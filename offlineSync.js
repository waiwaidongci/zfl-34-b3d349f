import {
  initialize,
  readBirdsStore,
  readEventsStore,
  writeBirdsAndEventsStore,
  readStore,
  writeStore,
  EVENT_TYPES
} from "./dataStore.js";
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  recordAuditLog,
  pickBirdKeyFields,
  pickSessionKeyFields
} from "./auditLog.js";
import { syncAllocateRing, isRingAllocated } from "./ringInventory.js";
import { validateDictionaryValues } from "./dictionaries.js";
import { persistRiskToBird } from "./healthRisk.js";
import { createSession, getSession, updateSession } from "./fieldSessions.js";
import { randomUUID } from "node:crypto";

const SYNC_TRACKER_FILE = "offlineSyncTracker";

const CONFLICT_STRATEGIES = {
  SKIP: "skip",
  OVERWRITE: "overwrite",
  MERGE: "merge"
};

const VALID_STRATEGIES = new Set(Object.values(CONFLICT_STRATEGIES));

const syncPacketCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function generateSyncPacketId() {
  return `SYNC-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8)}`;
}

function cleanupCache() {
  const now = Date.now();
  for (const [id, entry] of syncPacketCache) {
    if (now - entry.processedAt > CACHE_TTL_MS) {
      syncPacketCache.delete(id);
    }
  }
}

async function loadSyncTracker() {
  await initialize();
  return await readStore(SYNC_TRACKER_FILE) || { processedPackets: [] };
}

async function saveSyncTracker(data) {
  await initialize();
  await writeStore(SYNC_TRACKER_FILE, data);
}

function isPacketAlreadyProcessed(packetId) {
  if (syncPacketCache.has(packetId)) {
    return syncPacketCache.get(packetId).result;
  }
  return null;
}

function cachePacketResult(packetId, result) {
  syncPacketCache.set(packetId, {
    result,
    processedAt: Date.now()
  });
  cleanupCache();
}

function extractEventTime(event) {
  const data = event.data || event;
  if (data.at) return new Date(data.at).getTime();
  if (data.date) return new Date(data.date).getTime();
  return Date.now();
}

function sortEventsByTime(events) {
  return [...events].sort((a, b) => extractEventTime(a) - extractEventTime(b));
}

function buildEventSignature(event) {
  const data = event.data || event;
  const parts = [
    event.ringNo || "",
    event.eventType || "",
    data.at || data.date || "",
    JSON.stringify(data.place || data.point || "")
  ];
  return parts.join("|");
}

function buildBirdSignature(bird) {
  const parts = [
    bird.ringNo || "",
    bird.species || "",
    bird.capturePlace || "",
    bird.season || "",
    bird.fieldSessionId || ""
  ];
  return parts.join("|");
}

function buildSessionSignature(session) {
  const parts = [
    session.id || "",
    session.date || "",
    session.season || "",
    session.capturePlace || ""
  ];
  return parts.join("|");
}

async function validateBirdInput(bird) {
  const errors = [];
  if (!bird.ringNo) errors.push("缺少必填字段: ringNo");
  if (!bird.species) errors.push("缺少必填字段: species");

  const validations = await validateDictionaryValues([
    { type: "species", value: bird.species, allowEmpty: false },
    { type: "capturePlace", value: bird.capturePlace, allowEmpty: true },
    { type: "season", value: bird.season, allowEmpty: true }
  ]);
  const invalid = validations.filter(r => !r.valid);
  for (const v of invalid) {
    if (v.reason === "empty_value_not_allowed") {
      errors.push(`字段「${v.type}」不能为空`);
    } else {
      errors.push(`字段「${v.type}」的值「${v.value}」不在字典中`);
    }
  }
  return errors;
}

function resolveConflictStrategy(packetStrategy) {
  if (!packetStrategy) return CONFLICT_STRATEGIES.SKIP;
  const normalized = String(packetStrategy).toLowerCase().trim();
  if (VALID_STRATEGIES.has(normalized)) return normalized;
  return CONFLICT_STRATEGIES.SKIP;
}

function mergeBirdFields(existing, incoming) {
  const result = { ...existing };
  const fields = ["species", "sex", "age", "capturePlace", "season", "fieldSessionId"];
  for (const f of fields) {
    if (incoming[f] !== undefined && incoming[f] !== null && incoming[f] !== "") {
      result[f] = incoming[f];
    }
  }
  return result;
}

function overwriteBirdFields(existing, incoming) {
  const result = { ...existing };
  const fields = ["species", "sex", "age", "capturePlace", "season", "fieldSessionId"];
  for (const f of fields) {
    if (incoming[f] !== undefined) {
      result[f] = incoming[f];
    }
  }
  return result;
}

function mergeSessionInput(incoming) {
  const result = {};
  const fields = ["date", "season", "capturePlace", "team", "weather", "tide", "capturedCount", "releasedCount", "notes"];
  for (const f of fields) {
    if (incoming[f] !== undefined && incoming[f] !== null && incoming[f] !== "") {
      result[f] = incoming[f];
    }
  }
  return result;
}

function overwriteSessionInput(incoming) {
  const result = {};
  const fields = ["date", "season", "capturePlace", "team", "weather", "tide", "capturedCount", "releasedCount", "notes"];
  for (const f of fields) {
    if (incoming[f] !== undefined) {
      result[f] = incoming[f];
    }
  }
  return result;
}

function mergeEventData(existingData, incomingData) {
  const result = { ...existingData };
  for (const [key, value] of Object.entries(incomingData || {})) {
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

function overwriteEventData(incomingData) {
  return { ...(incomingData || {}) };
}

async function processOfflinePacket(packet) {
  await initialize();
  cleanupCache();

  const packetId = packet.packetId || generateSyncPacketId();
  const conflictStrategy = resolveConflictStrategy(packet.conflictStrategy);

  const cached = isPacketAlreadyProcessed(packetId);
  if (cached) {
    return { ...cached, idempotent: true };
  }

  const tracker = await loadSyncTracker();
  const historicalRecord = tracker.processedPackets.find(p => p.packetId === packetId);
  if (historicalRecord) {
    cachePacketResult(packetId, historicalRecord.result);
    return { ...historicalRecord.result, idempotent: true };
  }

  const result = {
    packetId,
    conflictStrategy,
    processedAt: new Date().toISOString(),
    success: {
      birds: 0,
      events: 0,
      sessions: 0
    },
    conflictResolution: {
      skipped: 0,
      overwritten: 0,
      merged: 0
    },
    conflicts: [],
    failures: [],
    skipped: [],
    ringNoConflicts: [],
    records: []
  };

  const birdsStore = await readBirdsStore();
  const eventsStore = await readEventsStore();

  const existingBirdRingNos = new Set(birdsStore.birds.map(b => b.ringNo));
  const existingEventSignatures = new Set(eventsStore.events.map(buildEventSignature));
  const existingEventSignatureIndexMap = new Map();
  for (let idx = 0; idx < eventsStore.events.length; idx++) {
    const sig = buildEventSignature(eventsStore.events[idx]);
    existingEventSignatureIndexMap.set(sig, idx);
  }

  const existingEventIndexMap = new Map();
  for (const e of eventsStore.events) {
    const key = `${e.ringNo}|${e.eventType}`;
    const current = existingEventIndexMap.get(key) || -1;
    if (e.eventIndex > current) {
      existingEventIndexMap.set(key, e.eventIndex);
    }
  }

  const sessionsInput = Array.isArray(packet.fieldSessions) ? packet.fieldSessions : [];
  const birdsInput = Array.isArray(packet.birds) ? packet.birds : [];
  const eventsInput = Array.isArray(packet.events) ? packet.events : [];

  const packetBirdSigs = new Set();
  const packetEventSigs = new Set();
  const packetSessionSigs = new Set();
  const packetBirdRingNos = new Set();

  const newSessions = [];
  const overwrittenSessions = [];
  const mergedSessions = [];

  for (let i = 0; i < sessionsInput.length; i++) {
    const session = sessionsInput[i];
    const tempId = session.tempId || `session-${i}`;
    const sig = buildSessionSignature(session);

    if (packetSessionSigs.has(sig)) {
      result.skipped.push({
        type: "session",
        tempId,
        reason: "duplicate_in_packet"
      });
      result.records.push({ type: "session", tempId, action: "skipped", reason: "duplicate_in_packet" });
      continue;
    }
    packetSessionSigs.add(sig);

    if (session.id) {
      const existingSession = await getSession(session.id);
      if (existingSession) {
        if (conflictStrategy === CONFLICT_STRATEGIES.SKIP) {
          result.conflicts.push({
            type: "session",
            tempId,
            sessionId: session.id,
            reason: "session_already_exists",
            existing: pickSessionKeyFields(existingSession),
            resolvedBy: "skip"
          });
          result.conflictResolution.skipped++;
          result.records.push({
            type: "session",
            tempId,
            sessionId: session.id,
            action: "skipped",
            conflictReason: "session_already_exists"
          });
        } else if (conflictStrategy === CONFLICT_STRATEGIES.OVERWRITE) {
          try {
            const updateInput = overwriteSessionInput(session);
            const updated = await updateSession(session.id, updateInput);
            overwrittenSessions.push({ tempId, session: updated });
            result.conflicts.push({
              type: "session",
              tempId,
              sessionId: session.id,
              reason: "session_already_exists",
              existing: pickSessionKeyFields(existingSession),
              resolvedBy: "overwrite"
            });
            result.conflictResolution.overwritten++;
            result.success.sessions++;
            result.records.push({
              type: "session",
              tempId,
              sessionId: session.id,
              action: "overwritten",
              conflictReason: "session_already_exists"
            });
          } catch (e) {
            result.failures.push({
              type: "session",
              tempId,
              sessionId: session.id,
              reason: e.message
            });
            result.records.push({
              type: "session",
              tempId,
              sessionId: session.id,
              action: "failed",
              reason: e.message
            });
          }
        } else if (conflictStrategy === CONFLICT_STRATEGIES.MERGE) {
          try {
            const updateInput = mergeSessionInput(session);
            const updated = await updateSession(session.id, updateInput);
            mergedSessions.push({ tempId, session: updated });
            result.conflicts.push({
              type: "session",
              tempId,
              sessionId: session.id,
              reason: "session_already_exists",
              existing: pickSessionKeyFields(existingSession),
              resolvedBy: "merge"
            });
            result.conflictResolution.merged++;
            result.success.sessions++;
            result.records.push({
              type: "session",
              tempId,
              sessionId: session.id,
              action: "merged",
              conflictReason: "session_already_exists"
            });
          } catch (e) {
            result.failures.push({
              type: "session",
              tempId,
              sessionId: session.id,
              reason: e.message
            });
            result.records.push({
              type: "session",
              tempId,
              sessionId: session.id,
              action: "failed",
              reason: e.message
            });
          }
        }
        continue;
      }
    }

    try {
      const created = await createSession(session);
      newSessions.push({ tempId, session: created });
      result.success.sessions++;
      result.records.push({
        type: "session",
        tempId,
        sessionId: created.id,
        action: "created"
      });
    } catch (e) {
      result.failures.push({
        type: "session",
        tempId,
        reason: e.message,
        details: session
      });
      result.records.push({
        type: "session",
        tempId,
        action: "failed",
        reason: e.message
      });
    }
  }

  const sessionTempIdMap = new Map();
  for (const s of newSessions) {
    if (s.tempId) sessionTempIdMap.set(s.tempId, s.session.id);
  }
  for (const s of overwrittenSessions) {
    if (s.tempId) sessionTempIdMap.set(s.tempId, s.session.id);
  }
  for (const s of mergedSessions) {
    if (s.tempId) sessionTempIdMap.set(s.tempId, s.session.id);
  }

  const resolvedBirdTempIdMap = new Map();

  for (let i = 0; i < birdsInput.length; i++) {
    const bird = birdsInput[i];
    const tempId = bird.tempId || `bird-${i}`;
    const sig = buildBirdSignature(bird);

    if (packetBirdSigs.has(sig)) {
      result.skipped.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        reason: "duplicate_in_packet"
      });
      result.records.push({ type: "bird", tempId, ringNo: bird.ringNo, action: "skipped", reason: "duplicate_in_packet" });
      continue;
    }
    packetBirdSigs.add(sig);

    const resolvedFieldSessionId = bird.fieldSessionId
      ? (sessionTempIdMap.get(bird.fieldSessionId) || bird.fieldSessionId)
      : null;

    if (bird.ringNo && packetBirdRingNos.has(bird.ringNo)) {
      result.ringNoConflicts.push({
        tempId,
        ringNo: bird.ringNo,
        reason: "ring_duplicate_in_packet"
      });
      result.failures.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        reason: "ring_duplicate_in_packet"
      });
      result.records.push({ type: "bird", tempId, ringNo: bird.ringNo, action: "failed", reason: "ring_duplicate_in_packet" });
      continue;
    }

    if (bird.ringNo) {
      packetBirdRingNos.add(bird.ringNo);
    }

    if (bird.ringNo && existingBirdRingNos.has(bird.ringNo)) {
      const birdForValidation = { ...bird, fieldSessionId: resolvedFieldSessionId };
      const validationErrors = await validateBirdInput(birdForValidation);

      if (conflictStrategy === CONFLICT_STRATEGIES.SKIP) {
        result.ringNoConflicts.push({
          tempId,
          ringNo: bird.ringNo,
          reason: "ring_already_exists_in_db"
        });
        result.conflicts.push({
          type: "bird",
          tempId,
          ringNo: bird.ringNo,
          reason: "ring_already_exists_in_db",
          resolvedBy: "skip"
        });
        result.conflictResolution.skipped++;
        result.records.push({
          type: "bird",
          tempId,
          ringNo: bird.ringNo,
          action: "skipped",
          conflictReason: "ring_already_exists_in_db"
        });
        continue;
      }

      if (validationErrors.length > 0) {
        result.ringNoConflicts.push({
          tempId,
          ringNo: bird.ringNo,
          reason: "ring_already_exists_in_db"
        });
        result.failures.push({
          type: "bird",
          tempId,
          ringNo: bird.ringNo,
          reason: "validation_failed",
          details: validationErrors
        });
        result.records.push({
          type: "bird",
          tempId,
          ringNo: bird.ringNo,
          action: "failed",
          reason: "validation_failed_on_conflict_resolution"
        });
        continue;
      }

      const existingIdx = birdsStore.birds.findIndex(b => b.ringNo === bird.ringNo);
      if (existingIdx === -1) continue;

      const existingBird = birdsStore.birds[existingIdx];

      if (conflictStrategy === CONFLICT_STRATEGIES.OVERWRITE) {
        const newBird = overwriteBirdFields(existingBird, {
          species: bird.species,
          sex: bird.sex || "unknown",
          age: bird.age || null,
          capturePlace: bird.capturePlace || null,
          season: bird.season || null,
          fieldSessionId: resolvedFieldSessionId
        });
        persistRiskToBird(newBird);
        birdsStore.birds[existingIdx] = newBird;
        resolvedBirdTempIdMap.set(tempId, bird.ringNo);
        result.conflicts.push({
          type: "bird",
          tempId,
          ringNo: bird.ringNo,
          reason: "ring_already_exists_in_db",
          resolvedBy: "overwrite"
        });
        result.conflictResolution.overwritten++;
        result.success.birds++;
        result.records.push({
          type: "bird",
          tempId,
          ringNo: bird.ringNo,
          action: "overwritten",
          conflictReason: "ring_already_exists_in_db"
        });
      } else if (conflictStrategy === CONFLICT_STRATEGIES.MERGE) {
        const newBird = mergeBirdFields(existingBird, {
          species: bird.species,
          sex: bird.sex,
          age: bird.age,
          capturePlace: bird.capturePlace,
          season: bird.season,
          fieldSessionId: resolvedFieldSessionId
        });
        persistRiskToBird(newBird);
        birdsStore.birds[existingIdx] = newBird;
        resolvedBirdTempIdMap.set(tempId, bird.ringNo);
        result.conflicts.push({
          type: "bird",
          tempId,
          ringNo: bird.ringNo,
          reason: "ring_already_exists_in_db",
          resolvedBy: "merge"
        });
        result.conflictResolution.merged++;
        result.success.birds++;
        result.records.push({
          type: "bird",
          tempId,
          ringNo: bird.ringNo,
          action: "merged",
          conflictReason: "ring_already_exists_in_db"
        });
      }

      const birdInlineEventTypes = ["measurements", "releases", "recaptures", "observations"];
      for (const type of birdInlineEventTypes) {
        const arr = bird[type] || [];
        if (Array.isArray(arr)) {
          for (let j = 0; j < arr.length; j++) {
            const inlineEvent = {
              ringNo: bird.ringNo,
              eventType: type,
              data: { ...arr[j] }
            };
            if (!inlineEvent.data.fieldSessionId && resolvedFieldSessionId) {
              inlineEvent.data.fieldSessionId = resolvedFieldSessionId;
            }
            if (type === "measurements" && !inlineEvent.data.at) {
              inlineEvent.data.at = new Date().toISOString().slice(0, 10);
            }
            if ((type === "releases" || type === "recaptures" || type === "observations") && !inlineEvent.data.at) {
              inlineEvent.data.at = new Date().toISOString();
            }
            eventsInput.push(inlineEvent);
          }
        }
      }
      continue;
    }

    if (bird.ringNo && await isRingAllocated(bird.ringNo)) {
      result.ringNoConflicts.push({
        tempId,
        ringNo: bird.ringNo,
        reason: "ring_allocated_in_inventory"
      });
      result.failures.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        reason: "ring_allocated_in_inventory"
      });
      result.records.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        action: "failed",
        reason: "ring_allocated_in_inventory"
      });
      continue;
    }

    const birdForValidation = { ...bird, fieldSessionId: resolvedFieldSessionId };
    const validationErrors = await validateBirdInput(birdForValidation);
    if (validationErrors.length > 0) {
      result.failures.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        reason: "validation_failed",
        details: validationErrors
      });
      result.records.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        action: "failed",
        reason: "validation_failed"
      });
      continue;
    }

    try {
      const newBird = {
        ringNo: bird.ringNo,
        species: bird.species,
        sex: bird.sex || "unknown",
        age: bird.age || null,
        capturePlace: bird.capturePlace || null,
        season: bird.season || null,
        fieldSessionId: resolvedFieldSessionId
      };

      persistRiskToBird(newBird);
      birdsStore.birds.push(newBird);
      existingBirdRingNos.add(bird.ringNo);
      resolvedBirdTempIdMap.set(tempId, bird.ringNo);
      result.success.birds++;
      result.records.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        action: "created"
      });

      const birdInlineEventTypes = ["measurements", "releases", "recaptures", "observations"];
      for (const type of birdInlineEventTypes) {
        const arr = bird[type] || [];
        if (Array.isArray(arr)) {
          for (let j = 0; j < arr.length; j++) {
            const inlineEvent = {
              ringNo: bird.ringNo,
              eventType: type,
              data: { ...arr[j] }
            };
            if (!inlineEvent.data.fieldSessionId && resolvedFieldSessionId) {
              inlineEvent.data.fieldSessionId = resolvedFieldSessionId;
            }
            if (type === "measurements" && !inlineEvent.data.at) {
              inlineEvent.data.at = new Date().toISOString().slice(0, 10);
            }
            if ((type === "releases" || type === "recaptures" || type === "observations") && !inlineEvent.data.at) {
              inlineEvent.data.at = new Date().toISOString();
            }
            eventsInput.push(inlineEvent);
          }
        }
      }
    } catch (e) {
      result.failures.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        reason: e.message
      });
      result.records.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        action: "failed",
        reason: e.message
      });
    }
  }

  const sortedEvents = sortEventsByTime(eventsInput);
  const typeCounterMap = new Map();

  for (let i = 0; i < sortedEvents.length; i++) {
    const event = sortedEvents[i];
    const tempId = event.tempId || `event-${i}`;

    let resolvedRingNo = event.ringNo;
    if (!resolvedRingNo && event.birdTempId) {
      resolvedRingNo = resolvedBirdTempIdMap.get(event.birdTempId);
    }

    if (!resolvedRingNo) {
      result.failures.push({
        type: "event",
        tempId,
        eventType: event.eventType,
        reason: "missing_ring_no_or_temp_id_mapping"
      });
      result.records.push({
        type: "event",
        tempId,
        eventType: event.eventType,
        action: "failed",
        reason: "missing_ring_no_or_temp_id_mapping"
      });
      continue;
    }

    if (!EVENT_TYPES.includes(event.eventType)) {
      result.failures.push({
        type: "event",
        tempId,
        ringNo: resolvedRingNo,
        eventType: event.eventType,
        reason: "invalid_event_type"
      });
      result.records.push({
        type: "event",
        tempId,
        ringNo: resolvedRingNo,
        eventType: event.eventType,
        action: "failed",
        reason: "invalid_event_type"
      });
      continue;
    }

    const eventForSig = { ...event, ringNo: resolvedRingNo };
    const sig = buildEventSignature(eventForSig);

    if (packetEventSigs.has(sig)) {
      result.skipped.push({
        type: "event",
        tempId,
        ringNo: resolvedRingNo,
        eventType: event.eventType,
        reason: "duplicate_in_packet"
      });
      result.records.push({
        type: "event",
        tempId,
        ringNo: resolvedRingNo,
        eventType: event.eventType,
        action: "skipped",
        reason: "duplicate_in_packet"
      });
      continue;
    }
    packetEventSigs.add(sig);

    if (existingEventSignatures.has(sig)) {
      if (conflictStrategy === CONFLICT_STRATEGIES.SKIP) {
        result.skipped.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          reason: "already_exists_in_db"
        });
        result.conflicts.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          reason: "already_exists_in_db",
          resolvedBy: "skip"
        });
        result.conflictResolution.skipped++;
        result.records.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          action: "skipped",
          conflictReason: "already_exists_in_db"
        });
        continue;
      }

      const existingIdx = existingEventSignatureIndexMap.get(sig);
      if (existingIdx === undefined || existingIdx === null) {
        result.skipped.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          reason: "already_exists_in_db"
        });
        result.conflicts.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          reason: "already_exists_in_db",
          resolvedBy: "skip"
        });
        result.records.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          action: "skipped",
          conflictReason: "already_exists_in_db"
        });
        continue;
      }

      const existingEvent = eventsStore.events[existingIdx];
      const resolvedFieldSessionId = event.data && event.data.fieldSessionId
        ? (sessionTempIdMap.get(event.data.fieldSessionId) || event.data.fieldSessionId)
        : null;

      let newData;
      if (conflictStrategy === CONFLICT_STRATEGIES.OVERWRITE) {
        newData = overwriteEventData(event.data || {});
        result.conflicts.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          reason: "already_exists_in_db",
          resolvedBy: "overwrite"
        });
        result.conflictResolution.overwritten++;
        result.records.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          action: "overwritten",
          conflictReason: "already_exists_in_db"
        });
      } else {
        newData = mergeEventData(existingEvent.data || {}, event.data || {});
        result.conflicts.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          reason: "already_exists_in_db",
          resolvedBy: "merge"
        });
        result.conflictResolution.merged++;
        result.records.push({
          type: "event",
          tempId,
          ringNo: resolvedRingNo,
          eventType: event.eventType,
          action: "merged",
          conflictReason: "already_exists_in_db"
        });
      }

      if (resolvedFieldSessionId) newData.fieldSessionId = resolvedFieldSessionId;
      if (event.eventType === "measurements" && !newData.at) {
        newData.at = new Date().toISOString().slice(0, 10);
      }
      if ((event.eventType === "releases" || event.eventType === "recaptures" || event.eventType === "observations") && !newData.at) {
        newData.at = new Date().toISOString();
      }

      eventsStore.events[existingIdx] = {
        ...existingEvent,
        data: newData
      };
      result.success.events++;
      continue;
    }

    const resolvedFieldSessionId = event.data && event.data.fieldSessionId
      ? (sessionTempIdMap.get(event.data.fieldSessionId) || event.data.fieldSessionId)
      : null;

    const counterKey = `${resolvedRingNo}|${event.eventType}`;
    const existingMaxIndex = existingEventIndexMap.get(counterKey) ?? -1;
    const packetCount = typeCounterMap.get(counterKey) || 0;
    const currentIndex = existingMaxIndex + 1 + packetCount;
    typeCounterMap.set(counterKey, packetCount + 1);

    try {
      const eventData = { ...(event.data || {}) };
      if (resolvedFieldSessionId) eventData.fieldSessionId = resolvedFieldSessionId;
      if (event.eventType === "measurements" && !eventData.at) {
        eventData.at = new Date().toISOString().slice(0, 10);
      }
      if ((event.eventType === "releases" || event.eventType === "recaptures" || event.eventType === "observations") && !eventData.at) {
        eventData.at = new Date().toISOString();
      }

      eventsStore.events.push({
        ringNo: resolvedRingNo,
        eventType: event.eventType,
        eventIndex: currentIndex,
        data: eventData
      });
      existingEventSignatures.add(sig);
      existingEventSignatureIndexMap.set(sig, eventsStore.events.length - 1);
      result.success.events++;
      result.records.push({
        type: "event",
        tempId,
        ringNo: resolvedRingNo,
        eventType: event.eventType,
        action: "created"
      });
    } catch (e) {
      result.failures.push({
        type: "event",
        tempId,
        ringNo: resolvedRingNo,
        eventType: event.eventType,
        reason: e.message
      });
      result.records.push({
        type: "event",
        tempId,
        ringNo: resolvedRingNo,
        eventType: event.eventType,
        action: "failed",
        reason: e.message
      });
    }
  }

  await writeBirdsAndEventsStore(birdsStore, eventsStore);

  for (const bird of birdsInput) {
    const tempId = bird.tempId;
    const resolvedRingNo = resolvedBirdTempIdMap.get(tempId);
    if (resolvedRingNo && existingBirdRingNos.has(resolvedRingNo)) {
      try {
        await syncAllocateRing(resolvedRingNo, resolvedRingNo);
      } catch (_) {}
    }
  }

  const unresolvedConflicts = result.conflicts.filter(c => c.resolvedBy === "skip" || !c.resolvedBy);
  const hasErrors = result.failures.length > 0 || unresolvedConflicts.length > 0;
  result.status = hasErrors ? "partial_success" : "success";

  const createdOrUpdatedBirds = [];
  for (const [tempId, ringNo] of resolvedBirdTempIdMap.entries()) {
    const bird = birdsStore.birds.find(b => b.ringNo === ringNo);
    if (bird) {
      const record = result.records.find(r => r.type === "bird" && r.ringNo === ringNo && r.tempId === tempId);
      createdOrUpdatedBirds.push({
        tempId,
        ringNo,
        action: record ? record.action : "created",
        bird: pickBirdKeyFields(bird)
      });
    }
  }

  const allProcessedSessions = [
    ...newSessions.map(s => ({ ...s, action: "created" })),
    ...overwrittenSessions.map(s => ({ ...s, action: "overwritten" })),
    ...mergedSessions.map(s => ({ ...s, action: "merged" }))
  ];

  recordAuditLog({
    operationType: OPERATION_TYPES.OFFLINE_SYNC_PACKET,
    targetType: TARGET_TYPES.OFFLINE_SYNC,
    targetId: packetId,
    requestSummary: {
      packetId,
      conflictStrategy,
      inputCounts: {
        sessions: sessionsInput.length,
        birds: birdsInput.length,
        events: eventsInput.length
      },
      success: result.success,
      conflictResolution: result.conflictResolution,
      conflictsCount: result.conflicts.length,
      conflictSummary: {
        total: result.conflicts.length,
        byType: {
          bird: result.conflicts.filter(c => c.type === "bird").length,
          session: result.conflicts.filter(c => c.type === "session").length,
          event: result.conflicts.filter(c => c.type === "event").length
        },
        byResolution: {
          skipped: result.conflicts.filter(c => c.resolvedBy === "skip").length,
          overwritten: result.conflicts.filter(c => c.resolvedBy === "overwrite").length,
          merged: result.conflicts.filter(c => c.resolvedBy === "merge").length,
          unresolved: result.conflicts.filter(c => !c.resolvedBy).length
        }
      },
      failuresCount: result.failures.length,
      skippedCount: result.skipped.length,
      ringNoConflictCount: result.ringNoConflicts.length,
      status: result.status
    },
    before: null,
    after: {
      processedSessions: allProcessedSessions.map(s => ({
        action: s.action,
        tempId: s.tempId,
        ...pickSessionKeyFields(s.session)
      })),
      createdOrUpdatedBirds,
      ringNoConflicts: result.ringNoConflicts
    }
  });

  tracker.processedPackets.push({
    packetId,
    processedAt: result.processedAt,
    result
  });
  if (tracker.processedPackets.length > 1000) {
    tracker.processedPackets = tracker.processedPackets.slice(-1000);
  }
  await saveSyncTracker(tracker);
  cachePacketResult(packetId, result);

  return { ...result, idempotent: false };
}

export {
  CONFLICT_STRATEGIES,
  resolveConflictStrategy,
  processOfflinePacket
};

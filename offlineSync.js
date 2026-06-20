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
import { createSession, getSession } from "./fieldSessions.js";
import { randomUUID } from "node:crypto";

const SYNC_TRACKER_FILE = "offlineSyncTracker";

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

async function processOfflinePacket(packet) {
  await initialize();
  cleanupCache();

  const packetId = packet.packetId || generateSyncPacketId();
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
    processedAt: new Date().toISOString(),
    success: {
      birds: 0,
      events: 0,
      sessions: 0
    },
    conflicts: [],
    failures: [],
    skipped: [],
    ringNoConflicts: []
  };

  const birdsStore = await readBirdsStore();
  const eventsStore = await readEventsStore();

  const existingBirdRingNos = new Set(birdsStore.birds.map(b => b.ringNo));
  const existingEventSignatures = new Set(eventsStore.events.map(buildEventSignature));
  const existingSessionIds = new Set();

  const sessionsInput = Array.isArray(packet.fieldSessions) ? packet.fieldSessions : [];
  const birdsInput = Array.isArray(packet.birds) ? packet.birds : [];
  const eventsInput = Array.isArray(packet.events) ? packet.events : [];

  const packetBirdSigs = new Set();
  const packetEventSigs = new Set();
  const packetSessionSigs = new Set();
  const packetBirdRingNos = new Set();

  const newSessions = [];
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
      continue;
    }
    packetSessionSigs.add(sig);

    if (session.id) {
      const existingSession = await getSession(session.id);
      if (existingSession) {
        result.conflicts.push({
          type: "session",
          tempId,
          sessionId: session.id,
          reason: "session_already_exists",
          existing: pickSessionKeyFields(existingSession)
        });
        continue;
      }
    }

    try {
      const created = await createSession(session);
      newSessions.push({ tempId, session: created });
      existingSessionIds.add(created.id);
      result.success.sessions++;
    } catch (e) {
      result.failures.push({
        type: "session",
        tempId,
        reason: e.message,
        details: session
      });
    }
  }

  const sessionTempIdMap = new Map();
  for (const s of newSessions) {
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
      continue;
    }

    if (bird.ringNo) {
      packetBirdRingNos.add(bird.ringNo);
    }

    if (bird.ringNo && existingBirdRingNos.has(bird.ringNo)) {
      result.ringNoConflicts.push({
        tempId,
        ringNo: bird.ringNo,
        reason: "ring_already_exists_in_db"
      });
      result.conflicts.push({
        type: "bird",
        tempId,
        ringNo: bird.ringNo,
        reason: "ring_already_exists_in_db"
      });
      resolvedBirdTempIdMap.set(tempId, bird.ringNo);
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
      continue;
    }
    packetEventSigs.add(sig);

    if (existingEventSignatures.has(sig)) {
      result.skipped.push({
        type: "event",
        tempId,
        ringNo: resolvedRingNo,
        eventType: event.eventType,
        reason: "already_exists_in_db"
      });
      continue;
    }

    const resolvedFieldSessionId = event.data && event.data.fieldSessionId
      ? (sessionTempIdMap.get(event.data.fieldSessionId) || event.data.fieldSessionId)
      : null;

    const counterKey = `${resolvedRingNo}|${event.eventType}`;
    const currentIndex = typeCounterMap.get(counterKey) || 0;
    typeCounterMap.set(counterKey, currentIndex + 1);

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
      result.success.events++;
    } catch (e) {
      result.failures.push({
        type: "event",
        tempId,
        ringNo: resolvedRingNo,
        eventType: event.eventType,
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

  const hasErrors = result.failures.length > 0 || result.conflicts.length > 0;
  result.status = hasErrors ? "partial_success" : "success";

  const createdBirds = [];
  for (const [tempId, ringNo] of resolvedBirdTempIdMap.entries()) {
    const bird = birdsStore.birds.find(b => b.ringNo === ringNo);
    if (bird) {
      createdBirds.push({ tempId, ringNo, bird: pickBirdKeyFields(bird) });
    }
  }

  recordAuditLog({
    operationType: OPERATION_TYPES.OFFLINE_SYNC_PACKET,
    targetType: TARGET_TYPES.OFFLINE_SYNC,
    targetId: packetId,
    requestSummary: {
      packetId,
      inputCounts: {
        sessions: sessionsInput.length,
        birds: birdsInput.length,
        events: eventsInput.length
      },
      success: result.success,
      conflictsCount: result.conflicts.length,
      failuresCount: result.failures.length,
      skippedCount: result.skipped.length,
      ringNoConflictCount: result.ringNoConflicts.length,
      status: result.status
    },
    before: null,
    after: {
      createdSessions: newSessions.map(s => pickSessionKeyFields(s.session)),
      createdBirds,
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
  processOfflinePacket
};

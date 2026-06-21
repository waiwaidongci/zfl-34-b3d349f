import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { validateSnapshotStructure } from "./backupValidator.js";
import {
  initialize,
  loadLegacyCompatibleDb,
  saveLegacyCompatibleDb,
  STORE_FILES,
  atomicWriteFile,
  readStore,
  writeStore,
  atomicWriteMulti,
  splitLegacyBirdToEvents,
  DATA_DIR
} from "./dataStore.js";
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  recordAuditLog,
  buildAuditLogEntry,
  pickBirdKeyFields,
  pickSessionKeyFields,
  pickDictEntryKeyFields,
  pickRingKeyFields
} from "./auditLog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = STORE_FILES.legacySeabirds;
const snapshotsDir = join(DATA_DIR, "snapshots");
const indexPath = join(snapshotsDir, "index.json");

async function ensureSnapshotsDir() {
  if (!existsSync(snapshotsDir)) {
    await mkdir(snapshotsDir, { recursive: true });
  }
}

async function loadIndex() {
  await ensureSnapshotsDir();
  if (!existsSync(indexPath)) {
    await atomicWriteFile(indexPath, { snapshots: [] });
    return { snapshots: [] };
  }
  try {
    return JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    return { snapshots: [] };
  }
}

async function saveIndex(data) {
  await ensureSnapshotsDir();
  await atomicWriteFile(indexPath, data);
}

function generateSnapshotId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `SNAP-${ts}-${randomUUID().slice(0, 8)}`;
}

async function loadAllStores() {
  await initialize();
  const [birdsStore, eventsStore, dictionariesStore, fieldSessionsStore, ringInventoryStore] = await Promise.all([
    readStore("birds"),
    readStore("events"),
    readStore("dictionaries"),
    readStore("fieldSessions"),
    readStore("ringInventory")
  ]);
  return {
    birds: birdsStore.birds || [],
    events: eventsStore.events || [],
    dictionaries: dictionariesStore,
    fieldSessions: fieldSessionsStore.fieldSessions || [],
    ringInventory: ringInventoryStore
  };
}

function computeSummary(db) {
  const birds = db.birds || [];
  const speciesCount = {};
  for (const bird of birds) {
    speciesCount[bird.species] = (speciesCount[bird.species] || 0) + 1;
  }
  const events = db.events || [];
  const eventTypeCount = {};
  for (const event of events) {
    eventTypeCount[event.eventType] = (eventTypeCount[event.eventType] || 0) + 1;
  }
  const dictionaries = db.dictionaries || {};
  const dictSummary = {};
  for (const [key, entries] of Object.entries(dictionaries)) {
    dictSummary[key] = Array.isArray(entries) ? entries.length : 0;
  }
  const fieldSessions = db.fieldSessions || [];
  const ringInventory = db.ringInventory || {};
  const rings = ringInventory.rings || [];
  const ringStatusCount = {};
  for (const ring of rings) {
    ringStatusCount[ring.status] = (ringStatusCount[ring.status] || 0) + 1;
  }
  return {
    totalBirds: birds.length,
    speciesBreakdown: Object.entries(speciesCount).map(([species, count]) => ({ species, count })),
    totalMeasurements: birds.reduce((s, b) => s + (b.measurements?.length || 0), 0),
    totalRecaptures: birds.reduce((s, b) => s + (b.recaptures?.length || 0), 0),
    totalObservations: birds.reduce((s, b) => s + (b.observations?.length || 0), 0),
    totalReleases: birds.reduce((s, b) => s + (b.releases?.length || 0), 0),
    totalEvents: events.length,
    eventTypeBreakdown: Object.entries(eventTypeCount).map(([type, count]) => ({ type, count })),
    dictionaries: dictSummary,
    totalFieldSessions: fieldSessions.length,
    ringInventory: {
      totalBatches: (ringInventory.batches || []).length,
      totalRings: rings.length,
      statusBreakdown: Object.entries(ringStatusCount).map(([status, count]) => ({ status, count }))
    }
  };
}

export async function createSnapshot() {
  await initialize();
  const allStores = await loadAllStores();
  const legacyDb = await loadLegacyCompatibleDb();

  const db = {
    ...allStores,
    birds: legacyDb.birds
  };

  if (!db.birds || db.birds.length === 0) {
    if (!existsSync(dbPath)) {
      throw new Error("db_not_found");
    }
  }

  const validation = validateSnapshotStructure(db);
  if (!validation.valid) {
    throw new Error("db_structure_invalid");
  }

  const snapshotId = generateSnapshotId();
  const snapshotFileName = `${snapshotId}.json`;
  const snapshotFilePath = join(snapshotsDir, snapshotFileName);

  const snapshotData = {
    _meta: {
      snapshotId,
      createdAt: new Date().toISOString(),
      sourceFile: "complete snapshot (birds + events + dictionaries + fieldSessions + ringInventory)",
      summary: computeSummary(db)
    },
    data: db
  };

  await ensureSnapshotsDir();
  await atomicWriteFile(snapshotFilePath, snapshotData);

  const index = await loadIndex();
  index.snapshots.push({
    snapshotId,
    createdAt: snapshotData._meta.createdAt,
    fileName: snapshotFileName,
    summary: snapshotData._meta.summary
  });
  await saveIndex(index);

  await recordAuditLog({
    operationType: OPERATION_TYPES.SYSTEM_SNAPSHOT_CREATE,
    targetType: TARGET_TYPES.SYSTEM,
    targetId: snapshotId,
    requestSummary: {
      snapshotId,
      summary: snapshotData._meta.summary
    },
    before: null,
    after: {
      summary: snapshotData._meta.summary
    }
  });

  return {
    snapshotId,
    createdAt: snapshotData._meta.createdAt,
    summary: snapshotData._meta.summary
  };
}

export async function listSnapshots() {
  const index = await loadIndex();
  return index.snapshots.map(s => ({
    snapshotId: s.snapshotId,
    createdAt: s.createdAt,
    summary: s.summary
  }));
}

export async function getSnapshotSummary(snapshotId) {
  const index = await loadIndex();
  const entry = index.snapshots.find(s => s.snapshotId === snapshotId);
  if (!entry) return null;

  const snapshotFilePath = join(snapshotsDir, entry.fileName);
  if (!existsSync(snapshotFilePath)) return null;

  const raw = await readFile(snapshotFilePath, "utf8");
  let snapshotData;
  try {
    snapshotData = JSON.parse(raw);
  } catch {
    return null;
  }

  const normalizedDb = normalizeSnapshotDb(snapshotData.data);

  return {
    snapshotId: entry.snapshotId,
    createdAt: entry.createdAt,
    summary: computeSummary(normalizedDb),
    validation: validateSnapshotStructure(normalizedDb)
  };
}

function isLegacyFormat(db) {
  if (!db) return false;
  const hasEmbeddedEvents = Array.isArray(db.birds) && db.birds.some(b =>
    Array.isArray(b.measurements) || Array.isArray(b.releases) ||
    Array.isArray(b.recaptures) || Array.isArray(b.observations)
  );
  const missingEvents = !Array.isArray(db.events) || db.events.length === 0;
  const missingDicts = !db.dictionaries || Object.keys(db.dictionaries).length === 0;
  const missingSessions = !Array.isArray(db.fieldSessions) || db.fieldSessions.length === 0;
  const missingRingInv = !db.ringInventory ||
    ((!Array.isArray(db.ringInventory.batches) || db.ringInventory.batches.length === 0) &&
     (!Array.isArray(db.ringInventory.rings) || db.ringInventory.rings.length === 0));
  return hasEmbeddedEvents && (missingEvents || missingDicts || missingSessions || missingRingInv);
}

function extractEventTypesFromBirds(birds) {
  const types = new Set();
  for (const bird of birds || []) {
    if (Array.isArray(bird.measurements) && bird.measurements.length > 0) types.add("measurements");
    if (Array.isArray(bird.releases) && bird.releases.length > 0) types.add("releases");
    if (Array.isArray(bird.recaptures) && bird.recaptures.length > 0) types.add("recaptures");
    if (Array.isArray(bird.observations) && bird.observations.length > 0) types.add("observations");
  }
  return [...types];
}

function normalizeSnapshotDb(db) {
  if (!db || !Array.isArray(db.birds)) {
    return db || { birds: [] };
  }

  const normalized = { ...db };
  const birds = normalized.birds;

  if (!normalized.events || !Array.isArray(normalized.events) || normalized.events.length === 0) {
    const events = [];
    for (const lb of birds) {
      const { events: birdEvents } = splitLegacyBirdToEvents(lb);
      events.push(...birdEvents);
    }
    normalized.events = events;
  }

  if (!normalized.dictionaries || typeof normalized.dictionaries !== "object") {
    normalized.dictionaries = { species: [], capturePlace: [], season: [] };
  } else {
    if (!normalized.dictionaries.species) normalized.dictionaries.species = [];
    if (!normalized.dictionaries.capturePlace) normalized.dictionaries.capturePlace = [];
    if (!normalized.dictionaries.season) normalized.dictionaries.season = [];
  }

  if (!normalized.fieldSessions || !Array.isArray(normalized.fieldSessions)) {
    normalized.fieldSessions = [];
  }

  if (!normalized.ringInventory || typeof normalized.ringInventory !== "object") {
    normalized.ringInventory = { batches: [], rings: [] };
  } else {
    if (!Array.isArray(normalized.ringInventory.batches)) normalized.ringInventory.batches = [];
    if (!Array.isArray(normalized.ringInventory.rings)) normalized.ringInventory.rings = [];
  }

  normalized._legacyFormatNormalized = isLegacyFormat(db);
  return normalized;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function findChangedFields(oldObj, newObj) {
  const changes = [];
  const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  for (const key of allKeys) {
    if (!deepEqual(oldObj?.[key], newObj?.[key])) {
      changes.push({
        field: key,
        oldValue: oldObj?.[key],
        newValue: newObj?.[key]
      });
    }
  }
  return changes;
}

function compareById(currentArray, snapshotArray, idField) {
  const currentMap = new Map((currentArray || []).map(item => [item[idField], item]));
  const snapshotMap = new Map((snapshotArray || []).map(item => [item[idField], item]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, item] of snapshotMap) {
    if (!currentMap.has(id)) {
      added.push(item);
    } else {
      const currentItem = currentMap.get(id);
      if (!deepEqual(currentItem, item)) {
        changed.push({
          id,
          current: currentItem,
          snapshot: item,
          changedFields: findChangedFields(currentItem, item)
        });
      }
    }
  }
  for (const [id, item] of currentMap) {
    if (!snapshotMap.has(id)) {
      removed.push(item);
    }
  }
  return { added, removed, changed };
}

function compareEvents(currentEvents, snapshotEvents) {
  const eventKey = (e) => `${e.ringNo}|${e.eventType}|${e.eventIndex}`;
  const currentMap = new Map((currentEvents || []).map(e => [eventKey(e), e]));
  const snapshotMap = new Map((snapshotEvents || []).map(e => [eventKey(e), e]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, event] of snapshotMap) {
    if (!currentMap.has(key)) {
      added.push(event);
    } else {
      const currentEvent = currentMap.get(key);
      if (!deepEqual(currentEvent, event)) {
        changed.push({
          key,
          current: currentEvent,
          snapshot: event,
          changedFields: findChangedFields(currentEvent, event)
        });
      }
    }
  }
  for (const [key, event] of currentMap) {
    if (!snapshotMap.has(key)) {
      removed.push(event);
    }
  }
  return { added, removed, changed };
}

function compareDictionaries(currentDicts, snapshotDicts) {
  const result = {};
  const allTypes = new Set([...Object.keys(currentDicts || {}), ...Object.keys(snapshotDicts || {})]);
  for (const type of allTypes) {
    const currentEntries = currentDicts?.[type] || [];
    const snapshotEntries = snapshotDicts?.[type] || [];
    result[type] = compareById(currentEntries, snapshotEntries, "value");
  }
  return result;
}

function compareRingInventory(currentInventory, snapshotInventory) {
  const currentBatches = currentInventory?.batches || [];
  const snapshotBatches = snapshotInventory?.batches || [];
  const currentRings = currentInventory?.rings || [];
  const snapshotRings = snapshotInventory?.rings || [];
  return {
    batches: compareById(currentBatches, snapshotBatches, "id"),
    rings: compareById(currentRings, snapshotRings, "ringNo")
  };
}

async function computeDiff(snapshotDb) {
  const currentDb = await loadAllStores();
  const currentLegacyDb = await loadLegacyCompatibleDb();
  const current = {
    ...currentDb,
    birds: currentLegacyDb.birds
  };
  const snapshot = snapshotDb;
  const birdsDiff = compareById(current.birds, snapshot.birds, "ringNo");
  const eventsDiff = compareEvents(current.events, snapshot.events);
  const dictionariesDiff = compareDictionaries(current.dictionaries, snapshot.dictionaries);
  const fieldSessionsDiff = compareById(current.fieldSessions, snapshot.fieldSessions, "id");
  const ringInventoryDiff = compareRingInventory(current.ringInventory, snapshot.ringInventory);
  const diffSummary = {
    birds: {
      added: birdsDiff.added.length,
      removed: birdsDiff.removed.length,
      changed: birdsDiff.changed.length,
      addedRingNos: birdsDiff.added.map(b => b.ringNo),
      removedRingNos: birdsDiff.removed.map(b => b.ringNo),
      changedRingNos: birdsDiff.changed.map(c => c.id)
    },
    events: {
      added: eventsDiff.added.length,
      removed: eventsDiff.removed.length,
      changed: eventsDiff.changed.length,
      addedEventKeys: eventsDiff.added.map(e => `${e.ringNo}:${e.eventType}[${e.eventIndex}]`),
      removedEventKeys: eventsDiff.removed.map(e => `${e.ringNo}:${e.eventType}[${e.eventIndex}]`),
      changedEventKeys: eventsDiff.changed.map(c => c.key)
    },
    dictionaries: {},
    fieldSessions: {
      added: fieldSessionsDiff.added.length,
      removed: fieldSessionsDiff.removed.length,
      changed: fieldSessionsDiff.changed.length,
      addedIds: fieldSessionsDiff.added.map(s => s.id),
      removedIds: fieldSessionsDiff.removed.map(s => s.id),
      changedIds: fieldSessionsDiff.changed.map(c => c.id)
    },
    ringInventory: {
      batches: {
        added: ringInventoryDiff.batches.added.length,
        removed: ringInventoryDiff.batches.removed.length,
        changed: ringInventoryDiff.batches.changed.length,
        addedIds: ringInventoryDiff.batches.added.map(b => b.id),
        removedIds: ringInventoryDiff.batches.removed.map(b => b.id),
        changedIds: ringInventoryDiff.batches.changed.map(c => c.id)
      },
      rings: {
        added: ringInventoryDiff.rings.added.length,
        removed: ringInventoryDiff.rings.removed.length,
        changed: ringInventoryDiff.rings.changed.length,
        addedRingNos: ringInventoryDiff.rings.added.map(r => r.ringNo),
        removedRingNos: ringInventoryDiff.rings.removed.map(r => r.ringNo),
        changedRingNos: ringInventoryDiff.rings.changed.map(c => c.id)
      }
    }
  };
  for (const [type, diff] of Object.entries(dictionariesDiff)) {
    diffSummary.dictionaries[type] = {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      addedValues: diff.added.map(d => d.value),
      removedValues: diff.removed.map(d => d.value),
      changedValues: diff.changed.map(c => c.id)
    };
  }
  return {
    summary: diffSummary,
    details: {
      birds: birdsDiff,
      events: eventsDiff,
      dictionaries: dictionariesDiff,
      fieldSessions: fieldSessionsDiff,
      ringInventory: ringInventoryDiff
    }
  };
}

async function saveAllStores(db) {
  const writeBatch = [];
  if (db.birds !== undefined) {
    const newBirds = [];
    const newEvents = [];
    for (const lb of db.birds) {
      const { bird, events } = splitLegacyBirdToEvents(lb);
      newBirds.push(bird);
      newEvents.push(...events);
    }
    writeBatch.push([STORE_FILES.birds, { birds: newBirds }]);
    writeBatch.push([STORE_FILES.events, { events: newEvents }]);
  }
  if (db.dictionaries !== undefined) {
    writeBatch.push([STORE_FILES.dictionaries, db.dictionaries]);
  }
  if (db.fieldSessions !== undefined) {
    writeBatch.push([STORE_FILES.fieldSessions, { fieldSessions: db.fieldSessions }]);
  }
  if (db.ringInventory !== undefined) {
    writeBatch.push([STORE_FILES.ringInventory, db.ringInventory]);
  }
  await atomicWriteMulti(writeBatch);
}

export async function restoreFromSnapshot(snapshotId, options = {}) {
  const { previewOnly = false } = options;
  const index = await loadIndex();
  const entry = index.snapshots.find(s => s.snapshotId === snapshotId);
  if (!entry) throw new Error("snapshot_not_found");

  const snapshotFilePath = join(snapshotsDir, entry.fileName);
  if (!existsSync(snapshotFilePath)) throw new Error("snapshot_file_missing");

  const raw = await readFile(snapshotFilePath, "utf8");
  let snapshotData;
  try {
    snapshotData = JSON.parse(raw);
  } catch {
    throw new Error("snapshot_file_corrupt");
  }

  const rawDb = snapshotData.data;
  if (!rawDb) throw new Error("snapshot_data_missing");

  const db = normalizeSnapshotDb(rawDb);
  const isLegacyFormat = db._legacyFormatNormalized;
  delete db._legacyFormatNormalized;

  const validation = validateSnapshotStructure(db);
  if (!validation.valid) {
    const err = new Error("snapshot_structure_invalid");
    err.validationErrors = validation.errors;
    throw err;
  }

  const diff = await computeDiff(db);

  if (previewOnly) {
    return {
      snapshotId,
      previewOnly: true,
      legacyFormatNormalized: isLegacyFormat,
      diff: diff.summary,
      diffDetails: diff.details,
      snapshotSummary: computeSummary(db),
      currentSummary: computeSummary(await (async () => {
        const currentDb = await loadAllStores();
        const currentLegacyDb = await loadLegacyCompatibleDb();
        return { ...currentDb, birds: currentLegacyDb.birds };
      })())
    };
  }

  await saveAllStores(db);

  await recordAuditLog({
    operationType: OPERATION_TYPES.SYSTEM_SNAPSHOT_RESTORE,
    targetType: TARGET_TYPES.SYSTEM,
    targetId: snapshotId,
    requestSummary: {
      snapshotId,
      legacyFormatNormalized: isLegacyFormat,
      diff: diff.summary
    },
    before: {
      birds: diff.details.birds.removed.map(pickBirdKeyFields),
      fieldSessions: diff.details.fieldSessions.removed.map(pickSessionKeyFields),
      ringInventory: {
        rings: diff.details.ringInventory.rings.removed.map(pickRingKeyFields)
      }
    },
    after: {
      birds: diff.details.birds.added.map(pickBirdKeyFields),
      fieldSessions: diff.details.fieldSessions.added.map(pickSessionKeyFields),
      ringInventory: {
        rings: diff.details.ringInventory.rings.added.map(pickRingKeyFields)
      }
    }
  });

  return {
    snapshotId,
    restoredAt: new Date().toISOString(),
    legacyFormatNormalized: isLegacyFormat,
    summary: computeSummary(db),
    diff: diff.summary
  };
}

async function loadAllStoresForConsistency() {
  await initialize();
  const [birdsStore, eventsStore, dictionariesStore, fieldSessionsStore, ringInventoryStore, auditLogsStore] = await Promise.all([
    readStore("birds"),
    readStore("events"),
    readStore("dictionaries"),
    readStore("fieldSessions"),
    readStore("ringInventory"),
    readStore("auditLogs")
  ]);
  return {
    birds: birdsStore.birds || [],
    events: eventsStore.events || [],
    dictionaries: dictionariesStore || { species: [], capturePlace: [], season: [] },
    fieldSessions: fieldSessionsStore.fieldSessions || [],
    ringInventory: ringInventoryStore || { batches: [], rings: [] },
    auditLogs: auditLogsStore.logs || []
  };
}

export async function checkConsistency() {
  const db = await loadAllStoresForConsistency();
  const repairable = [];
  const nonRepairable = [];

  const birdRingNoSet = new Set(db.birds.map(b => b.ringNo));
  const sessionMap = new Map(db.fieldSessions.map(s => [s.id, s]));
  const batchMap = new Map((db.ringInventory.batches || []).map(b => [b.id, b]));
  const ringMap = new Map((db.ringInventory.rings || []).map(r => [r.ringNo, r]));

  const dictValues = {};
  for (const type of ["species", "capturePlace", "season"]) {
    dictValues[type] = new Set((db.dictionaries[type] || []).map(e => e.value));
  }

  const orphanEvents = db.events.filter(e => !birdRingNoSet.has(e.ringNo));
  if (orphanEvents.length > 0) {
    repairable.push({
      type: "orphan_events",
      description: "事件引用了不存在的鸟类环号",
      count: orphanEvents.length,
      details: orphanEvents.map(e => ({ ringNo: e.ringNo, eventType: e.eventType, eventIndex: e.eventIndex })),
      repairAction: "remove_orphan_events",
      repairHint: "移除所有引用不存在环号的事件"
    });
  }

  const eventsByBirdType = new Map();
  for (const e of db.events) {
    const key = `${e.ringNo}|${e.eventType}`;
    if (!eventsByBirdType.has(key)) eventsByBirdType.set(key, []);
    eventsByBirdType.get(key).push(e);
  }

  const duplicateIndexItems = [];
  for (const [key, evts] of eventsByBirdType) {
    const indexCount = {};
    for (const e of evts) {
      const idx = e.eventIndex;
      indexCount[idx] = (indexCount[idx] || 0) + 1;
    }
    for (const [idx, count] of Object.entries(indexCount)) {
      if (count > 1) {
        duplicateIndexItems.push({
          key,
          eventIndex: Number(idx),
          count,
          events: evts.filter(e => e.eventIndex === Number(idx)).map(e => ({ ringNo: e.ringNo, eventType: e.eventType, eventIndex: e.eventIndex }))
        });
      }
    }
  }
  if (duplicateIndexItems.length > 0) {
    repairable.push({
      type: "duplicate_event_index",
      description: "同一环号+事件类型下存在重复的eventIndex",
      count: duplicateIndexItems.length,
      details: duplicateIndexItems,
      repairAction: "reindex_events",
      repairHint: "重新编排eventIndex使同一环号+事件类型下索引连续无重复"
    });
  }

  const indexGapItems = [];
  for (const [key, evts] of eventsByBirdType) {
    const sorted = [...evts].sort((a, b) => a.eventIndex - b.eventIndex);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].eventIndex !== i) {
        indexGapItems.push({
          key,
          expectedIndex: i,
          actualIndex: sorted[i].eventIndex,
          ringNo: sorted[i].ringNo,
          eventType: sorted[i].eventType
        });
        break;
      }
    }
  }
  if (indexGapItems.length > 0) {
    repairable.push({
      type: "event_index_gap",
      description: "同一环号+事件类型下eventIndex不连续",
      count: indexGapItems.length,
      details: indexGapItems,
      repairAction: "reindex_events",
      repairHint: "重新编排eventIndex使索引从0连续递增"
    });
  }

  const unknownDictValues = [];
  for (const bird of db.birds) {
    if (bird.species && !dictValues.species.has(bird.species)) {
      unknownDictValues.push({ source: "bird", ringNo: bird.ringNo, dictType: "species", value: bird.species });
    }
    if (bird.capturePlace && !dictValues.capturePlace.has(bird.capturePlace)) {
      unknownDictValues.push({ source: "bird", ringNo: bird.ringNo, dictType: "capturePlace", value: bird.capturePlace });
    }
    if (bird.season && !dictValues.season.has(bird.season)) {
      unknownDictValues.push({ source: "bird", ringNo: bird.ringNo, dictType: "season", value: bird.season });
    }
  }
  for (const session of db.fieldSessions) {
    if (session.season && !dictValues.season.has(session.season)) {
      unknownDictValues.push({ source: "fieldSession", id: session.id, dictType: "season", value: session.season });
    }
    if (session.capturePlace && !dictValues.capturePlace.has(session.capturePlace)) {
      unknownDictValues.push({ source: "fieldSession", id: session.id, dictType: "capturePlace", value: session.capturePlace });
    }
  }
  if (unknownDictValues.length > 0) {
    const deduped = [];
    const seen = new Set();
    for (const item of unknownDictValues) {
      const dedupeKey = `${item.dictType}|${item.value}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        deduped.push({ dictType: item.dictType, value: item.value, referencedBy: unknownDictValues.filter(i => i.dictType === item.dictType && i.value === item.value).length });
      }
    }
    repairable.push({
      type: "unknown_dict_values",
      description: "鸟类或场次引用了字典中不存在的值",
      count: deduped.length,
      details: deduped,
      repairAction: "add_missing_dict_entries",
      repairHint: "将缺失的字典值添加到对应字典类型中"
    });
  }

  const unallocatedRings = [];
  for (const bird of db.birds) {
    const ring = ringMap.get(bird.ringNo);
    if (!ring) {
      unallocatedRings.push({ ringNo: bird.ringNo, reason: "ring_not_in_inventory" });
    } else if (ring.status !== "allocated") {
      unallocatedRings.push({ ringNo: bird.ringNo, reason: "ring_not_allocated", currentStatus: ring.status });
    }
  }
  if (unallocatedRings.length > 0) {
    repairable.push({
      type: "unallocated_ring_in_use",
      description: "鸟类已使用但环号库存未分配",
      count: unallocatedRings.length,
      details: unallocatedRings,
      repairAction: "allocate_used_rings",
      repairHint: "将已使用但未分配的环号状态设为allocated"
    });
  }

  const orphanRingBatches = (db.ringInventory.rings || []).filter(r => r.batchId && !batchMap.has(r.batchId));
  if (orphanRingBatches.length > 0) {
    nonRepairable.push({
      type: "orphan_ring_batch_ref",
      description: "环号引用了不存在的批次ID",
      count: orphanRingBatches.length,
      details: orphanRingBatches.map(r => ({ ringNo: r.ringNo, batchId: r.batchId }))
    });
  }

  const sessionStatsMismatches = [];
  for (const session of db.fieldSessions) {
    const sessionEvents = db.events.filter(e =>
      e.data && e.data.fieldSessionId === session.id
    );
    const actualCaptured = sessionEvents.filter(e => e.eventType === "measurements").length;
    const actualReleased = sessionEvents.filter(e => e.eventType === "releases").length;
    const capturedMismatch = session.capturedCount !== undefined && session.capturedCount !== actualCaptured;
    const releasedMismatch = session.releasedCount !== undefined && session.releasedCount !== actualReleased;
    if (capturedMismatch || releasedMismatch) {
      sessionStatsMismatches.push({
        sessionId: session.id,
        date: session.date,
        capturedCount: { expected: actualCaptured, actual: session.capturedCount },
        releasedCount: { expected: actualReleased, actual: session.releasedCount }
      });
    }
  }
  if (sessionStatsMismatches.length > 0) {
    repairable.push({
      type: "session_stats_mismatch",
      description: "场次统计数字与实际事件数不一致",
      count: sessionStatsMismatches.length,
      details: sessionStatsMismatches,
      repairAction: "recalculate_session_stats",
      repairHint: "根据实际事件重新计算场次的capturedCount和releasedCount"
    });
  }

  const birdSessionRefs = [];
  for (const bird of db.birds) {
    if (bird.fieldSessionId && !sessionMap.has(bird.fieldSessionId)) {
      birdSessionRefs.push({ ringNo: bird.ringNo, fieldSessionId: bird.fieldSessionId });
    }
  }
  if (birdSessionRefs.length > 0) {
    nonRepairable.push({
      type: "bird_invalid_session_ref",
      description: "鸟类引用了不存在的场次ID",
      count: birdSessionRefs.length,
      details: birdSessionRefs
    });
  }

  const eventSessionRefs = [];
  for (const e of db.events) {
    if (e.data && e.data.fieldSessionId && !sessionMap.has(e.data.fieldSessionId)) {
      eventSessionRefs.push({ ringNo: e.ringNo, eventType: e.eventType, eventIndex: e.eventIndex, fieldSessionId: e.data.fieldSessionId });
    }
  }
  if (eventSessionRefs.length > 0) {
    nonRepairable.push({
      type: "event_invalid_session_ref",
      description: "事件引用了不存在的场次ID",
      count: eventSessionRefs.length,
      details: eventSessionRefs
    });
  }

  const orphanAuditBirdRefs = [];
  const orphanAuditRingRefs = [];
  const orphanAuditRingBatchRefs = [];
  const orphanAuditSessionRefs = [];
  const orphanAuditDictRefs = [];
  for (const log of db.auditLogs) {
    switch (log.targetType) {
      case TARGET_TYPES.BIRD:
        if (log.targetId && !birdRingNoSet.has(log.targetId)) {
          orphanAuditBirdRefs.push({ logId: log.id, targetId: log.targetId, operationType: log.operationType });
        }
        break;
      case TARGET_TYPES.RING:
        if (log.targetId && !ringMap.has(log.targetId)) {
          orphanAuditRingRefs.push({ logId: log.id, targetId: log.targetId, operationType: log.operationType });
        }
        break;
      case TARGET_TYPES.RING_BATCH:
        if (log.targetId && !batchMap.has(log.targetId)) {
          orphanAuditRingBatchRefs.push({ logId: log.id, targetId: log.targetId, operationType: log.operationType });
        }
        break;
      case TARGET_TYPES.SESSION:
        if (log.targetId && !sessionMap.has(log.targetId)) {
          orphanAuditSessionRefs.push({ logId: log.id, targetId: log.targetId, operationType: log.operationType });
        }
        break;
      case TARGET_TYPES.DICTIONARY: {
        const dictType = typeof log.targetId === "string" ? log.targetId.split("|")[0] : null;
        const dictValue = typeof log.targetId === "string" ? log.targetId.split("|").slice(1).join("|") : null;
        if (dictType && dictValue && dictValues[dictType] && !dictValues[dictType].has(dictValue)) {
          orphanAuditDictRefs.push({ logId: log.id, targetId: log.targetId, dictType, dictValue, operationType: log.operationType });
        } else if (log.targetId && !dictType) {
          orphanAuditDictRefs.push({ logId: log.id, targetId: log.targetId, operationType: log.operationType, note: "无法解析字典类型" });
        }
        break;
      }
    }
  }
  if (orphanAuditBirdRefs.length > 0) {
    nonRepairable.push({
      type: "audit_invalid_bird_ref",
      description: "审计日志引用了不存在的鸟类环号",
      count: orphanAuditBirdRefs.length,
      details: orphanAuditBirdRefs
    });
  }
  if (orphanAuditRingRefs.length > 0) {
    nonRepairable.push({
      type: "audit_invalid_ring_ref",
      description: "审计日志引用了不存在的环号",
      count: orphanAuditRingRefs.length,
      details: orphanAuditRingRefs
    });
  }
  if (orphanAuditRingBatchRefs.length > 0) {
    nonRepairable.push({
      type: "audit_invalid_ring_batch_ref",
      description: "审计日志引用了不存在的环号批次ID",
      count: orphanAuditRingBatchRefs.length,
      details: orphanAuditRingBatchRefs
    });
  }
  if (orphanAuditSessionRefs.length > 0) {
    nonRepairable.push({
      type: "audit_invalid_session_ref",
      description: "审计日志引用了不存在的场次ID",
      count: orphanAuditSessionRefs.length,
      details: orphanAuditSessionRefs
    });
  }
  if (orphanAuditDictRefs.length > 0) {
    nonRepairable.push({
      type: "audit_invalid_dict_ref",
      description: "审计日志引用了不存在的字典值",
      count: orphanAuditDictRefs.length,
      details: orphanAuditDictRefs
    });
  }

  const result = {
    checkedAt: new Date().toISOString(),
    summary: {
      totalBirds: db.birds.length,
      totalEvents: db.events.length,
      totalFieldSessions: db.fieldSessions.length,
      totalRings: (db.ringInventory.rings || []).length,
      totalBatches: (db.ringInventory.batches || []).length,
      totalAuditLogs: db.auditLogs.length,
      repairableCount: repairable.length,
      nonRepairableCount: nonRepairable.length
    },
    repairable,
    nonRepairable
  };

  const checkAuditEntry = buildAuditLogEntry({
    operationType: OPERATION_TYPES.SYSTEM_CONSISTENCY_CHECK,
    targetType: TARGET_TYPES.SYSTEM,
    targetId: "consistency-check",
    requestSummary: {
      repairableCount: repairable.length,
      nonRepairableCount: nonRepairable.length,
      repairableTypes: repairable.map(r => r.type),
      nonRepairableTypes: nonRepairable.map(r => r.type)
    },
    before: null,
    after: null
  });

  const newAuditLogs = [...db.auditLogs, checkAuditEntry];
  await atomicWriteMulti([
    [STORE_FILES.auditLogs, { logs: newAuditLogs }]
  ]);

  return result;
}

function buildRepairPlanSignature(repairPlan) {
  const items = (repairPlan || []).slice().sort((a, b) => (a.action || "").localeCompare(b.action || ""));
  return JSON.stringify(items);
}

export async function repairConsistency(repairPlan) {
  if (!Array.isArray(repairPlan) || repairPlan.length === 0) {
    throw new Error("empty_repair_plan");
  }

  const validActions = [
    "remove_orphan_events",
    "reindex_events",
    "add_missing_dict_entries",
    "allocate_used_rings",
    "recalculate_session_stats"
  ];
  for (const item of repairPlan) {
    if (!validActions.includes(item.action)) {
      throw new Error(`invalid_repair_action: ${item.action}`);
    }
  }

  const planSignature = buildRepairPlanSignature(repairPlan);
  const checkResult = await checkConsistency();
  const expectedActions = checkResult.repairable.map(r => r.repairAction);
  const planActions = repairPlan.map(p => p.action);
  for (const action of planActions) {
    if (!expectedActions.includes(action)) {
      throw new Error(`action_not_needed: ${action}`);
    }
  }

  const db = await loadAllStoresForConsistency();

  const newEvents = db.events.map(e => ({ ...e }));
  const newDictionaries = JSON.parse(JSON.stringify(db.dictionaries));
  const newRingInventory = JSON.parse(JSON.stringify(db.ringInventory));
  const newFieldSessions = db.fieldSessions.map(s => ({ ...s }));
  const newBirds = db.birds.map(b => ({ ...b }));

  const repairDetails = [];

  for (const item of repairPlan) {
    switch (item.action) {
      case "remove_orphan_events": {
        const birdRingNoSet = new Set(newBirds.map(b => b.ringNo));
        const beforeCount = newEvents.length;
        const removed = [];
        const kept = [];
        for (const e of newEvents) {
          if (!birdRingNoSet.has(e.ringNo)) {
            removed.push({ ringNo: e.ringNo, eventType: e.eventType, eventIndex: e.eventIndex });
          } else {
            kept.push(e);
          }
        }
        newEvents.length = 0;
        newEvents.push(...kept);
        repairDetails.push({ action: item.action, removedCount: removed.length, beforeCount, afterCount: newEvents.length });
        break;
      }
      case "reindex_events": {
        const grouped = new Map();
        for (const e of newEvents) {
          const key = `${e.ringNo}|${e.eventType}`;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key).push(e);
        }
        let reindexedCount = 0;
        for (const [, evts] of grouped) {
          evts.sort((a, b) => a.eventIndex - b.eventIndex);
          for (let i = 0; i < evts.length; i++) {
            if (evts[i].eventIndex !== i) {
              evts[i].eventIndex = i;
              reindexedCount++;
            }
          }
        }
        repairDetails.push({ action: item.action, reindexedCount });
        break;
      }
      case "add_missing_dict_entries": {
        const dictValues = {};
        for (const type of ["species", "capturePlace", "season"]) {
          dictValues[type] = new Set((newDictionaries[type] || []).map(e => e.value));
        }
        const addedEntries = [];
        for (const bird of newBirds) {
          if (bird.species && !dictValues.species.has(bird.species)) {
            const entry = { value: bird.species, description: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            if (!newDictionaries.species) newDictionaries.species = [];
            newDictionaries.species.push(entry);
            dictValues.species.add(bird.species);
            addedEntries.push({ type: "species", value: bird.species });
          }
          if (bird.capturePlace && !dictValues.capturePlace.has(bird.capturePlace)) {
            const entry = { value: bird.capturePlace, description: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            if (!newDictionaries.capturePlace) newDictionaries.capturePlace = [];
            newDictionaries.capturePlace.push(entry);
            dictValues.capturePlace.add(bird.capturePlace);
            addedEntries.push({ type: "capturePlace", value: bird.capturePlace });
          }
          if (bird.season && !dictValues.season.has(bird.season)) {
            const entry = { value: bird.season, description: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            if (!newDictionaries.season) newDictionaries.season = [];
            newDictionaries.season.push(entry);
            dictValues.season.add(bird.season);
            addedEntries.push({ type: "season", value: bird.season });
          }
        }
        for (const session of newFieldSessions) {
          if (session.season && !dictValues.season.has(session.season)) {
            const entry = { value: session.season, description: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            if (!newDictionaries.season) newDictionaries.season = [];
            newDictionaries.season.push(entry);
            dictValues.season.add(session.season);
            addedEntries.push({ type: "season", value: session.season });
          }
          if (session.capturePlace && !dictValues.capturePlace.has(session.capturePlace)) {
            const entry = { value: session.capturePlace, description: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            if (!newDictionaries.capturePlace) newDictionaries.capturePlace = [];
            newDictionaries.capturePlace.push(entry);
            dictValues.capturePlace.add(session.capturePlace);
            addedEntries.push({ type: "capturePlace", value: session.capturePlace });
          }
        }
        const uniqueAdded = [];
        const seenAdded = new Set();
        for (const a of addedEntries) {
          const k = `${a.type}|${a.value}`;
          if (!seenAdded.has(k)) { seenAdded.add(k); uniqueAdded.push(a); }
        }
        repairDetails.push({ action: item.action, addedEntries: uniqueAdded, addedCount: uniqueAdded.length });
        break;
      }
      case "allocate_used_rings": {
        const birdRingNoSet = new Set(newBirds.map(b => b.ringNo));
        const rings = newRingInventory.rings || [];
        const allocatedRings = [];
        for (const ring of rings) {
          if (birdRingNoSet.has(ring.ringNo) && ring.status !== "allocated") {
            const prevStatus = ring.status;
            ring.status = "allocated";
            ring.allocatedTo = ring.ringNo;
            ring.allocatedAt = new Date().toISOString();
            allocatedRings.push({ ringNo: ring.ringNo, previousStatus: prevStatus });
          }
        }
        for (const bird of newBirds) {
          if (!rings.find(r => r.ringNo === bird.ringNo)) {
            const newRing = {
              ringNo: bird.ringNo,
              batchId: null,
              status: "allocated",
              allocatedTo: bird.ringNo,
              allocatedAt: new Date().toISOString(),
              reservedBy: null,
              reservedAt: null,
              reservedExpiresAt: null
            };
            rings.push(newRing);
            allocatedRings.push({ ringNo: bird.ringNo, previousStatus: "not_in_inventory" });
          }
        }
        repairDetails.push({ action: item.action, allocatedCount: allocatedRings.length, details: allocatedRings });
        break;
      }
      case "recalculate_session_stats": {
        const sessionMap = new Map(newFieldSessions.map(s => [s.id, s]));
        const recalculated = [];
        for (const session of newFieldSessions) {
          const sessionEvents = newEvents.filter(e =>
            e.data && e.data.fieldSessionId === session.id
          );
          const actualCaptured = sessionEvents.filter(e => e.eventType === "measurements").length;
          const actualReleased = sessionEvents.filter(e => e.eventType === "releases").length;
          const beforeCaptured = session.capturedCount;
          const beforeReleased = session.releasedCount;
          if (session.capturedCount !== actualCaptured || session.releasedCount !== actualReleased) {
            session.capturedCount = actualCaptured;
            session.releasedCount = actualReleased;
            recalculated.push({
              sessionId: session.id,
              capturedCount: { before: beforeCaptured, after: actualCaptured },
              releasedCount: { before: beforeReleased, after: actualReleased }
            });
          }
        }
        repairDetails.push({ action: item.action, recalculatedCount: recalculated.length, details: recalculated });
        break;
      }
    }
  }

  const repairAuditEntry = buildAuditLogEntry({
    operationType: OPERATION_TYPES.SYSTEM_CONSISTENCY_REPAIR,
    targetType: TARGET_TYPES.SYSTEM,
    targetId: "consistency-repair",
    requestSummary: {
      planSignature,
      repairActions: repairPlan.map(p => p.action),
      repairDetails
    },
    before: {
      repairableCount: checkResult.repairable.length,
      nonRepairableCount: checkResult.nonRepairable.length,
      repairableTypes: checkResult.repairable.map(r => r.type)
    },
    after: {
      repairDetails
    }
  });

  const newAuditLogs = [...db.auditLogs, repairAuditEntry];

  const writeBatch = [];
  writeBatch.push([STORE_FILES.birds, { birds: newBirds }]);
  writeBatch.push([STORE_FILES.events, { events: newEvents }]);
  writeBatch.push([STORE_FILES.dictionaries, newDictionaries]);
  writeBatch.push([STORE_FILES.fieldSessions, { fieldSessions: newFieldSessions }]);
  writeBatch.push([STORE_FILES.ringInventory, newRingInventory]);
  writeBatch.push([STORE_FILES.auditLogs, { logs: newAuditLogs }]);

  await atomicWriteMulti(writeBatch);

  const recheckResult = await checkConsistency();

  return {
    repairedAt: new Date().toISOString(),
    appliedActions: repairPlan.map(p => p.action),
    repairDetails,
    recheck: {
      repairableCount: recheckResult.repairable.length,
      nonRepairableCount: recheckResult.nonRepairable.length,
      repairableTypes: recheckResult.repairable.map(r => r.type),
      nonRepairableTypes: recheckResult.nonRepairable.map(r => r.type)
    }
  };
}

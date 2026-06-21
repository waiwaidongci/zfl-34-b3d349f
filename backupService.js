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
  splitLegacyBirdToEvents
} from "./dataStore.js";
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  recordAuditLog,
  pickBirdKeyFields,
  pickSessionKeyFields,
  pickDictEntryKeyFields,
  pickRingKeyFields
} from "./auditLog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = STORE_FILES.legacySeabirds;
const snapshotsDir = join(__dirname, "data", "snapshots");
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
    summary: snapshotData._meta?.summary || computeSummary(normalizedDb),
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

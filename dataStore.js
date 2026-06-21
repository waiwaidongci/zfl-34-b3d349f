import { mkdir, readFile, writeFile, rename, unlink, glob, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STORE_ORDER = ["birds", "events", "reports", "dictionaries", "fieldSessions", "ringInventory", "auditLogs", "offlineSyncTracker"];

function getDataDir() {
  const envDir = process.env.DATA_DIR;
  if (envDir) {
    return resolve(__dirname, envDir);
  }
  return join(__dirname, "data");
}

function getStoreFiles() {
  const DATA_DIR = getDataDir();
  return {
    birds: join(DATA_DIR, "birds.json"),
    events: join(DATA_DIR, "events.json"),
    reports: join(DATA_DIR, "reports.json"),
    dictionaries: join(DATA_DIR, "dictionaries.json"),
    fieldSessions: join(DATA_DIR, "fieldSessions.json"),
    ringInventory: join(DATA_DIR, "ringInventory.json"),
    auditLogs: join(DATA_DIR, "auditLogs.json"),
    offlineSyncTracker: join(DATA_DIR, "offlineSyncTracker.json"),
    legacySeabirds: join(DATA_DIR, "seabirds.json")
  };
}

function getImportsDir() {
  return join(getDataDir(), "imports");
}

function getImportsIndexPath() {
  return join(getImportsDir(), "index.json");
}

function getTaskFilePath(taskId) {
  return join(getImportsDir(), `${taskId}.json`);
}

function getSnapshotsDir() {
  return join(getDataDir(), "snapshots");
}

function getSnapshotsIndexPath() {
  return join(getSnapshotsDir(), "index.json");
}

function getSnapshotFilePath(fileName) {
  return join(getSnapshotsDir(), fileName);
}

const STORE_FILES = getStoreFiles();
const EVENT_TYPES = ["measurements", "releases", "recaptures", "observations"];

function nowIso() {
  return new Date().toISOString();
}
function buildDictEntry(value, description = null) {
  const t = nowIso();
  return { value, description, createdAt: t, updatedAt: t };
}

const SEED_DATA = {
  birds: {
    birds: [
      {
        ringNo: "SB-26001",
        species: "黑尾鸥",
        sex: "unknown",
        age: "adult",
        capturePlace: "东礁A区",
        season: "2026春",
        fieldSessionId: "FS-2026-0503-001"
      }
    ]
  },
  events: {
    events: [
      {
        ringNo: "SB-26001",
        eventType: "measurements",
        eventIndex: 0,
        data: { at: "2026-05-03", wing: 328, weight: 512, bill: 44, fieldSessionId: "FS-2026-0503-001" }
      },
      {
        ringNo: "SB-26001",
        eventType: "releases",
        eventIndex: 0,
        data: { at: "2026-05-03T09:40:00.000Z", place: "东礁A区", fieldSessionId: "FS-2026-0503-001" }
      },
      {
        ringNo: "SB-26001",
        eventType: "recaptures",
        eventIndex: 0,
        data: { at: "2026-06-11", place: "东礁B区", note: "换羽正常", fieldSessionId: "FS-2026-0611-001" }
      },
      {
        ringNo: "SB-26001",
        eventType: "observations",
        eventIndex: 0,
        data: { at: "2026-06-15", point: "N30.1,E122.3", note: "近岸盘旋" }
      }
    ]
  },
  reports: {
    reports: {
      generatedAt: null,
      recaptureRateCache: []
    }
  },
  dictionaries: (function buildDictSeed() {
    const MANDATORY_SEED = {
      species: ["黑尾鸥"],
      capturePlace: ["东礁A区", "东礁B区"],
      season: ["2026春"]
    };
    const dict = { species: [], capturePlace: [], season: [] };
    for (const type of ["species", "capturePlace", "season"]) {
      for (const v of MANDATORY_SEED[type]) dict[type].push(buildDictEntry(v));
    }
    return dict;
  })(),
  fieldSessions: {
    fieldSessions: [
      {
        id: "FS-2026-0503-001",
        date: "2026-05-03",
        season: "2026春",
        capturePlace: "东礁A区",
        team: ["张三", "李四", "王五"],
        weather: "晴，风力3级",
        tide: "高潮 08:20，潮高2.1m",
        capturedCount: 15,
        releasedCount: 15,
        notes: "鸟群活跃度高，无异常情况",
        createdAt: "2026-05-03T10:00:00.000Z",
        updatedAt: "2026-05-03T18:00:00.000Z"
      },
      {
        id: "FS-2026-0611-001",
        date: "2026-06-11",
        season: "2026春",
        capturePlace: "东礁B区",
        team: ["张三", "李四"],
        weather: "多云，风力4级",
        tide: "低潮 10:15，潮高0.8m",
        capturedCount: 8,
        releasedCount: 8,
        notes: "部分个体处于换羽期",
        createdAt: "2026-06-11T08:00:00.000Z",
        updatedAt: "2026-06-11T16:30:00.000Z"
      }
    ]
  },
  ringInventory: {
    batches: [
      {
        id: "BATCH-2026-SPRING-001",
        prefix: "SB",
        startNo: 26000,
        endNo: 26999,
        season: "2026春",
        description: "2026年春季黑尾鸥环志批次",
        createdAt: "2026-01-15T00:00:00.000Z"
      }
    ],
    rings: [
      {
        ringNo: "SB-26001",
        batchId: "BATCH-2026-SPRING-001",
        status: "allocated",
        allocatedTo: "SB-26001",
        allocatedAt: "2026-05-03T00:00:00.000Z",
        reservedBy: null,
        reservedAt: null,
        reservedExpiresAt: null
      },
      {
        ringNo: "SB-26002",
        batchId: "BATCH-2026-SPRING-001",
        status: "available",
        allocatedTo: null,
        allocatedAt: null,
        reservedBy: null,
        reservedAt: null,
        reservedExpiresAt: null
      }
    ]
  },
  auditLogs: {
    logs: []
  }
};

let migrationState = {
  hasMigrated: false,
  legacyFilePresent: false,
  migratedAt: null,
  migrationDetails: null,
  consistencyCheck: null
};

async function ensureDataDir() {
  const DATA_DIR = getDataDir();
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function ensureImportsDir() {
  const importsDir = getImportsDir();
  if (!existsSync(importsDir)) {
    await mkdir(importsDir, { recursive: true });
  }
}

async function ensureSnapshotsDir() {
  const snapshotsDir = getSnapshotsDir();
  if (!existsSync(snapshotsDir)) {
    await mkdir(snapshotsDir, { recursive: true });
  }
}

const inFlightTempPaths = new Set();

async function cleanupOrphanTempFiles() {
  try {
    const DATA_DIR = getDataDir();
    const tempPattern = join(DATA_DIR, "*.tmp.*");
    const tempFiles = [];
    for await (const entry of glob(tempPattern)) {
      tempFiles.push(entry);
    }
    const toDelete = tempFiles.filter(f => !inFlightTempPaths.has(f));
    for (const f of toDelete) {
      try {
        await unlink(f);
        console.log(`[dataStore] 清理孤儿临时文件: ${f.split("/").pop()}`);
      } catch (_) {}
    }
    if (toDelete.length > 0) {
      console.log(`[dataStore] 共清理 ${toDelete.length} 个孤儿临时文件`);
    }
  } catch (_) {}
}

function generateTempPath(filePath) {
  return `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function atomicWriteFile(filePath, data) {
  const tempPath = generateTempPath(filePath);
  inFlightTempPaths.add(tempPath);
  try {
    const jsonStr = JSON.stringify(data, null, 2);
    await ensureDataDir();
    await writeFile(tempPath, jsonStr, "utf8");
    await rename(tempPath, filePath);
  } finally {
    inFlightTempPaths.delete(tempPath);
  }
}

async function atomicWriteMulti(fileMap) {
  const entries = Array.isArray(fileMap)
    ? fileMap.map(([filePath, data]) => ({ filePath, data, tempPath: generateTempPath(filePath), backupPath: `${filePath}.bak.${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }))
    : Object.entries(fileMap).map(([filePath, data]) => ({ filePath, data, tempPath: generateTempPath(filePath), backupPath: `${filePath}.bak.${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }));

  for (const entry of entries) inFlightTempPaths.add(entry.tempPath);
  await ensureDataDir();

  const changed = [];
  for (const { tempPath, data } of entries) {
    const jsonStr = JSON.stringify(data, null, 2);
    await writeFile(tempPath, jsonStr, "utf8");
  }

  try {
    for (const entry of entries) {
      if (existsSync(entry.filePath)) {
        const fileStat = await stat(entry.filePath);
        if (!fileStat.isFile()) {
          throw new Error(`target_not_file: ${entry.filePath}`);
        }
      }
    }

    for (const entry of entries) {
      if (existsSync(entry.filePath)) {
        await rename(entry.filePath, entry.backupPath);
        entry.backedUp = true;
      }
    }

    for (const entry of entries) {
      await rename(entry.tempPath, entry.filePath);
      entry.committed = true;
      changed.push(entry);
    }

    for (const entry of entries) {
      if (entry.backedUp) await unlink(entry.backupPath);
    }
  } catch (e) {
    for (const entry of changed.reverse()) {
      try {
        if (entry.committed && existsSync(entry.filePath)) await unlink(entry.filePath);
      } catch (_) {}
    }
    for (const entry of entries.reverse()) {
      try {
        if (entry.backedUp && existsSync(entry.backupPath)) await rename(entry.backupPath, entry.filePath);
      } catch (_) {}
      try {
        if (existsSync(entry.tempPath)) await unlink(entry.tempPath);
      } catch (_) {}
    }
    throw e;
  } finally {
    for (const entry of entries) inFlightTempPaths.delete(entry.tempPath);
  }
}

async function readJsonSafely(filePath, defaultValue) {
  if (!existsSync(filePath)) return defaultValue;
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[dataStore] 读取文件失败: ${filePath}`, e.message);
    return defaultValue;
  }
}

function splitLegacyBirdToEvents(legacyBird) {
  const bird = {
    ringNo: legacyBird.ringNo,
    species: legacyBird.species,
    sex: legacyBird.sex,
    age: legacyBird.age,
    capturePlace: legacyBird.capturePlace,
    season: legacyBird.season,
    fieldSessionId: legacyBird.fieldSessionId || null,
    healthRisk: legacyBird.healthRisk || undefined
  };

  const events = [];
  for (const type of EVENT_TYPES) {
    const arr = legacyBird[type] || [];
    for (let i = 0; i < arr.length; i++) {
      events.push({
        ringNo: legacyBird.ringNo,
        eventType: type,
        eventIndex: i,
        data: arr[i]
      });
    }
  }
  return { bird, events };
}

function reassembleBirdFromEvents(birdRecord, allEvents) {
  const birdEvents = allEvents.filter(e => e.ringNo === birdRecord.ringNo);
  const assembled = { ...birdRecord };
  for (const type of EVENT_TYPES) {
    assembled[type] = birdEvents
      .filter(e => e.eventType === type)
      .sort((a, b) => a.eventIndex - b.eventIndex)
      .map(e => e.data);
  }
  return assembled;
}

async function verifyAndRepairConsistency() {
  const result = {
    checkedAt: new Date().toISOString(),
    issues: [],
    repaired: false,
    summary: null
  };

  try {
    const storeFiles = getStoreFiles();
    const birdsStore = await readJsonSafely(storeFiles.birds, null);
    const eventsStore = await readJsonSafely(storeFiles.events, null);

    if (!birdsStore || !eventsStore) {
      result.issues.push("store_files_missing");
      migrationState.consistencyCheck = result;
      return result;
    }

    const birds = birdsStore.birds || [];
    const events = eventsStore.events || [];
    const birdRingNos = new Set(birds.map(b => b.ringNo));

    const orphanEvents = events.filter(e => !birdRingNos.has(e.ringNo));
    if (orphanEvents.length > 0) {
      result.issues.push(`orphan_events: ${orphanEvents.length}`);
    }

    const birdsByRing = new Map(birds.map(b => [b.ringNo, b]));
    const eventsByBirdAndType = new Map();
    for (const e of events) {
      const key = `${e.ringNo}|${e.eventType}`;
      if (!eventsByBirdAndType.has(key)) eventsByBirdAndType.set(key, []);
      eventsByBirdAndType.get(key).push(e);
    }

    for (const [ringNo, bird] of birdsByRing) {
      for (const type of EVENT_TYPES) {
        const key = `${ringNo}|${type}`;
        const birdEvents = eventsByBirdAndType.get(key) || [];
        if (birdEvents.length === 0) continue;

        const sorted = [...birdEvents].sort((a, b) => a.eventIndex - b.eventIndex);
        for (let i = 0; i < sorted.length; i++) {
          if (sorted[i].eventIndex !== i) {
            result.issues.push(`index_gap: ${ringNo}.${type} expected ${i} got ${sorted[i].eventIndex}`);
          }
        }
      }
    }

    result.summary = {
      totalBirds: birds.length,
      totalEvents: events.length,
      orphanEventCount: orphanEvents.length,
      birdRingNos: Array.from(birdRingNos)
    };

    migrationState.consistencyCheck = result;

    if (result.issues.length > 0 && !result.repaired) {
      console.warn(`[dataStore] 一致性问题: ${JSON.stringify(result.issues)}`);
    } else if (result.issues.length === 0) {
      console.log(`[dataStore] 一致性检查通过: ${result.summary.totalBirds} birds, ${result.summary.totalEvents} events`);
    }
  } catch (e) {
    result.issues.push(`check_error: ${e.message}`);
    console.error(`[dataStore] 一致性检查失败:`, e.message);
  }

  return result;
}

async function performMigration() {
  const storeFiles = getStoreFiles();
  const legacyPath = storeFiles.legacySeabirds;
  const legacyExists = existsSync(legacyPath);
  migrationState.legacyFilePresent = legacyExists;

  const missingStores = [];
  for (const storeName of STORE_ORDER) {
    if (!existsSync(storeFiles[storeName])) {
      missingStores.push(storeName);
    }
  }

  if (missingStores.length === 0) {
    return;
  }

  console.log(`[dataStore] 检测到缺失文件: ${missingStores.join(", ")}，开始初始化`);
  await ensureDataDir();

  const writeBatch = [];

  if (legacyExists && (missingStores.includes("birds") || missingStores.includes("events"))) {
    const legacy = await readJsonSafely(legacyPath, { birds: [] });
    const legacyBirds = legacy.birds || [];

    const newBirds = [];
    const newEvents = [];
    for (const lb of legacyBirds) {
      const { bird, events } = splitLegacyBirdToEvents(lb);
      newBirds.push(bird);
      newEvents.push(...events);
    }

    if (missingStores.includes("birds")) {
      writeBatch.push([storeFiles.birds, { birds: newBirds }]);
    }
    if (missingStores.includes("events")) {
      writeBatch.push([storeFiles.events, { events: newEvents }]);
    }
    if (missingStores.includes("reports")) {
      writeBatch.push([storeFiles.reports, JSON.parse(JSON.stringify(SEED_DATA.reports))]);
    }
    for (const storeName of missingStores) {
      if (storeName !== "birds" && storeName !== "events" && storeName !== "reports") {
        const seedData = SEED_DATA[storeName];
        const data = seedData !== undefined
          ? JSON.parse(JSON.stringify(seedData))
          : defaultForStore(storeName);
        writeBatch.push([storeFiles[storeName], data]);
      }
    }

    migrationState.hasMigrated = true;
    migrationState.migratedAt = new Date().toISOString();
    migrationState.migrationDetails = {
      legacyBirdCount: legacyBirds.length,
      migratedBirdCount: newBirds.length,
      migratedEventCount: newEvents.length
    };
  } else {
    for (const storeName of missingStores) {
      const seedData = SEED_DATA[storeName];
      const data = seedData !== undefined
        ? JSON.parse(JSON.stringify(seedData))
        : defaultForStore(storeName);
      writeBatch.push([storeFiles[storeName], data]);
    }
  }

  const dictSeedIdx = writeBatch.findIndex(([p]) => p === storeFiles.dictionaries);
  if (dictSeedIdx !== -1 && legacyExists) {
    const legacy = await readJsonSafely(legacyPath, { birds: [] });
    const existingValues = { species: new Set(), capturePlace: new Set(), season: new Set() };
    for (const b of legacy.birds || []) {
      if (b.species) existingValues.species.add(b.species);
      if (b.capturePlace) existingValues.capturePlace.add(b.capturePlace);
      if (b.season) existingValues.season.add(b.season);
    }

    const sessionsSeed = SEED_DATA.fieldSessions.fieldSessions || [];
    for (const s of sessionsSeed) {
      if (s.season) existingValues.season.add(s.season);
      if (s.capturePlace) existingValues.capturePlace.add(s.capturePlace);
    }

    const dict = { species: [], capturePlace: [], season: [] };
    const mandatory = {
      species: ["黑尾鸥"],
      capturePlace: ["东礁A区", "东礁B区"],
      season: ["2026春"]
    };
    for (const type of ["species", "capturePlace", "season"]) {
      const values = new Set([...mandatory[type], ...existingValues[type]]);
      for (const v of values) dict[type].push(buildDictEntry(v));
    }
    writeBatch[dictSeedIdx][1] = dict;
  }

  await atomicWriteMulti(writeBatch);

  console.log(`[dataStore] 数据结构初始化完成 (${migrationState.hasMigrated ? `从旧文件迁移: ${migrationState.migrationDetails.migratedBirdCount} birds, ${migrationState.migrationDetails.migratedEventCount} events` : `种子数据, ${missingStores.length} 个文件`})`);
}

async function initialize() {
  await ensureDataDir();
  await cleanupOrphanTempFiles();
  await performMigration();
  await verifyAndRepairConsistency();
}

function getMigrationState() {
  return { ...migrationState };
}

async function readBirdsStore() {
  const storeFiles = getStoreFiles();
  return await readJsonSafely(storeFiles.birds, { birds: [] });
}

async function readEventsStore() {
  const storeFiles = getStoreFiles();
  return await readJsonSafely(storeFiles.events, { events: [] });
}

async function readReportsStore() {
  const storeFiles = getStoreFiles();
  return await readJsonSafely(storeFiles.reports, { reports: {} });
}

async function writeBirdsStore(data) {
  const storeFiles = getStoreFiles();
  await atomicWriteFile(storeFiles.birds, data);
}

async function writeEventsStore(data) {
  const storeFiles = getStoreFiles();
  await atomicWriteFile(storeFiles.events, data);
}

async function writeReportsStore(data) {
  const storeFiles = getStoreFiles();
  await atomicWriteFile(storeFiles.reports, data);
}

async function loadLegacyCompatibleDb() {
  await initialize();
  const birdsStore = await readBirdsStore();
  const eventsStore = await readEventsStore();

  const birds = (birdsStore.birds || []).map(b =>
    reassembleBirdFromEvents(b, eventsStore.events || [])
  );

  return { birds };
}

async function saveLegacyCompatibleDb(db) {
  const storeFiles = getStoreFiles();
  const legacyBirds = db.birds || [];

  const newBirds = [];
  const newEvents = [];
  for (const lb of legacyBirds) {
    const { bird, events } = splitLegacyBirdToEvents(lb);
    newBirds.push(bird);
    newEvents.push(...events);
  }

  await atomicWriteMulti([
    [storeFiles.birds, { birds: newBirds }],
    [storeFiles.events, { events: newEvents }]
  ]);
}

async function writeBirdsAndEventsStore(birdsData, eventsData) {
  const storeFiles = getStoreFiles();
  await atomicWriteMulti([
    [storeFiles.birds, birdsData],
    [storeFiles.events, eventsData]
  ]);
}

function eventsFromBirdSubrecords(ringNo, eventType, subrecords) {
  return subrecords.map((data, i) => ({
    ringNo,
    eventType,
    eventIndex: i,
    data
  }));
}

function groupEventsByRing(events) {
  const map = new Map();
  for (const e of events) {
    if (!map.has(e.ringNo)) map.set(e.ringNo, { measurements: [], releases: [], recaptures: [], observations: [] });
    map.get(e.ringNo)[e.eventType].push(e);
  }
  for (const arrMap of map.values()) {
    for (const type of EVENT_TYPES) {
      arrMap[type].sort((a, b) => a.eventIndex - b.eventIndex);
    }
  }
  return map;
}

async function readStore(storeName) {
  const storeFiles = getStoreFiles();
  const path = storeFiles[storeName];
  if (!path) throw new Error(`unknown_store: ${storeName}`);
  return await readJsonSafely(path, defaultForStore(storeName));
}

async function writeStore(storeName, data) {
  const storeFiles = getStoreFiles();
  const path = storeFiles[storeName];
  if (!path) throw new Error(`unknown_store: ${storeName}`);
  await atomicWriteFile(path, data);
}

function defaultForStore(storeName) {
  switch (storeName) {
    case "birds": return { birds: [] };
    case "events": return { events: [] };
    case "reports": return { reports: {} };
    case "dictionaries": return { species: [], capturePlace: [], season: [] };
    case "fieldSessions": return { fieldSessions: [] };
    case "ringInventory": return { batches: [], rings: [] };
    case "auditLogs": return { logs: [] };
    case "offlineSyncTracker": return { processedPackets: [] };
    default: return {};
  }
}

export {
  STORE_FILES,
  STORE_ORDER,
  EVENT_TYPES,
  SEED_DATA,
  getDataDir,
  getStoreFiles,
  getImportsDir,
  getImportsIndexPath,
  getTaskFilePath,
  getSnapshotsDir,
  getSnapshotsIndexPath,
  getSnapshotFilePath,
  ensureDataDir,
  ensureImportsDir,
  ensureSnapshotsDir,
  initialize,
  getMigrationState,
  loadLegacyCompatibleDb,
  saveLegacyCompatibleDb,
  readBirdsStore,
  readEventsStore,
  readReportsStore,
  writeBirdsStore,
  writeEventsStore,
  writeReportsStore,
  writeBirdsAndEventsStore,
  splitLegacyBirdToEvents,
  reassembleBirdFromEvents,
  eventsFromBirdSubrecords,
  groupEventsByRing,
  readStore,
  writeStore,
  atomicWriteMulti,
  defaultForStore,
  atomicWriteFile,
  readJsonSafely,
  verifyAndRepairConsistency,
  cleanupOrphanTempFiles
};

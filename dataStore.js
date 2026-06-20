import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

const STORE_FILES = {
  birds: join(DATA_DIR, "birds.json"),
  events: join(DATA_DIR, "events.json"),
  reports: join(DATA_DIR, "reports.json"),
  dictionaries: join(DATA_DIR, "dictionaries.json"),
  fieldSessions: join(DATA_DIR, "fieldSessions.json"),
  ringInventory: join(DATA_DIR, "ringInventory.json"),
  auditLogs: join(DATA_DIR, "auditLogs.json"),
  legacySeabirds: join(DATA_DIR, "seabirds.json")
};

const EVENT_TYPES = ["measurements", "releases", "recaptures", "observations"];

const SEED_BIRDS = {
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
};

const SEED_EVENTS = {
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
};

const SEED_REPORTS = {
  reports: {
    generatedAt: null,
    recaptureRateCache: []
  }
};

let migrationState = {
  hasMigrated: false,
  legacyFilePresent: false,
  migratedAt: null,
  migrationDetails: null
};

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function atomicWriteFile(filePath, data) {
  const tempPath = `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const jsonStr = JSON.stringify(data, null, 2);
  await ensureDataDir();
  await writeFile(tempPath, jsonStr, "utf8");
  await rename(tempPath, filePath);
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

async function performMigration() {
  const legacyPath = STORE_FILES.legacySeabirds;
  const legacyExists = existsSync(legacyPath);
  migrationState.legacyFilePresent = legacyExists;

  const birdsPath = STORE_FILES.birds;
  const eventsPath = STORE_FILES.events;
  const reportsPath = STORE_FILES.reports;

  const birdsExist = existsSync(birdsPath);
  const eventsExist = existsSync(eventsPath);
  const reportsExist = existsSync(reportsPath);

  if (birdsExist && eventsExist && reportsExist) {
    return;
  }

  await ensureDataDir();

  let birdsData;
  let eventsData;
  let reportsData;

  if (legacyExists) {
    const legacy = await readJsonSafely(legacyPath, { birds: [] });
    const legacyBirds = legacy.birds || [];

    const newBirds = [];
    const newEvents = [];
    for (const lb of legacyBirds) {
      const { bird, events } = splitLegacyBirdToEvents(lb);
      newBirds.push(bird);
      newEvents.push(...events);
    }

    birdsData = { birds: newBirds };
    eventsData = { events: newEvents };
    reportsData = JSON.parse(JSON.stringify(SEED_REPORTS));

    migrationState.hasMigrated = true;
    migrationState.migratedAt = new Date().toISOString();
    migrationState.migrationDetails = {
      legacyBirdCount: legacyBirds.length,
      migratedBirdCount: newBirds.length,
      migratedEventCount: newEvents.length
    };
  } else {
    birdsData = JSON.parse(JSON.stringify(SEED_BIRDS));
    eventsData = JSON.parse(JSON.stringify(SEED_EVENTS));
    reportsData = JSON.parse(JSON.stringify(SEED_REPORTS));
  }

  await atomicWriteFile(birdsPath, birdsData);
  await atomicWriteFile(eventsPath, eventsData);
  await atomicWriteFile(reportsPath, reportsData);

  console.log(`[dataStore] 数据结构初始化完成 ${migrationState.hasMigrated ? `(从旧文件迁移: ${migrationState.migrationDetails.migratedBirdCount} birds, ${migrationState.migrationDetails.migratedEventCount} events)` : "(种子数据)"}`);
}

async function initialize() {
  await ensureDataDir();
  await performMigration();
}

function getMigrationState() {
  return { ...migrationState };
}

async function readBirdsStore() {
  return await readJsonSafely(STORE_FILES.birds, { birds: [] });
}

async function readEventsStore() {
  return await readJsonSafely(STORE_FILES.events, { events: [] });
}

async function readReportsStore() {
  return await readJsonSafely(STORE_FILES.reports, { reports: {} });
}

async function writeBirdsStore(data) {
  await atomicWriteFile(STORE_FILES.birds, data);
}

async function writeEventsStore(data) {
  await atomicWriteFile(STORE_FILES.events, data);
}

async function writeReportsStore(data) {
  await atomicWriteFile(STORE_FILES.reports, data);
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
  const legacyBirds = db.birds || [];

  const newBirds = [];
  const newEvents = [];
  for (const lb of legacyBirds) {
    const { bird, events } = splitLegacyBirdToEvents(lb);
    newBirds.push(bird);
    newEvents.push(...events);
  }

  await writeBirdsStore({ birds: newBirds });
  await writeEventsStore({ events: newEvents });
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
  const path = STORE_FILES[storeName];
  if (!path) throw new Error(`unknown_store: ${storeName}`);
  return await readJsonSafely(path, defaultForStore(storeName));
}

async function writeStore(storeName, data) {
  const path = STORE_FILES[storeName];
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
    default: return {};
  }
}

export {
  STORE_FILES,
  EVENT_TYPES,
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
  splitLegacyBirdToEvents,
  reassembleBirdFromEvents,
  eventsFromBirdSubrecords,
  groupEventsByRing,
  readStore,
  writeStore,
  defaultForStore,
  atomicWriteFile,
  readJsonSafely
};

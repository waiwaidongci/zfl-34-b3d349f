import { mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { validateSnapshotStructure } from "./backupValidator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "seabirds.json");
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
    await writeFile(indexPath, JSON.stringify({ snapshots: [] }, null, 2));
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
  await writeFile(indexPath, JSON.stringify(data, null, 2));
}

function generateSnapshotId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `SNAP-${ts}-${randomUUID().slice(0, 8)}`;
}

function computeSummary(db) {
  const birds = db.birds || [];
  const speciesCount = {};
  for (const bird of birds) {
    speciesCount[bird.species] = (speciesCount[bird.species] || 0) + 1;
  }
  return {
    totalBirds: birds.length,
    speciesBreakdown: Object.entries(speciesCount).map(([species, count]) => ({ species, count })),
    totalMeasurements: birds.reduce((s, b) => s + (b.measurements?.length || 0), 0),
    totalRecaptures: birds.reduce((s, b) => s + (b.recaptures?.length || 0), 0),
    totalObservations: birds.reduce((s, b) => s + (b.observations?.length || 0), 0),
    totalReleases: birds.reduce((s, b) => s + (b.releases?.length || 0), 0)
  };
}

export async function createSnapshot() {
  if (!existsSync(dbPath)) {
    throw new Error("db_not_found");
  }

  const raw = await readFile(dbPath, "utf8");
  let db;
  try {
    db = JSON.parse(raw);
  } catch {
    throw new Error("db_parse_error");
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
      sourceFile: "data/seabirds.json",
      summary: computeSummary(db)
    },
    data: db
  };

  await ensureSnapshotsDir();
  await writeFile(snapshotFilePath, JSON.stringify(snapshotData, null, 2));

  const index = await loadIndex();
  index.snapshots.push({
    snapshotId,
    createdAt: snapshotData._meta.createdAt,
    fileName: snapshotFileName,
    summary: snapshotData._meta.summary
  });
  await saveIndex(index);

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

  return {
    snapshotId: entry.snapshotId,
    createdAt: entry.createdAt,
    summary: snapshotData._meta?.summary || entry.summary,
    validation: validateSnapshotStructure(snapshotData.data)
  };
}

export async function restoreFromSnapshot(snapshotId) {
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

  const db = snapshotData.data;
  if (!db) throw new Error("snapshot_data_missing");

  const validation = validateSnapshotStructure(db);
  if (!validation.valid) {
    const err = new Error("snapshot_structure_invalid");
    err.validationErrors = validation.errors;
    throw err;
  }

  await writeFile(dbPath, JSON.stringify(db, null, 2));

  return {
    snapshotId,
    restoredAt: new Date().toISOString(),
    summary: computeSummary(db)
  };
}

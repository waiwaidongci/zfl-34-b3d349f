import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { syncAllocateRing } from "./ringInventory.js";
import { persistRiskToBird } from "./healthRisk.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const birdsPath = join(__dirname, "data", "seabirds.json");

const KNOWN_SPECIES = new Set([
  "黑尾鸥", "黑嘴鸥", "遗鸥", "红嘴鸥", "普通燕鸥",
  "白额圆尾鹱", "黑叉尾海燕", "大凤头燕鸥", "粉红燕鸥",
  "褐翅燕鸥", "灰背鸥", "海鸥", "北极鸥", "三趾鸥"
]);

const REQUIRED_FIELDS = ["ringNo", "species"];

const PREVIEW_TTL_MS = 30 * 60 * 1000;

const previewCache = new Map();

function cleanupCache() {
  const now = Date.now();
  for (const [id, entry] of previewCache) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) {
      previewCache.delete(id);
    }
  }
}

async function loadBirds() {
  if (!existsSync(birdsPath)) return { birds: [] };
  return JSON.parse(await readFile(birdsPath, "utf8"));
}

async function saveBirds(db) {
  await writeFile(birdsPath, JSON.stringify(db, null, 2));
}

function buildKnownSpeciesSet(existingBirds) {
  const species = new Set(KNOWN_SPECIES);
  for (const bird of existingBirds) {
    if (bird.species) species.add(bird.species);
  }
  return species;
}

function validateBirds(records, existingBirds) {
  const knownSpecies = buildKnownSpeciesSet(existingBirds);
  const existingRingNos = new Set(existingBirds.map(b => b.ringNo));
  const batchRingCounts = new Map();

  const fieldErrors = [];
  const duplicateInBatch = [];
  const duplicateInDb = [];
  const missingMeasurements = [];
  const unknownSpeciesMap = new Map();

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const errors = [];

    for (const field of REQUIRED_FIELDS) {
      if (!rec[field]) {
        errors.push({ field, message: `缺少必填字段: ${field}` });
      }
    }

    if (rec.ringNo && typeof rec.ringNo !== "string") {
      errors.push({ field: "ringNo", message: "ringNo 必须为字符串" });
    }

    if (rec.species && typeof rec.species !== "string") {
      errors.push({ field: "species", message: "species 必须为字符串" });
    }

    if (rec.species && !knownSpecies.has(rec.species)) {
      const arr = unknownSpeciesMap.get(rec.species) || [];
      arr.push({ index: i, ringNo: rec.ringNo || "(missing)" });
      unknownSpeciesMap.set(rec.species, arr);
    }

    if (errors.length > 0) {
      fieldErrors.push({ index: i, ringNo: rec.ringNo || "(missing)", errors });
    }

    if (rec.ringNo) {
      const count = batchRingCounts.get(rec.ringNo) || 0;
      batchRingCounts.set(rec.ringNo, count + 1);
      if (count === 1) {
        duplicateInBatch.push(rec.ringNo);
      }
    }

    if (rec.ringNo && existingRingNos.has(rec.ringNo)) {
      duplicateInDb.push({ index: i, ringNo: rec.ringNo });
    }

    if (!rec.measurements || !Array.isArray(rec.measurements) || rec.measurements.length === 0) {
      missingMeasurements.push({ index: i, ringNo: rec.ringNo || "(missing)" });
    }
  }

  return {
    totalRecords: records.length,
    validRecords: records.length - fieldErrors.length - duplicateInDb.length,
    fieldErrors,
    duplicateInBatch,
    duplicateInDb,
    missingMeasurements,
    unknownSpecies: [...unknownSpeciesMap.entries()].map(([species, records]) => ({
      species,
      count: records.length,
      records
    })),
    hasBlockingErrors: fieldErrors.length > 0 || duplicateInDb.length > 0
  };
}

function createPreview(records, existingBirds) {
  cleanupCache();

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("invalid_input");
  }

  const validation = validateBirds(records, existingBirds);
  const previewId = `IMP-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6)}`;

  const preview = {
    previewId,
    createdAt: Date.now(),
    records,
    validation,
    status: validation.hasBlockingErrors ? "blocked" : "ready"
  };

  previewCache.set(previewId, preview);
  return preview;
}

function getPreview(previewId) {
  cleanupCache();
  const entry = previewCache.get(previewId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PREVIEW_TTL_MS) {
    previewCache.delete(previewId);
    return null;
  }
  return entry;
}

async function commitImport(previewId) {
  const preview = getPreview(previewId);
  if (!preview) {
    throw new Error("preview_not_found");
  }
  if (preview.status === "committed") {
    throw new Error("already_committed");
  }
  if (preview.validation.hasBlockingErrors) {
    throw new Error("has_blocking_errors");
  }

  const db = await loadBirds();
  const existingRingNos = new Set(db.birds.map(b => b.ringNo));
  const imported = [];
  const skipped = [];

  for (const rec of preview.records) {
    if (existingRingNos.has(rec.ringNo)) {
      skipped.push({ ringNo: rec.ringNo, reason: "duplicate_in_db" });
      continue;
    }
    if (!rec.ringNo || !rec.species) {
      skipped.push({ ringNo: rec.ringNo || "(missing)", reason: "missing_required_field" });
      continue;
    }

    const bird = {
      ringNo: rec.ringNo,
      species: rec.species,
      sex: rec.sex || "unknown",
      age: rec.age || null,
      capturePlace: rec.capturePlace || null,
      season: rec.season || null,
      fieldSessionId: rec.fieldSessionId || null,
      measurements: (rec.measurements || []).map(m => ({
        ...m,
        at: m.at || new Date().toISOString().slice(0, 10),
        fieldSessionId: m.fieldSessionId || rec.fieldSessionId || null
      })),
      releases: (rec.releases || []).map(r => ({
        ...r,
        at: r.at || new Date().toISOString(),
        fieldSessionId: r.fieldSessionId || rec.fieldSessionId || null
      })),
      recaptures: [],
      observations: []
    };

    persistRiskToBird(bird);
    db.birds.push(bird);
    imported.push(bird);
    existingRingNos.add(rec.ringNo);
  }

  await saveBirds(db);

  for (const bird of imported) {
    try {
      await syncAllocateRing(bird.ringNo, bird.ringNo);
    } catch (_) {}
  }

  preview.status = "committed";
  preview.committedAt = new Date().toISOString();

  return {
    previewId,
    imported: imported.length,
    skipped: skipped.length,
    skippedDetails: skipped
  };
}

export { validateBirds, createPreview, getPreview, commitImport, KNOWN_SPECIES };

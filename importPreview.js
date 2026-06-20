import {
  initialize,
  loadLegacyCompatibleDb,
  readBirdsStore,
  readEventsStore,
  writeBirdsStore,
  writeEventsStore,
  writeBirdsAndEventsStore,
  reassembleBirdFromEvents
} from "./dataStore.js";
import { randomUUID } from "node:crypto";
import { syncAllocateRing } from "./ringInventory.js";
import { persistRiskToBird } from "./healthRisk.js";
import { validateDictionaryValue, validateDictionaryValues } from "./dictionaries.js";
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  recordAuditLog,
  pickBirdKeyFields
} from "./auditLog.js";

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
  await initialize();
  return await loadLegacyCompatibleDb();
}

function buildKnownSpeciesSet(existingBirds) {
  const species = new Set(KNOWN_SPECIES);
  for (const bird of existingBirds) {
    if (bird.species) species.add(bird.species);
  }
  return species;
}

async function validateBirds(records, existingBirds) {
  const existingRingNos = new Set(existingBirds.map(b => b.ringNo));
  const batchRingCounts = new Map();

  const fieldErrors = [];
  const duplicateInBatch = [];
  const duplicateInDb = [];
  const missingMeasurements = [];
  const unknownSpeciesMap = new Map();
  const dictValidationWarnings = [];

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

    if (rec.species) {
      const speciesCheck = await validateDictionaryValue("species", rec.species, { allowEmpty: false });
      if (!speciesCheck.valid) {
        const arr = unknownSpeciesMap.get(rec.species) || [];
        arr.push({ index: i, ringNo: rec.ringNo || "(missing)" });
        unknownSpeciesMap.set(rec.species, arr);
      }
    }

    if (rec.capturePlace) {
      const placeCheck = await validateDictionaryValue("capturePlace", rec.capturePlace, { allowEmpty: true });
      if (!placeCheck.valid) {
        dictValidationWarnings.push({ index: i, ringNo: rec.ringNo || "(missing)", field: "capturePlace", value: rec.capturePlace });
      }
    }

    if (rec.season) {
      const seasonCheck = await validateDictionaryValue("season", rec.season, { allowEmpty: true });
      if (!seasonCheck.valid) {
        dictValidationWarnings.push({ index: i, ringNo: rec.ringNo || "(missing)", field: "season", value: rec.season });
      }
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
    dictValidationWarnings,
    hasBlockingErrors: fieldErrors.length > 0 || duplicateInDb.length > 0 || unknownSpeciesMap.size > 0
  };
}

async function createPreview(records, existingBirds) {
  cleanupCache();

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("invalid_input");
  }

  const validation = await validateBirds(records, existingBirds);
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
  await initialize();
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

  const birdsStore = await readBirdsStore();
  const eventsStore = await readEventsStore();
  const existingRingNos = new Set(birdsStore.birds.map(b => b.ringNo));
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

    const speciesCheck = await validateDictionaryValue("species", rec.species, { allowEmpty: false });
    if (!speciesCheck.valid) {
      skipped.push({ ringNo: rec.ringNo, reason: "dictionary_validation_failed", invalidFields: ["species"] });
      continue;
    }

    const bird = {
      ringNo: rec.ringNo,
      species: rec.species,
      sex: rec.sex || "unknown",
      age: rec.age || null,
      capturePlace: rec.capturePlace || null,
      season: rec.season || null,
      fieldSessionId: rec.fieldSessionId || null
    };

    const birdEvents = [];
    const eventTypes = ["measurements", "releases", "recaptures", "observations"];
    for (const type of eventTypes) {
      const arr = (type === "recaptures" || type === "observations")
        ? []
        : (rec[type] || []);
      for (let i = 0; i < arr.length; i++) {
        const entry = { ...arr[i] };
        if (type === "measurements" && !entry.at) entry.at = new Date().toISOString().slice(0, 10);
        if (type === "releases" && !entry.at) entry.at = new Date().toISOString();
        if (!entry.fieldSessionId && rec.fieldSessionId) entry.fieldSessionId = rec.fieldSessionId;
        birdEvents.push({
          ringNo: rec.ringNo,
          eventType: type,
          eventIndex: i,
          data: entry
        });
      }
    }

    const assembledBird = reassembleBirdFromEvents(bird, birdEvents);
    persistRiskToBird(assembledBird);
    bird.healthRisk = assembledBird.healthRisk;

    birdsStore.birds.push(bird);
    eventsStore.events.push(...birdEvents);
    imported.push(reassembleBirdFromEvents(bird, [...eventsStore.events, ...birdEvents]));
    existingRingNos.add(rec.ringNo);
  }

  await writeBirdsAndEventsStore(birdsStore, eventsStore);

  for (const bird of imported) {
    try {
      await syncAllocateRing(bird.ringNo, bird.ringNo);
    } catch (_) {}
  }

  preview.status = "committed";
  preview.committedAt = new Date().toISOString();

  const importedRingNos = imported.map(b => b.ringNo);
  recordAuditLog({
    operationType: OPERATION_TYPES.BIRD_BATCH_IMPORT,
    targetType: TARGET_TYPES.BIRD,
    targetId: previewId,
    requestSummary: { previewId, importedCount: imported.length, skippedCount: skipped.length, importedRingNos, skippedDetails: skipped },
    before: null,
    after: imported.map(b => pickBirdKeyFields(b))
  });

  return {
    previewId,
    imported: imported.length,
    skipped: skipped.length,
    skippedDetails: skipped
  };
}

export { validateBirds, createPreview, getPreview, commitImport, KNOWN_SPECIES };

import { mkdir, readFile, unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  initialize,
  loadLegacyCompatibleDb,
  readBirdsStore,
  readEventsStore,
  readStore,
  writeBirdsAndEventsStore,
  reassembleBirdFromEvents,
  atomicWriteFile,
  atomicWriteMulti,
  STORE_FILES,
  getImportsDir,
  getImportsIndexPath,
  getTaskFilePath,
  ensureImportsDir
} from "./dataStore.js";
import { getRingStatus, syncAllocateRing } from "./ringInventory.js";
import { persistRiskToBird } from "./healthRisk.js";
import { validateDictionaryValue } from "./dictionaries.js";
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  recordAuditLog,
  pickBirdKeyFields
} from "./auditLog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const KNOWN_SPECIES = new Set([
  "黑尾鸥", "黑嘴鸥", "遗鸥", "红嘴鸥", "普通燕鸥",
  "白额圆尾鹱", "黑叉尾海燕", "大凤头燕鸥", "粉红燕鸥",
  "褐翅燕鸥", "灰背鸥", "海鸥", "北极鸥", "三趾鸥"
]);

const REQUIRED_FIELDS = ["ringNo", "species"];
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;

const TASK_STATUS = {
  READY: "ready",
  BLOCKED: "blocked",
  COMMITTING: "committing",
  PARTIAL: "partial",
  COMMITTED: "committed",
  EXPIRED: "expired"
};

function generateTaskId() {
  return `IMP-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6)}`;
}

async function loadIndex() {
  await ensureImportsDir();
  const INDEX_PATH = getImportsIndexPath();
  if (!existsSync(INDEX_PATH)) {
    const defaultIndex = { tasks: [] };
    await atomicWriteFile(INDEX_PATH, defaultIndex);
    return defaultIndex;
  }
  try {
    return JSON.parse(await readFile(INDEX_PATH, "utf8"));
  } catch {
    return { tasks: [] };
  }
}

async function saveIndex(index) {
  await ensureImportsDir();
  const INDEX_PATH = getImportsIndexPath();
  await atomicWriteFile(INDEX_PATH, index);
}

async function cleanupExpired() {
  const now = Date.now();
  const index = await loadIndex();
  const toDelete = [];
  const remaining = [];
  for (const entry of index.tasks) {
    if (entry.status !== TASK_STATUS.COMMITTED && now - entry.createdAt > TASK_TTL_MS) {
      toDelete.push(entry.taskId);
    } else {
      remaining.push(entry);
    }
  }
  if (toDelete.length > 0) {
    for (const taskId of toDelete) {
      try {
        const fp = getTaskFilePath(taskId);
        if (existsSync(fp)) await unlink(fp);
      } catch (_) {}
    }
    index.tasks = remaining;
    await saveIndex(index);
  }
  return toDelete;
}

function isTaskExpired(task) {
  if (!task) return true;
  if (task.status === TASK_STATUS.COMMITTED) return false;
  return Date.now() - task.createdAt > TASK_TTL_MS;
}

async function loadTask(taskId) {
  await cleanupExpired();
  const fp = getTaskFilePath(taskId);
  if (!existsSync(fp)) return null;
  try {
    const task = JSON.parse(await readFile(fp, "utf8"));
    if (isTaskExpired(task)) {
      task.status = TASK_STATUS.EXPIRED;
      await saveTask(task);
      const idx = await loadIndex();
      const entry = idx.tasks.find(t => t.taskId === taskId);
      if (entry) {
        entry.status = TASK_STATUS.EXPIRED;
        await saveIndex(idx);
      }
      return task;
    }
    return task;
  } catch {
    return null;
  }
}

async function saveTask(task) {
  await ensureImportsDir();
  const fp = getTaskFilePath(task.taskId);
  await atomicWriteFile(fp, task);
  const index = await loadIndex();
  const existingIdx = index.tasks.findIndex(t => t.taskId === task.taskId);
  const summaryEntry = {
    taskId: task.taskId,
    createdAt: task.createdAt,
    expiresAt: task.createdAt + TASK_TTL_MS,
    status: task.status,
    totalRecords: task.records.length,
    validation: {
      hasBlockingErrors: task.validation?.hasBlockingErrors || false,
      validRecords: task.validation?.validRecords || 0,
      fieldErrors: task.validation?.fieldErrors?.length || 0,
      duplicateInDb: task.validation?.duplicateInDb?.length || 0
    },
    commitProgress: task.commitState ? {
      processed: task.commitState.processedCount || 0,
      committed: task.commitState.successCount || 0,
      skipped: task.commitState.skippedCount || 0,
      failed: task.commitState.failedCount || 0,
      total: task.records.length
    } : null,
    committedAt: task.commitState?.committedAt || null
  };
  if (existingIdx >= 0) {
    index.tasks[existingIdx] = summaryEntry;
  } else {
    index.tasks.unshift(summaryEntry);
  }
  await saveIndex(index);
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

async function validateBirds(records, existingBirds, fieldSessions) {
  const existingRingNos = new Set(existingBirds.map(b => b.ringNo));
  const batchRingCounts = new Map();
  const sessionMap = new Map((fieldSessions || []).map(s => [s.id, s]));

  const fieldErrors = [];
  const duplicateInBatch = [];
  const duplicateInDb = [];
  const missingMeasurements = [];
  const unknownSpeciesMap = new Map();
  const dictValidationWarnings = [];
  const fieldSessionWarnings = [];

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

    if (rec.fieldSessionId) {
      const session = sessionMap.get(rec.fieldSessionId);
      if (!session) {
        fieldSessionWarnings.push({
          index: i,
          ringNo: rec.ringNo || "(missing)",
          fieldSessionId: rec.fieldSessionId,
          warningType: "session_not_found",
          message: `引用的作业场次 ${rec.fieldSessionId} 不存在`
        });
      } else {
        const mismatches = [];
        if (rec.season && rec.season !== session.season) {
          mismatches.push({ field: "season", recordValue: rec.season, sessionValue: session.season });
        }
        if (rec.capturePlace && rec.capturePlace !== session.capturePlace) {
          mismatches.push({ field: "capturePlace", recordValue: rec.capturePlace, sessionValue: session.capturePlace });
        }
        if (mismatches.length > 0) {
          fieldSessionWarnings.push({
            index: i,
            ringNo: rec.ringNo || "(missing)",
            fieldSessionId: rec.fieldSessionId,
            warningType: "session_mismatch",
            message: `记录与场次不一致: ${mismatches.map(m => `${m.field}(记录:${m.recordValue}, 场次:${m.sessionValue})`).join(", ")}`,
            mismatches
          });
        }
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

  const recordsWithFieldSession = records.filter(r => !!r.fieldSessionId).length;
  const recordsWithoutFieldSession = records.length - recordsWithFieldSession;

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
    fieldSessionWarnings,
    fieldSessionValidationSummary: {
      totalRecords: records.length,
      recordsWithFieldSession,
      recordsWithoutFieldSession,
      sessionNotFoundCount: fieldSessionWarnings.filter(w => w.warningType === "session_not_found").length,
      sessionMismatchCount: fieldSessionWarnings.filter(w => w.warningType === "session_mismatch").length
    },
    hasBlockingErrors: fieldErrors.length > 0 || duplicateInDb.length > 0 || unknownSpeciesMap.size > 0
  };
}

async function loadFieldSessions() {
  await initialize();
  const store = await readStore("fieldSessions");
  return store.fieldSessions || [];
}

function buildInitialCommitState(records) {
  return {
    processedCount: 0,
    successCount: 0,
    skippedCount: 0,
    failedCount: 0,
    processedRingNos: [],
    perRecordStatus: records.map((rec, i) => ({
      index: i,
      ringNo: rec.ringNo || null,
      status: "pending"
    })),
    importedRingNos: [],
    skippedDetails: [],
    failedDetails: [],
    startedAt: null,
    lastBatchAt: null,
    committedAt: null
  };
}

async function createPreview(records, existingBirds) {
  await cleanupExpired();

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("invalid_input");
  }

  const fieldSessions = await loadFieldSessions();
  const validation = await validateBirds(records, existingBirds, fieldSessions);
  const taskId = generateTaskId();

  const task = {
    taskId,
    createdAt: Date.now(),
    records,
    validation,
    status: validation.hasBlockingErrors ? TASK_STATUS.BLOCKED : TASK_STATUS.READY,
    commitState: buildInitialCommitState(records)
  };

  await saveTask(task);
  return task;
}

async function getPreview(taskId) {
  const task = await loadTask(taskId);
  if (!task) return null;
  return task;
}

async function listTasks() {
  await cleanupExpired();
  const index = await loadIndex();
  return index.tasks;
}

function getNextPendingIndices(task, batchSize = BATCH_SIZE) {
  const pending = [];
  for (const rs of task.commitState.perRecordStatus) {
    if (rs.status === "pending") {
      pending.push(rs.index);
      if (pending.length >= batchSize) break;
    }
  }
  return pending;
}

function buildBirdAndEvents(rec) {
  const bird = {
    ringNo: rec.ringNo,
    species: rec.species,
    sex: rec.sex || "unknown",
    age: rec.age,
    capturePlace: rec.capturePlace,
    season: rec.season,
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

  return { bird, birdEvents };
}

async function commitImport(taskId, options = {}) {
  const { batchSize = BATCH_SIZE } = options;
  await initialize();

  const task = await loadTask(taskId);
  if (!task) {
    throw new Error("preview_not_found");
  }
  if (task.status === TASK_STATUS.EXPIRED) {
    throw new Error("task_expired");
  }
  if (task.status === TASK_STATUS.COMMITTED) {
    return {
      taskId,
      imported: task.commitState.successCount,
      skipped: task.commitState.skippedCount,
      failed: task.commitState.failedCount,
      skippedDetails: task.commitState.skippedDetails,
      failedDetails: task.commitState.failedDetails,
      completed: true,
      alreadyCommitted: true
    };
  }
  if (task.validation.hasBlockingErrors) {
    throw new Error("has_blocking_errors");
  }

  const previousStatus = task.status;
  task.status = TASK_STATUS.COMMITTING;
  if (!task.commitState.startedAt) {
    task.commitState.startedAt = new Date().toISOString();
  }
  await saveTask(task);

  try {
    const birdsStore = await readBirdsStore();
    const eventsStore = await readEventsStore();
    const existingRingNos = new Set(birdsStore.birds.map(b => b.ringNo));
    const processedRingNos = new Set(task.commitState.processedRingNos);
    const batchIndices = getNextPendingIndices(task, batchSize);

    if (batchIndices.length === 0) {
      task.status = task.commitState.failedCount > 0 ? TASK_STATUS.PARTIAL : TASK_STATUS.COMMITTED;
      task.commitState.committedAt = new Date().toISOString();
      await saveTask(task);
      await recordAuditLogForTask(task);
      return buildCommitResult(task, true);
    }

    for (const idx of batchIndices) {
      const rec = task.records[idx];
      const rs = task.commitState.perRecordStatus[idx];

      if (rec.ringNo && processedRingNos.has(rec.ringNo)) {
        rs.status = "skipped";
        rs.error = "duplicate_in_batch_processed";
        task.commitState.skippedCount++;
        task.commitState.skippedDetails.push({ ringNo: rec.ringNo, reason: "duplicate_in_batch_processed" });
        task.commitState.processedCount++;
        continue;
      }

      if (existingRingNos.has(rec.ringNo)) {
        rs.status = "skipped";
        rs.error = "duplicate_in_db";
        task.commitState.skippedCount++;
        task.commitState.skippedDetails.push({ ringNo: rec.ringNo, reason: "duplicate_in_db" });
        task.commitState.processedCount++;
        continue;
      }
      if (!rec.ringNo || !rec.species) {
        rs.status = "skipped";
        rs.error = "missing_required_field";
        task.commitState.skippedCount++;
        task.commitState.skippedDetails.push({ ringNo: rec.ringNo || "(missing)", reason: "missing_required_field" });
        task.commitState.processedCount++;
        continue;
      }

      const speciesCheck = await validateDictionaryValue("species", rec.species, { allowEmpty: false });
      if (!speciesCheck.valid) {
        rs.status = "skipped";
        rs.error = "dictionary_validation_failed";
        rs.invalidFields = ["species"];
        task.commitState.skippedCount++;
        task.commitState.skippedDetails.push({ ringNo: rec.ringNo, reason: "dictionary_validation_failed", invalidFields: ["species"] });
        task.commitState.processedCount++;
        continue;
      }

      try {
        const { bird, birdEvents } = buildBirdAndEvents(rec);
        const assembledBird = reassembleBirdFromEvents(bird, [...eventsStore.events, ...birdEvents]);
        persistRiskToBird(assembledBird);
        bird.healthRisk = assembledBird.healthRisk;

        const ring = await getRingStatus(bird.ringNo);
        if (ring) {
          if (ring.status === "allocated") {
            throw new Error("ring_already_allocated");
          }
          if (ring._expiredReservation) {
            throw new Error("ring_reservation_expired");
          }
          if (ring.status === "reserved" && !bird.fieldSessionId) {
            throw new Error("ring_reserved");
          }
          if (ring.status === "reserved" && ring.reservedBy !== bird.fieldSessionId) {
            throw new Error("ring_reserved_by_other_session");
          }
        }

        birdsStore.birds.push(bird);
        eventsStore.events.push(...birdEvents);
        existingRingNos.add(rec.ringNo);

        if (ring) {
          await syncAllocateRing(bird.ringNo, bird.ringNo, { fieldSessionId: bird.fieldSessionId || null });
        }

        rs.status = "success";
        task.commitState.successCount++;
        task.commitState.importedRingNos.push(rec.ringNo);
        task.commitState.processedRingNos.push(rec.ringNo);
        processedRingNos.add(rec.ringNo);
      } catch (e) {
        rs.status = "failed";
        rs.error = e.message;
        task.commitState.failedCount++;
        task.commitState.failedDetails.push({
          index: idx,
          ringNo: rec.ringNo || "(missing)",
          error: e.message
        });
      }
      task.commitState.processedCount++;
    }

    await writeBirdsAndEventsStore(birdsStore, eventsStore);
    task.commitState.lastBatchAt = new Date().toISOString();

    const remaining = getNextPendingIndices(task, 1);
    const isComplete = remaining.length === 0;

    if (isComplete) {
      task.status = task.commitState.failedCount > 0 ? TASK_STATUS.PARTIAL : TASK_STATUS.COMMITTED;
      task.commitState.committedAt = new Date().toISOString();
      await saveTask(task);
      await recordAuditLogForTask(task);
      return buildCommitResult(task, true);
    } else {
      task.status = TASK_STATUS.PARTIAL;
      await saveTask(task);
      return buildCommitResult(task, false);
    }
  } catch (e) {
    task.status = (previousStatus === TASK_STATUS.PARTIAL) ? TASK_STATUS.PARTIAL : TASK_STATUS.READY;
    await saveTask(task);
    throw e;
  }
}

function buildCommitResult(task, completed) {
  return {
    taskId: task.taskId,
    previewId: task.taskId,
    imported: task.commitState.successCount,
    skipped: task.commitState.skippedCount,
    failed: task.commitState.failedCount,
    skippedDetails: task.commitState.skippedDetails,
    failedDetails: task.commitState.failedDetails,
    completed,
    progress: {
      processed: task.commitState.processedCount,
      total: task.records.length,
      remaining: task.records.length - task.commitState.processedCount
    },
    status: task.status
  };
}

async function recordAuditLogForTask(task) {
  const importedRingNos = task.commitState.importedRingNos;
  const fieldSessionValidationSummary = task.validation.fieldSessionValidationSummary || null;
  const fieldSessionWarnings = task.validation.fieldSessionWarnings || [];

  const birdsStore = await readBirdsStore();
  const eventsStore = await readEventsStore();
  const importedBirds = importedRingNos
    .map(ringNo => {
      const bird = birdsStore.birds.find(b => b.ringNo === ringNo);
      if (!bird) return null;
      return reassembleBirdFromEvents(bird, eventsStore.events);
    })
    .filter(Boolean);

  await recordAuditLog({
    operationType: OPERATION_TYPES.BIRD_BATCH_IMPORT,
    targetType: TARGET_TYPES.BIRD,
    targetId: task.taskId,
    requestSummary: {
      previewId: task.taskId,
      taskId: task.taskId,
      importedCount: task.commitState.successCount,
      skippedCount: task.commitState.skippedCount,
      failedCount: task.commitState.failedCount,
      importedRingNos,
      skippedDetails: task.commitState.skippedDetails,
      failedDetails: task.commitState.failedDetails,
      fieldSessionValidation: fieldSessionValidationSummary
        ? { ...fieldSessionValidationSummary, warnings: fieldSessionWarnings }
        : null
    },
    before: null,
    after: importedBirds.map(b => pickBirdKeyFields(b))
  });
}

export {
  validateBirds,
  createPreview,
  getPreview,
  commitImport,
  listTasks,
  KNOWN_SPECIES,
  TASK_STATUS,
  TASK_TTL_MS
};

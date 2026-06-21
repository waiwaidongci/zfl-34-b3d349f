import {
  initialize,
  readStore,
  writeStore
} from "./dataStore.js";
import { randomUUID } from "node:crypto";

export const OPERATION_TYPES = {
  BIRD_CREATE: "bird_create",
  BIRD_MEASUREMENT_APPEND: "bird_measurement_append",
  BIRD_RECAPTURE_APPEND: "bird_recapture_append",
  BIRD_OBSERVATION_APPEND: "bird_observation_append",
  BIRD_RELEASE_APPEND: "bird_release_append",
  BIRD_HEALTH_RISK_UPDATE: "bird_health_risk_update",
  BIRD_BATCH_IMPORT: "bird_batch_import",
  ALL_HEALTH_RISK_RECALCULATE: "all_health_risk_recalculate",
  RING_BATCH_CREATE: "ring_batch_create",
  RING_ALLOCATE: "ring_allocate",
  RING_RELEASE: "ring_release",
  RING_RESERVE: "ring_reserve",
  RING_CANCEL_RESERVATION: "ring_cancel_reservation",
  SESSION_CREATE: "session_create",
  SESSION_UPDATE: "session_update",
  SESSION_DELETE: "session_delete",
  DICTIONARY_ENTRY_ADD: "dictionary_entry_add",
  DICTIONARY_ENTRY_UPDATE: "dictionary_entry_update",
  DICTIONARY_ENTRY_DELETE: "dictionary_entry_delete",
  OFFLINE_SYNC_PACKET: "offline_sync_packet"
};

export const TARGET_TYPES = {
  BIRD: "bird",
  RING: "ring",
  RING_BATCH: "ring_batch",
  SESSION: "session",
  DICTIONARY: "dictionary",
  SYSTEM: "system",
  OFFLINE_SYNC: "offline_sync"
};

function generateLogId() {
  return `LOG-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8)}`;
}

async function loadAuditLogs() {
  await initialize();
  return await readStore("auditLogs");
}

async function saveAuditLogs(data) {
  await initialize();
  await writeStore("auditLogs", data);
}

export function pickBirdKeyFields(bird) {
  if (!bird) return null;
  return {
    ringNo: bird.ringNo,
    species: bird.species,
    sex: bird.sex,
    age: bird.age,
    capturePlace: bird.capturePlace,
    season: bird.season,
    fieldSessionId: bird.fieldSessionId,
    measurementsCount: (bird.measurements || []).length,
    recapturesCount: (bird.recaptures || []).length,
    observationsCount: (bird.observations || []).length,
    releasesCount: (bird.releases || []).length,
    healthRiskLevel: bird.healthRisk ? bird.healthRisk.level : null
  };
}

export function pickRingKeyFields(ring) {
  if (!ring) return null;
  return {
    ringNo: ring.ringNo,
    batchId: ring.batchId,
    status: ring.status,
    allocatedTo: ring.allocatedTo,
    reservedBy: ring.reservedBy,
    reservedAt: ring.reservedAt,
    reservedExpiresAt: ring.reservedExpiresAt
  };
}

export function pickSessionKeyFields(session) {
  if (!session) return null;
  return {
    id: session.id,
    date: session.date,
    season: session.season,
    capturePlace: session.capturePlace,
    team: session.team,
    capturedCount: session.capturedCount,
    releasedCount: session.releasedCount
  };
}

export function pickDictEntryKeyFields(entry) {
  if (!entry) return null;
  return {
    value: entry.value,
    description: entry.description
  };
}

export async function recordAuditLog({
  operationType,
  targetType,
  targetId,
  requestSummary = null,
  before = null,
  after = null
}) {
  try {
    const logEntry = {
      id: generateLogId(),
      timestamp: new Date().toISOString(),
      operationType,
      targetType,
      targetId,
      requestSummary,
      before,
      after
    };

    const data = await loadAuditLogs();
    data.logs.push(logEntry);
    await saveAuditLogs(data);
    return logEntry;
  } catch (e) {
    console.error("[auditLog] Failed to write audit log:", e.message);
    return null;
  }
}

function normalizeDateFilter(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

export async function queryAuditLogs({ dateFrom, dateTo, operationType, targetId, ringNo, limit, offset } = {}) {
  const data = await loadAuditLogs();
  let logs = data.logs;

  const fromDate = normalizeDateFilter(dateFrom);
  const toDate = normalizeDateFilter(dateTo);

  if (fromDate) {
    logs = logs.filter(l => l.timestamp.slice(0, 10) >= fromDate);
  }
  if (toDate) {
    logs = logs.filter(l => l.timestamp.slice(0, 10) <= toDate);
  }
  if (operationType) {
    logs = logs.filter(l => l.operationType === operationType);
  }
  if (targetId) {
    logs = logs.filter(l => l.targetId === targetId);
  }
  if (ringNo) {
    logs = logs.filter(l => {
      if (l.targetId === ringNo) return true;
      if (l.operationType === OPERATION_TYPES.BIRD_BATCH_IMPORT
          && l.requestSummary
          && Array.isArray(l.requestSummary.importedRingNos)
          && l.requestSummary.importedRingNos.includes(ringNo)) {
        return true;
      }
      return false;
    });
  }

  logs = logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const total = logs.length;

  if (typeof offset === "number" && offset > 0) {
    logs = logs.slice(offset);
  }
  if (typeof limit === "number" && limit > 0) {
    logs = logs.slice(0, limit);
  }

  return {
    total,
    returned: logs.length,
    logs
  };
}

export async function getAuditLogStats() {
  const data = await loadAuditLogs();
  const logs = data.logs;
  const stats = {
    total: logs.length,
    byOperationType: {},
    byTargetType: {},
    byDate: {}
  };
  for (const log of logs) {
    stats.byOperationType[log.operationType] = (stats.byOperationType[log.operationType] || 0) + 1;
    stats.byTargetType[log.targetType] = (stats.byTargetType[log.targetType] || 0) + 1;
    const date = log.timestamp.slice(0, 10);
    stats.byDate[date] = (stats.byDate[date] || 0) + 1;
  }
  return stats;
}

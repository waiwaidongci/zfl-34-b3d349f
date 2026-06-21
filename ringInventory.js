import {
  initialize,
  loadLegacyCompatibleDb,
  readStore,
  writeStore
} from "./dataStore.js";
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  recordAuditLog,
  pickRingKeyFields
} from "./auditLog.js";
import { getSession } from "./fieldSessions.js";

const RESERVATION_DEFAULT_TTL_HOURS = 24;

async function loadInventory() {
  await initialize();
  return await readStore("ringInventory");
}

async function saveInventory(inventory) {
  await initialize();
  await writeStore("ringInventory", inventory);
}

async function loadBirds() {
  await initialize();
  return await loadLegacyCompatibleDb();
}

function formatRingNo(prefix, num) {
  return `${prefix}-${String(num).padStart(5, "0")}`;
}

export async function createBatch({ prefix, startNo, endNo, season, description }) {
  if (!prefix || typeof startNo !== "number" || typeof endNo !== "number" || startNo > endNo) {
    throw new Error("invalid_batch_params");
  }

  const inventory = await loadInventory();
  const birds = await loadBirds();

  const batchId = `BATCH-${season || new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;

  const newRings = [];
  const conflictRings = [];

  for (let num = startNo; num <= endNo; num++) {
    const ringNo = formatRingNo(prefix, num);
    if (birds.birds.some(b => b.ringNo === ringNo)) {
      conflictRings.push(ringNo);
      continue;
    }
    if (inventory.rings.some(r => r.ringNo === ringNo)) {
      conflictRings.push(ringNo);
      continue;
    }
    newRings.push({
      ringNo,
      batchId,
      status: "available",
      allocatedTo: null,
      allocatedAt: null,
      reservedBy: null,
      reservedAt: null,
      reservedExpiresAt: null
    });
  }

  const batch = {
    id: batchId,
    prefix,
    startNo,
    endNo,
    season: season || null,
    description: description || null,
    createdAt: new Date().toISOString(),
    totalGenerated: newRings.length,
    conflicts: conflictRings
  };

  inventory.batches.push(batch);
  inventory.rings.push(...newRings);
  await saveInventory(inventory);

  recordAuditLog({
    operationType: OPERATION_TYPES.RING_BATCH_CREATE,
    targetType: TARGET_TYPES.RING_BATCH,
    targetId: batchId,
    requestSummary: { prefix, startNo, endNo, season, description, generated: newRings.length, conflicts: conflictRings.length },
    before: null,
    after: { id: batchId, prefix, startNo, endNo, season, totalGenerated: newRings.length }
  });

  return { batch, generated: newRings.length, conflicts: conflictRings };
}

export async function listBatches({ season } = {}) {
  const inventory = await loadInventory();
  let batches = inventory.batches;
  if (season) {
    batches = batches.filter(b => b.season === season);
  }
  return batches.map(batch => {
    const batchRings = inventory.rings.filter(r => r.batchId === batch.id);
    return {
      ...batch,
      totalRings: batchRings.length,
      available: batchRings.filter(r => r.status === "available").length,
      reserved: batchRings.filter(r => r.status === "reserved" && !isRingReservationExpired(r)).length,
      allocated: batchRings.filter(r => r.status === "allocated").length
    };
  });
}

export async function listRings({ status, batchId, ringNo } = {}) {
  const inventory = await loadInventory();
  let rings = inventory.rings;
  if (status) rings = rings.filter(r => r.status === status);
  if (batchId) rings = rings.filter(r => r.batchId === batchId);
  if (ringNo) rings = rings.filter(r => r.ringNo === ringNo);
  return rings;
}

export async function getNextAvailableRing(batchId) {
  const inventory = await loadInventory();
  let rings = inventory.rings.filter(r => r.status === "available");
  if (batchId) rings = rings.filter(r => r.batchId === batchId);
  return rings.sort((a, b) => a.ringNo.localeCompare(b.ringNo))[0] || null;
}

function isRingReservationExpired(ring) {
  if (!ring || ring.status !== "reserved" || !ring.reservedExpiresAt) return false;
  return new Date() > new Date(ring.reservedExpiresAt);
}

function isRingReserved(ring) {
  if (!ring || ring.status !== "reserved") return false;
  return !isRingReservationExpired(ring);
}

export async function allocateRing({ ringNo, allocatedTo, season, fromReserved = false, fieldSessionId }) {
  if (!ringNo || !allocatedTo) {
    throw new Error("missing_params");
  }

  const inventory = await loadInventory();
  const birds = await loadBirds();

  if (birds.birds.some(b => b.ringNo === ringNo)) {
    throw new Error("ring_already_used_in_birds");
  }

  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) {
    throw new Error("ring_not_found");
  }
  if (ring.status === "allocated") {
    throw new Error("ring_already_allocated");
  }
  if (ring.status === "reserved" && isRingReservationExpired(ring)) {
    ring.status = "available";
    ring.reservedBy = null;
    ring.reservedAt = null;
    ring.reservedExpiresAt = null;
  }
  if (ring.status === "reserved" && !fromReserved) {
    throw new Error("ring_reserved");
  }
  if (ring.status === "reserved" && fromReserved && fieldSessionId && ring.reservedBy !== fieldSessionId) {
    throw new Error("ring_reserved_by_other_session");
  }

  const beforeRing = pickRingKeyFields(ring);
  ring.status = "allocated";
  ring.allocatedTo = allocatedTo;
  ring.allocatedAt = new Date().toISOString();
  ring.reservedBy = null;
  ring.reservedAt = null;
  ring.reservedExpiresAt = null;

  await saveInventory(inventory);
  recordAuditLog({
    operationType: OPERATION_TYPES.RING_ALLOCATE,
    targetType: TARGET_TYPES.RING,
    targetId: ringNo,
    requestSummary: { ringNo, allocatedTo, season, fromReserved, fieldSessionId },
    before: beforeRing,
    after: pickRingKeyFields(ring)
  });
  return ring;
}

export async function releaseRing(ringNo) {
  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) {
    throw new Error("ring_not_found");
  }

  const birds = await loadBirds();
  if (birds.birds.some(b => b.ringNo === ringNo)) {
    throw new Error("ring_still_used_by_bird");
  }

  const beforeRing = pickRingKeyFields(ring);
  ring.status = "available";
  ring.allocatedTo = null;
  ring.allocatedAt = null;
  ring.reservedBy = null;
  ring.reservedAt = null;
  ring.reservedExpiresAt = null;

  await saveInventory(inventory);
  recordAuditLog({
    operationType: OPERATION_TYPES.RING_RELEASE,
    targetType: TARGET_TYPES.RING,
    targetId: ringNo,
    requestSummary: { ringNo },
    before: beforeRing,
    after: pickRingKeyFields(ring)
  });
  return ring;
}

export async function allocateNextAvailable({ batchId, allocatedTo, season }) {
  const nextRing = await getNextAvailableRing(batchId);
  if (!nextRing) {
    throw new Error("no_available_rings");
  }
  return await allocateRing({ ringNo: nextRing.ringNo, allocatedTo, season });
}

export async function syncAllocateRing(ringNo, allocatedTo) {
  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) return null;
  if (ring.status === "allocated") {
    throw new Error("ring_already_allocated");
  }
  if (ring.status === "reserved" && isRingReservationExpired(ring)) {
    ring.status = "available";
    ring.reservedBy = null;
    ring.reservedAt = null;
    ring.reservedExpiresAt = null;
  }
  const beforeRing = pickRingKeyFields(ring);
  ring.status = "allocated";
  ring.allocatedTo = allocatedTo || ringNo;
  ring.allocatedAt = new Date().toISOString();
  ring.reservedBy = null;
  ring.reservedAt = null;
  ring.reservedExpiresAt = null;
  await saveInventory(inventory);
  recordAuditLog({
    operationType: OPERATION_TYPES.RING_ALLOCATE,
    targetType: TARGET_TYPES.RING,
    targetId: ringNo,
    requestSummary: { ringNo, allocatedTo: allocatedTo || ringNo, sync: true },
    before: beforeRing,
    after: pickRingKeyFields(ring)
  });
  return ring;
}

export async function isRingAllocated(ringNo) {
  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) return false;
  return ring.status === "allocated";
}

export async function getRingStatus(ringNo) {
  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) return null;
  if (ring.status === "reserved" && isRingReservationExpired(ring)) {
    return { ...ring, status: "available", _expiredReservation: true };
  }
  return { ...ring };
}

export async function reserveRing({ ringNo, fieldSessionId, ttlHours }) {
  if (!ringNo || !fieldSessionId) {
    throw new Error("missing_params");
  }

  const session = await getSession(fieldSessionId);
  if (!session) {
    throw new Error("session_not_found");
  }

  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) {
    throw new Error("ring_not_found");
  }
  if (ring.status === "allocated") {
    throw new Error("ring_already_allocated");
  }
  if (ring.status === "reserved" && !isRingReservationExpired(ring)) {
    throw new Error("ring_already_reserved");
  }

  const ttl = typeof ttlHours === "number" ? ttlHours : RESERVATION_DEFAULT_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString();

  const beforeRing = pickRingKeyFields(ring);
  ring.status = "reserved";
  ring.reservedBy = fieldSessionId;
  ring.reservedAt = new Date().toISOString();
  ring.reservedExpiresAt = expiresAt;

  await saveInventory(inventory);
  recordAuditLog({
    operationType: OPERATION_TYPES.RING_RESERVE,
    targetType: TARGET_TYPES.RING,
    targetId: ringNo,
    requestSummary: { ringNo, fieldSessionId, ttlHours: ttl, expiresAt },
    before: beforeRing,
    after: pickRingKeyFields(ring)
  });
  return ring;
}

export async function cancelReservation(ringNo) {
  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) {
    throw new Error("ring_not_found");
  }
  if (ring.status !== "reserved") {
    throw new Error("ring_not_reserved");
  }

  const beforeRing = pickRingKeyFields(ring);
  ring.status = "available";
  ring.reservedBy = null;
  ring.reservedAt = null;
  ring.reservedExpiresAt = null;

  await saveInventory(inventory);
  recordAuditLog({
    operationType: OPERATION_TYPES.RING_CANCEL_RESERVATION,
    targetType: TARGET_TYPES.RING,
    targetId: ringNo,
    requestSummary: { ringNo },
    before: beforeRing,
    after: pickRingKeyFields(ring)
  });
  return ring;
}

export async function listReservedRings({ fieldSessionId, includeExpired = false } = {}) {
  const inventory = await loadInventory();
  let rings = inventory.rings.filter(r => r.status === "reserved");
  if (!includeExpired) {
    rings = rings.filter(r => !isRingReservationExpired(r));
  }
  if (fieldSessionId) {
    rings = rings.filter(r => r.reservedBy === fieldSessionId);
  }
  return rings;
}

export async function isRingReservedForSession(ringNo, fieldSessionId) {
  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) return false;
  if (ring.status !== "reserved") return false;
  if (isRingReservationExpired(ring)) return false;
  return ring.reservedBy === fieldSessionId;
}

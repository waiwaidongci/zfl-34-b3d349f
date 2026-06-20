import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const inventoryPath = join(__dirname, "data", "ringInventory.json");
const birdsPath = join(__dirname, "data", "seabirds.json");

const seed = {
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
      allocatedAt: "2026-05-03T00:00:00.000Z"
    },
    {
      ringNo: "SB-26002",
      batchId: "BATCH-2026-SPRING-001",
      status: "available",
      allocatedTo: null,
      allocatedAt: null
    }
  ]
};

async function loadInventory() {
  if (!existsSync(inventoryPath)) {
    await mkdir(dirname(inventoryPath), { recursive: true });
    await writeFile(inventoryPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(inventoryPath, "utf8"));
}

async function saveInventory(inventory) {
  await writeFile(inventoryPath, JSON.stringify(inventory, null, 2));
}

async function loadBirds() {
  return JSON.parse(await readFile(birdsPath, "utf8"));
}

function formatRingNo(prefix, num) {
  return `${prefix}-${String(num).padStart(5, "0")}`;
}

async function createBatch({ prefix, startNo, endNo, season, description }) {
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
      allocatedAt: null
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

  return { batch, generated: newRings.length, conflicts: conflictRings };
}

async function listBatches({ season } = {}) {
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
      allocated: batchRings.filter(r => r.status === "allocated").length
    };
  });
}

async function listRings({ status, batchId, ringNo } = {}) {
  const inventory = await loadInventory();
  let rings = inventory.rings;
  if (status) rings = rings.filter(r => r.status === status);
  if (batchId) rings = rings.filter(r => r.batchId === batchId);
  if (ringNo) rings = rings.filter(r => r.ringNo === ringNo);
  return rings;
}

async function getNextAvailableRing(batchId) {
  const inventory = await loadInventory();
  let rings = inventory.rings.filter(r => r.status === "available");
  if (batchId) rings = rings.filter(r => r.batchId === batchId);
  return rings.sort((a, b) => a.ringNo.localeCompare(b.ringNo))[0] || null;
}

async function allocateRing({ ringNo, allocatedTo, season }) {
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

  ring.status = "allocated";
  ring.allocatedTo = allocatedTo;
  ring.allocatedAt = new Date().toISOString();

  await saveInventory(inventory);
  return ring;
}

async function releaseRing(ringNo) {
  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) {
    throw new Error("ring_not_found");
  }

  const birds = await loadBirds();
  if (birds.birds.some(b => b.ringNo === ringNo)) {
    throw new Error("ring_still_used_by_bird");
  }

  ring.status = "available";
  ring.allocatedTo = null;
  ring.allocatedAt = null;

  await saveInventory(inventory);
  return ring;
}

async function allocateNextAvailable({ batchId, allocatedTo, season }) {
  const nextRing = await getNextAvailableRing(batchId);
  if (!nextRing) {
    throw new Error("no_available_rings");
  }
  return await allocateRing({ ringNo: nextRing.ringNo, allocatedTo, season });
}

async function syncAllocateRing(ringNo, allocatedTo) {
  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) return null;
  if (ring.status === "allocated") {
    throw new Error("ring_already_allocated");
  }
  ring.status = "allocated";
  ring.allocatedTo = allocatedTo || ringNo;
  ring.allocatedAt = new Date().toISOString();
  await saveInventory(inventory);
  return ring;
}

async function isRingAllocated(ringNo) {
  const inventory = await loadInventory();
  const ring = inventory.rings.find(r => r.ringNo === ringNo);
  if (!ring) return false;
  return ring.status === "allocated";
}

export {
  createBatch,
  listBatches,
  listRings,
  getNextAvailableRing,
  allocateRing,
  releaseRing,
  allocateNextAvailable,
  syncAllocateRing,
  isRingAllocated
};

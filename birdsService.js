import {
  initialize,
  loadLegacyCompatibleDb,
  saveLegacyCompatibleDb,
  readBirdsStore,
  readEventsStore,
  writeBirdsStore,
  writeBirdsAndEventsStore,
  reassembleBirdFromEvents,
  EVENT_TYPES
} from "./dataStore.js";
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  recordAuditLog,
  pickBirdKeyFields
} from "./auditLog.js";
import { syncAllocateRing, isRingAllocated, getRingStatus } from "./ringInventory.js";
import { validateDictionaryValues, validateDictionaryValue } from "./dictionaries.js";
import {
  calculateBirdRisk,
  getRiskSummary,
  persistRiskToBird,
  persistRiskToAllBirds
} from "./healthRisk.js";

async function ensureInitialized() {
  await initialize();
}

export async function listBirds({ species, season, capturePlace, fieldSessionId, healthRiskLevel } = {}) {
  await ensureInitialized();
  const db = await loadLegacyCompatibleDb();
  let birds = db.birds;
  if (species) birds = birds.filter(b => b.species === species);
  if (season) birds = birds.filter(b => b.season === season);
  if (capturePlace) birds = birds.filter(b => b.capturePlace === capturePlace);
  if (fieldSessionId) birds = birds.filter(b => b.fieldSessionId === fieldSessionId);
  if (healthRiskLevel) birds = birds.filter(b => b.healthRisk && b.healthRisk.level === healthRiskLevel);
  return birds;
}

export async function findBirdByRingNo(ringNo) {
  await ensureInitialized();
  const db = await loadLegacyCompatibleDb();
  return db.birds.find(b => b.ringNo === ringNo) || null;
}

export async function createBird(input) {
  await ensureInitialized();

  const birdValidations = await validateDictionaryValues([
    { type: "species", value: input.species, allowEmpty: false },
    { type: "capturePlace", value: input.capturePlace, allowEmpty: true },
    { type: "season", value: input.season, allowEmpty: true }
  ]);
  const invalid = birdValidations.filter(r => !r.valid);
  if (invalid.length > 0) {
    const messages = invalid.map(r => {
      if (r.reason === "empty_value_not_allowed") return `字段「${r.type}」不能为空`;
      return `字段「${r.type}」的值「${r.value}」不在字典中，请先在字典中添加`;
    });
    const err = new Error("dictionary_validation_failed");
    err.details = invalid;
    err.validationMessage = messages.join("；");
    throw err;
  }

  const birdsStore = await readBirdsStore();
  if (birdsStore.birds.some(b => b.ringNo === input.ringNo)) {
    const err = new Error("ring_exists");
    throw err;
  }

  const ringStatus = await getRingStatus(input.ringNo);
  if (ringStatus) {
    if (ringStatus.status === "allocated") {
      const err = new Error("ring_allocated_in_inventory");
      err.userMessage = "该环号在库存中已被占用";
      throw err;
    }
    if (ringStatus.status === "reserved" && input.fieldSessionId) {
      if (ringStatus.reservedBy !== input.fieldSessionId) {
        const err = new Error("ring_reserved_by_other_session");
        err.userMessage = "该环号已被其他场次预留";
        throw err;
      }
    } else if (ringStatus.status === "reserved" && !input.fieldSessionId) {
      const err = new Error("ring_reserved");
      err.userMessage = "该环号已被预留";
      throw err;
    }
  }

  const bird = {
    ringNo: input.ringNo,
    species: input.species,
    sex: input.sex || "unknown",
    age: input.age,
    capturePlace: input.capturePlace,
    season: input.season,
    fieldSessionId: input.fieldSessionId || null
  };

  const eventsStore = await readEventsStore();
  const events = [];
  for (const type of EVENT_TYPES) {
    const arr = input[type] || (type === "measurements" ? input.measurements :
                               type === "releases" ? input.releases : []);
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const entry = { ...arr[i] };
      if (type === "measurements" && !entry.at) entry.at = new Date().toISOString().slice(0, 10);
      if ((type === "releases") && !entry.at) entry.at = new Date().toISOString();
      if (!entry.fieldSessionId && input.fieldSessionId) entry.fieldSessionId = input.fieldSessionId;
      events.push({
        ringNo: input.ringNo,
        eventType: type,
        eventIndex: i,
        data: entry
      });
    }
  }
  for (const type of ["recaptures", "observations"]) {
    if (!events.some(e => e.eventType === type)) {
    }
  }

  persistRiskToBird(bird);

  birdsStore.birds.push(bird);
  eventsStore.events.push(...events);

  await writeBirdsAndEventsStore(birdsStore, eventsStore);

  try {
    await syncAllocateRing(input.ringNo, input.ringNo);
  } catch (_) {}

  recordAuditLog({
    operationType: OPERATION_TYPES.BIRD_CREATE,
    targetType: TARGET_TYPES.BIRD,
    targetId: bird.ringNo,
    requestSummary: { ringNo: input.ringNo, species: input.species, sex: input.sex, age: input.age, capturePlace: input.capturePlace, season: input.season },
    before: null,
    after: pickBirdKeyFields(bird)
  });

  const assembledBird = reassembleBirdFromEvents(bird, [...eventsStore.events]);
  return assembledBird;
}

export async function getBirdHistory(ringNo) {
  await ensureInitialized();
  const bird = await findBirdByRingNo(ringNo);
  if (!bird) return null;
  return { ...bird };
}

export async function recalculateBirdHealthRisk(ringNo, explicit = false) {
  await ensureInitialized();
  const birdsStore = await readBirdsStore();
  const idx = birdsStore.birds.findIndex(b => b.ringNo === ringNo);
  if (idx === -1) return null;

  const eventsStore = await readEventsStore();
  const bird = reassembleBirdFromEvents(birdsStore.birds[idx], eventsStore.events);
  const beforeBird = pickBirdKeyFields(bird);
  const risk = calculateBirdRisk(bird);
  birdsStore.birds[idx].healthRisk = risk;

  await writeBirdsStore(birdsStore);

  recordAuditLog({
    operationType: OPERATION_TYPES.BIRD_HEALTH_RISK_UPDATE,
    targetType: TARGET_TYPES.BIRD,
    targetId: ringNo,
    requestSummary: { action: explicit ? "recalculate_health_risk_explicit" : "recalculate_health_risk" },
    before: beforeBird,
    after: pickBirdKeyFields(birdsStore.birds[idx])
  });

  return { ringNo, species: birdsStore.birds[idx].species, healthRisk: risk };
}

export async function appendBirdEvent(ringNo, action, input) {
  await ensureInitialized();

  if ((action === "recaptures" || action === "releases" || action === "observations") && input.place) {
    const placeValidation = await validateDictionaryValue("capturePlace", input.place, { allowEmpty: true });
    if (!placeValidation.valid) {
      const err = new Error("dictionary_validation_failed");
      err.details = [placeValidation];
      err.validationMessage = `字段「capturePlace」的值「${input.place}」不在字典中，请先在字典中添加`;
      throw err;
    }
  }

  const birdsStore = await readBirdsStore();
  const birdIdx = birdsStore.birds.findIndex(b => b.ringNo === ringNo);
  if (birdIdx === -1) return null;

  const eventsStore = await readEventsStore();
  const birdRecord = birdsStore.birds[birdIdx];
  const existingBird = reassembleBirdFromEvents(birdRecord, eventsStore.events);
  const beforeBird = pickBirdKeyFields(existingBird);

  const existingEvents = eventsStore.events
    .filter(e => e.ringNo === ringNo && e.eventType === action)
    .sort((a, b) => a.eventIndex - b.eventIndex);

  const newIndex = existingEvents.length > 0
    ? existingEvents[existingEvents.length - 1].eventIndex + 1
    : 0;

  const newEntry = {
    at: input.at || (action === "measurements" ? new Date().toISOString().slice(0, 10) : new Date().toISOString()),
    ...input
  };

  eventsStore.events.push({
    ringNo,
    eventType: action,
    eventIndex: newIndex,
    data: newEntry
  });

  const reassembled = reassembleBirdFromEvents(birdRecord, eventsStore.events);
  persistRiskToBird(reassembled);
  birdsStore.birds[birdIdx] = {
    ringNo: reassembled.ringNo,
    species: reassembled.species,
    sex: reassembled.sex,
    age: reassembled.age,
    capturePlace: reassembled.capturePlace,
    season: reassembled.season,
    fieldSessionId: reassembled.fieldSessionId,
    healthRisk: reassembled.healthRisk
  };

  await writeBirdsAndEventsStore(birdsStore, eventsStore);

  const opTypeMap = {
    measurements: OPERATION_TYPES.BIRD_MEASUREMENT_APPEND,
    recaptures: OPERATION_TYPES.BIRD_RECAPTURE_APPEND,
    observations: OPERATION_TYPES.BIRD_OBSERVATION_APPEND,
    releases: OPERATION_TYPES.BIRD_RELEASE_APPEND
  };

  recordAuditLog({
    operationType: opTypeMap[action],
    targetType: TARGET_TYPES.BIRD,
    targetId: ringNo,
    requestSummary: { action, entry: newEntry },
    before: beforeBird,
    after: pickBirdKeyFields(birdsStore.birds[birdIdx])
  });

  return reassembleBirdFromEvents(birdsStore.birds[birdIdx], eventsStore.events);
}

export async function getHealthRiskReport() {
  await ensureInitialized();
  const db = await loadLegacyCompatibleDb();
  return getRiskSummary(db.birds);
}

export async function recalculateAllBirdsHealthRisk() {
  await ensureInitialized();
  const birdsStore = await readBirdsStore();
  const eventsStore = await readEventsStore();

  const birds = birdsStore.birds.map(b => reassembleBirdFromEvents(b, eventsStore.events));
  persistRiskToAllBirds(birds);

  birdsStore.birds = birds.map(b => ({
    ringNo: b.ringNo,
    species: b.species,
    sex: b.sex,
    age: b.age,
    capturePlace: b.capturePlace,
    season: b.season,
    fieldSessionId: b.fieldSessionId,
    healthRisk: b.healthRisk
  }));

  await writeBirdsStore(birdsStore);

  const summary = getRiskSummary(birds);

  recordAuditLog({
    operationType: OPERATION_TYPES.ALL_HEALTH_RISK_RECALCULATE,
    targetType: TARGET_TYPES.SYSTEM,
    targetId: "system",
    requestSummary: { recalculatedCount: birds.length },
    before: null,
    after: { total: summary.total, byLevel: summary.byLevel }
  });

  return {
    message: "已重新计算全库健康风险",
    recalculatedCount: birds.length,
    summary: {
      total: summary.total,
      byLevel: summary.byLevel,
      byFactorType: summary.byFactorType
    }
  };
}

export async function getRecaptureRateReport({ season } = {}) {
  await ensureInitialized();
  const db = await loadLegacyCompatibleDb();
  const birds = season ? db.birds.filter(b => b.season === season) : db.birds;
  const bySpecies = {};
  for (const bird of birds) {
    bySpecies[bird.species] ||= { species: bird.species, banded: 0, recaptured: 0 };
    bySpecies[bird.species].banded += 1;
    if (bird.recaptures.length) bySpecies[bird.species].recaptured += 1;
  }
  return Object.values(bySpecies).map(row => ({
    ...row,
    rate: row.banded ? Number((row.recaptured / row.banded).toFixed(3)) : 0
  }));
}

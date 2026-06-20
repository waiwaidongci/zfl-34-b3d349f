import {
  initialize,
  loadLegacyCompatibleDb,
  readStore,
  writeStore,
  atomicWriteFile
} from "./dataStore.js";
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  recordAuditLog,
  pickSessionKeyFields
} from "./auditLog.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionsPath = join(__dirname, "data", "fieldSessions.json");

const seed = {
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
      notes: "发现3只换羽个体",
      createdAt: "2026-06-11T09:00:00.000Z",
      updatedAt: "2026-06-11T16:30:00.000Z"
    }
  ]
};

async function loadSessions() {
  await initialize();
  const data = await readStore("fieldSessions");
  if (!data.fieldSessions || data.fieldSessions.length === 0) {
    await atomicWriteFile(sessionsPath, seed);
    return JSON.parse(JSON.stringify(seed));
  }
  return data;
}

async function saveSessions(sessions) {
  await initialize();
  await writeStore("fieldSessions", sessions);
}

async function loadBirds() {
  await initialize();
  return await loadLegacyCompatibleDb();
}

function generateSessionId(date) {
  const dateStr = (date || new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `FS-${dateStr.slice(0, 4)}-${dateStr.slice(4)}-${random}`;
}

function normalizeDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return d.slice(0, 10);
}

export async function createSession(input) {
  if (!input.date || !input.capturePlace || !input.season) {
    throw new Error("missing_required_fields");
  }
  const sessions = await loadSessions();
  const session = {
    id: input.id || generateSessionId(input.date),
    date: normalizeDate(input.date),
    season: input.season,
    capturePlace: input.capturePlace,
    team: input.team || [],
    weather: input.weather || null,
    tide: input.tide || null,
    capturedCount: typeof input.capturedCount === "number" ? input.capturedCount : 0,
    releasedCount: typeof input.releasedCount === "number" ? input.releasedCount : 0,
    notes: input.notes || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  sessions.fieldSessions.push(session);
  await saveSessions(sessions);
  recordAuditLog({
    operationType: OPERATION_TYPES.SESSION_CREATE,
    targetType: TARGET_TYPES.SESSION,
    targetId: session.id,
    requestSummary: { date: input.date, season: input.season, capturePlace: input.capturePlace, team: input.team, capturedCount: input.capturedCount, releasedCount: input.releasedCount },
    before: null,
    after: pickSessionKeyFields(session)
  });
  return session;
}

export async function listSessions({ season, capturePlace, dateFrom, dateTo } = {}) {
  const sessions = await loadSessions();
  let result = sessions.fieldSessions;
  if (season) result = result.filter(s => s.season === season);
  if (capturePlace) result = result.filter(s => s.capturePlace === capturePlace);
  if (dateFrom) {
    const from = normalizeDate(dateFrom);
    result = result.filter(s => s.date >= from);
  }
  if (dateTo) {
    const to = normalizeDate(dateTo);
    result = result.filter(s => s.date <= to);
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

export async function getSession(id) {
  const sessions = await loadSessions();
  return sessions.fieldSessions.find(s => s.id === id) || null;
}

export async function updateSession(id, input) {
  const sessions = await loadSessions();
  const idx = sessions.fieldSessions.findIndex(s => s.id === id);
  if (idx === -1) throw new Error("session_not_found");
  const existing = sessions.fieldSessions[idx];
  const beforeSession = pickSessionKeyFields(existing);
  const updated = {
    ...existing,
    ...input,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString()
  };
  if (input.date) updated.date = normalizeDate(input.date);
  sessions.fieldSessions[idx] = updated;
  await saveSessions(sessions);
  recordAuditLog({
    operationType: OPERATION_TYPES.SESSION_UPDATE,
    targetType: TARGET_TYPES.SESSION,
    targetId: id,
    requestSummary: input,
    before: beforeSession,
    after: pickSessionKeyFields(updated)
  });
  return updated;
}

export async function deleteSession(id) {
  const sessions = await loadSessions();
  const idx = sessions.fieldSessions.findIndex(s => s.id === id);
  if (idx === -1) throw new Error("session_not_found");
  const existing = sessions.fieldSessions[idx];
  const beforeSession = pickSessionKeyFields(existing);
  sessions.fieldSessions.splice(idx, 1);
  await saveSessions(sessions);
  recordAuditLog({
    operationType: OPERATION_TYPES.SESSION_DELETE,
    targetType: TARGET_TYPES.SESSION,
    targetId: id,
    requestSummary: { id },
    before: beforeSession,
    after: null
  });
  return true;
}

export async function getSessionSummary({ season, capturePlace, dateFrom, dateTo } = {}) {
  const sessions = await listSessions({ season, capturePlace, dateFrom, dateTo });
  const birds = await loadBirds();

  const birdRecords = birds.birds || [];

  return sessions.map(session => {
    const sessionBirds = birdRecords.filter(b => b.fieldSessionId === session.id);

    const measurements = sessionBirds.reduce((sum, b) => {
      return sum + (b.measurements || []).filter(m => m.fieldSessionId === session.id).length;
    }, 0);

    const recaptures = birdRecords.reduce((sum, b) => {
      return sum + (b.recaptures || []).filter(r => r.fieldSessionId === session.id).length;
    }, 0);

    const observations = birdRecords.reduce((sum, b) => {
      return sum + (b.observations || []).filter(o => o.fieldSessionId === session.id).length;
    }, 0);

    const releases = sessionBirds.reduce((sum, b) => {
      return sum + (b.releases || []).filter(r => r.fieldSessionId === session.id).length;
    }, 0);

    const speciesBreakdown = {};

    for (const b of sessionBirds) {
      speciesBreakdown[b.species] ||= { species: b.species, banded: 0, recaptured: 0 };
      speciesBreakdown[b.species].banded += 1;
      const hasRecapture = (b.recaptures || []).some(r => r.fieldSessionId === session.id);
      if (hasRecapture) speciesBreakdown[b.species].recaptured += 1;
    }

    for (const b of birdRecords) {
      if (b.fieldSessionId === session.id) continue;
      const hasRecapture = (b.recaptures || []).some(r => r.fieldSessionId === session.id);
      if (hasRecapture) {
        speciesBreakdown[b.species] ||= { species: b.species, banded: 0, recaptured: 0 };
        speciesBreakdown[b.species].recaptured += 1;
      }
    }

    return {
      id: session.id,
      date: session.date,
      season: session.season,
      capturePlace: session.capturePlace,
      team: session.team,
      weather: session.weather,
      tide: session.tide,
      capturedCount: session.capturedCount,
      releasedCount: session.releasedCount,
      notes: session.notes,
      computedStats: {
        newBirds: sessionBirds.length,
        measurements,
        recaptures,
        observations,
        releases,
        speciesBreakdown: Object.values(speciesBreakdown)
      }
    };
  });
}

export async function getSessionDetail(id) {
  const session = await getSession(id);
  if (!session) return null;

  const birds = await loadBirds();
  const birdRecords = birds.birds || [];

  const sessionBirds = birdRecords
    .filter(b => b.fieldSessionId === id)
    .map(b => ({
      ringNo: b.ringNo,
      species: b.species,
      sex: b.sex,
      age: b.age,
      capturePlace: b.capturePlace,
      measurements: (b.measurements || []).filter(m => m.fieldSessionId === id),
      recaptures: (b.recaptures || []).filter(r => r.fieldSessionId === id),
      observations: (b.observations || []).filter(o => o.fieldSessionId === id),
      releases: (b.releases || []).filter(r => r.fieldSessionId === id)
    }));

  const recaptureBirds = birdRecords
    .filter(b => {
      return (b.recaptures || []).some(r => r.fieldSessionId === id) && b.fieldSessionId !== id;
    })
    .map(b => ({
      ringNo: b.ringNo,
      species: b.species,
      sex: b.sex,
      age: b.age,
      originalSeason: b.season,
      originalCapturePlace: b.capturePlace,
      recaptures: (b.recaptures || []).filter(r => r.fieldSessionId === id)
    }));

  return {
    ...session,
    relatedBirds: sessionBirds,
    recapturedBirds: recaptureBirds
  };
}

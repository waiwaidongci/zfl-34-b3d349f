import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRingInventoryRoutes } from "./ringInventoryRoutes.js";
import { syncAllocateRing, isRingAllocated } from "./ringInventory.js";
import { createPreview, getPreview, commitImport } from "./importPreview.js";
import {
  createSession,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  getSessionSummary,
  getSessionDetail
} from "./fieldSessions.js";
import { handleMigrationRoutes } from "./migrationRoutes.js";
import {
  calculateBirdRisk,
  getRiskSummary,
  persistRiskToBird,
  persistRiskToAllBirds
} from "./healthRisk.js";
import {
  DICTIONARY_TYPES,
  loadDictionaries,
  listDictionary,
  addDictionaryEntry,
  updateDictionaryEntry,
  deleteDictionaryEntry,
  validateDictionaryValue,
  validateDictionaryValues,
  mapDictError
} from "./dictionaries.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "seabirds.json");
const port = Number(process.env.PORT || 3034);

const seed = {
  birds: [
    {
      ringNo: "SB-26001",
      species: "黑尾鸥",
      sex: "unknown",
      age: "adult",
      capturePlace: "东礁A区",
      season: "2026春",
      fieldSessionId: "FS-2026-0503-001",
      measurements: [{ at: "2026-05-03", wing: 328, weight: 512, bill: 44, fieldSessionId: "FS-2026-0503-001" }],
      releases: [{ at: "2026-05-03T09:40:00.000Z", place: "东礁A区", fieldSessionId: "FS-2026-0503-001" }],
      recaptures: [{ at: "2026-06-11", place: "东礁B区", note: "换羽正常", fieldSessionId: "FS-2026-0611-001" }],
      observations: [{ at: "2026-06-15", point: "N30.1,E122.3", note: "近岸盘旋" }]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function mapSessionError(e) {
  switch (e.message) {
    case "missing_required_fields": return { status: 400, error: "missing_required_fields", message: "缺少必填字段：date、season、capturePlace" };
    case "session_not_found": return { status: 404, error: "session_not_found", message: "作业场次不存在" };
    default: return { status: 500, error: e.message };
  }
}

function buildDictValidationError(results) {
  const invalid = results.filter(r => !r.valid);
  if (invalid.length === 0) return null;
  const messages = invalid.map(r => {
    if (r.reason === "empty_value_not_allowed") {
      return `字段「${r.type}」不能为空`;
    }
    return `字段「${r.type}」的值「${r.value}」不在字典中，请先在字典中添加`;
  });
  return {
    status: 400,
    error: "dictionary_validation_failed",
    message: messages.join("；"),
    details: invalid
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (url.pathname.startsWith("/ring-inventory/")) {
      const handled = await handleRingInventoryRoutes(req, res, url, body);
      if (handled !== false) return;
    }

    const migrationHandled = handleMigrationRoutes(req, res, url, db, send);
    if (migrationHandled !== false) return;

    if (url.pathname.startsWith("/import")) {
      if (req.method === "POST" && url.pathname === "/import/preview") {
        const input = await body(req);
        if (!input.records || !Array.isArray(input.records)) {
          return send(res, 400, { error: "invalid_input", message: "请求体需包含 records 数组" });
        }
        try {
          const preview = await createPreview(input.records, db.birds);
          return send(res, 200, {
            previewId: preview.previewId,
            status: preview.status,
            validation: preview.validation,
            createdAt: new Date(preview.createdAt).toISOString()
          });
        } catch (e) {
          if (e.message === "invalid_input") {
            return send(res, 400, { error: "invalid_input", message: "records 不能为空" });
          }
          throw e;
        }
      }

      const previewMatch = url.pathname.match(/^\/import\/preview\/([^/]+)$/);
      if (previewMatch && req.method === "GET") {
        const previewId = decodeURIComponent(previewMatch[1]);
        const preview = getPreview(previewId);
        if (!preview) return send(res, 404, { error: "preview_not_found", message: "预览不存在或已过期" });
        return send(res, 200, {
          previewId: preview.previewId,
          status: preview.status,
          validation: preview.validation,
          createdAt: new Date(preview.createdAt).toISOString(),
          committedAt: preview.committedAt || null
        });
      }

      const commitMatch = url.pathname.match(/^\/import\/commit\/([^/]+)$/);
      if (commitMatch && req.method === "POST") {
        const previewId = decodeURIComponent(commitMatch[1]);
        try {
          const result = await commitImport(previewId);
          return send(res, 200, result);
        } catch (e) {
          switch (e.message) {
            case "preview_not_found": return send(res, 404, { error: "preview_not_found", message: "预览不存在或已过期" });
            case "already_committed": return send(res, 409, { error: "already_committed", message: "该预览已提交，不可重复写入" });
            case "has_blocking_errors": return send(res, 422, { error: "has_blocking_errors", message: "存在阻断性错误，请修正后重新提交预览" });
            default: throw e;
          }
        }
      }
    }

    if (url.pathname.startsWith("/field-sessions")) {
      if (req.method === "POST" && url.pathname === "/field-sessions") {
        const input = await body(req);
        const sessionValidations = await validateDictionaryValues([
          { type: "season", value: input.season, allowEmpty: false },
          { type: "capturePlace", value: input.capturePlace, allowEmpty: false }
        ]);
        const sessionDictError = buildDictValidationError(sessionValidations);
        if (sessionDictError) return send(res, sessionDictError.status, sessionDictError);
        try {
          const session = await createSession(input);
          return send(res, 201, session);
        } catch (e) {
          const mapped = mapSessionError(e);
          return send(res, mapped.status, mapped);
        }
      }

      if (req.method === "GET" && url.pathname === "/field-sessions") {
        const season = url.searchParams.get("season");
        const capturePlace = url.searchParams.get("capturePlace");
        const dateFrom = url.searchParams.get("dateFrom");
        const dateTo = url.searchParams.get("dateTo");
        const sessions = await listSessions({ season, capturePlace, dateFrom, dateTo });
        return send(res, 200, sessions);
      }

      if (req.method === "GET" && url.pathname === "/field-sessions/summary") {
        const season = url.searchParams.get("season");
        const capturePlace = url.searchParams.get("capturePlace");
        const dateFrom = url.searchParams.get("dateFrom");
        const dateTo = url.searchParams.get("dateTo");
        const summary = await getSessionSummary({ season, capturePlace, dateFrom, dateTo });
        return send(res, 200, summary);
      }

      const idMatch = url.pathname.match(/^\/field-sessions\/([^/]+)$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        if (req.method === "GET") {
          const detail = await getSessionDetail(id);
          if (!detail) return send(res, 404, { error: "session_not_found" });
          return send(res, 200, detail);
        }
        if (req.method === "PUT") {
          const input = await body(req);
          const updateValidations = [];
          if (input.season !== undefined) updateValidations.push({ type: "season", value: input.season, allowEmpty: false });
          if (input.capturePlace !== undefined) updateValidations.push({ type: "capturePlace", value: input.capturePlace, allowEmpty: false });
          if (updateValidations.length > 0) {
            const updateDictResults = await validateDictionaryValues(updateValidations);
            const updateDictError = buildDictValidationError(updateDictResults);
            if (updateDictError) return send(res, updateDictError.status, updateDictError);
          }
          try {
            const updated = await updateSession(id, input);
            return send(res, 200, updated);
          } catch (e) {
            const mapped = mapSessionError(e);
            return send(res, mapped.status, mapped);
          }
        }
        if (req.method === "DELETE") {
          try {
            await deleteSession(id);
            return send(res, 200, { deleted: true });
          } catch (e) {
            const mapped = mapSessionError(e);
            return send(res, mapped.status, mapped);
          }
        }
      }

      const detailMatch = url.pathname.match(/^\/field-sessions\/([^/]+)\/(detail)$/);
      if (detailMatch && req.method === "GET") {
        const id = decodeURIComponent(detailMatch[1]);
        const detail = await getSessionDetail(id);
        if (!detail) return send(res, 404, { error: "session_not_found" });
        return send(res, 200, detail);
      }
    }

    if (url.pathname.startsWith("/dictionaries")) {
      if (req.method === "GET" && url.pathname === "/dictionaries") {
        const dict = await loadDictionaries();
        return send(res, 200, {
          types: DICTIONARY_TYPES,
          counts: DICTIONARY_TYPES.reduce((acc, t) => {
          acc[t] = (dict[t] || []).length;
          return acc;
        }, {})
      });
    }

      const typeMatch = url.pathname.match(/^\/dictionaries\/([^/]+)$/);
      if (typeMatch) {
        const type = decodeURIComponent(typeMatch[1]);

        if (req.method === "GET") {
          const dict = await loadDictionaries();
          const entries = listDictionary(dict, type);
          if (entries === null) {
            return send(res, 400, { error: "invalid_dictionary_type", message: `无效的字典类型，支持: ${DICTIONARY_TYPES.join(", ")}` });
          }
          return send(res, 200, entries);
        }

        if (req.method === "POST") {
          const input = await body(req);
          try {
            const entry = await addDictionaryEntry(type, input.value, input.description);
            return send(res, 201, entry);
          } catch (e) {
            const mapped = mapDictError(e);
            return send(res, mapped.status, mapped);
          }
        }
      }

      const entryMatch = url.pathname.match(/^\/dictionaries\/([^/]+)\/([^/]+)$/);
      if (entryMatch) {
        const type = decodeURIComponent(entryMatch[1]);
        const value = decodeURIComponent(entryMatch[2]);

        if (req.method === "PUT") {
          const input = await body(req);
          try {
            const entry = await updateDictionaryEntry(type, value, input.value, input.description);
            return send(res, 200, entry);
          } catch (e) {
            const mapped = mapDictError(e);
            return send(res, mapped.status, mapped);
          }
        }

        if (req.method === "DELETE") {
          try {
            await deleteDictionaryEntry(type, value);
            return send(res, 200, { deleted: true });
          } catch (e) {
            const mapped = mapDictError(e);
            return send(res, mapped.status, mapped);
          }
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, {
      service: "海鸟环志站API",
      endpoints: [
        "GET /birds", "POST /birds",
        "GET /birds/:ringNo/history",
        "GET /birds/:ringNo/tracks",
        "POST /birds/:ringNo/measurements", "POST /birds/:ringNo/recaptures",
        "POST /birds/:ringNo/observations", "POST /birds/:ringNo/releases",
        "POST /birds/:ringNo/health-risk/recalculate",
        "GET /health-risk/report",
        "POST /health-risk/recalculate-all",
        "GET /reports/recapture-rate?season=",
        "GET /reports/migration-summary?species=&season=",
        "POST /ring-inventory/batches", "GET /ring-inventory/batches",
        "GET /ring-inventory/rings", "GET /ring-inventory/rings/available",
        "POST /ring-inventory/rings/allocate", "POST /ring-inventory/rings/allocate-next",
        "POST /ring-inventory/rings/release",
        "POST /field-sessions", "GET /field-sessions",
        "GET /field-sessions/:id", "PUT /field-sessions/:id", "DELETE /field-sessions/:id",
        "GET /field-sessions/summary", "GET /field-sessions/:id/detail",
        "POST /import/preview", "GET /import/preview/:previewId", "POST /import/commit/:previewId",
        "GET /dictionaries", "GET /dictionaries/:type", "POST /dictionaries/:type",
        "PUT /dictionaries/:type/:value", "DELETE /dictionaries/:type/:value"
      ]
    });

    if (req.method === "GET" && url.pathname === "/birds") {
      const species = url.searchParams.get("species");
      return send(res, 200, species ? db.birds.filter(b => b.species === species) : db.birds);
    }
    if (req.method === "POST" && url.pathname === "/birds") {
      const input = await body(req);
      const birdValidations = await validateDictionaryValues([
        { type: "species", value: input.species, allowEmpty: false },
        { type: "capturePlace", value: input.capturePlace, allowEmpty: true },
        { type: "season", value: input.season, allowEmpty: true }
      ]);
      const birdDictError = buildDictValidationError(birdValidations);
      if (birdDictError) return send(res, birdDictError.status, birdDictError);
      if (db.birds.some(b => b.ringNo === input.ringNo)) return send(res, 409, { error: "ring_exists" });
      if (await isRingAllocated(input.ringNo)) return send(res, 409, { error: "ring_allocated_in_inventory", message: "该环号在库存中已被占用" });
      const bird = {
        ringNo: input.ringNo,
        species: input.species,
        sex: input.sex || "unknown",
        age: input.age,
        capturePlace: input.capturePlace,
        season: input.season,
        fieldSessionId: input.fieldSessionId || null,
        measurements: (input.measurements || []).map(m => ({
          ...m,
          at: m.at || new Date().toISOString().slice(0, 10),
          fieldSessionId: m.fieldSessionId || input.fieldSessionId || null
        })),
        releases: (input.releases || []).map(r => ({
          ...r,
          at: r.at || new Date().toISOString(),
          fieldSessionId: r.fieldSessionId || input.fieldSessionId || null
        })),
        recaptures: [],
        observations: []
      };
      persistRiskToBird(bird);
      db.birds.push(bird);
      await saveDb(db);
      await syncAllocateRing(input.ringNo, input.ringNo);
      return send(res, 201, bird);
    }
    const actionMatch = url.pathname.match(/^\/birds\/([^/]+)\/(history|measurements|recaptures|observations|releases|health-risk)$/);
    if (actionMatch) {
      const bird = db.birds.find(b => b.ringNo === decodeURIComponent(actionMatch[1]));
      if (!bird) return send(res, 404, { error: "bird_not_found" });
      const action = actionMatch[2];
      if (req.method === "GET" && action === "history") {
        const responseBird = { ...bird };
        return send(res, 200, responseBird);
      }
      if (req.method === "POST" && action === "health-risk") {
        const risk = calculateBirdRisk(bird);
        bird.healthRisk = risk;
        await saveDb(db);
        return send(res, 200, { ringNo: bird.ringNo, healthRisk: risk });
      }
      if (req.method === "POST" && action !== "history" && action !== "health-risk") {
        const input = await body(req);
        if ((action === "recaptures" || action === "releases") && input.place) {
          const placeValidation = await validateDictionaryValue("capturePlace", input.place, { allowEmpty: true });
          const placeDictError = buildDictValidationError([placeValidation]);
          if (placeDictError) return send(res, placeDictError.status, placeDictError);
        }
        bird[action].push({
          at: input.at || (action === "measurements" ? new Date().toISOString().slice(0, 10) : new Date().toISOString()),
          ...input
        });
        persistRiskToBird(bird);
        await saveDb(db);
        return send(res, 201, bird);
      }
    }

    const healthRiskRecalcMatch = url.pathname.match(/^\/birds\/([^/]+)\/health-risk\/recalculate$/);
    if (healthRiskRecalcMatch && req.method === "POST") {
      const bird = db.birds.find(b => b.ringNo === decodeURIComponent(healthRiskRecalcMatch[1]));
      if (!bird) return send(res, 404, { error: "bird_not_found" });
      const risk = calculateBirdRisk(bird);
      bird.healthRisk = risk;
      await saveDb(db);
      return send(res, 200, {
        ringNo: bird.ringNo,
        species: bird.species,
        healthRisk: risk
      });
    }

    if (req.method === "GET" && url.pathname === "/health-risk/report") {
      const summary = getRiskSummary(db.birds);
      return send(res, 200, summary);
    }

    if (req.method === "POST" && url.pathname === "/health-risk/recalculate-all") {
      persistRiskToAllBirds(db.birds);
      await saveDb(db);
      const summary = getRiskSummary(db.birds);
      return send(res, 200, {
        message: "已重新计算全库健康风险",
        recalculatedCount: db.birds.length,
        summary: {
          total: summary.total,
          byLevel: summary.byLevel,
          byFactorType: summary.byFactorType
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/reports/recapture-rate") {
      const season = url.searchParams.get("season");
      const birds = season ? db.birds.filter(b => b.season === season) : db.birds;
      const bySpecies = {};
      for (const bird of birds) {
        bySpecies[bird.species] ||= { species: bird.species, banded: 0, recaptured: 0 };
        bySpecies[bird.species].banded += 1;
        if (bird.recaptures.length) bySpecies[bird.species].recaptured += 1;
      }
      return send(res, 200, Object.values(bySpecies).map(row => ({ ...row, rate: row.banded ? Number((row.recaptured / row.banded).toFixed(3)) : 0 })));
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Seabird banding API listening on http://localhost:${port}`));

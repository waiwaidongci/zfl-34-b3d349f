import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize as initDataStore, getMigrationState } from "./dataStore.js";
import { handleRingInventoryRoutes } from "./ringInventoryRoutes.js";
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
import { handleBackupRoutes } from "./backupRoutes.js";
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
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  queryAuditLogs,
  getAuditLogStats
} from "./auditLog.js";
import { processOfflinePacket } from "./offlineSync.js";
import {
  listBirds,
  findBirdByRingNo,
  createBird,
  getBirdHistory,
  recalculateBirdHealthRisk,
  appendBirdEvent,
  getHealthRiskReport,
  recalculateAllBirdsHealthRisk,
  getRecaptureRateReport
} from "./birdsService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3034);

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

function mapBirdServiceError(e) {
  switch (e.message) {
    case "ring_exists":
      return { status: 409, error: "ring_exists", message: "环号已存在" };
    case "ring_allocated_in_inventory":
      return { status: 409, error: "ring_allocated_in_inventory", message: e.userMessage || "该环号在库存中已被占用" };
    case "ring_reserved":
      return { status: 409, error: "ring_reserved", message: e.userMessage || "该环号已被预留" };
    case "ring_reserved_by_other_session":
      return { status: 409, error: "ring_reserved_by_other_session", message: e.userMessage || "该环号已被其他场次预留" };
    case "dictionary_validation_failed":
      return {
        status: 400,
        error: "dictionary_validation_failed",
        message: e.validationMessage || "字典校验失败",
        details: e.details || []
      };
    default:
      return null;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/ring-inventory/")) {
      const handled = await handleRingInventoryRoutes(req, res, url, body);
      if (handled !== false) return;
    }

    const migrationHandled = await handleMigrationRoutes(req, res, url, send);
    if (migrationHandled !== false) return;

    const backupHandled = await handleBackupRoutes(req, res, url, send);
    if (backupHandled !== false) return;

    if (url.pathname.startsWith("/import")) {
      if (req.method === "POST" && url.pathname === "/import/preview") {
        const input = await body(req);
        if (!input.records || !Array.isArray(input.records)) {
          return send(res, 400, { error: "invalid_input", message: "请求体需包含 records 数组" });
        }
        try {
          const birds = await listBirds();
          const preview = await createPreview(input.records, birds);
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
      dataStore: {
        migrationState: getMigrationState(),
        structure: ["birds.json", "events.json", "reports.json", "dictionaries.json", "fieldSessions.json", "ringInventory.json", "auditLogs.json"]
      },
      endpoints: [
        "GET /birds?species=&season=&capturePlace=&fieldSessionId=&healthRiskLevel=", "POST /birds",
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
        "POST /ring-inventory/rings/reserve", "POST /ring-inventory/rings/cancel-reservation",
        "GET /ring-inventory/rings/reserved", "GET /ring-inventory/rings/:ringNo/status",
        "POST /field-sessions", "GET /field-sessions",
        "GET /field-sessions/:id", "PUT /field-sessions/:id", "DELETE /field-sessions/:id",
        "GET /field-sessions/summary", "GET /field-sessions/:id/detail",
        "POST /import/preview", "GET /import/preview/:previewId", "POST /import/commit/:previewId",
        "GET /dictionaries", "GET /dictionaries/:type", "POST /dictionaries/:type",
        "PUT /dictionaries/:type/:value", "DELETE /dictionaries/:type/:value",
        "GET /audit-logs?dateFrom=&dateTo=&operationType=&ringNo=&targetId=&limit=&offset=",
        "GET /audit-logs/stats",
        "POST /backups/snapshots", "GET /backups/snapshots",
        "GET /backups/snapshots/:id", "POST /backups/snapshots/:id/restore",
        "POST /offline-sync"
      ]
    });

    if (req.method === "GET" && url.pathname === "/birds") {
      const species = url.searchParams.get("species");
      const season = url.searchParams.get("season");
      const capturePlace = url.searchParams.get("capturePlace");
      const fieldSessionId = url.searchParams.get("fieldSessionId");
      const healthRiskLevel = url.searchParams.get("healthRiskLevel");
      const birds = await listBirds({ species, season, capturePlace, fieldSessionId, healthRiskLevel });
      return send(res, 200, birds);
    }
    if (req.method === "POST" && url.pathname === "/birds") {
      const input = await body(req);
      try {
        const bird = await createBird(input);
        return send(res, 201, bird);
      } catch (e) {
        const mapped = mapBirdServiceError(e);
        if (mapped) return send(res, mapped.status, mapped);
        throw e;
      }
    }
    const actionMatch = url.pathname.match(/^\/birds\/([^/]+)\/(history|measurements|recaptures|observations|releases|health-risk)$/);
    if (actionMatch) {
      const ringNo = decodeURIComponent(actionMatch[1]);
      const action = actionMatch[2];

      if (req.method === "GET" && action === "history") {
        const bird = await getBirdHistory(ringNo);
        if (!bird) return send(res, 404, { error: "bird_not_found" });
        return send(res, 200, bird);
      }
      if (req.method === "POST" && action === "health-risk") {
        const result = await recalculateBirdHealthRisk(ringNo, false);
        if (!result) return send(res, 404, { error: "bird_not_found" });
        return send(res, 200, { ringNo: result.ringNo, healthRisk: result.healthRisk });
      }
      if (req.method === "POST" && action !== "history" && action !== "health-risk") {
        const input = await body(req);
        try {
          const bird = await appendBirdEvent(ringNo, action, input);
          if (!bird) return send(res, 404, { error: "bird_not_found" });
          return send(res, 201, bird);
        } catch (e) {
          const mapped = mapBirdServiceError(e);
          if (mapped) return send(res, mapped.status, mapped);
          throw e;
        }
      }
    }

    const healthRiskRecalcMatch = url.pathname.match(/^\/birds\/([^/]+)\/health-risk\/recalculate$/);
    if (healthRiskRecalcMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(healthRiskRecalcMatch[1]);
      const result = await recalculateBirdHealthRisk(ringNo, true);
      if (!result) return send(res, 404, { error: "bird_not_found" });
      return send(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/health-risk/report") {
      const summary = await getHealthRiskReport();
      return send(res, 200, summary);
    }

    if (req.method === "POST" && url.pathname === "/health-risk/recalculate-all") {
      const result = await recalculateAllBirdsHealthRisk();
      return send(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/reports/recapture-rate") {
      const season = url.searchParams.get("season");
      const report = await getRecaptureRateReport({ season });
      return send(res, 200, report);
    }

    if (url.pathname.startsWith("/audit-logs")) {
      if (req.method === "GET" && url.pathname === "/audit-logs") {
        const dateFrom = url.searchParams.get("dateFrom");
        const dateTo = url.searchParams.get("dateTo");
        const operationType = url.searchParams.get("operationType");
        const ringNo = url.searchParams.get("ringNo");
        const targetId = url.searchParams.get("targetId");
        const limitParam = url.searchParams.get("limit");
        const offsetParam = url.searchParams.get("offset");
        const limit = limitParam ? Number(limitParam) : undefined;
        const offset = offsetParam ? Number(offsetParam) : undefined;
        const result = await queryAuditLogs({ dateFrom, dateTo, operationType, targetId, ringNo, limit, offset });
        return send(res, 200, result);
      }
      if (req.method === "GET" && url.pathname === "/audit-logs/stats") {
        const stats = await getAuditLogStats();
        return send(res, 200, {
          ...stats,
          operationTypes: Object.values(OPERATION_TYPES),
          targetTypes: Object.values(TARGET_TYPES)
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/offline-sync") {
      const input = await body(req);
      if (!input || typeof input !== "object") {
        return send(res, 400, { error: "invalid_input", message: "请求体必须是有效的JSON对象" });
      }
      try {
        const result = await processOfflinePacket(input);
        const statusCode = result.status === "success" ? 200 :
                          (result.status === "partial_success" ? 207 : 400);
        return send(res, statusCode, result);
      } catch (e) {
        return send(res, 500, { error: "sync_failed", message: e.message });
      }
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

async function startServer() {
  await initDataStore();
  server.listen(port, () => console.log(`Seabird banding API listening on http://localhost:${port}`));
}

startServer();

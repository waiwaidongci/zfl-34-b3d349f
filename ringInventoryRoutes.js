import {
  createBatch,
  listBatches,
  listRings,
  getNextAvailableRing,
  allocateRing,
  releaseRing,
  allocateNextAvailable,
  reserveRing,
  cancelReservation,
  listReservedRings,
  getRingStatus
} from "./ringInventory.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function errorMap(err) {
  switch (err.message) {
    case "invalid_batch_params": return { status: 400, error: "invalid_batch_params", message: "批次参数无效，prefix、startNo、endNo 为必填且 startNo <= endNo" };
    case "missing_params": return { status: 400, error: "missing_params", message: "缺少必填参数" };
    case "ring_not_found": return { status: 404, error: "ring_not_found", message: "环号不存在" };
    case "ring_already_allocated": return { status: 409, error: "ring_already_allocated", message: "环号已被分配" };
    case "ring_already_used_in_birds": return { status: 409, error: "ring_already_used_in_birds", message: "环号已在 birds 记录中使用" };
    case "ring_still_used_by_bird": return { status: 409, error: "ring_still_used_by_bird", message: "环号仍被鸟类记录占用，无法释放" };
    case "no_available_rings": return { status: 404, error: "no_available_rings", message: "没有可用的环号" };
    case "ring_reserved": return { status: 409, error: "ring_reserved", message: "环号已被预留" };
    case "ring_reserved_by_other_session": return { status: 409, error: "ring_reserved_by_other_session", message: "环号已被其他场次预留" };
    case "ring_already_reserved": return { status: 409, error: "ring_already_reserved", message: "环号已被预留" };
    case "ring_not_reserved": return { status: 400, error: "ring_not_reserved", message: "环号未被预留，无法取消" };
    case "session_not_found": return { status: 404, error: "session_not_found", message: "作业场次不存在" };
    default: return { status: 500, error: "internal_error", message: err.message };
  }
}

async function handleRingInventoryRoutes(req, res, url, body) {
  try {
    if (req.method === "POST" && url.pathname === "/ring-inventory/batches") {
      const input = await body(req);
      const result = await createBatch(input);
      return send(res, 201, result);
    }

    if (req.method === "GET" && url.pathname === "/ring-inventory/batches") {
      const season = url.searchParams.get("season");
      const batches = await listBatches({ season });
      return send(res, 200, batches);
    }

    if (req.method === "GET" && url.pathname === "/ring-inventory/rings") {
      const status = url.searchParams.get("status");
      const batchId = url.searchParams.get("batchId");
      const ringNo = url.searchParams.get("ringNo");
      const rings = await listRings({ status, batchId, ringNo });
      return send(res, 200, rings);
    }

    if (req.method === "GET" && url.pathname === "/ring-inventory/rings/available") {
      const batchId = url.searchParams.get("batchId");
      const ring = await getNextAvailableRing(batchId);
      if (!ring) return send(res, 404, { error: "no_available_rings", message: "没有可用的环号" });
      return send(res, 200, ring);
    }

    if (req.method === "POST" && url.pathname === "/ring-inventory/rings/allocate") {
      const input = await body(req);
      const ring = await allocateRing(input);
      return send(res, 200, ring);
    }

    if (req.method === "POST" && url.pathname === "/ring-inventory/rings/allocate-next") {
      const input = await body(req);
      const ring = await allocateNextAvailable(input);
      return send(res, 200, ring);
    }

    if (req.method === "POST" && url.pathname === "/ring-inventory/rings/release") {
      const input = await body(req);
      const ring = await releaseRing(input.ringNo);
      return send(res, 200, ring);
    }

    if (req.method === "POST" && url.pathname === "/ring-inventory/rings/reserve") {
      const input = await body(req);
      const ring = await reserveRing(input);
      return send(res, 200, ring);
    }

    if (req.method === "POST" && url.pathname === "/ring-inventory/rings/cancel-reservation") {
      const input = await body(req);
      const ring = await cancelReservation(input.ringNo);
      return send(res, 200, ring);
    }

    if (req.method === "GET" && url.pathname === "/ring-inventory/rings/reserved") {
      const fieldSessionId = url.searchParams.get("fieldSessionId");
      const includeExpired = url.searchParams.get("includeExpired") === "true";
      const rings = await listReservedRings({ fieldSessionId, includeExpired });
      return send(res, 200, rings);
    }

    const ringStatusMatch = url.pathname.match(/^\/ring-inventory\/rings\/([^/]+)\/status$/);
    if (ringStatusMatch && req.method === "GET") {
      const ringNo = decodeURIComponent(ringStatusMatch[1]);
      const ring = await getRingStatus(ringNo);
      if (!ring) return send(res, 404, { error: "ring_not_found", message: "环号不存在" });
      return send(res, 200, ring);
    }

    return false;
  } catch (err) {
    const { status, error, message } = errorMap(err);
    return send(res, status, { error, message });
  }
}

export { handleRingInventoryRoutes };

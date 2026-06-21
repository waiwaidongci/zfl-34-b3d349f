import {
  createSnapshot,
  listSnapshots,
  getSnapshotSummary,
  restoreFromSnapshot
} from "./backupService.js";

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function handleBackupRoutes(req, res, url, send) {
  if (!url.pathname.startsWith("/backups")) return false;

  if (req.method === "POST" && url.pathname === "/backups/snapshots") {
    try {
      const result = await createSnapshot();
      return send(res, 201, result);
    } catch (e) {
      switch (e.message) {
        case "db_not_found":
          return send(res, 404, { error: "db_not_found", message: "数据文件 data/seabirds.json 不存在" });
        case "db_parse_error":
          return send(res, 500, { error: "db_parse_error", message: "数据文件解析失败" });
        case "db_structure_invalid":
          return send(res, 422, { error: "db_structure_invalid", message: "当前数据结构校验不通过，无法创建快照" });
        default:
          throw e;
      }
    }
  }

  if (req.method === "GET" && url.pathname === "/backups/snapshots") {
    const snapshots = await listSnapshots();
    return send(res, 200, snapshots);
  }

  const snapshotMatch = url.pathname.match(/^\/backups\/snapshots\/([^/]+)$/);
  if (snapshotMatch && req.method === "GET") {
    const snapshotId = decodeURIComponent(snapshotMatch[1]);
    const summary = await getSnapshotSummary(snapshotId);
    if (!summary) {
      return send(res, 404, { error: "snapshot_not_found", message: "快照不存在" });
    }
    return send(res, 200, summary);
  }

  const previewMatch = url.pathname.match(/^\/backups\/snapshots\/([^/]+)\/preview$/);
  if (previewMatch && req.method === "POST") {
    const snapshotId = decodeURIComponent(previewMatch[1]);
    try {
      const result = await restoreFromSnapshot(snapshotId, { previewOnly: true });
      return send(res, 200, result);
    } catch (e) {
      switch (e.message) {
        case "snapshot_not_found":
          return send(res, 404, { error: "snapshot_not_found", message: "快照不存在" });
        case "snapshot_file_missing":
          return send(res, 404, { error: "snapshot_file_missing", message: "快照文件已丢失" });
        case "snapshot_file_corrupt":
          return send(res, 500, { error: "snapshot_file_corrupt", message: "快照文件已损坏，无法解析" });
        case "snapshot_data_missing":
          return send(res, 422, { error: "snapshot_data_missing", message: "快照中缺少 data 字段" });
        case "snapshot_structure_invalid":
          return send(res, 422, {
            error: "snapshot_structure_invalid",
            message: "快照结构校验不通过，无法预览",
            validationErrors: e.validationErrors || []
          });
        default:
          throw e;
      }
    }
  }

  const restoreMatch = url.pathname.match(/^\/backups\/snapshots\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === "POST") {
    const snapshotId = decodeURIComponent(restoreMatch[1]);
    try {
      const body = await parseBody(req);
      const previewOnly = body.previewOnly === true || url.searchParams.get("previewOnly") === "true";
      const result = await restoreFromSnapshot(snapshotId, { previewOnly });
      if (previewOnly) {
        return send(res, 200, result);
      }
      return send(res, 200, result);
    } catch (e) {
      switch (e.message) {
        case "snapshot_not_found":
          return send(res, 404, { error: "snapshot_not_found", message: "快照不存在" });
        case "snapshot_file_missing":
          return send(res, 404, { error: "snapshot_file_missing", message: "快照文件已丢失" });
        case "snapshot_file_corrupt":
          return send(res, 500, { error: "snapshot_file_corrupt", message: "快照文件已损坏，无法解析" });
        case "snapshot_data_missing":
          return send(res, 422, { error: "snapshot_data_missing", message: "快照中缺少 data 字段" });
        case "snapshot_structure_invalid":
          return send(res, 422, {
            error: "snapshot_structure_invalid",
            message: "快照结构校验不通过，无法恢复",
            validationErrors: e.validationErrors || []
          });
        default:
          throw e;
      }
    }
  }

  return false;
}

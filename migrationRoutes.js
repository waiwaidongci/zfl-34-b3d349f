import { buildTrack, buildMigrationSummary } from "./trackUtils.js";

export function handleMigrationRoutes(req, res, url, db, send) {
  const trackMatch = url.pathname.match(/^\/birds\/([^/]+)\/tracks$/);
  if (trackMatch && req.method === "GET") {
    const ringNo = decodeURIComponent(trackMatch[1]);
    const bird = db.birds.find(b => b.ringNo === ringNo);
    if (!bird) return send(res, 404, { error: "bird_not_found" });
    return send(res, 200, buildTrack(bird));
  }

  if (url.pathname === "/reports/migration-summary" && req.method === "GET") {
    const species = url.searchParams.get("species") || null;
    const season = url.searchParams.get("season") || null;
    return send(res, 200, buildMigrationSummary(db.birds, { species, season }));
  }

  return false;
}

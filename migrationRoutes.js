import { buildTrack, buildMigrationSummary, buildHotspotStats } from "./trackUtils.js";
import { listBirds, findBirdByRingNo } from "./birdsService.js";

export async function handleMigrationRoutes(req, res, url, send) {
  const trackMatch = url.pathname.match(/^\/birds\/([^/]+)\/tracks$/);
  if (trackMatch && req.method === "GET") {
    const ringNo = decodeURIComponent(trackMatch[1]);
    const bird = await findBirdByRingNo(ringNo);
    if (!bird) return send(res, 404, { error: "bird_not_found" });
    return send(res, 200, buildTrack(bird));
  }

  if (url.pathname === "/reports/migration-summary" && req.method === "GET") {
    const species = url.searchParams.get("species") || null;
    const season = url.searchParams.get("season") || null;
    const birds = await listBirds();
    return send(res, 200, buildMigrationSummary(birds, { species, season }));
  }

  if (url.pathname === "/reports/migration-hotspots" && req.method === "GET") {
    const species = url.searchParams.get("species") || null;
    const season = url.searchParams.get("season") || null;
    const dateFrom = url.searchParams.get("dateFrom") || null;
    const dateTo = url.searchParams.get("dateTo") || null;
    const birds = await listBirds();
    return send(res, 200, buildHotspotStats(birds, { species, season, dateFrom, dateTo }));
  }

  return false;
}

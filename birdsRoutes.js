import {
  listBirds,
  createBird,
  getBirdHistory,
  recalculateBirdHealthRisk,
  appendBirdEvent
} from "./birdsService.js";

export async function handleBirdsRoutes(req, res, url, send, body, mapBirdServiceError) {
  if (!url.pathname.startsWith("/birds")) return false;

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

  return false;
}

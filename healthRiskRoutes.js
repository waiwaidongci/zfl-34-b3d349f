import {
  getHealthRiskReport,
  getHealthRiskTrendView,
  getHealthRiskTopFactors,
  recalculateAllBirdsHealthRisk,
  getRecaptureRateReport
} from "./birdsService.js";

export async function handleHealthRiskRoutes(req, res, url, send) {
  if (url.pathname.startsWith("/health-risk")) {
    if (req.method === "GET" && url.pathname === "/health-risk/report") {
      const summary = await getHealthRiskReport();
      return send(res, 200, summary);
    }

    if (req.method === "GET" && url.pathname === "/health-risk/trend") {
      const season = url.searchParams.get("season");
      const capturePlace = url.searchParams.get("capturePlace");
      const trend = await getHealthRiskTrendView({ season, capturePlace });
      return send(res, 200, trend);
    }

    if (req.method === "GET" && url.pathname === "/health-risk/top-factors") {
      const limitParam = url.searchParams.get("limit");
      const severity = url.searchParams.get("severity");
      const season = url.searchParams.get("season");
      const capturePlace = url.searchParams.get("capturePlace");
      const limit = limitParam ? Number(limitParam) : undefined;
      const topFactors = await getHealthRiskTopFactors({ limit, severity, season, capturePlace });
      return send(res, 200, topFactors);
    }

    if (req.method === "POST" && url.pathname === "/health-risk/recalculate-all") {
      const result = await recalculateAllBirdsHealthRisk();
      return send(res, 200, result);
    }

    return false;
  }

  if (req.method === "GET" && url.pathname === "/reports/recapture-rate") {
    const season = url.searchParams.get("season");
    const report = await getRecaptureRateReport({ season });
    return send(res, 200, report);
  }

  return false;
}

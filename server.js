import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      measurements: [{ at: "2026-05-03", wing: 328, weight: 512, bill: 44 }],
      releases: [{ at: "2026-05-03T09:40:00.000Z", place: "东礁A区" }],
      recaptures: [{ at: "2026-06-11", place: "东礁B区", note: "换羽正常" }],
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, { service: "海鸟环志站API", endpoints: ["GET /birds", "POST /birds", "GET /birds/:ringNo/history", "POST /birds/:ringNo/measurements", "POST /birds/:ringNo/recaptures", "POST /birds/:ringNo/observations", "GET /reports/recapture-rate?season="] });
    if (req.method === "GET" && url.pathname === "/birds") {
      const species = url.searchParams.get("species");
      return send(res, 200, species ? db.birds.filter(b => b.species === species) : db.birds);
    }
    if (req.method === "POST" && url.pathname === "/birds") {
      const input = await body(req);
      if (db.birds.some(b => b.ringNo === input.ringNo)) return send(res, 409, { error: "ring_exists" });
      const bird = { ringNo: input.ringNo, species: input.species, sex: input.sex || "unknown", age: input.age, capturePlace: input.capturePlace, season: input.season, measurements: input.measurements || [], releases: input.releases || [], recaptures: [], observations: [] };
      db.birds.push(bird);
      await saveDb(db);
      return send(res, 201, bird);
    }
    const actionMatch = url.pathname.match(/^\/birds\/([^/]+)\/(history|measurements|recaptures|observations|releases)$/);
    if (actionMatch) {
      const bird = db.birds.find(b => b.ringNo === decodeURIComponent(actionMatch[1]));
      if (!bird) return send(res, 404, { error: "bird_not_found" });
      const action = actionMatch[2];
      if (req.method === "GET" && action === "history") return send(res, 200, bird);
      if (req.method === "POST" && action !== "history") {
        const input = await body(req);
        bird[action].push({ at: input.at || new Date().toISOString(), ...input });
        await saveDb(db);
        return send(res, 201, bird);
      }
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

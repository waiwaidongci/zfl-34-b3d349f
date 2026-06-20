import { parsePoint, haversineKm } from "./geoUtils.js";

export function buildTrack(bird) {
  const events = [];

  for (const r of bird.recaptures || []) {
    events.push({
      at: r.at,
      type: "recapture",
      place: r.place || null,
      note: r.note || null,
      coord: null
    });
  }

  for (const o of bird.observations || []) {
    const coord = parsePoint(o.point);
    events.push({
      at: o.at,
      type: "observation",
      point: o.point || null,
      note: o.note || null,
      coord
    });
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  let totalDistance = 0;
  let prevCoord = null;
  for (const ev of events) {
    if (ev.coord && prevCoord) {
      totalDistance += haversineKm(prevCoord, ev.coord);
    }
    if (ev.coord) prevCoord = ev.coord;
  }

  const timeline = events.map(ev => {
    const entry = { at: ev.at, type: ev.type };
    if (ev.type === "observation") {
      entry.point = ev.point;
    } else {
      entry.place = ev.place;
    }
    if (ev.note) entry.note = ev.note;
    if (ev.coord) entry.lat = ev.coord.lat;
    if (ev.coord) entry.lng = ev.coord.lng;
    return entry;
  });

  const geoEvents = events.filter(e => e.coord);
  const latestPosition = geoEvents.length
    ? { lat: geoEvents[geoEvents.length - 1].coord.lat, lng: geoEvents[geoEvents.length - 1].coord.lng, at: geoEvents[geoEvents.length - 1].at }
    : null;

  const dates = events.map(e => new Date(e.at).getTime()).filter(n => !Number.isNaN(n));
  let spanDays = 0;
  if (dates.length >= 2) {
    spanDays = Math.round((Math.max(...dates) - Math.min(...dates)) / 86400000);
  }

  return {
    ringNo: bird.ringNo,
    species: bird.species,
    season: bird.season,
    timeline,
    latestPosition,
    spanDays,
    totalDistance: Number(totalDistance.toFixed(2))
  };
}

export function buildMigrationSummary(birds, { species, season } = {}) {
  let filtered = birds;
  if (species) filtered = filtered.filter(b => b.species === species);
  if (season) filtered = filtered.filter(b => b.season === season);

  return filtered.map(b => {
    const track = buildTrack(b);
    return {
      ringNo: track.ringNo,
      species: track.species,
      season: track.season,
      latestPosition: track.latestPosition,
      spanDays: track.spanDays,
      totalDistance: track.totalDistance,
      eventCount: track.timeline.length
    };
  });
}

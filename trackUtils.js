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

export function buildHotspotStats(birds, { species, season, dateFrom, dateTo } = {}) {
  let filteredBirds = birds;
  if (species) filteredBirds = filteredBirds.filter(b => b.species === species);
  if (season) filteredBirds = filteredBirds.filter(b => b.season === season);

  const allObservations = [];
  for (const bird of filteredBirds) {
    const observations = bird.observations || [];
    for (const obs of observations) {
      const coord = parsePoint(obs.point);
      if (!coord) continue;

      const obsDate = new Date(obs.at);
      if (isNaN(obsDate.getTime())) continue;

      if (dateFrom) {
        const fromDate = new Date(dateFrom);
        if (obsDate < fromDate) continue;
      }
      if (dateTo) {
        const toDate = new Date(dateTo);
        if (obsDate > toDate) continue;
      }

      allObservations.push({
        ringNo: bird.ringNo,
        species: bird.species,
        point: obs.point,
        coord,
        at: obs.at,
        date: obsDate
      });
    }
  }

  const birdObsMap = new Map();
  for (const obs of allObservations) {
    if (!birdObsMap.has(obs.ringNo)) birdObsMap.set(obs.ringNo, []);
    birdObsMap.get(obs.ringNo).push(obs);
  }
  for (const obsList of birdObsMap.values()) {
    obsList.sort((a, b) => a.date - b.date);
  }

  const hotspotMap = new Map();
  for (const obs of allObservations) {
    const key = obs.point;
    if (!hotspotMap.has(key)) {
      hotspotMap.set(key, {
        point: obs.point,
        lat: obs.coord.lat,
        lng: obs.coord.lng,
        eventCount: 0,
        ringNos: new Set(),
        latestAt: obs.date,
        latestAtStr: obs.at,
        moveDistances: []
      });
    }
    const hotspot = hotspotMap.get(key);
    hotspot.eventCount += 1;
    hotspot.ringNos.add(obs.ringNo);
    if (obs.date > hotspot.latestAt) {
      hotspot.latestAt = obs.date;
      hotspot.latestAtStr = obs.at;
    }

    const birdObsList = birdObsMap.get(obs.ringNo);
    const obsIdx = birdObsList.findIndex(o => o === obs);
    if (obsIdx > 0) {
      const prevObs = birdObsList[obsIdx - 1];
      const dist = haversineKm(prevObs.coord, obs.coord);
      if (dist > 0) {
        hotspot.moveDistances.push(dist);
      }
    }
  }

  const result = [];
  for (const hotspot of hotspotMap.values()) {
    const avgMoveDistance = hotspot.moveDistances.length
      ? hotspot.moveDistances.reduce((sum, d) => sum + d, 0) / hotspot.moveDistances.length
      : 0;

    result.push({
      point: hotspot.point,
      lat: hotspot.lat,
      lng: hotspot.lng,
      eventCount: hotspot.eventCount,
      ringNoCount: hotspot.ringNos.size,
      latestObservationAt: hotspot.latestAtStr,
      avgMoveDistance: Number(avgMoveDistance.toFixed(2))
    });
  }

  result.sort((a, b) => b.eventCount - a.eventCount);

  return result;
}

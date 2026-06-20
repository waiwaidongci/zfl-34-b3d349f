const R_KM = 6371;

export function parsePoint(point) {
  if (!point || typeof point !== "string") return null;
  const m = point.match(/^([NS])(\d+(?:\.\d+)?),\s*([EW])(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = m[1] === "S" ? -parseFloat(m[2]) : parseFloat(m[2]);
  const lng = m[3] === "W" ? -parseFloat(m[4]) : parseFloat(m[4]);
  return { lat, lng };
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function haversineKm(a, b) {
  if (!a || !b) return 0;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return R_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

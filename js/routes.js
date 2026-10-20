/*
 * Entry-route scoring. Walks each route in ~12 m steps, projects a scent cone
 * downwind from every step, and measures how much of the deer-sensitive area
 * that scent reaches:
 *  - the area in front of the stand (where it faces, out to 150 m)
 *  - bedding areas, food sources and trails the user has marked
 * Walking straight through those areas and approaching from upwind also cost points.
 */
(function (global) {
  'use strict';

  const R = 6371000;
  const RAD = Math.PI / 180;
  const NEAR_STAND = 40; // ignore the last few steps at the stand itself

  const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };
  const bearing = (dx, dy) => ((Math.atan2(dx, dy) / RAD) + 360) % 360;

  function toXY(lat, lon, o) {
    return [(lon - o.lon) * RAD * R * Math.cos(o.lat * RAD), (lat - o.lat) * RAD * R];
  }
  function fromXY(x, y, o) {
    return [o.lat + y / R / RAD, o.lon + x / (R * Math.cos(o.lat * RAD)) / RAD];
  }

  function densify(pts, step) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
      for (let k = 0; k < n; k++) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
    }
    if (pts.length) out.push(pts[pts.length - 1]);
    return out;
  }

  const SPOT_ZONE = {
    bedding: { radius: 70, weight: 1.0, label: 'bedding area' },
    food: { radius: 60, weight: 0.8, label: 'food source' },
    trail: { radius: 35, weight: 0.6, label: 'trail' },
  };

  // Weighted sample points (meters, stand at origin) for everything deer-sensitive near a stand.
  function zones(stand, spots) {
    const o = { lat: stand.lat, lon: stand.lon };
    const pts = [];
    if (stand.facing != null) {
      for (let r = 30; r <= 150; r += 20) {
        for (let a = -45; a <= 45; a += 15) {
          const b = (stand.facing + a) * RAD;
          pts.push({ x: r * Math.sin(b), y: r * Math.cos(b), w: 0.7, label: 'area in front of the stand' });
        }
      }
    }
    for (const s of spots || []) {
      const z = SPOT_ZONE[s.type];
      if (!z) continue;
      const [cx, cy] = toXY(s.lat, s.lon, o);
      if (Math.hypot(cx, cy) > 1500) continue;
      pts.push({ x: cx, y: cy, w: z.weight, label: z.label, name: s.name });
      for (const rr of [z.radius / 2, z.radius]) {
        for (let a = 0; a < 360; a += 45) pts.push({ x: cx + rr * Math.sin(a * RAD), y: cy + rr * Math.cos(a * RAD), w: z.weight, label: z.label, name: s.name });
      }
    }
    return pts;
  }

  /**
   * points: [[lat, lon], ...] from the start of the walk to the stand.
   * wind: { dir (degrees, blowing from), speed (mph) }
   * Returns { score 0-100, cls, label, reason }.
   */
  function scoreRoute(points, stand, spots, wind) {
    if (!wind || wind.dir == null || points.length < 2) return null;
    const o = { lat: stand.lat, lon: stand.lon };
    const samples = densify(points.map((p) => toXY(p[0], p[1], o)), 12).filter(([x, y]) => Math.hypot(x, y) > NEAR_STAND);
    const down = (wind.dir + 180) % 360;
    const speed = wind.speed || 0;
    const half = speed < 3 ? 60 : speed < 6 ? 40 : 28;
    const reach = Math.min(400, 150 + speed * 20);

    // Approach side: coming from downwind keeps your scent behind you.
    let appIdx = samples.findIndex((s, i) => Math.hypot(s[0], s[1]) < 100 && i > 0);
    if (appIdx < 0) appIdx = samples.length - 1;
    const app = samples[Math.max(0, appIdx - 1)] || [0, 0];
    const approachOff = samples.length ? angDiff(bearing(app[0], app[1]), down) : 0;
    const approachPenalty = (approachOff / 180) * 20;

    const Z = zones(stand, spots);
    let tot = 0, hit = 0, walk = 0;
    const hits = {};
    for (const z of Z) {
      tot += z.w;
      let reached = false, walked = false;
      for (const s of samples) {
        const dx = z.x - s[0], dy = z.y - s[1];
        const d = Math.hypot(dx, dy);
        if (d < 20) walked = true;
        if (d < reach && (d < 15 || angDiff(bearing(dx, dy), down) < half)) reached = true;
        if (reached && walked) break;
      }
      if (reached) { hit += z.w; hits[z.name || z.label] = (hits[z.name || z.label] || 0) + z.w; }
      if (walked) walk += z.w;
    }
    const exposure = tot ? hit / tot : 0;
    const walkFrac = tot ? walk / tot : 0;
    // Walking into a marked spot bumps deer no matter the wind.
    let bumped = null;
    for (const sp of spots || []) {
      const z = SPOT_ZONE[sp.type];
      if (!z) continue;
      const [cx, cy] = toXY(sp.lat, sp.lon, o);
      if (samples.some(([x, y]) => Math.hypot(x - cx, y - cy) < z.radius)) { bumped = sp.name || z.label; break; }
    }
    let score = 100 - exposure * 75 - walkFrac * 60 - approachPenalty;
    if (speed < 3) score -= 5; // swirling air is unpredictable
    if (bumped) score = Math.min(score, 25);
    score = Math.max(0, Math.min(100, Math.round(score)));

    let reason;
    const worst = Object.entries(hits).sort((a, b) => b[1] - a[1])[0];
    if (bumped) reason = `Walks through the ${bumped}`;
    else if (walkFrac > 0.08) reason = 'Walks right through the area in front of the stand';
    else if (exposure > 0.15 && worst) reason = `Scent drifts over the ${worst[0]}`;
    else if (!Z.length) reason = approachOff < 60 ? 'Walking in with the wind in your face' : 'Wind at your back on the way in';
    else if (approachOff > 120) reason = 'Scent clear of deer areas, but you approach from upwind';
    else reason = 'Scent stays clear of deer areas';
    if (speed < 3) reason += ' · light, swirly wind';

    const cls = score >= 75 ? 'r-good' : score >= 50 ? 'r-marg' : 'r-bad';
    return { score, cls, label: score >= 75 ? 'Good' : score >= 50 ? 'Caution' : 'Bad', reason };
  }

  // Try straight-line approaches from every direction and return the best one.
  function suggestApproach(stand, spots, wind, length = 250) {
    if (!wind || wind.dir == null) return null;
    const o = { lat: stand.lat, lon: stand.lon };
    const down = (wind.dir + 180) % 360;
    let best = null;
    for (let b = 0; b < 360; b += 15) {
      const start = fromXY(length * Math.sin(b * RAD), length * Math.cos(b * RAD), o);
      const r = scoreRoute([start, [stand.lat, stand.lon]], stand, spots, wind);
      if (!r) continue;
      let rank = r.score;
      if (stand.facing != null && angDiff(b, stand.facing) > 120) rank += 4; // slip in behind the stand
      rank -= angDiff(b, down) / 180; // tie-break toward the downwind side
      if (!best || rank > best.rank) best = { ...r, rank, bearing: b, points: [start, [stand.lat, stand.lon]] };
    }
    return best;
  }

  global.Routes = { scoreRoute, suggestApproach, toXY, fromXY };
})(window);

/*
 * Terrain from AWS Terrain Tiles (Terrarium PNG encoding). In the US the source is
 * USGS 3DEP at ~10 m (3 m in places). Tiles are decoded into elevation grids and
 * used for elevation, slope, aspect and thermal drift at stands and along routes.
 */
(function (global) {
  'use strict';

  const Z = 15; // ~3.5 m pixels at 40°N; 3DEP source is ~10 m
  const URL_T = (x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`;
  const RAD = Math.PI / 180;
  const tiles = new Map(); // "x/y" -> Float32Array | 'loading' | 'failed'
  const waiting = new Map(); // "x/y" -> Promise
  let failures = 0;

  function tileXY(lat, lon) {
    const n = 2 ** Z;
    const x = ((lon + 180) / 360) * n;
    const r = lat * RAD;
    const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
    return [x, y];
  }

  function loadTile(x, y) {
    const key = `${x}/${y}`;
    if (tiles.has(key) && tiles.get(key) !== 'loading') return Promise.resolve(tiles.get(key));
    if (waiting.has(key)) return waiting.get(key);
    tiles.set(key, 'loading');
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 256; c.height = 256;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, 256, 256).data;
          const grid = new Float32Array(256 * 256);
          for (let i = 0; i < grid.length; i++) grid[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
          tiles.set(key, grid);
          resolve(grid);
        } catch (e) { tiles.set(key, 'failed'); failures++; resolve(null); }
      };
      img.onerror = () => { tiles.set(key, 'failed'); failures++; resolve(null); };
      img.src = URL_T(x, y);
    });
    waiting.set(key, p);
    p.then(() => waiting.delete(key));
    return p;
  }

  // Load every tile within `meters` of each point. Resolves true if anything new arrived.
  async function ensure(points, meters = 250) {
    const need = new Set();
    for (const [lat, lon] of points) {
      const dLat = meters / 111320, dLon = meters / (111320 * Math.cos(lat * RAD));
      for (const [a, b] of [[lat - dLat, lon - dLon], [lat + dLat, lon + dLon], [lat - dLat, lon + dLon], [lat + dLat, lon - dLon]]) {
        const [x, y] = tileXY(a, b);
        need.add(`${Math.floor(x)}/${Math.floor(y)}`);
      }
    }
    const fresh = [...need].filter((k) => !tiles.has(k));
    if (!fresh.length) return false;
    await Promise.all(fresh.map((k) => { const [x, y] = k.split('/').map(Number); return loadTile(x, y); }));
    return true;
  }

  function px(gx, gy) {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const g = tiles.get(`${tx}/${ty}`);
    if (!(g instanceof Float32Array)) return null;
    const ix = Math.min(255, Math.max(0, gx - tx * 256)), iy = Math.min(255, Math.max(0, gy - ty * 256));
    return g[iy * 256 + ix];
  }

  // Bilinear elevation in meters, or null if the tile isn't loaded.
  function elevation(lat, lon) {
    const [x, y] = tileXY(lat, lon);
    const gx = x * 256 - 0.5, gy = y * 256 - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
    if ([a, b, c, d].some((v) => v == null)) return null;
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  function offset(lat, lon, bearing, m) {
    const b = bearing * RAD;
    return [lat + (m * Math.cos(b)) / 111320, lon + (m * Math.sin(b)) / (111320 * Math.cos(lat * RAD))];
  }

  /**
   * Ground shape at a point: slope (degrees), aspect (compass direction the slope
   * faces, i.e. downhill), and where it sits relative to ground ~150 m around it.
   */
  function describe(lat, lon) {
    const e0 = elevation(lat, lon);
    if (e0 == null) return null;
    // Fit the hillside over ~100 m (8 points at 50 m) rather than the few meters
    // right under the stand: thermals follow the larger slope, not a ditch or a bump.
    const h = 50;
    const at = (b) => elevation(...offset(lat, lon, b, h));
    const pts = [0, 45, 90, 135, 180, 225, 270, 315].map((b) => [b, at(b)]);
    if (pts.some(([, v]) => v == null)) return null;
    let sx = 0, sy = 0, sxx = 0, syy = 0;
    for (const [b, v] of pts) {
      const x = Math.sin(b * RAD) * h, y = Math.cos(b * RAD) * h;
      sx += x * (v - e0); sy += y * (v - e0); sxx += x * x; syy += y * y;
    }
    const dzdx = sx / sxx, dzdy = sy / syy; // least-squares rise per meter toward E and N
    const grad = Math.hypot(dzdx, dzdy);
    const slope = Math.atan(grad) / RAD;
    const aspect = grad > 0 ? ((Math.atan2(-dzdx, -dzdy) / RAD) + 360) % 360 : null; // downhill direction
    const ring = [];
    for (let b = 0; b < 360; b += 30) { const v = elevation(...offset(lat, lon, b, 150)); if (v != null) ring.push(v); }
    const rel = ring.length ? e0 - ring.reduce((a, v) => a + v, 0) / ring.length : 0;
    const position = rel > 6 ? 'ridge' : rel < -6 ? 'bottom' : slope > 4 ? 'side-hill' : 'flat';
    return { elevation: e0, slope, aspect, rel, position };
  }

  /**
   * Thermal flow at a moment: downslope while the ground is cool (night, dawn, dusk),
   * upslope once the sun has warmed it. Returns { toward (bearing), speed (mph-equivalent), phase }.
   */
  function thermal(ground, t, day) {
    if (!ground || ground.aspect == null || ground.slope < 3 || !day) return null;
    const H = 3600 * 1000;
    const sr = day.sunrise.getTime(), ss = day.sunset.getTime(), x = t.getTime();
    let phase;
    if (x < sr + 1.5 * H || x > ss - 1 * H) phase = 'down';
    else if (x > sr + 3 * H && x < ss - 2.5 * H) phase = 'up';
    else phase = 'switching';
    if (phase === 'switching') return { phase, toward: null, speed: 0 };
    // Slope flows are typically 1-2 mph; they steer scent mainly when the wind is light.
    const speed = 2 * Math.min(1, ground.slope / 10);
    return { phase, toward: phase === 'down' ? ground.aspect : (ground.aspect + 180) % 360, speed };
  }

  /**
   * Where scent actually goes: the wind's push plus the thermal pull, as a vector sum.
   * wind: { dir (blowing from), speed mph }. Returns { dir (as a "from" bearing), speed, toward, thermalShare }.
   */
  function scentDrift(wind, th) {
    if (!wind || wind.dir == null) return null;
    const toward = (wind.dir + 180) % 360;
    let x = Math.sin(toward * RAD) * (wind.speed || 0), y = Math.cos(toward * RAD) * (wind.speed || 0);
    let share = 0;
    if (th && th.toward != null && th.speed > 0) {
      x += Math.sin(th.toward * RAD) * th.speed;
      y += Math.cos(th.toward * RAD) * th.speed;
      share = th.speed / ((wind.speed || 0) + th.speed);
    }
    const sp = Math.hypot(x, y);
    const tw = sp > 0 ? ((Math.atan2(x, y) / RAD) + 360) % 360 : toward;
    return { dir: (tw + 180) % 360, speed: sp, toward: tw, thermalShare: share };
  }

  // Total climb along a path of [lat, lon] points, sampled every ~10 m.
  function climb(points) {
    let up = 0, down = 0, prev = null;
    for (let i = 0; i < points.length - 1; i++) {
      const [a, b] = points[i], [c, d] = points[i + 1];
      const dist = Math.hypot((c - a) * 111320, (d - b) * 111320 * Math.cos(a * RAD));
      const n = Math.max(1, Math.ceil(dist / 10));
      for (let k = 0; k <= n; k++) {
        const e = elevation(a + ((c - a) * k) / n, b + ((d - b) * k) / n);
        if (e == null) return null;
        if (prev != null) { if (e > prev) up += e - prev; else down += prev - e; }
        prev = e;
      }
    }
    return { up, down };
  }

  global.Terrain = { ensure, elevation, describe, thermal, scentDrift, climb, get available() { return failures < 3; } };
})(window);

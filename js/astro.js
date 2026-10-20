/* Sun, moon and solunar calculations built on SunCalc. */
(function (global) {
  'use strict';

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addMs(d, ms) {
    return new Date(d.getTime() + ms);
  }

  function valid(d) {
    return d instanceof Date && !isNaN(d.getTime());
  }

  function phaseName(phase) {
    // phase: 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter
    if (phase < 0.03 || phase > 0.97) return 'New Moon';
    if (phase < 0.22) return 'Waxing Crescent';
    if (phase < 0.28) return 'First Quarter';
    if (phase < 0.47) return 'Waxing Gibbous';
    if (phase < 0.53) return 'Full Moon';
    if (phase < 0.72) return 'Waning Gibbous';
    if (phase < 0.78) return 'Last Quarter';
    return 'Waning Crescent';
  }

  // Find the moon overhead (upper transit) and underfoot (lower transit) times
  // for a local day by scanning altitude for interior extrema.
  function moonTransits(day, lat, lon) {
    const start = startOfDay(day);
    const step = 10 * MIN;
    const alt = (t) => SunCalc.getMoonPosition(t, lat, lon).altitude;
    const out = { overhead: null, underfoot: null };
    let prev = alt(addMs(start, -step));
    let cur = alt(start);
    for (let t = start.getTime(); t < start.getTime() + 24 * HOUR; t += step) {
      const next = alt(new Date(t + step));
      const isMax = cur > prev && cur >= next;
      const isMin = cur < prev && cur <= next;
      if (isMax || isMin) {
        // Refine to the minute.
        let best = t, bestAlt = cur;
        for (let r = t - step; r <= t + step; r += MIN) {
          const a = alt(new Date(r));
          if (isMax ? a > bestAlt : a < bestAlt) { best = r; bestAlt = a; }
        }
        const when = new Date(best);
        if (when >= start && when < addMs(start, 24 * HOUR)) {
          if (isMax && !out.overhead) out.overhead = when;
          if (isMin && !out.underfoot) out.underfoot = when;
        }
      }
      prev = cur;
      cur = next;
    }
    return out;
  }

  function solunarPeriods(day, lat, lon) {
    const mt = SunCalc.getMoonTimes(startOfDay(day), lat, lon);
    const tr = moonTransits(day, lat, lon);
    const periods = [];
    if (tr.overhead) periods.push({ kind: 'major', label: 'Moon overhead', center: tr.overhead, start: addMs(tr.overhead, -HOUR), end: addMs(tr.overhead, HOUR) });
    if (tr.underfoot) periods.push({ kind: 'major', label: 'Moon underfoot', center: tr.underfoot, start: addMs(tr.underfoot, -HOUR), end: addMs(tr.underfoot, HOUR) });
    if (valid(mt.rise)) periods.push({ kind: 'minor', label: 'Moonrise', center: mt.rise, start: addMs(mt.rise, -30 * MIN), end: addMs(mt.rise, 30 * MIN) });
    if (valid(mt.set)) periods.push({ kind: 'minor', label: 'Moonset', center: mt.set, start: addMs(mt.set, -30 * MIN), end: addMs(mt.set, 30 * MIN) });
    periods.sort((a, b) => a.center - b.center);
    return { periods, moonrise: valid(mt.rise) ? mt.rise : null, moonset: valid(mt.set) ? mt.set : null, transits: tr };
  }

  function dayInfo(day, lat, lon, legal) {
    const noon = startOfDay(day);
    noon.setHours(12);
    const sun = SunCalc.getTimes(noon, lat, lon);
    const illum = SunCalc.getMoonIllumination(noon);
    const sol = solunarPeriods(day, lat, lon);
    const legalStart = valid(sun.sunrise) ? addMs(sun.sunrise, -legal.before * MIN) : null;
    const legalEnd = valid(sun.sunset) ? addMs(sun.sunset, legal.after * MIN) : null;
    return {
      date: startOfDay(day),
      sunrise: sun.sunrise,
      sunset: sun.sunset,
      dawn: sun.dawn, // civil twilight start
      dusk: sun.dusk,
      solarNoon: sun.solarNoon,
      legalStart,
      legalEnd,
      dayLength: valid(sun.sunset) && valid(sun.sunrise) ? sun.sunset - sun.sunrise : null,
      moon: {
        phase: illum.phase,
        fraction: illum.fraction,
        name: phaseName(illum.phase),
        waxing: illum.phase < 0.5,
        rise: sol.moonrise,
        set: sol.moonset,
        overhead: sol.transits.overhead,
        underfoot: sol.transits.underfoot,
      },
      solunar: sol.periods,
    };
  }

  // Draw the moon's lit portion onto a canvas.
  function drawMoon(canvas, phase) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, r = w / 2 - 2, c = w / 2;
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = '#2b3128';
    ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f1ecd2';
    const waxing = phase <= 0.5;
    const k = Math.cos(phase * 2 * Math.PI); // 1 new, -1 full
    ctx.beginPath();
    // Lit half circle on the right (waxing) or left (waning).
    ctx.arc(c, c, r, -Math.PI / 2, Math.PI / 2, !waxing);
    // Terminator ellipse back to top.
    ctx.ellipse(c, c, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0) === waxing);
    ctx.fill();
  }

  global.Astro = { dayInfo, drawMoon, phaseName, startOfDay, HOUR, MIN };
})(window);

/*
 * Deer movement model. Scores each forecast hour 0-100 from:
 *  - time relative to sunrise/sunset (deer are crepuscular)
 *  - solunar major/minor periods
 *  - pressure trend, temperature drop, wind, precipitation
 *  - moon phase and rut timing
 * Weights come from common field wisdom, not a fitted model.
 */
(function (global) {
  'use strict';

  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const gauss = (x, w) => Math.exp(-(x * x) / (2 * w * w));

  function overlap(t, period) {
    // 1 inside the period, fading out over 30 min on either side.
    const s = period.start.getTime(), e = period.end.getTime(), x = t.getTime();
    if (x >= s && x <= e) return 1;
    const d = x < s ? s - x : x - e;
    return clamp(1 - d / (0.5 * HOUR), 0, 1);
  }

  function rutPhase(date, rutPeak) {
    if (!rutPeak) return { boost: 0, label: null, midday: 0 };
    const days = Math.round((date - rutPeak) / DAY);
    if (days < -35 || days > 40) return { boost: 0, label: null, midday: 0, days };
    if (days < -14) return { boost: 4, label: 'Pre-rut: scrapes and rubs opening up', midday: 0.1, days };
    if (days < -4) return { boost: 9, label: 'Seeking phase: bucks cruising', midday: 0.35, days };
    if (days <= 6) return { boost: 12, label: 'Peak rut: chasing, all-day movement', midday: 0.6, days };
    if (days <= 18) return { boost: 6, label: 'Lockdown/tending: sporadic movement', midday: 0.3, days };
    return { boost: 4, label: 'Post-rut: bucks back on food', midday: 0.1, days };
  }

  /**
   * hours: [{ time: Date, temp, wind, gust, dir, precip, precipProb, pressure (hPa), cloud }]
   *   temps in °F, wind in mph, precip in inches.
   * days: map of dayKey -> Astro.dayInfo
   */
  function scoreHours(hours, getDay, opts) {
    const out = [];
    for (let i = 0; i < hours.length; i++) {
      const h = hours[i];
      const day = getDay(h.time);
      if (!day) { out.push(null); continue; }
      const factors = [];
      const t = h.time.getTime();

      // 1. Daylight curve: peaks just after sunrise and just before sunset.
      const hSunrise = (t - (day.sunrise.getTime() + 0.4 * HOUR)) / HOUR;
      const hSunset = (t - (day.sunset.getTime() - 0.4 * HOUR)) / HOUR;
      const rut = rutPhase(day.date, opts.rutPeak);
      let base = 18 + 45 * Math.max(gauss(hSunrise, 1.3), gauss(hSunset, 1.3));
      const midday = Math.abs((t - day.solarNoon.getTime()) / HOUR) < 2.5;
      if (midday && rut.midday) base += 20 * rut.midday;
      let score = base;

      // 2. Solunar.
      let sol = 0;
      for (const p of day.solunar) {
        const o = overlap(h.time, p);
        sol = Math.max(sol, o * (p.kind === 'major' ? 14 : 8));
      }
      if (sol > 0) factors.push({ v: sol, text: 'Solunar period' });
      score += sol;

      // 3. Pressure trend over the previous 6 hours.
      const prev6 = hours[i - 6];
      if (prev6 && h.pressure != null && prev6.pressure != null) {
        const dp = h.pressure - prev6.pressure; // hPa
        let pv = 0;
        if (dp > 1.5) pv = 7; // rising after a front
        else if (dp < -3) pv = 5; // falling fast ahead of a storm
        else if (dp < -1.5) pv = 2;
        if (h.pressure > 1022) pv += 2;
        if (h.pressure < 1005) pv -= 3;
        score += pv;
        h.pressureTrend = dp;
      }

      // 4. Temperature: compare to the same hour yesterday.
      const prev24 = hours[i - 24];
      if (prev24 && h.temp != null && prev24.temp != null) {
        const dt = h.temp - prev24.temp;
        if (dt <= -10) score += 10;
        else if (dt <= -5) score += 5;
        else if (dt >= 10) score -= 6;
        else if (dt >= 5) score -= 3;
      }
      if (h.temp != null) {
        if (h.temp > 75) score -= 10;
        else if (h.temp > 65) score -= 5;
        else if (h.temp < 40) score += 3;
      }

      // 5. Wind.
      if (h.wind != null) {
        if (h.wind > 20) score -= 15;
        else if (h.wind > 14) score -= 8;
        else if (h.wind < 2) score -= 1;
        else if (h.wind <= 10) score += 2;
      }

      // 6. Precipitation: heavy rain shuts them down, movement after it clears.
      if (h.precip != null) {
        if (h.precip > 0.15) score -= 12;
        else if (h.precip > 0.04) score -= 4;
        else if (h.precip > 0) score += 1; // drizzle/mist is fine
        const before = hours.slice(Math.max(0, i - 4), i);
        const wasRaining = before.some((b) => b.precip != null && b.precip > 0.05);
        if (wasRaining && h.precip < 0.01) score += 8;
      }

      // 7. Moon phase: modest bump around new and full.
      const mp = day.moon.phase;
      const nearNewFull = Math.min(mp, Math.abs(mp - 0.5), 1 - mp) < 0.06;
      if (nearNewFull) score += 3;

      score += rut.boost;
      out.push(clamp(Math.round(score), 0, 100));
    }
    return out;
  }

  // Summarise a day: overall score, reasons, and best windows within legal light.
  function summarizeDay(day, hours, scores, opts) {
    const idx = [];
    for (let i = 0; i < hours.length; i++) {
      const t = hours[i].time;
      if (scores[i] == null) continue;
      if (t >= day.legalStart - HOUR && t <= day.legalEnd) idx.push(i);
    }
    if (!idx.length) return null;
    const noon = day.solarNoon.getTime();
    const am = idx.filter((i) => hours[i].time.getTime() < noon);
    const pm = idx.filter((i) => hours[i].time.getTime() >= noon);
    const maxOf = (arr) => (arr.length ? Math.max(...arr.map((i) => scores[i])) : 0);
    const mean = idx.reduce((s, i) => s + scores[i], 0) / idx.length;
    const score = Math.round(0.4 * maxOf(am) + 0.4 * maxOf(pm) + 0.2 * mean);

    // Reasons
    const reasons = [];
    const dayHours = idx.map((i) => hours[i]);
    const temps = dayHours.map((h) => h.temp).filter((v) => v != null);
    const winds = dayHours.map((h) => h.wind).filter((v) => v != null);
    const precip = dayHours.reduce((s, h) => s + (h.precip || 0), 0);
    const first = idx[0];
    const yIdx = first - 24;
    if (yIdx >= 0 && hours[yIdx].temp != null && hours[first].temp != null) {
      const dt = hours[first].temp - hours[yIdx].temp;
      if (dt <= -5) reasons.push({ good: true, text: `Morning ${Math.round(-dt)}° cooler than yesterday` });
      else if (dt >= 5) reasons.push({ good: false, text: `Morning ${Math.round(dt)}° warmer than yesterday` });
    }
    if (temps.length && Math.max(...temps) > 68) reasons.push({ good: false, text: 'Warm afternoon: deer will move late' });
    if (winds.length) {
      const mw = Math.max(...winds);
      if (mw > 18) reasons.push({ good: false, text: `Windy (up to ${Math.round(mw)} mph)` });
      else if (mw <= 10) reasons.push({ good: true, text: 'Light winds' });
    }
    if (precip > 0.3) reasons.push({ good: false, text: 'Steady rain expected' });
    const pt = dayHours.map((h) => h.pressureTrend).filter((v) => v != null);
    if (pt.length) {
      const maxRise = Math.max(...pt), maxFall = Math.min(...pt);
      if (maxRise > 1.5) reasons.push({ good: true, text: 'Pressure rising (post-front)' });
      else if (maxFall < -3) reasons.push({ good: true, text: 'Pressure dropping ahead of weather' });
    }
    const goodSol = day.solunar.filter((p) => nearLight(p.center, day));
    if (goodSol.length) reasons.push({ good: true, text: `${goodSol[0].label} near ${isMorning(goodSol[0].center, day) ? 'dawn' : 'dusk'}` });
    const mp = day.moon.phase;
    if (Math.min(mp, Math.abs(mp - 0.5), 1 - mp) < 0.06) reasons.push({ good: true, text: day.moon.name });
    const rut = rutPhase(day.date, opts.rutPeak);
    if (rut.label) reasons.push({ good: true, text: rut.label });

    // Best windows: contiguous runs of top hours.
    const windows = [];
    const threshold = Math.max(score - 8, 45);
    let run = null;
    for (const i of idx) {
      if (scores[i] >= threshold) {
        if (!run) run = { start: hours[i].time, end: new Date(hours[i].time.getTime() + HOUR), peak: scores[i] };
        else { run.end = new Date(hours[i].time.getTime() + HOUR); run.peak = Math.max(run.peak, scores[i]); }
      } else if (run) { windows.push(run); run = null; }
    }
    if (run) windows.push(run);
    // Clip windows to legal light.
    for (const w of windows) {
      if (w.start < day.legalStart) w.start = day.legalStart;
      if (w.end > day.legalEnd) w.end = day.legalEnd;
    }
    windows.sort((a, b) => b.peak - a.peak);

    return { score, reasons, windows: windows.filter((w) => w.end > w.start).slice(0, 3), amIdx: am, pmIdx: pm };
  }

  function nearLight(t, day) {
    return Math.abs(t - day.sunrise) < 1.5 * HOUR || Math.abs(t - day.sunset) < 1.5 * HOUR;
  }
  function isMorning(t, day) {
    return t < day.solarNoon;
  }

  function label(score) {
    if (score >= 80) return 'Excellent';
    if (score >= 65) return 'Good';
    if (score >= 50) return 'Fair';
    if (score >= 35) return 'Slow';
    return 'Poor';
  }

  global.Movement = { scoreHours, summarizeDay, label, rutPhase };
})(window);

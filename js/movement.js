/*
 * Deer movement model. Scores each forecast hour 0-100.
 *
 * Weights follow GPS-collar research rather than hunting folklore:
 *  - Time relative to sunrise/sunset dominates every study (deer are crepuscular).
 *  - Season / rut timing is the next biggest driver.
 *  - Temperature change is the most consistent weather effect, but modest.
 *  - Barometric pressure: mixed evidence, small weight.
 *  - Wind: small and inconsistent effect on movement (it matters for scent, which
 *    the stand and route ratings handle), so only extreme wind counts here.
 *  - Moon phase: no effect in GPS studies, so it is not scored.
 *  - Solunar: only moon overhead/underfoot showed any association, and only on
 *    days away from new/full moon; small weight. Moonrise/moonset are not scored.
 * See EVIDENCE below for sources.
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
    // "Normal" temperature for each hour of the day across the whole window (~10 days),
    // so heat is judged against the season, not a fixed number.
    const sums = new Array(24).fill(0), counts = new Array(24).fill(0);
    for (const h of hours) if (h.temp != null) { const k = h.time.getHours(); sums[k] += h.temp; counts[k]++; }
    const normal = sums.map((v, k) => (counts[k] >= 3 ? v / counts[k] : null));
    for (let i = 0; i < hours.length; i++) {
      const h = hours[i];
      const day = getDay(h.time);
      if (!day) { out.push(null); continue; }
      const t = h.time.getTime();

      // 1. Daylight curve (the dominant factor): peaks just after sunrise and before sunset.
      const hSunrise = (t - (day.sunrise.getTime() + 0.4 * HOUR)) / HOUR;
      const hSunset = (t - (day.sunset.getTime() - 0.4 * HOUR)) / HOUR;
      const rut = rutPhase(day.date, opts.rutPeak);
      let score = 15 + 55 * Math.max(gauss(hSunrise, 1.3), gauss(hSunset, 1.3));
      const midday = Math.abs((t - day.solarNoon.getTime()) / HOUR) < 2.5;
      if (midday && rut.midday) score += 22 * rut.midday;

      // 2. Season / rut.
      score += rut.boost;

      // 3. Temperature: change vs the same hour yesterday, and heat.
      const prev24 = hours[i - 24];
      if (prev24 && h.temp != null && prev24.temp != null) {
        const dt = h.temp - prev24.temp;
        if (dt <= -10) score += 9;
        else if (dt <= -5) score += 5;
        else if (dt >= 10) score -= 5;
        else if (dt >= 5) score -= 2;
      }
      if (h.temp != null) {
        const n = normal[h.time.getHours()];
        const anomaly = n != null ? h.temp - n : 0;
        if (anomaly > 10) score -= 6; // unseasonably warm
        else if (anomaly > 5) score -= 3;
        else if (anomaly < -8) score += 3; // unseasonably cold
        if (h.temp > 75) score -= 4; // hot is hot, whatever the season
        h.tempAnomaly = anomaly;
      }

      // 4. Pressure trend over 6 hours (mixed evidence, small weight).
      const prev6 = hours[i - 6];
      if (prev6 && h.pressure != null && prev6.pressure != null) {
        const dp = h.pressure - prev6.pressure; // hPa
        if (dp > 1.5) score += 3; // rising behind a front
        else if (dp < -3) score += 2; // falling fast ahead of weather
        h.pressureTrend = dp;
      }

      // 5. Wind: only extreme wind.
      if (h.wind != null && h.wind > 25) score -= 4;

      // 6. Precipitation: heavy rain slows movement; movement after it clears.
      if (h.precip != null) {
        if (h.precip > 0.15) score -= 6;
        const before = hours.slice(Math.max(0, i - 4), i);
        if (before.some((b) => b.precip != null && b.precip > 0.05) && h.precip < 0.01) score += 4;
      }

      // 7. Solunar: moon overhead/underfoot only, small weight, mostly away from new/full moon.
      const mp = day.moon.phase;
      const fromNewFull = Math.min(mp, Math.abs(mp - 0.5), 1 - mp); // 0 at new/full, 0.25 at quarters
      let sol = 0;
      for (const p of day.solunar) if (p.kind === 'major') sol = Math.max(sol, overlap(h.time, p));
      score += sol * (2 + 8 * fromNewFull); // 2 at new/full, up to 4 at quarter moons

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
    const anoms = dayHours.map((h) => h.tempAnomaly).filter((v) => v != null);
    const maxAnom = anoms.length ? Math.max(...anoms) : 0, minAnom = anoms.length ? Math.min(...anoms) : 0;
    if (maxAnom > 8 || (temps.length && Math.max(...temps) > 75)) reasons.push({ good: false, text: 'Warmer than it has been: deer will move late' });
    else if (minAnom < -8) reasons.push({ good: true, text: 'Colder than it has been' });
    if (precip > 0.3) reasons.push({ good: false, text: 'Steady rain expected' });
    if (winds.length) {
      const mw = Math.max(...winds);
      if (mw > 25) reasons.push({ good: false, text: `Very windy (up to ${Math.round(mw)} mph)` });
      else if (mw > 15) reasons.push({ good: false, text: `Windy: tougher hunting, movement only slightly affected` });
    }
    const pt = dayHours.map((h) => h.pressureTrend).filter((v) => v != null);
    if (pt.length) {
      const maxRise = Math.max(...pt), maxFall = Math.min(...pt);
      if (maxRise > 1.5) reasons.push({ good: true, text: 'Pressure rising (post-front)' });
      else if (maxFall < -3) reasons.push({ good: true, text: 'Pressure dropping ahead of weather' });
    }
    const goodSol = day.solunar.filter((p) => p.kind === 'major' && nearLight(p.center, day));
    if (goodSol.length) reasons.push({ good: true, text: `${goodSol[0].label} near ${isMorning(goodSol[0].center, day) ? 'dawn' : 'dusk'} (small effect)` });
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

  // What drives the score and how strong the research behind each factor is.
  const EVIDENCE = [
    { factor: 'Time of day (dawn & dusk)', weight: 'Up to +55', strength: 'strong', note: 'The dominant pattern in every GPS-collar study.' },
    { factor: 'Rut timing', weight: '+4 to +12, plus midday movement at peak', strength: 'strong', note: 'Adult bucks increase movement into the breeding season, then drop off after.' },
    { factor: 'Temperature', weight: '+5 to +9 colder than yesterday, +3 colder than the week; −2 to −6 warmer, −4 above 75°F', strength: 'moderate', note: 'The most consistent weather effect, but smaller than time of day. Warmth is judged against the past and coming week, not a fixed number.' },
    { factor: 'Barometric pressure', weight: '+2 to +3', strength: 'mixed', note: 'Some studies show more movement on rising or very high pressure; others show little.' },
    { factor: 'Rain', weight: '−6 heavy, +4 after it clears', strength: 'limited', note: 'Little hard data; kept small.' },
    { factor: 'Solunar (moon overhead/underfoot)', weight: '+2 to +4', strength: 'weak', note: 'One GPS study found a link only for overhead/underfoot, mostly away from new/full moon. Moonrise/moonset not scored.' },
    { factor: 'Wind', weight: '−4 only above 25 mph', strength: 'weak', note: 'Studies disagree and effects are small; wind matters most for scent, handled by stand and route ratings.' },
    { factor: 'Moon phase', weight: 'Not scored', strength: 'none', note: 'GPS studies found no effect of moon phase on movement.' },
  ];
  const SOURCES = [
    ['Penn State: deer movement vs moon phase and weather', 'https://www.psu.edu/news/research/story/research-focus-how-deer-respond-changes-moon-phase-weather'],
    ['Webb et al. 2010, Int. J. of Ecology: moon phase and deer movement', 'https://doaj.org/article/98c06121b2744793be79f44614fcd27f'],
    ['Sullivan et al. 2016, SEAFWA: deer activity and solunar events', 'https://seafwa.org/journal/2016/movement-moon-white-tailed-deer-activity-and-solunar-events'],
    ['Goethlich, Auburn Univ.: abiotic factors and deer activity', 'https://etd.auburn.edu/handle/10415/7077'],
    ['NC State: adult male movement through the breeding season', 'https://repository.lib.ncsu.edu/items/61a4d1f2-63c5-4c35-8169-e3be4adcff7d/full'],
  ];

  global.Movement = { scoreHours, summarizeDay, label, rutPhase, EVIDENCE, SOURCES };
})(window);

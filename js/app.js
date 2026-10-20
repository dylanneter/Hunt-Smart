/* Hunt Smart main app. */
(function () {
  'use strict';

  const HOUR = 3600 * 1000;
  const STORE_KEY = 'huntsmart.v1';
  const FORECAST_KEY = 'huntsmart.forecast.v1';
  // Open-Meteo refreshes current conditions every 15 minutes; poll a bit faster so we catch each update.
  const REFRESH_MS = 10 * 60 * 1000;
  const STALE_MS = 30 * 60 * 1000;
  const DIRS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const DIRS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  const WMO = {
    0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
    45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
    51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
    56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
    61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
    71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
    80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '🌧️'],
    85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
    95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
  };

  // ---------- State ----------
  const defaults = {
    settings: { lat: null, lon: null, legalBefore: 30, legalAfter: 30, rutPeak: defaultRut(), units: 'imperial' },
    stands: [],
  };
  let store = load();
  let forecast = null; // raw cached response
  let model = null; // computed hours/days
  let selectedDay = 0;
  let mapHour = 0;
  let refreshTimer = null, fetching = false, lastError = null;
  let map = null, standLayer = null, coneLayer = null, addingStand = false, pendingLatLng = null, editingId = null;

  function defaultRut() {
    const now = new Date();
    // If we're past mid-December, point at next year's rut.
    const y = now.getMonth() === 11 && now.getDate() > 15 ? now.getFullYear() + 1 : now.getFullYear();
    return `${y}-11-12`;
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.settings) return { settings: { ...defaults.settings, ...s.settings }, stands: s.stands || [] };
    } catch (e) { /* ignore */ }
    return JSON.parse(JSON.stringify(defaults));
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  }

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const metric = () => store.settings.units === 'metric';
  const fmtTemp = (f) => (f == null ? '--' : metric() ? `${Math.round((f - 32) * 5 / 9)}°` : `${Math.round(f)}°`);
  const fmtWind = (mph) => (mph == null ? '--' : metric() ? `${Math.round(mph * 1.609)} km/h` : `${Math.round(mph)} mph`);
  const fmtPress = (hpa) => (hpa == null ? '--' : metric() ? `${Math.round(hpa)} hPa` : `${(hpa * 0.02953).toFixed(2)} inHg`);
  const fmtPrecip = (inch) => (metric() ? `${(inch * 25.4).toFixed(1)} mm` : `${inch.toFixed(2)}"`);
  const fmtTime = (d) => (d && !isNaN(d) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
  const fmtHour = (d) => d.toLocaleTimeString([], { hour: 'numeric' });
  const fmtDay = (d, i) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long' }));
  const fmtDayShort = (d, i) => (i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short' }));
  const dirName = (deg) => DIRS16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };
  const scoreClass = (s) => (s >= 80 ? 's-exc' : s >= 65 ? 's-good' : s >= 50 ? 's-fair' : s >= 35 ? 's-slow' : 's-poor');
  const hasLoc = () => store.settings.lat != null && store.settings.lon != null;

  function arrowSvg(dirFrom, size = 18) {
    // Arrow points the way the wind is blowing (downwind).
    return `<svg class="arrow" width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${dirFrom + 180}deg)" aria-hidden="true"><path d="M12 2 L19 20 L12 15 L5 20 Z" fill="currentColor"/></svg>`;
  }

  function showBanner(msg, kind) {
    const b = $('banner');
    if (!msg) { b.classList.add('hidden'); return; }
    b.textContent = msg;
    b.className = `banner ${kind || ''}`;
  }

  // Vector-average wind over a set of hours.
  function avgWind(hours) {
    let x = 0, y = 0, s = 0, n = 0;
    for (const h of hours) {
      if (h.dir == null || h.wind == null) continue;
      const r = (h.dir * Math.PI) / 180;
      x += Math.sin(r) * h.wind; y += Math.cos(r) * h.wind; s += h.wind; n++;
    }
    if (!n) return null;
    let dir = (Math.atan2(x, y) * 180) / Math.PI;
    if (dir < 0) dir += 360;
    return { dir, speed: s / n, gust: Math.max(...hours.map((h) => h.gust || 0)) };
  }

  function windRating(stand, dir, speed) {
    if (!stand.goodWinds || !stand.goodWinds.length || dir == null) return { cls: 'r-unk', text: 'Set winds' };
    const d = Math.min(...stand.goodWinds.map((w) => angDiff(dir, DIRS8.indexOf(w) * 45)));
    let r;
    if (d <= 22.5) r = { cls: 'r-good', text: 'Good wind' };
    else if (d <= 45) r = { cls: 'r-marg', text: 'Marginal' };
    else r = { cls: 'r-bad', text: 'Bad wind' };
    if (speed != null && speed < 3) r.text += ' · swirly';
    return r;
  }

  // ---------- Forecast ----------
  async function fetchForecast(force) {
    if (!hasLoc()) return;
    const { lat, lon } = store.settings;
    const cached = readCachedForecast();
    const fresh = cached && cached.lat === lat && cached.lon === lon && Date.now() - cached.fetchedAt < REFRESH_MS;
    if (!forecast && cached && cached.lat === lat && cached.lon === lon) { forecast = cached; buildModel(); render(); }
    if ((fresh && !force) || fetching) return;

    const hourly = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
    const current = 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=${hourly}&current=${current}&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`
      + `&timezone=auto&timeformat=unixtime&past_days=2&forecast_days=8`;
    fetching = true;
    $('refreshBtn').classList.add('spin');
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
      const data = await res.json();
      if (!data.hourly || !data.current) throw new Error('Unexpected response from weather service');
      const prev = forecast && forecast.lat === lat && forecast.lon === lon ? forecast.data.current : null;
      forecast = { lat, lon, fetchedAt: Date.now(), data };
      lastError = null;
      try { localStorage.setItem(FORECAST_KEY, JSON.stringify(forecast)); } catch (e) { /* ignore */ }
      showBanner(null);
      buildModel();
      render();
      announceWindShift(prev, data.current);
    } catch (err) {
      lastError = err;
      if (forecast) showBanner(`Offline – showing forecast from ${new Date(forecast.fetchedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, 'warn');
      else showBanner(`Couldn't load weather: ${err.message}. Sun and moon times still work.`, 'warn');
      if (!forecast) { buildModel(); render(); }
    } finally {
      fetching = false;
      $('refreshBtn').classList.remove('spin');
      renderLiveStatus();
    }
  }

  // Keep pulling fresh conditions while the app is open; pause when it's in the background.
  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
      if (document.hidden) return;
      fetchForecast();
      renderLiveStatus();
    }, 30 * 1000);
  }
  function stopAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function renderLiveStatus() {
    const el = $('updated');
    if (!forecast) { el.innerHTML = ''; return; }
    const age = Date.now() - forecast.fetchedAt;
    const mins = Math.floor(age / 60000);
    const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)}h ago`;
    let cls = 'live', text = `Live · ${ago}`;
    if (!navigator.onLine || (lastError && age > REFRESH_MS)) { cls = 'offline'; text = `Offline · ${ago}`; }
    else if (age > STALE_MS) { cls = 'stale'; text = `Updated ${ago}`; }
    el.innerHTML = `<span class="live-dot ${cls}"></span>${text}`;
  }

  function announceWindShift(prev, cur) {
    if (!prev || !cur || prev.wind_direction_10m == null || cur.wind_direction_10m == null) return;
    if (cur.wind_speed_10m < 3 && prev.wind_speed_10m < 3) return;
    if (angDiff(prev.wind_direction_10m, cur.wind_direction_10m) < 45) return;
    showToast(`Wind shifted ${dirName(prev.wind_direction_10m)} → ${dirName(cur.wind_direction_10m)} (${fmtWind(cur.wind_speed_10m)})`);
  }

  let toastTimer = null;
  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 6000);
  }

  function readCachedForecast() {
    try { return JSON.parse(localStorage.getItem(FORECAST_KEY)); } catch (e) { return null; }
  }

  function buildModel() {
    const { lat, lon, legalBefore, legalAfter, rutPeak } = store.settings;
    const legal = { before: Number(legalBefore) || 0, after: Number(legalAfter) || 0 };
    const rut = rutPeak ? new Date(`${rutPeak}T12:00:00`) : null;
    const hours = [];
    let current = null;
    if (forecast && forecast.data && forecast.data.hourly) {
      const h = forecast.data.hourly;
      for (let i = 0; i < h.time.length; i++) {
        hours.push({
          time: new Date(h.time[i] * 1000),
          temp: h.temperature_2m[i], feels: h.apparent_temperature[i], rh: h.relative_humidity_2m[i],
          precipProb: h.precipitation_probability[i], precip: h.precipitation[i], code: h.weather_code[i],
          cloud: h.cloud_cover[i], pressure: h.pressure_msl[i], wind: h.wind_speed_10m[i],
          dir: h.wind_direction_10m[i], gust: h.wind_gusts_10m[i],
        });
      }
      const c = forecast.data.current;
      if (c) current = { time: new Date(c.time * 1000), temp: c.temperature_2m, feels: c.apparent_temperature, rh: c.relative_humidity_2m, code: c.weather_code, pressure: c.pressure_msl, wind: c.wind_speed_10m, dir: c.wind_direction_10m, gust: c.wind_gusts_10m };
    }

    const dayCache = {};
    const getDay = (t) => {
      const k = dayKey(t);
      if (!dayCache[k]) dayCache[k] = Astro.dayInfo(t, lat, lon, legal);
      return dayCache[k];
    };
    const scores = hours.length ? Movement.scoreHours(hours, getDay, { rutPeak: rut }) : [];

    const today = Astro.startOfDay(new Date());
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const info = getDay(d);
      const k = dayKey(d);
      const dayIdx = hours.map((h, j) => j).filter((j) => dayKey(hours[j].time) === k);
      const summary = hours.length ? Movement.summarizeDay(info, hours, scores, { rutPeak: rut }) : null;
      days.push({ info, idx: dayIdx, summary });
    }
    model = { hours, scores, days, current, getDay, rut };
  }

  // ---------- Rendering: Today ----------
  function render() {
    if (!model) return;
    renderDayPicker();
    renderToday();
    renderWeek();
    renderStandList();
    if (map) renderMapLayers();
    renderLiveStatus();
  }

  function renderDayPicker() {
    $('dayPicker').innerHTML = model.days.map((d, i) => {
      const s = d.summary ? d.summary.score : null;
      return `<button data-day="${i}" class="${i === selectedDay ? 'active' : ''}">
        <span>${fmtDayShort(d.info.date, i)}</span>
        <span class="chip ${s != null ? scoreClass(s) : ''}">${s != null ? s : '–'}</span></button>`;
    }).join('');
  }

  function renderToday() {
    const day = model.days[selectedDay];
    const info = day.info;
    const sum = day.summary;
    const dayHours = day.idx.map((i) => model.hours[i]);

    // Score
    const ring = $('scoreRing');
    if (sum) {
      $('scoreValue').textContent = sum.score;
      ring.className = `score-ring ${scoreClass(sum.score)}`;
      ring.style.setProperty('--pct', sum.score);
      $('scoreLabel').textContent = `${Movement.label(sum.score)} · ${fmtDay(info.date, selectedDay)}`;
      $('scoreReasons').innerHTML = sum.reasons.slice(0, 5).map((r) => `<li class="${r.good ? 'good' : 'bad'}">${esc(r.text)}</li>`).join('') || '<li>Typical conditions</li>';
      $('bestWindows').innerHTML = sum.windows.length
        ? sum.windows.map((w) => `<div class="window"><span class="chip ${scoreClass(w.peak)}">${w.peak}</span> <strong>${fmtTime(w.start)} – ${fmtTime(w.end)}</strong></div>`).join('')
        : '<p class="muted">No standout windows — dawn and dusk are your best bet.</p>';
    } else {
      $('scoreValue').textContent = '--';
      ring.className = 'score-ring';
      $('scoreLabel').textContent = hasLoc() ? 'Waiting for weather…' : 'Set your property location to begin';
      $('scoreReasons').innerHTML = hasLoc() ? '' : '<li><button class="btn small-btn" id="quickLocate">Use my location</button></li>';
      const q = $('quickLocate');
      if (q) q.onclick = useGps;
      $('bestWindows').innerHTML = '<p class="muted">—</p>';
    }

    // Sun
    const dl = info.dayLength ? `${Math.floor(info.dayLength / HOUR)}h ${Math.round((info.dayLength % HOUR) / 60000)}m` : '—';
    $('sunInfo').innerHTML = kv([
      ['Legal light', fmtTime(info.legalStart)],
      ['Sunrise', fmtTime(info.sunrise)],
      ['Solar noon', fmtTime(info.solarNoon)],
      ['Sunset', fmtTime(info.sunset)],
      ['Legal end', fmtTime(info.legalEnd)],
      ['Daylight', dl],
    ]);

    // Moon
    const m = info.moon;
    Astro.drawMoon($('moonCanvas'), m.phase);
    $('moonPhaseName').textContent = m.name;
    $('moonIllum').textContent = `${Math.round(m.fraction * 100)}% illuminated · ${m.waxing ? 'waxing' : 'waning'}`;
    $('moonInfo').innerHTML = kv([
      ['Moonrise', fmtTime(m.rise)], ['Moonset', fmtTime(m.set)],
      ['Overhead', fmtTime(m.overhead)], ['Underfoot', fmtTime(m.underfoot)],
    ]);

    // Weather now / day summary
    if (dayHours.length) {
      const temps = dayHours.map((h) => h.temp);
      const precip = dayHours.reduce((s, h) => s + (h.precip || 0), 0);
      const maxProb = Math.max(...dayHours.map((h) => h.precipProb || 0));
      const c = selectedDay === 0 ? liveConditions() : null;
      const am = avgWind(hoursBetween(info.sunrise.getTime() - HOUR, info.sunrise.getTime() + 3 * HOUR));
      const pm = avgWind(hoursBetween(info.sunset.getTime() - 3 * HOUR, info.sunset.getTime() + HOUR));
      const wx = WMO[c ? c.code : mode(dayHours.map((h) => h.code))] || ['', ''];
      $('wxNow').innerHTML = `
        <div class="wx-main">
          <span class="wx-icon">${wx[1]}</span>
          <div>
            <div class="wx-temp">${c ? fmtTemp(c.temp) : `${fmtTemp(Math.max(...temps))} / ${fmtTemp(Math.min(...temps))}`}</div>
            <div class="muted small">${esc(wx[0])}${c ? ` · feels ${fmtTemp(c.feels)} · H ${fmtTemp(Math.max(...temps))} L ${fmtTemp(Math.min(...temps))}` : ''}</div>
          </div>
          ${c ? `<div class="wx-wind">${arrowSvg(c.dir, 28)}<div><strong>${dirName(c.dir)} ${fmtWind(c.wind)}</strong><div class="muted small">gusts ${fmtWind(c.gust)}</div><div class="muted small">as of ${fmtTime(c.time)}</div></div></div>` : ''}
        </div>
        <div class="wx-sits">
          ${am ? `<div><span class="muted small">Morning sit</span><br>${arrowSvg(am.dir)} <strong>${dirName(am.dir)} ${fmtWind(am.speed)}</strong></div>` : ''}
          ${pm ? `<div><span class="muted small">Evening sit</span><br>${arrowSvg(pm.dir)} <strong>${dirName(pm.dir)} ${fmtWind(pm.speed)}</strong></div>` : ''}
          <div><span class="muted small">Precip</span><br><strong>${maxProb}%</strong> <span class="muted small">${precip > 0 ? fmtPrecip(precip) : ''}</span></div>
          <div><span class="muted small">Humidity</span><br><strong>${c ? c.rh : Math.round(avg(dayHours.map((h) => h.rh)))}%</strong></div>
        </div>`;

      // Hourly strip for legal light ±1h
      const from = info.legalStart.getTime() - HOUR, to = info.legalEnd.getTime() + HOUR;
      const strip = day.idx.filter((i) => model.hours[i].time >= from && model.hours[i].time <= to);
      $('hourly').innerHTML = strip.map((i) => {
        const h = model.hours[i], s = model.scores[i];
        const isNow = selectedDay === 0 && Math.abs(h.time - Date.now()) < HOUR / 2;
        return `<div class="hour ${isNow ? 'now' : ''}">
          <div class="muted small">${fmtHour(h.time)}</div>
          <div class="h-icon">${(WMO[h.code] || ['', ''])[1]}</div>
          <div>${fmtTemp(h.temp)}</div>
          <div class="h-wind">${arrowSvg(h.dir, 14)}<span>${dirName(h.dir)}</span></div>
          <div class="small">${Math.round(metric() ? h.wind * 1.609 : h.wind)}</div>
          <div class="small muted">${h.precipProb != null ? h.precipProb + '%' : ''}</div>
          <div class="h-bar"><span class="${scoreClass(s)}" style="height:${s}%"></span></div>
        </div>`;
      }).join('');
    } else {
      $('wxNow').innerHTML = '<p class="muted">No weather data yet.</p>';
      $('hourly').innerHTML = '';
    }

    renderPressure(info);
    renderStandPicks(info);
    renderSolunar(info);
    renderThermals(info);
  }

  function kv(rows) {
    return rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }
  function avg(a) { const b = a.filter((v) => v != null); return b.length ? b.reduce((s, v) => s + v, 0) / b.length : 0; }
  function mode(a) { const c = {}; let best = a[0], n = 0; for (const v of a) { c[v] = (c[v] || 0) + 1; if (c[v] > n) { n = c[v]; best = v; } } return best; }
  function hoursBetween(from, to) { return model.hours.filter((h) => h.time >= from && h.time <= to); }

  function renderPressure(info) {
    const canvas = $('pressureChart');
    const from = info.date.getTime() - 24 * HOUR, to = info.date.getTime() + 48 * HOUR;
    const pts = model.hours.filter((h) => h.time >= from && h.time <= to && h.pressure != null);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300, hgt = 140;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (pts.length < 2) { $('pressureNote').textContent = ''; return; }
    const conv = (p) => (metric() ? p : p * 0.02953);
    const vals = pts.map((p) => conv(p.pressure));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = metric() ? 2 : 0.06;
    lo -= pad; hi += pad;
    const L = 44, R = 8, T = 8, B = 20;
    const x = (t) => L + ((t - from) / (to - from)) * (w - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (hgt - T - B);
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--line').trim(), fg = css.getPropertyValue('--muted').trim(), accent = css.getPropertyValue('--accent').trim();

    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = fg; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3;
      const yy = y(v);
      ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(w - R, yy); ctx.stroke();
      ctx.fillText(metric() ? v.toFixed(0) : v.toFixed(2), 2, yy + 4);
    }
    // Day boundaries & labels
    for (let k = 0; k <= 3; k++) {
      const t = from + k * 24 * HOUR;
      const xx = x(t);
      ctx.beginPath(); ctx.moveTo(xx, T); ctx.lineTo(xx, hgt - B); ctx.stroke();
      if (k < 3) ctx.fillText(new Date(t + 12 * HOUR).toLocaleDateString([], { weekday: 'short' }), xx + 4, hgt - 5);
    }
    // Selected day shading
    ctx.fillStyle = 'rgba(160, 190, 120, 0.12)';
    ctx.fillRect(x(info.date.getTime()), T, x(info.date.getTime() + 24 * HOUR) - x(info.date.getTime()), hgt - T - B);
    // Line
    ctx.strokeStyle = accent; ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, k) => { const xx = x(p.time.getTime()), yy = y(conv(p.pressure)); k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
    ctx.stroke();
    // Now marker
    const now = Date.now();
    if (now > from && now < to) {
      ctx.strokeStyle = '#e8a33d'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x(now), T); ctx.lineTo(x(now), hgt - B); ctx.stroke();
      ctx.setLineDash([]);
    }
    // Note: trend across the selected day's legal light
    const a = pts.find((p) => p.time >= info.legalStart), b = [...pts].reverse().find((p) => p.time <= info.legalEnd);
    if (a && b) {
      const d = b.pressure - a.pressure;
      const txt = d > 2 ? 'Rising through the day — often good movement behind a front.'
        : d < -2 ? 'Falling through the day — deer often feed ahead of incoming weather.'
          : 'Fairly steady pressure.';
      $('pressureNote').textContent = `${fmtPress(a.pressure)} → ${fmtPress(b.pressure)}. ${txt}`;
    }
  }

  function renderStandPicks(info) {
    const el = $('standPicks');
    if (!store.stands.length) { el.innerHTML = '<p class="muted">Add your stands on the Map tab to see which ones the wind favors.</p>'; return; }
    if (!model.hours.length) { el.innerHTML = '<p class="muted">Waiting for wind forecast…</p>'; return; }
    const am = avgWind(hoursBetween(info.sunrise.getTime() - HOUR, info.sunrise.getTime() + 3 * HOUR));
    const pm = avgWind(hoursBetween(info.sunset.getTime() - 3 * HOUR, info.sunset.getTime() + HOUR));
    const rank = { 'r-good': 0, 'r-marg': 1, 'r-unk': 2, 'r-bad': 3 };
    const live = selectedDay === 0 ? liveConditions() : null;
    const rows = store.stands.map((s) => ({
      s, n: live ? windRating(s, live.dir, live.wind) : null,
      a: am ? windRating(s, am.dir, am.speed) : null, p: pm ? windRating(s, pm.dir, pm.speed) : null,
    }));
    const r = (x) => rank[x?.cls] ?? 4;
    rows.sort((r1, r2) => (live ? r(r1.n) - r(r2.n) : 0) || r(r1.a) + r(r1.p) - r(r2.a) - r(r2.p));
    const cell = (x) => `<td>${x ? `<span class="pill ${x.cls}">${x.text}</span>` : '—'}</td>`;
    el.innerHTML = `<table class="picks"><thead><tr><th>Stand</th>${live ? `<th>Right now<br><span class="muted small">${dirName(live.dir)} ${fmtWind(live.wind)}</span></th>` : ''}<th>Morning${am ? `<br><span class="muted small">${dirName(am.dir)} ${fmtWind(am.speed)}</span>` : ''}</th><th>Evening${pm ? `<br><span class="muted small">${dirName(pm.dir)} ${fmtWind(pm.speed)}</span>` : ''}</th></tr></thead><tbody>`
      + rows.map(({ s, n, a, p }) => `<tr><td><strong>${esc(s.name)}</strong><br><span class="muted small">${s.goodWinds.length ? s.goodWinds.join(', ') : 'no winds set'}</span></td>
        ${live ? cell(n) : ''}${cell(a)}${cell(p)}</tr>`).join('')
      + '</tbody></table>';
  }

  function renderSolunar(info) {
    const periods = info.solunar;
    if (!periods.length) { $('solunar').innerHTML = '<p class="muted">No solunar periods today.</p>'; return; }
    const near = (t) => Math.abs(t - info.sunrise) < 1.5 * HOUR || Math.abs(t - info.sunset) < 1.5 * HOUR;
    const inLight = (p) => p.end >= info.legalStart && p.start <= info.legalEnd;
    $('solunar').innerHTML = periods.map((p) => `
      <div class="sol ${p.kind} ${inLight(p) ? '' : 'dim'}">
        <span class="pill ${p.kind === 'major' ? 'r-good' : 'r-marg'}">${p.kind === 'major' ? 'Major' : 'Minor'}</span>
        <strong>${fmtTime(p.start)} – ${fmtTime(p.end)}</strong>
        <span class="muted small">${p.label}${near(p.center) ? ' · <b class="hot">lines up with ' + (p.center < info.solarNoon ? 'sunrise' : 'sunset') + '</b>' : ''}${inLight(p) ? '' : ' · outside shooting hours'}</span>
      </div>`).join('');
  }

  function renderThermals(info) {
    const morningSwitch = new Date(info.sunrise.getTime() + 2 * HOUR);
    const eveningSwitch = new Date(info.sunset.getTime() - 1.5 * HOUR);
    const dayHours = model.days[selectedDay].idx.map((i) => model.hours[i]);
    const maxWind = dayHours.length ? Math.max(...dayHours.map((h) => h.wind || 0)) : null;
    const rh = dayHours.length ? avg(dayHours.map((h) => h.rh)) : null;
    const tips = [
      `<li><strong>Until ~${fmtTime(morningSwitch)}:</strong> cool air sinks — thermals pull scent <em>downhill</em> and into creek bottoms. Favor stands above where deer travel.</li>`,
      `<li><strong>Midday:</strong> warming air rises — scent drifts <em>uphill</em>.</li>`,
      `<li><strong>From ~${fmtTime(eveningSwitch)}:</strong> air cools and thermals fall again; scent will start sliding downhill before dark.</li>`,
    ];
    if (maxWind != null && maxWind < 5) tips.push('<li>Light wind day: thermals will dominate and wind may swirl. Play the terrain.</li>');
    if (maxWind != null && maxWind > 15) tips.push('<li>Strong wind will override thermals; deer bed on leeward sides and in thick cover.</li>');
    if (rh != null && rh > 75) tips.push('<li>High humidity carries scent farther — be extra careful with wind.</li>');
    $('thermals').innerHTML = `<ul class="tips">${tips.join('')}</ul>`;
  }

  // ---------- Week ----------
  function renderWeek() {
    $('weekList').innerHTML = model.days.map((d, i) => {
      const s = d.summary;
      const hrs = d.idx.map((j) => model.hours[j]);
      const temps = hrs.map((h) => h.temp);
      const am = model.hours.length ? avgWind(hoursBetween(d.info.sunrise.getTime() - HOUR, d.info.sunrise.getTime() + 3 * HOUR)) : null;
      const pm = model.hours.length ? avgWind(hoursBetween(d.info.sunset.getTime() - 3 * HOUR, d.info.sunset.getTime() + HOUR)) : null;
      const wx = hrs.length ? WMO[mode(hrs.map((h) => h.code))] || ['', ''] : ['', ''];
      const pp = hrs.length ? Math.max(...hrs.map((h) => h.precipProb || 0)) : null;
      const best = s && s.windows[0];
      return `<button class="week-row" data-day="${i}">
        <div class="wk-day"><strong>${fmtDay(d.info.date, i)}</strong><span class="muted small">${d.info.date.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></div>
        <div class="wk-score"><span class="chip big ${s ? scoreClass(s.score) : ''}">${s ? s.score : '–'}</span></div>
        <div class="wk-wx">${wx[1]} ${temps.length ? `${fmtTemp(Math.max(...temps))}/${fmtTemp(Math.min(...temps))}` : ''}${pp != null ? ` <span class="muted small">${pp}%</span>` : ''}
          <div class="small">${am ? `AM ${arrowSvg(am.dir, 12)} ${dirName(am.dir)} ${Math.round(am.speed)}` : ''} ${pm ? `· PM ${arrowSvg(pm.dir, 12)} ${dirName(pm.dir)} ${Math.round(pm.speed)}` : ''}</div>
          <div class="muted small">☀ ${fmtTime(d.info.sunrise)} – ${fmtTime(d.info.sunset)} · ${d.info.moon.name}</div>
          ${best ? `<div class="small">Best: ${fmtTime(best.start)} – ${fmtTime(best.end)}</div>` : ''}
        </div></button>`;
    }).join('');
  }

  // ---------- Stands list ----------
  function renderStandList() {
    const el = $('standList');
    if (!store.stands.length) { el.innerHTML = '<p class="muted">No stands yet.</p>'; return; }
    const cur = currentMapWind();
    el.innerHTML = store.stands.map((s) => {
      const r = cur ? windRating(s, cur.dir, cur.wind) : null;
      return `<div class="stand-row">
        <div><strong>${esc(s.name)}</strong> <span class="muted small">${esc(s.type || '')}</span><br>
        <span class="muted small">Good winds: ${s.goodWinds.length ? s.goodWinds.join(', ') : 'not set'}</span>
        ${s.notes ? `<br><span class="small">${esc(s.notes)}</span>` : ''}</div>
        <div class="stand-actions">${r ? `<span class="pill ${r.cls}">${r.text}</span>` : ''}
          <button class="btn ghost small-btn" data-edit="${s.id}">Edit</button>
          <button class="btn ghost small-btn" data-goto="${s.id}">Map</button></div>
      </div>`;
    }).join('');
  }

  // ---------- Map ----------
  // Slider slot 0 is live conditions; the rest are upcoming forecast hours.
  function mapHours() {
    if (!model) return [];
    const now = Date.now();
    const future = model.hours.filter((h) => h.time.getTime() > now);
    const live = liveConditions();
    return live ? [live, ...future] : future;
  }
  function liveConditions() {
    if (!model || !model.current) return null;
    const c = model.current;
    if (Date.now() - c.time > 3 * HOUR) return null; // cached and too old to call "now"
    return { ...c, live: true };
  }
  function scoreAt(t) {
    const i = model.hours.findIndex((h) => t >= h.time && t < h.time.getTime() + HOUR);
    return i >= 0 ? model.scores[i] : null;
  }
  function currentMapWind() {
    const hs = mapHours();
    return hs[Math.min(mapHour, hs.length - 1)] || null;
  }

  function initMap() {
    if (map) { map.invalidateSize(); return; }
    const center = hasLoc() ? [store.settings.lat, store.settings.lon] : [39.5, -95];
    map = L.map('map', { zoomControl: false, attributionControl: true }).setView(center, hasLoc() ? 16 : 4);
    L.control.zoom({ position: 'topright' }).addTo(map);
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Imagery © Esri',
    });
    const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, © OpenTopoMap' });
    const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
    sat.addTo(map);
    L.control.layers({ Satellite: sat, Topo: topo, Streets: streets }, { Labels: labels }, { position: 'topright' }).addTo(map);
    coneLayer = L.layerGroup().addTo(map);
    standLayer = L.layerGroup().addTo(map);
    windControl.addTo(map);

    map.on('click', (e) => {
      if (!addingStand) return;
      addingStand = false;
      $('mapHint').classList.add('hidden');
      $('addStandBtn').textContent = '+ Add stand';
      pendingLatLng = e.latlng;
      openStandDialog(null);
    });
    setupSlider();
    renderMapLayers();
  }

  const windControl = L.control({ position: 'topleft' });
  windControl.onAdd = function () {
    const div = L.DomUtil.create('div', 'wind-control');
    div.id = 'windControl';
    return div;
  };

  function setupSlider() {
    const hs = mapHours();
    const slider = $('hourSlider');
    slider.max = Math.max(0, hs.length - 1);
    slider.value = Math.min(mapHour, slider.max);
  }

  function destPoint(lat, lon, bearing, meters) {
    const b = (bearing * Math.PI) / 180;
    const dLat = (meters * Math.cos(b)) / 111320;
    const dLon = (meters * Math.sin(b)) / (111320 * Math.cos((lat * Math.PI) / 180));
    return [lat + dLat, lon + dLon];
  }

  function renderMapLayers() {
    if (!map) return;
    setupSlider();
    const h = currentMapWind();
    const wc = $('windControl');
    if (wc) {
      wc.innerHTML = h
        ? `<div class="wc-compass">${arrowSvg(h.dir, 34)}</div><div><strong>${dirName(h.dir)} ${fmtWind(h.wind)}</strong><br><span class="small">gust ${fmtWind(h.gust)} · ${fmtTemp(h.temp)}</span></div>`
        : '<span class="small">No wind data</span>';
    }
    const sc = h ? (h.live ? scoreAt(Date.now()) : scoreAt(h.time)) : null;
    $('hourLabel').textContent = h
      ? `${h.live ? `Now · as of ${fmtTime(h.time)}` : `${h.time.toLocaleDateString([], { weekday: 'short' })} ${fmtHour(h.time)}`} · score ${sc ?? '–'}`
      : 'No forecast';

    standLayer.clearLayers();
    coneLayer.clearLayers();
    for (const s of store.stands) {
      const r = h ? windRating(s, h.dir, h.wind) : { cls: 'r-unk', text: '' };
      if (h) {
        // Scent cone downwind of the stand.
        const len = Math.min(500, 120 + (h.wind || 0) * 25);
        const half = h.wind < 4 ? 50 : h.wind < 8 ? 32 : 22;
        const down = h.dir + 180;
        const pts = [[s.lat, s.lon]];
        for (let a = -half; a <= half; a += half / 6) pts.push(destPoint(s.lat, s.lon, down + a, len));
        const color = r.cls === 'r-good' ? '#6fcf5a' : r.cls === 'r-marg' ? '#e8c43d' : r.cls === 'r-bad' ? '#e5533d' : '#aaaaaa';
        L.polygon(pts, { color, weight: 1, fillColor: color, fillOpacity: 0.22, interactive: false }).addTo(coneLayer);
      }
      const icon = L.divIcon({
        className: 'stand-icon',
        html: `<div class="stand-dot ${r.cls}"></div><div class="stand-label">${esc(s.name)}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11],
      });
      const mk = L.marker([s.lat, s.lon], { icon, draggable: true }).addTo(standLayer);
      mk.bindPopup(`<strong>${esc(s.name)}</strong><br>${r.text}<br><span class="small">Good: ${s.goodWinds.join(', ') || 'not set'}</span><br><button class="btn small-btn" data-edit="${s.id}">Edit</button>`);
      mk.on('dragend', () => {
        const ll = mk.getLatLng();
        s.lat = ll.lat; s.lon = ll.lng; save(); renderMapLayers();
      });
    }
  }

  // ---------- Stand dialog ----------
  function buildWindPick() {
    // 3x3 compass grid.
    const layout = ['NW', 'N', 'NE', 'W', '', 'E', 'SW', 'S', 'SE'];
    $('windPick').innerHTML = layout.map((d) => (d ? `<button type="button" data-dir="${d}">${d}</button>` : '<span class="cp-center">🦌</span>')).join('');
    $('windPick').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-dir]');
      if (b) b.classList.toggle('on');
    });
  }

  function openStandDialog(id) {
    editingId = id;
    const s = id ? store.stands.find((x) => x.id === id) : null;
    $('standDialogTitle').textContent = s ? 'Edit stand' : 'New stand';
    $('standName').value = s ? s.name : `Stand ${store.stands.length + 1}`;
    $('standType').value = s ? s.type || 'Ladder' : 'Ladder';
    $('standNotes').value = s ? s.notes || '' : '';
    const good = s ? s.goodWinds : [];
    $('windPick').querySelectorAll('button[data-dir]').forEach((b) => b.classList.toggle('on', good.includes(b.dataset.dir)));
    $('standDelete').classList.toggle('hidden', !s);
    $('standDialog').showModal();
  }

  function saveStand() {
    const goodWinds = [...$('windPick').querySelectorAll('button.on')].map((b) => b.dataset.dir);
    goodWinds.sort((a, b) => DIRS8.indexOf(a) - DIRS8.indexOf(b));
    const data = { name: $('standName').value.trim() || 'Stand', type: $('standType').value, notes: $('standNotes').value.trim(), goodWinds };
    if (editingId) {
      Object.assign(store.stands.find((x) => x.id === editingId), data);
    } else if (pendingLatLng) {
      store.stands.push({ id: Date.now().toString(36), lat: pendingLatLng.lat, lon: pendingLatLng.lng, ...data });
      if (!hasLoc()) { store.settings.lat = pendingLatLng.lat; store.settings.lon = pendingLatLng.lng; fetchForecast(true); }
    }
    pendingLatLng = null;
    save();
    render();
  }

  // ---------- Navigation ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.body.classList.toggle('map-mode', name === 'map');
    if (name === 'map') setTimeout(initMap, 0);
    window.scrollTo(0, 0);
  }

  // ---------- Settings ----------
  function fillSettings() {
    const s = store.settings;
    $('setLat').value = s.lat != null ? s.lat.toFixed(5) : '';
    $('setLon').value = s.lon != null ? s.lon.toFixed(5) : '';
    $('setLegalBefore').value = s.legalBefore;
    $('setLegalAfter').value = s.legalAfter;
    $('setRut').value = s.rutPeak || '';
    $('setUnits').value = s.units;
  }

  function useGps() {
    if (!navigator.geolocation) { showBanner('Location is not available on this device.', 'warn'); return; }
    showBanner('Getting your location…');
    navigator.geolocation.getCurrentPosition((pos) => {
      store.settings.lat = pos.coords.latitude;
      store.settings.lon = pos.coords.longitude;
      save(); fillSettings(); showBanner(null);
      if (map) map.setView([store.settings.lat, store.settings.lon], 16);
      buildModel(); render(); fetchForecast(true);
    }, (err) => showBanner(`Couldn't get location: ${err.message}. Enter it under Stands → Settings.`, 'warn'), { enableHighAccuracy: true, timeout: 15000 });
  }

  // ---------- Events ----------
  function bind() {
    document.querySelector('.tabbar').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (b) showView(b.dataset.view);
    });
    $('dayPicker').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-day]');
      if (b) { selectedDay = Number(b.dataset.day); renderDayPicker(); renderToday(); }
    });
    $('weekList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-day]');
      if (b) { selectedDay = Number(b.dataset.day); renderDayPicker(); renderToday(); showView('today'); }
    });
    $('refreshBtn').addEventListener('click', () => fetchForecast(true));
    $('hourSlider').addEventListener('input', (e) => { mapHour = Number(e.target.value); renderMapLayers(); renderStandList(); });
    $('addStandBtn').addEventListener('click', () => {
      addingStand = !addingStand;
      $('mapHint').classList.toggle('hidden', !addingStand);
      $('addStandBtn').textContent = addingStand ? 'Cancel' : '+ Add stand';
    });
    $('locateBtn').addEventListener('click', () => {
      if (!navigator.geolocation || !map) return;
      navigator.geolocation.getCurrentPosition((pos) => {
        const ll = [pos.coords.latitude, pos.coords.longitude];
        map.setView(ll, 17);
        L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#3d8bfd', fillOpacity: 1 }).addTo(map);
      }, (err) => showBanner(`Couldn't get location: ${err.message}`, 'warn'), { enableHighAccuracy: true, timeout: 15000 });
    });

    // Edit buttons in popups and lists.
    document.addEventListener('click', (e) => {
      const ed = e.target.closest('[data-edit]');
      if (ed) { if (map) map.closePopup(); openStandDialog(ed.dataset.edit); return; }
      const go = e.target.closest('[data-goto]');
      if (go) {
        const s = store.stands.find((x) => x.id === go.dataset.goto);
        showView('map');
        setTimeout(() => map && map.setView([s.lat, s.lon], 17), 50);
      }
    });

    $('standForm').addEventListener('submit', (e) => { e.preventDefault(); saveStand(); $('standDialog').close(); });
    $('standCancel').addEventListener('click', () => { pendingLatLng = null; $('standDialog').close(); });
    $('standDelete').addEventListener('click', () => {
      if (!editingId) return;
      const s = store.stands.find((x) => x.id === editingId);
      if (!confirm(`Delete ${s.name}?`)) return;
      store.stands = store.stands.filter((x) => x.id !== editingId);
      save(); $('standDialog').close(); render();
    });

    $('useGps').addEventListener('click', useGps);
    $('settingsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const lat = parseFloat($('setLat').value), lon = parseFloat($('setLon').value);
      const s = store.settings;
      const locChanged = lat !== s.lat || lon !== s.lon;
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { s.lat = lat; s.lon = lon; }
      s.legalBefore = Number($('setLegalBefore').value) || 0;
      s.legalAfter = Number($('setLegalAfter').value) || 0;
      s.rutPeak = $('setRut').value || null;
      s.units = $('setUnits').value;
      save();
      showBanner('Settings saved.');
      setTimeout(() => showBanner(null), 1500);
      buildModel(); render();
      if (locChanged) fetchForecast(true);
    });

    $('exportBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ app: 'hunt-smart', version: 1, ...store }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hunt-smart-stands.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('importFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!Array.isArray(data.stands)) throw new Error('No stands in file');
        const ids = new Set(store.stands.map((s) => s.id));
        const incoming = data.stands.filter((s) => typeof s.lat === 'number' && typeof s.lon === 'number').map((s) => ({
          id: String(s.id || Date.now().toString(36)), name: String(s.name || 'Stand').slice(0, 40), lat: s.lat, lon: s.lon,
          goodWinds: Array.isArray(s.goodWinds) ? s.goodWinds.filter((d) => DIRS8.includes(d)) : [],
          type: String(s.type || ''), notes: String(s.notes || '').slice(0, 300),
        }));
        const added = incoming.filter((s) => !ids.has(s.id));
        store.stands.push(...added);
        if (!hasLoc() && data.settings && typeof data.settings.lat === 'number') { store.settings.lat = data.settings.lat; store.settings.lon = data.settings.lon; }
        save(); fillSettings(); buildModel(); render(); fetchForecast();
        showBanner(`Imported ${added.length} stand(s).`);
        setTimeout(() => showBanner(null), 2000);
      } catch (err) {
        showBanner(`Import failed: ${err.message}`, 'warn');
      }
      e.target.value = '';
    });

    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      $('installBtn').classList.remove('hidden');
    });
    $('installBtn').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      $('installBtn').classList.add('hidden');
    });

    window.addEventListener('resize', () => { if (model) renderPressure(model.days[selectedDay].info); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { stopAutoRefresh(); return; }
      renderLiveStatus(); fetchForecast(); startAutoRefresh();
    });
    window.addEventListener('online', () => fetchForecast(true));
    window.addEventListener('offline', renderLiveStatus);
  }

  // ---------- Boot ----------
  function boot() {
    buildWindPick();
    bind();
    fillSettings();
    if (hasLoc()) {
      buildModel(); render(); fetchForecast();
    } else {
      $('scoreLabel').textContent = 'Set your property location to begin';
      $('scoreReasons').innerHTML = '<li><button class="btn small-btn" id="quickLocate">Use my location</button></li>'
        + '<li class="muted">Or add a stand on the Map tab.</li>';
      $('quickLocate').onclick = useGps;
      useGps();
    }
    startAutoRefresh();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
    }
  }

  boot();
})();

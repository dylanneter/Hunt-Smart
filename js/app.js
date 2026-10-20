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

  // ---------- State ----------
  const defaults = {
    settings: { lat: null, lon: null, placeName: null, legalBefore: 30, legalAfter: 30, rutPeak: defaultRut(), units: 'imperial' },
    stands: [],
  };
  let store = load();
  let forecast = null; // raw cached response
  let model = null; // computed hours/days
  let selectedDay = 0;
  let selectedHour = null; // hour of day shown in the Forecast hero
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
    if (!hasLoc()) { model = null; return; }
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

  // ---------- Rendering ----------
  const SCORE_COLORS = { 's-exc': '#2f9e44', 's-good': '#74b816', 's-fair': '#fab005', 's-slow': '#f08c00', 's-poor': '#c92a2a' };
  const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
  const fmtHourShort = (d) => d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/g, '').toLowerCase();
  const fmtClock = (d) => (d && !isNaN(d) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '') : '—');

  function wxIconName(code, time) {
    let night = false;
    if (time && model) {
      const d = model.getDay(time);
      night = time < d.sunrise || time > d.sunset;
    }
    if (code === 0 || code === 1) return night ? 'moon' : 'sun';
    if (code === 2) return night ? 'cloud' : 'cloud-sun';
    if (code === 45 || code === 48) return 'cloud-fog';
    if (code >= 95) return 'cloud-storm';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'cloud-snow';
    if (code >= 51) return 'cloud-rain';
    return 'cloud';
  }

  function render() {
    if (!model) return;
    renderDayPicker();
    renderToday();
    renderWeek();
    renderStandList();
    renderLocation();
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

  // Hour (0-23) shown in the hero for the selected day.
  function defaultHour() {
    if (selectedDay === 0) return new Date().getHours();
    const sr = model.days[selectedDay].info.sunrise;
    return sr && !isNaN(sr) ? sr.getHours() : 7;
  }

  function heroData() {
    const day = model.days[selectedDay];
    const i = day.idx.find((j) => model.hours[j].time.getHours() === selectedHour);
    const h = i != null ? model.hours[i] : null;
    const isNow = selectedDay === 0 && selectedHour === new Date().getHours();
    const live = isNow ? liveConditions() : null;
    return { h: live ? { ...h, ...live, precipProb: h ? h.precipProb : null } : h, score: i != null ? model.scores[i] : null, live: !!live };
  }

  function renderToday() {
    const day = model.days[selectedDay];
    const info = day.info;
    const sum = day.summary;
    if (selectedHour == null) selectedHour = defaultHour();

    renderHero(info);

    // Day outlook
    if (sum) {
      $('scoreLabel').textContent = `${Movement.label(sum.score)} day`;
      $('scoreSub').textContent = `${fmtDay(info.date, selectedDay)} · ${info.date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
      $('dayScoreChip').textContent = sum.score;
      $('dayScoreChip').className = `chip big ${scoreClass(sum.score)}`;
      $('scoreReasons').innerHTML = sum.reasons.slice(0, 5).map((r) => `<li class="${r.good ? 'good' : 'bad'}">${esc(r.text)}</li>`).join('') || '<li>Typical conditions</li>';
      $('bestWindows').innerHTML = sum.windows.length
        ? sum.windows.map((w) => `<div class="window">${icon('clock')}<strong>${fmtTime(w.start)} – ${fmtTime(w.end)}</strong><span class="chip ${scoreClass(w.peak)}">${w.peak}</span></div>`).join('')
        : '<p class="muted small">No standout windows. Dawn and dusk are your best bet.</p>';
    } else {
      $('scoreLabel').textContent = hasLoc() ? 'Waiting for weather…' : 'Set your property location';
      $('scoreSub').textContent = '';
      $('dayScoreChip').textContent = '--';
      $('dayScoreChip').className = 'chip big';
      $('scoreReasons').innerHTML = hasLoc() ? '' : '<li class="muted">Tap the location name above to search, or allow location access.</li>';
      $('bestWindows').innerHTML = '';
    }

    // Hourly strip for legal light ±1h
    if (day.idx.length) {
      const from = info.legalStart.getTime() - HOUR, to = info.legalEnd.getTime() + HOUR;
      const strip = day.idx.filter((i) => model.hours[i].time >= from && model.hours[i].time <= to);
      $('hourly').innerHTML = strip.map((i) => {
        const h = model.hours[i], s = model.scores[i];
        const isNow = selectedDay === 0 && h.time.getHours() === new Date().getHours();
        const sel = h.time.getHours() === selectedHour;
        return `<div class="hour ${isNow ? 'now' : ''} ${sel ? 'sel' : ''}" data-hour="${h.time.getHours()}">
          <div class="muted small">${fmtHourShort(h.time)}</div>
          ${icon(wxIconName(h.code, h.time))}
          <div>${fmtTemp(h.temp)}</div>
          <div class="h-wind">${arrowSvg(h.dir, 13)}<span>${dirName(h.dir)}</span></div>
          <div class="small">${Math.round(metric() ? h.wind * 1.609 : h.wind)}</div>
          <div class="small muted">${h.precipProb != null ? h.precipProb + '%' : ''}</div>
          <div class="h-bar"><span class="${scoreClass(s)}" style="height:${s}%"></span></div>
        </div>`;
      }).join('');
    } else {
      $('hourly').innerHTML = '<p class="empty">No weather data yet.</p>';
    }

    // Sun & moon
    const m = info.moon;
    Astro.drawMoon($('moonCanvas'), m.phase);
    $('moonPhaseName').textContent = m.name;
    $('moonIllum').textContent = `${Math.round(m.fraction * 100)}% illuminated · ${m.waxing ? 'waxing' : 'waning'}`;
    const dl = info.dayLength ? `${Math.floor(info.dayLength / HOUR)}h ${Math.round((info.dayLength % HOUR) / 60000)}m` : '—';
    const tile = (ic, k, v) => `<div class="tile-stat">${icon(ic)}<div><span>${k}</span><strong>${v}</strong></div></div>`;
    $('sunMoonGrid').innerHTML = [
      tile('sunrise', 'Legal light', fmtTime(info.legalStart)), tile('sunset', 'Legal end', fmtTime(info.legalEnd)),
      tile('sunrise', 'Sunrise', fmtTime(info.sunrise)), tile('sunset', 'Sunset', fmtTime(info.sunset)),
      tile('moon', 'Moonrise', fmtTime(m.rise)), tile('moon', 'Moonset', fmtTime(m.set)),
      tile('target', 'Moon overhead', fmtTime(m.overhead)), tile('target', 'Moon underfoot', fmtTime(m.underfoot)),
      tile('sun', 'Solar noon', fmtTime(info.solarNoon)), tile('clock', 'Daylight', dl),
    ].join('');

    renderPressure(info);
    renderStandPicks(info);
    renderSolunar(info);
    renderThermals(info);
  }

  function renderHero(info) {
    const { h, score, live } = heroData();
    const day = model.days[selectedDay];
    const cls = score != null ? scoreClass(score) : null;
    const color = cls ? SCORE_COLORS[cls] : 'var(--muted)';
    $('heroScore').textContent = score != null ? score : '--';
    document.querySelector('.hero-score').style.color = color;
    $('heroMeter').style.width = `${score || 0}%`;
    $('heroMeter').style.background = color;

    const at = new Date(info.date); at.setHours(selectedHour);
    $('heroWhen').textContent = `${fmtDay(info.date, selectedDay)} ${info.date.getMonth() + 1}/${info.date.getDate()} @ ${live ? 'now' : fmtHourShort(at)}`;
    $('hourPillText').textContent = live ? 'Now' : fmtHourShort(at);
    $('todayHour').value = selectedHour;

    $('heroWxIcon').innerHTML = `<use href="#i-${h ? wxIconName(h.code, at) : 'sun'}"/>`;
    $('heroTemp').textContent = h ? fmtTemp(h.temp) : '--';
    $('heroPrecip').textContent = h && h.precipProb != null ? `${h.precipProb}%` : '--';
    $('heroSunrise').textContent = fmtClock(info.sunrise);
    $('heroSunset').textContent = fmtClock(info.sunset);

    const w = h && h.wind != null ? h : null;
    $('heroWind').textContent = w ? Math.round(metric() ? w.wind * 1.609 : w.wind) : '--';
    $('heroWindUnit').textContent = metric() ? 'km/h' : 'mph';
    $('heroWindDir').textContent = w ? dirName(w.dir) : '--';
    document.querySelector('#heroDial .dial-needle').style.transform = `rotate(${w ? w.dir + 180 : 0}deg)`;
    setStreaks('miniStreaks', w ? w.dir : null, w ? w.wind : null);
    if (!day.idx.length) setStreaks('miniStreaks', null, null);
    renderMiniMap(w);
  }

  // Animated wind arrows drifting downwind over a map.
  function setStreaks(id, dir, speed) {
    const box = $(id);
    if (!box) return;
    if (dir == null || speed == null || store.settings.streaks === false) { box.innerHTML = ''; return; }
    let field = box.querySelector('.streak-field');
    if (!field) {
      field = document.createElement('div');
      field.className = 'streak-field';
      const path = '<svg viewBox="0 0 22 60"><path d="M11 58c-7-10 7-18 0-28S4 14 11 4M5 11l6-7 6 7"/></svg>';
      let html = '';
      for (let y = 0; y < 900; y += 110) {
        for (let x = 0; x < 900; x += 90) {
          const jx = x + Math.random() * 60, jy = y + Math.random() * 70;
          html += `<div class="streak" style="left:${jx}px;top:${jy}px;--delay:${(-Math.random() * 4).toFixed(2)}s">${path}</div>`;
        }
      }
      field.innerHTML = html;
      box.appendChild(field);
    }
    field.style.transform = `rotate(${dir + 180}deg)`;
    const dur = Math.max(1.2, Math.min(4.5, 4.5 - speed * 0.16));
    field.querySelectorAll('.streak').forEach((s) => s.style.setProperty('--dur', `${dur.toFixed(2)}s`));
  }

  let miniMap = null, miniLayers = null;
  function renderMiniMap(h) {
    if (!hasLoc()) return;
    const center = [store.settings.lat, store.settings.lon];
    if (!miniMap) {
      miniMap = L.map('miniMap', { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false, tap: false });
      miniMap.attributionControl.setPrefix(false);
      miniMap.attributionControl.setPosition('bottomleft');
      tileLayer('sat').addTo(miniMap);
      miniLayers = { cones: L.layerGroup().addTo(miniMap), stands: L.layerGroup().addTo(miniMap) };
    }
    const bounds = store.stands.length ? L.latLngBounds(store.stands.map((s) => [s.lat, s.lon])) : null;
    if (bounds && store.stands.length > 1) miniMap.fitBounds(bounds.pad(0.6), { maxZoom: 17 });
    else miniMap.setView(bounds ? bounds.getCenter() : center, 16);
    drawStands(miniLayers, h, false);
    setTimeout(() => miniMap.invalidateSize(), 0);
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
    if (pts.length < 2) { $('pressureNote').textContent = 'No pressure data yet.'; return; }
    const conv = (p) => (metric() ? p : p * 0.02953);
    const vals = pts.map((p) => conv(p.pressure));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = metric() ? 2 : 0.06;
    lo -= pad; hi += pad;
    const L0 = 44, R = 8, T = 8, B = 20;
    const x = (t) => L0 + ((t - from) / (to - from)) * (w - L0 - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (hgt - T - B);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--muted').trim(), accent = css.getPropertyValue('--accent').trim(), orange = css.getPropertyValue('--orange').trim();
    const grid = 'rgba(127,127,127,0.18)';

    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = fg; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3;
      const yy = y(v);
      ctx.beginPath(); ctx.moveTo(L0, yy); ctx.lineTo(w - R, yy); ctx.stroke();
      ctx.fillText(metric() ? v.toFixed(0) : v.toFixed(2), 2, yy + 4);
    }
    for (let k = 0; k <= 3; k++) {
      const t = from + k * 24 * HOUR;
      if (k < 3) ctx.fillText(new Date(t + 12 * HOUR).toLocaleDateString([], { weekday: 'short' }), x(t) + 4, hgt - 5);
    }
    ctx.fillStyle = 'rgba(165, 200, 107, 0.10)';
    ctx.fillRect(x(info.date.getTime()), T, x(info.date.getTime() + 24 * HOUR) - x(info.date.getTime()), hgt - T - B);
    // Line with soft fill
    ctx.beginPath();
    pts.forEach((p, k) => { const xx = x(p.time.getTime()), yy = y(conv(p.pressure)); k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
    ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
    const now = Date.now();
    if (now > from && now < to) {
      ctx.strokeStyle = orange; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x(now), T); ctx.lineTo(x(now), hgt - B); ctx.stroke();
      ctx.setLineDash([]);
    }
    const a = pts.find((p) => p.time >= info.legalStart), b = [...pts].reverse().find((p) => p.time <= info.legalEnd);
    if (a && b) {
      const d = b.pressure - a.pressure;
      const txt = d > 2 ? 'Rising through the day. Often good movement behind a front.'
        : d < -2 ? 'Falling through the day. Deer often feed ahead of incoming weather.'
          : 'Fairly steady pressure.';
      $('pressureNote').textContent = `${fmtPress(a.pressure)} → ${fmtPress(b.pressure)}. ${txt}`;
    }
  }

  function renderStandPicks(info) {
    const el = $('standPicks');
    if (!store.stands.length) { el.innerHTML = '<p class="empty">Add your stands on the Map tab to see which ones the wind favors.</p>'; return; }
    if (!model.hours.length) { el.innerHTML = '<p class="empty">Waiting for wind forecast…</p>'; return; }
    const am = avgWind(hoursBetween(info.sunrise.getTime() - HOUR, info.sunrise.getTime() + 3 * HOUR));
    const pm = avgWind(hoursBetween(info.sunset.getTime() - 3 * HOUR, info.sunset.getTime() + HOUR));
    const live = selectedDay === 0 ? liveConditions() : null;
    const rank = { 'r-good': 0, 'r-marg': 1, 'r-unk': 2, 'r-bad': 3 };
    const rows = store.stands.map((s) => ({
      s, n: live ? windRating(s, live.dir, live.wind) : null,
      a: am ? windRating(s, am.dir, am.speed) : null, p: pm ? windRating(s, pm.dir, pm.speed) : null,
    }));
    const r = (x) => rank[x?.cls] ?? 4;
    rows.sort((r1, r2) => (live ? r(r1.n) - r(r2.n) : 0) || r(r1.a) + r(r1.p) - r(r2.a) - r(r2.p));
    const cell = (x) => `<div>${x ? `<span class="pill ${x.cls}">${x.text.replace(' wind', '')}</span>` : '—'}</div>`;
    const head = (k, w) => `<div>${k}${w ? `<small>${dirName(w.dir)} ${Math.round(metric() ? w.speed * 1.609 : w.speed)}</small>` : ''}</div>`;
    const cols = live ? 3 : 2;
    el.innerHTML = `<div class="pick-head" style="--cols:${cols}"><div style="text-align:left">Stand</div>${live ? head('Now', { dir: live.dir, speed: live.wind }) : ''}${head('Morning', am)}${head('Evening', pm)}</div>`
      + rows.map(({ s, n, a, p }) => {
        const best = live ? n : a;
        return `<div class="pick-row" style="--cols:${cols}" data-edit="${s.id}">
          <div class="pick-name"><span class="tile ${best ? best.cls : 'r-unk'}">${icon('ladder')}</span>
            <div><strong>${esc(s.name)}</strong><span>${s.goodWinds.length ? s.goodWinds.join(', ') : 'no winds set'}</span></div></div>
          ${live ? cell(n) : ''}${cell(a)}${cell(p)}</div>`;
      }).join('');
  }

  function renderSolunar(info) {
    const periods = info.solunar;
    if (!periods.length) { $('solunar').innerHTML = '<p class="empty">No solunar periods today.</p>'; return; }
    const near = (t) => Math.abs(t - info.sunrise) < 1.5 * HOUR || Math.abs(t - info.sunset) < 1.5 * HOUR;
    const inLight = (p) => p.end >= info.legalStart && p.start <= info.legalEnd;
    $('solunar').innerHTML = periods.map((p) => `
      <div class="list-row static ${inLight(p) ? '' : 'dim'}">
        <span class="tile ${p.kind === 'major' ? 'accent' : ''}">${icon('leaf')}</span>
        <span class="row-text"><strong>${fmtTime(p.start)} – ${fmtTime(p.end)}</strong>
          <span>${p.kind === 'major' ? 'Major' : 'Minor'} · ${p.label}${near(p.center) ? ` · <b class="hot">lines up with ${p.center < info.solarNoon ? 'sunrise' : 'sunset'}</b>` : ''}${inLight(p) ? '' : ' · outside shooting hours'}</span></span>
      </div>`).join('');
  }

  function renderThermals(info) {
    const morningSwitch = new Date(info.sunrise.getTime() + 2 * HOUR);
    const eveningSwitch = new Date(info.sunset.getTime() - 1.5 * HOUR);
    const dayHours = model.days[selectedDay].idx.map((i) => model.hours[i]);
    const maxWind = dayHours.length ? Math.max(...dayHours.map((h) => h.wind || 0)) : null;
    const rh = dayHours.length ? avg(dayHours.map((h) => h.rh)) : null;
    const row = (ic, title, text) => `<div class="list-row static"><span class="tile">${icon(ic)}</span><span class="row-text"><strong>${title}</strong><span>${text}</span></span></div>`;
    const rows = [
      row('sunrise', `Until ~${fmtTime(morningSwitch)}`, 'Cool air sinks. Scent pulls downhill into creek bottoms, so favor stands above deer travel.'),
      row('sun', 'Midday', 'Warming air rises and scent drifts uphill.'),
      row('sunset', `From ~${fmtTime(eveningSwitch)}`, 'Air cools and thermals fall again. Scent starts sliding downhill before dark.'),
    ];
    if (maxWind != null && maxWind < 5) rows.push(row('wind', 'Light wind day', 'Thermals will dominate and wind may swirl. Play the terrain.'));
    if (maxWind != null && maxWind > 15) rows.push(row('wind', 'Strong wind', 'Wind overrides thermals. Deer bed on leeward sides and in thick cover.'));
    if (rh != null && rh > 75) rows.push(row('drop', 'High humidity', 'Scent carries farther. Be extra careful with wind.'));
    $('thermals').innerHTML = rows.join('');
  }

  // ---------- Week ----------
  function renderWeek() {
    $('weekList').innerHTML = model.days.map((d, i) => {
      const s = d.summary;
      const hrs = d.idx.map((j) => model.hours[j]);
      const temps = hrs.map((h) => h.temp);
      const am = model.hours.length ? avgWind(hoursBetween(d.info.sunrise.getTime() - HOUR, d.info.sunrise.getTime() + 3 * HOUR)) : null;
      const pm = model.hours.length ? avgWind(hoursBetween(d.info.sunset.getTime() - 3 * HOUR, d.info.sunset.getTime() + HOUR)) : null;
      const code = hrs.length ? mode(hrs.filter((h) => h.time >= d.info.sunrise && h.time <= d.info.sunset).map((h) => h.code)) : null;
      const pp = hrs.length ? Math.max(...hrs.map((h) => h.precipProb || 0)) : null;
      const best = s && s.windows[0];
      const wind = (label, w) => (w ? `<span>${label} ${arrowSvg(w.dir, 12)} <b>${dirName(w.dir)} ${Math.round(metric() ? w.speed * 1.609 : w.speed)}</b></span>` : '');
      return `<button class="week-row" data-day="${i}">
        <div class="wk-top">${icon(code != null ? wxIconName(code) : 'sun')}
          <div class="wk-day"><strong>${fmtDay(d.info.date, i)}</strong><span>${d.info.date.toLocaleDateString([], { month: 'short', day: 'numeric' })}${temps.length ? ` · ${fmtTemp(Math.max(...temps))} / ${fmtTemp(Math.min(...temps))}` : ''}${pp != null ? ` · ${pp}% rain` : ''}</span></div>
        </div>
        <span class="chip big ${s ? scoreClass(s.score) : ''}">${s ? s.score : '–'}</span>
        <div class="wk-meta">${wind('AM', am)}${wind('PM', pm)}
          ${best ? `<span>${icon('clock')} <b>${fmtTime(best.start)} – ${fmtTime(best.end)}</b></span>` : ''}
          <span>${icon('moon')} ${d.info.moon.name}</span></div>
      </button>`;
    }).join('');
  }

  // ---------- Stands list ----------
  function renderStandList() {
    const el = $('standList');
    if (!store.stands.length) { el.innerHTML = ''; return; }
    const cur = currentMapWind();
    el.innerHTML = store.stands.map((s) => {
      const r = cur ? windRating(s, cur.dir, cur.wind) : null;
      return `<div class="list-row" data-edit="${s.id}">
        <span class="tile ${r ? r.cls : 'r-unk'}">${icon('ladder')}</span>
        <span class="row-text"><strong>${esc(s.name)}</strong><span>${s.goodWinds.length ? `Good: ${s.goodWinds.join(', ')}` : 'No good winds set'}${s.type ? ` · ${esc(s.type)}` : ''}</span></span>
        <span class="row-end">${r ? `<span class="pill ${r.cls}">${r.text}</span>` : ''}
          <button class="icon-btn" data-goto="${s.id}" aria-label="Show on map">${icon('map')}</button></span>
      </div>`;
    }).join('');
  }

  // ---------- Map ----------
  const TILES = {
    sat: { name: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 19, attribution: 'Imagery © Esri' } },
    topo: { name: 'Topo', url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', opts: { maxZoom: 17, attribution: '© OpenStreetMap, © OpenTopoMap' } },
    streets: { name: 'Streets', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19, attribution: '© OpenStreetMap' } },
  };
  const LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
  const tileLayer = (key) => L.tileLayer(TILES[key].url, TILES[key].opts);
  let baseLayer = null, labelsLayer = null, placing = false;

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
    map.attributionControl.setPrefix(false);
    setBaseLayer(store.settings.mapBase || 'sat');
    setLabels(!!store.settings.mapLabels);
    coneLayer = L.layerGroup().addTo(map);
    standLayer = L.layerGroup().addTo(map);
    if (store.stands.length) map.fitBounds(L.latLngBounds(store.stands.map((s) => [s.lat, s.lon])).pad(0.5), { maxZoom: 17 });
    setupSlider();
    renderMapLayers();
  }

  function setBaseLayer(key) {
    if (!TILES[key]) key = 'sat';
    store.settings.mapBase = key; save();
    if (!map) return;
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = tileLayer(key).addTo(map);
    baseLayer.bringToBack();
  }
  function setLabels(on) {
    store.settings.mapLabels = on; save();
    if (!map) return;
    if (labelsLayer) { map.removeLayer(labelsLayer); labelsLayer = null; }
    if (on) labelsLayer = L.tileLayer(LABELS_URL, { maxZoom: 19 }).addTo(map);
  }

  function openLayers() {
    // Preview tiles near the property at zoom 14.
    const lat = store.settings.lat ?? 39.5, lon = store.settings.lon ?? -95, z = 14;
    const x = Math.floor(((lon + 180) / 360) * 2 ** z);
    const r = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
    $('layerGrid').innerHTML = Object.entries(TILES).map(([k, t]) => `
      <button type="button" class="layer-opt ${store.settings.mapBase === k || (!store.settings.mapBase && k === 'sat') ? 'on' : ''}" data-layer="${k}">
        <img alt="" loading="lazy" src="${t.url.replace('{z}', z).replace('{x}', x).replace('{y}', y)}"><span>${t.name}</span></button>`).join('');
    $('labelsToggle').checked = !!store.settings.mapLabels;
    $('streaksToggle').checked = store.settings.streaks !== false;
    $('layersDialog').showModal();
  }

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

  // Draw stand markers and downwind scent cones into a {stands, cones} pair of layer groups.
  function drawStands(layers, h, interactive) {
    layers.stands.clearLayers();
    layers.cones.clearLayers();
    for (const s of store.stands) {
      const r = h ? windRating(s, h.dir, h.wind) : { cls: 'r-unk', text: '' };
      if (h && h.wind != null) {
        const len = Math.min(500, 120 + h.wind * 25);
        const half = h.wind < 4 ? 50 : h.wind < 8 ? 32 : 22;
        const down = h.dir + 180;
        const pts = [[s.lat, s.lon]];
        for (let a = -half; a <= half; a += half / 6) pts.push(destPoint(s.lat, s.lon, down + a, len));
        const color = r.cls === 'r-good' ? '#6fcf5a' : r.cls === 'r-marg' ? '#e8c43d' : r.cls === 'r-bad' ? '#e5533d' : '#aaaaaa';
        L.polygon(pts, { color, weight: 1.5, fillColor: color, fillOpacity: 0.22, interactive: false }).addTo(layers.cones);
      }
      const icn = L.divIcon({
        className: 'stand-icon',
        html: `<div class="stand-dot ${r.cls}"></div><div class="stand-label">${esc(s.name)}</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12],
      });
      const mk = L.marker([s.lat, s.lon], { icon: icn, draggable: interactive, interactive }).addTo(layers.stands);
      if (interactive) {
        mk.bindPopup(`<strong>${esc(s.name)}</strong><br>${r.text}<br><span class="small">Good: ${s.goodWinds.join(', ') || 'not set'}</span><br><button class="btn" data-edit="${s.id}">Edit stand</button>`);
        mk.on('dragend', () => {
          const ll = mk.getLatLng();
          s.lat = ll.lat; s.lon = ll.lng; save(); renderMapLayers();
        });
      }
    }
  }

  function renderMapLayers() {
    if (!map) return;
    setupSlider();
    const h = currentMapWind();
    const sc = h ? (h.live ? scoreAt(Date.now()) : scoreAt(h.time)) : null;
    $('windControl').innerHTML = h
      ? `${arrowSvg(h.dir, 30)}<div><strong>${dirName(h.dir)} ${fmtWind(h.wind)}</strong><br><span>Gust ${fmtWind(h.gust)} · ${fmtTemp(h.temp)}${sc != null ? ` · Score ${sc}` : ''}</span></div>`
      : '';
    $('hourLabel').textContent = h ? (h.live ? 'Now' : `${h.time.toLocaleDateString([], { weekday: 'short' })} ${fmtHourShort(h.time)}`) : 'No forecast';
    setStreaks('mapStreaks', h ? h.dir : null, h ? h.wind : null);
    drawStands({ stands: standLayer, cones: coneLayer }, h, true);
  }

  function setPlacing(on) {
    placing = on;
    $('crosshair').classList.toggle('hidden', !on);
    $('placeBar').classList.toggle('hidden', !on);
    $('mapScrub').classList.toggle('hidden', on);
    $('addStandBtn').classList.toggle('on', on);
  }

  // ---------- Stand dialog ----------
  function buildWindPick() {
    // 3x3 compass grid.
    const layout = ['NW', 'N', 'NE', 'W', '', 'E', 'SW', 'S', 'SE'];
    $('windPick').innerHTML = layout.map((d) => (d ? `<button type="button" data-dir="${d}">${d}</button>` : `<span class="cp-center">${icon('deer')}</span>`)).join('');
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
      if (!hasLoc()) setLocation(pendingLatLng.lat, pendingLatLng.lng, null, { keepMap: true });
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
    else if (placing) setPlacing(false);
    if (name === 'today' && miniMap) setTimeout(() => miniMap.invalidateSize(), 0);
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
      showBanner(null);
      setLocation(pos.coords.latitude, pos.coords.longitude, null);
    }, (err) => showBanner(`Couldn't get location: ${err.message}. Tap the location at the top of Today to search instead.`, 'warn'), { enableHighAccuracy: true, timeout: 15000 });
  }

  // ---------- Location ----------
  // Place search and names come from OpenStreetMap Nominatim (free; max 1 request/sec, no autocomplete).
  const GEO = 'https://nominatim.openstreetmap.org';

  function setLocation(lat, lon, name, opts = {}) {
    const s = store.settings;
    s.lat = lat; s.lon = lon; s.placeName = name || null;
    save(); fillSettings();
    if (map && !opts.keepMap) map.setView([lat, lon], 16);
    buildModel(); render(); fetchForecast(true);
    if (!name) lookupPlaceName(lat, lon);
  }

  function placeLabel(addr) {
    if (!addr) return null;
    const town = addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || addr.township || addr.county;
    const iso = addr['ISO3166-2-lvl4'];
    const region = iso && /^US-/.test(iso) ? iso.slice(3) : addr.state || addr.country;
    return [town, region].filter(Boolean).join(', ') || null;
  }

  async function lookupPlaceName(lat, lon) {
    try {
      const res = await fetch(`${GEO}/reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${lat}&lon=${lon}`);
      if (!res.ok) return;
      const data = await res.json();
      const name = placeLabel(data.address);
      // Ignore the answer if the location changed while we waited.
      if (name && store.settings.lat === lat && store.settings.lon === lon) {
        store.settings.placeName = name;
        save(); renderLocation();
      }
    } catch (e) { /* offline: coordinates are shown instead */ }
  }

  function renderLocation() {
    const s = store.settings;
    const name = s.placeName || (hasLoc() ? 'Your location' : 'No location set');
    const coords = hasLoc() ? `${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}` : 'Tap to set';
    document.querySelectorAll('.loc-name').forEach((el) => { el.textContent = name; });
    document.querySelectorAll('.loc-coords').forEach((el) => { el.textContent = coords; });
  }

  function openLocationDialog() {
    $('locQuery').value = '';
    $('locResults').innerHTML = '';
    $('locDialog').showModal();
    setTimeout(() => $('locQuery').focus(), 50);
  }

  let locResults = [];
  async function searchLocation(q) {
    q = q.trim();
    if (!q) return;
    // Accept pasted coordinates like "41.6, -88.1".
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) {
      $('locDialog').close();
      setLocation(+m[1], +m[2], null);
      return;
    }
    const out = $('locResults');
    out.innerHTML = '<p class="muted small">Searching…</p>';
    try {
      const res = await fetch(`${GEO}/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`search returned ${res.status}`);
      locResults = await res.json();
      out.innerHTML = locResults.length
        ? locResults.map((r, i) => `<button type="button" class="list-row loc-result" data-i="${i}"><span class="tile">${icon('pin')}</span><span class="row-text"><strong>${esc(placeLabel(r.address) || r.name || r.display_name)}</strong><span>${esc(r.display_name)}</span></span></button>`).join('')
        : '<p class="muted small">No places found. Try a town and state, an address, or a ZIP code.</p>';
    } catch (err) {
      out.innerHTML = `<p class="muted small">Search failed (${esc(err.message)}). Check your connection.</p>`;
    }
  }

  // ---------- Events ----------
  function selectHour(h) {
    selectedHour = ((h % 24) + 24) % 24;
    renderToday();
  }

  function bind() {
    document.querySelector('.tabbar').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (b) showView(b.dataset.view);
    });
    $('dayPicker').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-day]');
      if (b) { selectedDay = Number(b.dataset.day); selectedHour = defaultHour(); renderDayPicker(); renderToday(); }
    });
    $('weekList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-day]');
      if (b) { selectedDay = Number(b.dataset.day); selectedHour = defaultHour(); renderDayPicker(); renderToday(); showView('today'); }
    });
    $('todayHour').addEventListener('input', (e) => selectHour(Number(e.target.value)));
    $('hourPill').addEventListener('click', (e) => {
      const st = e.target.closest('[data-step]');
      if (st) selectHour(selectedHour + Number(st.dataset.step));
    });
    $('hourly').addEventListener('click', (e) => {
      const h = e.target.closest('[data-hour]');
      if (h) { selectHour(Number(h.dataset.hour)); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });
    $('scoreHelp').addEventListener('click', () => $('helpDialog').showModal());
    $('refreshBtn').addEventListener('click', () => fetchForecast(true));

    // Map
    $('hourSlider').addEventListener('input', (e) => { mapHour = Number(e.target.value); renderMapLayers(); renderStandList(); });
    $('addStandBtn').addEventListener('click', () => setPlacing(!placing));
    $('placeCancel').addEventListener('click', () => setPlacing(false));
    $('placeConfirm').addEventListener('click', () => {
      pendingLatLng = map.getCenter();
      setPlacing(false);
      openStandDialog(null);
    });
    $('newStandRow').addEventListener('click', () => { showView('map'); setTimeout(() => setPlacing(true), 50); });
    $('layersBtn').addEventListener('click', openLayers);
    $('layerGrid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-layer]');
      if (!b) return;
      setBaseLayer(b.dataset.layer);
      $('layerGrid').querySelectorAll('.layer-opt').forEach((x) => x.classList.toggle('on', x === b));
    });
    $('labelsToggle').addEventListener('change', (e) => setLabels(e.target.checked));
    $('streaksToggle').addEventListener('change', (e) => {
      store.settings.streaks = e.target.checked; save();
      renderMapLayers(); if (model) renderHero(model.days[selectedDay].info);
    });
    let meMarker = null;
    $('locateBtn').addEventListener('click', () => {
      if (!navigator.geolocation || !map) return;
      navigator.geolocation.getCurrentPosition((pos) => {
        const ll = [pos.coords.latitude, pos.coords.longitude];
        map.setView(ll, 17);
        if (meMarker) meMarker.setLatLng(ll);
        else meMarker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#3d8bfd', fillOpacity: 1 }).addTo(map);
      }, (err) => showBanner(`Couldn't get location: ${err.message}`, 'warn'), { enableHighAccuracy: true, timeout: 15000 });
    });

    // Shared click targets: edit stand, show stand on map, open location search, switch view.
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-goto]');
      if (go) {
        const s = store.stands.find((x) => x.id === go.dataset.goto);
        showView('map');
        setTimeout(() => map && s && map.setView([s.lat, s.lon], 17), 50);
        return;
      }
      const ed = e.target.closest('[data-edit]');
      if (ed) { if (map) map.closePopup(); openStandDialog(ed.dataset.edit); return; }
      if (e.target.closest('.loc-open')) { openLocationDialog(); return; }
      const gv = e.target.closest('[data-goview]');
      if (gv) showView(gv.dataset.goview);
    });

    // Tap outside a bottom sheet to close it.
    document.querySelectorAll('dialog.sheet').forEach((d) => d.addEventListener('click', (e) => {
      if (e.target === d) { if (d.id === 'standDialog') pendingLatLng = null; d.close(); }
    }));

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
      const validLoc = !isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
      const locChanged = validLoc && (!hasLoc() || Math.abs(lat - s.lat) > 1e-5 || Math.abs(lon - s.lon) > 1e-5);
      s.legalBefore = Number($('setLegalBefore').value) || 0;
      s.legalAfter = Number($('setLegalAfter').value) || 0;
      s.rutPeak = $('setRut').value || null;
      s.units = $('setUnits').value;
      save();
      showToast('Settings saved');
      if (locChanged) setLocation(lat, lon, null);
      else { buildModel(); render(); }
    });

    $('locForm').addEventListener('submit', (e) => { e.preventDefault(); searchLocation($('locQuery').value); });
    $('locResults').addEventListener('click', (e) => {
      const b = e.target.closest('.loc-result');
      if (!b) return;
      const r = locResults[Number(b.dataset.i)];
      $('locDialog').close();
      setLocation(parseFloat(r.lat), parseFloat(r.lon), placeLabel(r.address) || r.name || null);
    });
    $('locGps').addEventListener('click', () => { $('locDialog').close(); useGps(); });
    $('locCancel').addEventListener('click', () => $('locDialog').close());

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
        if (!hasLoc() && data.settings && typeof data.settings.lat === 'number' && typeof data.settings.lon === 'number') { store.settings.lat = data.settings.lat; store.settings.lon = data.settings.lon; lookupPlaceName(store.settings.lat, store.settings.lon); }
        save(); fillSettings(); buildModel(); render(); fetchForecast();
        showToast(`Imported ${added.length} stand(s)`);
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
    renderLocation();
    if (hasLoc() && !store.settings.placeName) lookupPlaceName(store.settings.lat, store.settings.lon);
    buildModel(); render();
    if (hasLoc()) fetchForecast();
    else {
      $('scoreLabel').textContent = 'Set your property location';
      $('scoreReasons').innerHTML = '<li class="muted">Allow location access, or tap the location name above to search.</li>';
      useGps();
    }
    startAutoRefresh();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
    }
  }

  boot();
})();

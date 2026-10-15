/* TerraLive v1 client - live planet globe.
 * MapLibre GL (globe projection) + satellite.js. No frameworks.
 * Data comes from our own /api/live cache-proxy; TLEs from /api/tle/*.
 */
(() => {
'use strict';

/* ---------------- state ---------------- */
const LAYER_SHORT = { flights: 'f', sats: 's', starlink: 'x', ships: 'h', quakes: 'q', night: 'n' };
const SHORT_LAYER = { f: 'flights', s: 'sats', x: 'starlink', h: 'ships', q: 'quakes', n: 'night' };

/* ---------------- airline + aircraft enrichment (lazy, real data) ---------------- */
let airlinesLoading = null;
function ensureAirlines() {
  if (window.AIRLINES) return Promise.resolve();
  if (!airlinesLoading) {
    airlinesLoading = new Promise((res) => {
      const s = document.createElement('script');
      s.src = '/js/airlines.js'; s.onload = res; s.onerror = res;
      document.head.appendChild(s);
    });
  }
  return airlinesLoading;
}
function airlineName(callsign) {
  if (!callsign || !window.AIRLINES) return null;
  return window.AIRLINES[callsign.trim().substring(0, 3).toUpperCase()] || null;
}
function modelName(typeCode) {
  return (window.AC_TYPES && typeCode && window.AC_TYPES[typeCode]) || typeCode || null;
}
async function aircraftPhotoUrl(model) {
  if (!model) return null;
  try {
    const q = encodeURIComponent(model + ' aircraft in flight');
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
      '&generator=search&gsrsearch=' + q + '&gsrnamespace=6&gsrlimit=3&prop=pageimages&pithumbsize=600';
    const j = await (await fetch(url)).json();
    const pages = j.query && j.query.pages ? Object.values(j.query.pages) : [];
    const hit = pages.find((p) => p.thumbnail && p.thumbnail.source);
    return hit ? hit.thumbnail.source : null;
  } catch (e) { return null; }
}
async function loadTrackPhoto(model, token) {
  const img = $('track-photo');
  img.hidden = true; img.removeAttribute('src');
  if (!model) return;
  const url = await aircraftPhotoUrl(model);
  if (url && token === state._photoToken) { img.src = url; img.hidden = false; }
}

const state = {
  layers: { flights: true, sats: true, starlink: false, ships: true, quakes: true, night: true },
  nightOps: false,
  tracked: null,          // {kind:'flight'|'sat'|'ship', id}
  trail: [],
  follow: true,
  live: null,
  lastOk: 0,
  satrecs: [],            // stations+visual
  starlink: [],           // decimated
  autoRotate: true,
};

const $ = (id) => document.getElementById(id);
const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

/* ---------------- icons ---------------- */
const PLANE_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><path d='M24 3 L28.5 19 L45 29 L45 33.5 L28.5 29.5 L26.5 43 L21.5 43 L19.5 29.5 L3 33.5 L3 29 L19.5 19 Z' fill='#7df9ff' stroke='#0a2a33' stroke-width='1.5'/></svg>`;
const SHIP_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><path d='M24 5 L31 24 L24 43 L17 24 Z' fill='#5cff9d' stroke='#0a2a1a' stroke-width='1.5'/><circle cx='24' cy='24' r='3' fill='#0a2a1a'/></svg>`;

function addIcon(name, svg) {
  return new Promise((resolve, reject) => {
    const img = new Image(48, 48);
    img.onload = () => { try { map.addImage(name, img); resolve(); } catch (e) { reject(e); } };
    img.onerror = reject;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/* ---------------- map ---------------- */
const DAY_TILES = ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'];
const NIGHT_TILES = ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'];

function baseStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'raster', tiles: DAY_TILES, tileSize: 256, maxzoom: 18,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#04070d' } },
      { id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-fade-duration': 0 } },
    ],
  };
}

const map = new maplibregl.Map({
  container: 'globe',
  style: baseStyle(),
  center: [20, 22],
  zoom: 1.7,
  projection: 'globe',
  renderWorldCopies: false,
  attributionControl: { compact: true },
  fadeDuration: 0,
});

function addEntityLayers() {
  map.addSource('night', { type: 'geojson', data: emptyFC() });
  map.addSource('quakes', { type: 'geojson', data: emptyFC() });
  map.addSource('starlink', { type: 'geojson', data: emptyFC() });
  map.addSource('sats', { type: 'geojson', data: emptyFC() });
  map.addSource('iss', { type: 'geojson', data: emptyFC() });
  map.addSource('ships', { type: 'geojson', data: emptyFC() });
  map.addSource('flights', { type: 'geojson', data: emptyFC() });
  map.addSource('trail', { type: 'geojson', data: emptyFC(), lineMetrics: true });

  map.addLayer({ id: 'night-fill', type: 'fill', source: 'night',
    paint: { 'fill-color': '#01030a', 'fill-opacity': 0.42 } });

  map.addLayer({ id: 'quakes-layer', type: 'circle', source: 'quakes',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 2.5, 4, 5, 9, 7, 16, 9, 26],
      'circle-color': ['interpolate', ['linear'], ['get', 'mag'], 2.5, '#ffd97d', 5, '#ff9d5c', 7, '#ff5c5c', 9, '#ff2222'],
      'circle-opacity': 0.75, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff',
    }});

  map.addLayer({ id: 'starlink-layer', type: 'circle', source: 'starlink',
    paint: { 'circle-radius': 1.4, 'circle-color': '#b48cff', 'circle-opacity': 0.55 } });

  map.addLayer({ id: 'sats-layer', type: 'circle', source: 'sats',
    paint: { 'circle-radius': 3, 'circle-color': '#7df9ff', 'circle-opacity': 0.9,
      'circle-stroke-width': 1, 'circle-stroke-color': '#04303a' } });

  map.addLayer({ id: 'iss-glow', type: 'circle', source: 'iss',
    paint: { 'circle-radius': 14, 'circle-color': '#7df9ff', 'circle-opacity': 0.18 } });
  map.addLayer({ id: 'iss-layer', type: 'circle', source: 'iss',
    paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-width': 2, 'circle-stroke-color': '#7df9ff' } });
  map.addLayer({ id: 'iss-label', type: 'symbol', source: 'iss',
    layout: { 'text-field': 'ISS', 'text-size': 11, 'text-offset': [0, 1.4], 'text-font': ['Open Sans Bold'] },
    paint: { 'text-color': '#7df9ff', 'text-halo-color': '#000', 'text-halo-width': 1.5 } });

  map.addLayer({ id: 'ships-layer', type: 'symbol', source: 'ships',
    layout: { 'icon-image': 'ship', 'icon-size': 0.55, 'icon-allow-overlap': true,
      'icon-ignore-placement': true, 'icon-rotate': ['coalesce', ['get', 'cog'], 0], 'icon-rotation-alignment': 'map' } });

  map.addLayer({ id: 'flights-layer', type: 'symbol', source: 'flights',
    layout: { 'icon-image': 'plane', 'icon-size': 0.5, 'icon-allow-overlap': true,
      'icon-ignore-placement': true, 'icon-rotate': ['coalesce', ['get', 'track'], 0], 'icon-rotation-alignment': 'map' } });

  map.addLayer({ id: 'trail-layer', type: 'line', source: 'trail',
    paint: { 'line-width': 2.5,
      'line-gradient': ['interpolate', ['linear'], ['line-progress'],
        0, 'rgba(125,249,255,0)', 0.6, 'rgba(125,249,255,0.25)', 1, '#7df9ff'] } });

  applyLayerVisibility();
}

function layerIdFor(key) {
  return { flights: 'flights-layer', sats: 'sats-layer', starlink: 'starlink-layer',
    ships: 'ships-layer', quakes: 'quakes-layer', night: 'night-fill' }[key];
}
function applyLayerVisibility() {
  for (const [key, on] of Object.entries(state.layers)) {
    const id = layerIdFor(key);
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}

/* ---------------- sun / terminator ---------------- */
function subsolar(date) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000
  const M = (((357.5291 + 0.98560028 * d) % 360) + 360) % 360;
  const L = (((280.459 + 0.98564736 * d) % 360) + 360) % 360;
  const lambda = (L + 1.915 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad)) % 360;
  const eps = 23.439 - 0.00000036 * d;
  const dec = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad)) / rad;
  const GMST = (((280.46061837 + 360.98564736629 * d) % 360) + 360) % 360;
  const lon = (((lambda - GMST) % 360) + 540) % 360 - 180;
  return { lat: dec, lon };
}
function destPoint(lat, lon, bearingDeg, distDeg) {
  const rad = Math.PI / 180, d = distDeg * rad, br = bearingDeg * rad;
  const la1 = lat * rad, lo1 = lon * rad;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [(((lo2 / rad + 540) % 360) - 180), la2 / rad];
}
function updateTerminator() {
  const s = subsolar(new Date());
  const c = { lat: -s.lat, lon: s.lon > 0 ? s.lon - 180 : s.lon + 180 }; // antipode
  const ring = [];
  for (let b = 0; b <= 360; b += 4) ring.push(destPoint(c.lat, c.lon, b, 90));
  const src = map.getSource('night');
  if (src) src.setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] });
}

/* ---------------- live data ---------------- */
let liveTimer = null;

async function refreshLive() {
  try {
    const r = await fetch('/api/live', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    state.live = j;
    state.lastOk = Date.now();
    $('offline').hidden = true;

    const fc = (arr, fn) => ({ type: 'FeatureCollection',
      features: arr.map((a) => { const f = fn(a); return f; }).filter(Boolean) });

    map.getSource('flights').setData(fc(j.flights.data, (a) => ({
      type: 'Feature',
      properties: { kind: 'flight', id: a[0], name: a[1] || a[0], track: a[4], gs: a[5], alt: a[6], acType: a[7], reg: a[8] },
      geometry: { type: 'Point', coordinates: [a[3], a[2]] },
    })));

    map.getSource('ships').setData(fc(j.ships.data, (a) => ({
      type: 'Feature',
      properties: { kind: 'ship', id: String(a[0]), name: a[1] || ('MMSI ' + a[0]), cog: a[4], sog: a[5] },
      geometry: { type: 'Point', coordinates: [a[3], a[2]] },
    })));

    map.getSource('quakes').setData(fc(j.quakes.data, (q) => ({
      type: 'Feature',
      properties: { kind: 'quake', id: q.id, mag: q.mag, place: q.place, time: q.time, depth: q.depth },
      geometry: { type: 'Point', coordinates: [q.lon, q.lat] },
    })));

    $('c-flights').textContent = j.flights.n.toLocaleString();
    $('c-ships').textContent = j.ships.n.toLocaleString();
    $('c-quakes').textContent = j.quakes.n.toLocaleString();

    if (state.tracked && state.follow) followTracked();
    resolvePendingTrack();
    $('loading').classList.add('done');
  } catch (e) {
    if (Date.now() - state.lastOk > 90000) $('offline').hidden = false;
  }
}

/* ---------------- satellites (browser SGP4) ---------------- */
function parseTLE(txt) {
  const lines = txt.split('\n');
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = (lines[i] || '').trim();
    const l1 = lines[i + 1] || '', l2 = lines[i + 2] || '';
    if (!/^1 \d{5}/.test(l1) || !/^2 \d{5}/.test(l2)) continue;
    try {
      const satrec = satellite.twoline2satrec(l1, l2);
      out.push({ satrec, id: l1.substring(2, 7).trim(), name: name || ('NORAD ' + l1.substring(2, 7).trim()) });
    } catch (e) { /* skip bad records */ }
  }
  return out;
}

async function loadTLEs() {
  try {
    const [st, vi] = await Promise.all([
      fetch('/api/tle/stations').then((r) => (r.ok ? r.text() : '')),
      fetch('/api/tle/visual').then((r) => (r.ok ? r.text() : '')),
    ]);
    const seen = new Set();
    state.satrecs = [];
    for (const s of [...parseTLE(st), ...parseTLE(vi)]) {
      if (!seen.has(s.id)) { seen.add(s.id); state.satrecs.push(s); }
    }
    const sl = await fetch('/api/tle/starlink').then((r) => (r.ok ? r.text() : ''));
    const all = parseTLE(sl);
    const stride = Math.max(1, Math.ceil(all.length / 1400)); // cap for phones
    state.starlink = all.filter((_, i) => i % stride === 0);
    satTick(true);
    setInterval(() => satTick(false), 2500);
    setInterval(() => starlinkTick(), 6000);
  } catch (e) { /* satellites stay empty; flights still work */ }
  // Retry until the TLE feed is reachable - the server may still be fetching it.
  if (!state.satrecs.length && !state._tleRetry) {
    state._tleRetry = setInterval(() => {
      if (state.satrecs.length) { clearInterval(state._tleRetry); state._tleRetry = null; return; }
      loadTLEs();
    }, 30000);
  }
}

function propagateToFC(list, wantISS) {
  const now = new Date();
  const feats = [], issFeats = [];
  for (const s of list) {
    let pos;
    try {
      const pv = satellite.propagate(s.satrec, now);
      if (!pv || !pv.position) continue;
      const g = satellite.eciToGeodetic(pv.position, satellite.gstime(now));
      pos = { lon: (g.longitude * 180) / Math.PI, lat: (g.latitude * 180) / Math.PI,
        alt: Math.hypot(pv.position.x, pv.position.y, pv.position.z) - 6371,
        vel: pv.velocity ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) : null };
    } catch (e) { continue; }
    const f = { type: 'Feature',
      properties: { kind: 'sat', id: s.id, name: s.name, alt: Math.round(pos.alt), vel: pos.vel == null ? null : +pos.vel.toFixed(2) },
      geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] } };
    if (wantISS && /ISS/.test(s.name)) issFeats.push(f); else feats.push(f);
  }
  return { feats, issFeats };
}

function satTick(first) {
  if (!state.satrecs.length || !map.getSource('sats')) { if (first) setTimeout(() => satTick(true), 3000); return; }
  const { feats, issFeats } = propagateToFC(state.satrecs, true);
  map.getSource('sats').setData({ type: 'FeatureCollection', features: feats });
  map.getSource('iss').setData({ type: 'FeatureCollection', features: issFeats });
  const n = feats.length + issFeats.length;
  if (n) $('c-sats').textContent = (n + (state.layers.starlink ? state.starlink.length : 0)).toLocaleString();
  if (state.tracked && state.tracked.kind === 'sat' && state.follow) followTracked(feats.concat(issFeats));
  resolvePendingTrack();
}
function starlinkTick() {
  if (!state.starlink.length || !map.getSource('starlink')) return;
  const { feats } = propagateToFC(state.starlink, false);
  map.getSource('starlink').setData({ type: 'FeatureCollection', features: feats });
}

/* ---------------- click-to-track ---------------- */
const CLICK_LAYERS = ['flights-layer', 'ships-layer', 'sats-layer', 'iss-layer'];

map.on('click', (e) => {
  const feats = map.queryRenderedFeatures(e.point, { layers: CLICK_LAYERS });
  if (!feats.length) { untrack(); return; }
  const p = feats[0].properties;
  track({ kind: p.kind, id: String(p.id) }, feats[0].geometry.coordinates);
});

map.on('click', (e) => {
  // quakes get a popup instead of tracking
  const q = map.queryRenderedFeatures(e.point, { layers: ['quakes-layer'] });
  if (q.length) {
    const p = q[0].properties;
    new maplibregl.Popup({ closeButton: true })
      .setLngLat(q[0].geometry.coordinates)
      .setHTML(`<b>M${p.mag}</b> - ${escapeHtml(p.place)}<br><span style="color:#8fa3b8">${new Date(+p.time).toUTCString()} · ${p.depth} km deep</span>`)
      .addTo(map);
  }
});

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function track(t, lngLat) {
  exitLiveView(false);
  state.tracked = t;
  state.trail = lngLat ? [lngLat] : [];
  state.follow = true;
  updateTrailSource();
  $('track-card').hidden = false;
  $('track-kind').textContent = t.kind.toUpperCase();
  if (lngLat) map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), t.kind === 'sat' ? 2.5 : 4), duration: 900 });
  updateTrackCard();
  toast('Tracking ' + t.id + ' - tap card to re-lock, X to release');
}
function untrack() {
  exitLiveView(false);
  state.tracked = null; state.trail = [];
  updateTrailSource();
  $('track-card').hidden = true;
}
$('track-close').addEventListener('click', (e) => { e.stopPropagation(); untrack(); });
$('track-card').addEventListener('click', () => { if (state.tracked) { state.follow = true; toast('Camera re-locked'); } });
map.on('dragstart', () => {
  if (state.liveView) { exitLiveView(false); return; }
  if (state.tracked && state.follow) { state.follow = false; toast('Camera released - tap card to re-lock'); }
});

function findTrackedFeature(extraFeats) {
  const t = state.tracked;
  if (!t || !state.live) return null;
  if (t.kind === 'flight') {
    const a = state.live.flights.data.find((x) => x[0] === t.id);
    return a ? { lngLat: [a[3], a[2]], props: { name: a[1] || a[0], alt: a[6], gs: a[5], track: a[4], acType: a[7], reg: a[8] } } : null;
  }
  if (t.kind === 'ship') {
    const s = state.live.ships.data.find((x) => String(x[0]) === t.id);
    return s ? { lngLat: [s[3], s[2]], props: { name: s[1] || ('MMSI ' + s[0]), sog: s[5], cog: s[4], track: s[4] } } : null;
  }
  if (t.kind === 'sat' && extraFeats) {
    const f = extraFeats.find((x) => x.properties.id === t.id);
    return f ? { lngLat: f.geometry.coordinates, props: f.properties } : null;
  }
  return null;
}

function followTracked(extraFeats) {
  const hit = findTrackedFeature(extraFeats);
  if (!hit) { updateTrackCard(null); return; }
  const last = state.trail[state.trail.length - 1];
  if (!last || Math.abs(last[0] - hit.lngLat[0]) > 1e-6 || Math.abs(last[1] - hit.lngLat[1]) > 1e-6) {
    state.trail.push(hit.lngLat);
    if (state.trail.length > 120) state.trail.shift();
    updateTrailSource();
  }
  if (!state.liveView) map.jumpTo({ center: hit.lngLat }); // chase cam owns the camera in live view
  updateTrackCard(hit.props);
}
function updateTrailSource() {
  const src = map.getSource('trail');
  if (!src) return;
  src.setData(state.trail.length > 1
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: state.trail } }] }
    : emptyFC());
}
function updateTrackCard(props) {
  const t = state.tracked;
  if (!t) return;
  const hit = props || (findTrackedFeature() || {}).props;
  if (!hit) { $('track-name').textContent = t.id + ' (out of range)'; $('track-grid').innerHTML = ''; return; }
  let rows = '';
  if (t.kind === 'flight') {
    $('track-name').textContent = hit.name;
    const model = modelName(hit.acType);
    ensureAirlines().then(() => {
      if (!state.tracked || state.tracked.id !== t.id) return;
      const al = airlineName(hit.name);
      const sub = $('track-sub');
      if (al) { sub.textContent = al; sub.hidden = false; }
      else sub.hidden = true;
      updateTrackCardRows(t, hit, model, al);
    });
    updateTrackCardRows(t, hit, model, null);
    state._photoToken = (state._photoToken || 0) + 1;
    loadTrackPhoto(model, state._photoToken);
    $('liveview-btn').hidden = false;
    if (state.liveView) { $('liveview-btn').textContent = 'Exit live view'; }
    else { $('liveview-btn').textContent = 'View live'; }
  } else if (t.kind === 'ship') {
    $('track-name').textContent = hit.name;
    $('track-sub').hidden = true;
    $('track-photo').hidden = true;
    rows = `<span class="k">Speed</span><span>${hit.sog == null ? '–' : hit.sog + ' kts'}</span>` +
      `<span class="k">Course</span><span>${hit.cog == null ? '–' : hit.cog + '°'}</span>`;
    $('liveview-btn').hidden = false;
    if (state.liveView) { $('liveview-btn').textContent = 'Exit live view'; }
    else { $('liveview-btn').textContent = 'View live'; }
  } else {
    $('track-name').textContent = hit.name || t.id;
    $('track-sub').hidden = true;
    $('track-photo').hidden = true;
    $('liveview-btn').hidden = true;
    rows = `<span class="k">Altitude</span><span>${hit.alt == null ? '–' : hit.alt.toLocaleString() + ' km'}</span>` +
      `<span class="k">Velocity</span><span>${hit.vel == null ? '–' : hit.vel + ' km/s'}</span>` +
      `<span class="k">NORAD</span><span>${escapeHtml(t.id)}</span>`;
  }
  $('track-grid').innerHTML = rows;
}
function updateTrackCardRows(t, hit, model, airline) {
  if (!state.tracked || state.tracked.id !== t.id || t.kind !== 'flight') return;
  let rows = '';
  if (airline) rows += `<span class="k">Airline</span><span>${escapeHtml(airline)}</span>`;
  rows += `<span class="k">Altitude</span><span>${hit.alt == null ? '–' : hit.alt.toLocaleString() + ' ft'}</span>` +
    `<span class="k">Speed</span><span>${hit.gs == null ? '–' : hit.gs + ' kts'}</span>` +
    `<span class="k">Heading</span><span>${hit.track == null ? '–' : Math.round(hit.track) + '°'}</span>` +
    `<span class="k">Aircraft</span><span>${escapeHtml(model || '–')}${hit.reg ? ' · ' + escapeHtml(hit.reg) : ''}</span>`;
  $('track-grid').innerHTML = rows;
}

/* ---------------- live view: GTA-style switch transition + chase cam ---------------- */
let liveViewTimer = null;
function enterLiveView() {
  const t = state.tracked;
  if (!t || (t.kind !== 'flight' && t.kind !== 'ship')) return;
  const hit = findTrackedFeature();
  if (!hit) { toast('Target out of range right now'); return; }
  state.liveView = true;
  state.follow = true;
  $('liveview-btn').textContent = 'Exit live view';
  $('track-note').textContent = 'Live view - drag to exit';
  const dest = hit.lngLat;
  // Phase 1: punch up into the sky, GTA switch style
  map.flyTo({ center: map.getCenter(), zoom: 2.2, pitch: 0, duration: 800, curve: 1.6, essential: true });
  setTimeout(() => {
    if (!state.liveView) return;
    // Phase 2: dive onto the target, camera aligned to its heading
    const b = hit.props && hit.props.track != null ? hit.props.track : 0;
    map.flyTo({ center: dest, zoom: 14.5, pitch: 62, bearing: b, duration: 2400, curve: 1.35, essential: true });
  }, 850);
  // Chase cam: keep easing onto the target as it moves
  clearInterval(liveViewTimer);
  liveViewTimer = setInterval(() => {
    if (!state.liveView) return;
    const h = findTrackedFeature();
    if (!h) return;
    const b = h.props && h.props.track != null ? h.props.track : map.getBearing();
    map.easeTo({ center: h.lngLat, zoom: 14.5, pitch: 62, bearing: b, duration: 1800 });
  }, 4000);
}
function exitLiveView(restoreZoom) {
  if (!state.liveView) return;
  state.liveView = false;
  clearInterval(liveViewTimer);
  $('liveview-btn').textContent = 'View live';
  $('track-note').textContent = 'Camera locked - drag to release';
  if (restoreZoom !== false) map.flyTo({ center: map.getCenter(), zoom: 4, pitch: 0, duration: 1500 });
}
$('liveview-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.liveView) exitLiveView();
  else enterLiveView();
});

/* ---------------- share links (the viral loop) ---------------- */
function buildShareURL() {
  const c = map.getCenter();
  const ly = Object.entries(state.layers).filter(([, v]) => v).map(([k]) => LAYER_SHORT[k]).join('');
  let h = `#c=${c.lat.toFixed(3)},${c.lng.toFixed(3)},${map.getZoom().toFixed(2)},${Math.round(map.getBearing())},${Math.round(map.getPitch())}&ly=${ly}`;
  if (state.nightOps) h += '&ops=1';
  if (state.tracked) h += `&tr=${state.tracked.kind}:${encodeURIComponent(state.tracked.id)}`;
  return location.origin + location.pathname + h;
}
let pendingTrack = null;
function parseShareHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return;
  const params = Object.fromEntries(h.split('&').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  if (params.c) {
    const [lat, lon, z, b, p] = params.c.split(',').map(Number);
    if ([lat, lon, z].every((v) => Number.isFinite(v)))
      map.jumpTo({ center: [lon, lat], zoom: z, bearing: b || 0, pitch: p || 0 });
    state.autoRotate = false;
  }
  if (params.ly) {
    for (const k of Object.keys(state.layers)) state.layers[k] = false;
    for (const ch of params.ly) if (SHORT_LAYER[ch]) state.layers[SHORT_LAYER[ch]] = true;
    syncChips(); applyLayerVisibility();
  }
  if (params.ops === '1' && !state.nightOps) toggleNightOps();
  if (params.tr) {
    const i = params.tr.indexOf(':');
    pendingTrack = { kind: params.tr.slice(0, i), id: decodeURIComponent(params.tr.slice(i + 1)) };
  }
}
function resolvePendingTrack() {
  if (!pendingTrack || !state.live) return;
  const t = pendingTrack;
  let ok = false;
  if (t.kind === 'flight') ok = state.live.flights.data.some((x) => x[0] === t.id);
  else if (t.kind === 'ship') ok = state.live.ships.data.some((x) => String(x[0]) === t.id);
  else if (t.kind === 'sat') ok = state.satrecs.some((s) => s.id === t.id);
  if (ok) { pendingTrack = null; track(t); }
  else if (Date.now() - state.lastOk > 120000) { pendingTrack = null; toast('shared target is out of range right now'); }
}
$('share-btn').addEventListener('click', async () => {
  const url = buildShareURL();
  try { await navigator.clipboard.writeText(url); toast('Link copied - send it to someone'); }
  catch (e) {
    prompt('Copy your share link:', url);
  }
  history.replaceState(null, '', url.slice(url.indexOf('#')));
});

/* ---------------- UI wiring ---------------- */
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}
function syncChips() {
  document.querySelectorAll('#chips .chip[data-layer]').forEach((ch) => {
    ch.classList.toggle('on', !!state.layers[ch.dataset.layer]);
  });
  $('nightops').classList.toggle('on', state.nightOps);
}
document.querySelectorAll('#chips .chip[data-layer]').forEach((ch) => {
  ch.addEventListener('click', () => {
    const k = ch.dataset.layer;
    state.layers[k] = !state.layers[k];
    ch.classList.toggle('on', state.layers[k]);
    applyLayerVisibility();
  });
});
function toggleNightOps() {
  state.nightOps = !state.nightOps;
  const src = map.getSource('basemap');
  if (src) src.setTiles(state.nightOps ? NIGHT_TILES : DAY_TILES);
  map.setLayoutProperty('night-fill', 'visibility', state.nightOps || !state.layers.night ? 'none' : 'visible');
  $('nightops').classList.toggle('on', state.nightOps);
  toast(state.nightOps ? 'Night ops on - dark basemap' : 'Day basemap restored');
}
$('nightops').addEventListener('click', toggleNightOps);

// gentle auto-rotation until the user takes over (the instant "living planet" feel)
(function autoSpin() {
  if (!state.autoRotate || document.hidden) { requestAnimationFrame(autoSpin); return; }
  map.setBearing((map.getBearing() + 0.02) % 360);
  requestAnimationFrame(autoSpin);
})();
for (const ev of ['pointerdown', 'wheel', 'touchstart']) {
  map.getCanvas().addEventListener(ev, () => { state.autoRotate = false; }, { passive: true });
}

setTimeout(() => { $('hint').style.opacity = '0'; }, 14000);

/* fps meter (?fps=1) */
if (new URLSearchParams(location.search).get('fps') === '1') {
  const el = $('fps'); el.hidden = false;
  let frames = 0, last = performance.now();
  (function loop(t) {
    frames++;
    if (t - last >= 1000) { el.textContent = frames + ' fps'; frames = 0; last = t; }
    requestAnimationFrame(loop);
  })(performance.now());
}

/* ---------------- boot ---------------- */
map.on('load', async () => {
  try { await Promise.all([addIcon('plane', PLANE_SVG), addIcon('ship', SHIP_SVG)]); }
  catch (e) { console.warn('icon load failed', e); }
  addEntityLayers();
  updateTerminator();
  setInterval(updateTerminator, 60000);
  parseShareHash();
  await refreshLive();
  liveTimer = setInterval(refreshLive, 25000);
  loadTLEs();
  setTimeout(() => {
    if (Date.now() - state.lastOk > 45000) {
      $('load-status').textContent = 'SIGNAL WEAK - STILL TRYING';
    }
  }, 15000);
});
map.on('error', (e) => console.warn('map error', e && e.error));

})();

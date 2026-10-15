/*
 * TerraLive — cache-proxy backend (v1)
 *
 * Polls free upstream APIs on a timer, caches the results in memory, and serves
 * ONE slim aggregated endpoint (/api/live) to browsers. This protects upstream
 * providers from being hammered when traffic spikes, and keeps client payloads
 * small (arrays, rounded coords, gzip).
 *
 * No API keys are ever sent to the browser. The optional AISSTREAM_API_KEY is
 * used only by a server-side websocket.
 */
'use strict';

const express = require('express');
const compression = require('compression');
const path = require('path');

const PORT = process.env.PORT || 3000;
const UA = { 'User-Agent': 'TerraLive/1.0 (+https://github.com/Gake2026/terralive)' };

const app = express();
app.use(compression());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

async function fetchTimeout(url, ms = 25000, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: { ...UA, ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r;
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/* Flights — adsb.lol (primary), OpenSky (fallback)                    */
/* ------------------------------------------------------------------ */

// Five overlapping regional queries stitch together near-global coverage.
// adsb.lol has no usable global dump endpoint; dist is in nautical miles.
const REGIONS = [
  { lat: 30, lon: 10, dist: 2200 }, // Europe / Africa / Middle East
  { lat: 38, lon: -98, dist: 2200 }, // North America
  { lat: -15, lon: -60, dist: 2000 }, // South America
  { lat: 28, lon: 105, dist: 2200 }, // Asia
  { lat: -25, lon: 135, dist: 2000 }, // Oceania
];

// Slim record: [hex, flight, lat, lon, track, gs_kts, alt_ft, type, reg]
const flightsCache = { t: 0, ok: false, source: 'none', data: [] };
let adsbFails = 0;

async function pollFlights() {
  try {
    const results = await Promise.all(
      REGIONS.map((r) =>
        fetchTimeout(`https://api.adsb.lol/v2/lat/${r.lat}/lon/${r.lon}/dist/${r.dist}`, 25000)
          .then((res) => res.json())
          .catch(() => null)
      )
    );
    const seen = new Map();
    for (const j of results) {
      if (!j || !Array.isArray(j.ac)) continue;
      for (const a of j.ac) {
        if (a.lat == null || a.lon == null || !a.hex || seen.has(a.hex)) continue;
        seen.set(a.hex, [
          a.hex,
          (a.flight || '').trim() || null,
          +Number(a.lat).toFixed(4),
          +Number(a.lon).toFixed(4),
          a.track == null ? null : +Number(a.track).toFixed(1),
          a.gs == null ? null : Math.round(a.gs),
          a.alt_baro === 'ground' ? 0 : a.alt_baro == null ? null : Math.round(a.alt_baro),
          a.t || null,
          a.r || null,
        ]);
      }
    }
    let arr = [...seen.values()];
    if (arr.length === 0) throw new Error('empty merge');
    // Decimate so the client payload stays sane on phones.
    if (arr.length > 9000) {
      const stride = Math.ceil(arr.length / 9000);
      arr = arr.filter((_, i) => i % stride === 0);
    }
    flightsCache.t = Date.now();
    flightsCache.ok = true;
    flightsCache.source = 'adsb.lol';
    flightsCache.data = arr;
    adsbFails = 0;
  } catch (e) {
    adsbFails++;
    console.warn('[flights] adsb.lol cycle failed (' + adsbFails + '): ' + e.message);
    if (adsbFails >= 3) pollFlightsOpenSky(); // failover, then keep trying adsb.lol
  }
}

// Slim record matches the adsb.lol shape.
async function pollFlightsOpenSky() {
  try {
    const j = await (
      await fetchTimeout('https://opensky-network.org/api/states/all', 30000)
    ).json();
    const arr = [];
    for (const s of j.states || []) {
      const lon = s[5], lat = s[6];
      if (lat == null || lon == null) continue;
      arr.push([
        (s[0] || '').trim(),
        (s[1] || '').trim() || null,
        +Number(lat).toFixed(4),
        +Number(lon).toFixed(4),
        s[10] == null ? null : +Number(s[10]).toFixed(1),
        s[9] == null ? null : Math.round(s[9] * 1.94384),
        s[7] == null ? null : Math.round(s[7] * 3.28084),
        null,
        null,
      ]);
      if (arr.length >= 9000) break;
    }
    if (arr.length) {
      flightsCache.t = Date.now();
      flightsCache.ok = true;
      flightsCache.source = 'opensky (fallback)';
      flightsCache.data = arr;
      console.log('[flights] OpenSky fallback served ' + arr.length + ' aircraft');
    }
  } catch (e) {
    console.warn('[flights] OpenSky fallback failed: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* Earthquakes — USGS (free, keyless)                                   */
/* ------------------------------------------------------------------ */

const quakesCache = { t: 0, data: [] };

async function pollQuakes() {
  try {
    const j = await (
      await fetchTimeout(
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
        20000
      )
    ).json();
    quakesCache.t = Date.now();
    quakesCache.data = (j.features || []).map((f) => ({
      id: f.id,
      mag: +Number(f.properties.mag).toFixed(1),
      place: f.properties.place,
      time: f.properties.time,
      lat: +Number(f.geometry.coordinates[1]).toFixed(3),
      lon: +Number(f.geometry.coordinates[0]).toFixed(3),
      depth: Math.round(f.geometry.coordinates[2]),
    }));
  } catch (e) {
    console.warn('[quakes] ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* Ships — AISStream (needs free key) or Digitraffic regional fallback  */
/* ------------------------------------------------------------------ */

// Slim record: [mmsi, name, lat, lon, cog, sog]
const shipsCache = { t: 0, data: [], source: 'none', note: '' };

function startAISStream() {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) return false;
  let WebSocket;
  try {
    WebSocket = require('ws');
  } catch (e) {
    console.warn('[ships] ws package missing, skipping AISStream');
    return false;
  }
  const vessels = new Map();
  let backoff = 5000;

  function connect() {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.on('open', () => {
      backoff = 5000;
      ws.send(
        JSON.stringify({
          APIKey: key,
          BoundingBoxes: [[[-90, -180], [90, 180]]],
          FilterMessageTypes: ['PositionReport'],
        })
      );
      console.log('[ships] AISStream connected (global)');
    });
    ws.on('message', (buf) => {
      try {
        const m = JSON.parse(buf.toString());
        const md = m.MetaData || {};
        if (md.MMSI && md.latitude != null) {
          vessels.set(md.MMSI, {
            mmsi: md.MMSI,
            name: (md.ShipName || '').trim() || null,
            lat: +Number(md.latitude).toFixed(4),
            lon: +Number(md.longitude).toFixed(4),
            cog: md.COG == null ? null : Math.round(md.COG),
            sog: md.SOG == null ? null : +Number(md.SOG).toFixed(1),
            t: Date.now(),
          });
        }
      } catch (e) { /* ignore malformed frames */ }
    });
    const retry = () => {
      try { ws.close(); } catch (e) {}
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 120000);
    };
    ws.on('close', retry);
    ws.on('error', retry);
  }
  connect();

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of vessels) if (now - v.t > 180000) vessels.delete(k);
    shipsCache.t = now;
    shipsCache.source = 'aisstream';
    shipsCache.note = 'global live AIS';
    shipsCache.data = [...vessels.values()]
      .slice(0, 5000)
      .map((v) => [v.mmsi, v.name, v.lat, v.lon, v.cog, v.sog]);
  }, 10000);
  return true;
}

async function pollShipsFallback() {
  try {
    const j = await (
      await fetchTimeout('https://meri.digitraffic.fi/api/ais/v1/locations', 25000, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
    ).json();
    const feats = j.features || [];
    shipsCache.t = Date.now();
    shipsCache.source = 'digitraffic';
    shipsCache.note = 'regional (Baltic / North Europe) — set AISSTREAM_API_KEY for global';
    shipsCache.data = feats
      .map((f) => {
        const p = f.properties || {};
        const c = (f.geometry || {}).coordinates || [];
        return [
          p.mmsi,
          null,
          c[1] == null ? null : +Number(c[1]).toFixed(4),
          c[0] == null ? null : +Number(c[0]).toFixed(4),
          p.cog == null ? null : Math.round(p.cog),
          p.sog == null ? null : +Number(p.sog).toFixed(1),
        ];
      })
      .filter((s) => s[2] != null);
  } catch (e) {
    console.warn('[ships] digitraffic fallback failed: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* Satellites — CelesTrak TLE, propagated in the browser (satellite.js) */
/* ------------------------------------------------------------------ */

const tleCache = {
  stations: { t: 0, txt: '', fresh: false },
  visual: { t: 0, txt: '', fresh: false },
  starlink: { t: 0, txt: '', fresh: false },
};

// Bundled fallback: guarantees satellites render even if CelesTrak is
// unreachable from this host. Fresh data replaces it as soon as a poll succeeds.
const fs = require('fs');
for (const g of Object.keys(tleCache)) {
  try {
    const p = path.join(__dirname, 'data', 'tle-fallback', g + '.txt');
    const txt = fs.readFileSync(p, 'utf8');
    if (/^1 \d{5}/m.test(txt)) {
      tleCache[g] = { t: fs.statSync(p).mtimeMs, txt, fresh: false };
      console.log(`[tle] ${g}: fallback loaded (${(txt.match(/^1 /gm) || []).length} objects)`);
    }
  } catch (e) { console.warn('[tle] no fallback for ' + g); }
}

async function pollTLE(group) {
  try {
    const txt = await (
      await fetchTimeout(
        `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=TLE`,
        40000
      )
    ).text();
    if (/^1 \d{5}/m.test(txt)) {
      tleCache[group].t = Date.now();
      tleCache[group].txt = txt;
      tleCache[group].fresh = true;
      console.log(`[tle] ${group}: ${(txt.match(/^1 /gm) || []).length} objects`);
    }
  } catch (e) {
    console.warn('[tle] ' + group + ': ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/api/tle/:group', (req, res) => {
  const g = tleCache[req.params.group];
  if (!g || !g.txt) return res.status(503).type('text/plain').send('TLE not loaded yet');
  res.type('text/plain').send(g.txt);
});

app.get('/api/live', (req, res) => {
  res.json({
    now: Date.now(),
    flights: { t: flightsCache.t, ok: flightsCache.ok, source: flightsCache.source, n: flightsCache.data.length, data: flightsCache.data },
    ships: { t: shipsCache.t, source: shipsCache.source, note: shipsCache.note, n: shipsCache.data.length, data: shipsCache.data },
    quakes: { t: quakesCache.t, n: quakesCache.data.length, data: quakesCache.data },
  });
});

/* ------------------------------------------------------------------ */
/* Polling loops                                                        */
/* ------------------------------------------------------------------ */

const usingAISStream = startAISStream();
if (!usingAISStream) {
  console.log('[ships] no AISSTREAM_API_KEY — using Digitraffic regional fallback');
  pollShipsFallback();
  setInterval(pollShipsFallback, 60000);
}

pollFlights();
setInterval(pollFlights, 25000);
pollQuakes();
setInterval(pollQuakes, 5 * 60 * 1000);
for (const g of ['stations', 'visual', 'starlink']) {
  pollTLE(g);
  // Retry every 60s until a FRESH fetch succeeds (upstreams can be slow
  // or refuse a fresh IP at boot), then settle into the 6h refresh cadence.
  const retry = setInterval(() => {
    if (tleCache[g].fresh) { clearInterval(retry); setInterval(() => pollTLE(g), 6 * 60 * 60 * 1000); }
    else pollTLE(g);
  }, 60000);
}

app.listen(PORT, () => console.log('TerraLive listening on :' + PORT));

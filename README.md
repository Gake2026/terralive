# TerraLive 🌍

**Watch the living planet.** Every plane, ship and satellite on Earth — live on one 3D globe, in your browser, in under 10 seconds. No signup, no install.

TerraLive is an **original implementation** built from scratch. It is inspired by the *concept* of live planet-intelligence globes (e.g. bilawalsidhu/gods-eye-view) but shares no code with them.

## Quick start

```bash
npm install
node server.js        # serves http://localhost:3000
```

Optional: copy `.env.example` → `.env` (see below).

## How it works

A small Node backend polls free upstream APIs on a timer, caches them in memory, and serves **one** slim aggregated endpoint (`/api/live`) to browsers. This protects upstream providers from rate-limit spikes and keeps client payloads tiny (compact arrays, rounded coordinates, gzip).

Satellite positions are computed **in the browser** from CelesTrak TLE data using SGP4 (`satellite.js`) — no per-frame server cost.

```
browser ──/api/live──▶ Node cache-proxy ──poll──▶ adsb.lol / OpenSky
         ──/api/tle/*─▶                        ──poll──▶ CelesTrak
                                                    ──poll──▶ USGS
                                                    ──WS/poll─▶ AISStream / Digitraffic
```

## Data sources (all free)

| Layer | Source | Notes |
|---|---|---|
| Live flights | [adsb.lol](https://api.adsb.lol) v2 API (primary) | 5 overlapping regional queries stitched + deduped server-side (~6–9k aircraft). Keyless. |
| Live flights fallback | [OpenSky Network](https://opensky-network.org) | Used only if adsb.lol fails 3 cycles in a row. |
| Satellites | [CelesTrak](https://celestrak.org) TLE (`stations`, `visual`, `starlink` groups) | Propagated in-browser via SGP4 every 2.5s. Starlink shell decimated to ≤1400 objects for phones. |
| Ships (global) | [AISStream](https://aisstream.io) websocket | **Requires a free API key** (see below). Server-side only — the key never reaches the browser. |
| Ships (fallback) | [Digitraffic / Fintraffic](https://www.digitraffic.fi/en/marine-traffic/) AIS | Free, keyless, regional (Baltic / North Europe, ~1k vessels). Used automatically when no AISStream key is set. |
| Earthquakes | [USGS](https://earthquake.usgs.gov) GeoJSON feed (M2.5+, past day) | Free, keyless. |
| Basemap | Esri World Imagery (day) · CARTO dark_all (Night Ops) | Free tile endpoints with attribution. |
| Day/night terminator | Computed client-side from solar geometry | No API. |

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `PORT` | no (default 3000) | HTTP port. Render sets this automatically. |
| `AISSTREAM_API_KEY` | no | Free key from [aisstream.io](https://aisstream.io) → unlocks **global** live ships. Without it, ships fall back to the free regional Digitraffic feed. |

Get a free AISStream key: sign up at aisstream.io → dashboard → copy API key → set it as an env var on Render (never commit it).

## API endpoints

- `GET /healthz` — liveness probe (Render health check + keepalive target)
- `GET /api/live` — `{ flights, ships, quakes }` slim arrays + timestamps/sources
- `GET /api/tle/:group` — raw TLE text (`stations`, `visual`, `starlink`), cached 6h

## Deploy (Render free tier)

`render.yaml` is a one-click Blueprint: https://render.com/deploy?repo=https://github.com/Gake2026/terralive

Or manually: New → Web Service → connect the `terralive` repo → build `npm install`, start `node server.js`, plan **Free**, health check `/healthz`. Render auto-deploys on every push to `main`.

**Keepalive:** Render's free tier sleeps after ~15 min idle. A 10-minute cron pings `/healthz` to keep it warm (`terralive-keepalive`).

## Share links (the viral loop)

The ⤴ Share button serializes camera position, active layers, Night Ops mode and the currently tracked target into the URL hash, e.g.:

```
https://terralive.onrender.com/#c=28.613,77.209,4.5,0,0&ly=fsn&tr=flight:7609ef
```

Anyone opening the link lands on the exact same view and starts tracking the same target (if still in range).

## Performance notes

- Entity counts are capped/decimated: flights ≤9000, Starlink ≤1400, AISStream vessels ≤5000.
- Flights render as a single MapLibre symbol layer with `icon-allow-overlap` (one draw call class); satellites/ships are circle/symbol layers updated in place — no layer rebuilds.
- Satellite SGP4 runs at most every 2.5s (Starlink every 6s), not per frame.
- Append `?fps=1` to the URL for a live fps meter (desktop verification).
- Measured so far: architecture-level only — real-device fps still to be recorded via `?fps=1` on a phone.

## v2 roadmap (out of scope for v1)

- Voice Q&A control ("show me every 747 over Europe")
- Cockpit ride-along mode (camera glued to a flight)
- Public CCTV / webcam projections
- Historical replay scrubber
- More TLE groups (weather sats, debris toggle)

## Monetization slots

Two marked, currently hidden placeholder slots exist in `public/index.html` (`#ad-leaderboard`, `#ad-rail` — search for `ADSENSE-RESERVED`). No ad code is loaded in v1. To monetize: unhide the slots and paste AdSense units.

## License

Original code, all rights reserved. Data courtesy of the public sources above; basemap tiles © Esri / CARTO / OpenStreetMap contributors.

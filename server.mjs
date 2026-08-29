/* Enlil — backend Node.js zero-dipendenze (node server.mjs)
 *
 * Ruoli (v. clima.md):
 *  - proxy con cache su file per le fonti senza auth (NASA, HadCRUT5, Berkeley)
 *  - fetch Open-Meteo lato server con snapshot persistente su disco
 *  - endpoint NOAA CDO (richiede NOAA_TOKEN nell'ambiente o in .env)
 *  - endpoint ERA5: serve data/era5-grid.json prodotto da scripts/fetch_era5.py
 *
 * La logica di dominio (griglia, periodi, fetch/retry, Open-Meteo, NOAA) sta in
 * lib/core.mjs, condivisa con worker/index.js. Qui restano solo cache su file e
 * il server HTTP.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERIES,
  fetchWithRetry,
  buildGridPayload,
  noaaStationData,
} from "./lib/core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public"); // statici condivisi col deploy Cloudflare
const CACHE_DIR = path.join(ROOT, "data", "cache");
const ERA5_FILE = path.join(PUBLIC_DIR, "data", "era5-grid.json");
const OM_SEED_FILE = path.join(PUBLIC_DIR, "data", "om-grid-seed.json"); // fallback finale griglia OM
const OM_CLIMATOLOGY_FILE = path.join(PUBLIC_DIR, "data", "om-climatology-1961-1990.json");
const GRID_CACHE_TTL_MS = 12 * 3600 * 1000;
const SERIES_CACHE_TTL_MS = 24 * 3600 * 1000;

fs.mkdirSync(CACHE_DIR, { recursive: true });

// .env opzionale (formato CHIAVE=valore, una per riga)
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* .env assente: ok */ }

const NOAA_TOKEN = process.env.NOAA_TOKEN || "";

/* ---------------- Cache su file ---------------- */

function readCache(file, ttlMs) {
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age > ttlMs) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readStale(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/* Proxy con cache: serve la copia fresca se presente; altrimenti scarica e
 * salva; se l'upstream fallisce ma esiste una copia vecchia, serve quella. */
async function proxyCached(res, cacheName, ttlMs, url, contentType) {
  const file = path.join(CACHE_DIR, cacheName);
  const fresh = readCache(file, ttlMs);
  if (fresh !== null) return send(res, 200, fresh, contentType);
  try {
    const up = await fetchWithRetry(url);
    const body = await up.text();
    fs.writeFileSync(file, body);
    return send(res, 200, body, contentType);
  } catch (err) {
    const stale = readStale(file);
    if (stale !== null) {
      res.setHeader("X-Enlil-Stale", "1");
      return send(res, 200, stale, contentType);
    }
    return sendJson(res, 502, { error: String(err.message || err) });
  }
}

/* ---------------- Open-Meteo: griglia con snapshot ---------------- */

// medie climatologiche 1961-1990 per punto (asset precalcolato)
function loadClimatology() {
  return JSON.parse(fs.readFileSync(OM_CLIMATOLOGY_FILE, "utf8")).mean;
}

async function handleGrid(res) {
  const file = path.join(CACHE_DIR, "grid.json");
  const fresh = readCache(file, GRID_CACHE_TTL_MS);
  if (fresh !== null) return sendJson(res, 200, JSON.parse(fresh));
  try {
    const payload = await buildGridPayload(loadClimatology());
    fs.writeFileSync(file, JSON.stringify(payload));
    return sendJson(res, 200, payload);
  } catch (err) {
    const stale = readStale(file);
    if (stale !== null) {
      const payload = JSON.parse(stale);
      payload.stale = true;
      return sendJson(res, 200, payload);
    }
    // ultimo livello: snapshot statico committato nel repo
    const seed = readStale(OM_SEED_FILE);
    if (seed !== null) {
      const payload = JSON.parse(seed);
      payload.stale = true;
      payload.seed = true;
      return sendJson(res, 200, payload);
    }
    return sendJson(res, 503, {
      error: `Open-Meteo non raggiungibile e nessuno snapshot disponibile: ${err.message}`,
    });
  }
}

/* ---------------- NOAA CDO (richiede NOAA_TOKEN) ---------------- */

async function handleNoaaStation(res, url) {
  if (!NOAA_TOKEN) {
    return sendJson(res, 501, {
      error: "NOAA_TOKEN non configurato. Richiedi il token gratuito su https://www.ncei.noaa.gov/cdo-web/token e avvia il server con NOAA_TOKEN=... (o in .env).",
    });
  }
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const { status, body } = await noaaStationData(NOAA_TOKEN, lat, lon);
  return sendJson(res, status, body);
}

/* ---------------- ERA5: serve il JSON prodotto da scripts/fetch_era5.py ---------------- */

function handleEra5(res) {
  const body = readStale(ERA5_FILE);
  if (body === null) {
    return sendJson(res, 501, {
      error: "ERA5 non ancora generato. Configura il token Copernicus CDS in ~/.cdsapirc, accetta la licenza del dataset reanalysis-era5-single-levels-monthly-means e lancia scripts/fetch_era5.py.",
    });
  }
  return send(res, 200, body, "application/json");
}

/* ---------------- Static file serving ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".csv": "text/csv; charset=utf-8",
};

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, content) => {
    if (err) return sendJson(res, 404, { error: "Not found" });
    // index.html sempre rivalidato; gli altri asset cacheabili 1h
    const isHtml = path.extname(file) === ".html";
    res.setHeader("Cache-Control", isHtml ? "no-cache" : "public, max-age=3600");
    send(res, 200, content, MIME[path.extname(file)] || "application/octet-stream");
  });
}

/* ---------------- Helpers risposta ---------------- */

function send(res, status, body, contentType) {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8");
}

/* ---------------- Router ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    switch (url.pathname) {
      case "/api/health":
        return sendJson(res, 200, {
          ok: true,
          providers: { noaa: Boolean(NOAA_TOKEN), era5: fs.existsSync(ERA5_FILE) },
        });
      case "/api/grid":
        return await handleGrid(res);
      case "/api/gistemp":
        return await proxyCached(res, "gistemp.csv", SERIES_CACHE_TTL_MS, SERIES.gistemp, "text/csv; charset=utf-8");
      case "/api/hadcrut5":
        return await proxyCached(res, "hadcrut5.csv", SERIES_CACHE_TTL_MS, SERIES.hadcrut5, "text/csv; charset=utf-8");
      case "/api/berkeley":
        return await proxyCached(res, "berkeley.txt", SERIES_CACHE_TTL_MS, SERIES.berkeley, "text/plain; charset=utf-8");
      case "/api/noaa/station-data":
        return await handleNoaaStation(res, url);
      case "/api/era5":
        return handleEra5(res);
      default:
        return serveStatic(res, url.pathname);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Enlil attivo su http://localhost:${PORT}`);
  console.log(`NOAA CDO: ${NOAA_TOKEN ? "token presente" : "NON configurato (endpoint disabilitato)"}`);
  console.log(`ERA5: ${fs.existsSync(ERA5_FILE) ? "data/era5-grid.json presente" : "da generare con scripts/fetch_era5.py"}`);
});

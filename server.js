/* Enlil — backend Node.js zero-dipendenze (node server.js)
 *
 * Ruoli (v. clima.md):
 *  - proxy con cache su file per le fonti senza auth (NASA, HadCRUT5, Berkeley)
 *  - fetch Open-Meteo lato server con snapshot persistente su disco
 *  - endpoint NOAA CDO (richiede NOAA_TOKEN nell'ambiente o in .env)
 *  - endpoint ERA5: serve data/era5-grid.json prodotto da scripts/fetch_era5.py
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public"); // statici condivisi col deploy Cloudflare
const CACHE_DIR = path.join(ROOT, "data", "cache");
const ERA5_FILE = path.join(PUBLIC_DIR, "data", "era5-grid.json");
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

/* ---------------- Griglia e periodi (specchio del frontend) ---------------- */

function buildGrid() {
  // lon < 180: +180 e -180 sono lo stesso meridiano. 17 lat x 18 lon = 306.
  const pts = [];
  for (let lat = -80; lat <= 80; lat += 10) {
    for (let lon = -180; lon < 180; lon += 20) pts.push({ lat, lon });
  }
  return pts;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function buildPeriods() {
  const end = new Date();
  end.setDate(end.getDate() - 7); // l'archivio ha ~5 giorni di ritardo
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  const baseEnd = new Date(end);
  baseEnd.setFullYear(baseEnd.getFullYear() - 40);
  const baseStart = new Date(start);
  baseStart.setFullYear(baseStart.getFullYear() - 40);
  return {
    recent: { start: fmtDate(start), end: fmtDate(end) },
    baseline: { start: fmtDate(baseStart), end: fmtDate(baseEnd) },
  };
}

/* ---------------- Utility fetch/cache ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, { headers = {}, retries = 4 } = {}) {
  // alcuni upstream (es. NASA GISS) rispondono 403 allo User-Agent di Node:
  // ci presentiamo con un UA browser-like per tutte le chiamate in uscita
  const finalHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Enlil/1.0",
    ...headers,
  };
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch(url, { headers: finalHeaders, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res;
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 5000 * (attempt + 1);
      console.warn(`429 da ${new URL(url).host}, riprovo tra ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Upstream HTTP ${res.status} per ${new URL(url).host}`);
  }
}

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

const OM_CHUNK_SIZE = 100;
const OM_CHUNK_DELAY_MS = 1500;

async function fetchGridMeans(grid, period) {
  const means = [];
  for (let i = 0; i < grid.length; i += OM_CHUNK_SIZE) {
    const chunk = grid.slice(i, i + OM_CHUNK_SIZE);
    const params = new URLSearchParams({
      latitude: chunk.map((p) => p.lat).join(","),
      longitude: chunk.map((p) => p.lon).join(","),
      start_date: period.start,
      end_date: period.end,
      daily: "temperature_2m_mean",
    });
    const up = await fetchWithRetry(`https://archive-api.open-meteo.com/v1/archive?${params}`);
    const data = await up.json();
    const locations = Array.isArray(data) ? data : [data];
    for (const loc of locations) {
      const vals = (loc.daily?.temperature_2m_mean || []).filter((v) => v !== null);
      means.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
    }
    if (i + OM_CHUNK_SIZE < grid.length) await sleep(OM_CHUNK_DELAY_MS);
  }
  return means;
}

async function handleGrid(res) {
  const file = path.join(CACHE_DIR, "grid.json");
  const fresh = readCache(file, GRID_CACHE_TTL_MS);
  if (fresh !== null) return sendJson(res, 200, JSON.parse(fresh));
  try {
    const grid = buildGrid();
    const periods = buildPeriods();
    const recent = await fetchGridMeans(grid, periods.recent);
    const baseline = await fetchGridMeans(grid, periods.baseline);
    const payload = { fetchedAt: new Date().toISOString(), periods, grid, recent, baseline };
    fs.writeFileSync(file, JSON.stringify(payload));
    return sendJson(res, 200, payload);
  } catch (err) {
    const stale = readStale(file);
    if (stale !== null) {
      const payload = JSON.parse(stale);
      payload.stale = true;
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
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return sendJson(res, 400, { error: "Parametri lat/lon mancanti o non validi" });
  }
  const h = { token: NOAA_TOKEN };
  const extent = `${(lat - 1).toFixed(2)},${(lon - 1).toFixed(2)},${(lat + 1).toFixed(2)},${(lon + 1).toFixed(2)}`;
  const stRes = await fetchWithRetry(
    `https://www.ncei.noaa.gov/cdo-web/api/v2/stations?datasetid=GHCND&extent=${extent}&limit=25`,
    { headers: h }
  );
  const stations = ((await stRes.json()).results || []).filter((s) => {
    // scarta stazioni chiuse da anni (es. MILAN: maxdate 2008); alcune reti
    // nazionali hanno un ritardo di ~1 anno su CDO (es. Italia: ago 2025)
    return s.maxdate && s.maxdate >= fmtDate(new Date(Date.now() - 3 * 365 * 86400000));
  });
  if (!stations.length) {
    return sendJson(res, 404, { error: "Nessuna stazione GHCND con dati recenti entro 1° dal punto" });
  }

  // distanza equirettangolare approssimata (sufficiente per pochi gradi)
  const dist = (s) => {
    const dLat = (s.latitude - lat) * 111;
    const dLon = (s.longitude - lon) * 111 * Math.cos((lat * Math.PI) / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  };
  const st = stations.reduce((a, b) => (dist(a) <= dist(b) ? a : b));

  // periodo = ultimi 12 mesi DISPONIBILI per la stazione (ancorati a maxdate,
  // non a oggi: altrimenti le stazioni in ritardo darebbero serie vuote)
  const endD = new Date(Math.min(Date.now(), new Date(st.maxdate).getTime()));
  const startD = new Date(endD);
  startD.setFullYear(startD.getFullYear() - 1);
  const end = fmtDate(endD);
  const dataRes = await fetchWithRetry(
    `https://www.ncei.noaa.gov/cdo-web/api/v2/data?datasetid=GHCND&stationid=${st.id}` +
      `&datatypeid=TAVG&datatypeid=TMAX&datatypeid=TMIN&startdate=${fmtDate(startD)}&enddate=${end}&limit=1000&units=metric`,
    { headers: h }
  );
  const rows = (await dataRes.json()).results || [];
  const avg = (type) => {
    const v = rows.filter((r) => r.datatype === type).map((r) => r.value);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  return sendJson(res, 200, {
    station: { id: st.id, name: st.name, distanceKm: Math.round(dist(st)) },
    period: { start: fmtDate(startD), end },
    tavg: avg("TAVG"), tmax: avg("TMAX"), tmin: avg("TMIN"),
  });
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
        return await proxyCached(
          res, "gistemp.csv", SERIES_CACHE_TTL_MS,
          "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv",
          "text/csv; charset=utf-8"
        );
      case "/api/hadcrut5":
        return await proxyCached(
          res, "hadcrut5.csv", SERIES_CACHE_TTL_MS,
          "https://www.metoffice.gov.uk/hadobs/hadcrut5/data/HadCRUT.5.1.0.0/analysis/diagnostics/HadCRUT.5.1.0.0.analysis.summary_series.global.monthly.csv",
          "text/csv; charset=utf-8"
        );
      case "/api/berkeley":
        return await proxyCached(
          res, "berkeley.txt", SERIES_CACHE_TTL_MS,
          "https://berkeley-earth-temperature.s3.amazonaws.com/Global/Land_and_Ocean_summary.txt",
          "text/plain; charset=utf-8"
        );
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

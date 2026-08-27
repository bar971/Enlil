/* Enlil — mappa climatica mondiale
 *
 * Due modalità (v. clima.md):
 *  - con backend (`node server.js`): le fonti passano dal proxy con cache
 *    (/api/grid, /api/gistemp, /api/hadcrut5, /api/berkeley, /api/era5, /api/noaa)
 *  - senza backend (file:// o hosting statico): fetch diretti Open-Meteo e
 *    snapshot NASA embedded in data/gistemp.js
 */

const PROVIDERS = {
  openMeteo: { enabled: true, url: "https://archive-api.open-meteo.com/v1/archive" },
  gistemp:   { enabled: true },
  era5:      { enabled: true, url: "/api/era5" },
};

/* Rilevamento backend: se la pagina è servita da server.js, /api/health
 * risponde con lo stato dei provider (noaa: token presente, era5: JSON pronto). */
let backend = null; // { noaa: boolean, era5: boolean } | null
async function detectBackend() {
  try {
    const res = await fetch("/api/health", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()).providers || {};
  } catch {
    return null;
  }
}

/* ---------------- Mappa ---------------- */

const map = L.map("map", { worldCopyJump: true }).setView([20, 0], 2);
// Basemap geo-politica Esri World Dark Gray: confini e nomi degli stati
// (i nomi compaiono automaticamente ai livelli di zoom in cui sono leggibili).
// Nota: CARTO basemaps è stata scartata perché ora mostra un watermark
// "API KEY REQUIRED" su ogni tile senza chiave.
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 12,
    attribution:
      'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community',
  }
).addTo(map);

const legend = L.control({ position: "bottomright" });
legend.onAdd = () => {
  const div = L.DomUtil.create("div", "legend");
  div.innerHTML =
    '<div class="bar"></div>' +
    "ΔT ultimi 12 mesi<br>vs 40 anni fa (°C): 0 → ≥ +3";
  return div;
};
legend.addTo(map);

const statusEl = document.getElementById("map-status");
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

/* Griglia di punti sul globo: lat -80..80 passo 10, lon -180..180 passo 20 */
function buildGrid() {
  const pts = [];
  for (let lat = -80; lat <= 80; lat += 10) {
    for (let lon = -180; lon <= 180; lon += 20) {
      pts.push({ lat, lon });
    }
  }
  return pts;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* Open-Meteo free tier: ogni location di una richiesta batch conta come
 * chiamata ai fini dei limiti (~600/min, 10.000/giorno). La griglia da 323
 * punti x 2 periodi = ~646 chiamate a caricamento: senza cautele si sfora.
 * Mitigazioni: chunking da 100 con pausa tra richieste, retry con backoff
 * su HTTP 429, e cache in localStorage (i ricaricamenti non costano nulla). */
const CHUNK_SIZE = 100;
const CHUNK_DELAY_MS = 1500;
const CACHE_TTL_MS = 12 * 3600 * 1000;

async function fetchJsonWithRetry(url, label) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < 4) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 5000 * (attempt + 1);
      setStatus(
        `Open-Meteo: limite richieste raggiunto (${label}), riprovo tra ${Math.round(wait / 1000)}s…`
      );
      await sleep(wait);
      continue;
    }
    throw new Error(`Open-Meteo HTTP ${res.status}`);
  }
}

async function fetchGridMeans(grid, period, label) {
  const allMeans = [];
  const chunks = [];
  for (let i = 0; i < grid.length; i += CHUNK_SIZE) {
    chunks.push(grid.slice(i, i + CHUNK_SIZE));
  }
  for (let i = 0; i < chunks.length; i++) {
    const params = new URLSearchParams({
      latitude: chunks[i].map((p) => p.lat).join(","),
      longitude: chunks[i].map((p) => p.lon).join(","),
      start_date: period.start,
      end_date: period.end,
      daily: "temperature_2m_mean",
    });
    const data = await fetchJsonWithRetry(
      `${PROVIDERS.openMeteo.url}?${params}`,
      `${label} ${i + 1}/${chunks.length}`
    );
    const locations = Array.isArray(data) ? data : [data];
    // media sul periodo per location, ignorando eventuali null;
    // l'ordine della risposta segue l'ordine delle coordinate inviate
    allMeans.push(
      ...locations.map((loc) => {
        const vals = (loc.daily?.temperature_2m_mean || []).filter((v) => v !== null);
        if (!vals.length) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      })
    );
    if (i < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
  }
  return allMeans;
}

/* Cache in localStorage: chiave legata ai periodi, TTL 12h. Se la quota
 * giornaliera Open-Meteo è esaurita, i dati già scaricati restano usabili. */
function loadCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function saveCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    /* quota localStorage piena o non disponibile: si prosegue senza cache */
  }
}

/* Ultimi 12 mesi completi (l'archivio ha ~5 giorni di ritardo) e la stessa
 * finestra di 40 anni prima, usata come baseline di confronto. */
function buildPeriods() {
  const end = new Date();
  end.setDate(end.getDate() - 7);
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

async function loadOpenMeteoLayer() {
  let grid, periods, recentMeans, baselineMeans, source;

  if (backend !== null) {
    // Modalità backend: griglia + snapshot gestiti da server.js
    setStatus("Richiedo la griglia di temperature al backend locale…");
    const res = await fetch("/api/grid");
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `Backend HTTP ${res.status}`);
    grid = payload.grid;
    periods = payload.periods;
    recentMeans = payload.recent;
    baselineMeans = payload.baseline;
    source = payload.stale
      ? "snapshot backend (datato: quota Open-Meteo esaurita)"
      : "backend locale";
  } else {
    // Modalità standalone: fetch diretto con cache in localStorage
    grid = buildGrid();
    periods = buildPeriods();
    const cacheKey = `enlil-openmeteo|${periods.recent.start}|${periods.recent.end}`;
    const cached = loadCache(cacheKey);
    if (cached) {
      recentMeans = cached.recent;
      baselineMeans = cached.baseline;
      source = "cache locale";
    } else {
      setStatus("Scarico temperature recenti e baseline da Open-Meteo…");
      // sequenziali (non parallele) per dimezzare il burst di chiamate
      recentMeans = await fetchGridMeans(grid, periods.recent, "periodo recente");
      baselineMeans = await fetchGridMeans(grid, periods.baseline, "baseline");
      saveCache(cacheKey, { recent: recentMeans, baseline: baselineMeans });
      source = "Open-Meteo (fetch diretto)";
    }
  }

  const heatPoints = [];
  const markerLayer = L.layerGroup();
  let valid = 0;

  grid.forEach((p, i) => {
    const r = recentMeans[i];
    const b = baselineMeans[i];
    if (r === null || b === null || r === undefined || b === undefined) return;
    const delta = r - b;
    valid++;
    // intensità 0..1 su scala 0..+3 °C (raffreddamenti clampati a 0)
    heatPoints.push([p.lat, p.lon, Math.min(Math.max(delta / 3, 0), 1)]);
    L.circleMarker([p.lat, p.lon], {
      radius: 6,
      color: delta >= 0 ? "#d7301f" : "#2c7fb0",
      fillOpacity: 0.7,
      weight: 1,
      bubblingMouseEvents: false, // il click sul marker non deve attivare la query NOAA
    })
      .bindPopup(
        `<b>Punto ${p.lat}°, ${p.lon}°</b>` +
          `<div class="popup-row"><span class="lbl">Temperatura media degli ultimi 12 mesi<br>` +
          `(${periods.recent.start} → ${periods.recent.end})</span>` +
          `<span class="val">${r.toFixed(1)} °C</span></div>` +
          `<div class="popup-row"><span class="lbl">Temperatura media dello stesso periodo, 40 anni fa<br>` +
          `(${periods.baseline.start} → ${periods.baseline.end})</span>` +
          `<span class="val">${b.toFixed(1)} °C</span></div>` +
          `<div class="popup-row"><span class="lbl">ΔT: di quanto si è scaldato questo punto in 40 anni</span>` +
          `<span class="val">${delta >= 0 ? "+" : ""}${delta.toFixed(2)} °C</span></div>`
      )
      .addTo(markerLayer);
  });

  L.heatLayer(heatPoints, {
    radius: 40,
    blur: 30,
    maxZoom: 5,
    gradient: { 0: "#2c7fb0", 0.4: "#fee08b", 0.7: "#fc8d59", 1: "#d7301f" },
  }).addTo(map);
  markerLayer.addTo(map);

  setStatus(
    `${valid} punti caricati (${source}). ` +
      `Periodo recente: ${periods.recent.start} → ${periods.recent.end}; ` +
      `baseline: ${periods.baseline.start} → ${periods.baseline.end}. Clicca un punto per i dettagli.`
  );
}

/* ERA5 (clima.md §4): server.js espone /api/era5 leggendo data/era5-grid.json
 * generato da scripts/fetch_era5.py. Se il file non esiste (501) non si
 * mostra nulla e non è un errore. */
async function loadEra5Layer() {
  if (!PROVIDERS.era5.enabled || backend === null || !backend.era5) return;
  const res = await fetch(PROVIDERS.era5.url);
  if (!res.ok) return;
  const gridJson = await res.json(); // [{lat, lon, anomaly}, ...]
  L.heatLayer(
    gridJson.map((g) => [g.lat, g.lon, Math.min(Math.max(g.anomaly / 3, 0), 1)]),
    { radius: 40, blur: 30, gradient: { 0: "#2c7fb0", 0.4: "#fee08b", 0.7: "#fc8d59", 1: "#d7301f" } }
  ).addTo(map);
}

/* NOAA CDO (clima.md §2): click sulla mappa (fuori dai marker) → dati della
 * stazione GHCND più vicina. Attivo solo con backend + NOAA_TOKEN. */
map.on("click", async (e) => {
  if (backend === null || !backend.noaa) return;
  const popup = L.popup()
    .setLatLng(e.latlng)
    .setContent("Interrogo NOAA CDO…")
    .openOn(map);
  try {
    const res = await fetch(
      `/api/noaa/station-data?lat=${e.latlng.lat.toFixed(2)}&lon=${e.latlng.lng.toFixed(2)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const fmtVal = (v) => (v === null ? "n/d" : `${v.toFixed(1)} °C`);
    popup.setContent(
      `<b>Stazione NOAA più vicina</b><br>` +
        `${data.station.name} <small>(${data.station.id})</small><br>` +
        `Media ultimo anno (${data.period.start} → ${data.period.end}):<br>` +
        `TAVG: <b>${fmtVal(data.tavg)}</b> · TMAX: ${fmtVal(data.tmax)} · TMIN: ${fmtVal(data.tmin)}`
    );
  } catch (err) {
    popup.setContent(`NOAA CDO: ${err.message}`);
  }
});

/* ---------------- Grafico serie storiche globali ---------------- */

function parseGistemp(csv) {
  // formato: riga 1 titolo, riga 2 intestazione, poi "Year,Jan,...,J-D,..."
  return csv
    .trim()
    .split("\n")
    .slice(2)
    .map((line) => line.split(","))
    .filter((cols) => cols[0] && /^\d{4}$/.test(cols[0]) && cols[13] && cols[13] !== "***")
    .map((cols) => ({ year: Number(cols[0]), anomaly: Number(cols[13]) }));
}

function parseHadcrut5(csv) {
  // Time,Anomaly,lower,upper — mensile dal 1850; aggrega in media annuale
  // (solo anni con 12 mesi completi)
  const byYear = {};
  csv.trim().split("\n").slice(1).forEach((line) => {
    const cols = line.split(",");
    const v = Number(cols[1]);
    if (!cols[0] || !Number.isFinite(v)) return;
    const year = Number(cols[0].slice(0, 4));
    (byYear[year] = byYear[year] || []).push(v);
  });
  return Object.entries(byYear)
    .filter(([, v]) => v.length === 12)
    .map(([y, v]) => ({ year: Number(y), anomaly: v.reduce((a, b) => a + b, 0) / v.length }));
}

function parseBerkeley(txt) {
  // TXT whitespace-separated: Year, Annual Anomaly, ... (righe di commento con %)
  return txt
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("%"))
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => /^\d{4}$/.test(c[0]) && Number.isFinite(Number(c[1])))
    .map((c) => ({ year: Number(c[0]), anomaly: Number(c[1]) }));
}

async function renderChart() {
  const datasets = [];
  const toMap = (series) => new Map(series.map((d) => [d.year, d.anomaly]));
  const seriesList = [];

  // GISTEMP: CSV live dal proxy backend, altrimenti snapshot embedded
  let gistempCsv = GISTEMP_CSV;
  if (backend !== null) {
    try {
      const res = await fetch("/api/gistemp");
      if (res.ok) gistempCsv = await res.text();
    } catch { /* resta lo snapshot */ }
  }
  seriesList.push({ label: "NASA GISTEMP", series: parseGistemp(gistempCsv), color: "#fc8d59" });

  // HadCRUT5 e Berkeley Earth: solo con backend (proxy, niente CORS)
  if (backend !== null) {
    const extra = [
      { url: "/api/hadcrut5", label: "HadCRUT5", color: "#4dbbd5", parse: parseHadcrut5 },
      { url: "/api/berkeley", label: "Berkeley Earth", color: "#a3d977", parse: parseBerkeley },
    ];
    for (const src of extra) {
      try {
        const res = await fetch(src.url);
        if (!res.ok) continue;
        seriesList.push({ label: src.label, series: src.parse(await res.text()), color: src.color });
      } catch { /* fonte non disponibile: si salta */ }
    }
  }

  // asse X = unione degli anni di tutte le serie
  const years = [...new Set(seriesList.flatMap((s) => s.series.map((d) => d.year)))].sort((a, b) => a - b);
  for (const s of seriesList) {
    const m = toMap(s.series);
    datasets.push({
      label: s.label,
      data: years.map((y) => m.get(y) ?? null),
      borderColor: s.color,
      pointRadius: 0,
      borderWidth: 1.5,
      spanGaps: false,
    });
  }
  datasets[0].fill = true;
  datasets[0].backgroundColor = "rgba(252,141,89,0.15)";

  new Chart(document.getElementById("gistemp-chart"), {
    type: "line",
    data: { labels: years, datasets },
    options: {
      scales: {
        x: { ticks: { color: "#9aa7b5", maxTicksLimit: 15 }, grid: { color: "#232c38" } },
        y: { ticks: { color: "#9aa7b5" }, grid: { color: "#232c38" }, title: { display: true, text: "Anomalia (°C)", color: "#9aa7b5" } },
      },
      plugins: { legend: { labels: { color: "#cdd6e0" } } },
    },
  });
}

/* ---------------- Avvio ---------------- */

// Grafico: renderizzato lazy alla prima apertura (Chart.js ha bisogno del
// canvas visibile per calcolare le dimensioni corrette)
let chartRendered = false;
const toggleBtn = document.getElementById("toggle-chart");
toggleBtn.addEventListener("click", () => {
  const sec = document.getElementById("chart-section");
  const show = sec.hidden;
  sec.hidden = !show;
  toggleBtn.textContent = show
    ? "Nascondi serie storiche globali"
    : "Mostra serie storiche globali (GISTEMP · HadCRUT5 · Berkeley Earth)";
  if (show && !chartRendered && PROVIDERS.gistemp.enabled) {
    chartRendered = true;
    renderChart().catch((err) => setStatus(`Errore grafico: ${err.message}`, true));
  }
});

(async () => {
  backend = await detectBackend();
  const jobs = [];
  if (PROVIDERS.openMeteo.enabled) {
    jobs.push(
      loadOpenMeteoLayer().catch((err) => setStatus(`Errore Open-Meteo: ${err.message}`, true))
    );
  }
  jobs.push(loadEra5Layer().catch(() => { /* ERA5 assente: nessun errore in UI */ }));
  await Promise.all(jobs);
})();

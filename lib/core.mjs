/* Enlil — logica condivisa fra server.mjs (Node) e worker/index.js (Cloudflare).
 *
 * Vincolo: solo API standard (fetch, AbortSignal, URL, URLSearchParams, console).
 * Nessun import da `node:` — così il bundle del Worker non richiede nodejs_compat.
 *
 * NB: public/app.js resta uno script classico (la modalità standalone `file://`
 * non carica moduli ES) e tiene copie inline di buildGrid/buildPeriods/fmtDate;
 * un test di sync (test/) verifica che restino allineate.
 */

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Enlil/1.0" };

export const OM_CHUNK_SIZE = 100;
export const OM_CHUNK_DELAY_MS = 1500;

// Serie storiche globali: chiave (KV / nome file) -> URL upstream.
export const SERIES = {
  gistemp: "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv",
  hadcrut5:
    "https://www.metoffice.gov.uk/hadobs/hadcrut5/data/HadCRUT.5.1.0.0/analysis/diagnostics/HadCRUT.5.1.0.0.analysis.summary_series.global.monthly.csv",
  berkeley: "https://berkeley-earth-temperature.s3.amazonaws.com/Global/Land_and_Ocean_summary.txt",
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Griglia e periodi ---------------- */

export function buildGrid() {
  // lon < 180: +180 e -180 sono lo stesso meridiano. 17 lat x 18 lon = 306.
  const pts = [];
  for (let lat = -80; lat <= 80; lat += 10) {
    for (let lon = -180; lon < 180; lon += 20) pts.push({ lat, lon });
  }
  return pts;
}

export function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/* Ultimi 12 mesi completi (l'archivio ha ~5 giorni di ritardo) e la stessa
 * finestra di 40 anni prima, usata come baseline di confronto. */
export function buildPeriods() {
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

/* ---------------- Fetch con retry ---------------- */

/* UA browser-like (NASA GISS risponde 403 allo UA di Node/undici) + timeout
 * esplicito (un upstream che pende consuma il budget del runtime). Retry con
 * backoff solo su HTTP 429; ogni altro esito !ok viene propagato. */
export async function fetchWithRetry(url, { headers = {}, retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(60000) });
    if (res.ok) return res;
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1);
      console.warn(`429 da ${new URL(url).host}, riprovo tra ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Upstream HTTP ${res.status} per ${new URL(url).host}`);
  }
}

/* ---------------- Open-Meteo: medie per punto della griglia ---------------- */

/* Open-Meteo free tier: ogni location di una richiesta batch conta come
 * chiamata (~600/min, 10.000/giorno). 306 punti x 2 periodi ≈ 612 chiamate:
 * chunking da 100 con pausa tra le richieste. */
export async function fetchGridMeans(grid, period) {
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

/* Payload completo della griglia (oggetto, non stringa: il caller serializza). */
export async function buildGridPayload() {
  const grid = buildGrid();
  const periods = buildPeriods();
  const recent = await fetchGridMeans(grid, periods.recent);
  const baseline = await fetchGridMeans(grid, periods.baseline);
  return { fetchedAt: new Date().toISOString(), periods, grid, recent, baseline };
}

/* ---------------- NOAA CDO: stazione GHCND più vicina ---------------- */

/* Dato un token e un punto, restituisce { status, body } dove body è già
 * l'oggetto JSON di risposta. status 200 = ok, 400/404 = errore atteso.
 * Il token va verificato dal caller (messaggio di config diverso per
 * server / Worker); qui si assume presente. */
export async function noaaStationData(token, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { status: 400, body: { error: "Parametri lat/lon mancanti o non validi" } };
  }
  const h = { token };
  // clamp ai limiti geografici: vicino a poli/antimeridiano lat±1 / lon±1
  // uscirebbe da [-90,90] / [-180,180] e CDO risponderebbe 400
  const clampLat = (v) => Math.max(-90, Math.min(90, v));
  const clampLon = (v) => Math.max(-180, Math.min(180, v));
  const extent = `${clampLat(lat - 1).toFixed(2)},${clampLon(lon - 1).toFixed(2)},${clampLat(lat + 1).toFixed(2)},${clampLon(lon + 1).toFixed(2)}`;
  const stRes = await fetchWithRetry(
    `https://www.ncei.noaa.gov/cdo-web/api/v2/stations?datasetid=GHCND&extent=${extent}&limit=25`,
    { headers: h }
  );
  // scarta stazioni chiuse da anni (es. MILAN: maxdate 2008); alcune reti
  // nazionali hanno ~1 anno di ritardo su CDO (es. Italia: ago 2025)
  const stations = ((await stRes.json()).results || []).filter(
    (s) => s.maxdate && s.maxdate >= fmtDate(new Date(Date.now() - 3 * 365 * 86400000))
  );
  if (!stations.length) {
    return { status: 404, body: { error: "Nessuna stazione GHCND con dati recenti entro 1° dal punto" } };
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
  // 3 datatype x 365 giorni possono superare 1000 record: CDO li restituisce
  // in ordine di data crescente, quindi troncare a 1000 sbilancerebbe la media
  // verso i primi mesi. Si pagina con offset (1-based) fino a esaurimento.
  const base =
    `https://www.ncei.noaa.gov/cdo-web/api/v2/data?datasetid=GHCND&stationid=${st.id}` +
    `&datatypeid=TAVG&datatypeid=TMAX&datatypeid=TMIN&startdate=${fmtDate(startD)}&enddate=${end}&units=metric&limit=1000`;
  const rows = [];
  for (let offset = 1; offset <= 5000; offset += 1000) {
    const dataRes = await fetchWithRetry(`${base}&offset=${offset}`, { headers: h });
    const batch = (await dataRes.json()).results || [];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  const avg = (type) => {
    const v = rows.filter((r) => r.datatype === type).map((r) => r.value);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  return {
    status: 200,
    body: {
      station: { id: st.id, name: st.name, distanceKm: Math.round(dist(st)) },
      period: { start: fmtDate(startD), end },
      tavg: avg("TAVG"), tmax: avg("TMAX"), tmin: avg("TMIN"),
    },
  };
}

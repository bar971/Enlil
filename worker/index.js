/* Enlil — Cloudflare Worker
 *
 * Port di server.js (Node) per l'edge:
 *  - statici serviti dal binding ASSETS (cartella public/, condivisa col server locale)
 *  - cache su KV (ENLIL_CACHE) al posto del filesystem
 *  - NOAA_TOKEN come secret del Worker (mai nel frontend)
 */

const GRID_TTL_S = 12 * 3600;
const SERIES_TTL_S = 24 * 3600;

// Cache HTTP all'edge/nel browser: risposte fresche cacheabili 5 min, poi
// servibili "stale" per 1h mentre si rivalida. Per le risposte già stale si
// usa una finestra corta così tornano presto a rivalidarsi.
const CACHE_FRESH = "public, max-age=300, stale-while-revalidate=3600";
const CACHE_STALE = "public, max-age=60";
const NO_STORE = "no-store";

// Serie storiche globali: chiave KV -> URL upstream. Usato dal proxy e dal cron.
const SERIES = {
  gistemp: "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv",
  hadcrut5:
    "https://www.metoffice.gov.uk/hadobs/hadcrut5/data/HadCRUT.5.1.0.0/analysis/diagnostics/HadCRUT.5.1.0.0.analysis.summary_series.global.monthly.csv",
  berkeley: "https://berkeley-earth-temperature.s3.amazonaws.com/Global/Land_and_Ocean_summary.txt",
};

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Enlil/1.0" };

// KV put con timestamp nei metadata (formato condiviso da proxy, grid e cron)
const kvPut = (env, key, body) =>
  env.ENLIL_CACHE.put(key, body, { metadata: { ts: Math.floor(Date.now() / 1000) } });

/* ---------------- Griglia e periodi (specchio di server.js e del frontend) ---------------- */

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

/* ---------------- Utility ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });

async function fetchWithRetry(url, { headers = {}, retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    // timeout esplicito: senza, un upstream che pende consuma il budget del Worker
    const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(60000) });
    if (res.ok) return res;
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 5000 * (attempt + 1);
      await sleep(wait);
      continue;
    }
    throw new Error(`Upstream HTTP ${res.status} per ${new URL(url).host}`);
  }
}

/* KV cache: valore + timestamp in metadata. Se l'upstream fallisce ma esiste
 * una copia vecchia, viene servita con header X-Enlil-Stale. */
async function proxyCached(env, key, ttlS, url, ctx) {
  const CT = "text/plain; charset=utf-8";
  const cached = await env.ENLIL_CACHE.getWithMetadata(key);
  if (cached.value !== null && cached.metadata?.ts && Date.now() / 1000 - cached.metadata.ts < ttlS) {
    return new Response(cached.value, { headers: { "Content-Type": CT, "Cache-Control": CACHE_FRESH } });
  }
  try {
    const up = await fetchWithRetry(url);
    const body = await up.text();
    // scrittura KV in background: non blocca la risposta
    ctx.waitUntil(kvPut(env, key, body));
    return new Response(body, { headers: { "Content-Type": CT, "Cache-Control": CACHE_FRESH } });
  } catch (err) {
    if (cached.value !== null) {
      return new Response(cached.value, {
        headers: { "Content-Type": CT, "Cache-Control": CACHE_STALE, "X-Enlil-Stale": "1" },
      });
    }
    return json({ error: String(err.message || err) }, 502);
  }
}

/* ---------------- Open-Meteo: griglia con snapshot in KV ---------------- */

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

/* Costruisce il payload della griglia (fetch Open-Meteo per i due periodi).
 * Separato da handleGrid così lo riusa anche il cron (refreshGrid). */
async function buildGridPayload() {
  const grid = buildGrid();
  const periods = buildPeriods();
  const recent = await fetchGridMeans(grid, periods.recent);
  const baseline = await fetchGridMeans(grid, periods.baseline);
  return JSON.stringify({ fetchedAt: new Date().toISOString(), periods, grid, recent, baseline });
}

async function handleGrid(env, ctx) {
  const CT = "application/json";
  const cached = await env.ENLIL_CACHE.getWithMetadata("grid");
  if (cached.value !== null && cached.metadata?.ts && Date.now() / 1000 - cached.metadata.ts < GRID_TTL_S) {
    return new Response(cached.value, { headers: { "Content-Type": CT, "Cache-Control": CACHE_FRESH } });
  }
  try {
    const payload = await buildGridPayload();
    ctx.waitUntil(kvPut(env, "grid", payload));
    return new Response(payload, { headers: { "Content-Type": CT, "Cache-Control": CACHE_FRESH } });
  } catch (err) {
    if (cached.value !== null) {
      const payload = JSON.parse(cached.value);
      payload.stale = true;
      return json(payload, 200, { "Cache-Control": CACHE_STALE });
    }
    // ultimo livello: snapshot statico committato (asset public/data/om-grid-seed.json)
    try {
      const seedRes = await env.ASSETS.fetch("http://assets/data/om-grid-seed.json");
      if (seedRes.ok) {
        const payload = await seedRes.json();
        payload.stale = true;
        payload.seed = true;
        return json(payload, 200, { "Cache-Control": CACHE_STALE });
      }
    } catch { /* seed assente */ }
    return json(
      { error: `Open-Meteo non raggiungibile e nessuno snapshot disponibile: ${err.message}` },
      503
    );
  }
}

/* ---------------- NOAA CDO (secret NOAA_TOKEN) ---------------- */

const NOAA_TTL_S = 7 * 24 * 3600;

async function handleNoaaStation(env, url, request, ctx) {
  if (!env.NOAA_TOKEN) {
    return json(
      { error: "NOAA_TOKEN non configurato sul Worker (wrangler secret put NOAA_TOKEN)." },
      501
    );
  }
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "Parametri lat/lon mancanti o non validi" }, 400);
  }

  // Throttle best-effort per IP: KV non è atomica, è un limite morbido per
  // evitare che uno script esaurisca la quota NOAA (10.000/giorno per token).
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const rlKey = `noaa-rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const rlCount = Number(await env.ENLIL_CACHE.get(rlKey)) || 0;
  if (rlCount >= 30) {
    return json({ error: "Troppe richieste NOAA in un minuto, riprova a breve." }, 429, { "Cache-Control": NO_STORE });
  }
  ctx.waitUntil(env.ENLIL_CACHE.put(rlKey, String(rlCount + 1), { expirationTtl: 120 }));

  // Cache della risposta per lat/lon arrotondati a 0,1° (~11 km), TTL 7 giorni:
  // la maggior parte dei click su aree abitate ricade su una cella già vista.
  const cacheKey = `noaa:${lat.toFixed(1)}:${lon.toFixed(1)}`;
  const cached = await env.ENLIL_CACHE.getWithMetadata(cacheKey);
  if (cached.value !== null && cached.metadata?.ts && Date.now() / 1000 - cached.metadata.ts < NOAA_TTL_S) {
    return new Response(cached.value, {
      status: cached.metadata.status || 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": NO_STORE, "X-Enlil-Cache": "kv" },
    });
  }
  const reply = (payload, status) => {
    const bodyStr = JSON.stringify(payload);
    if (status === 200 || status === 404) {
      ctx.waitUntil(env.ENLIL_CACHE.put(cacheKey, bodyStr, {
        metadata: { ts: Math.floor(Date.now() / 1000), status }, expirationTtl: NOAA_TTL_S,
      }));
    }
    return new Response(bodyStr, {
      status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": NO_STORE },
    });
  };

  const h = { token: env.NOAA_TOKEN };
  // clamp ai limiti geografici: vicino ai poli/antimeridiano lat±1 / lon±1
  // uscirebbe da [-90,90] / [-180,180] e CDO risponderebbe 400
  const clampLat = (v) => Math.max(-90, Math.min(90, v));
  const clampLon = (v) => Math.max(-180, Math.min(180, v));
  const extent = `${clampLat(lat - 1).toFixed(2)},${clampLon(lon - 1).toFixed(2)},${clampLat(lat + 1).toFixed(2)},${clampLon(lon + 1).toFixed(2)}`;
  const stRes = await fetchWithRetry(
    `https://www.ncei.noaa.gov/cdo-web/api/v2/stations?datasetid=GHCND&extent=${extent}&limit=25`,
    { headers: h }
  );
  const stations = ((await stRes.json()).results || []).filter(
    (s) => s.maxdate && s.maxdate >= fmtDate(new Date(Date.now() - 3 * 365 * 86400000))
  );
  if (!stations.length) {
    return reply({ error: "Nessuna stazione GHCND con dati recenti entro 1° dal punto" }, 404);
  }
  const dist = (s) => {
    const dLat = (s.latitude - lat) * 111;
    const dLon = (s.longitude - lon) * 111 * Math.cos((lat * Math.PI) / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  };
  const st = stations.reduce((a, b) => (dist(a) <= dist(b) ? a : b));

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
  return reply({
    station: { id: st.id, name: st.name, distanceKm: Math.round(dist(st)) },
    period: { start: fmtDate(startD), end },
    tavg: avg("TAVG"), tmax: avg("TMAX"), tmin: avg("TMIN"),
  }, 200);
}

/* ---------------- Cron: pre-scalda la KV ---------------- */
/* Gli egress di Cloudflare sono IP condivisi: a KV fredda il primo
 * visitatore paga tutti i retry 429 di Open-Meteo (o fallisce). Un Cron
 * Trigger rigenera grid e serie in background prima che la cache scada. */

async function refreshGrid(env) {
  try {
    await kvPut(env, "grid", await buildGridPayload());
    console.log("cron: grid aggiornata");
  } catch (err) {
    console.warn("cron: refreshGrid fallito:", err.message);
  }
}

async function refreshSeries(env) {
  for (const [key, url] of Object.entries(SERIES)) {
    try {
      const up = await fetchWithRetry(url);
      await kvPut(env, key, await up.text());
      console.log(`cron: ${key} aggiornata`);
    } catch (err) {
      console.warn(`cron: refresh ${key} fallito:`, err.message);
    }
  }
}

/* ---------------- Entrypoint ---------------- */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshGrid(env));
    ctx.waitUntil(refreshSeries(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/api/health": {
          // verifica reale che l'asset ERA5 sia presente
          let era5 = false;
          try {
            era5 = (await env.ASSETS.fetch("http://assets/data/era5-grid.json")).ok;
          } catch { /* asset assente */ }
          return json({ ok: true, providers: { noaa: Boolean(env.NOAA_TOKEN), era5 } }, 200, { "Cache-Control": NO_STORE });
        }
        case "/api/grid":
          return await handleGrid(env, ctx);
        case "/api/gistemp":
          return await proxyCached(env, "gistemp", SERIES_TTL_S, SERIES.gistemp, ctx);
        case "/api/hadcrut5":
          return await proxyCached(env, "hadcrut5", SERIES_TTL_S, SERIES.hadcrut5, ctx);
        case "/api/berkeley":
          return await proxyCached(env, "berkeley", SERIES_TTL_S, SERIES.berkeley, ctx);
        case "/api/noaa/station-data":
          return await handleNoaaStation(env, url, request, ctx);
        case "/api/era5":
          return env.ASSETS.fetch(new URL("/data/era5-grid.json", url.origin));
        default:
          return env.ASSETS.fetch(request);
      }
    } catch (err) {
      return json({ error: String(err.message || err) }, 500);
    }
  },
};

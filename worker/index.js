/* Enlil — Cloudflare Worker
 *
 * Port di server.mjs (Node) per l'edge:
 *  - statici serviti dal binding ASSETS (cartella public/, condivisa col server locale)
 *  - cache su KV (ENLIL_CACHE) al posto del filesystem
 *  - NOAA_TOKEN come secret del Worker (mai nel frontend)
 *
 * La logica di dominio (griglia, periodi, fetch/retry, Open-Meteo, NOAA) sta in
 * lib/core.mjs, condivisa con server.mjs. Qui restano solo cache su KV, header
 * HTTP, Cron Trigger e routing.
 */

import { SERIES, fetchWithRetry, buildGridPayload, noaaStationData, noaaStationHistory } from "../lib/core.mjs";

const GRID_TTL_S = 12 * 3600;
const SERIES_TTL_S = 24 * 3600;
const NOAA_TTL_S = 7 * 24 * 3600;
const NOAA_HISTORY_TTL_S = 30 * 24 * 3600;
const NOAA_HISTORY_RATE_COST = 4; // ricerca stazione GSOM + tre decadi mensili

// Cache HTTP all'edge/nel browser: risposte fresche cacheabili 5 min, poi
// servibili "stale" per 1h mentre si rivalida. Per le risposte già stale si
// usa una finestra corta così tornano presto a rivalidarsi.
const CACHE_FRESH = "public, max-age=300, stale-while-revalidate=3600";
const CACHE_STALE = "public, max-age=60";
const NO_STORE = "no-store";

// KV put con timestamp nei metadata (formato condiviso da proxy, grid e cron)
const kvPut = (env, key, body) =>
  env.ENLIL_CACHE.put(key, body, { metadata: { ts: Math.floor(Date.now() / 1000) } });

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });

/* ---------------- Serie storiche: proxy con cache su KV ---------------- */

/* Se l'upstream fallisce ma esiste una copia vecchia, viene servita stale. */
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

// medie climatologiche 1961-1990 per punto (asset precalcolato)
async function loadClimatology(env) {
  const res = await env.ASSETS.fetch("http://assets/data/om-climatology-1961-1990.json");
  return (await res.json()).mean;
}

async function handleGrid(env, ctx) {
  const CT = "application/json";
  const cached = await env.ENLIL_CACHE.getWithMetadata("grid");
  if (cached.value !== null && cached.metadata?.ts && Date.now() / 1000 - cached.metadata.ts < GRID_TTL_S) {
    return new Response(cached.value, { headers: { "Content-Type": CT, "Cache-Control": CACHE_FRESH } });
  }
  try {
    const payload = JSON.stringify(await buildGridPayload(await loadClimatology(env)));
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

  const { status, body } = await noaaStationData(env.NOAA_TOKEN, lat, lon);
  const bodyStr = JSON.stringify(body);
  if (status === 200 || status === 404) {
    ctx.waitUntil(env.ENLIL_CACHE.put(cacheKey, bodyStr, {
      metadata: { ts: Math.floor(Date.now() / 1000), status }, expirationTtl: NOAA_TTL_S,
    }));
  }
  return new Response(bodyStr, {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": NO_STORE },
  });
}

async function handleNoaaHistory(env, url, request, ctx) {
  if (!env.NOAA_TOKEN) {
    return json({ error: "NOAA_TOKEN non configurato sul Worker (wrangler secret put NOAA_TOKEN)." }, 501);
  }
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "Parametri lat/lon mancanti o non validi" }, 400);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const rlKey = `noaa-rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const rlCount = Number(await env.ENLIL_CACHE.get(rlKey)) || 0;
  if (rlCount + NOAA_HISTORY_RATE_COST > 30) {
    return json({ error: "Troppe richieste NOAA in un minuto, riprova a breve." }, 429, { "Cache-Control": NO_STORE });
  }
  ctx.waitUntil(env.ENLIL_CACHE.put(rlKey, String(rlCount + NOAA_HISTORY_RATE_COST), { expirationTtl: 120 }));
  const cacheKey = `noaa-history:${lat.toFixed(1)}:${lon.toFixed(1)}`;
  const cached = await env.ENLIL_CACHE.getWithMetadata(cacheKey);
  if (cached.value !== null && cached.metadata?.ts && Date.now() / 1000 - cached.metadata.ts < NOAA_HISTORY_TTL_S) {
    return new Response(cached.value, {
      status: cached.metadata.status || 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": NO_STORE, "X-Enlil-Cache": "kv" },
    });
  }
  const { status, body } = await noaaStationHistory(env.NOAA_TOKEN, lat, lon);
  const bodyStr = JSON.stringify(body);
  if (status === 200 || status === 404) {
    ctx.waitUntil(env.ENLIL_CACHE.put(cacheKey, bodyStr, {
      metadata: { ts: Math.floor(Date.now() / 1000), status }, expirationTtl: NOAA_HISTORY_TTL_S,
    }));
  }
  return new Response(bodyStr, {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": NO_STORE },
  });
}

/* ---------------- Cron: pre-scalda la KV ---------------- */
/* Gli egress di Cloudflare sono IP condivisi: a KV fredda il primo
 * visitatore paga tutti i retry 429 di Open-Meteo (o fallisce). Un Cron
 * Trigger rigenera grid e serie in background prima che la cache scada. */

async function refreshGrid(env) {
  try {
    await kvPut(env, "grid", JSON.stringify(await buildGridPayload(await loadClimatology(env))));
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
        case "/api/noaa/station-history":
          return await handleNoaaHistory(env, url, request, ctx);
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

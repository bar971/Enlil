# HANDOFF — Enlil (clima globale su mappa mondiale)

> Stato al 2026-08-31 (`master`; climatologia OM 1961-1990 completa 306/306, protezione asset e test NOAA integrati). Documento per riprendere il progetto su un'altra macchina o da un altro agente.

## Cos'è

Web app che visualizza il riscaldamento climatico su una cartina mondiale geo-politica, più serie storiche globali a confronto. Architettura: **backend Node.js zero-dipendenze** (`server.mjs` + `lib/core.mjs`, solo moduli `node:`) + **frontend statico** (`index.html`, `app.js`, `style.css`) con Leaflet + Chart.js da CDN. Tutte le fonti di `clima.md` sono integrate.

## Struttura file

| File | Ruolo |
|---|---|
| `index.html` / `style.css` / `app.js` | Frontend: mappa Leaflet, heatmap, marker, grafico a scomparsa |
| `server.mjs` | Backend: static serving + proxy con cache su file + server HTTP |
| `worker/index.js` | Cloudflare Worker: stesse rotte, cache su KV, Cron Trigger |
| `lib/core.mjs` | Logica condivisa server↔worker: griglia, periodi, fetch/retry, Open-Meteo, NOAA (solo API standard, niente `node:`) |
| `lib/series.mjs` | Parser canonici delle serie storiche (fonte per i test; `app.js` ne tiene una copia inline) |
| `data/gistemp.js` | Snapshot NASA GISTEMP embedded (fallback senza backend) |
| `public/data/era5-grid.json` | Griglia ERA5 precomputata (10.368 punti, ~500 KB) — generata da script |
| `data/cache/` | Cache runtime del backend (gitignored): grid.json, gistemp.csv, hadcrut5.csv, berkeley.txt |
| `scripts/fetch_era5.py` | Genera `public/data/era5-grid.json` dal CDS (richiede token); non modifica la climatologia Open-Meteo |
| `clima.md` | Documento fonte sui dataset |
| `.env` | `NOAA_TOKEN=...` (gitignored, vive nel repo secrets) |
| `scripts/gen_om_climatology.mjs` | Genera la climatologia Open-Meteo 1961-1990 sui 306 punti (asset precalcolato, resume-safe) |
| `data/om-climatology-1961-1990.json` / `data/om-climatology.js` | Media climatologica 1961-1990 per punto: JSON per server/worker, `.js` embedded per la modalità standalone |

## Fonti dati e stato

| Fonte | Auth | Integrazione | Stato |
|---|---|---|---|
| Open-Meteo Archive (ERA5-based) | No | `/api/grid`: griglia 306 punti (lat -80..80 Δ10°, lon -180..160 Δ20°), **anomalia media ultimi 12 mesi vs climatologia 1961-1990** (climatologia precalcolata come asset; sul percorso caldo si scarica solo `recent`) | ✓ live |
| NASA GISTEMP | No | `/api/gistemp` proxy CSV, cache 24h | ✓ live |
| HadCRUT5 | No | `/api/hadcrut5` proxy CSV mensile → aggregato annuale nel frontend | ✓ live |
| Berkeley Earth | No | `/api/berkeley` proxy TXT annuale | ✓ live |
| NOAA CDO (stazioni GHCND) | Token | `/api/noaa/station-data?lat&lon`: stazione attiva più vicina + TAVG/TMAX/TMIN ultimi 12 mesi disponibili | ✓ live |
| ERA5 (CDS) | Token | `/api/era5` serve `data/era5-grid.json` (layer heatmap 10.368 punti) | ✓ live |

## Setup su un nuovo PC

1. Clonare il repo progetto e, come cartella sorella, il repo `Enlil-secrets`
2. Copiare dai secrets: `.env` → root del progetto; `cdsapirc` → `~/.cdsapirc`
3. `node server.mjs` → http://localhost:8000 (funziona subito: griglia da snapshot ERA5+Open-Meteo, serie da proxy)
4. Solo per rigenerare ERA5: installare Python 3.13, `python -m venv .venv`, `.venv/Scripts/pip install cdsapi xarray netCDF4`, poi `.venv/Scripts/python scripts/fetch_era5.py`

## Comportamenti non ovvi (imparati sul campo)

- **Open-Meteo free tier**: ogni location di una richiesta batch conta come chiamata (~600/min, 10.000/giorno). Il server fa chunking (100/richiesta, pausa 1,5 s), retry con backoff su 429 (nessun `Retry-After` esposto), snapshot su disco con TTL 12h e fallback a snapshot datato. Il frontend standalone usa localStorage.
- **NASA GISS risponde 403 allo User-Agent di Node/undici**: `fetchWithRetry` invia un UA browser-like.
- **NOAA CDO**: `sortfield=distance` NON esiste (400); la stazione più vicina si calcola in locale (distanza equirettangolare). Molte stazioni GHCND sono storiche (es. MILAN chiusa nel 2008) → filtro `maxdate` entro 3 anni. Le stazioni italiane hanno ~1 anno di ritardo (maxdate ago 2025) → il periodo della query è ancorato a `maxdate`, non a oggi.
- **CARTO basemaps mostra watermark "API KEY REQUIRED"** senza chiave → basemap = Esri World Dark Gray Canvas (confini + nomi stati, niente chiave).
- **CDS**: il dataset giusto è `reanalysis-era5-single-levels-monthly-means`; request con liste (`year: [...]`) e `data_format: "netcdf"` + `download_format: "unarchived"`. I NetCDF nuovi usano la coordinata `valid_time` (lo script gestisce anche `time`). **Le longitudini ERA5 sono 0..360**: lo script le normalizza a -180..180 (senza normalizzazione metà del calore viene disegnata fuori mappa da Leaflet).
- **Metrica mappa** = anomalia media ultimi 12 mesi − climatologia 1961-1990 (stessa baseline del grafico). La climatologia per punto non cambia mai: precalcolata come asset (`om-climatology-1961-1990.json`), NON scaricata sul percorso caldo → `/api/grid` scarica solo `recent` (306 chiamate, non 612). `buildGridPayload(climatologyMeans)` riceve l'array; il payload tiene la chiave `baseline` (= climatologia per punto) per non cambiare forma al frontend.
- **Frontend**: rileva il backend con `GET /api/health` (timeout 2 s); senza backend funziona standalone (fetch diretto Open-Meteo `recent` + climatologia da `data/om-climatology.js` embedded + snapshot GISTEMP embedded). Grafico = pannello laterale a scomparsa, renderizzato lazy alla prima apertura (Chart.js richiede canvas visibile). Click su marker ≠ click su mappa (`bubblingMouseEvents: false`): il secondo interroga NOAA. Layer Open-Meteo ed ERA5 mutuamente esclusivi via `L.control.layers` (base layers); la legenda mostra la fonte attiva su `baselayerchange`.
- **Mappa vincolata**: `noWrap` + `maxBounds` (un solo mondo), `minZoom` = `Math.floor(getBoundsZoom(WORLD_BOUNDS, true)) - 1` (un livello sotto la vista globale: si apre sul mondo intero, ma si può zoomare fuori di un gradino con margine attorno), maxZoom 12. Marker OM con raggio adattivo allo zoom (4→10 px).
- **Heatmap**: i parametri vanno tarati per densità griglia. OM (306 punti): radius 40/blur 30/max 0.9/minOpacity 0.25. ERA5 (10.368 punti): radius 14/blur 10/max 1.5/minOpacity 0.3 — con i default la griglia fitta satura tutto per accumulo.

## Verifiche eseguite (2026-08-27)

- Tutti gli endpoint testati con curl: health, grid (200, snapshot 323/323 validi, ΔT medio +1,25 °C), gistemp/hadcrut5/berkeley (200, cacheati), era5 (200, 508 KB), noaa (CAMERI/ROMA CIAMPINO con valori reali)
- ERA5: ΔT medio +1,23 °C, Artico +3,20 °C vs Tropici +0,83 °C (amplificazione artica coerente)
- **Verifica visiva con Playwright headless** (Chromium su http://localhost:8000): rendering mappa, selettore layer OM/ERA5, pannello grafico con 3 serie, vincoli zoom/pan (10 zoom-out forzati non spostano la vista), legenda fonte attiva. Così è stato trovato e corretto il bug delle longitudini ERA5 0..360.
- Test Playwright non committati: erano in `/tmp/pwtest` (playwright-core + Chromium già presente in `%LOCALAPPDATA%/ms-playwright`).

### Aggiornamento 2026-08-29 — metrica mappa 1961-1990 IN PRODUZIONE

- Climatologia Open-Meteo 1961-1990 completata a **306/306 punti reali** (min −53,3 / max +28,3 °C, media 6,63 °C). Ultimi 42 punti scaricati via routine cloud subito dopo il reset quota 00:00 UTC (2 tentativi, nessun 429; un `TimeoutError` a 300/306 assorbito dal resume).
- `public/data/om-grid-seed.json` rigenerato con la nuova baseline. `node --test` 13/13.
- Merge `--no-ff` `metrica-mappa` → `master` (`cedeae2`), push. Deploy automatico Workers Builds (`buildOutcome: success`).
- **KV `grid` ripulita e rigenerata**: `curl` di verifica lanciato prima della propagazione del deploy aveva riempito la KV (allora vuota) con un payload della metrica vecchia → `wrangler kv key delete grid --remote`, poi il worker nuovo l'ha rigenerata live.
- Verifica prod: `/api/grid` → `periods.climatology` 1961-1990, `baseline.len` 306, `stale:false`, **ΔT media +1,41 °C** (min −1,44 / max +6,89). `/api/health` ok, `/api/era5` 200 (510 KB), label frontend nuove servite ("Anomalia: ultimi 12 mesi vs media 1961–1990"). Verifica headless nel browser nelle 3 modalità completata con esito positivo.

### Aggiornamento 2026-08-31 — protezione climatologia e test NOAA

- `scripts/fetch_era5.py` genera esclusivamente `public/data/era5-grid.json`: rimossa la scrittura della climatologia Open-Meteo provvisoria campionata da ERA5.
- Aggiunto un test di regressione che vincola i target di scrittura dello script ERA5 e impedisce di reintrodurre riferimenti agli asset climatologici Open-Meteo.
- Aggiunti test NOAA con rete simulata: coordinate non valide, clamp geografico, esclusione stazioni obsolete, scelta della più vicina, periodo ancorato ai dati disponibili, medie, estremi, valori mancanti e paginazione oltre 1.000 record.
- Corretto il pareggio degli estremi NOAA: a parità di temperatura viene scelta la data più recente.
- Verifiche: `node --test` **18/18** e `npx --yes wrangler@4 deploy --dry-run` completati con successo.

## Deploy Cloudflare (attivo)

- URL: https://enlil.bar971.workers.dev — Worker `enlil` (`worker/index.js`), statici da `public/` (binding `ASSETS`, da dichiarare esplicitamente in `wrangler.jsonc` altrimenti `env.ASSETS` è undefined), cache KV `enlil-cache` id `076d8cde3bef436eabed421aa3e51546` (binding `ENLIL_CACHE`), secret `NOAA_TOKEN`.
- Deploy: `npx wrangler deploy` (wrangler 4.x, OAuth già attivo). Dev locale del Worker: `npx wrangler dev` (carica `.env` da solo).
- **429 da IP Cloudflare**: Open-Meteo limita per IP e gli egress Cloudflare sono condivisi → a freddo `/api/grid` può accumulare retry per ~2 min o fallire; una volta scritta la chiave `grid` in KV resta servita in ~200 ms. In emergenza, seed manuale: `npx wrangler kv key put grid --namespace-id 076d8cde... --path data/cache/grid.json --metadata '{"ts": <epoch>}')`.
- **KV edge caching**: le letture KV all'edge sono cached ~60 s — anche i miss/null. Se un endpoint appena popolato sembra ignorare la chiave, attendere >60 s SENZA richiamarlo (ogni chiamata rinfresca il null in cache).

## Debiti noti / prossimi passi

- Test: `node --test` (parser serie, sync app.js↔lib, protezione asset climatologici e logica NOAA); CI in `.github/workflows/ci.yml`. Copertura ancora limitata su cache KV/file e Worker end-to-end.
- Dominio custom non configurato (resta su workers.dev)
- Griglia OM fissa (passo 10°×20°): si può valutare densità maggiore o zoom-dipendente
- ERA5 va rigenerato periodicamente per restare aggiornato (`scripts/fetch_era5.py`, ora climatologia 1961-1990)
- **Mai lanciare `curl`/richieste a `enlil.bar971.workers.dev/api/grid` subito dopo un push su `master`**: se la KV `grid` è vuota e il deploy non è ancora propagato, il worker vecchio ripopola la KV con la metrica vecchia (TTL 12h). Aspettare che il deploy sia live, o `wrangler kv key delete grid --remote` dopo
- Popup NOAA mostra solo l'ultimo anno: possibile estensione a serie storica della stazione

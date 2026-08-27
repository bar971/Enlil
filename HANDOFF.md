# HANDOFF — Enlil (clima globale su mappa mondiale)

> Stato al 2026-08-27. Documento per riprendere il progetto su un'altra macchina o da un altro agente.

## Cos'è

Web app che visualizza il riscaldamento climatico su una cartina mondiale geo-politica, più serie storiche globali a confronto. Architettura: **backend Node.js zero-dipendenze** (`server.js`, solo `node:http`) + **frontend statico** (`index.html`, `app.js`, `style.css`) con Leaflet + Chart.js da CDN. Tutte le fonti di `clima.md` sono integrate.

## Struttura file

| File | Ruolo |
|---|---|
| `index.html` / `style.css` / `app.js` | Frontend: mappa Leaflet, heatmap, marker, grafico a scomparsa |
| `server.js` | Backend: static serving + proxy con cache + snapshot griglia + NOAA + ERA5 |
| `data/gistemp.js` | Snapshot NASA GISTEMP embedded (fallback senza backend) |
| `data/era5-grid.json` | Griglia ERA5 precomputata (10.368 punti, ~500 KB) — generata da script |
| `data/cache/` | Cache runtime del backend (gitignored): grid.json, gistemp.csv, hadcrut5.csv, berkeley.txt |
| `scripts/fetch_era5.py` | Genera `data/era5-grid.json` dal CDS (richiede token) |
| `clima.md` | Documento fonte sui dataset |
| `.env` | `NOAA_TOKEN=...` (gitignored, vive nel repo secrets) |

## Fonti dati e stato

| Fonte | Auth | Integrazione | Stato |
|---|---|---|---|
| Open-Meteo Archive (ERA5-based) | No | `/api/grid`: griglia 323 punti (lat -80..80 Δ10°, lon -180..180 Δ20°), media ultimi 12 mesi vs 40 anni prima | ✓ live |
| NASA GISTEMP | No | `/api/gistemp` proxy CSV, cache 24h | ✓ live |
| HadCRUT5 | No | `/api/hadcrut5` proxy CSV mensile → aggregato annuale nel frontend | ✓ live |
| Berkeley Earth | No | `/api/berkeley` proxy TXT annuale | ✓ live |
| NOAA CDO (stazioni GHCND) | Token | `/api/noaa/station-data?lat&lon`: stazione attiva più vicina + TAVG/TMAX/TMIN ultimi 12 mesi disponibili | ✓ live |
| ERA5 (CDS) | Token | `/api/era5` serve `data/era5-grid.json` (layer heatmap 10.368 punti) | ✓ live |

## Setup su un nuovo PC

1. Clonare il repo progetto e, come cartella sorella, il repo `Enlil-secrets`
2. Copiare dai secrets: `.env` → root del progetto; `cdsapirc` → `~/.cdsapirc`
3. `node server.js` → http://localhost:8000 (funziona subito: griglia da snapshot ERA5+Open-Meteo, serie da proxy)
4. Solo per rigenerare ERA5: installare Python 3.13, `python -m venv .venv`, `.venv/Scripts/pip install cdsapi xarray netCDF4`, poi `.venv/Scripts/python scripts/fetch_era5.py`

## Comportamenti non ovvi (imparati sul campo)

- **Open-Meteo free tier**: ogni location di una richiesta batch conta come chiamata (~600/min, 10.000/giorno). Il server fa chunking (100/richiesta, pausa 1,5 s), retry con backoff su 429 (nessun `Retry-After` esposto), snapshot su disco con TTL 12h e fallback a snapshot datato. Il frontend standalone usa localStorage.
- **NASA GISS risponde 403 allo User-Agent di Node/undici**: `fetchWithRetry` invia un UA browser-like.
- **NOAA CDO**: `sortfield=distance` NON esiste (400); la stazione più vicina si calcola in locale (distanza equirettangolare). Molte stazioni GHCND sono storiche (es. MILAN chiusa nel 2008) → filtro `maxdate` entro 3 anni. Le stazioni italiane hanno ~1 anno di ritardo (maxdate ago 2025) → il periodo della query è ancorato a `maxdate`, non a oggi.
- **CARTO basemaps mostra watermark "API KEY REQUIRED"** senza chiave → basemap = Esri World Dark Gray Canvas (confini + nomi stati, niente chiave).
- **CDS**: il dataset giusto è `reanalysis-era5-single-levels-monthly-means`; request con liste (`year: [...]`) e `data_format: "netcdf"` + `download_format: "unarchived"`. I NetCDF nuovi usano la coordinata `valid_time` (lo script gestisce anche `time`).
- **Frontend**: rileva il backend con `GET /api/health` (timeout 2 s); senza backend funziona standalone (fetch diretto Open-Meteo + snapshot GISTEMP embedded). Grafico renderizzato lazy alla prima apertura (Chart.js richiede canvas visibile). Click su marker ≠ click su mappa (`bubblingMouseEvents: false`): il secondo interroga NOAA.

## Verifiche eseguite (2026-08-27)

- Tutti gli endpoint testati con curl: health, grid (200, snapshot 323/323 validi, ΔT medio +1,25 °C), gistemp/hadcrut5/berkeley (200, cacheati), era5 (200, 508 KB), noaa (CAMERI/ROMA CIAMPINO con valori reali)
- ERA5: ΔT medio +1,23 °C, Artico +3,20 °C vs Tropici +0,83 °C (amplificazione artica coerente)
- **Mai verificato in browser reale**: rendering completo di mappa/popup/grafico dopo le ultime modifiche (nessuna automazione browser eseguita)

## Debiti noti / prossimi passi

- UI/UX: migliorie in coda (discusse con l'utente, da raccogliere)
- `scripts/fetch_era5.py` testato e funzionante, ma il layer ERA5 in mappa non è stato validato visivamente
- Nessun test automatico; nessun deploy pubblico (solo localhost)

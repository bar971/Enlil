# Enlil — Clima globale

Pagina web con cartina mondiale geo-politica per dati climatici, secondo le fonti di `clima.md`.
Due modalità d'uso:

| Modalità | Come | Cosa funziona |
|---|---|---|
| **Con backend** (consigliata) | `node server.js` → http://localhost:8000 | Tutto: mappa Open-Meteo con snapshot su disco, serie GISTEMP/HadCRUT5/Berkeley live via proxy, NOAA (con token), ERA5 (dopo aver generato il JSON) |
| **Standalone** | apri `index.html` nel browser | Mappa Open-Meteo (fetch diretto, cache in localStorage) + grafico GISTEMP da snapshot embedded |

Nessuna dipendenza npm: il backend è Node puro (`node:http`).

## Cosa mostra

- **Mappa** (Leaflet, basemap Esri World Dark Gray con confini e nomi degli stati): heatmap + 323 marker (lat -80..80 passo 10°, lon -180..180 passo 20°). Per ogni punto, ΔT = media ultimi 12 mesi − media stesso periodo 40 anni fa (Open-Meteo Archive / rianalisi ERA5). Clic su marker → dettagli; clic altrove sulla mappa → stazione NOAA GHCND più vicina (se configurata).
- **Grafico a scomparsa**: anomalie globali annuali GISTEMP (dal 1880), HadCRUT5 (dal 1850, aggregato da mensile), Berkeley Earth (dal 1850).

## Backend: endpoint

- `GET /api/health` — stato provider (`noaa`: token presente, `era5`: JSON generato)
- `GET /api/grid` — griglia Open-Meteo; snapshot in `data/cache/grid.json` (TTL 12h; se Open-Meteo è in 429 serve lo snapshot datato)
- `GET /api/gistemp` · `/api/hadcrut5` · `/api/berkeley` — proxy con cache 24h in `data/cache/`
- `GET /api/noaa/station-data?lat=..&lon=..` — stazione GHCND più vicina + medie TAVG/TMAX/TMIN ultimo anno
- `GET /api/era5` — serve `data/era5-grid.json` (501 finché non generato)

## Autenticazione richiesta (solo 2 fonti)

### NOAA CDO (dati per stazione)
1. Token gratuito via email: https://www.ncei.noaa.gov/cdo-web/token
2. Avvio con token:
   ```bash
   NOAA_TOKEN=xxx node server.js        # oppure riga NOAA_TOKEN=xxx in .env
   ```

### ERA5 / Copernicus CDS (mappa grigliata ad alta risoluzione)
1. Account gratuito su https://cds.climate.copernicus.eu
2. Personal Access Token in `~/.cdsapirc`:
   ```
   url: https://cds.climate.copernicus.eu/api
   key: YOUR_PERSONAL_ACCESS_TOKEN
   ```
3. Accettare la licenza del dataset: apri [la pagina del dataset](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means?tab=download) loggato, scorri in fondo ("Terms of use") e clicca Accept
4. `pip install cdsapi xarray netCDF4`, poi:
   ```bash
   python scripts/fetch_era5.py   # scarica 2 NetCDF e scrive data/era5-grid.json
   ```
   Il layer ERA5 compare in automatico al prossimo caricamento della pagina.

## Note

- I token restano solo sul server (env/`.env`, in `.gitignore`): mai nel frontend.
- Open-Meteo free tier conta ogni location batch come chiamata (~600/min, 10.000/giorno): il server fa chunking con pausa, retry su 429 e snapshot su disco; il frontend standalone usa localStorage come cache.
- Fonti senza auth (NASA GISTEMP, HadCRUT5, Berkeley Earth, Open-Meteo) funzionano subito.

# Fonti certificate per storici temperature globali

Documento di riferimento per l'integrazione di dati climatici in una applicazione web.
Per ogni fonte: contenuto, metodo di accesso, autenticazione e note di integrazione.

---

## 1. NASA GISTEMP (Goddard Institute for Space Studies)

- **Contenuto**: anomalie di temperatura globali/regionali, dal 1880, aggiornamento mensile.
- **Accesso**: download diretto via HTTP GET, **nessuna autenticazione**. File CSV/TXT statici.
- **Endpoint principali**:
  - Serie globale annuale: `https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv`
  - Altri dataset: `https://data.giss.nasa.gov/gistemp/`
- **Integrazione web**: la più semplice — `fetch` + parsing CSV. File di pochi KB, ideali per cache lato client. Consigliato un backend proxy per evitare problemi CORS.

## 2. NOAA NCEI — Climate Data Online (CDO) API

- **Contenuto**: dati grezzi e aggregati di migliaia di stazioni mondiali (GHCN), giornalieri e mensili.
- **Accesso**: API REST con **token gratuito** (registrazione via email sul sito NOAA).
- **Endpoint principali**:
  - Classico: `https://www.ncei.noaa.gov/cdo-web/api/v2/data?datasetid=GSOD&...`
  - Nuovi (in migrazione): `https://www.ncei.noaa.gov/access/services/search/v1` e `.../access/services/data/v1`
- **Limiti**: 5 richieste/sec, 10.000 richieste/giorno per token.
- **Integrazione web**: **solo backend** (il token non deve finire nel frontend). Pattern: la propria API interroga NOAA, normalizza e cachea in DB.

## 3. HadCRUT5 (Met Office Hadley Centre / University of East Anglia, UK)

- **Contenuto**: dataset di riferimento dei rapporti IPCC, dal 1850, con intervalli di incertezza (ensemble di 200 membri). Serie mensili/annuali globali ed emisferiche.
- **Accesso**: download diretto **senza autenticazione**, formati CSV e NetCDF.
- **Endpoint principali**:
  - Serie globale mensile: `https://www.metoffice.gov.uk/hadobs/hadcrut5/data/HadCRUT.5.1.0.0/analysis/diagnostics/HadCRUT.5.1.0.0.analysis.summary_series.global.monthly.csv`
  - Pagina download: `https://www.metoffice.gov.uk/hadobs/hadcrut5/`
- **Integrazione web**: CSV via fetch; NetCDF (mappe grigliate) da parsare lato server con librerie tipo `netcdf4`/`xarray`.

## 4. ERA5 — Copernicus Climate Data Store (ECMWF, UE)

- **Contenuto**: rianalisi grigliata completa (temperatura a 2 m, risoluzione ~31 km) dal 1940. Ideale per **mappe geografiche** di temperatura, non solo serie globali.
- **Accesso**: API dedicata con client Python `cdsapi`:
  1. Account gratuito su `https://cds.climate.copernicus.eu`
  2. Personal access token salvato in `~/.cdsapirc`:
     ```
     url: https://cds.climate.copernicus.eu/api
     key: YOUR_PERSONAL_ACCESS_TOKEN
     ```
  3. Accettazione della licenza **per ogni singolo dataset** (obbligatoria, altrimenti le richieste falliscono).
- **Formati output**: NetCDF / GRIB.
- **Integrazione web**: **solo lato server**, con job asincroni (le richieste grandi vanno in coda; alcuni dataset superano 1 GB). Pattern consigliato: scaricare una volta, convertire in tile/JSON e servire dal proprio storage.

## 5. Berkeley Earth

- **Contenuto**: dataset indipendente, dal 1750 circa, con stime per singola località/stato. Utile come cross-validazione dei dataset istituzionali.
- **Accesso**: download diretto di file testo/CSV da `https://berkeleyearth.org/data/` — nessuna API formale né autenticazione.
- **Integrazione web**: fetch diretto + parsing.

---

## Note architetturali per web app

| Fonte | Auth | Formato | Lato client | Lato server |
|---|---|---|---|---|
| NASA GISTEMP | No | CSV | Si (con proxy) | Si |
| NOAA CDO | Token | JSON/CSV | No | Si |
| HadCRUT5 | No | CSV/NetCDF | Si (CSV) | Si |
| ERA5/CDS | Token + licenza | NetCDF/GRIB | No | Si (job asincroni) |
| Berkeley Earth | No | TXT/CSV | Si (con proxy) | Si |

**Combinazione consigliata**:
- Grafici di serie storiche → **NASA GISTEMP + HadCRUT5** (CSV leggeri, zero auth)
- Mappe geografiche → **ERA5** precaricato sul backend
- Dati a livello di singola stazione → **NOAA CDO**
- Cross-validazione → **Berkeley Earth**

Tutti i dataset convergono sullo stesso segnale di riscaldamento (~1,1–1,3 °C rispetto all'era preindustriale), con piccole differenze metodologiche.

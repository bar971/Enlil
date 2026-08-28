# Piano — follow-up §4.1: metrica della mappa Enlil

> Le Fasi 1–8 del piano di analisi precedente sono COMPLETATE e in produzione
> (`master` @ `387797a`). Questo file ora descrive il follow-up §4.1.

## STATO ESECUZIONE (agg. 2026-08-28 ~08:00 UTC — sospeso: budget Open-Meteo esaurito, riprendere dopo le 00:00 UTC)

Branch **`metrica-mappa`** su origin, **allineato a `origin/metrica-mappa`**.
**NON mergiato su master, NON deployato.** Ultimo commit = checkpoint WIP
(climatologia 264/306). I commit `41d8b5f`..`5110318` + `9cdb694` + i due
checkpoint WIP restano la base.

### NOTA: `master` è avanzato (feature NON di questo piano)
In questa sessione è stata sviluppata e **deployata in produzione** una feature
indipendente: nel popup della stazione NOAA ora compaiono "Giorno più caldo
(TMAX)" e "Giorno più freddo (TMIN)" con data e valore.
- Branch `noaa-popup-estremi` (da `master` 387797a) → merge `--no-ff` `5effe3c`
  su `master` → `git push` → `npx wrangler deploy` (Version ID
  `e5e09460-6046-4ea8-bb9b-6e0454af1999`). Branch feature già **eliminato**
  (locale + origin).
- File toccati: `lib/core.mjs` (`noaaStationData` ora restituisce anche
  `warmestDay` / `coldestDay` = `{date,value}` o `null`), `public/app.js`
  (2 righe nel popup, con guardia `"warmestDay" in data` → voci KV `noaa:*`
  pre-deploy, TTL 7 gg, mostrano il popup senza le righe nuove finché non
  scadono). `node --test` 12/12. Verificato live su `enlil.bar971.workers.dev`.
- **`master` ora = `5effe3c`, non più `387797a`.** Quando si mergerà
  `metrica-mappa` su `master` questa feature è già dentro (nessun conflitto
  atteso: `metrica-mappa` non tocca la sezione popup NOAA di `app.js` né
  `noaaStationData`).

### FATTO e verificato (questa sessione, PC nuovo con `../Enlil-secrets`)
- Setup: `Enlil/.env` (da `../Enlil-secrets/.env`, gitignored) e `~/.cdsapirc`
  (da `../Enlil-secrets/cdsapirc`) copiati. Branch locale `metrica-mappa`
  tracking origin. wrangler loggato: OAuth `bar971@yahoo.it`, account
  `dcaf61703f63be2dcb360a0c2af4bc56`, namespace KV `enlil-cache`
  `076d8cde3bef436eabed421aa3e51546` visibile.
- `node --test` → **13/13 pass**.
- Codice branch (core/server/worker/app/index.html) invariato e coerente:
  `buildPeriods→{recent,climatology}`, `buildGridPayload(climatologyMeans)`,
  `loadClimatology()` in server e worker, label nuove nel frontend.
- **`scripts/gen_om_climatology.mjs` MODIFICATO** (approvato dall'utente):
  range 1961–1990 spezzato in **3 decadi** (1961-70 / 71-80 / 81-90) con media
  pesata sui giorni validi → **risultato identico** a una richiesta unica sul
  trentennio; pacing configurabile da env `OM_CLIM_CHUNK` (def 25),
  `OM_CLIM_DELAY_MS` (def 4000), `OM_CLIM_WINDOW_DELAY_MS` (def 2000);
  `fetchWithRetry(..., { retries: 2 })`.
- ERA5 (`public/data/era5-grid.json`, commit `f591682`): nuova metrica,
  media anomalia globale **+1,41 °C** (da riverificare con headless, non
  ri-misurato in questa sessione). Layer pronto.

### PARZIALE — climatologia OM (il blocco)
- `public/data/om-climatology-1961-1990.json` = **264/306 punti REALI**
  Open-Meteo (tutti validi, no null; min −53,3 / max +28,3 °C). `om-climatology.js`
  risincronizzato a 264 (header "PARZIALE 264/306"). Entrambi verranno **riscritti
  completi (306) dallo script** al termine.
- I 264 punti seguono l'ordine di `buildGrid()`. **Mancano 42 punti** alle
  latitudini nord alte (dal punto `{lat:60, lon:60}` in poi).
- Progressione: sessione 2026-08-27 → 150; mattina 2026-08-28 (~05:20 UTC) → 204;
  passata di questa sessione (~07:15 UTC, chunk 6 / 30s / 12s) → **264**, poi
  HTTP 429 persistente (2 retry falliti) → script uscito con codice 1.
- **Causa blocco: rate-limit Open-Meteo per PESO delle richieste.** Formula
  ufficiale (https://open-meteo.com/en/pricing):
  `chiamate = (n°variabili/10) × (n°giorni/14)` per location, ogni location di
  un batch conta a sé. Limiti free: 600/min · 5.000/ora · **10.000/giorno**,
  reset **00:00 UTC**. Un download 30 anni × 306 punti ≈ **23.900 chiamate**
  (≈2,4× il giorno). Con lo split a 3 decadi il costo per punto è identico
  (~78) ma spalmabile: i **42 punti mancanti ≈ 3.300 chiamate**, dentro il
  budget di un giorno pieno.
- **NON è un ban IP** — probe minima → HTTP 200. Non insistere sul 429:
  brucia budget su richieste fallite e allunga il throttle. Riprendere
  **leggeri**, una passata, **subito dopo un reset 00:00 UTC**.

### Decisioni utente (questa sessione)
- `recent` per il nuovo `om-grid-seed.json`: **riusare quello già committato**
  nel seed sul branch (la KV `grid` di produzione è **vuota**, "Value not
  found" — non è una fonte per `recent`).
- Ambito: eseguire **fino a produzione** (merge `--no-ff` + `wrangler deploy` +
  re-seed KV `grid`).
- Fix script gen_om_climatology (decadi + pacing env): approvato.

### PER CHIUDERE (riprendere quando Open-Meteo è di nuovo servibile)
1. `git checkout metrica-mappa && git pull`  (su altro PC: serve anche
   `Enlil/.env` da `../Enlil-secrets/.env` e `~/.cdsapirc` da
   `../Enlil-secrets/cdsapirc` — v. sotto "Setup altro PC")
2. **Riprendere la climatologia** (resume-safe, riparte da 264/306, ~3.300
   chiamate → sta in un giorno). Footprint leggero, subito dopo un reset
   00:00 UTC:
   ```
   OM_CLIM_CHUNK=6 OM_CLIM_DELAY_MS=30000 OM_CLIM_WINDOW_DELAY_MS=12000 \
     node scripts/gen_om_climatology.mjs
   ```
   Rilanciare finché `mean.length === 306` (su 429: aspettare il reset). Al
   termine lo script riscrive `om-climatology-1961-1990.json` (306) e
   `om-climatology.js` (306, header pulito).
3. Verifica valori: 306 medie plausibili (~ −55…+30 °C), **niente artefatti ai
   poli** (confronto con ERA5).
4. Rigenerare `public/data/om-grid-seed.json`: caricare il seed committato,
   sostituire `.baseline` con `om-climatology-1961-1990.json` `.mean` (306
   valori, stesso ordine di `buildGrid()`), lasciare invariato il resto
   (`recent`, `grid`, `periods`, `fetchedAt`, `seed`). One-liner node.
5. `node --test` (atteso 13/13).
6. Verifica programmatica/headless nelle 3 modalità (`node server.mjs` +
   `file://`): `/api/grid` con `periods.climatology`, ΔT media ~+1,2…+1,4,
   popup "Media climatologica 1961–1990" / "Anomalia…", legenda "Anomalia:
   ultimi 12 mesi vs media 1961–1990", niente blu spurio ai poli, 0 CSP.
7. Commit finale sul branch: climatologia reale 306/306; togliere note
   "PARZIALE"/"PROVVISORIO".
8. Docs: `HANDOFF.md` (metrica mappa nuova, nuovi file, togliere §4.1 dai
   "Debiti noti"), `README.md` (descrizione mappa). Poi **eliminare questo
   file** `HANDOFF-metrica-mappa.md` (piano realizzato).
9. `git checkout master && git merge --no-ff metrica-mappa && git push`
   (mai `.env`).
10. `npx wrangler deploy`.
11. Re-seed KV `grid` con la nuova metrica:
    `npx wrangler kv key put grid --namespace-id 076d8cde3bef436eabed421aa3e51546 --path <payload> --metadata '{"ts": <epoch>}'`
    — payload = `om-grid-seed.json` senza i flag `seed`/`stale`.
12. Verifica prod: `curl https://enlil.bar971.workers.dev/api/grid` nuova
    metrica, 3 modalità, `wrangler tail` a freddo.
13. Aggiornare "Debiti noti" di `HANDOFF.md` + memoria progetto se serve.

## Setup altro PC (per ripartire da zero)

1. `git clone https://github.com/bar971/Enlil.git` e, come cartella sorella,
   `git clone https://github.com/bar971/Enlil-secrets.git` (privato).
2. `cd Enlil && git checkout metrica-mappa`.
3. `cp ../Enlil-secrets/.env .env`  (gitignored; contiene `NOAA_TOKEN`).
4. `cp ../Enlil-secrets/cdsapirc ~/.cdsapirc`  (serve solo per `fetch_era5.py`,
   non per la climatologia OM).
5. `npm ci` (o `npm install`).
6. `npx wrangler login` se si deve deployare (OAuth `bar971@yahoo.it`, account
   `dcaf61703f63be2dcb360a0c2af4bc56`, namespace KV `enlil-cache`
   `076d8cde3bef436eabed421aa3e51546`).
7. `node --test` per sanity check, poi riprendere dal punto 2 di "PER CHIUDERE".

Stato repo al momento del salvataggio (2026-08-28 ~08:00 UTC):
- `github.com/bar971/Enlil` — `master` = `5effe3c` (feature popup NOAA, deployata);
  `metrica-mappa` = checkpoint WIP climatologia 264/306. Locale == origin per
  entrambi.
- `github.com/bar971/Enlil-secrets` — `master`, invariato in questa sessione
  (solo letto `.env`). Nessun segreto nuovo da sincronizzare.

## Context

La mappa mostra, per ogni punto, ΔT = (media ultimi 12 mesi) − (media dello **stesso
singolo anno** di 40 anni fa). Un solo anno come riferimento è rumoroso: la fase ENSO
del 2025–26 vs quella del 1985–86 può spostare il segnale di diversi decimi di grado, e
i numeri non sono confrontabili con l'anomalia "ufficiale" (~+1,2 °C). Il grafico è già
stato riallineato alla climatologia **1961–1990** (Fase 2): questo follow-up porta la
mappa sulla **stessa baseline**, così tutta l'app parla una lingua sola — "anomalia
rispetto alla media 1961–1990".

Nuova metrica: **ΔT[punto] = media(ultimi 12 mesi) − media climatologica 1961–1990[punto]**.

### Decisioni prese con l'utente
- Metrica: **anomalia vs climatologia 1961–1990** (non finestre mobili, non 1991–2020).
- ERA5: **rigenerare ora** dal CDS (`~/.cdsapirc` presente, `cdsapi`/`xarray` funzionano);
  se licenza dataset non accettata o coda CDS troppo lunga → segnalare e ripiegare
  (climatologia ERA5 su 1981–1990, ~⅓ del download, con nota).
- Deploy: come le fasi precedenti — branch `metrica-mappa`, un unico merge `--no-ff` su
  `master`, poi `npx wrangler deploy` manuale (l'auto-deploy non sincronizza i trigger),
  poi re-seed della chiave KV `grid`.

### Idea chiave: climatologia precalcolata, non sul percorso caldo
La climatologia 1961–1990 su griglia fissa **non cambia mai**. Si calcola una volta
offline (tollerando i 429 di Open-Meteo), si committa come asset (~5 KB), e il percorso
`/api/grid` continua a scaricare **solo gli ultimi 12 mesi** (stesso costo/quota di oggi,
anzi metà: 306 chiamate invece di 612). ΔT = recent − climatologia(asset).

## Modifiche

### 1. `lib/core.mjs`
- `buildPeriods()` → restituisce `{ recent, climatology }` dove
  `climatology = { start: "1961-01-01", end: "1990-12-31" }` (costante, NON scaricata sul
  percorso caldo; serve solo per etichette e per lo script offline).
- `buildGridPayload(climatologyMeans)` — nuova firma: riceve l'array delle medie
  climatologiche per punto (306 valori, ordine di `buildGrid()`), scarica solo `recent`
  con `fetchGridMeans` (invariata), e restituisce
  `{ fetchedAt, periods, grid, recent, baseline: climatologyMeans }` (la chiave `baseline`
  resta, ora contiene la climatologia per punto → il frontend non cambia forma).
- `fetchGridMeans` invariata (ora usata solo per `recent`, 1 anno).

### 2. Nuovo `scripts/gen_om_climatology.mjs` + asset committati
- Script Node (ESM): importa `buildGrid`, `fetchWithRetry` da `../lib/core.mjs`; cicla la
  griglia a **chunk piccoli (25 punti)** con pause lunghe e **salvataggio incrementale**
  su `public/data/om-climatology-1961-1990.json` (resume-safe contro i 429); ogni chunk
  chiede `start_date=1961-01-01&end_date=1990-12-31&daily=temperature_2m_mean` e media i
  valori non-null.
- Output `public/data/om-climatology-1961-1990.json`:
  `{ period, generatedAt, grid: [{lat,lon}...], mean: [float...] }` (306 entry).
- `public/data/om-climatology.js` (per la modalità standalone `file://`, che non può
  `fetch` un JSON locale): `const OM_CLIMATOLOGY = { …stesso oggetto… };` — stesso pattern
  di `data/gistemp.js`, generato dallo script insieme al JSON.
- Rigenerare `public/data/om-grid-seed.json` con la nuova metrica (recent fresco −
  climatologia), stesso ruolo di fallback finale.

### 3. `server.mjs` e `worker/index.js`
- `handleGrid`: carica la climatologia (server: `fs.readFileSync` di
  `public/data/om-climatology-1961-1990.json`; worker:
  `env.ASSETS.fetch("http://assets/data/om-climatology-1961-1990.json")`), passa `.mean`
  a `buildGridPayload`.
- `refreshGrid` (worker, cron): idem.
- Il resto (cache file/KV, seed fallback, header) invariato. Il seed ora è già nella
  metrica nuova.

### 4. `public/app.js`
- Copia inline di `buildPeriods` → nuova forma (`climatology` invece di `baseline`
  date-range). Il test di sync continua a confrontarla con `lib/core.mjs`.
- Modalità **backend**: nessun cambto di flusso — usa `payload.baseline` (ora climatologia)
  e `payload.recent` come oggi.
- Modalità **standalone**: `baseline = OM_CLIMATOLOGY.mean` (dallo script `<script src>`);
  scarica solo `recent` live; chiave localStorage → `v3` (cambia il significato dei means).
- Testi: `updateLegend` → "Anomalia vs media 1961–1990 (°C)"; popup marker → righe
  "Media ultimi 12 mesi", "Media climatologica 1961–1990", "Anomalia rispetto alla norma
  1961–1990"; riga di stato → "…; climatologia: 1961–1990".

### 5. `public/index.html`
- `<script src="data/om-climatology.js"></script>` prima di `app.js` (come `gistemp.js`).
- Sottotitolo → "anomalia di temperatura per punto: media degli ultimi 12 mesi rispetto
  alla media climatologica 1961–1990 (stessa baseline del grafico)".
- CSP `connect-src`: già include `archive-api.open-meteo.com` (standalone) — nessun cambio.

### 6. `scripts/fetch_era5.py` + `public/data/era5-grid.json`
- `baseline_months` = tutti i mesi 1961–1990 (360 stringhe `"YYYY-MM"`), non più
  `year_month_range(base_end)`. `download()` già deriva `year`/`month` dalla lista →
  richiesta CDS 30 anni × 12 mesi (~1 GB NetCDF, coda CDS).
- `mean_of(baseline_nc, baseline_months)` → media climatologica 1961–1990.
- `delta = mean_of(recent) - mean_of(baseline)`; coarsen / normalizzazione longitudini /
  output invariati.
- Rigenerare `public/data/era5-grid.json` (committato, ~450 KB). `data/*.nc` restano
  gitignored.
- **Ripiego** se il download 30 anni è impraticabile: `baseline_months` = 1981–1990 (120
  mesi), con commento nello script e nota "climatologia ERA5 su 1981–1990".

### 7. `test/`
- `test/sync.test.mjs`: `buildPeriods` continua a essere confrontata (nuova forma uguale
  fra app.js e core.mjs) — dep `fmtDate` già gestita.
- Aggiungere in `test/series.test.mjs` (o nuovo `test/periods.test.mjs`) un assert che
  `buildPeriods().climatology` = `{ start:"1961-01-01", end:"1990-12-31" }` e che
  `recent` copra ~1 anno.

### 8. Docs
- `HANDOFF.md` / `README.md`: descrizione mappa → nuova metrica; nuovi file
  (`gen_om_climatology.mjs`, `om-climatology-1961-1990.json`, `om-climatology.js`); nota
  che la climatologia OM è precalcolata e si rigenera con lo script.
- Rimuovere §4.1 dai "Debiti noti" di `HANDOFF.md`.

## Ordine di esecuzione

1. Branch `metrica-mappa`.
2. `lib/core.mjs` (buildPeriods + buildGridPayload).
3. Scrivere `scripts/gen_om_climatology.mjs`; **eseguirlo** (lungo, resume-safe) →
   `om-climatology-1961-1990.json` + `om-climatology.js`.
4. `server.mjs` + `worker/index.js` (carica climatologia). Test locale `node server.mjs`.
5. `app.js` + `index.html` (frontend + standalone + testi).
6. Rigenerare `om-grid-seed.json` (via `server.mjs` a cache vuota, o derivandolo).
7. `fetch_era5.py` → **eseguirlo** → `era5-grid.json` (o ripiego 1981–1990).
8. Test (`node --test`) + headless nelle 3 modalità.
9. Docs. Commit (4–6 commit coesi). Merge `--no-ff` su `master`. `npx wrangler deploy`.
10. Re-seed KV `grid` (nuova metrica); verifica prod.

## Verifica end-to-end

- `node scripts/gen_om_climatology.mjs` → 306 medie, valori assoluti plausibili
  (~ −35…+30 °C), ordine = `buildGrid()`.
- `node --test` verde (incluso il nuovo assert su `buildPeriods`).
- `node server.mjs` → `curl /api/grid`: `baseline` = climatologia, `recent` recente,
  `recent[i] − baseline[i]` con **media globale ~ +1,0…+1,4 °C** e amplificazione artica
  netta; `periods.climatology = {1961-01-01 … 1990-12-31}`.
- Headless (`server.mjs`): popup con "Media climatologica 1961–1990" e "Anomalia…",
  legenda aggiornata, 306 marker, grafico invariato, 0 violazioni CSP.
- `file://` standalone: usa `OM_CLIMATOLOGY` embedded, scarica solo `recent`, rende la
  mappa (se Open-Meteo non è in 429).
- `fetch_era5.py` → `era5-grid.json`: media anomalia globale ~ +1,0…+1,3 °C, range più
  stretto dell'attuale (−2,46…+6,68 → atteso più contenuto), Artico >> Tropici.
- Deploy: `curl https://enlil.bar971.workers.dev/api/grid` nuova metrica; re-seed KV;
  headless prod nelle 3 modalità; `wrangler tail` durante un load a freddo.
- Rollback: `git revert -m 1 <merge>` + push, o `wrangler rollback` + ripristino chiave KV
  `grid` dal dump precedente.

## Rischi

- **Open-Meteo 429 durante la generazione climatologia**: mitigato da chunk da 25, pause
  lunghe, salvataggio incrementale con resume. Può richiedere più passaggi.
- **CDS 30 anni**: coda + ~1 GB. Ripiego 1981–1990 documentato.
- **Worker cold `/api/grid`**: ora più leggero (solo `recent`) — rischio ridotto rispetto
  a oggi.
- **Coerenza dei 3 file con la copia inline in app.js**: `buildPeriods` coperta dal test
  di sync; la climatologia è un dato, non codice.
- La modalità standalone dipende da `om-climatology.js` committato: se non rigenerato
  resta disallineato dal backend — da fare nello stesso commit dell'asset JSON.

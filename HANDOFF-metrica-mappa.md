# Piano — follow-up §4.1: metrica della mappa Enlil

> Le Fasi 1–8 del piano di analisi precedente sono COMPLETATE e in produzione
> (`master` @ `387797a`). Questo file ora descrive il follow-up §4.1.

## STATO ESECUZIONE (2026-08-27, interrotto su richiesta — continuare altrove)

Branch **`metrica-mappa`** pushato su origin, 5 commit (`41d8b5f`..`5110318`).
**NON mergiato su master, NON deployato.**

FATTO e verificato:
- Codice completo: `lib/core.mjs` (buildPeriods→`{recent,climatology}`,
  `buildGridPayload(climatologyMeans)`), `server.mjs` + `worker/index.js`
  (caricano l'asset climatologia), `app.js` + `index.html` (metrica, testi,
  standalone con `OM_CLIMATOLOGY` embedded), `scripts/gen_om_climatology.mjs`,
  `scripts/fetch_era5.py` (baseline 1961–1990 + emette la climatologia OM).
- `node --test` → 13/13 pass (nuovo assert su `buildPeriods`).
- `server.mjs` `/api/grid` restituisce la forma nuova (seed fallback, perché
  Open-Meteo è in 429): `periods.climatology` OK, ΔT media +1,24 °C.
- **ERA5 rigenerato e CORRETTO**: `public/data/era5-grid.json` nuova metrica —
  media anomalia globale **+1,41 °C**, range −0,83…+7,12 (più stretto),
  Artico +2,94 vs Tropici +0,78. Questo layer è pronto.

BLOCCATO:
- **Quota giornaliera Open-Meteo esaurita** ("try again tomorrow", reset 00:00
  UTC). `scripts/gen_om_climatology.mjs` non ha potuto girare.
- `public/data/om-climatology-1961-1990.json` e `om-climatology.js` committati
  sono **PROVVISORI** — campionati da ERA5 da `fetch_era5.py`. Verificato: ~20
  punti su 306 (poli/coste) hanno artefatti grossi (es. lat −70: ΔT −6,9 dove
  ERA5 dà +2,0). **Non deployabile così**: la mappa OM mostrerebbe blu spurio
  ai poli.

PER CHIUDERE (dopo reset quota Open-Meteo, ~00:00 UTC):
1. `git checkout metrica-mappa`
2. `node scripts/gen_om_climatology.mjs` (resume-safe; ~13 richieste, pochi
   minuti) → rigenera `om-climatology-1961-1990.json` + `om-climatology.js`
   con dati Open-Meteo veri.
3. Rigenerare `om-grid-seed.json`: prendere `recent` dal dump KV `grid` di
   produzione (metrica-indipendente) + `baseline` = nuova climatologia.
   Script già usato: vedi comando in cronologia (KV get + node one-liner).
4. `node --test`; verifica headless (`server.mjs` + `file://`): popup con
   "Media climatologica 1961–1990"/"Anomalia…", legenda aggiornata, ΔT media
   ~+1,2…+1,4, niente blu spurio ai poli, 0 violazioni CSP.
5. `git commit --amend` sul commit `43dad18` (o commit nuovo) con la
   climatologia vera; aggiornare la NOTA "PROVVISORIA" nei messaggi/HANDOFF.
6. `git checkout master && git merge --no-ff metrica-mappa && git push`
7. `npx wrangler deploy` (l'auto-deploy non sincronizza i trigger).
8. Re-seed KV `grid` con la nuova metrica:
   `npx wrangler kv key put grid --namespace-id 076d8cde3bef436eabed421aa3e51546 --path <nuovo-payload> --metadata '{"ts": <epoch>}'`
   (payload = `om-grid-seed.json` senza i flag `seed`/`stale`).
9. Verifica prod: `/api/grid` nuova metrica, headless nelle 3 modalità,
   `wrangler tail` a freddo.
10. Aggiornare i "Debiti noti" di HANDOFF (togliere la nota climatologia
    provvisoria) e la memoria progetto se serve.

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

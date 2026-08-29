/* Enlil — genera la climatologia Open-Meteo 1961-1990 per la griglia della mappa.
 *
 *   node scripts/gen_om_climatology.mjs
 *
 * Output:
 *   public/data/om-climatology-1961-1990.json  { period, generatedAt, grid, mean }
 *   public/data/om-climatology.js              const OM_CLIMATOLOGY = {…}  (modalità file://)
 *
 * La climatologia su griglia fissa non cambia mai: si calcola una volta e si
 * committa. Il range 1961-1990 in un'unica richiesta ha un "call weight" alto su
 * Open-Meteo e viene throttlato (429) dopo pochi chunk: si spezza in tre decadi
 * (ogni richiesta pesa ~1/3) e per ogni punto si media pesando sul numero di
 * giorni validi — identico a una richiesta unica 1961-1990, a meno dei null.
 * Chunk piccoli, pause lunghe, salvataggio incrementale (resume-safe): rilanciare
 * lo script riprende da dove si era interrotto.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildGrid, fetchWithRetry, CLIMATOLOGY, sleep } from "../lib/core.mjs";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const JSON_FILE = join(OUT_DIR, "om-climatology-1961-1990.json");
const JS_FILE = join(OUT_DIR, "om-climatology.js");

// Pacing configurabile da env per adattarsi allo stato del rate-limit Open-Meteo
// senza toccare i default (25 / 4s / 2s vanno bene a quota piena).
const CHUNK = Number(process.env.OM_CLIM_CHUNK) || 25;
const DELAY_MS = Number(process.env.OM_CLIM_DELAY_MS) || 4000;
const WINDOW_DELAY_MS = Number(process.env.OM_CLIM_WINDOW_DELAY_MS) || 2000;
// Le tre decadi partizionano esattamente 1961-01-01..1990-12-31 (nessun buco né
// sovrapposizione): sommando i giorni validi di tutte e tre si ottiene la stessa
// media di una richiesta unica sull'intero trentennio.
const WINDOWS = [
  { start: "1961-01-01", end: "1970-12-31" },
  { start: "1971-01-01", end: "1980-12-31" },
  { start: "1981-01-01", end: "1990-12-31" },
];

const grid = buildGrid();

// resume: se il JSON esiste già ed è coerente con la griglia corrente, riparti
let mean = [];
try {
  const prev = JSON.parse(readFileSync(JSON_FILE, "utf8"));
  if (
    prev.period?.start === CLIMATOLOGY.start &&
    JSON.stringify(prev.grid) === JSON.stringify(grid) &&
    Array.isArray(prev.mean) &&
    prev.mean.length <= grid.length
  ) {
    mean = prev.mean;
    console.log(`Ripresa: ${mean.length}/${grid.length} punti già calcolati`);
  }
} catch { /* nessun file precedente */ }

function save() {
  const obj = { period: { ...CLIMATOLOGY }, generatedAt: new Date().toISOString(), grid, mean };
  writeFileSync(JSON_FILE, JSON.stringify(obj));
  return obj;
}

// Media climatologica di un chunk di punti: per ogni punto somma i valori
// giornalieri di tutte le decadi e divide per il conteggio totale.
async function chunkMeans(chunk) {
  const sum = new Array(chunk.length).fill(0);
  const cnt = new Array(chunk.length).fill(0);
  for (const w of WINDOWS) {
    const params = new URLSearchParams({
      latitude: chunk.map((p) => p.lat).join(","),
      longitude: chunk.map((p) => p.lon).join(","),
      start_date: w.start,
      end_date: w.end,
      daily: "temperature_2m_mean",
    });
    const up = await fetchWithRetry(`https://archive-api.open-meteo.com/v1/archive?${params}`, { retries: 2 });
    const data = await up.json();
    const locations = Array.isArray(data) ? data : [data];
    locations.forEach((loc, k) => {
      for (const v of loc.daily?.temperature_2m_mean || []) {
        if (v !== null) { sum[k] += v; cnt[k] += 1; }
      }
    });
    if (w !== WINDOWS[WINDOWS.length - 1]) await sleep(WINDOW_DELAY_MS);
  }
  return sum.map((s, k) => (cnt[k] ? s / cnt[k] : null));
}

for (let i = mean.length; i < grid.length; i += CHUNK) {
  const chunk = grid.slice(i, i + CHUNK);
  mean.push(...(await chunkMeans(chunk)));
  save();
  console.log(`${mean.length}/${grid.length} punti`);
  if (i + CHUNK < grid.length) await sleep(DELAY_MS);
}

const obj = save();
writeFileSync(JS_FILE, `// Climatologia Open-Meteo 1961-1990 per la griglia mappa (modalità standalone).\n// Generato da scripts/gen_om_climatology.mjs il ${obj.generatedAt.slice(0, 10)}.\nconst OM_CLIMATOLOGY = ${JSON.stringify(obj)};\n`);

const valid = mean.filter((v) => v !== null);
console.log(
  `Fatto: ${mean.length} punti (${valid.length} validi), media globale ${(
    valid.reduce((a, b) => a + b, 0) / valid.length
  ).toFixed(2)} °C`
);

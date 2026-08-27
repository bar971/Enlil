/* Enlil — genera la climatologia Open-Meteo 1961-1990 per la griglia della mappa.
 *
 *   node scripts/gen_om_climatology.mjs
 *
 * Output:
 *   public/data/om-climatology-1961-1990.json  { period, generatedAt, grid, mean }
 *   public/data/om-climatology.js              const OM_CLIMATOLOGY = {…}  (modalità file://)
 *
 * La climatologia su griglia fissa non cambia mai: si calcola una volta e si
 * committa. Ogni richiesta copre un range di 30 anni per pochi punti, quindi
 * chunk piccoli, pause lunghe e salvataggio incrementale (resume-safe contro i
 * 429). Rilanciare lo script riprende da dove si era interrotto.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildGrid, fetchWithRetry, CLIMATOLOGY, sleep } from "../lib/core.mjs";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const JSON_FILE = join(OUT_DIR, "om-climatology-1961-1990.json");
const JS_FILE = join(OUT_DIR, "om-climatology.js");

const CHUNK = 25;
const DELAY_MS = 4000;

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

for (let i = mean.length; i < grid.length; i += CHUNK) {
  const chunk = grid.slice(i, i + CHUNK);
  const params = new URLSearchParams({
    latitude: chunk.map((p) => p.lat).join(","),
    longitude: chunk.map((p) => p.lon).join(","),
    start_date: CLIMATOLOGY.start,
    end_date: CLIMATOLOGY.end,
    daily: "temperature_2m_mean",
  });
  const up = await fetchWithRetry(`https://archive-api.open-meteo.com/v1/archive?${params}`);
  const data = await up.json();
  const locations = Array.isArray(data) ? data : [data];
  for (const loc of locations) {
    const vals = (loc.daily?.temperature_2m_mean || []).filter((v) => v !== null);
    mean.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  }
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

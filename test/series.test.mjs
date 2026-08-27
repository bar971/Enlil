/* Test dei parser e del riallineamento serie (lib/series.mjs). */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseGistemp, parseHadcrut5, parseBerkeley, rebaseline } from "../lib/series.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name) => readFileSync(join(FIX, name), "utf8");

test("parseGistemp: usa la colonna J-D, scarta header, *** e anni incompleti", () => {
  const out = parseGistemp(fx("gistemp.csv"));
  assert.deepEqual(out, [
    { year: 1960, anomaly: 0.01 },
    { year: 1970, anomaly: 0.03 },
    { year: 2015, anomaly: 0.98 },
  ]);
  // il 2026 (J-D = ***) non deve comparire
  assert.ok(!out.some((d) => d.year === 2026));
});

test("parseHadcrut5: media annuale solo per anni con 12 mesi", () => {
  const out = parseHadcrut5(fx("hadcrut5.csv"));
  assert.equal(out.length, 1);
  assert.equal(out[0].year, 1960);
  assert.ok(Math.abs(out[0].anomaly - 0.2) < 1e-9);
  // il 1961 ha solo 3 mesi -> escluso
  assert.ok(!out.some((d) => d.year === 1961));
});

test("parseBerkeley: scarta righe di commento % e righe non numeriche", () => {
  const out = parseBerkeley(fx("berkeley.txt"));
  assert.deepEqual(out, [
    { year: 1960, anomaly: -0.02 },
    { year: 1970, anomaly: 0.01 },
    { year: 2015, anomaly: 0.81 },
  ]);
});

test("rebaseline: sottrae la media della finestra [from, to]", () => {
  const series = [];
  for (let y = 1961; y <= 1990; y++) series.push({ year: y, anomaly: 0.5 });
  series.push({ year: 2000, anomaly: 1.5 });
  const out = rebaseline(series, 1961, 1990);
  assert.ok(out.slice(0, 30).every((d) => Math.abs(d.anomaly) < 1e-9)); // finestra -> 0
  assert.ok(Math.abs(out.at(-1).anomaly - 1.0) < 1e-9); // 1.5 - 0.5
});

test("rebaseline: serie con <25 anni nella finestra resta invariata", () => {
  const series = [];
  for (let y = 1980; y <= 1990; y++) series.push({ year: y, anomaly: 0.7 }); // 11 anni
  const out = rebaseline(series, 1961, 1990);
  assert.deepEqual(out, series);
});

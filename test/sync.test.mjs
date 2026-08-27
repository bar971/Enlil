/* Verifica che le copie inline in public/app.js (script classico, non può
 * importare moduli ES per via della modalità file://) restino equivalenti,
 * per COMPORTAMENTO, alle versioni canoniche in lib/series.mjs e lib/core.mjs.
 *
 * Approccio: si estrae il sorgente della funzione da app.js, la si istanzia
 * con new Function e si confrontano gli output con la versione di lib/ su input
 * di prova. Immune a differenze di formattazione/commenti. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as series from "../lib/series.mjs";
import * as core from "../lib/core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const appJs = readFileSync(join(ROOT, "public", "app.js"), "utf8");
const fx = (name) => readFileSync(join(ROOT, "test", "fixtures", name), "utf8");

/* Estrae "function nome(...) { ... }" bilanciando le graffe. Le graffe dentro
 * stringhe/regex di queste funzioni sono sempre bilanciate, quindi il conteggio
 * ingenuo è sufficiente. */
function extractFnSource(src, name) {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`funzione ${name} non trovata`);
  const braceStart = src.indexOf("{", m.index + m[0].length);
  if (braceStart < 0) throw new Error(`corpo di ${name} non trovato`);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { i++; break; }
  }
  const decl = src.slice(m.index, braceStart).replace(/^export\s+/, "");
  return decl + src.slice(braceStart, i);
}

/* Estrae "const NOME = …;" su una riga (le const condivise sono oggetti inline). */
function extractConst(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*`);
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} non trovata`);
  const end = src.indexOf(";", m.index);
  return src.slice(m.index, end + 1);
}

/* deps: nomi di funzioni o const da includere nello scope prima di `name`. */
function loadFn(src, name, deps = []) {
  const parts = deps.map((d) => {
    try { return extractFnSource(src, d); } catch { return extractConst(src, d); }
  });
  parts.push(extractFnSource(src, name));
  // eslint-disable-next-line no-new-func
  return new Function(`${parts.join("\n")}\nreturn ${name};`)();
}

const eq = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

for (const name of ["parseGistemp", "parseHadcrut5", "parseBerkeley"]) {
  test(`app.js ${name} == lib/series.mjs ${name}`, () => {
    const appFn = loadFn(appJs, name);
    const input = fx(name === "parseGistemp" ? "gistemp.csv" : name === "parseHadcrut5" ? "hadcrut5.csv" : "berkeley.txt");
    eq(appFn(input), series[name](input));
  });
}

test("app.js rebaseline == lib/series.mjs rebaseline", () => {
  const appFn = loadFn(appJs, "rebaseline");
  const s = [];
  for (let y = 1955; y <= 2005; y++) s.push({ year: y, anomaly: Math.sin(y) });
  eq(appFn(s, 1961, 1990), series.rebaseline(s, 1961, 1990));
  const short = s.filter((d) => d.year >= 1985);
  eq(appFn(short, 1961, 1990), series.rebaseline(short, 1961, 1990));
});

test("app.js buildGrid == lib/core.mjs buildGrid", () => {
  eq(loadFn(appJs, "buildGrid")(), core.buildGrid());
});

test("app.js fmtDate == lib/core.mjs fmtDate", () => {
  const d = new Date("2026-03-14T09:26:53.000Z");
  assert.equal(loadFn(appJs, "fmtDate")(d), core.fmtDate(d));
});

test("app.js buildPeriods == lib/core.mjs buildPeriods", () => {
  const appFn = loadFn(appJs, "buildPeriods", ["CLIMATOLOGY", "fmtDate"]);
  // due chiamate a microsecondi di distanza: uguali salvo il tick di mezzanotte
  // UTC, nel qual caso si riprova una volta
  let a = JSON.stringify(appFn()), b = JSON.stringify(core.buildPeriods());
  if (a !== b) { a = JSON.stringify(appFn()); b = JSON.stringify(core.buildPeriods()); }
  assert.equal(a, b);
});

test("lib/core.mjs buildPeriods: climatologia fissa 1961-1990, recent ~1 anno", () => {
  const p = core.buildPeriods();
  assert.deepEqual(p.climatology, { start: "1961-01-01", end: "1990-12-31" });
  const days = (new Date(p.recent.end) - new Date(p.recent.start)) / 86400000;
  assert.ok(days >= 364 && days <= 367, `recent copre ${days} giorni`);
});

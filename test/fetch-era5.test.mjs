/* Regressione: lo script ERA5 non deve poter modificare gli asset della
 * climatologia Open-Meteo. Il test controlla sia i nomi proibiti sia tutti i
 * target aperti esplicitamente in scrittura, senza richiedere cdsapi/xarray o
 * effettuare download in CI. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(ROOT, "scripts", "fetch_era5.py"), "utf8");
const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");

test("fetch_era5 non scrive gli asset climatologici Open-Meteo", () => {
  assert.doesNotMatch(source, /om-climatology(?:-1961-1990)?\.(?:json|js)/);
  assert.doesNotMatch(source, /write_om_climatology|OM_CLIM_(?:JSON|JS)/);

  const writeTargets = [
    ...source.matchAll(/open\(\s*([A-Z][A-Z0-9_]*)\s*,\s*["']w["']/g),
  ].map((match) => match[1]);
  assert.deepEqual(writeTargets, ["OUT_FILE", "META_FILE"]);
  assert.match(source, /OUT_FILE\s*=.*["']era5-grid\.json["']/);
  assert.match(source, /META_FILE\s*=.*["']era5-grid\.meta\.json["']/);
});

test("fetch_era5 riusa e valida la baseline salvo refresh esplicito", () => {
  assert.match(source, /--refresh-baseline/);
  assert.match(source, /--validate-baseline/);
  assert.match(source, /def ensure_baseline\(/);
  assert.match(source, /available_months\(target\)/);
  assert.match(source, /Rilancia con --refresh-baseline/);
  assert.match(source, /partial = target \+ ["']\.part["']/);
  assert.match(source, /os\.replace\(partial, target\)/);
  assert.match(gitignore, /^data\/\*\.nc\.part$/m);
});

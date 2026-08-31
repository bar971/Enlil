import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cachedFile, readCache, readStale } from "../lib/file-cache.mjs";

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "enlil-cache-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "entry.txt");
}

test("cache file: hit fresco senza chiamare upstream", async (t) => {
  const file = tempFile(t);
  writeFileSync(file, "cached");
  let calls = 0;

  const result = await cachedFile(file, 60_000, async () => { calls++; return "new"; });

  assert.deepEqual(result, { body: "cached", source: "fresh" });
  assert.equal(calls, 0);
});

test("cache file: entry scaduta viene aggiornata e salvata", async (t) => {
  const file = tempFile(t);
  writeFileSync(file, "old");
  const old = new Date(Date.now() - 120_000);
  utimesSync(file, old, old);

  assert.equal(readCache(file, 60_000), null);
  const result = await cachedFile(file, 60_000, async () => "new");

  assert.deepEqual(result, { body: "new", source: "upstream" });
  assert.equal(readFileSync(file, "utf8"), "new");
});

test("cache file: errore upstream serve la copia stale", async (t) => {
  const file = tempFile(t);
  writeFileSync(file, "fallback");
  const old = new Date(Date.now() - 120_000);
  utimesSync(file, old, old);

  const result = await cachedFile(file, 60_000, async () => { throw new Error("offline"); });

  assert.deepEqual(result, { body: "fallback", source: "stale" });
  assert.equal(readStale(file), "fallback");
});

test("cache file: miss senza fallback propaga l'errore upstream", async (t) => {
  const file = tempFile(t);
  await assert.rejects(
    cachedFile(file, 60_000, async () => { throw new Error("offline"); }),
    /offline/
  );
  assert.equal(readStale(file), null);
});

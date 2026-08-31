import test from "node:test";
import assert from "node:assert/strict";

import worker from "../worker/index.js";

const NOW = Date.parse("2026-08-31T12:00:00Z");
const freshTs = Math.floor(NOW / 1000) - 60;
const staleTs = Math.floor(NOW / 1000) - 25 * 3600;

function harness(entry) {
  const puts = [];
  const waits = [];
  return {
    env: {
      ENLIL_CACHE: {
        getWithMetadata: async () => entry,
        put: async (...args) => { puts.push(args); },
      },
    },
    ctx: { waitUntil(promise) { waits.push(promise); } },
    puts,
    waits,
  };
}

test("cache KV: hit fresco evita upstream", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch non atteso");
  });
  const h = harness({ value: "cached", metadata: { ts: freshTs } });

  const response = await worker.fetch(new Request("https://enlil.test/api/gistemp"), h.env, h.ctx);

  assert.equal(await response.text(), "cached");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300, stale-while-revalidate=3600");
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(h.waits.length, 0);
});

test("cache KV: entry scaduta viene aggiornata in background", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  t.mock.method(globalThis, "fetch", async () => new Response("updated"));
  const h = harness({ value: "old", metadata: { ts: staleTs } });

  const response = await worker.fetch(new Request("https://enlil.test/api/gistemp"), h.env, h.ctx);
  await Promise.all(h.waits);

  assert.equal(await response.text(), "updated");
  assert.equal(h.puts.length, 1);
  assert.equal(h.puts[0][0], "gistemp");
  assert.equal(h.puts[0][1], "updated");
  assert.deepEqual(h.puts[0][2], { metadata: { ts: Math.floor(NOW / 1000) } });
});

test("cache KV: errore upstream serve stale con header esplicito", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const h = harness({ value: "fallback", metadata: { ts: staleTs } });

  const response = await worker.fetch(new Request("https://enlil.test/api/gistemp"), h.env, h.ctx);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "fallback");
  assert.equal(response.headers.get("X-Enlil-Stale"), "1");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=60");
});

test("cache KV: miss e upstream offline restituiscono 502", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const h = harness({ value: null, metadata: null });

  const response = await worker.fetch(new Request("https://enlil.test/api/gistemp"), h.env, h.ctx);

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "offline" });
});

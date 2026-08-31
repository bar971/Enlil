/* End-to-end dell'entrypoint Worker: Request -> router -> binding -> Response.
 * I binding KV e ASSETS sono implementati in memoria/sul filesystem locale,
 * mantenendo il test deterministico e privo di accessi alla rete. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../worker/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const NOW = Date.parse("2026-08-31T12:00:00Z");
const FRESH_TS = Math.floor(NOW / 1000) - 60;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".js": "text/javascript; charset=utf-8",
};

class MemoryKv {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  async get(key) {
    return this.entries.get(key)?.value ?? null;
  }

  async getWithMetadata(key) {
    return this.entries.get(key) ?? { value: null, metadata: null };
  }

  async put(key, value, options = {}) {
    this.entries.set(key, { value, metadata: options.metadata ?? null });
  }
}

const assets = {
  async fetch(input) {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = normalize(join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return new Response("Forbidden", { status: 403 });
    try {
      return new Response(readFileSync(file), {
        headers: { "Content-Type": MIME[extname(file)] || "application/octet-stream" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

function harness(entries = {}) {
  const waits = [];
  return {
    env: { ENLIL_CACHE: new MemoryKv(entries), ASSETS: assets, NOAA_TOKEN: "test-token" },
    ctx: { waitUntil(promise) { waits.push(promise); } },
    async drain() { await Promise.all(waits); },
  };
}

test("Worker e2e: health verifica binding, secret e asset ERA5", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const h = harness();

  const response = await worker.fetch(new Request("https://enlil.test/api/health"), h.env, h.ctx);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, providers: { noaa: true, era5: true } });
});

test("Worker e2e: statici e rotta ERA5 passano dal binding ASSETS", async () => {
  const h = harness();

  const page = await worker.fetch(new Request("https://enlil.test/"), h.env, h.ctx);
  const era5 = await worker.fetch(new Request("https://enlil.test/api/era5"), h.env, h.ctx);
  const missing = await worker.fetch(new Request("https://enlil.test/non-esiste.txt"), h.env, h.ctx);

  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Type"), /^text\/html/);
  assert.match(await page.text(), /<!doctype html>/i);
  assert.equal(era5.status, 200);
  assert.ok(Array.isArray(await era5.json()));
  assert.equal(missing.status, 404);
});

test("Worker e2e: /api/grid serve il payload fresco dalla KV", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("upstream non atteso");
  });
  const payload = { grid: [{ lat: 0, lon: 0 }], recent: [1.5], baseline: [0.5] };
  const h = harness({ grid: { value: JSON.stringify(payload), metadata: { ts: FRESH_TS } } });

  const response = await worker.fetch(new Request("https://enlil.test/api/grid"), h.env, h.ctx);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300, stale-while-revalidate=3600");
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Worker e2e: NOAA applica rate limit e serve la risposta dalla KV", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("NOAA upstream non atteso");
  });
  const body = { station: { id: "TEST", name: "Test", distanceKm: 1 }, tavg: 12 };
  const h = harness({
    "noaa:45.0:9.0": {
      value: JSON.stringify(body),
      metadata: { ts: FRESH_TS, status: 200 },
    },
  });
  const request = new Request("https://enlil.test/api/noaa/station-data?lat=45&lon=9", {
    headers: { "CF-Connecting-IP": "192.0.2.1" },
  });

  const response = await worker.fetch(request, h.env, h.ctx);
  await h.drain();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Enlil-Cache"), "kv");
  assert.deepEqual(await response.json(), body);
  assert.equal(fetchMock.mock.callCount(), 0);
  const rateKey = `noaa-rl:192.0.2.1:${Math.floor(NOW / 60000)}`;
  assert.equal(await h.env.ENLIL_CACHE.get(rateKey), "1");
});

import test from "node:test";
import assert from "node:assert/strict";

import { noaaStationData } from "../lib/core.mjs";

const FIXED_NOW = Date.parse("2026-08-31T12:00:00Z");

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test("NOAA: valida coordinate e non interroga la rete", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch non atteso");
  });

  assert.deepEqual(await noaaStationData("token", NaN, 9), {
    status: 400,
    body: { error: "Parametri lat/lon mancanti o non validi" },
  });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("NOAA: clampa l'extent e restituisce 404 se le stazioni sono obsolete", async (t) => {
  t.mock.method(Date, "now", () => FIXED_NOW);
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ results: [{ id: "OLD", maxdate: "2020-01-01", latitude: 90, longitude: 180 }] })
  );

  const result = await noaaStationData("secret", 89.7, 179.8);

  assert.equal(result.status, 404);
  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, options] = fetchMock.mock.calls[0].arguments;
  assert.match(url, /extent=88\.70,178\.80,90\.00,180\.00/);
  assert.equal(options.headers.token, "secret");
});

test("NOAA: sceglie la stazione recente più vicina e calcola medie ed estremi", async (t) => {
  t.mock.method(Date, "now", () => FIXED_NOW);
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    if (url.includes("/stations?")) {
      return jsonResponse({ results: [
        { id: "STALE", name: "Vecchia", latitude: 45.001, longitude: 9.001, maxdate: "2020-01-01" },
        { id: "FAR", name: "Lontana", latitude: 45.8, longitude: 9.8, maxdate: "2025-08-15" },
        { id: "NEAR", name: "Vicina", latitude: 45.02, longitude: 9.01, maxdate: "2025-08-15" },
      ] });
    }
    return jsonResponse({ results: [
      { datatype: "TAVG", date: "2025-01-01T00:00:00", value: 10 },
      { datatype: "TAVG", date: "2025-01-02T00:00:00", value: 14 },
      { datatype: "TMAX", date: "2025-06-01T00:00:00", value: 30 },
      { datatype: "TMAX", date: "2025-06-02T00:00:00", value: 30 },
      { datatype: "TMIN", date: "2025-02-01T00:00:00", value: -4 },
      { datatype: "TMIN", date: "2025-02-02T00:00:00", value: -4 },
    ] });
  });

  const { status, body } = await noaaStationData("token", 45, 9);

  assert.equal(status, 200);
  assert.deepEqual(body.station, { id: "NEAR", name: "Vicina", distanceKm: 2 });
  assert.deepEqual(body.period, { start: "2024-08-15", end: "2025-08-15" });
  assert.equal(body.tavg, 12);
  assert.equal(body.tmax, 30);
  assert.equal(body.tmin, -4);
  assert.deepEqual(body.warmestDay, { date: "2025-06-02", value: 30 });
  assert.deepEqual(body.coldestDay, { date: "2025-02-02", value: -4 });
  assert.match(urls[1], /stationid=NEAR/);
  assert.match(urls[1], /offset=1/);
});

test("NOAA: pagina oltre 1000 record e lascia null i tipi mancanti", async (t) => {
  t.mock.method(Date, "now", () => FIXED_NOW);
  const offsets = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/stations?")) {
      return jsonResponse({ results: [
        { id: "PAGED", name: "Paginata", latitude: 0, longitude: 0, maxdate: "2026-08-01" },
      ] });
    }
    const offset = new URL(url).searchParams.get("offset");
    offsets.push(offset);
    if (offset === "1") {
      return jsonResponse({ results: Array.from({ length: 1000 }, (_, i) => ({
        datatype: "TAVG", date: `2025-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00`, value: 10,
      })) });
    }
    return jsonResponse({ results: [
      { datatype: "TAVG", date: "2026-08-01T00:00:00", value: 20 },
    ] });
  });

  const { status, body } = await noaaStationData("token", 0, 0);

  assert.equal(status, 200);
  assert.deepEqual(offsets, ["1", "1001"]);
  assert.equal(body.tavg, 10020 / 1001);
  assert.equal(body.tmax, null);
  assert.equal(body.tmin, null);
  assert.equal(body.warmestDay, null);
  assert.equal(body.coldestDay, null);
});

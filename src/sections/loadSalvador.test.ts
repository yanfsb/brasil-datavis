import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { clearSalvadorCache, loadSalvadorPlace, loadSalvadorSummary, parseSalvadorPlace, parseSalvadorSummary } from "./loadSalvador.ts";
import type { SalvadorSummary } from "./loadSalvador.ts";

const fixture = JSON.parse(readFileSync(new URL("../../public/data/salvador/summary.json", import.meta.url), "utf8")) as SalvadorSummary;

test("validates the published nested city summary and lazy detail", () => {
  assert.equal(parseSalvadorSummary(fixture).municipality.tseCode, "38490");
  const mapped = fixture.places.find((item) => item.neighborhoodCode && item.mapCoordinate && item.tallies?.length);
  assert.ok(mapped, "published place index includes assignment, geographic coordinates, and candidate tallies");
  const place = fixture.places[0];
  assert.ok(place);
  const detail = JSON.parse(readFileSync(new URL(`../../public/data/salvador/${place.detail}`, import.meta.url), "utf8"));
  assert.equal(parseSalvadorPlace(detail, place).sections.length, place.sectionCount);
});

test("rejects malformed nested fields, invalid counts, election/version mismatch and unknown identities", () => {
  const malformed = structuredClone(fixture) as unknown as Record<string, unknown>;
  (malformed.neighborhoods as { features: { properties: { votesByCandidate: Record<string, unknown> } }[] }).features[0]!.properties.votesByCandidate["13"] = NaN;
  assert.throws(() => parseSalvadorSummary(malformed), /safe integer/);
  for (const change of [
    (value: any) => { value.schemaVersion = 2; },
    (value: any) => { value.election.year = 2022; },
    (value: any) => { value.candidates.pop(); },
    (value: any) => { value.municipality.tseCode = "99999"; },
    (value: any) => { value.places[0].detail = "places/other.json"; },
    (value: any) => { value.places[0].sectionCount = -1; },
    (value: any) => { value.places[0].mapCoordinate = { longitude: 999, latitude: 0 }; },
    (value: any) => { value.places[0].tallies = [{ candidateNumber: "13", votes: 1 }, { candidateNumber: "13", votes: 2 }]; },
    (value: any) => { value.neighborhoods.features[0].geometry.coordinates = [[[[Infinity, 0], [0, 0], [0, 1], [Infinity, 0]]]]; value.neighborhoods.features[0].geometry.type = "MultiPolygon"; },
  ]) {
    const value = structuredClone(fixture);
    change(value);
    assert.throws(() => parseSalvadorSummary(value));
  }
});

test("place detail must match indexed identity, version, and section counts", () => {
  const place = fixture.places[0]!;
  const detail = JSON.parse(readFileSync(new URL(`../../public/data/salvador/${place.detail}`, import.meta.url), "utf8")) as Record<string, any>;
  assert.throws(() => parseSalvadorPlace({ ...detail, schemaVersion: 2 }, place), /version/);
  assert.throws(() => parseSalvadorPlace({ ...detail, place: { ...detail.place, placeCode: "9999" } }, place), /identity/);
  assert.throws(() => parseSalvadorPlace({ ...detail, sections: [{ section: "1", votesByCode: { "13": -1 } }] }, { ...place, sectionCount: 1 }), /safe integer/);
  assert.throws(() => parseSalvadorPlace({ ...detail, sections: [] }, place), /count mismatch/);
});

test("summary and place failures are retried instead of cached", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; clearSalvadorCache(); });
  clearSalvadorCache();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1 ? new Response("bad", { status: 500 }) : new Response(JSON.stringify(fixture));
  }) as typeof fetch;
  await assert.rejects(() => loadSalvadorSummary());
  assert.equal((await loadSalvadorSummary()).municipality.name, "Salvador");
  assert.equal(calls, 2);

  const place = fixture.places[0]!;
  calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1 ? new Response("bad", { status: 500 }) : new Response(JSON.stringify({ schemaVersion: 1, place: { municipalityCode: "38490", zone: place.zone, placeCode: place.placeCode }, sections: [] }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(() => loadSalvadorPlace(place));
  await assert.rejects(() => loadSalvadorPlace(place), /section count mismatch/);
  assert.equal(calls, 2);
});

test("a missing published summary does not recognize Salvador and abort is preserved", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; clearSalvadorCache(); });
  clearSalvadorCache();
  globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
  await assert.rejects(() => loadSalvadorSummary(), /Published Salvador asset is missing/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => loadSalvadorSummary(controller.signal), { name: "AbortError" });
});

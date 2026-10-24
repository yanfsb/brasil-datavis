import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeBairro } from "./normalizeBairro.ts";
import { clearSectionTileCache, loadSectionTile, parseSectionTile, sectionTilePath } from "./loadTile.ts";
import { sectionKey, ufCode, type PollingPlace, type SectionTile } from "./types.ts";

const tile: SectionTile = {
  uf: ufCode("BA"),
  election: { year: 2026, round: 1, office: "president", officeCode: "1" },
  places: [place()],
  neighborhoods: [
    {
      municipalityCode: "38490",
      neighborhoodKey: "CENTRO",
      label: "Centro",
      placeCount: 1,
      sectionCount: 2,
      electorate: 600,
      tallies: [{ candidateNumber: "13", votes: 240 }],
    },
  ],
};

test("section identity and UF codes are branded strings", () => {
  assert.equal(sectionKey({ uf: " ba ", municipalityCode: "38490", zone: "001", section: "0042" }), "BA:38490:001:0042");
  assert.equal(ufCode("ba"), "BA");
  assert.equal(sectionTilePath("ba"), "/data/sections/BA.json");
  assert.throws(() => ufCode("ZZ"), /invalid UF code/);
  assert.throws(() => sectionKey({ uf: "BA", municipalityCode: "", zone: "1", section: "1" }), /section key/);
});

test("a tile object keeps places and neighborhood aggregates", () => {
  const parsed = parseSectionTile(tile);
  assert.equal(parsed.uf, "BA");
  assert.equal(parsed.election.office, "president");
  assert.equal(parsed.places.length, 1);
  assert.equal(parsed.neighborhoods[0]?.neighborhoodKey, normalizeBairro("Centro").key);
  assert.equal(parsed.places[0]?.neighborhoodLabel, "Centro");
});

test("the checked-in example is a fake UF file, not a loadable tile", () => {
  const example = JSON.parse(readFileSync(new URL("../../public/data/sections/_example.json", import.meta.url), "utf8")) as { uf?: string };
  assert.equal(example.uf, "EX");
  assert.throws(() => parseSectionTile(example), /known state code/);
});

test("loadSectionTile fetches each UF once and reuses the promise", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
    clearSectionTileCache();
  });
  clearSectionTileCache();
  let calls = 0;
  let respond: (response: Response) => void = () => {};
  globalThis.fetch = (() => {
    calls += 1;
    return new Promise<Response>((resolve) => {
      respond = resolve;
    });
  }) as typeof fetch;

  const first = loadSectionTile("ba");
  const second = loadSectionTile("BA");
  assert.equal(calls, 1);
  respond(jsonResponse(tile));
  assert.equal(await first, await second);
  assert.equal((await loadSectionTile("BA")).places[0]?.placeId, "1000");
  assert.equal(calls, 1);
});

test("a missing tile rejects with the UF and is not cached", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
    clearSectionTileCache();
  });
  clearSectionTileCache();
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(new Response("missing", { status: 404 }));
  }) as typeof fetch;

  await assert.rejects(() => loadSectionTile("BA"), /indisponível para BA/);
  await assert.rejects(() => loadSectionTile("BA"), /\/data\/sections\/BA\.json/);
  assert.equal(calls, 2);
});

test("an unknown UF never hits the network", async () => {
  await assert.rejects(() => loadSectionTile("EX"), /invalid UF code/);
});

function place(): PollingPlace {
  const neighborhood = normalizeBairro("Centro");
  return {
    placeId: "1000",
    municipalityCode: "38490",
    municipalityName: "Salvador",
    zone: "1",
    name: "Escola Exemplo",
    neighborhoodLabel: neighborhood.label,
    neighborhoodKey: neighborhood.key,
    latitude: -12.97,
    longitude: -38.51,
    sectionCount: 2,
    electorate: 600,
    tallies: [
      { candidateNumber: "13", votes: 240 },
      { candidateNumber: "22", votes: 180 },
    ],
  };
}

function jsonResponse(body: SectionTile): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

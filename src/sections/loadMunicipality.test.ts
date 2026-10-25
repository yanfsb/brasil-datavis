import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { loadMunicipalityApuracao, validateMunicipalApuracao } from "./loadMunicipality.ts";

const candidates = ["13", "22", "80"];
const fixture = {
  schemaVersion: 1,
  municipalityCode: "1234567",
  candidateVotes: { "13": 7, "22": 6, "80": 0 },
  zones: [{ number: "1", candidateVotes: { "13": 7, "22": 6, "80": 0 }, validVotes: 13,
    winner: "13", marginPercentagePoints: 100 / 13,
    places: [{ code: "5", sections: [
      { number: "10", candidateVotes: { "13": 3, "22": 2, "80": 0 }, specialVotes: { "95": 1 }, validVotes: 5 },
      { number: "11", candidateVotes: { "13": 4, "22": 4, "80": 0 }, specialVotes: {}, validVotes: 8 },
    ] }] }],
};

test("validates nested municipality, zone, place, section, and all-candidate totals", () => {
  assert.equal(validateMunicipalApuracao(fixture, "1234567", candidates).zones[0].places[0].sections.length, 2);
});

test("rejects mismatched identity and non-reconciled nested totals", () => {
  assert.throws(() => validateMunicipalApuracao(fixture, "7654321", candidates), /root/);
  const wrong = structuredClone(fixture);
  wrong.zones[0].places[0].sections[0].candidateVotes["13"] = 30;
  assert.throws(() => validateMunicipalApuracao(wrong, "1234567", candidates), /section valid votes/);
});

test("municipal detail requests are cached and failed requests can be retried", async () => {
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    if (requests === 1) return new Response("", { status: 503 });
    return new Response(gzipSync(Buffer.from(JSON.stringify(fixture))));
  };
  await assert.rejects(loadMunicipalityApuracao("1234567", "municipalities/1234567.json.gz", candidates, fetcher), /503/);
  const [first, second] = await Promise.all([
    loadMunicipalityApuracao("1234567", "municipalities/1234567.json.gz", candidates, fetcher),
    loadMunicipalityApuracao("1234567", "municipalities/1234567.json.gz", candidates, fetcher),
  ]);
  assert.equal(first, second);
  assert.equal(requests, 2);
});

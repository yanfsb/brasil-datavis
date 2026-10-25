import assert from "node:assert/strict";
import test from "node:test";
import { validateNeighborhoodSummary } from "./loadNeighborhood.ts";

const summary = {
  schemaVersion: 1,
  municipality: { name: "Exemplo", uf: "BA", tseCode: "12345", ibgeCode: "1234567" },
  election: { year: 2026, round: 1, cargoCode: "1" },
  geometry: { coordinateCrsAssumption: "EPSG:4674 (datum TSE não declarado)" },
  candidateNumbers: ["13", "22"],
  candidates: [{ number: "13", name: "Candidata A", party: "A" }, { number: "22", name: "Candidato B", party: "B" }],
  candidateVotes: { "13": 12, "22": 8 },
  noGeometryVotesByCode: { "13": 2, "22": 3, "95": 1 },
  coverage: { totalPlaces: 2, assignedPlaces: 1 },
  neighborhoods: { type: "FeatureCollection", features: [{
    type: "Feature", properties: { code: "123", name: "Centro", votesByCandidate: { "13": 10, "22": 5 } },
    geometry: { type: "Polygon", coordinates: [[[-46, -23], [-45, -23], [-45, -22], [-46, -22], [-46, -23]]] },
  }] },
  places: [
    { id: "1-10", zone: "1", placeCode: "10", sectionCount: 1, detail: "places/1-10.json", neighborhoodCode: "123",
      name: "Escola", validVotes: 15, coordinate: { x: 1, y: 2 }, mapCoordinate: { longitude: -45.5, latitude: -22.5 },
      tallies: [{ candidateNumber: "13", votes: 10 }, { candidateNumber: "22", votes: 5 }] },
    { id: "1-11", zone: "1", placeCode: "11", sectionCount: 1, detail: "places/1-11.json", neighborhoodCode: null,
      name: "Outro local", validVotes: 5, coordinate: null, mapCoordinate: null,
      tallies: [{ candidateNumber: "13", votes: 2 }, { candidateNumber: "22", votes: 3 }] },
  ],
};

test("validates national neighborhood layers and reconciles mapped and unassigned votes", () => {
  const parsed = validateNeighborhoodSummary(summary, "1234567", ["13", "22"]);
  assert.equal(parsed.municipality.name, "Exemplo");
  assert.equal(parsed.neighborhoods.features.length, 1);
});

test("rejects neighborhood layers whose mapped and unassigned votes do not reconcile", () => {
  const broken = structuredClone(summary);
  broken.neighborhoods.features[0]!.properties.votesByCandidate["13"] = 9;
  assert.throws(() => validateNeighborhoodSummary(broken, "1234567", ["13", "22"]), /do not reconcile/);
});

test("rejects incorrect municipality identity, candidate catalog, and malformed coordinates", () => {
  assert.throws(() => validateNeighborhoodSummary(summary, "1234568", ["13", "22"]), /root/);
  assert.throws(() => validateNeighborhoodSummary(summary, "1234567", ["22", "13"]), /catalog mismatch/);
  const broken = structuredClone(summary);
  broken.neighborhoods.features[0]!.geometry.coordinates[0]![0]![0] = Number.NaN;
  assert.throws(() => validateNeighborhoodSummary(broken, "1234567", ["13", "22"]), /feature/);
});

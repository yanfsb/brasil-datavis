import assert from "node:assert/strict";
import test from "node:test";
import { aggregateCandidateResults, aggregateZoneResults, buildHeatGrid, contestSummary } from "./analysis.ts";

test("contest summary ranks every candidate and reports margin over valid votes", () => {
  assert.deepEqual(contestSummary([
    { candidateNumber: "13", votes: 240 },
    { candidateNumber: "22", votes: 180 },
    { candidateNumber: "10", votes: 80 },
  ]), {
    validVotes: 500,
    leader: "13",
    runnerUp: "22",
    marginPercentagePoints: 12,
  });
});

test("contest summary distinguishes ties and no-result from a winner", () => {
  assert.equal(contestSummary([{ candidateNumber: "13", votes: 4 }, { candidateNumber: "22", votes: 4 }]).leader, null);
  assert.equal(contestSummary([]).leader, null);
  assert.equal(contestSummary([]).validVotes, 0);
});

test("municipal candidate summary keeps every candidate, including those with votes but no local win", () => {
  assert.deepEqual(aggregateCandidateResults([
    [{ candidateNumber: "13", votes: 50 }, { candidateNumber: "22", votes: 30 }],
    [{ candidateNumber: "14", votes: 5 }, { candidateNumber: "13", votes: 10 }],
  ], ["13", "14", "22", "80"]), [
    { candidateNumber: "13", votes: 60 }, { candidateNumber: "22", votes: 30 },
    { candidateNumber: "14", votes: 5 }, { candidateNumber: "80", votes: 0 },
  ]);
});

test("zone results aggregate and rank all candidates across polling places", () => {
  assert.deepEqual(aggregateZoneResults([
    { zone: "1", tallies: [{ candidateNumber: "13", votes: 8 }, { candidateNumber: "22", votes: 5 }] },
    { zone: "1", tallies: [{ candidateNumber: "22", votes: 7 }, { candidateNumber: "55", votes: 2 }] },
    { zone: "2", tallies: [{ candidateNumber: "55", votes: 9 }] },
  ]), [
    { zone: "1", validVotes: 22, winner: "22", marginPercentagePoints: 18.181818181818183,
      tallies: [{ candidateNumber: "22", votes: 12 }, { candidateNumber: "13", votes: 8 }, { candidateNumber: "55", votes: 2 }] },
    { zone: "2", validVotes: 9, winner: "55", marginPercentagePoints: null,
      tallies: [{ candidateNumber: "55", votes: 9 }] },
  ]);
});

test("heat grid is deterministic, candidate-specific, and bounded by three bandwidths", () => {
  const places = [
    { x: 50, y: 50, votesByCandidate: { "13": 100, "22": 0 } },
    { x: 1050, y: 50, votesByCandidate: { "13": 0, "22": 50 } },
  ];
  const options = { minX: -1000, minY: -1000, maxX: 2000, maxY: 1000, cellSize: 100, bandwidth: 100 };
  const first = buildHeatGrid(places, "13", options);
  const again = buildHeatGrid(places, "13", options);
  assert.deepEqual(first, again);
  assert.equal(first.values[10 * first.columns + 10], 100);
  assert.equal(first.values[10 * first.columns + 20], 0);
  assert.equal(first.max, 100);
});

test("heat grid rejects invalid bandwidth, cell size, and vote counts", () => {
  assert.throws(() => buildHeatGrid([], "13", { minX: 0, minY: 0, maxX: 1, maxY: 1, cellSize: 0, bandwidth: 1 }), /positive/);
  assert.throws(() => buildHeatGrid([{ x: 0, y: 0, votesByCandidate: { "13": -1 } }], "13", { minX: 0, minY: 0, maxX: 1, maxY: 1, cellSize: 1, bandwidth: 1 }), /non-negative/);
});

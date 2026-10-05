import assert from "node:assert/strict";
import test from "node:test";
import {
  contrastByLeader,
  correlateMargin,
  correlationSentence,
  marginColor,
  pearson,
  residual,
  sequentialColor,
  weightedMean,
  weightedPearson,
  type StatePoint,
} from "./stats.ts";

const states: StatePoint[] = [
  point("RR", "flavio", 20, 10, 100),
  point("SP", "flavio", 10, 30, 1000),
  point("BA", "lula", -15, 40, 500),
  point("PI", "lula", -25, 50, 200),
];

test("pearson recovers a perfect negative line", () => {
  const result = pearson([1, 2, 3, 4], [8, 6, 4, 2]);
  assert.ok(Math.abs(result.r + 1) < 1e-12);
  assert.equal(result.slope, -2);
  assert.equal(result.intercept, 10);
});

test("correlateMargin uses the named indicator", () => {
  const result = correlateMargin(states, "analfabetismo");
  assert.equal(result.n, 4);
  assert.ok(result.r < 0);
});

test("weighted mean respects vote weights", () => {
  assert.equal(weightedMean([10, 40], [1, 3]), 32.5);
});

test("equal weights reproduce the unweighted correlation", () => {
  const xs = [1, 2, 3, 4];
  const ys = [2, 4, 6, 8];
  const plain = pearson(xs, ys);
  const weighted = weightedPearson(xs, ys, [1, 1, 1, 1]);
  assert.ok(Math.abs(plain.r - weighted.r) < 1e-12);
  assert.ok(Math.abs(plain.slope - weighted.slope) < 1e-12);
});

test("residual is the distance from the fitted line", () => {
  assert.equal(residual(4, 1, { slope: 2, intercept: 1 }), 1);
});

test("leader contrast can treat each state equally or weight valid votes", () => {
  const equal = contrastByLeader(states, "analfabetismo", "uf");
  assert.equal(equal.flavio, 20);
  assert.equal(equal.lula, 45);
  const weighted = contrastByLeader(states, "analfabetismo", "validos");
  assert.ok(weighted.flavio > equal.flavio);
  assert.ok(weighted.lula < equal.lula);
});

test("colors stay inside the two candidate families", () => {
  assert.equal(marginColor(25), "#1e6a4a");
  assert.equal(marginColor(-25), "#c4452d");
  assert.equal(sequentialColor(0, 0, 10, true), "#f4efe4");
  assert.equal(sequentialColor(10, 0, 10, true), "#8c3d22");
});

test("generated reading names the direction without claiming causation", () => {
  const sentence = correlationSentence("analfabetismo", pearson([1, 2, 3], [3, 2, 1]));
  assert.match(sentence, /cai quando analfabetismo aumenta/);
  assert.match(sentence, /sem ponderar/);
  assert.doesNotMatch(sentence, /causa/);
});

function point(
  sigla: string,
  lider: StatePoint["lider"],
  margem: number,
  indicator: number,
  validos: number,
): StatePoint {
  return {
    sigla,
    lider,
    margem,
    eleitorado: validos,
    validos,
    indicadores: { analfabetismo: indicator },
  };
}

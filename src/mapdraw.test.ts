import assert from "node:assert/strict";
import test from "node:test";
import { advantageColor, buildSpatialGrid, fitView, flatPartyColor, leaderOf, overscanView, pointInRing, querySpatialGrid, screenTransform, stateOutlineWidth, zoomAt } from "./mapdraw.ts";

test("point in a square ring", () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(pointInRing(5, 5, square), true);
  assert.equal(pointInRing(15, 5, square), false);
});

test("leader follows the larger vote total", () => {
  assert.equal(leaderOf(10, 4), "flavio");
  assert.equal(leaderOf(4, 10), "lula");
  assert.equal(leaderOf(3, 3), "empate");
});

test("spatial grid only returns shapes in the queried cell", () => {
  const near = { box: { minX: 0, minY: 0, maxX: 10, maxY: 10 } };
  const far = { box: { minX: 500, minY: 500, maxX: 520, maxY: 520 } };
  const grid = buildSpatialGrid([near, far], 100);
  assert.deepEqual(querySpatialGrid(grid, 4, 4), [near]);
  assert.deepEqual(querySpatialGrid(grid, 200, 200), []);
});

test("overscan keeps the viewport center in the middle of the cache", () => {
  const view = { scale: 2, panX: 30, panY: -10 };
  const frame = overscanView(view, 200, 100, 0.5);
  const worldX = (100 - view.panX) / view.scale;
  const cachedX = frame.panX + worldX * frame.scale;
  assert.ok(Math.abs(cachedX - frame.width / 2) < 1e-9);
});

test("screen transform keeps a world point under the same cursor", () => {
  const from = { scale: 2, panX: 10, panY: 20 };
  const to = { scale: 4, panX: -30, panY: 8 };
  const worldX = 15;
  const worldY = 9;
  const before = from.panX + worldX * from.scale;
  const mapped = screenTransform(from, to);
  const after = mapped.x + before * mapped.scale;
  assert.ok(Math.abs(after - (to.panX + worldX * to.scale)) < 1e-9);
  assert.ok(Math.abs(mapped.y + (from.panY + worldY * from.scale) * mapped.scale - (to.panY + worldY * to.scale)) < 1e-9);
});

test("municipality and advantage colors are not the same view", () => {
  const close = advantageColor("flavio", 3);
  const landslide = advantageColor("flavio", 50);
  assert.notEqual(close, landslide);
  assert.notEqual(flatPartyColor("flavio"), close);
  assert.ok(rgbSum(close) > rgbSum(landslide));
});

test("state outline thins on screen as the map zooms out", () => {
  const country = 0.08;
  const far = stateOutlineWidth(country, country) * country;
  const near = stateOutlineWidth(country * 4, country) * country * 4;
  assert.ok(far < near);
  assert.ok(far >= 0.7);
  assert.ok(near <= 2.1);
});

test("zoom out leaves the maximum and can return to the country scale", () => {
  const capped = zoomAt(8, -100, -40, 20, 20, 0.5, { min: 0.06, max: 8 });
  assert.ok(capped.scale < 8);
  const floor = zoomAt(0.07, 10, 10, 20, 20, 0.5, { min: 0.06, max: 8 });
  assert.equal(floor.scale, 0.06);
});

test("fit and zoom keep the cursor anchored", () => {
  const fitted = fitView(100, 50, 200, 200);
  assert.ok(fitted.scale > 1);
  const zoomed = zoomAt(fitted.scale, fitted.panX, fitted.panY, 40, 40, 2);
  const worldX = (40 - fitted.panX) / fitted.scale;
  assert.ok(Math.abs((40 - zoomed.panX) / zoomed.scale - worldX) < 1e-9);
});

function rgbSum(color: string): number {
  const channels = color.match(/\d+/g)?.map(Number) ?? [];
  return channels.reduce((sum, channel) => sum + channel, 0);
}

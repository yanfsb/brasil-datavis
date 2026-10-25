export type Leader = string;

export interface BBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function pointInRing(x: number, y: number, ring: readonly number[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 2; index < ring.length; previous = index, index += 2) {
    const x1 = ring[previous];
    const y1 = ring[previous + 1];
    const x2 = ring[index];
    const y2 = ring[index + 1];
    const crosses = (y1 > y) !== (y2 > y);
    if (crosses && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

export function ringBBox(ring: readonly number[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < ring.length; index += 2) {
    const x = ring[index];
    const y = ring[index + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function contains(box: BBox, x: number, y: number): boolean {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
}

export function leaderOf(flavio: number, lula: number): Leader {
  if (flavio === lula) return "empate";
  return flavio > lula ? "flavio" : "lula";
}

export function partyColor(leader: Leader, margin: number, mode: "flat" | "vantagem"): string {
  if (leader === "empate") return "#3a3f46";
  const amount = mode === "flat" ? 0.92 : 0.42 + 0.58 * Math.min(1, Math.abs(margin) / 45);
  const [red, green, blue] = leader === "flavio" ? [47, 116, 242] : [226, 48, 78];
  const mix = (channel: number, base: number): number => Math.round(base + (channel - base) * amount);
  return `rgb(${mix(red, 12)}, ${mix(green, 14)}, ${mix(blue, 19)})`;
}

const CANDIDATE_COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  "13": [226, 59, 85], "14": [14, 165, 233], "16": [245, 158, 11], "21": [20, 184, 166],
  "22": [47, 116, 245], "27": [132, 204, 22], "29": [236, 72, 153], "30": [6, 182, 212],
  "35": [249, 115, 22], "55": [168, 85, 247], "70": [34, 197, 94], "80": [250, 204, 21],
};

export function candidateFlatColor(number: string): string {
  if (number === "empate") return "#5c6168";
  const [red, green, blue] = CANDIDATE_COLORS[number] ?? candidateFallbackColor(number);
  return `rgb(${red}, ${green}, ${blue})`;
}

export function candidateAdvantageColor(number: string, margin: number): string {
  if (number === "empate") return "#5c6168";
  const target = CANDIDATE_COLORS[number] ?? candidateFallbackColor(number);
  const abs = Math.abs(margin);
  const amount = abs >= 45 ? 1 : abs >= 25 ? 0.62 + ((abs - 25) / 20) * 0.38 : abs >= 10 ? 0.32 + ((abs - 10) / 15) * 0.3 : 0.08 + (abs / 10) * 0.24;
  const base = [232, 226, 216];
  const channel = (index: number): number => Math.round(base[index] + (target[index] - base[index]) * amount);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function candidateFallbackColor(number: string): readonly [number, number, number] {
  const hue = ((Number(number) || 0) * 137.508) % 360;
  const chroma = 0.7;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const [r, g, b] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [Math.round((r + 0.15) * 255), Math.round((g + 0.15) * 255), Math.round((b + 0.15) * 255)];
}

export function flatPartyColor(leader: Leader): string {
  if (leader === "flavio") return "#2f74f5";
  if (leader === "lula") return "#e23b55";
  return "#5c6168";
}

export function advantageColor(leader: Leader, margin: number): string {
  const abs = Math.abs(margin);
  const amount = abs >= 45 ? 1 : abs >= 25 ? 0.62 + ((abs - 25) / 20) * 0.38 : abs >= 10 ? 0.32 + ((abs - 10) / 15) * 0.3 : 0.08 + (abs / 10) * 0.24;
  const target = leader === "flavio" ? [37, 110, 242] : leader === "lula" ? [214, 42, 72] : [92, 96, 104];
  const base = [232, 226, 216];
  const channel = (index: number): number => Math.round(base[index] + (target[index] - base[index]) * amount);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

export function indicatorColor(value: number, min: number, max: number): string {
  if (max === min) return "#3a3f46";
  const amount = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const red = Math.round(42 + amount * 196);
  const green = Math.round(78 - amount * 40);
  const blue = Math.round(92 - amount * 50);
  return `rgb(${red}, ${green}, ${blue})`;
}

export function fitView(
  worldWidth: number,
  worldHeight: number,
  viewWidth: number,
  viewHeight: number,
  inset: { top: number; right: number; bottom: number; left: number } = { top: 0, right: 0, bottom: 0, left: 0 },
): { scale: number; panX: number; panY: number } {
  const availableWidth = Math.max(1, viewWidth - inset.left - inset.right);
  const availableHeight = Math.max(1, viewHeight - inset.top - inset.bottom);
  const scale = Math.min(availableWidth / worldWidth, availableHeight / worldHeight) * 0.96;
  return {
    scale,
    panX: inset.left + (availableWidth - worldWidth * scale) / 2,
    panY: inset.top + (availableHeight - worldHeight * scale) / 2,
  };
}

export interface SpatialGrid<T> {
  readonly cell: number;
  readonly buckets: ReadonlyMap<string, readonly T[]>;
}

export function buildSpatialGrid<T extends { readonly box: BBox }>(items: readonly T[], cell: number): SpatialGrid<T> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const x0 = Math.floor(item.box.minX / cell);
    const x1 = Math.floor(item.box.maxX / cell);
    const y0 = Math.floor(item.box.minY / cell);
    const y1 = Math.floor(item.box.maxY / cell);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = `${x}:${y}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(item);
        else buckets.set(key, [item]);
      }
    }
  }
  return { cell, buckets };
}

export function querySpatialGrid<T>(grid: SpatialGrid<T>, x: number, y: number): readonly T[] {
  return grid.buckets.get(`${Math.floor(x / grid.cell)}:${Math.floor(y / grid.cell)}`) ?? [];
}

export function overscanView(
  view: { scale: number; panX: number; panY: number },
  width: number,
  height: number,
  margin: number,
): { scale: number; panX: number; panY: number; width: number; height: number } {
  return {
    scale: view.scale,
    panX: view.panX + width * margin,
    panY: view.panY + height * margin,
    width: width * (1 + margin * 2),
    height: height * (1 + margin * 2),
  };
}

export function screenTransform(
  from: { scale: number; panX: number; panY: number },
  to: { scale: number; panX: number; panY: number },
): { scale: number; x: number; y: number } {
  const scale = to.scale / from.scale;
  return { scale, x: to.panX - from.panX * scale, y: to.panY - from.panY * scale };
}

export function intersectsView(
  box: BBox,
  view: { scale: number; panX: number; panY: number },
  width: number,
  height: number,
  pad = 8,
): boolean {
  const x1 = view.panX + box.minX * view.scale;
  const y1 = view.panY + box.minY * view.scale;
  const x2 = view.panX + box.maxX * view.scale;
  const y2 = view.panY + box.maxY * view.scale;
  return x2 >= -pad && y2 >= -pad && x1 <= width + pad && y1 <= height + pad;
}

export function stateOutlineWidth(viewScale: number, countryScale: number): number {
  const zoom = viewScale / Math.max(countryScale, 0.0001);
  const screenPx = Math.min(2.1, Math.max(0.7, 1.15 * Math.sqrt(zoom)));
  return screenPx / viewScale;
}

export function zoomAt(
  scale: number,
  panX: number,
  panY: number,
  cursorX: number,
  cursorY: number,
  factor: number,
  limits: { min: number; max: number } = { min: 0.02, max: 8 },
): { scale: number; panX: number; panY: number } {
  const next = Math.min(limits.max, Math.max(limits.min, scale * factor));
  if (!Number.isFinite(scale) || scale <= 0) {
    return { scale: limits.min, panX, panY };
  }
  const worldX = (cursorX - panX) / scale;
  const worldY = (cursorY - panY) / scale;
  return { scale: next, panX: cursorX - worldX * next, panY: cursorY - worldY * next };
}

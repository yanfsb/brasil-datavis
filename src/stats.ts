export type Leader = "flavio" | "lula" | "empate";

export interface CandidateSlice {
  readonly votos: number;
  readonly percentual: number;
}

export interface StatePoint {
  readonly sigla: string;
  readonly lider: Leader;
  readonly margem: number;
  readonly eleitorado: number;
  readonly validos: number;
  readonly indicadores: Readonly<Record<string, number>>;
}

export interface Correlation {
  readonly n: number;
  readonly r: number;
  readonly slope: number;
  readonly intercept: number;
}

export interface GroupContrast {
  readonly flavio: number;
  readonly lula: number;
  readonly diferenca: number;
}

export function pearson(xs: readonly number[], ys: readonly number[]): Correlation {
  if (xs.length !== ys.length || xs.length < 3) {
    throw new Error("correlation needs at least three paired observations");
  }
  const n = xs.length;
  const meanX = average(xs);
  const meanY = average(ys);
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) {
    throw new Error("correlation is undefined when one series does not vary");
  }
  return {
    n,
    r: covariance / Math.sqrt(varianceX * varianceY),
    slope: covariance / varianceX,
    intercept: meanY - (covariance / varianceX) * meanX,
  };
}

export function correlateMargin(
  states: readonly StatePoint[],
  indicatorId: string,
): Correlation {
  return pearson(
    states.map((state) => state.indicadores[indicatorId]),
    states.map((state) => state.margem),
  );
}

export function weightedPearson(
  xs: readonly number[],
  ys: readonly number[],
  weights: readonly number[],
): Correlation {
  if (xs.length !== ys.length || xs.length !== weights.length || xs.length < 3) {
    throw new Error("weighted correlation needs at least three paired observations");
  }
  const weight = weights.reduce((sum, item) => sum + item, 0);
  if (weight <= 0) throw new Error("weights must sum to a positive number");
  const meanX = xs.reduce((sum, value, index) => sum + weights[index] * value, 0) / weight;
  const meanY = ys.reduce((sum, value, index) => sum + weights[index] * value, 0) / weight;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    covariance += weights[index] * dx * dy;
    varianceX += weights[index] * dx * dx;
    varianceY += weights[index] * dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) {
    throw new Error("correlation is undefined when one series does not vary");
  }
  return {
    n: xs.length,
    r: covariance / Math.sqrt(varianceX * varianceY),
    slope: covariance / varianceX,
    intercept: meanY - (covariance / varianceX) * meanX,
  };
}

export function residual(margin: number, indicator: number, line: Pick<Correlation, "slope" | "intercept">): number {
  return margin - (line.intercept + line.slope * indicator);
}

export function weightedMean(
  values: readonly number[],
  weights: readonly number[],
): number {
  if (values.length !== weights.length || values.length === 0) {
    throw new Error("weighted mean needs paired positive-length series");
  }
  const weight = weights.reduce((sum, item) => sum + item, 0);
  if (weight <= 0) {
    throw new Error("weights must sum to a positive number");
  }
  return values.reduce((sum, value, index) => sum + value * weights[index], 0) / weight;
}

export function contrastByLeader(
  states: readonly StatePoint[],
  indicatorId: string,
  weight: "uf" | "validos",
): GroupContrast {
  const flavio = states.filter((state) => state.lider === "flavio");
  const lula = states.filter((state) => state.lider === "lula");
  if (flavio.length === 0 || lula.length === 0) {
    throw new Error("both leading groups are required");
  }
  const mean = (group: readonly StatePoint[]): number => {
    const values = group.map((state) => state.indicadores[indicatorId]);
    if (weight === "uf") return average(values);
    return weightedMean(values, group.map((state) => state.validos));
  };
  const flavioMean = mean(flavio);
  const lulaMean = mean(lula);
  return {
    flavio: flavioMean,
    lula: lulaMean,
    diferenca: flavioMean - lulaMean,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function mixHex(from: string, to: string, amount: number): string {
  const t = clamp(amount, 0, 1);
  const start = hexToRgb(from);
  const end = hexToRgb(to);
  const channel = (index: number): string =>
    Math.round(start[index] + (end[index] - start[index]) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export function marginColor(margin: number, limit = 25): string {
  const amount = clamp(Math.abs(margin) / limit, 0, 1);
  if (margin === 0) return "#efe6d6";
  return margin > 0 ? mixHex("#efe6d6", "#1e6a4a", amount) : mixHex("#efe6d6", "#c4452d", amount);
}

export function sequentialColor(value: number, min: number, max: number, higherIsWorse: boolean): string {
  if (max === min) return "#efe6d6";
  const amount = clamp((value - min) / (max - min), 0, 1);
  const darkness = higherIsWorse ? amount : 1 - amount;
  return mixHex("#f4efe4", "#8c3d22", darkness);
}

export function formatNumber(value: number, digits = 1): string {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function correlationSentence(
  indicatorName: string,
  correlation: Correlation,
  unit = "UFs",
): string {
  const strength = Math.abs(correlation.r);
  const intensity = strength >= 0.7 ? "forte" : strength >= 0.4 ? "moderada" : "fraca";
  const direction = correlation.r >= 0 ? "sobe" : "cai";
  return `Correlação ${intensity}: a margem de Flávio ${direction} quando ${indicatorName} aumenta. r = ${formatNumber(correlation.r, 2)} em ${correlation.n} ${unit}, sem ponderar pelo eleitorado.`;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

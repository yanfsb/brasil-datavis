export interface CandidateTally {
  readonly candidateNumber: string;
  readonly votes: number;
}

export interface ContestSummary {
  readonly validVotes: number;
  readonly leader: string | null;
  readonly runnerUp: string | null;
  readonly marginPercentagePoints: number | null;
}

export interface ZoneInput {
  readonly zone: string;
  readonly tallies: readonly CandidateTally[];
}

export interface ZoneResult {
  readonly zone: string;
  readonly validVotes: number;
  readonly winner: string | null;
  readonly marginPercentagePoints: number | null;
  readonly tallies: readonly CandidateTally[];
}

export interface HeatPoint {
  readonly x: number;
  readonly y: number;
  readonly votesByCandidate: Readonly<Record<string, number>>;
}

export interface HeatGridOptions {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly cellSize: number;
  readonly bandwidth: number;
}

export interface HeatGrid {
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly values: readonly number[];
  readonly max: number;
}

/** Winner and margin among all valid candidate votes; ties and empty counts have no leader. */
export function contestSummary(tallies: readonly CandidateTally[]): ContestSummary {
  const seen = new Set<string>();
  for (const tally of tallies) {
    if (!tally.candidateNumber || seen.has(tally.candidateNumber)) {
      throw new Error("candidate numbers must be non-empty and unique");
    }
    if (!Number.isSafeInteger(tally.votes) || tally.votes < 0) {
      throw new Error("candidate votes must be non-negative safe integers");
    }
    seen.add(tally.candidateNumber);
  }
  const ranked = [...tallies].sort((left, right) => right.votes - left.votes || left.candidateNumber.localeCompare(right.candidateNumber));
  const validVotes = tallies.reduce((sum, tally) => sum + tally.votes, 0);
  const first = ranked[0];
  const second = ranked[1];
  const tied = first !== undefined && second !== undefined && first.votes === second.votes;
  return {
    validVotes,
    leader: first && first.votes > 0 && !tied ? first.candidateNumber : null,
    runnerUp: second?.candidateNumber ?? null,
    marginPercentagePoints: first && second && validVotes > 0
      ? (100 * (first.votes - second.votes)) / validVotes
      : null,
  };
}

/** Aggregate municipal candidate votes while preserving candidates with zero votes. */
export function aggregateCandidateResults(
  groups: readonly (readonly CandidateTally[])[],
  candidateNumbers: readonly string[],
): CandidateTally[] {
  if (candidateNumbers.length === 0 || new Set(candidateNumbers).size !== candidateNumbers.length
    || candidateNumbers.some((number) => !/^\d+$/.test(number))) {
    throw new Error("candidate numbers must be unique numeric codes");
  }
  const totals = new Map(candidateNumbers.map((number) => [number, 0]));
  for (const group of groups) {
    const seen = new Set<string>();
    for (const tally of group) {
      if (!totals.has(tally.candidateNumber) || seen.has(tally.candidateNumber)
        || !Number.isSafeInteger(tally.votes) || tally.votes < 0) {
        throw new Error("candidate votes must match the catalog and be non-negative safe integers");
      }
      const total = (totals.get(tally.candidateNumber) ?? 0) + tally.votes;
      if (!Number.isSafeInteger(total)) throw new Error("candidate vote total exceeds the safe integer range");
      totals.set(tally.candidateNumber, total);
      seen.add(tally.candidateNumber);
    }
  }
  return [...totals].map(([candidateNumber, votes]) => ({ candidateNumber, votes }))
    .sort((left, right) => right.votes - left.votes || Number(left.candidateNumber) - Number(right.candidateNumber));
}

/** Aggregate valid candidate votes by TSE electoral zone and rank every candidate. */
export function aggregateZoneResults(inputs: readonly ZoneInput[], candidateNumbers: readonly string[] = []): ZoneResult[] {
  if (new Set(candidateNumbers).size !== candidateNumbers.length || candidateNumbers.some((number) => !number)) {
    throw new Error("candidate numbers must be unique and non-empty");
  }
  const zones = new Map<string, Map<string, number>>();
  for (const input of inputs) {
    if (!/^\d+$/.test(input.zone)) throw new Error("electoral zone must be numeric");
    const candidates = zones.get(input.zone) ?? new Map<string, number>();
    for (const tally of input.tallies) {
      if (!tally.candidateNumber || !Number.isSafeInteger(tally.votes) || tally.votes < 0) {
        throw new Error("zone candidate votes must be non-negative safe integers");
      }
      candidates.set(tally.candidateNumber, (candidates.get(tally.candidateNumber) ?? 0) + tally.votes);
    }
    zones.set(input.zone, candidates);
  }
  return [...zones].map(([zone, candidateVotes]) => {
    for (const candidateNumber of candidateNumbers) if (!candidateVotes.has(candidateNumber)) candidateVotes.set(candidateNumber, 0);
    const tallies = [...candidateVotes].map(([candidateNumber, votes]) => ({ candidateNumber, votes }))
      .sort((left, right) => right.votes - left.votes || Number(left.candidateNumber) - Number(right.candidateNumber));
    const contest = contestSummary(tallies);
    return { zone, validVotes: contest.validVotes, winner: contest.leader,
      marginPercentagePoints: contest.marginPercentagePoints, tallies };
  }).sort((left, right) => Number(left.zone) - Number(right.zone));
}

/** Deterministic Gaussian vote density on a fixed metric grid, truncated at 3 bandwidths. */
export function buildHeatGrid(
  points: readonly HeatPoint[],
  candidateNumber: string,
  options: HeatGridOptions,
): HeatGrid {
  const { minX, minY, maxX, maxY, cellSize, bandwidth } = options;
  if (![minX, minY, maxX, maxY, cellSize, bandwidth].every(Number.isFinite)
    || maxX <= minX || maxY <= minY || cellSize <= 0 || bandwidth <= 0) {
    throw new Error("heat grid bounds, cell size, and bandwidth must be finite and positive");
  }
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("heat point coordinates must be finite");
    for (const votes of Object.values(point.votesByCandidate)) {
      if (!Number.isSafeInteger(votes) || votes < 0) throw new Error("heat votes must be non-negative safe integers");
    }
  }
  const columns = Math.ceil((maxX - minX) / cellSize);
  const rows = Math.ceil((maxY - minY) / cellSize);
  const values = Array<number>(columns * rows).fill(0);
  const radius = bandwidth * 3;
  const denominator = 2 * bandwidth * bandwidth;
  let max = 0;

  for (const point of points) {
    const votes = point.votesByCandidate[candidateNumber] ?? 0;
    if (votes === 0) continue;
    const firstColumn = Math.max(0, Math.floor((point.x - radius - minX) / cellSize));
    const lastColumn = Math.min(columns - 1, Math.floor((point.x + radius - minX) / cellSize));
    const firstRow = Math.max(0, Math.floor((point.y - radius - minY) / cellSize));
    const lastRow = Math.min(rows - 1, Math.floor((point.y + radius - minY) / cellSize));
    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = minY + (row + 0.5) * cellSize;
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const x = minX + (column + 0.5) * cellSize;
        const dx = x - point.x;
        const dy = y - point.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > radius * radius) continue;
        const index = row * columns + column;
        values[index] = (values[index] ?? 0) + votes * Math.exp(-distanceSquared / denominator);
        max = Math.max(max, values[index] ?? 0);
      }
    }
  }
  return { columns, rows, cellSize, values, max };
}

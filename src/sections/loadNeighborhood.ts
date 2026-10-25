import type { SalvadorCandidate, SalvadorSummary } from "./loadSalvador.ts";

const cache = new Map<string, Promise<SalvadorSummary>>();

export function loadNeighborhoodSummary(ibge: string, assetPath: string, candidateNumbers: readonly string[], fetcher: typeof fetch = fetch): Promise<SalvadorSummary> {
  if (!/^\d{7}$/.test(ibge) || assetPath !== `municipalities/${ibge}.json.gz`) {
    return Promise.reject(new Error("invalid neighborhood layer identity"));
  }
  const existing = cache.get(ibge);
  if (existing) return existing;
  const request = fetcher(`/data/neighborhoods/${assetPath}`).then(async (response) => {
    if (!response.ok) throw new Error(`failed loading neighborhood layer ${ibge}: ${response.status}`);
    const encoding = response.headers.get("content-encoding")?.toLowerCase() ?? "";
    const payload = encoding.includes("gzip") ? await response.json() : await decompressJson(response);
    return validateNeighborhoodSummary(payload, ibge, candidateNumbers);
  }).catch((error: unknown) => {
    cache.delete(ibge);
    throw error;
  });
  cache.set(ibge, request);
  return request;
}

async function decompressJson(response: Response): Promise<unknown> {
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot decompress the neighborhood layer");
  const stream = new Blob([await response.arrayBuffer()]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

export function validateNeighborhoodSummary(input: unknown, ibge: string, expectedCandidateNumbers: readonly string[]): SalvadorSummary {
  if (!isRecord(input) || input.schemaVersion !== 1 || !isRecord(input.municipality) || !isRecord(input.election)
    || input.municipality.ibgeCode !== ibge || input.election.year !== 2026 || input.election.round !== 1
    || input.election.cargoCode !== "1" || !isRecord(input.geometry) || !isRecord(input.neighborhoods)
    || input.neighborhoods.type !== "FeatureCollection" || !Array.isArray(input.neighborhoods.features)
    || !Array.isArray(input.places) || !Array.isArray(input.candidates) || !Array.isArray(input.candidateNumbers)) {
    throw new Error("invalid neighborhood layer root");
  }
  const candidateNumbers = input.candidateNumbers;
  if (!candidateNumbers.length || new Set(candidateNumbers).size !== candidateNumbers.length
    || candidateNumbers.some((number) => typeof number !== "string" || !/^\d+$/.test(number))
    || candidateNumbers.join(",") !== expectedCandidateNumbers.join(",")) {
    throw new Error("neighborhood layer candidate catalog mismatch");
  }
  const candidates = input.candidates.map(validateCandidate);
  if (candidates.length !== candidateNumbers.length || candidates.some((candidate, index) => candidate.number !== candidateNumbers[index])) {
    throw new Error("neighborhood layer candidate metadata mismatch");
  }
  const identity = new Set(candidateNumbers);
  const candidateVotes = validateVotes(input.candidateVotes, identity, "municipality votes");
  const noGeometryVotes = validateVotes(input.noGeometryVotesByCode, null, "unassigned votes");
  const features = input.neighborhoods.features.map((feature) => validateFeature(feature, identity));
  const neighborhoodCodes = new Set(features.map((feature) => feature.properties.code));
  if (neighborhoodCodes.size !== features.length) throw new Error("duplicate IBGE neighborhood code");
  const placeIds = new Set<string>();
  const places = input.places.map((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.zone !== "string" || typeof value.placeCode !== "string"
      || value.id !== `${value.zone}-${value.placeCode}` || !/^\d+$/.test(value.zone) || !/^\d+$/.test(value.placeCode)
      || placeIds.has(value.id) || !Number.isInteger(value.sectionCount) || (value.sectionCount as number) < 0
      || value.detail !== `places/${value.id}.json` || !Array.isArray(value.tallies)
      || (value.neighborhoodCode !== null && (typeof value.neighborhoodCode !== "string" || !neighborhoodCodes.has(value.neighborhoodCode)))
      || !validPoint(value.coordinate, "x", "y", false) || !validPoint(value.mapCoordinate, "longitude", "latitude", true)
      || (value.neighborhoodCode !== null && (value.coordinate === null || value.mapCoordinate === null))) throw new Error("invalid neighborhood polling place");
    placeIds.add(value.id);
    const tallies = value.tallies.map((tally) => {
      if (!isRecord(tally) || typeof tally.candidateNumber !== "string" || !identity.has(tally.candidateNumber)) throw new Error("invalid neighborhood polling place tally");
      return { candidateNumber: tally.candidateNumber, votes: nonNegativeInteger(tally.votes, "polling place tally") };
    });
    if (tallies.length !== candidateNumbers.length || new Set(tallies.map((tally) => tally.candidateNumber)).size !== identity.size
      || tallies.reduce((total, tally) => total + tally.votes, 0) !== value.validVotes) {
      throw new Error("incomplete neighborhood polling place tally");
    }
    return value as unknown as SalvadorSummary["places"][number];
  });
  const summed = Object.fromEntries(candidateNumbers.map((number) => [number,
    features.reduce((total, feature) => total + feature.properties.votesByCandidate[number], 0) + (noGeometryVotes[number] ?? 0)]));
  const placeTotals = Object.fromEntries(candidateNumbers.map((number) => [number,
    places.reduce((total, place) => total + (place.tallies?.find((tally) => tally.candidateNumber === number)?.votes ?? 0), 0)]));
  for (const number of candidateNumbers) {
    if (summed[number] !== candidateVotes[number] || placeTotals[number] !== candidateVotes[number]) {
      throw new Error(`neighborhood layer vote totals do not reconcile for candidate ${number}`);
    }
  }
  if (!isRecord(input.coverage)) throw new Error("invalid neighborhood coverage");
  const municipality = input.municipality;
  if (typeof municipality.name !== "string" || !municipality.name || typeof municipality.uf !== "string"
    || typeof municipality.tseCode !== "string" || typeof municipality.ibgeCode !== "string") throw new Error("invalid neighborhood municipality");
  return input as unknown as SalvadorSummary;
}

function validateCandidate(value: unknown): SalvadorCandidate {
  if (!isRecord(value) || typeof value.number !== "string" || typeof value.name !== "string" || typeof value.party !== "string") {
    throw new Error("invalid neighborhood candidate");
  }
  return { number: value.number, name: value.name, party: value.party };
}

function validateFeature(value: unknown, candidates: ReadonlySet<string>): { properties: { code: string; name: string; votesByCandidate: Record<string, number> }; geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown } } {
  if (!isRecord(value) || !isRecord(value.properties) || typeof value.properties.code !== "string" || typeof value.properties.name !== "string"
    || !isRecord(value.geometry) || (value.geometry.type !== "Polygon" && value.geometry.type !== "MultiPolygon")
    || !finiteCoordinates(value.geometry.coordinates)) throw new Error("invalid IBGE neighborhood feature");
  const votes = validateVotes(value.properties.votesByCandidate, candidates, "neighborhood votes");
  return { properties: { code: value.properties.code, name: value.properties.name, votesByCandidate: votes },
    geometry: { type: value.geometry.type, coordinates: value.geometry.coordinates } };
}

function validateVotes(value: unknown, candidates: ReadonlySet<string> | null, label: string): Record<string, number> {
  if (!isRecord(value)) throw new Error(`invalid ${label}`);
  const result: Record<string, number> = {};
  for (const [code, count] of Object.entries(value)) {
    if (!/^\d+$/.test(code) || (candidates && !candidates.has(code))) throw new Error(`invalid ${label} code`);
    result[code] = nonNegativeInteger(count, label);
  }
  if (candidates && [...candidates].some((code) => !(code in result))) throw new Error(`incomplete ${label}`);
  return result;
}

function validPoint(value: unknown, x: string, y: string, geographic: boolean): boolean {
  if (value === null) return true;
  if (!isRecord(value) || typeof value[x] !== "number" || !Number.isFinite(value[x])
    || typeof value[y] !== "number" || !Number.isFinite(value[y])) return false;
  return !geographic || (value[x] >= -180 && value[x] <= 180 && value[y] >= -90 && value[y] <= 90);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
  return value;
}

function finiteCoordinates(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.every((item) => typeof item === "number")) return value.every((item) => typeof item === "number" && Number.isFinite(item));
  return value.every(finiteCoordinates);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

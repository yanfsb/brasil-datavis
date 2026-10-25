export interface SalvadorPlaceIndexEntry {
  readonly id: string;
  readonly zone: string;
  readonly placeCode: string;
  readonly sectionCount: number;
  readonly detail: string;
  readonly neighborhoodCode?: string | null;
  readonly name?: string;
  readonly neighborhoodLabel?: string;
  readonly coordinate?: { readonly x: number; readonly y: number } | null;
  readonly mapCoordinate?: { readonly longitude: number; readonly latitude: number } | null;
  readonly coordinateStatus?: string;
  readonly unassignedReason?: string | null;
  readonly electorate?: number;
  readonly validVotes?: number;
  readonly blankVotes?: number;
  readonly nullVotes?: number;
  readonly technicalNullVotes?: number;
  readonly tallies?: readonly { readonly candidateNumber: string; readonly votes: number }[];
}

export interface SalvadorCandidate {
  readonly number: string;
  readonly name: string;
  readonly party: string;
}

export interface SalvadorSummary {
  readonly schemaVersion: 1;
  readonly municipality: { readonly name: string; readonly uf: string; readonly tseCode: string; readonly ibgeCode: string };
  readonly election: { readonly year: number; readonly round: number; readonly cargoCode: string };
  readonly sourceManifest?: Record<string, unknown>;
  readonly coverage: Record<string, unknown>;
  readonly reconciliation?: Record<string, unknown>;
  readonly geometry?: { readonly coordinateCrsAssumption?: string };
  readonly candidateNumbers: readonly string[];
  readonly candidates: readonly SalvadorCandidate[];
  readonly noGeometryVotesByCode: Readonly<Record<string, number>>;
  readonly places: readonly SalvadorPlaceIndexEntry[];
  readonly neighborhoods: { readonly type: "FeatureCollection"; readonly features: readonly unknown[] };
}

export interface SalvadorPlaceSections {
  readonly schemaVersion: 1;
  readonly place: { readonly municipalityCode: string; readonly zone: string; readonly placeCode: string };
  readonly sections: readonly { readonly section: string; readonly votesByCode: Readonly<Record<string, number>> }[];
}

const SUMMARY_PATH = "/data/salvador/summary.json";
const EXPECTED_DATASET = { municipality: "38490", ibge: "2927408", year: 2026, round: 1, cargo: "1" } as const;
let summaryCache: Promise<SalvadorSummary> | undefined;
const placeCache = new Map<string, Promise<SalvadorPlaceSections>>();

/** The city is available only after its published summary manifest validates. */
export async function loadSalvadorSummary(signal?: AbortSignal): Promise<SalvadorSummary> {
  if (signal?.aborted) throw abortError();
  if (summaryCache) return summaryCache;
  const request = fetchJson(SUMMARY_PATH, signal).then(parseSalvadorSummary);
  summaryCache = request;
  try {
    return await request;
  } catch (error) {
    if (summaryCache === request) summaryCache = undefined;
    throw error;
  }
}

export async function loadSalvadorPlace(place: SalvadorPlaceIndexEntry, signal?: AbortSignal): Promise<SalvadorPlaceSections> {
  if (signal?.aborted) throw abortError();
  const validIdentity = typeof place.id === "string" && typeof place.zone === "string" && typeof place.placeCode === "string"
    && place.id === `${place.zone}-${place.placeCode}` && /^\d+$/.test(place.zone) && /^\d+$/.test(place.placeCode)
    && place.detail === `places/${place.id}.json`;
  if (!validIdentity) throw new Error("unknown Salvador polling-place identity");
  const pending = placeCache.get(place.id);
  if (pending) return pending;
  const path = `/data/salvador/${place.detail}`;
  const request = fetchJson(path, signal).then((payload) => parseSalvadorPlace(payload, place));
  placeCache.set(place.id, request);
  try {
    return await request;
  } catch (error) {
    if (placeCache.get(place.id) === request) placeCache.delete(place.id);
    throw error;
  }
}

export function clearSalvadorCache(): void {
  summaryCache = undefined;
  placeCache.clear();
}

export function parseSalvadorSummary(value: unknown): SalvadorSummary {
  const root = record(value, "summary");
  if (root.schemaVersion !== 1) throw new Error("unsupported Salvador summary schema version");
  const municipality = record(root.municipality, "municipality");
  if (municipality.name !== "Salvador" || municipality.uf !== "BA" || municipality.tseCode !== EXPECTED_DATASET.municipality || municipality.ibgeCode !== EXPECTED_DATASET.ibge) {
    throw new Error("unknown Salvador municipality identity");
  }
  const election = record(root.election, "election");
  if (election.year !== EXPECTED_DATASET.year || election.round !== EXPECTED_DATASET.round || election.cargoCode !== EXPECTED_DATASET.cargo) {
    throw new Error("Salvador election/version mismatch");
  }
  const manifest = record(root.sourceManifest, "source manifest");
  for (const source of ["votes", "detail", "electorate", "geometry"]) {
    const entry = record(manifest[source], `source manifest.${source}`);
    text(entry.url, `source manifest.${source}.url`);
    text(entry.member, `source manifest.${source}.member`);
    count(entry.bytes, `source manifest.${source}.bytes`);
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`source manifest.${source}.sha256 is invalid`);
    for (const field of ["lastModified", "etag"]) {
      if (entry[field] !== null && typeof entry[field] !== "string") throw new Error(`source manifest.${source}.${field} is invalid`);
    }
  }
  validateNested(root.coverage, "coverage");
  validateNested(root.reconciliation, "reconciliation");
  const candidateNumbers = stringArray(root.candidateNumbers, "candidate numbers");
  if (new Set(candidateNumbers).size !== candidateNumbers.length) throw new Error("candidate numbers must be unique");
  if (!Array.isArray(root.candidates)) throw new Error("candidate metadata must be an array");
  const candidateMetadata = root.candidates.map((value, index) => {
    const candidate = record(value, `candidates[${index}]`);
    return { number: text(candidate.number, "candidate number"), name: text(candidate.name, "candidate name"), party: text(candidate.party, "candidate party") };
  });
  if (candidateMetadata.length !== candidateNumbers.length || new Set(candidateMetadata.map((candidate) => candidate.number)).size !== candidateMetadata.length
    || candidateMetadata.some((candidate) => !candidateNumbers.includes(candidate.number))) {
    throw new Error("candidate metadata must match the valid candidate numbers");
  }
  validateCountMap(root.noGeometryVotesByCode, "no-geometry votes");
  if (!Array.isArray(root.places)) throw new Error("summary places must be an array");
  const places = root.places.map((value, index) => {
    const place = record(value, `places[${index}]`);
    const id = text(place.id, "place id");
    const zone = text(place.zone, "place zone");
    const placeCode = text(place.placeCode, "place code");
    const sectionCount = count(place.sectionCount, "place section count");
    const detail = text(place.detail, "place detail");
    if (!/^\d+$/.test(zone) || !/^\d+$/.test(placeCode) || id !== `${zone}-${placeCode}` || detail !== `places/${id}.json`) {
      throw new Error(`unknown polling-place identity at places[${index}]`);
    }
    if (place.neighborhoodCode !== null && place.neighborhoodCode !== undefined) text(place.neighborhoodCode, "place neighborhood code");
    if (place.name !== undefined && typeof place.name !== "string") throw new Error("place name must be a string");
    if (place.neighborhoodLabel !== undefined && typeof place.neighborhoodLabel !== "string") throw new Error("place neighborhood label must be a string");
    for (const field of ["coordinate", "mapCoordinate"] as const) {
      const coordinate = place[field];
      if (coordinate !== null && coordinate !== undefined) {
        const point = record(coordinate, `place ${field}`);
        const keys = field === "coordinate" ? ["x", "y"] : ["longitude", "latitude"];
        for (const key of keys) {
          if (typeof point[key] !== "number" || !Number.isFinite(point[key])) throw new Error(`place ${field}.${key} must be finite`);
        }
        if (field === "mapCoordinate" && (Number(point.longitude) < -180 || Number(point.longitude) > 180 || Number(point.latitude) < -90 || Number(point.latitude) > 90)) {
          throw new Error("place map coordinates must be longitude/latitude degrees");
        }
      }
    }
    if (place.coordinateStatus !== undefined && !["valid", "missing", "conflict", "outside-municipality"].includes(String(place.coordinateStatus))) throw new Error("invalid place coordinate status");
    if (place.tallies !== undefined) {
      if (!Array.isArray(place.tallies)) throw new Error("place tallies must be an array");
      const seen = new Set<string>();
      for (const tallyValue of place.tallies) {
        const tally = record(tallyValue, "place tally");
        const candidate = text(tally.candidateNumber, "place tally candidate");
        if (seen.has(candidate)) throw new Error("place tally candidates must be unique");
        seen.add(candidate);
        count(tally.votes, "place tally votes");
      }
    }
    return { id, zone, placeCode, sectionCount, detail };
  });
  if (new Set(places.map((place) => place.id)).size !== places.length) throw new Error("polling-place identities must be unique");
  const neighborhoods = record(root.neighborhoods, "neighborhoods");
  if (neighborhoods.type !== "FeatureCollection" || !Array.isArray(neighborhoods.features)) throw new Error("neighborhoods must be a FeatureCollection");
  for (const [index, item] of neighborhoods.features.entries()) validateFeature(item, index);
  return value as SalvadorSummary;
}

export function parseSalvadorPlace(value: unknown, expected: SalvadorPlaceIndexEntry): SalvadorPlaceSections {
  const root = record(value, "place detail");
  if (root.schemaVersion !== 1) throw new Error("unsupported Salvador place schema version");
  const identity = record(root.place, "place identity");
  if (identity.municipalityCode !== EXPECTED_DATASET.municipality || identity.zone !== expected.zone || identity.placeCode !== expected.placeCode) {
    throw new Error("unknown or mismatched Salvador polling-place identity");
  }
  if (!Array.isArray(root.sections)) throw new Error("place sections must be an array");
  const seen = new Set<string>();
  const sections = root.sections.map((value, index) => {
    const section = record(value, `sections[${index}]`);
    const number = text(section.section, "section number");
    if (!/^\d+$/.test(number) || seen.has(number)) throw new Error("section identities must be numeric and unique");
    seen.add(number);
    return { section: number, votesByCode: validateCountMap(section.votesByCode, "section votes") };
  });
  if (sections.length !== expected.sectionCount) throw new Error("place section count mismatch");
  return value as SalvadorPlaceSections;
}

async function fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(response.status === 404 ? `Published Salvador asset is missing: ${path}` : `Failed to load Salvador asset (${response.status}): ${path}`);
  return response.json() as Promise<unknown>;
}

function validateNested(value: unknown, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} numbers must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNested(item, `${label}[${index}]`));
    return;
  }
  const object = record(value, label);
  for (const [key, item] of Object.entries(object)) validateNested(item, `${label}.${key}`);
}

function validateFeature(value: unknown, index: number): void {
  const feature = record(value, `neighborhood feature ${index}`);
  if (feature.type !== "Feature") throw new Error("neighborhood item must be a Feature");
  const properties = record(feature.properties, "neighborhood properties");
  text(properties.code, "neighborhood code");
  text(properties.name, "neighborhood name");
  validateCountMap(properties.votesByCandidate, "neighborhood candidate votes");
  validateCountMap(properties.specialVotesByCode, "neighborhood special votes");
  const geometry = record(feature.geometry, "neighborhood geometry");
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") throw new Error("unsupported neighborhood geometry");
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || polygons.length === 0) throw new Error("neighborhood coordinates must not be empty");
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) throw new Error("neighborhood rings must not be empty");
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) throw new Error("neighborhood ring must contain at least four points");
      for (const point of ring) {
        if (!Array.isArray(point) || point.length < 2 || !point.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
          throw new Error("neighborhood coordinates must be finite numbers");
        }
      }
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => text(item, label));
}
function validateCountMap(value: unknown, label: string): Record<string, number> {
  const result = record(value, label);
  for (const [key, item] of Object.entries(result)) {
    if (!key) throw new Error(`${label} has an empty code`);
    count(item, `${label}.${key}`);
  }
  return result as Record<string, number>;
}
function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

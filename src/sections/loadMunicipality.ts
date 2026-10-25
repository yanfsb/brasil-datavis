export interface MunicipalSectionResult {
  readonly number: string;
  readonly candidateVotes: Readonly<Record<string, number>>;
  readonly specialVotes: Readonly<Record<string, number>>;
  readonly validVotes: number;
}

export interface MunicipalPlaceResult {
  readonly code: string;
  readonly name?: string;
  readonly sections: readonly MunicipalSectionResult[];
}

export interface MunicipalZoneResult {
  readonly number: string;
  readonly candidateVotes: Readonly<Record<string, number>>;
  readonly validVotes: number;
  readonly winner: string | null;
  readonly marginPercentagePoints: number | null;
  readonly places: readonly MunicipalPlaceResult[];
}

export interface MunicipalApuracao {
  readonly schemaVersion: 1;
  readonly municipalityCode: string;
  readonly candidateVotes: Readonly<Record<string, number>>;
  readonly zones: readonly MunicipalZoneResult[];
}

const cache = new Map<string, Promise<MunicipalApuracao>>();

export function loadMunicipalityApuracao(
  ibge: string,
  assetPath: string,
  candidateNumbers: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<MunicipalApuracao> {
  const pathPrefix = `municipalities/${ibge}.json.gz`;
  if (!/^\d{7}$/.test(ibge) || assetPath !== pathPrefix) return Promise.reject(new Error("invalid municipality detail identity"));
  const existing = cache.get(ibge);
  if (existing) return existing;
  const request = fetcher(`/data/apuracao/${assetPath}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`failed loading municipal apuracao ${ibge}: ${response.status}`);
      const encoding = response.headers.get("content-encoding")?.toLowerCase() ?? "";
      const payload = encoding.includes("gzip")
        ? await response.json()
        : await decompressJson(response);
      return validateMunicipalApuracao(payload, ibge, candidateNumbers);
    })
    .catch((error: unknown) => {
      cache.delete(ibge);
      throw error;
    });
  cache.set(ibge, request);
  return request;
}

async function decompressJson(response: Response): Promise<unknown> {
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot decompress the municipal detail file");
  const stream = new Blob([await response.arrayBuffer()]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

export function validateMunicipalApuracao(input: unknown, expectedIbge: string, candidateNumbers: readonly string[]): MunicipalApuracao {
  if (!isRecord(input) || input.schemaVersion !== 1 || input.municipalityCode !== expectedIbge || !Array.isArray(input.zones)) {
    throw new Error("invalid municipal detail root");
  }
  const identities = new Set(candidateNumbers);
  if (identities.size !== candidateNumbers.length || !identities.size) throw new Error("invalid candidate catalog");
  const candidateVotes = voteRecord(input.candidateVotes, identities, "municipality candidate votes");
  const zones = input.zones.map((zone) => validateZone(zone, identities));
  if (new Set(zones.map((zone) => zone.number)).size !== zones.length) throw new Error("duplicate electoral zone");
  const summed = sumCandidateVotes(zones.map((zone) => zone.candidateVotes), identities);
  if (!sameVotes(candidateVotes, summed, identities)) throw new Error("municipality and zone vote totals do not reconcile");
  return { schemaVersion: 1, municipalityCode: expectedIbge, candidateVotes, zones };
}

function validateZone(input: unknown, identities: ReadonlySet<string>): MunicipalZoneResult {
  if (!isRecord(input) || !isNumericId(input.number) || !Array.isArray(input.places)) throw new Error("invalid zone record");
  const candidateVotes = voteRecord(input.candidateVotes, identities, "zone candidate votes");
  const validVotes = safeCount(input.validVotes, "zone valid votes");
  if (sumVotes(candidateVotes) !== validVotes) throw new Error("zone valid votes do not reconcile");
  if (input.winner !== null && (typeof input.winner !== "string" || !identities.has(input.winner))) throw new Error("invalid zone winner");
  const margin = input.marginPercentagePoints;
  if (margin !== null && (typeof margin !== "number" || !Number.isFinite(margin) || margin < 0 || margin > 100)) throw new Error("invalid zone margin");
  const places = input.places.map((place) => validatePlace(place, identities));
  if (new Set(places.map((place) => place.code)).size !== places.length) throw new Error("duplicate polling place in zone");
  const placeVotes = sumCandidateVotes(places.flatMap((place) => place.sections.map((section) => section.candidateVotes)), identities);
  if (!sameVotes(candidateVotes, placeVotes, identities)) throw new Error("zone and polling-place vote totals do not reconcile");
  return { number: input.number, candidateVotes, validVotes, winner: input.winner as string | null,
    marginPercentagePoints: margin as number | null, places };
}

function validatePlace(input: unknown, identities: ReadonlySet<string>): MunicipalPlaceResult {
  if (!isRecord(input) || !isNumericId(input.code) || !Array.isArray(input.sections)) throw new Error("invalid polling place");
  const sections = input.sections.map((section) => validateSection(section, identities));
  if (new Set(sections.map((section) => section.number)).size !== sections.length) throw new Error("duplicate section in polling place");
  if (input.name !== undefined && typeof input.name !== "string") throw new Error("invalid polling-place name");
  return { code: input.code, name: input.name as string | undefined, sections };
}

function validateSection(input: unknown, identities: ReadonlySet<string>): MunicipalSectionResult {
  if (!isRecord(input) || !isNumericId(input.number)) throw new Error("invalid section record");
  const candidateVotes = voteRecord(input.candidateVotes, identities, "section candidate votes");
  const specialVotes = voteRecord(input.specialVotes, null, "section special votes");
  const validVotes = safeCount(input.validVotes, "section valid votes");
  if (sumVotes(candidateVotes) !== validVotes) throw new Error("section valid votes do not reconcile");
  return { number: input.number, candidateVotes, specialVotes, validVotes };
}

function voteRecord(input: unknown, identities: ReadonlySet<string> | null, label: string): Readonly<Record<string, number>> {
  if (!isRecord(input)) throw new Error(`invalid ${label}`);
  const result: Record<string, number> = {};
  for (const [number, votes] of Object.entries(input)) {
    if (!isNumericId(number) || (identities && !identities.has(number))) throw new Error(`unknown candidate in ${label}`);
    result[number] = safeCount(votes, label);
  }
  if (identities && [...identities].some((number) => result[number] === undefined)) throw new Error(`incomplete ${label}`);
  return result;
}

function sumCandidateVotes(records: readonly Readonly<Record<string, number>>[], identities: ReadonlySet<string>): Record<string, number> {
  const result: Record<string, number> = Object.fromEntries([...identities].map((number) => [number, 0]));
  for (const record of records) for (const number of identities) result[number] += record[number] ?? 0;
  return result;
}

function sameVotes(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>, identities: ReadonlySet<string>): boolean {
  return [...identities].every((number) => left[number] === right[number]);
}

function sumVotes(votes: Readonly<Record<string, number>>): number {
  return Object.values(votes).reduce((sum, value) => sum + value, 0);
}

function safeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
  return value;
}

function isNumericId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

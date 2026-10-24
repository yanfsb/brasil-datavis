declare const ufBrand: unique symbol;
declare const sectionBrand: unique symbol;

/** Two-letter state code used as the tile partition, such as "BA". */
export type UfCode = string & { readonly [ufBrand]: never };

/** Section identity: UF, municipality code, zone, and section. */
export type SectionKey = string & { readonly [sectionBrand]: never };

export type Office = "president";
export type Round = 1 | 2;

/** States drawn on the municipal map. Overseas voters (ZZ) are not a tile. */
export const KNOWN_UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO",
  "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR",
  "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
] as const;

export type KnownUf = (typeof KNOWN_UFS)[number];

const KNOWN_UF_SET: ReadonlySet<string> = new Set(KNOWN_UFS);

export interface ElectionMeta {
  readonly year: number;
  readonly round: Round;
  readonly office: Office;
  /** TSE cargo code. President is "1". */
  readonly officeCode: string;
}

export interface CandidateTally {
  readonly candidateNumber: string;
  readonly votes: number;
}

/**
 * One polling place. `placeId` is NR_LOCAL_VOTACAO and is unique only inside
 * the municipality, so callers key a place by municipalityCode + zone + placeId.
 * Section rows are rolled up; the tile does not list them.
 */
export interface PollingPlace {
  readonly placeId: string;
  readonly municipalityCode: string;
  readonly municipalityName: string;
  readonly zone: string;
  readonly name: string;
  readonly neighborhoodLabel: string;
  readonly neighborhoodKey: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly sectionCount: number;
  readonly electorate: number;
  readonly tallies: readonly CandidateTally[];
}

/**
 * Votes rolled up for one neighborhood label inside one municipality.
 * The same key in another municipality is a different row.
 */
export interface NeighborhoodAgg {
  readonly municipalityCode: string;
  readonly neighborhoodKey: string;
  readonly label: string;
  readonly placeCount: number;
  readonly sectionCount: number;
  readonly electorate: number;
  readonly tallies: readonly CandidateTally[];
}

/** One UF of polling places and neighborhood totals. Never the whole country. */
export interface SectionTile {
  readonly uf: UfCode;
  readonly election: ElectionMeta;
  readonly places: readonly PollingPlace[];
  readonly neighborhoods: readonly NeighborhoodAgg[];
}

export function ufCode(value: string): UfCode {
  const code = value.trim().toUpperCase();
  if (!KNOWN_UF_SET.has(code)) {
    throw new Error(`invalid UF code: ${value}`);
  }
  return code as UfCode;
}

export function sectionKey(parts: {
  uf: string;
  municipalityCode: string;
  zone: string;
  section: string;
}): SectionKey {
  const uf = parts.uf.trim().toUpperCase();
  const municipalityCode = parts.municipalityCode.trim();
  const zone = parts.zone.trim();
  const section = parts.section.trim();
  if (!uf || !municipalityCode || !zone || !section) {
    throw new Error("section key needs uf, municipality, zone, and section");
  }
  return `${uf}:${municipalityCode}:${zone}:${section}` as SectionKey;
}

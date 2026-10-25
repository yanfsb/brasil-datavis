import type { CandidateTally, ElectionMeta } from "./types.ts";

/** Geometry coordinates share the local metric projection used by this city package. */
export type FlatRing = readonly number[];
export type PolygonRings = readonly FlatRing[];
export type MultiPolygonRings = readonly PolygonRings[];

export interface NeighborhoodBoundary {
  readonly code: string;
  readonly name: string;
  readonly geometry: MultiPolygonRings;
}

export interface CityLayerMeta {
  readonly schemaVersion: 1;
  readonly datasetVersion: string;
  readonly municipality: {
    readonly ibgeCode: string;
    readonly tseCode: string;
    readonly name: string;
    readonly uf: "BA";
  };
  readonly election: ElectionMeta & {
    readonly electionCode: "6257";
    readonly resultsUpdatedAt: string;
  };
  readonly geometry: {
    readonly source: "IBGE Censo 2022";
    readonly referenceDate: "2022-07-31";
    readonly crs: "EPSG:4674";
    readonly projectedCrs: string;
    readonly projectedOrigin: readonly [longitude: number, latitude: number];
  };
  readonly sourceUrls: readonly string[];
}

export interface VoteSummary {
  readonly validVotes: number;
  readonly blankVotes: number;
  readonly nullVotes: number;
  readonly tallies: readonly CandidateTally[];
}

export interface NeighborhoodResults extends VoteSummary {
  readonly neighborhoodCode: string;
  readonly placeCount: number;
  readonly sectionCount: number;
}

export interface CityPollingPlace extends VoteSummary {
  readonly key: string;
  readonly localNumber: string;
  readonly zone: string;
  readonly municipalityTseCode: string;
  readonly name: string;
  readonly neighborhoodLabel: string;
  readonly coordinate: { readonly x: number; readonly y: number } | null;
  readonly coordinateStatus: "valid" | "missing" | "conflict" | "outside-municipality";
  readonly sectionCount: number;
  readonly electorate: number;
  readonly unassignedReason: "no-coordinate" | "outside-municipality" | "ambiguous-boundary" | null;
}

export interface UnassignedVotes extends VoteSummary {
  readonly reason: "no-coordinate" | "outside-municipality" | "ambiguous-boundary";
  readonly placeCount: number;
}

/** Compact, municipality-scoped package; section rows are fetched separately on demand. */
export interface CityLayer {
  readonly meta: CityLayerMeta;
  readonly bounds: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
  readonly neighborhoods: readonly NeighborhoodBoundary[];
  readonly results: readonly NeighborhoodResults[];
  readonly places: readonly CityPollingPlace[];
  readonly unassigned: readonly UnassignedVotes[];
  readonly candidates: readonly { readonly number: string; readonly name: string; readonly party: string }[];
}

export interface SectionResults extends VoteSummary {
  readonly schemaVersion: 1;
  readonly datasetVersion: string;
  readonly electionCode: "6257";
  readonly placeKey: string;
  readonly sections: readonly {
    readonly number: string;
    readonly principalSection: string | null;
    readonly aggregationType: string;
    readonly electorate: number;
    readonly validVotes: number;
    readonly blankVotes: number;
    readonly nullVotes: number;
    readonly tallies: readonly CandidateTally[];
  }[];
}

import { KNOWN_UFS, ufCode, type SectionTile, type UfCode } from "./types.ts";

const cache = new Map<string, Promise<SectionTile>>();
const KNOWN_UF_SET: ReadonlySet<string> = new Set(KNOWN_UFS);

/** False until `/data/sections/{UF}.json` tiles are published. */
export const sectionLayerReady = false;

export function sectionTilePath(uf: string): string {
  return `/data/sections/${ufCode(uf)}.json`;
}

export function clearSectionTileCache(): void {
  cache.clear();
}

/**
 * Load one UF tile. Repeated calls for the same UF share one request.
 * A missing file rejects and is not cached.
 */
export async function loadSectionTile(uf: string): Promise<SectionTile> {
  const code = ufCode(uf);
  const pending = cache.get(code);
  if (pending) return pending;
  const request = fetchSectionTile(code);
  cache.set(code, request);
  try {
    return await request;
  } catch (error) {
    cache.delete(code);
    throw error;
  }
}

async function fetchSectionTile(uf: UfCode): Promise<SectionTile> {
  const path = sectionTilePath(uf);
  const response = await fetch(path);
  if (response.status === 404) {
    throw new Error(`Camada de seções indisponível para ${uf}. Arquivo ausente: ${path}`);
  }
  if (!response.ok) {
    throw new Error(`Falha ao carregar seções de ${uf} (${response.status} ${path}).`);
  }
  const payload: unknown = await response.json();
  const tile = parseSectionTile(payload);
  if (tile.uf !== uf) {
    throw new Error(`Arquivo de seções de ${uf} declara a UF ${tile.uf}.`);
  }
  return tile;
}

export function parseSectionTile(payload: unknown): SectionTile {
  if (!isRecord(payload)) throw new Error("section tile must be an object");
  if (typeof payload.uf !== "string" || !KNOWN_UF_SET.has(payload.uf)) {
    throw new Error("section tile uf must be a known state code");
  }
  if (!isRecord(payload.election)) throw new Error("section tile needs election metadata");
  const { year, round, office, officeCode } = payload.election;
  if (typeof year !== "number" || (round !== 1 && round !== 2)) {
    throw new Error("section tile election needs a year and round 1 or 2");
  }
  if (office !== "president" || typeof officeCode !== "string") {
    throw new Error("section tile election office is not supported");
  }
  if (!Array.isArray(payload.places) || !Array.isArray(payload.neighborhoods)) {
    throw new Error("section tile needs places and neighborhoods arrays");
  }
  return payload as unknown as SectionTile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

"""Open water around islands by clipping the IBGE mesh to a physical coastline.

The official municipal mesh treats channels as shared borders, so Itaparica
and Vera Cruz look landlocked. Natural Earth 10m land keeps those channels
as water. Requires shapely (installed in .venv).
"""

from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import box, shape
from shapely.prepared import prep
from shapely.strtree import STRtree

from scripts.build_map import get_json, mercator, project_mesh, scale_rings

ROOT = Path(__file__).resolve().parents[1]
MESH = ROOT / "data" / "cache" / "malha-mun.geojson"
LAND = ROOT / "data" / "cache" / "ne_10m_land.geojson"
MAP = ROOT / "public" / "data" / "map.json"
BRAZIL = box(-74.8, -34.2, -28.2, 6.2)
SIMPLIFY = 0.0014


def land_parts():
    data = json.loads(LAND.read_text())
    parts = []
    for feature in data["features"]:
        geom = shape(feature["geometry"]).intersection(BRAZIL)
        if geom.is_empty:
            continue
        geoms = getattr(geom, "geoms", [geom])
        for piece in geoms:
            if piece.geom_type == "Polygon" and not piece.is_empty:
                parts.append(piece)
            elif piece.geom_type == "MultiPolygon":
                parts.extend(polygon for polygon in piece.geoms if not polygon.is_empty)
    parts.sort(key=lambda polygon: polygon.area, reverse=True)
    return parts


def polygons_of(geom) -> list:
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in {"MultiPolygon", "GeometryCollection"}:
        output = []
        for piece in geom.geoms:
            output.extend(polygons_of(piece))
        return output
    return []


def to_rings(geom) -> list:
    output = []
    for polygon in polygons_of(geom):
        if polygon.area < 1e-7:
            continue
        exterior = [[float(x), float(y)] for x, y, *_rest in polygon.exterior.coords]
        holes = [[[float(x), float(y)] for x, y, *_rest in hole.coords] for hole in polygon.interiors]
        output.append([exterior, *holes])
    return output


def clip_geometry(geom, continent, islands):
    island_hits = [part for part in islands if part.intersects(geom)]
    island_piece = geom.intersection(island_hits[0].buffer(0.002)) if len(island_hits) == 1 else None
    if len(island_hits) > 1:
        from shapely.ops import unary_union

        island_piece = geom.intersection(unary_union(island_hits).buffer(0.002))
    island_area = 0 if island_piece is None else island_piece.area
    continent_piece = geom.intersection(continent)
    if island_area > 1e-6 and island_area > continent_piece.area * 4:
        return island_piece, True
    return continent_piece, False


def projected(rings: list) -> list:
    return [[[mercator(x, y) for x, y in ring] for ring in polygon] for polygon in rings]


def clipped_states(bounds, land) -> list[dict]:
    mesh = get_json(
        "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR"
        "?formato=application/vnd.geo+json&qualidade=intermediaria&intrarregiao=UF",
        timeout=120,
    )
    outlines = []
    for feature in mesh["features"]:
        clipped = shape(feature["geometry"]).intersection(land).simplify(0.0018, preserve_topology=True)
        rings = to_rings(clipped)
        if not rings:
            continue
        outlines.append({"ibge": str(feature["properties"]["codarea"]), "g": scale_rings(projected(rings), bounds)})
    return outlines


def main() -> None:
    parts = land_parts()
    continent = parts[0]
    islands = [part for part in parts[1:] if part.area < continent.area * 0.02]
    from shapely.ops import unary_union

    land = unary_union([continent, *islands])
    prepared = prep(continent)
    island_index = STRtree(islands)
    mesh = json.loads(MESH.read_text())
    _projected, bounds = project_mesh(mesh["features"])
    by_code = {str(feature["properties"]["codarea"]): feature for feature in mesh["features"]}
    snapshot = json.loads(MAP.read_text())
    clipped_count = 0
    island_count = 0
    for index, municipality in enumerate(snapshot["mun"], start=1):
        feature = by_code.get(municipality["ibge"])
        if feature is None:
            municipality["ilha"] = False
            continue
        geom = shape(feature["geometry"])
        candidates = [islands[i] for i in island_index.query(geom, predicate="intersects")]
        clipped, is_island = clip_geometry(geom, continent, candidates)
        if index % 500 == 0:
            print(f"checked {index}", flush=True)
        municipality["ilha"] = is_island
        if is_island:
            island_count += 1
        if clipped.is_empty or clipped.area < geom.area * 0.04:
            continue
        if not is_island and prepared.covers(geom):
            continue
        simplified = clipped.simplify(SIMPLIFY, preserve_topology=True)
        rings = to_rings(simplified)
        if not rings:
            continue
        municipality["g"] = scale_rings(projected(rings), bounds)
        clipped_count += 1
    snapshot["estados"] = outlines_from_municipalities(snapshot["mun"])
    MAP.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))
    print(f"clipped {clipped_count} island munis {island_count} bytes {MAP.stat().st_size}")


def outlines_from_municipalities(municipalities: list[dict]) -> list[dict]:
    """State outline follows the drawn municipality polygons, not a second mesh."""
    from collections import defaultdict

    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    from shapely.validation import make_valid

    grouped: dict[str, list] = defaultdict(list)
    for municipality in municipalities:
        for polygon in municipality.get("g") or []:
            if not polygon or len(polygon[0]) < 6:
                continue
            exterior = [(polygon[0][index], polygon[0][index + 1]) for index in range(0, len(polygon[0]) - 1, 2)]
            holes = [
                [(ring[index], ring[index + 1]) for index in range(0, len(ring) - 1, 2)]
                for ring in polygon[1:]
                if len(ring) >= 6
            ]
            grouped[municipality["uf"]].append(make_valid(Polygon(exterior, holes)))
    outlines = []
    for sigla, polygons in grouped.items():
        polygons = [piece for polygon in polygons for piece in polygons_of(polygon) if piece.area >= 1]
        anchors = [
            (int(point[0]), int(point[1]))
            for polygon in polygons
            for point in polygon.exterior.coords
        ]
        merged = unary_union(polygons)
        pieces = polygons_of(merged)
        rings = []
        for piece in pieces:
            if piece.is_empty or piece.area < 4:
                continue
            snapped = [snap_vertex(point, anchors) for point in piece.exterior.coords]
            exterior = [coord for vertex in snapped for coord in vertex]
            if len(exterior) >= 6:
                rings.append([exterior])
        if rings:
            outlines.append({"ibge": sigla, "g": rings})
    return outlines


def snap_vertex(point, anchors: list[tuple[int, int]]) -> tuple[int, int]:
    nearest = min(anchors, key=lambda anchor: (anchor[0] - point[0]) ** 2 + (anchor[1] - point[1]) ** 2)
    if (nearest[0] - point[0]) ** 2 + (nearest[1] - point[1]) ** 2 <= 2.25:
        return nearest
    return round(point[0]), round(point[1])


if __name__ == "__main__":
    main()

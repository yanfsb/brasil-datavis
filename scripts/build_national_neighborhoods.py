"""Publish neighborhood maps for municipalities with official IBGE bairro polygons.

TSE longitude/latitude has no CRS declaration in the source catalogue. Spatial
assignment therefore records an EPSG:4674 coordinate assumption, and ambiguous,
missing, conflicting, or non-covered places stay outside the neighborhood map.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
import shutil
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/cache"
GEOMETRY_ZIP = CACHE / "BR_bairros_CD2022.zip"
GEOMETRY_URL = "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/bairros/shp/BR/BR_bairros_CD2022.zip"
ELECTORATE_ZIP = CACHE / "eleitorado_local_votacao_2026.zip"
ELECTORATE_URL = "https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip"
APURACAO_MANIFEST = ROOT / "public/data/apuracao/manifest.json"
OUTPUT = ROOT / "public/data/neighborhoods"
SPECIAL_CODES = {"28", "95", "96", "97"}


def ensure_archive(path: Path, url: str) -> None:
    if path.is_file():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "brasil-datavis/2026 public data"})
    print(f"downloading {path.name}", flush=True)
    try:
        with urllib.request.urlopen(request, timeout=300) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        with zipfile.ZipFile(temporary) as archive:
            bad = archive.testzip()
            if bad:
                raise ValueError(f"archive CRC failure {path.name}:{bad}")
        temporary.replace(path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_tse_code(value: str) -> str:
    return str(int(value))


def assignment_status(has_coordinate: bool, match_count: int) -> str:
    if not has_coordinate:
        return "no-coordinate"
    if match_count == 1:
        return "assigned"
    if match_count == 0:
        return "no-neighborhood-boundary"
    return "ambiguous-boundary"


def summarize_place_votes(city: dict, candidate_numbers: list[str]) -> dict[tuple[str, str], dict]:
    places: dict[tuple[str, str], dict] = {}
    for zone in city["zones"]:
        for place in zone["places"]:
            identity = (zone["number"], place["code"])
            totals: Counter[str] = Counter()
            sections = place["sections"]
            for section in sections:
                totals.update(section["candidateVotes"])
                totals.update(section["specialVotes"])
            places[identity] = {
                "name": place.get("name", ""),
                "sectionCount": len(sections),
                "votesByCode": dict(totals),
                "tallies": [{"candidateNumber": number, "votes": totals[number]} for number in candidate_numbers],
            }
    return places


def read_ibge_bairros() -> dict[str, list[tuple[dict, object]]]:
    ensure_archive(GEOMETRY_ZIP, GEOMETRY_URL)
    extraction = CACHE / "ibge-br-bairros"
    extraction.mkdir(parents=True, exist_ok=True)
    required = {f"BR_bairros_CD2022.{extension}" for extension in ("shp", "shx", "dbf", "prj", "cpg")}
    with zipfile.ZipFile(GEOMETRY_ZIP) as archive:
        if not required.issubset(set(archive.namelist())):
            raise ValueError(f"IBGE neighborhood archive missing sidecars: {sorted(required - set(archive.namelist()))}")
        bad = archive.testzip()
        if bad:
            raise ValueError(f"IBGE neighborhood archive CRC failure: {bad}")
        for name in required:
            (extraction / name).write_bytes(archive.read(name))
    projection = (extraction / "BR_bairros_CD2022.prj").read_text(encoding="utf-8")
    if "SIRGAS_2000" not in projection:
        raise ValueError("unexpected IBGE neighborhood CRS")
    reader = shapefile.Reader(str(extraction / "BR_bairros_CD2022.shp"), encoding="utf-8")
    fields = [field[0] for field in reader.fields[1:]]
    grouped: dict[str, list[tuple[dict, object]]] = defaultdict(list)
    for record, shp in zip(reader.records(), reader.shapes()):
        row = dict(zip(fields, record))
        geometry = shape(shp.__geo_interface__)
        if geometry.is_empty or not geometry.is_valid:
            raise ValueError(f"invalid IBGE neighborhood geometry {row.get('CD_BAIRRO')}")
        grouped[str(row["CD_MUN"])].append((row, geometry))
    for ibge, items in grouped.items():
        codes = [str(row["CD_BAIRRO"]) for row, _ in items]
        if len(set(codes)) != len(codes):
            raise ValueError(f"duplicate CD_BAIRRO in municipality {ibge}")
    return grouped


def read_electorate_places(catalog: list[dict[str, str]], covered_municipalities: set[str]) -> tuple[dict, dict]:
    if not ELECTORATE_ZIP.is_file():
        raise FileNotFoundError(f"missing TSE electorate source {ELECTORATE_ZIP}")
    by_tse = {(item["uf"], normalized_tse_code(item["cd"])): item["ibge"] for item in catalog}
    eligible_ufs = {item["uf"] for item in catalog if item["ibge"] in covered_municipalities}
    coordinate_rows: dict[tuple[str, str, str], dict] = {}
    quality = Counter()
    with zipfile.ZipFile(ELECTORATE_ZIP) as archive:
        names = set(archive.namelist())
        for uf in sorted(eligible_ufs):
            member = f"eleitorado_local_votacao_2026_{uf}.csv"
            if member not in names:
                raise ValueError(f"missing TSE electorate member {member}")
            with archive.open(member) as binary:
                source = csv.DictReader((line.decode("latin-1") for line in binary), delimiter=";")
                required = {"AA_ELEICAO", "NR_TURNO", "SG_UF", "CD_MUNICIPIO", "NR_ZONA", "NR_LOCAL_VOTACAO", "NM_LOCAL_VOTACAO", "NM_BAIRRO", "NR_LONGITUDE", "NR_LATITUDE"}
                if not required.issubset(source.fieldnames or []):
                    raise ValueError(f"TSE electorate member missing fields: {member}")
                for row in source:
                    if row.get("AA_ELEICAO") != "2026" or row.get("NR_TURNO") != "1":
                        continue
                    try:
                        tse_municipality_code = normalized_tse_code(row["CD_MUNICIPIO"])
                    except (TypeError, ValueError):
                        continue
                    ibge = by_tse.get((row["SG_UF"], tse_municipality_code))
                    if ibge not in covered_municipalities:
                        continue
                    identity = (ibge, row["NR_ZONA"], row["NR_LOCAL_VOTACAO"])
                    raw = (row.get("NR_LONGITUDE", ""), row.get("NR_LATITUDE", ""))
                    try:
                        lon, lat = (float(value.replace(",", ".")) for value in raw)
                        if not (-180 <= lon <= 180 and -90 <= lat <= 90) or lon == 0 or lat == 0:
                            raise ValueError()
                        coordinate = (lon, lat)
                        quality["coordinateRowsValid"] += 1
                    except (ValueError, TypeError):
                        coordinate = None
                        quality["coordinateRowsInvalid"] += 1
                    existing = coordinate_rows.get(identity)
                    if existing is None:
                        coordinate_rows[identity] = {"coordinate": coordinate, "conflict": False,
                                                     "name": row.get("NM_LOCAL_VOTACAO", "").strip(),
                                                     "neighborhoodLabel": row.get("NM_BAIRRO", "").strip(), "rows": 1}
                    else:
                        existing["rows"] += 1
                        if existing["coordinate"] != coordinate:
                            existing["conflict"] = True
    return coordinate_rows, dict(quality)


def build(catalog: list[dict[str, str]] | None = None, map_payload: dict | None = None) -> dict:
    ensure_archive(GEOMETRY_ZIP, GEOMETRY_URL)
    ensure_archive(ELECTORATE_ZIP, ELECTORATE_URL)
    if catalog is None:
        from build_map import load_catalog
        catalog = load_catalog()
    if map_payload is None:
        map_path = ROOT / "public/data/map.json"
        if not map_path.is_file():
            raise FileNotFoundError("build the municipal map before neighborhood layers")
        map_payload = json.loads(map_path.read_text(encoding="utf-8"))
    apuracao = json.loads(APURACAO_MANIFEST.read_text(encoding="utf-8"))
    city_results = apuracao["municipalities"]
    candidates = [{"number": str(item["number"]), "name": item["name"], "party": item["party"]} for item in apuracao["candidates"]]
    candidate_numbers = [item["number"] for item in candidates]
    geometries_by_municipality = read_ibge_bairros()
    map_municipalities = {item["ibge"]: item for item in map_payload["mun"]}
    eligible = set(geometries_by_municipality) & set(map_municipalities) & set(city_results)
    if not eligible:
        raise ValueError("IBGE neighborhood mesh has no overlap with map and TSE results")
    source_hash = hashlib.sha256(("national-neighborhoods-v2" + sha256(GEOMETRY_ZIP) + sha256(ELECTORATE_ZIP) + apuracao["sourceSha256"]).encode()).hexdigest()
    catalog_hash = hashlib.sha256(json.dumps(catalog, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest_path = OUTPUT / "manifest.json"
    if manifest_path.is_file():
        cached = json.loads(manifest_path.read_text(encoding="utf-8"))
        valid_assets = all((OUTPUT / item["detail"]).is_file() for item in cached.get("municipalities", {}).values())
        if cached.get("sourceSha256") == source_hash and cached.get("catalogSha256") == catalog_hash and valid_assets:
            refresh_manifest_coverage(cached)
            manifest_path.write_text(json.dumps(cached, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            print(f"using cached IBGE neighborhood layers for {len(cached['municipalities'])} municipalities", flush=True)
            apply_to_map(map_payload, cached)
            return cached
    coordinate_rows, coordinate_quality = read_electorate_places(catalog, eligible)
    output_municipalities: dict[str, dict] = {}
    assignment_totals = Counter()
    vote_totals = Counter()
    output_directory = OUTPUT / "municipalities"
    output_directory.mkdir(parents=True, exist_ok=True)
    catalog_by_ibge = {item["ibge"]: item for item in catalog}
    for ibge in sorted(eligible):
        map_mun = map_municipalities[ibge]
        geo_items = geometries_by_municipality[ibge]
        codes = [str(row["CD_BAIRRO"]) for row, _ in geo_items]
        names = [str(row.get("NM_BAIRRO") or "") for row, _ in geo_items]
        geometries = [geometry for _, geometry in geo_items]
        union = unary_union(geometries)
        center = union.centroid
        zone = int((center.x + 180) // 6) + 1
        target_crs = f"EPSG:{31960 + zone}"
        project = Transformer.from_crs("EPSG:4674", target_crs, always_xy=True).transform
        tree = STRtree(geometries)
        apuracao_path = OUTPUT.parent / "apuracao" / city_results[ibge]["detail"]
        with gzip.open(apuracao_path, "rt", encoding="utf-8") as source:
            city = json.load(source)
        place_votes = summarize_place_votes(city, candidate_numbers)
        neighborhood_votes: dict[str, Counter[str]] = {code: Counter() for code in codes}
        place_rows = []
        unassigned = Counter()
        assigned_place_count = 0
        assigned_valid_votes = 0
        total_valid_votes = 0
        assigned_all_votes = 0
        total_all_votes = 0
        municipality_point_counts = Counter()
        for (zone_code, place_code), record in place_votes.items():
            identity = (ibge, zone_code, place_code)
            source_place = coordinate_rows.get(identity)
            coordinate = source_place["coordinate"] if source_place else None
            reason = None
            if source_place is None:
                reason = "no-coordinate-record"
            elif source_place["conflict"]:
                reason = "coordinate-conflict"
                coordinate = None
            elif coordinate is None:
                reason = "no-coordinate"
            neighborhood_code = None
            x = y = None
            if coordinate is not None:
                point = Point(coordinate)
                hits = tree.query(point)
                matches = [int(index) for index in hits if geometries[int(index)].covers(point)]
                status = assignment_status(True, len(matches))
                if status == "assigned":
                    neighborhood_code = codes[matches[0]]
                    x, y = project(*coordinate)
                else:
                    reason = status
            if neighborhood_code is not None:
                assigned_place_count += 1
                neighborhood_votes[neighborhood_code].update(record["votesByCode"])
                assigned_valid_votes += sum(record["votesByCode"].get(number, 0) for number in candidate_numbers)
                assigned_all_votes += sum(record["votesByCode"].values())
            else:
                unassigned.update(record["votesByCode"])
            local_valid_votes = sum(record["votesByCode"].get(number, 0) for number in candidate_numbers)
            total_valid_votes += local_valid_votes
            total_all_votes += sum(record["votesByCode"].values())
            municipality_point_counts[reason or "assigned"] += 1
            place_rows.append({"id": f"{zone_code}-{place_code}", "zone": zone_code, "placeCode": place_code,
                               "sectionCount": record["sectionCount"], "detail": f"places/{zone_code}-{place_code}.json",
                               "neighborhoodCode": neighborhood_code,
                               "name": (source_place or {}).get("name", record["name"]),
                               "neighborhoodLabel": (source_place or {}).get("neighborhoodLabel", ""),
                               "coordinate": {"x": x, "y": y} if x is not None and y is not None else None,
                               "mapCoordinate": {"longitude": coordinate[0], "latitude": coordinate[1]} if coordinate is not None else None,
                               "coordinateStatus": "valid" if neighborhood_code else reason,
                               "unassignedReason": reason,
                               "validVotes": local_valid_votes,
                               "tallies": record["tallies"]})
        features = []
        for index, ((row, geometry), code, name) in enumerate(zip(geo_items, codes, names)):
            votes = neighborhood_votes[code]
            features.append({"type": "Feature", "geometry": geometry.__geo_interface__,
                             "properties": {"code": code, "name": name,
                                            "votesByCandidate": {number: votes[number] for number in candidate_numbers},
                                            "specialVotesByCode": {vote_code: votes[vote_code] for vote_code in SPECIAL_CODES if votes[vote_code]}}})
        assigned_percent = 100 * assigned_valid_votes / total_valid_votes if total_valid_votes else 0
        summary = {
            "schemaVersion": 1,
            "municipality": {"name": map_mun["nome"], "uf": map_mun["uf"],
                             "tseCode": catalog_by_ibge[ibge]["cd"], "ibgeCode": ibge},
            "election": {"year": 2026, "round": 1, "cargoCode": "1"},
            "geometry": {"source": "IBGE Malha de Bairros Censo 2022", "sourceCrs": "EPSG:4674",
                         "coordinateCrsAssumption": "EPSG:4674 (TSE coordinate datum is not declared)", "projectedCrs": target_crs,
                         "neighborhoods": len(features)},
            "candidateNumbers": candidate_numbers, "candidates": candidates,
            "candidateVotes": {number: city["candidateVotes"].get(number, 0) for number in candidate_numbers},
            "noGeometryVotesByCode": dict(unassigned),
            "coverage": {"totalPlaces": len(place_rows), "assignedPlaces": assigned_place_count,
                         "unassignedPlaces": len(place_rows) - assigned_place_count,
                         "assignedValidVotes": assigned_valid_votes, "totalValidVotes": total_valid_votes,
                         "unassignedValidVotes": total_valid_votes - assigned_valid_votes,
                         "assignedValidVotesPercent": round(assigned_percent, 4),
                         "assignmentReasons": dict(municipality_point_counts)},
            "places": place_rows,
            "neighborhoods": {"type": "FeatureCollection", "features": features},
        }
        raw = json.dumps(summary, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        path = output_directory / f"{ibge}.json.gz"
        path.write_bytes(compressed)
        output_municipalities[ibge] = {"detail": f"municipalities/{ibge}.json.gz", "neighborhoodCount": len(features),
                                       "placeCount": len(place_rows), "assignedPlaceCount": assigned_place_count,
                                       "totalValidVotes": total_valid_votes, "assignedValidVotes": assigned_valid_votes,
                                       "bytes": len(compressed)}
        assignment_totals.update(municipality_point_counts)
        vote_totals["valid"] += total_valid_votes
        vote_totals["assignedValid"] += assigned_valid_votes
        print(f"bairros {ibge} {map_mun['nome']} places={len(place_rows)} assigned={assigned_place_count} votes={assigned_percent:.1f}%", flush=True)

    manifest = {"schemaVersion": 1, "year": 2026, "sourceSha256": source_hash, "catalogSha256": catalog_hash,
                "coordinateReferenceAssumption": "TSE local coordinates treated as EPSG:4674; verify with data owner before definitive boundary claims",
                "source": {"ibge": str(GEOMETRY_ZIP.name), "electorate": str(ELECTORATE_ZIP.name)},
                "neighborhoodMunicipalities": len(geometries_by_municipality),
                "mappedMunicipalities": len(output_municipalities),
                "municipalitiesWithAssignedResults": sum(1 for item in output_municipalities.values() if item["assignedPlaceCount"] > 0),
                "municipalityAssets": len(output_municipalities),
                "neighborhoodFeatures": sum(item["neighborhoodCount"] for item in output_municipalities.values()),
                "pollingPlaces": sum(item["placeCount"] for item in output_municipalities.values()),
                "assignedPlaces": sum(item["assignedPlaceCount"] for item in output_municipalities.values()),
                "assignmentReasons": dict(assignment_totals), "totalValidVotes": vote_totals["valid"],
                "assignedValidVotes": vote_totals["assignedValid"], "municipalities": output_municipalities,
                "sourceCoordinateQuality": coordinate_quality}
    refresh_manifest_coverage(manifest)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote neighborhood layers for {len(output_municipalities)} municipalities; manifest {manifest_path}", flush=True)
    apply_to_map(map_payload, manifest)
    return manifest


def refresh_manifest_coverage(manifest: dict) -> None:
    records = manifest["municipalities"]
    manifest["municipalityAssets"] = len(records)
    manifest["mappedMunicipalities"] = len(records)
    manifest["municipalitiesWithAssignedResults"] = sum(1 for item in records.values() if item["assignedPlaceCount"] > 0)


def apply_to_map(payload: dict, manifest: dict) -> None:
    records = manifest["municipalities"]
    for municipality in payload["mun"]:
        municipality.pop("neighborhoodLayer", None)
        record = records.get(municipality["ibge"])
        if record:
            municipality["neighborhoodLayer"] = record["detail"]
    payload["bairroCoverage"] = {"municipalitiesWithOfficialNeighborhoods": manifest["neighborhoodMunicipalities"],
                                 "municipalitiesWithNeighborhoodLayer": manifest["mappedMunicipalities"],
                                 "municipalitiesWithAssignedResults": manifest["municipalitiesWithAssignedResults"],
                                 "source": "IBGE Censo 2022; TSE local coordinates under stated EPSG:4674 assumption"}


if __name__ == "__main__":
    layer_manifest = build()
    map_path = ROOT / "public/data/map.json"
    if map_path.is_file():
        map_payload = json.loads(map_path.read_text(encoding="utf-8"))
        apply_to_map(map_payload, layer_manifest)
        map_path.write_text(json.dumps(map_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"attached neighborhood layers to {map_path}", flush=True)

"""Audit official 2026 Salvador polling-place data against IBGE 2022 bairros.

Raw ZIPs are expected in ignored data/cache/. This command never publishes
browser data; it writes a reproducible audit report only after source/member,
geometry, join and vote-conservation checks have run.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

import shapefile
from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/cache"
REPORT = ROOT / "data/audit/salvador-2026.json"
SOURCES = {
    "votes": ("votacao_secao_2026_BR.zip", "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_BR.zip", "votacao_secao_2026_BR.csv"),
    "detail": ("detalhe_votacao_secao_2026.zip", "https://cdn.tse.jus.br/estatistica/sead/odsele/detalhe_votacao_secao/detalhe_votacao_secao_2026.zip", "detalhe_votacao_secao_2026_BR.csv"),
    "electorate": ("eleitorado_local_votacao_2026.zip", "https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip", "eleitorado_local_votacao_2026_BA.csv"),
    "geometry": ("BA_bairros_CD2022.zip", "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/bairros/shp/UF/BA_bairros_CD2022.zip", "BA_bairros_CD2022.shp"),
}
MUNICIPALITY_TSE = "38490"
MUNICIPALITY_IBGE = "2927408"
ELECTION = "6257"
EA20_URL = "https://resultados.tse.jus.br/oficial/ele2026/6257/dados/ba/ba38490-c0001-e006257-u.json"
TECHNICAL_NULL_CODES = {"28"}


def source_headers(url: str) -> dict[str, str | None]:
    request = Request(url, method="HEAD")
    with urlopen(request, timeout=30) as response:
        return {"lastModified": response.headers.get("Last-Modified"), "etag": response.headers.get("ETag")}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def archive(name: str, member: str) -> zipfile.ZipFile:
    path = CACHE / name
    if not path.is_file():
        raise FileNotFoundError(f"missing source archive {path}")
    zf = zipfile.ZipFile(path)
    names = zf.namelist()
    if names.count(member) != 1:
        raise ValueError(f"expected exactly one member {member!r}; found {names.count(member)}")
    bad = zf.testzip()
    if bad:
        raise ValueError(f"archive CRC failure in {name}:{bad}")
    return zf


def rows(zf: zipfile.ZipFile, member: str):
    with zf.open(member) as binary:
        text = io.TextIOWrapper(binary, encoding="latin-1", newline="")
        yield from csv.DictReader(text, delimiter=";")


def election_match(row: dict[str, str], year_field: str) -> bool:
    return (row.get(year_field) == "2026" and row.get("NR_TURNO") == "1"
            and row.get("CD_ELEICAO") == ELECTION and row.get("CD_CARGO") == "1"
            and row.get("SG_UF") == "BA" and row.get("CD_MUNICIPIO") == MUNICIPALITY_TSE)


def number(value: str) -> int:
    if not value or not value.isdigit():
        raise ValueError(f"invalid non-negative count {value!r}")
    return int(value)


def ea20_candidate_totals(payload: dict) -> dict[str, int]:
    """Return official valid candidate counts, excluding special technical-null codes."""
    totals = {}
    try:
        for group in payload["carg"]:
            if group.get("cd") != "1":
                continue
            for coalition in group.get("agr", []):
                for party in coalition.get("par", []):
                    for candidate in party.get("cand", []):
                        number_code = str(candidate["n"])
                        if number_code in totals:
                            raise ValueError(f"duplicate EA20 candidate number {number_code}")
                        totals[number_code] = number(candidate["vap"])
    except (KeyError, TypeError) as error:
        raise ValueError("malformed EA20 candidate results") from error
    return totals


def ea20_candidate_metadata(payload: dict, valid_numbers: set[str]) -> list[dict[str, str]]:
    metadata = {}
    for group in payload.get("carg", []):
        if group.get("cd") != "1":
            continue
        for coalition in group.get("agr", []):
            for party in coalition.get("par", []):
                for candidate in party.get("cand", []):
                    number_code = str(candidate.get("n", ""))
                    if number_code in valid_numbers:
                        name = str(candidate.get("nmu") or candidate.get("nm") or f"Candidato {number_code}")
                        metadata[number_code] = {
                            "number": number_code,
                            "name": name.title() if name.isupper() else name,
                            "party": str(party.get("sg") or "Sem partido informado"),
                        }
    if set(metadata) != valid_numbers:
        raise ValueError("EA20 candidate metadata does not cover the valid candidate list")
    return [metadata[number_code] for number_code in sorted(metadata, key=int)]


def reconcile_ea20(payload: dict, csv_totals: dict[str, int], turnout: int, electorate: int) -> dict:
    official = ea20_candidate_totals(payload)
    candidate_csv = {code: count for code, count in csv_totals.items()
                      if code not in {"95", "96", "97"} | TECHNICAL_NULL_CODES}
    if candidate_csv != official:
        raise ValueError(f"EA20 candidate reconciliation mismatch: CSV={candidate_csv}, EA20={official}")
    summary = payload.get("v", {})
    elec = payload.get("e", {})
    if number(summary.get("vv", "")) != sum(official.values()) or number(summary.get("vnom", "")) != sum(official.values()):
        raise ValueError("EA20 valid-vote total does not equal candidate tally sum")
    if number(summary.get("tv", "")) != turnout or number(elec.get("c", "")) != turnout:
        raise ValueError("EA20 turnout mismatch")
    if number(elec.get("te", "")) != electorate:
        raise ValueError("EA20 electorate mismatch")
    blank_votes = sum(csv_totals.get(code, 0) for code in ("95",))
    null_votes = sum(csv_totals.get(code, 0) for code in ("96", "97"))
    technical_nulls = sum(csv_totals.get(code, 0) for code in TECHNICAL_NULL_CODES)
    if blank_votes != number(summary.get("vb", "")):
        raise ValueError("section-source blank votes (code 95) do not reconcile to EA20 vb")
    if null_votes != number(summary.get("vn", "")):
        raise ValueError("section-source null votes (codes 96/97) do not reconcile to EA20 vn")
    if technical_nulls != number(summary.get("vnt", "")):
        raise ValueError("section-source code 28 does not reconcile to EA20 vnt")
    total_null_related = null_votes + technical_nulls
    if total_null_related != number(summary.get("tvn", "")):
        raise ValueError("section-source null and technical-null votes do not reconcile to EA20 tvn")
    return {"url": EA20_URL, "candidateVotesByNumber": dict(sorted(official.items()),),
            "candidates": ea20_candidate_metadata(payload, set(official)),
            "validVotes": number(summary["vv"]), "turnout": number(summary["tv"]),
            "electorate": number(elec["te"]), "blankVotes": number(summary["vb"]),
            "nullVotes": number(summary["vn"]), "technicalNullVotes": technical_nulls,
            "totalNullRelatedVotes": number(summary["tvn"])}


def publish_static_data(boundary_rows, boundaries, place_votes, assigned_places, vote_sections,
                        electorate, project, reconciliation, source_meta, coverage) -> None:
    """Publish compact city geometry and separately loadable polling-place detail."""
    neighborhood_votes: dict[int, Counter[str]] = defaultdict(Counter)
    for place, totals in place_votes.items():
        if place in assigned_places:
            neighborhood_votes[assigned_places[place]].update(totals)
    features = []
    for index, (record, _) in enumerate(boundary_rows):
        code = str(record["CD_BAIRRO"])
        features.append({"type": "Feature", "geometry": boundaries[index].__geo_interface__,
                         "properties": {"code": code, "name": str(record.get("NM_BAIRRO", "")),
                                        "votesByCandidate": dict(sorted((
                                            code_vote, count) for code_vote, count in neighborhood_votes[index].items()
                                            if code_vote not in {"28", "95", "96", "97"})),
                                        "specialVotesByCode": dict(sorted((
                                            code_vote, count) for code_vote, count in neighborhood_votes[index].items()
                                            if code_vote in {"28", "95", "96", "97"}))}})

    places_dir = ROOT / "public/data/salvador/places"
    places_dir.mkdir(parents=True, exist_ok=True)
    place_index = []
    for place in sorted(place_votes):
        municipality, zone, place_code = place
        place_id = f"{zone}-{place_code}"
        sections = []
        for section, bucket in sorted(vote_sections.items()):
            if (section[0], section[1], bucket["place"]) != place:
                continue
            sections.append({"section": section[2], "votesByCode": dict(sorted(bucket["votes"].items()))})
        payload = {"schemaVersion": 1, "place": {"municipalityCode": municipality,
                    "zone": zone, "placeCode": place_code}, "sections": sections}
        (places_dir / f"{place_id}.json").write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
        local = electorate.get(place, {})
        coordinate = local.get("coordinate")
        projected_coordinate = None
        map_coordinate = None
        if coordinate is not None:
            x, y = project(*coordinate)
            projected_coordinate = {"x": x, "y": y}
            map_coordinate = {"longitude": coordinate[0], "latitude": coordinate[1]}
        neighborhood_index = assigned_places.get(place)
        tallies = [{"candidateNumber": code, "votes": count} for code, count in sorted(place_votes[place].items())
                   if code not in {"28", "95", "96", "97"}]
        place_index.append({"id": place_id, "zone": zone, "placeCode": place_code,
                            "sectionCount": len(sections), "detail": f"places/{place_id}.json",
                            "neighborhoodCode": str(boundary_rows[neighborhood_index][0]["CD_BAIRRO"]) if neighborhood_index is not None else None,
                            "name": local.get("name", ""), "neighborhoodLabel": local.get("label", ""),
                            "coordinate": projected_coordinate, "mapCoordinate": map_coordinate,
                            "coordinateStatus": "valid" if coordinate is not None else "missing",
                            "tallies": tallies})

    no_geometry = Counter()
    for place, totals in place_votes.items():
        if place not in assigned_places:
            no_geometry.update(totals)
    summary = {"schemaVersion": 1, "municipality": {"name": "Salvador", "uf": "BA", "tseCode": MUNICIPALITY_TSE, "ibgeCode": MUNICIPALITY_IBGE},
               "election": {"year": 2026, "round": 1, "cargoCode": "1"},
               "sourceManifest": source_meta, "coverage": coverage,
               "reconciliation": reconciliation,
               "candidateNumbers": sorted(reconciliation["candidateVotesByNumber"], key=int),
               "candidates": reconciliation["candidates"],
               "noGeometryVotesByCode": dict(sorted(no_geometry.items())),
               "places": place_index,
               "neighborhoods": {"type": "FeatureCollection", "features": features}}
    output = ROOT / "public/data/salvador"
    output.mkdir(parents=True, exist_ok=True)
    (output / "summary.json").write_text(json.dumps(summary, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    source_meta = {}
    for key, (filename, url, member) in SOURCES.items():
        path = CACHE / filename
        if not path.exists():
            raise FileNotFoundError(path)
        source_meta[key] = {"url": url, "member": member, "bytes": path.stat().st_size, "sha256": sha256(path), **source_headers(url)}

    vote_zip = archive(SOURCES["votes"][0], SOURCES["votes"][2])
    detail_zip = archive(SOURCES["detail"][0], SOURCES["detail"][2])
    electorate_zip = archive(SOURCES["electorate"][0], SOURCES["electorate"][2])
    # Inspect exact geometry sidecars and their checksums, all within the source ZIP.
    geom_path = CACHE / "BA_bairros_CD2022.zip"
    with zipfile.ZipFile(geom_path) as geom_zip:
        required = {"BA_bairros_CD2022.shp", "BA_bairros_CD2022.shx", "BA_bairros_CD2022.dbf", "BA_bairros_CD2022.prj", "BA_bairros_CD2022.cpg"}
        if not required.issubset(set(geom_zip.namelist())):
            raise ValueError(f"IBGE archive missing sidecars: {sorted(required-set(geom_zip.namelist()))}")
        bad = geom_zip.testzip()
        if bad:
            raise ValueError(f"geometry CRC failure in {bad}")
        for extension in ("shp", "shx", "dbf", "prj", "cpg"):
            (CACHE / f"BA_bairros_CD2022.{extension}").write_bytes(geom_zip.read(f"BA_bairros_CD2022.{extension}"))

    reader = shapefile.Reader(str(CACHE / "BA_bairros_CD2022.shp"), encoding="utf-8")
    fields = [field[0] for field in reader.fields[1:]]
    records = [dict(zip(fields, rec)) for rec in reader.records()]
    shapes = reader.shapes()
    boundary_rows = [(record, geom) for record, geom in zip(records, shapes) if str(record.get("CD_MUN", "")) == MUNICIPALITY_IBGE]
    if not boundary_rows:
        raise ValueError("official IBGE BA mesh contains no Salvador records")
    boundaries = [shape(geom.__geo_interface__) for _, geom in boundary_rows]
    geometry_counts = Counter("empty" if g.is_empty else "invalid" if not g.is_valid else "valid" for g in boundaries)
    codes = [str(row.get("CD_BAIRRO", "")) for row, _ in boundary_rows]
    if len(set(codes)) != len(codes):
        raise ValueError("duplicate CD_BAIRRO in Salvador boundary records")
    if any(g.is_empty or not g.is_valid for g in boundaries):
        raise ValueError("empty or invalid IBGE Salvador boundary geometry")
    crs_text = (CACHE / "BA_bairros_CD2022.prj").read_text(encoding="utf-8")
    if "SIRGAS_2000" not in crs_text:
        raise ValueError("unexpected IBGE CRS")
    project = Transformer.from_crs("EPSG:4674", "EPSG:31984", always_xy=True).transform
    projected = [transform(project, g) for g in boundaries]
    tree = STRtree(projected)

    electorate: dict[tuple[str, str, str], dict] = {}
    coordinate_conflicts = 0
    invalid_coordinates = Counter()
    for row in rows(electorate_zip, SOURCES["electorate"][2]):
        if not (row.get("AA_ELEICAO") == "2026" and row.get("NR_TURNO") == "1" and row.get("SG_UF") == "BA" and row.get("CD_MUNICIPIO") == MUNICIPALITY_TSE):
            continue
        key = (row["CD_MUNICIPIO"], row["NR_ZONA"], row["NR_LOCAL_VOTACAO"])
        raw = (row.get("NR_LONGITUDE", ""), row.get("NR_LATITUDE", ""))
        try:
            lon, lat = (float(v.replace(",", ".")) for v in raw)
            if not math.isfinite(lon) or not math.isfinite(lat) or not (-180 <= lon <= 180 and -90 <= lat <= 90) or lon == 0 or lat == 0:
                raise ValueError()
            coord = (lon, lat)
        except ValueError:
            coord = None
            invalid_coordinates["missing-or-invalid"] += 1
        old = electorate.get(key)
        if old and old["coordinate"] != coord:
            coordinate_conflicts += 1
        # Multiple sections repeat the same local; retain one row, flag coordinate disagreements.
        if old is None:
            electorate[key] = {"coordinate": coord, "label": row.get("NM_BAIRRO", ""), "name": row.get("NM_LOCAL_VOTACAO", "")}

    vote_sections: dict[tuple[str, str, str], dict] = {}
    vote_totals: Counter[str] = Counter()
    voterows = 0
    for row in rows(vote_zip, SOURCES["votes"][2]):
        if not election_match(row, "ANO_ELEICAO"):
            continue
        voterows += 1
        section = (row["CD_MUNICIPIO"], row["NR_ZONA"], row["NR_SECAO"])
        place = row.get("NR_LOCAL_VOTACAO", "")
        candidate = row.get("NR_VOTAVEL", "")
        count = number(row.get("QT_VOTOS", ""))
        bucket = vote_sections.setdefault(section, {"place": place, "votes": Counter()})
        if bucket["place"] != place:
            raise ValueError(f"section has conflicting polling places: {section}")
        bucket["votes"][candidate] += count
        vote_totals[candidate] += count

    detail_sections = {}
    detail_rows = 0
    for row in rows(detail_zip, SOURCES["detail"][2]):
        if not election_match(row, "ANO_ELEICAO"):
            continue
        detail_rows += 1
        key = (row["CD_MUNICIPIO"], row["NR_ZONA"], row["NR_SECAO"])
        if key in detail_sections:
            raise ValueError(f"duplicate section detail row {key}")
        detail_sections[key] = row
    if set(vote_sections) != set(detail_sections):
        raise ValueError(f"vote/detail section mismatch: votes-only={len(set(vote_sections)-set(detail_sections))}, detail-only={len(set(detail_sections)-set(vote_sections))}")

    detail_totals = Counter()
    for section, bucket in vote_sections.items():
        row = detail_sections[section]
        candidate_sum = sum(bucket["votes"].values())
        named = sum(v for c, v in bucket["votes"].items() if c not in {"95", "96", "97"})
        blank = bucket["votes"].get("95", 0)
        null = bucket["votes"].get("96", 0) + bucket["votes"].get("97", 0)
        expected = (number(row["QT_VOTOS_NOMINAIS"]), number(row["QT_VOTOS_BRANCOS"]), number(row["QT_VOTOS_NULOS"]) + number(row["QT_VOTOS_ANULADOS_APU_SEP"]))
        if (named, blank, null) != expected:
            raise ValueError(f"section vote/detail mismatch {section}: {(named, blank, null)} != {expected}")
        if candidate_sum != number(row["QT_COMPARECIMENTO"]):
            raise ValueError(f"section votes do not reconcile to turnout for {section}")
        detail_totals["turnout"] += number(row["QT_COMPARECIMENTO"])
        detail_totals["electorate"] += number(row["QT_APTOS"])

    assigned_places = Counter()
    assignment_issues = Counter()
    for key, local in electorate.items():
        coord = local["coordinate"]
        if coord is None:
            assignment_issues["no-coordinate"] += 1
            continue
        lon, lat = coord
        if not (-39.5 <= lon <= -38.0 and -13.5 <= lat <= -12.0):
            assignment_issues["outside-salvador-envelope"] += 1
            continue
        x, y = project(lon, lat)
        point = Point(x, y)
        candidates = tree.query(point)
        containing = [int(i) for i in candidates if projected[int(i)].covers(point)]
        if len(containing) == 1:
            assigned_places[key] = containing[0]
        elif len(containing) == 0:
            assignment_issues["outside-or-gap"] += 1
        else:
            assignment_issues["ambiguous-boundary-or-overlap"] += 1

    vote_places = {(s[0], s[1], b["place"]) for s, b in vote_sections.items()}
    missing_electorate = vote_places - set(electorate)
    if missing_electorate:
        assignment_issues["voting-place-without-electorate-coordinate-row"] = len(missing_electorate)
    place_votes: dict[tuple[str, str, str], Counter[str]] = defaultdict(Counter)
    for section, bucket in vote_sections.items():
        place_votes[(section[0], section[1], bucket["place"])].update(bucket["votes"])
    total_vote_weight = Counter()
    assigned_vote_weight = Counter()
    for place, totals in place_votes.items():
        total_vote_weight.update(totals)
        if place in assigned_places:
            assigned_vote_weight.update(totals)
    unassigned_vote_weight = total_vote_weight - assigned_vote_weight
    if assigned_vote_weight + unassigned_vote_weight != total_vote_weight:
        raise ValueError("vote-weighted assignment does not conserve all vote codes")
    with urlopen(Request(EA20_URL, headers={"User-Agent": "BrasilDatavis/1.0"}), timeout=30) as response:
        ea20_payload = json.load(response)
    reconciliation = reconcile_ea20(ea20_payload, vote_totals, detail_totals["turnout"], detail_totals["electorate"])
    valid_codes = {code for code in vote_totals if code not in {"95", "96", "97"} | TECHNICAL_NULL_CODES}
    valid_total = sum(total_vote_weight[code] for code in valid_codes)
    if valid_total != reconciliation["validVotes"]:
        raise ValueError("spatial input valid votes do not conserve EA20 valid-vote total")
    assigned_valid = sum(assigned_vote_weight[code] for code in valid_codes)
    all_total = sum(total_vote_weight.values())
    assigned_all = sum(assigned_vote_weight.values())

    result = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "municipality": {"name": "Salvador", "tseCode": MUNICIPALITY_TSE, "ibgeCode": MUNICIPALITY_IBGE, "uf": "BA"},
        "election": {"year": 2026, "round": 1, "electionCode": ELECTION, "cargoCode": "1"},
        "sources": source_meta,
        "geometry": {"sourceRecords": len(boundary_rows), "geometryCounts": dict(geometry_counts), "duplicateCodes": len(codes)-len(set(codes)), "crs": "EPSG:4674", "projectedCrs": "EPSG:31984", "projectedAreaKm2": round(sum(g.area for g in projected)/1e6, 3)},
        "results": {"voteRows": voterows, "detailRows": detail_rows, "voteSections": len(vote_sections), "detailSections": len(detail_sections), "candidateCodesIncludingSpecial": len(vote_totals), "voteTotalsByCode": dict(sorted(vote_totals.items())), "sectionTurnout": detail_totals["turnout"], "sectionElectorate": detail_totals["electorate"], "ea20Reconciliation": reconciliation, "technicalNullCodes": {code: vote_totals[code] for code in sorted(TECHNICAL_NULL_CODES)}},
        "locations": {"electorateRowsUniquePlaces": len(electorate), "votingPlaces": len(vote_places), "validCoordinatePlaces": sum(1 for v in electorate.values() if v["coordinate"] is not None), "coordinateConflicts": coordinate_conflicts, "invalidCoordinates": dict(invalid_coordinates), "assignments": len(assigned_places), "assignmentIssues": dict(assignment_issues)},
        "voteCoverage": {"allVotes": all_total, "assignedVotes": assigned_all, "unassignedVotes": all_total-assigned_all, "allVotesCoveragePercent": round(100*assigned_all/all_total, 6) if all_total else None, "validCandidateVotes": valid_total, "assignedValidCandidateVotes": assigned_valid, "validVoteCoveragePercent": round(100*assigned_valid/valid_total, 6) if valid_total else None, "unassignedByCode": dict(sorted(unassigned_vote_weight.items()))},
        "publicationGate": "reconciled; spatially unassigned votes retained as explicit categories",
    }
    publish_static_data(boundary_rows, boundaries, place_votes, assigned_places, vote_sections,
                         electorate, project, reconciliation, source_meta, result["voteCoverage"])
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

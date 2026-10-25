"""Build lazy, municipality-scoped presidential results from the TSE section CSV.

The source zip is the same audited nationwide file used by audit_salvador.py.
One gzip-compressed JSON asset is emitted per municipality; sections are not
loaded until a user opens that municipality's detail panel.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
import shutil
import sqlite3
import tempfile
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/cache"
SOURCE_ZIP = CACHE / "votacao_secao_2026_BR.zip"
ELECTORATE_ZIP = CACHE / "eleitorado_local_votacao_2026.zip"
SOURCE_URL = "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_BR.zip"
ELECTORATE_URL = "https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip"
SOURCE_MEMBER = "votacao_secao_2026_BR.csv"
SNAPSHOT = ROOT / "public/data/snapshot.json"
OUTPUT = ROOT / "public/data/apuracao"
ELECTION = "6257"
CANDIDATE_CODE = {"95", "96", "97", "28"}


def ensure_archive(path: Path, url: str) -> None:
    if path.is_file():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "brasil-datavis/2026 public TSE data"})
    print(f"downloading {path.name} from TSE", flush=True)
    try:
        with urllib.request.urlopen(request, timeout=300) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        with zipfile.ZipFile(temporary) as archive:
            bad_member = archive.testzip()
            if bad_member:
                raise ValueError(f"archive CRC failure in {path.name}:{bad_member}")
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


def candidate_catalog(snapshot: dict) -> list[dict]:
    candidates = snapshot["brasil"].get("candidatos", [])
    result = []
    for candidate in candidates:
        number = str(candidate["numero"])
        if number in CANDIDATE_CODE:
            continue
        result.append({"number": number, "name": str(candidate["nome"]), "party": str(candidate["partido"]),
                       "nationalVotes": int(candidate["votos"]), "nationalPercent": float(candidate["percentual"])})
    if not result or len({candidate["number"] for candidate in result}) != len(result):
        raise ValueError("national snapshot has an invalid presidential candidate catalog")
    return sorted(result, key=lambda candidate: int(candidate["number"]))


def publish_city(ibge: str, rows: Iterable[tuple[str, str, str, str, int]], candidates: list[dict], place_names: dict[tuple[str, str, str], str] | None = None) -> dict:
    """Serialize rows (zone, place, section, vote code, count) into one compact city asset."""
    zones: dict[str, dict] = {}
    candidate_numbers = [candidate["number"] for candidate in candidates]
    for zone_code, place_code, section_code, vote_code, votes in rows:
        zone = zones.setdefault(zone_code, {"places": {}, "candidateVotes": defaultdict(int)})
        place = zone["places"].setdefault(place_code, {"sections": {}})
        section = place["sections"].setdefault(section_code, {"candidateVotes": defaultdict(int), "specialVotes": defaultdict(int)})
        if vote_code in candidate_numbers:
            section["candidateVotes"][vote_code] += votes
            zone["candidateVotes"][vote_code] += votes
        else:
            section["specialVotes"][vote_code] += votes

    output_zones = []
    for zone_code, zone in sorted(zones.items(), key=lambda item: int(item[0])):
        tallies = {number: zone["candidateVotes"].get(number, 0) for number in candidate_numbers}
        ranked = sorted(tallies.items(), key=lambda item: (-item[1], int(item[0])))
        valid_votes = sum(tallies.values())
        margin = (100 * (ranked[0][1] - ranked[1][1]) / valid_votes) if len(ranked) > 1 and valid_votes else None
        places = []
        for place_code, place in sorted(zone["places"].items(), key=lambda item: int(item[0])):
            sections = []
            for section_code, section in sorted(place["sections"].items(), key=lambda item: int(item[0])):
                candidate_votes = {number: section["candidateVotes"].get(number, 0) for number in candidate_numbers}
                sections.append({"number": section_code, "candidateVotes": candidate_votes,
                                 "specialVotes": dict(sorted(section["specialVotes"].items(), key=lambda item: int(item[0]))),
                                 "validVotes": sum(candidate_votes.values())})
            place = {"code": place_code, "sections": sections}
            place_name = (place_names or {}).get((ibge, zone_code, place_code))
            if place_name:
                place["name"] = place_name
            places.append(place)
        output_zones.append({"number": zone_code, "candidateVotes": tallies, "validVotes": valid_votes,
                             "winner": ranked[0][0] if ranked and ranked[0][1] > 0 and (len(ranked) < 2 or ranked[0][1] != ranked[1][1]) else None,
                             "marginPercentagePoints": margin, "places": places})

    total = defaultdict(int)
    for zone in output_zones:
        for number, votes in zone["candidateVotes"].items():
            total[number] += votes
    payload = {"schemaVersion": 1, "municipalityCode": ibge, "candidateVotes": dict(total), "zones": output_zones}
    return payload


def load_place_names(catalog: list[dict[str, str]]) -> dict[tuple[str, str, str], str]:
    if not ELECTORATE_ZIP.is_file():
        raise FileNotFoundError(f"missing cached TSE polling-place catalog: {ELECTORATE_ZIP}")
    municipality_by_tse = {(item["uf"], str(int(item["cd"]))): item for item in catalog}
    names: dict[tuple[str, str, str], str] = {}
    with zipfile.ZipFile(ELECTORATE_ZIP) as archive:
        members = set(archive.namelist())
        for uf in sorted({item["uf"] for item in catalog}):
            member = f"eleitorado_local_votacao_2026_{uf}.csv"
            if member not in members:
                raise ValueError(f"missing TSE polling-place member {member}")
            with archive.open(member) as binary:
                source = csv.DictReader((line.decode("latin-1") for line in binary), delimiter=";")
                required = {"AA_ELEICAO", "NR_TURNO", "SG_UF", "CD_MUNICIPIO", "NR_ZONA", "NR_LOCAL_VOTACAO", "NM_LOCAL_VOTACAO"}
                if not required.issubset(source.fieldnames or []):
                    raise ValueError(f"TSE polling-place file {member} is missing required fields")
                for row in source:
                    if row["AA_ELEICAO"] != "2026" or row["NR_TURNO"] != "1":
                        continue
                    municipality_code = str(int(row["CD_MUNICIPIO"]))
                    municipality = municipality_by_tse.get((row["SG_UF"], municipality_code))
                    if municipality is None:
                        continue
                    identity = (municipality["ibge"], row["NR_ZONA"], row["NR_LOCAL_VOTACAO"])
                    name = row["NM_LOCAL_VOTACAO"].strip()
                    if name and identity not in names:
                        names[identity] = name
    return names


def apply_to_map(payload: dict, manifest: dict) -> None:
    """Attach all-candidate municipal totals to the map payload without losing other fields."""
    candidates = manifest["candidates"]
    metadata = [{"number": item["number"], "name": item["name"], "party": item["party"]} for item in candidates]
    records = manifest["municipalities"]
    missing = []
    discrepancies = []
    for municipality in payload["mun"]:
        record = records.get(municipality["ibge"])
        if record is None:
            missing.append(municipality["ibge"])
            continue
        municipality["candidatos"] = [
            {**candidate, "votes": record["candidateVotes"].get(candidate["number"], 0)}
            for candidate in metadata
        ]
        section_votes = sum(record["candidateVotes"].values())
        ea20_votes = municipality.get("votosValidosEA20", municipality["vv"])
        if ea20_votes != section_votes:
            municipality["votosValidosEA20"] = ea20_votes
            discrepancies.append({"ibge": municipality["ibge"], "ea20ValidVotes": ea20_votes,
                                  "sectionValidVotes": section_votes, "difference": section_votes - ea20_votes})
        else:
            municipality.pop("votosValidosEA20", None)
        municipality["vv"] = section_votes
        by_number = record["candidateVotes"]
        municipality["fv"] = by_number.get("22", 0)
        municipality["lv"] = by_number.get("13", 0)
        municipality["fp"] = round(100 * municipality["fv"] / section_votes, 2) if section_votes else 0
        municipality["lp"] = round(100 * municipality["lv"] / section_votes, 2) if section_votes else 0
        municipality["apuracaoDetalhe"] = record["detail"]
    if missing:
        raise ValueError(f"no nationwide section results for {len(missing)} mapped municipalities: {missing[:5]}")
    payload["candidatos"] = candidates
    payload["brasil"]["candidatos"] = candidates
    payload["votosForaMunicipios"] = manifest["outsideMunicipalityVotes"]
    payload["discrepanciasEA20"] = discrepancies
    payload["fonteApuracaoDetalhada"] = "TSE, votação por seção 2026, eleição 6257, turno 1"


def build(catalog: list[dict[str, str]] | None = None) -> dict:
    ensure_archive(SOURCE_ZIP, SOURCE_URL)
    ensure_archive(ELECTORATE_ZIP, ELECTORATE_URL)
    if not SNAPSHOT.is_file():
        raise FileNotFoundError(f"missing national TSE candidate snapshot: {SNAPSHOT}")
    if catalog is None:
        from build_map import load_catalog
        catalog = load_catalog()
    municipality_by_tse = {(item["uf"], str(int(item["cd"]))): item for item in catalog}
    snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    candidates = candidate_catalog(snapshot)
    valid_numbers = {candidate["number"] for candidate in candidates}
    source_sha = hashlib.sha256((sha256(SOURCE_ZIP) + sha256(ELECTORATE_ZIP)).encode()).hexdigest()
    snapshot_sha = sha256(SNAPSHOT)
    catalog_sha = hashlib.sha256(json.dumps(catalog, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest_path = OUTPUT / "manifest.json"
    if manifest_path.is_file():
        cached = json.loads(manifest_path.read_text(encoding="utf-8"))
        cached_assets_exist = all((OUTPUT / item["detail"]).is_file() for item in cached.get("municipalities", {}).values())
        if (cached.get("sourceSha256") == source_sha and cached.get("snapshotSha256") == snapshot_sha
                and cached.get("catalogSha256") == catalog_sha and cached_assets_exist):
            print(f"using cached national detail assets for {len(cached['municipalities'])} municipalities", flush=True)
            return cached
    valid_ufs = {item["uf"] for item in catalog}
    place_names = load_place_names(catalog)
    source_candidate_totals = {number: 0 for number in valid_numbers}
    outside_municipality_votes = {number: 0 for number in valid_numbers}

    with tempfile.TemporaryDirectory(prefix="brasil-apuracao-") as temp:
        database = sqlite3.connect(Path(temp) / "votes.sqlite")
        database.execute("PRAGMA journal_mode=OFF")
        database.execute("PRAGMA synchronous=OFF")
        database.execute("CREATE TABLE votes (ibge TEXT, zone TEXT, place TEXT, section TEXT, code TEXT, count INTEGER, PRIMARY KEY (ibge, zone, place, section, code))")
        batch: list[tuple[str, str, str, str, str, int]] = []
        with zipfile.ZipFile(SOURCE_ZIP) as archive:
            if archive.namelist().count(SOURCE_MEMBER) != 1:
                raise ValueError(f"expected exactly one TSE member {SOURCE_MEMBER}")
            with archive.open(SOURCE_MEMBER) as binary:
                source = csv.DictReader((line.decode("latin-1") for line in binary), delimiter=";")
                required = {"ANO_ELEICAO", "NR_TURNO", "CD_ELEICAO", "CD_CARGO", "SG_UF", "CD_MUNICIPIO", "NR_ZONA", "NR_LOCAL_VOTACAO", "NR_SECAO", "NR_VOTAVEL", "QT_VOTOS"}
                if not required.issubset(source.fieldnames or []):
                    raise ValueError("TSE section CSV is missing required fields")
                for row in source:
                    if (row["ANO_ELEICAO"] != "2026" or row["NR_TURNO"] != "1" or row["CD_ELEICAO"] != ELECTION or row["CD_CARGO"] != "1"):
                        continue
                    vote_code = row["NR_VOTAVEL"]
                    if vote_code not in valid_numbers and vote_code not in CANDIDATE_CODE:
                        raise ValueError(f"unknown presidential vote code {vote_code} in section source")
                    count = int(row["QT_VOTOS"])
                    if count < 0:
                        raise ValueError("TSE vote counts must be non-negative")
                    municipality_code = str(int(row["CD_MUNICIPIO"]))
                    municipality = municipality_by_tse.get((row["SG_UF"], municipality_code))
                    if vote_code in valid_numbers:
                        source_candidate_totals[vote_code] += count
                    if municipality is None:
                        if row["SG_UF"] in valid_ufs:
                            raise ValueError(f"unmapped Brazilian municipality {row['SG_UF']}/{municipality_code}")
                        if vote_code in valid_numbers:
                            outside_municipality_votes[vote_code] += count
                        continue  # Votes outside municipal boundaries are tracked separately.
                    batch.append((municipality["ibge"], row["NR_ZONA"], row["NR_LOCAL_VOTACAO"], row["NR_SECAO"], vote_code, count))
                    if len(batch) >= 100_000:
                        database.executemany("INSERT INTO votes VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ibge, zone, place, section, code) DO UPDATE SET count=count+excluded.count", batch)
                        batch.clear()
                if batch:
                    database.executemany("INSERT INTO votes VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ibge, zone, place, section, code) DO UPDATE SET count=count+excluded.count", batch)
        database.commit()

        candidate_totals = {candidate["number"]: 0 for candidate in candidates}
        for number, votes in database.execute("SELECT code, SUM(count) FROM votes WHERE code IN (%s) GROUP BY code" % ",".join("?" for _ in valid_numbers), tuple(valid_numbers)):
            candidate_totals[number] = votes
        official_totals = {candidate["number"]: candidate["nationalVotes"] for candidate in candidates}
        if source_candidate_totals != official_totals:
            raise ValueError(f"national candidate vote totals do not reconcile to TSE snapshot: {source_candidate_totals} != {official_totals}")
        if any(candidate_totals[number] + outside_municipality_votes[number] != source_candidate_totals[number] for number in valid_numbers):
            raise ValueError("municipal and outside-municipality vote totals do not reconcile to the source")

        output_directory = OUTPUT / "municipalities"
        output_directory.mkdir(parents=True, exist_ok=True)
        index: dict[str, dict] = {}
        query = database.execute("SELECT ibge, zone, place, section, code, count FROM votes ORDER BY ibge, CAST(zone AS INTEGER), CAST(place AS INTEGER), CAST(section AS INTEGER), CAST(code AS INTEGER)")
        current_ibge: str | None = None
        city_rows: list[tuple[str, str, str, str, int]] = []

        def save_city(ibge: str, rows: list[tuple[str, str, str, str, int]]) -> None:
            payload = publish_city(ibge, rows, candidates, place_names)
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            target = output_directory / f"{ibge}.json.gz"
            target.write_bytes(compressed)
            index[ibge] = {"detail": f"municipalities/{ibge}.json.gz", "validVotes": sum(payload["candidateVotes"].values()),
                           "zoneCount": len(payload["zones"]), "bytes": len(compressed), "candidateVotes": payload["candidateVotes"]}

        for ibge, zone, place, section, code, count in query:
            if current_ibge is not None and ibge != current_ibge:
                save_city(current_ibge, city_rows)
                city_rows = []
            current_ibge = ibge
            city_rows.append((zone, place, section, code, count))
        if current_ibge is not None:
            save_city(current_ibge, city_rows)
        database.close()

    manifest = {"schemaVersion": 1, "year": 2026, "round": 1, "cargo": "presidente",
                "source": [SOURCE_ZIP.name, ELECTORATE_ZIP.name], "sourceSha256": source_sha, "snapshotSha256": snapshot_sha,
                "catalogSha256": catalog_sha, "candidates": candidates, "municipalities": index,
                "outsideMunicipalityVotes": outside_municipality_votes,
                "municipalCandidateVotes": candidate_totals}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {len(index)} municipality detail assets; manifest {OUTPUT / 'manifest.json'}")
    return manifest


if __name__ == "__main__":
    national_manifest = build()
    map_path = ROOT / "public/data/map.json"
    if map_path.is_file():
        map_payload = json.loads(map_path.read_text(encoding="utf-8"))
        apply_to_map(map_payload, national_manifest)
        map_path.write_text(json.dumps(map_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"attached all-candidate totals to {map_path}", flush=True)

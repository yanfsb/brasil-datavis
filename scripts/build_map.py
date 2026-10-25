"""Build the municipality map used by the interactive frontend.

Election figures come from the TSE EA20 files. Boundaries come from the IBGE
mesh. Social indicators come from SIDRA. Partial TSE downloads are cached so
the script can resume.
"""

from __future__ import annotations

import gzip
import json
import math
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "cache"
OUT = ROOT / "public" / "data" / "map.json"
UA = {"User-Agent": "brasil-datavis-poc/0.1 (public data snapshot)", "Accept-Encoding": "identity"}
TSE = "https://resultados.tse.jus.br/oficial/ele2026/6257"
WORKERS = 12


def get_bytes(url: str, timeout: int = 90) -> bytes:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return raw


def get_json(url: str, timeout: int = 90):
    return json.loads(get_bytes(url, timeout).decode("utf-8"))


def br_number(value: str | int | float) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    if text in {"", "-", "...", ".."}:
        raise ValueError(f"missing number {value!r}")
    return float(text)


def extract_votes(payload: dict) -> dict[str, float | int]:
    flavio = lula = None
    for cargo in payload.get("carg", []):
        for group in cargo.get("agr", []):
            for party in group.get("par", []):
                for candidate in party.get("cand", []):
                    votes = int(candidate["vap"])
                    share = br_number(candidate["pvapn"])
                    if candidate["n"] == "22":
                        flavio = (votes, share)
                    elif candidate["n"] == "13":
                        lula = (votes, share)
    if flavio is None or lula is None:
        raise ValueError(f"missing presidential candidates in {payload.get('cdabr')}")
    return {
        "fv": flavio[0],
        "fp": round(flavio[1], 2),
        "lv": lula[0],
        "lp": round(lula[1], 2),
        "vv": int(payload["v"]["vv"]),
        "ap": round(br_number(payload["s"]["pstn"]), 2),
        "ab": round(br_number(payload["e"]["pan"]), 2),
    }


def fetch_place(sigla: str, code: str) -> dict[str, float | int]:
    url = f"{TSE}/dados/{sigla}/{sigla}{code}-c0001-e006257-u.json"
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            return extract_votes(get_json(url))
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in {429, 403, 500, 502, 503}:
                raise
            time.sleep(1.5 * (attempt + 1))
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"failed {sigla}{code}: {last_error}")


def load_catalog() -> list[dict[str, str]]:
    config = get_json(f"{TSE}/config/mun-e006257-cm.json")
    catalog = []
    for unit in config["abr"]:
        sigla = str(unit["cd"]).lower()
        if sigla in {"br", "zz", "ex"}:
            continue
        for city in unit.get("mu", []):
            ibge = str(city.get("cdi") or "")
            if len(ibge) != 7:
                continue
            catalog.append({"uf": sigla.upper(), "cd": str(city["cd"]), "ibge": ibge, "nome": city["nm"].title()})
    return catalog


def load_vote_cache(catalog: list[dict[str, str]]) -> dict[str, dict]:
    path = CACHE / "tse-mun.json"
    cached: dict[str, dict] = {}
    if path.exists():
        cached = json.loads(path.read_text())
    pending = [item for item in catalog if item["ibge"] not in cached]
    print(f"tse cache {len(cached)} pending {len(pending)}", flush=True)
    if not pending:
        return cached
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fetch_place, item["uf"].lower(), item["cd"]): item for item in pending}
        for future in as_completed(futures):
            item = futures[future]
            cached[item["ibge"]] = future.result()
            done += 1
            if done % 250 == 0 or done == len(pending):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(cached))
                print(f"tse {done}/{len(pending)}", flush=True)
    path.write_text(json.dumps(cached))
    return cached


def sidra_value_map(url: str) -> dict[str, float]:
    payload = get_json(url, timeout=180)
    values: dict[str, float] = {}
    for variable in payload:
        for result in variable.get("resultados", []):
            for serie in result.get("series", []):
                raw = next(iter(serie.get("serie", {}).values()), None)
                if raw in (None, "-", "...", ".."):
                    continue
                values[serie["localidade"]["id"]] = float(raw)
    print(f"sidra value {url.split('/agregados/')[1][:18]} places {len(values)}", flush=True)
    return values


def sidra_category_map(url: str) -> dict[str, dict[str, float]]:
    payload = get_json(url, timeout=180)
    grouped: dict[str, dict[str, float]] = {}
    for variable in payload:
        for result in variable.get("resultados", []):
            category = "value"
            for classification in result.get("classificacoes", []):
                if classification.get("categoria"):
                    category = next(iter(classification["categoria"]))
                    break
            for serie in result.get("series", []):
                raw = next(iter(serie.get("serie", {}).values()), None)
                if raw in (None, "-", "...", ".."):
                    continue
                grouped.setdefault(serie["localidade"]["id"], {})[category] = float(raw)
    print(f"sidra {url.split('/agregados/')[1][:12]} places {len(grouped)}", flush=True)
    return grouped


def rate(part: float, total: float) -> float | None:
    if total <= 0:
        return None
    return round(100 * part / total, 2)


def category_rate(url: str, part: str, total: str) -> dict[str, float]:
    grouped = sidra_category_map(url)
    values: dict[str, float] = {}
    for ibge, categories in grouped.items():
        if total not in categories:
            continue
        amount = rate(categories.get(part, 0), categories[total])
        if amount is not None:
            values[ibge] = amount
    return values


def extra_indicators() -> dict[str, dict[str, float]]:
    """Municipal indicators beyond the original literacy, sewage and income series."""
    water = category_rate(
        "https://servicodados.ibge.gov.br/api/v3/agregados/6803/periodos/2022/variaveis/381"
        "?localidades=N6[all]&classificacao=1821[72129,72144]",
        "72144",
        "72129",
    )
    waste = category_rate(
        "https://servicodados.ibge.gov.br/api/v3/agregados/6892/periodos/2022/variaveis/381"
        "?localidades=N6[all]&classificacao=67[10972,2520]",
        "2520",
        "10972",
    )
    internet = category_rate(
        "https://servicodados.ibge.gov.br/api/v3/agregados/9942/periodos/2022/variaveis/382"
        "?localidades=N6[all]&classificacao=2072[77584,77585]|86[95251]|58[95253]",
        "77585",
        "77584",
    )
    population = sidra_value_map(
        "https://servicodados.ibge.gov.br/api/v3/agregados/4714/periodos/2022/variaveis/93?localidades=N6[all]"
    )
    density = sidra_value_map(
        "https://servicodados.ibge.gov.br/api/v3/agregados/4714/periodos/2022/variaveis/614?localidades=N6[all]"
    )
    gdp = sidra_value_map(
        "https://servicodados.ibge.gov.br/api/v3/agregados/5938/periodos/2023/variaveis/37?localidades=N6[all]"
    )
    pib: dict[str, float] = {}
    for ibge, thousand_reais in gdp.items():
        people = population.get(ibge)
        if people and people > 0:
            pib[ibge] = round(thousand_reais * 1000 / people, 0)
    return {
        "agua": water,
        "lixo": waste,
        "internet": internet,
        "densidade": {ibge: round(value, 1) for ibge, value in density.items()},
        "pib": pib,
        "populacao": population,
    }


def mercator(lon: float, lat: float) -> tuple[float, float]:
    clamped = min(89.9, max(-89.9, lat))
    return math.radians(lon), math.log(math.tan(math.pi / 4 + math.radians(clamped) / 2))


def project_mesh(features: list[dict]) -> tuple[list[dict], tuple[float, float, float, float]]:
    projected = []
    xs: list[float] = []
    ys: list[float] = []
    for feature in features:
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        converted = []
        for polygon in polygons:
            rings = []
            for ring in polygon:
                points = [mercator(lon, lat) for lon, lat, *_rest in ring]
                xs.extend(point[0] for point in points)
                ys.extend(point[1] for point in points)
                rings.append(points)
            converted.append(rings)
        projected.append({"ibge": str(feature["properties"]["codarea"]), "polys": converted})
    return projected, (min(xs), min(ys), max(xs), max(ys))


def state_outlines(bounds: tuple[float, float, float, float]) -> list[dict]:
    mesh = get_json(
        "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR"
        "?formato=application/vnd.geo+json&qualidade=intermediaria&intrarregiao=UF",
        timeout=120,
    )
    projected, _state_bounds = project_mesh(mesh["features"])
    return [{"ibge": item["ibge"], "g": scale_rings(item["polys"], bounds)} for item in projected]


def scale_rings(polys: list, bounds: tuple[float, float, float, float]) -> list[list[list[int]]]:
    min_x, min_y, max_x, max_y = bounds
    width = 10000
    height = round(10000 * (max_y - min_y) / (max_x - min_x))
    scaled = []
    for polygon in polys:
        rings = []
        for ring in polygon:
            flat: list[int] = []
            for x, y in ring:
                flat.append(round((x - min_x) / (max_x - min_x) * width))
                flat.append(round((max_y - y) / (max_y - min_y) * height))
            rings.append(flat)
        scaled.append(rings)
    return scaled


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    catalog = load_catalog()
    by_ibge = {item["ibge"]: item for item in catalog}
    votes = load_vote_cache(catalog)
    literacy = sidra_category_map(
        "https://servicodados.ibge.gov.br/api/v3/agregados/9542/periodos/2022/variaveis/950"
        "?localidades=N6[all]&classificacao=59[93024,1024]|2[6794]|86[95251]|287[100362]"
    )
    sewage = sidra_category_map(
        "https://servicodados.ibge.gov.br/api/v3/agregados/6805/periodos/2022/variaveis/381"
        "?localidades=N6[all]&classificacao=11558[46292,46290]"
    )
    income = sidra_value_map(
        "https://servicodados.ibge.gov.br/api/v3/agregados/10295/periodos/2022/variaveis/13431"
        "?localidades=N6[all]&classificacao=2[6794]|86[95251]|58[95253]"
    )
    extras = extra_indicators()
    mesh_path = CACHE / "malha-mun.geojson"
    if mesh_path.exists():
        mesh = json.loads(mesh_path.read_text())
    else:
        mesh = get_json(
            "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR"
            "?formato=application/vnd.geo+json&qualidade=minima&intrarregiao=municipio",
            timeout=180,
        )
        mesh_path.write_text(json.dumps(mesh))
    projected, bounds = project_mesh(mesh["features"])
    municipalities = []
    missing_votes = 0
    for feature in projected:
        meta = by_ibge.get(feature["ibge"])
        vote = votes.get(feature["ibge"])
        if meta is None or vote is None:
            missing_votes += 1
            continue
        lit = literacy.get(feature["ibge"], {})
        sew = sewage.get(feature["ibge"], {})
        money = income.get(feature["ibge"])
        municipalities.append(
            {
                "ibge": feature["ibge"],
                "nome": meta["nome"],
                "uf": meta["uf"],
                "fp": vote["fp"],
                "lp": vote["lp"],
                "fv": vote["fv"],
                "lv": vote["lv"],
                "vv": vote["vv"],
                "ap": vote["ap"],
                "ab": vote["ab"],
                "analfabetismo": rate(lit.get("1024", 0), lit.get("93024", 0)) if "93024" in lit else None,
                "esgoto": rate(sew.get("46290", 0), sew.get("46292", 0)) if "46292" in sew else None,
                "renda": round(money, 0) if money is not None else None,
                "agua": extras["agua"].get(feature["ibge"]),
                "lixo": extras["lixo"].get(feature["ibge"]),
                "internet": extras["internet"].get(feature["ibge"]),
                "densidade": extras["densidade"].get(feature["ibge"]),
                "pib": extras["pib"].get(feature["ibge"]),
                "populacao": extras["populacao"].get(feature["ibge"]),
                "g": scale_rings(feature["polys"], bounds),
            }
        )
    nacional = extract_votes(get_json(f"{TSE}/dados/br/br-c0001-e006257-u.json"))
    snapshot_path = ROOT / "public" / "data" / "snapshot.json"
    uf_indicators = {}
    if snapshot_path.exists():
        previous = json.loads(snapshot_path.read_text())
        uf_indicators = {item["sigla"]: item["indicadores"] for item in previous["ufs"]}
    payload = {
        "fonte": "TSE EA20 ciclo 6257 e malha municipal IBGE",
        "width": 10000,
        "height": round(10000 * (bounds[3] - bounds[1]) / (bounds[2] - bounds[0])),
        "brasil": nacional,
        "ufIndicadores": uf_indicators,
        "mun": municipalities,
        "estados": state_outlines(bounds),
        "ausentes": missing_votes,
    }
    from mine_extra import apply_cached
    from build_national_apuracao import apply_to_map, build as build_national_apuracao
    from build_national_neighborhoods import apply_to_map as apply_neighborhoods, build as build_national_neighborhoods

    apply_cached(payload["mun"], payload["ufIndicadores"])
    apply_to_map(payload, build_national_apuracao(catalog))
    apply_neighborhoods(payload, build_national_neighborhoods(catalog, payload))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT} mun {len(municipalities)} missing {missing_votes} bytes {OUT.stat().st_size}", flush=True)


if __name__ == "__main__":
    main()

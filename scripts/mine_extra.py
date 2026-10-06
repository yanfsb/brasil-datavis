"""Add official series that the first map build did not keep.

TSE 2026 blank and null shares come from the same EA20 files already used for
the presidential tally. The 2022 comparison comes from the TSE municipal
candidate file. Age, urban population and GDP composition come from SIDRA.
"""

from __future__ import annotations

import csv
import io
import json
import sys
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_map import CACHE, OUT, TSE, br_number, get_json, load_catalog, rate

EXTRA = CACHE / "extra-indicators.json"
TSE_EXTRA = CACHE / "tse-extra.json"
ZIP_2022 = CACHE / "votacao_candidato_munzona_2022.zip"
ZIP_URL = "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_candidato_munzona/votacao_candidato_munzona_2022.zip"
AGE_60 = ("93095", "93096", "93097", "93098", "49108", "49109", "60040", "60041", "6653")
SOCIAL_FIELDS = ("urbano", "idosos", "agro", "industria")
VOTE_FIELDS = ("brancos", "nulos", "lula22", "pl22", "oscilacao", "oscilacaopl")


def category_by(url: str, classification_id: str) -> dict[str, dict[str, float]]:
    payload = get_json(url, timeout=240)
    grouped: dict[str, dict[str, float]] = {}
    for variable in payload:
        for result in variable.get("resultados", []):
            category = None
            for classification in result.get("classificacoes", []):
                if str(classification.get("id")) == classification_id and classification.get("categoria"):
                    category = next(iter(classification["categoria"]))
            if category is None:
                continue
            for serie in result.get("series", []):
                raw = next(iter(serie.get("serie", {}).values()), None)
                if raw in (None, "-", "...", ".."):
                    continue
                grouped.setdefault(serie["localidade"]["id"], {})[category] = float(raw)
    print(f"sidra class {classification_id} places {len(grouped)}", flush=True)
    return grouped


def value_map(url: str) -> dict[str, float]:
    payload = get_json(url, timeout=240)
    values: dict[str, float] = {}
    for variable in payload:
        for result in variable.get("resultados", []):
            for serie in result.get("series", []):
                raw = next(iter(serie.get("serie", {}).values()), None)
                if raw in (None, "-", "...", ".."):
                    continue
                values[serie["localidade"]["id"]] = float(raw)
    print(f"sidra value places {len(values)}", flush=True)
    return values


def participation_id(needle: str) -> str:
    meta = get_json("https://servicodados.ibge.gov.br/api/v3/agregados/5938/metadados")
    for item in meta["variaveis"]:
        name = item["nome"].lower()
        if needle not in name:
            continue
        if "no valor adicionado bruto a preços correntes total" not in name:
            continue
        if "microrregião" in name or "mesorregião" in name or "unidade da federação" in name:
            continue
        return str(item["id"])
    raise RuntimeError(f"missing PIB participation variable for {needle}")


def age_60() -> dict[str, float]:
    """Sum 60+ shares. SIDRA omits a zero cell, so a missing older group is zero."""
    totals: dict[str, float] = {}
    base: set[str] = set()
    for code in AGE_60:
        grouped = category_by(
            "https://servicodados.ibge.gov.br/api/v3/agregados/9514/periodos/2022/variaveis/1000093"
            f"?localidades=N6[all]&classificacao=2[6794]|287[{code}]|286[113635]",
            "287",
        )
        for ibge, categories in grouped.items():
            if code not in categories:
                continue
            totals[ibge] = totals.get(ibge, 0) + categories[code]
            if code == AGE_60[0]:
                base.add(ibge)
    return {ibge: round(totals.get(ibge, 0), 2) for ibge in base}


def sidra_series() -> dict[str, dict[str, float]]:
    urban = category_by(
        "https://servicodados.ibge.gov.br/api/v3/agregados/9923/periodos/2022/variaveis/93"
        "?localidades=N6[all]&classificacao=1[6795,1]",
        "1",
    )
    agro_id = participation_id("agropecuária")
    industry_id = participation_id("indústria")
    agro = value_map(
        f"https://servicodados.ibge.gov.br/api/v3/agregados/5938/periodos/2021/variaveis/{agro_id}?localidades=N6[all]"
    )
    industry = value_map(
        f"https://servicodados.ibge.gov.br/api/v3/agregados/5938/periodos/2021/variaveis/{industry_id}?localidades=N6[all]"
    )
    urbano: dict[str, float] = {}
    for ibge, categories in urban.items():
        amount = rate(categories.get("1", 0), categories.get("6795", 0)) if "6795" in categories else None
        if amount is not None:
            urbano[ibge] = amount
    return {
        "urbano": urbano,
        "idosos": age_60(),
        "agro": {ibge: round(value, 2) for ibge, value in agro.items()},
        "industria": {ibge: round(value, 2) for ibge, value in industry.items()},
    }


def fetch_extra(sigla: str, code: str) -> dict[str, float]:
    url = f"{TSE}/dados/{sigla}/{sigla}{code}-c0001-e006257-u.json"
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            payload = get_json(url)
            return {
                "brancos": round(br_number(payload["v"]["pvbn"]), 2),
                "nulos": round(br_number(payload["v"]["ptvnn"]), 2),
            }
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"failed extra {sigla}{code}: {last_error}")


def tse_extra(catalog: list[dict[str, str]]) -> dict[str, dict[str, float]]:
    cached: dict[str, dict[str, float]] = {}
    if TSE_EXTRA.exists():
        cached = json.loads(TSE_EXTRA.read_text())
    pending = [item for item in catalog if item["ibge"] not in cached]
    print(f"tse extra cache {len(cached)} pending {len(pending)}", flush=True)
    if not pending:
        return cached
    done = 0
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(fetch_extra, item["uf"].lower(), item["cd"]): item for item in pending}
        for future in as_completed(futures):
            item = futures[future]
            cached[item["ibge"]] = future.result()
            done += 1
            if done % 250 == 0 or done == len(pending):
                TSE_EXTRA.parent.mkdir(parents=True, exist_ok=True)
                TSE_EXTRA.write_text(json.dumps(cached))
                print(f"tse extra {done}/{len(pending)}", flush=True)
    TSE_EXTRA.write_text(json.dumps(cached))
    return cached


def download_2022() -> None:
    if ZIP_2022.exists() and ZIP_2022.stat().st_size > 600_000_000:
        print(f"2022 zip cached {ZIP_2022.stat().st_size}", flush=True)
        return
    print("downloading 2022 municipal results", flush=True)
    ZIP_2022.parent.mkdir(parents=True, exist_ok=True)
    partial = ZIP_2022.with_suffix(".partial")
    request = urllib.request.Request(ZIP_URL, headers={"User-Agent": "brasil-datavis-poc/0.1"})
    with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as handle:
        total = int(response.headers.get("Content-Length") or 0)
        written = 0
        while True:
            chunk = response.read(1_048_576)
            if not chunk:
                break
            handle.write(chunk)
            written += len(chunk)
            if total and written % (40 * 1_048_576) < 1_048_576:
                print(f"2022 zip {written / 1_048_576:.0f}/{total / 1_048_576:.0f} MB", flush=True)
    partial.replace(ZIP_2022)


def read_2022(catalog: list[dict[str, str]]) -> tuple[dict[str, float], dict[str, float]]:
    download_2022()
    by_code = {item["cd"].zfill(5): item["ibge"] for item in catalog}
    names = []
    with zipfile.ZipFile(ZIP_2022) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        national = [name for name in names if name.upper().endswith("_BRASIL.CSV")]
        chosen = national or names
        print(f"2022 csv files {len(names)} using {len(chosen)}", flush=True)
        votes: dict[str, dict[str, int]] = {}
        header: list[str] | None = None
        for name in chosen:
            with archive.open(name) as raw:
                text = io.TextIOWrapper(raw, encoding="latin-1", newline="")
                reader = csv.DictReader(text, delimiter=";")
                if header is None:
                    header = reader.fieldnames or []
                    print("2022 header", header[:12], flush=True)
                for row in reader:
                    if row.get("NR_TURNO") != "1" or row.get("CD_CARGO") not in {"1", "01"}:
                        continue
                    code = str(row.get("CD_MUNICIPIO") or "").zfill(5)
                    ibge = by_code.get(code)
                    if ibge is None:
                        continue
                    quantity = int(row.get("QT_VOTOS_NOMINAIS") or 0)
                    bucket = votes.setdefault(ibge, {"13": 0, "22": 0, "total": 0})
                    bucket["total"] += quantity
                    number = row.get("NR_CANDIDATO")
                    if number in {"13", "22"}:
                        bucket[number] += quantity
    lula: dict[str, float] = {}
    pl: dict[str, float] = {}
    for ibge, bucket in votes.items():
        if bucket["total"] <= 0:
            continue
        lula[ibge] = round(100 * bucket["13"] / bucket["total"], 2)
        pl[ibge] = round(100 * bucket["22"] / bucket["total"], 2)
    print(f"2022 municipalities {len(lula)}", flush=True)
    if len(lula) < 5000:
        raise RuntimeError(f"2022 coverage too small: {len(lula)}")
    return lula, pl


def save_extra(payload: dict[str, dict[str, float]]) -> None:
    EXTRA.parent.mkdir(parents=True, exist_ok=True)
    EXTRA.write_text(json.dumps(payload))


def ready(payload: dict[str, dict[str, float]], field: str) -> bool:
    return field in payload and len(payload[field]) > 5000


def load_or_build(catalog: list[dict[str, str]]) -> dict[str, dict[str, float]]:
    payload: dict[str, dict[str, float]] = json.loads(EXTRA.read_text()) if EXTRA.exists() else {}
    if not ready(payload, "brancos") or not ready(payload, "nulos"):
        blanks = tse_extra(catalog)
        payload["brancos"] = {ibge: item["brancos"] for ibge, item in blanks.items()}
        payload["nulos"] = {ibge: item["nulos"] for ibge, item in blanks.items()}
        save_extra(payload)
    if not all(ready(payload, field) for field in ("urbano", "agro", "industria")):
        payload.update(sidra_series())
        save_extra(payload)
    if not ready(payload, "idosos"):
        payload["idosos"] = age_60()
        save_extra(payload)
    if not ready(payload, "lula22") or not ready(payload, "pl22"):
        lula22, pl22 = read_2022(catalog)
        payload["lula22"] = lula22
        payload["pl22"] = pl22
        save_extra(payload)
    return payload


def weighted_mean(rows: list[dict], field: str, weight: str) -> float | None:
    numerator = 0.0
    denominator = 0.0
    for row in rows:
        value = row.get(field)
        mass = row.get(weight) or 0
        if not isinstance(value, (int, float)) or mass <= 0:
            continue
        numerator += value * mass
        denominator += mass
    if denominator <= 0:
        return None
    return round(numerator / denominator, 2)


def apply_series(municipalities: list[dict], uf_indicators: dict, series: dict[str, dict[str, float]]) -> None:
    for municipality in municipalities:
        ibge = municipality["ibge"]
        for field, values in series.items():
            if ibge in values:
                municipality[field] = values[ibge]
        if isinstance(municipality.get("lula22"), (int, float)):
            municipality["oscilacao"] = round(municipality["lp"] - municipality["lula22"], 2)
        if isinstance(municipality.get("pl22"), (int, float)):
            municipality["oscilacaopl"] = round(municipality["fp"] - municipality["pl22"], 2)
    grouped: dict[str, list[dict]] = {}
    for municipality in municipalities:
        grouped.setdefault(municipality["uf"], []).append(municipality)
    for uf, rows in grouped.items():
        target = uf_indicators.setdefault(uf, {})
        for field in (*SOCIAL_FIELDS, *VOTE_FIELDS):
            weight = "vv" if field in VOTE_FIELDS else "populacao"
            value = weighted_mean(rows, field, weight)
            if value is not None:
                target[field] = value


def apply_cached(municipalities: list[dict], uf_indicators: dict) -> None:
    if not EXTRA.exists():
        return
    apply_series(municipalities, uf_indicators, json.loads(EXTRA.read_text()))


def main() -> None:
    catalog = load_catalog()
    series = load_or_build(catalog)
    payload = json.loads(OUT.read_text())
    apply_series(payload["mun"], payload.setdefault("ufIndicadores", {}), series)
    national = get_json(f"{TSE}/dados/br/br-c0001-e006257-u.json")
    payload["brasil"]["brancos"] = round(br_number(national["v"]["pvbn"]), 2)
    payload["brasil"]["nulos"] = round(br_number(national["v"]["ptvnn"]), 2)
    payload["fonte"] = "TSE EA20 2026, votação municipal 2022 e SIDRA/Censo"
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sample = payload["mun"][0]
    print(
        "patched",
        OUT,
        "brancos",
        sample.get("brancos"),
        "idosos",
        sample.get("idosos"),
        "lula22",
        sample.get("lula22"),
        "bytes",
        OUT.stat().st_size,
        flush=True,
    )


if __name__ == "__main__":
    main()

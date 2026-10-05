"""Build a local snapshot of the 2026 first round and social indicators.

Sources are the TSE results CDN and IBGE SIDRA. The browser app reads the
snapshot so it does not depend on those APIs or on their CORS policy.
"""

from __future__ import annotations

import gzip
import json
import math
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "data"
UA = {"User-Agent": "brasil-datavis-poc/0.1 (public data snapshot)", "Accept-Encoding": "identity"}

UFS = {
    "11": ("RO", "Rondônia", "Norte"),
    "12": ("AC", "Acre", "Norte"),
    "13": ("AM", "Amazonas", "Norte"),
    "14": ("RR", "Roraima", "Norte"),
    "15": ("PA", "Pará", "Norte"),
    "16": ("AP", "Amapá", "Norte"),
    "17": ("TO", "Tocantins", "Norte"),
    "21": ("MA", "Maranhão", "Nordeste"),
    "22": ("PI", "Piauí", "Nordeste"),
    "23": ("CE", "Ceará", "Nordeste"),
    "24": ("RN", "Rio Grande do Norte", "Nordeste"),
    "25": ("PB", "Paraíba", "Nordeste"),
    "26": ("PE", "Pernambuco", "Nordeste"),
    "27": ("AL", "Alagoas", "Nordeste"),
    "28": ("SE", "Sergipe", "Nordeste"),
    "29": ("BA", "Bahia", "Nordeste"),
    "31": ("MG", "Minas Gerais", "Sudeste"),
    "32": ("ES", "Espírito Santo", "Sudeste"),
    "33": ("RJ", "Rio de Janeiro", "Sudeste"),
    "35": ("SP", "São Paulo", "Sudeste"),
    "41": ("PR", "Paraná", "Sul"),
    "42": ("SC", "Santa Catarina", "Sul"),
    "43": ("RS", "Rio Grande do Sul", "Sul"),
    "50": ("MS", "Mato Grosso do Sul", "Centro-Oeste"),
    "51": ("MT", "Mato Grosso", "Centro-Oeste"),
    "52": ("GO", "Goiás", "Centro-Oeste"),
    "53": ("DF", "Distrito Federal", "Centro-Oeste"),
}

TSE_ELECTION = "006257"
TSE_CYCLE = "6257"
FLAVIO_NUMBER = "22"
LULA_NUMBER = "13"


def get_json(url: str) -> dict | list:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=90) as response:
        raw = response.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def number(value: str | int | float | None) -> float:
    if value is None:
        raise ValueError("missing numeric value")
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(".", "").replace(",", ".") if "," in str(value) else str(value).strip()
    if text in {"", "-", "...", ".."}:
        raise ValueError(f"unavailable SIDRA value: {value!r}")
    return float(text)


def sidra_rows(url: str) -> list[dict[str, str]]:
    payload = get_json(url)
    if not isinstance(payload, list) or len(payload) < 2:
        raise RuntimeError(f"unexpected SIDRA payload from {url}")
    return payload[1:]


def sidra_map(url: str, category_field: str | None = None) -> dict[str, dict[str, float]]:
    """Map IBGE UF code -> classification code -> value."""
    grouped: dict[str, dict[str, float]] = {}
    for row in sidra_rows(url):
        uf = row["D1C"]
        key = row[category_field] if category_field else "value"
        grouped.setdefault(uf, {})[key] = number(row["V"])
    return grouped


def tse_url(sigla: str) -> str:
    code = sigla.lower()
    return (
        "https://resultados.tse.jus.br/oficial/ele2026/"
        f"{TSE_CYCLE}/dados/{code}/{code}-c0001-e{TSE_ELECTION}-u.json"
    )


def candidates(payload: dict) -> list[dict]:
    found: list[dict] = []
    for cargo in payload.get("carg", []):
        for group in cargo.get("agr", []):
            for party in group.get("par", []):
                for candidate in party.get("cand", []):
                    found.append(
                        {
                            "numero": candidate["n"],
                            "nome": candidate["nmu"].title() if candidate["nmu"].isupper() else candidate["nmu"],
                            "nomeUrna": candidate["nmu"],
                            "partido": party["sg"],
                            "votos": int(candidate["vap"]),
                            "percentual": number(candidate["pvapn"]),
                        }
                    )
    return sorted(found, key=lambda item: item["votos"], reverse=True)


def election_slice(payload: dict) -> dict:
    people = payload["e"]
    votes = payload["v"]
    sections = payload["s"]
    ranked = candidates(payload)
    by_number = {item["numero"]: item for item in ranked}
    flavio = by_number[FLAVIO_NUMBER]
    lula = by_number[LULA_NUMBER]
    return {
        "atualizadoEm": f"{payload.get('dt', '')} {payload.get('ht', '')}".strip(),
        "secoesTotalizadas": number(sections["pstn"]),
        "eleitorado": int(people["te"]),
        "comparecimento": int(people["c"]),
        "abstencao": number(people["pan"]),
        "validos": int(votes["vv"]),
        "brancos": number(votes["pvbn"]),
        "nulos": number(votes["ptvnn"]),
        "flavio": flavio,
        "lula": lula,
        "margem": round(flavio["percentual"] - lula["percentual"], 4),
        "lider": "flavio" if flavio["votos"] > lula["votos"] else "lula" if lula["votos"] > flavio["votos"] else "empate",
        "candidatos": ranked,
    }


def rate(part: float, total: float) -> float:
    if total == 0:
        raise ValueError("cannot divide by zero")
    return round(100 * part / total, 4)


def project_feature(feature: dict, width: float, height: float, bounds: tuple[float, float, float, float]) -> str:
    min_x, min_y, max_x, max_y = bounds
    pad = 18

    def xy(lon: float, lat: float) -> tuple[float, float]:
        merc_x = math.radians(lon)
        clamped = min(89.9, max(-89.9, lat))
        merc_y = math.log(math.tan(math.pi / 4 + math.radians(clamped) / 2))
        x = pad + (merc_x - min_x) / (max_x - min_x) * (width - pad * 2)
        y = pad + (max_y - merc_y) / (max_y - min_y) * (height - pad * 2)
        return round(x, 2), round(y, 2)

    def ring(points: list[list[float]]) -> str:
        if len(points) < 3:
            return ""
        head, *tail = points
        commands = [f"M{xy(head[0], head[1])[0]} {xy(head[0], head[1])[1]}"]
        for lon, lat, *_rest in tail:
            x, y = xy(lon, lat)
            commands.append(f"L{x} {y}")
        commands.append("Z")
        return "".join(commands)

    geometry = feature["geometry"]
    polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    return "".join(ring(ring_points) for polygon in polygons for ring_points in polygon)


def mercator_bounds(features: list[dict]) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []

    def visit(points: list[list[float]]) -> None:
        for lon, lat, *_rest in points:
            xs.append(math.radians(lon))
            clamped = min(89.9, max(-89.9, lat))
            ys.append(math.log(math.tan(math.pi / 4 + math.radians(clamped) / 2)))

    for feature in features:
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        for polygon in polygons:
            for ring in polygon:
                visit(ring)
    return min(xs), min(ys), max(xs), max(ys)


def build_map() -> list[dict]:
    url = (
        "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR"
        "?formato=application/vnd.geo+json&qualidade=intermediaria&intrarregiao=UF"
    )
    geojson = get_json(url)
    if not isinstance(geojson, dict):
        raise RuntimeError("IBGE mesh was not an object")
    features = geojson["features"]
    bounds = mercator_bounds(features)
    paths = []
    for feature in features:
        code = str(feature["properties"].get("codarea") or feature["properties"].get("codarea")).zfill(2)
        if code not in UFS:
            continue
        sigla, nome, regiao = UFS[code]
        paths.append(
            {
                "ibge": code,
                "sigla": sigla,
                "nome": nome,
                "regiao": regiao,
                "d": project_feature(feature, 820, 780, bounds),
            }
        )
    if len(paths) != 27:
        raise RuntimeError(f"expected 27 state paths, got {len(paths)}")
    return paths


def main() -> None:
    literacy = sidra_map(
        "https://apisidra.ibge.gov.br/values/t/9542/n3/all/n1/1/v/950/p/2022"
        "/c59/93024,1024/c2/6794/c86/95251/c287/100362",
        "D4C",
    )
    sewage = sidra_map(
        "https://apisidra.ibge.gov.br/values/t/6805/n3/all/n1/1/v/381/p/2022/c11558/46292,46290",
        "D4C",
    )
    water = sidra_map(
        "https://apisidra.ibge.gov.br/values/t/6803/n3/all/n1/1/v/381/p/2022/c1821/72129,72144",
        "D4C",
    )
    waste = sidra_map(
        "https://apisidra.ibge.gov.br/values/t/6892/n3/all/n1/1/v/381/p/2022/c67/10972,2520",
        "D4C",
    )
    internet = sidra_map(
        "https://apisidra.ibge.gov.br/values/t/9942/n3/all/n1/1/v/382/p/2022"
        "/c2072/77584,77585/c86/95251/c58/95253",
        "D4C",
    )
    income_rows = sidra_rows(
        "https://apisidra.ibge.gov.br/values/t/7395/n3/all/n1/1/v/4196/p/last"
    )
    gini_rows = sidra_rows(
        "https://apisidra.ibge.gov.br/values/t/7435/n3/all/n1/1/v/10681/p/last"
    )
    unemployment_rows = sidra_rows(
        "https://apisidra.ibge.gov.br/values/t/4099/n3/all/n1/1/v/4099/p/last"
    )
    population = sidra_map(
        "https://apisidra.ibge.gov.br/values/t/4709/n3/all/n1/1/v/93/p/2022"
    )

    def single(rows: list[dict[str, str]]) -> tuple[dict[str, float], str]:
        values = {row["D1C"]: number(row["V"]) for row in rows}
        period = rows[0]["D3N"]
        if any(row["D3N"] != period for row in rows):
            raise RuntimeError("SIDRA returned mixed periods")
        return values, period

    income, income_period = single(income_rows)
    gini, gini_period = single(gini_rows)
    unemployment, unemployment_period = single(unemployment_rows)

    brasil = election_slice(get_json(tse_url("br")))
    states = []
    for ibge, (sigla, nome, regiao) in UFS.items():
        election = election_slice(get_json(tse_url(sigla)))
        states.append(
            {
                "ibge": ibge,
                "sigla": sigla,
                "nome": nome,
                "regiao": regiao,
                "populacao": int(population[ibge]["value"]),
                **election,
                "indicadores": {
                    "analfabetismo": rate(literacy[ibge]["1024"], literacy[ibge]["93024"]),
                    "esgoto": rate(sewage[ibge]["46290"], sewage[ibge]["46292"]),
                    "agua": rate(water[ibge]["72144"], water[ibge]["72129"]),
                    "lixo": rate(waste[ibge]["2520"], waste[ibge]["10972"]),
                    "internet": rate(internet[ibge]["77585"], internet[ibge]["77584"]),
                    "renda": round(income[ibge], 2),
                    "gini": round(gini[ibge], 4),
                    "desocupacao": round(unemployment[ibge], 2),
                },
            }
        )

    brazil_code = "1"
    snapshot = {
        "geradoPara": "POC local. Não é divulgação oficial nem pesquisa eleitoral.",
        "turno": 1,
        "eleicao": {
            "ciclo": TSE_CYCLE,
            "data": "2026-10-04",
            "cargo": "Presidente",
            "fonte": "TSE, arquivos EA20 de resultado unificado",
            "url": tse_url("br"),
        },
        "brasil": {
            **brasil,
            "populacao": int(population[brazil_code]["value"]),
            "indicadores": {
                "analfabetismo": rate(literacy[brazil_code]["1024"], literacy[brazil_code]["93024"]),
                "esgoto": rate(sewage[brazil_code]["46290"], sewage[brazil_code]["46292"]),
                "agua": rate(water[brazil_code]["72144"], water[brazil_code]["72129"]),
                "lixo": rate(waste[brazil_code]["2520"], waste[brazil_code]["10972"]),
                "internet": rate(internet[brazil_code]["77585"], internet[brazil_code]["77584"]),
                "renda": round(income[brazil_code], 2),
                "gini": round(gini[brazil_code], 4),
                "desocupacao": round(unemployment[brazil_code], 2),
            },
        },
        "ufs": states,
        "mapa": build_map(),
        "indicadores": [
            {
                "id": "analfabetismo",
                "nome": "Analfabetismo",
                "descricao": "Pessoas de 15 anos ou mais não alfabetizadas",
                "unidade": "%",
                "sentido": "maior é pior",
                "fonte": "IBGE, Censo Demográfico 2022, tabela 9542",
                "ano": "2022",
            },
            {
                "id": "esgoto",
                "nome": "Esgoto coletado",
                "descricao": "Domicílios com rede geral, rede pluvial ou fossa ligada à rede",
                "unidade": "%",
                "sentido": "maior é melhor",
                "fonte": "IBGE, Censo Demográfico 2022, tabela 6805",
                "ano": "2022",
            },
            {
                "id": "agua",
                "nome": "Água da rede",
                "descricao": "Domicílios ligados à rede geral e que a usam como forma principal",
                "unidade": "%",
                "sentido": "maior é melhor",
                "fonte": "IBGE, Censo Demográfico 2022, tabela 6803",
                "ano": "2022",
            },
            {
                "id": "lixo",
                "nome": "Lixo coletado",
                "descricao": "Domicílios com lixo coletado no domicílio ou em caçamba de serviço de limpeza",
                "unidade": "%",
                "sentido": "maior é melhor",
                "fonte": "IBGE, Censo Demográfico 2022, tabela 6892",
                "ano": "2022",
            },
            {
                "id": "internet",
                "nome": "Internet no domicílio",
                "descricao": "Moradores em domicílios com conexão à internet",
                "unidade": "%",
                "sentido": "maior é melhor",
                "fonte": "IBGE, Censo Demográfico 2022, tabela 9942",
                "ano": "2022",
            },
            {
                "id": "renda",
                "nome": "Renda per capita",
                "descricao": "Rendimento médio mensal real domiciliar per capita",
                "unidade": "R$",
                "sentido": "maior é melhor",
                "fonte": "IBGE, PNAD Contínua anual, tabela 7395",
                "ano": income_period,
            },
            {
                "id": "gini",
                "nome": "Desigualdade",
                "descricao": "Índice de Gini do rendimento domiciliar per capita",
                "unidade": "índice",
                "sentido": "maior é pior",
                "fonte": "IBGE, PNAD Contínua anual, tabela 7435",
                "ano": gini_period,
            },
            {
                "id": "desocupacao",
                "nome": "Desocupação",
                "descricao": "Taxa de desocupação das pessoas de 14 anos ou mais",
                "unidade": "%",
                "sentido": "maior é pior",
                "fonte": "IBGE, PNAD Contínua trimestral, tabela 4099",
                "ano": unemployment_period,
            },
        ],
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / "snapshot.json"
    target.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {target} ({target.stat().st_size} bytes)")
    print(
        "Brasil",
        brasil["flavio"]["percentual"],
        brasil["lula"]["percentual"],
        "ufs",
        len(states),
        "renda",
        income_period,
        "gini",
        gini_period,
        "desocupacao",
        unemployment_period,
    )


if __name__ == "__main__":
    main()

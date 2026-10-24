"""Plan one UF section tile. This scaffold does not download TSE files.

F1 will read votacao_secao for the UF, filter the nationwide
detalhe_votacao_secao and eleitorado_local_votacao archives down to that UF,
join section to NR_LOCAL_VOTACAO, and write public/data/sections/{UF}.json.

Usage:
  python3 scripts/build_sections.py --uf BA --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys

YEAR = 2026
ROUND = 1
OFFICE = "president"
OFFICE_CODE = "1"

UFS = (
    "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO",
    "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR",
    "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
)

RESULTS_CATALOG = f"https://dadosabertos.tse.jus.br/dataset/resultados-{YEAR}"
ELECTORATE_CATALOG = f"https://dadosabertos.tse.jus.br/dataset/eleitorado-{YEAR}"


def source_urls(uf: str) -> dict[str, str]:
    return {
        "votacao_secao": (
            "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/"
            f"votacao_secao_{YEAR}_{uf}.zip"
        ),
        "detalhe_votacao_secao": (
            "https://cdn.tse.jus.br/estatistica/sead/odsele/detalhe_votacao_secao/"
            f"detalhe_votacao_secao_{YEAR}.zip"
        ),
        "eleitorado_local_votacao": (
            "https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/"
            f"eleitorado_local_votacao_{YEAR}.zip"
        ),
    }


def output_path(uf: str) -> str:
    return f"public/data/sections/{uf}.json"


def illustrative_tile(uf: str) -> dict:
    """Shape of a tile. Numbers are placeholders, not an election result."""
    return {
        "uf": uf,
        "election": {
            "year": YEAR,
            "round": ROUND,
            "office": OFFICE,
            "officeCode": OFFICE_CODE,
        },
        "places": [
            {
                "placeId": "1000",
                "municipalityCode": "00000",
                "municipalityName": "Exemplo",
                "zone": "1",
                "name": "Escola Exemplo",
                "neighborhoodLabel": "Centro",
                "neighborhoodKey": "CENTRO",
                "latitude": None,
                "longitude": None,
                "sectionCount": 0,
                "electorate": 0,
                "tallies": [
                    {"candidateNumber": "13", "votes": 0},
                    {"candidateNumber": "22", "votes": 0},
                ],
            }
        ],
        "neighborhoods": [
            {
                "municipalityCode": "00000",
                "neighborhoodKey": "CENTRO",
                "label": "Centro",
                "placeCount": 0,
                "sectionCount": 0,
                "electorate": 0,
                "tallies": [
                    {"candidateNumber": "13", "votes": 0},
                    {"candidateNumber": "22", "votes": 0},
                ],
            }
        ],
    }


def print_plan(uf: str) -> None:
    print(f"section tile {uf}")
    print(f"output: {output_path(uf)}")
    print("license: Creative Commons Attribution")
    print(f"catalog: {RESULTS_CATALOG}")
    print(f"catalog: {ELECTORATE_CATALOG}")
    print("join: SG_UF + CD_MUNICIPIO + NR_ZONA + NR_SECAO -> NR_LOCAL_VOTACAO")
    print("neighborhood: DS_BAIRRO, free text, aggregated inside the municipality")
    print("sources:")
    for name, url in source_urls(uf).items():
        print(f"  {name}: {url}")
    print("schema:")
    print(json.dumps(illustrative_tile(uf), ensure_ascii=False, indent=2))
    print("dry-run: no file written and no TSE archive downloaded")


def build_tile(uf: str) -> None:
    # TODO F1: stream votacao_secao for this UF, filter the nationwide
    # detalhe_votacao_secao and eleitorado_local_votacao ZIPs, join on
    # NR_LOCAL_VOTACAO, and write output_path(uf). Do not download those
    # multi-GB archives in the F0 scaffold.
    raise NotImplementedError(
        f"section tile download is not implemented; run with --dry-run (uf {uf})"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--uf", required=True, help="state code, for example BA")
    parser.add_argument("--dry-run", action="store_true", help="print the tile schema and source URLs, then exit")
    args = parser.parse_args(argv)
    uf = args.uf.strip().upper()
    if uf not in UFS:
        parser.error(f"unknown UF {args.uf!r}; expected one of {', '.join(UFS)}")
    if args.dry_run:
        print_plan(uf)
        return 0
    build_tile(uf)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except NotImplementedError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error

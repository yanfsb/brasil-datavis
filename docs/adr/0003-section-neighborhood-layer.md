# ADR 0003: Section and neighborhood layer

## Status

Accepted as a scaffold. The download, the join, and drawing points are F1.

## Problem

The map draws municipalities (about 5,570) and a UF snapshot. The official count also exists per electoral section, about 470–500 thousand of them, and per polling place, about 94 thousand. One browser payload with every section is too large.

Neighborhood is the free-text field `DS_BAIRRO` on the polling place. It is not an IBGE polygon, so it cannot be a choropleth of official boundaries. The same name ("Centro") occurs in many municipalities.

## Decision

The municipal map stays the default. Locais is a drill-down that loads one UF at a time from `/data/sections/{UF}.json`.

Each tile carries:

- election metadata for the partition in force: year 2026, round 1, office president (TSE cargo code 1)
- polling places as points, with coordinates, the original neighborhood label, the normalized key, electorate, and candidate tallies rolled up from the sections at that place
- neighborhood aggregates keyed by municipality plus normalized `DS_BAIRRO`

Raw section rows stay in the build. The browser file does not list them. Overseas voters (`ZZ`) are not a tile. Another year, round, or office would be another directory, not a second cargo mixed into this file.

The Locais control is present and disabled until those tiles exist.

## Consequences

- Opening a state downloads that state, not the country. A large UF is still places and neighborhoods, not every section row.
- Neighborhood names are grouped only inside a municipality. Spelling variants that differ by case or spacing share a key. Accents stay, so "São João" and "SAO JOAO" do not merge. The original label remains for display.
- Places without coordinates keep null latitude and longitude. F1 decides how to draw them.
- `detalhe_votacao_secao` and `eleitorado_local_votacao` are nationwide ZIPs. The builder filters them to one UF and does not commit the archives.
- Tiles are plain JSON. Gzip is a later choice if one UF file is too heavy, not part of this scaffold.
- No neighborhood polygons.

## Sources

License: Creative Commons Attribution.

Catalogs:

- https://dadosabertos.tse.jus.br/dataset/resultados-2026
- https://dadosabertos.tse.jus.br/dataset/eleitorado-2026

Files (replace `{UF}` with the state code):

- Section votes, one ZIP per UF: https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_{UF}.zip
- Section detail, nationwide: https://cdn.tse.jus.br/estatistica/sead/odsele/detalhe_votacao_secao/detalhe_votacao_secao_2026.zip
- Electorate by polling place, nationwide, including `DS_BAIRRO` and `NR_LOCAL_VOTACAO`: https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip

Join the section key `SG_UF`, `CD_MUNICIPIO`, `NR_ZONA`, `NR_SECAO` to `NR_LOCAL_VOTACAO` on the electorate file. Candidate votes come from `votacao_secao` for cargo 1, round 1. Turnout comes from `detalhe_votacao_secao`.

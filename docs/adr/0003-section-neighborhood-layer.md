# ADR 0003: Section and neighborhood layer

## Status

Accepted for nationwide detail by municipality, electoral zone, polling place, and section. Neighborhood maps use official IBGE polygons where available and a strictly disclosed EPSG:4674 coordinate assumption; the coordinate reference still requires confirmation from TSE.

## Problem

The map draws municipalities (about 5,570) and a UF snapshot. The official count also exists per electoral section, about 470–500 thousand of them, and per polling place, about 94 thousand. One browser payload with every section is too large.

The TSE `NM_BAIRRO` is the cadastro label for a polling place, not a voter's residence and not a polygon. The official IBGE 2022 neighborhood mesh contains polygons for 895 municipalities. A nationwide spatial audit joins TSE polling-place coordinates to those polygons; only locations covered unambiguously by one official neighborhood contribute to a neighborhood result. All 895 official polygon layers are selectable; 32 with no assigned polling places show boundaries only and an explicit no-neighborhood-results notice. Unassigned votes remain visible outside the map.

## Decision

The municipal map stays the default and preserves its state when a neighborhood view opens. The neighborhood layers are partitioned by municipality and election. They contain official IBGE polygons and results aggregated from polling places whose TSE coordinates fall unambiguously inside exactly one polygon. The geometry is keyed by IBGE `CD_BAIRRO`; TSE `NM_BAIRRO` is retained only as address provenance and is never used as a substitute for spatial assignment. The TSE coordinate catalogue provides longitude and latitude but no datum/CRS declaration, so locations are provisionally interpreted as EPSG:4674 and the UI states this assumption.

For every Brazilian municipality, the nationwide presidential section file is grouped into a compact, gzip-compressed municipal asset. The UI loads that asset only after a municipality is selected and its detail button is opened; the view drills from zones to polling places and sections, ranking every valid candidate. TSE-to-IBGE mapping uses the official municipal catalog. Candidate totals are reconciled against the national TSE snapshot; votes without a Brazilian municipality (including overseas records) are tracked separately and are not assigned to a city. Neighborhood summary packages are generated for all 895 municipalities represented in the official IBGE neighborhood mesh. Of these, 863 have at least one uniquely assigned result location; 32 expose boundary-only views and direct users to the zone/place/section results.

The data partition is 2026, first round, president (`CD_ELEICAO=6257`, `CD_CARGO=1`, `NR_TURNO=1`). Municipal details exclude votes without a Brazilian municipality; the national overview retains the TSE national totals, which include overseas voters. Other elections require separate partitions.

"Disputa" shows the winning candidate and margin over valid votes. "Concentração" shows a candidate-weighted density at polling-place coordinates; it describes votes recorded at those places, never residents' preferences. Sections have no invented territorial polygons.

Publication is blocked until geometry, joins, and vote totals pass the documented audit and reconcile. Missing or ambiguous coordinates are reported separately, never silently assigned.

## Consequences

- The national overview downloads compact municipal geometries and all-candidate totals. Detailed section votes are split into per-municipality gzip assets and fetched only after the user selects that municipality and opens its detail view.
- Geographic assignment uses original IBGE polygons before any display simplification. Border, outside, invalid, or missing coordinates remain unassigned with an explicit reason.
- Results by neighborhood mean votes at polling places located within the boundary, not votes by neighborhood residents.
- TSE `NM_BAIRRO` and IBGE `NM_BAIRRO` may differ; retain both as separate fields and never fuzzy-join them.
- The source malha is definitive Censo 2022 (reference date 2022-07-31); election and coordinate-source dates are separately recorded.
- Source ZIPs remain in local cache and are not committed. Browser data is generated, compact JSON partitioned by city and election.
- National section coverage is generated from the TSE presidential section CSV. The 895 IBGE neighborhood municipalities have 35,085 polling places in the result detail; 24,720 are assigned to exactly one neighborhood, covering 89.56% of their valid votes. Another 9,931 have coordinates but no matching neighborhood polygon, and 434 have no TSE coordinate record. The 32 municipalities with zero assigned places show official neighborhood boundaries without neighborhood vote totals; zone/place/section results remain available.
- TSE coordinate datum is not declared in the catalogue. EPSG:4674 is an explicit provisional assumption, not a verified source fact; the resulting point-to-neighborhood map must not be described as a confirmed legal boundary join until TSE confirms the CRS. Coordinates outside all neighborhood polygons and missing/conflicting points remain unassigned.
- The checked-in EA20 municipal cache differs from the national section CSV in 11 municipalities. The map uses the section-file candidate totals, preserves the EA20 valid-vote count for comparison, and exposes each discrepancy instead of silently choosing one.

## Sources

License: Creative Commons Attribution.

Catalogs:

- https://dadosabertos.tse.jus.br/dataset/resultados-2026
- https://dadosabertos.tse.jus.br/dataset/eleitorado-2026

Files (replace `{UF}` with the state code):

- Presidential section votes, consolidated presidential resource: https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_BR.zip
- Section detail, nationwide (select the presidential member; do not concatenate members): https://cdn.tse.jus.br/estatistica/sead/odsele/detalhe_votacao_secao/detalhe_votacao_secao_2026.zip
- Electorate by polling place, nationwide (select one source member; actual fields include `NM_BAIRRO`, `NR_LOCAL_VOTACAO`, `NR_LATITUDE`, `NR_LONGITUDE`; catalogue does not declare a coordinate datum): https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip
- Definitive IBGE Censo 2022 neighborhood mesh, SIRGAS 2000: https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/bairros/shp/BR/BR_bairros_CD2022.zip
- TSE municipal code to IBGE code mapping: https://resultados.tse.jus.br/oficial/ele2026/6257/config/mun-e006257-cm.json

Join sections using election, round, `SG_UF`, TSE `CD_MUNICIPIO`, `NR_ZONA`, and `NR_SECAO`; use source `NR_LOCAL_VOTACAO` to associate with the polling place. Filter every source for first round before joining, and avoid mixing consolidated and per-UF members. Votes come from the presidential `votacao_secao` resource; turnout comes from the matching presidential detail member. The official TSE-to-IBGE municipality mapping resolves geometry keys. Audit coordinate-to-polygon assignment and reconcile section/place/neighborhood/unassigned totals before publication.

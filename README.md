# Chão e urna

Mapa interativo do 1º turno presidencial de 2026, com todas as candidaturas válidas. As cores mostram a candidatura vencedora por município; os painéis comparam votos e percentuais de todos os candidatos. O mapa ocupa a tela: dá para arrastar, aproximar e clicar um município. Também cruza o voto com indicadores sociais e demográficos.

## Rodar

```bash
npm install
npm test
npm run dev
```

Se `public/data/map.json` não existir:

```bash
python3 scripts/build_map.py
```

O script baixa a malha municipal do IBGE, os arquivos EA20 do TSE e os indicadores do SIDRA. Também gera, a partir dos resultados por seção, arquivos gzip por município para zonas, locais e seções; e camadas gzip de bairros quando há polígonos oficiais do IBGE e locais com associação espacial não ambígua. Os arquivos são carregados sob demanda. Os downloads ficam no cache em `data/cache/`; os totais nacionais das candidaturas são reconciliados antes da publicação. O processamento geográfico usa as dependências de `requirements-sections.txt`.

## Detalhes da apuração

Depois de selecionar qualquer município, o botão "Exibir detalhes da apuração" abre a navegação por zonas eleitorais, locais de votação e seções. Cada nível mostra o vencedor e os votos de todas as candidaturas. O arquivo municipal é carregado sob demanda; votos registrados no local não representam necessariamente os votos de moradores dali.

O mapa de bairros está disponível em Salvador e em outros 894 municípios com polígonos oficiais do IBGE Censo 2022. Em 863 há resultados associados a bairros; nos outros 32, exibimos apenas as divisões oficiais e avisamos que nenhum local foi associado, então não há resultado por bairro. Os demais 4.675 municípios não têm polígonos de bairros nesta malha.

Nos 895 municípios, 24.720 de 35.085 locais presentes na apuração foram associados a um único bairro; esses locais representam 89,56% dos votos válidos do conjunto. 434 locais não aparecem no cadastro de coordenadas do TSE e 9.931 não coincidem com nenhum polígono de bairro. Permanecem fora do mapa, sem geografia presumida.

A coordenada TSE não declara datum/referência espacial no catálogo: o mapa usa a hipótese EPSG:4674 e informa isso na tela. As associações são uma camada espacial provisória, não uma afirmação sobre residência. Resultados por bairro são votos registrados em locais situados dentro do polígono, não votos de moradores. As zonas eleitorais não têm polígonos nesta camada.

Decisões, fontes e limitações estão em `docs/adr/0003-section-neighborhood-layer.md`.

```bash
npm test
PYTHONPATH=scripts python3 -m unittest test_audit_salvador test_build_national_apuracao test_build_national_neighborhoods
npm run build
```

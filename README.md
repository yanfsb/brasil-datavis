# Chão e urna

Mapa interativo do 1º turno presidencial de 2026. O mapa ocupa a tela: dá para arrastar, aproximar e clicar um município. As camadas cruzam o voto com analfabetismo, esgoto, água, lixo, internet, renda, PIB per capita, densidade e abstenção.

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

O script baixa a malha municipal do IBGE, os arquivos EA20 do TSE e os indicadores do SIDRA. A consulta ao TSE é retomável pelo cache em `data/cache/`.

## Camada de seção (planejada)

O mapa municipal continua sendo a visão padrão. Locais de votação e bairros entram como um drill-down, um arquivo por UF, descrito em `docs/adr/0003-section-neighborhood-layer.md`. O controle "Locais" fica desativado até esses arquivos existirem.

```bash
npm test
python3 scripts/build_sections.py --uf BA --dry-run
```

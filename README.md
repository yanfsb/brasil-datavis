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

# Section tiles

One JSON file per UF. The municipal map stays the default; a reader downloads a state only when the Locais layer asks for it. This directory has the contract and a fake example. It does not contain real sections.

`_example.json` uses the sentinel UF `EX`. The loader only accepts the 27 states and requests `/data/sections/{UF}.json` with an uppercase code, for example `/data/sections/BA.json`.

## Shape

```json
{
  "uf": "BA",
  "election": { "year": 2026, "round": 1, "office": "president", "officeCode": "1" },
  "places": [
    {
      "placeId": "1000",
      "municipalityCode": "38490",
      "municipalityName": "Salvador",
      "zone": "1",
      "name": "Escola Exemplo",
      "neighborhoodLabel": "Centro",
      "neighborhoodKey": "CENTRO",
      "latitude": -12.97,
      "longitude": -38.51,
      "sectionCount": 2,
      "electorate": 600,
      "tallies": [
        { "candidateNumber": "13", "votes": 240 },
        { "candidateNumber": "22", "votes": 180 }
      ]
    }
  ],
  "neighborhoods": [
    {
      "municipalityCode": "38490",
      "neighborhoodKey": "CENTRO",
      "label": "Centro",
      "placeCount": 1,
      "sectionCount": 2,
      "electorate": 600,
      "tallies": [{ "candidateNumber": "13", "votes": 240 }]
    }
  ]
}
```

Field notes:

- `placeId` is `NR_LOCAL_VOTACAO`. It repeats across municipalities. A place is `municipalityCode` + `zone` + `placeId`.
- `neighborhoodKey` is `DS_BAIRRO` after trim, collapsed spaces, and uppercase. `neighborhoodLabel` and `label` keep a display string. A blank bairro keeps an empty key and groups only with other blank labels in the same municipality.
- The same neighborhood key in two municipalities is two `neighborhoods` rows.
- `latitude` and `longitude` are decimal degrees, or `null` when the source has no point.
- `tallies` are candidate votes already summed for that place or neighborhood. Section rows are not in the file.
- `election` is part of the partition. This path is the 2026 presidential first round. Another year, round, or office gets its own directory.

Nationwide `votacao_secao` rows are about 470–500 thousand. Polling places are about 94 thousand. A tile holds the places and neighborhood aggregates of one UF only.

See `docs/adr/0003-section-neighborhood-layer.md` for the sources and the join.

import unittest

from build_national_apuracao import apply_to_map, publish_city


CANDIDATES = [
    {"number": "13", "name": "Lula", "party": "PT", "nationalVotes": 60, "nationalPercent": 60.0},
    {"number": "22", "name": "Flávio", "party": "PL", "nationalVotes": 40, "nationalPercent": 40.0},
    {"number": "80", "name": "Samara", "party": "UP", "nationalVotes": 0, "nationalPercent": 0.0},
]


class PublishCityTests(unittest.TestCase):
    def test_aggregates_zone_and_section_tallies_and_keeps_special_codes_separate(self):
        result = publish_city("1234567", [
            ("1", "5", "10", "13", 3),
            ("1", "5", "10", "22", 2),
            ("1", "5", "10", "95", 1),
            ("1", "5", "11", "13", 4),
            ("1", "5", "11", "22", 4),
            ("2", "8", "1", "22", 5),
        ], CANDIDATES, {("1234567", "1", "5"): "Escola Municipal"})
        first, second = result["zones"]
        self.assertEqual(first["winner"], "13")
        self.assertEqual(first["candidateVotes"], {"13": 7, "22": 6, "80": 0})
        self.assertEqual(first["validVotes"], 13)
        self.assertAlmostEqual(first["marginPercentagePoints"], 100 / 13)
        self.assertEqual(first["places"][0]["name"], "Escola Municipal")
        self.assertEqual(first["places"][0]["sections"][0]["specialVotes"], {"95": 1})
        self.assertEqual(first["places"][0]["sections"][0]["validVotes"], 5)
        self.assertEqual(second["winner"], "22")
        self.assertEqual(result["candidateVotes"], {"13": 7, "22": 11, "80": 0})

    def test_tied_zone_has_no_winner(self):
        result = publish_city("1234567", [("1", "5", "10", "13", 4), ("1", "5", "10", "22", 4)], CANDIDATES)
        self.assertIsNone(result["zones"][0]["winner"])

    def test_attaches_every_candidate_to_map_and_preserves_outside_votes(self):
        payload = {"mun": [{"ibge": "1234567", "vv": 12, "fv": 0, "lv": 0, "fp": 0, "lp": 0}], "brasil": {}, "fonte": "base"}
        manifest = {"candidates": CANDIDATES, "municipalities": {"1234567": {"candidateVotes": {"13": 7, "22": 6}, "detail": "municipalities/1234567.json.gz"}},
                    "outsideMunicipalityVotes": {"13": 1}}
        apply_to_map(payload, manifest)
        self.assertEqual([candidate["votes"] for candidate in payload["mun"][0]["candidatos"]], [7, 6, 0])
        self.assertEqual(payload["mun"][0]["apuracaoDetalhe"], "municipalities/1234567.json.gz")
        self.assertEqual(payload["votosForaMunicipios"], {"13": 1})
        self.assertEqual(payload["discrepanciasEA20"][0]["difference"], 1)
        self.assertEqual(payload["mun"][0]["vv"], 13)
        apply_to_map(payload, manifest)
        self.assertEqual(len(payload["discrepanciasEA20"]), 1)


if __name__ == "__main__":
    unittest.main()

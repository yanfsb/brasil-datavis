import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from shapely.geometry import Polygon

from audit_salvador import archive, election_match, number, publish_static_data, reconcile_ea20


class SalvadorAuditTests(unittest.TestCase):
    def test_election_filter_requires_first_round_president_and_salvador(self):
        row = {
            "ANO_ELEICAO": "2026", "NR_TURNO": "1", "CD_ELEICAO": "6257",
            "CD_CARGO": "1", "SG_UF": "BA", "CD_MUNICIPIO": "38490",
        }
        self.assertTrue(election_match(row, "ANO_ELEICAO"))
        for field, value in (("NR_TURNO", "2"), ("CD_ELEICAO", "other"),
                             ("CD_CARGO", "2"), ("SG_UF", "SP"),
                             ("CD_MUNICIPIO", "00000")):
            with self.subTest(field=field):
                self.assertFalse(election_match({**row, field: value}, "ANO_ELEICAO"))

    def test_election_filter_accepts_electorate_year_field(self):
        row = {
            "AA_ELEICAO": "2026", "NR_TURNO": "1", "CD_ELEICAO": "6257",
            "CD_CARGO": "1", "SG_UF": "BA", "CD_MUNICIPIO": "38490",
        }
        self.assertTrue(election_match(row, "AA_ELEICAO"))

    def test_vote_counts_are_nonnegative_integers(self):
        self.assertEqual(number("00012"), 12)
        for invalid in ("", "-1", "1,0", "abc"):
            with self.subTest(value=invalid):
                with self.assertRaises(ValueError):
                    number(invalid)

    def test_ea20_reconciles_candidates_and_separates_code_28_technical_nulls(self):
        codes = {"13": 944358, "14": 29219, "16": 505, "21": 226,
                 "22": 391188, "27": 462, "29": 239, "30": 2052,
                 "35": 180, "55": 36320, "70": 40676, "80": 1589}
        self.assertEqual(sum(codes.values()), 1447014)
        candidates = [{"n": code, "vap": str(votes), "nmu": f"Nome {code}"} for code, votes in codes.items()]
        payload = {
            "carg": [{"cd": "1", "agr": [{"par": [{"sg": "PX", "cand": candidates}]}]}],
            "v": {"vv": "1447014", "vnom": "1447014", "tv": "1561593",
                  "vb": "37013", "vn": "77516", "vnt": "50", "tvn": "77566"},
            "e": {"c": "1561593", "te": "1955479"},
        }
        reconciled = reconcile_ea20({**payload, "carg": payload["carg"]},
                                    {**codes, "28": 50, "95": 37013, "96": 77516},
                                    1561593, 1955479)
        self.assertEqual(reconciled["validVotes"], 1447014)
        self.assertEqual(reconciled["technicalNullVotes"], 50)
        self.assertEqual(reconciled["nullVotes"] + reconciled["technicalNullVotes"], 77566)
        self.assertNotIn("28", reconciled["candidateVotesByNumber"])
        self.assertEqual(reconciled["candidates"][0], {"number": "13", "name": "Nome 13", "party": "PX"})
        with self.assertRaisesRegex(ValueError, "candidate reconciliation"):
            reconcile_ea20(payload, {**codes, "28": 50, "13": 944357}, 1561593, 1955479)

    def test_ea20_rejects_each_special_vote_reconciliation_mismatch(self):
        candidates = [{"n": "13", "vap": "100"}]
        payload = {"carg": [{"cd": "1", "agr": [{"par": [{"cand": candidates}]}]}],
                   "v": {"vv": "100", "vnom": "100", "tv": "400", "vb": "10", "vn": "20",
                         "vnt": "3", "tvn": "23"},
                   "e": {"c": "400", "te": "500"}}
        valid_codes = {"13": 100, "95": 10, "96": 20, "28": 3}
        for code, wrong_count, message in (("95", 9, "code 95"), ("96", 19, "codes 96/97"),
                                            ("28", 2, "code 28")):
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    reconcile_ea20(payload, {**valid_codes, code: wrong_count}, 400, 500)
        with self.assertRaisesRegex(ValueError, "tvn"):
            reconcile_ea20({**payload, "v": {**payload["v"], "tvn": "24"}},
                           valid_codes, 400, 500)

    def test_publication_aggregates_votes_and_preserves_unassigned_places_lazily(self):
        import json
        from collections import Counter

        assigned = ("38490", "1", "100")
        unassigned = ("38490", "1", "200")
        place_votes = {assigned: Counter({"13": 5, "95": 1}),
                       unassigned: Counter({"13": 2, "96": 1})}
        sections = {("38490", "1", "1"): {"place": "100", "votes": Counter({"13": 5, "95": 1})},
                    ("38490", "1", "2"): {"place": "200", "votes": Counter({"13": 2, "96": 1})}}
        with tempfile.TemporaryDirectory() as directory, patch("audit_salvador.ROOT", Path(directory)):
            electorate = {assigned: {"coordinate": (-38.5, -12.9), "name": "Escola", "label": "Centro"},
                          unassigned: {"coordinate": None, "name": "Outro", "label": ""}}
            publish_static_data([({"CD_BAIRRO": "001", "NM_BAIRRO": "Centro"}, None)],
                                [Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])],
                                place_votes, {assigned: 0}, sections, electorate,
                                lambda lon, lat: (lon * 1000, lat * 1000),
                                {"candidateVotesByNumber": {"13": 7}, "candidates": [{"number": "13", "name": "Nome 13", "party": "PX"}]}, {},
                                {"allVotes": 9, "assignedVotes": 6, "unassignedVotes": 3})
            output = Path(directory) / "public/data/salvador"
            summary = json.loads((output / "summary.json").read_text())
            self.assertEqual(summary["neighborhoods"]["features"][0]["properties"]["votesByCandidate"], {"13": 5})
            self.assertEqual(summary["neighborhoods"]["features"][0]["properties"]["specialVotesByCode"], {"95": 1})
            self.assertEqual(summary["noGeometryVotesByCode"], {"13": 2, "96": 1})
            self.assertFalse((output / "sections.json").exists())
            self.assertEqual(len(summary["places"]), 2)
            assigned_place = next(place for place in summary["places"] if place["placeCode"] == "100")
            unassigned_place = next(place for place in summary["places"] if place["placeCode"] == "200")
            self.assertEqual(assigned_place["neighborhoodCode"], "001")
            self.assertEqual(assigned_place["coordinate"], {"x": -38500, "y": -12900})
            self.assertEqual(assigned_place["tallies"], [{"candidateNumber": "13", "votes": 5}])
            self.assertIsNone(unassigned_place["neighborhoodCode"])
            self.assertIsNone(unassigned_place["coordinate"])
            self.assertEqual(len(json.loads((output / summary["places"][1]["detail"]).read_text())["sections"]), 1)

    def test_archive_requires_the_exact_expected_member(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.zip"
            with zipfile.ZipFile(path, "w") as source:
                source.writestr("unexpected.csv", "header\\n")
            with patch("audit_salvador.CACHE", Path(directory)):
                with self.assertRaisesRegex(ValueError, "expected exactly one member"):
                    archive("source.zip", "expected.csv")


if __name__ == "__main__":
    unittest.main()

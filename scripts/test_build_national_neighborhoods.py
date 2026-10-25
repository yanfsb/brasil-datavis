import unittest

from build_national_neighborhoods import apply_to_map, assignment_status, summarize_place_votes


class NeighborhoodAssignmentTests(unittest.TestCase):
    def test_only_exactly_one_official_polygon_is_assignable(self):
        self.assertEqual(assignment_status(False, 0), "no-coordinate")
        self.assertEqual(assignment_status(True, 0), "no-neighborhood-boundary")
        self.assertEqual(assignment_status(True, 1), "assigned")
        self.assertEqual(assignment_status(True, 2), "ambiguous-boundary")

    def test_official_boundary_layer_stays_available_when_no_place_can_be_assigned(self):
        payload = {"mun": [{"ibge": "1234567"}, {"ibge": "7654321"}]}
        manifest = {"neighborhoodMunicipalities": 2, "mappedMunicipalities": 2,
                    "municipalitiesWithAssignedResults": 1,
                    "municipalities": {
                        "1234567": {"detail": "municipalities/1234567.json.gz", "assignedPlaceCount": 0},
                        "7654321": {"detail": "municipalities/7654321.json.gz", "assignedPlaceCount": 1},
                    }}
        apply_to_map(payload, manifest)
        self.assertEqual(payload["mun"][0]["neighborhoodLayer"], "municipalities/1234567.json.gz")
        self.assertEqual(payload["mun"][1]["neighborhoodLayer"], "municipalities/7654321.json.gz")
        self.assertEqual(payload["bairroCoverage"]["municipalitiesWithAssignedResults"], 1)

    def test_place_tallies_sum_every_section_and_keep_special_votes_separate(self):
        city = {"zones": [{"number": "1", "places": [{"code": "10", "name": "Escola", "sections": [
            {"number": "1", "candidateVotes": {"13": 7, "22": 3}, "specialVotes": {"95": 1}},
            {"number": "2", "candidateVotes": {"13": 2, "22": 5}, "specialVotes": {"96": 2}},
        ]}]}]}
        result = summarize_place_votes(city, ["13", "22", "80"])[("1", "10")]
        self.assertEqual(result["name"], "Escola")
        self.assertEqual(result["sectionCount"], 2)
        self.assertEqual(result["votesByCode"], {"13": 9, "22": 8, "95": 1, "96": 2})
        self.assertEqual(result["tallies"], [
            {"candidateNumber": "13", "votes": 9},
            {"candidateNumber": "22", "votes": 8},
            {"candidateNumber": "80", "votes": 0},
        ])


if __name__ == "__main__":
    unittest.main()

"""tools/esco.py's reading of an ESCO API answer, without the network.
Run: python -m unittest discover -s tools -p "test_*.py"."""
import unittest

import esco

ANSWER = {
    'uri': 'http://data.europa.eu/esco/skill/abc-123',
    'className': 'Concept',
    'preferredLabel': {'fr': 'Ansible', 'en': 'Ansible', 'de': 'Ansible'},
    'alternativeLabel': {'fr': ['outil Ansible', 'outil Ansible'], 'de': ['x']},
    '_links': {
        'broaderConcept': [{'uri': 'http://data.europa.eu/esco/isced-f/0612'}],
        'narrowerConcept': [{'uri': 'http://data.europa.eu/esco/skill/child-1'}],
        'narrowerSkill': {'uri': 'http://data.europa.eu/esco/skill/child-2'},
    },
}


class Reading(unittest.TestCase):
    def test_a_concept_keeps_its_french_and_english_labels_synonyms_and_parents(self):
        self.assertEqual(esco.concept(ANSWER), {
            'id': 'abc-123', 'fr': 'Ansible', 'en': 'Ansible',
            'alt': {'fr': ['outil Ansible']}, 'broader': ['0612'], 'kind': 'Concept',
        })

    def test_every_narrower_link_is_followed_list_or_single(self):
        self.assertEqual(sorted(esco.narrower(ANSWER)), [
            'http://data.europa.eu/esco/skill/child-1', 'http://data.europa.eu/esco/skill/child-2'])


if __name__ == '__main__':
    unittest.main()

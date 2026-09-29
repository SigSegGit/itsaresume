# -*- coding: utf-8 -*-
"""Build data/esco.json: the ESCO concepts the CV generator matches offers against.

    python tools/esco.py                 # crawl (cached, resumable), then write data/esco.json
    python tools/esco.py --cache DIR     # where the raw API answers are kept (default: .esco-cache)

ESCO is the European classification of skills (European Commission, free to
reuse with attribution). It gives every concept a French and an English label,
its synonyms in both languages, and its broader concepts: the link between an
offer's words and the owner's, in either language, without a model.

Three branches are kept: ICT knowledge (ISCED-F 06), "working with computers"
(skills S5), and the transversal skills (T: communication, teamwork...).
Standard library only; one request at a time, politely.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://ec.europa.eu/esco/api/resource/concept'
ROOTS = [
    'http://data.europa.eu/esco/isced-f/06',
    'http://data.europa.eu/esco/skill/S5',
    'http://data.europa.eu/esco/skill/T',
]
LANGUAGES = ('fr', 'en')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'esco.json')
USER_AGENT = 'itsaresume-cv/0.1 (ESCO crawl for a CV generator)'


def fetch(uri, cache):
    """The API's answer for one concept, from the cache when it is there."""
    name = os.path.join(cache, urllib.parse.quote(uri, safe='') + '.json')
    if os.path.exists(name):
        with open(name, encoding='utf-8') as handle:
            return json.load(handle)
    url = API + '?' + urllib.parse.urlencode({'uri': uri, 'language': 'fr'})
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                answer = json.load(response)
            break
        except urllib.error.HTTPError as error:
            # A concept ESCO no longer serves: kept as nothing, and skipped.
            if error.code == 404:
                answer = {}
                break
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    with open(name, 'w', encoding='utf-8', newline='') as handle:
        json.dump(answer, handle, ensure_ascii=False)
    time.sleep(0.05)
    return answer


def short(uri):
    """A stable, short id: the part of the URI after the last slash."""
    return uri.rstrip('/').rsplit('/', 1)[-1]


def concept(answer):
    """The fields kept for one concept."""
    labels = answer.get('preferredLabel') or {}
    alternatives = answer.get('alternativeLabel') or {}
    links = answer.get('_links') or {}
    broader = [short(link['uri']) for key in ('broaderConcept', 'broaderSkill', 'broaderHierarchyConcept')
               for link in links.get(key) or [] if link.get('uri')]
    return {
        'id': short(answer['uri']),
        'fr': labels.get('fr', ''),
        'en': labels.get('en', ''),
        'alt': {lang: sorted(set(alternatives.get(lang) or [])) for lang in LANGUAGES if alternatives.get(lang)},
        'broader': sorted(set(broader)),
        'kind': (answer.get('skillType') or answer.get('className') or '').rsplit('/', 1)[-1],
    }


def narrower(answer):
    links = answer.get('_links') or {}
    return [link['uri'] for key, value in links.items() if key.startswith('narrower')
            for link in (value if isinstance(value, list) else [value]) if link.get('uri')]


def crawl(cache):
    seen, todo, concepts = set(), list(ROOTS), []
    while todo:
        uri = todo.pop()
        if uri in seen:
            continue
        seen.add(uri)
        answer = fetch(uri, cache)
        if 'uri' not in answer:
            continue
        concepts.append(concept(answer))
        todo.extend(child for child in narrower(answer) if child not in seen)
        if len(seen) % 200 == 0:
            print(f'{len(seen)} concepts', file=sys.stderr, flush=True)
    return concepts


def main():
    cache = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else '.esco-cache'
    os.makedirs(cache, exist_ok=True)
    concepts = sorted(crawl(cache), key=lambda c: c['id'])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='') as handle:
        json.dump({'source': 'ESCO, European Commission (esco.ec.europa.eu), reused with attribution',
                   'roots': [short(root) for root in ROOTS], 'concepts': concepts},
                  handle, ensure_ascii=False, indent=0)
        handle.write('\n')
    print(f'{len(concepts)} concepts written to data/esco.json', file=sys.stderr)


if __name__ == '__main__':
    main()

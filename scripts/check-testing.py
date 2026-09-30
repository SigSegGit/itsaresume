# -*- coding: utf-8 -*-
"""Keep docs/TESTING.md honest against the sabotage plan.

Each table row names a test and, in its last column, the defences that break
it. A row that cites a defence whose ``expect`` list does not name that test
is a claim nobody checked. This checks both directions:

* every defence a row cites exists and lists the row's test in ``expect``;
* every (defence, test) pair of the plan is cited by that test's row;
* every defence's ``live`` anchor appears exactly once in its file (a line
  edited under an anchor used to surface only in the 16-minute sabotage job;
  here it fails in seconds).

    python scripts/check-testing.py
"""

import io
import glob
import json
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
DOC = os.path.join(ROOT, 'docs', 'TESTING.md')
PLANS = os.path.join(ROOT, 'scripts', 'sabotage', '*.json')


def rows(text):
    """Map test name to the set of defences its row cites."""
    found = {}
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 4:
            continue
        test = re.fullmatch(r'`([a-z0-9_]+)`', cells[0])
        if not test:
            continue
        cited = set()
        if cells[-1].startswith('—'):
            cells[-1] = ''  # "— (reason)": nothing cited, the reason is prose
        for part in cells[-1].split(';'):
            part = part.strip()
            if part and not part.startswith('—'):
                cited.add(part)
        found.setdefault(test.group(1), set()).update(cited)
    return found


def problems(text, defences):
    out = []
    table = rows(text)
    for test, cited in sorted(table.items()):
        for name in sorted(cited):
            if name not in defences:
                out.append(f'{test}: cites unknown defence "{name}"')
            elif test not in defences[name]['expect']:
                out.append(f'{test}: cites "{name}", whose expect does not name it')
    for name, d in sorted(defences.items()):
        for test in d['expect']:
            if name not in table.get(test, set()):
                out.append(f'{test}: row missing or does not cite "{name}"')
    return out


def anchor_problems(defences):
    """Defences whose live anchor is not exactly once in its file."""
    out = []
    for name, d in sorted(defences.items()):
        path = os.path.join(ROOT, d['file'])
        text = io.open(path, encoding='utf-8', newline='').read() if os.path.exists(path) else ''
        count = text.count(d['live'])
        if count != 1:
            out.append(f'{name}: anchor found {count} times in {d["file"]}')
    return out


def main():
    text = io.open(DOC, encoding='utf-8').read()
    defences = {}
    for plan in sorted(glob.glob(PLANS)):
        defences.update(json.load(io.open(plan, encoding='utf-8'))['defences'])
    found = problems(text, defences) + anchor_problems(defences)
    for p in found:
        print('FAIL', p)
    print(f'{len(found)} problem(s)')
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())

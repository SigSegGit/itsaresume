# -*- coding: utf-8 -*-
"""Keep the resume pointer in docs/HANDOVER.md honest.

The ITSARESUME-STATE block is what a future session reads to know where to
resume without asking Nicolas. Prose that nobody checks rots; this checks it:

* the block exists at the top, with NEXT, TITLE, WRITTEN-AT and BASE;
* NEXT names a real item of section 8 that is not ticked (or is ``done`` when
  every item is ticked);
* BASE is a commit that is an ancestor of HEAD (the pointer was written on
  this history, not on a branch that was thrown away);
* sections 0, 1, 8 and 9 exist, and section 1 still states zero pay-per-use;
* section 0 fits on a page. In ITSaNAS the same section grew to 1,100 lines,
  and a resume pointer nobody can read in one sitting is not one.

    python scripts/check-handover.py
"""

import io
import os
import re
import subprocess
import sys

MAX_SECTION_0_LINES = 60

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
PATH = os.path.join(ROOT, 'docs', 'HANDOVER.md')


def sections(text):
    """Map section number ('0', '1', ...) to its body, from '## N.' headings."""
    found = {}
    current, lines = None, []
    for line in text.splitlines():
        heading = re.match(r'^## (\d+)\.', line)
        if heading:
            if current is not None:
                found[current] = lines
            current, lines = heading.group(1), []
        elif current is not None:
            lines.append(line)
    if current is not None:
        found[current] = lines
    return found


def main():
    problems = []
    with io.open(PATH, encoding='utf-8') as handle:
        text = handle.read()

    block = re.search(r'<!-- ITSARESUME-STATE\n(.*?)\n-->', text, re.S)
    if not block:
        print('docs/HANDOVER.md: no ITSARESUME-STATE block.')
        return 1
    fields = dict(re.findall(r'^([A-Z-]+):\s*(.*?)\s*$', block.group(1), re.M))
    for key in ('NEXT', 'TITLE', 'WRITTEN-AT', 'BASE'):
        if not fields.get(key):
            problems.append('the block has no %s' % key)
    if fields.get('WRITTEN-AT') and not re.match(r'^\d{4}-\d{2}-\d{2}$', fields['WRITTEN-AT']):
        problems.append('WRITTEN-AT is not YYYY-MM-DD: %r' % fields['WRITTEN-AT'])

    body = sections(text)
    for number in ('0', '1', '8', '9'):
        if number not in body:
            problems.append('section %s is missing' % number)

    if '0' in body and len(body['0']) > MAX_SECTION_0_LINES:
        problems.append('section 0 is %d lines; it must fit on a page (%d)'
                        % (len(body['0']), MAX_SECTION_0_LINES))

    if '1' in body and 'zero pay-per-use' not in '\n'.join(body['1']).lower():
        problems.append('section 1 no longer states "zero pay-per-use"')

    items = {}
    for line in body.get('8', []):
        item = re.match(r'^- \[([ x])\] \*\*(8\.\d+)\*\*', line)
        if item:
            items[item.group(2)] = item.group(1) == 'x'
    if not items:
        problems.append('section 8 has no "- [ ] **8.N**" items')

    nxt = fields.get('NEXT', '')
    if nxt == 'done':
        open_items = [k for k, done in items.items() if not done]
        if open_items:
            problems.append('NEXT is "done" but %s are not ticked' % ', '.join(open_items))
    elif nxt:
        if nxt not in items:
            problems.append('NEXT %s is not an item of section 8' % nxt)
        elif items[nxt]:
            problems.append('NEXT %s is already ticked' % nxt)

    base = fields.get('BASE', '')
    if base:
        if not re.match(r'^[0-9a-f]{7,40}$', base):
            problems.append('BASE is not a commit sha: %r' % base)
        else:
            ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', base, 'HEAD'],
                                      cwd=ROOT, capture_output=True, text=True)
            if ancestor.returncode != 0:
                problems.append('BASE %s is not an ancestor of HEAD%s'
                                % (base, (': ' + ancestor.stderr.strip()) if ancestor.stderr.strip() else ''))

    if problems:
        print('docs/HANDOVER.md is not a pointer a future session can trust:')
        for problem in problems:
            print('  - ' + problem)
        return 1
    print('handover pointer: NEXT %s (%s), BASE %s, %d items in section 8.'
          % (nxt, fields.get('TITLE'), base, len(items)))
    return 0


if __name__ == '__main__':
    sys.exit(main())

# -*- coding: utf-8 -*-
"""Which sabotage plans a change needs (8.46), for GITHUB_OUTPUT.

    python scripts/sabotage-select.py <base sha>   # sabotage_root=… sabotage_cv=…
    python scripts/sabotage-select.py --check      # every plan names its files

The plans are split by attack surface (offer → model, model → page, public
exposure, HTTP, billing, deploy, laptop, plus what faces no attacker), and
each plan lists in "files" what its defences depend on: the file each
defence breaks and the test files that hold its named tests. A pull request
runs only the plans whose files it touches; the full pass runs on `main`
after each merge and on `workflow_dispatch` (both pass an empty base).

Never narrower than sure: a file no plan names (a helper, a fixture, a
manifest), the tree's sabotage script, a workflow, an unknown base or a base
git cannot diff against runs every plan of the tree concerned. Documentation
runs none, except Markdown under a test directory, which may be a fixture.
`--check` keeps "files" honest: a plan that forgets a file it depends on
would be skipped by the change that breaks it.

Two trees, each with its own plans and sabotage script: the router at the
root (paths from the repository root) and the generator in cv/ (paths from
cv/). Output paths are relative to their tree, as each job runs from there.
"""

import glob
import io
import json
import os
import re
import subprocess
import sys

TREES = (('root', ''), ('cv', 'cv/'))


def top():
    out = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else os.getcwd()


def plans(root, prefix):
    """{plan path relative to its tree: plan} for one tree."""
    found = {}
    for path in sorted(glob.glob(os.path.join(root, prefix, 'scripts', 'sabotage', '*.json'))):
        with io.open(path, encoding='utf-8') as handle:
            found['scripts/sabotage/' + os.path.basename(path)] = json.load(handle)
    return found


def changed(base, root):
    """The files changed since `base`, or None when that cannot be known."""
    if not base:
        return None
    out = subprocess.run(['git', 'diff', '--name-only', base + '...HEAD'],
                         cwd=root, capture_output=True, text=True)
    if out.returncode != 0:
        return None
    return [line.strip() for line in out.stdout.splitlines() if line.strip()]


def is_doc(path):
    if re.search(r'(^|/)tests?/', path):
        return False
    return path.startswith('docs/') or path.startswith('cv/docs/') or path.endswith('.md')


def select(files, trees):
    """{tree name: set of plan paths} that the changed `files` need."""
    every = {name: set(found) for name, (_, found) in trees.items()}
    if files is None:
        return every
    chosen = {name: set() for name in trees}
    for path in files:
        if path.startswith('.github/workflows/'):
            return every
        if is_doc(path):
            continue
        name = 'cv' if path.startswith('cv/') else 'root'
        prefix, found = trees[name]
        rel = path[len(prefix):]
        if rel in found:
            chosen[name].add(rel)
            continue
        hits = {plan for plan, body in found.items() if rel in body.get('files', [])}
        if not hits:
            chosen[name] = set(every[name])
        else:
            chosen[name] |= hits
    return chosen


def sources(root, pattern):
    texts = {}
    for path in glob.glob(os.path.join(root, pattern), recursive=True):
        if os.sep + 'target' + os.sep in path or os.sep + 'node_modules' + os.sep in path:
            continue
        with io.open(path, encoding='utf-8', errors='replace') as handle:
            texts[os.path.relpath(path, root).replace(os.sep, '/')] = handle.read()
    return texts


def needs(plan, root):
    """(files the plan depends on, test names found in no file)."""
    command = plan.get('command', [])
    files, lost = set(), []
    if command[:2] == ['node', '--test']:
        texts = sources(root, os.path.join('test', '**', '*.test.js'))
        # A name built from a template (`stem: ${a} and ${b}`) matches it.
        templates = {path: [re.compile('.*'.join(re.escape(part) for part
                                                 in re.split(r'\$\{[^}]*\}', body)), re.S)
                            for body in re.findall(r'\b(?:test|it)\(\s*`([^`]*\$\{[^`]*)`', text)]
                     for path, text in texts.items()}

        def holds(path, name):
            text = texts[path]
            if any(q + s + q in text for q in ("'", '"', '`')
                   for s in (name, name.replace("'", "\\'"))):
                return True
            return any(pattern.fullmatch(name) for pattern in templates[path])
    elif command[:2] == ['cargo', 'test']:
        texts = sources(root, os.path.join('crates', '**', '*.rs'))

        def holds(path, name):
            return 'fn %s(' % name.split('::')[-1] in texts[path]
    else:
        texts, holds = {}, None
        files.update(command[1:2])
    for defence in plan.get('defences', {}).values():
        files.add(defence['file'])
        if holds is None:
            continue
        for name in defence.get('expect', []):
            hits = [path for path in texts if holds(path, name)]
            if hits:
                files.update(hits)
            else:
                lost.append(name)
    # What these files use is what the plan depends on too (Rodin, 2026-10-06:
    # a helper changed alone would skip the plans whose tests run through it).
    if command[:2] == ['node', '--test']:
        files = imported(files, root)
    elif command[:2] == ['cargo', 'test']:
        # A test links its whole crate: every source of each crate concerned.
        crates = {m.group(1) for f in files for m in [re.match(r'(crates/[^/]+)/', f)] if m}
        files |= {path for path in sources(root, os.path.join('crates', '**', '*.rs'))
                  if any(path.startswith(crate + '/src/') for crate in crates)}
    return files, lost


IMPORT = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}/[^'"]+)['"]''')


def imported(files, root):
    """`files` and every module they import by a relative path, transitively."""
    seen, todo = set(files), list(files)
    while todo:
        path = todo.pop()
        if not path.endswith(('.js', '.mjs')):
            continue
        try:
            with io.open(os.path.join(root, path), encoding='utf-8', errors='replace') as handle:
                text = handle.read()
        except OSError:
            continue
        for target in IMPORT.findall(text):
            module = os.path.normpath(os.path.join(os.path.dirname(path), target)).replace(os.sep, '/')
            if module not in seen and os.path.exists(os.path.join(root, module)):
                seen.add(module)
                todo.append(module)
    return seen


def check(root):
    problems = []
    for _, prefix in TREES:
        tree = os.path.join(root, prefix)
        for path, plan in plans(root, prefix).items():
            where = prefix + path
            if not plan.get('surface'):
                problems.append('%s: no "surface"' % where)
            files, lost = needs(plan, tree)
            for name in lost:
                problems.append('%s: test %r is in no test file' % (where, name))
            for missing in sorted(files - set(plan.get('files', []))):
                problems.append('%s: "files" lacks %s' % (where, missing))
    for problem in problems:
        print(problem)
    print('%d problem(s) in the sabotage plans\' "files"' % len(problems))
    return 1 if problems else 0


def main():
    root = top()
    if sys.argv[1:2] == ['--check']:
        return check(root)
    trees = {name: (prefix, plans(root, prefix)) for name, prefix in TREES}
    chosen = select(changed(sys.argv[1] if len(sys.argv) > 1 else '', root), trees)
    for name, _ in TREES:
        print('sabotage_%s=%s' % (name, ' '.join(sorted(chosen[name]))))
    return 0


if __name__ == '__main__':
    sys.exit(main())

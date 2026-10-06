# -*- coding: utf-8 -*-
"""Hold .github/workflows/ci.yml to what the required checks need.

A matrix job skipped at job level reports one unexpanded name
("test (${{ matrix.os }})"), never the per-OS names the required checks
wait for, and the pull request stays blocked (seen on #85, 2026-10-06). So
a matrix job never carries a job-level `if`: its steps do.

Plain text, no YAML library (the CI's system Python has none): a job is a
two-space key under `jobs:`, its own keys are four spaces in.

    python scripts/check-workflow.py [workflow.yml]
"""
import io
import re
import sys


def jobs(text):
    """{name: [lines of the job]} for the jobs under `jobs:`."""
    found, current = {}, None
    inside = False
    for line in text.splitlines():
        if line.startswith('jobs:'):
            inside = True
            continue
        if not inside:
            continue
        if line and not line.startswith(' ') and not line.startswith('#'):
            break
        match = re.match(r'^  ([A-Za-z0-9_-]+):\s*$', line)
        if match:
            current = match.group(1)
            found[current] = []
        elif current:
            found[current].append(line)
    return found


def problems(text):
    found = []
    for name, lines in jobs(text).items():
        matrix = any(re.match(r'^      matrix:', line) for line in lines)
        job_if = any(re.match(r'^    if:', line) for line in lines)
        if matrix and job_if:
            found.append('%s: a matrix job skipped at job level reports no per-OS check; '
                         'put the condition on its steps' % name)
    return found


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else '.github/workflows/ci.yml'
    with io.open(path, encoding='utf-8') as handle:
        found = problems(handle.read())
    for line in found:
        print('FAIL ' + line)
    print('%d problem(s)' % len(found))
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())

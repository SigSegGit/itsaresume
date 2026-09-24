# -*- coding: utf-8 -*-
"""Break one behaviour, watch the test that guards it go red, restore the file.

Why this exists
---------------

Every fallback and error test in this project must be *sabotage-verified*
(docs/HANDOVER.md, section 1): cancel the behaviour, watch its test fail,
restore. A test that passes whether or not the behaviour exists is decoration.

Done by hand, this goes wrong in two known ways, both inherited from the
ITSaNAS project where they cost real time:

* **Restoring by editing.** An edit-back can fail on its own (ambiguous
  anchor) and leave a half-restored file that looks like a working one. Here
  the file is restored by *copying* a byte-for-byte backup, whatever happens.
* **A stale cargo artefact.** If the restored file's mtime is not newer than
  the last build, cargo may reuse the sabotaged binary and the next "green"
  is a lie. Every write here is followed by an explicit touch.

Two more guards are specific to this script:

* **Baseline first.** The command must be green before any sabotage. A test
  that was already red would otherwise "verify" every sabotage.
* **Named victims.** Each defence lists the tests expected to go red. Turning
  some *other* test red says nothing about the defence, so it does not count.
* **A sabotage that does not compile is a broken plan**, not a verification,
  unless the defence is declared ``"compile_time": true`` (a guarantee the
  type system enforces, where refusing to build *is* the proof).

Usage
-----

    python scripts/sabotage.py                      # every scripts/sabotage/*.json
    python scripts/sabotage.py scripts/sabotage/router.json

A plan file::

    {
      "command": ["cargo", "test", "-p", "itsaresume-router"],
      "defences": {
        "Other stops the request": {
          "file": "crates/itsaresume-router/src/router.rs",
          "live": "if !error.allows_fallback() {",
          "dead": "if false {",
          "expect": ["other_error_stops_without_trying_the_next_backend"]
        }
      }
    }

Exit status is 0 only if the baseline was green, every defence turned each of
its named tests red, and the tree is green again after the last restore.
"""

import glob
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile


def repo_root():
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))


def touch(path):
    """Make cargo see the file as changed. See the module docstring."""
    os.utime(path, None)


def red_tests(output):
    """Names cargo printed as failed, from lines like ``test a::b ... FAILED``."""
    names = set()
    for line in output.splitlines():
        line = line.strip()
        if line.startswith('test ') and line.endswith('FAILED'):
            names.add(line.split()[1])
    return sorted(names)


def matches(expected, red):
    """A red test name matches an expectation by full path or by last segment."""
    return any(name == expected or name.endswith('::' + expected) for name in red)


def run(command, root):
    completed = subprocess.run(command, cwd=root, capture_output=True, text=True,
                               encoding='utf-8', errors='replace')
    return completed.returncode, completed.stdout + completed.stderr


def verify(defence, command, root):
    """Return (verdict, detail). verdict is 'ok' or 'fail'."""
    path = os.path.join(root, defence['file'])
    live, dead = defence['live'], defence['dead']
    expect = defence.get('expect', [])
    compile_time = defence.get('compile_time', False)

    if not expect and not compile_time:
        return 'fail', 'no "expect" list: name the tests this sabotage must turn red'

    with io.open(path, encoding='utf-8', newline='') as handle:
        pristine = handle.read()

    found = pristine.count(live)
    if found != 1:
        return 'fail', ('the anchor appears %d times in %s; an ambiguous anchor is '
                        'how a restore silently fails' % (found, defence['file']))

    handle, backup = tempfile.mkstemp(suffix='.pristine')
    os.close(handle)
    shutil.copyfile(path, backup)
    try:
        with io.open(path, 'w', encoding='utf-8', newline='') as out:
            out.write(pristine.replace(live, dead))
        touch(path)
        code, output = run(command, root)
    finally:
        # Whatever happened -- a failed build, a crash, Ctrl-C -- the file goes
        # back byte for byte, then is touched so cargo rebuilds it.
        shutil.copyfile(backup, path)
        os.unlink(backup)
        touch(path)

    red = red_tests(output)
    if compile_time:
        if code != 0 and not red and 'error' in output:
            return 'ok', 'the build refused the sabotage (compile-time guarantee)'
        return 'fail', 'declared compile_time, but the sabotaged tree built'

    if not red and code != 0:
        tail = '\n'.join(output.strip().splitlines()[-8:])
        return 'fail', 'the sabotaged tree did not build; the plan is broken:\n' + tail

    missing = [e for e in expect if not matches(e, red)]
    if missing:
        return 'fail', ('stayed green: %s (red were: %s)'
                        % (', '.join(missing), ', '.join(red) or 'none'))
    return 'ok', 'red: ' + ', '.join(red)


def main():
    root = repo_root()
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(root, 'scripts', 'sabotage', '*.json')))

    plans = []
    for plan_path in paths:
        with io.open(plan_path, encoding='utf-8') as handle:
            plans.append((plan_path, json.load(handle)))

    total = sum(len(plan['defences']) for _, plan in plans)
    if total == 0:
        print('0 defences declared: nothing is sabotage-verified yet.')
        return 0

    failures = 0
    for plan_path, plan in plans:
        command = plan['command']
        print('== %s' % os.path.relpath(plan_path, root))

        code, output = run(command, root)
        if code != 0:
            print('BASELINE RED -- the tree fails before any sabotage, so no')
            print('sabotage can prove anything. Fix the tree first.')
            print('\n'.join(output.strip().splitlines()[-15:]))
            return 1

        for name, defence in plan['defences'].items():
            verdict, detail = verify(defence, command, root)
            print('%-4s %s' % ('ok' if verdict == 'ok' else 'FAIL', name))
            for line in detail.splitlines():
                print('       ' + line)
            if verdict != 'ok':
                failures += 1

        code, output = run(command, root)
        if code != 0:
            print('AFTER RESTORE THE TREE IS RED -- a restore went wrong.')
            print('\n'.join(output.strip().splitlines()[-15:]))
            return 1

    print('')
    if failures:
        print('%d of %d defence(s) are NOT verified by any test.' % (failures, total))
        return 1
    print('%d defence(s) verified: each turned its named tests red, every file was' % total)
    print('restored from a byte-for-byte copy, and the tree is green again.')
    return 0


if __name__ == '__main__':
    sys.exit(main())

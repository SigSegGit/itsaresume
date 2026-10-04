// 4.1: the profiles a job may be tailored to: the owner's (--profile, id
// "default") and the JSON files of --profiles DIR, by a closed set of names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProfiles } from '../src/profiles.js';

test('the profiles are the default and each <id>.json of the directory; other names are not profiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-profiles-'));
  for (const name of ['bob.json', 'carol-2.json', 'Bad Name.json', 'default.json', 'notes.txt', '.hidden.json']) writeFileSync(join(dir, name), '{}');
  mkdirSync(join(dir, 'dir.json'));
  const profiles = listProfiles({ profile: '/owner/profile.json', profilesDir: dir });
  assert.deepEqual([...profiles.keys()], ['default', 'bob', 'carol-2']);
  assert.equal(profiles.get('default'), '/owner/profile.json');
  assert.equal(profiles.get('bob'), join(dir, 'bob.json'));
});

test('no directory, or a missing one, is the default alone', () => {
  assert.deepEqual([...listProfiles({ profile: '/p.json' }).keys()], ['default']);
  assert.deepEqual([...listProfiles({ profile: '/p.json', profilesDir: join(tmpdir(), 'no-such-itsacv-dir') }).keys()], ['default']);
});

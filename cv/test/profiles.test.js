// 4.1: the profiles a job may be tailored to: the owner's (--profile, id
// "default") and the JSON files of --profiles DIR, by a closed set of names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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

test('itsacv serve --profiles DIR offers the directory\'s profiles on the page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-profiles-'));
  writeFileSync(join(dir, 'bob.json'), '{}');
  const cli = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const profile = new URL('./fixtures/profile.synthetic.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const child = spawn(process.execPath, [cli, 'serve', '--port', '0', '--no-layout', '--profile', profile, '--profiles', dir, '--out', dir, '--url', 'http://127.0.0.1:9']);
  try {
    const port = await new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const found = stderr.match(/serving on http:\/\/127\.0\.0\.1:(\d+)/);
        if (found) resolve(found[1]);
      });
      child.on('exit', () => reject(new Error(stderr)));
    });
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.deepEqual(status.profiles, ['default', 'bob']);
  } finally {
    child.kill();
  }
});

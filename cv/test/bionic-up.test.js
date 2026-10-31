// 2026-10-31, the owner: a session wakes Bionic itself for its tests and
// benches (deploy/laptop/bionic-up.sh), on the port the router and the
// tunnel use, and says so when it does not answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../deploy/laptop/bionic-up.sh', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const posix = { skip: process.platform === 'win32' && 'POSIX shell fakes' };

function run(curlExit) {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-up-'));
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'lms'), `#!/bin/sh\necho "lms $*" >> "${calls}"\n`);
  writeFileSync(join(dir, 'curl'), `#!/bin/sh\necho "curl $*" >> "${calls}"\nexit ${curlExit}\n`);
  for (const name of ['lms', 'curl']) chmodSync(join(dir, name), 0o755);
  writeFileSync(join(dir, 'public.env'), `BIONIC_LMS=${join(dir, 'lms')}\n`);
  const result = spawnSync('bash', [script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ITSACV_PUBLIC_ENV: join(dir, 'public.env'), BIONIC_WAIT: '2', BIONIC_PAUSE: '0' },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { ...result, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

test('bionic-up starts Bionic on 54321 and returns once its models answer', posix, () => {
  const { status, stderr, calls } = run(0);
  assert.equal(status, 0, stderr);
  assert.equal(calls[0], 'lms server start --port 54321');
  assert.match(calls[1], /^curl .*http:\/\/127\.0\.0\.1:54321\/v1\/models/);
});

test('bionic-up fails, naming the port, when Bionic never answers', posix, () => {
  const { status, stderr, calls } = run(7);
  assert.equal(status, 1);
  assert.match(stderr, /127\.0\.0\.1:54321/);
  assert.equal(calls.filter((line) => line.startsWith('curl')).length, 2, 'asked BIONIC_WAIT times');
});

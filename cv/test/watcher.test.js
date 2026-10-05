// 8.44, laptop side: deploy/laptop/wake-watcher.sh, started at logon, holds
// nothing heavy: each round, one SSH call marks the laptop seen and takes a
// wake request; a request starts Bionic's server and the tunnel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../deploy/laptop/wake-watcher.sh', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

function run(sshSays) {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-watch-'));
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\necho "ssh" >> "${calls}"\necho "${sshSays}"\n`);
  writeFileSync(join(dir, 'lms'), `#!/bin/sh\necho "lms $*" >> "${calls}"\n`);
  writeFileSync(join(dir, 'tunnel'), `#!/bin/sh\necho "tunnel" >> "${calls}"\n`);
  for (const name of ['ssh', 'lms', 'tunnel']) chmodSync(join(dir, name), 0o755);
  writeFileSync(join(dir, 'public.env'), `VM_SSH=vm\nVM_KEY=key\nBIONIC_LMS=${join(dir, 'lms')}\n`);
  const result = spawnSync('bash', [script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ITSACV_PUBLIC_ENV: join(dir, 'public.env'), ITSACV_WATCH_ROUNDS: '1', ITSACV_WATCH_PAUSE: '0', ITSACV_TUNNEL_CMD: join(dir, 'tunnel'), ITSACV_TUNNEL_PIDFILE: join(dir, 'tunnel.pid') },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  // The tunnel starts in the background: give it a moment.
  spawnSync('sleep', ['0.5']);
  return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
}

const posix = { skip: process.platform === 'win32' && 'POSIX shell fakes' };

test('a quiet round marks the laptop seen and starts nothing', posix, () => {
  assert.deepEqual(run(''), ['ssh']);
});

test('a wake request starts the server of Bionic and the tunnel', posix, () => {
  const calls = run('wake');
  assert.equal(calls[0], 'ssh');
  assert.ok(calls.includes('lms server start'), calls.join('|'));
  assert.ok(calls.includes('tunnel'), calls.join('|'));
});

// 8.43, laptop side: deploy/laptop/bionic-tunnel.sh starts Bionic's server
// (BIONIC_LMS, its own `lms`) before each tunnel round, so a laptop that is
// on lends its model without anyone opening Bionic; the model itself loads
// at the first request and unloads when idle (Bionic's own TTL).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../deploy/laptop/bionic-tunnel.sh', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

test('the tunnel starts Bionic\'s server before each round', { skip: process.platform === 'win32' && 'POSIX shell fakes' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-tunnel-'));
  const calls = join(dir, 'calls');
  for (const name of ['ssh', 'lms']) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, 'public.env'), `VM_SSH=vm\nVM_KEY=key\nBIONIC_LMS=${join(dir, 'lms')}\n`);
  const run = spawnSync('bash', [script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ITSACV_PUBLIC_ENV: join(dir, 'public.env'), ITSACV_TUNNEL_ROUNDS: '2', ITSACV_TUNNEL_PAUSE: '0' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = readFileSync(calls, 'utf8').trim().split('\n').map((line) => line.split(' ')[0]);
  assert.deepEqual(lines, ['lms', 'ssh', 'ssh', 'lms', 'ssh', 'ssh']);
});

// 2026-10-05: four tunnels ran at once (session tasks whose shells were
// stopped, their scripts not); each round freed the VM's ports, cutting
// the others, and restarted Bionic: the local model failed "Peer
// disconnected". A second tunnel now leaves at once.
test('a second tunnel leaves at once while the first is alive', { skip: process.platform === 'win32' && 'POSIX shell fakes' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-tunnel-'));
  const calls = join(dir, 'calls');
  for (const name of ['ssh', 'lms']) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, 'public.env'), `VM_SSH=vm\nVM_KEY=key\nBIONIC_LMS=${join(dir, 'lms')}\n`);
  const alive = spawnSync('bash', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(dir, 'tunnel.pid'), `${alive}\n`);
  try {
    const run = spawnSync('bash', [script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ITSACV_PUBLIC_ENV: join(dir, 'public.env'), ITSACV_TUNNEL_ROUNDS: '2', ITSACV_TUNNEL_PAUSE: '0', ITSACV_TUNNEL_PIDFILE: join(dir, 'tunnel.pid') },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /already/);
    assert.equal(existsSync(calls), false, 'neither ssh nor lms was called');
  } finally {
    spawnSync('kill', [alive]);
  }
});

// The VM stack (deploy/vm-generator/compose.yaml) checks the router on the
// port it listens on: the image's own HEALTHCHECK asks 8787, the VM's
// router listens on 8789, and Docker called a working router unhealthy
// (seen 2026-10-05).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const compose = readFileSync(new URL('../deploy/vm-generator/compose.yaml', import.meta.url), 'utf8');

test('the VM router is health-checked on the port it listens on', () => {
  const router = compose.slice(compose.indexOf('  router:'), compose.indexOf('  generator:'));
  const listen = router.match(/"--listen", "127\.0\.0\.1:(\d+)"/)?.[1];
  assert.ok(listen, 'the router names its listen port');
  const health = router.match(/healthcheck:[\s\S]*?127\.0\.0\.1:(\d+)\/healthz/)?.[1];
  assert.equal(health, listen, 'the healthcheck asks the listen port');
});

// 2.31b: a comparison is one job per model: a queue of three refused it always.
test('the VM queue holds a whole comparison', () => {
  assert.ok(Number(compose.match(/--max-queued (\d+)/)?.[1]) >= 4, 'claude, gemini, openai, local');
});

// A file mounted alone keeps the inode it was mounted with: when the owner
// replaced profile.json on the VM, the generator kept reading the old one
// against the new sources/, and every run failed its quote check (seen
// 2026-11-06). Only directories are mounted.
test('the VM generator mounts directories only, never a file alone', () => {
  const generator = compose.slice(compose.indexOf('  generator:'));
  const mounts = [...generator.matchAll(/^\s+- \$\{DATA[^}]*\}\/([^:]+):(\/data\/[^:\s]+)/gm)];
  assert.ok(mounts.length >= 2, 'the generator mounts its data');
  for (const [, source, target] of mounts) assert.ok(!/\.\w+$/.test(source), `${source} -> ${target} is a file`);
  const profile = generator.match(/ITSACV_PROFILE: (\S+)/)?.[1];
  assert.ok(mounts.some(([, , target]) => profile.startsWith(`${target}/`)), 'the profile is read inside a mounted directory');
});

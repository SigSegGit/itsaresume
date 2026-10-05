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

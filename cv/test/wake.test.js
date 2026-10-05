// 8.44: the local model, asked for while it sleeps, is woken through the
// laptop's watcher (deploy/laptop/wake-watcher.sh): the generator leaves a
// request in <out>/wake/, the watcher (which marks the laptop seen there at
// each round) starts Bionic and the tunnel, and the job waits, then runs:
// nobody types the offer again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocal, laptopAwake, requestWake, WAKE_DIR } from '../src/wake.js';

const local = (state) => [{ name: 'bionic', kind: 'lm-studio', state }];
const QUICK = { every: 5, max: 200 };

function outDir({ seenAgo } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'itsacv-wake-'));
  if (seenAgo !== undefined) {
    mkdirSync(join(out, WAKE_DIR), { recursive: true });
    const seen = join(out, WAKE_DIR, 'laptop-seen');
    writeFileSync(seen, '');
    const at = Date.now() / 1000 - seenAgo;
    utimesSync(seen, at, at);
  }
  return out;
}

test('the laptop is awake when its watcher marked it within three minutes', () => {
  assert.equal(laptopAwake(outDir({ seenAgo: 30 })), true);
  assert.equal(laptopAwake(outDir({ seenAgo: 600 })), false);
  assert.equal(laptopAwake(outDir()), false);
});

test('a request to wake is a file the watcher takes', () => {
  const out = outDir();
  requestWake(out);
  assert.ok(existsSync(join(out, WAKE_DIR, 'local')));
});

test('a local model already up is used at once, with no step', async () => {
  const steps = [];
  await ensureLocal({ out: outDir(), backends: async () => local('up'), onStep: (step) => steps.push(step), wait: QUICK });
  assert.deepEqual(steps, []);
});

test('a sleeping local model on an awake laptop is woken, and the job waits for it', async () => {
  const out = outDir({ seenAgo: 10 });
  const states = ['down', 'down', 'up'];
  const steps = [];
  await ensureLocal({ out, backends: async () => local(states.shift() ?? 'up'), onStep: (step, detail) => steps.push([step, detail?.note]), wait: QUICK });
  assert.equal(steps[0][0], 'wake');
  assert.match(steps[0][1], /réveil/i);
  assert.ok(existsSync(join(out, WAKE_DIR, 'local')), 'the request was left');
});

test('a laptop off, or a model that never wakes, fails the job plainly', async () => {
  await assert.rejects(
    ensureLocal({ out: outDir(), backends: async () => local('down'), onStep: () => {}, wait: QUICK }),
    /portable éteint ou hors ligne/,
  );
  await assert.rejects(
    ensureLocal({ out: outDir({ seenAgo: 10 }), backends: async () => local('down'), onStep: () => {}, wait: QUICK }),
    /ne s’est pas réveillée/,
  );
});

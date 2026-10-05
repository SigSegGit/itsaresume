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

// Through serve() itself: a job for the local model on a laptop that is
// off fails plainly, without calling any model.
test('serve() runs a local job through the wake check', async () => {
  const { createServer } = await import('node:http');
  const { serve } = await import('../src/serve.js');
  const stand = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/status' ? { contract: '1.1', backends: local('down') } : { contract: '1.1', status: 'ok' }));
  });
  await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
  const out = outDir();
  let called = false;
  const server = await serve({ profile: new URL('./fixtures/profile.synthetic.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), out, url: `http://127.0.0.1:${stand.address().port}`, port: 0, useWord: false, llm: async () => { called = true; return {}; } });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = (await (await fetch(base)).text()).match(/name="csrf-token" content="([0-9a-f]+)"/)[1];
    const posted = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ offers: [{ title: 'SRE', text: 'Senior SRE. Kubernetes, Terraform, on-call.' }], model: 'local' }) });
    assert.equal(posted.status, 202);
    let job;
    for (let i = 0; i < 200 && job?.status !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      [job] = await (await fetch(`${base}/api/jobs`)).json();
    }
    assert.equal(job?.status, 'failed', JSON.stringify(job));
    assert.match(job.error, /portable éteint ou hors ligne/);
    assert.equal(called, false, 'no model was asked');
  } finally {
    server.closeAllConnections();
    server.close();
    stand.close();
  }
});

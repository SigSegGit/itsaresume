// 2.31a (the owner, 2026-11-06): a run's name from the offer's first words
// is not telling ("L'entreprise", "suite-a-notre-echange…"). A name typed
// before the run names its folder; a run can be renamed afterwards, and the
// new name is kept beside it (title.txt). Both optional.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runName } from '../src/run.js';
import { createApp } from '../src/server.js';

const NOW = new Date('2026-11-06T13:05:18Z');
const OFFER = "L'entreprise\nFintech de gestion.\nMissions : sécuriser l'IaC.";

test('a run is named after the name typed for it, else the offer\'s first line', () => {
  assert.equal(runName(OFFER, NOW), '20261106-130518-l-entreprise');
  assert.equal(runName(OFFER, NOW, 'Fintech — DevSecOps AWS'), '20261106-130518-fintech-devsecops-aws');
  assert.equal(runName(OFFER, NOW, '  '), '20261106-130518-l-entreprise', 'a blank name is no name');
});

const TOKEN = 'c'.repeat(48);

async function start(t, tailored = []) {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-naming-'));
  const app = createApp({
    token: TOKEN,
    deps: {
      status: async () => ({ profile: { name: 'Alex' }, router: { up: true }, layout: { word: false } }),
      split: async () => ({ offers: [], repairs: [] }),
      tailor: async ({ offer, title, onStep }) => {
        tailored.push(title);
        onStep('done');
        return { dir, name: 'run-1', report: '# Fit', analysis: {}, view: { files: [], fit: { score: 50, verdict: 'go' } }, page: null, offer };
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  return { port: app.server.address().port, dir };
}

function call(port, { method = 'GET', path = '/', body } = {}) {
  const headers = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'X-CSRF-Token': TOKEN, 'Content-Type': 'application/json' };
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function done(port) {
  for (let i = 0; i < 200; i += 1) {
    const jobs = JSON.parse((await call(port, { path: '/api/jobs' })).text);
    if (jobs.length && jobs.every((job) => job.status === 'done')) return jobs;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the jobs never finished');
}

test('the name typed before the run reaches the run; none when none was typed', async (t) => {
  const tailored = [];
  const { port } = await start(t, tailored);
  await call(port, { method: 'POST', path: '/api/jobs', body: { offers: [{ title: 'Fintech DevSecOps', text: OFFER }, { text: OFFER }] } });
  await done(port);
  assert.deepEqual(tailored.sort(), ['Fintech DevSecOps', undefined].sort());
});

test('a run can be renamed after it ran, the name kept beside it', async (t) => {
  const { port, dir } = await start(t);
  await call(port, { method: 'POST', path: '/api/jobs', body: { offers: [{ text: OFFER }] } });
  const [job] = await done(port);
  const renamed = await call(port, { method: 'POST', path: `/api/jobs/${job.id}/title`, body: { title: 'Fintech — DevSecOps AWS' } });
  assert.equal(renamed.status, 200);
  assert.equal(JSON.parse((await call(port, { path: '/api/jobs' })).text)[0].title, 'Fintech — DevSecOps AWS');
  assert.equal(readFileSync(join(dir, 'title.txt'), 'utf8'), 'Fintech — DevSecOps AWS\n');

  assert.equal((await call(port, { method: 'POST', path: `/api/jobs/${job.id}/title`, body: { title: '<script>x</script>\n' } })).status, 400, 'not a plain name');
  assert.equal((await call(port, { method: 'POST', path: `/api/jobs/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/title`, body: { title: 'x' } })).status, 404);
  assert.equal(readFileSync(join(dir, 'title.txt'), 'utf8'), 'Fintech — DevSecOps AWS\n', 'a refused name changes nothing');
  assert.ok(existsSync(dir));
});

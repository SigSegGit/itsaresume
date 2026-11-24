// 2026-11-24 (the owner): free CVs for people met on LinkedIn, in exchange
// for their opinion. The CV page asks it; the server keeps it beside the
// runs (feedback.jsonl, the owner's alone), named by the run and its
// invitation. The A4 page also follows the palette the run was made with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { appendFeedback } from '../src/feedback.js';

const TOKEN = 'd'.repeat(48);

async function start(t, kept) {
  const app = createApp({
    token: TOKEN,
    deps: {
      status: async () => ({ profile: { name: 'Alex' }, router: { up: true }, layout: { word: false } }),
      split: async () => ({ offers: [], repairs: [] }),
      tailor: async ({ offer, onStep }) => {
        onStep('done');
        return { dir: tmpdir(), name: 'run-1', report: '# Fit', analysis: {}, view: { files: [], fit: { score: 50, verdict: 'go' } }, page: { experiences: [] }, offer };
      },
      feedback: (entry) => kept.push(entry),
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  return app.server.address().port;
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

async function oneJob(port, style) {
  await call(port, { method: 'POST', path: '/api/jobs', body: { offers: [{ title: 'Offre test', text: 'SRE, Kubernetes, Terraform.' }], ...(style ? { style } : {}) } });
  for (let i = 0; i < 200; i += 1) {
    const jobs = JSON.parse((await call(port, { path: '/api/jobs' })).text);
    if (jobs.length && jobs.every((job) => job.status === 'done')) return jobs[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the job never finished');
}

test('an opinion on a CV: a rating 1-5 and a short comment, kept with the run\'s name', async (t) => {
  const kept = [];
  const port = await start(t, kept);
  const job = await oneJob(port);
  const path = `/api/jobs/${job.id}/feedback`;
  assert.equal((await call(port, { method: 'POST', path, body: { rating: 4, comment: '  Clair, mais la 2e expérience est trop courte.  ' } })).status, 200);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].job, job.id);
  assert.equal(kept[0].title, 'Offre test');
  assert.equal(kept[0].rating, 4);
  assert.equal(kept[0].comment, 'Clair, mais la 2e expérience est trop courte.');
  assert.match(kept[0].at, /^\d{4}-\d\d-\d\dT/);
  for (const body of [{ rating: 0 }, { rating: 6 }, { rating: 3.5 }, { rating: '5' }, { rating: 5, comment: 'x'.repeat(2001) }]) {
    assert.equal((await call(port, { method: 'POST', path, body })).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await call(port, { method: 'POST', path: '/api/jobs/00000000-0000-0000-0000-000000000000/feedback', body: { rating: 5 } })).status, 404);
  assert.equal(kept.length, 1, 'nothing kept from a refused opinion');
});

test('feedback.jsonl: one JSON line per opinion, the owner\'s alone', () => {
  const out = mkdtempSync(join(tmpdir(), 'itsacv-feedback-'));
  appendFeedback(out, { job: 'a', rating: 5, comment: 'ok' });
  appendFeedback(out, { job: 'b', rating: 2, comment: 'ligne\nsuivante' });
  const lines = readFileSync(join(out, 'feedback.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((line) => JSON.parse(line).job), ['a', 'b']);
  if (process.platform !== 'win32') assert.equal(statSync(join(out, 'feedback.jsonl')).mode & 0o777, 0o600);
});

test('4.x: the A4 page data carries the palette the run was made with', async (t) => {
  const port = await start(t, []);
  const job = await oneJob(port, { palette: 'foret' });
  assert.equal(JSON.parse((await call(port, { path: `/api/jobs/${job.id}/page` })).text).palette, 'foret');
});

test('itsacv invite --feedback: the opinions per invitation, mean rating, newest comments first', async () => {
  const { feedbackByInvite } = await import('../src/feedback.js');
  const lines = [
    { at: '2026-11-24T10:00:00Z', invite: 'Sam D.', title: 'SRE', rating: 4, comment: 'Clair.' },
    { at: '2026-11-25T10:00:00Z', invite: 'Sam D.', title: 'DevOps', rating: 2, comment: 'Trop long.\nVraiment.' },
    { at: '2026-11-25T11:00:00Z', invite: null, title: 'Cloud', rating: 5, comment: '' },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\nnot json\n';
  assert.equal(feedbackByInvite(lines), [
    'Sam D.\t2 opinions\tmean 3.0/5',
    '  2026-11-25\t2/5\tDevOps\tTrop long. Vraiment.',
    '  2026-11-24\t4/5\tSRE\tClair.',
    '(no invitation)\t1 opinion\tmean 5.0/5',
    '  2026-11-25\t5/5\tCloud\t',
    '',
  ].join('\n'));
  const out = mkdtempSync(join(tmpdir(), 'itsacv-feedback-cli-'));
  appendFeedback(out, { at: '2026-11-24T10:00:00Z', invite: 'Ana', title: 'SRE', rating: 5, comment: 'Top' });
  const cli = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, [cli, 'invite', '--feedback', '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Ana\t1 opinion\tmean 5\.0\/5\n {2}2026-11-24\t5\/5\tSRE\tTop\n$/);
});

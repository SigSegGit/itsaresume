// 2026-11-24: the owner's applications, tracked on his own page. Each run
// folder of <out> is an application: its status (to send, sent, interview,
// offer, rejected), the day it changed, the day it was sent, a short note,
// kept in the folder (application.json), so a restart loses nothing. Never
// on the public page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicationsCsv, listApplications, setApplication, weekly, STATUSES } from '../src/applications.js';
import { createApp } from '../src/server.js';

function outWithRuns() {
  const out = mkdtempSync(join(tmpdir(), 'itsacv-apps-'));
  const run = (name, score, files = {}) => {
    const dir = join(out, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'analysis.json'), JSON.stringify({ fit: { score, verdict: 'good' }, requirements: [] }));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  };
  run('20261120-090000-ingenieur-sre', 80, { 'offer.txt': 'Ingénieur SRE\nChez Fintech.' });
  run('20261122-100000-devops', 55, { 'title.txt': 'Fintech — DevOps AWS\n' });
  mkdirSync(join(out, '2026-10-29-compare'));
  mkdirSync(join(out, '20261123-110000-rejected-run'));
  return out;
}

test('every run folder with an analysis is an application, newest first, "to send" until told', () => {
  const out = outWithRuns();
  const rows = listApplications(out);
  assert.deepEqual(rows.map((row) => row.run), ['20261122-100000-devops', '20261120-090000-ingenieur-sre']);
  assert.equal(rows[0].title, 'Fintech — DevOps AWS', 'the name given to the run first');
  assert.equal(rows[1].title, 'Ingénieur SRE', 'else the offer\'s first line');
  assert.equal(rows[1].date, '2026-11-20');
  assert.equal(rows[1].score, 80);
  assert.equal(rows[1].status, 'todo');
  assert.deepEqual(STATUSES, ['todo', 'sent', 'interview', 'offer', 'rejected']);
});

test('a status is kept in the run folder; the day it was sent stays when it moves on', () => {
  const out = outWithRuns();
  const run = '20261120-090000-ingenieur-sre';
  setApplication(out, run, { status: 'sent', note: '  via le site\n de Fintech ' }, Date.parse('2026-11-21T09:00:00Z'));
  setApplication(out, run, { status: 'interview' }, Date.parse('2026-11-25T09:00:00Z'));
  const saved = JSON.parse(readFileSync(join(out, run, 'application.json'), 'utf8'));
  assert.deepEqual(saved, { status: 'interview', at: '2026-11-25', sent: '2026-11-21', note: 'via le site de Fintech' });
  const row = listApplications(out).find((entry) => entry.run === run);
  assert.equal(row.status, 'interview');
  assert.equal(row.sent, '2026-11-21');
});

test('a status change is refused for an unknown status, a long note, or a folder that is not a run', () => {
  const out = outWithRuns();
  assert.throws(() => setApplication(out, '20261120-090000-ingenieur-sre', { status: 'won' }), /status/);
  assert.throws(() => setApplication(out, '20261120-090000-ingenieur-sre', { status: 'sent', note: 'x'.repeat(501) }), /note/);
  for (const run of ['../etc', '2026-10-29-compare', '20261123-110000-rejected-run', '20261199-000000-nope']) {
    assert.throws(() => setApplication(out, run, { status: 'sent' }), /run/, run);
  }
});

test('applications sent per week, the last eight weeks, Monday first', () => {
  const rows = [
    { sent: '2026-11-17' }, { sent: '2026-11-23' }, { sent: '2026-11-24' }, { sent: '2026-09-01' }, { sent: null },
  ];
  const weeks = weekly(rows, Date.parse('2026-11-25T12:00:00Z'));
  assert.equal(weeks.length, 8);
  assert.deepEqual(weeks.at(-1), { week: '2026-11-23', sent: 2 });
  assert.deepEqual(weeks.at(-2), { week: '2026-11-16', sent: 1 });
  assert.equal(weeks.reduce((sum, week) => sum + week.sent, 0), 3, 'older than eight weeks: not counted');
});

test('the CSV: one row per application, a cell never opens as a formula', () => {
  const csv = applicationsCsv([{ run: 'r1', date: '2026-11-20', title: '=HYPERLINK("x")', score: 80, status: 'sent', at: '2026-11-21', sent: '2026-11-21', note: 'a, b' }]);
  const [head, row] = csv.trim().split('\n');
  assert.equal(head, 'run,date,title,score,status,since,sent,note');
  assert.match(row, /^r1,2026-11-20,"'=HYPERLINK\(""x""\)",80,sent,2026-11-21,2026-11-21,"a, b"$/);
});

const TOKEN = 'e'.repeat(48);
function call(port, { method = 'GET', path = '/', body, host } = {}) {
  const headers = { Host: host ?? `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'X-CSRF-Token': TOKEN, 'Content-Type': 'application/json' };
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function serve(t, out, publicMode) {
  const app = createApp({
    token: TOKEN,
    ...(publicMode ? { publicMode } : {}),
    deps: {
      status: async () => ({ profile: { name: 'Alex' }, router: { up: true }, layout: { word: false } }),
      split: async () => ({ offers: [], repairs: [] }),
      tailor: async () => { throw new Error('no run here'); },
      applications: {
        list: () => listApplications(out),
        set: (run, change) => setApplication(out, run, change),
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  return app.server.address().port;
}

test('the owner\'s page reads and changes the applications; the CSV downloads', async (t) => {
  const out = outWithRuns();
  const port = await serve(t, out);
  const listed = JSON.parse((await call(port, { path: '/api/applications' })).text);
  assert.equal(listed.rows.length, 2);
  assert.equal(listed.weekly.length, 8);
  const changed = await call(port, { method: 'POST', path: '/api/applications/20261122-100000-devops', body: { status: 'sent', note: 'LinkedIn' } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(JSON.parse(changed.text).status, 'sent');
  assert.equal((await call(port, { method: 'POST', path: '/api/applications/20261122-100000-devops', body: { status: 'won' } })).status, 400);
  assert.equal((await call(port, { method: 'POST', path: '/api/applications/..%2F..%2Fetc', body: { status: 'sent' } })).status, 400);
  const csv = await call(port, { path: '/api/applications.csv' });
  assert.match(csv.type, /^text\/csv/);
  assert.match(csv.text, /20261122-100000-devops,2026-11-22,Fintech — DevOps AWS,55,sent,/);
});

test('the applications are never on the public page', async (t) => {
  const out = outWithRuns();
  const port = await serve(t, out, { host: 'cv.example.org', perDay: 5, perVisitorPerHour: 2, maxQueued: 3 });
  assert.equal((await call(port, { path: '/api/applications', host: 'cv.example.org' })).status, 404);
  assert.equal((await call(port, { path: '/api/applications.csv', host: 'cv.example.org' })).status, 404);
  assert.equal((await call(port, { method: 'POST', path: '/api/applications/20261122-100000-devops', host: 'cv.example.org', body: { status: 'sent' } })).status, 404);
});

test('the owner\'s page has its applications card: filter, status, note, weekly line, CSV', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(html, /<section class="card" id="applications-card"[^>]*hidden>/);
  assert.match(html, /<select id="applications-filter"/);
  assert.match(html, /href="\/api\/applications\.csv"/);
  assert.match(app, /api\(`\/api\/applications\/\$\{encodeURIComponent\(row\.run\)\}`, \{ status: select\.value, note: note\.value \}\)/);
  assert.match(app, /if \(!open\) showApplications\(\);/);
});

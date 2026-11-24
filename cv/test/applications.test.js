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
import { applicationsCsv, cvFile, draftFor, listApplications, setApplication, weekly, STATUSES } from '../src/applications.js';
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
  assert.deepEqual(saved, { status: 'interview', at: '2026-11-25', sent: '2026-11-21', note: 'via le site de Fintech', contact: '', channel: null });
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
  assert.equal(head, 'run,date,title,score,status,since,sent,note,contact,channel');
  assert.match(row, /^r1,2026-11-20,"'=HYPERLINK\(""x""\)",80,sent,2026-11-21,2026-11-21,"a, b",,$/);
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
        file: (run, name) => cvFile(out, run, name),
        draft: (run, lang) => draftFor(out, run, { name: 'Alex Martin' }, lang),
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
  const posted = await call(port, { method: 'POST', path: '/api/applications/20261122-100000-devops', host: 'cv.example.org', body: { status: 'sent' } });
  assert.ok([403, 404].includes(posted.status), `refused, not ${posted.status}`);
});

test('the owner\'s page has its applications card: filter, status, note, weekly line, CSV', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(html, /<section class="card" id="applications-card"[^>]*hidden>/);
  assert.match(html, /<select id="applications-filter"/);
  assert.match(html, /href="\/api\/applications\.csv"/);
  assert.match(app, /api\(`\/api\/applications\/\$\{encodeURIComponent\(row\.run\)\}`, \{ status: select\.value, note: note\.value, contact: contact\.value, channel: channel\.value \}\)/);
  assert.match(app, /if \(!open\) showApplications\(\);/);
});

// 2026-11-24 (2): what to follow up, the response rate, each CV's files,
// and the same list in the terminal.
test('an application sent over a week ago with no news is to follow up; the summary counts it', async () => {
  const { followUp, summary } = await import('../src/applications.js');
  const now = Date.parse('2026-11-30T09:00:00Z');
  const rows = [
    { status: 'sent', at: '2026-11-20', sent: '2026-11-20' },
    { status: 'sent', at: '2026-11-25', sent: '2026-11-25' },
    { status: 'interview', at: '2026-11-21', sent: '2026-11-10' },
    { status: 'rejected', at: '2026-11-22', sent: '2026-11-12' },
    { status: 'todo', at: null, sent: null },
  ];
  assert.deepEqual(rows.map((row) => followUp(row, now)), [true, false, false, false, false]);
  assert.deepEqual(summary(rows, now), { total: 5, sent: 4, interviews: 1, rate: 25, followUps: 1 });
  assert.equal(summary([], now).rate, null, 'no rate before anything is sent');
});

test('each application lists its CV files; the owner\'s page serves them, nothing else', async (t) => {
  const out = outWithRuns();
  writeFileSync(join(out, '20261120-090000-ingenieur-sre', 'cv.pdf'), '%PDF-1.7 fake');
  const row = listApplications(out).find((entry) => entry.run === '20261120-090000-ingenieur-sre');
  assert.deepEqual(row.files, ['cv.pdf']);
  assert.equal(cvFile(out, '20261120-090000-ingenieur-sre', 'analysis.json'), null, 'never another file of the run');
  const port = await serve(t, out);
  const pdf = await call(port, { path: '/api/applications/20261120-090000-ingenieur-sre/cv.pdf' });
  assert.equal(pdf.status, 200);
  assert.match(pdf.type, /^application\/pdf/);
  assert.equal((await call(port, { path: '/api/applications/20261120-090000-ingenieur-sre/cv.docx' })).status, 404, 'not made');
  assert.equal((await call(port, { path: '/api/applications/20261120-090000-ingenieur-sre/analysis.json' })).status, 404, 'only the CV');
  assert.equal((await call(port, { path: '/api/applications/..%2F..%2Fetc/cv.pdf' })).status, 404);
  const listed = JSON.parse((await call(port, { path: '/api/applications' })).text);
  assert.equal(typeof listed.summary.total, 'number');
  assert.ok(listed.rows.every((entry) => typeof entry.follow_up === 'boolean'));
});

test('itsacv applications: the list in the terminal, or as CSV', async () => {
  const out = outWithRuns();
  setApplication(out, '20261120-090000-ingenieur-sre', { status: 'sent' }, Date.parse('2026-11-01T09:00:00Z'));
  const cli = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const { spawnSync } = await import('node:child_process');
  const text = spawnSync(process.execPath, [cli, 'applications', '--out', out], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^2026-11-22\ttodo\t55\tFintech — DevOps AWS\n2026-11-20\tsent\t80\tIngénieur SRE\tfollow up\n/);
  assert.match(text.stdout, /2 applications, 1 sent, 0 interviews, 1 to follow up\n$/);
  const csv = spawnSync(process.execPath, [cli, 'applications', '--csv', '--out', out], { encoding: 'utf8' });
  assert.match(csv.stdout, /^run,date,title,score,status,since,sent,note,contact,channel\n/);
});

test('the applications card shows the summary, the follow-ups and the CV links', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /row\.follow_up \? h\('span', \{ class: 'chip warn', text: t\('À relancer'\) \}\) : null/);
  assert.match(app, /href: `\/api\/applications\/\$\{encodeURIComponent\(row\.run\)\}\/\$\{file\}`/);
  assert.match(app, /t\('\{v0\} candidatures · {v1} envoyées · {v2} entretiens \(\{v3\}\) · {v4} à relancer'/);
});

// 2026-11-24 (3): who the application went to and how, the week for the
// coaching sessions, and a follow-up written from the facts only.
test('a contact and a channel per application, in the CSV too', async () => {
  const { CHANNELS } = await import('../src/applications.js');
  const out = outWithRuns();
  const run = '20261120-090000-ingenieur-sre';
  setApplication(out, run, { status: 'sent', contact: '  Claire M., RH ', channel: 'linkedin' }, Date.parse('2026-11-21T09:00:00Z'));
  setApplication(out, run, { status: 'interview' }, Date.parse('2026-11-25T09:00:00Z'));
  const row = listApplications(out).find((entry) => entry.run === run);
  assert.equal(row.contact, 'Claire M., RH', 'kept when a later change does not say');
  assert.equal(row.channel, 'linkedin');
  assert.deepEqual(CHANNELS, ['linkedin', 'email', 'site', 'phone', 'other']);
  assert.throws(() => setApplication(out, run, { status: 'sent', channel: 'pigeon' }), /channel/);
  assert.throws(() => setApplication(out, run, { status: 'sent', contact: 'x'.repeat(121) }), /contact/);
  assert.match(applicationsCsv(listApplications(out)), /^run,date,title,score,status,since,sent,note,contact,channel\n/);
});

test('the week in one screen: sent, answers, follow-ups, and what moved', async () => {
  const { weekReport } = await import('../src/applications.js');
  const now = Date.parse('2026-11-27T12:00:00Z');
  const rows = [
    { date: '2026-11-24', title: 'SRE', status: 'sent', at: '2026-11-24', sent: '2026-11-24' },
    { date: '2026-11-10', title: 'DevOps', status: 'interview', at: '2026-11-25', sent: '2026-11-12' },
    { date: '2026-11-01', title: 'Cloud', status: 'sent', at: '2026-11-03', sent: '2026-11-03' },
    { date: '2026-11-26', title: 'Data', status: 'todo', at: null, sent: null },
    { date: '2026-10-30', title: 'Old', status: 'rejected', at: '2026-11-05', sent: '2026-11-01' },
  ];
  assert.equal(weekReport(rows, now), [
    'Week of 2026-11-23',
    '  1 sent, 1 answered (1 interview or offer), 1 to follow up, 1 CV made and not sent',
    '  moved this week:',
    '    2026-11-25\tinterview\tDevOps',
    '    2026-11-24\tsent\tSRE',
    '',
  ].join('\n'));
});

test('a follow-up draft says only what the application and the profile hold', async () => {
  const { followUpDraft } = await import('../src/applications.js');
  const row = { title: 'Ingénieur SRE', sent: '2026-11-20', contact: 'Claire M., RH' };
  const fr = followUpDraft(row, { name: 'Alex Martin' }, 'fr');
  assert.match(fr, /^Bonjour Claire M\.,/);
  assert.match(fr, /« Ingénieur SRE »/);
  assert.match(fr, /20\/11\/2026/);
  assert.match(fr, /Alex Martin$/);
  const en = followUpDraft({ title: 'SRE', sent: '2026-11-20' }, { name: 'Alex Martin' }, 'en');
  assert.match(en, /^Hello,/);
  assert.match(en, /"SRE"/);
  assert.doesNotMatch(fr + en, /undefined|null/);
});

test('the owner\'s page gives each application its follow-up draft', async (t) => {
  const out = outWithRuns();
  setApplication(out, '20261120-090000-ingenieur-sre', { status: 'sent' }, Date.parse('2026-11-01T09:00:00Z'));
  const port = await serve(t, out);
  const got = await call(port, { path: '/api/applications/20261120-090000-ingenieur-sre/follow-up?lang=fr' });
  assert.equal(got.status, 200, got.text);
  assert.match(JSON.parse(got.text).text, /Ingénieur SRE/);
  assert.equal((await call(port, { path: '/api/applications/nope/follow-up' })).status, 404);
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /navigator\.clipboard\.writeText\(\(await api\(`\/api\/applications\/\$\{encodeURIComponent\(row\.run\)\}\/follow-up\?lang=\$\{lang\}`\)\)\.text\)/);
});

// The page's own code, read as text. The server's CSP allows only our own
// script and stylesheet, and the script only ever writes text into the page:
// a model's answer or an offer containing markup stays text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPage } from './fixtures/page.js';

const web = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');

test('the script never parses HTML nor evaluates code', () => {
  const app = web('app.js');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout(\'', 'createContextualFragment', 'srcdoc']) {
    assert.ok(!app.includes(sink), `app.js uses ${sink}`);
  }
  assert.ok(!/setAttribute\(\s*['"]on/.test(app), 'no event handler attribute');
  assert.ok(!/\.href\s*=/.test(app.replace(/href:\s*`\/api\/jobs\/\$\{job\.id\}\/files\/\$\{name\}`/, '')), 'no link built from data');
});

test('the page holds no inline script, style or handler, and loads nothing from elsewhere', () => {
  const html = web('index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'inline script');
  assert.ok(!/\sstyle=/.test(html), 'inline style');
  assert.ok(!/\son[a-z]+=/.test(html), 'inline handler');
  const urls = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(urls.sort(), ['/app.js', '/favicon.svg', '/icon-180.png', '/style.css']);
  assert.ok(!/@import|url\(\s*['"]?https?:/.test(web('style.css')), 'no remote stylesheet or font');
});

test('the page is responsive', () => {
  assert.ok(web('index.html').includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.match(web('style.css'), /@media \(max-width: \d+px\)/);
});

// 2026-10-05: `.model { display: block }` showed the hidden, empty profile
// choice on the public page. A class's display must never beat `hidden`.
test('an element hidden by its attribute stays hidden, whatever its class displays', () => {
  const css = web('style.css');
  const hiddenWithClass = [...web('index.html').matchAll(/<\w+[^>]*\sclass="([^"]+)"[^>]*\shidden[\s>]/g)].map((found) => found[1]);
  assert.ok(hiddenWithClass.includes('model'), 'the profile row is a hidden .model');
  assert.match(css, /\.model\s*\{[^}]*display:\s*block/, 'and .model sets a display');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('the footer never claims the analysis stays local: it names Claude and the local fallback', () => {
  const foot = web('index.html').match(/<footer[\s\S]*?<\/footer>/)[0];
  assert.ok(!/100\s*%\s*local/i.test(foot), 'claims 100 % local');
  assert.match(foot, /Claude/);
  assert.match(foot, /IA locale/);
});

/* ---------- The page's script, run over a minimal DOM (test/fixtures/page.js) ---------- */

const STATUS = { profile: { name: 'Alex MARTIN', skills: 7, verdicts: { verified: 2 } }, router: { up: true }, layout: { word: true } };

/** A finished job as GET /api/jobs/:id returns it. */
const detail = (extra = {}) => ({
  id: 'j1', title: 'Senior SRE', status: 'done', steps: [], error: null,
  fit: { score: 72, verdict: 'good', model_score: null, qualification: { level: 'partial', gaps: [] }, rationale: '' },
  headline: 'Senior SRE', summary: ['SRE running PostgreSQL in production.'], requirements: [], verification: [], flags: [], older: [],
  repairs: [], backend: 'stub', attempts: 1, layout: null, ats: null, skipped: null, files: ['cv.docx', 'report.md'], ...extra,
});

/** The page over a server that has these jobs, finished with `details`. */
function pageWith(jobs, details = {}, routes = {}) {
  return loadPage(async (path, init) => {
    if (routes[path]) return routes[path](init);
    if (path === '/api/status') return { body: STATUS };
    if (path === '/api/jobs') return { body: jobs };
    const id = path.match(/^\/api\/jobs\/([^/]+)$/)?.[1];
    if (id && details[id]) return { body: details[id] };
    return { status: 404, body: { error: 'not found' } };
  });
}

test('a card whose layout was skipped says what was not done, and why', async () => {
  const skipped = { reason: 'layout, PDF and ATS check skipped: Word failed (Word stopped (exit code 1))', failed: true };
  const page = pageWith([{ id: 'j1', title: 'Senior SRE', status: 'done', steps: [], error: null }], { j1: detail({ skipped }) });
  await page.settle();
  assert.match(page.$('jobs').textContent, /Non fait : layout, PDF and ATS check skipped: Word failed \(Word stopped \(exit code 1\)\)/);
  page.close();
});

test('a card says when the offer held instructions, which were not applied, and shows no text of them', async () => {
  const jobs = [{ id: 'j1', title: 'Senior SRE', status: 'done', steps: [], error: null }];
  const flagged = pageWith(jobs, { j1: detail({ offer_instructions: true }) });
  await flagged.settle();
  assert.match(flagged.$('jobs').textContent, /Cette offre contient des consignes adressées au candidat ou à une IA : elles n'ont pas été appliquées\./);
  flagged.close();
  const plain = pageWith(jobs, { j1: detail({ offer_instructions: false }) });
  await plain.settle();
  assert.doesNotMatch(plain.$('jobs').textContent, /consignes adressées/);
  plain.close();
});

test('a finished card never shows a literal null', async () => {
  const page = pageWith([{ id: 'j1', title: 'Senior SRE', status: 'done', steps: [], error: null }], { j1: detail() });
  await page.settle();
  assert.doesNotMatch(page.$('jobs').textContent, /null/);
  page.close();
});

test('the status pill says the router answers, not that the model does', async () => {
  const page = pageWith([]);
  await page.settle();
  assert.match(page.$('status-router').textContent, /Routeur joignable/);
  assert.doesNotMatch(page.$('status-router').textContent, /Modèle/);
  page.close();
});

// A personal quality the profile holds no evidence for is not a "no": it is
// not scored, and the page says it is to be shown in interview.
test('a personal quality is never shown as a failed requirement', async () => {
  const requirements = [
    { name: 'Kubernetes', importance: 'must', match: 'no', never: true, note: '', skills: [], kind: 'skill' },
    { name: 'Pédagogie', importance: 'must', match: 'no', never: false, note: '', skills: [], kind: 'quality' },
  ];
  const page = pageWith([{ id: 'j1', title: 'Senior SRE', status: 'done', steps: [], error: null }], { j1: detail({ requirements }) });
  await page.settle();
  const text = page.$('jobs').textContent;
  assert.match(text, /Exigences de l’offre \(1\)/);
  assert.match(text, /Savoir-être, non notés \(1\)/);
  assert.match(text, /Pédagogie — à montrer en entretien : ton profil n’en dit rien encore/);
  page.close();
});

// Two offers pasted as one gave one CV scored against both (seen: the
// Architecte CV carried the AI Tech Lead offer's requirements).
test('a text holding two offers is not added as one', async () => {
  const page = pageWith([]);
  await page.settle();
  page.$('paste').value = 'Architecte\nContexte\nModernisation.\nMissions principales\nÉtudes.\n\nAI Tech Lead\nContexte\nGenAI.\nMission principale\nAccompagner.';
  page.$('add').click();
  assert.equal(page.$('offers').childNodes.length, 0);
  assert.match(page.$('offers-error').textContent, /plusieurs offres/);
  page.$('paste').value = 'Architecte\nContexte\nModernisation.\nMissions principales\nÉtudes.';
  page.$('add').click();
  assert.equal(page.$('offers').childNodes.length, 1);
  page.close();
});

test('a match the profile does not name is shown as the model reading, to verify, in French', async () => {
  const requirements = [
    { name: 'Cycles de delivery', importance: 'must', match: 'adjacent', judged: true, never: false, note: 'CI/CD et GitOps en production', skills: [{ name: 'GitOps', lab: false }], kind: 'skill' },
    { name: 'Kubernetes', importance: 'must', match: 'no', judged: false, never: true, note: 'never claimed (profile)', skills: [], kind: 'skill' },
  ];
  const fit = { score: 20, verdict: 'weak', qualification: { level: 'not-qualified', gaps: ['Cycles de delivery (to verify)', 'Kubernetes (never claimed)', 'Docker (lab only)'] } };
  const page = pageWith([{ id: 'j1', title: 'Senior SRE', status: 'done', steps: [], error: null }], { j1: detail({ requirements, fit }) });
  await page.settle();
  const text = page.$('jobs').textContent;
  assert.match(text, /à vérifier : CI\/CD et GitOps en production/);
  assert.match(text, /Cycles de delivery \(à vérifier\), Kubernetes \(jamais revendiqué\), Docker \(lab uniquement\)/);
  assert.doesNotMatch(text, /never claimed|lab only|to verify/);
  page.close();
});

test('the page sends its token with every call, reads included (in public mode it names the visitor)', async () => {
  const seen = [];
  const page = pageWith([], {}, { '/api/jobs': (init) => { seen.push(init?.headers?.['X-CSRF-Token']); return { body: [] }; } });
  await page.settle();
  assert.ok(seen.length > 0 && seen.every((given) => typeof given === 'string' && given.length > 0), JSON.stringify(seen));
  page.close();
});

test('in public mode the page offers one offer at a time, with no email splitting', async () => {
  const page = pageWith([], {}, { '/api/status': () => ({ body: { ...STATUS, public: true } }) });
  await page.settle();
  assert.equal(page.$('split').hidden, true);
  assert.match(page.$('drop-help').textContent, /une offre à la fois/i);
  assert.match(page.$('drop-help').textContent, /Alex MARTIN/);
  page.close();
});

// Regression of 2026-10-01: the public status lost `verdicts` and `truth`
// (the owner's assessment stays private) and the page read
// `profile.verdicts.verified`: "Statut indisponible", pills stuck. The page
// must render the public status as served.
test('the public status renders without the owner assessment', async () => {
  const publicStatus = { profile: { name: 'Alex Martin', skills: 12, lab: 2, never: 1 }, router: { up: true }, layout: { word: true }, public: true };
  const page = pageWith([], {}, { '/api/status': () => ({ body: publicStatus }) });
  await page.settle();
  assert.doesNotMatch(page.$('status-profile').textContent, /indisponible/);
  assert.match(page.$('status-profile').textContent, /Alex Martin · 12 compétences/);
  assert.match(page.$('status-router').textContent, /Routeur joignable/);
  assert.match(page.$('status-layout').textContent, /Word/);
  page.close();
});

test('the page lets the owner pick the model, and sends the choice with the offers', () => {
  const html = web('index.html');
  const select = html.match(/<select id="model"[\s\S]*?<\/select>/)?.[0] ?? '';
  assert.deepEqual([...select.matchAll(/value="([a-z]+)"/g)].map((m) => m[1]), ['auto', 'claude', 'local']);
  assert.match(web('app.js'), /api\('\/api\/jobs', \{ offers: [^\n]*, model: \$\('model'\)\.value[,} ]/);
});

test('an administrative condition is shown apart, to confirm, never as a failed requirement', async () => {
  const requirements = [
    { name: 'Kubernetes', importance: 'must', match: 'no', never: true, note: '', skills: [], kind: 'skill' },
    { name: 'Nationalité française', importance: 'must', match: 'no', never: false, note: '', skills: [], kind: 'condition' },
  ];
  const page = pageWith([{ id: 'j1', title: 'Réseau', status: 'done', steps: [], error: null }], { j1: detail({ requirements }) });
  await page.settle();
  const text = page.$('jobs').textContent;
  assert.match(text, /Exigences de l’offre \(1\)/);
  assert.match(text, /Conditions à confirmer, non notées \(1\)/);
  assert.match(text, /Nationalité française — à confirmer : ton profil n’en dit rien/);
  page.close();
});

// 4.1: the profile choice exists only where the owner has several profiles;
// the public status never lists them (server test), so the page hides it there.
test('the page offers a profile choice only when the status lists several, and sends the one chosen', async () => {
  const posted = [];
  const page = loadPage(async (path, init) => {
    if (path === '/api/status') return { body: { ...STATUS, profiles: ['default', 'bob'] } };
    if (path === '/api/jobs' && init?.method === 'POST') {
      posted.push(JSON.parse(init.body));
      return { status: 202, body: [] };
    }
    if (path === '/api/jobs') return { body: [] };
    return { status: 404, body: { error: 'not found' } };
  });
  await page.settle();
  assert.equal(page.$('profile-row').hidden, false);
  assert.deepEqual(page.$('profile').childNodes.map((option) => option.textContent), ['default', 'bob']);
  page.$('paste').value = 'Architecte\nContexte\nModernisation.\nMissions principales\nÉtudes.';
  page.$('add').click();
  page.$('profile').value = 'bob';
  page.$('generate').click();
  await page.settle();
  assert.equal(posted[0]?.profile, 'bob');
  page.close();
  const single = pageWith([]);
  await single.settle();
  assert.equal(single.$('profile-row').hidden, true, 'one profile: no choice');
  single.close();
});

// 8.43: the page applies the server's model menu and keeps it current; the
// menu's logic is src/models.js (test/models.test.js).
test('the page greys the models the server says cannot answer, and refreshes the menu', () => {
  const app = web('app.js');
  assert.match(app, /option\.disabled = !state\.available;/);
  assert.match(app, /button\.disabled = offers\.length === 0 \|\| !modelsReady;/);
  assert.match(app, /setInterval\?\.\(refreshStatus, \d+\)/);
  assert.match(app, /\$\('model'\)\.addEventListener\('focus', refreshStatus\)/);
});

// 2026-10-06: a queued job shows its place in its lane, refreshed by the poll.
test('the page shows a queued job its place in the queue', () => {
  const app = web('app.js');
  assert.match(app, /queued: \['', Number\.isInteger\(job\.position\) \? `en attente : \$\{job\.position === 1 \? 'prochain'/);
});

// 2026-10-06 (the owner's technical note): no minute is lost by seeing a
// job's progress 5 s late, and a local model's run lasts minutes. The page
// asks no more often than every 5 s, and a tab out of sight asks nothing.
const RUNNING = [{ id: 'j1', title: 'Senior SRE', status: 'running', steps: [] }];

test('a running job is asked about no more often than every 5 seconds', async () => {
  const page = pageWith(RUNNING);
  await page.settle();
  await page.tick();
  await page.tick();
  assert.ok(page.delays.length > 0, 'the page waits between two asks');
  assert.ok(page.delays.every((ms) => ms >= 5000), `delays: ${page.delays}`);
});

test('a tab out of sight asks nothing, and asks again when it is back in sight', async () => {
  const page = pageWith(RUNNING);
  await page.settle();
  page.document.hidden = true;
  const before = page.fetches.length;
  await page.tick();
  await page.tick();
  assert.equal(page.fetches.length, before, 'a hidden tab fetched');
  page.document.hidden = false;
  await page.tick();
  assert.ok(page.fetches.some((call, i) => i >= before && call.path === '/api/jobs'), 'a visible tab asks again');
});

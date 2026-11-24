// 2026-11-24: the LinkedIn outreach from the premium admin page. The owner
// made one invitation per person with `docker compose exec ... invite` over
// SSH; the admin page now makes, lists and revokes them, and shows each one's
// funnel (asked, made, opinions) and its comments. The invitations stay the
// generator's (<out>/invites.json, under its lock): the premium container
// mounts the same folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../premium/accounts.js';
import { createPremiumApp } from '../premium/server.js';
import { createInvite, funnelRows, outreachFunnel, outreachOf, revokeInvite } from '../src/invites.js';
import { QA_LOG } from '../src/qa.js';
import { FEEDBACK_FILE } from '../src/feedback.js';

const LOG = [
  { invite: 'Ana B.', status: 'done', at: '2026-11-20T10:00:00Z' },
  { invite: 'Ana B.', status: 'failed', at: '2026-11-21T10:00:00Z' },
  { invite: 'Bob C.', status: 'done', at: '2026-11-22T10:00:00Z' },
].map((entry) => JSON.stringify(entry)).join('\n');
const FEEDBACK = [
  { invite: 'Ana B.', rating: 4, comment: 'Clair', at: '2026-11-22T09:00:00Z' },
  { invite: 'Ana B.', rating: 2, comment: '', at: '2026-11-23T09:00:00Z' },
  { invite: null, rating: 5, comment: 'anonyme', at: '2026-11-23T09:00:00Z' },
].map((entry) => JSON.stringify(entry)).join('\n');

test('funnelRows: per invitation, live code, asked, made, opinions, mean, last activity, comments', () => {
  const invites = { aaa: { label: 'Ana B.' }, bbb: { label: 'Bob C.', revoked: true }, ccc: { label: 'Cleo D.' } };
  const rows = funnelRows(invites, `${LOG}\nnot json`, FEEDBACK);
  assert.deepEqual(rows.map((row) => row.label), ['Ana B.', 'Bob C.', 'Cleo D.']);
  const [ana, bob, cleo] = rows;
  assert.deepEqual({ ...ana, comments: undefined }, { label: 'Ana B.', live: true, code: 'aaa', asked: 2, made: 1, opinions: 2, mean: 3, last: '2026-11-23T09:00:00Z', comments: undefined });
  assert.deepEqual(ana.comments, [{ rating: 2, comment: '', at: '2026-11-23T09:00:00Z' }, { rating: 4, comment: 'Clair', at: '2026-11-22T09:00:00Z' }], 'newest first');
  assert.equal(bob.live, false);
  assert.equal(bob.code, null, 'a revoked invitation shows no code');
  assert.deepEqual({ asked: cleo.asked, opinions: cleo.opinions, mean: cleo.mean, last: cleo.last }, { asked: 0, opinions: 0, mean: null, last: null });
  // The CLI's --funnel reads the same rows.
  assert.equal(outreachFunnel(invites, LOG, FEEDBACK).split('\n')[0], 'Ana B.\tlive\t2 asked\t1 made\t2 opinions (3.0/5)\tlast 2026-11-23');
});

test('outreachOf: the rows from an out folder, empty when nothing was made yet', () => {
  const out = mkdtempSync(join(tmpdir(), 'outreach-'));
  try {
    assert.deepEqual(outreachOf(out), []);
    createInvite(out, 'Ana B.');
    writeFileSync(join(out, QA_LOG), LOG);
    writeFileSync(join(out, FEEDBACK_FILE), FEEDBACK);
    const [ana] = outreachOf(out);
    assert.equal(ana.opinions, 2);
    assert.match(ana.code, /^[0-9a-f]{24}$/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

async function serve(outreach) {
  const store = createStore(null);
  store.register('boss@example.org', 'long enough');
  const boss = store.login('boss@example.org', 'long enough').token;
  store.register('a@example.org', 'long enough');
  const buyer = store.login('a@example.org', 'long enough').token;
  const app = createPremiumApp({ store, analyse: async () => ({}), pageOf: () => ({}), profileOf: () => ({}), admins: ['boss@example.org'], outreach, mailer: { send: async () => {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, token, body) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return { server, call, boss, buyer, store };
}

test('the admin page makes, lists and revokes invitations; admins only; each action in the admin log', async () => {
  const out = mkdtempSync(join(tmpdir(), 'outreach-'));
  const { server, call, boss, buyer, store } = await serve({ out, host: 'cv.example.org' });
  try {
    assert.equal((await call('/api/admin/invites', buyer)).status, 403);
    assert.equal((await call('/api/admin/invites', buyer, { label: 'Eve' })).status, 403);
    assert.equal((await call('/api/admin/invites/revoke', buyer, { label: 'Eve' })).status, 403);

    const made = await call('/api/admin/invites', boss, { label: '  Ana B. ' });
    assert.equal(made.status, 200);
    assert.equal(made.json.label, 'Ana B.');
    assert.match(made.json.link, /^https:\/\/cv\.example\.org\/\?i=[0-9a-f]{24}$/);
    assert.equal((await call('/api/admin/invites', boss, { label: 'Ana B.' })).status, 409, 'one live invitation per label');
    assert.equal((await call('/api/admin/invites', boss, { label: 'x\ny' })).status, 400);

    writeFileSync(join(out, FEEDBACK_FILE), FEEDBACK);
    const listed = await call('/api/admin/invites', boss);
    assert.equal(listed.status, 200);
    const [ana] = listed.json.invitations;
    assert.equal(ana.link, made.json.link);
    assert.equal(ana.code, undefined, 'the link, not the bare code');
    assert.equal(ana.opinions, 2);

    assert.deepEqual((await call('/api/admin/invites/revoke', boss, { label: 'Ana B.' })).json, { revoked: 1 });
    assert.equal((await call('/api/admin/invites/revoke', boss, { label: 'Ana B.' })).status, 404, 'nothing live left to revoke');
    const after = (await call('/api/admin/invites', boss)).json.invitations[0];
    assert.deepEqual({ live: after.live, link: after.link }, { live: false, link: null });

    const log = store.adminLog().map((row) => `${row.target}: ${row.action}`);
    assert.deepEqual(log, ['Ana B.: invitation revoked', 'Ana B.: invitation made']);
  } finally {
    server.close();
    rmSync(out, { recursive: true, force: true });
  }
});

test('without the generator\'s folder the invitations say so (404), the rest of the admin works', async () => {
  const { server, call, boss } = await serve(null);
  try {
    assert.equal((await call('/api/admin/invites', boss)).status, 404);
    assert.equal((await call('/api/admin/invites', boss, { label: 'Ana' })).status, 404);
    assert.equal((await call('/api/admin/stats', boss)).status, 200);
  } finally {
    server.close();
  }
});

test('no host given, the link is the page\'s path; revoking by code is refused (labels only)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'outreach-'));
  const { server, call, boss } = await serve({ out, host: '' });
  try {
    const { json } = await call('/api/admin/invites', boss, { label: 'Ana' });
    assert.match(json.link, /^\/\?i=[0-9a-f]{24}$/);
    const code = json.link.slice(4);
    assert.equal((await call('/api/admin/invites/revoke', boss, { label: code })).status, 404);
    assert.equal(revokeInvite(out, 'Ana'), 1, 'still live: the code did not revoke it');
  } finally {
    server.close();
    rmSync(out, { recursive: true, force: true });
  }
});

test('the page and the VM: an Invitations card, the premium container reads the generator\'s folder', () => {
  const html = readFileSync(new URL('../premium/web/admin.html', import.meta.url), 'utf8');
  assert.match(html, /<section class="card" id="invites">/);
  assert.match(readFileSync(new URL('../premium/web/admin.js', import.meta.url), 'utf8'), /api\('api\/admin\/invites', \{ label/);
  const compose = readFileSync(new URL('../deploy/vm-generator/compose.yaml', import.meta.url), 'utf8');
  const premium = compose.slice(compose.indexOf('\n  premium:'));
  assert.match(premium, /- \$\{DATA:-~\/itsacv-data\}\/out:\/data\/out\n/);
  assert.match(premium, /--out \/data\/out --public-host \\"\$\$CV_HOST\\"/);
});

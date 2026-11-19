// 6.8 (the owner, 2026-11-20): the founder's admin page and the database's
// management; 6.4g: a snapshot restores to the same counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../premium/accounts.js';
import { createPremiumApp } from '../premium/server.js';

const people = (store) => {
  store.register('a@example.org', 'long enough');
  store.register('b@example.org', 'long enough');
  const a = store.user(store.login('a@example.org', 'long enough').token);
  store.buy(a, 'pack10', { currency: 'GBP', price: 5.99 });
  return a;
};

test('6.4g: a snapshot opened by createStore() gives the same stats()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'premium-snap-'));
  try {
    const store = createStore(null);
    people(store);
    const path = store.backup(dir);
    const restored = createStore(path);
    assert.deepEqual(restored.stats(), store.stats());
    assert.equal(restored.verify(), 'ok');
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admin: the accounts list never carries a password hash, a salt or a profile', () => {
  const store = createStore(null);
  people(store);
  const rows = store.adminUsers();
  assert.equal(rows.length, 2);
  for (const row of rows) for (const secret of ['hash', 'salt', 'profile', 'previews']) assert.ok(!(secret in row), secret);
  const a = rows.find((row) => row.email === 'a@example.org');
  assert.equal(a.credits, 10);
  assert.equal(a.orders, 1);
  assert.deepEqual(store.adminUsers('b@').map((row) => row.email), ['b@example.org']);
  assert.deepEqual(store.adminUsers('%').map((row) => row.email), [], 'a LIKE wildcard is a plain character');
});

test('admin: a credit change needs a reason, never goes below zero, and is logged', () => {
  const store = createStore(null);
  people(store);
  assert.throws(() => store.adjustCredits('boss@example.org', 'a@example.org', 5, ''), /reason/);
  assert.throws(() => store.adjustCredits('boss@example.org', 'a@example.org', -11, 'refund'), /below zero/);
  assert.throws(() => store.adjustCredits('boss@example.org', 'nobody@example.org', 1, 'gift'), /no such account/);
  assert.equal(store.adjustCredits('boss@example.org', 'a@example.org', -3, 'refund'), 7);
  const [entry] = store.adminLog();
  assert.equal(entry.admin, 'boss@example.org');
  assert.equal(entry.target, 'a@example.org');
  assert.match(entry.action, /credits -3: refund/);
});

test('admin: revenue per currency, simulated orders apart', () => {
  const store = createStore(null);
  people(store);
  assert.deepEqual(store.revenue(), [{ currency: 'GBP', orders: 1, total: 5.99, simulated: 1 }]);
});

async function serve(options = {}) {
  const store = createStore(null);
  people(store);
  const app = createPremiumApp({ store, analyse: async () => ({}), pageOf: () => ({}), profileOf: () => ({}), admins: ['boss@example.org'], ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { body, token } = {}) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a page */ }
    return { status: response.status, json, text };
  };
  store.register('boss@example.org', 'long enough');
  return { server, call, store, boss: store.login('boss@example.org', 'long enough').token, client: store.login('a@example.org', 'long enough').token };
}

test('admin routes: 401 without a session, 403 for a customer, open to a listed admin', async () => {
  const { server, call, boss, client } = await serve();
  try {
    for (const path of ['/api/admin/stats', '/api/admin/users', '/api/admin/log']) {
      assert.equal((await call(path)).status, 401, path);
      assert.equal((await call(path, { token: client })).status, 403, path);
      assert.equal((await call(path, { token: boss })).status, 200, path);
    }
    assert.equal((await call('/api/admin/credits', { token: client, body: { email: 'a@example.org', delta: 5, reason: 'x' } })).status, 403);
    const stats = await call('/api/admin/stats', { token: boss });
    assert.equal(stats.json.stats.users, 3);
    assert.equal(stats.json.revenue[0].currency, 'GBP');
    const users = await call('/api/admin/users?q=a%40', { token: boss });
    assert.deepEqual(users.json.users.map((row) => row.email), ['a@example.org']);
    const changed = await call('/api/admin/credits', { token: boss, body: { email: 'a@example.org', delta: 5, reason: 'gift' } });
    assert.equal(changed.json.credits, 15);
    assert.equal((await call('/api/admin/credits', { token: boss, body: { email: 'a@example.org', delta: 5 } })).status, 400);
    assert.equal((await call('/api/admin/credits', { token: boss, body: { email: 'a@example.org', delta: 1.5, reason: 'x' } })).status, 400);
    assert.equal((await call('/api/admin/log', { token: boss })).json.log[0].admin, 'boss@example.org');
    const me = await call('/api/me', { token: boss });
    assert.equal(me.json.admin, true);
    assert.equal((await call('/api/me', { token: client })).json.admin, false);
  } finally {
    server.close();
  }
});

test('admin routes: no admin configured, nobody is one', async () => {
  const { server, call, boss } = await serve({ admins: [] });
  try {
    assert.equal((await call('/api/admin/stats', { token: boss })).status, 403);
  } finally {
    server.close();
  }
});

test('admin: the snapshots are listed with their size and the newest is verified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'premium-admin-'));
  const { server, call, boss, store } = await serve({ snapshots: dir });
  try {
    store.backup(dir, Date.parse('2026-11-20T10:00:00Z'));
    writeFileSync(join(dir, 'other.txt'), 'x');
    const { json } = await call('/api/admin/snapshots', { token: boss });
    assert.deepEqual(json.snapshots.map((row) => row.name), ['premium-2026112010.db']);
    assert.ok(json.snapshots[0].bytes > 0);
    assert.equal(json.newest.integrity, 'ok');
    assert.equal(json.newest.stats.users, store.stats().users);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admin page: served, and its script only sets textContent', async () => {
  const { server, call } = await serve();
  try {
    const page = await call('/admin.html');
    assert.equal(page.status, 200);
    assert.match(page.text, /admin\.js/);
    const script = await call('/admin.js');
    assert.equal(script.status, 200);
    assert.doesNotMatch(script.text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  } finally {
    server.close();
  }
});

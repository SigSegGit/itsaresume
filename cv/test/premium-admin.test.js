// 6.8 (the owner, 2026-11-20): the founder's admin page and the database's
// management; 6.4g: a snapshot restores to the same counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('6.4g: restore-check opens a synced copy, never writing it, and compares it with the live base', async () => {
  const { restoreCheck } = await import('../premium/restore-check.js');
  const dir = mkdtempSync(join(tmpdir(), 'premium-restore-'));
  try {
    const live = createStore(join(dir, 'premium.db'));
    people(live);
    const snapshot = live.backup(join(dir, 'snapshots'));
    const before = readFileSync(snapshot);
    const same = restoreCheck(snapshot, join(dir, 'premium.db'));
    assert.equal(same.ok, true);
    assert.equal(same.same, true);
    assert.equal(same.stats.users, 2);
    assert.deepEqual(readFileSync(snapshot), before, 'the snapshot is untouched');
    live.register('c@example.org', 'long enough');
    const behind = restoreCheck(snapshot, join(dir, 'premium.db'));
    assert.equal(behind.same, false);
    assert.equal(behind.ok, false);
    writeFileSync(join(dir, 'broken.db'), 'not a database');
    assert.throws(() => restoreCheck(join(dir, 'broken.db')));
    live.close();
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

// 6.8b (the owner, 2026-11-20): refunds, an erasure from the page, the
// orders for the accounts, the failed jobs; each admin action logged.
test('admin: a refund is recorded once, takes back the credits left, and leaves the revenue', () => {
  const store = createStore(null);
  const a = people(store);
  const [order] = store.adminOrders();
  assert.equal(order.email, 'a@example.org');
  assert.throws(() => store.refundOrder('boss@example.org', order.id, ''), /reason/);
  assert.throws(() => store.refundOrder('boss@example.org', 'ffffffffffff', 'x'), /no such order/);
  store.debit(a);
  const done = store.refundOrder('boss@example.org', order.id, 'customer asked', Date.parse('2026-11-21T10:00:00Z'));
  assert.equal(done.credits_taken, 9, 'one credit was already spent');
  assert.equal(store.adminUsers('a@')[0].credits, 0);
  assert.equal(store.adminOrders()[0].refunded_at, '2026-11-21T10:00:00.000Z');
  assert.throws(() => store.refundOrder('boss@example.org', order.id, 'again'), /already refunded/);
  assert.deepEqual(store.revenue(), [{ currency: 'GBP', orders: 0, total: 0, simulated: 0 }]);
  assert.match(store.adminLog()[0].action, /refund [0-9a-f]{12}: customer asked/);
});

test('admin: an erasure from the page needs a reason, keeps the orders without the address, and is logged', () => {
  const store = createStore(null);
  people(store);
  assert.throws(() => store.adminErase('boss@example.org', 'a@example.org', ''), /reason/);
  assert.throws(() => store.adminErase('boss@example.org', 'nobody@example.org', 'x'), /no such account/);
  store.adminErase('boss@example.org', 'a@example.org', 'asked by mail');
  assert.deepEqual(store.adminUsers().map((row) => row.email), ['b@example.org']);
  assert.equal(store.adminOrders()[0].email, null);
  assert.match(store.adminLog()[0].action, /erase: asked by mail/);
});

test('admin: the orders as CSV, one line each, a formula never starting a cell', () => {
  const store = createStore(null);
  store.register('=cmd@example.org', 'long enough');
  const user = store.user(store.login('=cmd@example.org', 'long enough').token);
  store.buy(user, 'unit', { currency: 'EUR', price: 1.49 });
  const lines = store.ordersCsv().trim().split('\n');
  assert.equal(lines[0], 'id,at,email,pack,credits,currency,price,simulated,refunded_at');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /,"'=cmd@example\.org",unit,1,EUR,1\.49,1,$/);
});

test('admin: the failed jobs, newest first, with their error', () => {
  const store = createStore(null);
  const a = people(store);
  store.addJob(a, { id: '1'.repeat(16), status: 'running', title: 'SRE', created: '2026-11-20T10:00:00Z' });
  store.saveJob(a, { id: '1'.repeat(16), status: 'failed', error: 'model down' });
  store.addJob(a, { id: '2'.repeat(16), status: 'done', title: 'Dev', created: '2026-11-20T11:00:00Z' });
  assert.deepEqual(store.failedJobs(), [{ id: '1'.repeat(16), email: 'a@example.org', title: 'SRE', created: '2026-11-20T10:00:00Z', error: 'model down' }]);
});

test('admin routes (6.8b): orders, CSV, refund, erase and failed jobs, admins only', async () => {
  const { server, call, boss, client } = await serve();
  try {
    for (const path of ['/api/admin/orders', '/api/admin/orders.csv', '/api/admin/failed']) {
      assert.equal((await call(path, { token: client })).status, 403, path);
      assert.equal((await call(path, { token: boss })).status, 200, path);
    }
    const csv = await call('/api/admin/orders.csv', { token: boss });
    assert.match(csv.text, /^id,at,email/);
    const { json: { orders } } = await call('/api/admin/orders', { token: boss });
    assert.equal((await call('/api/admin/refund', { token: client, body: { id: orders[0].id, reason: 'x' } })).status, 403);
    assert.equal((await call('/api/admin/refund', { token: boss, body: { id: orders[0].id, reason: 'x' } })).status, 200);
    assert.equal((await call('/api/admin/refund', { token: boss, body: { id: orders[0].id, reason: 'x' } })).status, 409);
    assert.equal((await call('/api/admin/erase', { token: boss, body: { email: 'b@example.org' } })).status, 400);
    assert.equal((await call('/api/admin/erase', { token: boss, body: { email: 'boss@example.org', reason: 'x' } })).status, 400, 'an admin does not erase itself');
    assert.equal((await call('/api/admin/erase', { token: boss, body: { email: 'b@example.org', reason: 'x' } })).status, 200);
  } finally {
    server.close();
  }
});

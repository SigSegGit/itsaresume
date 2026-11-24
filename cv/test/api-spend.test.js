// 2026-11-24: what customers cost the owner today, where he looks. The
// router counts customers' tokens and requests (customer_budget in its
// /status); the premium admin page shows them against the ceilings, their
// estimated API cost and the day's real revenue; the owner's local page
// shows the spend in its header.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../premium/accounts.js';
import { createPremiumApp } from '../premium/server.js';
import { estimateCost } from '../premium/pricing.js';

test('an estimate of the API cost from the tokens counted, at the paid model\'s prices', () => {
  const { usd, eur } = estimateCost(6_000_000);
  assert.equal(usd, 1, 'five parts read, one written, as a generation measures');
  assert.equal(eur, 0.86);
  assert.deepEqual(estimateCost(0), { usd: 0, eur: 0 });
});

async function serve(routerStatus) {
  const store = createStore(null);
  store.register('boss@example.org', 'long enough');
  const boss = store.login('boss@example.org', 'long enough').token;
  store.register('a@example.org', 'long enough');
  const buyer = store.user(store.login('a@example.org', 'long enough').token);
  const order = store.pendingOrder(buyer, 'pack5');
  store.confirmPaid(order.id, { amount: 499, currency: 'eur' });
  store.buy(buyer, 'pack5');
  const app = createPremiumApp({ store, analyse: async () => ({}), pageOf: () => ({}), profileOf: () => ({}), admins: ['boss@example.org'], routerStatus, mailer: { send: async () => {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, token) => {
    const response = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return { server, get, boss, buyer: store.login('a@example.org', 'long enough').token };
}

test('the admin page: customers\' spend against the ceilings, its cost, the day\'s real revenue; admins only', async () => {
  const budget = { day: '2026-11-24', tokens: 6_000_000, requests: 40, tokens_limit: 8_000_000, requests_limit: 300 };
  const { server, get, boss, buyer } = await serve(async () => ({ backends: [], customer_budget: budget }));
  try {
    assert.equal((await get('/api/admin/api-spend', buyer)).status, 403);
    const { status, json } = await get('/api/admin/api-spend', boss);
    assert.equal(status, 200);
    assert.deepEqual(json.budget, budget);
    assert.deepEqual(json.estimate, { usd: 1, eur: 0.86 });
    assert.deepEqual(json.revenue_today, { EUR: 4.99 }, 'the simulated order is no revenue');
  } finally {
    server.close();
  }
});

test('the router down, the admin page says so instead of failing', async () => {
  const { server, get, boss } = await serve(async () => { throw new Error('connect ECONNREFUSED'); });
  try {
    const { status, json } = await get('/api/admin/api-spend', boss);
    assert.equal(status, 200);
    assert.equal(json.budget, null);
  } finally {
    server.close();
  }
});

test('the pages show it: the admin card, the local page\'s header', () => {
  assert.match(readFileSync(new URL('../premium/web/admin.html', import.meta.url), 'utf8'), /<section class="card" id="api-spend">/);
  assert.match(readFileSync(new URL('../premium/web/admin.js', import.meta.url), 'utf8'), /api\('api\/admin\/api-spend'\)/);
  assert.match(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), /id="status-customers"/);
  assert.match(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), /setPill\('status-customers'/);
  assert.match(readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8'), /customer_budget: routed\?\.customer_budget \?\? null/);
});

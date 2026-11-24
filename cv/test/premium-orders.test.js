// 6.13 (2026-11-23): the customer sees their own orders and downloads a
// receipt for each one paid; a pending order has none, nor anyone else's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../premium/accounts.js';
import { createPremiumApp } from '../premium/server.js';
import { receiptText } from '../premium/receipt.js';

async function serve() {
  const store = createStore(null);
  const app = createPremiumApp({ store, analyse: async () => ({}), pageOf: () => ({}), profileOf: () => ({}), mailer: { send: async () => {} } });
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
    try { json = JSON.parse(text); } catch { /* a receipt is text */ }
    return { status: response.status, json, text, headers: response.headers };
  };
  const register = async (email) => (await call('/api/register', { body: { email, password: 'long enough', accept: true } })).json.token;
  return { store, server, call, register };
}

test('the account lists its own orders, newest first; a receipt per paid order, text, in the page language', async () => {
  const { server, call, register } = await serve();
  try {
    const token = await register('a@example.org');
    const first = (await call('/api/checkout', { token, body: { pack: 'pack5', currency: 'EUR' } })).json.order;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = (await call('/api/checkout', { token, body: { pack: 'pack10', currency: 'GBP' } })).json.order;
    const me = (await call('/api/me', { token })).json;
    assert.deepEqual(me.orders.map((order) => order.id), [second.id, first.id]);
    assert.equal(me.orders[0].currency, 'GBP');
    assert.equal(me.orders[0].refunded_at, null);
    assert.ok(!('email' in me.orders[0]) && !('payment_ref' in me.orders[0]), 'only what the customer needs');

    const fr = await call(`/api/orders/${first.id}/receipt`, { token });
    assert.equal(fr.status, 200);
    assert.match(fr.headers.get('content-type'), /^text\/plain/);
    assert.match(fr.headers.get('content-disposition'), new RegExp(`attachment; filename="itsaresume-recu-${first.id}\\.txt"`));
    assert.match(fr.text, new RegExp(first.id));
    assert.match(fr.text, /4,99 EUR/);
    assert.match(fr.text, /5 crédits/);
    assert.match(fr.text, /paiement de démonstration/i, 'a simulated order says so');
    const en = await call(`/api/orders/${second.id}/receipt?lang=en`, { token });
    assert.match(en.text, /Receipt/);
    assert.match(en.text, /5\.99 GBP/);
    assert.match(en.headers.get('content-disposition'), /itsaresume-receipt-/);

    const other = await register('b@example.org');
    assert.deepEqual((await call('/api/me', { token: other })).json.orders, [], 'never the orders of another account');
    assert.equal((await call(`/api/orders/${first.id}/receipt`, { token: other })).status, 404, 'never another account\'s');
    assert.equal((await call(`/api/orders/${first.id}/receipt`)).status, 401);
  } finally {
    server.close();
  }
});

test('a receipt: a refunded order says it, a pending one has none', () => {
  const order = { id: 'a1b2c3d4e5f6', at: '2026-11-23T10:00:00.000Z', pack: 'pack5', credits: 5, currency: 'CHF', price: 5.5, simulated: false, refunded_at: '2026-11-24T08:00:00.000Z' };
  const text = receiptText(order, 'fr');
  assert.match(text, /5,50 CHF/);
  assert.match(text, /Remboursée le 2026-11-24/);
  assert.doesNotMatch(text, /démonstration/);
  assert.match(receiptText(order, 'en'), /Refunded on 2026-11-24/);
  assert.match(receiptText(order, 'en'), /not an invoice/i);
  assert.throws(() => receiptText({ ...order, pending: true }, 'fr'), /pending/);
});

test('a pending order (Stripe not yet paid) has no receipt', async () => {
  const { store, server, call, register } = await serve();
  try {
    const token = await register('a@example.org');
    const pending = store.pendingOrder(store.user(token), 'pack5');
    assert.equal((await call(`/api/orders/${pending.id}/receipt`, { token })).status, 404);
    assert.deepEqual((await call('/api/me', { token })).json.orders, [], 'a pending order is not listed as bought');
  } finally {
    server.close();
  }
});

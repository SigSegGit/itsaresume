// 6.12 (2026-11-23): real payment through Stripe Checkout, off until the
// owner sets STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. The credits come
// only from Stripe's signed "paid" event, once, for the order's own amount.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createStore } from '../premium/accounts.js';
import { createPremiumApp } from '../premium/server.js';
import { checkoutSession, minorUnits, stripeFromEnv, verifyWebhook } from '../premium/stripe.js';

const SECRET = 'whsec_test';
const sign = (payload, t, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

test('the webhook signature: right secret and fresh only, the payload untouched', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const now = 1_800_000_000;
  assert.equal(verifyWebhook(payload, sign(payload, now), SECRET, now).id, 'evt_1');
  assert.equal(verifyWebhook(payload, `${sign(payload, now, 'old')},${sign(payload, now).split(',')[1]}`, SECRET, now).id, 'evt_1', 'one of several v1 is enough (secret rolled)');
  assert.throws(() => verifyWebhook(payload, sign(payload, now, 'other'), SECRET, now), /signature/);
  assert.throws(() => verifyWebhook(payload.replace('evt_1', 'evt_2'), sign(payload, now), SECRET, now), /signature/);
  assert.throws(() => verifyWebhook(payload, sign(payload, now - 301), SECRET, now), /old/);
  assert.throws(() => verifyWebhook(payload, '', SECRET, now), /signature/);
});

test('the checkout session: amount in minor units, the order as reference, the key as bearer', async () => {
  assert.equal(minorUnits(4.99), 499);
  assert.equal(minorUnits(0.29), 29);
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }) };
  };
  const session = await checkoutSession({ secretKey: 'sk_test_x', fetch }, {
    order: { id: 'a1b2c3d4e5f6', pack: 'pack5', credits: 5, currency: 'EUR', price: 4.99 }, label: '5 CV', email: 'a@example.org',
    successUrl: 'https://cv.example.org/premium/checkout.html?order=a1b2c3d4e5f6', cancelUrl: 'https://cv.example.org/premium/#pricing',
  });
  assert.equal(session.url, 'https://checkout.stripe.com/c/pay/cs_1');
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk_test_x');
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('mode'), 'payment');
  assert.equal(form.get('client_reference_id'), 'a1b2c3d4e5f6');
  assert.equal(form.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '499');
  assert.equal(form.get('line_items[0][quantity]'), '1');
  assert.equal(form.get('customer_email'), 'a@example.org');
  const failing = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid currency' } }) });
  await assert.rejects(checkoutSession({ secretKey: 'k', fetch: failing }, { order: { id: 'x', currency: 'EUR', price: 1 }, label: 'x', successUrl: 'https://a', cancelUrl: 'https://a' }), /Invalid currency/);
});

test('the configuration: both keys or none', () => {
  assert.equal(stripeFromEnv({}), null);
  assert.throws(() => stripeFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }), /STRIPE_WEBHOOK_SECRET/);
  assert.equal(typeof stripeFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: SECRET }).checkout, 'function');
});

async function serve(payments) {
  const store = createStore(null);
  const app = createPremiumApp({ store, analyse: async () => ({}), pageOf: () => ({}), profileOf: () => ({}), mailer: { send: async () => {} }, payments });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { body, token, raw, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method: body || raw ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const { json: { token } } = await call('/api/register', { body: { email: 'a@example.org', password: 'long enough', accept: true } });
  return { server, call, token };
}

const fakePayments = () => {
  const sessions = [];
  return {
    sessions,
    checkout: async (args) => { sessions.push(args); return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }; },
    verify: (raw, header) => verifyWebhook(raw, header, SECRET, Math.floor(Date.now() / 1000)),
  };
};

const paidEvent = (order, { amount = 499, currency = 'eur', status = 'paid', id = 'evt_1' } = {}) => JSON.stringify({
  id, type: 'checkout.session.completed',
  data: { object: { id: 'cs_1', client_reference_id: order, payment_status: status, amount_total: amount, currency } },
});

test('with Stripe: checkout sends to Stripe, the order waits, the paid event credits it once', async () => {
  const payments = fakePayments();
  const { server, call, token } = await serve(payments);
  try {
    const started = await call('/api/checkout', { token, body: { pack: 'pack5', currency: 'EUR' }, headers: { host: 'cv.example.org', 'x-forwarded-proto': 'https' } });
    assert.equal(started.status, 200);
    assert.equal(started.json.redirect, 'https://checkout.stripe.com/c/pay/cs_1');
    const id = started.json.order.id;
    assert.equal(payments.sessions[0].order.price, 4.99);
    assert.match(payments.sessions[0].successUrl, new RegExp(`checkout\\.html\\?order=${id}$`));
    assert.equal((await call('/api/me', { token })).json.credits, 0, 'nothing before the payment');
    assert.equal((await call(`/api/orders/${id}`, { token })).json.pending, true);

    const event = paidEvent(id);
    const t = Math.floor(Date.now() / 1000);
    assert.equal((await call('/api/stripe/webhook', { raw: event, headers: { 'stripe-signature': sign(event, t) } })).status, 200);
    assert.equal((await call('/api/stripe/webhook', { raw: event, headers: { 'stripe-signature': sign(event, t) } })).status, 200, 'Stripe retries: answered, not counted twice');
    assert.equal((await call('/api/me', { token })).json.credits, 5);
    const order = (await call(`/api/orders/${id}`, { token })).json;
    assert.equal(order.pending, false);
    assert.equal(order.simulated, false);
  } finally {
    server.close();
  }
});

test('with Stripe: a forged, unpaid or wrong-amount event credits nothing', async () => {
  const { server, call, token } = await serve(fakePayments());
  try {
    const { json: { order: { id } } } = await call('/api/checkout', { token, body: { pack: 'pack5', currency: 'EUR' } });
    const t = Math.floor(Date.now() / 1000);
    const forged = paidEvent(id);
    assert.equal((await call('/api/stripe/webhook', { raw: forged, headers: { 'stripe-signature': sign(forged, t, 'guess') } })).status, 400);
    const unpaid = paidEvent(id, { status: 'unpaid', id: 'evt_2' });
    assert.equal((await call('/api/stripe/webhook', { raw: unpaid, headers: { 'stripe-signature': sign(unpaid, t) } })).status, 200);
    const cheap = paidEvent(id, { amount: 1, id: 'evt_3' });
    assert.equal((await call('/api/stripe/webhook', { raw: cheap, headers: { 'stripe-signature': sign(cheap, t) } })).status, 400);
    const otherCurrency = paidEvent(id, { currency: 'usd', id: 'evt_4' });
    assert.equal((await call('/api/stripe/webhook', { raw: otherCurrency, headers: { 'stripe-signature': sign(otherCurrency, t) } })).status, 400);
    assert.equal((await call('/api/me', { token })).json.credits, 0);
  } finally {
    server.close();
  }
});

test('without Stripe the demo is unchanged: credits at once, simulated; no webhook route', async () => {
  const { server, call, token } = await serve(null);
  try {
    const { json } = await call('/api/checkout', { token, body: { pack: 'pack5', currency: 'EUR' } });
    assert.equal(json.redirect, undefined);
    assert.equal(json.credits, 5);
    assert.equal(json.order.simulated, true);
    const event = paidEvent(json.order.id);
    assert.equal((await call('/api/stripe/webhook', { raw: event, headers: { 'stripe-signature': sign(event, Math.floor(Date.now() / 1000)) } })).status, 404);
  } finally {
    server.close();
  }
});

const signed = (event) => ({ raw: event, headers: { 'stripe-signature': sign(event, Math.floor(Date.now() / 1000)) } });

test('6.14: a refund made at Stripe takes back the credits left, once; an unknown or partial refund changes nothing', async () => {
  const { server, call, token } = await serve(fakePayments());
  try {
    const { json: { order: { id } } } = await call('/api/checkout', { token, body: { pack: 'pack5', currency: 'EUR' } });
    const paid = JSON.stringify({ id: 'evt_p', type: 'checkout.session.completed', data: { object: { id: 'cs_1', client_reference_id: id, payment_status: 'paid', amount_total: 499, currency: 'eur', payment_intent: 'pi_1' } } });
    await call('/api/stripe/webhook', signed(paid));
    assert.equal((await call('/api/me', { token })).json.credits, 5);
    const refund = (intent, refunded = true, evt = 'evt_r') => JSON.stringify({ id: evt, type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: intent, refunded, amount_refunded: refunded ? 499 : 100 } } });
    assert.equal((await call('/api/stripe/webhook', signed(refund('pi_1', false, 'evt_partial')))).status, 200);
    assert.equal((await call('/api/me', { token })).json.credits, 5, 'a partial refund is the owner\'s call, not automatic');
    assert.equal((await call('/api/stripe/webhook', signed(refund('pi_other')))).status, 200, 'not ours: answered, ignored');
    assert.equal((await call('/api/stripe/webhook', signed(refund('pi_1')))).json.order, 'refunded');
    assert.equal((await call('/api/stripe/webhook', signed(refund('pi_1')))).json.order, 'already', 'Stripe retries: once');
    assert.equal((await call('/api/me', { token })).json.credits, 0);
    const me = (await call('/api/me', { token })).json;
    assert.ok(me.orders[0].refunded_at, 'the customer sees it refunded');
  } finally {
    server.close();
  }
});

test('6.14: an expired Checkout drops its pending order; a paid one is never dropped', async () => {
  const { server, call, token } = await serve(fakePayments());
  try {
    const { json: { order: { id } } } = await call('/api/checkout', { token, body: { pack: 'pack5', currency: 'EUR' } });
    const expired = JSON.stringify({ id: 'evt_e', type: 'checkout.session.expired', data: { object: { id: 'cs_1', client_reference_id: id, payment_status: 'unpaid' } } });
    assert.equal((await call('/api/stripe/webhook', signed(expired))).json.order, 'dropped');
    assert.equal((await call(`/api/orders/${id}`, { token })).status, 404);
    const late = paidEvent(id, { id: 'evt_late' });
    assert.equal((await call('/api/stripe/webhook', signed(late))).status, 400, 'paid after expiry: no order to credit, Stripe shows the failure');

    const { json: { order: { id: kept } } } = await call('/api/checkout', { token, body: { pack: 'pack5', currency: 'EUR' } });
    await call('/api/stripe/webhook', signed(paidEvent(kept, { id: 'evt_k' })));
    const again = JSON.stringify({ id: 'evt_e2', type: 'checkout.session.expired', data: { object: { id: 'cs_2', client_reference_id: kept } } });
    assert.equal((await call('/api/stripe/webhook', signed(again))).json.order, 'none');
    assert.equal((await call('/api/me', { token })).json.credits, 5);
  } finally {
    server.close();
  }
});

test('6.14: a delayed payment method (async_payment_succeeded) credits as a card does', async () => {
  const { server, call, token } = await serve(fakePayments());
  try {
    const { json: { order: { id } } } = await call('/api/checkout', { token, body: { pack: 'pack5', currency: 'EUR' } });
    const event = JSON.stringify({ id: 'evt_a', type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_1', client_reference_id: id, payment_status: 'paid', amount_total: 499, currency: 'eur' } } });
    assert.equal((await call('/api/stripe/webhook', signed(event))).json.order, 'credited');
    assert.equal((await call('/api/me', { token })).json.credits, 5);
  } finally {
    server.close();
  }
});

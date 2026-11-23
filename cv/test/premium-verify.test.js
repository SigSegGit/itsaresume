// 6.10 (2026-11-23, before going public): the address is confirmed before
// anything is paid for or generated: a one-time link mailed at sign-up,
// valid a day; a new one on request, limited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../premium/accounts.js';
import { createPremiumApp } from '../premium/server.js';

const DAY = 86400000;

test('store: a confirmation link works once, within a day, for its own address', () => {
  const store = createStore(null);
  const { token: session } = store.register('a@example.org', 'long enough', 0);
  assert.equal(store.user(session, 1).verified, false);
  const link = store.verifyToken('a@example.org', 0);
  assert.match(link, /^[0-9a-f]{48}$/);
  assert.equal(store.confirmEmail(link, DAY - 1), 'a@example.org');
  assert.equal(store.user(session, DAY).verified, true);
  assert.throws(() => store.confirmEmail(link, DAY), /invalid or expired/, 'once');
  const late = store.verifyToken('a@example.org', 0);
  assert.throws(() => store.confirmEmail(late, DAY + 1), /invalid or expired/);
  assert.equal(store.verifyToken('nobody@example.org', 0), null);
});

test('store: an erased account takes its links with it', () => {
  const store = createStore(null);
  store.register('a@example.org', 'long enough');
  const link = store.verifyToken('a@example.org');
  store.adminErase('boss@example.org', 'a@example.org', 'asked');
  assert.throws(() => store.confirmEmail(link), /invalid or expired/);
});

async function serve(options = {}) {
  const mails = [];
  const store = createStore(null);
  const app = createPremiumApp({ store, analyse: async () => ({}), pageOf: () => ({}), profileOf: () => ({}), mailer: { send: async (mail) => mails.push(mail) }, requireVerified: true, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { body, token } = {}) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return { server, call, mails, store };
}

const linkOf = (mail) => /#verify=([0-9a-f]{48})/.exec(mail.text)?.[1];

test('sign-up mails a confirmation link; until it is followed, nothing is bought', async () => {
  const { server, call, mails } = await serve();
  try {
    const { json: { token } } = await call('/api/register', { body: { email: 'a@example.org', password: 'long enough', accept: true } });
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'a@example.org');
    const link = linkOf(mails[0]);
    assert.ok(link, mails[0].text);
    assert.equal((await call('/api/me', { token })).json.verified, false);
    const refused = await call('/api/checkout', { token, body: { pack: 'unit', currency: 'EUR' } });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, 'confirm your e-mail address first');
    assert.equal((await call('/api/email/verify', { body: { token: link } })).status, 200);
    assert.equal((await call('/api/me', { token })).json.verified, true);
    assert.equal((await call('/api/checkout', { token, body: { pack: 'unit', currency: 'EUR' } })).status, 200);
    assert.equal((await call('/api/email/verify', { body: { token: link } })).status, 400, 'once');
  } finally {
    server.close();
  }
});

test('a new link on request, for the logged-in address only, limited', async () => {
  const { server, call, mails } = await serve({ limits: { verify: { max: 2, windowMs: 3600000 } } });
  try {
    const { json: { token } } = await call('/api/register', { body: { email: 'a@example.org', password: 'long enough', accept: true } });
    assert.equal((await call('/api/email/resend', { body: {} })).status, 401);
    assert.equal((await call('/api/email/resend', { token, body: {} })).status, 200);
    assert.equal((await call('/api/email/resend', { token, body: {} })).status, 200);
    assert.equal((await call('/api/email/resend', { token, body: {} })).status, 429);
    assert.equal(mails.length, 3);
    assert.ok(mails.every((mail) => mail.to === 'a@example.org'));
  } finally {
    server.close();
  }
});

test('generation waits for the confirmation too; without the option nothing waits', async () => {
  const { server, call } = await serve();
  try {
    const { json: { token } } = await call('/api/register', { body: { email: 'a@example.org', password: 'long enough', accept: true } });
    assert.equal((await call('/api/generate', { token, body: { offer: 'SRE' } })).status, 403);
  } finally {
    server.close();
  }
  const open = await serve({ requireVerified: false });
  try {
    const { json: { token } } = await open.call('/api/register', { body: { email: 'b@example.org', password: 'long enough', accept: true } });
    assert.equal((await open.call('/api/checkout', { token, body: { pack: 'unit', currency: 'EUR' } })).status, 200);
  } finally {
    open.server.close();
  }
});

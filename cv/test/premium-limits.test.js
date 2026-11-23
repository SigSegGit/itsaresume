// 6.9 (2026-11-23, before going public): attempts are limited. A password is
// not guessed by trying, a mailbox is not flooded with recovery mails, an
// address does not open accounts by the hundred.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, clientIp } from '../premium/limits.js';
import { createStore } from '../premium/accounts.js';
import { createPremiumApp } from '../premium/server.js';

test('limiter: max hits per window, per key; then refused with the seconds left', () => {
  const limit = createLimiter({ max: 3, windowMs: 60000 });
  for (let i = 0; i < 3; i += 1) assert.equal(limit.hit('a', 1000 + i).ok, true);
  const refused = limit.hit('a', 2000);
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfter, 59);
  assert.equal(limit.hit('b', 2000).ok, true, 'another key is apart');
  assert.equal(limit.hit('a', 61001).ok, true, 'the window passed');
  limit.clear('a');
  assert.equal(limit.check('a', 61002).ok, true);
});

test('limiter: a check counts nothing; old keys are dropped', () => {
  const limit = createLimiter({ max: 1, windowMs: 1000 });
  assert.equal(limit.check('a', 0).ok, true);
  assert.equal(limit.check('a', 0).ok, true);
  for (let i = 0; i < 5000; i += 1) limit.hit(`k${i}`, 0);
  limit.hit('late', 5000);
  assert.ok(limit.size() <= 1, `${limit.size()} keys kept`);
});

test('clientIp: the proxy\'s X-Forwarded-For only from the machine itself', () => {
  const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(req('::1', '198.51.100.1, 203.0.113.9')), '203.0.113.9', 'the entry the proxy added');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(req('198.51.100.7', '203.0.113.9')), '198.51.100.7', 'a client cannot name itself');
  assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1');
});

async function serve(limits) {
  const store = createStore(null);
  store.register('a@example.org', 'long enough');
  const mails = [];
  const app = createPremiumApp({ store, analyse: async () => ({}), pageOf: () => ({}), profileOf: () => ({}), mailer: { send: async (mail) => mails.push(mail) }, limits });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, ip = '203.0.113.1') => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null), retry: response.headers.get('retry-after') };
  };
  return { server, call, mails };
}

test('login: after the failures allowed for an address, even the right password waits', async () => {
  const { server, call } = await serve({ login: { max: 3, windowMs: 60000 } });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await call('/api/login', { email: 'a@example.org', password: 'wrong guess' })).status, 401);
    const refused = await call('/api/login', { email: 'a@example.org', password: 'long enough' });
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.retry) > 0);
    assert.equal((await call('/api/login', { email: 'A@Example.org ', password: 'long enough' })).status, 429, 'the address as the store reads it');
    assert.equal((await call('/api/login', { email: 'b@example.org', password: 'x' })).status, 401, 'another address is apart');
  } finally {
    server.close();
  }
});

test('login: a success clears the address\'s failures', async () => {
  const { server, call } = await serve({ login: { max: 3, windowMs: 60000 } });
  try {
    for (let i = 0; i < 2; i += 1) await call('/api/login', { email: 'a@example.org', password: 'wrong guess' });
    assert.equal((await call('/api/login', { email: 'a@example.org', password: 'long enough' })).status, 200);
    for (let i = 0; i < 2; i += 1) assert.equal((await call('/api/login', { email: 'a@example.org', password: 'wrong guess' })).status, 401);
  } finally {
    server.close();
  }
});

test('login: one address trying many accounts is stopped too', async () => {
  const { server, call } = await serve({ loginIp: { max: 4, windowMs: 60000 } });
  try {
    for (let i = 0; i < 4; i += 1) assert.equal((await call('/api/login', { email: `x${i}@example.org`, password: 'wrong guess' })).status, 401);
    assert.equal((await call('/api/login', { email: 'a@example.org', password: 'long enough' })).status, 429);
    assert.equal((await call('/api/login', { email: 'a@example.org', password: 'long enough' }, '203.0.113.2')).status, 200);
  } finally {
    server.close();
  }
});

test('recovery: a few mails per address an hour, the same answer for an unknown one', async () => {
  const { server, call, mails } = await serve({ forgot: { max: 2, windowMs: 3600000 } });
  try {
    for (let i = 0; i < 2; i += 1) assert.equal((await call('/api/password/forgot', { email: 'a@example.org' })).status, 200);
    assert.equal((await call('/api/password/forgot', { email: 'a@example.org' })).status, 429);
    assert.equal(mails.length, 2);
    for (let i = 0; i < 2; i += 1) await call('/api/password/forgot', { email: 'nobody@example.org' });
    assert.equal((await call('/api/password/forgot', { email: 'nobody@example.org' })).status, 429, 'an unknown address is limited alike');
  } finally {
    server.close();
  }
});

test('register: a few accounts per network address an hour', async () => {
  const { server, call } = await serve({ register: { max: 2, windowMs: 3600000 } });
  try {
    for (let i = 0; i < 2; i += 1) assert.equal((await call('/api/register', { email: `n${i}@example.org`, password: 'long enough', accept: true })).status, 200);
    assert.equal((await call('/api/register', { email: 'n9@example.org', password: 'long enough', accept: true })).status, 429);
    assert.equal((await call('/api/register', { email: 'n9@example.org', password: 'long enough', accept: true }, '203.0.113.7')).status, 200);
  } finally {
    server.close();
  }
});

test('the default limits are on without any option', async () => {
  const { server, call } = await serve(undefined);
  try {
    let status = 0;
    for (let i = 0; i < 12 && status !== 429; i += 1) status = (await call('/api/login', { email: 'a@example.org', password: 'wrong guess' })).status;
    assert.equal(status, 429);
  } finally {
    server.close();
  }
});

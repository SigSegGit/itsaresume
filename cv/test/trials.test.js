// 2026-11-24 (the owner): free trials he can give away without anyone
// spending his money for ever. Red-teamed paths, each closed here:
// - the premium preview (a model call, the API's money once customers are on
//   it) taken with throwaway accounts: an unconfirmed address previews
//   nothing when addresses are checked, an address and the whole site have
//   a daily ceiling;
// - one invitation link shared widely: a quota of own-profile CVs per
//   invitation, whoever opens it;
// - a stranger with no invitation using the free own-profile CV:
//   `serviceInviteOnly` keeps it for invited visitors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../premium/accounts.js';
import { createPremiumApp } from '../premium/server.js';

async function premium({ limits = {}, requireVerified = true } = {}) {
  const store = createStore(null);
  const mails = [];
  const app = createPremiumApp({
    store, requireVerified, limits,
    analyse: async () => ({ fit: { score: 50, verdict: 'go' }, requirements: [] }),
    pageOf: () => ({ experiences: [], skills: [] }),
    profileOf: () => ({ identity: { name: 'Sam' }, experiences: [] }),
    mailer: { send: async (mail) => mails.push(mail) },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, { token, ip = '203.0.113.1' } = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const account = async (email, { ip, confirm = true } = {}) => {
    const { json: { token } } = await call('/api/register', { email, password: 'long enough', accept: true }, { ip });
    if (confirm) {
      const link = mails.map((mail) => /verify=([0-9a-f]+)/.exec(mail.text)?.[1]).filter(Boolean).at(-1);
      await call('/api/email/verify', { token: link });
    }
    return token;
  };
  return { server, call, account };
}

const PREVIEW = { offer: 'Ingénieur SRE : Kubernetes, Terraform.', resume: { basics: { name: 'Sam' } } };

test('red team: an unconfirmed address takes no free preview when addresses are checked', async () => {
  const { server, call, account } = await premium();
  try {
    const token = await account('a@example.org', { confirm: false });
    assert.equal((await call('/api/preview', PREVIEW, { token })).status, 403);
  } finally {
    server.close();
  }
});

test('red team: throwaway accounts from one address hit a daily preview ceiling per address', async () => {
  const { server, call, account } = await premium({ limits: { previewIp: { max: 4, windowMs: 86400000 }, register: { max: 50, windowMs: 3600000 } } });
  try {
    const statuses = [];
    for (const name of ['a', 'b', 'c']) {
      const token = await account(`${name}@example.org`);
      for (let i = 0; i < 2; i += 1) statuses.push((await call('/api/preview', PREVIEW, { token })).status);
    }
    assert.equal(statuses.filter((status) => status === 429).length, 2, statuses.join(','));
    assert.ok(statuses.slice(0, 4).every((status) => status !== 429), statuses.join(','));
  } finally {
    server.close();
  }
});

test('red team: accounts from many addresses hit the site\'s daily preview ceiling', async () => {
  const { server, call, account } = await premium({ limits: { previewAll: { max: 3, windowMs: 86400000 } } });
  try {
    const statuses = [];
    for (const [at, name] of ['a', 'b', 'c', 'd'].entries()) {
      const ip = `198.51.100.${at + 1}`;
      const token = await account(`${name}@example.org`, { ip });
      statuses.push((await call('/api/preview', PREVIEW, { token, ip })).status);
    }
    assert.equal(statuses.at(-1), 429, statuses.join(','));
    assert.ok(statuses.slice(0, 3).every((status) => status !== 429), statuses.join(','));
  } finally {
    server.close();
  }
});

test('red team: the premium server sends its model calls as a customer\'s', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../premium/server.js', import.meta.url), 'utf8');
  assert.match(source, /const llm = asCustomer\(\(\{ system, prompt, schema, backend, kind, audience \}\) => complete\(\{ url: router, system, prompt, schema, backend, kind, audience \}\)\);/);
});

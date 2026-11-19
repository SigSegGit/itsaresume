// 6.4d (the owner, 2026-11-19): a real use, end to end, in CI: a visitor
// previews free, is offered a pack when saving a profile, buys, saves it,
// chats within the quota then refills it with a credit, generates a CV,
// exports their data, forgets the password and resets it, deletes the
// account. The model, the chat and the mail are fakes; everything else is real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../premium/accounts.js';
import { createPremiumApp, CHAT } from '../premium/server.js';

async function start() {
  const mails = [];
  const app = createPremiumApp({
    store: createStore(null),
    analyse: async () => ({ fit: { score: 80, verdict: 'good' }, requirements: [{ name: 'SQL', match: 'yes' }] }),
    pageOf: () => ({ headline: 'H', profile: ['Secret summary'], skill_groups: [], experiences: [{ title: 'T', org: 'O', dates: 'D', items: [{ id: 'b', text: 'Secret bullet' }] }] }),
    profileOf: (resume) => ({ identity: { name: resume.basics?.name ?? 'x' }, experiences: [] }),
    chat: async ({ message }) => `echo: ${message}`,
    mailer: { send: async (mail) => mails.push(mail) },
    contact: 'contact@example.org',
  });
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
  return { server, call, mails };
}

const until = async (check) => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout');
};

test('e2e: preview, pay to save a profile, chat quota and refill, generate, export, reset, delete', async () => {
  const { server, call, mails } = await start();
  try {
    const email = 'e2e@example.org';
    const resume = { basics: { name: 'E2E' }, work: [{ name: 'Acme', position: 'SRE' }] };
    const { json: { token } } = await call('/api/register', { body: { email, password: 'first password', accept: true } });

    // Free: a preview of an unsaved profile, nothing stored, no text sent.
    const preview = await call('/api/preview', { token, body: { offer: 'an offer', resume } });
    assert.equal(preview.status, 200);
    assert.ok(!preview.text.includes('Secret'));
    assert.equal((await call('/api/me', { token })).json.profile, null, 'the preview stores nothing');

    // Saving a profile needs a purchase: the packs come with the refusal.
    const refused = await call('/api/profile', { token, body: { resume } });
    assert.equal(refused.status, 402);
    assert.ok(refused.json.packs.length > 0);
    assert.equal((await call('/api/chat', { token, body: { message: 'hi' } })).status, 402, 'the chat too');

    assert.equal((await call('/api/checkout', { token, body: { pack: 'pack5', currency: 'EUR' } })).json.credits, 5);
    assert.equal((await call('/api/profile', { token, body: { resume } })).status, 200);

    // The chat: a free quota with the purchase, then one credit refills it.
    for (let i = 0; i < CHAT.free; i += 1) assert.equal((await call('/api/chat', { token, body: { message: `m${i}` } })).status, 200);
    const empty = await call('/api/chat', { token, body: { message: 'one more' } });
    assert.equal(empty.status, 429);
    assert.equal(empty.json.refill.messages, CHAT.perCredit);
    assert.equal((await call('/api/chat/refill', { token, body: {} })).json.chat_left, CHAT.perCredit);
    assert.equal((await call('/api/me', { token })).json.credits, 4);
    assert.equal((await call('/api/chat', { token, body: { message: 'again' } })).json.reply, 'echo: again');

    // A paid CV.
    const job = await call('/api/generate', { token, body: { offer: 'an offer' } });
    await until(async () => (await call(`/api/jobs/${job.json.id}`, { token })).json.status === 'done');
    assert.ok((await call(`/api/jobs/${job.json.id}/page`, { token })).text.includes('Secret bullet'));
    assert.equal((await call('/api/me', { token })).json.credits, 3);

    // GDPR export: profile, CV, orders and the chat.
    const exported = (await call('/api/me/export', { token })).json;
    assert.equal(exported.profile.identity.name, 'E2E');
    assert.equal(exported.orders.length, 1);
    assert.ok(exported.account.chat.history.length > 0);

    // Recovery: a mail with a one-time link, the old password gone.
    assert.equal((await call('/api/password/forgot', { body: { email: 'nobody@example.org' } })).status, 200, 'no account enumeration');
    assert.equal(mails.length, 0);
    await call('/api/password/forgot', { body: { email } });
    assert.equal(mails.length, 1);
    const reset = /#reset=([0-9a-f]+)/.exec(mails[0].text)[1];
    assert.equal((await call('/api/password/reset', { body: { token: reset, password: 'second password' } })).status, 200);
    assert.equal((await call('/api/password/reset', { body: { token: reset, password: 'third password' } })).status, 400, 'one use');
    assert.equal((await call('/api/me', { token })).status, 401, 'old sessions closed');
    assert.equal((await call('/api/login', { body: { email, password: 'first password' } })).status, 401);
    const { json: { token: again } } = await call('/api/login', { body: { email, password: 'second password' } });

    // Erasure.
    assert.equal((await call('/api/me/delete', { token: again, body: { password: 'second password' } })).status, 200);
    assert.equal((await call('/api/login', { body: { email, password: 'second password' } })).status, 401);

    // The contact on the privacy page comes from the configuration.
    assert.match((await call('/privacy.html')).text, /contact@example\.org/);
  } finally {
    server.close();
  }
});

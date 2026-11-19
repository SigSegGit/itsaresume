// 6.4 (the owner, 2026-11-19): the paid, multi-account part, apart from the
// local generator. Credits bought by packs (simulated payment in the demo), a
// free preview that shows the verdict but never the CV's text, a paid
// generation that debits one credit and refunds it on failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { PACKS, API_PRICES, RUN, costPerCv, unitPrice, marginPerCv } from '../premium/pricing.js';
import { createStore } from '../premium/accounts.js';
import { redact } from '../premium/preview.js';
import { createPremiumApp } from '../premium/server.js';

test('packs: the price per CV falls with the pack size', () => {
  for (let i = 1; i < PACKS.length; i += 1) assert.ok(unitPrice(PACKS[i]) < unitPrice(PACKS[i - 1]), PACKS[i].id);
});

test('cost per CV: calls × tokens × the API price list', () => {
  const opus = API_PRICES['claude-opus-5-5'];
  const expected = (RUN.calls * RUN.input * opus.input + RUN.calls * RUN.output * opus.output) / 1e6;
  assert.equal(costPerCv('claude-opus-5-5'), expected);
  assert.ok(costPerCv('claude-haiku-5-5') < costPerCv('claude-sonnet-5-5'));
  for (const pack of PACKS) for (const model of Object.keys(API_PRICES)) assert.ok(marginPerCv(pack, model) > 0, `${pack.id} ${model}`);
});

test('accounts: register, log in, wrong password and duplicates refused, no password stored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'premium-'));
  const store = createStore(join(dir, 'accounts.json'));
  const { token } = store.register('a@example.org', 'correct horse');
  assert.equal(store.user(token).email, 'a@example.org');
  assert.throws(() => store.register('a@example.org', 'another one'), /exists/);
  assert.throws(() => store.register('b@example.org', 'short'), /password/);
  assert.throws(() => store.login('a@example.org', 'wrong horse'), /password/);
  assert.ok(store.user(store.login('a@example.org', 'correct horse').token));
  assert.ok(!readFileSync(join(dir, 'accounts.json'), 'utf8').includes('correct horse'));
  assert.equal(createStore(join(dir, 'accounts.json')).user(token).email, 'a@example.org', 'persisted');
});

test('credits: a pack adds its credits, a debit at zero is refused, a refund gives it back', () => {
  const store = createStore(null);
  const user = store.user(store.register('c@example.org', 'long enough').token);
  assert.throws(() => store.debit(user), /credit/);
  store.buy(user, 'pack5');
  assert.equal(user.credits, 5);
  store.debit(user);
  store.refund(user);
  assert.equal(user.credits, 5);
  assert.throws(() => store.buy(user, 'nope'), /pack/);
});

const page = () => ({
  headline: 'Senior SRE — secret headline',
  profile: ['A tailored summary nobody sees free.'],
  skill_groups: [{ title: 'Cloud', items: ['GCP'] }],
  experiences: [{ title: 'SRE', org: 'Acme', dates: '2020', items: [{ id: 'b1', text: 'Tailored bullet one' }, { id: 'b2', text: 'Tailored bullet two' }] }],
});
const analysis = () => ({ fit: { score: 72, verdict: 'good' }, requirements: [{ name: 'Terraform', match: 'yes' }, { name: 'Kafka', match: 'no' }] });

test('preview: the verdict and the shape, never the tailored text', () => {
  const shown = JSON.stringify(redact(page(), analysis()));
  for (const secret of ['secret headline', 'tailored summary', 'Tailored bullet']) assert.ok(!shown.includes(secret), secret);
  const preview = redact(page(), analysis());
  assert.equal(preview.score, 72);
  assert.deepEqual(preview.experiences[0].lines, [19, 19], 'line lengths only');
  assert.equal(preview.requirements.length, 2);
});

async function serve(options = {}) {
  const calls = [];
  const app = createPremiumApp({
    store: createStore(null),
    analyse: async ({ offer, mode }) => {
      calls.push(mode);
      if (offer.includes('FAIL')) throw new Error('model down');
      return analysis();
    },
    pageOf: () => page(),
    profileOf: (resume) => ({ id: 'p', name: resume.basics?.name ?? 'x' }),
    ...options,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { body, token, method } = {}) => {
    const response = await fetch(base + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null), headers: response.headers };
  };
  return { server, call, calls };
}

const until = async (check) => {
  for (let i = 0; i < 50; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout');
};

test('server: preview free on the subscription, generation paid by a credit on the API, refunded on failure', async () => {
  const { server, call, calls } = await serve();
  try {
    const { json: { token } } = await call('/api/register', { body: { email: 'd@example.org', password: 'long enough' } });
    assert.equal((await call('/api/preview', { token, body: { offer: 'an offer' } })).status, 409, 'a profile first');
    assert.equal((await call('/api/profile', { token, body: { resume: { basics: { name: 'D' } } } })).status, 200);
    const preview = await call('/api/preview', { token, body: { offer: 'an offer' } });
    assert.equal(preview.status, 200);
    assert.ok(!JSON.stringify(preview.json).includes('Tailored bullet'));
    assert.equal(calls.at(-1), 'preview');
    assert.equal((await call('/api/generate', { token, body: { offer: 'an offer' } })).status, 402, 'no credit');
    assert.equal((await call('/api/checkout', { token, body: { pack: 'pack5' } })).json.credits, 5);
    const job = await call('/api/generate', { token, body: { offer: 'an offer' } });
    assert.equal(job.status, 202);
    assert.equal(calls.at(-1), 'paid');
    await until(async () => (await call(`/api/jobs/${job.json.id}`, { token })).json.status === 'done');
    const full = await call(`/api/jobs/${job.json.id}/page`, { token });
    assert.equal(full.status, 200);
    assert.equal(full.json.experiences[0].items[0].text, 'Tailored bullet one');
    assert.equal((await call('/api/me', { token })).json.credits, 4);
    const failed = await call('/api/generate', { token, body: { offer: 'FAIL' } });
    await until(async () => (await call(`/api/jobs/${failed.json.id}`, { token })).json.status === 'failed');
    assert.equal((await call('/api/me', { token })).json.credits, 4, 'refunded');
    const { json: { token: other } } = await call('/api/register', { body: { email: 'e@example.org', password: 'long enough' } });
    assert.equal((await call(`/api/jobs/${job.json.id}/page`, { token: other })).status, 404, 'another account sees nothing');
    assert.equal((await call('/api/me')).status, 401);
  } finally {
    server.close();
  }
});

test('server: previews are limited per account per day', async () => {
  const { server, call } = await serve();
  try {
    const { json: { token } } = await call('/api/register', { body: { email: 'f@example.org', password: 'long enough' } });
    await call('/api/profile', { token, body: { resume: {} } });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await call('/api/preview', { token, body: { offer: 'x' } })).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  } finally {
    server.close();
  }
});

test('extension: a LinkedIn profile page read into a JSON Resume, on the click only', () => {
  const source = readFileSync(new URL('../premium/extension/linkedin.js', import.meta.url), 'utf8');
  const { linkedInProfile } = runInContext(`${source}\n;({ linkedInProfile });`, createContext({}));
  const node = (text, children = {}) => ({ innerText: text, querySelectorAll: (selector) => children[selector] ?? [], querySelector: (selector) => (children[selector] ?? [])[0] ?? null });
  const spans = (...texts) => ({ 'span[aria-hidden="true"]': texts.map((text) => node(text)) });
  const experience = node('', { 'li.artdeco-list__item': [node('', spans('SRE', 'Acme · Full-time', 'Jan 2020 - Present · 5 yrs', 'Paris', 'Ran PostgreSQL on-call.'))] });
  const skills = node('', { 'li.artdeco-list__item': [node('', spans('Terraform')), node('', spans('Kafka'))] });
  const doc = {
    querySelector: (selector) => ({ h1: node('Alex Martin'), '.text-body-medium': node('Senior SRE') }[selector] ?? null),
    getElementById: (id) => ({ experience: { closest: () => experience }, skills: { closest: () => skills }, about: { closest: () => node('', spans('About', 'Ten years of on-call.')) } }[id] ?? null),
  };
  const resume = JSON.parse(JSON.stringify(linkedInProfile(doc)));
  assert.equal(resume.basics.name, 'Alex Martin');
  assert.equal(resume.basics.label, 'Senior SRE');
  assert.equal(resume.basics.summary, 'Ten years of on-call.');
  assert.deepEqual(resume.work, [{ position: 'SRE', name: 'Acme', startDate: 'Jan 2020', endDate: 'Present', highlights: ['Ran PostgreSQL on-call.'] }]);
  assert.deepEqual(resume.skills, [{ name: 'LinkedIn', keywords: ['Terraform', 'Kafka'] }]);
});

// 6.4b (the owner, 2026-11-19): one grid per market, aggressive, each price a
// local charm price from the EUR grid, the exchange rate and the market.
import { CURRENCIES, localPacks, currencyFor, charm } from '../premium/pricing.js';

test('currencies: every market keeps a falling price per CV and a margin on the paid model', () => {
  for (const code of Object.keys(CURRENCIES)) {
    const packs = localPacks(code);
    assert.equal(packs.length, PACKS.length, code);
    for (let i = 1; i < packs.length; i += 1) assert.ok(packs[i].price / packs[i].credits < packs[i - 1].price / packs[i - 1].credits, `${code} ${packs[i].id}`);
    for (const pack of packs) assert.ok(pack.margin_eur > 0, `${code} ${pack.id}: ${pack.margin_eur}`);
  }
});

test('currencies: charm prices (.49/.99, whole numbers where cents are not used)', () => {
  assert.equal(charm(1.52, 2), 1.49);
  assert.equal(charm(5.2, 2), 4.99);
  assert.equal(charm(36.4, 2), 35.99);
  assert.equal(charm(1133, 0), 1129);
  for (const code of Object.keys(CURRENCIES)) {
    for (const pack of localPacks(code)) {
      const cents = Math.round((pack.price % 1) * 100);
      assert.ok(CURRENCIES[code].decimals === 0 ? Number.isInteger(pack.price) && pack.price % 10 === 9 : [49, 99].includes(cents), `${code} ${pack.price}`);
    }
  }
  assert.deepEqual(localPacks('EUR').map((pack) => pack.price), PACKS.map((pack) => pack.price), 'EUR is the grid itself');
});

test('currencies: the visitor\'s language picks the market, EUR otherwise', () => {
  assert.equal(currencyFor('en-GB,en;q=0.9'), 'GBP');
  assert.equal(currencyFor('en-US'), 'USD');
  assert.equal(currencyFor('fr-CH,fr;q=0.8'), 'CHF');
  assert.equal(currencyFor('pt-BR'), 'BRL');
  assert.equal(currencyFor('fr-FR,fr;q=0.9'), 'EUR');
  assert.equal(currencyFor(''), 'EUR');
  assert.equal(currencyFor('xx'), 'EUR');
});

test('checkout: the order records its currency and local price; the credits are the same', async () => {
  const { server, call } = await serve();
  try {
    const { json: { token } } = await call('/api/register', { body: { email: 'g@example.org', password: 'long enough' } });
    const result = await call('/api/checkout', { token, body: { pack: 'pack10', currency: 'GBP' } });
    assert.equal(result.json.credits, 10);
    assert.equal(result.json.order.currency, 'GBP');
    assert.equal(result.json.order.price, localPacks('GBP').find((pack) => pack.id === 'pack10').price);
    assert.equal((await call('/api/checkout', { token, body: { pack: 'pack10', currency: 'XXX' } })).status, 400);
    const packs = await call('/api/packs?currency=BRL');
    assert.equal(packs.json.currency, 'BRL');
    assert.equal(packs.json.packs[0].price, localPacks('BRL')[0].price);
    const order = await call(`/api/orders/${result.json.order.id}`, { token });
    assert.equal(order.json.pack, 'pack10');
  } finally {
    server.close();
  }
});

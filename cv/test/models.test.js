// Router 8.43, cv side: the model menu follows what the router says of each
// backend (GET /status), so the page never offers a model that cannot answer
// without saying why, and picks the local model when it can take the job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelMenu } from '../src/models.js';
import { serve } from '../src/serve.js';

const NOW = Date.UTC(2026, 9, 5, 14, 0) / 1000;
const claude = (state, extra = {}) => ({ name: 'claude', kind: 'claude-code', state, ...extra });
const local = (state, extra = {}) => ({ name: 'bionic', kind: 'lm-studio', state, ...extra });

test('the local model up is the default, and says whether it must load first', () => {
  const ready = modelMenu([claude('up'), local('up', { loaded: true })], NOW);
  assert.equal(ready.default, 'local');
  assert.equal(ready.options.local.available, true);
  assert.doesNotMatch(ready.options.local.note, /charg/);
  const cold = modelMenu([claude('up'), local('up', { loaded: false })], NOW);
  assert.equal(cold.default, 'local');
  assert.match(cold.options.local.note, /chargé à la demande/);
});

test('the local model down is unavailable, said plainly, and auto takes the default', () => {
  const menu = modelMenu([claude('unknown'), local('down', { reason: 'unreachable: 127.0.0.1:54321' })], NOW);
  assert.equal(menu.options.local.available, false);
  assert.match(menu.options.local.note, /portable éteint ou hors ligne/);
  assert.doesNotMatch(JSON.stringify(menu), /127\.0\.0\.1/, 'no router reason reaches the page');
  assert.equal(menu.default, 'auto');
  assert.equal(menu.options.claude.available, true);
});

// The time is the owner's, Paris: 13:50 UTC is 15:50 in October.
test('Claude at its limit is unavailable for an hour, then offered again with the time it was seen', () => {
  const since = NOW - 10 * 60;
  const fresh = modelMenu([claude('limited', { since }), local('down')], NOW);
  assert.equal(fresh.options.claude.available, false);
  assert.match(fresh.options.claude.note, /limite.*15:50|15:50.*limite/i);
  assert.equal(fresh.default, null, 'nothing can answer: no default');
  assert.equal(fresh.options.auto.available, false);
  const later = modelMenu([claude('limited', { since: NOW - 2 * 3600 }), local('down')], NOW);
  assert.equal(later.options.claude.available, true);
  assert.equal(later.default, 'auto');
});

test('Claude stopped (logged out, a tripwire) is unavailable', () => {
  const menu = modelMenu([claude('stopped', { since: NOW }), local('up', { loaded: true })], NOW);
  assert.equal(menu.options.claude.available, false);
  assert.equal(menu.default, 'local');
  assert.equal(menu.options.auto.available, true);
});

test('a router older than /status leaves the menu as it was: everything offered, auto first', () => {
  const menu = modelMenu(undefined, NOW);
  assert.equal(menu.default, 'auto');
  for (const model of ['auto', 'claude', 'local']) assert.equal(menu.options[model].available, true, model);
});

test('no router at all offers nothing, and says so', () => {
  const menu = modelMenu(null, NOW);
  assert.equal(menu.default, null);
  for (const model of ['auto', 'claude', 'local']) {
    assert.equal(menu.options[model].available, false, model);
    assert.match(menu.options[model].note, /routeur injoignable/);
  }
});

test('serve() hands the page the menu from the router, without any router reason', async () => {
  const stand = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/status'
      ? { contract: '1.1', backends: [claude('up'), local('down', { reason: 'unreachable: 127.0.0.1:54321' })] }
      : { contract: '1.1', status: 'ok' }));
  });
  await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
  const out = mkdtempSync(join(tmpdir(), 'itsacv-models-'));
  const server = await serve({ profile: '/nowhere/profile.json', out, url: `http://127.0.0.1:${stand.address().port}`, port: 0, useWord: false, llm: async () => ({}) });
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/status`)).json();
    assert.equal(body.models.default, 'auto', JSON.stringify(body));
    assert.equal(body.models.options.local.available, false);
    assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|unreachable/);
  } finally {
    server.close();
    stand.close();
  }
});

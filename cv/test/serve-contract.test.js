// Router 8.42 (Rodin on 8.37): `itsacv serve` reads the router's contract on
// its /healthz probe at start, so a router speaking another major is caught
// before the first job, not by the first job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../src/serve.js';

/** A stand-in router whose /healthz answers `body`. */
async function router(body) {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function start(health) {
  const stand = await router(health);
  const out = mkdtempSync(join(tmpdir(), 'itsacv-contract-'));
  const url = `http://127.0.0.1:${stand.address().port}`;
  try {
    const server = await serve({ profile: '/nowhere/profile.json', out, url, port: 0, useWord: false, llm: async () => ({}) });
    server.close();
    return null;
  } catch (error) {
    return error;
  } finally {
    stand.close();
  }
}

test('serve() refuses to start on a router speaking another contract major, naming both', async () => {
  const error = await start({ status: 'ok', contract: '2.0' });
  assert.ok(error, 'serve() started against contract 2.0');
  assert.match(error.message, /contract 2\.0\b/);
  assert.match(error.message, /speaks contract 1\.x/);
});

test('serve() starts on a router speaking contract 1, a newer minor, or none', async () => {
  for (const health of [{ status: 'ok', contract: '1.0' }, { status: 'ok', contract: '1.7' }, { status: 'ok' }]) {
    assert.equal(await start(health), null, JSON.stringify(health));
  }
});

// The client of itsaresume's endpoint, against the ways an answer goes wrong
// on a slow single-slot model: it never comes (a timeout the owner can set
// above the router's own), it comes cut (the connection drops mid-body), or
// it comes as a refusal whose real reason is in each backend's attempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTokens, complete, counted } from '../src/llm.js';

/** A stand-in for itsaresume whose every POST gets `answer(request, response)`. */
async function router(answer) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => answer(request, response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const stop = (server) => {
  server.closeAllConnections();
  server.close();
};

test('a connection cut mid-answer is an error at once, not a wait for the timer', async () => {
  const { server, url } = await router((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '5000' });
    response.write('{"backend":"stub","text":"{\\"langu');
    setTimeout(() => response.socket.destroy(), 50);
  });
  try {
    const started = Date.now();
    await assert.rejects(complete({ url, system: 's', prompt: 'p', timeoutMs: 5000 }), /itsaresume.*connection cut mid-answer/);
    assert.ok(Date.now() - started < 2000, `gave up after ${Date.now() - started} ms`);
  } finally {
    stop(server);
  }
});

test("a router refusal carries each backend's own reason", async () => {
  const { server, url } = await router((request, response) => {
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: {
      kind: 'exhausted',
      message: 'every backend failed with a quota or an outage',
      attempts: [
        { backend: 'claude-code', kind: 'quota_exceeded', message: 'usage limit reached' },
        { backend: 'lm-studio', kind: 'timeout', message: 'no answer within 600 s' },
      ],
    } }));
  });
  try {
    await assert.rejects(
      complete({ url, system: 's', prompt: 'p' }),
      /503: every backend failed with a quota or an outage \(claude-code: usage limit reached; lm-studio: no answer within 600 s\)/,
    );
  } finally {
    stop(server);
  }
});

const CLI = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const PROFILE = new URL('./fixtures/profile.synthetic.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

/** The CLI, killed if still running after 20 s. */
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ITSACV_TIMEOUT: '', ...env } });
    const deadline = setTimeout(() => child.kill(), 20_000);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => {
      clearTimeout(deadline);
      resolve({ status, stderr });
    });
  });
}

/** A local model can take 40 minutes; the router gives up on a backend after
 * its own timeout_secs. The client must wait longer than that, so its limit
 * is the owner's to set. */
test('--timeout and ITSACV_TIMEOUT set how long one answer may take', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-timeout-'));
  const offer = join(dir, 'offer.txt');
  writeFileSync(offer, 'Senior SRE wanted. Must: PostgreSQL.');
  // Answers, but after 2 s: a client waiting 1 s never sees it.
  const { server, url } = await router((request, response) => setTimeout(() => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ backend: 'slow', text: 'too late' }));
  }, 2000));
  const base = ['tailor', offer, '--profile', PROFILE, '--out', dir, '--url', url, '--no-layout'];
  try {
    const flag = await runCli([...base, '--timeout', '1']);
    assert.equal(flag.status, 4, flag.stderr);
    assert.match(flag.stderr, /timed out after 1 s/);
    const env = await runCli(base, { ITSACV_TIMEOUT: '1' });
    assert.equal(env.status, 4, env.stderr);
    assert.match(env.stderr, /timed out after 1 s/);
    for (const bad of ['soon', '0', '-5']) {
      const refused = await runCli([...base, '--timeout', bad]);
      assert.equal(refused.status, 2, bad);
      assert.match(refused.stderr, /--timeout/);
    }
  } finally {
    stop(server);
  }
});

test("the usage says the client's timeout must exceed the router backend's", () => {
  const { stderr } = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.match(stderr, /tailor .*\[--timeout SECONDS\]/);
  assert.match(stderr, /serve .*\[--timeout SECONDS\]/);
  assert.match(stderr, /ITSACV_TIMEOUT/);
  assert.match(stderr, /must exceed the router backend's timeout_secs/);
});

// Router 8.39: the answer reports the tokens its backend reported.
test('the answer carries the tokens the router reported, null when it reports none', async () => {
  const usage = { input: 3, output: 179, cache_read: 6914, cache_creation: 7109 };
  const bodies = [{ backend: 'claude-code', text: 'a', attempts: [], usage }, { backend: 'lm-studio', text: 'b', attempts: [] }];
  const { server, url } = await router((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(bodies.shift()));
  });
  try {
    assert.deepEqual(await complete({ url, system: 's', prompt: 'p' }), { text: 'a', backend: 'claude-code', usage });
    assert.deepEqual(await complete({ url, system: 's', prompt: 'p' }), { text: 'b', backend: 'lm-studio', usage: null });
  } finally {
    stop(server);
  }
});

// The owner reads, per run, what each backend took: Claude and the local model apart.
test('tokens are summed per backend; an answer without usage counts as a call only', () => {
  const tokens = {};
  addTokens(tokens, { backend: 'claude-code', usage: { input: 3, output: 179, cache_read: 6914, cache_creation: 7109 } });
  addTokens(tokens, { backend: 'claude-code', usage: { input: 7, output: 21, cache_read: 86, cache_creation: 0 } });
  addTokens(tokens, { backend: 'lm-studio', usage: { input: 24, output: 5 } });
  addTokens(tokens, { backend: 'lm-studio', usage: null });
  assert.deepEqual(tokens, {
    'claude-code': { calls: 2, input: 10, output: 200, cache_read: 7000, cache_creation: 7109 },
    'lm-studio': { calls: 2, input: 24, output: 5, cache_read: 0, cache_creation: 0 },
  });
});

test('a counted model call hands each answer on, unchanged, after the model gave it', async () => {
  const seen = [];
  const llm = counted(async (request) => ({ text: request.prompt, backend: 'b', usage: null }), (answer) => seen.push(answer));
  assert.deepEqual(await llm({ prompt: 'x' }), { text: 'x', backend: 'b', usage: null });
  assert.deepEqual(seen, [{ text: 'x', backend: 'b', usage: null }]);
});

// redteam: the backend name comes from the router's answer; "__proto__" as a
// key would reach Object.prototype. A name that is not a plain id counts as "?".
test('a backend name that is no plain id is counted as "?", and never touches a prototype', () => {
  const tokens = addTokens({}, { backend: '__proto__', usage: { input: 1 } });
  addTokens(tokens, { backend: 'constructor', usage: { input: 2 } });
  assert.equal(({}).calls, undefined);
  assert.deepEqual(Object.keys(tokens), ['?']);
  assert.equal(tokens['?'].input, 3);
});

// Router 8.37: the contract is frozen at 1.x; a router speaking another major
// is refused before its answer is read (docs/ARCHITECTURE.md, Contract).
test("an answer whose contract major is not the client's is refused, naming both", async () => {
  const answers = [
    [200, { contract: '2.0', backend: 'claude-code', text: 'a', attempts: [] }],
    [502, { contract: '2.0', error: { kind: 'stopped', message: 'm' } }],
    [200, { contract: 1, backend: 'claude-code', text: 'a', attempts: [] }],
  ];
  const { server, url } = await router((request, response) => {
    const [status, body] = answers.shift();
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  try {
    for (const spoken of ['2.0', '2.0', '1']) {
      await assert.rejects(complete({ url, system: 's', prompt: 'p' }), (error) => {
        assert.match(error.message, new RegExp(`contract ${spoken.replace('.', '\\.')}\\b`));
        assert.match(error.message, /speaks contract 1\.x/);
        return true;
      });
    }
  } finally {
    stop(server);
  }
});

// ADR in docs/ARCHITECTURE.md (router, Contract): no `contract` key means a
// router older than the field, whose answer is contract 1.0 by construction.
test('an answer without contract, or with a newer minor, is read as contract 1', async () => {
  const bodies = [{ backend: 'lm-studio', text: 'a', attempts: [] }, { contract: '1.3', backend: 'lm-studio', text: 'b', attempts: [] }];
  const { server, url } = await router((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(bodies.shift()));
  });
  try {
    assert.equal((await complete({ url, system: 's', prompt: 'p' })).text, 'a');
    assert.equal((await complete({ url, system: 's', prompt: 'p' })).text, 'b');
  } finally {
    stop(server);
  }
});

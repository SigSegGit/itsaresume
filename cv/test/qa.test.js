// Manual QA: the model the page asks for reaches the router by its backend
// name, and every run lands as one JSON line in the owner's private log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS, backendFor, withModel, appendQaLog, QA_LOG } from '../src/qa.js';

test('auto lets the router choose; claude and local name its backends', () => {
  assert.deepEqual(MODELS, ['auto', 'claude', 'local']);
  assert.equal(backendFor('auto'), undefined);
  assert.equal(backendFor('claude'), 'claude-code');
  assert.equal(backendFor('local'), 'lm-studio');
  assert.throws(() => backendFor('gpt-4'), /model/);
});

test('each run appends one JSON line to the QA log, never rewriting it', () => {
  const out = mkdtempSync(join(tmpdir(), 'itsacv-qa-'));
  appendQaLog(out, { offer: 'one\nline two', model: 'claude' });
  appendQaLog(out, { offer: 'two', model: 'local' });
  const lines = readFileSync(join(out, QA_LOG), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((entry) => [entry.offer, entry.model]), [['one\nline two', 'claude'], ['two', 'local']]);
});

test('a chosen model goes with every call to the router; auto sends none', async () => {
  const sent = [];
  const llm = async (call) => (sent.push(call), { text: '{}', backend: 'x' });
  await withModel(llm, 'local')({ system: 's', prompt: 'p' });
  await withModel(llm, 'auto')({ system: 's', prompt: 'p' });
  assert.deepEqual(sent, [{ system: 's', prompt: 'p', backend: 'lm-studio' }, { system: 's', prompt: 'p', backend: undefined }]);
});

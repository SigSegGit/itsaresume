// 2.16: invitation links, one per ESN, made and revoked by the owner. The
// file lives in the owner's output directory, readable by the owner alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInvite, invitationOf, loadInvites, revokeInvite, usageByInvite } from '../src/invites.js';

const CLI = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const fresh = () => mkdtempSync(join(tmpdir(), 'itsacv-invites-'));

test('an invitation is a fresh 24-hex code naming its label, kept in invites.json for the owner alone', () => {
  const out = fresh();
  const alten = createInvite(out, '  Alten  ');
  const sopra = createInvite(out, 'Sopra Steria');
  assert.match(alten, /^[0-9a-f]{24}$/);
  assert.notEqual(alten, sopra);
  assert.deepEqual(loadInvites(out), { [alten]: { label: 'Alten' }, [sopra]: { label: 'Sopra Steria' } });
  if (process.platform !== 'win32') assert.equal(statSync(join(out, 'invites.json')).mode & 0o777, 0o600);
});

test('a label is a short line of text: empty, too long or with control characters is refused', () => {
  const out = fresh();
  for (const label of ['', '   ', 'x'.repeat(61), 'Alten\nAdmin']) assert.throws(() => createInvite(out, label), /label/);
  assert.deepEqual(loadInvites(out), {});
});

test('an invitation is revoked by its label or its code; a revoked or unknown code names nobody', () => {
  const out = fresh();
  const alten = createInvite(out, 'Alten');
  const sopra = createInvite(out, 'Sopra');
  assert.equal(revokeInvite(out, 'Alten'), 1);
  assert.equal(revokeInvite(out, sopra), 1);
  assert.equal(revokeInvite(out, 'Nobody'), 0);
  const invites = loadInvites(out);
  assert.equal(invitationOf(invites, alten), null);
  assert.equal(invitationOf(invites, sopra), null);
  assert.equal(invitationOf(invites, 'ffffffffffffffffffffffff'), null);
  const capgemini = createInvite(out, 'Capgemini');
  assert.equal(invitationOf(loadInvites(out), capgemini), 'Capgemini');
  assert.equal(invitationOf(loadInvites(out), undefined), null);
  assert.equal(invitationOf(loadInvites(out), '__proto__'), null, 'no inherited key is a code');
});

test('no invites.json is no invitation', () => {
  assert.deepEqual(loadInvites(fresh()), {});
});

test('itsacv invite prints the link, --list shows each one, --revoke ends it', () => {
  const out = fresh();
  const made = spawnSync(process.execPath, [CLI, 'invite', 'Alten', '--out', out, '--public-host', 'cv.example.org'], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const code = Object.keys(loadInvites(out))[0];
  assert.equal(made.stdout.trim(), `https://cv.example.org/?i=${code}`);
  assert.equal(spawnSync(process.execPath, [CLI, 'invite', '--revoke', 'Alten', '--out', out], { encoding: 'utf8' }).status, 0);
  const listed = spawnSync(process.execPath, [CLI, 'invite', '--list', '--out', out], { encoding: 'utf8' });
  assert.equal(listed.stdout.trim(), `Alten\t${code}\trevoked`);
  const none = spawnSync(process.execPath, [CLI, 'invite', '--revoke', 'Nobody', '--out', out], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no invitation/);
});

// Rodin: the label is worth something only if the owner can read, per ESN,
// how many jobs and how many tokens it took, without writing jq by hand.
test('usage per invitation: jobs and tokens per backend, from the QA log; anonymous jobs apart', () => {
  const lines = [
    { invite: 'Alten', status: 'done', tokens: { 'claude-code': { calls: 2, input: 10, output: 200, cache_read: 7000, cache_creation: 7109 } } },
    { invite: 'Alten', status: 'failed', tokens: { 'lm-studio': { calls: 1, input: 24, output: 5, cache_read: 0, cache_creation: 0 } } },
    { invite: 'Alten', status: 'done', reused: true, tokens: null },
    { invite: null, status: 'done', tokens: { 'claude-code': { calls: 1, input: 1, output: 2, cache_read: 0, cache_creation: 0 } } },
  ].map((line) => JSON.stringify(line));
  assert.equal(
    usageByInvite([...lines, 'not json', ''].join('\n')),
    'Alten\t3 jobs (1 reused, 1 failed)\tclaude-code 14119 read 200 written; lm-studio 24 read 5 written\n'
      + '(no invitation)\t1 job\tclaude-code 1 read 2 written\n',
  );
  assert.equal(usageByInvite(''), '');
});

test('itsacv invite --usage reads the QA log of --out', () => {
  const out = fresh();
  writeFileSync(join(out, 'qa-log.jsonl'), `${JSON.stringify({ invite: 'Alten', status: 'done', tokens: null })}\n`);
  const shown = spawnSync(process.execPath, [CLI, 'invite', '--usage', '--out', out], { encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, 'Alten\t1 job\tno tokens\n');
});

// redteam: two ESNs with one label merged in --usage, and --revoke of the
// label ended both. A live label is unique; a revoked one may be reused.
test('a live label is unique: a second invitation with it is refused until the first is revoked', () => {
  const out = fresh();
  createInvite(out, 'Alten');
  assert.throws(() => createInvite(out, 'Alten'), /already/);
  revokeInvite(out, 'Alten');
  assert.match(createInvite(out, 'Alten'), /^[0-9a-f]{24}$/);
});

// redteam: a fixed .tmp name kept a stale file's mode through the rename.
test('invites.json is 0600 even over a stale world-readable temporary file', { skip: process.platform === 'win32' }, () => {
  const out = fresh();
  writeFileSync(join(out, 'invites.json.tmp'), 'stale', { mode: 0o644 });
  createInvite(out, 'Alten');
  assert.equal(statSync(join(out, 'invites.json')).mode & 0o777, 0o600);
});

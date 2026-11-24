// 2026-11-25 (the owner): the premium base backed up every 5 minutes, as a
// differential, encrypted with his own key before ITSaNAS sees it. A full
// base a day and SQLite changesets in between, each one an age file
// (age-encryption.org/v1, X25519) for his public key only: neither the VM,
// nor ITSaNAS, nor this code can read them back without his identity, and
// the official `age` tool decrypts them, so the restore never depends on us.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt, encrypt, generateIdentity, parseIdentity, parseRecipient, recipientOf } from '../premium/age.js';
import { createStore } from '../premium/accounts.js';
import { backupRecipients, restoreJournal } from '../premium/journal.js';

const temp = () => mkdtempSync(join(tmpdir(), 'journal-'));

test('age: an identity and its recipient, in the age encodings; a wrong one refused', () => {
  const { identity, recipient } = generateIdentity();
  assert.match(identity, /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
  assert.match(recipient, /^age1[0-9a-z]{58}$/);
  assert.equal(recipientOf(identity), recipient);
  assert.equal(parseRecipient(recipient).length, 32);
  assert.equal(parseIdentity(`# created: now\n# public key: ${recipient}\n${identity}\n`).length, 32, 'an identity file, comments and all');
  for (const bad of ['age1', `${recipient.slice(0, -1)}q`, recipient.toUpperCase().replace('AGE1', 'age1'), `ag1${recipient.slice(4)}`]) {
    assert.throws(() => parseRecipient(bad), /recipient/, bad);
  }
});

test('age: what one encrypts only its identity decrypts, whatever the size; any change is refused', () => {
  const one = generateIdentity();
  const two = generateIdentity();
  for (const size of [0, 1, 65536, 65537, 200000]) {
    const plain = Buffer.alloc(size, size % 251);
    const sealed = encrypt(plain, [one.recipient, two.recipient]);
    assert.match(sealed.subarray(0, 40).toString('latin1'), /^age-encryption\.org\/v1\n-> X25519 /);
    assert.deepEqual(decrypt(sealed, one.identity), plain, `size ${size}, first recipient`);
    assert.deepEqual(decrypt(sealed, two.identity), plain, `size ${size}, second recipient`);
    assert.throws(() => decrypt(sealed, generateIdentity().identity), /no identity/);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decrypt(tampered, one.identity));
  }
  const sealed = encrypt(Buffer.from('header'), [one.recipient]);
  const header = Buffer.from(sealed);
  // One character of the header's MAC changed: only the MAC check sees it.
  const at = header.indexOf('\n--- ') + 5;
  header[at] = header[at] === 0x41 ? 0x42 : 0x41;
  assert.throws(() => decrypt(header, one.identity), /MAC/, 'the header is authenticated');
  // Two encryptions of the same bytes differ (fresh file key and nonce).
  assert.notDeepEqual(encrypt(Buffer.from('x'), [one.recipient]), encrypt(Buffer.from('x'), [one.recipient]));
});

// The point of the format: the owner's restore does not need this code.
const age = spawnSync('age', ['--version']).status === 0;
test('age: the official tool decrypts what this code encrypts, and the reverse', { skip: !age && 'no `age` on PATH (CI installs it)' }, () => {
  const dir = temp();
  try {
    const { identity, recipient } = generateIdentity();
    writeFileSync(join(dir, 'key.txt'), `${identity}\n`);
    const plain = Buffer.alloc(150000, 7);
    writeFileSync(join(dir, 'ours.age'), encrypt(plain, [recipient]));
    assert.deepEqual(execFileSync('age', ['-d', '-i', join(dir, 'key.txt'), join(dir, 'ours.age')]), plain);
    writeFileSync(join(dir, 'plain'), plain);
    execFileSync('age', ['-r', recipient, '-o', join(dir, 'theirs.age'), join(dir, 'plain')]);
    assert.deepEqual(decrypt(readFileSync(join(dir, 'theirs.age')), identity), plain);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function busy(store, n) {
  store.register(`user${n}@example.org`, 'long enough');
  const user = store.user(store.login(`user${n}@example.org`, 'long enough').token);
  store.buy(user, 'pack5');
}

test('the journal: a base, then a changeset per 5 minutes that saw writes; the restore is the live base', () => {
  const dir = temp();
  try {
    const { identity, recipient } = generateIdentity();
    const store = createStore(join(dir, 'premium.db'));
    busy(store, 1);
    let now = Date.parse('2026-11-25T10:00:00Z');
    const journal = store.openJournal({ dir: join(dir, 'backup'), recipients: [recipient], now: () => now });
    journal.start();
    busy(store, 2);
    now += 300000;
    journal.tick();
    now += 300000;
    journal.tick();
    store.adjustCredits('boss@example.org', 'user1@example.org', 3, 'gift');
    now += 300000;
    journal.tick();
    const files = readdirSync(join(dir, 'backup')).sort();
    assert.deepEqual(files, ['20261125T1000.base.db.age', '20261125T1000.c000001.age', '20261125T1000.c000002.age'], 'nothing written when nothing changed; no temporary file left');
    for (const file of files) assert.equal(readFileSync(join(dir, 'backup', file)).subarray(0, 21).toString(), 'age-encryption.org/v1');
    const restored = restoreJournal(join(dir, 'backup'), identity, join(dir, 'restored.db'));
    assert.deepEqual(restored.stats, store.stats());
    assert.equal(restored.changes, 2);
    // The owner's command, on his machine: the same result, exit 0.
    writeFileSync(join(dir, 'key.txt'), `# public key: ${recipient}\n${identity}\n`);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../premium/journal-restore.js', import.meta.url)), join(dir, 'backup'), join(dir, 'key.txt'), join(dir, 'cli.db')], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout).stats, store.stats());
    // A changeset lost in transit stops the restore instead of a silent gap.
    rmSync(join(dir, 'backup', '20261125T1000.c000001.age'));
    assert.throws(() => restoreJournal(join(dir, 'backup'), identity, join(dir, 'gap.db')), /changeset 1 of 20261125T1000 is missing/);
    assert.equal(restored.integrity, 'ok');
    const copy = createStore(join(dir, 'restored.db'));
    assert.deepEqual(copy.adminUsers(''), store.adminUsers(''));
    copy.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the journal: a new base a day, the last 7 chains kept, a restore takes the newest whole chain', () => {
  const dir = temp();
  try {
    const { identity, recipient } = generateIdentity();
    const store = createStore(join(dir, 'premium.db'));
    let now = Date.parse('2026-11-01T00:00:00Z');
    const journal = store.openJournal({ dir: join(dir, 'backup'), recipients: [recipient], now: () => now });
    journal.start();
    for (let day = 0; day < 9; day += 1) {
      busy(store, day);
      now += 86400000;
      journal.tick();
    }
    const bases = readdirSync(join(dir, 'backup')).filter((name) => name.endsWith('.base.db.age'));
    assert.equal(bases.length, 7);
    assert.equal(bases.sort()[0], '20261104T0000.base.db.age');
    assert.ok(readdirSync(join(dir, 'backup')).every((name) => !name.startsWith('20261101') && !name.startsWith('20261102') && !name.startsWith('20261103')), 'an old chain goes whole');
    assert.deepEqual(restoreJournal(join(dir, 'backup'), identity, join(dir, 'restored.db')).stats, store.stats());
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the journal is off without a key; a key that is not an age recipient stops the server at start', () => {
  assert.deepEqual(backupRecipients({}), []);
  const { recipient } = generateIdentity();
  assert.deepEqual(backupRecipients({ PREMIUM_BACKUP_RECIPIENTS: ` ${recipient} ,` }), [recipient]);
  assert.throws(() => backupRecipients({ PREMIUM_BACKUP_RECIPIENTS: 'ssh-ed25519 AAAA' }), /PREMIUM_BACKUP_RECIPIENTS/);
  const server = readFileSync(new URL('../premium/server.js', import.meta.url), 'utf8');
  assert.match(server, /setInterval\(\(\) => logged\('journal', \(\) => journal\.tick\(\)\), JOURNAL_EVERY_MS\)/);
  assert.match(server, /journal: journal\?\.status\(\) \?\? null/);
  const script = readFileSync(new URL('../deploy/vm-generator/itsanas-premium.sh', import.meta.url), 'utf8');
  assert.match(script, /SNAPSHOTS="\$\{ITSACV_DATA:-\$HOME\/itsacv-data\}\/premium\/backup"/, 'ITSaNAS syncs the encrypted journal, never the plain snapshots');
});

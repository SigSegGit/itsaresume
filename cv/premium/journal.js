// 2026-11-25 (the owner): the premium base, backed up as it changes. A chain
// is a full base (VACUUM INTO) then SQLite changesets, one per 5 minutes that
// saw writes; a new chain a day, the last CHAINS_KEPT kept. Every file is an
// age file for the owner's recipients only, written once under its final
// name (a temporary dot-file renamed), never rewritten: what ITSaNAS syncs.
//   <chain>.base.db.age, <chain>.c000001.age, <chain>.c000002.age, ...
// Restore: the newest chain's base, then its changesets in order (any `age`
// opens each file; restoreJournal does it all with the identity).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, constants } from 'node:sqlite';
import { decrypt, encrypt, parseRecipient } from './age.js';
import { createStore } from './accounts.js';

export const JOURNAL_EVERY_MS = 5 * 60 * 1000;
export const BASE_EVERY_MS = 24 * 60 * 60 * 1000;
export const CHAINS_KEPT = 7;

const BASE = /^(\d{8}T\d{4}(?:-\d+)?)\.base\.db\.age$/;
const CHANGES = /^(\d{8}T\d{4}(?:-\d+)?)\.c(\d{6})\.age$/;
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, '');

/** The owner's age recipients from PREMIUM_BACKUP_RECIPIENTS (comma-separated); none: no journal. */
export function backupRecipients(env = process.env) {
  const given = String(env.PREMIUM_BACKUP_RECIPIENTS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const recipient of given) {
    try {
      parseRecipient(recipient);
    } catch (error) {
      throw new Error(`PREMIUM_BACKUP_RECIPIENTS: "${recipient.slice(0, 20)}…" is not an age recipient (age1…): ${error.message}`);
    }
  }
  return given;
}

/** The journal of `db` in `dir`; `start()` writes a base, `tick()` every JOURNAL_EVERY_MS. */
export function createJournal({ db, dir, recipients, now = Date.now }) {
  if (!recipients.length) throw new Error('journal: no recipient');
  recipients.forEach(parseRecipient);
  let session = null;
  let chain = null;
  let seq = 0;
  let baseAt = 0;
  let lastAt = null;

  const put = (name, bytes) => {
    const temporary = join(dir, `.${name}.tmp`);
    writeFileSync(temporary, encrypt(bytes, recipients), { mode: 0o600 });
    renameSync(temporary, join(dir, name));
    lastAt = now();
  };

  function prune() {
    const chains = readdirSync(dir).map((name) => BASE.exec(name)?.[1]).filter(Boolean).sort();
    for (const old of chains.slice(0, -CHAINS_KEPT)) {
      for (const name of readdirSync(dir)) if (name.startsWith(`${old}.`)) rmSync(join(dir, name), { force: true });
    }
  }

  function base() {
    const at = now();
    let name = stamp(at);
    for (let n = 2; existsSync(join(dir, `${name}.base.db.age`)); n += 1) name = `${stamp(at)}-${n}`;
    const plain = join(dir, `.${name}.base.db`);
    rmSync(plain, { force: true });
    // The copy and the new session in one synchronous step: no write between.
    db.exec(`VACUUM INTO '${plain.replaceAll("'", "''")}'`);
    session?.close();
    session = db.createSession();
    chain = null;
    try {
      put(`${name}.base.db.age`, readFileSync(plain));
    } finally {
      rmSync(plain, { force: true });
    }
    chain = name;
    seq = 0;
    baseAt = at;
    prune();
  }

  /** The changes since the last file; the session restarts only once they are written. */
  function flush() {
    const changes = session.changeset();
    if (!changes.length) return;
    put(`${chain}.c${String(seq + 1).padStart(6, '0')}.age`, Buffer.from(changes));
    seq += 1;
    session.close();
    session = db.createSession();
  }

  return {
    start() {
      mkdirSync(dir, { recursive: true });
      base();
    },
    tick() {
      if (!chain) return base();
      flush();
      if (now() - baseAt >= BASE_EVERY_MS) base();
    },
    status() {
      return { chain, changes: seq, last_at: lastAt === null ? null : new Date(lastAt).toISOString() };
    },
    close() {
      if (chain) flush();
      session?.close();
      session = null;
    },
  };
}

/**
 * The newest chain of `dir` restored into `out` with the owner's identity
 * (its file text): the base, then every changeset in order; a missing one
 * stops it. Returns the chain, the changesets applied, integrity and counts.
 */
export function restoreJournal(dir, identity, out) {
  const names = readdirSync(dir);
  const chain = names.map((name) => BASE.exec(name)?.[1]).filter(Boolean).sort().at(-1);
  if (!chain) throw new Error(`restore: no base in ${dir}`);
  const changes = names.map((name) => CHANGES.exec(name)).filter((match) => match?.[1] === chain).map((match) => Number(match[2])).sort((a, b) => a - b);
  changes.forEach((number, index) => {
    if (number !== index + 1) throw new Error(`restore: changeset ${index + 1} of ${chain} is missing`);
  });
  rmSync(out, { force: true });
  writeFileSync(out, decrypt(readFileSync(join(dir, `${chain}.base.db.age`)), identity), { mode: 0o600 });
  const db = new DatabaseSync(out);
  try {
    for (const number of changes) {
      const set = decrypt(readFileSync(join(dir, `${chain}.c${String(number).padStart(6, '0')}.age`)), identity);
      if (!db.applyChangeset(set, { onConflict: () => constants.SQLITE_CHANGESET_ABORT })) throw new Error(`restore: changeset ${number} of ${chain} conflicts`);
    }
  } finally {
    db.close();
  }
  const store = createStore(out);
  try {
    return { chain, changes: changes.length, integrity: store.verify(), stats: store.stats() };
  } finally {
    store.close();
  }
}

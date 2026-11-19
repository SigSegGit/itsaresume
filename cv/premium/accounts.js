// 6.4: accounts, sessions, credits, orders, CVs and the profile chat.
// 6.4f (the owner, 2026-11-19): a real database: SQLite through Node's own
// node:sqlite, one file (premium.db), no dependency. secure_delete and a
// rollback journal: an erased row leaves no trace in the file (GDPR).
// backup() writes a consistent snapshot (VACUUM INTO): the snapshots, never
// the live file, are what a sync (ITSaNAS) copies.
//
// 6.4c GDPR: export, erasure of the profile or the whole account, retention
// limits applied by purge(). No payment method is ever stored here.

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PACKS } from './pricing.js';

export const MIN_PASSWORD = 8;
export const PREVIEWS_PER_DAY = 3;
/** 6.4d: the profile chat: messages given with the first purchase, and per credit spent. */
export const CHAT = { free: 20, perCredit: 20 };
/** A password reset link lives an hour, once. */
const RESET_MS = 3600000;
/** The privacy notice's version a new account accepts (web/privacy.html). */
export const PRIVACY_VERSION = '2026-11-19';
/**
 * Retention, in days: a session; a generated CV; an account with no login
 * (then erased). Orders: 10 years (French accounting law), without the
 * address once the account is erased. Snapshots kept: the last 48.
 */
export const RETENTION = { sessionDays: 30, cvDays: 365, inactiveDays: 730, orderYears: 10, snapshots: 48 };
const DAY = 86400000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CHAT_KEPT = 40;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0,
  profile TEXT, previews TEXT NOT NULL DEFAULT '{}', chat_left INTEGER,
  created_at TEXT NOT NULL, accepted_at TEXT NOT NULL, privacy_version TEXT NOT NULL, last_login TEXT);
CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, email TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resets (key TEXT PRIMARY KEY, email TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, email TEXT, pack TEXT NOT NULL, credits INTEGER NOT NULL, currency TEXT NOT NULL,
  price REAL NOT NULL, simulated INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, title TEXT, created TEXT NOT NULL,
  demo INTEGER, score REAL, error TEXT, page TEXT);
CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL, reply TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_email ON jobs (email, created);
CREATE INDEX IF NOT EXISTS chat_email ON chat (email, id);
CREATE INDEX IF NOT EXISTS orders_email ON orders (email);
`;

const hash = (password, salt) => scryptSync(password, salt, 32).toString('hex');
const tokenKey = (token) => createHash('sha256').update(String(token)).digest('hex');
const day = (now) => new Date(now).toISOString().slice(0, 10);
const iso = (now) => new Date(now).toISOString();
const json = (text, fallback) => (text == null ? fallback : JSON.parse(text));

/** file: the database file, or null for one in memory (tests). */
export function createStore(file) {
  const db = new DatabaseSync(file ?? ':memory:');
  db.exec('PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;');
  db.exec(SCHEMA);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = (work) => {
    db.exec('BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const jobOf = (row) => ({
    id: row.id, status: row.status, title: row.title, created: row.created, demo: Boolean(row.demo),
    ...(row.score != null ? { score: row.score } : {}), ...(row.error ? { error: row.error } : {}), ...(row.page ? { page: JSON.parse(row.page) } : {}),
  });
  /** A user as the server reads it: a plain object, reloaded per request. */
  const load = (email) => {
    const row = one('SELECT * FROM users WHERE email = ?', email);
    if (!row) return null;
    const history = all('SELECT at, message, reply FROM chat WHERE email = ? ORDER BY id', email);
    return {
      email: row.email, salt: row.salt, hash: row.hash, credits: row.credits, profile: json(row.profile, null), previews: json(row.previews, {}),
      jobs: all('SELECT * FROM jobs WHERE email = ? ORDER BY created DESC LIMIT 50', email).map(jobOf),
      ...(row.chat_left == null ? {} : { chat: { left: row.chat_left, history } }),
      created_at: row.created_at, accepted_at: row.accepted_at, privacy_version: row.privacy_version, last_login: row.last_login,
    };
  };
  const open = (email, now) => {
    const token = randomBytes(24).toString('hex');
    run('INSERT INTO sessions (key, email, at) VALUES (?, ?, ?)', tokenKey(token), email, now);
    run('UPDATE users SET last_login = ? WHERE email = ?', iso(now), email);
    return { token };
  };
  const checked = (user, password) => {
    const given = Buffer.from(hash(String(password ?? ''), user?.salt ?? 'none'), 'hex');
    return Boolean(user) && timingSafeEqual(given, Buffer.from(user.hash, 'hex'));
  };
  const erase = (email) => {
    for (const table of ['users', 'sessions', 'resets', 'jobs', 'chat']) run(`DELETE FROM ${table} WHERE email = ?`, email);
    // The orders stay for the accounts, pseudonymous.
    run('UPDATE orders SET email = NULL WHERE email = ?', email);
  };
  const credit = (user, delta) => {
    run('UPDATE users SET credits = credits + ? WHERE email = ?', delta, user.email);
    user.credits += delta;
  };

  const store = {
    register(email, password, now = Date.now()) {
      const key = String(email ?? '').trim().toLowerCase();
      if (!EMAIL.test(key)) throw new Error('email: not an address');
      if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`password: ${MIN_PASSWORD} characters at least`);
      if (one('SELECT 1 AS x FROM users WHERE email = ?', key)) throw new Error('an account exists for this address');
      const salt = randomBytes(16).toString('hex');
      run('INSERT INTO users (email, salt, hash, created_at, accepted_at, privacy_version) VALUES (?, ?, ?, ?, ?, ?)', key, salt, hash(password, salt), iso(now), iso(now), PRIVACY_VERSION);
      return open(key, now);
    },
    login(email, password, now = Date.now()) {
      const user = load(String(email ?? '').trim().toLowerCase());
      if (!checked(user, password)) throw new Error('wrong address or password');
      return open(user.email, now);
    },
    logout(token) {
      run('DELETE FROM sessions WHERE key = ?', tokenKey(token));
    },
    user(token, now = Date.now()) {
      const session = token ? one('SELECT email, at FROM sessions WHERE key = ?', tokenKey(token)) : undefined;
      if (!session || now - session.at > RETENTION.sessionDays * DAY) return null;
      return load(session.email);
    },
    /** Simulated payment. local: { currency, price } of the market grid; EUR by default. */
    buy(user, packId, local = null) {
      const pack = PACKS.find((entry) => entry.id === packId);
      if (!pack) throw new Error('pack: unknown');
      const order = { id: randomBytes(6).toString('hex'), email: user.email, pack: pack.id, credits: pack.credits, currency: local?.currency ?? 'EUR', price: local?.price ?? pack.price, simulated: true, at: new Date().toISOString() };
      transaction(() => {
        credit(user, pack.credits);
        run('UPDATE users SET chat_left = COALESCE(chat_left, ?) WHERE email = ?', CHAT.free, user.email);
        run('INSERT INTO orders (id, email, pack, credits, currency, price, simulated, at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', order.id, order.email, order.pack, order.credits, order.currency, order.price, order.at);
      });
      user.chat ??= { left: CHAT.free, history: [] };
      return order;
    },
    hasPaid(user) {
      return Boolean(one('SELECT 1 AS x FROM orders WHERE email = ? LIMIT 1', user.email));
    },
    order(user, id) {
      const row = one('SELECT * FROM orders WHERE id = ? AND email = ?', id, user.email);
      return row ? { ...row, simulated: Boolean(row.simulated) } : null;
    },
    debit(user) {
      if (user.credits < 1) throw new Error('no credit left');
      credit(user, -1);
    },
    refund(user) {
      credit(user, 1);
    },
    /** One exchange of the profile chat; the last CHAT_KEPT kept. */
    chatSaid(user, message, reply) {
      transaction(() => {
        run('UPDATE users SET chat_left = chat_left - 1 WHERE email = ?', user.email);
        run('INSERT INTO chat (email, at, message, reply) VALUES (?, ?, ?, ?)', user.email, iso(Date.now()), message, reply);
        run('DELETE FROM chat WHERE email = ? AND id NOT IN (SELECT id FROM chat WHERE email = ? ORDER BY id DESC LIMIT ?)', user.email, user.email, CHAT_KEPT);
      });
      user.chat.left -= 1;
    },
    refillChat(user) {
      if (user.credits <= 0) throw new Error('no credit left for the chat');
      transaction(() => {
        credit(user, -1);
        run('UPDATE users SET chat_left = chat_left + ? WHERE email = ?', CHAT.perCredit, user.email);
      });
      user.chat.left += CHAT.perCredit;
    },
    previewAllowed(user, now = Date.now()) {
      const today = day(now);
      const count = (user.previews?.[today] ?? 0) + 1;
      user.previews = { [today]: count };
      run('UPDATE users SET previews = ? WHERE email = ?', JSON.stringify(user.previews), user.email);
      return count <= PREVIEWS_PER_DAY;
    },
    setProfile(user, profile) {
      run('UPDATE users SET profile = ? WHERE email = ?', JSON.stringify(profile), user.email);
      user.profile = profile;
    },
    deleteProfile(user) {
      run('UPDATE users SET profile = NULL WHERE email = ?', user.email);
      user.profile = null;
    },
    addJob(user, job) {
      run('INSERT INTO jobs (id, email, status, title, created, demo) VALUES (?, ?, ?, ?, ?, ?)', job.id, user.email, job.status, job.title ?? '', job.created, job.demo ? 1 : 0);
      if (job.page) store.saveJob(user, job);
      user.jobs.unshift(job);
    },
    /** A job's outcome, once the generation ends. */
    saveJob(user, job) {
      run('UPDATE jobs SET status = ?, score = ?, error = ?, page = ? WHERE id = ? AND email = ?', job.status, job.score ?? null, job.error ?? null, job.page ? JSON.stringify(job.page) : null, job.id, user.email);
    },
    /** A one-time reset token for an address; null when no account (said to nobody). */
    resetToken(email, now = Date.now()) {
      const user = one('SELECT email FROM users WHERE email = ?', String(email ?? '').trim().toLowerCase());
      if (!user) return null;
      const token = randomBytes(24).toString('hex');
      run('INSERT INTO resets (key, email, at) VALUES (?, ?, ?)', tokenKey(token), user.email, now);
      return token;
    },
    resetPassword(token, password, now = Date.now()) {
      const key = tokenKey(token);
      const reset = one('SELECT email, at FROM resets WHERE key = ?', key);
      run('DELETE FROM resets WHERE key = ?', key);
      if (!reset || now - reset.at > RESET_MS || !one('SELECT 1 AS x FROM users WHERE email = ?', reset.email)) throw new Error('this link is invalid or expired');
      if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`password: ${MIN_PASSWORD} characters at least`);
      const salt = randomBytes(16).toString('hex');
      transaction(() => {
        run('UPDATE users SET salt = ?, hash = ? WHERE email = ?', salt, hash(password, salt), reset.email);
        run('DELETE FROM sessions WHERE email = ?', reset.email);
      });
    },
    /** Everything held on the account, as JSON (GDPR art. 15 and 20); null when none. */
    exportOf(user) {
      const stored = user?.email ? load(user.email) : null;
      if (!stored) return null;
      const { hash: _hash, salt: _salt, profile, jobs, ...account } = stored;
      const orders = all('SELECT * FROM orders WHERE email = ? ORDER BY at', stored.email).map((row) => ({ ...row, simulated: Boolean(row.simulated) }));
      return { account, profile, jobs, orders, retention: RETENTION, privacy_version: PRIVACY_VERSION };
    },
    /** Erasure (GDPR art. 17), the password asked again. */
    deleteAccount(user, password) {
      if (!checked(load(user.email), password)) throw new Error('wrong password');
      transaction(() => erase(user.email));
    },
    /** Applies the retention limits; run daily. */
    purge(now = Date.now()) {
      transaction(() => {
        run('DELETE FROM sessions WHERE ? - at > ?', now, RETENTION.sessionDays * DAY);
        run('DELETE FROM resets WHERE ? - at > ?', now, RESET_MS);
        run('DELETE FROM jobs WHERE created < ?', iso(now - RETENTION.cvDays * DAY));
        for (const { email } of all('SELECT email FROM users WHERE COALESCE(last_login, created_at) < ?', iso(now - RETENTION.inactiveDays * DAY))) erase(email);
        run('DELETE FROM orders WHERE at < ?', iso(now - RETENTION.orderYears * 366 * DAY));
      });
    },
    /** Counts, for tests and the founder's view. */
    stats() {
      return Object.fromEntries(['users', 'sessions', 'orders', 'jobs', 'chat'].map((table) => [table, one(`SELECT COUNT(*) AS n FROM ${table}`).n]));
    },
    /**
     * A consistent snapshot in `dir` (what ITSaNAS syncs, never the live
     * file); the last RETENTION.snapshots kept. Returns its path.
     */
    backup(dir, now = Date.now()) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `premium-${iso(now).slice(0, 13).replace(/[-:T]/g, '')}.db`);
      rmSync(path, { force: true });
      db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
      const snapshots = readdirSync(dir).filter((name) => /^premium-\d{10}\.db$/.test(name)).sort();
      for (const old of snapshots.slice(0, -RETENTION.snapshots)) rmSync(join(dir, old), { force: true });
      return path;
    },
    close() {
      db.close();
    },
  };
  return store;
}

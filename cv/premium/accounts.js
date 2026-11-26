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
import { createJournal } from './journal.js';

export const MIN_PASSWORD = 8;
export const PREVIEWS_PER_DAY = 3;
/** 6.4d: the profile chat: messages given with the first purchase, and per credit spent. */
export const CHAT = { free: 20, perCredit: 20 };
/** A password reset link lives an hour, once. */
const RESET_MS = 3600000;
/** 6.10: an address confirmation link lives a day. */
const VERIFY_MS = 86400000;
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
CREATE TABLE IF NOT EXISTS verifications (key TEXT PRIMARY KEY, email TEXT NOT NULL, at INTEGER NOT NULL);
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
CREATE TABLE IF NOT EXISTS pending_orders (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, pack TEXT NOT NULL, credits INTEGER NOT NULL, currency TEXT NOT NULL,
  price REAL NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, admin TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL);
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
  // 6.8b: an order's refund, on databases made before the column existed.
  // 6.10: the address confirmed, on databases made before the column existed.
  if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'verified_at')) db.exec('ALTER TABLE users ADD COLUMN verified_at TEXT');
  if (!db.prepare('PRAGMA table_info(orders)').all().some((column) => column.name === 'refunded_at')) db.exec('ALTER TABLE orders ADD COLUMN refunded_at TEXT');
  // 6.14: the provider's payment reference, so its refund finds the order.
  if (!db.prepare('PRAGMA table_info(orders)').all().some((column) => column.name === 'payment_ref')) db.exec('ALTER TABLE orders ADD COLUMN payment_ref TEXT');
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
      verified: row.verified_at != null,
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
    for (const table of ['users', 'sessions', 'resets', 'verifications', 'jobs', 'chat', 'pending_orders']) run(`DELETE FROM ${table} WHERE email = ?`, email);
    // The orders stay for the accounts, pseudonymous.
    run('UPDATE orders SET email = NULL WHERE email = ?', email);
  };
  // 6.8b, 6.14: a refunded order: the credits it gave that are left go back, logged.
  const takeBack = (order, admin, why, now) => {
    let taken = 0;
    if (order.email) {
      const row = one('SELECT credits FROM users WHERE email = ?', order.email);
      taken = row ? Math.min(row.credits, order.credits) : 0;
      if (taken) run('UPDATE users SET credits = credits - ? WHERE email = ?', taken, order.email);
    }
    run('UPDATE orders SET refunded_at = ? WHERE id = ?', iso(now), order.id);
    run('INSERT INTO admin_log (at, admin, target, action) VALUES (?, ?, ?, ?)', iso(now), admin, order.email ?? '(erased)', `refund ${order.id}: ${why.slice(0, 200)} (credits -${taken})`);
    return taken;
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
    /** 6.12: an order waiting for its payment (Stripe); no credit yet. */
    pendingOrder(user, packId, local = null) {
      const pack = PACKS.find((entry) => entry.id === packId);
      if (!pack) throw new Error('pack: unknown');
      const order = { id: randomBytes(6).toString('hex'), email: user.email, pack: pack.id, credits: pack.credits, currency: local?.currency ?? 'EUR', price: local?.price ?? pack.price, simulated: false, pending: true, at: new Date().toISOString() };
      run('INSERT INTO pending_orders (id, email, pack, credits, currency, price, at) VALUES (?, ?, ?, ?, ?, ?, ?)', order.id, order.email, order.pack, order.credits, order.currency, order.price, order.at);
      return order;
    },
    /** 6.12: the paid event: credits the order once, for its own amount and currency. */
    confirmPaid(id, { amount, currency, ref = null }) {
      return transaction(() => {
        const pending = one('SELECT * FROM pending_orders WHERE id = ?', String(id));
        if (!pending) {
          if (one('SELECT 1 AS x FROM orders WHERE id = ?', String(id))) return 'already';
          throw new Error('no such order');
        }
        if (Number(amount) !== Math.round(pending.price * 100) || String(currency).toUpperCase() !== pending.currency) throw new Error('amount or currency differs from the order');
        const user = one('SELECT email, credits FROM users WHERE email = ?', pending.email);
        if (!user) throw new Error('no such account');
        credit(user, pending.credits);
        run('UPDATE users SET chat_left = COALESCE(chat_left, ?) WHERE email = ?', CHAT.free, pending.email);
        run('INSERT INTO orders (id, email, pack, credits, currency, price, simulated, at, payment_ref) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)', pending.id, pending.email, pending.pack, pending.credits, pending.currency, pending.price, new Date().toISOString(), ref == null ? null : String(ref));
        run('DELETE FROM pending_orders WHERE id = ?', pending.id);
        return 'credited';
      });
    },
    /** 6.14: the provider's full refund of a payment: as refundOrder, by the provider's reference. */
    refundPaid(ref, now = Date.now()) {
      if (!ref) return 'unknown';
      return transaction(() => {
        const order = one('SELECT id, email, credits, refunded_at FROM orders WHERE payment_ref = ?', String(ref));
        if (!order) return 'unknown';
        if (order.refunded_at) return 'already';
        takeBack(order, 'stripe', 'refunded at the payment provider', now);
        return 'refunded';
      });
    },
    /** 6.14: an expired Checkout: its order was never paid, it goes. */
    dropPending(id) {
      return run('DELETE FROM pending_orders WHERE id = ?', String(id ?? '')).changes ? 'dropped' : 'none';
    },
    /** 6.13: the account's own orders, newest first, what a receipt needs. */
    ordersOf(user) {
      return all('SELECT id, at, pack, credits, currency, price, simulated, refunded_at FROM orders WHERE email = ? ORDER BY at DESC', user.email)
        .map((row) => ({ ...row, simulated: Boolean(row.simulated) }));
    },
    hasPaid(user) {
      return Boolean(one('SELECT 1 AS x FROM orders WHERE email = ? LIMIT 1', user.email));
    },
    order(user, id) {
      const row = one('SELECT id, email, pack, credits, currency, price, simulated, at, refunded_at FROM orders WHERE id = ? AND email = ?', id, user.email);
      if (row) return { ...row, simulated: Boolean(row.simulated), pending: false };
      const pending = one('SELECT * FROM pending_orders WHERE id = ? AND email = ?', id, user.email);
      return pending ? { ...pending, simulated: false, pending: true } : null;
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
    /** 6.10: a one-time link confirming an address; null when no account. */
    verifyToken(email, now = Date.now()) {
      const user = one('SELECT email FROM users WHERE email = ?', String(email ?? '').trim().toLowerCase());
      if (!user) return null;
      const token = randomBytes(24).toString('hex');
      run('INSERT INTO verifications (key, email, at) VALUES (?, ?, ?)', tokenKey(token), user.email, now);
      return token;
    },
    /** 6.10: follows a confirmation link, once, within a day; returns the address. */
    confirmEmail(token, now = Date.now()) {
      const key = tokenKey(token);
      const found = one('SELECT email, at FROM verifications WHERE key = ?', key);
      run('DELETE FROM verifications WHERE key = ?', key);
      if (!found || now - found.at >= VERIFY_MS || !one('SELECT 1 AS x FROM users WHERE email = ?', found.email)) throw new Error('this link is invalid or expired');
      run('UPDATE users SET verified_at = COALESCE(verified_at, ?) WHERE email = ?', iso(now), found.email);
      return found.email;
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
        run('DELETE FROM verifications WHERE ? - at > ?', now, VERIFY_MS);
        run('DELETE FROM jobs WHERE created < ?', iso(now - RETENTION.cvDays * DAY));
        for (const { email } of all('SELECT email FROM users WHERE COALESCE(last_login, created_at) < ?', iso(now - RETENTION.inactiveDays * DAY))) erase(email);
        run('DELETE FROM orders WHERE at < ?', iso(now - RETENTION.orderYears * 366 * DAY));
        // 6.12: an order never paid goes after a week.
        run('DELETE FROM pending_orders WHERE at < ?', iso(now - 7 * DAY));
      });
    },
    /** Counts, for tests and the founder's view. */
    stats() {
      return Object.fromEntries(['users', 'sessions', 'orders', 'jobs', 'chat'].map((table) => [table, one(`SELECT COUNT(*) AS n FROM ${table}`).n]));
    },
    /** 6.8: SQLite's own integrity check, 'ok' when sound. */
    verify() {
      return all('PRAGMA integrity_check').map((row) => Object.values(row)[0]).join('; ');
    },
    /** 6.8: the accounts for the admin page; never a hash, a salt or a profile. */
    adminUsers(query = '', limit = 200) {
      const like = `%${String(query).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return all(`SELECT u.email, u.credits, u.created_at, u.last_login, u.chat_left,
          (SELECT COUNT(*) FROM orders o WHERE o.email = u.email) AS orders,
          (SELECT COUNT(*) FROM jobs j WHERE j.email = u.email) AS jobs,
          (u.profile IS NOT NULL) AS has_profile
        FROM users u WHERE u.email LIKE ? ESCAPE '\\' ORDER BY u.created_at DESC LIMIT ?`, like, Math.min(Math.max(1, Number(limit) || 200), 1000))
        .map((row) => ({ ...row, has_profile: Boolean(row.has_profile) }));
    },
    /** 6.8: an admin's credit change: a reason, never below zero, logged. Returns the new balance. */
    adjustCredits(admin, email, delta, reason, now = Date.now()) {
      const why = String(reason ?? '').trim();
      if (!why) throw new Error('reason: required');
      if (!Number.isInteger(delta) || delta === 0) throw new Error('delta: a non-zero whole number');
      return transaction(() => {
        const row = one('SELECT credits FROM users WHERE email = ?', email);
        if (!row) throw new Error('no such account');
        if (row.credits + delta < 0) throw new Error('credits: never below zero');
        run('UPDATE users SET credits = credits + ? WHERE email = ?', delta, email);
        run('INSERT INTO admin_log (at, admin, target, action) VALUES (?, ?, ?, ?)', iso(now), admin, email, `credits ${delta > 0 ? '+' : ''}${delta}: ${why.slice(0, 200)}`);
        return row.credits + delta;
      });
    },
    /** An admin action outside the accounts (an invitation made or revoked). */
    noteAdmin(admin, target, action) {
      run('INSERT INTO admin_log (at, admin, target, action) VALUES (?, ?, ?, ?)', iso(Date.now()), admin, String(target).slice(0, 200), String(action).slice(0, 200));
    },
    adminLog(limit = 100) {
      return all('SELECT at, admin, target, action FROM admin_log ORDER BY id DESC LIMIT ?', limit);
    },
    /** 6.8: orders and totals per currency; a refunded order counts for nothing. */
    revenue() {
      return all(`SELECT currency, SUM(refunded_at IS NULL) AS orders, ROUND(COALESCE(SUM(CASE WHEN refunded_at IS NULL THEN price END), 0), 2) AS total,
          SUM(CASE WHEN refunded_at IS NULL THEN simulated ELSE 0 END) AS simulated FROM orders GROUP BY currency ORDER BY currency`).map((row) => ({ ...row }));
    },
    /** 6.8b: the orders, newest first. */
    adminOrders(limit = 500) {
      return all('SELECT id, at, email, pack, credits, currency, price, simulated, refunded_at FROM orders ORDER BY at DESC LIMIT ?', limit).map((row) => ({ ...row }));
    },
    /** 6.8b: the orders for the accounts; a cell never opens as a formula. */
    ordersCsv() {
      const cell = (value) => {
        if (value == null) return '';
        let text = String(value);
        if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
        return /[",\n']/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      };
      const columns = ['id', 'at', 'email', 'pack', 'credits', 'currency', 'price', 'simulated', 'refunded_at'];
      const rows = all(`SELECT ${columns.join(', ')} FROM orders ORDER BY at`);
      return `${columns.join(',')}\n${rows.map((row) => columns.map((name) => cell(row[name])).join(',')).join('\n')}${rows.length ? '\n' : ''}`;
    },
    /**
     * 6.8b: an order's refund, recorded (the payment provider's own refund is
     * done there): the credits it gave that are left are taken back, logged.
     */
    refundOrder(admin, id, reason, now = Date.now()) {
      const why = String(reason ?? '').trim();
      if (!why) throw new Error('reason: required');
      return transaction(() => {
        const order = one('SELECT id, email, credits, refunded_at FROM orders WHERE id = ?', String(id));
        if (!order) throw new Error('no such order');
        if (order.refunded_at) throw new Error('already refunded');
        return { id: order.id, credits_taken: takeBack(order, admin, why, now) };
      });
    },
    /** 6.8b: an account erased by an admin (a mailed request): as deleteAccount, logged. */
    adminErase(admin, email, reason, now = Date.now()) {
      const why = String(reason ?? '').trim();
      if (!why) throw new Error('reason: required');
      transaction(() => {
        if (!one('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new Error('no such account');
        erase(email);
        run('INSERT INTO admin_log (at, admin, target, action) VALUES (?, ?, ?, ?)', iso(now), admin, email, `erase: ${why.slice(0, 200)}`);
      });
    },
    /** 6.8b: the failed generations, newest first. */
    failedJobs(limit = 100) {
      return all("SELECT id, email, title, created, error FROM jobs WHERE status = 'failed' ORDER BY created DESC LIMIT ?", limit).map((row) => ({ ...row }));
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
    /** 2026-11-25: the encrypted journal of this base (premium/journal.js). */
    openJournal({ dir, recipients, now }) {
      return createJournal({ db, dir, recipients, now });
    },
    close() {
      db.close();
    },
  };
  return store;
}

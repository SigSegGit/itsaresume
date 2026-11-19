// 6.4: accounts, sessions and credits, in one JSON file (a demo's store: one
// process, no database). Passwords are scrypt hashes with their own salt.
//
// 6.4c GDPR: export (access, portability), erasure of the profile or the
// whole account, retention limits applied by purge(). No payment method is
// ever stored here: a saved card lives at the payment provider, as its token.

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { PACKS } from './pricing.js';

export const MIN_PASSWORD = 8;
/** 6.4d: the profile chat: messages given with the first purchase, and per credit spent. */
export const CHAT = { free: 20, perCredit: 20 };
/** A password reset link lives an hour, once. */
const RESET_MS = 3600000;
export const PREVIEWS_PER_DAY = 3;
/** The privacy notice's version a new account accepts (web/privacy.html). */
export const PRIVACY_VERSION = '2026-11-19';
/**
 * Retention, in days: a session; a generated CV (its page); an account with
 * no login (then erased). Orders: 10 years (French accounting law), without
 * the address once the account is erased.
 */
export const RETENTION = { sessionDays: 30, cvDays: 365, inactiveDays: 730, orderYears: 10 };
const DAY = 86400000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const hash = (password, salt) => scryptSync(password, salt, 32).toString('hex');
const tokenKey = (token) => createHash('sha256').update(String(token)).digest('hex');
const day = (now) => new Date(now).toISOString().slice(0, 10);

/** file: where the store lives, or null to keep it in memory (tests). */
export function createStore(file) {
  const data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { users: {}, sessions: {}, orders: [] };
  data.resets ??= {};
  const save = () => {
    if (!file) return;
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  const open = (email, now) => {
    const token = randomBytes(24).toString('hex');
    data.sessions[tokenKey(token)] = { email, at: now };
    data.users[email].last_login = new Date(now).toISOString();
    save();
    return { token };
  };
  const checked = (user, password) => {
    const given = Buffer.from(hash(String(password ?? ''), user?.salt ?? 'none'), 'hex');
    return Boolean(user) && timingSafeEqual(given, Buffer.from(user.hash, 'hex'));
  };
  const erase = (email) => {
    delete data.users[email];
    for (const [key, session] of Object.entries(data.sessions)) if (session.email === email) delete data.sessions[key];
    // The orders stay for the accounts, pseudonymous.
    for (const order of data.orders) if (order.email === email) order.email = null;
  };
  return {
    register(email, password, now = Date.now()) {
      const key = String(email ?? '').trim().toLowerCase();
      if (!EMAIL.test(key)) throw new Error('email: not an address');
      if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`password: ${MIN_PASSWORD} characters at least`);
      if (data.users[key]) throw new Error('an account exists for this address');
      const salt = randomBytes(16).toString('hex');
      data.users[key] = {
        email: key, salt, hash: hash(password, salt), credits: 0, profile: null, previews: {}, jobs: [],
        created_at: new Date(now).toISOString(), accepted_at: new Date(now).toISOString(), privacy_version: PRIVACY_VERSION,
      };
      return open(key, now);
    },
    login(email, password, now = Date.now()) {
      const user = data.users[String(email ?? '').trim().toLowerCase()];
      if (!checked(user, password)) throw new Error('wrong address or password');
      return open(user.email, now);
    },
    logout(token) {
      delete data.sessions[tokenKey(token)];
      save();
    },
    user(token, now = Date.now()) {
      const session = token ? data.sessions[tokenKey(token)] : undefined;
      if (!session || now - session.at > RETENTION.sessionDays * DAY) return null;
      return data.users[session.email] ?? null;
    },
    /** Simulated payment. local: { currency, price } of the market grid; EUR by default. */
    buy(user, packId, local = null) {
      const pack = PACKS.find((entry) => entry.id === packId);
      if (!pack) throw new Error('pack: unknown');
      user.credits += pack.credits;
      user.chat ??= { left: CHAT.free, history: [] };
      const order = { id: randomBytes(6).toString('hex'), email: user.email, pack: pack.id, credits: pack.credits, currency: local?.currency ?? 'EUR', price: local?.price ?? pack.price, simulated: true, at: new Date().toISOString() };
      data.orders.push(order);
      save();
      return order;
    },
    hasPaid(user) {
      return data.orders.some((order) => order.email === user.email);
    },
    /** One exchange of the profile chat; history capped at 40 entries. */
    chatSaid(user, message, reply) {
      user.chat.left -= 1;
      user.chat.history.push({ at: new Date().toISOString(), message, reply });
      user.chat.history.splice(0, Math.max(0, user.chat.history.length - 40));
      save();
    },
    refillChat(user) {
      if (user.credits <= 0) throw new Error('no credit left for the chat');
      user.credits -= 1;
      user.chat.left += CHAT.perCredit;
      save();
    },
    /** A one-time reset token for an address; null when no account (said to nobody). */
    resetToken(email, now = Date.now()) {
      const user = data.users[String(email ?? '').trim().toLowerCase()];
      if (!user) return null;
      const token = randomBytes(24).toString('hex');
      data.resets[tokenKey(token)] = { email: user.email, at: now };
      save();
      return token;
    },
    resetPassword(token, password, now = Date.now()) {
      const key = tokenKey(token);
      const reset = data.resets[key];
      delete data.resets[key];
      save();
      if (!reset || now - reset.at > RESET_MS || !data.users[reset.email]) throw new Error('this link is invalid or expired');
      if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`password: ${MIN_PASSWORD} characters at least`);
      const user = data.users[reset.email];
      user.salt = randomBytes(16).toString('hex');
      user.hash = hash(password, user.salt);
      for (const [sessionKey, session] of Object.entries(data.sessions)) if (session.email === user.email) delete data.sessions[sessionKey];
      save();
    },
    order(user, id) {
      return data.orders.find((entry) => entry.id === id && entry.email === user.email) ?? null;
    },
    debit(user) {
      if (user.credits < 1) throw new Error('no credit left');
      user.credits -= 1;
      save();
    },
    refund(user) {
      user.credits += 1;
      save();
    },
    previewAllowed(user, now = Date.now()) {
      const today = day(now);
      user.previews = { [today]: (user.previews?.[today] ?? 0) + 1 };
      save();
      return user.previews[today] <= PREVIEWS_PER_DAY;
    },
    setProfile(user, profile) {
      user.profile = profile;
      save();
    },
    addJob(user, job) {
      user.jobs.unshift(job);
      user.jobs.splice(50);
      save();
    },
    /** Everything held on the account, as JSON (GDPR art. 15 and 20); null when none. */
    exportOf(user) {
      const stored = data.users[user?.email];
      if (!stored) return null;
      const { hash: _hash, salt: _salt, profile, jobs, ...account } = stored;
      return { account, profile, jobs, orders: data.orders.filter((order) => order.email === stored.email), retention: RETENTION, privacy_version: PRIVACY_VERSION };
    },
    deleteProfile(user) {
      user.profile = null;
      save();
    },
    /** Erasure (GDPR art. 17), the password asked again. */
    deleteAccount(user, password) {
      if (!checked(user, password)) throw new Error('wrong password');
      erase(user.email);
      save();
    },
    /** Applies the retention limits; run daily. */
    purge(now = Date.now()) {
      for (const [key, session] of Object.entries(data.sessions)) if (now - session.at > RETENTION.sessionDays * DAY) delete data.sessions[key];
      for (const user of Object.values(data.users)) {
        user.jobs = user.jobs.filter((job) => now - Date.parse(job.created) <= RETENTION.cvDays * DAY);
        const seen = Date.parse(user.last_login ?? user.created_at);
        if (now - seen > RETENTION.inactiveDays * DAY) erase(user.email);
      }
      data.orders = data.orders.filter((order) => now - Date.parse(order.at) <= RETENTION.orderYears * 366 * DAY);
      save();
    },
    save,
  };
}

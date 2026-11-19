// 6.4: accounts, sessions and credits, in one JSON file (a demo's store: one
// process, no database). Passwords are scrypt hashes with their own salt.

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { PACKS } from './pricing.js';

export const MIN_PASSWORD = 8;
export const PREVIEWS_PER_DAY = 3;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const hash = (password, salt) => scryptSync(password, salt, 32).toString('hex');
const tokenKey = (token) => createHash('sha256').update(String(token)).digest('hex');
const day = (now) => new Date(now).toISOString().slice(0, 10);

/** file: where the store lives, or null to keep it in memory (tests). */
export function createStore(file) {
  const data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { users: {}, sessions: {}, orders: [] };
  const save = () => {
    if (!file) return;
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  const open = (email) => {
    const token = randomBytes(24).toString('hex');
    data.sessions[tokenKey(token)] = email;
    save();
    return { token };
  };
  return {
    register(email, password) {
      const key = String(email ?? '').trim().toLowerCase();
      if (!EMAIL.test(key)) throw new Error('email: not an address');
      if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`password: ${MIN_PASSWORD} characters at least`);
      if (data.users[key]) throw new Error('an account exists for this address');
      const salt = randomBytes(16).toString('hex');
      data.users[key] = { email: key, salt, hash: hash(password, salt), credits: 0, profile: null, previews: {}, jobs: [] };
      return open(key);
    },
    login(email, password) {
      const user = data.users[String(email ?? '').trim().toLowerCase()];
      const given = Buffer.from(hash(String(password ?? ''), user?.salt ?? 'none'), 'hex');
      if (!user || !timingSafeEqual(given, Buffer.from(user.hash, 'hex'))) throw new Error('wrong address or password');
      return open(user.email);
    },
    logout(token) {
      delete data.sessions[tokenKey(token)];
      save();
    },
    user(token) {
      const email = token ? data.sessions[tokenKey(token)] : undefined;
      return email ? data.users[email] : null;
    },
    /** Simulated payment: the order is recorded, the credits added. */
    /** local: { currency, price } of the market grid; EUR by default. */
    buy(user, packId, local = null) {
      const pack = PACKS.find((entry) => entry.id === packId);
      if (!pack) throw new Error('pack: unknown');
      user.credits += pack.credits;
      const order = { id: randomBytes(6).toString('hex'), email: user.email, pack: pack.id, credits: pack.credits, currency: local?.currency ?? 'EUR', price: local?.price ?? pack.price, simulated: true, at: new Date().toISOString() };
      data.orders.push(order);
      save();
      return order;
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
    save,
  };
}

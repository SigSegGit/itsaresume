// 6.4: the paid, multi-account site, apart from the local generator. It
// reuses the generator's pipeline (src/) read-only and the A4 page (web/cv.*),
// and adds accounts, credits, a free preview and paid generations.
//
//   node premium/server.js --port 18791 --router http://127.0.0.1:18789 --data C:/Users/<you>/.itsaresume/premium
//
// Preview: the router (the owner's subscription first), the CV's text never
// leaves the server. Paid: one credit, the Anthropic API in production; the
// demo sends it to the router too and says so (DEMO_PAID).

import { createServer } from 'node:http';
import { readFileSync, mkdirSync, appendFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costTable, PAID_MODEL, RUN, costPerCv, API_PRICES, EUR_PER_USD, CURRENCIES, localPacks, currencyFor, estimateCost } from './pricing.js';
import { redact } from './preview.js';
import { createLimiter, clientIp, DEFAULT_LIMITS } from './limits.js';
import { CHAT } from './accounts.js';
import { mailerFromEnv } from './smtp.js';
import { stripeFromEnv } from './stripe.js';
import { receiptText } from './receipt.js';

/** 6.11: the address check is on with a real mailer, unless PREMIUM_REQUIRE_VERIFIED=0. */
export function verificationRequired(env) {
  if (env.PREMIUM_REQUIRE_VERIFIED === '0') return false;
  return env.PREMIUM_REQUIRE_VERIFIED === '1' || Boolean(env.PREMIUM_SMTP_URL);
}

export { CHAT };

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MAX_BODY = 300_000;
const COOKIE = 'premium_session';
const FILES = {
  '/': [join(HERE, 'web/index.html'), 'text/html'],
  '/app.js': [join(HERE, 'web/app.js'), 'text/javascript'],
  '/style.css': [join(HERE, 'web/style.css'), 'text/css'],
  '/privacy.html': [join(HERE, 'web/privacy.html'), 'text/html'],
  '/checkout.html': [join(HERE, 'web/checkout.html'), 'text/html'],
  '/checkout.js': [join(HERE, 'web/checkout.js'), 'text/javascript'],
  // 6.8: the founder's page (its API answers admins only).
  '/admin.html': [join(HERE, 'web/admin.html'), 'text/html'],
  '/admin.js': [join(HERE, 'web/admin.js'), 'text/javascript'],
  // 6.7: both languages, shared with the generator's page.
  '/i18n.js': [join(HERE, '../web/i18n.js'), 'text/javascript'],
  // The generator's A4 page, as is: it reads /api/jobs/:id/page.
  '/cv.html': [join(HERE, '../web/cv.html'), 'text/html'],
  '/cv.js': [join(HERE, '../web/cv.js'), 'text/javascript'],
  '/cv.css': [join(HERE, '../web/cv.css'), 'text/css'],
  '/favicon.svg': [join(HERE, '../web/favicon.svg'), 'image/svg+xml'],
};

class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const send = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  // 6.8b: a string is sent as is (the orders CSV), anything else as JSON.
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
};

async function readJson(request) {
  // A form cannot send this type cross-site without a preflight: no CSRF by form.
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON only');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const tokenOf = (request) => {
  const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (bearer) return bearer;
  return /(?:^|;\s*)premium_session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1] ?? null;
};
const sessionCookie = (token, age = 30 * 86400) => ({ 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}` });

/**
 * store: accounts.js; analyse({ profile, offer, mode }) → analysis, mode
 * 'preview' or 'paid'; pageOf(profile, analysis) → the A4 page's data;
 * profileOf(resume) → a checked profile (throws what is wrong).
 */
export function createPremiumApp({ store, analyse, pageOf, profileOf, chat = null, mailer = { send: async (mail) => console.log(`[mail to ${mail.to}] ${mail.subject}\n${mail.text}`) }, contact = '', demoPaid = false, admins = [], snapshots = null, limits = {}, requireVerified = false, payments = null, routerStatus = null, outreach = null, journal = null }) {
  // 6.9: attempts limited (limits.js); a refusal says when to come back.
  const limiter = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([name, rule]) => [name, createLimiter({ ...rule, ...(limits[name] ?? {}) })]));
  // 6.10: a link to this site as the visitor reached it (behind the proxy:
  // its scheme and the path prefix it strips).
  const siteOf = (request) => {
    const proto = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const prefix = /^\/[a-z0-9-]{1,40}$/.test(request.headers['x-forwarded-prefix'] ?? '') ? request.headers['x-forwarded-prefix'] : '';
    return `${proto}://${request.headers.host}${prefix}`;
  };
  const linkTo = (request, fragment) => `${siteOf(request)}/#${fragment}`;
  const sendVerification = async (request, email) => {
    const token = store.verifyToken(email);
    if (!token) return;
    await mailer.send({ to: email, subject: 'itsaresume : confirmez votre adresse / confirm your address', text: `Pour confirmer votre adresse (lien valable 24 h, une fois) / To confirm your address (link valid 24 h, once):\n${linkTo(request, `verify=${token}`)}\nSi vous n'avez rien demandé, ignorez ce message. / If you asked for nothing, ignore this message.` });
  };
  const verified = (user) => {
    if (requireVerified && !user.verified) throw new HttpError(403, 'confirm your e-mail address first');
  };
  const allow = (name, key) => {
    const answer = limiter[name].hit(key);
    if (!answer.ok) throw new HttpError(429, 'too many attempts: try again later', { retry_after: answer.retryAfter });
  };
  const offerPacks = (request) => ({ packs: localPacks(currencyFor(request.headers['accept-language'])) });
  const account = (request) => {
    const user = store.user(tokenOf(request));
    if (!user) throw new HttpError(401, 'log in first');
    return user;
  };
  // 6.8: the admins are configured (PREMIUM_ADMINS), never in the repository.
  const adminSet = new Set(admins.map((email) => String(email).trim().toLowerCase()).filter(Boolean));
  const isAdmin = (user) => adminSet.has(user.email);
  const admin = (request) => {
    const user = account(request);
    if (!isAdmin(user)) throw new HttpError(403, 'admins only');
    return user;
  };
  const invitesModule = () => import('../src/invites.js');
  const outreachDir = () => {
    if (!outreach?.out) throw new HttpError(404, 'invitations: the generator folder is not configured (--out)');
    return outreach.out;
  };
  const inviteLink = (code) => `${outreach?.host ? `https://${outreach.host}` : ''}/?i=${code}`;
  const snapshotList = () => {
    if (!snapshots || !existsSync(snapshots)) return [];
    return readdirSync(snapshots).filter((name) => /^premium-\d{10}\.db$/.test(name)).sort().reverse()
      .map((name) => ({ name, bytes: statSync(join(snapshots, name)).size }));
  };
  const offerOf = (body) => {
    const offer = String(body.offer ?? '').trim();
    if (offer.length < 1 || offer.length > 60000) throw new HttpError(400, 'offer: 1 to 60000 characters');
    return offer;
  };
  const needProfile = (user) => {
    if (!user.profile) throw new HttpError(409, 'import your profile first (the add-on, or a JSON Resume)');
  };

  const routes = {
    'GET /api/admin/stats': (request) => {
      admin(request);
      return { stats: store.stats(), revenue: store.revenue(), integrity: store.verify() };
    },
    // 2026-11-24: what customers cost today (the router's count), against the
    // ceilings, its estimated API cost, and the day's real revenue.
    'GET /api/admin/api-spend': async (request) => {
      admin(request);
      let budget = null;
      try {
        budget = (await routerStatus?.())?.customer_budget ?? null;
      } catch {
        budget = null;
      }
      const today = new Date().toISOString().slice(0, 10);
      const revenue = {};
      for (const order of store.adminOrders(10000)) {
        if (!String(order.at).startsWith(today) || order.simulated || order.refunded_at) continue;
        revenue[order.currency] = Math.round(((revenue[order.currency] ?? 0) + order.price) * 100) / 100;
      }
      return { budget, estimate: estimateCost(budget?.tokens ?? 0), revenue_today: revenue };
    },
    'GET /api/admin/users': (request, url) => {
      admin(request);
      return { users: store.adminUsers(url.searchParams.get('q') ?? '') };
    },
    'POST /api/admin/credits': async (request) => {
      const user = admin(request);
      const body = await readJson(request);
      try {
        return { credits: store.adjustCredits(user.email, String(body.email ?? '').trim().toLowerCase(), body.delta, body.reason) };
      } catch (error) {
        throw new HttpError(error.message === 'no such account' ? 404 : 400, error.message);
      }
    },
    'GET /api/admin/orders': (request) => {
      admin(request);
      return { orders: store.adminOrders() };
    },
    'GET /api/admin/orders.csv': (request) => {
      admin(request);
      return [store.ordersCsv(), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="orders.csv"' }, 200];
    },
    'GET /api/admin/failed': (request) => {
      admin(request);
      return { jobs: store.failedJobs() };
    },
    'POST /api/admin/refund': async (request) => {
      const user = admin(request);
      const body = await readJson(request);
      try {
        return store.refundOrder(user.email, String(body.id ?? ''), body.reason);
      } catch (error) {
        throw new HttpError({ 'no such order': 404, 'already refunded': 409 }[error.message] ?? 400, error.message);
      }
    },
    'POST /api/admin/erase': async (request) => {
      const user = admin(request);
      const body = await readJson(request);
      const email = String(body.email ?? '').trim().toLowerCase();
      if (email === user.email) throw new HttpError(400, 'an admin does not erase its own account here');
      try {
        store.adminErase(user.email, email, body.reason);
        return { erased: email };
      } catch (error) {
        throw new HttpError(error.message === 'no such account' ? 404 : 400, error.message);
      }
    },
    // 2026-11-24: the LinkedIn outreach from this page. `outreach.out` is the
    // generator's folder (its invites.json, QA log and opinions); the link is
    // the public page's, the bare code never leaves.
    'GET /api/admin/invites': async (request) => {
      admin(request);
      const { outreachOf } = await invitesModule();
      return { invitations: outreachOf(outreachDir()).map(({ code, ...row }) => ({ ...row, link: code ? inviteLink(code) : null })) };
    },
    'POST /api/admin/invites': async (request) => {
      const user = admin(request);
      const body = await readJson(request);
      const { createInvite } = await invitesModule();
      const label = String(body.label ?? '').trim();
      const out = outreachDir();
      let code;
      try {
        code = createInvite(out, label);
      } catch (error) {
        throw new HttpError(/already live/.test(error.message) ? 409 : 400, error.message);
      }
      store.noteAdmin(user.email, label, 'invitation made');
      return { label, link: inviteLink(code) };
    },
    'POST /api/admin/invites/revoke': async (request) => {
      const user = admin(request);
      const body = await readJson(request);
      const { loadInvites, revokeInvite } = await invitesModule();
      const label = String(body.label ?? '').trim();
      // Labels only: a code typed here would be a secret in the admin log.
      if (!label || !Object.values(loadInvites(outreachDir())).some((invite) => invite.label === label && !invite.revoked)) {
        throw new HttpError(404, 'no live invitation with that label');
      }
      const revoked = revokeInvite(outreachDir(), label);
      store.noteAdmin(user.email, label, 'invitation revoked');
      return { revoked };
    },
    'GET /api/admin/log': (request) => {
      admin(request);
      return { log: store.adminLog() };
    },
    'GET /api/admin/snapshots': async (request) => {
      admin(request);
      const list = snapshotList();
      let newest = null;
      if (list.length) {
        const { createStore } = await import('./accounts.js');
        const copy = createStore(join(snapshots, list[0].name));
        try {
          newest = { name: list[0].name, integrity: copy.verify(), stats: copy.stats() };
        } finally {
          copy.close();
        }
      }
      return { snapshots: list, newest, journal: journal?.status() ?? null };
    },
    'GET /api/packs': (request, url) => {
      const asked = url.searchParams.get('currency');
      const currency = CURRENCIES[asked] ? asked : currencyFor(request.headers['accept-language']);
      return { currency, symbol: CURRENCIES[currency].symbol, locale: CURRENCIES[currency].locale, currencies: Object.keys(CURRENCIES), packs: localPacks(currency), founder: costTable(), model: PAID_MODEL, run: RUN, cost_usd: costPerCv(PAID_MODEL), prices: API_PRICES, eur_per_usd: EUR_PER_USD, demo_paid: demoPaid, card_payment: Boolean(payments) };
    },
    'POST /api/register': async (request) => {
      const body = await readJson(request);
      // 6.4c: the privacy notice (/privacy.html) accepted, its version recorded.
      if (body.accept !== true) throw new HttpError(400, 'accept the privacy notice first');
      allow('register', clientIp(request));
      try {
        const { token } = store.register(body.email, body.password);
        await sendVerification(request, String(body.email).trim().toLowerCase());
        return [{ token }, sessionCookie(token)];
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    },
    'POST /api/login': async (request) => {
      const body = await readJson(request);
      // 6.9: failures are counted per address and per network address; while
      // either is spent, even the right password waits (no oracle).
      const email = String(body.email ?? '').trim().toLowerCase();
      const ip = clientIp(request);
      for (const [name, key] of [['login', email], ['loginIp', ip]]) {
        const answer = limiter[name].check(key);
        if (!answer.ok) throw new HttpError(429, 'too many attempts: try again later', { retry_after: answer.retryAfter });
      }
      try {
        const { token } = store.login(body.email, body.password);
        limiter.login.clear(email);
        return [{ token }, sessionCookie(token)];
      } catch (error) {
        limiter.login.hit(email);
        limiter.loginIp.hit(ip);
        throw new HttpError(401, error.message);
      }
    },
    'POST /api/logout': async (request) => {
      store.logout(tokenOf(request));
      return [{ ok: true }, sessionCookie('', 0)];
    },
    'GET /api/me': (request) => {
      const user = account(request);
      return {
        email: user.email,
        credits: user.credits,
        profile: user.profile ? { name: user.profile.identity?.name ?? user.profile.name, experiences: user.profile.experiences?.length ?? 0 } : null,
        jobs: user.jobs.map(({ page, ...job }) => job),
        orders: store.ordersOf(user),
        demo_paid: demoPaid,
        paid: store.hasPaid(user),
        admin: isAdmin(user),
        verified: user.verified,
        chat_left: user.chat?.left ?? 0,
        chat_per_credit: CHAT.perCredit,
        chat_history: (user.chat?.history ?? []).slice(-10),
      };
    },
    // 6.4c GDPR: access and portability, erasure.
    'GET /api/me/export': (request) => [store.exportOf(account(request)), { 'content-disposition': 'attachment; filename="itsaresume-mes-donnees.json"' }],
    'POST /api/me/delete': async (request) => {
      const user = account(request);
      const body = await readJson(request);
      try {
        store.deleteAccount(user, body.password);
      } catch (error) {
        throw new HttpError(401, error.message);
      }
      return [{ ok: true }, sessionCookie('', 0)];
    },
    'POST /api/profile/delete': async (request) => {
      store.deleteProfile(account(request));
      return { ok: true };
    },
    // 6.4d: the profile chat, for those who bought a pack.
    'POST /api/chat': async (request) => {
      const user = account(request);
      const message = String((await readJson(request)).message ?? '').trim().slice(0, 4000);
      if (!message) throw new HttpError(400, 'an empty message');
      if (!store.hasPaid(user)) throw new HttpError(402, 'the profile chat comes with a pack of CVs', offerPacks(request));
      if (!chat) throw new HttpError(503, 'the chat is off');
      if (user.chat.left < 1) throw new HttpError(429, 'no message left', { refill: { credits: 1, messages: CHAT.perCredit } });
      let reply;
      try {
        reply = await chat({ profile: user.profile, history: user.chat.history, message });
      } catch (error) {
        throw new HttpError(502, `the chat failed: ${error.message}`);
      }
      store.chatSaid(user, message, reply);
      return { reply, chat_left: user.chat.left };
    },
    'POST /api/chat/refill': async (request) => {
      const user = account(request);
      if (!store.hasPaid(user)) throw new HttpError(402, 'the profile chat comes with a pack of CVs', offerPacks(request));
      try {
        store.refillChat(user);
      } catch {
        throw new HttpError(402, 'no credit left: buy a pack', offerPacks(request));
      }
      return { chat_left: user.chat.left, credits: user.credits };
    },
    // Recovery: the same answer whether the address has an account or not.
    'POST /api/password/forgot': async (request) => {
      const body = await readJson(request);
      allow('forgotIp', clientIp(request));
      allow('forgot', String(body.email ?? '').trim().toLowerCase());
      const token = store.resetToken(body.email);
      if (token) {
        // Behind the public proxy: its scheme and the path prefix it strips.
        const link = linkTo(request, `reset=${token}`);
        await mailer.send({ to: String(body.email).trim().toLowerCase(), subject: 'itsaresume : nouveau mot de passe', text: `Pour choisir un nouveau mot de passe (lien valable une heure, une fois) : ${link}\nSi vous n'avez rien demandé, ignorez ce message.` });
      }
      return { ok: true };
    },
    'POST /api/email/verify': async (request) => {
      const body = await readJson(request);
      try {
        store.confirmEmail(String(body.token ?? ''));
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      return { ok: true };
    },
    'POST /api/email/resend': async (request) => {
      const user = account(request);
      await readJson(request);
      allow('verify', user.email);
      if (!user.verified) await sendVerification(request, user.email);
      return { ok: true };
    },
    'POST /api/password/reset': async (request) => {
      const body = await readJson(request);
      try {
        store.resetPassword(body.token, body.password);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      return { ok: true };
    },
    'POST /api/profile': async (request) => {
      const user = account(request);
      const body = await readJson(request);
      // 6.4d: saving a profile comes with a purchase; the packs come with the refusal.
      if (!store.hasPaid(user)) throw new HttpError(402, 'saving a profile comes with a pack of CVs: buy one first', offerPacks(request));
      let profile;
      try {
        profile = profileOf(body.resume ?? {});
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      store.setProfile(user, profile);
      return { ok: true };
    },
    'POST /api/checkout': async (request) => {
      const user = account(request);
      verified(user);
      const body = await readJson(request);
      try {
        const currency = body.currency ?? 'EUR';
        if (!CURRENCIES[currency]) throw new Error('currency: unknown');
        const local = localPacks(currency).find((pack) => pack.id === body.pack);
        if (payments) {
          // 6.12: the order waits; Stripe's signed paid event credits it.
          const order = store.pendingOrder(user, body.pack, local && { currency, price: local.price });
          const session = await payments.checkout({ order, label: local?.label ?? order.pack, email: user.email, successUrl: `${siteOf(request)}/checkout.html?order=${order.id}`, cancelUrl: `${siteOf(request)}/#pricing` });
          return { order, credits: user.credits, redirect: session.url };
        }
        const order = store.buy(user, body.pack, local && { currency, price: local.price });
        return { order, credits: user.credits };
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    },
    // 6.12: Stripe's events, signed; only "checkout.session.completed" and paid credits.
    'POST /api/stripe/webhook': async (request) => {
      if (!payments) throw new HttpError(404, 'not found');
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) throw new HttpError(413, 'too large');
        chunks.push(chunk);
      }
      let event;
      try {
        event = payments.verify(Buffer.concat(chunks).toString('utf8'), request.headers['stripe-signature']);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      const object = event?.data?.object ?? {};
      try {
        // 6.14: a delayed method (SEPA...) is paid later, by its own event.
        if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event?.type) && object.payment_status === 'paid') {
          return { received: true, order: store.confirmPaid(object.client_reference_id, { amount: object.amount_total, currency: object.currency, ref: object.payment_intent }) };
        }
        // 6.14: a Checkout left unpaid expires (24 h at most): its order goes.
        if (event?.type === 'checkout.session.expired') return { received: true, order: store.dropPending(object.client_reference_id) };
        // 6.14: a full refund made at Stripe takes back the credits left; a partial one is the owner's call.
        if (event?.type === 'charge.refunded' && object.refunded === true) return { received: true, order: store.refundPaid(object.payment_intent) };
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      return { received: true };
    },
    'POST /api/preview': async (request) => {
      const user = account(request);
      const body = await readJson(request);
      const offer = offerOf(body);
      // A visitor previews with a profile sent along, never stored.
      let profile = user.profile;
      if (!profile && body.resume) {
        try {
          profile = profileOf(body.resume);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
      }
      needProfile({ profile });
      // 2026-11-24, red team: a free preview is a model call; throwaway
      // accounts get none unconfirmed, and an address and the site have a
      // daily ceiling, whatever the number of accounts.
      verified(user);
      if (!store.previewAllowed(user)) throw new HttpError(429, 'free previews used up for today');
      allow('previewIp', clientIp(request));
      allow('previewAll', 'site');
      let analysis;
      try {
        analysis = await analyse({ profile, offer, mode: 'preview' });
      } catch (error) {
        throw new HttpError(502, `the preview failed: ${error.message}`);
      }
      return redact(pageOf(profile, analysis), analysis);
    },
    'POST /api/generate': async (request) => {
      const user = account(request);
      verified(user);
      const offer = offerOf(await readJson(request));
      needProfile(user);
      try {
        store.debit(user);
      } catch {
        throw new HttpError(402, 'no credit left: buy a pack');
      }
      const job = { id: randomBytes(8).toString('hex'), status: 'running', title: offer.split('\n')[0].slice(0, 80), created: new Date().toISOString(), demo: demoPaid };
      store.addJob(user, job);
      const profile = user.profile;
      (async () => {
        try {
          const analysis = await analyse({ profile, offer, mode: 'paid' });
          job.page = pageOf(profile, analysis);
          job.score = analysis.fit?.score ?? null;
          job.status = 'done';
        } catch (error) {
          job.status = 'failed';
          job.error = error.message;
          store.refund(user);
        }
        store.saveJob(user, job);
      })();
      return [{ id: job.id, status: job.status }, {}, 202];
    },
  };

  const jobOf = (request, id) => {
    const job = account(request).jobs.find((entry) => entry.id === id);
    if (!job) throw new HttpError(404, 'no such CV');
    return job;
  };

  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && FILES[url.pathname]) {
        const [file, type] = FILES[url.pathname];
        response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self'; img-src 'self' data:" });
        let body = readFileSync(file);
        // The generator's A4 page, reused: its links and its API made relative,
        // so it reads this site's jobs under any prefix (6.4e).
        if (url.pathname === '/cv.html') body = Buffer.from(body.toString('utf8').replace(/(href|src)="\//g, '$1="'));
        if (url.pathname === '/cv.js') body = Buffer.from(body.toString('utf8').replaceAll('`/api/jobs/', '`api/jobs/'));
        // The privacy page names the configured contact (never written in the repository).
        if (url.pathname === '/privacy.html') return response.end(body.toString('utf8').replaceAll('{{contact}}', contact.replace(/[<>&"]/g, '') || 'à compléter / to be completed'));
        return response.end(body);
      }
      // 6.13: a paid order's receipt, the account's own only.
      const receipt = /^\/api\/orders\/([0-9a-f]{12})\/receipt$/.exec(url.pathname);
      if (request.method === 'GET' && receipt) {
        const found = store.order(account(request), receipt[1]);
        if (!found || found.pending) throw new HttpError(404, 'no such order');
        const en = url.searchParams.get('lang') === 'en';
        return send(response, 200, receiptText(found, en ? 'en' : 'fr'), {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="itsaresume-${en ? 'receipt' : 'recu'}-${found.id}.txt"`,
        });
      }
      const order = /^\/api\/orders\/([0-9a-f]{12})$/.exec(url.pathname);
      if (request.method === 'GET' && order) {
        const found = store.order(account(request), order[1]);
        if (!found) throw new HttpError(404, 'no such order');
        return send(response, 200, found);
      }
      const page = /^\/api\/jobs\/([0-9a-f]{16})\/page$/.exec(url.pathname);
      const status = /^\/api\/jobs\/([0-9a-f]{16})$/.exec(url.pathname);
      if (request.method === 'GET' && page) {
        const job = jobOf(request, page[1]);
        if (job.status !== 'done') throw new HttpError(404, 'not ready');
        return send(response, 200, job.page);
      }
      if (request.method === 'GET' && status) {
        const { page: _, ...job } = jobOf(request, status[1]);
        return send(response, 200, job);
      }
      const route = routes[`${request.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, 'not found');
      const result = await route(request, url);
      const [body, headers = {}, code = 200] = Array.isArray(result) ? result : [result];
      return send(response, code, body, headers);
    } catch (error) {
      const retry = error.extra?.retry_after ? { 'retry-after': String(error.extra.retry_after) } : {};
      return send(response, error.status ?? 500, { error: error.status ? error.message : 'internal error', ...(error.extra ?? {}) }, retry);
    }
  });
}

/** The real dependencies: the generator's pipeline through the router. */
async function main(argv) {
  const option = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const router = option('router', 'http://127.0.0.1:18789');
  const data = option('data', join(HERE, '.data'));
  const port = Number(option('port', 18791));
  mkdirSync(data, { recursive: true });
  const { createStore } = await import('./accounts.js');
  const { analyse } = await import('../src/pipeline.js');
  const { asCustomer, complete } = await import('../src/llm.js');
  const { pageData } = await import('../src/tailor.js');
  const { fromJsonResume } = await import('../src/import.js');
  const { validateProfile } = await import('../src/profile.js');
  // 2026-11-24: every premium call is a customer's: the router decides what
  // it may reach (customer_billing: the API, never the owner's subscription).
  const llm = asCustomer(({ system, prompt, schema, backend, kind, audience }) => complete({ url: router, system, prompt, schema, backend, kind, audience }));
  // 6.4f: one SQLite file; hourly snapshots in snapshots/, the folder a sync copies.
  const accounts = createStore(join(data, 'premium.db'));
  accounts.purge();
  accounts.backup(join(data, 'snapshots'));
  // 2026-11-25: the encrypted journal (a base a day, changes every 5 min), for
  // the owner's age key only: the folder ITSaNAS syncs. No key, no journal.
  const { backupRecipients, JOURNAL_EVERY_MS } = await import('./journal.js');
  const recipients = backupRecipients(process.env);
  const logged = (what, run) => {
    try {
      run();
    } catch (error) {
      console.error(`premium: the ${what} failed: ${error.message}`);
    }
  };
  let journal = null;
  if (recipients.length) {
    journal = accounts.openJournal({ dir: join(data, 'backup'), recipients });
    journal.start();
    setInterval(() => logged('journal', () => journal.tick()), JOURNAL_EVERY_MS).unref();
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        logged('last journal entry', () => journal.close());
        process.exit(0);
      });
    }
  } else {
    console.warn('premium: PREMIUM_BACKUP_RECIPIENTS unset, no encrypted journal (only the plain hourly snapshots)');
  }
  setInterval(() => accounts.backup(join(data, 'snapshots')), 3600000).unref();
  const routerStatus = async () => (await fetch(new URL('/status', router))).json();
  const app = createPremiumApp({
    routerStatus,
    journal,
    // The generator's folder (invites.json, QA log, opinions) and the public host.
    outreach: option('out', null) ? { out: option('out', null), host: option('public-host', process.env.CV_HOST ?? '') } : null,
    store: accounts,
    // 6.8: comma-separated admin addresses, from $DATA/.env (never the repository).
    admins: option('admins', process.env.PREMIUM_ADMINS ?? '').split(','),
    snapshots: join(data, 'snapshots'),
    // The demo has no API key: the paid mode goes to the router as well.
    analyse: async ({ profile, offer }) => (await analyse({ profile, offer, llm })).analysis,
    pageOf: pageData,
    profileOf: (resume) => {
      const profile = fromJsonResume(resume);
      const { errors } = validateProfile(profile);
      if (errors.length) throw new Error(errors.join('; '));
      return profile;
    },
    demoPaid: true,
    // 6.10/6.11: on once a real mailer sends the links (the demo's only writes them to the outbox).
    requireVerified: verificationRequired(process.env),
    contact: option('contact', process.env.PREMIUM_CONTACT ?? ''),
    // 6.11: SMTP when PREMIUM_SMTP_URL is set; else the demo mail, the console and the data folder's outbox.
    // 6.12: Stripe when its two keys are set; else the simulated payment.
    payments: stripeFromEnv(process.env),
    mailer: mailerFromEnv(process.env) ?? { send: async (mail) => {
      appendFileSync(join(data, 'outbox.log'), `${new Date().toISOString()} to ${mail.to}: ${mail.subject}\n${mail.text}\n\n`);
      console.log(`[mail to ${mail.to}] ${mail.text}`);
    } },
    // The profile chat: helps to say what the profile holds, never invents.
    chat: async ({ profile, history, message }) => (await llm({
      system: 'You help a person improve their own professional profile for CVs. Ask about facts they have not written down, suggest clearer wording of what they said, never invent an employer, a skill, a level, a number or a result. Answer in the language of the message, briefly.',
      prompt: `Profile (JSON):\n${JSON.stringify(profile ?? {}).slice(0, 12000)}\n\nRecent exchanges:\n${history.slice(-6).map((entry) => `User: ${entry.message}\nYou: ${entry.reply}`).join('\n')}\n\nUser: ${message}`,
    })).text,
  });
  // 6.4c: the retention limits, applied daily.
  setInterval(() => accounts.purge(), 86400000).unref();
  app.listen(port, '127.0.0.1', () => console.log(`premium demo on http://127.0.0.1:${port} (router ${router}, data ${data})`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));

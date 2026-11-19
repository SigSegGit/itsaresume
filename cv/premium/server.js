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
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costTable, PAID_MODEL, RUN, costPerCv, API_PRICES, EUR_PER_USD, CURRENCIES, localPacks, currencyFor } from './pricing.js';
import { redact } from './preview.js';
import { CHAT } from './accounts.js';

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
  response.end(JSON.stringify(body));
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
export function createPremiumApp({ store, analyse, pageOf, profileOf, chat = null, mailer = { send: async (mail) => console.log(`[mail to ${mail.to}] ${mail.subject}\n${mail.text}`) }, contact = '', demoPaid = false }) {
  const offerPacks = (request) => ({ packs: localPacks(currencyFor(request.headers['accept-language'])) });
  const account = (request) => {
    const user = store.user(tokenOf(request));
    if (!user) throw new HttpError(401, 'log in first');
    return user;
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
    'GET /api/packs': (request, url) => {
      const asked = url.searchParams.get('currency');
      const currency = CURRENCIES[asked] ? asked : currencyFor(request.headers['accept-language']);
      return { currency, symbol: CURRENCIES[currency].symbol, locale: CURRENCIES[currency].locale, currencies: Object.keys(CURRENCIES), packs: localPacks(currency), founder: costTable(), model: PAID_MODEL, run: RUN, cost_usd: costPerCv(PAID_MODEL), prices: API_PRICES, eur_per_usd: EUR_PER_USD, demo_paid: demoPaid };
    },
    'POST /api/register': async (request) => {
      const body = await readJson(request);
      // 6.4c: the privacy notice (/privacy.html) accepted, its version recorded.
      if (body.accept !== true) throw new HttpError(400, 'accept the privacy notice first');
      try {
        const { token } = store.register(body.email, body.password);
        return [{ token }, sessionCookie(token)];
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    },
    'POST /api/login': async (request) => {
      const body = await readJson(request);
      try {
        const { token } = store.login(body.email, body.password);
        return [{ token }, sessionCookie(token)];
      } catch (error) {
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
        demo_paid: demoPaid,
        paid: store.hasPaid(user),
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
      const token = store.resetToken(body.email);
      if (token) {
        const link = `http://${request.headers.host}/#reset=${token}`;
        await mailer.send({ to: String(body.email).trim().toLowerCase(), subject: 'itsaresume : nouveau mot de passe', text: `Pour choisir un nouveau mot de passe (lien valable une heure, une fois) : ${link}\nSi vous n'avez rien demandé, ignorez ce message.` });
      }
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
      const body = await readJson(request);
      try {
        const currency = body.currency ?? 'EUR';
        if (!CURRENCIES[currency]) throw new Error('currency: unknown');
        const local = localPacks(currency).find((pack) => pack.id === body.pack);
        const order = store.buy(user, body.pack, local && { currency, price: local.price });
        return { order, credits: user.credits };
      } catch (error) {
        throw new HttpError(400, error.message);
      }
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
      if (!store.previewAllowed(user)) throw new HttpError(429, 'free previews used up for today');
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
        store.save();
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
        const body = readFileSync(file);
        // The privacy page names the configured contact (never written in the repository).
        if (url.pathname === '/privacy.html') return response.end(body.toString('utf8').replaceAll('{{contact}}', contact.replace(/[<>&"]/g, '') || 'à compléter'));
        return response.end(body);
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
      return send(response, error.status ?? 500, { error: error.status ? error.message : 'internal error', ...(error.extra ?? {}) });
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
  const { complete } = await import('../src/llm.js');
  const { pageData } = await import('../src/tailor.js');
  const { fromJsonResume } = await import('../src/import.js');
  const { validateProfile } = await import('../src/profile.js');
  const llm = ({ system, prompt, schema, backend, kind }) => complete({ url: router, system, prompt, schema, backend, kind });
  const accounts = createStore(join(data, 'accounts.json'));
  accounts.purge();
  const app = createPremiumApp({
    store: accounts,
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
    contact: option('contact', process.env.PREMIUM_CONTACT ?? ''),
    // Demo mail: the console and the data folder's outbox.
    mailer: { send: async (mail) => {
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

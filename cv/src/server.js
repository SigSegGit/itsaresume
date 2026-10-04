// The local web page: paste an email, get one tailored, checked CV per offer.
//
// It serves one person on one machine, so it listens on 127.0.0.1 only, and
// treats every request as possibly forged by another page in the same browser:
//   - Host must be this server (a DNS-rebinding page sends its own name);
//   - a POST must come from this origin, carry the page's CSRF token in a
//     header (a form or a cross-origin page cannot set one), be JSON, and
//     stay under MAX_BODY;
//   - every response forbids framing, sniffing and any script not ours (CSP);
//   - files are served from a fixed list, never from a path in the URL.
// The page itself only ever sets textContent (test/web.test.js checks it).

import { createServer } from 'node:http';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanName } from './guard.js';
import { looksLikeOffer, OFFER_CHARS } from './intake.js';
import { MODELS } from './qa.js';
import { addTokens } from './llm.js';

export const MAX_BODY = 256 * 1024;
export const MAX_OFFERS = 6;
export const MAX_TEXT = 60_000;

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const DOWNLOADS = {
  'cv.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'cv.pdf': 'application/pdf',
  'report.md': 'text/markdown; charset=utf-8',
};
export const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

class HttpError extends Error {
  constructor(status, message, { close = false } = {}) {
    super(message);
    this.status = status;
    // Close the connection once answered: the body was not read to its end.
    this.close = close;
  }
}

/** Past this much, an oversized body is not even drained: the socket is cut. */
const DRAIN_LIMIT = 4 * MAX_BODY;

function send(response, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  response.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra });
  response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/**
 * The body, at most MAX_BODY bytes. Over it the answer is a 413 the client
 * receives (audit 2026-09-27: the socket used to be cut first). Up to
 * DRAIN_LIMIT a body, declared or streamed, is drained, discarded, then
 * answered: answering before the client has sent its body made the close
 * reset the connection under the response (1 run in 30, 2026-10-01). Only a
 * length declared past DRAIN_LIMIT is refused unread, and there a reset is
 * accepted.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, `the request is larger than ${MAX_BODY} bytes`, { close: true });
    if (Number(request.headers['content-length']) > DRAIN_LIMIT) {
      reject(tooLarge());
      return;
    }
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      else if (size > DRAIN_LIMIT) request.destroy();
    });
    request.on('end', () => (size > MAX_BODY ? reject(tooLarge()) : resolve(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', reject);
  });
}

const sameToken = (given, token) =>
  typeof given === 'string' && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

/** What a public visitor sees of a finished run: never the owner's notes. */
const PUBLIC_FILES = new Set(['cv.pdf', 'cv.docx']);

/**
 * The header a public visitor sees: whose CV, and what can run. Not how the
 * owner's sources judge the profile (verdicts, the truth document), and no
 * raw error (a path, a router address).
 */
function publicStatus(status) {
  const { profile = {} } = status;
  const shown = profile.error !== undefined
    ? { error: 'profil indisponible' }
    : { name: profile.name, skills: profile.skills, lab: profile.lab, never: profile.never };
  return { ...status, profile: shown, public: true };
}

/** A job as the page sees it. */
function view(job, { detail = false, publicMode = null } = {}) {
  // Router text and paths are the owner's: a visitor only learns that it failed.
  const error = publicMode && job.status === 'failed' ? 'échec' : job.error ?? null;
  const base = { id: job.id, title: job.title, status: job.status, steps: job.steps, error, elapsed_ms: job.elapsed?.() ?? null, model: job.model, via: job.via };
  if (!job.result) return base;
  const { fit } = job.result.view;
  base.fit = { score: fit.score, verdict: fit.verdict, qualification: fit.qualification?.level ?? null };
  if (!detail) return base;
  const full = { ...base, ...job.result.view, fit, report: job.result.report };
  if (!publicMode) return full;
  // Past applications, sources, what the owner must confirm, the model's
  // comment and the report are the owner's working notes.
  return {
    ...full,
    fit: { ...fit, rationale: '' },
    older: [],
    flags: [],
    verification: [],
    repairs: [],
    report: undefined,
    files: full.files.filter((name) => PUBLIC_FILES.has(name)),
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Page loads remembered in public mode (each is a visitor with its own jobs). */
const MAX_VISITORS = 10_000;
/** How long a public visitor keeps their jobs across reloads. */
const VISITOR_DAYS = 7;

/**
 * The server, not yet listening. Everything that touches a model, Word or the
 * disk comes in through `deps`, so the tests run it with fakes.
 */
export function createApp({ deps, token = randomBytes(24).toString('hex'), publicMode = null, clock = Date.now }) {
  const jobs = new Map();
  const queue = [];
  let running = false;

  // Public mode (behind a reverse proxy, open to anyone): each page load is a
  // visitor with its own token and sees only its own jobs; generations are
  // capped per visitor per hour, per day for everyone, and in the queue, so
  // nobody can spend the owner's model quota beyond a known bound.
  const visitors = new Map();
  const accepted = [];
  // A reload is the same visitor (seen 2026-10-01: reopening the page during
  // a several-minute run lost the CV): the visitor's token rides in a cookie
  // the page cannot read (HttpOnly) and other sites cannot send (Strict).
  const pageToken = (request) => {
    if (!publicMode) return { value: token };
    const kept = /(?:^|;\s*)itsacv_visitor=([0-9a-f]{48})(?:;|$)/.exec(String(request.headers.cookie ?? ''))?.[1];
    if (kept && visitors.has(kept)) return { value: kept };
    const fresh = randomBytes(24).toString('hex');
    visitors.set(fresh, new Set());
    if (visitors.size > MAX_VISITORS) visitors.delete(visitors.keys().next().value);
    return { value: fresh, cookie: `itsacv_visitor=${fresh}; Path=/; Max-Age=${VISITOR_DAYS * 24 * 3600}; HttpOnly; Secure; SameSite=Strict` };
  };
  const visitorOf = (request) => {
    const given = request.headers['x-csrf-token'];
    return typeof given === 'string' && visitors.has(given) ? given : null;
  };
  // The proxy sets X-Forwarded-For to the client's address; the last entry is its own.
  const clientOf = (request) => String(request.headers['x-forwarded-for'] ?? '').split(',').pop().trim() || request.socket.remoteAddress;
  function admit(request, count) {
    const now = publicMode.now();
    while (accepted.length && accepted[0].at <= now - DAY) accepted.shift();
    const client = clientOf(request);
    if (queue.length + (running ? 1 : 0) + count > publicMode.maxQueued) {
      throw new HttpError(429, 'Trop de CV en cours de génération : réessaie dans quelques minutes.');
    }
    if (accepted.filter((entry) => entry.client === client && entry.at > now - HOUR).length + count > publicMode.perVisitorPerHour) {
      throw new HttpError(429, `Au plus ${publicMode.perVisitorPerHour} CV par heure et par visiteur : réessaie plus tard.`);
    }
    if (accepted.length + count > publicMode.perDay) {
      throw new HttpError(429, `Le plafond de ${publicMode.perDay} CV par jour est atteint aujourd’hui : réessaie demain.`);
    }
    for (let i = 0; i < count; i += 1) accepted.push({ at: now, client });
  }

  // Hammering is banned (public mode, memory only): more than banAfter attempts
  // at POST /api/jobs within an hour from one IP or one visitor bans both for
  // banHours. Every attempt counts, including those the caps refuse.
  const hits = new Map();
  const bans = new Map();
  const BAN_MESSAGE = `Trop de demandes : accès suspendu pour ${publicMode?.banHours ?? 24} h.`;
  function checkBan(request) {
    const now = publicMode.now();
    const banAfter = publicMode.banAfter ?? 10;
    const keys = [`ip:${clientOf(request)}`, `visitor:${visitorOf(request)}`];
    for (const [key, until] of bans) if (until <= now) bans.delete(key);
    if (keys.some((key) => bans.has(key))) throw new HttpError(429, BAN_MESSAGE);
    let over = false;
    for (const key of keys) {
      const recent = (hits.get(key) ?? []).filter((at) => at > now - HOUR);
      recent.push(now);
      hits.delete(key);
      hits.set(key, recent);
      if (recent.length > banAfter) over = true;
    }
    for (const [key, list] of hits) {
      if (list[list.length - 1] <= now - HOUR) hits.delete(key);
    }
    while (hits.size > MAX_VISITORS) hits.delete(hits.keys().next().value);
    if (over) {
      for (const key of keys) bans.set(key, now + (publicMode.banHours ?? 24) * HOUR);
      while (bans.size > MAX_VISITORS) bans.delete(bans.keys().next().value);
      throw new HttpError(429, BAN_MESSAGE);
    }
  }

  /** Manual QA: one line per run, kept by the owner (deps.log), never shown to visitors. */
  function log(job) {
    if (!deps.log) return;
    const result = job.result ?? {};
    try {
      deps.log({
        at: new Date(clock()).toISOString(),
        id: job.id,
        title: job.title,
        offer: job.text,
        model: job.model,
        via: job.via,
        visitor: job.visitor,
        status: job.status,
        reused: job.reused ?? false,
        error: job.error ?? null,
        elapsed_ms: job.endedAt != null ? job.endedAt - job.startedAt : null,
        steps: job.times,
        backend: result.backend ?? null,
        tokens: job.tokens ?? null,
        attempts: result.attempts ?? null,
        repairs: result.repairs ?? null,
        dir: result.dir ?? null,
        fit: result.view?.fit ?? null,
        analysis: result.analysis ?? null,
      });
    } catch (error) {
      process.stderr.write(`itsacv serve: the QA log failed: ${error.message ?? error}
`);
    }
  }

  async function work() {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift();
      job.status = 'running';
      job.startedAt = clock();
      // Read by the view: running, it grows; done or failed, it stays.
      job.elapsed = () => (job.endedAt ?? clock()) - job.startedAt;
      try {
        const onStep = (step, detail = {}) => {
          job.steps.push({ step, ...detail });
          job.times.push({ step, at: clock() - job.startedAt });
        };
        // Every model answer's tokens, kept on the job: a failed run spent them too.
        const onAnswer = (answer) => addTokens((job.tokens ??= {}), answer);
        job.result = await deps.tailor({ offer: job.text, model: job.model, onStep, onAnswer });
        job.status = 'done';
        job.endedAt = clock();
      } catch (error) {
        job.status = 'failed';
        job.endedAt = clock();
        job.error = String(error.message ?? error).slice(0, 2000);
      }
      log(job);
    }
    running = false;
  }

  const server = createServer(async (request, response) => {
    try {
      const { port } = server.address();
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const origins = hosts.map((host) => `http://${host}`);
      if (publicMode) {
        hosts.push(publicMode.host);
        origins.push(`https://${publicMode.host}`);
      }
      if (!hosts.includes(request.headers.host)) throw new HttpError(421, 'this server only answers to its own address');
      const url = new URL(request.url, `http://${request.headers.host}`);
      const path = url.pathname;

      if (request.method === 'GET') {
        if (path === '/') {
          const issued = pageToken(request);
          const html = readFileSync(join(WEB, 'index.html'), 'utf8').replace('__CSRF_TOKEN__', issued.value);
          return send(response, 200, html, 'text/html; charset=utf-8', issued.cookie ? { 'Set-Cookie': issued.cookie } : {});
        }
        if (STATIC[path]) return send(response, 200, readFileSync(join(WEB, STATIC[path][0])), STATIC[path][1]);
        if (path === '/api/status') return send(response, 200, publicMode ? publicStatus(await deps.status()) : await deps.status());
        if (path === '/api/jobs') {
          const mine = publicMode ? visitors.get(visitorOf(request)) ?? new Set() : null;
          return send(response, 200, [...jobs.values()].filter((job) => !mine || mine.has(job.id)).map((job) => view(job, { publicMode })));
        }
        const match = path.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/files\/([a-z]+\.[a-z]+))?$/);
        const job = match && jobs.get(match[1]);
        if (!job) throw new HttpError(404, 'not found');
        if (!match[2]) return send(response, 200, view(job, { detail: true, publicMode }));
        const type = DOWNLOADS[match[2]];
        const listed = type && job.result?.view.files.includes(match[2]) && (!publicMode || PUBLIC_FILES.has(match[2]));
        const file = listed && join(job.result.dir, match[2]);
        if (!file || !existsSync(file)) throw new HttpError(404, 'not found');
        response.writeHead(200, { ...HEADERS, 'Content-Type': type, 'Content-Disposition': `attachment; filename="${job.result.name}-${match[2]}"` });
        return createReadStream(file).pipe(response);
      }

      if (request.method !== 'POST') throw new HttpError(405, 'GET or POST only');
      if (!origins.includes(request.headers.origin)) throw new HttpError(403, 'a request from another origin');
      const visitor = publicMode ? visitorOf(request) : null;
      if (publicMode ? !visitor : !sameToken(request.headers['x-csrf-token'], token)) throw new HttpError(403, 'a missing or wrong CSRF token');
      if (!/^application\/json\b/.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON only');
      let body;
      try {
        body = JSON.parse(await readBody(request));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'the body is not JSON');
      }

      if (path === '/api/split') {
        // A free text sent to the model on the owner's quota: the owner's alone.
        if (publicMode) throw new HttpError(403, 'le découpage de mails n’est pas disponible en accès public : colle une offre à la fois');
        if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT) {
          throw new HttpError(400, `text: a non-empty string of at most ${MAX_TEXT} characters`);
        }
        return send(response, 200, await deps.split(body.text));
      }
      if (path === '/api/jobs') {
        if (publicMode) checkBan(request);
        const offers = body?.offers;
        const model = body?.model ?? 'auto';
        if (!MODELS.includes(model)) throw new HttpError(400, `model: one of ${MODELS.join(', ')}`);
        // The VM forwards the public name; the laptop page is reached on 127.0.0.1.
        const via = publicMode && request.headers.host === publicMode.host ? 'vm' : 'laptop';
        if (!Array.isArray(offers) || offers.length === 0 || offers.length > MAX_OFFERS) {
          throw new HttpError(400, `offers: from 1 to ${MAX_OFFERS}`);
        }
        const created = offers.map((offer) => {
          if (typeof offer?.text !== 'string' || !offer.text.trim() || offer.text.length > MAX_TEXT) {
            throw new HttpError(400, `offer text: a non-empty string of at most ${MAX_TEXT} characters`);
          }
          if (publicMode && !looksLikeOffer(offer.text)) {
            throw new HttpError(400, `Ce texte ne ressemble pas à une offre d’emploi (entre ${OFFER_CHARS.min} et ${OFFER_CHARS.max} caractères) : colle le texte d’une offre.`);
          }
          return { id: randomUUID(), title: cleanName(offer.title ?? '') ?? 'Offre', text: offer.text, status: 'queued', steps: [], times: [], model, via, visitor };
        });
        // An offer already answered is answered from its run: no model call, not counted.
        // A model chosen by hand is a measure: it always runs.
        const reused = created.map((job) => (publicMode && deps.reuse && job.model === 'auto' ? deps.reuse(job.text) : null));
        if (publicMode) admit(request, reused.filter((result) => !result).length);
        created.forEach((job, index) => {
          jobs.set(job.id, job);
          visitors.get(visitor)?.add(job.id);
          if (reused[index]) {
            job.result = reused[index];
            job.status = 'done';
            job.reused = true;
            log(job);
          } else {
            queue.push(job);
          }
        });
        work();
        return send(response, 202, created.map((job) => view(job)));
      }
      throw new HttpError(404, 'not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const extra = error.close ? { Connection: 'close' } : {};
      if (!response.headersSent) send(response, status, { error: status === 500 ? 'internal error' : error.message }, undefined, extra);
      if (status === 500) process.stderr.write(`itsacv serve: ${error.stack ?? error}\n`);
    }
  });
  return { server, token, jobs };
}

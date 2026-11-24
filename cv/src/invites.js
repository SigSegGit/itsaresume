// Invitation links (2.16): one code per ESN, made by the owner, so the QA log
// says who spent what (2.13 counts tokens per visitor, a random token). The
// codes live in <out>/invites.json, readable by the owner alone; the server
// reads the file at each use, so a revocation needs no restart.

import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { QA_LOG } from './qa.js';
import { FEEDBACK_FILE } from './feedback.js';

export const INVITES_FILE = 'invites.json';
export const LABEL_MAX = 60;

/** `{ code: { label, revoked? } }`; no file is no invitation. */
export function loadInvites(out) {
  const file = join(out, INVITES_FILE);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Written whole then renamed, 0600: a reader never sees half a file. The
// temporary name is fresh, and its mode set explicitly: a stale file of the
// same name would keep its own mode through the rename (redteam).
function save(out, invites) {
  const file = join(out, INVITES_FILE);
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(invites, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

// §9: two owner commands at once (create, revoke) each read then write the
// whole file: one would lose the other's change. A lock file, made with
// O_EXCL, serialises them; one older than STALE_MS is a crashed run's.
const STALE_MS = 60_000;

function locked(out, work, waitMs = 5000) {
  const lock = join(out, `${INVITES_FILE}.lock`);
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (error) {
      // Windows answers EPERM while the last holder's file is being deleted.
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > STALE_MS) {
        try { unlinkSync(lock); } catch { /* another run took it over first */ }
        continue;
      }
      if (Date.now() > until) throw new Error(`invites.json is busy (${lock}): another itsacv invite is running`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return work();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

/** A new invitation for `label`; returns its code. */
export function createInvite(out, label, { waitMs } = {}) {
  const clean = String(label ?? '').trim();
  // eslint-disable-next-line no-control-regex
  if (!clean || clean.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error(`an invitation label is 1 to ${LABEL_MAX} characters on one line`);
  }
  return locked(out, () => {
    const invites = loadInvites(out);
    // One live invitation per label, so --usage and --revoke name one ESN.
    if (Object.values(invites).some((invite) => invite.label === clean && !invite.revoked)) {
      throw new Error(`an invitation "${clean}" is already live: revoke it first, or choose another label`);
    }
    const code = randomBytes(12).toString('hex');
    invites[code] = { label: clean };
    save(out, invites);
    return code;
  }, waitMs);
}

/** Revokes every invitation whose code or label is `which`; returns how many. */
export function revokeInvite(out, which, { waitMs } = {}) {
  return locked(out, () => {
    const invites = loadInvites(out);
    let count = 0;
    for (const [code, invite] of Object.entries(invites)) {
      if ((code === which || invite.label === which) && !invite.revoked) {
        invite.revoked = true;
        count += 1;
      }
    }
    if (count) save(out, invites);
    return count;
  }, waitMs);
}

/**
 * The label a live code names, else null. `hasOwn` is belt and braces: an
 * inherited key ("__proto__") has no string label either, so no test can
 * tell it from the ternary below.
 */
export function invitationOf(invites, code) {
  if (typeof code !== 'string' || !Object.hasOwn(invites, code)) return null;
  const invite = invites[code];
  return invite && !invite.revoked && typeof invite.label === 'string' ? invite.label : null;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Per invitation, from the QA log's text (2.13, 2.16): jobs (reused and
 * failed said apart) and tokens per backend, read (cache included) and
 * written. Anonymous jobs come last; a line that is not JSON is skipped.
 */
export function usageByInvite(log) {
  const byInvite = new Map();
  for (const line of String(log).split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const label = typeof entry.invite === 'string' ? entry.invite : null;
    const sum = byInvite.get(label) ?? { jobs: 0, reused: 0, failed: 0, tokens: new Map() };
    byInvite.set(label, sum);
    sum.jobs += 1;
    if (entry.reused) sum.reused += 1;
    if (entry.status === 'failed') sum.failed += 1;
    for (const [backend, counts] of Object.entries(entry.tokens ?? {})) {
      const count = (key) => (Number.isSafeInteger(counts?.[key]) ? counts[key] : 0);
      const total = sum.tokens.get(backend) ?? { read: 0, written: 0 };
      sum.tokens.set(backend, total);
      total.read += count('input') + count('cache_read') + count('cache_creation');
      total.written += count('output');
    }
  }
  const labels = [...byInvite.keys()].filter((label) => label !== null).sort();
  if (byInvite.has(null)) labels.push(null);
  return labels
    .map((label) => {
      const sum = byInvite.get(label);
      const notes = [sum.reused && `${sum.reused} reused`, sum.failed && `${sum.failed} failed`].filter(Boolean);
      const jobs = `${plural(sum.jobs, 'job')}${notes.length ? ` (${notes.join(', ')})` : ''}`;
      const tokens = [...sum.tokens.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([backend, total]) => `${backend} ${total.read} read ${total.written} written`)
        .join('; ');
      return `${label ?? '(no invitation)'}\t${jobs}\t${tokens || 'no tokens'}\n`;
    })
    .join('');
}

const jsonLines = (text) => String(text ?? '').split('\n').flatMap((line) => {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === 'object' ? [entry] : [];
  } catch {
    return [];
  }
});

/** The mean of the prices said (euros, one decimal), null when none was. */
const meanPrice = (given) => {
  const prices = given.map((entry) => entry.price).filter(Number.isInteger);
  return prices.length ? Math.round((prices.reduce((sum, price) => sum + price, 0) / prices.length) * 10) / 10 : null;
};

/**
 * 2026-11-24: per invitation, live or revoked, its live code (null once
 * revoked), the own-profile CVs asked and made (QA log), the opinions given
 * (feedback.jsonl), their mean, the last activity and the comments, newest
 * first. A line that is not JSON is skipped.
 */
export function funnelRows(invites, log, feedback) {
  const runs = jsonLines(log);
  const opinions = jsonLines(feedback).filter((entry) => Number.isInteger(entry.rating));
  const entries = Object.entries(invites ?? {}).filter(([, invite]) => typeof invite?.label === 'string');
  const labels = [...new Set(entries.map(([, invite]) => invite.label))].sort();
  return labels.map((label) => {
    const code = entries.find(([, invite]) => invite.label === label && !invite.revoked)?.[0] ?? null;
    const asked = runs.filter((entry) => entry.invite === label);
    const given = opinions.filter((entry) => entry.invite === label);
    const last = [...asked, ...given].map((entry) => String(entry.at ?? '')).filter(Boolean).sort().at(-1) ?? null;
    return {
      label,
      live: code !== null,
      code,
      asked: asked.length,
      made: asked.filter((entry) => entry.status === 'done').length,
      opinions: given.length,
      mean: given.length ? Math.round((given.reduce((sum, entry) => sum + entry.rating, 0) / given.length) * 10) / 10 : null,
      price: meanPrice(given),
      last,
      comments: given.map(({ rating, comment, price, at }) => ({ rating, comment: String(comment ?? ''), price: Number.isInteger(price) ? price : null, at: at ?? null })).sort((a, b) => String(b.at).localeCompare(String(a.at))),
    };
  });
}

/** The rows of an out folder: its invitations, QA log and opinions. */
export function outreachOf(out) {
  const read = (name) => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : '');
  return funnelRows(loadInvites(out), read(QA_LOG), read(FEEDBACK_FILE));
}

/** `itsacv invite --funnel` (2026-11-24): the rows, one tab-separated line each. */
export function outreachFunnel(invites, log, feedback) {
  return funnelRows(invites, log, feedback).map((row) => {
    const mean = row.opinions ? ` (${row.mean.toFixed(1)}/5)` : '';
    const cells = [row.label, row.live ? 'live' : 'revoked', `${row.asked} asked`, `${row.made} made`, `${plural(row.opinions, 'opinion')}${mean}`, row.last ? `last ${row.last.slice(0, 10)}` : 'never used'];
    return `${cells.join('\t')}\n`;
  }).join('');
}

// Invitation links (2.16): one code per ESN, made by the owner, so the QA log
// says who spent what (2.13 counts tokens per visitor, a random token). The
// codes live in <out>/invites.json, readable by the owner alone; the server
// reads the file at each use, so a revocation needs no restart.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const INVITES_FILE = 'invites.json';
export const LABEL_MAX = 60;

/** `{ code: { label, revoked? } }`; no file is no invitation. */
export function loadInvites(out) {
  const file = join(out, INVITES_FILE);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Written whole then renamed, 0600: a reader never sees half a file.
function save(out, invites) {
  const file = join(out, INVITES_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(invites, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** A new invitation for `label`; returns its code. */
export function createInvite(out, label) {
  const clean = String(label ?? '').trim();
  // eslint-disable-next-line no-control-regex
  if (!clean || clean.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error(`an invitation label is 1 to ${LABEL_MAX} characters on one line`);
  }
  const invites = loadInvites(out);
  const code = randomBytes(12).toString('hex');
  invites[code] = { label: clean };
  save(out, invites);
  return code;
}

/** Revokes every invitation whose code or label is `which`; returns how many. */
export function revokeInvite(out, which) {
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

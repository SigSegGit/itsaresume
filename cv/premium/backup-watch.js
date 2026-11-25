// 2026-11-25: the encrypted journal (journal.js) is a backup only while the
// ITSaNAS node on the same VM copies it to other machines. The node rewrites
// the first line of `status.snapshot` in its home every 30 s; it carries
// `copies HAVE of WANT` (for an append-only folder, the machines that hold the
// newest file; its writer and parser: ITSaNAS crates/itsanas-cli/src/safety.rs).
// The admins hear of it when the backup has fewer than COPIES_WANTED copies
// for BEHIND_AFTER_MS, or when the line is missing or older than
// STALE_AFTER_MS: a node that stopped says nothing at all.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const COPIES_WANTED = 2;
export const BEHIND_AFTER_MS = 10 * 60 * 1000;
export const STALE_AFTER_MS = 5 * 60 * 1000;
export const WATCH_EVERY_MS = 60 * 1000;
const FILE = 'status.snapshot';
const ALERTS = new Set(['behind', 'stale', 'missing']);

/**
 * The node's first status line, read: `have` copies (0 when it says none, as
 * before anything is stored), `want`, and `at`, when it was written (ms), from
 * its `snapshot T`. The one place that knows the format, so a stable command
 * of the node (`itsanas copies --newest`) can replace it.
 */
export function readCopies(text) {
  const words = String(text).split('\n', 1)[0].split(/\s+/).filter(Boolean);
  const number = (word) => (/^\d+$/.test(word ?? '') ? Number(word) : null);
  const stamp = words[0] === 'snapshot' ? number(words[1]) : null;
  const at = words.indexOf('copies');
  const counted = at >= 0 && words[at + 2] === 'of' && number(words[at + 1]) !== null && number(words[at + 3]) !== null;
  return {
    have: counted ? number(words[at + 1]) : 0,
    want: counted ? number(words[at + 3]) : null,
    at: stamp === null ? null : stamp * 1000,
  };
}

/**
 * The watch over the node's `home` (mounted read-only). `check()` reads the
 * line and returns the state: ok, short (under COPIES_WANTED, within the
 * grace), behind, stale or missing. The last three send `alert({ subject,
 * text })` once per incident, and its end once more; a mail that fails is
 * sent again at the next check.
 */
export function createBackupWatch({ home, alert, now = Date.now }) {
  const path = join(home, FILE);
  let shortSince = null;
  let current = { state: 'missing', have: 0, want: COPIES_WANTED, line: null, at: null };
  let told = false;
  let sending = Promise.resolve();

  const read = (time) => {
    let text;
    let mtime;
    try {
      text = readFileSync(path, 'utf8');
      mtime = statSync(path).mtimeMs;
    } catch {
      shortSince = null;
      return { state: 'missing', have: 0, want: COPIES_WANTED, line: null, at: null };
    }
    const { have, at } = readCopies(text);
    const written = at ?? mtime;
    const line = text.split('\n', 1)[0];
    const base = { have, want: COPIES_WANTED, line, at: new Date(written).toISOString() };
    if (time - written > STALE_AFTER_MS) {
      shortSince = null;
      return { ...base, state: 'stale' };
    }
    if (have >= COPIES_WANTED) {
      shortSince = null;
      return { ...base, state: 'ok' };
    }
    shortSince ??= time;
    return { ...base, state: time - shortSince >= BEHIND_AFTER_MS ? 'behind' : 'short', since: new Date(shortSince).toISOString() };
  };

  const say = (alarm) => {
    const { state, line } = current;
    const subject = alarm
      ? `itsaresume : sauvegarde ITSaNAS en défaut (${state}) / backup alert`
      : 'itsaresume : sauvegarde ITSaNAS rétablie / backup back';
    const why = {
      behind: `fewer than ${COPIES_WANTED} other machines hold the newest journal file for ${BEHIND_AFTER_MS / 60000} minutes or more`,
      stale: `the node's ${FILE} was last written ${current.at}: the node is stopped or stuck`,
      missing: `no ${FILE} in the node's home: the node is not running, or its home is not mounted`,
    }[state] ?? 'the newest journal file is on enough machines again';
    const text = `${why}.\nLine read: ${line ?? '(none)'}\nChecked ${new Date(now()).toISOString()}.`;
    // Told at once (checks stay synchronous); a failed mail is untold again.
    const before = told;
    told = alarm;
    let sent;
    try {
      sent = Promise.resolve(alert({ subject, text }));
    } catch (error) {
      sent = Promise.reject(error);
    }
    sending = sent.catch((error) => {
      told = before;
      console.error(`premium: the backup alert failed: ${error.message}`);
    });
  };

  return {
    check() {
      current = read(now());
      const alarm = ALERTS.has(current.state);
      if (alarm !== told && (alarm || current.state === 'ok')) say(alarm);
      return current;
    },
    status() {
      return current;
    },
    idle() {
      return sending;
    },
  };
}

// 2026-11-24 (the owner): free CVs for people met on LinkedIn, in exchange
// for their opinion. One JSON line per opinion in <out>/feedback.jsonl,
// readable by the owner alone, never shown to a visitor.

import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FEEDBACK_FILE = 'feedback.jsonl';
export const COMMENT_MAX = 2000;

export function appendFeedback(out, entry) {
  const file = join(out, FEEDBACK_FILE);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * `itsacv invite --feedback`: per invitation, the opinions' count and mean,
 * then each one newest first (day, rating, run, comment on one line). No
 * invitation comes last; a line that is not JSON is skipped.
 */
export function feedbackByInvite(text) {
  const byInvite = new Map();
  for (const line of String(text).split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.rating)) continue;
    const label = typeof entry.invite === 'string' ? entry.invite : null;
    byInvite.set(label, [...(byInvite.get(label) ?? []), entry]);
  }
  const labels = [...byInvite.keys()].filter((label) => label !== null).sort();
  if (byInvite.has(null)) labels.push(null);
  return labels.map((label) => {
    const entries = byInvite.get(label).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const mean = entries.reduce((sum, entry) => sum + entry.rating, 0) / entries.length;
    const head = `${label ?? '(no invitation)'}\t${plural(entries.length, 'opinion')}\tmean ${mean.toFixed(1)}/5\n`;
    return head + entries.map((entry) => `  ${String(entry.at).slice(0, 10)}\t${entry.rating}/5\t${oneLine(entry.title)}\t${oneLine(entry.comment)}\n`).join('');
  }).join('');
}

/** Every opinion kept, as objects (a line that is not JSON is skipped). */
export function readFeedback(out) {
  const file = join(out, FEEDBACK_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry === 'object' && Number.isInteger(entry.rating) ? [entry] : [];
    } catch {
      return [];
    }
  });
}

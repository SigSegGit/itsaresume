// 2026-11-24 (the owner): free CVs for people met on LinkedIn, in exchange
// for their opinion. One JSON line per opinion in <out>/feedback.jsonl,
// readable by the owner alone, never shown to a visitor.

import { appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const FEEDBACK_FILE = 'feedback.jsonl';
export const COMMENT_MAX = 2000;

export function appendFeedback(out, entry) {
  const file = join(out, FEEDBACK_FILE);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

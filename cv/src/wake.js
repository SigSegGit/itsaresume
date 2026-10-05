// 8.44: wake the laptop's local model on demand. The owner keeps a light
// boot (no Bionic at logon): only a watcher runs there
// (deploy/laptop/wake-watcher.sh), which marks the laptop seen in
// <out>/wake/ at each round and takes a request left there, then starts
// Bionic's server and the tunnel. A job for the local model waits for it.

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WAKE_DIR = 'wake';
/** The watcher marks the laptop every minute; three missed rounds is off. */
export const SEEN_WITHIN_S = 180;
/** How long a job waits for the local model: start, tunnel, then the first request loads it. */
export const WAKE_WAIT = { every: 10_000, max: 6 * 60_000 };

/** Whether the laptop's watcher marked it within SEEN_WITHIN_S. */
export function laptopAwake(out, now = Date.now()) {
  try {
    return now - statSync(join(out, WAKE_DIR, 'laptop-seen')).mtimeMs < SEEN_WITHIN_S * 1000;
  } catch {
    return false;
  }
}

/** Leave a request for the watcher. */
export function requestWake(out) {
  mkdirSync(join(out, WAKE_DIR), { recursive: true });
  writeFileSync(join(out, WAKE_DIR, 'local'), new Date().toISOString());
}

const localUp = (backends) => backends?.find((backend) => backend.kind === 'lm-studio')?.state === 'up';

/**
 * Resolve once the local model can answer; wake it first when the laptop
 * is on. `backends` reads the router's /status; `onStep('wake', {note})`
 * tells the page what was done.
 */
export async function ensureLocal({ out, backends, onStep, wait = WAKE_WAIT }) {
  if (localUp(await backends())) return;
  if (!laptopAwake(out)) throw new Error('IA locale indisponible : portable éteint ou hors ligne. Choisis Claude.');
  requestWake(out);
  onStep('wake', { note: `Réveil de l’IA locale demandé au portable (jusqu’à ${Math.round(wait.max / 60_000)} min) : la génération partira d’elle-même.` });
  const deadline = Date.now() + wait.max;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, wait.every));
    if (localUp(await backends())) return;
  }
  throw new Error(`L’IA locale ne s’est pas réveillée en ${Math.round(wait.max / 60_000)} min. Choisis Claude.`);
}

// Router 8.43: the page's model menu, from what the router says of each
// backend (GET /status). Only this module's own words reach the page, never
// a router reason (an address, a message).

/** How long Claude at its limit stays off the menu: then it is tried again. */
export const LIMIT_PAUSE_S = 60 * 60;

const clock = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const at = (seconds) => clock.format(new Date(seconds * 1000));

// Claude, Gemini, OpenAI: a cloud plan or free tier, judged alike from the
// router's last answer or check (8.49, every ~15 min).
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * 2.35: when a limit lifts, from the backend's own words ("resets 5:30pm
 * (UTC)", "resets Nov 13, 5pm (UTC)"), in seconds; null when it does not say.
 */
export function resetAt(reason, since) {
  const said = /resets (?:([a-z]{3}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?\s*(am|pm) \(UTC\)/i.exec(reason ?? '');
  if (!said) return null;
  const [, month, day, hour, minute = '0', half] = said;
  const hours = (Number(hour) % 12) + (half.toLowerCase() === 'pm' ? 12 : 0);
  const seen = new Date(since * 1000);
  const monthIndex = month ? MONTHS.indexOf(month.toLowerCase()) : seen.getUTCMonth();
  if (monthIndex < 0) return null;
  let reset = Date.UTC(seen.getUTCFullYear(), monthIndex, month ? Number(day) : seen.getUTCDate(), hours, Number(minute)) / 1000;
  while (reset <= since) reset = month ? Date.UTC(new Date(reset * 1000).getUTCFullYear() + 1, monthIndex, Number(day), hours, Number(minute)) / 1000 : reset + 24 * 3600;
  return reset;
}

function cloudOption(backend, now) {
  if (!backend) return { available: false, note: 'non configuré' };
  // 2.35: no credits never lifts by itself; adding some is per-token billing (§1).
  if (backend.state === 'limited' && /no credits remaining|insufficient_quota/i.test(backend.reason ?? '')) {
    return { available: false, note: 'sans crédit : l’API est payante au token, exclue' };
  }
  if (backend.state === 'limited') {
    const since = backend.since ?? now;
    const reset = resetAt(backend.reason, since);
    if (reset !== null) {
      if (now < reset) return { available: false, note: `limite atteinte, levée à ${at(reset)}` };
      return { available: true, note: '' };
    }
    if (now - since < LIMIT_PAUSE_S) return { available: false, note: `limite d’usage atteinte à ${at(since)}` };
    return { available: true, note: `limite atteinte à ${at(since)}, peut-être levée` };
  }
  if (backend.state === 'stopped') return { available: false, note: 'indisponible (connexion ou sécurité)' };
  if (backend.state === 'down') return { available: false, note: 'injoignable' };
  return { available: true, note: '' };
}

function localOption(backend, awake) {
  if (!backend) return { available: false, note: 'non configurée' };
  // 8.44: the laptop is on (its watcher says so) but the model sleeps: woken at sending.
  if (backend.state === 'down' && awake) return { available: true, wake: true, note: 'en veille : réveil à l’envoi, 2 à 6 min' };
  if (backend.state === 'down') return { available: false, note: 'portable éteint ou hors ligne' };
  if (backend.state === 'up' && backend.loaded === false) return { available: true, note: 'chargé à la demande, 1 à 2 min de plus' };
  return { available: true, note: '' };
}

/**
 * The menu: each model available or not, with a note, and the default.
 * Claude while its use is light (never asked, or its last answer
 * `allowed`); else the local model when it can answer; else auto; none
 * when nothing can answer (the owner, 2026-10-05). `awake`: the laptop's
 * watcher was seen, so a sleeping local model can be woken (8.44). A router
 * without /status (`backends` undefined) leaves everything offered; no
 * router at all (`null`) offers nothing.
 */
export function modelMenu(backends, now = Date.now() / 1000, { awake = false } = {}) {
  if (backends === null) {
    const off = { available: false, note: 'routeur injoignable' };
    return { default: null, options: { auto: off, claude: off, gemini: off, openai: off, groq: off, local: off } };
  }
  if (!Array.isArray(backends)) {
    const open = { available: true, note: '' };
    const unknown = { available: false, note: 'non configuré' };
    return { default: 'auto', options: { auto: open, claude: open, gemini: unknown, openai: unknown, groq: unknown, local: open } };
  }
  const claudeBackend = backends.find((backend) => backend.kind === 'claude-code');
  const claude = cloudOption(claudeBackend, now);
  const gemini = cloudOption(backends.find((backend) => backend.kind === 'gemini-cli'), now);
  const openai = cloudOption(backends.find((backend) => backend.kind === 'openai'), now);
  // 2.36: Groq's free tier (OpenAI's open models), its own option.
  const groq = cloudOption(backends.find((backend) => backend.kind === 'groq'), now);
  const local = localOption(backends.find((backend) => backend.kind === 'lm-studio'), awake);
  const light = claudeBackend?.state !== 'limited' && [undefined, 'allowed'].includes(claudeBackend?.usage);
  const auto = { available: claude.available || gemini.available || openai.available || groq.available || local.available, note: '' };
  const fallback = auto.available ? 'auto' : null;
  // The owner, 2026-10-14: past Claude, the cloud free tiers before the slow local model.
  const chosen = (claude.available && light && 'claude') || (gemini.available && 'gemini')
    || (openai.available && 'openai') || (groq.available && 'groq') || (local.available && 'local') || fallback;
  // 2.31b: comparing needs two models that can answer.
  const compare = { available: [claude, gemini, openai, groq, local].filter((model) => model.available).length >= 2, note: '' };
  return { default: chosen, options: { auto, claude, gemini, openai, groq, local, compare } };
}

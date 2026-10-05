// Router 8.43: the page's model menu, from what the router says of each
// backend (GET /status). Only this module's own words reach the page, never
// a router reason (an address, a message).

/** How long Claude at its limit stays off the menu: then it is tried again. */
export const LIMIT_PAUSE_S = 60 * 60;

const clock = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const at = (seconds) => clock.format(new Date(seconds * 1000));

function claudeOption(backend, now) {
  if (!backend) return { available: false, note: 'non configuré' };
  if (backend.state === 'limited') {
    const since = backend.since ?? now;
    if (now - since < LIMIT_PAUSE_S) return { available: false, note: `limite d’usage atteinte à ${at(since)}` };
    return { available: true, note: `limite atteinte à ${at(since)}, peut-être levée` };
  }
  if (backend.state === 'stopped') return { available: false, note: 'indisponible (connexion ou sécurité)' };
  if (backend.state === 'down') return { available: false, note: 'injoignable' };
  return { available: true, note: '' };
}

function localOption(backend) {
  if (!backend) return { available: false, note: 'non configurée' };
  if (backend.state === 'down') return { available: false, note: 'portable éteint ou hors ligne' };
  if (backend.state === 'up' && backend.loaded === false) return { available: true, note: 'chargé à la demande, 1 à 2 min de plus' };
  return { available: true, note: '' };
}

/**
 * The menu: each model available or not, with a note, and the default.
 * The local model, when it can answer, is the default (the owner's
 * decision, 2026-10-05); else auto; none when nothing can answer. A router
 * without /status (`backends` undefined) leaves everything offered; no
 * router at all (`null`) offers nothing.
 */
export function modelMenu(backends, now = Date.now() / 1000) {
  if (backends === null) {
    const off = { available: false, note: 'routeur injoignable' };
    return { default: null, options: { auto: off, claude: off, local: off } };
  }
  if (!Array.isArray(backends)) {
    const open = { available: true, note: '' };
    return { default: 'auto', options: { auto: open, claude: open, local: open } };
  }
  const claude = claudeOption(backends.find((backend) => backend.kind === 'claude-code'), now);
  const local = localOption(backends.find((backend) => backend.kind === 'lm-studio'));
  const auto = { available: claude.available || local.available, note: '' };
  const fallback = auto.available ? 'auto' : null;
  return { default: local.available ? 'local' : fallback, options: { auto, claude, local } };
}

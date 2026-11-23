// 6.9: attempts limited, in memory (one process; a restart forgets, which
// only ever lets more through for one window).

/** A fixed-window counter per key: `max` hits per `windowMs`. */
export function createLimiter({ max, windowMs, cap = 10000 }) {
  const windows = new Map();
  const live = (key, now) => {
    const entry = windows.get(key);
    if (entry && now - entry.start < windowMs) return entry;
    windows.delete(key);
    return null;
  };
  const prune = (now) => {
    if (windows.size < cap) return;
    for (const [key, entry] of windows) if (now - entry.start >= windowMs) windows.delete(key);
    // Still full: the oldest windows go first (a flood of keys forgets itself).
    for (const key of windows.keys()) {
      if (windows.size < cap) break;
      windows.delete(key);
    }
  };
  const verdict = (entry, now) => (entry && entry.count >= max ? { ok: false, retryAfter: Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)) } : { ok: true });
  return {
    /** Whether a hit would pass, counting nothing. */
    check(key, now = Date.now()) {
      return verdict(live(key, now), now);
    },
    /** Counts a hit; refused (and not counted) past the max. */
    hit(key, now = Date.now()) {
      const entry = live(key, now);
      const answer = verdict(entry, now);
      if (!answer.ok) return answer;
      if (entry) entry.count += 1;
      else {
        prune(now);
        windows.set(key, { start: now, count: 1 });
      }
      return { ok: true };
    },
    clear(key) {
      windows.delete(key);
    },
    size() {
      return windows.size;
    },
  };
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/**
 * The client's address: the socket's, or, from the machine itself (Caddy on
 * the VM's host network), the entry the proxy appended to X-Forwarded-For.
 */
export function clientIp(request) {
  const remote = request.socket?.remoteAddress ?? '';
  const forwarded = String(request.headers?.['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  return LOOPBACK.test(remote) && forwarded.length ? forwarded[forwarded.length - 1] : remote;
}

/** The limits a public service starts with; each one overridable (tests, config). */
export const DEFAULT_LIMITS = {
  login: { max: 5, windowMs: 15 * 60000 },
  loginIp: { max: 30, windowMs: 15 * 60000 },
  forgot: { max: 3, windowMs: 3600000 },
  forgotIp: { max: 10, windowMs: 3600000 },
  register: { max: 5, windowMs: 3600000 },
};

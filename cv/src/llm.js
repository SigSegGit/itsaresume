// The model, through itsaresume's HTTP endpoint (never a metered API).
//
// node:http rather than fetch: fetch (undici) gives up after 5 minutes
// without response headers, and itsaresume sends none until the model has
// answered — which a local model on a laptop can take longer than that to do.

import { request as httpRequest } from 'node:http';

/**
 * How long one answer may take by default: a Claude plan or a local GPU can
 * be slow. It must exceed the router backend's own timeout_secs, or the
 * client gives up on an answer the router is still waiting for.
 */
export const TIMEOUT_MS = 20 * 60 * 1000;

/** " (claude-code: usage limit; lm-studio: ...)": what each backend said, when the router tells. */
function attemptsOf(error) {
  const said = (Array.isArray(error?.attempts) ? error.attempts : [])
    .filter((attempt) => typeof attempt?.message === 'string' && attempt.message)
    .map((attempt) => `${attempt.backend ?? 'a backend'}: ${attempt.message}`);
  return said.length ? ` (${said.join('; ')})` : '';
}

export function complete({ url, system, prompt, backend, schema, kind, timeoutMs = TIMEOUT_MS }) {
  const target = new URL(`${url.replace(/\/$/, '')}/v1/complete`);
  // A named backend is tried alone by the router (8.22): a measure per model.
  // A schema asks for structured output (8.24); an older router ignores it.
  // A kind (8.34) lets a classify-only backend take a call that only chooses.
  const body = JSON.stringify({ prompt, system, ...(backend ? { backend } : {}), ...(schema ? { schema } : {}), ...(kind ? { kind } : {}) });
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      target,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (response) => {
        let raw = '';
        let ended = false;
        response.setEncoding('utf8');
        response.on('data', (chunk) => (raw += chunk));
        // A body cut short (the router or a proxy dropped the connection)
        // never ends: without this, the wait would last until the timer.
        response.on('close', () => {
          if (!ended) {
            clearTimeout(timer);
            reject(new Error(`itsaresume at ${url}: connection cut mid-answer (${raw.length} characters received)`));
          }
        });
        response.on('end', () => {
          ended = true;
          clearTimeout(timer);
          let parsed = {};
          try {
            parsed = JSON.parse(raw);
          } catch {
            // an unreadable body is reported below with the status
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const reason = parsed.error?.message ?? raw.slice(0, 200);
            reject(new Error(`itsaresume answered ${response.statusCode}: ${reason}${attemptsOf(parsed.error)}`));
          } else {
            if (typeof parsed.text !== 'string') reject(new Error('itsaresume answered without a text'));
            else resolve({ text: parsed.text, backend: parsed.backend, usage: parsed.usage ?? null });
          }
        });
      },
    );
    const timer = setTimeout(() => {
      outgoing.destroy();
      reject(new Error(`itsaresume at ${url} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    outgoing.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`cannot reach itsaresume at ${url}: ${error.message}`));
    });
    outgoing.end(body);
  });
}

/** The JSON object in a model's answer, fenced or wrapped in prose. */
export function extractJson(text) {
  const unfenced = text.replace(/```(?:json)?/g, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      // fall through to the error below
    }
  }
  throw new Error(`the model's answer holds no JSON object: ${text.slice(0, 200)}`);
}

const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_creation'];

/**
 * Adds one answer's tokens into `tokens`, per backend (router 8.39), so the
 * owner reads what each run took of Claude's plan and of the local machine,
 * apart. An answer whose backend reported none counts as a call only.
 */
export function addTokens(tokens, answer) {
  // The name comes from the router's answer: a plain id, else "?" (never
  // "__proto__", which as a key would reach Object.prototype).
  const backend = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(answer.backend ?? '') && !['constructor', 'prototype'].includes(answer.backend) ? answer.backend : '?';
  const sum = (tokens[backend] ??= { calls: 0, ...Object.fromEntries(TOKEN_KEYS.map((key) => [key, 0])) });
  sum.calls += 1;
  for (const key of TOKEN_KEYS) {
    const count = answer.usage?.[key];
    if (Number.isSafeInteger(count) && count > 0) sum[key] += count;
  }
  return tokens;
}

/** `llm`, calling `onAnswer` with each answer once the model gave it. */
export function counted(llm, onAnswer) {
  return async (request) => {
    const answer = await llm(request);
    onAnswer(answer);
    return answer;
  };
}

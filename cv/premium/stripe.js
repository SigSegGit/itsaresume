// 6.12: real payment through Stripe Checkout, no dependency. Off until the
// owner sets STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in $DATA/.env
// (never the repository); the webhook endpoint is /api/stripe/webhook, event
// checkout.session.completed. The credits come only from that signed event.

import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.stripe.com/v1/checkout/sessions';
const TOLERANCE_S = 300;

/** A price in the currency's minor unit (the four markets all have cents). */
export const minorUnits = (price) => Math.round(Number(price) * 100);

/** The event, if `header` (Stripe-Signature) signs `payload` with `secret` within 5 minutes; else throws. */
export function verifyWebhook(payload, header, secret, now = Math.floor(Date.now() / 1000)) {
  const parts = String(header ?? '').split(',').map((part) => part.trim().split('='));
  const t = Number(parts.find(([key]) => key === 't')?.[1]);
  const given = parts.filter(([key]) => key === 'v1').map(([, value]) => Buffer.from(value ?? '', 'hex'));
  if (!Number.isFinite(t) || given.length === 0) throw new Error('webhook: no signature');
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest();
  if (!given.some((value) => value.length === expected.length && timingSafeEqual(value, expected))) throw new Error('webhook: bad signature');
  if (Math.abs(now - t) > TOLERANCE_S) throw new Error('webhook: too old');
  return JSON.parse(payload);
}

/** A Checkout session for one order: `{ id, url }`. */
export async function checkoutSession({ secretKey, fetch = globalThis.fetch }, { order, label, email, successUrl, cancelUrl }) {
  const form = new URLSearchParams({
    mode: 'payment',
    client_reference_id: order.id,
    'metadata[order]': order.id,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': String(order.currency).toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(minorUnits(order.price)),
    'line_items[0][price_data][product_data][name]': `itsaresume — ${label}`,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  if (email) form.set('customer_email', email);
  const response = await fetch(API, {
    method: 'POST',
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Stripe: ${json.error?.message ?? `HTTP ${response.status}`}`);
  return { id: json.id, url: json.url };
}

/** `{ checkout, verify }` from the environment, or null (the demo payment stays). */
export function stripeFromEnv(env = process.env) {
  if (!env.STRIPE_SECRET_KEY) return null;
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_SECRET_KEY needs STRIPE_WEBHOOK_SECRET (the webhook endpoint\'s signing secret)');
  return {
    checkout: (args) => checkoutSession({ secretKey: env.STRIPE_SECRET_KEY }, args),
    verify: (payload, header) => verifyWebhook(payload, header, env.STRIPE_WEBHOOK_SECRET),
  };
}

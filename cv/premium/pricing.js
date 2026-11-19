// 6.4: what a CV costs to make and what it sells for. Prices in EUR, API
// costs in USD (Anthropic's list price per million tokens, as cached on
// 2026-11-03: check the live price list before setting real prices).

/** Credit packs, cheaper per CV as the pack grows. */
export const PACKS = [
  { id: 'unit', label: '1 CV', credits: 1, price: 1.49 },
  { id: 'pack5', label: '5 CV', credits: 5, price: 4.99 },
  { id: 'pack10', label: '10 CV', credits: 10, price: 6.99 },
  { id: 'pack30', label: '30 CV', credits: 30, price: 15.99 },
  { id: 'pack50', label: '50 CV', credits: 50, price: 24.99 },
  { id: 'pack100', label: '100 CV', credits: 100, price: 35.99 },
];

/** USD per million tokens. */
export const API_PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: null },
};
/** The model a paid CV is made with: the owner wants a cheap one (2026-11-19). */
export const PAID_MODEL = 'claude-haiku-5-5';

/**
 * One generation, measured on the local runs: up to 3 calls, prompts of
 * 14.5k tokens at most (rounded up to 15k), ~3k output tokens each (thinking
 * included). A worst case, not an average.
 */
export const RUN = { calls: 3, input: 15000, output: 3000 };

/** Assumptions, to replace with the real ones before selling. */
export const EUR_PER_USD = 0.86;
/** Card payment fee: percentage + fixed (typical EU card rate). */
export const PAYMENT_FEE = { rate: 0.015, fixed: 0.25 };
/** Hosting: the existing VM, its share per CV (power, line), in EUR. */
export const HOSTING_PER_CV = 0.02;

export const unitPrice = (pack) => pack.price / pack.credits;

/** USD per CV for a model, worst case. */
export function costPerCv(model, run = RUN) {
  const price = API_PRICES[model];
  if (!price) throw new Error(`model: one of ${Object.keys(API_PRICES).join(', ')}`);
  return (run.calls * run.input * price.input + run.calls * run.output * price.output) / 1e6;
}

/** EUR left per CV once the API, the payment fee and the hosting are paid. */
export function marginPerCv(pack, model = PAID_MODEL) {
  const fee = (pack.price * PAYMENT_FEE.rate + PAYMENT_FEE.fixed) / pack.credits;
  return unitPrice(pack) - fee - costPerCv(model) * EUR_PER_USD - HOSTING_PER_CV;
}

/** The table the pricing page shows. */
export const costTable = () => PACKS.map((pack) => ({
  ...pack,
  per_cv: Math.round(unitPrice(pack) * 100) / 100,
  margin: Object.fromEntries(Object.keys(API_PRICES).map((model) => [model, Math.round(marginPerCv(pack, model) * 100) / 100])),
}));

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

/**
 * 6.4b: one grid per market. A local price is the EUR price × the exchange
 * rate × a market factor (what a CV is worth there: purchasing power and
 * competitors' prices), cut down to a charm price. Rates and factors are
 * assumptions of 2026-11: update the rates before launch.
 */
export const CURRENCIES = {
  EUR: { rate: 1, market: 1, decimals: 2, symbol: '€', locale: 'fr-FR' },
  GBP: { rate: 0.87, market: 1, decimals: 2, symbol: '£', locale: 'en-GB' },
  USD: { rate: 1.16, market: 1, decimals: 2, symbol: '$', locale: 'en-US' },
  CHF: { rate: 0.94, market: 1.1, decimals: 2, symbol: 'CHF', locale: 'fr-CH' },
};
// 6.7 (the owner, 2026-11-20): four markets, each in its language (fr or en).
const REGIONS = { GB: 'GBP', UK: 'GBP', US: 'USD', CH: 'CHF' };

/** The highest x.49 / x.99 (or whole number ending in 9) not above the value. */
export function charm(value, decimals = 2) {
  if (decimals === 0) return Math.max(9, Math.floor((value + 1) / 10) * 10 - 1);
  const floor = Math.floor(value);
  const steps = [floor - 0.01, floor + 0.49, floor + 0.99].filter((candidate) => candidate <= value + 1e-9);
  return Math.max(0.49, Math.round(steps[steps.length - 1] * 100) / 100);
}

/** The packs in a currency, each with its margin in EUR on the paid model. */
export function localPacks(code) {
  const currency = CURRENCIES[code];
  if (!currency) throw new Error(`currency: one of ${Object.keys(CURRENCIES).join(', ')}`);
  return PACKS.map((pack) => {
    const price = code === 'EUR' ? pack.price : charm(pack.price * currency.rate * currency.market, currency.decimals);
    const eur = price / currency.rate;
    const fee = (eur * PAYMENT_FEE.rate + PAYMENT_FEE.fixed) / pack.credits;
    const margin = eur / pack.credits - fee - costPerCv(PAID_MODEL) * EUR_PER_USD - HOSTING_PER_CV;
    return { ...pack, currency: code, price, per_cv: price / pack.credits, margin_eur: Math.round(margin * 1000) / 1000 };
  });
}

/** The market of an Accept-Language header: its first known region, else USD for English, else EUR. */
export function currencyFor(acceptLanguage = '') {
  const tags = String(acceptLanguage).split(',').map((tag) => tag.trim());
  for (const tag of tags) {
    const region = /^[a-z]{2,3}-([a-z]{2})\b/i.exec(tag)?.[1]?.toUpperCase();
    if (region && REGIONS[region]) return REGIONS[region];
  }
  return /^en\b/i.test(tags[0]) ? 'USD' : 'EUR';
}

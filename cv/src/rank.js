// 5.2a: N offers ranked by code (5.1's coverage on each offer's listing),
// the model's analysis only for the best K. The listing is the one call
// per offer, cached as the pipeline caches it, so an analysis reuses it.

import { coverage } from './matrix.js';
import { buildPrompt } from './prompt.js';
import { listRequirements } from './listing.js';

const CHARS_PER_TOKEN = 4;

/** The analysis prompt's input tokens, estimated before any call. */
export function estimateTokens(profile, offer, listed) {
  const { system, prompt } = buildPrompt(profile, offer, listed);
  return Math.ceil((system.length + prompt.length) / CHARS_PER_TOKEN);
}

/**
 * Rows `{ name, covered, total, share, tokens }` best share first (ties keep
 * the order given), the first `top` chosen, never one covered not at all.
 */
function rankBy(items, top, row) {
  const rows = items.map((item, at) => ({ at, ...row(item) }));
  rows.sort((a, b) => b.share - a.share || a.at - b.at);
  return rows.map(({ at, ...rest }, rank) => ({ index: at, ...rest, chosen: rank < top && rest.share > 0 }));
}
const covering = (profile, listed) => {
  const { covered, total, share } = coverage(profile, listed.map((item) => item.name));
  return { covered: covered.length, total, share };
};

/** 5.2a: `offers` [{ name, text, listed }] against one profile. */
export function rankOffers(offers, profile, { top, tokensOf = (offer) => estimateTokens(profile, offer.text, offer.listed) }) {
  return rankBy(offers, top, (offer) => ({ name: offer.name, text: offer.text, ...covering(profile, offer.listed), tokens: tokensOf(offer) }));
}

/** 4.4: the employer's side, `profiles` [{ id, profile }] against one offer's listing. */
export function rankProfiles(listed, profiles, { top, offer = '', tokensOf = ({ profile }) => estimateTokens(profile, offer, listed) }) {
  return rankBy(profiles, top, (entry) => ({ name: entry.id, ...covering(entry.profile, listed), tokens: tokensOf(entry) }));
}

/** The listing of `text`, through `cache` (the pipeline's: a later analysis reuses it). */
export async function listingOf(text, { llm, cache }) {
  let listed = cache?.read(text);
  if (!listed) {
    listed = await listRequirements({ offer: text, llm });
    cache?.write(text, listed);
  }
  return listed;
}

/**
 * 5.2b: `offers` [{ title, text }]: each listed once through `cache` (the
 * pipeline's, so a later analysis reuses it), then ranked.
 */
export async function rankListed({ offers, profile, top, llm, cache }) {
  const listedOffers = [];
  for (const offer of offers) listedOffers.push({ name: offer.title, text: offer.text, listed: await listingOf(offer.text, { llm, cache }) });
  return rankOffers(listedOffers, profile, { top });
}

const cell = (value) => String(value).replace(/\s*[\r\n]+\s*/g, ' ').replaceAll('|', '\|');

export function rankMarkdown(rows, { what = 'offre' } = {}) {
  const out = [`| rang | ${what} | couvertes | part | tokens (estim.) | retenue |`, '|---|---|---|---|---|---|'];
  rows.forEach((row, index) => out.push(`| ${index + 1} | ${cell(row.name)} | ${row.covered}/${row.total} | ${Math.round(row.share * 100)} % | ${row.tokens} | ${row.chosen ? 'oui' : 'non'} |`));
  const chosen = rows.filter((row) => row.chosen);
  out.push('', `${chosen.length} offre(s) retenue(s), environ ${chosen.reduce((sum, row) => sum + row.tokens, 0)} tokens d'entrée pour l'analyse.`);
  return `${out.join('\n')}\n`;
}

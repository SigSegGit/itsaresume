// 5.2a: N offers ranked by code (5.1's coverage on each offer's listing),
// the model's analysis only for the best K. The listing is the one call
// per offer, cached as the pipeline caches it, so an analysis reuses it.

import { coverage } from './matrix.js';
import { buildPrompt } from './prompt.js';

const CHARS_PER_TOKEN = 4;

/** The analysis prompt's input tokens, estimated before any call. */
export function estimateTokens(profile, offer, listed) {
  const { system, prompt } = buildPrompt(profile, offer, listed);
  return Math.ceil((system.length + prompt.length) / CHARS_PER_TOKEN);
}

/**
 * `offers`: [{ name, text, listed }]. Best share first (ties keep the order
 * given); the first `top` chosen, never one the profile covers not at all.
 */
export function rankOffers(offers, profile, { top, tokensOf = (offer) => estimateTokens(profile, offer.text, offer.listed) }) {
  const rows = offers.map((offer, at) => {
    const { covered, total, share } = coverage(profile, offer.listed.map((item) => item.name));
    return { at, name: offer.name, text: offer.text, covered: covered.length, total, share, tokens: tokensOf(offer) };
  });
  rows.sort((a, b) => b.share - a.share || a.at - b.at);
  return rows.map(({ at, ...row }, rank) => ({ ...row, chosen: rank < top && row.share > 0 }));
}

const cell = (value) => String(value).replace(/\s*[\r\n]+\s*/g, ' ').replaceAll('|', '\|');

export function rankMarkdown(rows) {
  const out = ['| rang | offre | couvertes | part | tokens (estim.) | retenue |', '|---|---|---|---|---|---|'];
  rows.forEach((row, index) => out.push(`| ${index + 1} | ${cell(row.name)} | ${row.covered}/${row.total} | ${Math.round(row.share * 100)} % | ${row.tokens} | ${row.chosen ? 'oui' : 'non'} |`));
  const chosen = rows.filter((row) => row.chosen);
  out.push('', `${chosen.length} offre(s) retenue(s), environ ${chosen.reduce((sum, row) => sum + row.tokens, 0)} tokens d'entrée pour l'analyse.`);
  return `${out.join('\n')}\n`;
}

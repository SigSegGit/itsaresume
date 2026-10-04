// 8.36: does the offer split keep its quality on a given model? Before the
// call is marked `classify` (a small model may then take it), measure it.
//
//   node scripts/measure-split.mjs --url http://127.0.0.1:8789 [--backend <name>] [--kind classify]
//
// The cases are built from the labelled corpus: each offer alone (one offer
// expected), and agency-style emails holding two or three offers of one
// language between a greeting with shared context and a signature. A case
// is right when the split finds exactly its offers and each piece holds its
// offer's first and last line and no other offer's first line. Nothing is
// written: record the numbers in docs/HANDOVER.md (router 8.36).

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { complete } from '../src/llm.js';
import { loadCorpus } from '../src/measure.js';
import { splitOffers } from '../src/split.js';

const { values } = parseArgs({ options: { url: { type: 'string' }, backend: { type: 'string' }, kind: { type: 'string' } } });
if (!values.url) {
  console.error('usage: node scripts/measure-split.mjs --url <router> [--backend <name>] [--kind classify]');
  process.exit(2);
}
const corpus = loadCorpus(fileURLToPath(new URL('../corpus', import.meta.url)));
const llm = ({ system, prompt }) => complete({ url: values.url, system, prompt, backend: values.backend, kind: values.kind });

const FRAME = {
  fr: ['Bonjour,', '', 'Notre client recherche plusieurs profils pour une mission à Lyon, démarrage sous un mois, télétravail partiel.', ''],
  en: ['Hello,', '', 'Our client is looking for several profiles, based in Berlin, starting next month, partly remote.', ''],
};
const SIGN = { fr: ['', 'Cordialement,', "L'équipe recrutement"], en: ['', 'Best regards,', 'The recruiting team'] };

const filled = (offer) => offer.trim().split('\n').filter((line) => line.trim());
const cases = corpus.map((entry) => ({ id: entry.id, text: entry.offer, offers: [entry.offer] }));
for (const language of ['fr', 'en']) {
  const group = corpus.filter((entry) => entry.language === language);
  const emails = [[0, 1], [2, 3], [0, 2, 3]].filter((picks) => picks.every((i) => group[i]));
  for (const picks of emails) {
    const offers = picks.map((i) => group[i].offer.trim());
    const text = [...FRAME[language], offers.join('\n\n'), ...SIGN[language]].join('\n');
    cases.push({ id: `${language}:${picks.map((i) => group[i].id).join('+')}`, text, offers });
  }
}

/** Why a split is wrong, or null. */
function wrong(expected, found) {
  if (found.length !== expected.length) return `${found.length} offer(s), expected ${expected.length}`;
  for (const [i, offer] of expected.entries()) {
    const lines = filled(offer);
    const piece = found[i].text;
    if (!piece.includes(lines[0]) || !piece.includes(lines.at(-1))) return `offer ${i + 1} cut short`;
    const other = expected.find((x, j) => j !== i && piece.includes(filled(x)[0]));
    if (other) return `offer ${i + 1} holds another offer`;
  }
  return null;
}

let right = 0;
for (const item of cases) {
  const started = Date.now();
  const { offers, repairs } = await splitOffers({ text: item.text, llm });
  const why = wrong(item.offers, offers);
  if (!why) right += 1;
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${item.id}: ${why ?? 'right'} in ${seconds}s` + (repairs.length ? `; repairs: ${repairs.join(' | ')}` : ''));
}
console.log(`split right on ${right}/${cases.length}`);

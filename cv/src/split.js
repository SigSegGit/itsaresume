// One email, several offers (an ESN often sends two or three at once): the
// model points at line ranges, code cuts.
//
// The model never rewrites an offer: it names line numbers, which are checked
// (inside the text, in order, no overlap, at least two non-empty lines each)
// before the text is cut. A shared range (client, place, dates stated once for
// all offers) goes in front of each offer. Anything doubtful keeps the whole
// text as one offer and says so; only an unreachable model is an error.

import { extractJson } from './llm.js';
import { cleanName, fence, UNTRUSTED } from './guard.js';

export const SPLIT_SYSTEM = `Some texts hold one job offer, some hold several (an agency email listing two or three positions). Find each distinct position in the text.

Answer with ONE JSON object and nothing else:
{"shared": [first, last] or null, "offers": [{"title": "position title", "start": first, "end": last}]}

Line numbers are the ones shown before each line, inclusive. Each offer's range covers that position's own text: its title, mission, requirements. "shared" is the range, if any, that describes all positions at once (client, place, dates); leave out greetings and signatures. A text with a single position gives a single offer.

${UNTRUSTED}`;

/** The text with its line numbers, fenced. */
export function splitPrompt(text) {
  const numbered = text.split('\n').map((line, index) => `${index + 1}| ${line}`).join('\n');
  return fence(numbered).join('\n');
}

const MIN_LINES = 2;

/** Whether `range` is [first, last] inside `count` lines, first <= last. */
const isRange = (range, count) =>
  Array.isArray(range) && range.length === 2 && range.every(Number.isInteger) && range[0] >= 1 && range[0] <= range[1] && range[1] <= count;

/** The checked ranges, or a reason to keep the text whole. */
function check(answer, lines) {
  const offers = answer?.offers;
  if (!Array.isArray(offers) || offers.length === 0) return { reason: 'no offer found' };
  const ranges = [];
  for (const offer of offers) {
    const range = [offer?.start, offer?.end];
    if (!isRange(range, lines.length)) return { reason: `the range ${JSON.stringify(range)} is not inside the text` };
    const filled = lines.slice(range[0] - 1, range[1]).filter((line) => line.trim()).length;
    if (filled < MIN_LINES) return { reason: `the range ${range.join('-')} holds fewer than ${MIN_LINES} lines` };
    ranges.push({ range, title: offer.title });
  }
  const shared = answer.shared ?? null;
  if (shared !== null && !isRange(shared, lines.length)) return { reason: `the shared range ${JSON.stringify(shared)} is not inside the text` };
  const all = [...ranges.map((item) => item.range), ...(shared ? [shared] : [])].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < all.length; i += 1) {
    if (all[i][0] <= all[i - 1][1]) return { reason: `the ranges ${all[i - 1].join('-')} and ${all[i].join('-')} overlap` };
  }
  return { ranges, shared };
}

/**
 * The offers in `text`: [{title, text}] and the repairs made on the way.
 * Only a failed call (the router unreachable or refusing) throws.
 */
export async function splitOffers({ text, llm }) {
  const lines = text.split('\n');
  const { text: answerText } = await llm({ system: SPLIT_SYSTEM, prompt: splitPrompt(text) });
  let checked;
  try {
    checked = check(extractJson(answerText), lines);
  } catch (error) {
    checked = { reason: `the answer could not be read (${error.message})` };
  }
  const firstLine = (chunk) => cleanName(chunk.find((line) => line.trim()) ?? '') ?? 'Offer';
  if (checked.reason) {
    return { offers: [{ title: firstLine(lines), text: text.trim() }], repairs: [`${checked.reason}: kept as one offer`] };
  }
  const cut = ([first, last]) => lines.slice(first - 1, last);
  const context = checked.shared ? [...cut(checked.shared), ''] : [];
  const offers = checked.ranges.map(({ range, title }) => ({
    title: cleanName(title ?? '') ?? firstLine(cut(range)),
    text: [...context, ...cut(range)].join('\n').trim(),
  }));
  return { offers, repairs: [] };
}

// What the offer asks for, listed by a short, focused call before the
// analysis. A small model reading the whole catalogue and the offer at once
// was seen reading an offer that names Copilot, Speckit and SAP Joule as three
// requirements, all met — 100/100. Listing is an easier task on its own, and
// the list then does two jobs: the analysis must classify every item, and the
// honesty check knows every name the offer uses.

import { extractJson } from './llm.js';
import { cleanName, fence, UNTRUSTED } from './guard.js';
import { MUST, NICE } from './importance.js';
import { canonical, mentions } from './text.js';

export const LISTING_SYSTEM = `List every skill, technology, tool, product, method or personal quality that the job offer asks for or names.

Answer with ONE JSON object and nothing else:
{"requirements": [{"name": "Kubernetes", "importance": "must | nice"}]}

One entry per item: an offer naming five tools gives five entries. Use the offer's own words for the names, at most a few words each. "must" unless the offer calls it optional, a plus, or nice to have.

${UNTRUSTED}`;

export function listingPrompt(offer) {
  return fence(offer).join('\n');
}

/**
 * The listed requirements, or [] when the answer cannot be read. A failed
 * call throws: swallowed, it took the requirement floor with it and the
 * score rose with no trace.
 */
export async function listRequirements({ offer, llm }) {
  const { text } = await llm({ system: LISTING_SYSTEM, prompt: listingPrompt(offer) });
  try {
    const seen = new Set();
    const listed = [];
    for (const item of extractJson(text).requirements ?? []) {
      // A name goes into the analysis prompt and the report: plain and short, or dropped.
      const name = cleanName(item?.name);
      const key = name?.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      listed.push({ name, importance: item.importance === 'nice' ? 'nice' : 'must' });
    }
    return withFloor(listed, offer);
  } catch {
    return withFloor([], offer);
  }
}

/**
 * The analysis with every listed requirement it left out added as unmet;
 * normalisation then marks met the ones named like a profile skill.
 */
export function mergeListed(analysis, listed) {
  const present = new Set((analysis.requirements ?? []).map((requirement) => String(requirement.name).trim().toLowerCase()));
  const added = listed.filter((item) => !present.has(item.name.toLowerCase()));
  return {
    analysis: {
      ...analysis,
      requirements: [
        ...(analysis.requirements ?? []),
        ...added.map((item) => ({ name: item.name, importance: item.importance, match: 'no', skills: [], note: 'named in the offer, left out by the analysis' })),
      ],
    },
    repairs: added.map((item) => `requirement ${item.name} (${item.importance}) named in the offer and left out by the analysis: added`),
  };
}

/** A header line: a short head, ":", and maybe its own enumeration. */
const HEADER = /^([^:.!?]{1,80}):(.*)$/;
/** A list item: a bullet, then the item. */
const BULLET = /^(?:[-*•·–]|\d+[.)])\s+(.+)$/;
/** Longer, an item is a sentence, not a requirement's name. */
const FLOOR_WORDS = 6;

/**
 * The requirement floor (2.1e): the items the offer lists under a header
 * that says must or nice ("Nice to have:" above a list, "Atouts : Airflow,
 * dbt."), with that importance. The model may drop them (the local model
 * dropped a whole "Nice to have" list on the corpus, twice); the offer's
 * layout does not. A header without a cue, or a denied one ("Not
 * required:"), gives nothing.
 */
export function floorItems(offer) {
  const items = [];
  let section = null;
  const add = (raw, importance) => {
    const name = cleanName(String(raw).replace(/[.;,]+$/, '').trim());
    if (!name || name.split(/\s+/).length > FLOOR_WORDS) return;
    if (!items.some((item) => item.name.toLowerCase() === name.toLowerCase())) items.push({ name, importance });
  };
  for (const raw of canonical(String(offer ?? '')).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      section = null;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      if (section) add(bullet[1], section);
      continue;
    }
    section = null;
    const header = HEADER.exec(line);
    if (!header) continue;
    const own = MUST.test(header[1]) ? 'must' : NICE.test(header[1]) ? 'nice' : null;
    if (!own) continue;
    if (header[2].trim() === '') section = own;
    else for (const part of header[2].split(/,|;|\bet\b|\band\b/)) add(part, own);
  }
  return items;
}

/** `listed`, plus the floor items no listed name names or is named by. */
function withFloor(listed, offer) {
  const missing = floorItems(offer).filter((item) => !listed.some((known) => mentions(item.name, known.name) || mentions(known.name, item.name)));
  return [...listed, ...missing];
}

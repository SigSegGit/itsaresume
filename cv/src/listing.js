// What the offer asks for, listed by a short, focused call before the
// analysis. A small model reading the whole catalogue and the offer at once
// was seen reading an offer that names Copilot, Speckit and SAP Joule as three
// requirements, all met — 100/100. Listing is an easier task on its own, and
// the list then does two jobs: the analysis must classify every item, and the
// honesty check knows every name the offer uses.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJson } from './llm.js';
import { cleanName, fence, UNTRUSTED } from './guard.js';
import { MUST, NICE } from './importance.js';
import { canonical, GENERIC, mentions, stem, STOP, wordsOf } from './text.js';
import { defaultIndex, lookup } from './lexicon.js';

export const LISTING_SYSTEM = `List every skill, technology, tool, product, method or personal quality that the job offer asks for or names.

Answer with ONE JSON object and nothing else:
{"requirements": [{"name": "Kubernetes", "importance": "must | nice"}]}

One entry per item: an offer naming five tools gives five entries. Use the offer's own words for the names, at most a few words each. "must" unless the offer calls it optional, a plus, or nice to have.

${UNTRUSTED}`;

/**
 * The listing's answer as a JSON Schema (8.25): the router asks the model
 * for exactly this document (router 8.24), so none is lost to prose around
 * it. `extractJson` still reads it, and still reads an older router's text.
 */
export const LISTING_SCHEMA = {
  type: 'object',
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, importance: { type: 'string', enum: ['must', 'nice'] } },
        required: ['name', 'importance'],
        additionalProperties: false,
      },
    },
  },
  required: ['requirements'],
  additionalProperties: false,
};

export function listingPrompt(offer) {
  return fence(offer).join('\n');
}

/**
 * The listed requirements, or [] when the answer cannot be read. A failed
 * call throws: swallowed, it took the requirement floor with it and the
 * score rose with no trace.
 */
export async function listRequirements({ offer, llm, structured = false }) {
  // Not by default: with the schema the local model listed less (8.25).
  const { text } = await llm({ system: LISTING_SYSTEM, prompt: listingPrompt(offer), ...(structured ? { schema: LISTING_SCHEMA } : {}) });
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
/**
 * The listing kept per offer (2.26a), keyed by the sha256 of its text: the
 * model's own spread came mostly from the listing, so one offer is listed
 * once and its rows stay the same across runs. A cache that cannot be read
 * or written is no cache: the run lists the offer and goes on.
 */
export function fileListingCache(dir) {
  const path = (offer) => join(dir, `${createHash('sha256').update(offer).digest('hex')}.json`);
  return {
    read(offer) {
      try {
        const listed = JSON.parse(readFileSync(path(offer), 'utf8'));
        return Array.isArray(listed) ? listed : null;
      } catch {
        return null;
      }
    },
    write(offer, listed) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path(offer), JSON.stringify(listed, null, 2));
      } catch {
        // the next run lists it again
      }
    },
  };
}

/**
 * 2.38: the listed requirements a row named `name` stands for: one it names
 * exactly, before its parenthesis or as one of its parts ("Moindre privilège
 * / IAM"), or whose content words, two at least, the row names all (the
 * words `mergeListed` covers with). "SQL" is not "SQL Server".
 */
export function listedOf(name, listed) {
  const whole = String(name).trim().toLowerCase();
  const parts = new Set([whole, whole.split('(')[0].trim(), ...whole.split(/\s*(?:[/,;+&]|(?<!\p{L})(?:et|and)(?!\p{L}))\s*/u).map((part) => part.trim())]);
  const words = new Set(wordsOf(whole).map(stem));
  return (listed ?? []).filter((item) => {
    const own = String(item.name).trim().toLowerCase();
    if (parts.has(own)) return true;
    const content = wordsOf(own).filter((word) => !STOP.has(word) && !GENERIC.has(word)).map(stem);
    return content.length >= 2 && content.every((word) => words.has(word));
  });
}

/**
 * 2.42: a row answered with a listed id ("L3", the prompt numbers the
 * listing) takes that row's name, its verdict kept: a name the model
 * translated no longer re-adds its row (2.25c). An id unknown or used
 * twice is not trusted. The id never leaves here.
 */
function byListedId(analysis, listed) {
  const repairs = [];
  const used = new Map();
  for (const row of analysis.requirements ?? []) {
    if (typeof row.listed === 'string') used.set(row.listed, (used.get(row.listed) ?? 0) + 1);
  }
  const requirements = (analysis.requirements ?? []).map(({ listed: id, ...row }) => {
    if (typeof id !== 'string') return row;
    const at = /^L([1-9]\d*)$/.exec(id) ? Number(id.slice(1)) - 1 : -1;
    if (at < 0 || at >= listed.length) {
      repairs.push(`requirement ${row.name}: listed id ${id} unknown, not trusted`);
      return row;
    }
    if (used.get(id) > 1) {
      repairs.push(`requirement ${row.name}: listed id ${id} given twice, not trusted`);
      return row;
    }
    const name = listed[at].name;
    if (String(row.name).trim().toLowerCase() !== name.trim().toLowerCase()) repairs.push(`requirement ${name}: answered as ${row.name}, named as the listing (${id})`);
    return { ...row, name };
  });
  return { analysis: { ...analysis, requirements }, repairs };
}

export function mergeListed(given, listed) {
  const named = byListedId(given, listed);
  const analysis = named.analysis;
  const present = new Set((analysis.requirements ?? []).map((requirement) => String(requirement.name).trim().toLowerCase()));
  // A listed name whose every content word the analysis already names, in
  // one row, is that row ("Customer meetings" / "Customer-facing
  // meetings", 2.10): added again, it counted a must twice.
  // Covered only by two content words at least ("SQL" is not "SQL Server",
  // "DevOps" is not "Azure DevOps"), and never a must by a nice row.
  const index = defaultIndex();
  const conceptsOf = (name) => [...new Set(lookup(index, String(name)))].sort().join(' ');
  const analysed = (analysis.requirements ?? []).map((requirement) => ({ words: new Set(wordsOf(requirement.name).map(stem)), importance: requirement.importance, concepts: conceptsOf(requirement.name) }));
  const covered = (item) => {
    const words = wordsOf(item.name).filter((word) => !STOP.has(word) && !GENERIC.has(word)).map(stem);
    if (words.length >= 2 && analysed.some((row) => words.every((word) => row.words.has(word)) && (row.importance === 'must' || item.importance === 'nice'))) return true;
    // 2.41: the same row answered in another language ("Machine learning" /
    // "Apprentissage automatique"): both names on the same lexicon concepts.
    const concepts = conceptsOf(item.name);
    return concepts !== '' && analysed.some((row) => row.concepts === concepts && (row.importance === 'must' || item.importance === 'nice'));
  };
  // A name that heads a row before its parenthesis is that row ("HA" /
  // "HA (haute disponibilité réseau)", 2026-10-02); "SQL" still is not "SQL Server".
  const heads = new Set((analysis.requirements ?? []).map((requirement) => String(requirement.name).split('(')[0].trim().toLowerCase()));
  const added = listed.filter((item) => !present.has(item.name.toLowerCase()) && !heads.has(item.name.toLowerCase()) && !covered(item));
  return {
    analysis: {
      ...analysis,
      requirements: [
        ...(analysis.requirements ?? []),
        ...added.map((item) => ({ name: item.name, importance: item.importance, match: 'no', skills: [], note: 'named in the offer, left out by the analysis' })),
      ],
    },
    repairs: [...named.repairs, ...added.map((item) => `requirement ${item.name} (${item.importance}) named in the offer and left out by the analysis: added`)],
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
  return [...listed, ...missing].filter((item) => !onlyDenied(offer, item.name));
}

/** A denial: "not required", "pas obligatoire", "ne serait pas un plus". */
const DENIAL = /(?<![\p{L}\p{N}])(?:pas|not|non|no)\s+(?:\p{L}+\s+)?(?:obligatoires?|exigée?s?|requise?s?|required|mandatory|indispensables?|needed|necessary|nécessaires?|un\s+plus|a\s+plus)(?![\p{L}\p{N}])/iu;

/**
 * Whether the offer names `name` only to deny it (2.1f): every sentence
 * that mentions it holds a denial and no nice cue ("n'est pas obligatoire
 * mais sera appréciée" still wants it). Both models listed "Kubernetes is
 * not required for this role" on the corpus.
 */
function onlyDenied(offer, name) {
  // The clause is the judge, not the sentence: "Terraform est obligatoire,
  // Kubernetes n'est pas requis" denies only Kubernetes.
  const clauses = canonical(String(offer ?? ''))
    .split(/\r?\n|(?<=[.!?;])\s+|,|\s;\s/)
    .filter((clause) => mentions(clause, name));
  return clauses.length > 0 && clauses.every((clause) => DENIAL.test(clause) && !NICE.test(clause));
}

const listing = new Map();

/** 2.32: runs of one offer at once (a comparison) share one listing; a failure is shared by none after it. */
export function sharedListing(offer, list) {
  if (!listing.has(offer)) listing.set(offer, list().finally(() => listing.delete(offer)));
  return listing.get(offer);
}

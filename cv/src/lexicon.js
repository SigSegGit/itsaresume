// The lexicon: an offer's words and the owner's, linked through shared
// concepts (ESCO, and technology concepts), in French and English, by code.
//
// A concept has a French and an English label, synonyms in both, and broader
// concepts. A phrase names a concept when one of its labels appears in it as
// whole words, case, accents and punctuation aside. A requirement then
// relates to one of the owner's skills as the same concept, a near one (its
// parent, child or sibling) or a shared theme (an ancestor two steps up), or
// not at all: the model is only needed for what this leaves unexplained.

import { readFileSync } from 'node:fs';
import { canonical } from './text.js';

/** The longest label, in words, looked for inside a phrase. */
const MAX_WORDS = 8;

/**
 * A word in the singular, roughly: "cycles" and "cycle" are one key (seen:
 * "Cycle de delivery" found nothing where "Cycles de delivery" found CI/CD).
 * Labels and phrases are folded alike, so a wrong singular still matches only
 * itself; words under four letters ("aws", "ops") and "-ss" ("process") stay.
 */
const singular = (word) => (word.endsWith('eaux') ? word.slice(0, -1) : word.length >= 4 && /[^s]s$/.test(word) ? word.slice(0, -1) : word);

/** A phrase as the index keys it: lower case, no accents, words and +/# only, singular. */
export function key(phrase) {
  return canonical(String(phrase ?? ''))
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .split(' ')
    .map(singular)
    .join(' ');
}

/** Every label and synonym of every concept, keyed; and each concept's neighbours. */
export function buildIndex(concepts) {
  const byKey = new Map();
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const children = new Map();
  for (const concept of concepts) {
    const labels = [concept.fr, concept.en, ...Object.values(concept.alt ?? {}).flat()];
    for (const label of labels) {
      // "Puppet (outils de ...)": the part before the parenthesis names it too.
      for (const form of [label, String(label ?? '').replace(/\s*\(.*\)\s*$/, '')]) {
        const k = key(form);
        if (k) byKey.set(k, [...new Set([...(byKey.get(k) ?? []), concept.id])]);
      }
    }
    for (const parent of concept.broader ?? []) children.set(parent, [...(children.get(parent) ?? []), concept.id]);
  }
  return { byKey, byId, children };
}

/**
 * The parts of a phrase that name concepts, the longest labels first, each
 * word used once (`parts`: the words and the concepts they name), and the
 * words no label takes (`rest`: "maîtrise", "tuning").
 */
export function spans(index, phrase) {
  const words = key(phrase).split(' ').filter(Boolean);
  const used = new Array(words.length).fill(false);
  const parts = [];
  for (let size = Math.min(MAX_WORDS, words.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      if (used.slice(start, start + size).some(Boolean)) continue;
      const ids = index.byKey.get(words.slice(start, start + size).join(' '));
      if (!ids) continue;
      parts.push({ words: words.slice(start, start + size), ids });
      used.fill(true, start, start + size);
    }
  }
  return { parts, rest: words.filter((_, at) => !used[at]) };
}

/** The concepts a phrase names, the longest labels first, each word used once. */
export function lookup(index, phrase) {
  return [...new Set(spans(index, phrase).parts.flatMap((part) => part.ids))];
}

/**
 * Each skill of the profile placed on the concepts its name, aliases and terms
 * name whole: a word inside a label is not the label (seen: ESCO's "Access",
 * Microsoft Access, inside Bastion's "privileged access"). A skill no whole
 * label places is placed on the technology concepts its name or an alias
 * names word by word ("PostgreSQL 16", "LLM locaux", "ELK / Kibana", 2.28b):
 * those concepts are curated, ESCO's verb phrases are not.
 */
export function skillConcepts(index, skills, { terms: byTerms = true } = {}) {
  const placed = new Map();
  for (const skill of skills) {
    // A term of three characters or fewer places nothing: "AI" is a term of
    // an alerting skill, "API" of REST (seen 2026-10-06, cv §9); its name
    // and aliases still place it. Without `terms`, only the name and the
    // aliases place a skill: what may meet a requirement (coverage.js).
    const terms = byTerms ? (skill.terms ?? []).filter((term) => key(term).replace(/ /g, '').length > 3) : [];
    let ids = [skill.name, ...(skill.aliases ?? []), ...terms].flatMap((label) => index.byKey.get(key(label)) ?? []);
    if (!ids.length) ids = [skill.name, ...(skill.aliases ?? [])].flatMap((label) => lookup(index, label)).filter((id) => id.startsWith('tech:'));
    if (ids.length) placed.set(skill.id, new Set(ids));
  }
  return placed;
}

const parentsOf = (index, id) => index.byId.get(id)?.broader ?? [];
/**
 * An umbrella ("DevOps", "Automatisation") holds categories as members, but
 * two categories under one umbrella are not near each other: CI/CD is not
 * Terraform's neighbour (2.28b).
 */
const umbrella = (index, id) => index.byId.get(id)?.kind === 'Umbrella';
const kinParents = (index, id) => parentsOf(index, id).filter((parent) => !umbrella(index, parent));

/** The concepts within `steps` of `id`, up the hierarchy. */
function ancestors(index, id, steps) {
  let level = [id];
  const seen = new Set();
  for (let step = 0; step < steps; step += 1) {
    level = level.flatMap((current) => parentsOf(index, current)).filter((parent) => !seen.has(parent));
    level.forEach((parent) => seen.add(parent));
  }
  return seen;
}

/** Parent, child or sibling. */
function near(index, a, b) {
  const pa = parentsOf(index, a);
  const pb = parentsOf(index, b);
  return pa.includes(b) || pb.includes(a) || kinParents(index, a).some((parent) => kinParents(index, b).includes(parent));
}

const RANK = { same: 0, near: 1, theme: 2 };

/**
 * How a requirement relates to the owner's skills: for each skill, its closest
 * relation to a concept the requirement names. Best relations first.
 */
export function relate(index, requirement, skills) {
  const concepts = lookup(index, requirement);
  const relations = [];
  for (const [skill, owned] of skills) {
    let best = null;
    for (const concept of concepts) {
      for (const mine of owned) {
        const relation = concept === mine ? 'same'
          : near(index, concept, mine) ? 'near'
            : [...ancestors(index, concept, 2)].some((a) => !umbrella(index, a) && ancestors(index, mine, 2).has(a)) ? 'theme' : null;
        if (relation && (!best || RANK[relation] < RANK[best.relation])) best = { skill, relation, concept };
      }
    }
    if (best) relations.push(best);
  }
  // A shared theme is a hint for when nothing nearer exists, not noise beside it.
  const top = Math.min(...relations.map((relation) => RANK[relation.relation]));
  return relations.filter((relation) => RANK[relation.relation] === top);
}

/**
 * The owner's skills a requirement names as a whole: the same concept or one
 * of its members, two steps down at most ("Conteneurisation" holds Docker).
 * A sibling is not a member: Puppet asked is not Terraform owned.
 */
export function members(index, requirement, skills) {
  return holders(index, lookup(index, requirement), skills);
}

/** The owner's skills placed on one of `concepts` or on one of their members, two steps down at most. */
export function holders(index, concepts, skills) {
  const wanted = new Set(concepts);
  const found = [];
  for (const [skill, owned] of skills) {
    if ([...owned].some((mine) => wanted.has(mine) || [...ancestors(index, mine, 2)].some((a) => wanted.has(a)))) found.push(skill);
  }
  return found;
}

/**
 * The owner's skills that are tools of the same family as a tool asked
 * ("Puppet" asked, Terraform held: both Infrastructure as Code): not the tool,
 * a transferable one. `family` is the shared parent concept. Tools only: two
 * categories under one umbrella are not siblings.
 */
export function siblings(index, concepts, skills) {
  const isTool = (id) => index.byId.get(id)?.kind === 'Tool';
  const tools = concepts.filter(isTool);
  const found = [];
  for (const [skill, owned] of skills) {
    for (const mine of [...owned].filter(isTool)) {
      const tool = tools.find((asked) => asked !== mine && kinParents(index, asked).some((parent) => kinParents(index, mine).includes(parent)));
      if (!tool) continue;
      found.push({ skill, family: kinParents(index, tool).find((parent) => kinParents(index, mine).includes(parent)) });
      break;
    }
  }
  return found;
}

/**
 * The owner's skills placed on a concept the requirement names and one of the
 * picked skills is placed on: other names of the same thing ("Shell" met
 * through KSH is Bash too). A shared category is not enough: "Python
 * scripting" met through Python is not Bash.
 */
export function alike(index, requirement, skills, picked) {
  const concepts = new Set(lookup(index, requirement));
  const common = new Set(picked.flatMap((id) => [...(skills.get(id) ?? [])].filter((concept) => concepts.has(concept))));
  return [...skills].filter(([, owned]) => [...owned].some((concept) => common.has(concept))).map(([skill]) => skill);
}

let shared = null;

/** ESCO and the technology concepts, read once. */
export function defaultIndex() {
  if (!shared) {
    const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8')).concepts;
    shared = buildIndex([...read('esco.json'), ...read('tech.json')]);
  }
  return shared;
}

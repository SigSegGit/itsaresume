// What the whole profile holds for a requirement, by code (2.28b-iii).
//
// The owner, 2026-10-25: a requirement is "no" only when what the job needs
// is really missing from the profile, not because its exact words are. The
// model's first verdict is a reading; this is the profile's answer to the
// same row, and the caller only ever raises a verdict with it, never lowers
// it. What the profile never claims is settled before (score.js isNever).
//
// - yes: every concept the requirement names is held at a working level or
//   better, and its other words are generic ("Maîtrise du SQL", "Langage
//   SQL"), or practices an expert or proficient skill covers ("Requêtage
//   SQL", "Administration de bases de données").
// - adjacent: a concept it names is held, but not all of it, or not at that
//   level, or with a word the skill may lack ("Oracle tuning", "SQL / NoSQL").
// - adjacent, to verify: nothing holds the concept, but a tool of the same
//   family is held ("Puppet" beside Terraform), or an experience bullet
//   states what it asks ("Optimisation de requêtes").
// - nothing (null): the profile is silent; the model's verdict stands.

import { holders, key, siblings, spans } from './lexicon.js';
import { GENERIC, STOP, stem, wordsOf } from './text.js';

/** Levels at which a held skill meets the concept it is placed on. */
export const STRONG_LEVELS = new Set(['expert', 'proficient', 'working']);
/** Levels at which a held skill also covers the practice of its concept. */
const DEEP_LEVELS = new Set(['expert', 'proficient']);
/** A level no sibling or bullet is offered at. */
const TOO_LOW = new Set(['notions']);

const keyed = (words) => new Set(words.flatMap((word) => key(word).split(' ')).filter(Boolean));

/** Words that say nothing a skill could lack: generic words, and what names a language or a technology as such. */
const IGNORED = keyed([...STOP, ...GENERIC, ...`langage langages language languages technologie technologies technology
  technologies solution solutions écosystème ecosystem notion notions bases base fondamentaux basics`.split(/\s+/)]);

/** Words that name a practice or a depth of the concept: met by an expert or proficient skill, not a working one. */
const PRACTICE = keyed(`administration administrer administrateur administratrice admin administrator exploitation exploiter
  gestion gérer requêtage requête requêtes querying query queries usage utilisation utiliser use using management manage
  managing opération opérations operation operations avancé avancée avancés avancées advanced confirmé confirmée
  expertise expert experte approfondi approfondie deep pointu pointue`.split(/\s+/));

const tech = (id) => id.startsWith('tech:');

/**
 * The concepts each part of a name names. Where a part names a curated
 * technology concept, ESCO's are left out: ESCO files "MySQL" and "Oracle"
 * as synonyms of "database management systems", which made PostgreSQL a
 * member of "MySQL".
 */
function partsOf(index, name) {
  const { parts, rest } = spans(index, name);
  return { parts: parts.map((part) => (part.ids.some(tech) ? part.ids.filter(tech) : part.ids)), rest };
}

/** A requirement's content words, stemmed: what an experience bullet must state, every one. */
function contentStems(name) {
  return [...new Set(wordsOf(name).filter((word) => !IGNORED.has(key(word)) && !PRACTICE.has(key(word))).map(stem))];
}

/**
 * The profile's answer to one requirement, or null when it has none.
 *
 * A skill placed on a concept by one of its terms only brings the
 * requirement near: a term is broader than a name ("intelligence
 * artificielle" is a term of an alerting skill, 2026-10-06 and 2026-10-25).
 *
 * @param name the requirement's name (a migration's target already taken)
 * @param ctx  { index, placed: Map(skill id → concepts, terms included), named: the same by
 *              names and aliases only, skills: Map(id → skill), ruled: { same, near, no },
 *              experiences, usable(id) → whether a skill may be used }
 * @returns {{ match: 'yes'|'adjacent', skills: string[], judged: boolean, via: 'concept'|'sibling'|'experience', note: string } | null}
 */
export function coverage(name, { index, placed, named = placed, skills, ruled = { same: [], near: [], no: [] }, experiences = [], usable = () => true }) {
  const ok = (id) => skills.has(id) && usable(id) && !ruled.no.includes(id);
  const near = (id) => ruled.near.includes(id);
  const strong = (id) => STRONG_LEVELS.has(skills.get(id).level) && !near(id);
  const { parts, rest } = partsOf(index, name);

  const byPart = parts.map((ids) => holders(index, ids, placed).filter(ok));
  const byName = parts.map((ids) => holders(index, ids, named).filter(ok));
  const same = ruled.same.filter(ok);
  // What a name, an alias or the owner's ruling places; a term's skills only
  // when there is nothing else, and then to verify (the profile's loose words).
  const firm = [...new Set([...byName.flat(), ...same, ...ruled.near.filter(ok)])];
  const loose = firm.length === 0;
  let held = loose ? [...new Set(byPart.flat())] : firm;
  // A notions-level skill is not named as an equivalent beside a better one.
  if (held.some((id) => !TOO_LOW.has(skills.get(id).level))) held = held.filter((id) => !TOO_LOW.has(skills.get(id).level));
  if (held.length) {
    const names = (ids) => ids.map((id) => skills.get(id).name);
    // The owner's "same" ruling covers the words it names.
    const covering = byName.map((ids) => [...ids, ...same].filter(strong));
    const met = covering.length ? covering.every((ids) => ids.length > 0) : same.some(strong);
    const deep = covering.flat().some((id) => DEEP_LEVELS.has(skills.get(id).level)) || same.some((id) => strong(id) && DEEP_LEVELS.has(skills.get(id).level));
    const extra = rest.filter((word) => !IGNORED.has(word) && !(deep && PRACTICE.has(word)));
    if (met && (extra.length === 0 || same.some(strong))) {
      const ids = [...new Set([...covering.flat(), ...same.filter(strong)])];
      return { match: 'yes', skills: ids, judged: false, via: 'concept', note: `equivalent: ${names(ids).join(', ')}` };
    }
    return { match: 'adjacent', skills: held, judged: loose, via: 'concept', note: `equivalent: ${names(held).join(', ')}${loose ? ' (through a term): to verify' : ''}` };
  }

  // A sibling is transferable when it is practised: a lab Docker does not
  // bring OpenShift near.
  const kin = siblings(index, parts.flat(), named).filter(({ skill }) => ok(skill) && strong(skill));
  if (kin.length) {
    const family = index.byId.get(kin[0].family);
    const ids = [...new Set(kin.map(({ skill }) => skill))];
    return {
      match: 'adjacent',
      skills: ids,
      judged: true,
      via: 'sibling',
      note: `same family as the profile's ${ids.map((id) => skills.get(id).name).join(', ')} (${family?.en ?? kin[0].family}): to verify`,
    };
  }

  const wanted = contentStems(name);
  if (wanted.length === 0) return null;
  for (const experience of experiences) {
    for (const bullet of experience.bullets ?? []) {
      const said = new Set([bullet.fr, bullet.en].flatMap((text) => wordsOf(text ?? '')).map(stem));
      if (!wanted.every((word) => said.has(word))) continue;
      const ids = (bullet.skills ?? []).filter((id) => ok(id) && !TOO_LOW.has(skills.get(id).level));
      if (!ids.length) continue;
      return { match: 'adjacent', skills: ids, judged: true, via: 'experience', note: `stated in the experience ${experience.id} (${bullet.id}): to verify` };
    }
  }
  return null;
}

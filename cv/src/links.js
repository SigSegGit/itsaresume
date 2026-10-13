// Links between an offer's words and the owner's skills (2.25a), beside the
// lexicon's concepts. Two sources:
//   mined  from the model's past matches: a word of a matched requirement
//          paired with its skills, counted once per offer; from MIN_OFFERS
//          distinct offers the code accepts it as a candidate, below that it
//          waits for the owner's verdict;
//   ruled  by the owner in links.json beside the profile (private, never in
//          the repository): same, near (adjacent, never yes, never no) or no.
// Mined links only shortlist (2.3b-ii): the model's own past readings never
// ground a match. Only the owner's verdicts change a match, in normalize().

import { existsSync, readFileSync } from 'node:fs';
import { defaultIndex, key, relate, skillConcepts } from './lexicon.js';

/** Distinct offers a mined link needs before the code accepts it. */
export const MIN_OFFERS = 3;

const VERDICTS = new Set(['same', 'near', 'no', null]);

/** Words that carry no skill: articles, and the offer's ways of asking. */
const STOP = new Set('de des du la le les et en au aux of and the for with un une sur pour ou dans experience connaissance maitrise bonne'.split(' '));

/** A requirement's content words, keyed as the lexicon keys them. */
export const contentWords = (phrase) => [...new Set(key(phrase).split(' ').filter((word) => word.length > 1 && !STOP.has(word)))];

/** Each analysis is one offer: every (word, skill) of its met requirements, counted once per offer. */
export function mineLinks(analyses, profile) {
  const ids = new Set(profile.skills.map((skill) => skill.id));
  const counts = new Map();
  for (const analysis of analyses) {
    const seen = new Set();
    for (const requirement of analysis.requirements ?? []) {
      if (requirement.match !== 'yes' && requirement.match !== 'adjacent') continue;
      for (const words of contentWords(requirement.name ?? '')) {
        for (const skill of (requirement.skills ?? []).filter((id) => ids.has(id))) seen.add(`${words}\u0000${skill}`);
      }
    }
    for (const pair of seen) counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return [...counts].map(([pair, offers]) => {
    const [words, skill] = pair.split('\u0000');
    return { words, skill, offers };
  }).sort((a, b) => b.offers - a.offers || a.words.localeCompare(b.words) || a.skill.localeCompare(b.skill));
}

/** The links file refreshed: new counts, the owner's verdicts kept, new links waiting (null). */
export function mergeLinks(existing, mined) {
  const id = (link) => `${link.words}\u0000${link.skill}`;
  const merged = new Map(existing.map((link) => [id(link), { ...link }]));
  for (const link of mined) {
    const kept = merged.get(id(link));
    merged.set(id(link), { words: link.words, skill: link.skill, offers: link.offers, verdict: kept?.verdict ?? null });
  }
  return [...merged.values()];
}

/** links.json: `{ links: [{ words, skill, offers, verdict }] }`; missing is none. */
export function readLinks(path) {
  if (!existsSync(path)) return [];
  const links = JSON.parse(readFileSync(path, 'utf8')).links ?? [];
  links.forEach((link, index) => {
    if (typeof link.words !== 'string' || !key(link.words) || typeof link.skill !== 'string') throw new Error(`${path}: link ${index + 1} needs words and skill`);
    if (!VERDICTS.has(link.verdict ?? null)) throw new Error(`${path}: link ${index + 1} (${link.words}): verdict must be same, near, no or null, not ${link.verdict}`);
  });
  return links.map((link) => ({ ...link, words: key(link.words), verdict: link.verdict ?? null }));
}

/** The links a requirement's words name, by kind: the owner's same / near / no, and the mined ones accepted. */
export function linkedSkills(links = [], requirement) {
  const phrase = ` ${key(requirement)} `;
  const found = { same: [], near: [], no: [], mined: [] };
  for (const link of links) {
    if (!phrase.includes(` ${key(link.words)} `)) continue;
    const kind = link.verdict ?? (link.offers >= MIN_OFFERS ? 'mined' : null);
    if (kind && !found[kind].includes(link.skill)) found[kind].push(link.skill);
  }
  return found;
}

/**
 * The candidate skills for a requirement: the lexicon's relations, the
 * profile's own names, the owner's same/near links and the accepted mined
 * ones, minus what the owner ruled no. Candidates are added for the model,
 * never a limit on it (the owner, 2026-10-06).
 */
export function shortlist(profile, requirement, { index = defaultIndex(), placed = skillConcepts(index, profile.skills) } = {}) {
  const linked = linkedSkills(profile.links, requirement);
  const phrase = ` ${key(requirement)} `;
  const named = profile.skills.filter((skill) => [skill.name, ...(skill.aliases ?? [])].some((name) => key(name) && phrase.includes(` ${key(name)} `))).map((skill) => skill.id);
  const ids = new Set(profile.skills.map((skill) => skill.id));
  const found = [...named, ...relate(index, requirement, placed).map((relation) => relation.skill), ...linked.same, ...linked.near, ...linked.mined];
  return [...new Set(found)].filter((id) => ids.has(id) && !linked.no.includes(id));
}

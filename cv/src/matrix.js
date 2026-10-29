// 5.1: matchmaking by code alone, no model call. For each offer x profile,
// the share of the offer's requirements a profile skill names: its name or
// alias as whole words, the lexicon's same concept or the owner's same link
// (whole), a near concept or link (half). A shared theme is not coverage. The model (5.2)
// is for the best pairs only, once this ranking is shown to agree with the
// full pipeline's qualification.

import { defaultIndex, key, relate, skillConcepts } from './lexicon.js';
import { linkedSkills } from './links.js';
import { offers } from './questions.js';

/** The requirements a profile covers, of those listed. */
export function coverage(profile, requirements, { index = defaultIndex(), placed = skillConcepts(index, profile.skills) } = {}) {
  const names = profile.skills.flatMap((skill) => [skill.name, ...(skill.aliases ?? [])]).map(key).filter(Boolean);
  // Named or the same concept counts whole; a near one (Docker for
  // Kubernetes) is transferable, half, as the score counts "adjacent".
  const weight = (requirement) => {
    const phrase = ` ${key(requirement)} `;
    const linked = linkedSkills(profile.links, requirement);
    const relations = relate(index, requirement, placed).map((relation) => relation.relation);
    if (names.some((name) => phrase.includes(` ${name} `)) || relations.includes('same') || linked.same.length) return 1;
    return relations.includes('near') || linked.near.length ? 0.5 : 0;
  };
  const weights = requirements.map(weight);
  const covered = requirements.filter((_, at) => weights[at] > 0);
  const total = requirements.length;
  return { covered, total, share: total ? weights.reduce((a, b) => a + b, 0) / total : 0 };
}

/** One row per offer x profile: `offers` [{name, requirements}], `profiles` [{id, profile}]. */
export function matrix(offers, profiles) {
  const index = defaultIndex();
  const placedOf = new Map(profiles.map(({ id, profile }) => [id, skillConcepts(index, profile.skills)]));
  return offers.flatMap((offer) => profiles.map(({ id, profile }) => {
    const { covered, total, share } = coverage(profile, offer.requirements, { index, placed: placedOf.get(id) });
    return { offer: offer.name, profile: id, covered: covered.length, total, share };
  }));
}

/**
 * 5.1b: the offers of the runs made (`runs` in time order, as readRuns
 * gives them): one per distinct offer, its latest run's table, named by
 * the run's name without its time.
 */
export function offersFromRuns(runs) {
  const offerOf = offers(runs);
  const latest = new Map();
  for (const run of runs) latest.set(offerOf(run), run);
  return [...latest.values()].map((run) => ({
    name: run.name.replace(/^\d{8}-\d{6}-/, ''),
    requirements: (run.analysis.requirements ?? []).map((requirement) => String(requirement.name ?? '').trim()).filter(Boolean),
  }));
}

const cell = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
const round = (share) => Math.round(share * 100) / 100;

export function toCsv(rows) {
  const lines = ['offer,profile,covered,total,share'];
  for (const row of rows) lines.push([row.offer, row.profile, row.covered, row.total, round(row.share)].map(cell).join(','));
  return `${lines.join('\n')}\n`;
}

/** Offers down, profiles across, the share in percent. */
export function toMarkdown(rows) {
  const profiles = [...new Set(rows.map((row) => row.profile))];
  const offers = [...new Set(rows.map((row) => row.offer))];
  const escape = (text) => String(text).replace(/\|/g, '\\|');
  const lines = [`| offer | ${profiles.map(escape).join(' | ')} |`, `|---|${profiles.map(() => '---:').join('|')}|`];
  for (const offer of offers) {
    const shares = profiles.map((profile) => rows.find((row) => row.offer === offer && row.profile === profile));
    lines.push(`| ${escape(offer)} | ${shares.map((row) => (row ? `${Math.round(row.share * 100)} %` : '')).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

// The questions to the owner (2.22b): what his offers ask that no profile
// skill meets. From one run's requirement table or from every run in
// `out/`: each requirement left at "no" that names a skill (not a quality, a
// condition, a language, a certification, nor what he says he never did),
// grouped by the concepts it names (ESCO and data/tech.json, else its own
// words), minus what `answers.json` already answers and what the profile now
// meets, ranked by how many offers ask it. The page (2.22c) asks them.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defaultIndex, key, lookup, members, skillConcepts } from './lexicon.js';
import { identityNames } from './profile.js';
import { isNever } from './score.js';

/** Not a skill to ask about: code settles these from the profile's own lines, or the interview does. */
const NOT_A_SKILL = new Set(['quality', 'condition', 'language', 'certification']);

/** What groups a phrase with others: the concepts it names, else its own words. */
function groupOf(index, phrase) {
  const concepts = lookup(index, phrase).sort();
  return { id: concepts.length ? concepts.join('+') : `words:${key(phrase)}`, concepts };
}

/** Each run directory named: its name, its offer (null when not kept) and its analysis; an unreadable one is named, not fatal. */
export function readRunDirs(dirs) {
  const runs = [];
  const unreadable = [];
  for (const dir of dirs) {
    const name = basename(dir);
    try {
      const offer = join(dir, 'offer.txt');
      runs.push({ name, offer: existsSync(offer) ? readFileSync(offer, 'utf8') : null, analysis: JSON.parse(readFileSync(join(dir, 'analysis.json'), 'utf8')) });
    } catch (error) {
      unreadable.push({ name, error: error.message });
    }
  }
  return { runs, unreadable };
}

/** Every run under `out` that wrote an analysis (a rejected one did not). */
export function readRuns(out) {
  const dirs = readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(out, entry.name, 'analysis.json')))
    .map((entry) => join(out, entry.name))
    .sort();
  return readRunDirs(dirs);
}

/**
 * The questions, most asked first: {id, asked, names, concepts, offers,
 * must, runs}. `offers` counts distinct offers (the same offer run twice is
 * one), `must` those that require it, `asked` is the wording offers use most.
 * `profile` is the loaded one (answers merged): what it meets is not asked;
 * `answers` the owner's, a "no" as much as a "yes".
 */
export function gatherQuestions(runs, { profile, answers = [], index = defaultIndex() }) {
  const placed = skillConcepts(index, profile.skills);
  const owned = new Set(profile.skills.flatMap((skill) => identityNames(skill).map(key)));
  const answered = new Set(answers.flatMap((answer) => [answer.asked, answer.name])
    .filter((text) => String(text ?? '').trim())
    .map((text) => groupOf(index, text).id));
  const groups = new Map();
  for (const run of runs) {
    const offer = run.offer?.replace(/\s+/g, ' ').trim() || `run:${run.name}`;
    for (const requirement of run.analysis.requirements ?? []) {
      if (requirement.match !== 'no' || NOT_A_SKILL.has(requirement.kind) || isNever(requirement, profile.never)) continue;
      const name = String(requirement.name ?? '').trim();
      if (!name) continue;
      const { id, concepts } = groupOf(index, name);
      if (answered.has(id) || owned.has(key(name)) || members(index, name, placed).length) continue;
      const group = groups.get(id) ?? { id, concepts, spelled: new Map(), counts: new Map(), offers: new Set(), musts: new Set(), runs: new Set() };
      const said = key(name);
      if (!group.spelled.has(said)) group.spelled.set(said, name);
      group.counts.set(said, (group.counts.get(said) ?? 0) + 1);
      group.offers.add(offer);
      if (requirement.importance === 'must') group.musts.add(offer);
      group.runs.add(run.name);
      groups.set(id, group);
    }
  }
  return [...groups.values()]
    .map((group) => {
      const top = Math.max(...group.counts.values());
      const most = [...group.counts.keys()].find((said) => group.counts.get(said) === top);
      return {
        id: group.id, asked: group.spelled.get(most), names: [...group.spelled.values()], concepts: group.concepts,
        offers: group.offers.size, must: group.musts.size, runs: [...group.runs],
      };
    })
    .sort((a, b) => b.offers - a.offers || b.must - a.must || a.asked.localeCompare(b.asked, 'fr'));
}

/** The questions as `itsacv questions` prints them, one a line. */
export function formatQuestions(questions, runCount) {
  const lines = questions.map((question) => {
    const also = question.names.filter((name) => name !== question.asked);
    const offers = `${String(question.offers).padStart(3)} offer${question.offers === 1 ? ' ' : 's'}`;
    return `${offers}  must in ${question.must}  ${question.asked}${also.length ? ` (also: ${also.join(', ')})` : ''}`;
  });
  return `${questions.length} question(s) from ${runCount} run(s), most asked first\n${lines.map((line) => `${line}\n`).join('')}`;
}

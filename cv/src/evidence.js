// How the tool knows whether a CV lies.
//
// Every skill carries evidence, for or against, from sources a human can open:
//   A — a verifiable artefact or a third-party document (a public repository,
//       an attestation, a certificate);
//   B — a candid self-assessment written to a third party, one that also
//       states the gaps (e.g. an email to a recruiter);
//   C — a claim in one of his own CVs.
// Only C sources are scanned: a candid "no Kubernetes in this project" names
// Kubernetes too, so A and B evidence is entered by hand, with its stance.
//
// The verdict of a skill follows from its best evidence. A or B evidence
// against a skill outweighs any number of CV claims for it. A skill that is
// contradicted, or that nothing supports, can neither be shown nor claimed:
// `restrict` removes it, with every bullet, fact and environment entry that
// names it, from the profile the CV draws from; normalize.js and analysis.js
// check the model's answer against the same verdicts.

import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { identityNames, LEVELS } from './profile.js';
import { mentions, STOP, wordsOf } from './text.js';
import { isNever } from './score.js';

export { GRADES, STANCES } from './profile.js';

const GRADE_RANK = { A: 3, B: 2, C: 1 };
/** Verdicts under which a skill may appear on a CV. */
export const SHOWABLE = new Set(['verified', 'self-declared', 'inconsistent']);

/** Names shorter than this are not looked for in text ("C" matches "c'est"). */
const MIN_SEARCHED_NAME = 3;
const searchable = (names) => names.filter((name) => name.length >= MIN_SEARCHED_NAME);

/** The text of every source that has a file, read relative to `dir` (the profile's directory). */
export function readSources(profile, dir, read = readFileSync) {
  return (profile.sources ?? []).filter((source) => source.file).map((source) => {
    const path = resolve(dir, source.file);
    const inside = relative(resolve(dir), path);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`source ${source.id}: ${source.file} is outside ${dir}`);
    try {
      return { id: source.id, text: read(path, 'utf8') };
    } catch (error) {
      throw new Error(`source ${source.id}: cannot read ${source.file} (${error.code ?? error.message})`);
    }
  });
}

/**
 * Lower case, whitespace runs collapsed: a quote survives line wrapping. The
 * truth document is Markdown: bold, code marks and the profile's confidence
 * marks ([✔], [~ …], [LAB], [✘]) are not part of what it says.
 */
const flat = (text) =>
  text
    .replace(/\*\*|`/g, '')
    .replace(/\s*\[(?:✔|~|✘|LAB)[^\]]*\]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const numbers = (text) => String(text ?? '').match(/\d+(?:[.,]\d+)?/g) ?? [];

/** A crude stem, the same as the offer check's: an inflection is the same word. */
const stem = (word) => word.slice(0, 6);

/**
 * Every line the CV may show traces to the truth document (`profile.truth`,
 * Nicolas's profile v4): a bullet or a fact is found in it word for word, or
 * is made of the pieces it cites (`quotes`, never empty): each of its content
 * words is in one of them, and it brings no number of its own. Its English
 * text brings no number, and names no profile skill, the French one lacks.
 */
export function checkProvenance(profile, texts) {
  if (!profile.truth) return [];
  const source = texts.find(({ id }) => id === profile.truth);
  if (!source) return [`the truth document ${profile.truth} has no text`];
  const truth = flat(source.text);
  const errors = [];
  const skills = (profile.skills ?? []).map((skill) => ({ name: skill.name, names: identityNames(skill).filter((name) => name.length >= 3) }));
  const trace = (label, item) => {
    if (Array.isArray(item.quotes) && item.quotes.length === 0) errors.push(`${label}: no quote`);
    const quotes = item.quotes ?? [item.fr];
    for (const quote of quotes) {
      if (!truth.includes(flat(quote))) errors.push(`${label}: "${quote}" is not in ${profile.truth}`);
    }
    if (item.quotes) {
      const cited = new Set(wordsOf(quotes.join(' ')).map(stem));
      for (const word of new Set(wordsOf(item.fr))) {
        if (!/^\d/.test(word) && !STOP.has(word) && !cited.has(stem(word))) errors.push(`${label}: "${word}" is in none of its quotes`);
      }
    }
    const cited = new Set(numbers(quotes.join(' ')));
    for (const number of numbers(item.fr)) if (!cited.has(number)) errors.push(`${label}: the number ${number} is in none of its quotes`);
    const french = new Set(numbers(item.fr));
    for (const number of numbers(item.en)) {
      if (!french.has(number)) errors.push(`${label}: the English text has the number ${number}, the French one does not`);
    }
    for (const skill of skills) {
      const named = (text) => skill.names.some((name) => mentions(text ?? '', name));
      if (named(item.en) && !named(item.fr)) errors.push(`${label}: the English text names ${skill.name}, the French one does not`);
    }
  };
  for (const experience of profile.experiences) {
    for (const bullet of experience.bullets) trace(`bullet ${bullet.id}`, bullet);
  }
  for (const fact of profile.profile_facts ?? []) trace(`fact ${fact.id}`, fact);
  for (const title of profile.titles ?? []) trace(`title ${title.id}`, title);
  for (const entry of profile.never ?? []) {
    if (entry.quote && !truth.includes(flat(entry.quote))) errors.push(`never-claimed ${entry.name}: "${entry.quote}" is not in ${profile.truth}`);
  }
  return errors;
}

/**
 * Requirements the CV leaves unmet that an older CV (grade C) names: worth
 * confirming, then adding to the profile if true. Never-claimed skills are
 * not suggested back.
 */
export function olderMentions(analysis, profile, texts) {
  const cvs = new Map((profile.sources ?? []).filter((source) => source.grade === 'C').map((source) => [source.id, source.title]));
  const found = [];
  for (const requirement of analysis.requirements ?? []) {
    if (requirement.match !== 'no' || isNever(requirement, profile.never)) continue;
    const sources = texts.filter(({ id, text }) => cvs.has(id) && mentions(text, requirement.name)).map(({ id }) => cvs.get(id));
    if (sources.length) found.push({ requirement: requirement.name, sources });
  }
  return found;
}

/**
 * Every evidence quote whose source has a text must be found in it, word for
 * word (case and line breaks aside): the detector may not invent its proof.
 */
export function checkQuotes(profile, texts) {
  const byId = new Map(texts.map(({ id, text }) => [id, flat(text)]));
  const errors = [];
  for (const skill of profile.skills) {
    for (const entry of skill.evidence ?? []) {
      if (!byId.has(entry.source)) continue;
      if (!entry.quote?.trim()) errors.push(`skill ${skill.id}: evidence from ${entry.source} has no quote`);
      else if (!byId.get(entry.source).includes(flat(entry.quote))) {
        errors.push(`skill ${skill.id}: the quote "${entry.quote}" is not in ${entry.source}`);
      }
    }
  }
  return errors;
}

/** Grade C evidence: which CVs mention each skill, by name or alias. */
export function scanSources(profile, texts) {
  const grades = new Map((profile.sources ?? []).map((source) => [source.id, source.grade]));
  const found = new Map();
  for (const skill of profile.skills) {
    const names = searchable(identityNames(skill));
    for (const { id, text } of texts) {
      if (grades.get(id) !== 'C') continue;
      if (names.some((name) => mentions(text, name))) {
        if (!found.has(skill.id)) found.set(skill.id, []);
        found.get(skill.id).push({ source: id, grade: 'C', stance: 'for', auto: true });
      }
    }
  }
  return found;
}

/** The verdict, evidence and flags of every skill of the profile. */
export function assess(profile, scanned) {
  const sources = new Map((profile.sources ?? []).map((source) => [source.id, source]));
  return profile.skills.map((skill) => {
    const manual = (skill.evidence ?? []).map((entry) => ({ ...entry, grade: sources.get(entry.source)?.grade ?? 'C' }));
    const evidence = [...manual, ...(scanned.get(skill.id) ?? [])];
    const supporting = evidence.filter((entry) => entry.stance !== 'against');
    const opposing = evidence.filter((entry) => entry.stance === 'against');
    const best = (list) => Math.max(0, ...list.map((entry) => GRADE_RANK[entry.grade] ?? 0));
    const bestFor = best(supporting);
    const bestAgainst = best(opposing);

    let verdict;
    if (bestAgainst >= GRADE_RANK.B && bestAgainst >= bestFor) verdict = 'contradicted';
    else if (supporting.length === 0) verdict = opposing.length ? 'contradicted' : 'unsupported';
    else if (bestFor >= GRADE_RANK.B) verdict = 'verified';
    else if (opposing.length) verdict = 'inconsistent';
    else verdict = 'self-declared';

    const count = new Set(supporting.map((entry) => entry.source)).size;
    const flags = [];
    if (skill.level !== 'notions' && verdict === 'self-declared' && count < 2) {
      flags.push(`${skill.name}: ${skill.level} level claimed in one CV only`);
    }
    // Levels stated by the sources ("Proficient: AWS", "Notions Azure"),
    // LEVELS runs from expert (0) down to notions.
    const stated = supporting.filter((entry) => LEVELS.includes(entry.level));
    if (new Set(stated.map((entry) => entry.level)).size > 1) {
      const where = stated.map((entry) => `${entry.level} in ${sources.get(entry.source)?.title ?? entry.source}`);
      flags.push(`${skill.name}: the sources disagree on the level (${where.join(', ')})`);
    }
    const highest = Math.min(...stated.map((entry) => LEVELS.indexOf(entry.level)));
    if (stated.length && LEVELS.indexOf(skill.level) < highest) {
      flags.push(`${skill.name}: the profile says ${skill.level}, the sources say ${LEVELS[highest]} at most`);
    }
    if (verdict === 'inconsistent') {
      flags.push(`${skill.name}: the sources disagree (${opposing.map((entry) => entry.quote).filter(Boolean).join('; ')})`);
    }
    return { id: skill.id, name: skill.name, names: identityNames(skill), level: skill.level, verdict, sources: count, evidence, flags };
  });
}

/** The assessment entries of the skills that may be neither shown nor claimed, by id. */
export function blocked(assessment) {
  return new Map((assessment ?? []).filter((entry) => !SHOWABLE.has(entry.verdict)).map((entry) => [entry.id, entry]));
}

/**
 * The profile the CV may draw from: without the skills the evidence rules
 * out, nor any bullet, fact, certification or environment entry naming one,
 * nor an experience left without a bullet. `removed` says what went and why.
 * The profile passed in is not modified.
 */
export function restrict(input, assessment) {
  const profile = structuredClone(input);
  const out = blocked(assessment);
  const removed = [];
  const named = (...texts) => {
    for (const entry of out.values()) {
      if (searchable(entry.names).some((name) => texts.some((text) => mentions(text ?? '', name)))) return entry;
    }
    return null;
  };
  const why = (entry) => `${entry.name}, which the evidence says is ${entry.verdict}`;

  profile.skills = profile.skills.filter((skill) => {
    if (!out.has(skill.id)) return true;
    removed.push(`skill ${skill.id}: ${out.get(skill.id).verdict}`);
    return false;
  });
  for (const experience of profile.experiences) {
    experience.bullets = experience.bullets.filter((bullet) => {
      const entry = out.get((bullet.skills ?? []).find((id) => out.has(id))) ?? named(bullet.fr, bullet.en);
      if (entry) removed.push(`bullet ${bullet.id} names ${why(entry)}`);
      return !entry;
    });
    experience.env = (experience.env ?? []).filter((item) => {
      const entry = named(item);
      if (entry) removed.push(`environment entry "${item}" of ${experience.id} names ${why(entry)}`);
      return !entry;
    });
  }
  profile.experiences = profile.experiences.filter((experience) => {
    if (experience.bullets.length) return true;
    removed.push(`experience ${experience.id}: no bullet left`);
    return false;
  });
  for (const [key, label] of [['profile_facts', 'fact'], ['glance', 'glance line'], ['certifications', 'certification']]) {
    if (!profile[key]) continue;
    profile[key] = profile[key].filter((item, index) => {
      const entry = named(item.fr, item.en);
      if (entry) removed.push(`${label} ${item.id ?? index + 1} names ${why(entry)}`);
      return !entry;
    });
  }
  return { profile, removed };
}

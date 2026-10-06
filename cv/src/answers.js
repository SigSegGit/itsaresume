// The owner's answers to "do you have this skill?" (2.22a), kept in
// `answers.json` beside `profile.json`, private like it. A "yes" becomes a
// skill at the level he gave, quoting his own sentence (ADR-6: his words are
// a source; a model never writes an answer). A "no" adds nothing and is
// remembered so the question is not asked again (2.22b).

import { existsSync, readFileSync } from 'node:fs';
import { LEVELS, identityNames } from './profile.js';

/** The answers in `path`, or none when the file does not exist. Throws on bad JSON. */
export function readAnswers(path) {
  if (!existsSync(path)) return [];
  const answers = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(answers)) throw new Error(`${path}: a list of answers is expected`);
  return answers;
}

/**
 * The profile with each acceptable "yes" as a skill. `blocked` is the
 * evidence's blocked skills (`blocked()` in src/evidence.js): an answer
 * cannot bring one back. `errors` names every answer refused; the profile
 * passed in is not modified.
 */
export function mergeAnswers(input, answers, { blocked = new Map() } = {}) {
  const profile = structuredClone(input);
  const groups = new Set((profile.skill_groups ?? []).map((group) => group.id));
  const errors = [];
  const added = [];
  const seen = new Set();
  for (const answer of answers) {
    const id = answer.id;
    if (seen.has(id)) {
      errors.push(`answer ${id}: answered twice`);
      continue;
    }
    seen.add(id);
    if (answer.answer === 'no') continue;
    if (answer.answer !== 'yes') {
      errors.push(`answer ${id}: answer ${answer.answer} is neither yes nor no`);
      continue;
    }
    const name = String(answer.name ?? '').trim();
    const lower = name.toLowerCase();
    const refusals = [];
    if (!name) refusals.push('no skill name');
    if (!LEVELS.includes(answer.level)) refusals.push(`level ${answer.level} is not one of ${LEVELS.join(', ')}`);
    if (!String(answer.said ?? '').trim()) refusals.push('no sentence from the owner');
    if (!groups.has(answer.group)) refusals.push(`unknown group ${answer.group}`);
    const owned = profile.skills.find((skill) => identityNames(skill).includes(lower));
    if (owned) refusals.push(`${owned.name} already says ${name}; the profile wins`);
    const contradicted = [...blocked.values()].find((entry) => (entry.names ?? [entry.name.toLowerCase()]).includes(lower));
    if (contradicted) refusals.push(`the evidence says ${contradicted.name} is ${contradicted.verdict}`);
    if (refusals.length) {
      errors.push(...refusals.map((why) => `answer ${id}: ${why}`));
      continue;
    }
    profile.skills.push({
      id: `answer-${id}`, name, group: answer.group, level: answer.level, aliases: [],
      quote: answer.said.trim(), provenance: { answer: id },
    });
    added.push(`answer-${id}`);
  }
  return { profile, added, errors };
}

// What the model returns about an offer, and the checks that keep it honest.
//
// The model may only *select* from the profile (experience, bullet and skill
// ids) and write two free texts: the headline and the summary. Those two are
// where invention would happen, so they may not name a required technology
// the profile does not contain.

import { LANGUAGES, identityNames, skillNames } from './profile.js';
import { blocked } from './evidence.js';
import { mentions } from './text.js';
import { checkFreeText, UNTRUSTED } from './guard.js';
import { SYSTEM } from './prompt.js';
import { LISTING_SYSTEM } from './listing.js';

/** A skill's own names, three characters or more ("C" is not looked for in text). */
const skillNamesOnly = (skill) => identityNames(skill).filter((name) => name.length >= 3);

export { mentions };

/** Words that place a sentence in the lab or in R&D. */
const LAB_MARKERS = ['lab', 'labo', 'homelab', 'R&D', 'projet', 'projets', 'project', 'projects', 'perso', 'personnel', 'personal',
  'open source', 'ITSOMETHING', 'conception', 'conçu', 'conçue', 'conçoit', 'designed', 'design'];
export const VERDICTS = ['strong', 'good', 'partial', 'weak'];
export const MATCHES = ['yes', 'adjacent', 'no'];

/** Check an analysis against the profile it claims to use. */
export function validateAnalysis(analysis, profile, { language, assessment, offer } = {}) {
  const errors = [];
  const need = (condition, message) => condition || errors.push(message);

  if (language) {
    need(analysis?.language === language, `language ${analysis?.language}: the offer is in ${language}, so is the answer`);
  }
  need((analysis?.requirements ?? []).length > 0, 'no requirement was read from the offer, so the fit cannot be scored');

  const skills = new Map(profile.skills.map((skill) => [skill.id, skill]));
  const experiences = new Map(profile.experiences.map((experience) => [experience.id, experience]));
  const groups = new Set(profile.skill_groups.map((group) => group.id));

  need(LANGUAGES.includes(analysis?.language), `language ${analysis?.language} is not one of ${LANGUAGES.join(', ')}`);

  const fit = analysis?.fit ?? {};
  need(Number.isInteger(fit.score) && fit.score >= 0 && fit.score <= 100, `fit score ${fit.score} is not an integer from 0 to 100`);
  need(VERDICTS.includes(fit.verdict), `fit verdict ${fit.verdict} is not one of ${VERDICTS.join(', ')}`);

  for (const requirement of analysis?.requirements ?? []) {
    const name = requirement.name;
    need(MATCHES.includes(requirement.match), `requirement ${name}: match ${requirement.match} is not one of ${MATCHES.join(', ')}`);
    for (const id of requirement.skills ?? []) {
      need(skills.has(id), `requirement ${name}: unknown skill ${id}`);
    }
    // A language or certification row is met by the profile's own lines, not a skill (normalize.js).
    if ((requirement.match === 'yes' || requirement.match === 'adjacent') && requirement.kind !== 'language' && requirement.kind !== 'certification') {
      need((requirement.skills ?? []).length > 0, `requirement ${name} is marked ${requirement.match} but names no profile skill`);
    } else {
      need((requirement.skills ?? []).length === 0, `requirement ${name} is marked no but names profile skills`);
    }
  }

  const selected = analysis?.experiences ?? [];
  need(selected.length > 0, 'the analysis selects no experience');
  for (const choice of selected) {
    const experience = experiences.get(choice.id);
    if (!experience) {
      errors.push(`unknown experience ${choice.id}`);
      continue;
    }
    const own = new Set(experience.bullets.map((bullet) => bullet.id));
    for (const bullet of choice.bullets ?? []) {
      need(own.has(bullet), `bullet ${bullet} does not belong to experience ${choice.id}`);
    }
  }

  for (const choice of analysis?.skill_groups ?? []) {
    need(groups.has(choice.id), `unknown skill group ${choice.id}`);
    for (const id of choice.skills ?? []) {
      const skill = skills.get(id);
      if (!skill) errors.push(`unknown skill ${id}`);
      else need(skill.group === choice.id, `skill ${id} is not in group ${choice.id}`);
    }
  }

  // The honesty rule. Any requirement named in the free text must be one of
  // the profile's own skills (by name or alias); an "adjacent" match does not
  // count, because writing "Kubernetes" when the profile says Docker is the
  // exact invention this exists to stop.
  const known = new Set(profile.skills.flatMap(skillNames));
  const freeText = [analysis?.headline ?? '', ...(analysis?.summary ?? [])].join('\n');
  if (analysis?.from_profile) {
    // Profile text chosen by id (normalize.js): proven line by line, so the
    // free-text checks below do not apply to it.
    need(analysis.headline !== '', 'headline_ids: none of them is a profile title');
    need(analysis.summary.length > 0, 'summary_ids: no hook among them (the summary is exactly one hook, then at most one fact)');
    if (offer !== undefined) errors.push(...checkFreeText(analysis, profile, offer, { cv: false }));
    return { errors };
  }
  need(typeof analysis?.headline === 'string' && analysis.headline.trim() !== '', 'the headline is empty');
  need((analysis?.summary ?? []).length > 0, 'the summary is empty');
  (analysis?.summary ?? []).forEach((sentence, i) => need(typeof sentence === 'string', `summary ${i + 1} is not a sentence`));
  for (const requirement of analysis?.requirements ?? []) {
    if (!known.has(requirement.name.toLowerCase()) && mentions(freeText, requirement.name)) {
      errors.push(`the headline or summary claims ${requirement.name}, which is not in the profile (if the profile does cover it, add it as an alias of the skill that does)`);
    }
  }
  // Merged examples (normalize.js) are held to it one by one.
  for (const member of (analysis?.requirements ?? []).flatMap((requirement) => requirement.members ?? [])) {
    if (!known.has(member.toLowerCase()) && mentions(freeText, member)) {
      errors.push(`the headline or summary claims ${member}, which is not in the profile (if the profile does cover it, add it as an alias of the skill that does)`);
    }
  }
  // A skill the evidence contradicts or does not support is out of the free
  // text too, under any of its names, whether the offer asks for it or not.
  for (const entry of blocked(assessment).values()) {
    const named = entry.names.find((name) => mentions(freeText, name));
    if (named) errors.push(`the headline or summary claims ${entry.name} (as "${named}"), which the evidence says is ${entry.verdict}`);
  }

  // Profile v4, §3.10: what the candidate never claims is never written,
  // under any of its names, whether the offer asks for it or not.
  for (const entry of profile.never ?? []) {
    const named = [entry.name, ...(entry.aliases ?? [])].find((name) => mentions(freeText, name));
    if (named) errors.push(`the headline or summary claims ${named}, which the profile says is never to be claimed`);
  }

  // Profile v4, rule 1, in the free text too: a tool named in the same clause
  // as an organisation must have been used there ("Docker at Acme" when
  // Docker is lab-only, "Oracle at Acme" when Oracle was used at the bank).
  const units = [['headline', analysis?.headline ?? ''], ...(analysis?.summary ?? []).map((sentence, i) => [`summary ${i + 1}`, sentence])];
  const orgs = profile.experiences.map((experience) => ({ id: experience.id, names: [...new Set([experience.org.fr, experience.org.en])] }));
  const placed = profile.skills.filter((skill) => skill.where);
  for (const [label, text] of units) {
    for (const clause of String(text).split(/[;!?]|\.(?=\s|$)/)) {
      const found = orgs.flatMap((org) => org.names.filter((name) => mentions(clause, name)).map((name) => ({ id: org.id, name })));
      // "Example Bank" also mentions an organisation named "Example": the longer name is the one meant.
      const at = found.filter((org) => !found.some((other) => other.name.length > org.name.length && mentions(other.name, org.name)));
      if (at.length === 0) continue;
      for (const skill of placed.filter((s) => skillNamesOnly(s).some((name) => mentions(clause, name)))) {
        for (const { id, name } of at) {
          if (!skill.where.includes(id)) errors.push(`${label}: ${skill.name} is tied to ${name}, where it was not used`);
        }
      }
    }
  }

  // Profile v4, rule 6, in the summary: a sentence naming what only the lab
  // covers (a lab skill's name, alias, or a term no other skill has) says so,
  // as the owner's own wording does ("pratiquée en lab"). Not the headline:
  // a title ("Ingénieur plateforme IA") carries no such context.
  const levelsOf = new Map();
  for (const skill of profile.skills) {
    for (const name of [skill.name, ...(skill.aliases ?? []), ...(skill.terms ?? [])]) {
      const key = name.toLowerCase();
      levelsOf.set(key, { name: levelsOf.get(key)?.name ?? name, levels: [...(levelsOf.get(key)?.levels ?? []), skill.level] });
    }
  }
  const labOnly = [...levelsOf.values()].filter(({ name, levels }) => name.length >= 3 && levels.every((level) => level === 'lab')).map(({ name }) => name);
  (analysis?.summary ?? []).forEach((sentence, i) => {
    if (typeof sentence !== 'string' || LAB_MARKERS.some((marker) => mentions(sentence, marker))) return;
    const named = labOnly.find((name) => mentions(sentence, name));
    if (named) errors.push(`summary ${i + 1}: ${named} is practised in the lab only: say so (lab, R&D, personal project)`);
  });

  // Prompt injection (src/guard.js): the free text is checked as if the offer
  // had taken control of the model.
  if (offer !== undefined) errors.push(...checkFreeText(analysis, profile, offer, { instructions: [SYSTEM, LISTING_SYSTEM, UNTRUSTED] }));

  return { errors };
}

// The profile: everything the tool knows about the candidate. The CV is built
// from it alone, so a malformed profile is refused before any model is asked.
//
// Beyond shape, it checks the rules of Nicolas's profile v4 that data can
// break: every tool stays attached to the experiences where it was used
// (`where`, the attribution matrix), a lab skill belongs to R&D only, and
// experiences come main missions first, then short missions, then R&D.

import { mentions } from './text.js';

export const LANGUAGES = ['fr', 'en'];
/** From the most to the least; "lab" is practised in personal R&D only. */
export const LEVELS = ['expert', 'proficient', 'working', 'lab', 'notions'];
/** Experience kinds, in the order the CV lists them. */
export const KINDS = ['main', 'short', 'rnd'];
export const kindOf = (experience) => experience.kind ?? 'main';
/** Evidence grades and stances; what they mean is in src/evidence.js. */
export const GRADES = ['A', 'B', 'C'];
export const STANCES = ['for', 'against'];
/** A profile fact is a hook (a CV summary sentence), a fact (a CV-ready supporting sentence) or a note (context, never printed). */
export const FACT_KINDS = ['hook', 'fact', 'note'];

/** Whether `text` is a `{fr, en}` object with both translations non-empty. */
function bilingual(value) {
  return Boolean(value) && LANGUAGES.every((lang) => typeof value[lang] === 'string' && value[lang].trim() !== '');
}

function duplicates(ids) {
  const seen = new Set();
  return ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
}

/** Check a profile; `errors` is empty when it is usable. */
export function validateProfile(profile) {
  const errors = [];
  const need = (condition, message) => condition || errors.push(message);

  const identity = profile?.identity ?? {};
  for (const field of ['name', 'email', 'phone']) {
    need(typeof identity[field] === 'string' && identity[field] !== '', `identity.${field} is missing`);
  }
  need(bilingual(identity.location), 'identity.location needs fr and en');

  const groups = new Set((profile.skill_groups ?? []).map((group) => group.id));
  for (const group of profile.skill_groups ?? []) {
    need(bilingual(group.title), `skill group ${group.id}: title needs fr and en`);
  }

  // Evidence sources (src/evidence.js).
  const sources = new Set();
  for (const source of profile.sources ?? []) {
    if (sources.has(source.id)) errors.push(`duplicate source ${source.id}`);
    sources.add(source.id);
    need(GRADES.includes(source.grade), `source ${source.id}: grade ${source.grade} is not one of ${GRADES.join(', ')}`);
    need(typeof source.title === 'string' && source.title !== '', `source ${source.id}: no title`);
  }

  const skills = new Set();
  for (const skill of profile.skills ?? []) {
    skills.add(skill.id);
    need(groups.has(skill.group), `skill ${skill.id}: unknown group ${skill.group}`);
    need(LEVELS.includes(skill.level), `skill ${skill.id}: level ${skill.level} is not one of ${LEVELS.join(', ')}`);
    need(typeof skill.name === 'string' && skill.name !== '', `skill ${skill.id}: no name`);
    for (const entry of skill.evidence ?? []) {
      need(sources.has(entry.source), `skill ${skill.id}: evidence from unknown source ${entry.source}`);
      need(STANCES.includes(entry.stance), `skill ${skill.id}: evidence stance ${entry.stance} is not one of ${STANCES.join(', ')}`);
      if (entry.level !== undefined) {
        need(LEVELS.includes(entry.level), `skill ${skill.id}: evidence level ${entry.level} is not one of ${LEVELS.join(', ')}`);
      }
    }
  }

  const experiences = profile.experiences ?? [];
  need(experiences.length > 0, 'the profile has no experience');
  const kinds = experiences.map(kindOf);
  for (const kind of kinds) need(KINDS.includes(kind), `experience kind ${kind} is not one of ${KINDS.join(', ')}`);
  need(kinds.every((kind, i) => i === 0 || KINDS.indexOf(kinds[i - 1]) <= KINDS.indexOf(kind)), 'experiences: main missions first, then short missions, then R&D');
  const references = experiences.filter((experience) => experience.reference);
  need(references.length <= 1 && references.every((experience) => kindOf(experience) === 'main'), 'one reference experience, a main mission');

  // The attribution matrix: a skill with `where` was used in those experiences only.
  const byId = new Map((profile.skills ?? []).map((skill) => [skill.id, skill]));
  const kindById = new Map(experiences.map((experience) => [experience.id, kindOf(experience)]));
  const attributed = (skill, experienceId) => !skill.where || skill.where.includes(experienceId);
  for (const skill of profile.skills ?? []) {
    for (const id of skill.where ?? []) need(kindById.has(id), `skill ${skill.id}: unknown experience ${id}`);
    if (skill.level === 'lab' && skill.where) {
      need(skill.where.every((id) => kindById.get(id) === 'rnd'), `skill ${skill.id}: a lab skill belongs to R&D only`);
    }
  }

  const bulletIds = [];
  for (const experience of experiences) {
    need(bilingual(experience.title), `experience ${experience.id}: title needs fr and en`);
    need(bilingual(experience.org), `experience ${experience.id}: org needs fr and en`);
    need(Boolean(experience.start), `experience ${experience.id}: no start`);
    need((experience.bullets ?? []).length > 0, `experience ${experience.id}: no bullet`);
    for (const bullet of experience.bullets ?? []) {
      bulletIds.push(bullet.id);
      need(bilingual(bullet), `bullet ${bullet.id}: needs fr and en`);
      for (const skill of bullet.skills ?? []) {
        need(skills.has(skill), `bullet ${bullet.id}: unknown skill ${skill}`);
        if (byId.has(skill)) {
          need(attributed(byId.get(skill), experience.id), `bullet ${bullet.id}: ${byId.get(skill).name} is not attributed to ${experience.id}`);
        }
      }
    }
    for (const item of experience.env ?? []) {
      const own = (profile.skills ?? []).filter((skill) => skill.where && identityNames(skill).some((name) => mentions(item, name)));
      if (own.length && !own.some((skill) => attributed(skill, experience.id))) {
        errors.push(`environment of ${experience.id}: ${item} is not attributed to ${experience.id}`);
      }
    }
    if (experience.title_empty !== undefined) need(bilingual(experience.title_empty), `experience ${experience.id}: title_empty needs fr and en`);
  }

  need(profile.pending === undefined || (Array.isArray(profile.pending) && profile.pending.every((name) => typeof name === 'string' && name.trim() !== '')), 'pending must be absent or a list of non-empty names');
  for (const entry of profile.never ?? []) {
    need(typeof entry.name === 'string' && entry.name !== '', 'a never-claimed entry has no name');
  }
  // No line of the profile may name what the candidate never claims: a
  // bullet saying "migrated to Kubernetes" would print it on the CV.
  const neverNames = (profile.never ?? []).flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]).filter(Boolean);
  const neverIn = (label, ...texts) => {
    for (const name of neverNames) {
      if (texts.some((text) => mentions(text ?? '', name))) errors.push(`${label} names ${name}, which is never claimed`);
    }
  };
  for (const experience of experiences) {
    for (const bullet of experience.bullets ?? []) neverIn(`bullet ${bullet.id}`, bullet.fr, bullet.en);
    for (const item of experience.env ?? []) neverIn(`environment of ${experience.id}`, item);
  }
  for (const fact of profile.profile_facts ?? []) neverIn(`fact ${fact.id}`, fact.fr, fact.en);
  (profile.glance ?? []).forEach((line, index) => neverIn(`glance line ${index + 1}`, line.fr, line.en));
  (profile.certifications ?? []).forEach((line, index) => neverIn(`certification ${index + 1}`, line.fr, line.en));

  for (const [list, name] of [
    [profile.titles ?? [], 'title'],
    [profile.glance ?? [], 'glance'],
    [profile.certifications ?? [], 'certification'],
    [profile.languages ?? [], 'language'],
  ]) {
    list.forEach((entry, index) => need(bilingual(entry), `${name} ${index + 1}: needs fr and en`));
  }
  for (const school of profile.education ?? []) {
    need(bilingual(school.title), `education ${school.id}: title needs fr and en`);
  }
  for (const fact of profile.profile_facts ?? []) {
    need(FACT_KINDS.includes(fact.kind), `fact ${fact.id}: kind ${fact.kind} is not one of ${FACT_KINDS.join(', ')}`);
  }
  if ((profile.titles ?? []).length) {
    need((profile.profile_facts ?? []).some((fact) => fact.kind === 'hook'), 'the profile has titles but no hook: the summary is one hook');
  }

  const ids = [
    ...(profile.skill_groups ?? []).map((group) => group.id),
    ...(profile.skills ?? []).map((skill) => skill.id),
    ...experiences.map((experience) => experience.id),
    ...bulletIds,
    ...(profile.titles ?? []).map((title) => title.id),
  ];
  for (const id of duplicates(ids)) errors.push(`duplicate id ${id}`);

  return { errors };
}

/**
 * A skill's own names, lower-cased: its name and its aliases (true synonyms,
 * "Postgres" for PostgreSQL). These are what a CV mentions it by.
 */
export function identityNames(skill) {
  return [skill.name, ...(skill.aliases ?? [])].map((name) => name.toLowerCase());
}

/**
 * Every word that matches the skill in an offer, lower-cased: its own names
 * and the broader terms it covers ("security" for PCI-DSS). A term is not
 * another name: a CV writing "security" is no evidence of PCI-DSS.
 */
export function skillNames(skill) {
  return [...identityNames(skill), ...(skill.terms ?? []).map((term) => term.toLowerCase())];
}

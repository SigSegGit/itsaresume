// Safe repairs of a model's answer, before validation.
//
// A repair may move a selection to where it belongs, or remove one the
// profile cannot back. The only thing it adds is a profile skill to a
// requirement named exactly like that skill — the profile's own words, not a
// guess. It never touches the headline or the summary: the free text is where
// invention lives, and it is either valid as written or refused.

import { isNever, qualification, scoreOf } from './score.js';
import { kindOf, LANGUAGES, skillNames } from './profile.js';
import { blocked } from './evidence.js';
import { backsRequirement } from './tailor.js';
import { cleanName, LIMITS } from './guard.js';
import { alike, defaultIndex, members, skillConcepts } from './lexicon.js';
import { importanceIn } from './importance.js';
import { canonical, enumerations, GENERIC, mentions, namesQuality, statedIn, stem, STOP, wordsOf } from './text.js';

/** Lower is stricter: of two rows for one requirement, the stricter match is kept. */
const STRICTNESS = { no: 0, adjacent: 1, yes: 2 };
/** The skills column: at most this many groups shown, and skills in each (the prompt says so; the model does not always listen). */
export const MAX_GROUPS = 6;
export const MAX_GROUP_SKILLS = 6;

/**
 * Whether one of the requirement's content words is among the words of the
 * skills' names, aliases or terms. A name with no content word left ("QA")
 * cannot be judged this way and is left to the model.
 */
function grounded(name, matched) {
  const wanted = wordsOf(name).filter((word) => !STOP.has(word) && !GENERIC.has(word)).map(stem);
  if (wanted.length === 0) return true;
  const named = new Set(matched.flatMap((skill) => skillNames(skill).flatMap((words) => wordsOf(words).map(stem))));
  return wanted.some((word) => named.has(word));
}

/**
 * Whether a requirement is a personal quality ("Pédagogie", "Capacité à
 * fédérer"): named with a quality word (text.js), and naming no product (a
 * word with a digit or an inner capital: "GitHub", "ITIL v4"), no profile
 * skill and nothing never claimed. The code decides, not the model:
 * "Leadership Kubernetes" stays a requirement to score.
 */
function isQuality(requirement, profile) {
  const name = canonical(requirement.name);
  if (!namesQuality(name) || /\p{N}|[\p{L}\p{N}]\p{Lu}/u.test(name) || isNever(requirement, profile.never)) return false;
  return !profile.skills.some((skill) => skillNames(skill).some((named) => mentions(name, named)));
}

/** Words that state a language's level or use, nothing else ("Anglais courant (écrit et oral)"). */
const LANGUAGE_WORDS = new Set(`langue langues language languages niveau level courant courante courants fluent fluency
  bilingue bilingual professionnel professionnelle professional business natif native maternelle écrit écrite parlé
  parlée oral orale read written spoken requis requise exigé exigée souhaité souhaitée apprécié appréciée obligatoire
  indispensable excellent excellente working proficiency proficient technique technical notions notion basique
  basiques basics basic débutant beginner intermédiaire intermediate avancé advanced`.split(/\s+/));
/** Profile levels that meet a language requirement; "notions" does not. */
const WORKING_LEVEL = /natif|native|maternel|bilingu|courant|fluent|profession|\bc[12]\b/i;
/**
 * Language levels in order (2.7e, Rodin 2026-09-29: "Anglais bilingue exigé"
 * against "courant" was yes): notions, intermediate, professional, fluent,
 * bilingual, native.
 */
const LEVELS = [
  /notions?|basi(?:que|c)s?|d[ée]butant|beginner|[ée]l[ée]mentaire|scolaire|\ba[12]\b/i,
  /interm[ée]diaire|intermediate|\bb1\b/i,
  /profession|business|working|op[ée]rationnel|\bb2\b/i,
  /courant|fluent|fluency|avanc[ée]|advanced|\bc1\b/i,
  /bilingu|\bc2\b/i,
  /natif|native|maternel|mother tongue/i,
];
/** The levels a text names, lowest first. */
const levelsIn = (text) => LEVELS.flatMap((level, rank) => (level.test(text) ? [rank] : []));
const [languageName, languageLevel] = [0, 1].map((part) => (line) => String(line ?? '').split(/\s+—\s+/)[part] ?? '');

/**
 * A certification an offer asks for: its word ("certification", "certifié",
 * "certified", not "certificats TLS") or a code offers name one by ("niveau
 * CKA"). Rodin, 2026-09-29: owning the skill is not holding the certificate.
 */
const CERTIFICATION = /(?<![\p{L}\p{N}])(certifi(?:cations?|[ée]e?s?|ed)|CKA|CKAD|CKS|RHCSA|RHCE|CCNA|CCNP|CISSP|OSCP|PMP|TOGAF|LPIC(?:-\d)?|AZ-\d{3})(?![\p{L}\p{N}])/iu;

/**
 * The profile's certification lines a certification requirement names, by a
 * word of three letters or more besides the certification words; `expired`
 * when every one of them says so. null when the requirement asks for none.
 */
function certificationOf(requirement, profile, lang) {
  const name = canonical(requirement.name);
  if (!CERTIFICATION.test(name)) return null;
  const asked = wordsOf(name).filter((word) => word.length >= 3 && !STOP.has(word) && !GENERIC.has(word) && !CERTIFICATION.test(word));
  const lines = (profile.certifications ?? []).filter((line) => LANGUAGES.some((l) => asked.some((word) => mentions(line[l] ?? '', word))));
  return {
    stated: lines.map((line) => line[lang] ?? line.fr),
    expired: lines.length > 0 && lines.every((line) => LANGUAGES.some((l) => /expir/i.test(line[l] ?? ''))),
  };
}

/**
 * What a migration asks for is its target: "Migration de Puppet vers
 * Ansible" is met through Ansible, not the Puppet it leaves (Rodin, 2026-09-29).
 */
const MIGRATION = /\b(?:migrations?|migrer|migrate|migrating|passage|transition|bascule)\b.*?\b(?:de|des|du|depuis|from)\s+.+?\s+(?:vers|to|→|->)\s+(.+)$/iu;
const asked = (name) => MIGRATION.exec(String(name ?? ''))?.[1] ?? name;

/**
 * The profile's languages a requirement asks for, when it asks for nothing
 * else ("Anglais professionnel", not "Documentation technique en anglais"):
 * `stated` their profile lines, `met` whether each is at a working level.
 */
function languageOf(requirement, profile, lang) {
  const words = wordsOf(requirement.name);
  const namesOf = (entry) => LANGUAGES.map((l) => languageName(entry[l]).toLowerCase());
  const named = (profile.languages ?? []).filter((entry) => namesOf(entry).some((name) => words.includes(name)));
  if (!named.length) return null;
  const names = new Set(named.flatMap(namesOf));
  if (!words.every((word) => names.has(word) || STOP.has(word) || GENERIC.has(word) || LANGUAGE_WORDS.has(word))) return null;
  return {
    stated: named.map((entry) => entry[lang] ?? entry.fr),
    match: languageMatch(requirement.name, named),
  };
}

/**
 * yes when every language named is held at the level the requirement asks
 * (its lowest, if it names several) or, when it asks none, at a working
 * level; adjacent when held at a working level below the one asked; no
 * otherwise.
 */
function languageMatch(name, named) {
  const [asked] = levelsIn(name);
  const held = named.map((entry) => Math.max(-1, ...LANGUAGES.flatMap((l) => levelsIn(languageLevel(entry[l])))));
  const working = named.every((entry) => LANGUAGES.some((l) => WORKING_LEVEL.test(languageLevel(entry[l]))));
  if (asked === undefined) return working ? 'yes' : 'no';
  if (held.every((rank) => rank >= asked)) return 'yes';
  return working ? 'adjacent' : 'no';
}

/**
 * The offer's examples in parentheses ("outils GenAI (Claude Code, GitHub
 * Copilot, BMad, etc.)") state one requirement, not one per example (seen:
 * five musts, 5/100). The rows an enumeration names are merged, enumerations
 * sharing a row are united, and the merged row is met as its best example is
 * (yes, then adjacent; client experience before lab): a never-claimed
 * example is said so in the report, and adds no must of its own.
 */
/** Words that name a category, not a product ("IIS web server"). */
const CATEGORY_WORDS = new Set(['web', 'server', 'servers', 'serveur', 'serveurs', 'database', 'databases', 'tool', 'tools', 'outil', 'outils',
  'platform', 'platforms', 'plateforme', 'plateformes', 'engine', 'engines', 'service', 'services', 'framework', 'frameworks']);

/**
 * A requirement's name without its category words: the model writes "IIS
 * web server" where the offer lists "(IIS, Apache, NGINX or Tomcat)" (2.10,
 * seen on a real run where IIS and Apache counted as musts twice).
 * "Apache Kafka" keeps its "Kafka".
 */
function core(name) {
  const kept = String(name ?? '').split(/\s+/).filter((word) => !CATEGORY_WORDS.has(word.toLowerCase()));
  return kept.length ? kept.join(' ') : String(name ?? '');
}

function mergeExamples(requirements, offer, profile, repairs, lang) {
  const lab = new Set(profile.skills.filter((skill) => skill.level === 'lab').map((skill) => skill.id));
  const parent = requirements.map((_, index) => index);
  const root = (index) => (parent[index] === index ? index : (parent[index] = root(parent[index])));
  for (const inside of enumerations(offer)) {
    // A language the profile names is settled on its own, level included,
    // never merged (seen 2026-09-30: "English, Spanish, and French or
    // Italian" became one row no longer read as a language, and the run was
    // refused twice).
    const named = requirements.flatMap((requirement, index) =>
      requirement.kind !== 'quality' && languageOf(requirement, profile, lang) === null && mentions(inside, core(requirement.name)) ? [index] : []);
    for (const index of named.slice(1)) parent[root(index)] = root(named[0]);
  }
  const groups = new Map();
  requirements.forEach((requirement, index) => groups.set(root(index), [...(groups.get(root(index)) ?? []), requirement]));
  const strength = (row) => 2 * STRICTNESS[row.match] + (row.skills.length > 0 && row.skills.every((id) => lab.has(id)) ? 0 : 1);
  return [...groups.values()].map((members) => {
    if (members.length === 1) return members[0];
    const best = members.reduce((kept, row) => (strength(row) > strength(kept) ? row : kept));
    const names = members.map((row) => row.name);
    const never = members.filter((row) => row.never).map((row) => row.name);
    repairs.push(`requirements ${names.join(', ')}: examples the offer lists together, counted as one`);
    return {
      name: names.join(' / '),
      importance: members.some((row) => row.importance === 'must') ? 'must' : 'nice',
      match: best.match,
      skills: best.skills,
      note: `examples the offer lists together: ${names.join(', ')}${never.length ? `; never claimed: ${never.join(', ')}` : ''}`,
      members: names,
      ...(never.length ? { never_members: never } : {}),
      ...(never.length === members.length ? { never: true } : {}),
    };
  });
}

/** Verdict thresholds, the same as the ones the prompt states. */
export function verdictFor(score) {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'good';
  if (score >= 40) return 'partial';
  return 'weak';
}

/**
 * `value` itself when it is a known id; the part before a colon when that is
 * one (seen: "bullet-id: the bullet's text"); otherwise `value` unchanged.
 */
function idOf(value, known, repairs) {
  if (typeof value !== 'string' || known.has(value)) return value;
  const prefix = value.split(':')[0].trim();
  if (value.includes(':') && known.has(prefix)) {
    repairs.push(`"${value.slice(0, 60)}" read as the id ${prefix}`);
    return prefix;
  }
  return value;
}

export function normalize(input, profile, { assessment, offer } = {}) {
  const analysis = structuredClone(input);
  const repairs = [];
  const bulletIds = new Set(profile.experiences.flatMap((experience) => experience.bullets.map((bullet) => bullet.id)));
  const skillIds = new Set(profile.skills.map((skill) => skill.id));
  let placement = null;
  const placed = () => (placement ??= skillConcepts(defaultIndex(), profile.skills.filter((skill) => !out.has(skill.id))));
  for (const choice of analysis.experiences ?? []) {
    choice.bullets = (choice.bullets ?? []).map((bullet) => idOf(bullet, bulletIds, repairs));
  }
  for (const choice of analysis.skill_groups ?? []) {
    choice.skills = (choice.skills ?? []).map((skill) => idOf(skill, skillIds, repairs));
  }
  for (const requirement of analysis.requirements ?? []) {
    // What kind of row this is (a personal quality, merged examples) is the code's call.
    delete requirement.kind;
    delete requirement.members;
    delete requirement.never_members;
    delete requirement.judged;
    delete requirement.equivalent;
    if (requirement.importance !== 'must' && requirement.importance !== 'nice') {
      repairs.push(`requirement ${cleanName(requirement.name) ?? '?'}: importance not must or nice, read as must`);
      requirement.importance = 'must';
    }
    requirement.skills = (requirement.skills ?? []).map((skill) => idOf(skill, skillIds, repairs));
    // A long name is cut; an unsafe one is left for validation to refuse (guard.js).
    const name = cleanName(requirement.name);
    if (name && name !== requirement.name) {
      if (name.length < String(requirement.name).trim().length) repairs.push(`requirement name cut to ${LIMITS.name} characters: ${name}`);
      requirement.name = name;
    }
  }

  // Skills the evidence contradicts or does not support are out, whatever
  // the model picked: they may be neither shown nor used to meet a requirement.
  const out = blocked(assessment);
  const allowed = (id, where) => {
    if (!out.has(id)) return true;
    repairs.push(`skill ${id} is ${out.get(id).verdict} by the evidence: dropped from ${where}`);
    return false;
  };
  for (const choice of analysis.skill_groups ?? []) {
    choice.skills = choice.skills.filter((id) => allowed(id, `group ${choice.id}`));
  }
  for (const requirement of analysis.requirements ?? []) {
    requirement.skills = requirement.skills.filter((id) => allowed(id, `requirement ${requirement.name}`));
  }
  const skills = new Map(profile.skills.map((skill) => [skill.id, skill]));
  const experienceIds = new Set(profile.experiences.map((experience) => experience.id));
  const owner = new Map();
  for (const experience of profile.experiences) {
    for (const bullet of experience.bullets) owner.set(bullet.id, experience.id);
  }


  // A requirement named exactly like a profile skill (or one of its aliases)
  // is met by that skill: the profile's own words settle it, not the model.
  const byName = new Map();
  for (const skill of profile.skills) {
    if (out.has(skill.id)) continue;
    for (const name of skillNames(skill)) if (!byName.has(name)) byName.set(name, skill.id);
  }

  // A requirement the offer does not state is the model's invention (it would
  // bring R&D projects and short missions onto the CV, and score): dropped.
  if (offer !== undefined) {
    analysis.requirements = (analysis.requirements ?? []).filter((requirement) => {
      if (statedIn(offer, String(requirement.name ?? ''))) return true;
      repairs.push(`requirement ${requirement.name}: not stated in the offer, dropped`);
      return false;
    });
    // What the candidate never claims counts when the offer names it, even if
    // the model left it out of the table (importance unknown: counted as must).
    for (const entry of profile.never ?? []) {
      const names = [entry.name, ...(entry.aliases ?? [])];
      if (!names.some((name) => mentions(offer, name))) continue;
      if ((analysis.requirements ?? []).some((requirement) => isNever(requirement, [entry]))) continue;
      repairs.push(`requirement ${entry.name}: named in the offer, never claimed in the profile, added as a must`);
      (analysis.requirements ??= []).push({ name: entry.name, importance: 'must', match: 'no', skills: [], note: '', never: true });
    }
    // Must or nice: where the offer gives a cue ("serait un plus",
    // "obligatoire"), the offer decides, not the model (2.6, ADR-9).
    for (const requirement of analysis.requirements ?? []) {
      const said = importanceIn(offer, String(requirement.name ?? ''));
      if (!said || said === requirement.importance) continue;
      repairs.push(`requirement ${requirement.name}: ${said} by the offer's cue, the model said ${requirement.importance}`);
      requirement.importance = said;
    }
  }

  const keys = [];
  for (const requirement of analysis.requirements ?? []) {
    const named = byName.get(String(requirement.name ?? '').trim().toLowerCase());
    // The profile's own name settles it, and that skill alone meets it: an
    // extra skill the model adds may not lift a lab-only match to full credit.
    if (named && (requirement.match !== 'yes' || requirement.skills.length !== 1 || requirement.skills[0] !== named)) {
      const others = requirement.skills.filter((id) => id !== named);
      repairs.push(`requirement ${requirement.name}: named like the profile skill ${named}, now yes with that skill alone${others.length ? ` (dropped: ${others.join(', ')})` : ''}`);
      requirement.match = 'yes';
      requirement.skills = [named];
    }
    keys.push(named ? `skill:${named}` : `name:${String(requirement.name ?? '').trim().toLowerCase()}`);
    // Profile v4, §3.10: what the candidate never claims stays a gap, whatever the model thought.
    if (isNever(requirement, profile.never)) {
      if (requirement.match !== 'no' || !requirement.never) repairs.push(`requirement ${requirement.name}: never claimed in the profile, now no`);
      requirement.match = 'no';
      requirement.skills = [];
      requirement.never = true;
      requirement.note = 'never claimed (profile)';
    }
    const known = (requirement.skills ?? []).filter((id) => skills.has(id));
    for (const id of (requirement.skills ?? []).filter((id) => !skills.has(id))) {
      repairs.push(`requirement ${requirement.name}: unknown skill ${id} dropped`);
    }
    // A pick the requirement's concept holds is not the model's reading only
    // (seen 2026-09-29: "SQL" through PostgreSQL and Oracle demoted to
    // verify), and another name of that pick's concept meets it too ("Shell"
    // kept KSH and dropped Bash, expert: "Shell" names KSH in the profile).
    // Only the model's extra picks are dropped for a named requirement (above).
    const met = (requirement.match === 'yes' || requirement.match === 'adjacent') && known.length > 0 && !requirement.never;
    const held = met ? members(defaultIndex(), asked(requirement.name), placed()).filter((id) => known.includes(id)) : [];
    for (const id of (met ? alike(defaultIndex(), asked(requirement.name), placed(), known) : []).filter((id) => !known.includes(id))) {
      known.push(id);
      repairs.push(`requirement ${requirement.name}: the profile's ${skills.get(id).name} meets it too`);
    }
    requirement.skills = known;
    // A requirement is fully met only through a skill the profile names for
    // it: one of its content words is among the words of the skill's name,
    // aliases or terms. Otherwise the match is the model's reading only
    // ("Cycles de delivery" through CI/CD and GitOps): half credit at most,
    // flagged to verify, and still a gap of the qualification. Zeroing it
    // turned real matches into false gaps.
    if ((requirement.match === 'yes' || requirement.match === 'adjacent') && known.length > 0 && held.length === 0 && !grounded(asked(requirement.name), known.map((id) => skills.get(id)))) {
      repairs.push(`requirement ${requirement.name}: no profile skill names it, the model's reading only: adjacent, to verify`);
      requirement.match = 'adjacent';
      requirement.judged = true;
    }
    if ((requirement.match === 'yes' || requirement.match === 'adjacent') && requirement.skills.length === 0) {
      repairs.push(`requirement ${requirement.name}: marked ${requirement.match} without a profile skill, now no`);
      requirement.match = 'no';
    } else if (requirement.match === 'no' && requirement.skills.length > 0) {
      repairs.push(`requirement ${requirement.name}: marked no, its skills dropped`);
      requirement.skills = [];
    }
    // A personal quality is for the interview: no profile skill backs it, and
    // as an unmet must-have it sank the qualification (seen: "Profil
    // polyvalent", "Curieux techniquement", partial became not qualified).
    if (isQuality(requirement, profile)) {
      requirement.kind = 'quality';
      requirement.match = 'no';
      requirement.skills = [];
      repairs.push(`requirement ${requirement.name}: a personal quality, not scored (to show in interview)`);
    }
    // A language is the profile's languages to answer, not a skill's (seen:
    // "Anglais professionnel" no beside "Anglais — bilingue"): met at a
    // working level, no at "notions", the profile's line said either way.
    const spoken = requirement.never || requirement.kind === 'quality' ? null : languageOf(requirement, profile, analysis.language);
    if (spoken) {
      const { match } = spoken;
      if (requirement.match !== match) repairs.push(`requirement ${requirement.name}: a language, ${match} by the profile (${spoken.stated.join(', ')})`);
      requirement.kind = 'language';
      requirement.match = match;
      requirement.skills = [];
      requirement.note = `profile: ${spoken.stated.join(', ')}`;
      delete requirement.judged;
    }
    // A certification is the profile's certifications to answer, never a
    // skill's: met when a certification line names it, adjacent when that
    // line says it expired, no otherwise, whatever the model read.
    const certified = requirement.never || requirement.kind === 'quality' || spoken ? null : certificationOf(requirement, profile, analysis.language);
    if (certified) {
      const match = certified.stated.length === 0 ? 'no' : certified.expired ? 'adjacent' : 'yes';
      if (requirement.match !== match) repairs.push(`requirement ${requirement.name}: a certification, ${match} by the profile's certifications`);
      requirement.kind = 'certification';
      requirement.match = match;
      requirement.skills = [];
      requirement.note = certified.stated.length ? `profile: ${certified.stated.join(', ')}` : 'no such certification in the profile';
      delete requirement.judged;
    }
    // A category the offer names loosely ("Conteneurisation", "Cloud public")
    // that holds skills of the profile is not a gap: adjacent, by code, with
    // the equivalent named for the owner (seen: false "non" on generic rows).
    if (requirement.match === 'no' && !requirement.never && requirement.kind !== 'quality' && requirement.kind !== 'language' && requirement.kind !== 'certification') {
      const found = members(defaultIndex(), asked(requirement.name), placed());
      if (found.length) {
        const names = found.map((id) => skills.get(id).name);
        requirement.match = 'adjacent';
        requirement.skills = found;
        requirement.equivalent = names;
        requirement.note = [requirement.note, `equivalent: ${names.join(', ')}`].filter(Boolean).join('; ');
        repairs.push(`requirement ${requirement.name}: marked no, the profile holds ${names.join(', ')}: adjacent`);
      }
    }
  }

  // One row per requirement: a row repeated (or two names of one profile
  // skill) counts once, with the stricter match and the higher importance.
  const merged = new Map();
  (analysis.requirements ?? []).forEach((requirement, index) => {
    const key = requirement.never ? `never:${requirement.name.toLowerCase()}` : keys[index];
    const kept = merged.get(key);
    if (!kept) return merged.set(key, { row: requirement, count: 1 });
    kept.count += 1;
    if (STRICTNESS[requirement.match] < STRICTNESS[kept.row.match]) kept.row = { ...requirement, importance: kept.row.importance };
    if (requirement.importance === 'must') kept.row.importance = 'must';
  });
  for (const { row, count } of merged.values()) {
    if (count > 1) repairs.push(`requirement ${row.name}: listed ${count} times, counted once`);
  }
  if (analysis.requirements) analysis.requirements = [...merged.values()].map(({ row }) => row);
  if (offer !== undefined && analysis.requirements) analysis.requirements = mergeExamples(analysis.requirements, offer, profile, repairs, analysis.language);

  // Experiences: every bullet goes under the experience that owns it, in the
  // order the model gave; an experience id that is really a bullet id counts
  // as that bullet.
  const bullets = new Map();
  const order = [];
  const place = (experienceId, bulletId) => {
    if (!bullets.has(experienceId)) {
      bullets.set(experienceId, []);
      order.push(experienceId);
    }
    if (bulletId && !bullets.get(experienceId).includes(bulletId)) bullets.get(experienceId).push(bulletId);
  };
  for (const choice of analysis.experiences ?? []) {
    if (experienceIds.has(choice.id)) place(choice.id);
    else if (owner.has(choice.id)) {
      repairs.push(`${choice.id} is a bullet, not an experience: moved under ${owner.get(choice.id)}`);
      place(owner.get(choice.id), choice.id);
    } else repairs.push(`unknown experience ${choice.id} dropped`);
    for (const bullet of choice.bullets ?? []) {
      if (!owner.has(bullet)) repairs.push(`unknown bullet ${bullet} dropped`);
      else {
        if (experienceIds.has(choice.id) && owner.get(bullet) !== choice.id) {
          repairs.push(`bullet ${bullet} moved from ${choice.id} to ${owner.get(bullet)}`);
        }
        place(owner.get(bullet), bullet);
      }
    }
  }
  // Profile v4, rule 3: a short mission or an R&D project earns its place by
  // backing a requirement the offer states (tailor.js enforces it; this says so).
  const backs = backsRequirement(profile, analysis);
  const experienceById = new Map(profile.experiences.map((experience) => [experience.id, experience]));
  for (const id of order) {
    const experience = experienceById.get(id);
    if (kindOf(experience) === 'main') continue;
    const bulletOf = new Map(experience.bullets.map((bullet) => [bullet.id, bullet]));
    bullets.set(id, bullets.get(id).filter((bullet) => {
      if (backs(bulletOf.get(bullet))) return true;
      repairs.push(`bullet ${bullet} (${kindOf(experience) === 'rnd' ? 'R&D project' : 'short mission'}) backs no requirement the offer states: dropped`);
      return false;
    }));
  }
  analysis.experiences = order.map((id) => ({ id, bullets: bullets.get(id) }));

  // Skill groups: every skill goes to its own group, in the order given.
  const groups = new Map();
  const groupOrder = [];
  const put = (groupId, skillId) => {
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
      groupOrder.push(groupId);
    }
    if (skillId && !groups.get(groupId).includes(skillId)) groups.get(groupId).push(skillId);
  };
  const groupIds = new Set(profile.skill_groups.map((group) => group.id));
  for (const choice of analysis.skill_groups ?? []) {
    if (!groupIds.has(choice.id)) repairs.push(`unknown skill group ${choice.id} dropped`);
    for (const id of choice.skills ?? []) {
      const skill = skills.get(id);
      if (!skill) repairs.push(`unknown skill ${id} dropped`);
      else {
        if (groupIds.has(choice.id) && skill.group !== choice.id) repairs.push(`skill ${id} moved to its group ${skill.group}`);
        put(skill.group, id);
      }
    }
  }
  // A skill that meets a requirement is in the column even when the model did
  // not list it (2.7g: open since the 2026-09-27 audit). A hidden group never
  // shows; a skill the evidence blocks never enters.
  const listed = new Set([...groups.values()].flat());
  const unseen = new Set(profile.skill_groups.filter((group) => group.hidden).map((group) => group.id));
  for (const requirement of analysis.requirements ?? []) {
    if (requirement.match === 'no') continue;
    for (const id of requirement.skills ?? []) {
      const skill = skills.get(id);
      if (!skill || listed.has(id) || out.has(id) || unseen.has(skill.group)) continue;
      put(skill.group, skill.id);
      listed.add(id);
      repairs.push(`skill ${id}: meets ${requirement.name}, added to the skills column`);
    }
  }
  analysis.skill_groups = groupOrder.map((id) => ({ id, skills: groups.get(id) }));

  // The skills column (seen: 50 skills picked, the column ran onto a second
  // page and pushed every optional bullet out): the skills that meet a
  // requirement first, then the model's order; at most MAX_GROUPS shown groups
  // of MAX_GROUP_SKILLS. Hidden groups never show, so they are not counted.
  const met = new Set((analysis.requirements ?? []).filter((r) => r.match !== 'no').flatMap((r) => r.skills));
  const hidden = new Set(profile.skill_groups.filter((group) => group.hidden).map((group) => group.id));
  // Beyond MAX_GROUPS, the groups holding a met skill are kept first, each
  // in the model's order.
  const shownChoices = analysis.skill_groups.filter((choice) => !hidden.has(choice.id));
  const holdsMet = (choice) => choice.skills.some((id) => met.has(id));
  const kept = new Set([...shownChoices.filter(holdsMet), ...shownChoices.filter((choice) => !holdsMet(choice))].slice(0, MAX_GROUPS).map((choice) => choice.id));
  analysis.skill_groups = analysis.skill_groups.filter((choice) => {
    if (hidden.has(choice.id) || kept.has(choice.id)) return true;
    repairs.push(`skill group ${choice.id}: beyond ${MAX_GROUPS} groups, left out`);
    return false;
  });
  for (const choice of analysis.skill_groups) {
    const ordered = [...choice.skills.filter((id) => met.has(id)), ...choice.skills.filter((id) => !met.has(id))];
    if (!hidden.has(choice.id) && ordered.length > MAX_GROUP_SKILLS) {
      repairs.push(`skill group ${choice.id}: ${ordered.length} skills, cut to ${MAX_GROUP_SKILLS}`);
      ordered.length = MAX_GROUP_SKILLS;
    }
    choice.skills = ordered;
  }

  // With titles in the profile, the headline and the summary are chosen by id
  // among the profile's titles and facts and taken verbatim, in the analysis
  // language: the CV then holds no word the model wrote.
  if (profile.titles?.length) {
    const lang = LANGUAGES.includes(analysis.language) ? analysis.language : 'fr';
    const titles = new Map(profile.titles.map((title) => [title.id, title]));
    const facts = new Map((profile.profile_facts ?? []).map((fact) => [fact.id, fact]));
    const pick = (ids, known, max) => [...new Set(Array.isArray(ids) ? ids : [])].filter((id) => known.has(id)).slice(0, max);
    // The summary is one hook, the first the model listed, and at most one
    // supporting fact; a note is context for the model, never CV text. No
    // hook, no summary: validation refuses it and the model is asked again.
    const listed = pick(analysis.summary_ids, facts, Infinity);
    const hook = listed.find((id) => facts.get(id).kind === 'hook');
    const fact = listed.find((id) => facts.get(id).kind === 'fact');
    for (const id of listed.filter((id) => id !== hook && id !== fact)) {
      const kind = facts.get(id).kind;
      repairs.push(kind === 'note' ? `summary: ${id} is a note (context only), not printed` : `summary: ${id} left out, ${kind === 'hook' ? 'one hook only' : 'one supporting fact at most'}`);
    }
    analysis.summary = hook ? [hook, fact].filter(Boolean).map((id) => facts.get(id)[lang]) : [];
    const headed = pick(analysis.headline_ids, titles, 2);
    // A must met only through skills the CV never shows (a hidden group) and
    // named by none of the text picked (summary, bullets, skills column) is
    // put on the page by the profile's title naming it, second after the
    // model's first (2.7f, seen 2026-09-29: "DevOps", a must, was nowhere on
    // the CV). A second title naming such a must is never pushed out. No
    // title, or no place: said, for the owner.
    const bulletText = new Map(profile.experiences.flatMap((experience) => experience.bullets).map((bullet) => [bullet.id, bullet[lang] ?? '']));
    const shownText = [
      ...analysis.summary,
      ...(analysis.experiences ?? []).flatMap((choice) => (choice.bullets ?? []).map((id) => bulletText.get(id) ?? '')),
      ...(analysis.skill_groups ?? []).filter((choice) => !hidden.has(choice.id)).flatMap((choice) => choice.skills.map((id) => skills.get(id)?.name ?? '')),
    ].join('\n');
    const musts = (analysis.requirements ?? [])
      .filter((requirement) => requirement.importance === 'must' && requirement.match !== 'no' && (requirement.skills ?? []).length > 0)
      .filter((requirement) => requirement.skills.every((id) => hidden.has(skills.get(id)?.group)))
      .map((requirement) => ({ name: requirement.name, names: [requirement.name, ...requirement.skills.map((id) => skills.get(id).name)] }));
    const naming = (id, must) => must.names.some((name) => mentions(titles.get(id)[lang], name));
    const untold = musts.filter((must) => !must.names.some((name) => mentions(shownText, name)));
    const unshown = untold.filter((must) => !headed.some((id) => naming(id, must)));
    const free = headed.length === 1 || (headed.length === 2 && !untold.some((must) => naming(headed[1], must)));
    unshown.forEach((must, index) => {
      const title = profile.titles.find((entry) => naming(entry.id, must));
      if (title && index === 0 && free) {
        headed.splice(1, 1, title.id);
        repairs.push(`headline: ${title[lang]} second, it names ${must.name}, a must the CV would not show`);
      } else {
        repairs.push(`requirement ${must.name}: a must met through skills the CV does not show, and ${title ? 'the headline has no place left for its title' : 'no profile title names it'}: not on the page`);
      }
    });
    analysis.headline = headed.map((id) => titles.get(id)[lang]).join(' · ');
    analysis.from_profile = true;
    repairs.push('headline and summary taken from the profile (titles and facts chosen by id)');
  }

  // The score is computed from the (repaired) requirement table; the model's
  // own figure is kept alongside, for comparison only.
  const fit = analysis.fit ?? {};
  const lab = new Set(profile.skills.filter((skill) => skill.level === 'lab').map((skill) => skill.id));
  const score = scoreOf(analysis.requirements ?? [], { lab });
  analysis.fit = {
    ...fit,
    model_score: fit.score,
    score,
    verdict: score === null ? undefined : verdictFor(score),
    qualification: qualification(analysis.requirements ?? [], { lab, never: profile.never }),
  };

  return { analysis, repairs };
}

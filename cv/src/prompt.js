// What the model is asked. The profile goes in as a catalogue of ids so the
// answer can be checked mechanically (src/analysis.js).

import { detectLanguage, LANGUAGE_NAMES } from './language.js';
import { fence, UNTRUSTED } from './guard.js';
import { kindOf } from './profile.js';
import { shortlist } from './links.js';
import { defaultIndex, key, skillConcepts } from './lexicon.js';

const SHAPE = {
  language: 'fr | en',
  fit: { rationale: '2-3 sentences' },
  requirements: [{ listed: 'L1', name: 'Kubernetes', importance: 'must | nice', match: 'yes | adjacent | no', skills: ['skill-id'], note: '' }],
  headline_ids: ['title-id'],
  summary_ids: ['hook-id', 'fact-id'],
  headline: 'CV title line',
  summary: ['sentence', 'sentence'],
  experiences: [{ id: 'experience-id', bullets: ['bullet-id'] }],
  skill_groups: [{ id: 'group-id', skills: ['skill-id'] }],
};

export const SYSTEM = `You assess how well a candidate fits a job offer and choose, from the candidate's catalogue, what a CV tailored to that offer should show.

Answer with ONE JSON object and nothing else, of this shape:
${JSON.stringify(SHAPE, null, 1)}

Rules:
- Use only ids that appear in the catalogue. Never invent an experience, a bullet or a skill.
- language: "fr" if the offer is written in French, otherwise "en". Write headline, summary, rationale and notes in that language.
- requirements: one requirement per skill, technology, tool or quality the offer names (an offer listing five tools gives five requirements), every one the offer asks for. match "yes" when a catalogue skill covers it (list those skill ids); "adjacent" when a related catalogue skill is transferable (list them, explain in note); "no" otherwise, with skills [].
- When the catalogue lists Titles: headline_ids holds 1 or 2 title ids, the most fitting first, and summary_ids: exactly one hook id, the hook that fits the offer best, then at most one fact id; a note is context about the candidate, never on the CV. headline and summary are then not used. Otherwise:
- headline: at most 90 characters, only about what the candidate really has.
- summary: 2 to 4 short CV sentences about the candidate's real experience that matters for this offer. Never name a technology the catalogue does not list, even if the offer asks for it. Only numbers, companies and product names that appear in the catalogue; no link, email address or phone number; do not copy the offer's sentences.
- experiences: for each relevant experience, 2 to 5 bullet ids that belong to it, most relevant first.
- skill_groups: up to 6 groups, each with up to 6 of its own skill ids, most relevant to the offer first.
- requirements decide the fit score, which is computed from them: list every requirement, and be strict about "yes".
- fit.rationale: 2-3 honest sentences on the strengths and the gaps.
- A skill marked lab was practised in the candidate's personal R&D only: never present it as client or employer experience.
- Never claim anything listed under "Never claim", whatever the offer asks; classify it "no".
- Do not mirror the offer: no copied sentence, no client name or location, no vocabulary only the offer uses. Select and order; never rewrite the candidate's history. Tone: direct, operational, senior.

${UNTRUSTED}`;

/** 2.25b: one letter per level, stated once in the compact catalogue. */
const LEVELS = { expert: 'E', proficient: 'P', working: 'W', notions: 'N', lab: 'L' };

/**
 * 2.25b, off by default: the same skills in fewer tokens, grouped under their
 * group, one letter per level, terms the lexicon keys alike written once.
 */
function compactSkills(profile) {
  const lines = ['Skills by group (id — name / aliases [covers], level). Levels: E expert, P proficient, W working, N notions, L lab (personal R&D only)'];
  for (const group of profile.skill_groups) {
    lines.push(`Group ${group.id} (${group.title.en}):`);
    for (const skill of profile.skills.filter((s) => s.group === group.id)) {
      const seen = new Set();
      const terms = (skill.terms ?? []).filter((term) => !seen.has(key(term)) && seen.add(key(term)));
      const names = [skill.name, ...(skill.aliases ?? [])].join(' / ');
      lines.push(`- ${skill.id} — ${names}${terms.length ? ` [${terms.join(', ')}]` : ''}, ${LEVELS[skill.level] ?? skill.level}`);
    }
  }
  return lines;
}

/**
 * The prompt's opt-ins, off until a real replay shows no run loses a matched
 * requirement: ITSACV_PROMPT="compact,shortlist" (2.25b, 2.3b-ii).
 */
export function promptOptions(env = process.env) {
  // 2.25d: on by default since the 2.42b A/B (no row lost); "off" is the whole prompt.
  const given = String(env.ITSACV_PROMPT ?? '').trim();
  if (given === 'off') return { compact: false, shortlist: false };
  const asked = (given || 'compact,shortlist').split(',').map((word) => word.trim()).filter(Boolean);
  const unknown = asked.filter((word) => word !== 'compact' && word !== 'shortlist');
  if (unknown.length) throw new Error(`ITSACV_PROMPT: unknown ${unknown.join(', ')} (compact, shortlist, or off)`);
  return { compact: asked.includes('compact'), shortlist: asked.includes('shortlist') };
}

function skillLines(profile, compact) {
  const lines = [];
  if (compact) lines.push(...compactSkills(profile));
  else {
    lines.push('Skill groups (id — title):');
    for (const group of profile.skill_groups) lines.push(`- ${group.id} — ${group.title.en}`);
    lines.push('', 'Skills (id — name, level, group):');
    for (const skill of profile.skills) {
      const aliases = skill.aliases?.length ? ` (also: ${skill.aliases.join(', ')})` : '';
      const terms = skill.terms?.length ? ` [covers: ${skill.terms.join(', ')}]` : '';
      const level = skill.level === 'lab' ? 'lab (personal R&D only)' : skill.level;
      lines.push(`- ${skill.id} — ${skill.name}${aliases}${terms}, ${level}, ${skill.group}`);
    }
  }
  const never = (profile.never ?? []).flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]);
  if (never.length) lines.push('', `Never claim, the candidate has confirmed having no experience of: ${never.join(', ')}`);
  return lines;
}

function experienceLines(profile) {
  const lines = ['Experiences (id — title, organisation, dates; then bullet ids and texts):'];
  for (const experience of profile.experiences) {
    const dates = experience.end ? `${experience.start}–${experience.end}` : experience.start;
    const kind = { main: '', short: ' [short missions: only the ones this offer calls for]', rnd: ' [R&D projects: only the ones this offer calls for]' }[kindOf(experience)];
    lines.push(`- ${experience.id} — ${experience.title.en}, ${experience.org.en}, ${dates}${kind}`);
    for (const bullet of experience.bullets) lines.push(`    - ${bullet.id}: ${bullet.en}`);
  }
  if (profile.titles?.length) {
    lines.push('', 'Titles (id — text):');
    for (const title of profile.titles) lines.push(`- ${title.id} — ${title.en}`);
  }
  if (profile.profile_facts?.length) {
    lines.push('', 'Facts about the candidate (id (kind: hook, fact or note) — text):');
    for (const fact of profile.profile_facts) lines.push(`- ${fact.id} (${fact.kind}) — ${fact.en}`);
  }
  return lines;
}

function listedLines(profile, listed, offered) {
  if (!listed.length) return [];
  // 2.3b-ii: the candidates code finds for each requirement, offered first;
  // the model may still pick any other skill (not a lock, the owner 2026-10-06).
  const index = defaultIndex();
  const placed = offered ? skillConcepts(index, profile.skills) : null;
  const lines = [offered
    ? 'Requirements found in the offer (classify every one of them in "requirements", with its id in "listed"; "candidates" are skill ids the catalogue links to it, check them first, and use any other catalogue skill that covers it):'
    : 'Requirements found in the offer (classify every one of them in "requirements", with its id in "listed"):'];
  // 2.42: the id ties each answered row to its listed row, whatever its name.
  for (const [at, item] of listed.entries()) {
    const candidates = offered ? shortlist(profile, item.name, { index, placed }) : [];
    lines.push(`- L${at + 1}: ${item.name} (${item.importance})${candidates.length ? ` — candidates: ${candidates.join(', ')}` : ''}`);
  }
  lines.push('');
  return lines;
}

// Every prompt that carries the offer fences it (src/guard.js).
function offerLines(offer) {
  return ['', ...fence(offer), ''];
}

function languageLine(offer) {
  const language = detectLanguage(offer);
  return `The offer is in ${LANGUAGE_NAMES[language]}: set "language" to "${language}" and write the headline, summary, rationale and notes in ${LANGUAGE_NAMES[language]}.`;
}

export function buildPrompt(profile, offer, listed = [], { compact = false, shortlist: offered = false } = {}) {
  const lines = ['CATALOGUE', '', ...skillLines(profile, compact), '', ...experienceLines(profile), ...offerLines(offer), ...listedLines(profile, listed, offered), languageLine(offer)];
  return { system: SYSTEM, prompt: lines.join('\n') };
}

// 2.37: Groq's free tier allows 8 000 tokens a minute; the whole analysis
// takes about 9 500 (prompt and answer). Split, it is two calls of about
// half: the requirements against the skills (no bullet), then the CV's
// choices given those requirements (skill ids only, no skill text).
const REQUIREMENT_RULES = ['- requirements:', '- requirements decide', '- Never claim'];
const BOTH = '- A skill marked lab';
const RULES = SYSTEM.split('\n').filter((line) => line.startsWith('- '));
const ruled = (requirementOnes) => RULES.filter((line) => line.startsWith(BOTH) || REQUIREMENT_RULES.some((start) => line.startsWith(start)) === requirementOnes).join('\n');
const shapeOf = (keep) => JSON.stringify(Object.fromEntries(Object.entries(SHAPE).filter(([key]) => keep(key))), null, 1);
const ASKED = new Set(['language', 'requirements']);

export const REQUIREMENTS_SYSTEM = `You classify how a candidate's catalogue skills meet each requirement of a job offer.

Answer with ONE JSON object and nothing else, of this shape:
${shapeOf((key) => ASKED.has(key))}

Rules:
- Use only skill ids that appear in the catalogue. Never invent a skill.
- language: "fr" if the offer is written in French, otherwise "en". Write the notes in that language.
${ruled(true)}

${UNTRUSTED}`;

export const CHOICES_SYSTEM = `You choose, from the candidate's catalogue, what a CV tailored to a job offer should show. The offer's requirements are already classified: they are given, do not answer them.

Answer with ONE JSON object and nothing else, of this shape:
${shapeOf((key) => !ASKED.has(key))}

Rules:
${ruled(false)}

${UNTRUSTED}`;

/**
 * 2.37: `requirements`, the first call's prompt; `choices(classified)`, the
 * second's, given the requirements the first classified.
 */
export function buildSplitPrompts(profile, offer, listed = [], { shortlist: offered = false } = {}) {
  const requirements = {
    system: REQUIREMENTS_SYSTEM,
    prompt: ['CATALOGUE', '', ...skillLines(profile, true), ...offerLines(offer), ...listedLines(profile, listed, offered), languageLine(offer)].join('\n'),
  };
  const choices = (classified) => {
    const groups = profile.skill_groups.map((group) => `- ${group.id} (${group.title.en}): ${profile.skills.filter((skill) => skill.group === group.id).map((skill) => skill.id).join(', ')}`);
    const rows = (classified ?? []).map((row) => `- ${row.name}: ${row.match}${row.skills?.length ? ` (${row.skills.join(', ')})` : ''}`);
    return {
      system: CHOICES_SYSTEM,
      prompt: ['CATALOGUE', '', 'Skill ids by group:', ...groups, '', ...experienceLines(profile), ...offerLines(offer), 'Requirements, already classified (name: match (skill ids)):', ...rows, '', languageLine(offer)].join('\n'),
    };
  };
  return { requirements, choices };
}

/**
 * The analysis answer as a JSON schema (router 8.24) whose ids are closed to
 * the catalogue: an invented skill, bullet or title id cannot be written.
 * Sent only when asked (2.3): measured on the corpus first.
 */
export function analysisSchema(profile) {
  const string = { type: 'string' };
  const ids = (list) => ({ type: 'array', items: { type: 'string', enum: list } });
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const skills = profile.skills.map((skill) => skill.id);
  const properties = {
    language: { type: 'string', enum: ['fr', 'en'] },
    fit: object({ rationale: string }),
    requirements: {
      type: 'array',
      items: object({ listed: string, name: string, importance: { type: 'string', enum: ['must', 'nice'] }, match: { type: 'string', enum: ['yes', 'adjacent', 'no'] }, skills: ids(skills), note: string }, ['name', 'importance', 'match', 'skills', 'note']),
    },
    headline: string,
    summary: { type: 'array', items: string },
    experiences: { type: 'array', items: object({ id: { type: 'string', enum: profile.experiences.map((e) => e.id) }, bullets: ids(profile.experiences.flatMap((e) => e.bullets.map((b) => b.id))) }) },
    skill_groups: { type: 'array', items: object({ id: { type: 'string', enum: profile.skill_groups.map((g) => g.id) }, skills: ids(skills) }) },
  };
  if (profile.titles?.length) properties.headline_ids = ids(profile.titles.map((title) => title.id));
  if (profile.profile_facts?.length) properties.summary_ids = ids(profile.profile_facts.map((fact) => fact.id));
  return object(properties, ['language', 'fit', 'requirements', 'experiences', 'skill_groups']);
}

/** The prompt for a second attempt: the first one, the rejected answer, why. */
export function retryPrompt(prompt, answer, errors) {
  return [
    prompt,
    '',
    'Your previous answer was:',
    answer,
    '',
    'It was rejected because:',
    ...errors.map((error) => `- ${error}`),
    '',
    'Answer again with one corrected JSON object.',
  ].join('\n');
}

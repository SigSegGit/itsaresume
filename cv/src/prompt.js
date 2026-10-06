// What the model is asked. The profile goes in as a catalogue of ids so the
// answer can be checked mechanically (src/analysis.js).

import { detectLanguage, LANGUAGE_NAMES } from './language.js';
import { fence, UNTRUSTED } from './guard.js';
import { kindOf } from './profile.js';

const SHAPE = {
  language: 'fr | en',
  fit: { rationale: '2-3 sentences' },
  requirements: [{ name: 'Kubernetes', importance: 'must | nice', match: 'yes | adjacent | no', skills: ['skill-id'], note: '' }],
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

export function buildPrompt(profile, offer, listed = []) {
  const lines = ['CATALOGUE', '', 'Skill groups (id — title):'];
  for (const group of profile.skill_groups) lines.push(`- ${group.id} — ${group.title.en}`);
  lines.push('', 'Skills (id — name, level, group):');
  for (const skill of profile.skills) {
    const aliases = skill.aliases?.length ? ` (also: ${skill.aliases.join(', ')})` : '';
    const terms = skill.terms?.length ? ` [covers: ${skill.terms.join(', ')}]` : '';
    const level = skill.level === 'lab' ? 'lab (personal R&D only)' : skill.level;
    lines.push(`- ${skill.id} — ${skill.name}${aliases}${terms}, ${level}, ${skill.group}`);
  }
  const never = (profile.never ?? []).flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]);
  if (never.length) lines.push('', `Never claim, the candidate has confirmed having no experience of: ${never.join(', ')}`);
  lines.push('', 'Experiences (id — title, organisation, dates; then bullet ids and texts):');
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
  const language = detectLanguage(offer);
  lines.push('', ...fence(offer), '');
  if (listed.length) {
    lines.push('Requirements found in the offer (classify every one of them in "requirements"):');
    for (const item of listed) lines.push(`- ${item.name} (${item.importance})`);
    lines.push('');
  }
  lines.push(`The offer is in ${LANGUAGE_NAMES[language]}: set "language" to "${language}" and write the headline, summary, rationale and notes in ${LANGUAGE_NAMES[language]}.`);
  return { system: SYSTEM, prompt: lines.join('\n') };
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
      items: object({ name: string, importance: { type: 'string', enum: ['must', 'nice'] }, match: { type: 'string', enum: ['yes', 'adjacent', 'no'] }, skills: ids(skills), note: string }),
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

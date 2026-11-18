// The fit score, computed from the requirement table instead of taken from
// the model: a small model was seen scoring 97/100 with a must-have missing.
// The table itself is still the model's reading of the offer, and it is shown
// in full in the report so that reading can be checked.

import { mentions } from './text.js';

export const IMPORTANCE_WEIGHT = { must: 3, nice: 1 };
export const MATCH_VALUE = { yes: 1, adjacent: 0.5, no: 0 };
/** Profile v4, rule 6: a skill practised in personal R&D only is not client experience. */
export const LAB_VALUE = 0.5;
/** Profile v4, rule 9: the core of an offer is its must-haves; half of them missed is the core missed. */
export const CORE_MISSED = 0.5;
/** More than CORE_MISSED of the must-haves missed: the core is missed, the score stays low (corpus run 2026-11-15). */
export const CORE_MISSED_CAP = 30;

/** A title for a first job or a first support level (2.43): no fit for a senior profile. */
export const JUNIOR_TITLE = /(?<![\p{L}\p{N}])(?:junior|d[ée]butant(?:e|s|es)?|stagiaire|stage(?!\s+gate)|alternan(?:ce|t|te)|apprenti(?:e|ssage)?|niveau\s*1|N1|internship|intern|entry[- ]level|graduate)(?![\p{L}\p{N}])/iu;

/** A title that also asks for seniority is contradictory: the junior word does not cap it. */
export const SENIOR_TITLE = /(?<![\p{L}\p{N}])(?:lead|senior|s[ée]nior|confirm[ée]e?|exp[ée]riment[ée]e?|expert|principal|staff|head)(?![\p{L}\p{N}])/iu;

/** The offer's first non-empty line: its title. */
export const titleOf = (offer) => String(offer ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';

/**
 * Why the score is capped beyond the must-haves count (2.43, corpus run
 * 2026-11-17), or null: the technology the title leads with (the must
 * named first in it) missed, or a junior title for a senior profile.
 */
export function capOf(requirements, { offer, senior = false } = {}) {
  const title = titleOf(offer);
  if (!title) return null;
  if (senior && JUNIOR_TITLE.test(title) && !SENIOR_TITLE.test(title)) return 'level: a junior or first-level post for a senior profile';
  const lower = title.toLowerCase();
  const lead = scored(requirements)
    .filter((requirement) => requirement.importance === 'must' && mentions(title, String(requirement.name ?? '')))
    .map((requirement) => ({ requirement, at: lower.indexOf(String(requirement.name).toLowerCase()) }))
    .sort((a, b) => (a.at < 0 ? Infinity : a.at) - (b.at < 0 ? Infinity : b.at))[0]?.requirement;
  return lead?.match === 'no' ? `core: ${lead.name}, the technology the title leads with, is missed` : null;
}

/** Whether a met requirement rests on lab skills only. */
const labOnly = (requirement, lab) =>
  requirement.match !== 'no' && (requirement.skills ?? []).length > 0 && requirement.skills.every((id) => lab.has(id));

/**
 * Whether a requirement names something the candidate never claims. A row of
 * merged examples (normalize.js) is, only when every example is: one
 * never-claimed example among met ones is reported, not a gap of its own.
 */
export const isNever = (requirement, never = []) =>
  requirement.never === true ||
  (!requirement.members && never.some((entry) => [entry.name, ...(entry.aliases ?? [])].some((name) => mentions(String(requirement.name ?? ''), name))));

/** The requirements that count: a personal quality is for the interview (normalize.js says which). */
function scored(requirements) {
  return requirements.filter((requirement) => requirement.kind !== 'quality' && requirement.kind !== 'condition');
}

/** 0-100, or null when there is nothing to score. `lab`: ids of lab skills; `offer` and `senior`: see capOf. */
export function scoreOf(requirements, { lab = new Set(), offer, senior = false } = {}) {
  let total = 0;
  let met = 0;
  let musts = 0;
  let missed = 0;
  for (const requirement of scored(requirements)) {
    const weight = IMPORTANCE_WEIGHT[requirement.importance] ?? IMPORTANCE_WEIGHT.nice;
    const value = MATCH_VALUE[requirement.match] ?? 0;
    total += weight;
    met += weight * (labOnly(requirement, lab) ? Math.min(value, LAB_VALUE) : value);
    if (requirement.importance === 'must') {
      musts += 1;
      if (requirement.match === 'no') missed += 1;
    }
  }
  if (total === 0) return null;
  const score = Math.round((100 * met) / total);
  const capped = (musts > 0 && missed / musts > CORE_MISSED) || capOf(requirements, { offer, senior }) !== null;
  return capped ? Math.min(score, CORE_MISSED_CAP) : score;
}

/**
 * qualified: every must-have met by client experience; partial: some missed;
 * not-qualified: at least CORE_MISSED of them missed, never claimed or met in
 * the lab only. `gaps` names the must-haves at fault.
 */
export function qualification(all, { lab = new Set(), never = [] } = {}) {
  const requirements = scored(all);
  const musts = requirements.filter((requirement) => requirement.importance === 'must');
  const gaps = [];
  for (const requirement of musts) {
    if (isNever(requirement, never)) gaps.push(`${requirement.name} (never claimed)`);
    else if (requirement.match === 'no') gaps.push(requirement.name);
    else if (labOnly(requirement, lab)) gaps.push(`${requirement.name} (lab only)`);
    else if (requirement.judged === true) gaps.push(`${requirement.name} (to verify)`);
  }
  // 2.48: a row to verify is a doubt, not a lack: only the missing ones
  // (no, never claimed, lab only) make the CV not qualified.
  const missing = gaps.filter((gap) => !gap.endsWith(' (to verify)')).length;
  const level = gaps.length === 0 ? 'qualified' : missing / musts.length >= CORE_MISSED ? 'not-qualified' : 'partial';
  return { level, gaps };
}

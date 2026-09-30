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
const scored = (requirements) => requirements.filter((requirement) => requirement.kind !== 'quality');

/** 0-100, or null when there is nothing to score. `lab`: ids of lab skills. */
export function scoreOf(requirements, { lab = new Set() } = {}) {
  let total = 0;
  let met = 0;
  for (const requirement of scored(requirements)) {
    const weight = IMPORTANCE_WEIGHT[requirement.importance] ?? IMPORTANCE_WEIGHT.nice;
    const value = MATCH_VALUE[requirement.match] ?? 0;
    total += weight;
    met += weight * (labOnly(requirement, lab) ? Math.min(value, LAB_VALUE) : value);
  }
  return total === 0 ? null : Math.round((100 * met) / total);
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
  const level = gaps.length === 0 ? 'qualified' : gaps.length / musts.length >= CORE_MISSED ? 'not-qualified' : 'partial';
  return { level, gaps };
}

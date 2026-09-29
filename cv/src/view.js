// What the web page shows of a run: plain data, no markup. The page builds
// its DOM from it with textContent only, so nothing here is ever read as HTML.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const FILES = ['cv.pdf', 'cv.docx', 'report.md'];

/** The run's result as the page needs it. */
export function jobView(result, loaded) {
  const { analysis, layout, ats, skipped, older = [], repairs = [], backend, attempts, dir } = result;
  const skills = new Map(loaded.full.skills.map((skill) => [skill.id, skill]));
  const titles = new Map((loaded.full.sources ?? []).map((source) => [source.id, source.title]));
  const assessment = new Map((loaded.assessment ?? []).map((entry) => [entry.id, entry]));
  const used = [...new Set([
    ...analysis.skill_groups.flatMap((choice) => choice.skills),
    ...analysis.requirements.flatMap((requirement) => requirement.skills),
  ])];
  return {
    language: analysis.language,
    fit: {
      score: analysis.fit.score,
      verdict: analysis.fit.verdict,
      model_score: analysis.fit.model_score ?? null,
      qualification: analysis.fit.qualification ?? null,
      rationale: analysis.fit.rationale ?? '',
    },
    headline: analysis.headline,
    summary: analysis.summary,
    requirements: analysis.requirements.map((requirement) => ({
      name: requirement.name,
      importance: requirement.importance,
      match: requirement.match,
      kind: requirement.kind === 'quality' ? 'quality' : 'skill',
      judged: requirement.judged === true,
      never: requirement.never === true,
      note: requirement.note ?? '',
      skills: requirement.skills.map((id) => ({ name: skills.get(id)?.name ?? id, lab: skills.get(id)?.level === 'lab' })),
    })),
    verification: used.filter((id) => assessment.has(id)).map((id) => {
      const entry = assessment.get(id);
      return {
        name: entry.name,
        level: entry.level,
        verdict: entry.verdict,
        sources: entry.evidence.map((e) => ({ title: titles.get(e.source) ?? e.source, grade: e.grade, stance: e.stance ?? 'for', quote: e.quote ?? '' })),
      };
    }),
    flags: used.flatMap((id) => assessment.get(id)?.flags ?? []),
    older,
    repairs,
    backend,
    attempts,
    layout: layout ?? null,
    ats: ats ?? null,
    skipped: skipped ?? null,
    files: FILES.filter((name) => existsSync(join(dir, name))),
  };
}

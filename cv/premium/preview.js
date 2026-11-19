// 6.4: the free preview. The server keeps the tailored text (headline,
// summary, chosen bullets, skills picked); the visitor gets the verdict, the
// requirements met or not, and the CV's shape as line lengths, so the page
// can draw a blurred skeleton. Nothing to un-blur in the browser.

export function redact(page, analysis) {
  return {
    score: analysis.fit?.score ?? null,
    verdict: analysis.fit?.verdict ?? '',
    requirements: (analysis.requirements ?? []).map((requirement) => ({ name: requirement.name, match: requirement.match })),
    summary_lines: (page.profile ?? []).map((text) => text.length),
    skill_groups: (page.skill_groups ?? []).length,
    experiences: (page.experiences ?? []).map((experience) => ({
      title: experience.title,
      org: experience.org,
      dates: experience.dates,
      lines: (experience.items ?? []).map((item) => item.text.length),
    })),
  };
}

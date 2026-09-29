// The fit report: what Nicolas reads before deciding to send the CV.
//
// Much of it is the model's text. A line break or a pipe in it must not start
// a heading or a column of its own, so every piece is flattened to one line,
// and table cells escape their pipes.

/** The model's text on one line. */
const line = (text) => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
/** The model's text in a table cell. */
const cell = (text) => line(text).replace(/\|/g, '\\|');

/** "1 page, content down to 97% of it", from a fractional page count. */
function describeLayout(layout) {
  if (!layout) return 'not measured (no layout engine on this machine, or --no-layout)';
  const pages = Math.max(1, Math.ceil(layout.pages - 1e-6));
  const fill = Math.round((layout.pages - (pages - 1)) * 100);
  return `${pages} page${pages > 1 ? 's' : ''}, content down to ${fill}% of ${pages > 1 ? 'the last one' : 'it'}` +
    (layout.layouts ? ` (${layout.layouts} layouts measured)` : '');
}

function describeAts(ats) {
  if (!ats) return ['**ATS check:** not checked (no PDF on this machine, or --no-layout)'];
  if (ats.problems.length === 0) {
    return [`**ATS check:** all ${ats.checked} pieces of the CV found in the PDF text, in reading order`];
  }
  return [`**ATS check:** ${ats.problems.length} problem(s)`, '', ...ats.problems.map((problem) => `- ${problem}`)];
}

/** One line per skill the CV shows or matches: its verdict and the sources behind it. */
function describeVerification(analysis, profile, assessment, removed) {
  const titles = new Map((profile.sources ?? []).map((source) => [source.id, source.title ?? source.id]));
  const byId = new Map(assessment.map((entry) => [entry.id, entry]));
  const used = new Set([
    ...analysis.skill_groups.flatMap((choice) => choice.skills),
    ...analysis.requirements.flatMap((requirement) => requirement.skills),
  ]);
  const lines = ['', '## Verification', '', 'What backs each skill this CV shows or matches (A artefact or third-party document, B candid self-assessment, C CV claim).', ''];
  for (const id of used) {
    const entry = byId.get(id);
    if (!entry) continue;
    const sources = entry.evidence
      .map((e) => `${titles.get(e.source) ?? e.source} (${e.grade})${e.stance === 'against' ? ' against' : ''}${e.quote ? `: "${e.quote}"` : ''}`)
      .join(', ');
    lines.push(`- **${entry.name}** (${entry.level}): ${entry.verdict} — ${sources || 'no source'}`);
  }
  const flags = assessment.filter((entry) => used.has(entry.id)).flatMap((entry) => entry.flags);
  if (flags.length) lines.push('', '**To confirm before sending:**', '', ...flags.map((flag) => `- ${flag}`));
  if (removed.length) lines.push('', '**Left out of the profile by the evidence:**', '', ...removed.map((item) => `- ${item}`));
  return lines;
}

const QUALIFICATION = { qualified: 'qualified', partial: 'partially qualified', 'not-qualified': 'not qualified' };

/** Profile v4, rule 9: whether the offer's core is covered, and by what it is not. */
function describeQualification(fit) {
  const q = fit.qualification;
  if (!q) return [];
  return ['', `**Qualification:** ${QUALIFICATION[q.level]}${q.gaps.length ? ` — must-haves not covered by client experience: ${q.gaps.map(line).join(', ')}` : ''}`];
}

export function report(analysis, profile, { backend, attempts, repairs = [], layout, ats, skipped, assessment, removed = [], older = [] }) {
  const skills = new Map(profile.skills.map((skill) => [skill.id, skill]));
  const experiences = new Map(profile.experiences.map((experience) => [experience.id, experience]));
  const lang = analysis.language;
  const lines = [
    `# Fit: ${analysis.fit.score} / 100 — ${analysis.fit.verdict}`,
    '',
    'Computed from the requirement table below (must ×3, nice ×1; yes 1, adjacent ½, no 0; met by lab skills only ½).',
    ...describeQualification(analysis.fit),
    '',
    `**The model's own comment (unchecked):** ${line(analysis.fit.rationale ?? '—')}` +
      (Number.isInteger(analysis.fit.model_score) ? ` It scored ${analysis.fit.model_score}/100 itself.` : ''),
    '',
    `**Headline:** ${line(analysis.headline)}`,
    '',
    '## Requirements',
    '',
    '| Requirement | Importance | Match | From the profile | Note |',
    '|---|---|---|---|---|',
  ];
  const scored = analysis.requirements.filter((requirement) => requirement.kind !== 'quality');
  const qualities = analysis.requirements.filter((requirement) => requirement.kind === 'quality');
  for (const requirement of scored) {
    const evidence = requirement.skills
      .map((id) => skills.get(id))
      .filter(Boolean)
      .map((skill) => `${skill.name} (${skill.level === 'lab' ? 'lab only' : skill.level})`)
      .join(', ');
    lines.push(`| ${cell(requirement.name)} | ${cell(requirement.importance)} | ${cell(requirement.match)} | ${cell(evidence || '—')} | ${cell(requirement.note)} |`);
  }
  const gaps = scored.filter((requirement) => requirement.match === 'no');
  // A never-claimed example of a met enumeration is not a gap of the score,
  // but it is one: said so.
  const unclaimed = scored.filter((requirement) => requirement.match !== 'no').flatMap((requirement) => (requirement.never_members ?? [])
    .map((name) => `- ${line(name)} (never claimed; the offer gives it as an example of ${line(requirement.name)}, met otherwise)`));
  if (gaps.length || unclaimed.length) {
    lines.push('', '## Gaps', '', ...gaps.map((gap) => `- ${line(gap.name)} (${line(gap.importance)})`), ...unclaimed);
  }
  if (qualities.length) {
    lines.push('', '## Personal qualities — not scored, to show in interview', '',
      'The offer asks for these; no skill of the profile can back them, so they count neither in the score nor in the qualification.', '',
      ...qualities.map((quality) => `- ${line(quality.name)} (${line(quality.importance)})`));
  }
  lines.push('', '## Summary on the CV', '', ...analysis.summary.map((sentence) => `> ${line(sentence)}`));
  lines.push('', '## Experiences put forward', '');
  for (const choice of analysis.experiences) {
    const experience = experiences.get(choice.id);
    lines.push(`- **${experience.title[lang]}** — ${experience.org[lang]}: ${choice.bullets.length} bullet(s)`);
  }
  if (older.length) {
    lines.push('', '**Named in older CVs, absent from the profile (confirm, then add it to the profile if true):**', '');
    lines.push(...older.map((item) => `- ${line(item.requirement)} — ${item.sources.map(line).join(', ')}`));
  }
  if (assessment) lines.push(...describeVerification(analysis, profile, assessment, removed));
  lines.push('', '## Layout and ATS', '', `**Layout:** ${describeLayout(layout)}`, '', ...describeAts(ats));
  if (skipped) lines.push('', `**Not done:** ${line(skipped.reason)}`);
  if (repairs.length) {
    lines.push('', '## Repairs made to the model\'s answer', '', ...repairs.map((repair) => `- ${line(repair)}`));
  }
  lines.push('', `---`, `Answered by ${backend} in ${attempts} attempt(s).`);
  return lines.join('\n') + '\n';
}

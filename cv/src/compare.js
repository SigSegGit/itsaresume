// A comparative run (the owner, 2026-10-24): the same offer read by each
// backend, its requirements lined up so a disagreement, and the code's
// reason for each demotion to adjacent ("proche"), show at a glance.

const PREFIX = /^requirement (.+?): (.*)$/;

/**
 * `runs`: backend → `{ requirements, repairs }` or `{ error }`. Rows are keyed
 * by the requirement's lower-cased name; `why` keeps, per backend, the
 * repairs that touched that requirement.
 */
export function compareVerdicts(runs) {
  const rows = new Map();
  const failed = {};
  for (const [backend, run] of Object.entries(runs)) {
    if (run.error) {
      failed[backend] = run.error;
      continue;
    }
    for (const requirement of run.requirements ?? []) {
      const name = requirement.name.trim().toLowerCase();
      const row = rows.get(name) ?? { name, verdicts: {}, why: {} };
      row.verdicts[backend] = requirement.match;
      rows.set(name, row);
    }
    for (const repair of run.repairs ?? []) {
      const found = PREFIX.exec(repair);
      const row = found && rows.get(found[1].trim().toLowerCase());
      if (row) (row.why[backend] ??= []).push(found[2]);
    }
  }
  const list = [...rows.values()].map((row) => ({ ...row, agree: new Set(Object.values(row.verdicts)).size === 1 && Object.keys(row.verdicts).length === Object.keys(runs).length - Object.keys(failed).length }));
  return { rows: list, failed };
}

const SPREAD = 15;
// 2.33: a repair counts when it changes the model's verdict, which the
// repair says with "(was …)"; the rest is the code's ordinary work.
const MANY_CHANGES = 3;
const CHANGED = / \(was (?:yes|adjacent|no)\)$/;
const KINDS = [
  [/no profile skill names it/, 'aucune compétence du profil ne la nomme'],
  [/never claimed in the profile/, 'jamais revendiquée'],
  [/named like the profile skill/, 'nommée comme une compétence du profil'],
  [/each part named like a profile skill/, 'chaque partie nommée dans le profil'],
  [/ruled it near/, 'règle « proche » du profil'],
  [/without a profile skill/, 'sans compétence du profil'],
  [/: a language, /, 'langue lue dans le profil'],
  [/: a certification, /, 'certification lue dans le profil'],
];
const kindOf = (repair) => KINDS.find(([pattern]) => pattern.test(repair))?.[1] ?? 'autre';
const changedVerdicts = (repairs) => (repairs ?? []).filter((repair) => CHANGED.test(repair));
function mostly(changes) {
  const counts = new Map();
  for (const repair of changes) counts.set(kindOf(repair), (counts.get(kindOf(repair)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([kind, count]) => `${kind} (${count})`).join(', ');
}
const tokensOf = (tokens) => (tokens ? Object.values(tokens).reduce((sum, used) => sum + (used.input ?? 0) + (used.output ?? 0), 0) : null);

/**
 * 2.31b: `entries`, one per model, as the QA log keeps them. One line per
 * model, the requirements (disagreements first), and what is worth a look,
 * found by code. A lead names no error text: it is safe to show.
 */
export function compareRuns(entries) {
  const models = entries.map((entry) => ({
    model: entry.model,
    status: entry.status,
    error: entry.error ?? null,
    elapsed_ms: entry.elapsed_ms ?? null,
    tokens: tokensOf(entry.tokens),
    score: entry.fit?.score ?? null,
    verdict: entry.fit?.verdict ?? null,
    qualification: entry.fit?.qualification?.level ?? null,
    attempts: entry.attempts ?? null,
    repairs: entry.repairs?.length ?? null,
    verdicts_changed: entry.repairs ? changedVerdicts(entry.repairs).length : null,
    pages: entry.pages ?? null,
    dir: entry.dir ?? null,
  }));
  const { rows, failed } = compareVerdicts(Object.fromEntries(entries.map((entry) => [entry.model,
    entry.status === 'done' ? { requirements: entry.analysis?.requirements, repairs: entry.repairs } : { error: entry.error ?? 'failed' }])));
  rows.sort((a, b) => Number(a.agree) - Number(b.agree));
  const leads = [];
  for (const [index, model] of models.entries()) {
    if (model.status !== 'done') leads.push({ kind: 'failed', text: `${model.model} a échoué : à corriger avant de le comparer.` });
    if (model.attempts > 1) leads.push({ kind: 'attempts', text: `${model.model} a demandé ${model.attempts} tentatives : ses réponses sont refusées par les contrôles.` });
    if (model.verdicts_changed >= MANY_CHANGES) leads.push({ kind: 'repairs', text: `${model.model} : le code a changé ${model.verdicts_changed} de ses verdicts, surtout : ${mostly(changedVerdicts(entries[index].repairs))}.` });
  }
  const scored = models.filter((model) => model.score !== null);
  if (scored.length > 1) {
    const scores = scored.map((model) => model.score);
    const spread = Math.max(...scores) - Math.min(...scores);
    if (spread > SPREAD) leads.push({ kind: 'spread', text: `Écart de ${spread} points entre les scores (${scored.map((model) => `${model.model} ${model.score}`).join(', ')}).` });
  }
  const differ = rows.filter((row) => !row.agree);
  if (differ.length) leads.push({ kind: 'disagree', text: `${differ.length} exigence(s) sur ${rows.length} lues différemment, dont : ${differ.slice(0, 5).map((row) => row.name).join(', ')}.` });
  return { models, rows, failed, leads };
}

/** What a public page may read: no error text, no path, no reason. */
export function publicComparison(report) {
  return {
    models: report.models.map(({ dir, ...model }) => ({ ...model, error: model.error ? 'échec' : null })),
    rows: report.rows.map((row) => ({ ...row, why: {} })),
    failed: Object.fromEntries(Object.keys(report.failed).map((model) => [model, 'échec'])),
    leads: report.leads,
  };
}

const cell = (value) => (value === null || value === undefined ? '–' : String(value).replace(/\s*[\r\n]+\s*/g, ' ').replaceAll('|', '\\|'));
const line = (cells) => `| ${cells.map(cell).join(' | ')} |`;

export function compareMarkdown(title, report) {
  const out = [`# Comparaison : ${cell(title)}`, ''];
  if (report.leads.length) out.push('## À regarder', '', ...report.leads.map((lead) => `- ${cell(lead.text)}`), '');
  out.push('## Par modèle', '', '| Modèle | Statut | Score | Verdict | Qualification | Durée (s) | Tokens | Tentatives | Réparations | Verdicts changés | Pages |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of report.models) out.push(line([m.model, m.status, m.score, m.verdict, m.qualification, m.elapsed_ms === null ? null : Math.round(m.elapsed_ms / 1000), m.tokens, m.attempts, m.repairs, m.verdicts_changed, m.pages]));
  const errors = report.models.filter((m) => m.error);
  if (errors.length) out.push('', '## Erreurs', '', ...errors.map((m) => `- **${m.model}** : ${cell(m.error)}`));
  const names = report.models.filter((m) => m.status === 'done').map((m) => m.model);
  if (report.rows.length) {
    out.push('', '## Exigences (désaccords d’abord)', '', `| Exigence | ${names.join(' | ')} |`, `|---|${names.map(() => '---').join('|')}|`);
    for (const row of report.rows) out.push(line([`${row.agree ? '' : 'DIFF '}${row.name}`, ...names.map((name) => row.verdicts[name])]));
    const why = report.rows.filter((row) => Object.keys(row.why).length);
    if (why.length) {
      out.push('', '## Pourquoi le code a corrigé', '');
      for (const row of why) out.push(`- **${cell(row.name)}** : ${Object.entries(row.why).map(([model, reasons]) => `${model} : ${reasons.map(cell).join(' ; ')}`).join(' / ')}`);
    }
  }
  return `${out.join('\n')}\n`;
}

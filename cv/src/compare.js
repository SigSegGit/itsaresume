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

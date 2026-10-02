// Manual QA: which model answers a run, and a private log of every run.
//
// The page offers three models: auto (the router's order, Claude then the
// local AI), Claude alone, the local AI alone. The router tries a named
// backend alone. The log is JSON lines in the output directory, the owner's,
// never in the repository: offers, choices, steps and outcome, to compare
// durations and outputs by model afterwards.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const MODELS = ['auto', 'claude', 'local'];
export const QA_LOG = 'qa-log.jsonl';

const BACKENDS = { auto: undefined, claude: 'claude-code', local: 'lm-studio' };

/** The router backend name for a model the page offers; undefined lets the router choose. */
export function backendFor(model) {
  if (!MODELS.includes(model)) throw new Error(`unknown model: ${model}`);
  return BACKENDS[model];
}

/** One run, one line, appended. */
export function appendQaLog(out, entry) {
  appendFileSync(join(out, QA_LOG), `${JSON.stringify(entry)}\n`);
}

/** The generator's llm, every call of a run sent to the chosen backend. */
export function withModel(llm, model) {
  const backend = backendFor(model);
  return (call) => llm({ ...call, backend });
}

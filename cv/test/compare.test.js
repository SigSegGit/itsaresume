import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVerdicts } from '../src/compare.js';

test('compare: one row per requirement across backends, disagreements and demotion reasons kept', () => {
  const runs = {
    claude: { requirements: [{ name: 'Supervision', match: 'yes' }, { name: 'Astreinte', match: 'adjacent' }], repairs: ["requirement Astreinte: no profile skill names it, the model's reading only: adjacent, to verify"] },
    local: { requirements: [{ name: 'supervision', match: 'adjacent' }, { name: 'Astreinte', match: 'adjacent' }], repairs: [] },
    gemini: { error: 'overloaded' },
  };
  const { rows, failed } = compareVerdicts(runs);
  assert.deepEqual(failed, { gemini: 'overloaded' });
  const supervision = rows.find((row) => row.name === 'supervision');
  assert.deepEqual(supervision.verdicts, { claude: 'yes', local: 'adjacent' });
  assert.equal(supervision.agree, false);
  const astreinte = rows.find((row) => row.name === 'astreinte');
  assert.equal(astreinte.agree, true);
  assert.deepEqual(astreinte.why, { claude: ["no profile skill names it, the model's reading only: adjacent, to verify"] });
});

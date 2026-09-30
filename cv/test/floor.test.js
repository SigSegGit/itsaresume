// 2.1e: a deterministic floor under the listing call. On the corpus the
// local model dropped a whole "Nice to have:" list in both runs (2.1c): the
// items the offer lists under a header that says must or nice are
// requirements whatever the model lists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { floorItems, listRequirements } from '../src/listing.js';

const startup = JSON.parse(readFileSync(new URL('../corpus/en-platform-startup.json', import.meta.url), 'utf8')).offer;
const answering = (requirements) => async () => ({ text: JSON.stringify({ requirements }) });

test('the items under a nice header are floor items, nice', () => {
  const items = floorItems(startup);
  for (const name of ['Rust', 'Datadog', 'Experience with SOC 2 audits']) {
    assert.deepEqual(items.find((item) => item.name === name), { name, importance: 'nice' }, name);
  }
});

test('the items under a must header are floor items, must', () => {
  assert.deepEqual(
    floorItems(startup).filter((item) => item.importance === 'must').map((item) => item.name),
    ['Kubernetes', 'Terraform', 'Strong Go or Python'],
  );
});

test("a header's own enumeration is floor items", () => {
  assert.deepEqual(floorItems('Atouts : Airflow, dbt.'), [
    { name: 'Airflow', importance: 'nice' },
    { name: 'dbt', importance: 'nice' },
  ]);
});

test('a header without a cue, or a denied one, adds nothing', () => {
  assert.deepEqual(floorItems('Missions :\n- Kubernetes\n- Terraform\n'), []);
  assert.deepEqual(floorItems('Not required:\n- Kubernetes\n'), []);
});

test('a list ends at a blank line or the next header', () => {
  assert.deepEqual(floorItems('Nice to have:\n- Rust\n\n- Kafka\n'), [{ name: 'Rust', importance: 'nice' }]);
  assert.deepEqual(floorItems('Nice to have:\n- Rust\nMissions:\n- Kafka\n'), [{ name: 'Rust', importance: 'nice' }]);
});

test('the listing gets back what the model dropped, and nothing twice', async () => {
  const listed = await listRequirements({ offer: startup, llm: answering([{ name: 'Kubernetes', importance: 'must' }, { name: 'Go', importance: 'must' }]) });
  const names = listed.map((item) => item.name);
  assert.ok(names.includes('Rust') && names.includes('Datadog') && names.includes('Terraform'), names.join(', '));
  assert.equal(names.filter((name) => /Kubernetes/.test(name)).length, 1, names.join(', '));
  assert.ok(!names.includes('Strong Go or Python'), 'a floor item naming a listed name is already there');
});

test('an unreadable listing still keeps the floor', async () => {
  const listed = await listRequirements({ offer: startup, llm: async () => ({ text: 'no json' }) });
  assert.ok(listed.some((item) => item.name === 'Rust'));
});

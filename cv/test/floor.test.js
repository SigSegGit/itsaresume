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
  assert.deepEqual(floorItems('Stack : Kubernetes, Terraform'), []);
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

// 2.1f: a name the offer only denies leaves the listing (both models listed
// "Kubernetes is not required for this role" on the corpus).
const corpusOffer = (id) => JSON.parse(readFileSync(new URL(`../corpus/${id}.json`, import.meta.url), 'utf8')).offer;

test('a name the offer only denies leaves the listing', async () => {
  for (const [id, name] of [['en-cloud-architect', 'Kubernetes'], ['fr-ingenieur-data-platform', 'Flink']]) {
    const listed = await listRequirements({ offer: corpusOffer(id), llm: answering([{ name, importance: 'must' }, { name: 'Python', importance: 'must' }]) });
    assert.ok(!listed.some((item) => item.name === name), `${id}: ${name} kept`);
  }
});

test('a denied must that the offer still wants stays, and so does a plain mention', async () => {
  const esn = await listRequirements({ offer: corpusOffer('fr-devops-esn'), llm: answering([{ name: 'Ansible', importance: 'nice' }]) });
  assert.ok(esn.some((item) => item.name === 'Ansible'), "\"n'est pas obligatoire mais sera appréciée\" is still wanted");
  const plain = await listRequirements({ offer: 'Vous déployez sur Kubernetes. Terraform is not required.', llm: answering([{ name: 'Kubernetes', importance: 'must' }, { name: 'Terraform', importance: 'must' }]) });
  assert.deepEqual(plain.map((item) => item.name), ['Kubernetes']);
});

// 8.25: the listing asks for structured output (router 8.24), so no answer
// is lost to a JSON document wrapped in prose.
// Measured on the corpus (2026-09-30, three runs each): with the schema the
// local model lists less (61-66/75 against 68-70/75 without); Sonnet is at
// 75/75 either way. So the schema is sent only when asked.
test('the listing call sends its schema only when asked', async () => {
  const requests = [];
  const llm = async (request) => (requests.push(request), { text: '{"requirements": []}' });
  await listRequirements({ offer: 'Kafka.', llm });
  await listRequirements({ offer: 'Kafka.', llm, structured: true });
  assert.equal(requests[0].schema, undefined);
  assert.equal(requests[1].schema?.properties?.requirements?.type, 'array');
  assert.deepEqual(requests[1].schema.properties.requirements.items.properties.importance.enum, ['must', 'nice']);
});

// 2.10, seen on a real run: the listing's "Customer meetings" was added as
// an unmet must beside the analysed "Customer-facing meetings".
test('a listed name whose words the analysis already names is not added twice', async () => {
  const { mergeListed } = await import('../src/listing.js');
  const analysis = { requirements: [{ name: 'Customer-facing meetings', importance: 'must', match: 'no', skills: [], note: '' }] };
  const { analysis: merged } = mergeListed(analysis, [
    { name: 'Customer meetings', importance: 'must' },
    { name: 'Customer support', importance: 'must' },
  ]);
  assert.deepEqual(merged.requirements.map((row) => row.name), ['Customer-facing meetings', 'Customer support']);
});

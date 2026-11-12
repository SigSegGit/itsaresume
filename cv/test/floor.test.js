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

// Red team: the denial of one clause must not remove a name of another.
test('a denial judges the clause that names the requirement, not the sentence', async () => {
  const offer = "Terraform est obligatoire, Kubernetes n'est pas requis.";
  const listed = await listRequirements({ offer, llm: answering([{ name: 'Terraform', importance: 'must' }, { name: 'Kubernetes', importance: 'must' }]) });
  assert.deepEqual(listed.map((item) => item.name), ['Terraform']);
});

// Red team: a short listed name is not absorbed by a longer, different row.
test('a listed must is not absorbed by a longer row (SQL beside SQL Server, DevOps beside Azure DevOps)', async () => {
  const { mergeListed } = await import('../src/listing.js');
  const analysis = { requirements: [{ name: 'SQL Server', importance: 'nice', match: 'no', skills: [], note: '' }, { name: 'Azure DevOps', importance: 'must', match: 'no', skills: [], note: '' }] };
  const { analysis: merged } = mergeListed(analysis, [{ name: 'SQL', importance: 'must' }, { name: 'DevOps', importance: 'must' }]);
  assert.deepEqual(merged.requirements.map((row) => row.name), ['SQL Server', 'Azure DevOps', 'SQL', 'DevOps']);
});

test('a two-word listed must is not absorbed by a nice row that names its words', async () => {
  const { mergeListed } = await import('../src/listing.js');
  const analysis = { requirements: [{ name: 'Customer-facing meetings', importance: 'nice', match: 'no', skills: [], note: '' }] };
  const { analysis: merged } = mergeListed(analysis, [{ name: 'Customer meetings', importance: 'must' }]);
  assert.deepEqual(merged.requirements.map((row) => row.name), ['Customer-facing meetings', 'Customer meetings']);
});

// Seen 2026-10-02: the listing named "HA", the analysis "HA (haute
// disponibilité réseau)"; "HA" came back as an unmet must, a second time.
test('a listed name that heads an analysed row before its parenthesis is that row', async () => {
  const { mergeListed } = await import('../src/listing.js');
  const analysis = { requirements: [{ name: 'HA (haute disponibilité réseau)', importance: 'must', match: 'adjacent', skills: [], note: '' }] };
  const { analysis: merged } = mergeListed(analysis, [{ name: 'HA', importance: 'must' }, { name: 'BGP', importance: 'must' }]);
  assert.deepEqual(merged.requirements.map((row) => row.name), ['HA (haute disponibilité réseau)', 'BGP']);
});

// 2.41 (seen in 2.25c): the listing named the rows in English, the analysis
// answered them in French; each listed row came back as an unmet must.
test('a listed row the analysis answered translated is not added back (same lexicon concept)', async () => {
  const { mergeListed } = await import('../src/listing.js');
  const row = (name) => ({ name, importance: 'must', match: 'yes', skills: [], note: '' });
  const analysis = { requirements: [row('Apprentissage automatique'), row('Observabilité')] };
  const { analysis: merged, repairs } = mergeListed(analysis, [
    { name: 'Machine learning', importance: 'must' },
    { name: 'Observability', importance: 'must' },
    { name: 'Kubernetes', importance: 'must' },
  ]);
  assert.deepEqual(merged.requirements.map((r) => r.name), ['Apprentissage automatique', 'Observabilité', 'Kubernetes']);
  assert.equal(repairs.length, 1);
});

test('a translated row covers a listed must only when it is a must too', async () => {
  const { mergeListed } = await import('../src/listing.js');
  const analysis = { requirements: [{ name: 'Apprentissage automatique', importance: 'nice', match: 'yes', skills: [], note: '' }] };
  const { analysis: merged } = mergeListed(analysis, [{ name: 'Machine learning', importance: 'must' }]);
  assert.deepEqual(merged.requirements.map((r) => r.name), ['Apprentissage automatique', 'Machine learning']);
});

// 2.42: the listed rows are numbered in the prompt and the analysis answers
// each by its id, so a translated name never re-adds its row (2.25c).
test('rows answered by their listed id take the listing\'s name, verdict kept, nothing added', async () => {
  const { mergeListed } = await import('../src/listing.js');
  const row = (name, listed, match = 'yes') => ({ name, importance: 'must', match, skills: [], note: '', listed });
  const analysis = { requirements: [row('Rigueur', 'L1'), row('Écoute active', 'L2', 'adjacent'), row('Python', undefined)] };
  const listed = [{ name: 'Rigor', importance: 'must' }, { name: 'Active listening', importance: 'must' }];
  const { analysis: merged, repairs } = mergeListed(analysis, listed);
  assert.deepEqual(merged.requirements.map((r) => [r.name, r.match]), [['Rigor', 'yes'], ['Active listening', 'adjacent'], ['Python', 'yes']]);
  assert.ok(merged.requirements.every((r) => !('listed' in r)), 'the id does not leave mergeListed');
  assert.ok(repairs.some((repair) => /answered as Rigueur/.test(repair)), repairs.join('\n'));
});

test('an unknown or repeated listed id is not trusted', async () => {
  const { mergeListed } = await import('../src/listing.js');
  const row = (name, listed) => ({ name, importance: 'must', match: 'yes', skills: [], note: '', listed });
  const listed = [{ name: 'Rigor', importance: 'must' }, { name: 'Active listening', importance: 'must' }];
  const { analysis: merged, repairs } = mergeListed({ requirements: [row('Rigueur', 'L1'), row('Kubernetes', 'L1'), row('Docker', 'L9')] }, listed);
  assert.deepEqual(merged.requirements.map((r) => r.name), ['Rigueur', 'Kubernetes', 'Docker', 'Rigor', 'Active listening']);
  assert.ok(repairs.some((repair) => /L1 .*twice/.test(repair)), repairs.join('\n'));
  assert.ok(repairs.some((repair) => /L9 .*unknown/.test(repair)), repairs.join('\n'));
});

test('the prompt numbers the listed rows and asks for their id', async () => {
  const { buildPrompt, SYSTEM } = await import('../src/prompt.js');
  const { v4 } = await import('./fixtures/v4.js');
  const { prompt } = buildPrompt(v4(), 'An offer', [{ name: 'Rigor', importance: 'must' }, { name: 'Kubernetes', importance: 'nice' }]);
  assert.match(prompt, /^- L1: Rigor \(must\)$/m);
  assert.match(prompt, /^- L2: Kubernetes \(nice\)$/m);
  assert.match(SYSTEM, /"listed"/);
});

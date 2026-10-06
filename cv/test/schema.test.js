// 2.3: the analysis call can ask for structured output whose ids are closed
// to the catalogue (router 8.24), so an invented skill or bullet id cannot
// even be written. Not sent by default: measured first on the corpus
// (scripts/measure-analysis.mjs), as the listing's schema cost recall.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analysisSchema } from '../src/prompt.js';
import { analyse } from '../src/pipeline.js';

const profile = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));

test('the analysis schema closes every id to the catalogue', () => {
  const p = profile();
  const schema = analysisSchema(p);
  const requirement = schema.properties.requirements.items;
  assert.deepEqual(requirement.properties.skills.items.enum, p.skills.map((s) => s.id));
  assert.deepEqual(requirement.properties.match.enum, ['yes', 'adjacent', 'no']);
  assert.deepEqual(requirement.properties.importance.enum, ['must', 'nice']);
  assert.deepEqual(schema.properties.language.enum, ['fr', 'en']);
  const experience = schema.properties.experiences.items.properties;
  assert.deepEqual(experience.id.enum, p.experiences.map((e) => e.id));
  assert.deepEqual(experience.bullets.items.enum, p.experiences.flatMap((e) => e.bullets.map((b) => b.id)));
  const group = schema.properties.skill_groups.items.properties;
  assert.deepEqual(group.id.enum, p.skill_groups.map((g) => g.id));
  assert.deepEqual(group.skills.items.enum, p.skills.map((s) => s.id));
  assert.deepEqual(schema.properties.summary_ids.items.enum, p.profile_facts.map((f) => f.id));
  assert.equal(schema.properties.headline_ids, undefined, 'no titles in the catalogue, no headline ids');
  assert.ok(schema.required.includes('requirements'));
});

test('the analysis call sends its schema only when asked, never the listing', async () => {
  const run = async (structured) => {
    const requests = [];
    const llm = async (request) => (requests.push(request), { text: '{"requirements": []}' });
    await analyse({ profile: profile(), offer: 'Kafka.', llm, structured }).catch(() => {});
    return requests;
  };
  const plain = await run(undefined);
  assert.ok(plain.length >= 2 && plain.every((r) => r.schema === undefined));
  const asked = await run(true);
  assert.equal(asked[0].schema, undefined, 'the listing keeps its own default');
  assert.ok(asked.length >= 3, 'listing, then two analysis attempts');
  for (const request of asked.slice(1)) assert.deepEqual(request.schema, analysisSchema(profile()));
});

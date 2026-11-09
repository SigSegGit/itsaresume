// 2.32 (the owner, 2026-11-09): one offer scored 58 with the local model and 77
// with Gemini, because each listed its own rows (12 against 35) and the score
// is met/total over them. The list of what an offer asks for must not depend
// on the model chosen to judge it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../src/pipeline.js';
import { LISTING_SYSTEM } from '../src/listing.js';

const OFFER = 'Ingénieur DevOps\nVous déployez sur Kubernetes.';
const listing = (name) => ({ text: JSON.stringify({ requirements: [{ name, importance: 'must' }] }), backend: 'x' });
// The analysis is out of scope: every run stops right after the listing.
const STOP = new Error('stop after the listing');
const judge = (calls) => async (request) => {
  calls.push(request.system === LISTING_SYSTEM ? 'listing' : 'analysis');
  if (request.system === LISTING_SYSTEM) return listing('Kubernetes');
  throw STOP;
};
const profile = { skills: [], experiences: [], never: [], identity: {}, education: [] };
const run = (options) => analyse({ profile, offer: OFFER, ...options }).catch(() => null);

test('the listing goes to the listing model, the judgement to the chosen one', async () => {
  const chosen = [];
  const lister = [];
  await run({ llm: judge(chosen), listingLlm: judge(lister) });
  assert.deepEqual(lister, ['listing']);
  assert.ok(!chosen.includes('listing'));
});

test('without a listing model the chosen one lists, as before', async () => {
  const chosen = [];
  await run({ llm: judge(chosen) });
  assert.equal(chosen[0], 'listing');
});

test('a listing model that fails leaves the listing to the chosen one', async () => {
  const chosen = [];
  await run({ llm: judge(chosen), listingLlm: async () => { throw new Error('every backend failed'); } });
  assert.equal(chosen[0], 'listing');
});

test('two runs of one offer at once share one listing', async () => {
  let stored = null;
  let listings = 0;
  const listingCache = { read: () => stored, write: (_, value) => { stored = value; } };
  const listingLlm = async () => {
    listings += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return listing('Kubernetes');
  };
  const llm = async () => { throw STOP; };
  await Promise.all([run({ llm, listingLlm, listingCache }), run({ llm, listingLlm, listingCache })]);
  assert.equal(listings, 1);
  assert.ok(stored);
});

test('a failed listing is not shared with the next run', async () => {
  let listings = 0;
  const listingCache = { read: () => null, write: () => {} };
  const llm = async () => { throw STOP; };
  const listingLlm = async () => { listings += 1; throw STOP; };
  await run({ llm, listingLlm, listingCache });
  await run({ llm, listingLlm, listingCache });
  assert.equal(listings, 2);
});

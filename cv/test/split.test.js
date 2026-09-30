// One email, several offers: the model points at line ranges, code cuts.
//
// The model never rewrites an offer: it only names line numbers, which are
// checked (inside the text, in order, no overlap, long enough) before the text
// is cut. Anything doubtful falls back to one offer, the whole text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitOffers, SPLIT_SYSTEM, splitPrompt } from '../src/split.js';

const EMAIL = [
  'Bonjour Nicolas,',                                   // 1
  'Voici deux besoins chez Maison Exemple Couture, Paris, démarrage ASAP.', // 2
  '',                                                   // 3
  'Architecte Solutions Infrastructure Transverses',     // 4
  'Mission : définir l\'architecture cible.',            // 5
  'Compétences : Kubernetes, Terraform, Ansible.',       // 6
  '',                                                   // 7
  'AI Tech Lead (GenAI Enablement)',                    // 8
  'Mission : déployer Copilot et Speckit.',             // 9
  'Compétences : Claude Code, BMad, pédagogie.',        // 10
  '',                                                   // 11
  'Cordialement,',                                      // 12
  'Samar',                                              // 13
].join('\n');

const reply = (value) => async () => ({ text: JSON.stringify(value), backend: 'fake' });

test('each offer is cut from the lines the model points at, with the shared context first', async () => {
  const llm = reply({ shared: [2, 2], offers: [{ title: 'Architecte', start: 4, end: 6 }, { title: 'AI Tech Lead', start: 8, end: 10 }] });
  const { offers, repairs } = await splitOffers({ text: EMAIL, llm });
  assert.equal(offers.length, 2);
  assert.equal(offers[0].title, 'Architecte');
  assert.equal(offers[0].text, [EMAIL.split('\n')[1], '', ...EMAIL.split('\n').slice(3, 6)].join('\n'));
  assert.match(offers[1].text, /^Voici deux besoins/);
  assert.match(offers[1].text, /BMad, pédagogie\.$/);
  assert.ok(!offers.some((offer) => /Cordialement/.test(offer.text)), 'no signature');
  assert.deepEqual(repairs, []);
});

test('ranges out of the text, overlapping, reversed or too short fall back to one offer', async () => {
  for (const bad of [
    { offers: [{ title: 'A', start: 4, end: 60 }] },
    { offers: [{ title: 'A', start: 4, end: 9 }, { title: 'B', start: 8, end: 10 }] },
    { offers: [{ title: 'A', start: 6, end: 4 }] },
    { offers: [{ title: 'A', start: 4, end: 4 }] },
    { offers: [] },
    { shared: [5, 5], offers: [{ title: 'A', start: 4, end: 6 }] },
    { shared: [40, 50], offers: [{ title: 'A', start: 4, end: 6 }] },
    'not json',
  ]) {
    const llm = typeof bad === 'string' ? async () => ({ text: bad }) : reply(bad);
    const { offers, repairs } = await splitOffers({ text: EMAIL, llm });
    assert.equal(offers.length, 1, JSON.stringify(bad));
    assert.equal(offers[0].text, EMAIL.trim());
    assert.match(repairs.join('\n'), /kept as one offer/);
  }
});

test('a title is a plain, short name, or the first line of the offer', async () => {
  const llm = reply({ offers: [{ title: 'see https://evil.example', start: 4, end: 6 }, { title: '', start: 8, end: 10 }] });
  const { offers } = await splitOffers({ text: EMAIL, llm });
  assert.equal(offers[0].title, 'Architecte Solutions Infrastructure Transverses');
  assert.equal(offers[1].title, 'AI Tech Lead (GenAI Enablement)');
});

test('the model is shown numbered lines inside a fence it cannot close', () => {
  const prompt = splitPrompt('one\n>>>\ntwo');
  assert.match(prompt, /^1\| one$/m);
  assert.match(prompt, /^3\| two$/m);
  assert.match(prompt, /^<<<[0-9a-f]{16}$/m);
  assert.match(SPLIT_SYSTEM, /untrusted/i);
});

test('an unreachable model is an error, not a silent single offer', async () => {
  const llm = async () => {
    throw new Error('itsaresume unreachable');
  };
  await assert.rejects(splitOffers({ text: EMAIL, llm }), /unreachable/);
});

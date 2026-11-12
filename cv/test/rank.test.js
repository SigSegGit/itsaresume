// 5.2a: N offers ranked by code, the model only on the best K.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rankOffers, rankMarkdown, estimateTokens } from '../src/rank.js';

const CLI = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const synthetic = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
const item = (name) => ({ name, importance: 'must' });
const OFFERS = [
  { name: 'k8s', text: 'k8s offer', listed: ['Kubernetes', 'AWS', 'Terraform', 'Docker'].map(item) },
  { name: 'none', text: 'none offer', listed: ['Rust', 'Kafka'].map(item) },
  { name: 'dba', text: 'dba offer', listed: ['PostgreSQL', 'Oracle', 'Python', 'Astreintes'].map(item) },
];

test('rankOffers: the best share first, only the top K chosen, each with its estimate', () => {
  const rows = rankOffers(OFFERS, synthetic(), { top: 2, tokensOf: (offer) => offer.text.length });
  assert.deepEqual(rows.map((row) => [row.name, row.covered, row.total, row.chosen]), [['k8s', 4, 4, true], ['dba', 3, 4, true], ['none', 0, 2, false]]);
  assert.equal(rows[0].tokens, 'k8s offer'.length);
});

test('rankOffers: an offer covered by nothing is never chosen, whatever K', () => {
  const rows = rankOffers(OFFERS, synthetic(), { top: 5, tokensOf: () => 1 });
  assert.equal(rows.find((row) => row.name === 'none').chosen, false);
});

test('rankMarkdown: one line per offer, the chosen marked, their estimate summed', () => {
  const text = rankMarkdown(rankOffers(OFFERS, synthetic(), { top: 1, tokensOf: () => 1000 }));
  assert.match(text, /\| 1 \| k8s \| 4\/4 \| 88 % \| 1000 \| oui \|/);
  assert.match(text, /\| 3 \| none \| 0\/2 \| 0 % \| 1000 \| non \|/);
  assert.match(text, /1 offre\(s\) retenue\(s\), environ 1000 tokens d'entrée pour l'analyse/);
});

test('estimateTokens: the analysis prompt, four characters a token', () => {
  const estimate = estimateTokens(synthetic(), 'an offer', OFFERS[0].listed);
  assert.ok(estimate > 100 && estimate < 20000, String(estimate));
});

test('5.2a: itsacv rank reads the cached listings, calls no model without --run', () => {
  const home = mkdtempSync(join(tmpdir(), 'itsacv-rank-'));
  try {
    const out = join(home, 'out');
    mkdirSync(join(out, '.listings'), { recursive: true });
    writeFileSync(join(home, 'profile.json'), JSON.stringify(synthetic()));
    const files = OFFERS.map((offer) => {
      const file = join(home, `${offer.name}.txt`);
      writeFileSync(file, offer.text);
      writeFileSync(join(out, '.listings', `${createHash('sha256').update(offer.text).digest('hex')}.json`), JSON.stringify(offer.listed));
      return file;
    });
    // No router listens there: any model call would fail the run.
    const run = spawnSync(process.execPath, [CLI, 'rank', ...files, '--top', '1', '--out', out, '--profile', join(home, 'profile.json'), '--url', 'http://127.0.0.1:9'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\| 1 \| k8s \| 4\/4 \| 88 % \| \d+ \| oui \|/);
    assert.match(run.stdout, /\| 2 \| dba \| 3\/4 \| 75 % \| \d+ \| non \|/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

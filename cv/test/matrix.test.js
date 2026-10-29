// 5.1: matchmaking by code alone, no model: for each offer x profile, the
// share of the offer's requirements a profile skill names (its name, the
// lexicon's same or near concept, the owner's same/near links).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { coverage, matrix, toCsv, toMarkdown } from '../src/matrix.js';
import { buildIndex, relate, skillConcepts } from '../src/lexicon.js';

function synthetic() {
  return JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
}

/** A second fictional profile: cloud and containers, no databases. */
function cloudOnly() {
  const p = synthetic();
  p.id = 'cloud';
  p.skills = p.skills.filter((skill) => ['aws', 'gcp', 'docker', 'terraform'].includes(skill.id));
  p.skills.push({ id: 'kubernetes', name: 'Kubernetes', group: 'cloud', level: 'expert', aliases: ['K8s'] });
  return p;
}

const OFFERS = [
  { name: 'dba', requirements: ['PostgreSQL', 'Oracle', 'Python', 'Astreintes'] },
  { name: 'k8s', requirements: ['Kubernetes', 'AWS', 'Terraform', 'Docker'] },
  { name: 'mixed', requirements: ['PostgreSQL', 'AWS', 'Gouvernance'] },
];

test('coverage counts the requirements a profile skill names, and names them', () => {
  const result = coverage(synthetic(), OFFERS[0].requirements);
  assert.deepEqual(result.covered, ['PostgreSQL', 'Oracle', 'Python']);
  assert.equal(result.total, 4);
  assert.equal(result.share, 0.75);
});

test('a requirement no skill names is not covered: a shared theme is not enough', () => {
  assert.equal(coverage(cloudOnly(), ['PostgreSQL']).share, 0);
  // Ansible and PostgreSQL share only "IT", two steps up: a theme.
  const index = buildIndex([
    { id: 'ict', fr: 'informatique', en: 'IT', alt: {}, broader: [] },
    { id: 'cfg', fr: 'gestion de configuration', en: 'configuration management', alt: {}, broader: ['ict'] },
    { id: 'ansible', fr: 'Ansible', en: 'Ansible', alt: {}, broader: ['cfg'] },
    { id: 'db', fr: 'bases de données', en: 'databases', alt: {}, broader: ['ict'] },
    { id: 'pg', fr: 'PostgreSQL', en: 'PostgreSQL', alt: {}, broader: ['db'] },
  ]);
  const p = { skills: [{ id: 'ansible', name: 'Ansible', aliases: [] }] };
  const placed = skillConcepts(index, p.skills);
  assert.equal(relate(index, 'PostgreSQL', placed)[0]?.relation, 'theme', 'the case is a theme');
  assert.equal(coverage(p, ['PostgreSQL'], { index, placed }).share, 0);
});

test('the matrix ranks the profiles per offer as a person would', () => {
  const rows = matrix(OFFERS, [{ id: 'synthetic', profile: synthetic() }, { id: 'cloud', profile: cloudOnly() }]);
  const best = (offer) => rows.filter((row) => row.offer === offer).sort((a, b) => b.share - a.share)[0].profile;
  assert.equal(best('dba'), 'synthetic');
  assert.equal(best('k8s'), 'cloud');
  assert.equal(rows.length, 6);
});

test('the matrix is written as CSV and as a Markdown table', () => {
  const rows = matrix(OFFERS.slice(0, 1), [{ id: 'synthetic', profile: synthetic() }]);
  assert.equal(toCsv(rows), 'offer,profile,covered,total,share\ndba,synthetic,3,4,0.75\n');
  assert.match(toMarkdown(rows), /\| dba \| 75 % \|/);
});

const CLI = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

test('5.1b: itsacv matrix reads the runs made, one row per offer (its latest run), one column per profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'itsacv-matrix-'));
  try {
    const out = join(home, 'out');
    writeFileSync(join(home, 'profile.json'), JSON.stringify(synthetic()));
    mkdirSync(join(home, 'profiles'));
    writeFileSync(join(home, 'profiles', 'cloud.json'), JSON.stringify(cloudOnly()));
    const runs = [
      ['20261001-100000-dba', 'the dba offer', ['PostgreSQL']],
      ['20261002-100000-dba', 'the dba offer', OFFERS[0].requirements],
      ['20261001-110000-k8s', 'the k8s offer', OFFERS[1].requirements],
    ];
    for (const [name, offer, names] of runs) {
      mkdirSync(join(out, name), { recursive: true });
      writeFileSync(join(out, name, 'analysis.json'), JSON.stringify({ requirements: names.map((entry) => ({ name: entry, importance: 'must', match: 'no', skills: [], note: '' })) }));
      writeFileSync(join(out, name, 'offer.txt'), offer);
    }
    const args = ['matrix', '--out', out, '--profile', join(home, 'profile.json'), '--profiles', join(home, 'profiles')];
    const table = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.equal(table.status, 0, table.stderr);
    assert.match(table.stdout, /\| offer \| default \| cloud \|/);
    assert.match(table.stdout, /\| dba \| 75 % \| 0 % \|/, 'the latest run of the dba offer, not the first');
    assert.match(table.stdout, /\| k8s \| \d+ % \| 100 % \|/);
    assert.equal(table.stdout.split('\n').filter((line) => line.startsWith('| dba')).length, 1, table.stdout);
    const csv = spawnSync(process.execPath, [CLI, ...args, '--csv'], { encoding: 'utf8' });
    assert.equal(csv.status, 0, csv.stderr);
    assert.equal(csv.stdout.trim().split('\n').length, 5, csv.stdout);
    assert.match(csv.stdout, /^dba,default,3,4,0\.75$/m);
    const none = spawnSync(process.execPath, [CLI, 'matrix', '--out', join(home, 'empty'), '--profile', join(home, 'profile.json')], { encoding: 'utf8' });
    assert.equal(none.status, 2, none.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

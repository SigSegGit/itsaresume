// 4.2 (ADR-12): a JSON Resume (jsonresume.org v1) compiled into a profile by
// code: nothing the file does not say. A fictional resume only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fromJsonResume } from '../src/import.js';
import { validateProfile } from '../src/profile.js';

const CLI = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const resume = () => ({
  basics: { name: 'Sam Doe', label: 'Platform engineer', email: 'sam@example.org', summary: 'Platform engineer, eight years on cloud platforms.', location: { city: 'Lyon', countryCode: 'FR' } },
  work: [
    { name: 'Nimbus', position: 'Platform engineer', startDate: '2021-03-01', highlights: ['Moved 40 services to Kubernetes with Terraform.', 'Cut the cloud bill by a third.'] },
    { name: 'Pixel', position: 'Ops engineer', startDate: '2017-09', endDate: '2021-02', summary: 'Ran the Linux fleet and its monitoring with Prometheus.' },
    { name: 'Garage', position: 'Intern', startDate: '2016', endDate: '2017' },
  ],
  skills: [
    { name: 'Cloud', level: 'Advanced', keywords: ['Kubernetes', 'Terraform'] },
    { name: 'Monitoring', keywords: ['Prometheus'] },
    { name: 'Linux', level: 'Master' },
  ],
  education: [{ institution: 'Example University', studyType: 'Master', area: 'Computer science' }],
  certificates: [{ name: 'CKA' }],
  languages: [{ language: 'English', fluency: 'Fluent' }],
});

test('4.2: a JSON Resume compiles into a profile the generator accepts', () => {
  const profile = fromJsonResume(resume());
  assert.deepEqual(validateProfile(profile).errors, []);
  assert.equal(profile.identity.name, 'Sam Doe');
  assert.deepEqual(profile.experiences.map((experience) => [experience.id, experience.start, experience.end ?? null]), [['nimbus', '03/2021', null], ['pixel', '09/2017', '02/2021'], ['garage', '2016', '2017']]);
});

test('4.2: every bullet is a sentence of the file: a highlight, else the summary, else position and company', () => {
  const profile = fromJsonResume(resume());
  const bullets = (id) => profile.experiences.find((experience) => experience.id === id).bullets.map((bullet) => [bullet.fr, bullet.en]);
  assert.deepEqual(bullets('nimbus'), [['Moved 40 services to Kubernetes with Terraform.', 'Moved 40 services to Kubernetes with Terraform.'], ['Cut the cloud bill by a third.', 'Cut the cloud bill by a third.']]);
  assert.deepEqual(bullets('pixel'), [['Ran the Linux fleet and its monitoring with Prometheus.', 'Ran the Linux fleet and its monitoring with Prometheus.']]);
  assert.deepEqual(bullets('garage'), [['Intern — Garage', 'Intern — Garage']]);
});

test('4.2: a bullet cites the skills it names, and only those', () => {
  const profile = fromJsonResume(resume());
  const nimbus = profile.experiences.find((experience) => experience.id === 'nimbus');
  assert.deepEqual(nimbus.bullets[0].skills.sort(), ['kubernetes', 'terraform']);
  assert.deepEqual(nimbus.bullets[1].skills, []);
  assert.deepEqual(profile.experiences.find((experience) => experience.id === 'pixel').bullets[0].skills.sort(), ['linux', 'prometheus']);
});

test('4.2: a level is read from the file\'s words, "working" when it says none, and that is to confirm', () => {
  const profile = fromJsonResume(resume());
  const level = (id) => profile.skills.find((skill) => skill.id === id).level;
  assert.equal(level('kubernetes'), 'proficient');
  assert.equal(level('linux'), 'expert');
  assert.equal(level('prometheus'), 'working');
  assert.ok(profile.to_confirm.some((line) => /Prometheus/.test(line)), JSON.stringify(profile.to_confirm));
  assert.ok(!profile.to_confirm.some((line) => /Kubernetes/.test(line)));
});

test('4.2: missing contact details are a dash and to confirm, never invented', () => {
  const profile = fromJsonResume(resume());
  assert.equal(profile.identity.phone, '—');
  assert.ok(profile.to_confirm.some((line) => /phone/.test(line)));
});

test('4.2: a resume without work is refused', () => {
  assert.throws(() => fromJsonResume({ ...resume(), work: [] }), /no work/);
});

test('4.2: itsacv import writes DIR/<id>.json, and refuses a resume it cannot compile', () => {
  const home = mkdtempSync(join(tmpdir(), 'itsacv-import-'));
  try {
    writeFileSync(join(home, 'sam.json'), JSON.stringify(resume()));
    const done = spawnSync(process.execPath, [CLI, 'import', join(home, 'sam.json'), '--id', 'sam', '--profiles', join(home, 'profiles')], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    const written = JSON.parse(readFileSync(join(home, 'profiles', 'sam.json'), 'utf8'));
    assert.equal(written.identity.name, 'Sam Doe');
    writeFileSync(join(home, 'empty.json'), JSON.stringify({ ...resume(), work: [] }));
    const refused = spawnSync(process.execPath, [CLI, 'import', join(home, 'empty.json'), '--id', 'empty', '--profiles', join(home, 'profiles')], { encoding: 'utf8' });
    assert.equal(refused.status, 2);
    assert.ok(!existsSync(join(home, 'profiles', 'empty.json')));
    const bad = spawnSync(process.execPath, [CLI, 'import', join(home, 'sam.json'), '--id', '../x', '--profiles', join(home, 'profiles')], { encoding: 'utf8' });
    assert.equal(bad.status, 2, 'an id is lower-case letters, digits and dashes');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

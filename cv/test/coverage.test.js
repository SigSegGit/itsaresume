// 2.28b-iii: the profile decides, not the model's first verdict (the owner,
// 2026-10-25: "no" only when what the job needs is really missing from the
// whole profile, not because exact words are). Synthetic profile only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v4 } from './fixtures/v4.js';
import { normalize } from '../src/normalize.js';
import { validateAnalysis } from '../src/analysis.js';
import { defaultIndex, relate, skillConcepts } from '../src/lexicon.js';

const answer = (requirements) => ({
  language: 'fr',
  fit: { score: 50, verdict: 'partial' },
  headline: 'SRE',
  summary: ['SRE.'],
  requirements,
  experiences: [],
  skill_groups: [],
});

/** One requirement as the model answered it, normalised against `profile`. */
function judge(name, { match = 'no', skills = [], profile = v4(), assessment } = {}) {
  const { analysis, repairs } = normalize(answer([{ name, importance: 'must', match, skills, note: '' }]), profile, { assessment });
  return { row: analysis.requirements[0], repairs, analysis, profile };
}

const withSkill = (skill) => {
  const p = v4();
  p.skills.push({ group: 'ai', aliases: [], ...skill });
  return p;
};

// The core of a requirement: generic words aside, it is the concept.
for (const name of ['Langage SQL', 'Maîtrise du SQL', 'Expérience SQL', 'Connaissance des bases de données']) {
  test(`"${name}" marked no is met through the profile's expert PostgreSQL`, () => {
    const { row } = judge(name);
    assert.equal(row.match, 'yes', JSON.stringify(row));
    assert.ok(row.skills.includes('postgresql'), row.skills.join());
    assert.equal(row.judged, undefined);
  });
}

test('a practice word ("Requêtage SQL") is met by an expert or proficient skill', () => {
  assert.equal(judge('Requêtage SQL').row.match, 'yes');
  assert.equal(judge('Administration de bases de données').row.match, 'yes');
});

test('a practice word asks more than a working level: adjacent', () => {
  const p = v4();
  for (const skill of p.skills) if (skill.id === 'postgresql' || skill.id === 'oracle') skill.level = 'working';
  const { row } = judge('Requêtage SQL', { profile: p });
  assert.equal(row.match, 'adjacent');
  assert.equal(judge('SQL', { profile: p }).row.match, 'yes', 'the concept alone is met at a working level');
});

test('the model adjacent with the right pick is lifted when the name has generic words', () => {
  assert.equal(judge('Maîtrise du SQL', { match: 'adjacent', skills: ['postgresql'] }).row.match, 'yes');
});

test('a wrong pick of the model does not hide the profile: "SQL" through Python is met through PostgreSQL', () => {
  const { row } = judge('SQL', { match: 'yes', skills: ['python'] });
  assert.equal(row.match, 'yes');
  assert.ok(row.skills.includes('postgresql'), row.skills.join());
  assert.ok(!row.skills.includes('python'), 'the wrong pick stays out');
  assert.equal(row.judged, undefined);
});

test('"Bases de données relationnelles" is a technology, not a personal quality', () => {
  const { row } = judge('Bases de données relationnelles');
  assert.equal(row.kind, undefined);
  assert.equal(row.match, 'yes');
});

test('a quality word without a technology is still a personal quality', () => {
  assert.equal(judge('Sens du relationnel').row.kind, 'quality');
  assert.equal(judge("Esprit d'équipe").row.kind, 'quality');
});

test('"Cloud" alone is met through AWS (proficient)', () => {
  const { row } = judge('Cloud');
  assert.equal(row.match, 'yes');
  assert.ok(row.skills.includes('aws'));
});

test('"DevOps" is met through infrastructure as code held at expert', () => {
  const { row } = judge('Pratiques DevOps');
  assert.equal(row.match, 'yes', JSON.stringify(row));
  assert.ok(row.skills.includes('terraform'), row.skills.join());
});

test('"Automatisation" is met through Terraform or Python', () => {
  const { row } = judge('Automatisation');
  assert.equal(row.match, 'yes', JSON.stringify(row));
});

test('"Intelligence artificielle" with a lab LLM skill is adjacent, not no', () => {
  const { row } = judge('Intelligence artificielle', { profile: withSkill({ id: 'local-llm', name: 'LLM locaux', level: 'lab' }) });
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.deepEqual(row.skills, ['local-llm']);
});

test('a skill whose name carries a version or a qualifier is placed on its concept ("PostgreSQL 16")', () => {
  const p = v4();
  p.skills = p.skills.filter((skill) => skill.id !== 'postgresql' && skill.id !== 'oracle');
  p.skills.push({ id: 'pg16', name: 'PostgreSQL 16', group: 'db', level: 'expert', aliases: [] });
  const { row } = judge('SQL', { profile: p });
  assert.equal(row.match, 'yes', JSON.stringify(row));
  assert.deepEqual(row.skills, ['pg16']);
});

test('a depth word the skill may lack ("Oracle tuning") stays adjacent', () => {
  const { row } = judge('Oracle tuning');
  assert.equal(row.match, 'adjacent');
  assert.deepEqual(row.skills, ['oracle']);
});

test('a requirement naming a concept the profile lacks beside one it holds ("SQL / NoSQL") is adjacent', () => {
  assert.equal(judge('SQL / NoSQL').row.match, 'adjacent');
});

test('a tool of the same family as a held one ("Puppet" beside Terraform) is adjacent, to verify', () => {
  const { row } = judge('Puppet');
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.equal(row.judged, true);
  assert.deepEqual(row.skills, ['terraform']);
  assert.match(row.note, /Terraform/);
});

test('a sibling held at lab level brings nothing near ("OpenShift" beside a lab Docker)', () => {
  assert.equal(judge('OpenShift').row.match, 'no');
});

test('a short term ("AI" on an alerting skill) does not place the skill on a concept', () => {
  const { row } = judge('IA', { profile: withSkill({ id: 'alerting', name: 'Alerting intelligent', group: 'obs', level: 'proficient', terms: ['AI', 'IA'] }) });
  assert.equal(row.match, 'no', JSON.stringify(row));
});

// Seen on the owner's real profile (2026-10-25 replay): "intelligence
// artificielle" is a term of an alerting skill, and "AI" became yes through it.
// A term is broader than a name (2026-10-06): it may bring a requirement
// near, never meet it.
test('a long term ("intelligence artificielle" on an alerting skill) brings it near, never meets it', () => {
  const p = withSkill({ id: 'alerting', name: 'Alerting intelligent', group: 'obs', level: 'proficient', terms: ['intelligence artificielle'] });
  const { row } = judge('AI', { profile: p });
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.deepEqual(row.skills, ['alerting']);
  assert.equal(row.judged, true, 'through a term only: to verify');
  assert.equal(judge('AI', { profile: p, match: 'adjacent', skills: ['alerting'] }).row.match, 'adjacent', 'the model adjacent is not lifted through a term');
});

test('a skill placed by a term only is no sibling ("Prometheus" beside a skill whose term is Grafana)', () => {
  const p = withSkill({ id: 'obs', name: 'Supervision maison', group: 'obs', level: 'proficient', terms: ['Grafana'] });
  assert.equal(judge('Prometheus', { profile: p }).row.match, 'no');
});

// Seen in the same replay: "GenAI" met by the model through a lab LLM skill
// gained the alerting skill as "another name" of it, through its term, and
// lost its lab-only half credit.
test('a skill placed by a term only does not join the model\'s yes as another name of its concept', () => {
  const p = withSkill({ id: 'alerting', name: 'Alerting intelligent', group: 'obs', level: 'proficient', terms: ['intelligence artificielle'] });
  p.skills.push({ id: 'local-llm', name: 'LLM locaux', group: 'ai', level: 'lab', aliases: [] });
  const { row } = judge('IA générative', { profile: p, match: 'yes', skills: ['local-llm'] });
  assert.deepEqual(row.skills, ['local-llm']);
});

// Seen in the same replay: "Gouvernance des usages IA" adjacent through the
// lab LLM skills and the alerting skill's term; the proficient alerting skill
// hid the lab-only gap.
test('beside skills a name places, a skill a term places is not named, and the lab-only gap shows', () => {
  const p = withSkill({ id: 'alerting', name: 'Alerting intelligent', group: 'obs', level: 'proficient', terms: ['intelligence artificielle'] });
  p.skills.push({ id: 'local-llm', name: 'LLM locaux', group: 'ai', level: 'lab', aliases: [] });
  const { row, analysis } = judge('Gouvernance IA', { profile: p });
  assert.equal(row.match, 'adjacent');
  assert.deepEqual(row.skills, ['local-llm']);
  assert.ok(analysis.fit.qualification.gaps.some((gap) => /lab only/.test(gap)), analysis.fit.qualification.gaps.join());
});

test('a notions-level skill is not shown as an equivalent beside a better one', () => {
  const { row } = judge('Cloud privé');
  assert.equal(row.match, 'adjacent');
  assert.deepEqual(row.skills, ['aws']);
});

// The profile's own vocabulary (2.28b-iii, red team on the real profile):
// requirements no lexicon concept names ("Ordonnancement", "Transferts de
// fichiers", "PRA") were no although a skill's name, alias or term says them.
function withVocabulary() {
  const p = v4();
  p.skills.push(
    { id: 'sched', name: 'Control-M', group: 'prod', level: 'proficient', aliases: ['BMC Control-M'], terms: ['ordonnancement', 'scheduling'] },
    { id: 'transfer', name: 'Axway CFT', group: 'prod', level: 'proficient', aliases: ['CFT'], terms: ['transferts de fichiers', 'file transfer'] },
    { id: 'virt', name: 'Virtualisation', group: 'sys', level: 'working', aliases: [], terms: ['VMware', 'ESX'] },
    { id: 'ha', name: 'Haute disponibilité (HAProxy)', group: 'sys', level: 'expert', aliases: ['HAProxy'], terms: ['load-balancing'] },
    { id: 'n3', name: 'Support applicatif N3', group: 'prod', level: 'expert', aliases: ['support N3'], terms: ['troubleshooting'] },
    { id: 'ops', name: 'Exploitation de production critique', group: 'prod', level: 'expert', aliases: ['MCO'], terms: ['PRA', 'PCA'] },
    { id: 'p2p', name: 'Stockage distribué P2P', group: 'sys', level: 'lab', aliases: ['P2P'], terms: ['stockage'] },
  );
  return p;
}

test("a skill's name and alias that say the whole requirement meet it", () => {
  const p = withVocabulary();
  const met = (name) => judge(name, { profile: p }).row;
  assert.deepEqual([met('Transferts de fichiers (CFT)').match, met('Transferts de fichiers (CFT)').skills], ['yes', ['transfer']]);
  assert.deepEqual([met('Virtualisation VMware').match, met('Virtualisation VMware').skills], ['yes', ['virt']]);
  assert.equal(met('Support applicatif').match, 'yes', 'the skill says more than the requirement asks');
  assert.equal(met('Ordonnancement Control-M').match, 'yes');
});

test("a skill's name that says part of the requirement brings it near", () => {
  const { row } = judge('Haute dispo (HAProxy)', { profile: withVocabulary() });
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.deepEqual(row.skills, ['ha']);
  assert.equal(row.judged, undefined);
});

test("a skill's terms alone bring a requirement near, to verify, never meet it", () => {
  const p = withVocabulary();
  for (const [name, id] of [['PRA / PCA', 'ops'], ['Troubleshooting', 'n3'], ['Ordonnancement', 'sched'], ['Stockage', 'p2p']]) {
    const { row } = judge(name, { profile: p });
    assert.equal(row.match, 'adjacent', `${name}: ${JSON.stringify(row)}`);
    assert.equal(row.judged, true, name);
    assert.ok(row.skills.includes(id), `${name}: ${row.skills.join()}`);
  }
});

test("the profile's vocabulary says nothing of what no skill names", () => {
  const p = withVocabulary();
  assert.equal(judge('COBOL', { profile: p }).row.match, 'no');
  assert.equal(judge('Mainframe z/OS', { profile: p }).row.match, 'no');
});

// The owner, 2026-10-27: "si je sais faire de l'alerting via IA, alors je
// suis proficient en IA". His same ruling places the skill on the concept
// its words name: that concept is met, not its sub-fields, and words the
// skill does not cover still hold it near.
test("the owner's same ruling places a skill on the concept its words name: IA met through the alerting skill", () => {
  const p = withSkill({ id: 'alerting', name: 'Alerting intelligent', group: 'obs', level: 'proficient', terms: ['IA', 'AI'] });
  p.skills.push({ id: 'local-llm', name: 'LLM locaux', group: 'ai', level: 'lab', aliases: [] });
  p.links = [{ words: 'ia', skill: 'alerting', verdict: 'same' }];
  for (const name of ['IA', 'AI', 'Intelligence artificielle', 'Expérience en IA']) {
    const { row } = judge(name, { profile: p });
    assert.equal(row.match, 'yes', `${name}: ${JSON.stringify(row)}`);
    assert.ok(row.skills.includes('alerting'), `${name}: ${row.skills.join()}`);
  }
  const genai = judge('IA générative', { profile: p }).row;
  assert.deepEqual([genai.match, genai.skills], ['adjacent', ['local-llm']], 'generative AI is a sub-field the ruling does not name');
  assert.equal(judge('Gouvernance IA', { profile: p }).row.match, 'adjacent', '"gouvernance" is a word the skill may lack');
});

test('a sibling database ("MySQL") is adjacent to verify, not yes through an ESCO synonym', () => {
  const { row } = judge('MySQL');
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.equal(row.judged, true);
});

test('what an experience bullet states ("Optimisation de requêtes") is adjacent, to verify, through its skills', () => {
  const { row } = judge('Optimisation de requêtes');
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.equal(row.judged, true);
  assert.deepEqual(row.skills, ['oracle']);
  assert.match(row.note, /bank/);
});

test('what the whole profile lacks stays no', () => {
  assert.equal(judge('COBOL').row.match, 'no');
  assert.equal(judge('Kubernetes').row.match, 'no', 'never claimed');
  assert.equal(judge('Kubernetes', { match: 'yes', skills: ['docker'] }).row.match, 'no', 'never claimed, whatever the model picked');
});

test("the owner's near ruling holds the profile's verdict at adjacent", () => {
  const p = v4();
  p.links = [{ words: 'sql', skill: 'postgresql', verdict: 'near' }, { words: 'sql', skill: 'oracle', verdict: 'near' }];
  assert.equal(judge('SQL', { profile: p }).row.match, 'adjacent');
});

test("the profile's answer never lowers the model's verdict", () => {
  const { row } = judge('Oracle tuning', { match: 'yes', skills: ['oracle'] });
  assert.equal(row.match, 'yes', 'the model met it through Oracle, named in it');
});

test('every verdict the profile gives passes validation', () => {
  const names = ['Requêtage SQL', 'Puppet', 'MySQL', 'Optimisation de requêtes', 'Oracle tuning', 'Cloud', 'COBOL'];
  const p = v4();
  const { analysis } = normalize(answer(names.map((name) => ({ name, importance: 'must', match: 'no', skills: [], note: '' }))), p);
  assert.deepEqual(validateAnalysis(analysis, p).errors.filter((error) => /requirement/.test(error)), []);
});

test('an evidence-blocked skill meets nothing through the profile, an owner link or a bullet', () => {
  const assessment = [{ id: 'postgresql', verdict: 'contradicted' }, { id: 'oracle', verdict: 'contradicted' }];
  assert.equal(judge('SQL', { assessment }).row.match, 'no');
  assert.equal(judge('Optimisation de requêtes', { assessment }).row.match, 'no', 'the bullet names Oracle, blocked');
  const p = v4();
  p.links = [{ words: 'sgbd maison', skill: 'postgresql', verdict: 'same' }];
  assert.equal(judge('SGBD maison', { profile: p, assessment }).row.match, 'no', 'the owner linked PostgreSQL, blocked');
});

test("the model's yes through a lab skill the concept holds, no word of it named, stays yes (not to verify)", () => {
  const p = v4();
  p.skills.push({ id: 'podman', name: 'Podman', group: 'iac', level: 'lab', aliases: [] });
  const { row } = judge('Conteneurisation', { match: 'yes', skills: ['podman'], profile: p });
  assert.equal(row.match, 'yes');
  assert.deepEqual(row.skills, ['podman']);
  assert.equal(row.judged, undefined);
});

test("the model's yes through a notions-level skill gives way to the profile's well-held one", () => {
  const { row } = judge('Cloud public', { match: 'yes', skills: ['gcp'] });
  assert.equal(row.match, 'yes');
  assert.deepEqual(row.skills, ['aws']);
});

test('an evidence-blocked skill does not join a met requirement as another name of its concept', () => {
  const p = v4();
  p.skills.push(
    { id: 'ksh', name: 'KSH', group: 'iac', level: 'working', aliases: ['Shell'] },
    { id: 'bash', name: 'Bash', group: 'iac', level: 'expert', aliases: [] },
  );
  const { row } = judge('Shell', { match: 'yes', skills: ['ksh'], profile: p, assessment: [{ id: 'bash', verdict: 'contradicted' }] });
  assert.deepEqual(row.skills, ['ksh']);
});

test("the model's yes through a lab skill its concept holds stays yes, its lab level said by the score", () => {
  const { row, analysis } = judge('Conteneurisation', { match: 'yes', skills: ['docker'] });
  assert.equal(row.match, 'yes');
  assert.equal(row.judged, undefined);
  assert.ok(analysis.fit.qualification.gaps.some((gap) => /lab only/.test(gap)), analysis.fit.qualification.gaps.join());
});

test('a quality word beside a product name the lexicon lacks keeps the requirement scored', () => {
  assert.equal(judge('Pédagogie GitHub Copilot').row.kind, undefined);
});

test('a quality word beside a never-claimed item the lexicon lacks keeps the requirement scored', () => {
  const p = v4();
  p.never.push({ name: 'Kafka', aliases: [] });
  const { row } = judge('Leadership Kafka', { profile: p });
  assert.equal(row.kind, undefined);
  assert.equal(row.match, 'no');
});

test('a quality word beside a profile skill the lexicon lacks keeps the requirement scored', () => {
  const p = v4();
  p.skills.push({ id: 'jira', name: 'Jira', group: 'tools', level: 'proficient', aliases: [] });
  assert.equal(judge('Rigueur Jira', { profile: p }).row.kind, undefined);
});

test('two categories under one umbrella are not related: CI/CD is not near infrastructure as code', () => {
  const index = defaultIndex();
  const placed = skillConcepts(index, [{ id: 'iac', name: 'Infrastructure as Code', aliases: [], terms: [] }]);
  assert.deepEqual(relate(index, 'Intégration continue', placed), []);
});

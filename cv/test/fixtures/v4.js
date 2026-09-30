// The synthetic profile shaped like profile v4: experience kinds (main, short
// missions, R&D), the attribution matrix (`where`), a lab skill, a
// never-claimed list. Fictitious person, fictitious companies.

import { readFileSync } from 'node:fs';

export function v4() {
  const p = JSON.parse(readFileSync(new URL('./profile.synthetic.json', import.meta.url), 'utf8'));
  const where = { postgresql: ['acme'], oracle: ['bank'], terraform: ['acme'], python: ['acme'], docker: ['rnd'], aws: ['short'], gcp: ['rnd'] };
  for (const skill of p.skills) skill.where = where[skill.id];
  p.skills.find((s) => s.id === 'docker').level = 'lab';
  p.skills.find((s) => s.id === 'docker').terms = ['conteneurs', 'containers'];
  p.experiences[0].reference = true;
  p.experiences.push(
    {
      id: 'short',
      kind: 'short',
      title: { fr: 'Missions courtes', en: 'Short assignments' },
      org: { fr: 'Freelance', en: 'Freelance' },
      start: '2022',
      end: '2024',
      bullets: [{ id: 'short-aws', fr: 'Sortie d\'AWS livrée en 10 jours.', en: 'Moved off AWS in 10 days.', skills: ['aws'] }],
    },
    {
      id: 'rnd',
      kind: 'rnd',
      title: { fr: 'Fondateur / R&D', en: 'Founder / R&D' },
      title_empty: { fr: 'Conseil et R&D', en: 'Consulting and R&D' },
      org: { fr: 'EXEMPLE', en: 'EXAMPLE' },
      start: '2026',
      bullets: [{ id: 'rnd-docker', fr: 'Routeur livré en conteneur Docker.', en: 'Router shipped as a Docker container.', skills: ['docker'] }],
    },
  );
  p.never = [{ name: 'Kubernetes', aliases: ['K8s'] }];
  return p;
}

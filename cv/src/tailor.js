// The CV model: what the template receives. Every text comes from the profile
// in the analysis language, except the headline and the summary, which the
// analysis wrote and `validateAnalysis` checked.
//
// The profile v4 rules on what goes where (§0):
//   3. a short mission or an R&D project shows only bullets that back a
//      requirement the offer states; R&D with none is one sober line, short
//      missions with none are left out;
//   4. the main missions always show, first, and the reference one is the
//      most developed: no other experience shows more bullets;
//   6. a lab skill is labelled so.

import { kindOf } from './profile.js';

export const LABELS = {
  en: {
    glance: 'AT A GLANCE',
    skills: 'TECHNICAL SKILLS',
    education: 'EDUCATION',
    certifications: 'CERTIFICATIONS',
    languages: 'LANGUAGES',
    profile: 'PROFILE',
    experience: 'EXPERIENCE',
    env: 'Env: ',
  },
  fr: {
    glance: 'EN BREF',
    skills: 'COMPÉTENCES TECHNIQUES',
    education: 'FORMATION',
    certifications: 'CERTIFICATIONS',
    languages: 'LANGUES',
    profile: 'PROFIL',
    experience: 'EXPÉRIENCES',
    env: 'Env : ',
  },
};

/** Every experience shows at least this many bullets, so the career has no hole. */
export const UNSELECTED_BULLETS = 1;
/** Default bullet limits: the most recent experiences say more. */
export const RECENT_EXPERIENCES = 3;
export const RECENT_BULLETS = 4;
export const OLDER_BULLETS = 2;

/** Skills that back a requirement the candidate meets (yes or adjacent). */
export function matchedSkills(analysis) {
  return new Set(
    (analysis.requirements ?? [])
      .filter((requirement) => requirement.match === 'yes' || requirement.match === 'adjacent')
      .flatMap((requirement) => requirement.skills ?? []),
  );
}

/**
 * Profile v4, rule 3: whether a short-mission or R&D bullet earns its place.
 * Its own skill meets a requirement, or the model picked it and one of its
 * skills is of the same group as a skill that does (the owner's CV generator
 * for a GenAI offer met through LLM routing: both "ai").
 */
export function backsRequirement(profile, analysis) {
  const matched = matchedSkills(analysis);
  const groupOf = new Map(profile.skills.map((skill) => [skill.id, skill.group]));
  const groups = new Set([...matched].map((id) => groupOf.get(id)).filter(Boolean));
  const picks = new Set((analysis.experiences ?? []).flatMap((choice) => choice.bullets ?? []));
  return (bullet) => (bullet.skills ?? []).some((skill) => matched.has(skill) || (picks.has(bullet.id) && groups.has(groupOf.get(skill))));
}

/**
 * Every bullet of the profile, the most worth showing first: the model's
 * picks in its own order, then bullets backing a matched requirement (the
 * more matched skills, the earlier), then the rest; ties go to the more
 * recent experience, then to profile order.
 */
export function rankBullets(profile, analysis) {
  const matched = matchedSkills(analysis);
  const backs = backsRequirement(profile, analysis);
  const picks = (analysis.experiences ?? []).flatMap((choice) => choice.bullets ?? []);
  // A short mission the model did not pick earns its place by a requirement
  // no main mission backs (2.7f, seen 2026-09-29: a short mission filled the
  // page through "Production", which the reference mission already showed).
  const main = profile.experiences.filter((experience) => kindOf(experience) === 'main').flatMap((experience) => experience.bullets);
  const backed = (requirement, bullet) => (bullet.skills ?? []).some((id) => (requirement.skills ?? []).includes(id));
  const open = (analysis.requirements ?? []).filter((requirement) => requirement.match !== 'no' && !main.some((bullet) => backed(requirement, bullet)));
  const fills = (bullet) => open.some((requirement) => backed(requirement, bullet));
  const entries = [];
  profile.experiences.forEach((experience, index) => {
    experience.bullets.forEach((bullet, position) => {
      const pick = picks.indexOf(bullet.id);
      const relevance = (bullet.skills ?? []).filter((skill) => matched.has(skill)).length;
      if (kindOf(experience) !== 'main' && !backs(bullet)) return;
      if (kindOf(experience) === 'short' && pick < 0 && !fills(bullet)) return;
      const tier = pick >= 0 ? 2 : relevance > 0 ? 1 : 0;
      entries.push({ id: bullet.id, experience: experience.id, index, position, pick, relevance, tier });
    });
  });
  return entries.sort(
    (a, b) =>
      b.tier - a.tier ||
      (a.tier === 2 ? a.pick - b.pick : 0) ||
      b.relevance - a.relevance ||
      a.index - b.index ||
      a.position - b.position,
  );
}

/** The default selection: picks and requirement-backed bullets, within the limits. */
export function defaultBullets(profile, analysis) {
  const selected = new Set();
  const count = new Map();
  const limit = (index) => (index < RECENT_EXPERIENCES ? RECENT_BULLETS : OLDER_BULLETS);
  for (const entry of rankBullets(profile, analysis)) {
    const used = count.get(entry.experience) ?? 0;
    if (entry.tier > 0 && (entry.tier === 2 || used < limit(entry.index))) {
      selected.add(entry.id);
      count.set(entry.experience, used + 1);
    }
  }
  return selected;
}

export function buildModel(profile, analysis, { bullets, skillCap = Infinity } = {}) {
  const lang = analysis.language;
  const t = (value) => value[lang];
  const skills = new Map(profile.skills.map((skill) => [skill.id, skill]));
  const groups = new Map(profile.skill_groups.map((group) => [group.id, group]));
  const shown = new Set(bullets ?? defaultBullets(profile, analysis));
  const ranked = rankBullets(profile, analysis);

  const chosen = new Map(profile.experiences.map((experience) => {
    let ids = ranked.filter((entry) => entry.experience === experience.id && shown.has(entry.id)).map((entry) => entry.id);
    if (kindOf(experience) === 'main' && ids.length < UNSELECTED_BULLETS) {
      ids = experience.bullets.slice(0, UNSELECTED_BULLETS).map((bullet) => bullet.id);
    }
    return [experience.id, ids];
  }));
  const reference = profile.experiences.find((experience) => experience.reference) ?? profile.experiences.find((e) => kindOf(e) === 'main');
  const most = chosen.get(reference.id).length;

  const experiences = profile.experiences.flatMap((experience) => {
    const byId = new Map(experience.bullets.map((bullet) => [bullet.id, bullet]));
    const ids = chosen.get(experience.id).slice(0, experience === reference ? Infinity : most);
    const kind = kindOf(experience);
    if (kind === 'short' && ids.length === 0) return [];
    const sober = kind === 'rnd' && ids.length === 0;
    const env = sober ? [] : experience.env ?? [];
    return [{
      title: t(sober && experience.title_empty ? experience.title_empty : experience.title),
      org: t(experience.org),
      dates: experience.end ? `${experience.start} – ${experience.end}` : experience.start,
      bullets: ids.map((id) => t(byId.get(id))),
      env: env.join(', '),
      has_env: env.length > 0,
    }];
  });

  const identity = profile.identity;
  return {
    labels: LABELS[lang],
    name: identity.name,
    name_caps: identity.name.toUpperCase(),
    // The profile's names for the skills that meet the offer: document keywords.
    // A lab skill is labelled here as in the skills column.
    keywords: [...new Set([...matchedSkills(analysis)].map((id) => skills.get(id)).filter(Boolean).map((skill) => (skill.level === 'lab' ? `${skill.name} (lab)` : skill.name)))],
    headline: analysis.headline,
    contact: [identity.email, identity.phone].join('  |  '),
    company_line: [identity.company, t(identity.location)].filter(Boolean).join('  |  '),
    glance: (profile.glance ?? []).map(t),
    skill_groups: analysis.skill_groups
      .filter((choice) => (choice.skills ?? []).length > 0 && !groups.get(choice.id).hidden)
      .map((choice) => ({
        title: t(groups.get(choice.id).title),
        items: choice.skills.slice(0, skillCap).map((id) => {
          const skill = skills.get(id);
          const name = skill.display?.[lang] ?? skill.name;
          return skill.level === 'lab' ? `${name} (lab)` : name;
        }),
      })),
    education: (profile.education ?? []).map((school) => ({
      title: t(school.title),
      details: (school.details ?? []).map(t),
    })),
    certifications: (profile.certifications ?? []).map(t),
    languages: (profile.languages ?? []).map(t),
    profile: analysis.summary,
    experiences,
  };
}

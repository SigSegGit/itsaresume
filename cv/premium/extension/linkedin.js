// 6.4: the user's own LinkedIn profile page, read on their click only, into
// a JSON Resume (jsonresume.org) that the server compiles like any import.
// No crawling, no other page, no request of its own: it reads the page the
// user has open. Self-contained: chrome.scripting serialises it into the page.
// LinkedIn changes its markup: a section it cannot find is left empty.
function linkedInProfile(doc = document) {
  const text = (node) => String(node?.innerText ?? '').trim();
  const sectionOf = (id) => doc.getElementById(id)?.closest('section') ?? null;
  const items = (section) => [...(section?.querySelectorAll('li.artdeco-list__item') ?? [])];
  const spans = (node) => [...node.querySelectorAll('span[aria-hidden="true"]')].map(text).filter(Boolean);
  const sentence = /[.!?]$/;

  const work = items(sectionOf('experience')).map((item) => {
    const [position = '', company = '', dates = '', ...rest] = spans(item);
    const [startDate = '', endDate = ''] = dates.split('·')[0].split(/\s+[-–]\s+/).map((part) => part.trim());
    // A short line with no final stop right after the dates is the place.
    const details = rest.length && !sentence.test(rest[0]) && rest[0].length < 60 ? rest.slice(1) : rest;
    return {
      position,
      name: company.split('·')[0].trim(),
      startDate,
      endDate,
      highlights: details.flatMap((line) => line.split('\n')).map((line) => line.replace(/^[-•·]\s*/, '').trim()).filter(Boolean),
    };
  }).filter((job) => job.position || job.name);

  const about = spans(sectionOf('about') ?? { querySelectorAll: () => [] });
  const keywords = items(sectionOf('skills')).map((item) => spans(item)[0]).filter(Boolean);
  return {
    basics: {
      name: text(doc.querySelector('h1')),
      label: text(doc.querySelector('.text-body-medium')),
      summary: about.reduce((longest, line) => (line.length > longest.length ? line : longest), ''),
    },
    work,
    skills: keywords.length ? [{ name: 'LinkedIn', keywords: [...new Set(keywords)] }] : [],
  };
}

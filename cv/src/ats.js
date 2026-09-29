// An ATS reads the PDF's text layer. This checks, on the text actually
// extracted from the generated PDF, that every piece of the CV is there and
// that the profile is read before the experience.

/** Lower case, one space between words, bullet glyphs and ligatures gone. */
function normalise(text) {
  return text
    .normalize('NFKC')
    // "machine-to-" at a line end, "machine" on the next: one word, as written.
    .replace(/-[ \t]*\r?\n\s*/g, '-')
    .replace(/[•●▪·]/g, ' ')
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function atsCheck(model, extractedText) {
  const problems = [];
  // Pages are separated by form feeds (tools/pdftext.py); a separator after
  // the last page does not make one more.
  const pages = extractedText.split('\f');
  if (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();
  pages.forEach((page, index) => {
    if (page.trim() === '') problems.push(`page ${index + 1} of the PDF is blank`);
  });
  const text = normalise(pages.join('\n'));
  const find = (piece) => text.indexOf(normalise(piece));

  const pieces = [
    model.name_caps,
    ...model.contact.split('|').map((part) => part.trim()).filter(Boolean),
    model.labels.profile,
    model.labels.experience,
    ...model.profile,
    ...model.experiences.flatMap((experience) => [experience.title, experience.org, ...experience.bullets]),
  ];
  for (const piece of pieces) {
    if (find(piece) < 0) problems.push(`missing from the PDF text: ${piece}`);
  }

  const profileAt = find(model.labels.profile);
  const experienceAt = find(model.labels.experience);
  if (profileAt >= 0 && experienceAt >= 0 && experienceAt < profileAt) {
    problems.push(`reading order: ${model.labels.experience} comes before ${model.labels.profile}`);
  }
  for (const experience of model.experiences) {
    const titleAt = find(experience.title);
    const bulletAt = experience.bullets.length ? find(experience.bullets[0]) : -1;
    if (titleAt >= 0 && bulletAt >= 0 && bulletAt < titleAt) {
      problems.push(`reading order: a bullet of "${experience.title}" comes before its title`);
    }
  }
  return { problems, checked: pieces.length };
}

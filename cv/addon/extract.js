// 4.6: what the add-on reads, on the user's click only: the selection, else
// the job description block of the page (LinkedIn's, then common ones), else
// the page's text; cut to what the generator takes (MAX_TEXT). Self-contained:
// chrome.scripting serialises it into the page.
export function offerText(doc = document) {
  const MAX = 60000;
  const BLOCKS = ['#job-details', '.jobs-description__content', '.jobs-box__html-content', '[data-testid="jobDescriptionText"]', 'main'];
  const selected = String(doc.getSelection?.()?.toString() ?? '').trim();
  if (selected) return selected.slice(0, MAX);
  for (const selector of BLOCKS) {
    const text = String(doc.querySelector(selector)?.innerText ?? '').trim();
    if (text) return text.slice(0, MAX);
  }
  return String(doc.body?.innerText ?? '').trim().slice(0, MAX);
}

// How many ranked bullets the CV shows, decided by measuring the real layout.
//
// Nicolas's rule: one full page; a second one only when the relevant content
// alone reaches a page and a half. "Relevant" is tier > 0 in rankBullets: the
// model's picks and the bullets backing a matched requirement.
//
// `measure(bullets)` renders the CV with that set of bullet ids and returns
// its length in pages: full pages plus how far down the last one the content
// ends (1.0 = exactly one full page, 1.3 = a second page, 30% used). Adding a
// bullet never shortens the CV, so the largest set that fits is found by
// binary search: a handful of layouts, not one per bullet.

export const ONE_PAGE = 1;
export const TWO_PAGES_FROM = 1.5;
export const TWO_PAGES = 2;

/**
 * The margin left at the bottom of the last page, in pages (~12 pt on A4).
 * Seen: content measured at exactly 1.00 page came out of the PDF export
 * with a blank second page — the export does not lay out to the point what
 * the measurement did.
 */
export const SAFETY = 0.015;

/**
 * Skills per group in the skills column, from the most to the fewest. When
 * the column alone runs past the page (seen: 50 skills picked), no number of
 * bullets can fit, so the column gives way first, one skill per group at a time.
 */
export const SKILL_CAPS = [6, 5, 4, 3, 2];

export async function fitToPage({ ranked, measure }) {
  const cache = new Map();
  let cap = SKILL_CAPS[0];
  const lengthOf = async (ids, k) => {
    const key = `${ids === all ? 'all' : 'relevant'}:${k}:${cap}`;
    if (!cache.has(key)) cache.set(key, await measure(new Set(ids.slice(0, k)), cap));
    return cache.get(key);
  };
  /** The largest k such that the first k ids fit within `limit` pages. */
  const largest = async (ids, limit) => {
    let low = 0;
    let high = ids.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((await lengthOf(ids, middle)) <= limit) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  const all = ranked.map((entry) => entry.id);
  const relevant = ranked.filter((entry) => entry.tier > 0).map((entry) => entry.id);

  const relevantPages = await lengthOf(relevant, relevant.length);
  if (relevantPages >= TWO_PAGES_FROM) {
    const limit = TWO_PAGES - SAFETY;
    const k = relevantPages <= limit ? relevant.length : await largest(relevant, limit);
    return { bullets: new Set(relevant.slice(0, k)), pages: await lengthOf(relevant, k), layouts: cache.size, cap };
  }
  for (const next of SKILL_CAPS) {
    cap = next;
    if ((await lengthOf(all, 0)) <= ONE_PAGE - SAFETY) break;
  }
  const k = await largest(all, ONE_PAGE - SAFETY);
  return { bullets: new Set(all.slice(0, k)), pages: await lengthOf(all, k), layouts: cache.size, cap };
}

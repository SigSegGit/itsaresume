// 2.24b: the browser's fill of the A4 page (web/cv.js), over a fake sheet
// whose height is the sum of what is shown, times the line spacing. The
// server's data decides what may show; the fill only decides how much.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../web/cv.js', import.meta.url), 'utf8');

function load() {
  // const bindings stay in the script's scope: read them out at its end.
  return runInContext(`${SOURCE}
;({ fill, SPACING });`, createContext({}));
}

// heights: per item id; an experience costs `head` unless bare and dropped.
function sheet(page, { heights, box, base = 100, head = 20 }) {
  const shown = new Set();
  const bare = new Map();
  let spacing = 1;
  return {
    shown,
    bares: bare,
    get spacingNow() { return spacing; },
    show(id, on) { if (on) shown.add(id); else shown.delete(id); },
    bare(index, on) { bare.set(index, on); },
    spacing(value) { spacing = value; },
    box: () => box,
    height() {
      let total = base;
      page.experiences.forEach((experience, index) => {
        if (!(bare.get(index) && experience.when_empty === null)) total += head;
        for (const item of experience.items) if (shown.has(item.id)) total += heights[item.id] ?? 10;
      });
      return total * spacing;
    },
  };
}

const page = () => ({
  experiences: [
    { reference: true, items: [
      { id: 'r1', rank: 0, must: true }, { id: 'r2', rank: 2, must: false }, { id: 'r3', rank: 5, must: false },
    ] },
    { reference: false, items: [
      { id: 'o1', rank: 0, must: true }, { id: 'o2', rank: 1, must: false }, { id: 'o3', rank: 3, must: false }, { id: 'o4', rank: 4, must: false },
    ] },
    { reference: false, when_empty: null, items: [{ id: 's1', rank: 6, must: false }] },
    { reference: false, items: [{ id: 'z', rank: 0, must: false }] },
  ],
});

test('items come in by rank while the page does not overflow, musts first', () => {
  const { fill } = load();
  const data = page();
  // base 100 + 3 heads 60 (the short one bare) + musts 20 = 180; each item 10;
  // all of it times the starting spacing, 1.15. The short one's item costs its head too.
  const fake = sheet(data, { heights: {}, box: 230 * 1.15 });
  const result = fill(data, fake);
  assert.ok(fake.shown.has('r1') && fake.shown.has('o1'), 'musts');
  assert.deepEqual([...fake.shown].sort(), ['o1', 'o2', 'o3', 'r1', 'r2', 'r3'], 'o3 waits for r3; o4 would pass the reference; s1 overflows');
  assert.equal(result.overflow, false);
  assert.ok(fake.height() <= 230 * 1.15);
});

test('a rank-0 item that is not a must never shows', () => {
  const { fill } = load();
  const data = page();
  const fake = sheet(data, { heights: {}, box: 10000 });
  fill(data, fake);
  assert.ok(!fake.shown.has('z'));
  assert.ok(!fake.shown.has('o4'), 'o4 would pass the reference');
  assert.equal(fake.shown.size, 7, 'everything else fits');
});

test('no experience shows more items than the reference (the docx cap)', () => {
  const { fill } = load();
  const data = page();
  for (const box of [190, 200, 210, 220, 240, 260, 10000]) {
    const fake = sheet(data, { heights: {}, box });
    fill(data, fake);
    const count = (e) => e.items.filter((item) => fake.shown.has(item.id)).length;
    const reference = count(data.experiences[0]);
    for (const other of data.experiences.slice(1)) assert.ok(count(other) <= reference, `box ${box}`);
  }
});

test('a short mission with nothing shown is dropped; with an item, it shows', () => {
  const { fill } = load();
  const data = page();
  const tight = sheet(data, { heights: {}, box: 200 });
  fill(data, tight);
  assert.equal(tight.bares.get(2), true);
  const wide = sheet(data, { heights: {}, box: 10000 });
  fill(data, wide);
  assert.equal(wide.bares.get(2), false);
});

test('the spacing widens within bounds until the page is 95 % full, never past the page', () => {
  const { fill, SPACING } = load();
  const data = page();
  const fake = sheet(data, { heights: { r2: 1, r3: 1, o2: 1, o3: 1, o4: 1, s1: 1 }, box: 260 });
  const result = fill(data, fake);
  assert.ok(fake.height() <= 260, 'no overflow');
  assert.ok(result.spacing > SPACING.start && result.spacing <= SPACING.max);
  assert.ok(result.fill >= 0.95 || result.spacing === SPACING.max, `fill ${result.fill}`);
  const empty = sheet(data, { heights: {}, box: 100000 });
  assert.equal(fill(data, empty).spacing, SPACING.max, 'bounded');
});

test('musts that overflow shrink the spacing within bounds, and say so', () => {
  const { fill, SPACING } = load();
  const data = page();
  const fake = sheet(data, { heights: { r1: 400, o1: 400 }, box: 1000 });
  const result = fill(data, fake);
  assert.ok(fake.shown.has('r1') && fake.shown.has('o1'), 'never dropped');
  assert.equal(result.shrunk, true);
  assert.ok(result.spacing >= SPACING.min);
  const worse = sheet(data, { heights: { r1: 4000, o1: 400 }, box: 1000 });
  const over = fill(data, worse);
  assert.equal(over.overflow, true);
  assert.equal(over.spacing, SPACING.min);
});

test('the A4 page prints alone, from a button wired in cv.js', () => {
  const read = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');
  assert.match(read('cv.html'), /<button id="print"[^>]*>/);
  const css = read('cv.css');
  assert.match(css, /@page\s*\{[^}]*size:\s*A4[^}]*margin:\s*0/);
  assert.match(css, /@media print\s*\{[^@]*#notice[^@]*#print[^@]*display:\s*none/);
  assert.match(read('cv.js'), /getElementById\('print'\)\.addEventListener\('click', \(\) => window\.print\(\)\)/);
});

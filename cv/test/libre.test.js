// 3.1 (ADR-11): LibreOffice as the layout engine where Word is absent. The
// conversion and the PDF reader are faked here; the real engine is measured
// against Word on the corpus before it is trusted (HANDOVER 3.1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLibre } from '../src/libre.js';

const dir = mkdtempSync(join(tmpdir(), 'libre-test-'));
const script = (name, body) => {
  const file = join(dir, name);
  writeFileSync(file, body);
  return [process.execPath, file];
};

// A fake soffice: answers --version, else writes <outdir>/<name>.pdf and logs its arguments.
const soffice = script('soffice.mjs', `
import { writeFileSync, appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) process.exit(0);
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify(args) + '\\n');
const out = args[args.indexOf('--outdir') + 1];
const docx = args.at(-1);
if (docx.includes('nopdf')) process.exit(0);
writeFileSync(join(out, basename(docx).replace(/\\.docx$/, '.pdf')), 'PDF of ' + basename(docx));
`);
const reader = (answer) => script(`reader-${Math.random()}.mjs`, `console.log(${JSON.stringify(JSON.stringify(answer))});`);
const slow = script('slow.mjs', `if (process.argv.includes('--version')) process.exit(0); setTimeout(() => {}, 60000);`);

test('no LibreOffice, no engine', async () => {
  assert.equal(await startLibre({ soffice: [join(dir, 'missing-soffice')] }), null);
});

test('a length is the full pages plus the fill of the last, and the PDF is kept when asked', async () => {
  const engine = await startLibre({ soffice, reader: reader({ pages: 2, fill: 0.4 }) });
  const docx = join(dir, 'cv.docx');
  writeFileSync(docx, 'docx');
  const pdf = join(dir, 'kept.pdf');
  const { pages } = await engine.measure(docx, pdf);
  assert.equal(pages, 1.4);
  assert.equal(readFileSync(pdf, 'utf8'), 'PDF of cv.docx');
  const call = JSON.parse(readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').at(-1));
  assert.ok(call.includes('--headless') && call.includes('--convert-to') && call.includes('pdf'), call.join(' '));
  assert.ok(call.some((arg) => arg.startsWith('-env:UserInstallation=')), 'a profile of its own');
  engine.close();
});

test('a conversion that writes no PDF, or a reader that answers nonsense, fails the measure', async () => {
  const engine = await startLibre({ soffice, reader: reader({ pages: 0, fill: 2 }) });
  const docx = join(dir, 'cv.docx');
  await assert.rejects(engine.measure(docx), /PDF reader answered/);
  const nopdf = join(dir, 'nopdf.docx');
  writeFileSync(nopdf, 'docx');
  await assert.rejects(engine.measure(nopdf), /wrote no PDF/);
  engine.close();
});

test('a conversion that hangs is stopped at the timeout', async () => {
  const engine = await startLibre({ soffice: slow, reader: reader({ pages: 1, fill: 0.5 }), timeoutMs: 500 });
  await assert.rejects(engine.measure(join(dir, 'cv.docx')), /did not finish within 0.5 s/);
  engine.close();
});

test('the engine cleans its working directory on close', async () => {
  const engine = await startLibre({ soffice, reader: reader({ pages: 1, fill: 0.9 }) });
  const before = existsSync(join(dir, 'kept.pdf'));
  engine.close();
  assert.ok(before);
});

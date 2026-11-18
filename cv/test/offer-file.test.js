// 2.53: an offer dropped as a document: its text, by kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import { offerFromFile, OFFER_FILES } from '../src/sources.js';

const docx = (paragraphs) => {
  const zip = new PizZip();
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer' });
};

test('a docx offer is its paragraphs, one per line', async () => {
  const text = await offerFromFile('Offre.docx', docx(['Data Support &amp; Reliability Engineer', 'Python, SQL, Kafka']));
  assert.equal(text, 'Data Support & Reliability Engineer\nPython, SQL, Kafka');
});

test('a text offer is read as UTF-8; other kinds are refused', async () => {
  assert.equal(await offerFromFile('offre.txt', Buffer.from('Ingénieur SRE\r\nParis')), 'Ingénieur SRE\nParis');
  await assert.rejects(() => offerFromFile('offre.exe', Buffer.from('x')), /pdf, docx, txt or md/);
  assert.deepEqual(OFFER_FILES, ['.pdf', '.docx', '.txt', '.md']);
});

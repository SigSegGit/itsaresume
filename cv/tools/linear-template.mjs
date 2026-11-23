// 2.62 (the owner, 2026-11-23): build templates/linear.docx, a single-column
// CV shaped like his own one-column CV (name, headline, contact, a shaded
// focus line, centred ruled headings, "org | title" with the dates right,
// bullets, a grey Env line, one line per skill group), from the two-column
// package (its styles, bullet numbering, theme), tags only.
//
//     node tools/linear-template.mjs
//
// Drawn in the marine roles (primary 1B2A4A, accent B8935A, light EAE4D6)
// so every palette recolours it. Calibri, A4, as the two-column one.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';

const dir = (name) => fileURLToPath(new URL(`../templates/${name}`, import.meta.url));
const PRIMARY = '1B2A4A';
const ACCENT = 'B8935A';
const LIGHT = 'EAE4D6';
const GREY = '555555';
const TEXT = '222222';
// A4 (11906 twips) less 850 each side: the right tab sits on the margin.
const RIGHT = 11906 - 2 * 850;

const rPr = ({ size = 19, bold, italic, color = TEXT, shade } = {}) => `<w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${bold ? '<w:b/><w:bCs/>' : ''}${italic ? '<w:i/><w:iCs/>' : ''}<w:color w:val="${color}"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
const run = (text, style = {}) => `<w:r>${rPr(style)}${style.tab ? '<w:tab/>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (runs, { before = 0, after = 0, jc, tabs, border, shade, bullet } = {}) => `<w:p><w:pPr>${bullet ? '<w:pStyle w:val="Paragraphedeliste"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}${border ? `<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="1" w:color="${ACCENT}"/></w:pBdr>` : ''}${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ''}${tabs ? `<w:tabs><w:tab w:val="right" w:pos="${tabs}"/></w:tabs>` : ''}<w:spacing w:before="${before}" w:after="${after}" w:line="240" w:lineRule="auto"/>${bullet ? '<w:ind w:left="284" w:hanging="227"/>' : ''}${jc ? `<w:jc w:val="${jc}"/>` : ''}</w:pPr>${runs}</w:p>`;
/** A loop marker alone in its paragraph: docxtemplater removes the paragraph. */
const marker = (tag) => para(run(tag));
const heading = (label) => para(run(label, { size: 22, bold: true, color: PRIMARY }), { before: 140, after: 60, jc: 'center', border: true });

const body = [
  para(run('{name}', { size: 40, bold: true, color: PRIMARY })),
  para(run('{headline}', { size: 23, bold: true })),
  para(run('{contact}', { size: 18 })),
  para(run('{company_line}', { size: 18 }), { after: 40 }),
  marker('{#glance.length}'),
  para(run('{glance|dots}', { size: 18, italic: true }), { after: 20, shade: LIGHT }),
  marker('{/glance.length}'),
  heading('{labels.profile}'),
  marker('{#profile}'),
  para(run('{.}'), { after: 40, jc: 'both' }),
  marker('{/profile}'),
  heading('{labels.experience}'),
  marker('{#experiences}'),
  para(run('{org}', { size: 20, bold: true }) + run('  |  ', { size: 20 }) + run('{title}', { size: 20, bold: true, color: PRIMARY }) + run('{dates}', { size: 18, italic: true, color: GREY, tab: true }), { before: 100, after: 20, tabs: RIGHT }),
  marker('{#bullets}'),
  para(run('{.}'), { after: 10, jc: 'both', bullet: true }),
  marker('{/bullets}'),
  marker('{#has_env}'),
  para(run('{labels.env}', { size: 17, bold: true, color: GREY }) + run('{env}', { size: 17, italic: true, color: GREY }), { after: 20 }),
  marker('{/has_env}'),
  marker('{/experiences}'),
  heading('{labels.skills}'),
  marker('{#skill_groups}'),
  para(run('{title}', { bold: true }) + run(': ') + run('{items|join}'), { after: 20, jc: 'both' }),
  marker('{/skill_groups}'),
  heading('{labels.education}'),
  marker('{#education}'),
  para(run('{title}', { size: 18 }) + run('{#details} — {.}{/details}', { size: 18 }), { after: 20 }),
  marker('{/education}'),
  marker('{#certifications.length}'),
  para(run('{certifications|dots}', { size: 18 }), { after: 20 }),
  marker('{/certifications.length}'),
  marker('{#languages.length}'),
  para(run('{languages|dots}', { size: 18 })),
  marker('{/languages.length}'),
].join('');

const zip = new PizZip(readFileSync(dir('two-column.docx')));
const source = zip.file('word/document.xml').asText();
const open = source.match(/^[\s\S]*?<w:body>/)[0];
const section = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="567" w:right="850" w:bottom="567" w:left="850" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>`;
zip.file('word/document.xml', `${open}${body}${section}</w:body></w:document>`);
writeFileSync(dir('linear.docx'), zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('templates/linear.docx written');

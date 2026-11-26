// The docx, from the committed template (Nicolas's two-column design, tags
// only — see tools/templatize.py).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { join } from 'node:path';
import { TEMPLATES_DIR, recolour, resolveStyle } from './style.js';

export const TEMPLATE = fileURLToPath(new URL('../templates/two-column.docx', import.meta.url));
const templatePath = (style) => join(TEMPLATES_DIR, `${resolveStyle(style).template}.docx`);

// 2.62: a list joined on one line, for the linear template.
const JOINS = { join: ', ', dots: ' · ' };

/** `{a.b}` reads `scope.a.b`; `{.}` is the current item; `{a|join}` and
 * `{a|dots}` join the list `a` with ", " and " · ". */
function dotted(tag) {
  const [path, joiner] = tag.split('|').map((part) => part.trim());
  return {
    get(scope) {
      if (path === '.') return scope;
      const value = path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), scope);
      return joiner && Array.isArray(value) ? value.join(JOINS[joiner]) : value;
    },
  };
}

/** Render `model` into a docx buffer. A missing field is an error, never an
 * "undefined" printed on a CV. */
export function render(model, style = {}) {
  const doc = new Docxtemplater(new PizZip(readFileSync(typeof style === 'string' ? style : templatePath(style))), {
    paragraphLoop: true,
    linebreaks: true,
    parser: dotted,
    nullGetter(part) {
      if (!part.module) {
        throw new Error(`the CV model has no value for {${part.value}}`);
      }
      return '';
    },
  });
  doc.render(model);
  const zip = doc.getZip();
  if (model.made_by) addFooter(zip, model.made_by);
  for (const link of model.links ?? []) addLink(zip, link);
  if (typeof style !== 'string') recolour(zip, resolveStyle(style).palette);
  setProperties(zip, model);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const RUN = /<w:r>(<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?<w:t(?: xml:space="preserve")?>([^<]*)<\/w:t><\/w:r>/gs;
const LINK_COLOUR = '1F4E79';

/**
 * 2026-11-25: `link.text`, where the body first shows it, made a hyperlink to
 * `link.url` (an external relationship): its run is split in three, the link
 * coloured and underlined, the rest as it was.
 */
function addLink(zip, link) {
  const name = 'word/document.xml';
  const xml = zip.file(name).asText();
  const text = escapeXml(link.text);
  const relsName = 'word/_rels/document.xml.rels';
  const rels = zip.file(relsName).asText();
  let id = 1;
  while (rels.includes(`Id="rIdLink${id}"`)) id += 1;
  const rid = `rIdLink${id}`;
  let done = false;
  const out = xml.replace(RUN, (whole, rPr = '', content) => {
    const at = done ? -1 : content.indexOf(text);
    if (at < 0) return whole;
    done = true;
    const run = (value, props = rPr) => (value ? `<w:r>${props}<w:t xml:space="preserve">${value}</w:t></w:r>` : '');
    const base = rPr || '<w:rPr></w:rPr>';
    const coloured = /<w:color [^>]*\/>/.test(base) ? base.replace(/<w:color [^>]*\/>/, `<w:color w:val="${LINK_COLOUR}"/>`) : base.replace('</w:rPr>', `<w:color w:val="${LINK_COLOUR}"/></w:rPr>`);
    const linked = coloured.replace('</w:rPr>', '<w:u w:val="single"/></w:rPr>');
    return `${run(content.slice(0, at))}<w:hyperlink r:id="${rid}" w:history="1">${run(text, linked)}</w:hyperlink>${run(content.slice(at + text.length))}`;
  });
  if (!done) return;
  const withNs = /<w:document[^>]*xmlns:r=/.test(out) ? out : out.replace('<w:document ', '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  zip.file(name, withNs);
  zip.file(relsName, rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(link.url).replace(/"/g, '&quot;')}" TargetMode="External"/></Relationships>`));
}

const FOOTER_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/**
 * 2.50: `text` as the page footer, centred, small and grey, inside the bottom
 * margin (footer distance 100 twips, one 6.5 pt line under the 280 margin):
 * the body keeps all its height.
 */
function addFooter(zip, text) {
  // 2.63: the body's font, or Word falls back to the styles' Times New Roman.
  const font = /w:ascii="([^"]+)"/.exec(zip.file('word/document.xml').asText())?.[1];
  const fonts = font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` : '';
  const run = `<w:r><w:rPr>${fonts}<w:color w:val="7F7F7F"/><w:sz w:val="13"/><w:szCs w:val="13"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  zip.file('word/footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${FOOTER_NS}><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>${run}</w:p></w:ftr>`);
  const rels = 'word/_rels/document.xml.rels';
  zip.file(rels, zip.file(rels).asText().replace('</Relationships>', '<Relationship Id="rIdMadeBy" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'));
  const types = '[Content_Types].xml';
  zip.file(types, zip.file(types).asText().replace('</Types>', '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'));
  const body = 'word/document.xml';
  zip.file(body, zip.file(body).asText()
    .replace(/<w:sectPr([^>]*)>/, (open) => `${open}<w:footerReference w:type="default" r:id="rIdMadeBy"/>`)
    .replace(/w:footer="\d+"/, 'w:footer="100"'));
}

/** Title, author and keywords: shown by PDF readers, read by ATS parsers. */
function setProperties(zip, model) {
  const path = 'docProps/core.xml';
  if (!zip.file(path)) return;
  let core = zip.file(path).asText();
  const set = (tag, value) => {
    const element = `<${tag}>${escapeXml(value)}</${tag}>`;
    const existing = new RegExp(`<${tag}>[^<]*</${tag}>`);
    core = existing.test(core)
      ? core.replace(existing, () => element)
      : core.replace('</cp:coreProperties>', () => `${element}</cp:coreProperties>`);
  };
  set('dc:creator', model.name);
  set('cp:lastModifiedBy', model.name);
  set('dc:title', `CV — ${model.name} — ${model.headline}`);
  set('cp:keywords', (model.keywords ?? []).join(', '));
  zip.file(path, core);
}

// The docx, from the committed template (Nicolas's two-column design, tags
// only — see tools/templatize.py).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

export const TEMPLATE = fileURLToPath(new URL('../templates/two-column.docx', import.meta.url));

/** `{a.b}` reads `scope.a.b`; `{.}` is the current item. */
function dotted(tag) {
  return {
    get(scope) {
      if (tag === '.') return scope;
      return tag.split('.').reduce((value, key) => (value == null ? undefined : value[key]), scope);
    },
  };
}

/** Render `model` into a docx buffer. A missing field is an error, never an
 * "undefined" printed on a CV. */
export function render(model, template = TEMPLATE) {
  const doc = new Docxtemplater(new PizZip(readFileSync(template)), {
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
  setProperties(zip, model);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

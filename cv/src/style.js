// 4.12 (the owner, 2026-11-14): the CV's template and colour palette, one
// default each. A template is a .docx of templates/ carrying the same tags
// as two-column.docx; a palette recolours its three roles (primary: titles
// and the sidebar, accent: rules and marks, light: tinted backgrounds).

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
/** The colours two-column.docx is drawn with: the "marine" palette. */
const DRAWN = { primary: '1B2A4A', accent: 'B8935A', light: 'EAE4D6' };
export const PALETTES = {
  marine: DRAWN,
  bordeaux: { primary: '5B1A2A', accent: 'C28F5C', light: 'F1E6DA' },
  foret: { primary: '1F3A2E', accent: '7A9A5B', light: 'E6EDE3' },
  ardoise: { primary: '2F3E46', accent: '52796F', light: 'E3ECE8' },
  graphite: { primary: '222222', accent: '888888', light: 'EEEEEE' },
};
export const DEFAULT_STYLE = { template: 'two-column', palette: 'marine' };

export const listTemplates = () => readdirSync(TEMPLATES_DIR).filter((name) => name.endsWith('.docx')).map((name) => name.slice(0, -5)).sort();

/** `{ template, palette }` with the defaults filled in; an unknown name throws. */
export function resolveStyle(style = {}) {
  const template = style.template ?? DEFAULT_STYLE.template;
  const palette = style.palette ?? DEFAULT_STYLE.palette;
  const templates = listTemplates();
  if (!templates.includes(template)) throw new Error(`template: one of ${templates.join(', ')}`);
  if (!PALETTES[palette]) throw new Error(`palette: one of ${Object.keys(PALETTES).join(', ')}`);
  return { template, palette };
}

const PARTS = ['word/document.xml', 'word/styles.xml', 'word/theme/theme1.xml'];
/** Each drawn colour of the docx's XML parts swapped for the palette's. */
export function recolour(zip, palette) {
  const target = PALETTES[palette];
  if (!target || target === DRAWN) return;
  for (const part of PARTS) {
    const file = zip.file(part);
    if (!file) continue;
    let xml = file.asText();
    for (const role of Object.keys(DRAWN)) xml = xml.replace(new RegExp(`"${DRAWN[role]}"`, 'gi'), `"${target[role]}"`);
    zip.file(part, xml);
  }
}

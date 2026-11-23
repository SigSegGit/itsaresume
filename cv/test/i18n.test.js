// 6.7 (the owner, 2026-11-20): every page in French and English. The French
// text is the key; web/i18n.js holds the English of every key a page uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../web/i18n.js', import.meta.url), 'utf8');
const DIRS = ['../web/', '../premium/web/'];
const files = (extension) => DIRS.flatMap((dir) => readdirSync(new URL(dir, import.meta.url))
  .filter((name) => name.endsWith(extension))
  .map((name) => ({ name: `${dir.slice(3)}${name}`, text: readFileSync(new URL(dir + name, import.meta.url), 'utf8') })));

/** i18n.js run with a browser's languages, a URL and a stored choice. */
function load({ languages, search = '', stored = null } = {}) {
  const saved = new Map(stored ? [['lang', stored]] : []);
  const context = createContext({
    URLSearchParams,
    location: { search, href: `http://x/${search}` },
    navigator: languages ? { languages } : undefined,
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
  });
  runInContext(SOURCE, context);
  return { i18n: context.i18n, saved };
}

test('i18n: the language is ?lang= > the stored choice > the browser > French', () => {
  assert.equal(load().i18n.lang, 'fr');
  assert.equal(load({ languages: ['de-DE', 'en-GB'] }).i18n.lang, 'en');
  assert.equal(load({ languages: ['fr-CH', 'en'] }).i18n.lang, 'fr');
  assert.equal(load({ languages: ['de-DE'] }).i18n.lang, 'fr');
  assert.equal(load({ languages: ['en-US'], stored: 'fr' }).i18n.lang, 'fr');
  const asked = load({ languages: ['fr-FR'], search: '?lang=en' });
  assert.equal(asked.i18n.lang, 'en');
  assert.equal(asked.saved.get('lang'), 'en', 'the choice is kept');
  assert.equal(load({ search: '?lang=xx' }).i18n.lang, 'fr');
});

test('i18n: t() gives the English, or the French key, and fills {vars}', () => {
  const en = load({ languages: ['en'] }).i18n;
  assert.equal(en.t('Acheter'), 'Buy');
  assert.equal(en.t('{price} par CV', { price: '1 €' }), '1 € per CV');
  assert.equal(en.t('pas une clé'), 'pas une clé');
  assert.equal(load().i18n.t('{price} par CV', { price: '1 €' }), '1 € par CV');
});

test('i18n: a price is written as the page language writes it', () => {
  const en = load({ languages: ['en'] }).i18n;
  const fr = load().i18n;
  assert.equal(en.money(1.49, 'EUR'), '€1.49');
  assert.equal(en.money(5.49, 'USD'), '$5.49');
  assert.match(fr.money(1.49, 'EUR'), /^1,49\s€$/);
  assert.match(fr.money(1.49, 'CHF'), /^1[.,]49\sCHF$/);
  assert.equal(en.money(39, 'GBP'), '£39');
});

const { EN } = load().i18n;
const squash = (text) => text.trim().replace(/\s+/g, ' ');

test('i18n: no empty English, nothing but text written into the page', () => {
  for (const [key, value] of Object.entries(EN)) assert.ok(key.trim() && value.trim(), key);
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!SOURCE.includes(sink), sink);
});

test('i18n: every page loads i18n.js before its own scripts', () => {
  for (const { name, text } of files('.html')) {
    const scripts = [...text.matchAll(/<script\b[^>]*\bsrc="\/?([^"]+)"/g)].map((match) => match[1]);
    assert.equal(scripts[0], 'i18n.js', `${name}: ${scripts.join(', ')}`);
    assert.match(text, /<html lang="fr">/, name);
  }
});

test('i18n: every key a page marks has its English', () => {
  const missing = [];
  for (const { name, text } of files('.html')) {
    for (const match of text.matchAll(/<(\w+)\b[^>]*\sdata-i18n(?:="([^"]*)")?[\s>][^<]*?>?([^<]*)</g)) {
      const key = match[2] || squash(match[3]);
      if (!EN[key]) missing.push(`${name}: ${key}`);
    }
    for (const match of text.matchAll(/<[^>]*\sdata-i18n-attr="([^"]+)"[^>]*>/g)) {
      for (const attr of match[1].split(/\s+/)) {
        const value = match[0].match(new RegExp(`\\s${attr}=(?:"([^"]*)"|'([^']*)')`));
        if (value && !EN[value[1] ?? value[2]]) missing.push(`${name} [${attr}]: ${value[1] ?? value[2]}`);
      }
    }
    const fr = (text.match(/data-lang="fr"/g) ?? []).length;
    assert.equal((text.match(/data-lang="en"/g) ?? []).length, fr, `${name}: a French block without its English`);
  }
  for (const { name, text } of files('.js')) {
    if (name.endsWith('i18n.js')) continue;
    for (const match of text.matchAll(/\bt\((['"])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
      if (!EN[match[2]]) missing.push(`${name}: t(${match[2]})`);
    }
    // A key kept apart from its t() call (a pattern table) says so: `// i18n: key`.
    for (const line of text.split('\n').filter((row) => row.includes('// i18n: key'))) {
      for (const match of line.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
        if (!EN[match[1]]) missing.push(`${name}: key ${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('i18n: no French left outside t() in the page scripts', () => {
  const left = [];
  for (const { name, text } of files('.js')) {
    if (name.endsWith('i18n.js') || name.endsWith('sample-offer.js')) continue;
    text.split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || line.includes('// i18n: key')) return;
      const bare = line.replace(/\bt\((['"])(?:(?!\1)[^\\]|\\.)*\1/g, 't()');
      for (const match of bare.matchAll(/(['`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
        if (/[éèêàùçôî«»]|\b(?:le|la|les|des|une|pour|avec|sans|aucun|votre|ton|ta|tes)\b/i.test(match[2].replace(/\$\{[^}]*\}/g, ''))) left.push(`${name}:${index + 1}: ${match[2].slice(0, 60)}`);
      }
    });
  }
  assert.deepEqual(left, []);
});

// 6.9: the premium server answers in English; every message it can send has
// its French, so a French page never shows English.
test('i18n: every premium server message has its French', () => {
  const { i18n } = load();
  const source = ['premium/server.js', 'premium/accounts.js'].map((name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')).join('\n');
  const messages = new Set([
    ...[...source.matchAll(/HttpError\(\d+, '([^']+)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/new Error\('([^']+)'\)/g)].map((match) => match[1]),
  ]);
  const missing = [...messages].filter((message) => !i18n.SERVER_FR[message]);
  assert.deepEqual(missing, []);
  assert.equal(i18n.serverText('wrong address or password'), 'adresse ou mot de passe incorrect');
  assert.equal(load({ languages: ['en'] }).i18n.serverText('wrong address or password'), 'wrong address or password');
});

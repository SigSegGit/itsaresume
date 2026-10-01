// Instructions hidden in an offer. The offer is untrusted text; a sentence in
// it that tells the candidate, or an AI, what to write is never applied (the
// CV is built from the profile only). It is found here by plain patterns,
// French and English, and flagged in the report and on the page.

import { canonical } from './text.js';

const MAX_SENTENCES = 5;
const MAX_CHARS = 200;

// JavaScript's \b knows no accented letter: word edges are spelled out.
const START = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;
/** A pattern from words and punctuation, `<` opening a word and `>` closing it. */
const pattern = (source) => new RegExp(source.replace(/</g, START).replace(/>/g, END), 'u');

const WORD = '(?:mot|code|phrase|expression|formule|word|string)';
const PATTERNS = [
  // French: write a word somewhere / prove you read / ignore the instructions / if you are an AI.
  pattern(`<(?:écri(?:s|vez|re)|inscri(?:s|vez|re)|insère[zr]?|ajoute[zr]?)>.{0,30}<${WORD}>`),
  pattern(String.raw`<(?:mentionne[zr]?|indique[zr]?|précise[zr]?)>.{0,40}<${WORD}>.{0,60}<dans (?:votre|ton|ta|ce|le|la|l')\s?(?:candidature|cv|lettre|résumé|resume|profil|message|mail|réponse)`),
  pattern(String.raw`<pour prouver (?:que|qu')\s*(?:vous|tu) (?:avez|as) lu>`),
  pattern(String.raw`<ignore[zrs]?\s+(?:toutes?\s+)?(?:tes|vos|les|ces)\s+(?:consignes|instructions|directives)>`),
  pattern(String.raw`<si (?:tu es|vous êtes) (?:une? )?(?:ia|intelligence artificielle|llm|assistant|chatbot|robot)>`),
  pattern(String.raw`<note (?:pour|à) (?:l'|les? )?(?:assistant|ia|ias|llm|agent|modèle)>`),
  // English.
  pattern(`<(?:write|include|add|mention|insert|put|type)>.{0,30}<${WORD}>.{0,60}<(?:in|into|on) (?:your|the) (?:cv|resume|résumé|application|cover letter|summary|profile)>`),
  pattern(`<to prove (?:that )?you(?:'ve| have)? read>`),
  pattern(`<ignore (?:all |any )?(?:the |your )?(?:previous|prior|above|earlier|preceding) (?:instructions|prompts?|rules|directions)>`),
  pattern(`<disregard (?:all |any )?(?:the |your )?(?:previous|prior|above|earlier) (?:instructions|prompts?|rules)>`),
  pattern(`<as an? (?:ai|llm|language model|artificial intelligence)>`),
  pattern(`<if you are an? (?:ai|llm|language model|assistant|bot)>`),
  pattern(`<note (?:to|for) (?:the )?(?:ai|llm|assistant|model)>`),
];

/** The sentences of the offer that instruct the candidate or an AI (at most 5, 200 characters each). */
export function offerInstructions(offer) {
  const found = [];
  for (const raw of canonical(offer).split(/\n+|(?<=[.!?])\s+/)) {
    const sentence = raw.trim();
    const plain = sentence.toLowerCase().replace(/[’‘]/g, "'");
    if (sentence && PATTERNS.some((candidate) => candidate.test(plain))) found.push(sentence.slice(0, MAX_CHARS));
    if (found.length === MAX_SENTENCES) break;
  }
  return found;
}

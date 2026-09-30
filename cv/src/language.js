// The offer's language, from its most common words. A small model was seen
// answering a French offer in English; the language is therefore decided
// here and imposed, not left to the model.

const WORDS = {
  fr: ['le', 'la', 'les', 'des', 'du', 'de', 'et', 'vous', 'nous', 'pour', 'avec', 'une', 'un', 'sur', 'est', 'au', 'aux', 'dans', 'votre', 'notre'],
  en: ['the', 'and', 'you', 'we', 'for', 'with', 'a', 'an', 'of', 'to', 'is', 'our', 'your', 'in', 'on', 'will', 'are', 'be'],
};

export const LANGUAGE_NAMES = { fr: 'French', en: 'English' };

export function detectLanguage(text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const count = (lang) => words.filter((word) => WORDS[lang].includes(word)).length;
  return count('fr') > count('en') ? 'fr' : 'en';
}

// Must or nice, decided by code from the offer's own cues (2.6). ADR-9: a
// 1.5B model read "Kafka serait un plus" as required. The listing call still
// proposes an importance; where the offer says it, the offer wins.
//
// A cue in the clause that names the requirement decides; a clause without
// one takes the next cue of its sentence ("Kafka, Terraform et Ansible
// serait appréciée": the predicate closes the enumeration), else the
// nearest before it ("Idéalement, une expérience GCP"); then the header
// the line hangs under ("Compétences obligatoires : Ansible, DevOps",
// "Nice to have:" above a list). A must anywhere wins over a nice. No cue:
// null, and the model's reading stands.

import { canonical, mentions } from './text.js';

const cue = (alternatives) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'iu');

/**
 * "un plus" and "a plus" only as a verdict ("serait un plus", "is a plus",
 * "(un plus)"), never as a comparison ("un plus grand nombre", "il y a plus
 * de"). "souhaité" is left out: "Profil souhaité" heads the requirements.
 */
export const NICE = cue([
  '(?:est|sera|serait|sont|seront|seraient|constitue|constituerait|c\'est)\\s+un\\s+(?:vrai\\s+|gros\\s+|réel\\s+)?plus',
  'un\\s+(?:vrai\\s+|gros\\s+|réel\\s+)?plus(?=\\s*(?:[).,;:!]|$))',
  '(?:is|would be|will be|as|considered|a big)\\s+a\\s+plus',
  'nice[- ]to[- ]have',
  'bonus',
  'atouts?',
  'appréciée?s?',
  'appréciables?',
  'idéalement',
  'ideally',
  'optionnel(?:le)?s?',
  'optional',
  'preferred',
  'souhaitables?',
  'desirable',
]);

export const MUST = cue([
  'obligatoires?',
  'exigée?s?',
  'requise?s?',
  'required',
  'indispensables?',
  'impérati(?:f|ve)s?',
  'mandatory',
  'must[- ]have',
]);

/** 'must', 'nice' or null for one piece of text. A must cue wins. */
const cueOf = (text) => (MUST.test(text) ? 'must' : NICE.test(text) ? 'nice' : null);

/** A header: a short head before ":" (the rest of the line may list items). */
const HEADER = /^([^:.!?]{1,80}):(.*)$/;

/**
 * The importance the offer gives `name`, or null when it gives none.
 */
export function importanceIn(offer, name) {
  const votes = new Set();
  let section = null;
  for (const raw of canonical(String(offer ?? '')).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let body = line;
    let lineCue = section;
    const header = HEADER.exec(line);
    if (header) {
      const own = cueOf(header[1]);
      if (header[2].trim() === '') {
        section = own;
        continue;
      }
      if (own) lineCue = own;
      body = header[2];
    }
    for (const sentence of body.split(/(?<=[.!?;])\s+/)) {
      const clauses = sentence.split(/,/);
      clauses.forEach((clause, index) => {
        if (!mentions(clause, name)) return;
        const found = [clause, ...clauses.slice(index + 1), ...clauses.slice(0, index).reverse()].map(cueOf).find(Boolean) ?? lineCue;
        if (found) votes.add(found);
      });
    }
  }
  return votes.has('must') ? 'must' : votes.has('nice') ? 'nice' : null;
}

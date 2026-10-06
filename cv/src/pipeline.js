// Offer → validated analysis.
//
// 1. A short call lists what the offer asks for (src/listing.js).
// 2. The analysis call gets the catalogue, the offer and that list.
// 3. Its answer is merged with the list, normalised (safe repairs: move or
//    remove, never touch the free text), then validated.
// The model gets one retry, told exactly what was wrong; an answer still
// invalid after that is refused, never rendered, and kept for diagnosis.

import { analysisSchema, buildPrompt, retryPrompt } from './prompt.js';
import { extractJson } from './llm.js';
import { validateAnalysis } from './analysis.js';
import { normalize } from './normalize.js';
import { detectLanguage } from './language.js';
import { listRequirements, mergeListed } from './listing.js';

export const MAX_ATTEMPTS = 2;

/**
 * `profile` is the one the CV may draw from (restricted by the evidence,
 * src/evidence.js); `assessment`, when given, is checked again on the answer.
 */
export async function analyse({ profile, offer, llm: call, assessment, structured = false, onStep = () => {} }) {
  // Every raw answer, in call order (2.8): a replay re-normalizes the stored
  // analysis, so a rule acting on the model's own answer shows only here.
  const calls = [];
  let step = 'listing';
  const llm = async (request) => {
    const answer = await call(request);
    calls.push({ step, backend: answer.backend, text: answer.text });
    return answer;
  };
  onStep('listing');
  const listed = await listRequirements({ offer, llm });
  step = 'analysis';
  const { system, prompt } = buildPrompt(profile, offer, listed);
  // 2.3: ids closed to the catalogue, only when asked (measured first).
  const schema = structured ? { schema: analysisSchema(profile) } : {};
  const language = detectLanguage(offer);
  let current = prompt;
  let errors = [];
  const answers = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    onStep('analysis', { attempt });
    const { text, backend } = await llm({ system, prompt: current, ...schema });
    answers.push(text);
    let analysis;
    let repairs = [];
    try {
      const merged = mergeListed(extractJson(text), listed);
      const normalised = normalize(merged.analysis, profile, { assessment, offer });
      analysis = normalised.analysis;
      repairs = [...merged.repairs, ...normalised.repairs];
      errors = validateAnalysis(analysis, profile, { language, assessment, offer }).errors;
    } catch (error) {
      errors = [error.message];
    }
    if (errors.length === 0) return { analysis, attempts: attempt, backend, repairs, listed, calls };
    current = retryPrompt(prompt, text, errors);
  }
  const failure = new Error(`the model's analysis is still invalid after ${MAX_ATTEMPTS} attempts:\n- ${errors.join('\n- ')}`);
  failure.answers = answers;
  failure.calls = calls;
  throw failure;
}

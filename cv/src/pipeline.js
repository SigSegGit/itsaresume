// Offer → validated analysis.
//
// 1. A short call lists what the offer asks for (src/listing.js).
// 2. The analysis call gets the catalogue, the offer and that list.
// 3. Its answer is merged with the list, normalised (safe repairs: move or
//    remove, never touch the free text), then validated.
// The model gets one retry, told exactly what was wrong; an answer still
// invalid after that is refused, never rendered, and kept for diagnosis.

import { analysisSchema, buildPrompt, buildSplitPrompts, promptOptions, retryPrompt } from './prompt.js';
import { extractJson } from './llm.js';
import { validateAnalysis } from './analysis.js';
import { normalize } from './normalize.js';
import { detectLanguage } from './language.js';
import { listRequirements, sharedListing, mergeListed } from './listing.js';

export const MAX_ATTEMPTS = 2;

/**
 * `profile` is the one the CV may draw from (restricted by the evidence,
 * src/evidence.js); `assessment`, when given, is checked again on the answer.
 */
export async function analyse({ profile, offer, llm: call, listingLlm = null, assessment, structured = false, listingCache = null, prompt: options = promptOptions(), split = false, onStep = () => {} }) {
  // Every raw answer, in call order (2.8): a replay re-normalizes the stored
  // analysis, so a rule acting on the model's own answer shows only here.
  const calls = [];
  let step = 'listing';
  const recorded = (ask) => async (request) => {
    const answer = await ask(request);
    calls.push({ step, backend: answer.backend, text: answer.text });
    return answer;
  };
  const llm = recorded(call);
  onStep('listing');
  // 2.32: the rows do not depend on who judges them; a listing model that
  // cannot answer leaves it to the chosen one.
  const list = async () => {
    try {
      return await listRequirements({ offer, llm: listingLlm ? recorded(listingLlm) : llm });
    } catch (error) {
      if (!listingLlm) throw error;
      return listRequirements({ offer, llm });
    }
  };
  let listed = listingCache?.read(offer);
  if (!listed) {
    listed = listingCache ? await sharedListing(offer, async () => {
      const fresh = await list();
      listingCache.write(offer, fresh);
      return fresh;
    }) : await list();
  }
  step = 'analysis';
  const { system, prompt } = buildPrompt(profile, offer, listed, options);
  // 2.3: ids closed to the catalogue, only when asked (measured first).
  const schema = structured ? { schema: analysisSchema(profile) } : {};
  const language = detectLanguage(offer);
  let current = prompt;
  let errors = [];
  const answers = [];
  // 2.37: two calls, each under Groq's free minute; the second gets the
  // requirements the first classified. A retry sends each its own answer.
  const parts = split ? buildSplitPrompts(profile, offer, listed, options) : null;
  let previous = null;
  const askSplit = async () => {
    const first = previous ? retryPrompt(parts.requirements.prompt, previous.requirements, errors) : parts.requirements.prompt;
    const asked = await llm({ system: parts.requirements.system, prompt: first });
    let classified;
    try {
      classified = extractJson(asked.text);
    } catch {
      return { text: asked.text, backend: asked.backend, parts: { requirements: asked.text, choices: '' } };
    }
    const choices = parts.choices(classified.requirements);
    const second = previous ? retryPrompt(choices.prompt, previous.choices, errors) : choices.prompt;
    const chosen = await llm({ system: choices.system, prompt: second });
    let text = chosen.text;
    try {
      text = JSON.stringify({ ...extractJson(chosen.text), language: classified.language, requirements: classified.requirements });
    } catch { /* invalid: told below, and sent back */ }
    return { text, backend: chosen.backend, parts: { requirements: asked.text, choices: chosen.text } };
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    onStep('analysis', { attempt });
    const asked = split ? await askSplit() : await llm({ system, prompt: current, ...schema });
    const { text, backend } = asked;
    previous = asked.parts ?? null;
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

// `itsacv serve`: the web server wired to the real profile, model and Word.

import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApp } from './server.js';
import { loadedFrom, loadProfile, readRun, runName, tailorOffer } from './run.js';
import { offerFromFile, profileFromSources, readOffer } from './sources.js';
import { pageData } from './tailor.js';
import { appendQaLog, SPLIT, withModel } from './qa.js';
import { cvFile, draftFor, listApplications, setApplication } from './applications.js';
import { appendFeedback, readFeedback } from './feedback.js';
import { splitOffers } from './split.js';
import { jobView } from './view.js';
import { findReusable, loadRuns } from './intake.js';
import { asCustomer, contractProblem, counted } from './llm.js';
import { loadInvites } from './invites.js';
import { DEFAULT_PROFILE, listProfiles } from './profiles.js';
import { modelMenu } from './models.js';
import { ensureLocal, laptopAwake } from './wake.js';
import { addAnswer } from './answers.js';
import { pageQuestions } from './questions.js';
import { blocked } from './evidence.js';
import { DEFAULT_STYLE, PALETTES, listTemplates } from './style.js';
import { listingOf, rankListed, rankProfiles } from './rank.js';
import { fromJsonResume, fromLinkedInFiles, writeProfile } from './import.js';
import { fileListingCache } from './listing.js';

/** 2.44: the public caps, bans and visitors, beside the runs (the owner's only). */
const PUBLIC_STATE = '.public-state.json';

/** Whether the router answers its health check within two seconds. */
function routerUp(url) {
  return new Promise((resolve) => {
    const call = request(new URL('/healthz', url), { method: 'GET', timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve(false));
    call.end();
  });
}

/**
 * Why the router's /healthz contract is not this client's, or null. A router
 * that is down, or whose body is not JSON, is not a contract problem: it may
 * start later, and each answer is checked again (llm.js).
 */
function routerContract(url) {
  return new Promise((resolve) => {
    const call = request(new URL('/healthz', url), { method: 'GET', timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        resolve(parsed && typeof parsed === 'object' ? contractProblem(parsed) : null);
      });
    });
    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve(null));
    call.end();
  });
}

/** The router's backends (GET /status, 8.43), or undefined: down, or older than the route. */
async function routerBackends(url) {
  return (await routerStatus(url))?.backends;
}

/** The router's whole /status, or undefined. */
function routerStatus(url) {
  return new Promise((resolve) => {
    const call = request(new URL('/status', url), { method: 'GET', timeout: 5000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(response.statusCode === 200 && Array.isArray(parsed.backends) ? parsed : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve(undefined));
    call.end();
  });
}

/** The page's header: whose profile, how checked, and what can run. */
async function status({ profilePath, url, useWord, out }) {
  let profile;
  try {
    const loaded = loadProfile(profilePath);
    const verdicts = {};
    for (const entry of loaded.assessment ?? []) verdicts[entry.verdict] = (verdicts[entry.verdict] ?? 0) + 1;
    profile = {
      name: loaded.full.identity.name,
      // 2.47: the first headline title, for the public page's pitch.
      title: loaded.full.titles?.[0]?.fr ?? null,
      skills: loaded.full.skills.length,
      lab: loaded.full.skills.filter((skill) => skill.level === 'lab').length,
      never: (loaded.full.never ?? []).length,
      verdicts,
      truth: (loaded.full.sources ?? []).find((source) => source.id === loaded.full.truth)?.title ?? null,
    };
  } catch (error) {
    profile = { error: error.message };
  }
  const word = useWord && process.platform === 'win32';
  // ADR-11: on Linux, LibreOffice makes the PDF; $ITSACV_SOFFICE says it is there.
  const libre = useWord && !word && Boolean(process.env.ITSACV_SOFFICE);
  const [up, routed] = await Promise.all([routerUp(url), routerStatus(url)]);
  const backends = routed?.backends;
  // 2026-11-24: customers' spend today (the owner's page only: never public).
  return { profile, router: { up }, models: modelMenu(up ? backends : null, undefined, { awake: laptopAwake(out) }), layout: { word, libre }, customer_budget: routed?.customer_budget ?? null };
}

export async function serve({ profile: profilePath, profilesDir, out, url, port, useWord, llm, publicMode = null, addon = null }) {
  // Router 8.42: another contract major stops the start, before any job.
  const problem = await routerContract(url);
  if (problem) throw new Error(problem);
  // 4.1: the owner's profile, and the files of --profiles DIR (read at each use).
  const profiles = () => listProfiles({ profile: profilePath, profilesDir });
  /** A past run as a job's result: its files, the view and the A4 page. */
  const fromRun = (dir) => {
    const result = readRun(dir);
    const loaded = loadProfile(profilePath);
    return { ...result, view: jobView(result, loaded), page: pageData(loaded.profile, result.analysis) };
  };
  const deps = {
    status: async () => ({ ...(await status({ profilePath, url, useWord, out })), styles: { templates: listTemplates(), palettes: Object.keys(PALETTES), default: DEFAULT_STYLE } }),
    profiles: () => [...profiles().keys()],
    split: (text) => splitOffers({ text, llm }),
    // 5.2b: the default profile, the listing cache the analysis reads.
    match: async ({ offer, top }) => {
      const entries = [...profiles()].map(([id, path]) => ({ id, profile: loadProfile(path).profile }));
      const listed = await listingOf(offer.text, { llm: withModel(llm, 'auto'), cache: fileListingCache(join(out, '.listings')) });
      return rankProfiles(listed, entries, { top, offer: offer.text });
    },
    importProfile: async ({ id, resume, linkedin }) => {
      if (!profilesDir) throw new Error('start serve with --profiles DIR to import profiles');
      return writeProfile(profilesDir, id, resume ? fromJsonResume(resume) : fromLinkedInFiles(linkedin));
    },
    rank: ({ offers, top }) => rankListed({ offers, profile: loadProfile(profiles().get(DEFAULT_PROFILE)).profile, top, llm: withModel(llm, 'auto'), cache: fileListingCache(join(out, '.listings')) }),
    tailor: async ({ offer: given, title, model = 'auto', onStep, onAnswer = () => {}, profile = DEFAULT_PROFILE, sources, links, threshold = 0, style = {} }) => {
      // 4.11: an offer given as a link is read (the owner's page only: no fetch for the public host).
      const offer = !publicMode && /^https?:\/\/\S+$/.test(given.trim()) ? await readOffer(given.trim()) : given;
      // 4.11: the run's own sources, in a temporary folder removed when the run ends: nothing kept.
      let loaded;
      // 2026-11-24: a visitor's own profile is a customer's run: the router
      // keeps it off the owner's subscription, and it takes no hand-picked model.
      const billed = sources && publicMode ? asCustomer(llm) : llm;
      if (sources || links) {
        const tmp = mkdtempSync(join(tmpdir(), 'itsacv-sources-'));
        try {
          const specs = (sources ?? []).map((file) => {
            const path = join(tmp, file.name);
            writeFileSync(path, Buffer.from(file.data, 'base64'));
            return path;
          });
          onStep('sources');
          loaded = loadedFrom((await profileFromSources([...specs, ...(links ?? [])], { llm: counted(withModel(billed, 'auto'), onAnswer) })).profile);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      } else {
        const path = profiles().get(profile);
        if (!path) throw new Error(`no profile "${profile}"`);
        loaded = loadProfile(path);
      }
      // 8.44: the local model asked for while it sleeps is woken; the job waits.
      if (model === 'local') await ensureLocal({ out, backends: () => routerBackends(url), onStep, warm: () => withModel(llm, 'local')({ system: 'Answer with OK.', prompt: 'OK' }) });
      const result = await tailorOffer({ loaded, offer, llm: counted(withModel(billed, sources && publicMode ? 'auto' : model), onAnswer), listingLlm: counted(withModel(billed, 'auto'), onAnswer), outDir: sources && publicMode ? mkdtempSync(join(tmpdir(), 'itsacv-service-')) : out, useWord, onStep, profileId: sources || links ? 'sources' : profile, title, split: SPLIT.has(model), minScore: threshold, style });
      return { ...result, view: jobView(result, loaded), page: pageData(loaded.profile, result.analysis) };
    },
    // Public mode: the same offer is answered from its best-rated run, with no model call.
    reuse: publicMode
      ? (offer) => {
          const run = findReusable(offer, loadRuns(out));
          return run ? fromRun(run.dir) : null;
        }
      : undefined,
    // 2.45: a visitor's finished CV, read back from its folder after a restart.
    restore: publicMode ? (dir) => (existsSync(join(dir, 'analysis.json')) ? fromRun(dir) : null) : undefined,
    // 2.22c: the owner's questions over every run, and his answers beside
    // the profile; the server never offers these on the public host.
    questions: publicMode ? undefined : () => pageQuestions({ loaded: loadProfile(profilePath), profilePath, out }),
    answer: publicMode ? undefined : (body) => {
      const loaded = loadProfile(profilePath);
      return addAnswer(join(dirname(profilePath), 'answers.json'), body, { profile: loaded.profile, blocked: blocked(loaded.assessment) });
    },
    log: (entry) => appendQaLog(out, entry),
    feedback: (entry) => appendFeedback(out, entry),
    applications: { list: () => listApplications(out), set: (run, change) => setApplication(out, run, change), file: (run, name) => cvFile(out, run, name), draft: (run, lang) => draftFor(out, run, loadProfile(profiles().get(DEFAULT_PROFILE)).profile, lang) },
    feedbackList: () => readFeedback(out),
    // 2.31b: beside the runs, in a folder of its own (not a run: loadRuns skips it).
    saveComparison: (name, comparison, markdown) => {
      const dir = join(out, 'compare', runName('', new Date(), name));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'compare.md'), markdown);
      writeFileSync(join(dir, 'compare.json'), `${JSON.stringify(comparison, null, 2)}\n`);
    },
    invites: () => loadInvites(out),
    // 2.53: an offer dropped as a document, its text.
    offerText: (name, buffer) => offerFromFile(name, buffer),
    // 2.44: the public caps, bans and visitors, so a deploy does not reset them.
    state: publicMode
      ? {
          load: () => (existsSync(join(out, PUBLIC_STATE)) ? JSON.parse(readFileSync(join(out, PUBLIC_STATE), 'utf8')) : null),
          save: (value) => {
            const file = join(out, PUBLIC_STATE);
            writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
            renameSync(`${file}.tmp`, file);
          },
        }
      : undefined,
  };
  const { server } = createApp({ deps, publicMode, addon });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

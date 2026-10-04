// `itsacv serve`: the web server wired to the real profile, model and Word.

import { request } from 'node:http';
import { createApp } from './server.js';
import { loadProfile, readRun, tailorOffer } from './run.js';
import { appendQaLog, withModel } from './qa.js';
import { splitOffers } from './split.js';
import { jobView } from './view.js';
import { findReusable, loadRuns } from './intake.js';
import { counted } from './llm.js';
import { loadInvites } from './invites.js';
import { DEFAULT_PROFILE, listProfiles } from './profiles.js';

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

/** The page's header: whose profile, how checked, and what can run. */
async function status({ profilePath, url, useWord }) {
  let profile;
  try {
    const loaded = loadProfile(profilePath);
    const verdicts = {};
    for (const entry of loaded.assessment ?? []) verdicts[entry.verdict] = (verdicts[entry.verdict] ?? 0) + 1;
    profile = {
      name: loaded.full.identity.name,
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
  return { profile, router: { up: await routerUp(url) }, layout: { word, libre } };
}

export async function serve({ profile: profilePath, profilesDir, out, url, port, useWord, llm, publicMode = null }) {
  // 4.1: the owner's profile, and the files of --profiles DIR (read at each use).
  const profiles = () => listProfiles({ profile: profilePath, profilesDir });
  const deps = {
    status: () => status({ profilePath, url, useWord }),
    profiles: () => [...profiles().keys()],
    split: (text) => splitOffers({ text, llm }),
    tailor: async ({ offer, model = 'auto', onStep, onAnswer = () => {}, profile = DEFAULT_PROFILE }) => {
      const path = profiles().get(profile);
      if (!path) throw new Error(`no profile "${profile}"`);
      const loaded = loadProfile(path);
      const result = await tailorOffer({ loaded, offer, llm: counted(withModel(llm, model), onAnswer), outDir: out, useWord, onStep, profileId: profile });
      return { ...result, view: jobView(result, loaded) };
    },
    // Public mode: the same offer is answered from its best-rated run, with no model call.
    reuse: publicMode
      ? (offer) => {
          const run = findReusable(offer, loadRuns(out));
          if (!run) return null;
          const result = readRun(run.dir);
          return { ...result, view: jobView(result, loadProfile(profilePath)) };
        }
      : undefined,
    log: (entry) => appendQaLog(out, entry),
    invites: () => loadInvites(out),
  };
  const { server } = createApp({ deps, publicMode });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

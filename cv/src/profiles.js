// The profiles a job may be tailored to (4.1): the owner's (--profile, id
// "default") and each <id>.json of --profiles DIR, ids from a closed set of
// names so a request can never name a path. Read at each use: a file added
// to the directory is offered without a restart.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PROFILE = 'default';
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** id -> path, the default first, then the directory's in name order. */
export function listProfiles({ profile, profilesDir }) {
  const profiles = new Map([[DEFAULT_PROFILE, profile]]);
  if (!profilesDir || !existsSync(profilesDir)) return profiles;
  for (const name of readdirSync(profilesDir).sort()) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
    if (!ID.test(id) || profiles.has(id) || !statSync(join(profilesDir, name)).isFile()) continue;
    profiles.set(id, join(profilesDir, name));
  }
  return profiles;
}

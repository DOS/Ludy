// SPDX-License-Identifier: AGPL-3.0-only
// Vercel's "Ignored Build Step" for apps/app (apps/app/vercel.json `ignoreCommand`, #2261). The web app ships with the
// backend release: Production builds only the `release` branch, which the release-branch workflow moves to a `v*` tag.
// A plain merge to `main` never reaches app.<domain>, even if the project's Production Branch is set to main by mistake.
// Exit 0 skips the build, exit 1 runs it (Vercel's convention). Previews build whatever the branch.
import { pathToFileURL } from 'node:url';

export const RELEASE_BRANCH = 'release';

// { build, reason } for the environment Vercel gives the step (VERCEL_ENV, VERCEL_GIT_COMMIT_REF).
export function decide(env) {
  if (env.VERCEL_ENV !== 'production') return { build: true, reason: `${env.VERCEL_ENV || 'unknown'} deployment: builds` };
  const ref = env.VERCEL_GIT_COMMIT_REF || '';
  if (ref === RELEASE_BRANCH) return { build: true, reason: `production from ${RELEASE_BRANCH}: a release` };
  return { build: false, reason: `production only builds ${RELEASE_BRANCH}, which a v* tag moves; this commit is on ${ref || 'an unknown ref'}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { build, reason } = decide(process.env);
  console.log(`[vercel-ignore] ${build ? 'build' : 'skip'}: ${reason}`);
  process.exit(build ? 1 : 0);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Typecheck, vitest and Playwright run in CI, not on the owner's machine that many agents share (AGENTS.md, "Local resources", owner order 2026-11-26).
//
//   node tools/local-guard.mjs <name> [<command> <args...> --] [<targets...>]
//
// In CI (CI=true) the command runs as given. Locally it refuses even when package or file targets are given, keeping local checks
// limited to fast low-CPU tools (pnpm lint, pnpm docs:check). With no command (`typecheck`), CI only checks.
// LUDY_FULL_LOCAL=1 lifts the stop strictly for a human developer on their own personal machine (never set by agents).
import { spawnSync } from 'node:child_process';

const [name = 'this script', ...rest] = process.argv.slice(2);
const sep = rest.indexOf('--');
const command = sep === -1 ? rest : rest.slice(0, sep);
const targets = (sep === -1 ? [] : rest.slice(sep + 1)).filter((arg, i) => !(i === 0 && arg === '--'));

const full = process.env.CI === 'true' || process.env.LUDY_FULL_LOCAL === '1';

if (!full) {
  console.error(
    `pnpm ${name}: typecheck, vitest and Playwright are banned on this shared machine (AGENTS.md, "Local resources", owner order 2026-11-26).\n` +
      'Run only fast low-CPU checks locally (pnpm lint, pnpm docs:check, node tools/ci/spdx-header.mjs, node tools/ci/pii-scan.mjs).\n' +
      'Then push: GitHub Actions CI runs typecheck and all test suites on the pull request.',
  );
  process.exit(1);
}
if (command.length === 0) process.exit(0);
const run = spawnSync(command[0], [...command.slice(1), ...targets], { stdio: 'inherit' });
if (run.error) {
  console.error(`pnpm ${name}: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);

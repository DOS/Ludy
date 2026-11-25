// SPDX-License-Identifier: AGPL-3.0-only
// Full suites run in CI, not on the owner's machine that many agents share (AGENTS.md, "Local resources", owner order 2026-11-17).
//
//   node tools/local-guard.mjs <name> [<command> <args...> --] [<targets...>]
//
// In CI (CI=true) the command runs as given. Elsewhere it runs only with targets (the files or projects you touched, which
// pnpm appends after `--`); with none it stops and says what to run instead. With no command (`typecheck`), it only checks.
// LUDY_FULL_LOCAL=1 lifts the stop for a person who wants a full run on their own machine.
import { spawnSync } from 'node:child_process';

const [name = 'this script', ...rest] = process.argv.slice(2);
const sep = rest.indexOf('--');
const command = sep === -1 ? rest : rest.slice(0, sep);
const targets = (sep === -1 ? [] : rest.slice(sep + 1)).filter((arg, i) => !(i === 0 && arg === '--'));

const full = process.env.CI === 'true' || process.env.LUDY_FULL_LOCAL === '1';
const instead = {
  typecheck: 'pnpm --filter <package> typecheck (each package you changed)',
  test: 'pnpm test <test files you touched>',
  'test:db': 'pnpm test:db <db test files you touched> (with LUDY_TEST_ADMIN_URL set, or the run is skipped, not passed)',
  'test:e2e': 'pnpm test:e2e <spec files you touched>, against the one shared stack',
};

// A target is a file or directory you name. Flags, and the value of a flag that takes one (`--project unit`, `-t name`),
// are not targets: with them alone every test file still runs.
const VALUE_FLAGS = new Set(['--project', '-t', '--testNamePattern', '--config', '-c', '--shard', '--dir', '--root', '-r', '--reporter', '--outputFile']);
const named = targets.filter((arg, i) => !arg.startsWith('-') && !VALUE_FLAGS.has(targets[i - 1] ?? ''));
if (!full && named.length === 0) {
  console.error(
    `pnpm ${name}: the full run is CI's, not this machine's (AGENTS.md, "Local resources").\n` +
      `Run instead: ${instead[name] ?? 'the part you changed'}.\n` +
      'Then push: CI runs everything on the pull request.',
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

#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm mcp:conformance --url <instance>`: the check a connector vendor runs against a Ludy instance (issue #4592, ADR-0051 decision 7, Vy plan V10).
// It proves the instance's MCP door behaves as ADR-0051 says, with no model call: the metadata documents, OAuth with PKCE and the `resource`
// parameter, the readOnlyHint / destructiveHint of every tool, a proposal (never an execution) from an R2 or R3 tool, and a sample wake-up receiver.
// Plain Node (26+), no dependencies. See docs/runbooks/mcp-endpoint.md, "Check a connector against an instance".
//
//   node tools/mcp-conformance/cli.mjs --url http://localhost:8080 --sign-up
//
// Options:
//   --url <address>        the instance (its PUBLIC_URL), required
//   --sign-up              make a throwaway account and org on the instance to approve the consent page (a throwaway instance only)
//   --org <slug|id>        the org to connect (default: the first the account may connect)
//   --wake-url <address>   your own wake-up receiver, to be sent the signed samples (with MCP_CONFORMANCE_WAKE_SECRET); default: a sample receiver
//   --proposal-tool <name> --proposal-args <json>   the proposal tool to call and its arguments, when the sample arguments are not enough
//   --only <prefix>        run only the checks whose name starts with it (for example `wake.`)
//   --strict               a skipped check (other than pairing.code, which waits for #4591) counts as a failure: CI uses it
//   --json                 print the results as JSON
// Environment: MCP_CONFORMANCE_TOKEN (an owner's or admin's access token for the consent page, instead of --sign-up), MCP_CONFORMANCE_WAKE_SECRET.
// Exit code: 0 when no check failed (a skipped one says why; the run says "incomplete" if one was), 1 when one failed or, with --strict, was skipped, 2 for a usage error.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runConformance } from './checks.mjs';

const USAGE = 'usage: mcp-conformance --url <instance> [--sign-up] [--org <slug|id>] [--wake-url <address>] [--proposal-tool <name> --proposal-args <json>] [--only <prefix>] [--strict] [--json]';

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export function parseOptions(argv, env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      'sign-up': { type: 'boolean' },
      org: { type: 'string' },
      'wake-url': { type: 'string' },
      'proposal-tool': { type: 'string' },
      'proposal-args': { type: 'string' },
      only: { type: 'string' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  if (!values.url || !URL.canParse(values.url)) throw new Error('--url <instance> is required and must be an address');
  /** @type {Record<string, unknown> | undefined} */
  let proposalArgs;
  if (values['proposal-args'] !== undefined) {
    try {
      proposalArgs = JSON.parse(values['proposal-args']);
    } catch {
      throw new Error('--proposal-args must be JSON');
    }
    if (proposalArgs === null || typeof proposalArgs !== 'object' || Array.isArray(proposalArgs)) throw new Error('--proposal-args must be a JSON object');
  }
  if (proposalArgs && !values['proposal-tool']) throw new Error('--proposal-args needs --proposal-tool (the arguments belong to one tool)');
  return {
    url: values.url,
    signUp: values['sign-up'] === true,
    json: values.json === true,
    strict: values.strict === true,
    ...(values.org ? { org: values.org } : {}),
    ...(values['wake-url'] ? { wakeUrl: values['wake-url'] } : {}),
    ...(values['proposal-tool'] ? { proposalTool: values['proposal-tool'] } : {}),
    ...(proposalArgs ? { proposalArgs } : {}),
    ...(values.only ? { only: values.only } : {}),
    ...(env['MCP_CONFORMANCE_TOKEN'] ? { token: env['MCP_CONFORMANCE_TOKEN'] } : {}),
    ...(env['MCP_CONFORMANCE_WAKE_SECRET'] ? { wakeSecret: env['MCP_CONFORMANCE_WAKE_SECRET'] } : {}),
  };
}

/** @param {string[]} argv @param {Record<string, string | undefined>} env @returns {Promise<number>} */
export async function main(argv, env) {
  let options;
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const mark = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };
  const results = await runConformance({
    ...options,
    ...(options.json ? {} : { progress: (r) => console.log(`${mark[r.status]}  ${r.name}: ${r.message}`) }),
  });
  const failed = results.filter((r) => r.status === 'fail');
  // The pairing code is the one skip that is expected (it waits for #4591). Any other skipped check means a rule was not shown.
  const unshown = results.filter((r) => r.status === 'skip' && r.name !== 'pairing.code');
  const broken = options.strict ? [...failed, ...unshown] : failed;
  const complete = unshown.length === 0 || options.only !== undefined;
  if (options.json) console.log(JSON.stringify({ url: options.url, passed: broken.length === 0, complete, results }, null, 2));
  else {
    console.log(`\n${results.filter((r) => r.status === 'pass').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'skip').length} skipped`);
    if (failed.length > 0) console.log(`failed: ${failed.map((r) => r.name).join(', ')}`);
    if (!complete) console.log(`incomplete: ${unshown.map((r) => r.name).join(', ')} not run, so those rules were not shown${options.strict ? ' (--strict: counted as a failure)' : '; pass --strict to fail on that'}`);
  }
  return broken.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}

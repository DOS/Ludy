// SPDX-License-Identifier: AGPL-3.0-only
// The MCP conformance tool (issue #4592): it passes a server that follows the rules and names the check that fails when one rule is broken. The
// broken servers are tools/mcp-conformance/fake-server.mjs with one flaw each; the wake-up receivers are the tool's sample receiver with one fault.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { hintProblems, isProposalShaped, runConformance } from '../mcp-conformance/checks.mjs';
import { main, parseOptions } from '../mcp-conformance/cli.mjs';
import { FAKE_OWNER_TOKEN, startFakeServer } from '../mcp-conformance/fake-server.mjs';
import { sampleOf } from '../mcp-conformance/sample-args.mjs';
import { VECTORS, createReceiver } from '../mcp-conformance/wake.mjs';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function fake(flaws: string[] = []) {
  const server = await startFakeServer({ flaws });
  closers.push(server.close);
  return server;
}
const failed = (results: { name: string; status: string }[]) => results.filter((r) => r.status === 'fail').map((r) => r.name);
const statusOf = (results: { name: string; status: string }[], name: string) => results.find((r) => r.name === name)?.status;

describe('mcp conformance against a server that follows the rules', () => {
  it('passes every check, and skips only the pairing code that waits for #4591', async () => {
    const server = await fake();
    const results = await runConformance({ url: server.url, token: FAKE_OWNER_TOKEN });
    expect(failed(results)).toEqual([]);
    expect(results.filter((r) => r.status === 'skip').map((r) => r.name)).toEqual(['pairing.code']);
    expect(results.find((r) => r.name === 'pairing.code')?.message).toContain('#4591');
    for (const name of ['metadata.protected-resource', 'metadata.authorization-server', 'mcp.challenge', 'oauth.pkce-required', 'oauth.resource-indicator', 'oauth.flow', 'tools.hints-present', 'tools.hints-match-tier', 'proposals.no-execution', 'wake.vectors', 'wake.stale-timestamp-refused', 'wake.repeated-event-id']) {
      expect(statusOf(results, name), name).toBe('pass');
    }
  });

  it('skips the consent flow and what needs its token, and says why, when no account is given', async () => {
    const server = await fake();
    const results = await runConformance({ url: server.url });
    expect(failed(results)).toEqual([]);
    expect(statusOf(results, 'oauth.pkce-required')).toBe('pass');
    expect(statusOf(results, 'oauth.flow')).toBe('skip');
    expect(results.find((r) => r.name === 'oauth.flow')?.message).toContain('--sign-up');
    expect(statusOf(results, 'tools.hints-match-tier')).toBe('skip');
  });
});

describe('mcp conformance names the check a broken server fails', () => {
  const cases: [string, string[], string[]][] = [
    ['protected resource metadata missing', ['no-resource-metadata'], ['metadata.protected-resource']],
    ['protected resource metadata names another resource', ['wrong-resource'], ['metadata.protected-resource']],
    ['the 401 does not point at the resource metadata', ['no-challenge-pointer'], ['mcp.challenge']],
    ['PKCE is not required', ['no-pkce'], ['oauth.pkce-required']],
    ['any resource is accepted', ['any-resource'], ['oauth.resource-indicator']],
    ['the access token is for another audience', ['wrong-audience'], ['oauth.flow']],
    ['a tool has no hints', ['readonly-missing'], ['tools.hints-present']],
    ['a read tool is also destructive', ['read-destructive'], ['tools.hints-present']],
    ['a proposal tool says it is read only', ['proposal-readonly'], ['tools.hints-match-tier']],
    ['an R2 tool executes instead of proposing', ['proposal-executes'], ['proposals.no-execution']],
  ];
  for (const [what, flaws, expected] of cases) {
    it(`${what}: fails ${expected.join(', ')} and nothing else it does not depend on`, async () => {
      const server = await fake(flaws);
      const results = await runConformance({ url: server.url, token: FAKE_OWNER_TOKEN });
      expect(failed(results)).toEqual(expected);
      const bad = results.find((r) => r.status === 'fail');
      expect(bad?.message.length).toBeGreaterThan(20);
    });
  }

  it('the executing R2 tool never gets its effect hidden: the message says what it answered', async () => {
    const server = await fake(['proposal-executes']);
    const results = await runConformance({ url: server.url, token: FAKE_OWNER_TOKEN, only: 'proposals.' });
    // Without the earlier checks the proposal check has nothing to read: it is skipped, not passed.
    expect(statusOf(results, 'proposals.no-execution')).toBe('skip');
    const all = await runConformance({ url: server.url, token: FAKE_OWNER_TOKEN });
    expect(all.find((r) => r.name === 'proposals.no-execution')?.message).toMatch(/instead of \{ proposalId, status: "pending" \}/);
    expect(server.executed.length).toBeGreaterThan(0);
  });

  it('skips the proposal check with the scope named when no proposal tool is listed', async () => {
    const server = await fake(['no-proposal-tool']);
    const results = await runConformance({ url: server.url, token: FAKE_OWNER_TOKEN });
    expect(failed(results)).toEqual([]);
    expect(results.find((r) => r.name === 'proposals.no-execution')?.message).toContain('ludy.engage.write');
  });
});

describe('the wake-up webhook samples', () => {
  const run = async (flaws: string[]) => {
    const secret = 'whsec_conformance_test_secret';
    const receiver = createReceiver(secret, { flaws });
    const wakeUrl = await receiver.listen();
    closers.push(receiver.close);
    return runConformance({ url: 'http://127.0.0.1:1', wakeUrl, wakeSecret: secret, only: 'wake.' });
  };

  it('a receiver that follows the runbook passes every sample', async () => {
    const results = await run([]);
    expect(failed(results)).toEqual([]);
    expect(results.filter((r) => r.status === 'pass').map((r) => r.name)).toEqual(['wake.vectors', 'wake.valid-accepted', 'wake.window-accepted', 'wake.bad-signature-refused', 'wake.stale-timestamp-refused', 'wake.rotation-accepted', 'wake.repeated-event-id']);
  });

  it('a receiver that accepts a stale timestamp fails wake.stale-timestamp-refused', async () => {
    expect(failed(await run(['accept-stale']))).toEqual(['wake.stale-timestamp-refused']);
  });

  it('a receiver that does not check the signature fails wake.bad-signature-refused (and the stale rule it also skips)', async () => {
    expect(failed(await run(['accept-forged']))).toEqual(['wake.bad-signature-refused', 'wake.stale-timestamp-refused']);
  });

  it('the sample receiver handles a repeated event id once, and a fault of its own shows as wake.repeated-event-id', async () => {
    const good = await runConformance({ url: 'http://127.0.0.1:1', only: 'wake.repeated' });
    expect(statusOf(good, 'wake.repeated-event-id')).toBe('pass');
    // Over HTTP alone a repeat answered 2xx cannot be told from a handled one: the tool counts only on its own receiver.
    const bad = await runConformance({ url: 'http://127.0.0.1:1', only: 'wake.repeated', receiverFlaws: ['process-repeats'] });
    expect(failed(bad)).toEqual(['wake.repeated-event-id']);
    expect(bad[0]?.message).toContain('2 times');
  });

  it('skips with the reason when your own receiver is named without its secret', async () => {
    const results = await runConformance({ url: 'http://127.0.0.1:1', wakeUrl: 'http://127.0.0.1:1/wake', only: 'wake.valid' });
    expect(statusOf(results, 'wake.valid-accepted')).toBe('skip');
    expect(results[0]?.message).toContain('MCP_CONFORMANCE_WAKE_SECRET');
  });

  it('its test vectors are the runbook\'s', () => {
    const runbook = readFileSync(new URL('../../docs/runbooks/mcp-wake-webhook.md', import.meta.url), 'utf8');
    for (const text of [VECTORS.signer, VECTORS.previous, VECTORS.ping.body, VECTORS.ping.signature, VECTORS.schedule.body, VECTORS.schedule.signature, VECTORS.rotation]) {
      expect(runbook).toContain(text);
    }
  });
});

describe('the hint rules and the helpers', () => {
  const proposal = { type: 'object', properties: { proposalId: { type: 'string' }, status: { enum: ['pending'] } }, required: ['proposalId', 'status'] };

  it('reads a proposal tool by its answer, and asks it to be neither read only nor destructive', () => {
    expect(isProposalShaped(proposal)).toBe(true);
    expect(isProposalShaped({ type: 'object', properties: { id: { type: 'string' } } })).toBe(false);
    const ok = { name: 'a', outputSchema: proposal, annotations: { readOnlyHint: false, destructiveHint: false } };
    expect(hintProblems([ok])).toEqual({ present: [], tier: [] });
    expect(hintProblems([{ ...ok, annotations: { readOnlyHint: false, destructiveHint: true } }]).tier).toHaveLength(1);
    expect(hintProblems([{ ...ok, annotations: { readOnlyHint: true, destructiveHint: false } }]).tier).toHaveLength(1);
  });

  it('asks for both hints as booleans, and refuses a tool that is read only and destructive', () => {
    expect(hintProblems([{ name: 'a' }]).present).toEqual(['a: no annotations']);
    expect(hintProblems([{ name: 'a', annotations: { readOnlyHint: true } }]).present).toEqual(['a: destructiveHint is missing']);
    expect(hintProblems([{ name: 'a', annotations: { readOnlyHint: 'yes', destructiveHint: false } }]).present).toEqual(['a: readOnlyHint is missing']);
    expect(hintProblems([{ name: 'a', annotations: { readOnlyHint: true, destructiveHint: true } }]).present).toHaveLength(1);
    expect(hintProblems([{ name: 'a', annotations: { readOnlyHint: true, destructiveHint: false } }])).toEqual({ present: [], tier: [] });
  });

  it('makes sample arguments that pass the schema a tool advertises', () => {
    const args = sampleOf({ type: 'object', properties: { conversationId: { type: 'string', format: 'uuid' }, body: { type: 'string', minLength: 3 }, n: { type: 'integer', minimum: 2 }, mode: { enum: ['a', 'b'] }, note: { type: ['string', 'null'] } }, required: ['conversationId', 'body', 'n', 'mode'] }) as Record<string, unknown>;
    expect(args['conversationId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(args['body']).length).toBeGreaterThanOrEqual(3);
    expect(args['n']).toBe(2);
    expect(args['mode']).toBe('a');
    expect('note' in args).toBe(false);
  });
});

describe('the command line', () => {
  it('needs --url', () => {
    expect(() => parseOptions([], {})).toThrow('--url');
    expect(() => parseOptions(['--url', 'nope'], {})).toThrow('--url');
    expect(() => parseOptions(['--url', 'http://localhost:8080', '--proposal-args', '[1]'], {})).toThrow('JSON object');
  });

  it('reads the token and the receiver secret from the environment, never from an argument', () => {
    const options = parseOptions(['--url', 'http://localhost:8080', '--sign-up'], { MCP_CONFORMANCE_TOKEN: 't', MCP_CONFORMANCE_WAKE_SECRET: 's' });
    expect(options).toMatchObject({ url: 'http://localhost:8080', signUp: true, token: 't', wakeSecret: 's' });
    expect(() => parseOptions(['--url', 'http://localhost:8080', '--token', 'x'], {})).toThrow();
  });

  it('exits 2 for a usage error, 1 when a check fails and 0 when none does', async () => {
    const quiet = async (argv: string[]) => {
      const log = console.log;
      const error = console.error;
      console.log = () => undefined;
      console.error = () => undefined;
      try {
        return await main(argv, { MCP_CONFORMANCE_TOKEN: FAKE_OWNER_TOKEN });
      } finally {
        console.log = log;
        console.error = error;
      }
    };
    expect(await quiet([])).toBe(2);
    const good = await fake();
    expect(await quiet(['--url', good.url])).toBe(0);
    const bad = await fake(['no-pkce']);
    expect(await quiet(['--url', bad.url, '--json'])).toBe(1);
  });
});

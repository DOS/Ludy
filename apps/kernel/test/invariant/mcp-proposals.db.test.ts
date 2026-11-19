// SPDX-License-Identifier: AGPL-3.0-only
// An MCP grant's call to an R2 or R3 command becomes a PROPOSAL, never an execution (#3858 slice d; ADR-0051 decision 10; owner decision 2026-11-18/19). Pinned here:
// - RED TEAM, 0 auto-executed R2+: every call an MCP actor can make to a command declared with mode 'proposal' (a company grant that holds the scope, the scope-less, the read-only, the member-bound, a grant of
//   another org, a revoked one, a forged scope list, an input that claims it was approved) either makes ONE pending proposal or is refused; the command's handler never runs, a command that is not declared
//   is FORBIDDEN, and a command without an approval policy that names an approver is refused for R2 and R3 alike (and the database refuses the same row);
// - the proposal carries the grant, the client and its host (stamped from the grant's own record by the database), is tainted, is authored by the grant alone (an agent entry that never approves), and holds the
//   input as the payload; the audit rows hold ids and never the payload; a refused call leaves an org-log row (denied or failed) under the command's name;
// - only a person approves it in Ludy (kernel.proposal.approve, with the policy's approvers and step-up), the command then runs once with the stored payload, and an MCP actor cannot approve, reject or edit;
// - the database lets the sealed proposal context insert ONE row of ONE shape into crove_kernel.proposal and nothing else (no other status, no decision, no human author, no policy flags, no other grant), no
//   update and no delete, and no other agent context gains the right; the provenance never changes;
// - the DB-backed cap: 20 pending proposals per grant, 100 per org over all grants; a decision frees room;
// - the Inbox card names the client and its host.
// Part of the invariant suite: its fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { PROPOSAL_PREPARERS, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, MCP_WRITE_CONTEXT_SCOPES, Runtime, type UserActor } from '@crove/kernel-runtime';
import { adsCommands } from '@crove/mod-ads';
import { crmCommands } from '@crove/mod-crm';
import { financeCommands } from '@crove/mod-finance';
import { hrCommands } from '@crove/mod-hr';
import { meetingsCommands } from '@crove/mod-meetings';
import { notesCommands } from '@crove/mod-notes';
import { socialCommands } from '@crove/mod-social';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ENGAGE = 'ludy.engage.write';
const ADS = 'ludy.ads.draft';
const CANARY = 'BÍ MẬT-3858D';

// The test commands. Two names that have an approval policy in the kernel (ads.budget.raise, R2 here; ads.cap.set, R3 here) and one that has none; the module that owns the real names is not registered in
// these runtimes, so these definitions stand in for them. Each records its run, so "never executed" is a fact the test reads.
const ran: Array<{ name: string; input: unknown }> = [];
const proposalCommand = (name: string, risk: 'R2' | 'R3', scope: string, extra: Record<string, unknown> = {}) => ({
  name,
  // The envelope every proposal command takes, as kernel.proposal.approve runs it: the stored payload and what the approver accepts.
  input: z.strictObject({ payload: z.strictObject({ text: z.string().max(500), approved: z.boolean().optional() }), acceptFailedChecks: z.boolean().optional() }),
  risk,
  sideEffect: 'internal' as const,
  access: 'proposal' as const,
  proposalKind: `${name.split('.')[0]}.kind_${name.replaceAll('.', '_')}`,
  mcp: { scope, mode: 'proposal' as const },
  // Every real proposal command names the record it acts on from the envelope (input.payload.X), as here: a refusal row built from the wrong shape would be lost.
  target: (input: { payload: { text: string } }) => ({ type: 'test.record', id: input.payload.text.length > 0 ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002' }),
  handler: async (_ctx: unknown, input: unknown) => {
    ran.push({ name, input: (input as { payload: unknown }).payload });
    return { done: true };
  },
  ...extra,
});

describe('which commands an MCP grant may reach as a proposal (#3858 slice d)', () => {
  const rt = () => new Runtime({} as never, { manifests: TEST_MANIFESTS });
  const base = proposalCommand('ads.cap.set', 'R3', ENGAGE);
  it('accepts a command of mode proposal only as an R2 or R3 proposal command that names its kind, and refuses every other shape', () => {
    expect(() => rt().register({ commands: [...kernelCommands, base as never], queries: [] })).not.toThrow();
    expect(() => rt().register({ commands: [...kernelCommands, proposalCommand('ads.budget.raise', 'R2', ADS) as never], queries: [] })).not.toThrow();
    const bad: Array<Record<string, unknown>> = [
      { risk: 'R1' },
      { risk: 'R0' },
      { access: ['owner', 'admin'] },
      { access: 'system' },
      { proposalKind: undefined },
      { proposalKind: '' },
      { sealedInput: ['text'] },
      { extension: { scope: 'meetings.record' } },
      { agent: { roles: 'any' } },
      { sensitive: true },
      { mcp: { scope: 'ludy.read', mode: 'proposal' } },
      { mcp: { scope: ENGAGE, mode: 'execute' } },
    ];
    for (const change of bad) expect(() => rt().register({ commands: [...kernelCommands, { ...base, ...change } as never], queries: [] }), JSON.stringify(change)).toThrow();
  });

  it('fails the registry check when a command is reachable as a proposal and the proposer is not registered', () => {
    const runtime = rt().register({ commands: [base as never], queries: [] });
    expect(() => runtime.validate()).toThrow(/kernel\.mcp\.propose/);
    expect(() => rt().register({ commands: [...kernelCommands, base as never], queries: [] }).validate()).not.toThrow();
  });

  it('pins that no real command declares mode proposal yet: slice (d) ships the mechanism, the commands come with their lines (Engage E4, #3863); a new one is a change to this protected file', () => {
    const all = [...kernelCommands, ...financeCommands, ...meetingsCommands, ...socialCommands, ...adsCommands, ...crmCommands, ...hrCommands, ...notesCommands];
    expect(all.filter((c) => (c as { mcp?: { mode?: string } }).mcp?.mode === 'proposal').map((c) => c.name)).toEqual([]);
  });
});

suite('what an MCP call to a proposal command does, end to end (#3858 slice d)', () => {
  const dbName = `crove_test_mcp_proposals_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  // A second runtime on the same database that also registers stand-ins named like two finance commands (a preparer's and an extraction's): registered in the first, they would make the finance app look installed.
  let financeRuntime: Runtime;
  let orgA = '';
  let orgB = '';
  const users: Record<string, string> = {};
  const browser = (who: string, mfa = false): UserActor => ({ type: 'user', userId: users[who] as string, aal: mfa ? 'aal2' : 'aal1', ...(mfa ? { mfaAt: Math.floor(Date.now() / 1000) } : {}) });
  const grantActor = (who: string, grantId: string, scopes: readonly string[], kind: 'company' | 'member' = 'company'): UserActor => ({
    type: 'user',
    userId: users[who] as string,
    aal: 'aal1',
    mcp: { grantId, clientId: `client-${grantId}`, clientName: 'Dy', scopes, kind },
  });
  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));
  async function insertGrant(org: string, who: string, scopes: string[], kind: 'company' | 'member' = 'company', host = 'client.example.com', extra = '', clientName = 'Dy'): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, $10, $9, $5::text[], $6, now(), now() + interval '30 days', $3, $7, $8) ${extra}`,
      [org, id, users[who], `client-${id}`, scopes, `oauth-${id}`, kind, kind === 'member' ? users[who] : null, host, clientName],
    );
    return id;
  }
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }
  const ruleOf = (e: DomainError) => (e as { rule?: unknown }).rule ?? (e.details as { rule?: unknown } | undefined)?.rule;
  // `payload` is what the proposal stores; the call passes it in the envelope every proposal command takes.
  const propose = (actor: UserActor, name = 'ads.cap.set', payload: unknown = { text: 'Gửi báo giá' }, org = orgA) => runtime.execute<{ proposalId: string; status: string }>(name, { payload }, { actor, orgId: org });
  const proposals = async (org = orgA) => (await q<{ id: string; command: string; status: string; requested_by_grant: string | null }>(`SELECT id, command, status, requested_by_grant FROM crove_kernel.proposal WHERE org_id = $1 ORDER BY created_at, id`, [org])).rows;
  const pendingOf = (grantId: string) => q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.proposal WHERE requested_by_grant = $1 AND status = 'pending'`, [grantId]).then((r) => r.rows[0]?.n ?? 0);

  // The two stand-in names that carry an approval policy (ads.cap.set, ads.budget.raise) have a preparer in the product, so the proposer would refuse them (a client's raw payload must not skip the preparer). Here, in
  // this file's own module copy, they are taken out of the preparers' table for the run, and put back after.
  const removedPreparers: Record<string, unknown> = {};
  beforeAll(async () => {
    if (!ADMIN) return;
    for (const name of ['ads.cap.set', 'ads.budget.raise']) {
      removedPreparers[name] = (PROPOSAL_PREPARERS as Record<string, unknown>)[name];
      delete (PROPOSAL_PREPARERS as Record<string, unknown>)[name];
    }
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 6 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [
        ...kernelCommands,
        proposalCommand('ads.cap.set', 'R3', ENGAGE) as never,
        proposalCommand('ads.budget.raise', 'R2', ADS) as never,
        proposalCommand('kernel.test.no_policy', 'R3', ENGAGE) as never,
        // A command a grant may run directly under a scope that has no sealed write context yet (slice c): refused, and audited as the grant's.
        { ...proposalCommand('kernel.test.direct', 'R3', ENGAGE), access: ['owner', 'admin'], risk: 'R1', proposalKind: undefined, mcp: { scope: ENGAGE } } as never,
      ],
      queries: kernelQueries({ inboundDomain: null }),
    });
    financeRuntime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, proposalCommand('finance.journal.reverse', 'R3', ENGAGE) as never, proposalCommand('finance.purchase.record', 'R3', ENGAGE) as never],
      queries: kernelQueries({ inboundDomain: null }),
    });
    for (const key of ['owner', 'member', 'foreign']) users[key] = await upsertIdentity(db, { issuer: 'mcp-proposals', subject: key, email: `${key}@mcp-proposals.test`, name: key });
    orgA = (await createOrg(runtime, browser('owner'), 'Org A')).orgId;
    orgB = (await createOrg(runtime, browser('foreign'), 'Org B')).orgId;
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgA, users.member]);
    // The catalog a migration fills for the commands of a line: here the test commands (the catalog is empty in the product until a line declares one).
    await q(`INSERT INTO crove_kernel.mcp_proposal_command (command, scope, kind, adr) VALUES ('ads.cap.set', $1, 'ads.kind_ads_cap_set', 'ADR-0051'), ('ads.budget.raise', $2, 'ads.kind_ads_budget_raise', 'ADR-0051'), ('kernel.test.no_policy', $1, 'kernel.kind_kernel_test_no_policy', 'ADR-0051'), ('finance.journal.reverse', $1, 'finance.kind_finance_journal_reverse', 'ADR-0051'), ('finance.purchase.record', $1, 'finance.kind_finance_purchase_record', 'ADR-0051')`, [ENGAGE, ADS]);
  }, 300_000);

  afterAll(async () => {
    for (const [name, preparer] of Object.entries(removedPreparers)) (PROPOSAL_PREPARERS as Record<string, unknown>)[name] = preparer;
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('makes one pending proposal for a company grant that holds the scope, stamps the grant and the client from the grant\'s own record, and never runs the command', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE], 'company', 'dy.example.org');
    const made = await propose(grantActor('owner', grant, ['ludy.read', ENGAGE]), 'ads.cap.set', { text: `${CANARY} báo giá`, approved: true });
    expect(made.status).toBe('pending');
    expect(ran).toEqual([]);
    const row = (await q(`SELECT * FROM crove_kernel.proposal WHERE id = $1`, [made.proposalId])).rows[0] as Record<string, any>;
    expect(row).toMatchObject({ org_id: orgA, command: 'ads.cap.set', kind: 'ads.kind_ads_cap_set', status: 'pending', revision: 1, tainted: true, requested_by_grant: grant, mcp_client_name: 'Dy', mcp_client_host: 'dy.example.org' });
    expect(row.payload).toEqual({ text: `${CANARY} báo giá`, approved: true });
    expect(row.authors).toEqual([{ type: 'agent', id: grant, run: grant }, { type: 'user', id: users.owner }]);
    expect(row.requested_by_agent).toBeNull();
    expect(row.decided_by).toBeNull();
    expect(row.eligible_approvers).toEqual([users.owner]);
    expect(row.title).toContain('“Dy”');
    // The call's audit row names the grant and the command and holds ids only, never the payload.
    const audit = (await q(`SELECT command, outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND detail ->> 'proposal_id' = $2`, [orgA, made.proposalId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ command: 'kernel.mcp.propose', outcome: 'ok' });
    expect(audit[0]?.detail).toMatchObject({ mcpCall: true, mcpGrant: grant, proposal_command: 'ads.cap.set' });
    expect(JSON.stringify(audit[0]?.detail)).not.toContain(CANARY);
  });

  it('refuses every call that is not a company grant holding the scope, makes no proposal, runs nothing, and leaves an org-log row under the command\'s name', async () => {
    const before = (await proposals()).length;
    const cases: Array<[string, UserActor]> = [];
    const readOnly = await insertGrant(orgA, 'owner', ['ludy.read']);
    cases.push(['read-only grant', grantActor('owner', readOnly, ['ludy.read'])]);
    const other = await insertGrant(orgA, 'owner', ['ludy.read', ADS]);
    cases.push(['another scope', grantActor('owner', other, ['ludy.read', ADS])]);
    const forged = await insertGrant(orgA, 'owner', ['ludy.read']);
    cases.push(['a scope list the row does not hold', grantActor('owner', forged, ['ludy.read', ENGAGE])]);
    const memberBound = await insertGrant(orgA, 'owner', ['ludy.member.read'], 'member');
    cases.push(['member-bound grant', grantActor('owner', memberBound, [ENGAGE], 'member')]);
    for (const [label, actor] of cases) {
      const e = await refusal(propose(actor));
      expect([403, 401], label).toContain(e.status);
    }
    // A grant of another org, a revoked grant, and a grant made by a person who is no longer an admin.
    const foreignGrant = await insertGrant(orgB, 'foreign', ['ludy.read', ENGAGE]);
    expect((await refusal(propose(grantActor('foreign', foreignGrant, ['ludy.read', ENGAGE]), 'ads.cap.set', { text: 'x' }, orgA))).status).toBeGreaterThanOrEqual(401);
    const revoked = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    await q(`UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1`, [revoked]);
    expect((await refusal(propose(grantActor('owner', revoked, ['ludy.read', ENGAGE])))).status).toBe(401);
    expect(await proposals()).toHaveLength(before);
    expect(ran).toEqual([]);
    // The refusal of a held-scope grant is in the org log as the grant's, under the command's name (N3 of the review of slice c).
    const live = await insertGrant(orgA, 'owner', ['ludy.read', ADS]);
    await refusal(propose(grantActor('owner', live, ['ludy.read', ADS]), 'ads.cap.set'));
    const rows = (await q(`SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.cap.set' AND detail ->> 'mcpGrant' = $2`, [orgA, live])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.outcome).toBe('denied');
  });

  it('refuses a command that is not declared, a command with no approval policy, and a direct command under a scope with no write context, each audited as the grant\'s', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    const actor = grantActor('owner', grant, ['ludy.read', ENGAGE]);
    // Not declared for MCP at all: closed, as before.
    const undeclared = await refusal(runtime.execute('kernel.proposal.approve', { id: randomUUID(), revision: 1 }, { actor, orgId: orgA }));
    expect([undeclared.status, ruleOf(undeclared)]).toEqual([403, 'mcp_scope']);
    // A command that has a preparer is not proposable by a raw payload, though it is declared, listed and has an approval policy.
    for (const name of ['finance.journal.reverse', 'finance.purchase.record']) {
      const preparer = await refusal(financeRuntime.execute(name, { payload: { text: 'x' } }, { actor, orgId: orgA }));
      expect([preparer.status, ruleOf(preparer)], name).toEqual([403, 'mcp_scope']);
    }
    // Declared, R3, but no approval policy names an approver: refused (R3 only as a proposal an approver can take), nothing inserted.
    const before = (await proposals()).length;
    const noPolicy = await refusal(propose(actor, 'kernel.test.no_policy'));
    expect([noPolicy.status, ruleOf(noPolicy)]).toEqual([403, 'mcp_scope']);
    expect(await proposals()).toHaveLength(before);
    // A direct (run-mode) command under a scope that has no sealed write context yet: refused after entry, so it is audited as the grant's. Where the scope has its context (E2, #3861) the command
    // is a run, which its own tests pin; this file only requires that it is never a proposal.
    const sealed = MCP_WRITE_CONTEXT_SCOPES.includes(ENGAGE);
    if (!sealed) {
      const direct = await refusal(runtime.execute('kernel.test.direct', { payload: { text: 'x' } }, { actor, orgId: orgA }));
      expect([direct.status, ruleOf(direct)]).toEqual([403, 'mcp_scope']);
    }
    const audited = (await q(`SELECT command, outcome FROM crove_kernel.audit_event WHERE org_id = $1 AND detail ->> 'mcpGrant' = $2 AND outcome <> 'ok' ORDER BY id`, [orgA, grant])).rows;
    expect(audited.map((r) => r.command)).toEqual(expect.arrayContaining(['kernel.proposal.approve', 'kernel.test.no_policy', ...(sealed ? [] : ['kernel.test.direct'])]));
    expect(ran.filter((r) => r.name !== 'kernel.test.direct')).toEqual([]);
  });

  it('refuses a call that tries to pre-accept what only the approver accepts, or that holds no payload object, and makes nothing', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    const actor = grantActor('owner', grant, ['ludy.read', ENGAGE]);
    const before = (await proposals()).length;
    for (const input of [{ payload: { text: 'x' }, acceptFailedChecks: true }, { payload: 'x' }, { payload: [1] }, {}]) {
      expect([400, 403, 422], JSON.stringify(input)).toContain((await refusal(runtime.execute('ads.cap.set', input, { actor, orgId: orgA }))).status);
    }
    expect(await proposals()).toHaveLength(before);
    expect(ran.filter((r) => r.name !== 'kernel.test.direct')).toEqual([]);
  });

  it('validates the payload against the command\'s own schema before anything is stored, and keeps a client-supplied record id out of the refusal audit', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    const actor = grantActor('owner', grant, ['ludy.read', ENGAGE]);
    const before = (await proposals()).length;
    for (const payload of [{ text: 5 }, { text: 'x', extra: true }, {}]) {
      expect((await refusal(propose(actor, 'ads.cap.set', payload))).status, JSON.stringify(payload)).toBe(422);
    }
    expect(await proposals()).toHaveLength(before);
    // A refused call (scope not held) names the command in the org log and no record: the test command derives a record id from the payload, which the audit never takes.
    const other = await insertGrant(orgA, 'owner', ['ludy.read', ADS]);
    await refusal(propose(grantActor('owner', other, ['ludy.read', ADS]), 'ads.cap.set', { text: 'client chose this' }));
    const rows = (await q(`SELECT target_type, target_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.cap.set' AND detail ->> 'mcpGrant' = $2`, [orgA, other])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect([row.target_type, row.target_id]).toEqual([null, null]);
  });

  it('builds the title from a client name with every format character, direction mark and quote taken out, so it cannot close the quote early or reorder the text', async () => {
    // A name that tries both: invisible and direction characters (U+061C, U+FEFF, U+2060 to U+2064, U+202E, U+2066), and a closing quote that would end ours and make the rest read as Ludy's own words.
    const nasty = 'Dy\u202e”\u061c đã được duyệt bởi quản lý \ufeff“\u2060\u2064\u2066x\u00ad\n';
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE], 'company', 'client.example.com', '', nasty);
    const made = await propose(grantActor('owner', grant, ['ludy.read', ENGAGE]));
    const row = (await q<{ title: string }>(`SELECT title FROM crove_kernel.proposal WHERE id = $1`, [made.proposalId])).rows[0];
    expect(row?.title).toBe('Ứng dụng AI “Dy đã được duyệt bởi quản lý x” đề xuất: ads.kind_ads_cap_set');
    expect(row?.title.match(/[“”]/g)?.length).toBe(2);
    expect(row?.title).not.toMatch(/[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\u00ad]/);
  });

  it('refuses the insert when the database\'s own reading of the approvers is empty, whatever list the caller passes', async () => {
    // An org whose only owner was demoted: nobody holds the approval roles, so the snapshot the database stamps is empty and the guard refuses the row (a context sealed before the demotion included).
    const lone = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'mcp-proposals', subject: 'lone', email: 'lone@mcp-proposals.test', name: 'lone' });
    users.lone = lone;
    const orgC = (await createOrg(runtime, { type: 'user', userId: lone, aal: 'aal1' }, 'Org C')).orgId;
    const grant = await insertGrant(orgC, 'lone', ['ludy.read', ENGAGE]);
    const row = [orgC, 'ads.kind_ads_cap_set', 'ads.cap.set', 't', '{}', [lone], JSON.stringify([{ type: 'agent', id: grant, run: grant }, { type: 'user', id: lone }]), grant];
    const text = `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors, tainted, requested_by_grant, mcp_client_name, mcp_client_host) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, 'x', 'x')`;
    await inContext(proposalCtx(orgC, grant, 'lone'), async (c) => expect(await attempt(c, text, row), 'with an approver').toBe('ok'));
    // The last-owner guard refuses this demotion, so the test (a superuser) sets the role with triggers skipped: it makes the state, which no command could reach, in which the database reads no approver.
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [orgC, lone]);
    });
    await inContext(proposalCtx(orgC, grant, 'lone'), async (c) => expect(await attempt(c, text, row), 'a caller list that names someone, an empty database list').toMatch(/AGENT_FORBIDDEN/));
  });

  it('refuses a person the proposer, the approval of an MCP actor, and any edit or rejection by one: nothing but a person decides', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    const actor = grantActor('owner', grant, ['ludy.read', ENGAGE]);
    expect((await refusal(runtime.execute('kernel.mcp.propose', { command: 'ads.cap.set', payload: { text: 'x' } }, { actor: browser('owner'), orgId: orgA }))).status).toBe(403);
    const made = await propose(actor);
    for (const name of ['kernel.proposal.approve', 'kernel.proposal.reject', 'kernel.proposal.edit', 'kernel.proposal.approve_many']) {
      const e = await refusal(runtime.execute(name, { id: made.proposalId, revision: 1, ids: [made.proposalId] }, { actor, orgId: orgA }));
      expect(e.status, name).toBeGreaterThanOrEqual(400);
    }
    expect((await q(`SELECT status FROM crove_kernel.proposal WHERE id = $1`, [made.proposalId])).rows[0]?.status).toBe('pending');
    expect(ran.filter((r) => r.name !== 'kernel.test.direct')).toEqual([]);
  });

  it('runs the command once, with the stored payload, only when a person approves in Ludy (R2 and R3), and an approval claimed in the input counts for nothing', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE, ADS]);
    const actor = grantActor('owner', grant, ['ludy.read', ENGAGE, ADS]);
    for (const [name, text] of [['ads.budget.raise', 'R2 việc'], ['ads.cap.set', 'R3 việc']] as const) {
      ran.length = 0;
      const made = await propose(actor, name, { text, approved: true });
      expect(ran).toEqual([]);
      const revision = (await q(`SELECT revision FROM crove_kernel.proposal WHERE id = $1`, [made.proposalId])).rows[0]?.revision as number;
      await runtime.execute('kernel.proposal.approve', { id: made.proposalId, revision }, { actor: browser('owner', true), orgId: orgA });
      expect(ran).toEqual([{ name, input: { text, approved: true } }]);
      const done = (await q(`SELECT status, decided_by, requested_by_grant FROM crove_kernel.proposal WHERE id = $1`, [made.proposalId])).rows[0];
      expect(done).toMatchObject({ status: 'executed', decided_by: users.owner, requested_by_grant: grant });
    }
  });

  it('shows the client and its host on the Inbox card, and nothing for a proposal a person made', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE], 'company', 'card.example.net');
    const second = await insertGrant(orgB, 'foreign', ['ludy.read', ENGAGE], 'company', 'other.example.net');
    await propose(grantActor('foreign', second, ['ludy.read', ENGAGE]), 'ads.cap.set', { text: 'b' }, orgB);
    const mine = await propose(grantActor('owner', grant, ['ludy.read', ENGAGE]));
    const list = await runtime.query<Array<{ id: string; requestedByMcp: { client: string; host: string } | null }>>('kernel.inbox.list', {}, { actor: browser('owner'), orgId: orgA });
    const card = list.find((i) => i.id === mine.proposalId);
    expect(card?.requestedByMcp).toEqual({ client: 'Dy', host: 'card.example.net' });
    // Another org's owner never sees it.
    const theirs = await runtime.query<Array<{ id: string }>>('kernel.inbox.list', {}, { actor: browser('foreign'), orgId: orgB });
    expect(theirs.map((i) => i.id)).not.toContain(mine.proposalId);
  });

  // ---- the database, with the sealed contexts written by the superuser in the exact shape the entries write --------------------------------------------------------------------------------------------------
  type Sealed = Record<string, unknown>;
  const proposalCtx = (org: string, grant: string, who = 'owner', scope = ENGAGE): Sealed => ({
    v: 1, org, actor: 'agent', user: null, role: 'owner', agent: grant, run: null, position: null, module: 'kernel', max_risk: 'R1', tainted: true, le_scope: ['*'], flags: [], kind: 'mcp_company_proposal', grantor: users[who], scope,
  });
  async function inContext<T>(ctx: Sealed, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.ctx_write($1::jsonb)', [JSON.stringify(ctx)]);
      await c.query('SET LOCAL ROLE crove_tenant');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }
  const attempt = async (c: pg.Client, text: string, params: unknown[] = []): Promise<string> => {
    await c.query('SAVEPOINT a');
    try {
      const r = await c.query(text, params);
      await c.query('ROLLBACK TO a');
      return r.rowCount === 0 ? 'no rows' : 'ok';
    } catch (error) {
      await c.query('ROLLBACK TO a');
      return (error as { message: string }).message;
    }
  };

  it('lets the sealed proposal context insert one pending proposal of one exact shape, and refuses every deviation, every update and delete, and every other table', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    const insert = (over: Record<string, unknown> = {}, command = 'ads.cap.set') => {
      const row: Record<string, unknown> = {
        org_id: orgA, kind: 'ads.kind_ads_cap_set', command, title: 't', payload: '{}', eligible_approvers: [users.owner], authors: JSON.stringify([{ type: 'agent', id: grant, run: grant }, { type: 'user', id: users.owner }]), tainted: true,
        requested_by_grant: grant, mcp_client_name: 'Dy', mcp_client_host: 'h', ...over,
      };
      const cols = Object.keys(row);
      return [`INSERT INTO crove_kernel.proposal (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING`, Object.values(row)] as const;
    };
    await inContext(proposalCtx(orgA, grant), async (c) => {
      expect(await attempt(c, ...insert()), 'the exact shape').toBe('ok');
      // The approver snapshot, the title and the client are the database's: forged ones are replaced, a kind other than the catalog's is refused.
      await c.query('SAVEPOINT forged');
      const forged = insert({ eligible_approvers: [users.member], title: 'Đã được duyệt bởi người quản lý', mcp_client_name: 'Giả', mcp_client_host: 'evil.test' });
      const stored = await c.query<{ eligible_approvers: string[]; title: string; mcp_client_name: string; mcp_client_host: string }>(`${forged[0].replace(' ON CONFLICT DO NOTHING', '')} RETURNING eligible_approvers, title, mcp_client_name, mcp_client_host`, [...forged[1]]);
      expect(stored.rows[0]?.eligible_approvers, 'a forged approver snapshot is replaced by the database\'s own reading').toEqual([users.owner]);
      expect(stored.rows[0]?.title).toBe('Ứng dụng AI “Dy” đề xuất: ads.kind_ads_cap_set');
      expect([stored.rows[0]?.mcp_client_name, stored.rows[0]?.mcp_client_host]).toEqual(['Dy', 'client.example.com']);
      await c.query('ROLLBACK TO forged');
      expect(await attempt(c, ...insert({ kind: 'ads.kind_other' })), 'a kind the catalog did not fix').toMatch(/AGENT_FORBIDDEN/);
      const deviations: Array<[string, Record<string, unknown>, string?]> = [
        ['status approved', { status: 'approved' }],
        ['status executed', { status: 'executed' }],
        ['decided by a person', { decided_by: users.owner, decided_at: new Date().toISOString() }],
        ['not tainted', { tainted: false }],
        ['a human author', { authors: JSON.stringify([{ type: 'user', id: users.owner }]) }],
        ['the grant alone as author', { authors: JSON.stringify([{ type: 'agent', id: grant, run: grant }]) }],
        ['another person as the user author', { authors: JSON.stringify([{ type: 'agent', id: grant, run: grant }, { type: 'user', id: users.member }]) }],
        ['three authors', { authors: JSON.stringify([{ type: 'agent', id: grant, run: grant }, { type: 'user', id: users.owner }, { type: 'user', id: users.member }]) }],
        ['a request input', { request_input: '{}' }],
        ['a far-future creation time', { created_at: new Date(Date.now() + 86_400_000 * 400).toISOString() }],
        ['another grant\'s author', { authors: JSON.stringify([{ type: 'agent', id: randomUUID(), run: randomUUID() }]) }],
        ['another grant', { requested_by_grant: randomUUID() }],
        ['no grant', { requested_by_grant: null, mcp_client_name: null, mcp_client_host: null }],
        ['policy flags', { policy_flags: ['P03'] }],
        ['an executed command id', { executed_command_id: randomUUID() }],
        ['a result', { result: '{}' }],
        ['revision 2', { revision: 2 }],
        ['an agent run', { requested_by_agent: randomUUID() }],
        ['co-authors', { co_authors: [users.owner] }],
      ];
      for (const [label, over] of deviations) expect(await attempt(c, ...insert(over)), label).not.toBe('ok');
      // A command whose approval policy names nobody, even in the exact shape.
      expect(await attempt(c, ...insert({}, 'kernel.test.no_policy')), 'no approval policy').toMatch(/AGENT_FORBIDDEN/);
      // The database keeps the grant's scope to its line's commands: ads.cap.set is listed under the engage scope, so a context entered for the ads scope inserts none of it, and a command the catalog does not list
      // at all (a real one, with an approval policy) is refused under any scope.
      await inContext(proposalCtx(orgA, grant, 'owner', ADS), async (other) => expect(await attempt(other, ...insert()), 'a command of another scope').toMatch(/AGENT_FORBIDDEN/));
      await inContext(proposalCtx(orgA, grant), async (other) => expect(await attempt(other, ...insert({}, 'finance.supplier_payment.record')), 'a command outside the catalog').toMatch(/AGENT_FORBIDDEN/));
      // Nothing but that insert: no update, no delete, no other table.
      expect(await attempt(c, `UPDATE crove_kernel.proposal SET status = 'approved' WHERE org_id = $1`, [orgA])).toMatch(/AGENT_FORBIDDEN|no rows/);
      expect(await attempt(c, `DELETE FROM crove_kernel.proposal WHERE org_id = $1`, [orgA])).toMatch(/AGENT_FORBIDDEN|no rows/);
      expect(await attempt(c, `INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'x')`, [orgA])).toMatch(/AGENT_FORBIDDEN/);
      expect(await attempt(c, `INSERT INTO crove_kernel.conversation_note (org_id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, 'x')`, [orgA, randomUUID(), users.owner])).not.toBe('ok');
    });
    // No other agent context gains the right: the read context of a company grant, a member grant's, the draft context and an org-chart-shaped agent context all refuse the very same row.
    const same = insert();
    const others: Array<[string, Sealed]> = [
      ['company read', { ...proposalCtx(orgA, grant), kind: 'mcp_company', max_risk: 'R0' }],
      ['company draft', { ...proposalCtx(orgA, grant), kind: 'mcp_company_draft' }],
      ['member', { ...proposalCtx(orgA, grant), kind: 'mcp_member', grantor: undefined, member: users.owner, max_risk: 'R0' }],
      ['org-chart agent', { ...proposalCtx(orgA, grant), kind: undefined, grantor: undefined, run: randomUUID(), position: randomUUID() }],
    ];
    for (const [label, ctx] of others) await inContext(ctx, async (c) => expect(await attempt(c, ...same), label).toMatch(/AGENT_FORBIDDEN/));
    // A person's own context still writes proposals as before (the control).
    await inContext({ v: 1, org: orgA, actor: 'user', user: users.owner, role: 'owner', le_scope: ['*'], flags: [] }, async (c) => expect(await attempt(c, ...insert({ requested_by_grant: null, mcp_client_name: null, mcp_client_host: null, authors: JSON.stringify([{ type: 'user', id: users.owner }]) }))).toBe('ok'));
  });

  it('inserts nothing for a grant that no longer stands: revoked, or its org stopped by a kill switch, even with a context sealed before', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    const row = [orgA, 'ads.kind_ads_cap_set', 'ads.cap.set', 't', '{}', [users.owner], JSON.stringify([{ type: 'agent', id: grant, run: grant }, { type: 'user', id: users.owner }]), grant];
    const text = `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors, tainted, requested_by_grant, mcp_client_name, mcp_client_host) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, 'x', 'x')`;
    await inContext(proposalCtx(orgA, grant), async (c) => expect(await attempt(c, text, row)).toBe('ok'));
    await q(`UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1`, [grant]);
    await inContext(proposalCtx(orgA, grant), async (c) => expect(await attempt(c, text, row)).toBe('MCP_GRANT_INVALID'));
    const live = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    await q(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1::uuid, 'org', '*', $2)`, [orgA, users.owner]);
    try {
      await inContext(proposalCtx(orgA, live), async (c) => expect(await attempt(c, text, [...row.slice(0, 6), JSON.stringify([{ type: 'agent', id: live, run: live }, { type: 'user', id: users.owner }]), live])).toBe('MCP_GRANT_INVALID'));
    } finally {
      await q(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1 AND released_at IS NULL`, [orgA, users.owner]);
    }
  });

  it('keeps the provenance of an MCP proposal for good: neither the grant nor the client can be changed, by anyone', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    const made = await propose(grantActor('owner', grant, ['ludy.read', ENGAGE]));
    for (const set of ['requested_by_grant = NULL', `mcp_client_name = 'Khác'`, `mcp_client_host = 'x.test'`]) {
      await expect(q(`UPDATE crove_kernel.proposal SET ${set} WHERE id = $1`, [made.proposalId]), set).rejects.toThrow();
    }
  });

  it('refuses the proposal entry to a grant that is not a company grant holding the named scope, to a made-up scope, and to a read-only transaction', async () => {
    const entry = async (grantId: string, scope: string, readOnly = false) => {
      const url = new URL(adminUrl);
      url.username = 'crove_app';
      url.password = 'test-app-pw';
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      try {
        await c.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
        return await c.query('SELECT crove_kernel.enter_mcp_company_proposal_context($1::uuid, $2::uuid, $3::text)', [orgA, grantId, scope]).then(() => 'entered', (e: Error) => e.message);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    const holds = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    expect(await entry(holds, ENGAGE)).toBe('entered');
    expect(await entry(holds, ADS)).toBe('MCP_GRANT_SCOPE');
    expect(await entry(holds, 'ludy.read')).toBe('MCP_GRANT_SCOPE');
    expect(await entry(holds, 'ludy.anything')).toBe('MCP_GRANT_SCOPE');
    expect(await entry(holds, ENGAGE, true)).toBe('MCP_WRITE_READ_ONLY');
    expect(await entry(await insertGrant(orgA, 'owner', ['ludy.member.read'], 'member'), ENGAGE)).toBe('MCP_GRANT_NOT_COMPANY');
    expect(await entry(randomUUID(), ENGAGE)).toBe('MCP_GRANT_INVALID');
  });

  it('counts the grantor as an author, so four-eyes holds: with two admins the grantor cannot approve their own AI app\'s proposal alone, the other admin can, and a sole approver uses the one-person path', async () => {
    const admin2 = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'mcp-proposals', subject: 'admin2', email: 'admin2@mcp-proposals.test', name: 'admin2' });
    users.admin2 = admin2;
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgA, admin2]);
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ADS]);
    const made = await propose(grantActor('owner', grant, ['ludy.read', ADS]), 'ads.budget.raise', { text: 'tăng ngân sách' });
    const revision = (await q(`SELECT revision FROM crove_kernel.proposal WHERE id = $1`, [made.proposalId])).rows[0]?.revision as number;
    const ownApproval = await refusal(runtime.execute('kernel.proposal.approve', { id: made.proposalId, revision }, { actor: browser('owner', true), orgId: orgA }));
    expect(ownApproval.code).toBe('FOUR_EYES_REQUIRED');
    ran.length = 0;
    await runtime.execute('kernel.proposal.approve', { id: made.proposalId, revision }, { actor: { type: 'user', userId: admin2, aal: 'aal2', mfaAt: Math.floor(Date.now() / 1000) }, orgId: orgA });
    expect(ran).toEqual([{ name: 'ads.budget.raise', input: { text: 'tăng ngân sách' } }]);
    // Back to one eligible approver for the later cases.
    await q(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgA, admin2]).catch(() => undefined);
  });

  it('caps pending proposals in the database: 20 per grant, 100 per org over all grants, and a decision frees room', async () => {
    const grant = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    const actor = grantActor('owner', grant, ['ludy.read', ENGAGE]);
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) ids.push((await propose(actor, 'ads.cap.set', { text: `n${i}` })).proposalId);
    expect(await pendingOf(grant)).toBe(20);
    const full = await refusal(propose(actor));
    expect([full.code, full.status]).toEqual(['MCP_PROPOSAL_CAP', 409]);
    expect(await pendingOf(grant)).toBe(20);
    // The cap is the grant's: a second grant of the org still makes its own.
    const second = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    await propose(grantActor('owner', second, ['ludy.read', ENGAGE]));
    // A person's rejection frees one place.
    await runtime.execute('kernel.proposal.reject', { id: ids[0], note: 'không' }, { actor: browser('owner', true), orgId: orgA });
    await propose(actor);
    expect(await pendingOf(grant)).toBe(20);
    // The org's cap: 100 pending proposals of grants in all. Fill to 100 with raw rows of fresh grants, and the next call of any grant is refused.
    const total = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.proposal WHERE org_id = $1 AND requested_by_grant IS NOT NULL AND status = 'pending'`, [orgA])).rows[0]?.n ?? 0;
    let need = 99 - total;
    while (need > 0) {
      const filler = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
      const take = Math.min(20, need);
      for (let i = 0; i < take; i += 1) await propose(grantActor('owner', filler, ['ludy.read', ENGAGE]), 'ads.cap.set', { text: `f${i}` });
      need -= take;
    }
    // 99 pending: two calls of two different grants at once make exactly one more (the org's cap is taken under one lock per org), and every later call is refused.
    const racers = await Promise.all(
      [await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]), await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE])].map((g) =>
        propose(grantActor('owner', g, ['ludy.read', ENGAGE])).then(() => 'made', (e: DomainError) => e.code),
      ),
    );
    expect(racers.sort()).toEqual(['MCP_PROPOSAL_CAP', 'made']);
    const fresh = await insertGrant(orgA, 'owner', ['ludy.read', ENGAGE]);
    const orgFull = await refusal(propose(grantActor('owner', fresh, ['ludy.read', ENGAGE])));
    expect(orgFull.code).toBe('MCP_PROPOSAL_CAP');
    // Another org is not counted.
    const fOrgB = await insertGrant(orgB, 'foreign', ['ludy.read', ENGAGE]);
    await propose(grantActor('foreign', fOrgB, ['ludy.read', ENGAGE]), 'ads.cap.set', { text: 'b' }, orgB);
  }, 240_000);

});

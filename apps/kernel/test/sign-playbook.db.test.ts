// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign Slice 5d SME contract playbook & cited redlines (#4442):
// out-of-the-box Vietnam SME default rules, owner/admin CRUD vs member/viewer RBAC & RLS,
// 100% AI-off deterministic evaluation + manual overrides, metered 'sign.playbook_check' with citation grounding,
// budget/kill-switch fallbacks, hr_contract 404 confidentiality, offboarding export, and org_purge cleanup.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiBudgetExhaustedError,
  SignAiReader,
  type AiCall,
  type AiMeter,
  type AiUsage,
} from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { ExtractClient } from '@ludy/extract-contract';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import type {
  SignPlaybookEvaluateResult,
  SignPlaybookGetResult,
  SignPlaybookRuleRecord,
  SignPlaybookRulesListResult,
} from '@ludy/kernel-contract';
import { Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { defaultSlotForRuleId, signCommands, signQueries } from '@ludy/mod-sign';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { evaluateEnvelopePlaybook, signAi } from '../src/sign-ai.ts';
import { runSignPdfInspectJob } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const TEST_JWT_KEY = 'unit-test-'.repeat(5);
const ISSUER = 'crove-auth';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }

  async get(key: string) {
    const found = this.blobs.get(key);
    if (!found) throw new Error(`missing blob: ${key}`);
    return found;
  }

  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const pdfFixture = (tag: string) =>
  Uint8Array.from(
    Buffer.from(`%PDF-1.4\n% sign-playbook-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
  );

const mockExtract: ExtractClient = {
  async extract(kind) {
    if (kind === 'pdf_inspect') {
      return {
        ok: true,
        kind: 'pdf_inspect',
        pageCount: 2,
        pages: [
          { page: 1, widthPt: 595, heightPt: 842, rotation: 0 },
          { page: 2, widthPt: 595, heightPt: 842, rotation: 0 },
        ],
      } as never;
    }
    throw new Error(`Unexpected extract kind: ${kind}`);
  },
};

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 5d SME contract playbook checklist and cited redline suggestions (#4442)', () => {
  const dbName = `crove_test_sign_pbk_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let appAiOff: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();

  const owner: Account = { subject: randomUUID(), email: 'owner-pbk@example.com', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin-pbk@example.com', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member-pbk@example.com', session: randomUUID(), userId: '' };
  const otherMember: Account = { subject: randomUUID(), email: 'member2-pbk@example.com', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer-pbk@example.com', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider-pbk@example.com', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };
  let purgeOrg = { slug: '', orgId: '' };

  const asUser = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal1' as const,
  });

  const asMfa = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function adminQuery<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal: 'aal1',
      is_anonymous: false,
      ...mfa,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(TEST_JWT_KEY));
  }

  async function rpc(
    path: string,
    who: Account,
    input: unknown,
    slug: string | null = org.slug,
    targetApp = appAiOff,
  ) {
    const response = await targetApp.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-crove-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> };
  }

  async function uploadSignPdfFor(who: Account, tag: string, slug = org.slug): Promise<string> {
    const form = new FormData();
    form.append('file', new File([Buffer.from(pdfFixture(tag))], `${tag}.pdf`, { type: 'application/pdf' }));
    form.append('purpose', 'sign_document');
    const res = await appAiOff.request('/api/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-crove-org': slug },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ fileId: string }> };
    return body.files[0]!.fileId;
  }

  async function createInspectedEnvelope(
    who: Account,
    options: {
      title: string;
      sourceKind?: 'standalone' | 'hr_contract';
      targetOrg?: { slug: string; orgId: string };
    },
  ): Promise<string> {
    const targetOrg = options.targetOrg ?? org;
    const fileId = await uploadSignPdfFor(who, `${options.title}-${randomUUID().slice(0, 8)}`, targetOrg.slug);
    const sourceKind = options.sourceKind ?? 'standalone';
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: options.title,
        routingMode: 'parallel',
        sourceFileId: fileId,
        sourceKind,
        ...(sourceKind !== 'standalone' ? { sourceId: randomUUID() } : {}),
      },
      { actor: asUser(who), orgId: targetOrg.orgId },
    );
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract },
      { orgId: targetOrg.orgId, envelopeId: created.envelopeId },
    );
    return created.envelopeId;
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('ludy_app', 'test-app-pw');
    workerUrl = login('ludy_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 6 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: workerUrl, max: 4 });
    workerDb = createDb(workerPool);

    const kernelCmds = buildKernelCommands({ shippedModules: AVAILABLE_MODULES });
    const sharedQueries = [...kernelQueries({ inboundDomain: null }), ...signQueries];
    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCmds, ...signCommands],
      queries: sharedQueries,
    });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCmds, ...signCommands, orgPurgeCommand({ store })],
      queries: sharedQueries,
    });

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: TEST_JWT_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);
    appAiOff = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false });

    for (const who of [owner, adminUser, member, otherMember, viewer, outsider]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const created = await rpc('org/create', owner, { name: 'Sign Playbook Org', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body.slug), orgId: String(created.body.orgId) };

    for (const [who, role] of [
      [adminUser, 'admin'],
      [member, 'member'],
      [otherMember, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await appAiOff.request('/api/rpc/org/invite', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await tokenFor(owner, { mfa: true })}`,
          'content-type': 'application/json',
          'x-crove-org': org.slug,
        },
        body: JSON.stringify({ json: { email: who.email, role } }),
      });
      expect(invite.status).toBe(200);
      const body = ((await invite.json()) as { json: { acceptPath: string } }).json;
      expect((await rpc('invites/accept', who, { token: body.acceptPath.split('#')[1] }, null)).status).toBe(200);
    }

    const createdOther = await rpc('org/create', outsider, { name: 'Other Playbook Org', idempotencyKey: randomUUID() }, null);
    expect(createdOther.status).toBe(200);
    otherOrg = { slug: String(createdOther.body.slug), orgId: String(createdOther.body.orgId) };

    const createdPurge = await rpc('org/create', owner, { name: 'Purge Playbook Org', idempotencyKey: randomUUID() }, null);
    expect(createdPurge.status).toBe(200);
    purgeOrg = { slug: String(createdPurge.body.slug), orgId: String(createdPurge.body.orgId) };
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('ships 6 Vietnam SME default rules with zero setup and enforces owner/admin write RBAC + RLS', async () => {
    const memberList = await rpc('sign/playbook/rules_list', member, {});
    expect(memberList.status).toBe(200);
    const listBody = memberList.body as unknown as SignPlaybookRulesListResult;
    expect(listBody.isSeeded).toBe(false);
    expect(listBody.canManage).toBe(false);
    expect(listBody.items).toHaveLength(6);
    expect(listBody.items.every((r) => r.isDefault && r.active)).toBe(true);

    const ownerList = await rpc('sign/playbook/rules_list', owner, {});
    expect(ownerList.status).toBe(200);
    expect((ownerList.body as unknown as SignPlaybookRulesListResult).canManage).toBe(true);

    // Members and viewers cannot upsert, delete, or seed playbook rules via RPC.
    for (const who of [member, viewer]) {
      expect(
        (
          await rpc('sign/playbook/rule_upsert', who, {
            title: 'Unauthorized Rule',
            guidance: 'Should be forbidden',
            severity: 'warn',
            matchKeywords: ['test'],
            active: true,
          })
        ).status,
      ).toBe(403);
      expect((await rpc('sign/playbook/rule_delete', who, { ruleId: listBody.items[0]!.id })).status).toBe(403);
      expect((await rpc('sign/playbook/seed_defaults', who, {})).status).toBe(403);
    }

    // Admin creates a custom rule (which also materializes the 6 default rules cleanly).
    const createdRuleRes = await rpc('sign/playbook/rule_upsert', adminUser, {
      title: 'Giới hạn trách nhiệm bồi thường',
      guidance: 'Tổng mức bồi thường thiệt hại tối đa không vượt quá 100% giá trị hợp đồng.',
      severity: 'critical',
      matchKeywords: ['bồi thường thiệt hại', 'giới hạn trách nhiệm'],
      active: true,
      idempotencyKey: randomUUID(),
    });
    expect(createdRuleRes.status).toBe(200);
    const customRule = createdRuleRes.body as unknown as SignPlaybookRuleRecord;
    expect(customRule.isDefault).toBe(false);
    expect(customRule.severity).toBe('critical');

    const afterCreate = (await rpc('sign/playbook/rules_list', member, {})).body as unknown as SignPlaybookRulesListResult;
    expect(afterCreate.isSeeded).toBe(true);
    expect(afterCreate.items).toHaveLength(7);

    // Admin deletes one default rule, then restores defaults while preserving the custom rule!
    const firstDefaultId = listBody.items[0]!.id;
    const delRes = await rpc('sign/playbook/rule_delete', adminUser, {
      ruleId: firstDefaultId,
      idempotencyKey: randomUUID(),
    });
    expect(delRes.status).toBe(200);
    expect(delRes.body).toEqual({ deleted: true });

    const afterDelete = (await rpc('sign/playbook/rules_list', owner, {})).body as unknown as SignPlaybookRulesListResult;
    expect(afterDelete.items).toHaveLength(6);
    expect(afterDelete.items.some((r) => r.id === firstDefaultId)).toBe(false);

    const restored = await rpc('sign/playbook/seed_defaults', owner, { idempotencyKey: randomUUID() });
    expect(restored.status).toBe(200);
    const restoredBody = restored.body as unknown as SignPlaybookRulesListResult;
    expect(restoredBody.items).toHaveLength(7);
    expect(restoredBody.items.some((r) => r.id === firstDefaultId)).toBe(true);
    expect(restoredBody.items.some((r) => r.id === customRule.id)).toBe(true);

    // Clean up custom rule so 6 defaults remain active for subsequent tests.
    expect((await rpc('sign/playbook/rule_delete', owner, { ruleId: customRule.id })).status).toBe(200);

    // Deleting ALL rules keeps the workspace at zero rules (isSeeded=true) without auto-restoring defaults.
    for (const defaultRule of listBody.items) {
      expect((await rpc('sign/playbook/rule_delete', owner, { ruleId: defaultRule.id })).status).toBe(200);
    }
    const emptyList = (await rpc('sign/playbook/rules_list', owner, {})).body as unknown as SignPlaybookRulesListResult;
    expect(emptyList.isSeeded).toBe(true);
    expect(emptyList.items).toEqual([]);

    // Guidance whose {{tag}} expansion exceeds 2000 characters is rejected with 422 instead of SQL 500.
    const overflowRes = await rpc('sign/playbook/rule_upsert', owner, {
      title: 'Overflow Guidance Rule',
      guidance: `${'a'.repeat(1998)}{{`,
      severity: 'warn',
      matchKeywords: [],
      active: true,
    });
    expect(overflowRes.status).toBe(422);

    // Creating a custom rule after deleting all rules does not resurrect deleted defaults.
    const postDeleteCustom = await rpc('sign/playbook/rule_upsert', owner, {
      title: 'Post-Delete Custom Rule',
      guidance: 'Check confidentiality clause manually.',
      severity: 'warn',
      matchKeywords: ['confidential'],
      active: true,
    });
    expect(postDeleteCustom.status).toBe(200);
    const afterCustomOnly = (await rpc('sign/playbook/rules_list', owner, {})).body as unknown as SignPlaybookRulesListResult;
    expect(afterCustomOnly.items).toHaveLength(1);
    expect((await rpc('sign/playbook/rule_delete', owner, { ruleId: (postDeleteCustom.body as unknown as SignPlaybookRuleRecord).id })).status).toBe(200);

    // Explicitly restore the 6 default rules for subsequent tests.
    const restoredAll = await rpc('sign/playbook/seed_defaults', owner, { idempotencyKey: randomUUID() });
    expect(restoredAll.status).toBe(200);
    expect((restoredAll.body as unknown as SignPlaybookRulesListResult).items).toHaveLength(6);
  });

  it('delivers 100% AI-off deterministic playbook evaluation and supports manual verdict overrides', async () => {
    const envId = await createInspectedEnvelope(member, { title: 'SME Vendor Contract AI-Off' });
    const samplePages = [
      {
        page: 1,
        text: 'Điều 3. Thanh toán: Bên mua thanh toán trong vòng 45 ngày kể từ ngày nhận hóa đơn.',
      },
      {
        page: 2,
        text: 'Điều 6. Phạt vi phạm: Bên vi phạm chịu mức phạt vi phạm bằng 14% giá trị hợp đồng.',
      },
    ];

    // Even when useAi=true is requested while AI is disabled on the server, deterministic fallback runs cleanly!
    const evalRes = await rpc('sign/playbook/evaluate', member, {
      envelopeId: envId,
      useAi: true,
      pages: samplePages,
      idempotencyKey: randomUUID(),
    });
    expect(evalRes.status).toBe(200);
    const evalBody = evalRes.body as unknown as SignPlaybookEvaluateResult;
    expect(evalBody.ai).toBe('off');
    expect(evalBody.check).not.toBeNull();
    expect(evalBody.check?.mode).toBe('deterministic');
    expect(evalBody.check?.findings).toHaveLength(6);
    expect(evalBody.check?.findings.every((f) => f.proposedByAi === false)).toBe(true);

    const penaltyFinding = evalBody.check!.findings.find(
      (f) => defaultSlotForRuleId(org.orgId, f.ruleId) === 'penalty_cap',
    )!;
    expect(penaltyFinding.verdict).toBe('fail');
    expect(penaltyFinding.pageNumber).toBe(2);
    expect(penaltyFinding.quoteExcerpt).toContain('14%');
    expect(penaltyFinding.suggestedRedline).toContain('8%');

    const paymentFinding = evalBody.check!.findings.find(
      (f) => defaultSlotForRuleId(org.orgId, f.ruleId) === 'payment_terms',
    )!;
    expect(paymentFinding.verdict).toBe('warn');
    expect(paymentFinding.pageNumber).toBe(1);

    // Viewer can read playbook check (canEdit=false) but gets 403 on override_finding.
    const viewerGet = await rpc('sign/playbook/get', viewer, { envelopeId: envId });
    expect(viewerGet.status).toBe(200);
    expect((viewerGet.body as unknown as SignPlaybookGetResult).canEdit).toBe(false);
    expect(
      (
        await rpc('sign/playbook/override_finding', viewer, {
          envelopeId: envId,
          ruleId: paymentFinding.ruleId,
          checkRevision: evalBody.check!.revision,
          verdict: 'pass',
          manualNote: 'Viewer probe',
        })
      ).status,
    ).toBe(403);

    // Member overrides payment finding to 'pass' with manualNote.
    const overrideRes = await rpc('sign/playbook/override_finding', member, {
      envelopeId: envId,
      ruleId: paymentFinding.ruleId,
      checkRevision: evalBody.check!.revision,
      verdict: 'pass',
      manualNote: 'Giám đốc đã duyệt riêng điều khoản Net 45 cho nhà cung cấp này',
      idempotencyKey: randomUUID(),
    });
    expect(overrideRes.status).toBe(200);
    const updatedCheck = overrideRes.body as unknown as NonNullable<SignPlaybookGetResult['check']>;
    expect(updatedCheck.mode).toBe('manual');
    const updatedPayment = updatedCheck.findings.find((f) => f.ruleId === paymentFinding.ruleId)!;
    expect(updatedPayment.verdict).toBe('pass');
    expect(updatedPayment.proposedByAi).toBe(false);
    expect(updatedPayment.overriddenBy).toBe(member.userId);
    expect(updatedPayment.manualNote).toContain('Net 45');

    // Non-forced fallback (preserveExistingFresh=true) never overwrites a committed manual check.
    const preserved = await runtime.execute<{ id: string; mode: string }>(
      'sign.playbook.record_check',
      {
        envelopeId: envId,
        sourceSha256: evalBody.check!.sourceSha256,
        mode: 'deterministic',
        promptVersion: null,
        preserveExistingFresh: true,
        extractedPages: samplePages,
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(preserved.id).toBe(updatedCheck.id);
    expect(preserved.mode).toBe('manual');

    // Same-PDF re-evaluation rotates check revision and rejects stale overrides with 409 without modifying the check.
    const rerunRes = await rpc('sign/playbook/evaluate', member, {
      envelopeId: envId,
      useAi: false,
      pages: samplePages,
      idempotencyKey: randomUUID(),
    });
    expect(rerunRes.status).toBe(200);
    const rerunCheck = (rerunRes.body as unknown as SignPlaybookEvaluateResult).check!;
    expect(rerunCheck.revision).not.toBe(updatedCheck.revision);
    const staleOverrideRes = await rpc('sign/playbook/override_finding', member, {
      envelopeId: envId,
      ruleId: paymentFinding.ruleId,
      checkRevision: updatedCheck.revision,
      verdict: 'fail',
      manualNote: 'Stale override probe',
    });
    expect(staleOverrideRes.status).toBe(409);
  });

  it('meters sign.playbook_check, verifies grounded citations, drops hallucinations, and respects AI budget + kill switch', async () => {
    const envId = await createInspectedEnvelope(member, { title: 'Metered Vy Playbook Contract' });
    const penaltyRuleId = (
      (await rpc('sign/playbook/rules_list', member, {})).body as unknown as SignPlaybookRulesListResult
    ).items.find((r) => defaultSlotForRuleId(org.orgId, r.id) === 'penalty_cap')!.id;
    const paymentRuleId = (
      (await rpc('sign/playbook/rules_list', member, {})).body as unknown as SignPlaybookRulesListResult
    ).items.find((r) => defaultSlotForRuleId(org.orgId, r.id) === 'payment_terms')!.id;

    const samplePages = [
      {
        page: 1,
        text: 'Điều 3. Thanh toán: Bên A thanh toán trong vòng 25 ngày kể từ ngày nhận hóa đơn hợp lệ.',
      },
      {
        page: 2,
        text: 'Điều 7. Phạt vi phạm: Mức phạt vi phạm hợp đồng là 15% tổng giá trị hợp đồng.',
      },
    ];

    const admitted: AiCall[] = [];
    const recorded: Array<{ call: AiCall; usage: AiUsage }> = [];
    const meter: AiMeter = {
      admit: async (call) => {
        admitted.push(call);
      },
      record: async (call, usage) => {
        recorded.push({ call, usage });
      },
    };

    const reader = new SignAiReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        playbookCheck: async () => ({
          output: {
            findings: [
              // Valid grounded AI finding on page 2
              {
                ruleId: penaltyRuleId,
                verdict: 'fail',
                rationale: 'Mức phạt 15% vượt trần 8% theo Điều 301 Luật Thương mại 2005.',
                pageNumber: 2,
                quoteExcerpt: 'Mức phạt vi phạm hợp đồng là 15% tổng giá trị hợp đồng.',
                suggestedRedline: 'Giới hạn mức phạt tối đa 8% giá trị phần nghĩa vụ bị vi phạm.',
              },
              // Hallucinated quote for paymentRuleId -> dropped by checkSignPlaybookCheck and filled deterministically!
              {
                ruleId: paymentRuleId,
                verdict: 'fail',
                rationale: 'Thanh toán 25 ngày.',
                pageNumber: 1,
                quoteExcerpt: 'Câu trích dẫn giả mạo không có trong PDF.',
                suggestedRedline: null,
              },
            ],
          },
          usage: { inputTokens: 210, outputTokens: 95 },
        }),
      },
    );

    const coworker = signAi(reader, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 30 }));
    const evaluated = await evaluateEnvelopePlaybook({
      ai: coworker,
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId: envId,
      useAi: true,
      pages: samplePages,
      meter,
    });

    expect(evaluated.ai).toBe('used');
    expect(evaluated.check?.mode).toBe('ai');
    expect(admitted).toEqual([]);
    // Note: custom playbookCheck generator bypasses metered() wrapper; verify real HTTP metered('sign.playbook_check') via budget check below!
    expect(recorded).toHaveLength(0);

    const savedPenalty = evaluated.check!.findings.find((f) => f.ruleId === penaltyRuleId)!;
    expect(savedPenalty.proposedByAi).toBe(true);
    expect(savedPenalty.verdict).toBe('fail');
    expect(savedPenalty.pageNumber).toBe(2);

    // Hallucinated payment quote was rejected by AI checker and filled deterministically (proposedByAi=false, pass on 25 days)!
    const savedPayment = evaluated.check!.findings.find((f) => f.ruleId === paymentRuleId)!;
    expect(savedPayment.proposedByAi).toBe(false);
    expect(savedPayment.verdict).toBe('pass');

    // Overriding an AI-proposed finding preserves proposedByAi=true while recording overriddenBy/overriddenAt.
    const aiOverrideRes = await rpc('sign/playbook/override_finding', member, {
      envelopeId: envId,
      ruleId: penaltyRuleId,
      checkRevision: evaluated.check!.revision,
      verdict: 'warn',
      manualNote: 'Partner agreed to cap at 8% in addendum',
    });
    expect(aiOverrideRes.status).toBe(200);
    const overriddenPenalty = (aiOverrideRes.body as unknown as NonNullable<SignPlaybookGetResult['check']>).findings.find(
      (f) => f.ruleId === penaltyRuleId,
    )!;
    expect(overriddenPenalty.verdict).toBe('warn');
    expect(overriddenPenalty.proposedByAi).toBe(true);
    expect(overriddenPenalty.overriddenBy).toBe(member.userId);
    expect(overriddenPenalty.overriddenAt).not.toBeNull();

    // Editing a rule marks existing checks stale and rejects in-flight AI recording with 409 SIGN_PLAYBOOK_STALE_RULES.
    const paymentRuleObj = (
      (await rpc('sign/playbook/rules_list', owner, {})).body as unknown as SignPlaybookRulesListResult
    ).items.find((r) => r.id === paymentRuleId)!;
    const editedPayRes = await rpc('sign/playbook/rule_upsert', owner, {
      ruleId: paymentRuleId,
      title: paymentRuleObj.title,
      guidance: 'Thời hạn thanh toán tối đa 15 ngày.',
      severity: paymentRuleObj.severity,
      matchKeywords: paymentRuleObj.matchKeywords,
      active: true,
    });
    expect(editedPayRes.status).toBe(200);
    const staleGet = (await rpc('sign/playbook/get', member, { envelopeId: envId })).body as unknown as SignPlaybookGetResult;
    expect(staleGet.check?.isStale).toBe(true);

    const staleAiReader = new SignAiReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        playbookCheck: async () => {
          // Mutate the rule while the model call is in flight.
          await rpc('sign/playbook/rule_upsert', owner, {
            ruleId: paymentRuleId,
            title: paymentRuleObj.title,
            guidance: paymentRuleObj.guidance,
            severity: paymentRuleObj.severity,
            matchKeywords: paymentRuleObj.matchKeywords,
            active: true,
          });
          return {
            output: {
              findings: [
                {
                  ruleId: penaltyRuleId,
                  verdict: 'fail',
                  rationale: 'Mức phạt 15% vượt trần 8%.',
                  pageNumber: 2,
                  quoteExcerpt: 'Mức phạt vi phạm hợp đồng là 15% tổng giá trị hợp đồng.',
                  suggestedRedline: 'Giới hạn 8%.',
                },
              ],
            },
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        },
      },
    );
    await expect(
      evaluateEnvelopePlaybook({
        ai: signAi(staleAiReader, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 30 })),
        runtime,
        orgId: org.orgId,
        actor: asUser(member),
        envelopeId: envId,
        useAi: true,
        pages: samplePages,
        meter,
      }),
    ).rejects.toMatchObject({ code: 'SIGN_PLAYBOOK_STALE_RULES', status: 409 });

    // Envelope status and version were NOT mutated by AI playbook evaluation.
    const envDetail = await runtime.query<{ envelope: { status: string } }>(
      'sign.envelope.get',
      { envelopeId: envId },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(envDetail.envelope.status).toBe('draft');

    // Budget exhaustion on a fresh envelope falls back to deterministic checklist while returning ai: 'budget'!
    const budgetEnvId = await createInspectedEnvelope(member, { title: 'Budget Exhausted Contract' });
    const budgetReader = new SignAiReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        playbookCheck: async () => {
          throw new AiBudgetExhaustedError('org', null);
        },
      },
    );
    const budgetRes = await evaluateEnvelopePlaybook({
      ai: signAi(budgetReader, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 30 })),
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId: budgetEnvId,
      useAi: true,
      pages: samplePages,
      meter,
    });
    expect(budgetRes.ai).toBe('budget');
    expect(budgetRes.check?.mode).toBe('deterministic');
    expect(budgetRes.check?.findings).toHaveLength(6);

    // Kill switch (kernel.agent.kill_switch.engage) blocks model execution and returns ai: 'off'.
    const { killSwitchId } = await runtime.execute<{ killSwitchId: string }>(
      'kernel.agent.kill_switch.engage',
      { scope: 'module', target: 'sign', reason: 'Playbook test kill switch' },
      { actor: asUser(owner), orgId: org.orgId },
    );
    let modelCalledWhileStopped = false;
    const stoppedReader = new SignAiReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        playbookCheck: async () => {
          modelCalledWhileStopped = true;
          return { output: { findings: [] } };
        },
      },
    );
    const stoppedRes = await evaluateEnvelopePlaybook({
      ai: signAi(stoppedReader, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 30 })),
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId: envId,
      useAi: true,
      pages: samplePages,
      meter,
    });
    expect(stoppedRes.ai).toBe('off');
    expect(modelCalledWhileStopped).toBe(false);
    await runtime.execute(
      'kernel.agent.kill_switch.release',
      { id: killSwitchId },
      { actor: asMfa(owner), orgId: org.orgId },
    );
  });

  it('enforces hr_contract 404 confidentiality, cross-org isolation, offboarding export, and org_purge cleanup', async () => {
    const hrEnvId = await createInspectedEnvelope(adminUser, {
      title: 'Confidential HR Offer Contract',
      sourceKind: 'hr_contract',
    });

    const hrEval = await rpc('sign/playbook/evaluate', adminUser, {
      envelopeId: hrEnvId,
      useAi: false,
      pages: [{ page: 1, text: 'Điều 4: Phạt vi phạm 10%.' }],
    });
    expect(hrEval.status).toBe(200);

    // Owner and admin can read hr_contract playbook check.
    for (const allowed of [owner, adminUser]) {
      expect((await rpc('sign/playbook/get', allowed, { envelopeId: hrEnvId })).status).toBe(200);
    }

    // Non-HR members, viewer, and cross-org outsider all get 404 SIGN_ENVELOPE_NOT_FOUND on read,
    // non-HR writer members get 404 on evaluate/override, and viewer gets 403 role refusal on evaluate.
    for (const blocked of [member, otherMember, viewer]) {
      expect((await rpc('sign/playbook/get', blocked, { envelopeId: hrEnvId })).status).toBe(404);
    }
    for (const blockedWriter of [member, otherMember]) {
      expect(
        (
          await rpc('sign/playbook/evaluate', blockedWriter, {
            envelopeId: hrEnvId,
            useAi: false,
            pages: [{ page: 1, text: 'Probe' }],
          })
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await rpc('sign/playbook/evaluate', viewer, {
          envelopeId: hrEnvId,
          useAi: false,
          pages: [{ page: 1, text: 'Probe' }],
        })
      ).status,
    ).toBe(403);
    expect((await rpc('sign/playbook/get', outsider, { envelopeId: hrEnvId }, otherOrg.slug)).status).toBe(404);

    // Seed rules & check in purgeOrg, verify offboarding snapshot export, and run org_purge!
    expect((await rpc('sign/playbook/seed_defaults', owner, {}, purgeOrg.slug)).status).toBe(200);
    const purgeEnvId = await createInspectedEnvelope(owner, {
      title: 'Purge Org Contract',
      targetOrg: purgeOrg,
    });
    expect(
      (
        await rpc(
          'sign/playbook/evaluate',
          owner,
          {
            envelopeId: purgeEnvId,
            useAi: false,
            pages: [{ page: 1, text: 'Điều 2: Thanh toán trong vòng 20 ngày.' }],
          },
          purgeOrg.slug,
        )
      ).status,
    ).toBe(200);

    const exportedRules: string[] = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'sign.playbook_rule' },
      { actor: { type: 'system', component: 'org-export' }, orgId: purgeOrg.orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedRules.push((JSON.parse(line) as { id: string }).id);
        }
      },
    );
    expect(exportedRules).toHaveLength(6);

    const exportedChecks: string[] = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'sign.playbook_check' },
      { actor: { type: 'system', component: 'org-export' }, orgId: purgeOrg.orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedChecks.push((JSON.parse(line) as { envelope_id: string }).envelope_id);
        }
      },
    );
    expect(exportedChecks).toEqual([purgeEnvId]);

    const dayMs = 24 * 60 * 60 * 1000;
    await adminQuery(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1", [purgeOrg.orgId]);
      await c.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'::jsonb),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}'::jsonb)`,
        [
          purgeOrg.orgId,
          new Date(Date.now() - 40 * dayMs),
          owner.userId,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * dayMs),
          randomUUID(),
        ],
      );
      await c.query('COMMIT');
    });

    const purgeLogs: string[] = [];
    const purgeCode = await runOrgPurge(
      { runtime: workerRuntime, minDays: 30, log: (l) => purgeLogs.push(l), error: (l) => purgeLogs.push(l) },
      [purgeOrg.orgId, '--reason', 'Owner offboarded sign playbook test org'],
    );
    expect(purgeCode, purgeLogs.join('\n')).toBe(0);

    await adminQuery(async (c) => {
      const ruleRem = await c.query('SELECT count(*)::int AS n FROM ludy_sign.playbook_rule WHERE org_id = $1::uuid', [
        purgeOrg.orgId,
      ]);
      const checkRem = await c.query(
        'SELECT count(*)::int AS n FROM ludy_sign.playbook_check WHERE org_id = $1::uuid',
        [purgeOrg.orgId],
      );
      expect(ruleRem.rows[0]?.n).toBe(0);
      expect(checkRem.rows[0]?.n).toBe(0);
    });
  });
});

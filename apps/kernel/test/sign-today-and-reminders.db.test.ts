// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign Slice 3c (#3813):
// 1) sign.today and kernel.today deterministic 48h expiring + 14d declined envelopes, strict hr_contract confidentiality
//    (owner/admin/creator only; ordinary members and viewers never see another employee's HR contract), zero free text, zero writes.
// 2) Single-shot 24h pre-expiry email reminder sweep (ADR-0053 'work', sequential routing_order, autoRemindBeforeExpiry opt-out,
//    mail_suppression handling, N1(a) direct-link suppression, zero plaintext tokens in mail_message, hash-chained signing_event).
// 3) ADR-0053 MODULE_OFF suppression + resumption, per-org error isolation, and envelope_guard / signer_guard immutability.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { SIGN_TOKEN_PATTERN, todayCoworkerKey, zTodayItems, type TodayItem, type TodayList } from '@ludy/kernel-contract';
import { DomainError, Runtime, fileKey, putFile, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import {
  SIGN_INVITE_MAIL_TEMPLATE,
  SIGN_PRE_EXPIRY_REMIND_MAIL_SOURCE,
  SIGN_REMIND_MAIL_TEMPLATE,
  generateRawSigningToken,
  hashSigningToken,
  signCommands,
  signQueries,
} from '@ludy/mod-sign';
import { AVAILABLE_MODULES } from '../src/config.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { signMailTemplates } from '../src/sign-mail.ts';
import { SIGN_ACTOR, sweepSignPreExpiryReminders } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const HOUR_MS = 3_600_000;
const VALID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

suite('eSign Slice 3c: Vy Today & 24h pre-expiry reminder on PostgreSQL 17 (#3813)', () => {
  const dbName = `ludy_test_sign_3c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  const store = new MemoryStore();

  let orgA = '';
  let orgB = '';
  let ownerA = '';
  let adminA = '';
  let memberA = '';
  let memberB = '';
  let viewerA = '';
  let ownerB = '';

  const asUser = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal1' as const,
    sessionId: randomUUID(),
  });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function createPerson(tag: string): Promise<{ userId: string; email: string }> {
    const email = `${tag}-${randomUUID().slice(0, 8)}@sign-3c.test`;
    const userId = await upsertIdentity(db, {
      issuer: 'test',
      subject: randomUUID(),
      email,
      name: `Person ${tag}`,
    });
    return { userId, email };
  }

  async function addMember(orgId: string, inviterId: string, person: { userId: string; email: string }, role: 'admin' | 'member' | 'viewer') {
    const inv = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: person.email, role },
      { actor: asMfa(inviterId), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.executeOrgless(
      'kernel.member.invite.accept',
      { token: inv.acceptPath.split('#')[1] },
      { actor: asUser(person.userId) },
    );
  }

  async function ingestSourcePdf(orgId: string, userId: string, tag: string): Promise<string> {
    const bytes = Uint8Array.from(
      Buffer.from(`%PDF-1.4\n% sign-3c-${tag}-${randomUUID()}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`, 'utf8'),
    );
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(store, storageKey, bytes, 'application/pdf', sha256);
    const ingested = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey,
        generation,
        source: 'sign_document',
      },
      { actor: asUser(userId), orgId, idempotencyKey: randomUUID() },
    );
    return ingested.fileId;
  }

  async function prepareAndSendEnvelope(opts: {
    orgId: string;
    creatorId: string;
    title: string;
    routingMode?: 'parallel' | 'sequential';
    sourceKind?: 'standalone' | 'hr_contract';
    sourceId?: string | null;
    expiresAt: string | null;
    autoRemindBeforeExpiry?: boolean;
    signers: Array<{
      name: string;
      email?: string;
      signerRole?: 'signer' | 'approver' | 'cc';
      deliveryMode: 'email' | 'link';
      routingOrder?: number;
      requireEmailOtp?: boolean;
    }>;
  }) {
    const sourceFileId = await ingestSourcePdf(opts.orgId, opts.creatorId, opts.title.slice(0, 20));
    const created = await runtime.execute<{ envelopeId: string; version: number }>(
      'sign.envelope.create',
      {
        title: opts.title,
        routingMode: opts.routingMode ?? 'parallel',
        sourceKind: opts.sourceKind ?? 'standalone',
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
        sourceFileId,
        expiresAt: opts.expiresAt,
        ...(opts.autoRemindBeforeExpiry !== undefined ? { autoRemindBeforeExpiry: opts.autoRemindBeforeExpiry } : {}),
      },
      { actor: asUser(opts.creatorId), orgId: opts.orgId, idempotencyKey: randomUUID() },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: created.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
      },
      { actor: SIGN_ACTOR, orgId: opts.orgId },
    );

    const signerIds: string[] = [];
    const fields: Array<{
      signerId: string;
      fieldType: 'signature';
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      wNorm: number;
      hNorm: number;
      required: boolean;
      proposedByAi: boolean;
    }> = [];

    for (const [idx, s] of opts.signers.entries()) {
      const added = await runtime.execute<{ signerId: string }>(
        'sign.signer.add',
        {
          envelopeId: created.envelopeId,
          routingOrder: s.routingOrder ?? idx + 1,
          signerRole: s.signerRole ?? 'signer',
          roleLabel: `Role ${idx + 1}`,
          name: s.name,
          ...(s.email ? { email: s.email } : {}),
          deliveryMode: s.deliveryMode,
          requireEmailOtp: s.requireEmailOtp ?? false,
        },
        { actor: asUser(opts.creatorId), orgId: opts.orgId, idempotencyKey: randomUUID() },
      );
      signerIds.push(added.signerId);
      if ((s.signerRole ?? 'signer') === 'signer') {
        fields.push({
          signerId: added.signerId,
          fieldType: 'signature',
          pageNumber: 1,
          xNorm: 0.1,
          yNorm: Math.min(0.8, 0.15 + idx * 0.15),
          wNorm: 0.25,
          hNorm: 0.08,
          required: true,
          proposedByAi: false,
        });
      }
    }

    if (fields.length > 0) {
      await runtime.execute(
        'sign.field.set',
        { envelopeId: created.envelopeId, fields },
        { actor: asUser(opts.creatorId), orgId: opts.orgId, idempotencyKey: randomUUID() },
      );
    }

    const sent = await runtime.execute<{
      envelopeId: string;
      links: Array<{ signerId: string; token: string }>;
    }>(
      'sign.envelope.send',
      { envelopeId: created.envelopeId },
      { actor: asUser(opts.creatorId), orgId: opts.orgId },
    );

    return {
      envelopeId: created.envelopeId,
      signerIds,
      links: sent.links,
    };
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
    const allQueries = [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...signQueries];
    const allCommands = [...kernelCmds, ...financeCommands, ...signCommands];

    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({ commands: allCommands, queries: allQueries });
    runtime.validate();

    workerRuntime = new Runtime(workerDb, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({ commands: allCommands, queries: allQueries });
    workerRuntime.validate();

    const pOwnerA = await createPerson('owner-a');
    const pAdminA = await createPerson('admin-a');
    const pMemberA = await createPerson('member-a');
    const pMemberB = await createPerson('member-b');
    const pViewerA = await createPerson('viewer-a');
    const pOwnerB = await createPerson('owner-b');

    ownerA = pOwnerA.userId;
    adminA = pAdminA.userId;
    memberA = pMemberA.userId;
    memberB = pMemberB.userId;
    viewerA = pViewerA.userId;
    ownerB = pOwnerB.userId;

    const createdA = await createOrg(runtime, asUser(ownerA), 'Sao Mai Co', randomUUID());
    const createdB = await createOrg(runtime, asUser(ownerB), 'Other Org', randomUUID());
    orgA = createdA.orgId;
    orgB = createdB.orgId;

    await addMember(orgA, ownerA, pAdminA, 'admin');
    await addMember(orgA, ownerA, pMemberA, 'member');
    await addMember(orgA, ownerA, pMemberB, 'member');
    await addMember(orgA, ownerA, pViewerA, 'viewer');
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

  it('surfaces 48h expiring and 14d declined envelopes on sign.today & kernel.today while strictly enforcing hr_contract confidentiality, zero free text, and zero writes', async () => {
    const baseNow = new Date(Date.now() + 2 * HOUR_MS);
    const baseNowIso = baseNow.toISOString();

    const hrConfidentialTitle = 'CANARY-HOP-DONG-LUONG-9999';
    const hrConfidentialDeclineNote = 'CANARY-LY-DO-TU-CHOI-8888';
    const canaryCounterpartyName = 'Canary Counterparty Name';

    // 1. Standalone envelope expiring in 18h (visible to owner, admin, and members).
    const expiringStandalone = await prepareAndSendEnvelope({
      orgId: orgA,
      creatorId: memberA,
      title: `Standalone ${hrConfidentialTitle}`,
      expiresAt: new Date(baseNow.getTime() + 18 * HOUR_MS).toISOString(),
      signers: [{ name: canaryCounterpartyName, deliveryMode: 'link' }],
    });

    // 2. Standalone envelope expiring in 72h (outside 48h window -> excluded).
    await prepareAndSendEnvelope({
      orgId: orgA,
      creatorId: memberA,
      title: 'Far Future Contract',
      expiresAt: new Date(baseNow.getTime() + 72 * HOUR_MS).toISOString(),
      signers: [{ name: 'Far Signer', deliveryMode: 'link' }],
    });

    // 3. Standalone declined envelope (declined via public ceremony).
    const declinedStandalone = await prepareAndSendEnvelope({
      orgId: orgA,
      creatorId: memberA,
      title: 'Declined Service Contract',
      expiresAt: new Date(baseNow.getTime() + 30 * HOUR_MS).toISOString(),
      signers: [{ name: canaryCounterpartyName, deliveryMode: 'link' }],
    });
    const declineTokenHash = hashSigningToken(declinedStandalone.links[0]!.token);
    await runtime.orgless(async (orglessDb) => {
      await sql`
        SELECT ludy_sign.public_decline(
          ${declineTokenHash},
          ${hrConfidentialDeclineNote},
          ${'a'.repeat(64)},
          'SignTest/1.0'
        )
      `.execute(orglessDb);
    });

    // 4. HR contract envelope created by adminA expiring in 10h (confidential: owner & admin see it; memberA, memberB, viewerA MUST NEVER see it).
    const hrExpiring = await prepareAndSendEnvelope({
      orgId: orgA,
      creatorId: adminA,
      title: `HR Salary ${hrConfidentialTitle}`,
      sourceKind: 'hr_contract',
      sourceId: randomUUID(),
      expiresAt: new Date(baseNow.getTime() + 10 * HOUR_MS).toISOString(),
      signers: [{ name: 'Employee Confidential', deliveryMode: 'link' }],
    });

    // 5. Cross-org expiring envelope in orgB (never visible in orgA).
    await prepareAndSendEnvelope({
      orgId: orgB,
      creatorId: ownerB,
      title: 'Other Org Envelope',
      expiresAt: new Date(baseNow.getTime() + 6 * HOUR_MS).toISOString(),
      signers: [{ name: 'Org B Signer', deliveryMode: 'link' }],
    });

    const { rows: auditBefore } = await withAdmin((c) =>
      c.query<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.audit_event WHERE org_id = $1', [orgA]),
    );

    const ownerItems = await runtime.query<TodayItem[]>(
      'sign.today',
      { now: baseNowIso },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(zTodayItems.safeParse(ownerItems).success).toBe(true);
    expect(ownerItems.map((i) => i.id)).toEqual([
      `declined:${declinedStandalone.envelopeId}`,
      `expiring:${hrExpiring.envelopeId}`,
      `expiring:${expiringStandalone.envelopeId}`,
    ]);
    expect(ownerItems[0]?.href).toBe(`/sign/envelopes/${declinedStandalone.envelopeId}`);

    const adminItems = await runtime.query<TodayItem[]>(
      'sign.today',
      { now: baseNowIso },
      { actor: asUser(adminA), orgId: orgA },
    );
    expect(adminItems.map((i) => i.id)).toEqual(ownerItems.map((i) => i.id));

    // Ordinary members NEVER see hr_contract envelopes created by admin/owner.
    const memberAItems = await runtime.query<TodayItem[]>(
      'sign.today',
      { now: baseNowIso },
      { actor: asUser(memberA), orgId: orgA },
    );
    expect(memberAItems.map((i) => i.id)).toEqual([
      `declined:${declinedStandalone.envelopeId}`,
      `expiring:${expiringStandalone.envelopeId}`,
    ]);
    const memberBItems = await runtime.query<TodayItem[]>(
      'sign.today',
      { now: baseNowIso },
      { actor: asUser(memberB), orgId: orgA },
    );
    expect(memberBItems.map((i) => i.id)).toEqual([
      `declined:${declinedStandalone.envelopeId}`,
      `expiring:${expiringStandalone.envelopeId}`,
    ]);

    // Viewers get zero actionable Today items.
    const viewerItems = await runtime.query<TodayItem[]>(
      'sign.today',
      { now: baseNowIso },
      { actor: asUser(viewerA), orgId: orgA },
    );
    expect(viewerItems).toEqual([]);

    // End-to-end merge through kernel.today (using live clock where envelopes are also within 48h).
    const mergedMember = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(memberB), orgId: orgA });
    expect(mergedMember.dropped).toBe(0);
    expect(mergedMember.failed).toBe(0);
    expect(todayCoworkerKey('sign')).toBe('gm');
    const signMergedIds = mergedMember.items.filter((i) => i.app === 'sign').map((i) => i.id);
    expect(signMergedIds).toContain(`declined:${declinedStandalone.envelopeId}`);
    expect(signMergedIds).toContain(`expiring:${expiringStandalone.envelopeId}`);
    expect(signMergedIds).not.toContain(`expiring:${hrExpiring.envelopeId}`);

    // Zero free text leaks into TodayList.
    const serialized = JSON.stringify(mergedMember);
    expect(serialized).not.toContain(hrConfidentialTitle);
    expect(serialized).not.toContain(hrConfidentialDeclineNote);
    expect(serialized).not.toContain(canaryCounterpartyName);

    // Zero audit/DB writes from sign.today & kernel.today.
    const { rows: auditAfter } = await withAdmin((c) =>
      c.query<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.audit_event WHERE org_id = $1', [orgA]),
    );
    expect(auditAfter[0]?.n).toBe(auditBefore[0]?.n);

    // Acknowledging a declined envelope removes it from sign.today & kernel.today while keeping event chain valid.
    const acked = await runtime.execute<{ envelopeId: string; declineAcknowledgedAt: string; version: number }>(
      'sign.envelope.acknowledge_decline',
      { envelopeId: declinedStandalone.envelopeId },
      { actor: asUser(memberA), orgId: orgA, idempotencyKey: randomUUID() },
    );
    expect(acked.declineAcknowledgedAt).toBeTruthy();

    const afterAckItems = await runtime.query<TodayItem[]>(
      'sign.today',
      { now: baseNowIso },
      { actor: asUser(memberA), orgId: orgA },
    );
    expect(afterAckItems.map((i) => i.id)).toEqual([`expiring:${expiringStandalone.envelopeId}`]);

    const ackedChain = await runtime.query<{ valid: boolean }>(
      'sign.envelope.verify',
      { envelopeId: declinedStandalone.envelopeId },
      { actor: asUser(memberA), orgId: orgA },
    );
    expect(ackedChain.valid).toBe(true);
  });

  it('persists autoRemindBeforeExpiry on draft create/update and enforces envelope_guard + signer_guard + worker-only definer checks', async () => {
    const sourceFileId = await ingestSourcePdf(orgA, ownerA, 'guard-check');
    const created = await runtime.execute<{ envelopeId: string; version: number }>(
      'sign.envelope.create',
      {
        title: 'Draft Auto Remind Toggle',
        routingMode: 'parallel',
        sourceKind: 'standalone',
        sourceFileId,
      },
      { actor: asUser(ownerA), orgId: orgA, idempotencyKey: randomUUID() },
    );

    const initialDetail = await runtime.query<{ envelope: { autoRemindBeforeExpiry: boolean; version: number } }>(
      'sign.envelope.get',
      { envelopeId: created.envelopeId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(initialDetail.envelope.autoRemindBeforeExpiry).toBe(true);

    await runtime.execute(
      'sign.envelope.update',
      {
        envelopeId: created.envelopeId,
        expectedVersion: initialDetail.envelope.version,
        autoRemindBeforeExpiry: false,
      },
      { actor: asUser(ownerA), orgId: orgA, idempotencyKey: randomUUID() },
    );

    const updatedDetail = await runtime.query<{ envelope: { autoRemindBeforeExpiry: boolean } }>(
      'sign.envelope.get',
      { envelopeId: created.envelopeId },
      { actor: asUser(ownerA), orgId: orgA },
    );
    expect(updatedDetail.envelope.autoRemindBeforeExpiry).toBe(false);

    // Non-worker role ludy_app cannot call ludy_sign.pre_expiry_remind_due_orgs.
    await expect(
      sql`SELECT * FROM ludy_sign.pre_expiry_remind_due_orgs(10, now())`.execute(db),
    ).rejects.toThrow();

    // Direct tenant-user write to pre_expiry_reminded_at is blocked by signer_guard() (SIGNER_SYSTEM_ONLY),
    // and direct tenant-user write to auto_remind_before_expiry on a sent envelope is blocked by envelope_guard() (ENVELOPE_FROZEN).
    const active = await prepareAndSendEnvelope({
      orgId: orgA,
      creatorId: ownerA,
      title: 'Sent Guard Test',
      expiresAt: new Date(Date.now() + 72 * HOUR_MS).toISOString(),
      signers: [{ name: 'Guard Signer', email: 'guard@sign-3c.test', deliveryMode: 'email' }],
    });

    const guardClient = await pool.connect();
    try {
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [ownerA, orgA]);
      const expectGuardFailure = async (sqlText: string, params: unknown[], pattern: RegExp) => {
        await guardClient.query('SAVEPOINT sign_3c_guard');
        await expect(guardClient.query(sqlText, params)).rejects.toThrow(pattern);
        await guardClient.query('ROLLBACK TO SAVEPOINT sign_3c_guard');
        await guardClient.query('RELEASE SAVEPOINT sign_3c_guard');
      };
      await expectGuardFailure(
        'UPDATE ludy_sign.envelope SET auto_remind_before_expiry = false WHERE org_id = $1 AND id = $2',
        [orgA, active.envelopeId],
        /ENVELOPE_FROZEN/,
      );
      await expectGuardFailure(
        'UPDATE ludy_sign.signer SET pre_expiry_reminded_at = now() WHERE org_id = $1 AND id = $2',
        [orgA, active.signerIds[0]!],
        /SIGNER_SYSTEM_ONLY/,
      );
    } finally {
      await guardClient.query('ROLLBACK').catch(() => {});
      guardClient.release();
    }
  });

  it('sends at most one 24h pre-expiry email reminder, respects sequential routing_order, autoRemindBeforeExpiry=false, mail_suppression, N1(a) direct-link suppression, and preserves event chain', async () => {
    const orgSweep = (await createOrg(runtime, asUser(ownerA), 'Sweep Org', randomUUID())).orgId;
    const sweepNow = new Date(Date.now() + 30 * 60_000);
    const dueIso = new Date(sweepNow.getTime() + 18 * HOUR_MS).toISOString();

    const activeEmail = `active-${randomUUID().slice(0, 6)}@sign-3c.test`;
    const suppressedEmail = `suppressed-${randomUUID().slice(0, 6)}@sign-3c.test`;
    const seqStep2Email = `seq2-${randomUUID().slice(0, 6)}@sign-3c.test`;
    const optOutEmail = `optout-${randomUUID().slice(0, 6)}@sign-3c.test`;

    // Suppress suppressedEmail on transactional stream in orgSweep.
    await runtime.execute(
      'kernel.mail.suppression.add',
      { email: suppressedEmail, scope: 'all' },
      { actor: asUser(ownerA), orgId: orgSweep, idempotencyKey: randomUUID() },
    );

    // 1. Parallel envelope with 1 active email signer, 1 suppressed email signer, 1 link signer, and 1 CC.
    const parallelEnv = await prepareAndSendEnvelope({
      orgId: orgSweep,
      creatorId: ownerA,
      title: 'Parallel 24h Reminder Contract',
      routingMode: 'parallel',
      expiresAt: dueIso,
      autoRemindBeforeExpiry: true,
      signers: [
        { name: 'Active Email Signer', email: activeEmail, deliveryMode: 'email' },
        { name: 'Suppressed Email Signer', email: suppressedEmail, deliveryMode: 'email' },
        { name: 'Zalo Link Signer', deliveryMode: 'link' },
        { name: 'CC Observer', email: 'cc@sign-3c.test', signerRole: 'cc', deliveryMode: 'email' },
      ],
    });

    // Hydrate the initial invite email for Active Email Signer so an active email token exists BEFORE the 24h sweep!
    const { rows: inviteMails } = await withAdmin((c) =>
      c.query<{ id: string; subject: string; payload: Record<string, unknown> }>(
        `SELECT id, subject, payload FROM ludy_kernel.mail_message
         WHERE org_id = $1::uuid AND to_address = $2 AND template_key = $3
         ORDER BY created_at DESC LIMIT 1`,
        [orgSweep, activeEmail, SIGN_INVITE_MAIL_TEMPLATE],
      ),
    );
    const initialInviteMail = inviteMails[0]!;
    const renderedInvite = await signMailTemplates[SIGN_INVITE_MAIL_TEMPLATE]!.render({
      messageId: initialInviteMail.id,
      subject: initialInviteMail.subject,
      payload: initialInviteMail.payload,
      publicUrl: 'https://ludy.example.com',
      inboundAddress: null,
      brand: 'Ludy',
      execute: <T>(command: string, input: unknown) =>
        workerRuntime.execute<T>(command, input, { actor: SIGN_ACTOR, orgId: orgSweep }),
    });
    const inviteToken = renderedInvite!.text.match(/https:\/\/ludy\.example\.com\/-\/sign#([A-Za-z0-9_-]+)/)?.[1] ?? '';
    expect(inviteToken).toMatch(SIGN_TOKEN_PATTERN);

    // 2. Sequential envelope: Step 1 (link) is pending; Step 2 (email) is waiting -> MUST NOT remind Step 2 yet.
    const seqEnv = await prepareAndSendEnvelope({
      orgId: orgSweep,
      creatorId: ownerA,
      title: 'Sequential 24h Contract',
      routingMode: 'sequential',
      expiresAt: dueIso,
      autoRemindBeforeExpiry: true,
      signers: [
        { name: 'Step 1 Zalo', deliveryMode: 'link', routingOrder: 1 },
        { name: 'Step 2 Email', email: seqStep2Email, deliveryMode: 'email', routingOrder: 2 },
      ],
    });

    // 3. Opted-out envelope (autoRemindBeforeExpiry = false) -> MUST NOT remind.
    const optOutEnv = await prepareAndSendEnvelope({
      orgId: orgSweep,
      creatorId: ownerA,
      title: 'Opt Out Contract',
      routingMode: 'parallel',
      expiresAt: dueIso,
      autoRemindBeforeExpiry: false,
      signers: [{ name: 'Opt Out Signer', email: optOutEmail, deliveryMode: 'email' }],
    });

    // 4. N1(a) Unverified public direct-link envelope expiring within 24h -> MUST NEVER send pre-expiry mail!
    const tplFileId = await ingestSourcePdf(orgSweep, ownerA, 'direct-n1a');
    const createdTpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      {
        title: 'Public Direct Link Template',
        routingMode: 'parallel',
        sourceFileId: tplFileId,
      },
      { actor: asUser(ownerA), orgId: orgSweep, idempotencyKey: randomUUID() },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: createdTpl.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
      },
      { actor: SIGN_ACTOR, orgId: orgSweep },
    );
    const rolesRes = await runtime.execute<{ roles: Array<{ id: string }> }>(
      'sign.template.roles_set',
      {
        templateId: createdTpl.templateId,
        roles: [
          {
            roleKey: 'r1',
            signerRole: 'signer',
            roleLabel: 'Customer',
            routingOrder: 1,
            deliveryMode: 'link',
            requireEmailOtp: false,
          },
        ],
      },
      { actor: asUser(ownerA), orgId: orgSweep, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: createdTpl.templateId,
        fields: [
          {
            templateRoleId: rolesRes.roles[0]!.id,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.2,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
          },
        ],
      },
      { actor: asUser(ownerA), orgId: orgSweep, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: createdTpl.templateId, status: 'active' },
      { actor: asUser(ownerA), orgId: orgSweep, idempotencyKey: randomUUID() },
    );
    const directSet = await runtime.execute<{ token: string }>(
      'sign.template.direct_link_set',
      { templateId: createdTpl.templateId, enabled: true, requireEmailOtp: false },
      { actor: asUser(ownerA), orgId: orgSweep },
    );
    const directTokenHash = hashSigningToken(directSet.token);
    const unverifiedCeremonyToken = generateRawSigningToken();
    const directStarted = await runtime.orgless(async (orglessDb) => {
      const { rows } = await sql<{ v: { status: string; envelopeId: string; signerId: string } }>`
        SELECT ludy_sign.public_direct_start(
          ${directTokenHash},
          'Anonymous Visitor',
          'victim-n1a@sign-3c.test',
          NULL,
          ${hashSigningToken(unverifiedCeremonyToken)},
          ${'b'.repeat(64)},
          'DirectProbe/1.0'
        ) AS v
      `.execute(orglessDb);
      return rows[0]?.v ?? null;
    });
    expect(directStarted?.status).toBe('ok');
    // Force expires_at into the 24h window AND even flip delivery_mode + clear direct_link_id via superuser to test genesis-event N1(a) defense in depth!
    await withAdmin(async (c) => {
      await c.query(
        'UPDATE ludy_sign.envelope SET expires_at = $3::timestamptz, direct_link_id = NULL WHERE org_id = $1::uuid AND id = $2::uuid',
        [orgSweep, directStarted!.envelopeId, dueIso],
      );
      await c.query(
        `UPDATE ludy_sign.signer SET delivery_mode = 'email' WHERE org_id = $1::uuid AND id = $2::uuid`,
        [orgSweep, directStarted!.signerId],
      );
    });

    // Run Sweep Pass #1 at sweepNow!
    const pass1 = await sweepSignPreExpiryReminders({
      workerDb,
      runtime: workerRuntime,
      now: sweepNow,
    });
    expect(pass1.envelopes).toBeGreaterThanOrEqual(1);
    expect(pass1.remindedSigners).toBe(2); // Active Email Signer + Suppressed Email Signer on parallelEnv ONLY
    expect(pass1.queuedEmails).toBe(1);
    expect(pass1.suppressedEmails).toBe(1);

    // Run Sweep Pass #2 five minutes later: single-shot idempotency -> ZERO duplicate reminders!
    const pass2 = await sweepSignPreExpiryReminders({
      workerDb,
      runtime: workerRuntime,
      now: new Date(sweepNow.getTime() + 5 * 60_000),
    });
    expect(pass2.remindedSigners).toBe(0);
    expect(pass2.queuedEmails).toBe(0);

    // Verify mail_message rows for pre-expiry source in orgSweep.
    const { rows: mailRows } = await withAdmin((c) =>
      c.query<{ id: string; to_address: string; status: string; subject: string; payload: Record<string, unknown> }>(
        `SELECT id, to_address, status, subject, payload
         FROM ludy_kernel.mail_message
         WHERE org_id = $1::uuid AND source = $2
         ORDER BY to_address ASC`,
        [orgSweep, SIGN_PRE_EXPIRY_REMIND_MAIL_SOURCE],
      ),
    );
    expect(mailRows.map((m) => ({ to: m.to_address, status: m.status }))).toEqual([
      { to: activeEmail, status: 'queued' },
      { to: suppressedEmail, status: 'suppressed' },
    ]);
    // N1(a) victim, sequential waiting signer, and opt-out signer got ZERO pre-expiry emails.
    expect(mailRows.some((m) => m.to_address === 'victim-n1a@sign-3c.test')).toBe(false);
    expect(mailRows.some((m) => m.to_address === seqStep2Email)).toBe(false);
    expect(mailRows.some((m) => m.to_address === optOutEmail)).toBe(false);

    // Zero plaintext signing tokens in mail_message.payload; hydrate via signMailTemplates (`kernel-mail-send` path).
    const queuedMail = mailRows.find((m) => m.to_address === activeEmail)!;
    expect(JSON.stringify(queuedMail.payload)).not.toContain('/-/sign#');
    expect(queuedMail.payload.preExpiry).toBe(true);

    const rendered = await signMailTemplates[SIGN_REMIND_MAIL_TEMPLATE]!.render({
      messageId: queuedMail.id,
      subject: queuedMail.subject,
      payload: queuedMail.payload,
      publicUrl: 'https://ludy.example.com',
      inboundAddress: null,
      brand: 'Ludy',
      execute: <T>(command: string, input: unknown) =>
        workerRuntime.execute<T>(command, input, { actor: SIGN_ACTOR, orgId: orgSweep }),
    });
    expect(rendered).not.toBeNull();
    expect(rendered!.text).toContain('sap den han ky trong vong 24 gio toi');
    const urlMatch = rendered!.text.match(/https:\/\/ludy\.example\.com\/-\/sign#([A-Za-z0-9_-]+)/);
    expect(urlMatch?.[1]).toMatch(SIGN_TOKEN_PATTERN);
    // Non-disruptive token reuse: pre-expiry reminder reuses the active invite email token so neither open sessions nor the invite email break!
    expect(urlMatch?.[1]).toBe(inviteToken);

    // envelope.get distinguishes queued vs suppressed pre-expiry reminder status on signers.
    const parallelDetail = await runtime.query<{
      signers: Array<{ email: string | null; preExpiryRemindedAt: string | null; preExpiryRemindStatus?: string | null }>;
    }>('sign.envelope.get', { envelopeId: parallelEnv.envelopeId }, { actor: asUser(ownerA), orgId: orgSweep });
    const activeSignerDetail = parallelDetail.signers.find((s) => s.email === activeEmail);
    const suppressedSignerDetail = parallelDetail.signers.find((s) => s.email === suppressedEmail);
    expect(activeSignerDetail?.preExpiryRemindStatus).toBe('queued');
    expect(suppressedSignerDetail?.preExpiryRemindStatus).toBe('suppressed');

    // Verify hash-chained signing_event integrity on parallelEnv.
    const verifiedChain = await runtime.query<{ valid: boolean; eventChain: { valid: boolean } }>(
      'sign.envelope.verify',
      { envelopeId: parallelEnv.envelopeId },
      { actor: asUser(ownerA), orgId: orgSweep },
    );
    expect(verifiedChain.valid).toBe(true);

    // Opt-out envelope signer still has pre_expiry_reminded_at === null.
    const optOutDetail = await runtime.query<{ signers: Array<{ preExpiryRemindedAt: string | null }> }>(
      'sign.envelope.get',
      { envelopeId: optOutEnv.envelopeId },
      { actor: asUser(ownerA), orgId: orgSweep },
    );
    expect(optOutDetail.signers[0]?.preExpiryRemindedAt).toBeNull();

    // Now complete Step 1 on seqEnv so Step 2 advances from 'waiting' -> 'pending', then sweep again!
    const step1TokenHash = hashSigningToken(seqEnv.links[0]!.token);
    const step1View = await runtime.orgless(async (orglessDb) => {
      const { rows } = await sql<{ v: { fields: Array<{ id: string }> } }>`
        SELECT ludy_sign.public_record_view(${step1TokenHash}, ${'c'.repeat(64)}, 'SeqStep1/1.0') AS v
      `.execute(orglessDb);
      return rows[0]?.v ?? null;
    });
    await runtime.orgless(async (orglessDb) => {
      await sql`
        SELECT ludy_sign.public_submit(
          ${step1TokenHash},
          true,
          'draw',
          NULL,
          ${JSON.stringify([{ fieldId: step1View!.fields[0]!.id, signaturePngBase64: VALID_PNG_BASE64 }])}::jsonb,
          ${'c'.repeat(64)},
          'SeqStep1/1.0',
          'mail.crove.test'
        )
      `.execute(orglessDb);
    });

    const pass3 = await sweepSignPreExpiryReminders({
      workerDb,
      runtime: workerRuntime,
      now: new Date(sweepNow.getTime() + 10 * 60_000),
    });
    expect(pass3.remindedSigners).toBe(1);
    expect(pass3.queuedEmails).toBe(1);

    const seqDetail = await runtime.query<{ signers: Array<{ id: string; preExpiryRemindedAt: string | null }> }>(
      'sign.envelope.get',
      { envelopeId: seqEnv.envelopeId },
      { actor: asUser(ownerA), orgId: orgSweep },
    );
    expect(seqDetail.signers[1]?.preExpiryRemindedAt).not.toBeNull();
  });

  it('enforces ADR-0053 MODULE_OFF on sign.today, kernel.today, and sweepSignPreExpiryReminders, plus per-org sweep error isolation', async () => {
    const orgOff = (await createOrg(runtime, asUser(ownerA), 'Toggle Org', randomUUID())).orgId;
    const orgHealthy = (await createOrg(runtime, asUser(ownerA), 'Healthy Org', randomUUID())).orgId;

    const sweepNow = new Date(Date.now() + 45 * 60_000);
    const dueIso = new Date(sweepNow.getTime() + 12 * HOUR_MS).toISOString();

    const offEnv = await prepareAndSendEnvelope({
      orgId: orgOff,
      creatorId: ownerA,
      title: 'Off Org Contract',
      expiresAt: dueIso,
      signers: [{ name: 'Off Signer', email: 'off-signer@sign-3c.test', deliveryMode: 'email' }],
    });
    const healthyEnv = await prepareAndSendEnvelope({
      orgId: orgHealthy,
      creatorId: ownerA,
      title: 'Healthy Org Contract',
      expiresAt: dueIso,
      signers: [{ name: 'Healthy Signer', email: 'healthy-signer@sign-3c.test', deliveryMode: 'email' }],
    });

    // Turn 'sign' off for orgOff.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asMfa(ownerA), orgId: orgOff, idempotencyKey: randomUUID() },
    );

    await expect(
      runtime.query('sign.today', { now: sweepNow.toISOString() }, { actor: asUser(ownerA), orgId: orgOff }),
    ).rejects.toMatchObject({ code: 'MODULE_OFF' });

    const todayWhenOff = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(ownerA), orgId: orgOff });
    expect(todayWhenOff.failed).toBe(0);
    expect(todayWhenOff.items.filter((i) => i.app === 'sign')).toEqual([]);

    // Sweep while orgOff has sign disabled -> orgOff is skipped (not stamped!), orgHealthy succeeds!
    const sweepWhileOff = await sweepSignPreExpiryReminders({
      workerDb,
      runtime: workerRuntime,
      now: sweepNow,
    });
    expect(sweepWhileOff.queuedEmails).toBe(1);

    const { rows: offSignerRows } = await withAdmin((c) =>
      c.query<{ pre_expiry_reminded_at: Date | null }>(
        'SELECT pre_expiry_reminded_at FROM ludy_sign.signer WHERE org_id = $1::uuid AND envelope_id = $2::uuid',
        [orgOff, offEnv.envelopeId],
      ),
    );
    expect(offSignerRows[0]?.pre_expiry_reminded_at).toBeNull();

    const { rows: healthySignerRows } = await withAdmin((c) =>
      c.query<{ pre_expiry_reminded_at: Date | null }>(
        'SELECT pre_expiry_reminded_at FROM ludy_sign.signer WHERE org_id = $1::uuid AND envelope_id = $2::uuid',
        [orgHealthy, healthyEnv.envelopeId],
      ),
    );
    expect(healthySignerRows[0]?.pre_expiry_reminded_at).not.toBeNull();

    // Re-enable 'sign' on orgOff, and also verify per-org error isolation using a second due org whose execute throws!
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: true },
      { actor: asMfa(ownerA), orgId: orgOff, idempotencyKey: randomUUID() },
    );

    const orgFaulty = (await createOrg(runtime, asUser(ownerA), 'Faulty Org', randomUUID())).orgId;
    await prepareAndSendEnvelope({
      orgId: orgFaulty,
      creatorId: ownerA,
      title: 'Faulty Org Contract',
      expiresAt: dueIso,
      signers: [{ name: 'Faulty Signer', email: 'faulty@sign-3c.test', deliveryMode: 'email' }],
    });

    const loggedErrors: Array<[string, string]> = [];
    const faultyProxyRuntime = {
      appOn: (id: string, mod: 'sign', opts?: { fresh?: boolean }) => workerRuntime.appOn(id, mod, opts),
      execute: <T>(name: string, input: unknown, opts: { actor: typeof SIGN_ACTOR; orgId: string }) => {
        if (opts.orgId === orgFaulty) {
          return Promise.reject(new DomainError('SIMULATED_ORG_FAULT', 500, 'Simulated fault with PII canary-pii@example.com'));
        }
        return workerRuntime.execute<T>(name, input, opts);
      },
    } as unknown as Runtime;

    const isolatedRes = await sweepSignPreExpiryReminders({
      workerDb,
      runtime: faultyProxyRuntime,
      now: new Date(sweepNow.getTime() + 60_000),
      log: {
        error: (msg: unknown, code: unknown) => {
          loggedErrors.push([String(msg), String(code)]);
        },
      },
    });
    // orgOff succeeded despite orgFaulty throwing, and error log carried code only (never PII message)!
    expect(isolatedRes.orgs).toBe(1);
    expect(isolatedRes.queuedEmails).toBe(1);
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]?.[1]).toBe('SIMULATED_ORG_FAULT');
    expect(JSON.stringify(loggedErrors)).not.toContain('canary-pii@example.com');
  });

  it('drains >100 due envelopes across consecutive sweep passes without starving envelope #101', async () => {
    const orgBatch = (await createOrg(runtime, asUser(ownerB), 'Batch 101 Org', randomUUID())).orgId;
    const sourceFileId = await ingestSourcePdf(orgBatch, ownerB, 'batch-101');
    const sweepNow = new Date(Date.now() + 2 * HOUR_MS);
    const dueIso = new Date(sweepNow.getTime() + 10 * HOUR_MS).toISOString();

    await withAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        for (let idx = 0; idx < 101; idx += 1) {
          const envId = randomUUID();
          await c.query(
            `INSERT INTO ludy_sign.envelope (
               org_id, id, title, status, routing_mode, source_kind, source_file_id,
               source_storage_key, source_generation, source_sha256, inspect_status, page_count,
               expires_at, auto_remind_before_expiry, sent_at, created_by
             )
             SELECT $1::uuid, $2::uuid, $3, 'sent', 'parallel', 'standalone', f.id,
                    f.storage_key, f.generation, f.sha256, 'passed', 1,
                    $4::timestamptz, true, now(), $5::uuid
             FROM ludy_kernel.file f
             WHERE f.org_id = $1::uuid AND f.id = $6::uuid`,
            [orgBatch, envId, `Batch Env ${idx + 1}`, dueIso, ownerB, sourceFileId],
          );
          await c.query(
            `INSERT INTO ludy_sign.signer (
               org_id, envelope_id, routing_order, signer_role, role_label, name, email, delivery_mode, status
             ) VALUES ($1::uuid, $2::uuid, 1, 'signer', 'Party B', $3, $4, 'email', 'pending')`,
            [orgBatch, envId, `Signer ${idx + 1}`, `batch-${idx + 1}@sign-3c.test`],
          );
        }
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });

    const batchPass1 = await workerRuntime.execute<{ envelopesReminded: number; remindedSigners: number }>(
      'sign.envelope.pre_expiry_remind_sweep',
      { now: sweepNow.toISOString() },
      { actor: SIGN_ACTOR, orgId: orgBatch },
    );
    expect(batchPass1.envelopesReminded).toBe(100);
    expect(batchPass1.remindedSigners).toBe(100);

    const batchPass2 = await workerRuntime.execute<{ envelopesReminded: number; remindedSigners: number }>(
      'sign.envelope.pre_expiry_remind_sweep',
      { now: new Date(sweepNow.getTime() + 60_000).toISOString() },
      { actor: SIGN_ACTOR, orgId: orgBatch },
    );
    expect(batchPass2.envelopesReminded).toBe(1);
    expect(batchPass2.remindedSigners).toBe(1);

    const batchPass3 = await workerRuntime.execute<{ envelopesReminded: number; remindedSigners: number }>(
      'sign.envelope.pre_expiry_remind_sweep',
      { now: new Date(sweepNow.getTime() + 120_000).toISOString() },
      { actor: SIGN_ACTOR, orgId: orgBatch },
    );
    expect(batchPass3.envelopesReminded).toBe(0);
    expect(batchPass3.remindedSigners).toBe(0);
  });

  it('clamps ludy_sign.public_mail_token_issue token expires_at at 720 hours on legacy/long-expiry envelopes (#4270)', async () => {
    const legacyOrg = orgA;
    const sourceFileId = await ingestSourcePdf(legacyOrg, ownerA, 'legacy-720h');
    const nowIso = '2026-11-24T00:00:00.000Z';
    const farIso = '2027-06-01T00:00:00.000Z';
    const envId = randomUUID();
    const signerId = randomUUID();
    const msgId = randomUUID();
    const signerEmail = 'legacy-signer@sign-4270.test';

    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO ludy_sign.envelope (
           org_id, id, title, status, routing_mode, source_kind, source_file_id,
           source_storage_key, source_generation, source_sha256, inspect_status, page_count,
           expires_at, sent_at, created_by
         )
         SELECT $1::uuid, $2::uuid, 'Legacy 180d Envelope', 'sent', 'parallel', 'standalone', f.id,
                f.storage_key, f.generation, f.sha256, 'passed', 1, $3::timestamptz, $4::timestamptz, $5::uuid
         FROM ludy_kernel.file f
         WHERE f.org_id = $1::uuid AND f.id = $6::uuid`,
        [legacyOrg, envId, farIso, nowIso, ownerA, sourceFileId],
      );
      await c.query(
        `INSERT INTO ludy_sign.signer (
           org_id, id, envelope_id, routing_order, signer_role, role_label, name, email, delivery_mode, status
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'signer', 'Ben B', 'Legacy Signer', $4, 'email', 'pending')`,
        [legacyOrg, signerId, envId, signerEmail],
      );
      await c.query(
        `INSERT INTO ludy_kernel.mail_message (
           org_id, id, stream, source, source_id, template_key, to_address, to_hash, subject, payload, message_id_header, status
         ) VALUES (
           $1::uuid, $2::uuid, 'transactional', 'sign.envelope.send', $3::uuid, 'sign.invite', $4, $5,
           'Moi ky', '{}'::jsonb, $6, 'queued'
         )`,
        [legacyOrg, msgId, signerId, signerEmail, sha256Hex(signerEmail), `<${randomUUID()}@sign-4270.test>`],
      );
    });

    const wc = await workerPool.connect();
    try {
      await wc.query('BEGIN');
      await wc.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [legacyOrg]);
      const issued = await wc.query<{ v: { tokenId: string; expiresAt: string } | null }>(
        `SELECT ludy_sign.public_mail_token_issue($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz) AS v`,
        [envId, signerId, msgId, farIso, nowIso],
      );
      await wc.query('COMMIT');
      const expectedCapMs = new Date(nowIso).getTime() + 720 * HOUR_MS;
      expect(issued.rows[0]?.v).not.toBeNull();
      expect(new Date(issued.rows[0]!.v!.expiresAt).getTime()).toBe(expectedCapMs);

      const tokRow = await withAdmin((c) =>
        c.query<{ expires_at: Date }>('SELECT expires_at FROM ludy_sign.signing_token WHERE org_id = $1 AND id = $2', [
          legacyOrg,
          issued.rows[0]!.v!.tokenId,
        ]),
      );
      expect(tokRow.rows[0]!.expires_at.getTime()).toBe(expectedCapMs);
    } finally {
      await wc.query('ROLLBACK').catch(() => {});
      wc.release();
    }
  });
});

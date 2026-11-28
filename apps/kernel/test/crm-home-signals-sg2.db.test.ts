// SPDX-License-Identifier: AGPL-3.0-only
// SG2 PostgreSQL 17 integration tests (#4994):
// 1. sign.signals.opened: 7-day non-CC opened envelopes matched by case-folded trimmed email to canonical
//    COALESCE(duplicate_of, id) party, viewer = [], org_app_on('sign') gate, hr_contract + meeting_minutes
//    confidentiality, MCP company-grant only (403 on member grants + explicit confidential exclusion), IDs/dates only.
// 2. crm.signals.attention: batched 1-query-per-source across contacts (quote_viewed, quote_expiring, quote_unanswered,
//    customer_replied), per-member party_attention_seen + conversation RLS, MCP omits customer_replied and skips seen.
// 3. kernel.signals.contact_attention + kernel.mcp.signals: joins CRM + Sign + Finance overdue receivables, caps at 5
//    newest-first (cut drops oldest), fails closed per line in browser Home vs unchecked in ludy_signals.
// 4. crm.contact.get: loads person or organization by partyId (through duplicate merge) for /contacts?c=<partyId>.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  CONTACT_ATTENTION_HOME_MAX,
  CRM_ATTENTION_SIGNALS_READ,
  SIGN_OPENED_SIGNALS_READ,
  vietnamToday,
  zCrmAttentionSignals,
  zSignOpenedSignals,
  zTodayItems,
  type Contact,
  type CrmAttentionSignal,
  type Deal,
  type PartyAttentionItem,
  type PipelineStage,
  type QuoteLinkCreated,
  type SignOpenedSignal,
  type TodayItem,
} from '@ludy/kernel-contract';
import { Runtime, fileKey, putFile, sha256Hex, type BlobStore, type UserActor } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { addDays, financeCommands, financeQueries } from '@ludy/mod-finance';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { hashSigningToken, signCommands, signQueries } from '@ludy/mod-sign';
import { AVAILABLE_MODULES } from '../src/config.ts';
import { SIGN_ACTOR } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM_CRM = { type: 'system' as const, component: 'crm.deal_stale' };
const TODAY = vietnamToday();

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }

  async get(key: string) {
    const found = this.blobs.get(key);
    if (!found) throw new Error(`Missing blob ${key}`);
    return found;
  }

  async delete(key: string) {
    this.blobs.delete(key);
  }
}

suite('SG2 Home contact attention signals and sign.signals.opened on PostgreSQL (#4994)', () => {
  const dbName = `ludy_test_sg2_signals_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const store = new MemoryStore();

  const asUser = (userId: string, opts: { aal?: 'aal1' | 'aal2'; mfaAt?: number } = {}): UserActor => ({
    type: 'user',
    userId,
    aal: opts.aal ?? 'aal1',
    ...(opts.mfaAt !== undefined ? { mfaAt: opts.mfaAt } : {}),
  });
  const asMfa = (userId: string): UserActor => asUser(userId, { aal: 'aal2', mfaAt: Math.floor(Date.now() / 1000) });
  const asMcp = (userId: string, grantId: string, kind: 'company' | 'member'): UserActor => ({
    type: 'user',
    userId,
    aal: 'aal1',
    mcp: { grantId, clientId: 'sg2-client', clientName: 'SG2 Client', scopes: ['ludy.read'], kind },
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
    admin(async (c) => (await c.query<T>(text, params)).rows);

  async function person(tag: string): Promise<string> {
    const email = `${tag}-${randomUUID().slice(0, 8)}@sg2.test`;
    return (await upsertIdentity(db, { issuer: 'sg2-test', subject: randomUUID(), email, name: `User ${tag}` })) as string;
  }

  async function grant(orgId: string, userId: string, kind: 'company' | 'member'): Promise<string> {
    const id = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.agent_grant
       (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, 'SG2 Client', 'client.sg2.test', ARRAY['ludy.read'], $5, clock_timestamp(), now() + interval '30 days', $3, $6, ${kind === 'member' ? '$3' : 'NULL'})`,
      [orgId, id, userId, `client-${id}`, `oauth-${id}`, kind],
    );
    return id;
  }

  async function ingestPdf(orgId: string, userId: string, tag: string): Promise<string> {
    const bytes = Uint8Array.from(Buffer.from(`%PDF-1.4\n% sg2-${tag}-${randomUUID()}\n%%EOF\n`, 'utf8'));
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(store, storageKey, bytes, 'application/pdf', sha256);
    const ingested = await rt.execute<{ fileId: string }>(
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

  async function sendAndOpenEnvelope(opts: {
    orgId: string;
    creatorId: string;
    title: string;
    sourceKind?: 'standalone' | 'hr_contract' | 'meeting_minutes';
    sourceId?: string | null;
    signerEmail: string;
    signerRole?: 'signer' | 'approver' | 'cc';
    extraCcEmail?: string;
    openLink?: boolean;
    expiresAt?: string | null;
  }) {
    const sourceFileId = await ingestPdf(opts.orgId, opts.creatorId, opts.title.slice(0, 16));
    const created = await rt.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: opts.title,
        routingMode: 'parallel',
        sourceKind: opts.sourceKind ?? 'standalone',
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
        sourceFileId,
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
      { actor: asUser(opts.creatorId), orgId: opts.orgId, idempotencyKey: randomUUID() },
    );
    await worker.execute(
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
    const role = opts.signerRole ?? 'signer';
    const added = await rt.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: created.envelopeId,
        routingOrder: 1,
        signerRole: role,
        roleLabel: 'Partner',
        name: 'Secret Signer Name',
        email: opts.signerEmail,
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(opts.creatorId), orgId: opts.orgId, idempotencyKey: randomUUID() },
    );
    if (role !== 'cc') {
      await rt.execute(
        'sign.field.set',
        {
          envelopeId: created.envelopeId,
          fields: [
            {
              signerId: added.signerId,
              fieldType: 'signature',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.25,
              hNorm: 0.08,
              required: true,
              proposedByAi: false,
            },
          ],
        },
        { actor: asUser(opts.creatorId), orgId: opts.orgId, idempotencyKey: randomUUID() },
      );
    }
    let ccSignerId: string | null = null;
    if (opts.extraCcEmail) {
      const addedCc = await rt.execute<{ signerId: string }>(
        'sign.signer.add',
        {
          envelopeId: created.envelopeId,
          signerRole: 'cc',
          roleLabel: 'CC',
          name: 'CC Watcher',
          email: opts.extraCcEmail,
          deliveryMode: 'link',
          requireEmailOtp: false,
        },
        { actor: asUser(opts.creatorId), orgId: opts.orgId, idempotencyKey: randomUUID() },
      );
      ccSignerId = addedCc.signerId;
    }
    const sent = await rt.execute<{ envelopeId: string; links: Array<{ signerId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId: created.envelopeId },
      { actor: asUser(opts.creatorId), orgId: opts.orgId },
    );
    if (opts.openLink !== false && sent.links[0]) {
      const tokenHash = hashSigningToken(sent.links[0].token);
      await rt.orgless(async (orglessDb) => {
        await sql`
          SELECT ludy_sign.public_record_view(${tokenHash}, ${'b'.repeat(64)}, 'Sg2Test/1.0')
        `.execute(orglessDb);
      });
    }
    return { envelopeId: created.envelopeId, signerId: added.signerId, ccSignerId, fileId: sourceFileId };
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
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 6 });
    appPool = new pg.Pool({ connectionString: login('ludy_app', 'test-app-pw'), max: 3 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 3 });
    db = createDb(pool);

    const kernelCmds = buildKernelCommands({ shippedModules: AVAILABLE_MODULES });
    const allCommands = [...kernelCmds, ...crmCommands, ...financeCommands, ...meetingsCommands, ...signCommands];
    const allQueries = [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...financeQueries, ...meetingsQueries, ...signQueries];
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: allCommands,
      queries: allQueries,
    });
    rt.validate();
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: allCommands,
      queries: allQueries,
    });
    worker.validate();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  async function setupOrg() {
    const [owner, member, limited, viewer] = await Promise.all([person('owner'), person('member'), person('limited'), person('viewer')]);
    const { orgId } = await createOrg(rt, asUser(owner), `SG2 Org ${randomUUID().slice(0, 6)}`);
    const entity = (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]!.id;
    const branch = (await rows<{ id: string }>("INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Branch', 'branch', $2) RETURNING id", [orgId, owner]))[0]!.id;
    await rows(
      "INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')",
      [orgId, member, limited, viewer],
    );
    await rows('UPDATE ludy_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1', [orgId]);
    await rows("INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, limited, branch, owner]);
    await rt.execute('kernel.org.set_app', { module: 'sign', enabled: true }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
    await rt.execute<PipelineStage[]>('crm.pipeline.setup', {}, { actor: asUser(owner), orgId });
    return { orgId, owner, member, limited, viewer, entity, branch };
  }

  it('enforces sign.signals.opened email matching, duplicate collapse, 7-day window, CC exclusion, viewer = [], confidentiality, and MCP company-only access', async () => {
    const o = await setupOrg();
    const pKept = (await rows<{ id: string }>(
      "INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', 'Secret Kept Name', '  Alice@Acme.Test  ') RETURNING id",
      [o.orgId],
    ))[0]!.id;
    const pDupKeep = (await rows<{ id: string }>(
      "INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'organization', 'Kept Org', NULL) RETURNING id",
      [o.orgId],
    ))[0]!.id;
    await rows(
      "INSERT INTO ludy_kernel.party (org_id, kind, name, email, duplicate_of) VALUES ($1, 'organization', 'Dup Org', 'dup@acme.test', $2)",
      [o.orgId, pDupKeep],
    );
    const pHr = (await rows<{ id: string }>(
      "INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', 'HR Candidate', 'hr-secret@acme.test') RETURNING id",
      [o.orgId],
    ))[0]!.id;
    const pOld = (await rows<{ id: string }>(
      "INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', 'Old Signer', 'old@acme.test') RETURNING id",
      [o.orgId],
    ))[0]!.id;
    const pCc = (await rows<{ id: string }>(
      "INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', 'CC Watcher', 'cc@acme.test') RETURNING id",
      [o.orgId],
    ))[0]!.id;

    // 1. Valid standalone envelope opened by canonical party & merged duplicate party; also older envelope for pKept (must pick newest).
    const olderEnv = await sendAndOpenEnvelope({ orgId: o.orgId, creatorId: o.member, title: 'Older Env', signerEmail: 'alice@acme.test' });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE ludy_sign.signer SET viewed_at = now() - interval '2 days' WHERE org_id = $1 AND id = $2", [o.orgId, olderEnv.signerId]);
      await c.query('COMMIT');
    });
    const newerEnv = await sendAndOpenEnvelope({ orgId: o.orgId, creatorId: o.member, title: 'Newer Env', signerEmail: 'ALICE@ACME.TEST' });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE ludy_sign.signer SET viewed_at = now() - interval '1 hour' WHERE org_id = $1 AND id = $2", [o.orgId, newerEnv.signerId]);
      await c.query('COMMIT');
    });
    const dupEnv = await sendAndOpenEnvelope({ orgId: o.orgId, creatorId: o.member, title: 'Dup Env', signerEmail: 'dup@acme.test' });

    // 2. Unmatched signer email -> omitted.
    await sendAndOpenEnvelope({ orgId: o.orgId, creatorId: o.member, title: 'Unknown Signer', signerEmail: 'nobody@acme.test' });

    // 3. CC signer viewed -> excluded (alongside an unviewed primary signer with no matching party).
    const ccEnv = await sendAndOpenEnvelope({
      orgId: o.orgId,
      creatorId: o.member,
      title: 'CC Env',
      signerEmail: 'unused-primary@other.test',
      extraCcEmail: 'cc@acme.test',
      openLink: false,
    });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE ludy_sign.signer SET status = 'viewed', viewed_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, ccEnv.ccSignerId]);
      await c.query('COMMIT');
    });

    // 4. Stale (> 7 days) viewed -> excluded.
    const staleEnv = await sendAndOpenEnvelope({ orgId: o.orgId, creatorId: o.member, title: 'Old Env', signerEmail: 'old@acme.test' });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE ludy_sign.signer SET viewed_at = now() - interval '8 days' WHERE org_id = $1 AND id = $2", [o.orgId, staleEnv.signerId]);
      await c.query('COMMIT');
    });

    // 5. Confidential hr_contract (created by owner) & meeting_minutes (attendees meeting recorded by owner -> visible to owner in browser, NEVER to member or via MCP!).
    const hrEnv = await sendAndOpenEnvelope({
      orgId: o.orgId,
      creatorId: o.owner,
      title: 'HR Salary Offer',
      sourceKind: 'hr_contract',
      sourceId: randomUUID(),
      signerEmail: 'hr-secret@acme.test',
    });
    const mmParty = (await rows<{ id: string }>(
      "INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', 'Minutes Contact', 'minutes@acme.test') RETURNING id",
      [o.orgId],
    ))[0]!.id;
    await rt.execute('kernel.org.set_app', { module: 'meetings', enabled: true }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    const { meetingId } = await rt.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: 'Board Minutes Meeting',
        language: 'vi',
        visibility: 'attendees',
        keepVideo: false,
        liveNotes: false,
        summaryTemplate: 'general',
        consentMethod: 'told_at_start',
        readerUserIds: [],
      },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    await rt.execute('meetings.summary.save', { meetingId, summary: 'Private board notes', decisions: ['Approved'] }, { actor: asUser(o.owner), orgId: o.orgId });
    await rt.execute('meetings.result.publish', { meetingId, confirmed: true }, { actor: asUser(o.owner), orgId: o.orgId });
    const mmEnv = await sendAndOpenEnvelope({
      orgId: o.orgId,
      creatorId: o.owner,
      title: 'Board Minutes',
      sourceKind: 'meeting_minutes',
      sourceId: meetingId,
      signerEmail: 'minutes@acme.test',
    });

    // Browser viewer gets [].
    expect(await rt.query<SignOpenedSignal[]>(SIGN_OPENED_SIGNALS_READ, {}, { actor: asUser(o.viewer), orgId: o.orgId })).toEqual([]);

    // Browser member sees standalone kept & dup parties only (never hr_contract or meeting_minutes).
    const memberRows = await rt.query<SignOpenedSignal[]>(SIGN_OPENED_SIGNALS_READ, {}, { actor: asUser(o.member), orgId: o.orgId });
    expect(zSignOpenedSignals.safeParse(memberRows).success).toBe(true);
    expect(memberRows.map((r) => [r.partyId, r.envelopeId])).toEqual([
      [pDupKeep, dupEnv.envelopeId],
      [pKept, newerEnv.envelopeId],
    ]);
    expect(JSON.stringify(memberRows)).not.toMatch(/Secret|HR Salary|alice@|dup@/i);

    // Browser owner sees confidential HR & private meeting_minutes in addition to standalone.
    const ownerRows = await rt.query<SignOpenedSignal[]>(SIGN_OPENED_SIGNALS_READ, {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(ownerRows.map((r) => r.partyId).sort()).toEqual([pDupKeep, pHr, pKept, mmParty].sort());
    expect(ownerRows.some((r) => r.envelopeId === hrEnv.envelopeId)).toBe(true);
    expect(ownerRows.some((r) => r.envelopeId === mmEnv.envelopeId)).toBe(true);
    expect(ownerRows.some((r) => r.partyId === pOld || r.partyId === pCc)).toBe(false);

    // MCP member-bound grant is refused 403 FORBIDDEN.
    const memberGrant = await grant(o.orgId, o.member, 'member');
    await expect(rt.query(SIGN_OPENED_SIGNALS_READ, {}, { actor: asMcp(o.member, memberGrant, 'member'), orgId: o.orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    // MCP company grant (owner) succeeds and explicitly excludes hr_contract AND meeting_minutes even for owner!
    const companyGrant = await grant(o.orgId, o.owner, 'company');
    const mcpRows = await rt.query<SignOpenedSignal[]>(SIGN_OPENED_SIGNALS_READ, {}, { actor: asMcp(o.owner, companyGrant, 'company'), orgId: o.orgId });
    expect(zSignOpenedSignals.safeParse(mcpRows).success).toBe(true);
    expect(mcpRows.map((r) => [r.partyId, r.envelopeId])).toEqual([
      [pDupKeep, dupEnv.envelopeId],
      [pKept, newerEnv.envelopeId],
    ]);

    // Turning off 'sign' module gates runtime queries with MODULE_OFF (handled fail-closed by readSignals).
    await rt.execute('kernel.org.set_app', { module: 'sign', enabled: false }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(rt.query(SIGN_OPENED_SIGNALS_READ, {}, { actor: asUser(o.member), orgId: o.orgId })).rejects.toMatchObject({ code: 'MODULE_OFF' });
  });

  it('batches crm.signals.attention, honors per-member seen and RLS, omits customer_replied + seen under MCP, composes cap-5 Home list, and resolves crm.contact.get', async () => {
    const o = await setupOrg();
    const channelOpen = (
      await rows<{ id: string }>(
        "INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, connected_by) VALUES ($1, 'sandbox', $2, 'Ch Open', $3) RETURNING id",
        [o.orgId, `sg2-open-${randomUUID().slice(0, 6)}`, o.owner],
      )
    )[0]!.id;
    const channelRestricted = (
      await rows<{ id: string }>(
        "INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, connected_by) VALUES ($1, 'sandbox', $2, 'Ch Rest', $3) RETURNING id",
        [o.orgId, `sg2-rest-${randomUUID().slice(0, 6)}`, o.owner],
      )
    )[0]!.id;
    await rows('INSERT INTO ludy_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [
      o.orgId,
      o.limited,
      channelRestricted,
      o.owner,
    ]);

    const mkParty = async (kind: 'person' | 'organization', name: string, email: string | null = null) =>
      (await rows<{ id: string }>(
        'INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, $2, $3, $4) RETURNING id',
        [o.orgId, kind, name, email],
      ))[0]!.id;

    // 7 distinct contacts so we can verify cap 5 and oldest dropped:
    const p1Reply = await mkParty('person', 'P1 Customer Replied');
    const p2Opened = await mkParty('person', 'P2 Envelope Opened', 'p2-open@sg2.test');
    const p3Viewed = await mkParty('organization', 'P3 Quote Viewed');
    const p4Expiring = await mkParty('organization', 'P4 Quote Expiring');
    const p5Overdue = await mkParty('person', 'P5 Invoice Overdue');
    const p6Unanswered = await mkParty('person', 'P6 Quote Unanswered (older)');
    const p7OldOverdue = await mkParty('organization', 'P7 Oldest Overdue (cut)');

    // p1Reply: conversation reply after >= 7 days on channelOpen (hidden from `limited` via RLS, omitted under MCP).
    const convId = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO ludy_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, party_id, status, last_seq, last_inbound_at, last_message_at)
         VALUES ($1, $2, $3, 'comment_thread', $4, $5, 'new', 2, now() - interval '1 hour', now() - interval '1 hour')`,
        [o.orgId, convId, channelOpen, `t-${convId}`, p1Reply],
      );
      await c.query(
        `INSERT INTO ludy_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, body, send_state)
         VALUES
           ($1, $2, $3, 'comment_thread', 1, 'out', now() - interval '9 days', now() - interval '9 days', 'system', 'Old ping', 'sent'),
           ($1, $2, $3, 'comment_thread', 2, 'in', now() - interval '1 hour', now() - interval '1 hour', 'contact', 'PRIVATE_MSG_DO_NOT_LEAK', NULL)`,
        [o.orgId, convId, channelOpen],
      );
      await c.query('COMMIT');
    });

    // p2Opened: opened signing envelope 3 hours ago.
    const envP2 = await sendAndOpenEnvelope({ orgId: o.orgId, creatorId: o.member, title: 'P2 Sign', signerEmail: 'p2-open@sg2.test' });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE ludy_sign.signer SET viewed_at = now() - interval '3 hours' WHERE org_id = $1 AND id = $2", [o.orgId, envP2.signerId]);
      await c.query('COMMIT');
    });

    // Helper for deals + sent quotes.
    const makeSentQuote = async (partyId: string, sentDaysAgo: number, validInDays: number, num: string) => {
      const deal = await rt.execute<Deal>('crm.deal.create', { partyId, title: `Deal ${num}`, amount: '5000000', expectedClose: null }, { actor: asUser(o.member), orgId: o.orgId });
      const saved = await rt.execute<{ id: string }>(
        'crm.quote.save',
        { dealId: deal.id, lines: [{ kind: 'item', description: 'Line', unit: 'pcs', quantity: '1', unitPrice: '5000000', vatRate: '10%' }] },
        { actor: asUser(o.member), orgId: o.orgId },
      );
      await rows(
        "UPDATE ludy_crm.quote SET status = 'sent', number = $3, sent_at = now() - make_interval(days => $4), sent_via = 'link', valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + $5::int WHERE org_id = $1 AND id = $2",
        [o.orgId, saved.id, num, sentDaysAgo, validInDays],
      );
      return { dealId: deal.id, quoteId: saved.id };
    };

    // p3Viewed: quote viewed 6 hours ago.
    const q3 = await makeSentQuote(p3Viewed, 2, 14, 'BG-SG2-3');
    const link3 = await rt.execute<QuoteLinkCreated>('crm.quote.create_link', { quoteId: q3.quoteId }, { actor: asUser(o.member), orgId: o.orgId });
    await appPool.query('SELECT ludy_crm.quote_link_view($1::text) AS page', [link3.token]);
    await rows("UPDATE ludy_crm.quote SET first_viewed_at = now() - interval '6 hours' WHERE org_id = $1 AND id = $2", [o.orgId, q3.quoteId]);
    await rows("UPDATE ludy_crm.quote_link SET first_viewed_at = now() - interval '6 hours' WHERE org_id = $1 AND quote_id = $2", [o.orgId, q3.quoteId]);

    // p4Expiring & p6Unanswered: deal_next_step raised 12h ago (p4Expiring) and 4 days ago (p6Unanswered).
    await makeSentQuote(p4Expiring, 1, 1, 'BG-SG2-4');
    await makeSentQuote(p6Unanswered, 8, 10, 'BG-SG2-6');
    await worker.execute('crm.next_step.raise', {}, { actor: SYSTEM_CRM, orgId: o.orgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        "UPDATE ludy_crm.deal_next_step n SET raised_at = now() - interval '12 hours' FROM ludy_crm.deal d WHERE n.org_id = d.org_id AND n.deal_id = d.id AND n.org_id = $1 AND d.party_id = $2",
        [o.orgId, p4Expiring],
      );
      await c.query(
        "UPDATE ludy_crm.deal_next_step n SET raised_at = now() - interval '4 days' FROM ludy_crm.deal d WHERE n.org_id = d.org_id AND n.deal_id = d.id AND n.org_id = $1 AND d.party_id = $2",
        [o.orgId, p6Unanswered],
      );
      await c.query('COMMIT');
    });

    // p5Overdue (overdue 1 day) and p7OldOverdue (overdue 15 days) via open deals + sale invoices on default entity.
    await rt.execute<Deal>('crm.deal.create', { partyId: p5Overdue, title: 'Open P5', amount: '1000000', expectedClose: null }, { actor: asUser(o.member), orgId: o.orgId });
    await rt.execute<Deal>('crm.deal.create', { partyId: p7OldOverdue, title: 'Open P7', amount: '1000000', expectedClose: null }, { actor: asUser(o.member), orgId: o.orgId });
    const seedOverdue = (partyId: string, num: string, invoiceDate: string) =>
      admin(async (cl) => {
        const doc = randomUUID();
        const entry = randomUUID();
        await cl.query('BEGIN');
        await cl.query(
          `INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
           VALUES ($1, $2, $3, 'C26TAA', $4, $5, 'VND', 1000000, 0, 1000000, 'sale', $6)`,
          [o.orgId, doc, partyId, num, invoiceDate, o.entity],
        );
        await cl.query(
          `INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id)
           VALUES ($1, $2, $3, 'HD', 'finance.purchase_document', $4, $5)`,
          [o.orgId, entry, invoiceDate, doc, o.entity],
        );
        await cl.query(
          `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id)
           VALUES ($1, $2, 1, '131', 1000000, 0, $3, $4), ($1, $2, 2, '511', 0, 1000000, NULL, $4)`,
          [o.orgId, entry, partyId, o.entity],
        );
        await cl.query('COMMIT');
      });
    // Invoice date 31 days ago => overdue 1 day (after 30-day default); 45 days ago => overdue 15 days.
    await seedOverdue(p5Overdue, 'SG2-INV-5', addDays(TODAY, -31));
    await seedOverdue(p7OldOverdue, 'SG2-INV-7', addDays(TODAY, -45));

    // Check crm.signals.attention for member (all 4 kinds present, sorted newest-first).
    const crmMember = await rt.query<CrmAttentionSignal[]>(CRM_ATTENTION_SIGNALS_READ, {}, { actor: asUser(o.member), orgId: o.orgId });
    expect(zCrmAttentionSignals.safeParse(crmMember).success).toBe(true);
    expect(crmMember.map((r) => [r.partyId, r.kind])).toEqual([
      [p1Reply, 'customer_replied'],
      [p3Viewed, 'quote_viewed'],
      [p4Expiring, 'quote_expiring'],
      [p6Unanswered, 'quote_unanswered'],
    ]);
    expect(JSON.stringify(crmMember)).not.toContain('PRIVATE_MSG_DO_NOT_LEAK');

    // Home composition for owner/member: capped at 5 newest-first across CRM + Sign + Finance; oldest (p6, p7) dropped.
    const homeItems = await rt.query<TodayItem[]>('kernel.signals.contact_attention', {}, { actor: asUser(o.member), orgId: o.orgId });
    expect(zTodayItems.safeParse(homeItems).success).toBe(true);
    expect(homeItems).toHaveLength(CONTACT_ATTENTION_HOME_MAX);
    expect(homeItems.map((i) => i.href)).toEqual([
      `/contacts?c=${p1Reply}`,
      `/contacts?c=${p2Opened}`,
      `/contacts?c=${p3Viewed}`,
      `/contacts?c=${p4Expiring}`,
      `/contacts?c=${p5Overdue}`,
    ]);
    expect(homeItems[4]).toMatchObject({
      id: `signal:contact-attention:invoice_overdue:${p5Overdue}`,
      title: { key: 'signals.contactAttention.invoiceOverdue', params: { days: 1 } },
    });
    expect(homeItems.every((i) => i.amount === undefined && i.currency === undefined)).toBe(true);

    // Mark p3Viewed seen by `member` only -> disappears from `member` (p6 enters slot 5), remains visible to `owner` AND MCP!
    const p3Item = (await rt.query<{ items: PartyAttentionItem[] }>('crm.party.attention', { partyId: p3Viewed }, { actor: asUser(o.member), orgId: o.orgId })).items[0]!;
    await rt.execute(
      'crm.party.attention_seen',
      { partyId: p3Viewed, kind: p3Item.kind, targetId: p3Item.targetId, eventAt: p3Item.eventAt },
      { actor: asUser(o.member), orgId: o.orgId },
    );
    const memberAfterSeen = await rt.query<TodayItem[]>('kernel.signals.contact_attention', {}, { actor: asUser(o.member), orgId: o.orgId });
    expect(memberAfterSeen.map((i) => i.href)).toEqual([
      `/contacts?c=${p1Reply}`,
      `/contacts?c=${p2Opened}`,
      `/contacts?c=${p4Expiring}`,
      `/contacts?c=${p5Overdue}`,
      `/contacts?c=${p6Unanswered}`,
    ]);

    // Limited member (`limited`: no channelOpen access via RLS + partial branch-limited books scope in Finance):
    // Home omits customer_replied (RLS) and omits invoice_overdue (Finance partial view fail-closed), keeping Sign + allowed CRM items!
    const limitedHome = await rt.query<TodayItem[]>('kernel.signals.contact_attention', {}, { actor: asUser(o.limited), orgId: o.orgId });
    expect(limitedHome.map((i) => i.href)).toEqual([
      `/contacts?c=${p2Opened}`,
      `/contacts?c=${p3Viewed}`,
      `/contacts?c=${p4Expiring}`,
      `/contacts?c=${p6Unanswered}`,
    ]);

    // MCP under company grant (`owner`):
    // - crm.signals.attention omits customer_replied AND skips party_attention_seen (even if owner marks p3Viewed seen!).
    const ownerP3 = (await rt.query<{ items: PartyAttentionItem[] }>('crm.party.attention', { partyId: p3Viewed }, { actor: asUser(o.owner), orgId: o.orgId })).items[0]!;
    await rt.execute(
      'crm.party.attention_seen',
      { partyId: p3Viewed, kind: ownerP3.kind, targetId: ownerP3.targetId, eventAt: ownerP3.eventAt },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    const companyGrant = await grant(o.orgId, o.owner, 'company');
    const mcpCrm = await rt.query<CrmAttentionSignal[]>(CRM_ATTENTION_SIGNALS_READ, {}, { actor: asMcp(o.owner, companyGrant, 'company'), orgId: o.orgId });
    expect(mcpCrm.map((r) => [r.partyId, r.kind])).toEqual([
      [p3Viewed, 'quote_viewed'],
      [p4Expiring, 'quote_expiring'],
      [p6Unanswered, 'quote_unanswered'],
    ]);

    const mcpSignals = await rt.query<{ items: TodayItem[]; checked: string[]; unchecked: Array<{ rule: string; reason: string }> }>(
      'kernel.mcp.signals',
      {},
      { actor: asMcp(o.owner, companyGrant, 'company'), orgId: o.orgId },
    );
    expect(mcpSignals.checked).toContain('contact_attention');
    expect(mcpSignals.items.filter((i) => i.id.startsWith('signal:contact-attention:')).map((i) => i.href)).toEqual([
      `/contacts?c=${p2Opened}`,
      `/contacts?c=${p3Viewed}`,
      `/contacts?c=${p4Expiring}`,
      `/contacts?c=${p5Overdue}`,
      `/contacts?c=${p6Unanswered}`,
    ]);

    // MCP under branch-limited member grant (`limited`): contact_attention preserves verified CRM items while answering unchecked (`partial_view`).
    const limitedGrant = await grant(o.orgId, o.limited, 'member');
    const mcpLimited = await rt.query<{ items: TodayItem[]; checked: string[]; unchecked: Array<{ rule: string; reason: string }> }>(
      'kernel.mcp.signals',
      {},
      { actor: asMcp(o.limited, limitedGrant, 'member'), orgId: o.orgId },
    );
    expect(mcpLimited.unchecked).toContainEqual({ rule: 'contact_attention', reason: 'partial_view' });
    expect(mcpLimited.items.some((i) => i.id.startsWith('signal:contact-attention:'))).toBe(true);

    // crm.contact.get fetches both person and organization (and resolves merged duplicate -> canonical kept), rejecting unknown IDs.
    const gotPerson = await rt.query<Contact>('crm.contact.get', { partyId: p2Opened }, { actor: asUser(o.member), orgId: o.orgId });
    expect(gotPerson).toMatchObject({ id: p2Opened, kind: 'person', name: 'P2 Envelope Opened' });
    const gotOrg = await rt.query<Contact>('crm.contact.get', { partyId: p3Viewed }, { actor: asUser(o.viewer), orgId: o.orgId });
    expect(gotOrg).toMatchObject({ id: p3Viewed, kind: 'organization', name: 'P3 Quote Viewed' });
    const p3Dup = (await rows<{ id: string }>(
      "INSERT INTO ludy_kernel.party (org_id, kind, name, duplicate_of) VALUES ($1, 'organization', 'P3 Dup', $2) RETURNING id",
      [o.orgId, p3Viewed],
    ))[0]!.id;
    const gotMerged = await rt.query<Contact>('crm.contact.get', { partyId: p3Dup }, { actor: asUser(o.member), orgId: o.orgId });
    expect(gotMerged).toMatchObject({ id: p3Viewed, kind: 'organization', name: 'P3 Quote Viewed' });
    await expect(rt.query('crm.contact.get', { partyId: randomUUID() }, { actor: asUser(o.member), orgId: o.orgId })).rejects.toMatchObject({
      code: 'PARTY_NOT_FOUND',
    });
  });
});

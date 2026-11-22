// SPDX-License-Identifier: AGPL-3.0-only
// Stage 5D HR recruiting DB & crove-extract sandbox integration tests (#4446):
// 1. Additive migration columns (`source`, `hired_at` + backfill) and `hire` timestamp behavior.
// 2. Deterministic recruiting funnel BI (`hr.recruiting.analytics`): per-legal-entity SQL metrics,
//    conversion/drop-off %, SQL average/median time-to-hire, source effectiveness, 0 LLM cost, and PDPL erasure exclusion.
// 3. Sandboxed CV PDF & DOCX extraction via real `@ludy/extract` (`crove-extract`), T12 isolation,
//    AI-off parity, metered Ly `hr.cv_extract` draft proposal (never auto-saved, zero auto-decision), and zero PII in audits.
// 4. Engage Zalo OA / Facebook interview invite drafts (`hr.recruiting.inviteDraft`) backed by calendar slots (human send only).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InboxReader, metered } from '@ludy/agent';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createExtractApp } from '@ludy/extract';
import { createExtractClient } from '@ludy/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  type HrCandidateHireResult,
  type HrCandidateView,
  type HrCandidateWritten,
  type HrCvExtractResponse,
  type HrInviteDraftResult,
  type HrOpeningWritten,
  type HrRecruitingAnalyticsResult,
} from '@ludy/kernel-contract';
import {
  CredentialVault,
  DomainError,
  LocalDiskStore,
  Runtime,
  SUBJECT_WRAP_INFO,
  SubjectVault,
  type UserActor,
  parseVaultKey,
  sha256Hex,
} from '@ludy/kernel-runtime';
import { hrCommands, hrQueries, inferSuggestedSource } from '@ludy/mod-hr';
import { memberMeter } from '../src/ai-meter.ts';
import type { AuthUser } from '../src/auth.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runHrCvExtractJob, type HrCvExtractJob } from '../src/hr-cv-worker.ts';
import type { ConversationReader } from '../src/conversations-ai.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

function buildMinimalPdf(lines: readonly string[]): Uint8Array {
  const escaped = lines.map((line) => line.replace(/([()\\])/g, '\\$1'));
  const ops = escaped.map((line, i) => (i === 0 ? `(${line}) Tj` : `0 -18 Td (${line}) Tj`)).join(' ');
  const stream = `BT /F1 12 Tf 72 720 Td ${ops} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'utf8'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'utf8');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function buildMinimalZip(entries: Array<{ name: string; data: string }>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data, 'utf8');
    const body = deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(raw.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + body.byteLength;
  }
  const cdSize = centrals.reduce((sum, b) => sum + b.byteLength, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, eocd]));
}

function buildMinimalDocx(paragraphs: readonly string[]): Uint8Array {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</w:t></w:r></w:p>`)
    .join('');
  return buildMinimalZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

suite('HR Stage 5D: candidate source/hired_at, funnel BI analytics, crove-extract CV, and Engage invite drafts (#4446)', () => {
  const dbName = `crove_test_hr5d_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  let blobDir: string;
  let store: LocalDiskStore;

  const extractApp = createExtractApp();
  const realExtractClient = createExtractClient({
    url: 'http://crove-extract.local',
    fetch: (async (input, init) => Promise.resolve(extractApp.request(input instanceof Request ? input : new Request(input, init)))) as typeof fetch,
  });

  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org(names?: Partial<Record<'owner' | 'admin' | 'member' | 'viewer', string | null>>) {
    const tag = randomUUID().slice(0, 8);
    const person = (roleName: 'owner' | 'admin' | 'member' | 'viewer') =>
      upsertIdentity(createDb(pool), {
        issuer: 'hr5d',
        subject: `${roleName}-${tag}`,
        email: `${roleName}-${tag}@hr5d.test`,
        name: names?.[roleName] ?? null,
      });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId, slug } = await createOrg(rt, asUser(owner), `HR Stage5D ${tag}`);
    await withAdmin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [
        orgId,
        admin,
        member,
        viewer,
      ]),
    );
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    return { orgId, slug, owner, admin, member, viewer, exec, query };
  }

  function makeHttp(
    o: Awaited<ReturnType<typeof org>>,
    options: { elsewhere?: Awaited<ReturnType<typeof org>>; conversationReader?: ConversationReader; hrCvWaitMs?: number } = {},
  ) {
    const nowS = Math.floor(Date.now() / 1000);
    const users = new Map<string, AuthUser>([
      ...[o.owner, o.admin, o.member, o.viewer].map(
        (id) => [id, { userId: id, email: '', name: null, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: nowS }] as const,
      ),
      [
        'ext-user',
        {
          userId: o.admin,
          email: '',
          name: null,
          aal: 'aal1' as const,
          sessionId: '',
          mfaAt: null,
          extension: {
            tokenId: randomUUID(),
            orgId: o.orgId,
            userId: o.admin,
            scopes: ['meetings'] as const,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      ],
      ...(options.elsewhere
        ? [['other-owner', { userId: options.elsewhere.owner, email: '', name: null, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: nowS }] as const]
        : []),
    ]);
    const aiMeter = (actor: UserActor) => memberMeter(rt, actor, {});
    const app = createHttpApp({
      exports: new ConcurrencyLimiter({ total: 2, perKey: 2 }),
      config: loadConfig({
        DATABASE_URL: appUrl,
        AUTH_JWT_SECRET: 'test-only-jwt-secret-for-hr-stage5d-012345',
        AUTH_ISSUER: 'test-auth',
        WEB_DIST: '/nonexistent',
        EXPORT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
      runtime: rt,
      store,
      authenticate: async (header) => {
        const token = String(header ?? '').replace('Bearer ', '');
        const user = users.get(token);
        if (!user) throw new DomainError('UNAUTHENTICATED', 401, 'unauthenticated');
        return user;
      },
      pool,
      aiMeter,
      aiEnabled: options.conversationReader !== undefined,
      ...(options.conversationReader ? { conversationReader: options.conversationReader } : {}),
      ...(options.hrCvWaitMs !== undefined ? { hrCvWaitMs: options.hrCvWaitMs } : {}),
    });

    const postCv = async (token: string, bytes: Uint8Array, filename: string, mime: string, fields: Record<string, string> = {}, slug = o.slug) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      const res = await app.request('/api/hr/recruiting/cv-extract', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug },
        body: form,
      });
      const body = (await res.json().catch(() => null)) as HrCvExtractResponse & Record<string, unknown>;
      return { status: res.status, body };
    };

    const pollCv = async (token: string, jobId: string, query = '', slug = o.slug) => {
      const res = await app.request(`/api/hr/recruiting/cv-extract/${jobId}${query}`, {
        headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug },
      });
      const body = (await res.json().catch(() => null)) as HrCvExtractResponse & Record<string, unknown>;
      return { status: res.status, body };
    };

    const postRpc = async <T>(token: string, path: string, input: unknown, slug = o.slug) => {
      const res = await app.request(`/api/rpc/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-crove-org': slug },
        body: JSON.stringify({ json: input }),
      });
      const raw = (await res.json().catch(() => null)) as ({ json?: T } & Record<string, unknown>) | null;
      return { status: res.status, body: (raw && 'json' in raw ? raw.json : raw) as T & Record<string, unknown> };
    };

    return { app, postCv, pollCv, postRpc };
  }

  async function drainQueuedCvJobs(orgId: string) {
    const events = await withAdmin((c) =>
      c.query<{ id: string; payload: Omit<HrCvExtractJob, 'orgId'> }>(
        `SELECT e.id, e.payload
         FROM crove_kernel.outbox_event e
         WHERE e.org_id = $1
           AND e.type = 'hr.recruiting.cv_extract_queued'
           AND NOT EXISTS (
             SELECT 1
             FROM crove_kernel.audit_event a
             WHERE a.org_id = e.org_id
               AND a.command = 'hr.recruiting.cv_extract.complete'
               AND a.detail ->> 'jobId' = e.payload ->> 'jobId'
           )
         ORDER BY e.id ASC`,
        [orgId],
      ),
    );
    const out = [];
    for (const ev of events.rows) {
      out.push(
        await runHrCvExtractJob(
          { runtime: workerRt, store, extract: realExtractClient },
          { orgId, ...ev.payload },
        ),
      );
    }
    return out;
  }

  beforeAll(async () => {
    blobDir = mkdtempSync(join(tmpdir(), 'crove-hr5d-blobs-'));
    store = new LocalDiskStore(blobDir);
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appConn = new URL(adminUrl);
    appConn.username = 'crove_app';
    appConn.password = 'test-app-pw';
    appUrl = appConn.toString();
    const workerConn = new URL(adminUrl);
    workerConn.username = 'crove_worker';
    workerConn.password = 'test-worker-pw';

    pool = createPool({ connectionString: appUrl, max: 6 });
    workerPool = createPool({ connectionString: workerConn.toString(), max: 2 });
    const registry = {
      commands: [...kernelCommands, ...hrCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries],
    };
    rt = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      subjectVault,
      readAuditKey: randomBytes(32),
      stepUp: 'required',
    }).register(registry);
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    rmSync(blobDir, { recursive: true, force: true });
    if (ADMIN) {
      const rootDb = new pg.Client({ connectionString: ADMIN });
      await rootDb.connect();
      await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await rootDb.end();
    }
  });

  it('tracks candidate source, sets hired_at on hire, and enforces legal-entity-scoped funnel BI with erased isolation', async () => {
    const o = await org();
    const otherOrg = await org();

    const entities = await o.query<Array<{ id: string }>>(o.owner, 'kernel.legal_entity.list', {});
    const defaultEntityId = entities[0]!.id;
    const secondEntity = await o.exec<{ id: string }>(o.owner, 'kernel.legal_entity.create', {
      name: 'Chi nhánh Hà Nội',
      kind: 'branch',
      taxCode: null,
      parentId: defaultEntityId,
    });

    const opening1 = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      legalEntityId: defaultEntityId,
      title: 'Kế toán viên',
      contractType: 'indefinite',
      region: 'I',
      requiredSkills: ['MISA', 'Excel'],
    });
    const opening2 = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      legalEntityId: secondEntity.id,
      title: 'Nhân viên kinh doanh HN',
      contractType: 'indefinite',
      region: 'I',
    });

    // Rejects invalid source cleanly via CHECK constraint / schema validation
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.add', {
        openingId: opening1.openingId,
        displayName: 'Invalid Source',
        source: 'unknown_channel',
      }),
    ).rejects.toMatchObject({ status: 422 });

    // Create 5 candidates in entity 1 across different sources & stages + 1 in entity 2
    const cApplied = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening1.openingId,
      displayName: 'Ứng viên Applied',
      source: 'direct',
    });
    const cScreening = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening1.openingId,
      displayName: 'Ứng viên Screening',
      source: 'facebook',
    });
    await o.exec(o.admin, 'hr.recruiting.candidate.move_stage', { candidateId: cScreening.candidateId, toStage: 'screening' });

    const cHired = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening1.openingId,
      displayName: 'Ứng viên Hired Zalo',
      source: 'zalo_oa',
    });
    const hireRes = await o.exec<HrCandidateHireResult>(o.admin, 'hr.recruiting.candidate.hire', {
      candidateId: cHired.candidateId,
      effectiveFrom: '2026-12-01',
      baseWage: '15000000',
      allowDirectHire: true,
    });
    expect(hireRes.hiredAt).toBeTruthy();

    const cRejected = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening1.openingId,
      displayName: 'Ứng viên Rejected Referral',
      source: 'referral',
    });
    await o.exec(o.admin, 'hr.recruiting.candidate.move_stage', { candidateId: cRejected.candidateId, toStage: 'rejected' });

    const cErased = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening1.openingId,
      displayName: 'Bí mật đã xóa',
      email: 'secret@erased.test',
      source: 'job_board',
    });
    await o.exec(o.admin, 'hr.recruiting.candidate.move_stage', { candidateId: cErased.candidateId, toStage: 'rejected' });
    await o.exec(o.owner, 'hr.recruiting.candidate.erase', { candidateId: cErased.candidateId }, asMfa(o.owner));

    // Entity 2 candidate must stay isolated from Entity 1 analytics
    await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening2.openingId,
      displayName: 'Ứng viên Chi nhánh 2',
      source: 'facebook',
    });

    // Adjust timestamps cleanly in DB to verify deterministic 4.0 days time-to-hire average & median
    await withAdmin((c) =>
      c.query(
        `UPDATE crove_hr.candidate SET created_at = hired_at - interval '4 days' WHERE org_id = $1 AND id = $2`,
        [o.orgId, cHired.candidateId],
      ),
    );

    // Filter candidate list by source
    const zaloOnly = await o.query<HrCandidateView[]>(o.admin, 'hr.recruiting.candidate.list', { source: 'zalo_oa' });
    expect(zaloOnly.map((c) => c.id)).toEqual([cHired.candidateId]);
    expect(zaloOnly[0]!.hiredAt).toBe(hireRes.hiredAt);

    // Update source on non-hired candidate
    await o.exec(o.admin, 'hr.recruiting.candidate.edit', { candidateId: cApplied.candidateId, source: 'referral' });
    const edited = await o.query<HrCandidateView>(o.admin, 'hr.recruiting.candidate.get', { candidateId: cApplied.candidateId });
    expect(edited.source).toBe('referral');

    // Funnel analytics for Entity 1
    const analytics = await o.query<HrRecruitingAnalyticsResult>(o.admin, 'hr.recruiting.analytics', {
      legalEntityId: defaultEntityId,
      openingId: opening1.openingId,
    });
    expect(analytics.llmCost).toBe(0);
    expect(analytics.totalCandidates).toBe(4);
    expect(analytics.activeCandidates).toBe(2);
    expect(analytics.hiredCount).toBe(1);
    expect(analytics.rejectedCount).toBe(1);
    expect(analytics.erasedExcludedCount).toBe(1);
    expect(analytics.timeToHire).toEqual({ sampleSize: 1, avgDays: '4.0', medianDays: '4.0' });

    const screeningStep = analytics.funnel.find((f) => f.fromStage === 'applied' && f.toStage === 'screening');
    expect(screeningStep).toEqual({
      fromStage: 'applied',
      toStage: 'screening',
      enteredFromCount: 4,
      reachedToCount: 2,
      conversionPct: '50.0',
      dropOffPct: '50.0',
    });

    const zaloMetric = analytics.sources.find((s) => s.source === 'zalo_oa');
    expect(zaloMetric).toEqual({
      source: 'zalo_oa',
      totalCount: 1,
      activeCount: 0,
      hiredCount: 1,
      rejectedCount: 0,
      hireRatePct: '100.0',
      avgTimeToHireDays: '4.0',
    });
    // Erased candidate's job_board record is completely excluded from non-erased counts
    const jobBoardMetric = analytics.sources.find((s) => s.source === 'job_board');
    expect(jobBoardMetric?.totalCount).toBe(0);
    expect(JSON.stringify(analytics)).not.toContain('secret@erased.test');

    // Verify Entity 2 analytics stays isolated (1 candidate), both with explicit legalEntityId and openingId-only lookup
    const ent2Analytics = await o.query<HrRecruitingAnalyticsResult>(o.owner, 'hr.recruiting.analytics', {
      legalEntityId: secondEntity.id,
    });
    expect(ent2Analytics.totalCandidates).toBe(1);
    expect(ent2Analytics.erasedExcludedCount).toBe(0);

    const opening2OnlyAnalytics = await o.query<HrRecruitingAnalyticsResult>(o.owner, 'hr.recruiting.analytics', {
      openingId: opening2.openingId,
    });
    expect(opening2OnlyAnalytics.legalEntityId).toBe(secondEntity.id);
    expect(opening2OnlyAnalytics.totalCandidates).toBe(1);

    // RBAC & cross-org isolation
    await expect(o.query(o.member, 'hr.recruiting.analytics', {})).rejects.toMatchObject({ status: 403 });
    await expect(o.query(o.viewer, 'hr.recruiting.analytics', {})).rejects.toMatchObject({ status: 403 });
    await expect(otherOrg.query(otherOrg.owner, 'hr.recruiting.analytics', { openingId: opening1.openingId })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('extracts PDF and DOCX CVs strictly via crove-extract sandbox with AI-off parity, metered Ly drafts, and zero auto-save', async () => {
    const o = await org();
    const otherOrg = await org();
    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      title: 'Chuyên viên kế toán',
      contractType: 'indefinite',
      region: 'I',
      requiredSkills: ['MISA AMIS', 'Excel', 'Thuế GTGT'],
    });

    const pdfBytes = buildMinimalPdf([
      'Le Thi Thanh Ha',
      'Email: ha.ketoan@example.test | Phone: +84 912 345 678',
      '4 years of experience working with MISA AMIS and Excel.',
    ]);
    const docxBytes = buildMinimalDocx([
      'Phạm Quang Huy',
      'Email: huy.pham@example.com - ĐT: 0987654321',
      'Kinh nghiệm: 6 năm làm Thuế GTGT, MISA AMIS và Excel.',
    ]);

    // 1. AI OFF path: upload PDF -> 202 pending -> worker runs real crove-extract pdf_text -> poll 200 ready
    const httpAiOff = makeHttp(o, { elsewhere: otherOrg, hrCvWaitMs: 25 });
    const pdfUpload = await httpAiOff.postCv(o.admin, pdfBytes, 'cv-ha.pdf', 'application/pdf', {
      openingId: opening.openingId,
      lang: 'vi',
    });
    expect(pdfUpload.status).toBe(202);
    expect(pdfUpload.body.status).toBe('pending');
    const pdfJobId = (pdfUpload.body as { jobId: string }).jobId;

    // Poll before worker drains -> still pending; foreign org/member/extension refused
    expect((await httpAiOff.pollCv(o.admin, pdfJobId)).status).toBe(202);
    expect((await httpAiOff.pollCv(o.member, pdfJobId)).status).toBe(403);
    expect((await httpAiOff.pollCv('ext-user', pdfJobId)).status).toBe(403);
    expect((await httpAiOff.pollCv('other-owner', pdfJobId, '', o.slug)).status).toBe(403);
    expect((await httpAiOff.pollCv('other-owner', pdfJobId, '', otherOrg.slug)).status).toBe(404);

    // Worker executes real crove-extract pdf_text sandbox parser
    await drainQueuedCvJobs(o.orgId);

    const pdfReady = await httpAiOff.pollCv(o.admin, pdfJobId, `?openingId=${opening.openingId}`);
    expect(pdfReady.status).toBe(200);
    expect(pdfReady.body.status).toBe('ready');
    if (pdfReady.body.status !== 'ready') throw new Error('expected ready');
    expect(pdfReady.body.draft.ai).toEqual({ ok: false, reason: 'ai_off' });
    expect(pdfReady.body.draft.sourceKind).toBe('pdf_text');
    expect(pdfReady.body.draft.tainted).toBe(true);
    expect(pdfReady.body.draft.draftKind).toBe('proposal');
    expect(pdfReady.body.draft.autoSaved).toBe(false);
    expect(pdfReady.body.draft.autonomousDecision).toBe('none');
    expect(pdfReady.body.draft.displayName).toBe('Le Thi Thanh Ha');
    expect(pdfReady.body.draft.email).toBe('ha.ketoan@example.test');
    expect(pdfReady.body.draft.phone).toBe('0912345678');
    expect(pdfReady.body.draft.yearsExperience).toBe(4);
    expect(pdfReady.body.draft.matchedSkills).toEqual(expect.arrayContaining(['MISA AMIS', 'Excel']));

    // Verify ZERO candidate rows were auto-created by CV extraction!
    const candidatesBeforeSave = await o.query<HrCandidateView[]>(o.admin, 'hr.recruiting.candidate.list', {});
    expect(candidatesBeforeSave).toHaveLength(0);

    // 2. AI ON path: DOCX upload through real crove-extract docx_text + metered Ly (`hr.cv_extract`)
    const reader = new InboxReader(
      { baseURL: 'https://ai.local/v1', apiKey: 'test', model: 'test-model' },
      {
        cvExtract: vi.fn(() =>
          metered('hr.cv_extract', async () => ({
            output: {
              displayName: 'Phạm Quang Huy',
              email: 'huy.pham@example.com',
              phone: '0987654321',
              yearsExperience: 6,
              matchedSkills: ['Thuế GTGT', 'MISA AMIS', 'Excel'],
              summary: 'Ứng viên có 6 năm kinh nghiệm kế toán thuế và MISA AMIS.',
            },
            usage: { inputTokens: 150, outputTokens: 60 },
          })),
        ),
      },
    ) as unknown as ConversationReader;

    const httpAiOn = makeHttp(o, { elsewhere: otherOrg, conversationReader: reader, hrCvWaitMs: 6000 });
    // Wait until the new DOCX outbox_pending event commits, then drain it via worker + real crove-extract so POST returns 200 ready deterministically
    const workerDrainPromise = (async () => {
      for (let i = 0; i < 60; i += 1) {
        const pending = await withAdmin((c) =>
          c.query<{ count: string }>(
            `SELECT pg_catalog.count(*)::text AS count
             FROM crove_kernel.outbox_event e
             JOIN crove_kernel.outbox_pending p
               ON p.org_id = e.org_id AND p.event_id = e.id
             WHERE e.org_id = $1
               AND e.type = 'hr.recruiting.cv_extract_queued'
               AND NOT EXISTS (
                 SELECT 1
                 FROM crove_kernel.audit_event a
                 WHERE a.org_id = e.org_id
                   AND a.command = 'hr.recruiting.cv_extract.complete'
                   AND a.detail ->> 'jobId' = e.payload ->> 'jobId'
               )`,
            [o.orgId],
          ),
        );
        if (Number(pending.rows[0]?.count ?? 0) > 0) {
          await drainQueuedCvJobs(o.orgId);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('timed out waiting for hr.recruiting.cv_extract_queued outbox row');
    })();
    const docxReady = await httpAiOn.postCv(
      o.owner,
      docxBytes,
      'cv-huy.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      { openingId: opening.openingId, lang: 'vi' },
    );
    await workerDrainPromise;
    expect(docxReady.status).toBe(200);
    expect(docxReady.body.status).toBe('ready');
    if (docxReady.body.status !== 'ready') throw new Error('expected ready');
    expect(docxReady.body.draft.sourceKind).toBe('docx_text');
    expect(docxReady.body.draft.ai).toEqual({ ok: true, reason: 'ok' });
    expect(docxReady.body.draft.displayName).toBe('Phạm Quang Huy');
    expect(docxReady.body.draft.phone).toBe('0987654321');
    expect(docxReady.body.draft.yearsExperience).toBe(6);
    expect(docxReady.body.draft.matchedSkills).toEqual(expect.arrayContaining(['Thuế GTGT', 'MISA AMIS', 'Excel']));
    expect(docxReady.body.draft.autoSaved).toBe(false);

    // Check meter usage recorded for hr.cv_extract and NO raw PII/text in audit_event
    const usageRows = await withAdmin((c) =>
      c.query<{ feature: string; module: string }>(
        `SELECT feature, module FROM crove_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost' AND feature = 'hr.cv_extract'`,
        [o.orgId],
      ),
    );
    expect(usageRows.rows).toHaveLength(1);
    expect(usageRows.rows[0]).toEqual({ feature: 'hr.cv_extract', module: 'hr' });

    const auditText = JSON.stringify(
      (await withAdmin((c) => c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'hr.recruiting.cv_extract.%'`, [o.orgId]))).rows,
    );
    expect(auditText).not.toContain('ha.ketoan@example.test');
    expect(auditText).not.toContain('Phạm Quang Huy');
    expect(auditText).not.toContain('0987654321');

    // Verify non-manager member upload is refused 403 BEFORE touching BlobStore
    const unauthPdf = buildMinimalPdf(['Unauthorized Member CV 2026']);
    const unauthKey = `tmp/${o.orgId}/${sha256Hex(unauthPdf)}`;
    const memberUpload = await httpAiOff.postCv(o.member, unauthPdf, 'unauth.pdf', 'application/pdf', { openingId: opening.openingId });
    expect(memberUpload.status).toBe(403);
    await expect(store.get(unauthKey)).rejects.toThrow();

    // Verify repeated poll stays idempotent (200 ready) and cross-opening/invalid override fails 422
    const pdfRepeatPoll = await httpAiOff.pollCv(o.admin, pdfJobId, `?openingId=${opening.openingId}`);
    expect(pdfRepeatPoll.status).toBe(200);
    expect((await httpAiOff.pollCv(o.admin, pdfJobId, `?openingId=${randomUUID()}`)).status).toBe(422);
    expect((await httpAiOff.pollCv(o.admin, pdfJobId, '?openingId=not-a-uuid')).status).toBe(422);

    // Unsupported file type refused with 415
    const txtRefused = await httpAiOff.postCv(o.admin, new TextEncoder().encode('hello world'), 'cv.txt', 'text/plain');
    expect(txtRefused.status).toBe(415);

    // URL host matching never falls for query-string / subdomain spoofing
    expect(inferSuggestedSource('Profile: https://fb.com/candidate-page')).toBe('facebook');
    expect(inferSuggestedSource('Profile: https://sub.facebook.com/candidate')).toBe('facebook');
    expect(inferSuggestedSource('Profile: https://evil.example/?ref=fb.com&next=facebook.com')).toBe('direct');
    expect(inferSuggestedSource('Profile: https://zalo.me/0912345678')).toBe('zalo_oa');
    expect(inferSuggestedSource('Profile: https://www.topcv.vn/xem-cv/abc')).toBe('job_board');
  });

  it('generates slot-backed Vietnamese Engage interview invite drafts and refuses erased/non-admin callers', async () => {
    const o = await org({ owner: 'Chủ Doanh Nghiệp', admin: 'Quản Lý Nhân Sự' });
    const otherOrg = await org();
    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      title: 'Nhân viên CSKH',
      contractType: 'indefinite',
      region: 'I',
    });
    const cand = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Trần Thu Hà',
      source: 'zalo_oa',
    });

    const http = makeHttp(o, { elsewhere: otherOrg });
    const draftRes = await http.postRpc<HrInviteDraftResult>(o.admin, 'hr/recruiting/inviteDraft', {
      candidateId: cand.candidateId,
      channel: 'zalo_oa',
      interviewerUserId: o.owner,
      from: '2026-12-01',
      to: '2026-12-07',
      lang: 'vi',
    });
    expect(draftRes.status).toBe(200);
    expect(draftRes.body.autoSent).toBe(false);
    expect(draftRes.body.humanSendRequired).toBe(true);
    expect(draftRes.body.channel).toBe('zalo_oa');
    expect(draftRes.body.openingTitle).toBe('Nhân viên CSKH');
    expect(draftRes.body.interviewerName).toBe('Chủ Doanh Nghiệp');
    expect(draftRes.body.slots.length).toBeGreaterThan(0);
    expect(draftRes.body.message).toContain('Trần Thu Hà');
    expect(draftRes.body.message).toContain('Nhân viên CSKH');
    expect(draftRes.body.message).toContain('Zalo OA');

    // RBAC & cross-org isolation
    expect((await http.postRpc(o.member, 'hr/recruiting/inviteDraft', { candidateId: cand.candidateId, channel: 'facebook' })).status).toBe(403);
    expect((await http.postRpc('other-owner', 'hr/recruiting/inviteDraft', { candidateId: cand.candidateId, channel: 'facebook' }, otherOrg.slug)).status).toBe(404);

    // Erased candidates must be refused
    await o.exec(o.admin, 'hr.recruiting.candidate.move_stage', { candidateId: cand.candidateId, toStage: 'rejected' });
    await o.exec(o.owner, 'hr.recruiting.candidate.erase', { candidateId: cand.candidateId }, asMfa(o.owner));
    expect((await http.postRpc(o.owner, 'hr/recruiting/inviteDraft', { candidateId: cand.candidateId, channel: 'zalo_oa' })).status).toBe(409);
  });
});

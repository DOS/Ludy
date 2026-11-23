// SPDX-License-Identifier: AGPL-3.0-only
// Database integration tests for #4001 Slice 2 (meetings.transcript.redact_candidates,
// meetings.transcript.redact, and kernel.member_vy.subject_results.drop on PostgreSQL 17):
// - Recorder-only access (rejecting owner, admin, attendee reader, non-reader, viewer, agents, system, cross-org).
// - Deterministic scanning and selective redaction across all 9 draft publish surfaces; near-misses stay untouched.
// - Server re-detection and rejection of stale versions, tampered/shifted client offsets, and duplicates.
// - Published immutability (D3), including meeting.title once any surface is published and accepted action items.
// - Dropping recorder's own private Vy results, cancelling live Vy runs, and dropping draft translations (D5).
// - Zero original values kept (D2), search generated column + MCP minutes read clean after publish, audit counts only, AI off.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  REDACTION_MARK_BY_KIND,
  type MeetingSearchResult,
  type TranscriptRedactCandidates,
  type TranscriptRedacted,
} from '@ludy/kernel-contract';
import { Runtime, type AgentActor, type SystemActor, type UserActor } from '@ludy/kernel-runtime';
import { encodeTranscriptResult, meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const SYSTEM_ACTOR: SystemActor = { type: 'system', component: 'redact-test' };

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const EMAIL_PII = 'khach.hang@example.com';
const SPEAKER_EMAIL = 'speaker.line@example.net';
const PHONE_PII = '0912 345 678';
const TITLE_PHONE = '0987 654 321';
const WHO_EMAIL = 'who.contact@example.org';
const WHEN_PHONE = '0901 234 567';
const TAX_PII = '5900000018';
const CCCD_PII = '079091001234';
const BANK_PII = '1900123456789012';
const CHAPTER_PHONE = '0999 888 777';
const ALL_SECRET_TOKENS = [
  'khach.hang',
  'speaker.line',
  'who.contact',
  '0912 345',
  '345 678',
  '0987 654',
  '654 321',
  '0901 234',
  '234 567',
  '5900000018',
  '079091001234',
  '1900123456789012',
  '0999 888',
  '888 777',
];

suite('meeting draft redaction commands (#4001 Slice 2)', () => {
  const dbName = `crove_test_meetings_redact_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};

  const asUser = (who: string): UserActor => ({ type: 'user', userId: users[who] as string, aal: 'aal1' });
  const exec = <O = unknown>(who: string, name: string, input: unknown, org = orgId) =>
    runtime.execute<O>(name, input, { actor: asUser(who), orgId: org });
  const query = <O = unknown>(who: string, name: string, input: unknown, org = orgId) =>
    runtime.query<O>(name, input, { actor: asUser(who), orgId: org });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => (err as { code?: string }).code ?? 'ERR');

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<R>(text, params)).rows);

  async function waitForBlockedOnPid(holdPid: number, minBlocked = 1): Promise<number[]> {
    for (let i = 0; i < 200; i += 1) {
      const blocked = await sqlAdmin<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid)) ORDER BY pid`,
        [holdPid],
      );
      if (blocked.length >= minBlocked) return blocked.map((r) => r.pid);
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out waiting for ${minBlocked} transaction(s) to block on pid ${holdPid}`);
  }

  async function seedMeeting(
    opts: { recorder?: string; readers?: string[]; title?: string; visibility?: 'attendees' | 'org'; org?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const rec = users[opts.recorder ?? 'recorder'] as string;
    const targetOrg = opts.org ?? orgId;
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (
         org_id, id, title, language, started_at, ended_at, length_seconds,
         recorder_user_id, visibility, status, consent_method, consent_confirmed_by,
         consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date
       )
       VALUES ($1, $2, $3, 'vi', now(), now() + interval '30 minutes', 1800, $4, $5, 'ready', 'told_at_start', $4, now(), '1.0', current_date + 30, current_date + 365)`,
      [targetOrg, id, opts.title ?? 'Họp định kỳ', rec, opts.visibility ?? 'attendees'],
    );
    for (const reader of opts.readers ?? []) {
      await sqlAdmin(
        `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`,
        [targetOrg, randomUUID(), id, users[reader]],
      );
    }
    return id;
  }

  async function seedOrgAgentActor(): Promise<AgentActor> {
    const agentId = randomUUID();
    const runId = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(
        `INSERT INTO ludy_kernel.agent_template (key, module, title, role_key, max_risk, job_description)
         VALUES ('redact.probe', 'meetings', 'Probe', 'member', 'R2', '{}'::jsonb) ON CONFLICT DO NOTHING`,
      );
      await c.query(
        `INSERT INTO ludy_kernel.agent (org_id, id, template_key, display_name, kind, max_risk, status, created_by)
         VALUES ($1, $2, 'redact.probe', 'Agent Redact', 'org_chart', 'R2', 'active', $3)`,
        [orgId, agentId, users.owner],
      );
      await c.query(
        `INSERT INTO ludy_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at)
         VALUES ($1, $2, $3, 'meetings', 'running', false, now(), now() + interval '30 minutes')`,
        [orgId, runId, agentId],
      );
      await c.query('COMMIT');
    });
    return {
      type: 'agent',
      agentId,
      runId,
    };
  }

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    pools.push(pool);
    const db = createDb(pool);

    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });

    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'other', 'viewer', 'outsider']) {
      users[key] = await upsertIdentity(db, { issuer: 'redact-test', subject: key, email: `${key}@redact.test`, name: key });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Org Redact')).orgId;
    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer')`,
      [orgId, users.admin, users.recorder, users.attendee, users.other, users.viewer],
    );
    await createOrg(runtime, asUser('outsider'), 'Other Org');
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('allows only the meeting recorder (never owner, admin, attendee reader, non-reader, viewer, agent, member_vy, system, or cross-org)', async () => {
    const meetingId = await seedMeeting({
      readers: ['attendee'],
      title: `Họp với ${TITLE_PHONE}`,
    });
    await exec('recorder', 'meetings.transcript.draft_store', {
      meetingId,
      segments: [{ startSeconds: 0, endSeconds: 5, speakerLabel: 'Lan', text: `Gọi ${PHONE_PII} hoặc email ${EMAIL_PII}` }],
    });

    const scan = await query<TranscriptRedactCandidates>('recorder', 'meetings.transcript.redact_candidates', { meetingId });
    expect(scan.candidates.length).toBe(3);
    const first = scan.candidates[0]!;
    const payload = {
      meetingId,
      confirmed: true as const,
      items: [{ surface: first.surface, targetId: first.targetId, decisionIndex: first.decisionIndex, kind: first.kind, startPos: first.startPos, version: first.version }],
    };

    for (const actorKey of ['attendee', 'viewer']) {
      expect(await refuses(query(actorKey, 'meetings.transcript.redact_candidates', { meetingId })), `scan ${actorKey}`).toBe('FORBIDDEN');
      expect(await refuses(exec(actorKey, 'meetings.transcript.redact', payload)), `redact ${actorKey}`).toBe('FORBIDDEN');
    }
    // Owner and admin who are not readers of an attendees-only meeting see no meeting (RLS); even when added as readers, they cannot scan/redact drafts.
    for (const actorKey of ['owner', 'admin', 'other']) {
      expect(await refuses(query(actorKey, 'meetings.transcript.redact_candidates', { meetingId })), `scan hidden ${actorKey}`).toBe('MEETING_NOT_FOUND');
      expect(await refuses(exec(actorKey, 'meetings.transcript.redact', payload)), `redact hidden ${actorKey}`).toBe('MEETING_NOT_FOUND');
    }
    expect(await refuses(query('outsider', 'meetings.transcript.redact_candidates', { meetingId })), 'scan cross-org').toBe('NOT_A_MEMBER');
    expect(await refuses(exec('outsider', 'meetings.transcript.redact', payload)), 'redact cross-org').toBe('NOT_A_MEMBER');
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4), ($1, $5, $3, $6)`,
      [orgId, randomUUID(), meetingId, users.owner, randomUUID(), users.admin],
    );
    for (const actorKey of ['owner', 'admin']) {
      expect(await refuses(query(actorKey, 'meetings.transcript.redact_candidates', { meetingId })), `scan reader ${actorKey}`).toBe('FORBIDDEN');
      expect(await refuses(exec(actorKey, 'meetings.transcript.redact', payload)), `redact reader ${actorKey}`).toBe('FORBIDDEN');
    }

    const orgAgent = await seedOrgAgentActor();
    expect(await refuses(runtime.query('meetings.transcript.redact_candidates', { meetingId }, { actor: orgAgent, orgId }))).toBe('FORBIDDEN');
    expect(await refuses(runtime.execute('meetings.transcript.redact', payload, { actor: orgAgent, orgId }))).toBe('FORBIDDEN');
    expect(await refuses(runtime.query('meetings.transcript.redact_candidates', { meetingId }, { actor: SYSTEM_ACTOR, orgId }))).toBe('FORBIDDEN');
    expect(await refuses(runtime.execute('meetings.transcript.redact', payload, { actor: SYSTEM_ACTOR, orgId }))).toBe('FORBIDDEN');

    const vyRun = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', {
      feature: 'meetings.summary',
      subjectType: 'meeting',
      subjectId: meetingId,
    });
    const vyAgentId = (
      await sqlAdmin<{ id: string }>(
        `SELECT id FROM ludy_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`,
        [orgId, users.recorder],
      )
    )[0]!.id;
    const vyActor: AgentActor = {
      type: 'agent',
      agentId: vyAgentId,
      runId: vyRun.runId,
      memberVy: true,
    };
    expect(await refuses(runtime.query('meetings.transcript.redact_candidates', { meetingId }, { actor: vyActor, orgId }))).toBe('FORBIDDEN');
    expect(await refuses(runtime.execute('meetings.transcript.redact', payload, { actor: vyActor, orgId }))).toBe('FORBIDDEN');

    // Clean up live run via the recorder's own redaction.
    const done = await exec<TranscriptRedacted>('recorder', 'meetings.transcript.redact', payload);
    expect(done.redactedCount).toBe(1);
    expect(done.cancelledVyRuns).toBe(1);
  });

  it('scans all 9 draft surfaces, skips near-misses, confirms selectively, clears item contact flag, and exposes clean search & MCP reads after publish (with AI off)', async () => {
    const meetingId = await seedMeeting({
      readers: ['attendee'],
      visibility: 'org',
      title: `Họp hợp đồng ${TITLE_PHONE}`,
    });

    // Engage AI org kill switch to verify deterministic operation works identically with AI off (D4).
    const ksId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_kernel.kill_switch (org_id, id, scope, target, reason, engaged_by)
       VALUES ($1, $2, 'org', '*', 'AI off test', $3)`,
      [orgId, ksId, users.owner],
    );
    try {
      await exec('recorder', 'meetings.transcript.draft_store', {
        meetingId,
        segments: [
          {
            startSeconds: 0,
            endSeconds: 10,
            speakerLabel: SPEAKER_EMAIL,
            text: `Liên hệ ${EMAIL_PII} hoặc ${PHONE_PII}; giá 1.250.000 đồng năm 2026 cho 120 người (mã 1234567).`,
          },
        ],
      });
      await exec('recorder', 'meetings.summary.save', {
        meetingId,
        summary: `Hóa đơn xuất theo MST ${TAX_PII}, chi phí 50.000.000 đ.`,
        decisions: [`CCCD người đại diện: ${CCCD_PII}`, `Chuyển khoản STK ${BANK_PII}`, 'Hoàn tất trong tháng 11.'],
      });
      const { itemId: flaggedItemId } = await exec<{ itemId: string }>('recorder', 'meetings.action_item.create', {
        meetingId,
        title: `Gọi khách hàng ${PHONE_PII}`,
        who: WHO_EMAIL,
        whoUserId: users.attendee as string,
        when: `Hạn ${WHEN_PHONE}`,
        whenDate: '2026-11-30',
        transcriptSeconds: 0,
      });
      // Create and accept a draft action item into a team task: must NOT be proposed or redacted.
      const posId = randomUUID();
      await sqlAdmin(
        `INSERT INTO ludy_kernel.position (org_id, id, title, module, role_key, holder_user_id)
         VALUES ($1, $2, 'Nhân viên', 'kernel', 'member', $3)`,
        [orgId, posId, users.attendee],
      );
      const { itemId: acceptedItemId } = await exec<{ itemId: string }>('recorder', 'meetings.action_item.create', {
        meetingId,
        title: 'Đã giao 0911 111 222',
        who: 'An',
        whoUserId: users.attendee as string,
        when: '',
        whenDate: null,
        transcriptSeconds: null,
      });
      await exec('recorder', 'meetings.action_item.accept', {
        itemId: acceptedItemId,
        confirmed: true,
        title: 'Đã giao 0911 111 222',
        due: null,
        positionId: posId,
      });
      // Insert a draft chapter carrying a phone number (e.g. legacy / model-written row).
      const chapterId = randomUUID();
      await sqlAdmin(
        `INSERT INTO ludy_meetings.meeting_chapter (org_id, id, meeting_id, stage, position, title, start_seconds, tainted)
         VALUES ($1, $2, $3, 'draft', 1, $4, 0, false)`,
        [orgId, chapterId, meetingId, `Phần 1 gọi ${CHAPTER_PHONE}`],
      );

      const beforeItems = await query<{ items: Array<{ id: string; flags: string[] }> }>('recorder', 'meetings.result.get', { meetingId });
      expect(beforeItems.items.find((i) => i.id === flaggedItemId)?.flags).toEqual(['contact_in_title']);

      const scan = await query<TranscriptRedactCandidates>('recorder', 'meetings.transcript.redact_candidates', { meetingId });
      expect(scan.titleEditable).toBe(true);
      expect(scan.truncated).toBe(false);

      const summaryBySurface = scan.candidates.map((c) => `${c.surface}:${c.kind}:${c.decisionIndex ?? ''}:${c.matchText}`);
      expect(summaryBySurface).toEqual([
        `meeting.title:phone::${TITLE_PHONE}`,
        `transcript_segment.text:email::${EMAIL_PII}`,
        `transcript_segment.text:phone::${PHONE_PII}`,
        `transcript_segment.speaker_label:email::${SPEAKER_EMAIL}`,
        `meeting_result.summary:tax_code::${TAX_PII}`,
        `meeting_result.decision:national_id:0:${CCCD_PII}`,
        `meeting_result.decision:bank_account:1:${BANK_PII}`,
        `action_item.title:phone::${PHONE_PII}`,
        `action_item.who_drafted:email::${WHO_EMAIL}`,
        `action_item.when_drafted:phone::${WHEN_PHONE}`,
        `meeting_chapter.title:phone::${CHAPTER_PHONE}`,
      ]);
      // Near-misses and accepted action items were not proposed.
      expect(scan.candidates.some((c) => c.matchText.includes('1.250.000') || c.matchText.includes('2026') || c.matchText.includes('0911'))).toBe(false);

      // Accepted draft action item cannot be targeted directly either.
      const acceptedVer = (
        await sqlAdmin<{ v: string }>(
          `SELECT pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS v FROM ludy_meetings.action_item WHERE id = $1`,
          [acceptedItemId],
        )
      )[0]!.v;
      expect(
        await refuses(
          exec('recorder', 'meetings.transcript.redact', {
            meetingId,
            confirmed: true,
            items: [{ surface: 'action_item.title', targetId: acceptedItemId, decisionIndex: null, kind: 'phone', startPos: 9, version: acceptedVer }],
          }),
        ),
      ).toBe('REDACTION_PUBLISHED_IMMUTABLE');

      // Selectively confirm ALL EXCEPT the chapter phone first.
      const confirmedItems = scan.candidates.slice(0, -1).map((c) => ({
        surface: c.surface,
        targetId: c.targetId,
        decisionIndex: c.decisionIndex,
        kind: c.kind,
        startPos: c.startPos,
        version: c.version,
      }));
      const firstPass = await exec<TranscriptRedacted>('recorder', 'meetings.transcript.redact', {
        meetingId,
        confirmed: true,
        items: confirmedItems,
      });
      expect(firstPass.redactedCount).toBe(10);
      expect(firstPass.countsByKind).toEqual({
        email: 3,
        phone: 4,
        national_id: 1,
        tax_code: 1,
        bank_account: 1,
      });

      // Unconfirmed chapter phone stayed untouched; confirmed items were hidden with typed marks.
      const rescan = await query<TranscriptRedactCandidates>('recorder', 'meetings.transcript.redact_candidates', { meetingId });
      expect(rescan.candidates.map((c) => `${c.surface}:${c.matchText}`)).toEqual([`meeting_chapter.title:${CHAPTER_PHONE}`]);

      // Now confirm the remaining chapter phone.
      const last = rescan.candidates[0]!;
      const secondPass = await exec<TranscriptRedacted>('recorder', 'meetings.transcript.redact', {
        meetingId,
        confirmed: true,
        items: [{ surface: last.surface, targetId: last.targetId, decisionIndex: null, kind: last.kind, startPos: last.startPos, version: last.version }],
      });
      expect(secondPass.redactedCount).toBe(1);
      expect(secondPass.countsByKind.phone).toBe(1);

      const finalScan = await query<TranscriptRedactCandidates>('recorder', 'meetings.transcript.redact_candidates', { meetingId });
      expect(finalScan.candidates).toEqual([]);

      // Action item flag cleared once phone number was removed.
      const afterItems = await query<{ items: Array<{ id: string; flags: string[]; title: string }> }>('recorder', 'meetings.result.get', { meetingId });
      const itemView = afterItems.items.find((i) => i.id === flaggedItemId);
      expect(itemView?.title).toBe(`Gọi khách hàng ${REDACTION_MARK_BY_KIND.phone}`);
      expect(itemView?.flags).toEqual([]);

      // Publish and publish transcript segments for downstream search & MCP verification.
      await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
      await sqlAdmin(`UPDATE ludy_meetings.transcript_segment SET stage = 'published' WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId]);

      // Search generated column & meetings.search contain zero hidden values and return no hit for hidden PII.
      for (const q of ['0912', 'khach', '5900000018', '1900123456789012', '079091001234']) {
        const hits = await query<MeetingSearchResult>('attendee', 'meetings.search', { q });
        expect(hits.hits, `search ${q}`).toEqual([]);
      }
      const markHits = await query<MeetingSearchResult>('attendee', 'meetings.search', { q: 'thoai' });
      expect(markHits.hits).toHaveLength(1);
      expect(markHits.hits[0]?.text).toContain(REDACTION_MARK_BY_KIND.phone);
      expect(markHits.hits[0]?.speakerLabel).toBe(REDACTION_MARK_BY_KIND.email);
    } finally {
      // Release AI org kill switch before MCP grant check (mcp_grant_standing checks org kill switch).
      await sqlAdmin(`DELETE FROM ludy_kernel.kill_switch WHERE org_id = $1 AND id = $2`, [orgId, ksId]);
    }

    // MCP company grant read (ludy_meeting_minutes & ludy_meetings_search) sees only marks, zero original values.
    const grantId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, 'Client', 'client.example.test', ARRAY['ludy.read'], $5, clock_timestamp(), now() + interval '7 days', $3, 'company', NULL)`,
      [orgId, grantId, users.owner, `c-${grantId}`, `o-${grantId}`],
    );
    const mcpActor: UserActor = {
      type: 'user',
      userId: users.owner as string,
      aal: 'aal1',
      mcp: { grantId, clientId: `c-${grantId}`, clientName: 'Client', scopes: ['ludy.read'], kind: 'company' },
    };
    const minutes = await runtime.query<{
      title: string;
      summaryLines: string[];
      decisions: string[];
      actions: Array<{ title: string; who: string | null }>;
    }>('meetings.mcp.minutes', { meetingId }, { actor: mcpActor, orgId });
    expect(minutes.title).toBe(`Họp hợp đồng ${REDACTION_MARK_BY_KIND.phone}`);
    expect(minutes.summaryLines.join('\n')).toContain(REDACTION_MARK_BY_KIND.tax_code);
    expect(minutes.decisions[0]).toContain(REDACTION_MARK_BY_KIND.national_id);
    expect(minutes.decisions[1]).toContain(REDACTION_MARK_BY_KIND.bank_account);
    expect(minutes.actions.some((a) => a.title.includes(REDACTION_MARK_BY_KIND.phone) && a.who === REDACTION_MARK_BY_KIND.email)).toBe(true);

    const mcpBlob = JSON.stringify(minutes);
    for (const secret of ALL_SECRET_TOKENS) {
      expect(mcpBlob, `mcp leaked ${secret}`).not.toContain(secret);
    }
    const mcpSearchSecret = await runtime.query<{ items: unknown[] }>('meetings.mcp.search', { q: '5900000018' }, { actor: mcpActor, orgId });
    expect(mcpSearchSecret.items).toEqual([]);

    // D2 + Audit: hidden tokens exist nowhere in DB tables (except the unrelated accepted task row above) or audit detail.
    const auditRows = await sqlAdmin<{ command: string; detail: Record<string, unknown> }>(
      `SELECT command, detail FROM ludy_kernel.audit_event
       WHERE org_id = $1 AND command IN ('meetings.transcript.redact', 'meetings.transcript.redact_candidates', 'kernel.member_vy.subject_results.drop')
       ORDER BY id`,
      [orgId],
    );
    const auditText = JSON.stringify(auditRows);
    for (const secret of ALL_SECRET_TOKENS) {
      expect(auditText, `audit leaked ${secret}`).not.toContain(secret);
    }
    const redactAudit = auditRows.filter((r) => r.command === 'meetings.transcript.redact');
    expect(redactAudit.length).toBeGreaterThanOrEqual(2);
    expect(
      redactAudit.some(
        (r) =>
          r.detail.meetingId === meetingId &&
          r.detail.redactedCount === 10 &&
          r.detail.emailCount === 3 &&
          r.detail.phoneCount === 4 &&
          r.detail.nationalIdCount === 1 &&
          r.detail.taxCodeCount === 1 &&
          r.detail.bankAccountCount === 1 &&
          r.detail.countsByKind === undefined,
      ),
    ).toBe(true);

    // Check D2 across DB tables for this meeting.
    const dbDump = await sqlAdmin(
      `SELECT row_to_json(t)::text AS row FROM (
         SELECT m.title,
                (SELECT json_agg(s.text || ' ' || s.speaker_label) FROM ludy_meetings.transcript_segment s WHERE s.meeting_id = m.id) AS segs,
                (SELECT json_agg(r.summary || ' ' || r.decisions::text) FROM ludy_meetings.meeting_result r WHERE r.meeting_id = m.id) AS res,
                (SELECT json_agg(i.title || ' ' || i.who_drafted || ' ' || i.when_drafted) FROM ludy_meetings.action_item i WHERE i.meeting_id = m.id AND i.status = 'suggested') AS items,
                (SELECT json_agg(c.title) FROM ludy_meetings.meeting_chapter c WHERE c.meeting_id = m.id) AS chaps
         FROM ludy_meetings.meeting m WHERE m.id = $1
       ) t`,
      [meetingId],
    );
    const dumpStr = JSON.stringify(dbDump);
    for (const secret of ALL_SECRET_TOKENS) {
      expect(dumpStr, `DB still holds ${secret}`).not.toContain(secret);
    }
  });

  it('rejects stale updated_at, untrusted/shifted client offsets, wrong kinds, and duplicates atomically', async () => {
    const meetingId = await seedMeeting({ readers: ['attendee'], title: 'Họp ổn định' });
    await exec('recorder', 'meetings.transcript.draft_store', {
      meetingId,
      segments: [
        { startSeconds: 0, endSeconds: 5, speakerLabel: 'An', text: `Số một ${PHONE_PII}` },
        { startSeconds: 6, endSeconds: 10, speakerLabel: 'Bình', text: `Email ${EMAIL_PII}` },
      ],
    });

    const scan = await query<TranscriptRedactCandidates>('recorder', 'meetings.transcript.redact_candidates', { meetingId });
    expect(scan.candidates).toHaveLength(2);
    const [first, second] = scan.candidates as [typeof scan.candidates[0], typeof scan.candidates[0]];

    // Reject duplicate selection.
    expect(
      await refuses(
        exec('recorder', 'meetings.transcript.redact', {
          meetingId,
          confirmed: true,
          items: [
            { surface: first.surface, targetId: first.targetId, decisionIndex: null, kind: first.kind, startPos: first.startPos, version: first.version },
            { surface: first.surface, targetId: first.targetId, decisionIndex: null, kind: first.kind, startPos: first.startPos, version: first.version },
          ],
        }),
      ),
    ).toBe('REDACTION_DUPLICATE_SELECTION');

    // Reject tampered/shifted startPos even when another item is valid -> atomic rollback.
    expect(
      await refuses(
        exec('recorder', 'meetings.transcript.redact', {
          meetingId,
          confirmed: true,
          items: [
            { surface: first.surface, targetId: first.targetId, decisionIndex: null, kind: first.kind, startPos: first.startPos, version: first.version },
            { surface: second.surface, targetId: second.targetId, decisionIndex: null, kind: second.kind, startPos: 1, version: second.version },
          ],
        }),
      ),
    ).toBe('REDACTION_SPAN_MISMATCH');

    // Reject wrong kind for valid offset -> atomic rollback.
    expect(
      await refuses(
        exec('recorder', 'meetings.transcript.redact', {
          meetingId,
          confirmed: true,
          items: [
            { surface: first.surface, targetId: first.targetId, decisionIndex: null, kind: 'email', startPos: first.startPos, version: first.version },
          ],
        }),
      ),
    ).toBe('REDACTION_SPAN_MISMATCH');

    // Edit second segment so its version becomes stale, then submit both -> atomic REDACTION_STALE.
    await exec('recorder', 'meetings.transcript.correct', { segmentId: second.targetId, text: `Email mới ${EMAIL_PII}` });
    expect(
      await refuses(
        exec('recorder', 'meetings.transcript.redact', {
          meetingId,
          confirmed: true,
          items: [
            { surface: first.surface, targetId: first.targetId, decisionIndex: null, kind: first.kind, startPos: first.startPos, version: first.version },
            { surface: second.surface, targetId: second.targetId, decisionIndex: null, kind: second.kind, startPos: second.startPos, version: second.version },
          ],
        }),
      ),
    ).toBe('REDACTION_STALE');

    // Neither segment changed after all failed attempts.
    const unchanged = await sqlAdmin<{ text: string }>(
      `SELECT text FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2 ORDER BY start_seconds`,
      [orgId, meetingId],
    );
    expect(unchanged.map((r) => r.text)).toEqual([`Số một ${PHONE_PII}`, `Email mới ${EMAIL_PII}`]);
  });

  it('keeps published rows immutable (D3) and refuses meeting.title redaction once any surface is published', async () => {
    const meetingId = await seedMeeting({
      readers: ['attendee'],
      title: `Họp bảo mật ${TITLE_PHONE}`,
    });
    const pubSegId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage)
       VALUES ($1, $2, $3, 0, 5, 'Lan', $4, 'published')`,
      [orgId, pubSegId, meetingId, `Dòng đã công bố ${PHONE_PII}`],
    );
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: `Tóm tắt ${TAX_PII}`, decisions: [] });
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });

    // Create a fresh draft summary after publish: draft summary is editable, published items & meeting title are NOT.
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: `Nháp mới ${EMAIL_PII}`, decisions: [] });
    const scan = await query<TranscriptRedactCandidates>('recorder', 'meetings.transcript.redact_candidates', { meetingId });
    expect(scan.titleEditable).toBe(false);
    expect(scan.candidates.map((c) => `${c.surface}:${c.matchText}`)).toEqual([`meeting_result.summary:${EMAIL_PII}`]);

    const pubSegVer = (
      await sqlAdmin<{ v: string }>(
        `SELECT pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS v FROM ludy_meetings.transcript_segment WHERE id = $1`,
        [pubSegId],
      )
    )[0]!.v;
    const titleVer = (
      await sqlAdmin<{ v: string }>(
        `SELECT pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS v FROM ludy_meetings.meeting WHERE id = $1`,
        [meetingId],
      )
    )[0]!.v;
    const pubRes = (
      await sqlAdmin<{ id: string; v: string }>(
        `SELECT id, pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS v FROM ludy_meetings.meeting_result WHERE meeting_id = $1 AND stage = 'published'`,
        [meetingId],
      )
    )[0]!;

    expect(
      await refuses(
        exec('recorder', 'meetings.transcript.redact', {
          meetingId,
          confirmed: true,
          items: [{ surface: 'transcript_segment.text', targetId: pubSegId, decisionIndex: null, kind: 'phone', startPos: 18, version: pubSegVer }],
        }),
      ),
    ).toBe('REDACTION_PUBLISHED_IMMUTABLE');

    expect(
      await refuses(
        exec('recorder', 'meetings.transcript.redact', {
          meetingId,
          confirmed: true,
          items: [{ surface: 'meeting.title', targetId: meetingId, decisionIndex: null, kind: 'phone', startPos: 13, version: titleVer }],
        }),
      ),
    ).toBe('REDACTION_PUBLISHED_IMMUTABLE');

    expect(
      await refuses(
        exec('recorder', 'meetings.transcript.redact', {
          meetingId,
          confirmed: true,
          items: [{ surface: 'meeting_result.summary', targetId: pubRes.id, decisionIndex: null, kind: 'tax_code', startPos: 9, version: pubRes.v }],
        }),
      ),
    ).toBe('REDACTION_PUBLISHED_IMMUTABLE');

    // Draft summary redaction still succeeds and leaves published rows untouched.
    const draftItem = scan.candidates[0]!;
    const done = await exec<TranscriptRedacted>('recorder', 'meetings.transcript.redact', {
      meetingId,
      confirmed: true,
      items: [{ surface: draftItem.surface, targetId: draftItem.targetId, decisionIndex: null, kind: draftItem.kind, startPos: draftItem.startPos, version: draftItem.version }],
    });
    expect(done.redactedCount).toBe(1);

    const checkPub = await sqlAdmin<{ text: string }>(`SELECT text FROM ludy_meetings.transcript_segment WHERE id = $1`, [pubSegId]);
    expect(checkPub[0]?.text).toBe(`Dòng đã công bố ${PHONE_PII}`);
    const checkPubSum = await sqlAdmin<{ summary: string }>(`SELECT summary FROM ludy_meetings.meeting_result WHERE id = $1`, [pubRes.id]);
    expect(checkPubSum[0]?.summary).toBe(`Tóm tắt ${TAX_PII}`);
  });

  it('drops recorder private Vy results, cancels live Vy runs, and drops draft translations (D5) while preserving other meetings and published reader translations', async () => {
    const meetingId = await seedMeeting({ readers: ['attendee'], title: 'Họp D5' });
    const secondMeetingId = await seedMeeting({ readers: ['attendee'], title: 'Họp D5 khác' });

    await exec('recorder', 'meetings.transcript.draft_store', {
      meetingId,
      segments: [{ startSeconds: 0, endSeconds: 5, speakerLabel: 'An', text: `Liên hệ ${PHONE_PII}` }],
    });
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: `Gọi ${PHONE_PII}`, decisions: [] });

    // Seed recorder's finished Vy results on meetingId (transcribe + summary) and another meeting, plus an attendee published translation on secondMeeting.
    const rTranscribe = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', {
      feature: 'meetings.transcribe',
      subjectType: 'meeting',
      subjectId: meetingId,
    });
    await exec('recorder', 'kernel.member_vy.result.store', {
      runId: rTranscribe.runId,
      outcome: { status: 'ready', body: JSON.stringify({ v: 1, p: ['An'], s: [[0, 5, 0, `Liên hệ ${PHONE_PII}`]] }) },
    });
    const rSummary = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', {
      feature: 'meetings.summary',
      subjectType: 'meeting',
      subjectId: meetingId,
    });
    await exec('recorder', 'kernel.member_vy.result.store', {
      runId: rSummary.runId,
      outcome: { status: 'ready', body: JSON.stringify({ summary: `Gọi ${PHONE_PII}`, decisions: [], items: [], dropped: 0 }) },
    });
    // Live in-flight run for meetings.live_notes on meetingId.
    const rLive = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', {
      feature: 'meetings.live_notes',
      subjectType: 'meeting',
      subjectId: meetingId,
    });
    // Control run on secondMeetingId (must survive!).
    const rOtherMeeting = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', {
      feature: 'meetings.summary',
      subjectType: 'meeting',
      subjectId: secondMeetingId,
    });
    await exec('recorder', 'kernel.member_vy.result.store', {
      runId: rOtherMeeting.runId,
      outcome: { status: 'ready', body: JSON.stringify({ summary: 'An toàn', decisions: [], items: [], dropped: 0 }) },
    });

    // Seed recorder's draft translations (transcript + summary) and an immutable published translation for attendee on meetingId.
    await sqlAdmin(
      `INSERT INTO ludy_meetings.translation (org_id, meeting_id, member_user_id, kind, target_language, source_stage, source_hash, body)
       VALUES ($1, $2, $3, 'transcript', 'en', 'draft', $5, $6::jsonb),
              ($1, $2, $3, 'summary', 'en', 'draft', $5, '[]'::jsonb),
              ($1, $2, $4, 'summary', 'en', 'published', $5, '[]'::jsonb)`,
      [orgId, meetingId, users.recorder, users.attendee, 'a'.repeat(64), JSON.stringify([{ k: 'k1', h: 'a'.repeat(64), t: `Call ${PHONE_PII}`, s: 'ok', c: [] }])],
    );

    const scan = await query<TranscriptRedactCandidates>('recorder', 'meetings.transcript.redact_candidates', { meetingId });
    expect(scan.candidates).toHaveLength(2);

    const done = await exec<TranscriptRedacted>('recorder', 'meetings.transcript.redact', {
      meetingId,
      confirmed: true,
      items: scan.candidates.map((c) => ({
        surface: c.surface,
        targetId: c.targetId,
        decisionIndex: c.decisionIndex,
        kind: c.kind,
        startPos: c.startPos,
        version: c.version,
      })),
    });

    expect(done).toMatchObject({
      meetingId,
      redactedCount: 2,
      droppedVyResults: 3,
      cancelledVyRuns: 1,
      droppedTranslations: 2,
    });

    // Recorder's Vy results for meetingId are gone; live run is cancelled and cannot store later; copy_result refuses.
    const vyLeft = await sqlAdmin<{ c: string }>(
      `SELECT count(*)::text AS c FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND member_user_id = $2 AND subject_id = $3`,
      [orgId, users.recorder, meetingId],
    );
    expect(Number(vyLeft[0]?.c)).toBe(0);
    const liveRunRow = await sqlAdmin<{ status: string; error: string }>(
      `SELECT status, error FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2`,
      [orgId, rLive.runId],
    );
    expect(liveRunRow[0]).toEqual({ status: 'cancelled', error: 'SUBJECT_REDACTED' });

    expect(await refuses(exec('recorder', 'meetings.transcript.copy_result', { meetingId, runId: rTranscribe.runId }))).toBe('RESULT_NOT_FOUND');
    setSummaryEnabled(true);
    try {
      expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: rSummary.runId }))).toBe('SUMMARY_RESULT_NOT_FOUND');
    } finally {
      setSummaryEnabled(false);
    }
    expect(await refuses(exec('recorder', 'kernel.member_vy.result.store', { runId: rLive.runId, outcome: { status: 'ready', body: '{}' } }))).toBe(
      'VY_RUN_NOT_LIVE',
    );

    // Control result on secondMeetingId and attendee's published translation stayed untouched.
    const vyOtherLeft = await sqlAdmin<{ c: string }>(
      `SELECT count(*)::text AS c FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND member_user_id = $2 AND subject_id = $3`,
      [orgId, users.recorder, secondMeetingId],
    );
    expect(Number(vyOtherLeft[0]?.c)).toBe(1);

    const transRows = await sqlAdmin<{ member_user_id: string; kind: string; source_stage: string }>(
      `SELECT member_user_id, kind, source_stage FROM ludy_meetings.translation WHERE org_id = $1 AND meeting_id = $2`,
      [orgId, meetingId],
    );
    expect(transRows).toEqual([{ member_user_id: users.attendee, kind: 'summary', source_stage: 'published' }]);

    // Standalone kernel.member_vy.subject_results.drop respects member_only RLS (attendee drop never touches recorder's secondMeetingId result).
    const attendeeDrop = await exec<{ removed: number; cancelled: number }>('attendee', 'kernel.member_vy.subject_results.drop', {
      subjectType: 'meeting',
      subjectId: secondMeetingId,
    });
    expect(attendeeDrop).toEqual({ subjectType: 'meeting', subjectId: secondMeetingId, cancelled: 0, removed: 0 });
    const vyOtherStill = await sqlAdmin<{ c: string }>(
      `SELECT count(*)::text AS c FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND member_user_id = $2 AND subject_id = $3`,
      [orgId, users.recorder, secondMeetingId],
    );
    expect(Number(vyOtherStill[0]?.c)).toBe(1);
    expect(await refuses(runtime.execute('kernel.member_vy.subject_results.drop', { subjectType: 'meeting', subjectId: secondMeetingId }, { actor: SYSTEM_ACTOR, orgId }))).toBe('FORBIDDEN');
    expect(await refuses(exec('recorder', 'kernel.member_vy.subject_results.drop', { subjectType: 'Meeting free text', subjectId: secondMeetingId }))).toBe(
      'VALIDATION',
    );
  });

  it('blanks the live transcript preview of the meeting when it redacts, keeping where the preview has read, and leaves the preview of another meeting alone (#4557)', async () => {
    const meetingId = await seedMeeting({ title: 'Họp 4557 xem trước' });
    const other = await seedMeeting({ title: 'Họp 4557 khác' });
    const runId = randomUUID();
    const line = (m: string, seq: number, text: string, source: string | null = null) =>
      sqlAdmin(
        `INSERT INTO ludy_meetings.live_line (org_id, id, meeting_id, seq, start_seconds, end_seconds, text, source_run_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '2 days')`,
        [orgId, randomUUID(), m, seq, seq * 10, seq * 10 + 10, text, source],
      );
    await line(meetingId, 0, `Gọi ${PHONE_PII} nhé`, runId);
    await line(meetingId, 1, '');
    await line(meetingId, 2, `Email ${EMAIL_PII}`);
    await line(other, 0, `Gọi ${PHONE_PII} nhé`);
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: `Liên hệ ${PHONE_PII}`, decisions: [] });

    const scan = await query<TranscriptRedactCandidates>('recorder', 'meetings.transcript.redact_candidates', { meetingId });
    expect(scan.candidates.length).toBeGreaterThanOrEqual(1);
    // The preview is not a surface of the scan: no candidate names a live line.
    expect(JSON.stringify(scan)).not.toContain('live_line');
    const done = await exec<TranscriptRedacted>('recorder', 'meetings.transcript.redact', {
      meetingId,
      confirmed: true,
      items: scan.candidates.map((c) => ({ surface: c.surface, targetId: c.targetId, decisionIndex: c.decisionIndex, kind: c.kind, startPos: c.startPos, version: c.version })),
    });
    expect(done.redactedCount).toBe(scan.candidates.length);

    // Every line is a silent piece now, at the same seq and times: nothing of the text is left and the preview still reads on from its last line (seq 2), so the next window does not read the audio again.
    const lines = await sqlAdmin<{ seq: number; start_seconds: number; end_seconds: number; text: string; source_run_id: string | null; old: boolean }>(
      `SELECT seq, start_seconds, end_seconds, text, source_run_id, created_at < now() - interval '1 day' AS old FROM ludy_meetings.live_line WHERE org_id = $1 AND meeting_id = $2 ORDER BY seq`,
      [orgId, meetingId],
    );
    // The run the line came from and the day it was written stay as they were (the taint's source and the expiry clock), only the text is gone.
    expect(lines).toEqual([
      { seq: 0, start_seconds: 0, end_seconds: 10, text: '', source_run_id: runId, old: true },
      { seq: 1, start_seconds: 10, end_seconds: 20, text: '', source_run_id: null, old: true },
      { seq: 2, start_seconds: 20, end_seconds: 30, text: '', source_run_id: null, old: true },
    ]);
    // The other meeting's preview is untouched, and the audit holds the count of lines that held text (never a word of them).
    expect(await sqlAdmin<{ text: string }>(`SELECT text FROM ludy_meetings.live_line WHERE org_id = $1 AND meeting_id = $2`, [orgId, other])).toEqual([{ text: `Gọi ${PHONE_PII} nhé` }]);
    const audit = await sqlAdmin<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.transcript.redact' AND detail ->> 'meetingId' = $2 ORDER BY occurred_at DESC LIMIT 1`,
      [orgId, meetingId],
    );
    expect(audit[0]?.detail).toMatchObject({ clearedLiveLines: 2 });
    expect(JSON.stringify(audit)).not.toContain(PHONE_PII);
  });

  it('fails closed with VY_RUN_BUSY on out-of-order concurrent Vy run creation and retries ascending new runs cleanly', async () => {
    const mRace = await seedMeeting({ readers: ['attendee'], title: 'Họp B2 concurrency' });
    const r1 = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', {
      feature: 'meetings.summary',
      subjectType: 'meeting',
      subjectId: mRace,
    });
    await exec('recorder', 'kernel.member_vy.result.store', {
      runId: r1.runId,
      outcome: { status: 'ready', body: '{}' },
    });
    const vyAgentId = (
      await sqlAdmin<{ id: string }>(
        `SELECT id FROM ludy_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`,
        [orgId, users.recorder],
      )
    )[0]!.id;

    const r0Id = '00000000-0000-7000-8000-000000000001';

    const seedLowUuidRun = async (runId: string) => {
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(
          `INSERT INTO ludy_kernel.ai_run (org_id, id, agent_id, module, feature, status, tainted, started_at, finished_at, expires_at)
           VALUES ($1, $2, $3, 'meetings', 'meetings.title', 'succeeded', true, now(), now(), now() + interval '30 minutes')`,
          [orgId, runId, vyAgentId],
        );
        await c.query(
          `INSERT INTO ludy_kernel.member_vy_result (org_id, member_user_id, run_id, feature, subject_type, subject_id, status, body, private_read, expires_at, created_at)
           VALUES ($1, $2, $3, 'meetings.title', 'meeting', $4, 'ready', '{}', true, now() + interval '30 days', now())`,
          [orgId, users.recorder, runId, mRace],
        );
        await c.query('COMMIT');
      });
    };

    const cHold = new pg.Client({ connectionString: adminUrl });
    await cHold.connect();
    try {
      const holdPid = (await cHold.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

      // Case A: a newly committed run whose UUID <= maxLockedRunId must fail closed with 409 VY_RUN_BUSY (zero silent skip).
      await cHold.query('BEGIN');
      await cHold.query(`SELECT id FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, r1.runId]);
      const pBusy = exec('recorder', 'kernel.member_vy.subject_results.drop', { subjectType: 'meeting', subjectId: mRace });
      await waitForBlockedOnPid(holdPid);
      await seedLowUuidRun(r0Id);
      await cHold.query('COMMIT');
      expect(await refuses(pBusy)).toBe('VY_RUN_BUSY');

      const stillTwo = await sqlAdmin<{ c: string }>(
        `SELECT count(*)::text AS c FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`,
        [orgId, mRace],
      );
      expect(Number(stillTwo[0]?.c)).toBe(2);

      // Case B: a newly committed run whose UUID > maxLockedRunId retries in ascending order and drops all 3 cleanly.
      await cHold.query('BEGIN');
      await cHold.query(`SELECT id FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, r1.runId]);
      const pRetry = exec<{ cancelled: number; removed: number }>('recorder', 'kernel.member_vy.subject_results.drop', {
        subjectType: 'meeting',
        subjectId: mRace,
      });
      await waitForBlockedOnPid(holdPid);
      await exec('recorder', 'kernel.member_vy.run.start', {
        feature: 'meetings.live_notes',
        subjectType: 'meeting',
        subjectId: mRace,
      });
      await cHold.query('COMMIT');

      expect(await pRetry).toEqual({ subjectType: 'meeting', subjectId: mRace, cancelled: 1, removed: 3 });
      const zeroLeft = await sqlAdmin<{ c: string }>(
        `SELECT count(*)::text AS c FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`,
        [orgId, mRace],
      );
      expect(Number(zeroLeft[0]?.c)).toBe(0);
    } finally {
      await cHold.query('ROLLBACK').catch(() => {});
      await cHold.end();
    }
  });

  it('locks meeting before reading member_vy.result.get in transcript, summary (and notes enhance), and chapters copy_result (#4415)', async () => {
    const mRaceCopy = await seedMeeting({ readers: ['attendee'], title: 'Họp 4415 lock order' });

    await exec('recorder', 'meetings.transcript.draft_store', {
      meetingId: mRaceCopy,
      segments: [{ startSeconds: 0, endSeconds: 5, speakerLabel: 'An', text: `Liên hệ ${PHONE_PII}` }],
    });

    const startAndStore = async (feature: string, body: string, targetMeetingId = mRaceCopy) => {
      const started = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', {
        feature,
        subjectType: 'meeting',
        subjectId: targetMeetingId,
      });
      await exec('recorder', 'kernel.member_vy.result.store', {
        runId: started.runId,
        outcome: { status: 'ready', body },
      });
      return started.runId;
    };

    const cHold = new pg.Client({ connectionString: adminUrl });
    await cHold.connect();
    setSummaryEnabled(true);
    try {
      const holdPid = (await cHold.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

      const assertBlockedUntilRedactDrops = async (opts: {
        seedDraft: () => Promise<void>;
        feature: string;
        resultBody: string;
        copyCommand: string;
        expectedCode: string;
      }) => {
        await opts.seedDraft();
        const resultRunId = await startAndStore(opts.feature, opts.resultBody);
        const rHold = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', {
          feature: 'meetings.title',
          subjectType: 'meeting',
          subjectId: mRaceCopy,
        });
        const scan = await query<TranscriptRedactCandidates>('recorder', 'meetings.transcript.redact_candidates', { meetingId: mRaceCopy });
        expect(scan.candidates.length).toBeGreaterThanOrEqual(1);

        await cHold.query('BEGIN');
        await cHold.query(`SELECT id FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, rHold.runId]);
        const pRedact = exec<TranscriptRedacted>('recorder', 'meetings.transcript.redact', {
          meetingId: mRaceCopy,
          confirmed: true,
          items: scan.candidates.map((c) => ({
            surface: c.surface,
            targetId: c.targetId,
            decisionIndex: c.decisionIndex,
            kind: c.kind,
            startPos: c.startPos,
            version: c.version,
          })),
        });
        const [redactPid] = await waitForBlockedOnPid(holdPid, 1);

        // The copy command must block on ludy_meetings.meeting (held by pRedact) BEFORE calling kernel.member_vy.result.get.
        const pCopy = refuses(exec('recorder', opts.copyCommand, { meetingId: mRaceCopy, runId: resultRunId }));
        await waitForBlockedOnPid(redactPid!, 1);

        await cHold.query('COMMIT');

        const redacted = await pRedact;
        expect(redacted.redactedCount).toBe(scan.candidates.length);
        expect(redacted.droppedVyResults).toBe(2);
        expect(redacted.cancelledVyRuns).toBe(1);
        expect(await pCopy).toBe(opts.expectedCode);
      };

      await assertBlockedUntilRedactDrops({
        seedDraft: async () => {
          await exec('recorder', 'meetings.transcript.draft_store', {
            meetingId: mRaceCopy,
            segments: [{ startSeconds: 0, endSeconds: 5, speakerLabel: 'An', text: `Liên hệ ${PHONE_PII}` }],
          });
        },
        feature: 'meetings.transcribe',
        resultBody: encodeTranscriptResult([{ startSeconds: 0, endSeconds: 5, speakerLabel: 'An', text: `Chép lại ${PHONE_PII}` }]),
        copyCommand: 'meetings.transcript.copy_result',
        expectedCode: 'RESULT_NOT_FOUND',
      });

      await assertBlockedUntilRedactDrops({
        seedDraft: async () => {
          await exec('recorder', 'meetings.summary.save', {
            meetingId: mRaceCopy,
            summary: `Email ${EMAIL_PII}`,
            decisions: [],
          });
        },
        feature: 'meetings.summary',
        resultBody: JSON.stringify({ template: 'general', summary: `Tóm tắt ${EMAIL_PII}`, decisions: [], items: [], dropped: 0 }),
        copyCommand: 'meetings.summary.copy_result',
        expectedCode: 'SUMMARY_RESULT_NOT_FOUND',
      });

      await assertBlockedUntilRedactDrops({
        seedDraft: async () => {
          await exec('recorder', 'meetings.summary.save', {
            meetingId: mRaceCopy,
            summary: `Nháp ${PHONE_PII}`,
            decisions: [],
          });
        },
        feature: 'meetings.summary',
        resultBody: JSON.stringify({
          template: 'general',
          enhanced: { sections: [{ key: null, lines: [{ own: true, text: `Ghi chú ${EMAIL_PII}`, seconds: null }] }] },
          summary: '',
          decisions: [],
          items: [],
          dropped: 0,
        }),
        copyCommand: 'meetings.summary.copy_result',
        expectedCode: 'SUMMARY_RESULT_NOT_FOUND',
      });

      await assertBlockedUntilRedactDrops({
        seedDraft: async () => {
          await exec('recorder', 'meetings.chapters.save', {
            meetingId: mRaceCopy,
            chapters: [{ title: 'Phần gọi', startSeconds: 0 }],
          });
          const draftChapId = (
            await sqlAdmin<{ id: string }>(
              `SELECT id FROM ludy_meetings.meeting_chapter WHERE org_id = $1 AND meeting_id = $2 AND stage = 'draft'`,
              [orgId, mRaceCopy],
            )
          )[0]!.id;
          await sqlAdmin(
            `UPDATE ludy_meetings.meeting_chapter SET title = $1 WHERE org_id = $2 AND id = $3`,
            [`Phần gọi ${CHAPTER_PHONE}`, orgId, draftChapId],
          );
        },
        feature: 'meetings.chapters',
        resultBody: JSON.stringify({ chapters: [{ title: `Chương ${CHAPTER_PHONE}`, startSeconds: 0 }], dropped: 0 }),
        copyCommand: 'meetings.chapters.copy_result',
        expectedCode: 'SUMMARY_RESULT_NOT_FOUND',
      });

      // All draft surfaces stay redacted and zero private Vy results remain.
      const segRows = await sqlAdmin<{ text: string }>(
        `SELECT text FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2`,
        [orgId, mRaceCopy],
      );
      expect(segRows).toEqual([{ text: `Liên hệ ${REDACTION_MARK_BY_KIND.phone}` }]);
      const resRows = await sqlAdmin<{ summary: string }>(
        `SELECT summary FROM ludy_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2`,
        [orgId, mRaceCopy],
      );
      expect(resRows).toEqual([{ summary: `Nháp ${REDACTION_MARK_BY_KIND.phone}` }]);
      const chapRows = await sqlAdmin<{ title: string }>(
        `SELECT title FROM ludy_meetings.meeting_chapter WHERE org_id = $1 AND meeting_id = $2`,
        [orgId, mRaceCopy],
      );
      expect(chapRows).toEqual([{ title: `Phần gọi ${REDACTION_MARK_BY_KIND.phone}` }]);
      const vyLeft = await sqlAdmin<{ c: string }>(
        `SELECT count(*)::text AS c FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`,
        [orgId, mRaceCopy],
      );
      expect(Number(vyLeft[0]?.c)).toBe(0);

      // Concurrent same-command copy_result calls serialize on ludy_meetings.meeting with zero lock-upgrade deadlock.
      const mSerial = await seedMeeting({ readers: ['attendee'], title: 'Họp 4415 serialize' });

      const rT1 = await startAndStore(
        'meetings.transcribe',
        encodeTranscriptResult([{ startSeconds: 0, endSeconds: 5, speakerLabel: 'An', text: 'Bản sạch 1' }]),
        mSerial,
      );
      const rT2 = await startAndStore(
        'meetings.transcribe',
        encodeTranscriptResult([{ startSeconds: 0, endSeconds: 5, speakerLabel: 'An', text: 'Bản sạch 2' }]),
        mSerial,
      );
      const [t1, t2] = await Promise.all([
        exec<{ stored: number }>('recorder', 'meetings.transcript.copy_result', { meetingId: mSerial, runId: rT1 }),
        exec<{ stored: number }>('recorder', 'meetings.transcript.copy_result', { meetingId: mSerial, runId: rT2 }),
      ]);
      expect(t1.stored).toBe(1);
      expect(t2.stored).toBe(1);

      const rS = await startAndStore(
        'meetings.summary',
        JSON.stringify({ template: 'general', summary: 'Tóm tắt sạch', decisions: [], items: [], dropped: 0 }),
        mSerial,
      );
      const [s1, s2] = await Promise.allSettled([
        exec('recorder', 'meetings.summary.copy_result', { meetingId: mSerial, runId: rS }),
        exec('recorder', 'meetings.summary.copy_result', { meetingId: mSerial, runId: rS }),
      ]);
      const sFulfilled = [s1, s2].filter((r) => r.status === 'fulfilled');
      const sRejected = [s1, s2].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(sFulfilled).toHaveLength(1);
      expect(sRejected).toHaveLength(1);
      expect((sRejected[0]!.reason as { code?: string }).code).toBe('SUMMARY_ALREADY_COPIED');

      const rC = await startAndStore(
        'meetings.chapters',
        JSON.stringify({ chapters: [{ title: 'Chương sạch', startSeconds: 0 }], dropped: 0 }),
        mSerial,
      );
      const [ch1, ch2] = await Promise.allSettled([
        exec('recorder', 'meetings.chapters.copy_result', { meetingId: mSerial, runId: rC }),
        exec('recorder', 'meetings.chapters.copy_result', { meetingId: mSerial, runId: rC }),
      ]);
      const chFulfilled = [ch1, ch2].filter((r) => r.status === 'fulfilled');
      const chRejected = [ch1, ch2].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(chFulfilled).toHaveLength(1);
      expect(chRejected).toHaveLength(1);
      expect((chRejected[0]!.reason as { code?: string }).code).toBe('CHAPTERS_ALREADY_COPIED');
    } finally {
      setSummaryEnabled(false);
      await cHold.query('ROLLBACK').catch(() => {});
      await cHold.end();
    }
  });
});

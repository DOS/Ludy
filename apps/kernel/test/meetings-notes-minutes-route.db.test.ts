// SPDX-License-Identifier: AGPL-3.0-only
// Route-level PostgreSQL integration suite for #5129 (L32: draft minutes from typed notes for an unrecorded meeting):
//   - recorder-only access (403 non-recorder reader, 404 org non-reader/expired, 403 non-member stranger); notes still editable/manual with AI off
//   - gates (has_transcript, no_notes, redacted, off, vy.use denied, kill switch paused, budget exhausted/projected overflow, DraftBudget 429, mid-run AI_STOPPED) fail safely
//   - prompt sends numbered note lines, attendee display names (names only), and org glossary; zero cross-meeting/transcript/CANARY leakage
//   - deterministic check drops bad citations/ungrounded numbers/contacts and blanks ungrounded assignees while keeping grounded VND amounts
//   - stores counts-only metadata in ephemeral member_vy_result, logs no prose, and never auto-saves or auto-publishes meeting_result/action_item
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { metered } from '@ludy/agent';
import type { ModelPort } from '@ludy/agent/member-vy';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { REDACTION_MARK_BY_KIND } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { memberMeter } from '../src/ai-meter.ts';
import { notesMinutesStatusOf, runMeetingNotesMinutes, type MeetingBriefDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const CANARY_OTHER_MEETING = 'CANARY_OTHER_MEETING_TEXT_DO_NOT_LEAK_9911';

const refuses = async (p: Promise<unknown>): Promise<{ code?: string; status?: number } | null> => {
  try {
    await p;
    return null;
  } catch (e: unknown) {
    const err = e as { code?: string; status?: number };
    return { ...(err.code ? { code: err.code } : {}), ...(err.status !== undefined ? { status: err.status } : {}) };
  }
};

suite('meetings.notesMinutes route (#5129, L32)', () => {
  const dbName = `ludy_test_notes_minutes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let db: ReturnType<typeof createDb>;
  let runtime: Runtime;
  let orgId = '';
  const users = { owner: '', recorder: '', reader: '', outsider: '', stranger: '' };
  const asUser = (key: keyof typeof users) => ({ type: 'user' as const, userId: users[key], aal: 'aal1' as const });
  const asMfa = (key: keyof typeof users) => ({
    type: 'user' as const,
    userId: users[key],
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  const logged: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];
  let modelCalls = 0;
  let onBeforeModelReturn: (() => Promise<void>) | null = null;
  let nextResponse = JSON.stringify({
    summary: 'Nhóm trao đổi kế hoạch quý 4 với ngân sách 15.000.000 đ.',
    decisions: [{ text: 'Chốt ngân sách chiến dịch 15.000.000 đ.', noteLine: 1 }],
    items: [{ title: 'Gửi báo giá cho khách trước thứ Sáu', who: 'Văn Hùng', when: 'thứ Sáu', noteLine: 2 }],
  });
  const capturedPrompts: Array<{ system: string; user: string; feature?: string; expected?: { inputTokens: number; outputTokens: number } }> = [];

  const stubModel: ModelPort = {
    generate: async (_who, prompt) => {
      capturedPrompts.push({
        system: prompt.system,
        user: prompt.user,
        ...(prompt.feature ? { feature: prompt.feature } : {}),
        ...(prompt.expected ? { expected: prompt.expected } : {}),
      });
      return metered(
        'meetings.notes_minutes',
        async () => {
          modelCalls += 1;
          if (onBeforeModelReturn) await onBeforeModelReturn();
          return { text: nextResponse, usage: { inputTokens: 310, outputTokens: 120 } };
        },
        undefined,
        prompt.expected,
      );
    },
  };

  afterEach(() => {
    logged.length = 0;
    capturedPrompts.length = 0;
    modelCalls = 0;
    onBeforeModelReturn = null;
    setSummaryEnabled(true);
    nextResponse = JSON.stringify({
      summary: 'Nhóm trao đổi kế hoạch quý 4 với ngân sách 15.000.000 đ.',
      decisions: [{ text: 'Chốt ngân sách chiến dịch 15.000.000 đ.', noteLine: 1 }],
      items: [{ title: 'Gửi báo giá cho khách trước thứ Sáu', who: 'Văn Hùng', when: 'thứ Sáu', noteLine: 2 }],
    });
  });

  const deps = (overrides: { model?: ModelPort | null; budget?: DraftBudget; price?: MeetingBriefDeps['price'] } = {}): MeetingBriefDeps => {
    const price = overrides.price ?? { inputPerMTok: '0.15', outputPerMTok: '0.60' };
    return {
      runtime,
      model: overrides.model === undefined ? stubModel : overrides.model,
      meter: (actor) => memberMeter(runtime, actor, { price }),
      budget: overrides.budget ?? new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }),
      price,
    };
  };

  const sqlAdmin = async <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await client.query<T>(text, values);
    } finally {
      await client.end();
    }
  };

  const seedUnrecordedMeeting = async (
    opts: { noteBody?: string | null; withTranscript?: boolean; expired?: boolean; language?: 'vi' | 'en' } = {},
  ): Promise<string> => {
    const meetingId = randomUUID();
    const retentionExpr = opts.expired ? 'current_date - 1' : 'current_date + 365';
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Trao đổi trực tiếp không ghi âm', $3, '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $4, 'attendees', 'ready', 'told_at_start', $4, now(), '1.0', current_date + 30, ${retentionExpr})`,
      [orgId, meetingId, opts.language ?? 'vi', users.recorder],
    );
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [
      orgId,
      randomUUID(),
      meetingId,
      users.reader,
    ]);
    if (opts.noteBody !== null && opts.noteBody !== undefined) {
      await sqlAdmin(`INSERT INTO ludy_meetings.meeting_note (org_id, id, meeting_id, body) VALUES ($1, $2, $3, $4)`, [
        orgId,
        randomUUID(),
        meetingId,
        opts.noteBody,
      ]);
    }
    if (opts.withTranscript) {
      await sqlAdmin(
        `INSERT INTO ludy_meetings.transcript_segment (org_id, id, meeting_id, speaker_label, text, start_seconds, end_seconds, stage, tainted)
         VALUES ($1, $2, $3, 'Thu Lan', 'Nội dung băng ghi âm đã bóc băng.', 0, 15, 'draft', false)`,
        [orgId, randomUUID(), meetingId],
      );
    }
    return meetingId;
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const u = new URL(ADMIN!);
    u.pathname = `/${dbName}`;
    adminUrl = u.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    pools.push(pool);
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    setSummaryEnabled(true);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      const displayName = key === 'recorder' ? 'Thu Lan' : key === 'reader' ? 'Văn Hùng' : key;
      users[key] = await upsertIdentity(db, {
        issuer: 'notes-minutes',
        subject: key,
        email: `${key}@notes-minutes.test`,
        name: displayName,
      });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Không Ghi Âm')).orgId;
    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`,
      [orgId, users.recorder, users.reader, users.outsider],
    );
    await runtime.execute('meetings.glossary.add', { term: 'LudyApp' }, { actor: asMfa('owner'), orgId });

    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      const orig = console[level].bind(console);
      spies.push(
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
          orig(...args);
        }),
      );
    }
  }, 300_000);

  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    setSummaryEnabled(false);
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces recorder-only, visibility, retention, zero-transcript, notes, redaction, AI-off/vy.use/paused/budget/DraftBudget gates with 0 model calls', async () => {
    const cleanId = await seedUnrecordedMeeting({ noteBody: 'Chốt ngân sách chiến dịch 15.000.000 đ.\nVăn Hùng gửi báo giá trước thứ Sáu.' });
    const expiredId = await seedUnrecordedMeeting({ noteBody: 'Ghi chú đã hết hạn lưu trữ.', expired: true });
    const withTranscriptId = await seedUnrecordedMeeting({ noteBody: 'Ghi chú nhưng đã có băng.', withTranscript: true });
    const noNotesId = await seedUnrecordedMeeting({ noteBody: null });
    const whitespaceNotesId = await seedUnrecordedMeeting({ noteBody: '   \n\t  ' });
    const redactedId = await seedUnrecordedMeeting({ noteBody: `Gọi khách qua ${REDACTION_MARK_BY_KIND.phone}` });
    const erasedId = await seedUnrecordedMeeting({ noteBody: 'Ghi chú đã xóa: [đã xóa]' });

    // Non-recorder reader, org non-reader outsider (404), non-member stranger (403), expired text retention (404)
    const readerStatus = await notesMinutesStatusOf(deps(), orgId, asUser('reader'), cleanId);
    expect(readerStatus).toMatchObject({ available: false, reason: 'not_recorder' });
    expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('reader'), cleanId))).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await refuses(notesMinutesStatusOf(deps(), orgId, asUser('outsider'), cleanId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('outsider'), cleanId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await refuses(notesMinutesStatusOf(deps(), orgId, asUser('stranger'), cleanId))).toMatchObject({ code: 'NOT_A_MEMBER', status: 403 });
    expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('stranger'), cleanId))).toMatchObject({ code: 'NOT_A_MEMBER', status: 403 });
    expect(await refuses(notesMinutesStatusOf(deps(), orgId, asUser('recorder'), expiredId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), expiredId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });

    // Has transcript / no notes / redacted / erased
    expect(await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), withTranscriptId)).toMatchObject({ available: false, reason: 'has_transcript' });
    expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), withTranscriptId))).toMatchObject({ code: 'NOTES_MINUTES_HAS_TRANSCRIPT', status: 422 });
    expect(await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), noNotesId)).toMatchObject({ available: false, reason: 'no_notes' });
    expect(await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), whitespaceNotesId)).toMatchObject({ available: false, reason: 'no_notes' });
    expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), noNotesId))).toMatchObject({ code: 'NOTES_MINUTES_NO_NOTES', status: 422 });
    expect(await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), redactedId)).toMatchObject({ available: false, reason: 'redacted' });
    expect(await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), erasedId)).toMatchObject({ available: false, reason: 'redacted' });
    expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), redactedId))).toMatchObject({ code: 'NOTES_MINUTES_REDACTED', status: 422 });

    // AI off
    setSummaryEnabled(false);
    expect(await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), cleanId)).toMatchObject({ available: false, reason: 'off', estimate: null });
    expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), cleanId))).toMatchObject({ code: 'NOTES_MINUTES_OFF', status: 422 });
    setSummaryEnabled(true);
    expect(await notesMinutesStatusOf(deps({ model: null }), orgId, asUser('recorder'), cleanId)).toMatchObject({ available: false, reason: 'off', estimate: null });
    expect(await refuses(runMeetingNotesMinutes(deps({ model: null }), orgId, asUser('recorder'), cleanId))).toMatchObject({ code: 'NOTES_MINUTES_OFF', status: 422 });

    // vy.use denied
    await runtime.execute('kernel.member.permission.set', { userId: users.recorder, permission: 'vy.use', allowed: false }, { actor: asMfa('owner'), orgId });
    try {
      expect(await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), cleanId)).toMatchObject({ available: false, reason: 'forbidden' });
      expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), cleanId))).toMatchObject({ code: 'VY_NOT_ALLOWED', status: 403 });
    } finally {
      await runtime.execute('kernel.member.permission.set', { userId: users.recorder, permission: 'vy.use', allowed: null }, { actor: asMfa('owner'), orgId });
    }

    // Kill switch paused
    const killed = await runtime.execute<{ killSwitchId: string }>('kernel.agent.kill_switch.engage', { scope: 'module', target: 'meetings' }, { actor: asMfa('owner'), orgId });
    try {
      expect(await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), cleanId)).toMatchObject({ available: false, reason: 'paused' });
      expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), cleanId))).toMatchObject({ code: 'AI_BUDGET_EXHAUSTED', status: 422 });
    } finally {
      await runtime.execute('kernel.agent.kill_switch.release', { id: killed.killSwitchId }, { actor: asMfa('owner'), orgId });
    }

    // Budget exhausted at 0 and projected-cost overflow
    await sqlAdmin(`INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', '0', 80, true, $2)`, [orgId, users.owner]);
    try {
      expect(await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), cleanId)).toMatchObject({ available: false, reason: 'budget' });
      expect(await refuses(runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), cleanId))).toMatchObject({ code: 'AI_BUDGET_EXHAUSTED', status: 422 });
    } finally {
      await sqlAdmin('DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1', [orgId]);
    }

    await sqlAdmin(`INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', '0.000500', 80, true, $2)`, [orgId, users.owner]);
    try {
      const overflowOut = await runMeetingNotesMinutes(
        deps({ price: { inputPerMTok: '3.00', outputPerMTok: '15.00' } }),
        orgId,
        asUser('recorder'),
        cleanId,
      );
      expect(overflowOut).toEqual({
        state: 'failed',
        errorCode: 'AI_BUDGET_EXHAUSTED',
        summary: '',
        decisions: [],
        items: [],
        dropped: 0,
      });
    } finally {
      await sqlAdmin('DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1', [orgId]);
    }

    // DraftBudget 429 NOTES_MINUTES_BUSY
    const busyBudget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    const held = busyBudget.take(orgId, users.recorder);
    expect(held.allowed).toBe(true);
    try {
      expect(await refuses(runMeetingNotesMinutes(deps({ budget: busyBudget }), orgId, asUser('recorder'), cleanId))).toMatchObject({
        code: 'NOTES_MINUTES_BUSY',
        status: 429,
      });
    } finally {
      if (held.allowed) held.release();
    }

    expect(modelCalls).toBe(0);
  });

  it('isolates notes per meeting, cites lines, drops bad outputs, stores counts only, and never auto-saves or auto-publishes', async () => {
    await seedUnrecordedMeeting({ noteBody: CANARY_OTHER_MEETING });
    const meetingId = await seedUnrecordedMeeting({
      noteBody: 'Chốt ngân sách chiến dịch 15.000.000 đ.\nVăn Hùng gửi báo giá LudyApp trước thứ Sáu.',
    });

    const ready = await notesMinutesStatusOf(deps(), orgId, asUser('recorder'), meetingId);
    expect(ready).toMatchObject({ available: true, reason: null });
    expect(ready.estimate?.inputTokens).toBeGreaterThan(0);

    nextResponse = JSON.stringify({
      summary: 'Nhóm trao đổi kế hoạch với ngân sách 15.000.000 đ. Gọi 0901234567 ngay.',
      decisions: [
        { text: 'Chốt ngân sách chiến dịch 15.000.000 đ.', noteLine: 1 },
        { text: 'Quyết định bịa dòng không tồn tại.', noteLine: 99 },
      ],
      items: [
        { title: 'Gửi báo giá ludyapp trước thứ Sáu', who: 'Người Lạ', when: 'thứ Sáu', noteLine: 2 },
      ],
    });

    const answer = await runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), meetingId);
    expect(modelCalls).toBe(1);
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]?.user).toContain('Chốt ngân sách chiến dịch 15.000.000 đ.');
    expect(capturedPrompts[0]?.user).toContain('Văn Hùng gửi báo giá LudyApp trước thứ Sáu.');
    expect(capturedPrompts[0]?.user).toContain('Thu Lan');
    expect(capturedPrompts[0]?.user).toContain('Văn Hùng');
    expect(capturedPrompts[0]?.user).toContain('LudyApp');
    expect(capturedPrompts[0]?.user).not.toContain(CANARY_OTHER_MEETING);
    expect(capturedPrompts[0]?.user).not.toContain('recorder@notes-minutes.test');

    expect(answer).toEqual({
      state: 'drafted',
      errorCode: null,
      summary: 'Nhóm trao đổi kế hoạch với ngân sách 15.000.000 đ.',
      decisions: [{ text: 'Chốt ngân sách chiến dịch 15.000.000 đ.', noteLine: 1 }],
      items: [{ title: 'Gửi báo giá LudyApp trước thứ Sáu', who: '', when: 'thứ Sáu', noteLine: 2 }],
      dropped: 3,
    });

    // member_vy_result stores counts only under an ephemeral subject (not meetingId)
    const directRows = await sqlAdmin('SELECT id FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2', [orgId, meetingId]);
    expect(directRows.rows).toHaveLength(0);
    const ephemeralRows = await sqlAdmin<{ body: string | null; status: string }>(
      `SELECT r.body, r.status FROM ludy_kernel.member_vy_result r JOIN ludy_kernel.ai_run a ON a.org_id = r.org_id AND a.id = r.run_id WHERE r.org_id = $1 AND a.feature = 'meetings.notes_minutes' ORDER BY a.started_at DESC LIMIT 1`,
      [orgId],
    );
    expect(ephemeralRows.rows[0]?.status).toBe('ready');
    const stored = JSON.parse(ephemeralRows.rows[0]?.body ?? '{}') as Record<string, unknown>;
    expect(stored).toMatchObject({ v: 1, decisions: 1, items: 1, dropped: 3, noteLines: 2 });
    expect(ephemeralRows.rows[0]?.body).not.toContain('15.000.000 đ');

    // Never auto-saved or auto-published
    const resultsBefore = await sqlAdmin('SELECT stage FROM ludy_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2', [orgId, meetingId]);
    const itemsBefore = await sqlAdmin('SELECT stage FROM ludy_meetings.action_item WHERE org_id = $1 AND meeting_id = $2', [orgId, meetingId]);
    expect(resultsBefore.rows).toHaveLength(0);
    expect(itemsBefore.rows).toHaveLength(0);

    // Explicit draft apply populates ONLY draft stage (never published)
    await runtime.execute(
      'meetings.summary.save',
      { meetingId, summary: answer.summary, sections: [], decisions: answer.decisions.map((d) => d.text) },
      { actor: asUser('recorder'), orgId },
    );
    for (const item of answer.items) {
      await runtime.execute(
        'meetings.action_item.create',
        { meetingId, title: item.title, who: item.who, whoUserId: null, when: item.when, whenDate: null, transcriptSeconds: null },
        { actor: asUser('recorder'), orgId },
      );
    }
    const resultsAfter = await sqlAdmin<{ stage: string }>('SELECT stage FROM ludy_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2', [orgId, meetingId]);
    const itemsAfter = await sqlAdmin<{ stage: string }>('SELECT stage FROM ludy_meetings.action_item WHERE org_id = $1 AND meeting_id = $2', [orgId, meetingId]);
    expect(resultsAfter.rows.map((r) => r.stage)).toEqual(['draft']);
    expect(itemsAfter.rows.map((r) => r.stage)).toEqual(['draft']);

    // Logs hold zero note prose
    expect(logged.join('\n')).not.toContain('15.000.000 đ');
  });

  it('handles unparsable output with NOTES_MINUTES_UNPARSABLE and mid-run cancellation with AI_STOPPED', async () => {
    const meetingId = await seedUnrecordedMeeting({ noteBody: 'Chốt kế hoạch bán hàng quý 4.' });
    nextResponse = 'not valid json at all';
    expect(await runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), meetingId)).toEqual({
      state: 'failed',
      errorCode: 'NOTES_MINUTES_UNPARSABLE',
      summary: '',
      decisions: [],
      items: [],
      dropped: 0,
    });

    // Mid-run cancellation: engage kill switch before model call finishes, so result.store sees cancelled run -> AI_STOPPED
    let killSwitchId = '';
    onBeforeModelReturn = async () => {
      const engaged = await runtime.execute<{ killSwitchId: string }>(
        'kernel.agent.kill_switch.engage',
        { scope: 'module', target: 'meetings' },
        { actor: asMfa('owner'), orgId },
      );
      killSwitchId = engaged.killSwitchId;
    };
    nextResponse = JSON.stringify({
      summary: 'Chốt kế hoạch bán hàng quý 4.',
      decisions: [{ text: 'Chốt kế hoạch bán hàng quý 4.', noteLine: 1 }],
      items: [],
    });
    try {
      const stopped = await runMeetingNotesMinutes(deps(), orgId, asUser('recorder'), meetingId);
      expect(stopped).toEqual({
        state: 'failed',
        errorCode: 'AI_STOPPED',
        summary: '',
        decisions: [],
        items: [],
        dropped: 0,
      });
    } finally {
      if (killSwitchId !== '') {
        await runtime.execute('kernel.agent.kill_switch.release', { id: killSwitchId }, { actor: asMfa('owner'), orgId });
      }
    }
  });
});

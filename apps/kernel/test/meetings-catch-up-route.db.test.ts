// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for L33 meeting catch-up (#5130):
//   - readers only on status/facts/start/runMeetingCatchUp (non-readers & expired retention get 404 MEETING_NOT_FOUND; recorder gets reason 'is_recorder' / 403 FORBIDDEN)
//   - refuses unpublished minutes and redacted minutes cleanly with 0 model calls
//   - code-built "Việc của bạn" (`yourItems`: `who_parsed` first, `plainName` fallback, never matching another user's `who_parsed`) works even with AI off / forbidden / budget / paused
//   - AI off, vy.use denied, kill switch paused, spent hard budget, and projected-cost overflow refuse with fixed codes and 0 model calls
//   - prompt sends published summary/decisions/items only (never transcript/draft/notes), drops ungrounded numbers/contacts/bad citations, stores counts only in member_vy_result, logs no prose
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { metered, type AiMeter } from '@ludy/agent';
import type { ModelPort } from '@ludy/agent/member-vy';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { REDACTION_MARK_BY_KIND } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { memberMeter } from '../src/ai-meter.ts';
import { catchUpStatusOf, runMeetingCatchUp, type MeetingBriefDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET_TRANSCRIPT = 'Nội dung bản ghi riêng: khách hàng đồng ý chiết khấu bí mật 45% nếu ký tuần này.';
const SECRET_DRAFT = 'Bản nháp riêng của người ghi: chưa chốt thưởng nhóm 999 triệu.';
const SECRET_NOTES = 'Ghi chú riêng tư của người ghi không được phép rò rỉ.';

suite('meeting catch-up for a member who missed a meeting (#5130)', () => {
  const dbName = `ludy_test_catch_up_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const asMfa = (who: string) => ({
    type: 'user' as const,
    userId: users[who] as string,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string; status?: number }) ?? { code: 'ERR' });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  let modelCalls = 0;
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))),
  );
  afterEach(() => {
    logged.length = 0;
    modelCalls = 0;
    setSummaryEnabled(true);
  });

  let modelReply = '';
  let lastPrompt: { system: string; user: string; feature?: string | undefined; expected?: { inputTokens: number; outputTokens: number } | undefined } | null = null;
  const model: ModelPort = {
    generate: async (_who, prompt) => {
      modelCalls += 1;
      lastPrompt = prompt;
      return { text: modelReply, usage: { inputTokens: 200, outputTokens: 80 } };
    },
  };
  const noopMeter: AiMeter = { admit: async () => undefined, record: async () => undefined };
  const deps = (over: Partial<MeetingBriefDeps> = {}): MeetingBriefDeps => ({
    runtime,
    model,
    meter: () => noopMeter,
    budget: new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }),
    timeoutMs: 2000,
    ...over,
  });

  async function seedMeeting(opts: { published?: boolean; redacted?: boolean; expired?: boolean; language?: 'vi' | 'en' } = {}) {
    const meetingId = randomUUID();
    const retentionExpr = opts.expired ? 'current_date - 1' : 'current_date + 365';
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Giao ban sản phẩm', $3, '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $4, 'attendees', 'ready', 'told_at_start', $4, now(), '1.0', current_date + 30, ${retentionExpr})`,
      [orgId, meetingId, opts.language ?? 'vi', users.recorder],
    );
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4), ($1, $5, $3, $6)', [
      orgId,
      randomUUID(),
      meetingId,
      users.reader,
      randomUUID(),
      users.otherReader,
    ]);
    await sqlAdmin(
      `INSERT INTO ludy_meetings.transcript_segment (org_id, id, meeting_id, speaker_label, text, start_seconds, end_seconds, stage, tainted)
       VALUES ($1, $2, $3, 'Thu Lan', $4, 0, 15, 'draft', false)`,
      [orgId, randomUUID(), meetingId, SECRET_TRANSCRIPT],
    );
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage)
       VALUES ($1, $2, $3, '[]'::jsonb, 'manual', 'draft')`,
      [orgId, meetingId, SECRET_DRAFT],
    );
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting_note (org_id, id, meeting_id, body)
       VALUES ($1, $2, $3, $4)`,
      [orgId, randomUUID(), meetingId, SECRET_NOTES],
    );

    const itemById = randomUUID();
    const itemByName = randomUUID();
    const itemOtherParsed = randomUUID();
    if (opts.published !== false) {
      const summaryText = opts.redacted
        ? `Liên hệ ${REDACTION_MARK_BY_KIND.email} để nhận báo giá.`
        : 'Nhóm thống nhất chốt ngân sách chiến dịch và phân công triển khai tháng 12.';
      await sqlAdmin(
        `INSERT INTO ludy_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage)
         VALUES ($1, $2, $3, $4::jsonb, 'manual', 'published')`,
        [
          orgId,
          meetingId,
          summaryText,
          JSON.stringify(['Chốt ngân sách 15.000.000 đ cho chiến dịch tháng 12.', 'Giữ lịch phát hành vào thứ sáu.']),
        ],
      );
      await sqlAdmin(
        `INSERT INTO ludy_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, task_id, tainted, transcript_seconds)
         VALUES
           ($1, $2, $3, 'Gửi báo giá 15.000.000 đ cho khách A', 'Lan', $4, 'thứ năm', 'published', 'suggested', null, false, 10),
           ($1, $5, $3, 'Rà soát tài liệu ra mắt', 'chị Hùng', null, 'thứ sáu', 'published', 'suggested', null, false, 20),
           ($1, $6, $3, 'Việc riêng của người đọc khác', 'Văn Hùng', $7, 'tuần tới', 'published', 'suggested', null, false, 30)`,
        [orgId, itemById, meetingId, users.reader, itemByName, itemOtherParsed, users.otherReader],
      );
    }

    return { meetingId, itemById, itemByName, itemOtherParsed };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    setSummaryEnabled(true);
    for (const key of ['owner', 'recorder', 'reader', 'otherReader', 'outsider']) {
      const displayName = key === 'recorder' ? 'Thu Lan' : key === 'reader' ? 'Văn Hùng' : key === 'otherReader' ? 'Minh Anh' : key;
      users[key] = await upsertIdentity(db, { issuer: 'catch-up', subject: key, email: `${key}@catch-up.test`, name: displayName });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Họp Nhanh')).orgId;
    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`,
      [orgId, users.recorder, users.reader, users.otherReader, users.outsider],
    );
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

  it('enforces row visibility, recorder refusal, unpublished refusal, redaction gate, and builds yourItems even when AI is off', async () => {
    const { meetingId, itemById, itemByName, itemOtherParsed } = await seedMeeting();
    const unpub = await seedMeeting({ published: false });
    const redacted = await seedMeeting({ redacted: true });
    const expired = await seedMeeting({ expired: true });

    // Non-reader (even org owner!) and expired retention get 404 MEETING_NOT_FOUND, 0 model calls.
    expect(await refuses(catchUpStatusOf(deps(), orgId, asUser('outsider'), meetingId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await refuses(runMeetingCatchUp(deps(), orgId, asUser('outsider'), meetingId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await refuses(catchUpStatusOf(deps(), orgId, asUser('owner'), meetingId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await refuses(catchUpStatusOf(deps(), orgId, asUser('reader'), expired.meetingId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });

    // Recorder sees reason: 'is_recorder' on status and 403 FORBIDDEN on write/facts/start.
    expect(await catchUpStatusOf(deps(), orgId, asUser('recorder'), meetingId)).toMatchObject({
      meetingId,
      available: false,
      reason: 'is_recorder',
      yourItems: [],
      estimate: null,
    });
    expect(await refuses(runMeetingCatchUp(deps(), orgId, asUser('recorder'), meetingId))).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await refuses(exec('recorder', 'meetings.catch_up.start', { meetingId }))).toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Unpublished & redacted meetings refuse cleanly with 0 model calls and empty yourItems.
    expect(await catchUpStatusOf(deps(), orgId, asUser('reader'), unpub.meetingId)).toMatchObject({
      available: false,
      reason: 'not_published',
      yourItems: [],
    });
    expect(await refuses(runMeetingCatchUp(deps(), orgId, asUser('reader'), unpub.meetingId))).toMatchObject({ code: 'CATCH_UP_NOT_PUBLISHED', status: 422 });
    expect(await catchUpStatusOf(deps(), orgId, asUser('reader'), redacted.meetingId)).toMatchObject({
      available: false,
      reason: 'redacted',
      yourItems: [],
    });
    expect(await refuses(runMeetingCatchUp(deps(), orgId, asUser('reader'), redacted.meetingId))).toMatchObject({ code: 'CATCH_UP_REDACTED', status: 422 });

    // Code-built "Việc của bạn" works with AI off (switch off and null model), matching user_id + name fallback and excluding other user's who_parsed.
    setSummaryEnabled(false);
    const aiOffStatus = await catchUpStatusOf(deps({ model: null }), orgId, asUser('reader'), meetingId);
    expect(aiOffStatus.available).toBe(false);
    expect(aiOffStatus.reason).toBe('off');
    expect(aiOffStatus.yourItems.map((i) => ({ itemId: i.itemId, matchedBy: i.matchedBy }))).toEqual([
      { itemId: itemById, matchedBy: 'user_id' },
      { itemId: itemByName, matchedBy: 'name' },
    ]);
    expect(aiOffStatus.yourItems.some((i) => i.itemId === itemOtherParsed)).toBe(false);
    expect(await refuses(runMeetingCatchUp(deps(), orgId, asUser('reader'), meetingId))).toMatchObject({ code: 'CATCH_UP_OFF', status: 422 });
    setSummaryEnabled(true);
    expect(await refuses(runMeetingCatchUp(deps({ model: null }), orgId, asUser('reader'), meetingId))).toMatchObject({ code: 'CATCH_UP_OFF', status: 422 });
    expect(modelCalls).toBe(0);
  });

  it('refuses vy.use denial, kill switches, spent hard budget, and projected-cost overflow with 0 model calls', async () => {
    const { meetingId, itemById, itemByName } = await seedMeeting();

    // 1. vy.use denied
    await runtime.execute('kernel.member.permission.set', { userId: users.reader, permission: 'vy.use', allowed: false }, { actor: asMfa('owner'), orgId });
    try {
      const forbiddenStatus = await catchUpStatusOf(deps(), orgId, asUser('reader'), meetingId);
      expect(forbiddenStatus.available).toBe(false);
      expect(forbiddenStatus.reason).toBe('forbidden');
      expect(forbiddenStatus.yourItems.map((i) => i.itemId)).toEqual([itemById, itemByName]);
      expect(await refuses(runMeetingCatchUp(deps(), orgId, asUser('reader'), meetingId))).toMatchObject({ code: 'VY_NOT_ALLOWED', status: 403 });
      expect(modelCalls).toBe(0);
    } finally {
      await runtime.execute('kernel.member.permission.set', { userId: users.reader, permission: 'vy.use', allowed: null }, { actor: asMfa('owner'), orgId });
    }

    // 2. Kill switch engaged on module 'meetings'
    const engaged = await runtime.execute<{ killSwitchId: string }>('kernel.agent.kill_switch.engage', { scope: 'module', target: 'meetings' }, { actor: asMfa('owner'), orgId });
    try {
      const pausedStatus = await catchUpStatusOf(deps(), orgId, asUser('reader'), meetingId);
      expect(pausedStatus.available).toBe(false);
      expect(pausedStatus.reason).toBe('off');
      expect(pausedStatus.yourItems).toHaveLength(2);
      expect(await refuses(runMeetingCatchUp(deps(), orgId, asUser('reader'), meetingId))).toMatchObject({ code: 'AI_STOPPED', status: 422 });
      expect(modelCalls).toBe(0);
    } finally {
      await runtime.execute('kernel.agent.kill_switch.release', { id: engaged.killSwitchId }, { actor: asMfa('owner'), orgId });
    }

    // 3. Hard budget exhausted at 0 limit
    await sqlAdmin(
      `INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', '0', 80, true, $2)`,
      [orgId, users.owner],
    );
    try {
      const budgetStatus = await catchUpStatusOf(deps(), orgId, asUser('reader'), meetingId);
      expect(budgetStatus.available).toBe(false);
      expect(budgetStatus.reason).toBe('budget');
      expect(budgetStatus.yourItems).toHaveLength(2);
      expect(await refuses(runMeetingCatchUp(deps(), orgId, asUser('reader'), meetingId))).toMatchObject({ code: 'AI_BUDGET_EXHAUSTED', status: 422 });
      expect(modelCalls).toBe(0);
    } finally {
      await sqlAdmin('DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1', [orgId]);
    }

    // 4. Projected-cost admission refusal via real memberMeter
    const meteredModel: ModelPort = {
      generate: async (_who, prompt) =>
        metered(
          'meetings.catch_up',
          async () => {
            modelCalls += 1;
            return { text: modelReply, usage: { inputTokens: 200, outputTokens: 80 } };
          },
          undefined,
          prompt.expected,
        ),
    };
    await sqlAdmin(
      `INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', '0.000500', 80, true, $2)`,
      [orgId, users.owner],
    );
    try {
      const meteredOut = await runMeetingCatchUp(
        deps({
          model: meteredModel,
          meter: (actor) => memberMeter(runtime, actor, { price: { inputPerMTok: '3.00', outputPerMTok: '15.00' } }),
        }),
        orgId,
        asUser('reader'),
        meetingId,
      );
      expect(meteredOut).toMatchObject({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED', lines: [], dropped: 0 });
      expect(modelCalls).toBe(0);
    } finally {
      await sqlAdmin('DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1', [orgId]);
    }
  });

  it('grounds citations to published minutes only, drops ungrounded/poisoned lines, stores counts only, and leaks zero prose to logs', async () => {
    const { meetingId, itemById } = await seedMeeting();
    const status = await catchUpStatusOf(
      deps({ price: { inputPerMTok: '1.00', outputPerMTok: '2.00' } }),
      orgId,
      asUser('reader'),
      meetingId,
    );
    expect(status.available).toBe(true);
    expect(status.estimate).toMatchObject({ inputTokens: 1800, outputTokens: 350 });

    modelReply = JSON.stringify({
      lines: [
        { text: 'Bạn cần gửi báo giá 15.000.000 đ cho khách A trước thứ năm.', cite: { kind: 'item', itemId: itemById } },
        { text: 'Nhóm đã chốt ngân sách 15.000.000 đ cho chiến dịch tháng 12.', cite: { kind: 'decision', index: 1 } },
        { text: 'Ngân sách được nâng lên 99.000.000 đ.', cite: { kind: 'decision', index: 1 } },
        { text: 'Gửi tới attacker@evil.invalid ngay.', cite: { kind: 'decision', index: 2 } },
        { text: 'Trích dẫn sai.', cite: { kind: 'decision', index: 99 } },
      ],
    });

    const answer = await runMeetingCatchUp(deps(), orgId, asUser('reader'), meetingId);
    expect(modelCalls).toBe(1);
    expect(lastPrompt?.feature).toBe('meetings.catch_up');
    expect(lastPrompt?.expected).toEqual({ inputTokens: 1800, outputTokens: 350 });
    // Prompt receives published minutes only: never transcript, draft summary, or recorder notes.
    expect(lastPrompt?.user).not.toContain(SECRET_TRANSCRIPT);
    expect(lastPrompt?.user).not.toContain(SECRET_DRAFT);
    expect(lastPrompt?.user).not.toContain(SECRET_NOTES);

    expect(answer).toEqual({
      state: 'written',
      errorCode: null,
      lines: [
        { text: 'Bạn cần gửi báo giá 15.000.000 đ cho khách A trước thứ năm.', cite: { kind: 'item', itemId: itemById } },
        { text: 'Nhóm đã chốt ngân sách 15.000.000 đ cho chiến dịch tháng 12.', cite: { kind: 'decision', index: 1 } },
      ],
      dropped: 3,
    });

    // member_vy_result stores counts only under an ephemeral subject (not meetingId).
    const directRows = await sqlAdmin('SELECT id FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2', [orgId, meetingId]);
    expect(directRows.rows).toHaveLength(0);
    const ephemeralRows = await sqlAdmin<{ body: string | null; status: string }>(
      `SELECT r.body, r.status FROM ludy_kernel.member_vy_result r JOIN ludy_kernel.ai_run a ON a.org_id = r.org_id AND a.id = r.run_id WHERE r.org_id = $1 AND a.feature = 'meetings.catch_up'`,
      [orgId],
    );
    expect(
      ephemeralRows.rows.some(
        (r) => r.status === 'ready' && r.body === JSON.stringify({ v: 1, lines: 2, dropped: 3, decisions: 2, items: 3 }),
      ),
    ).toBe(true);

    // Unparsable reply fails with fixed error code; valid empty JSON returns state 'none'.
    modelReply = 'not valid json';
    expect(await runMeetingCatchUp(deps(), orgId, asUser('reader'), meetingId)).toEqual({
      state: 'failed',
      errorCode: 'CATCH_UP_UNPARSABLE',
      lines: [],
      dropped: 0,
    });
    modelReply = JSON.stringify({ lines: [] });
    expect(await runMeetingCatchUp(deps(), orgId, asUser('reader'), meetingId)).toEqual({
      state: 'none',
      errorCode: null,
      lines: [],
      dropped: 0,
    });

    // Zero prose leaked into console logs.
    const allLogs = logged.join('\n');
    expect(allLogs).not.toContain('15.000.000');
    expect(allLogs).not.toContain('chiến dịch');
    expect(allLogs).not.toContain(SECRET_TRANSCRIPT);
  });
});

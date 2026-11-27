// SPDX-License-Identifier: AGPL-3.0-only
// Render-time read-only context for opted-in morning briefing emails (ADR-0049 O1, issue #5080).
// Two-step / three-step invariant contract (docs/security/invariant-suite.md):
//   - Step 0a (PR #5138, before Step 0b / Slice A): pins that crove_kernel.enter_member_briefing_context(uuid,uuid,uuid),
//     crove_kernel.ctx_briefing_user_id(), and crove_kernel.member_briefing_table do not exist yet, and pins current
//     isolation of calendar_agenda, attendees-only private meetings, meeting_link, private notes, member_vy_memory,
//     member_vy_result, tasks, task comments, transcript_segment, meeting_note, and user credentials.
//   - Slice A readiness (once enter_member_briefing_context, ctx_briefing_user_id, and member_briefing_table exist):
//       1. enter_member_briefing_context(org_id, member_user_id, mail_id) is SECURITY DEFINER with pinned search_path,
//          executable ONLY by crove_worker (session_user verified internally), refuses re-entry inside any sealed
//          context, works under BEGIN READ ONLY (and in writable tx takes FOR SHARE on tenant_member while writes fail),
//          and fails closed (42501) unless org active (not closed or offboarding), member active/non-viewer, user_account
//          enabled, meetings app enabled, mail_message in (queued, sending) with source = 'meetings.morning', age <= 36h,
//          non-null to_address matching target member, and morning_notice (enabled = true, content = 'full').
//       2. Seals an R0 tainted agent context (kind = 'member_briefing', member = member_user_id, actor = 'agent',
//          user = null, position = null) binding member's role + le_scope, exposing member_user_id ONLY via
//          crove_kernel.ctx_briefing_user_id() while leaving ctx_acting_user_id() NULL.
//       3. crove_kernel.member_briefing_table is migration-populated only (zero runtime writes, mode = 'read' only),
//          strictly allowlisting ONLY the 7 Meetings tables (calendar_agenda, meeting, meeting_reader, meeting_link,
//          meeting_result [published only], action_item [published only], morning_brief_lines) and at most one narrow
//          non-secret member display-name lookup; NEVER tasks, notes, memory, member_vy results, party, CRM, or emails.
//       4. Bidirectional pg_policy audit on ctx_briefing_user_id() requires FOR SELECT ('r') policies matching the
//          catalog; active member_briefing refuses member_emails, emit, and EVERY write across guarded/closed tables.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@ludy/db";
import { migrate } from "@ludy/db/migrate";
import {
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from "@ludy/kernel";
import { Runtime } from "@ludy/kernel-runtime";
import { financeCommands, financeQueries } from "@ludy/mod-finance";
import { aiRunFeature, type AiRunFeature } from "./fixtures/ai-run-feature.ts";
import { contextToken } from "./fixtures/context-token.ts";
import {
  auditRoleFunctionExecute,
  auditRoleTablePrivileges,
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from "./fixtures/db-identifiers.ts";
import { TEST_MANIFESTS } from "./fixtures/manifests.ts";

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(
  new URL("../../../../supabase/migrations", import.meta.url),
);
const suite = ADMIN ? describe : describe.skip;

const SYSTEM = { type: "system" as const, component: "kernel.agent" };
const ENTRY_FN = "crove_kernel.enter_member_briefing_context(uuid,uuid,uuid)";
const HELPER_FN = "crove_kernel.ctx_briefing_user_id()";
const CATALOG_TABLE = "crove_kernel.member_briefing_table";

const REQUIRED_BRIEFING_TABLES = [
  "crove_meetings.calendar_agenda",
  "crove_meetings.meeting",
  "crove_meetings.meeting_reader",
  "crove_meetings.meeting_link",
  "crove_meetings.meeting_result",
  "crove_meetings.action_item",
  "crove_meetings.morning_brief_lines",
] as const;

const ALLOWED_MEETINGS_TABLES = new Set<string>(REQUIRED_BRIEFING_TABLES);

const ALLOWED_LOOKUP_COLUMNS = new Set([
  "org_id",
  "user_id",
  "id",
  "display_name",
  "name",
]);

const FORBIDDEN_BRIEFING_TABLES = new Set([
  "crove_kernel.task",
  "crove_kernel.task_comment",
  "crove_notes.note",
  "crove_kernel.member_vy_memory",
  "crove_kernel.member_vy_result",
  "crove_kernel.member_vy_system_feature",
  "crove_kernel.ai_run",
  "crove_kernel.user_account",
  "crove_kernel.user_identity",
  "crove_kernel.user_session",
  "crove_kernel.tenant_member",
  "crove_kernel.calendar_credential",
  "crove_kernel.calendar_connection",
  "crove_kernel.party",
  "crove_kernel.audit_event",
  "crove_kernel.outbox_pending",
  "crove_kernel.idempotency_key",
  "crove_kernel.refusal_tally",
  "crove_projects.project",
  "crove_kernel.mail_message",
  "crove_kernel.mail_event",
  "crove_kernel.mail_suppression",
  "crove_kernel.inbound_message",
  "crove_kernel.today_mail",
  "crove_meetings.transcript_segment",
  "crove_meetings.meeting_note",
  "crove_meetings.audio_segment",
  "crove_meetings.meeting_video",
  "crove_meetings.media_key",
]);

const FORBIDDEN_BRIEFING_PREFIXES = [
  "crove_projects.",
  "crove_notes.",
  "crove_crm.",
  "crove_finance.",
  "crove_hr.",
  "crove_social.",
  "crove_sign.",
  "crove_inventory.",
] as const;

let FEAT: AiRunFeature = { cols: "", vals: "" };

suite("member_briefing render-time read-only context invariants (ADR-0049 O1, #5080)", () => {
  const dbName = `member_briefing_${randomUUID().replaceAll("-", "")}`;
  let adminUrl = "";
  let appUrl = "";
  let workerUrl = "";
  let dbIds: DbIdentifiers | undefined;
  const pools: pg.Pool[] = [];

  let orgId = "";
  let orgName = "Briefing Org";
  let orgSlug = "briefing-org";
  let otherOrg = "";
  let otherOrgName = "Other Briefing Org";
  let otherOrgSlug = "other-briefing-org";
  let branch = "";
  let dueTz: "UTC" | "Pacific/Honolulu" | "Asia/Tokyo" = "UTC";
  const WEEKLY_DUE_NOW_SQL = `CASE
    WHEN pg_catalog.date_part('isodow', pg_catalog.now() AT TIME ZONE 'UTC') = 1
     AND (pg_catalog.now() AT TIME ZONE 'UTC')::time < time '11:00'
    THEN (pg_catalog.date_trunc('week', pg_catalog.now() AT TIME ZONE 'UTC') + interval '13 hours') AT TIME ZONE 'UTC'
    ELSE (pg_catalog.date_trunc('week', pg_catalog.now() AT TIME ZONE 'UTC') + interval '7 days 9 hours') AT TIME ZONE 'UTC'
  END`;

  const users = {
    owner: "",
    member: "",
    twin: "",
    other: "",
    viewer: "",
    limited: "",
    stranger: "",
  };
  const emails = {
    owner: "owner@member-briefing.test",
    member: "member@member-briefing.test",
    twin: "member@member-briefing.test",
    other: "other@member-briefing.test",
    viewer: "viewer@member-briefing.test",
    limited: "limited@member-briefing.test",
    stranger: "stranger@member-briefing.test",
  };
  const expectedNames: Record<keyof typeof users, string> = {
    owner: "owner Display",
    member: "member Display",
    twin: "twin Display",
    other: "other Display",
    viewer: "viewer Display",
    limited: "limited Display",
    stranger: "stranger Display",
  };

  let orgChart = { agentId: "", runId: "" };
  let memberVyRunId = "";
  const vyAgent: Record<string, string> = {};

  const ids = {
    calConnOwner: randomUUID(),
    calConnMember: randomUUID(),
    calConnOther: randomUUID(),
    calConnViewer: randomUUID(),
    calConnCross: randomUUID(),
    calAgendaOwner: randomUUID(),
    calAgendaMember: randomUUID(),
    calAgendaOther: randomUUID(),
    calAgendaViewer: randomUUID(),
    calAgendaCross: randomUUID(),
    calAgendaSeriesCross: randomUUID(),
    seriesCrossOrg: randomUUID(),
    mOrg: randomUUID(),
    mSharedMine: randomUUID(),
    mRecMine: randomUUID(),
    mAttCanary: randomUUID(),
    mCrossOrg: randomUUID(),
    mSeriesPrevCross: randomUUID(),
    resOrgPub: randomUUID(),
    resOrgDraft: randomUUID(),
    resSharedPub: randomUUID(),
    resRecPub: randomUUID(),
    resRecDraft: randomUUID(),
    resAttCanaryPub: randomUUID(),
    resCrossPub: randomUUID(),
    itemOrgPub: randomUUID(),
    itemOrgDraft: randomUUID(),
    itemSharedPub: randomUUID(),
    itemRecPub: randomUUID(),
    itemRecDraft: randomUUID(),
    itemAttCanaryPub: randomUUID(),
    itemSeriesCrossPub: randomUUID(),
    partyOrg: randomUUID(),
    partyCrossOrg: randomUUID(),
    stageOrg: randomUUID(),
    stageCrossOrg: randomUUID(),
    dealOrg: randomUUID(),
    dealCrossOrg: randomUUID(),
    linkOrg: randomUUID(),
    linkShared: randomUUID(),
    linkMine: randomUUID(),
    linkCanary: randomUUID(),
    linkCrossOrg: randomUUID(),
    segOrgPub: randomUUID(),
    segMinePub: randomUUID(),
    segCanaryPub: randomUUID(),
    noteRecMine: randomUUID(),
    noteOrg: randomUUID(),
    noteMemberPriv: randomUUID(),
    noteOtherOrg: randomUUID(),
    memMember: randomUUID(),
    vyResultMember: randomUUID(),
    taskOrg: randomUUID(),
    taskCommentOrg: randomUUID(),
    taskCrossOrg: randomUUID(),
    mailCanary: randomUUID(),
    mailEventCanary: randomUUID(),
    mailSuppressionCanary: randomUUID(),
    inboundCanary: randomUUID(),
    todayMailCanary: randomUUID(),
    briefLineMine: randomUUID(),
    briefLineOther: randomUUID(),
    briefLineRevoked: randomUUID(),
    mcpGrantOwner: randomUUID(),
    projectOrg: randomUUID(),
    projectColumnOrg: randomUUID(),
    projectMemberOrg: randomUUID(),
    projectTaskOrg: randomUUID(),
  };

  const has = {
    entry: false,
    helper: false,
    catalog: false,
    briefLines: false,
    notes: false,
    projects: false,
    memberVyHasAgenda: false,
    noticeEnabled: false,
    noticeContent: false,
    noticeVyLines: false,
    weeklyNoticesDue: false,
    seriesNudgesDue: false,
  };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function inContext<T>(
    url: string,
    enter: (c: pg.Client) => Promise<unknown>,
    fn: (c: pg.Client) => Promise<T>,
    opts: { commit?: boolean; readOnly?: boolean } = {},
  ): Promise<T> {
    const c = createDbClient({ connectionString: url }, dbIds);
    await c.connect();
    try {
      await c.query(opts.readOnly ? "BEGIN READ ONLY" : "BEGIN");
      await enter(c);
      const out = await fn(c);
      if (opts.commit) await c.query("COMMIT");
      return out;
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
  }

  const outcome = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: { code?: string; message?: string }) => ({
        ok: false as const,
        code: error.code ?? "",
        message: error.message ?? "",
      }),
    );

  async function inSavepoint<T>(
    c: pg.Client,
    name: string,
    fn: () => Promise<T>,
  ) {
    await c.query(`SAVEPOINT ${name}`);
    const res = await outcome(fn());
    await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await c.query(`RELEASE SAVEPOINT ${name}`);
    return res;
  }

  const asUser = (userId: string) => ({
    type: "user" as const,
    userId,
    aal: "aal1" as const,
  });

  const userEnter =
    (userId: string, org = orgId) =>
    (c: pg.Client) =>
      c.query("SELECT crove_kernel.enter_user_context($1::uuid, $2::text)", [
        org,
        contextToken(userId, org),
      ]);

  const systemEnter =
    (org = orgId) =>
    (c: pg.Client) =>
      c.query("SELECT crove_kernel.enter_system_context($1::uuid)", [org]);

  const agentEnter = (c: pg.Client) =>
    c.query("SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)", [
      orgId,
      orgChart.agentId,
      orgChart.runId,
    ]);

  const briefingEnter =
    (org: string, memberUserId: string, mailId: string) => (c: pg.Client) =>
      c.query(
        "SELECT crove_kernel.enter_member_briefing_context($1::uuid, $2::uuid, $3::uuid)",
        [org, memberUserId, mailId],
      );

  const sealOf = async (c: pg.Client) =>
    JSON.parse(
      (
        await c.query<{ ctx: string }>("SELECT current_setting('crove.ctx') AS ctx")
      ).rows[0]?.ctx as string,
    ) as Record<string, unknown>;

  async function ensureVyAgent(who: keyof typeof users): Promise<string> {
    if (vyAgent[who]) return vyAgent[who] as string;
    const agentId = randomUUID();
    await inContext(
      appUrl,
      userEnter(users[who]),
      (c) =>
        c.query(
          `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by)
           VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
          [orgId, agentId, users[who]],
        ),
      { commit: true },
    );
    vyAgent[who] = agentId;
    return agentId;
  }

  async function liveVyRun(who: keyof typeof users) {
    const agentId = await ensureVyAgent(who);
    await admin((c) =>
      c.query(
        `UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now()
         WHERE org_id = $1 AND agent_id = $2 AND status = 'running'`,
        [orgId, agentId],
      ),
    );
    const runId = randomUUID();
    await inContext(
      appUrl,
      userEnter(users[who]),
      (c) =>
        c.query(
          `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at${FEAT.cols})
           VALUES ($1, $2, $3, 'notes', 'running', true, now(), now() + interval '30 minutes'${FEAT.vals})`,
          [orgId, runId, agentId],
        ),
      { commit: true },
    );
    return { agentId, runId };
  }

  async function asVy<T>(
    who: keyof typeof users,
    fn: (c: pg.Client) => Promise<T>,
  ): Promise<T> {
    const run = await liveVyRun(who);
    return inContext(
      workerUrl,
      (c) =>
        c.query(
          "SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)",
          [orgId, run.agentId, run.runId],
        ),
      fn,
    );
  }

  async function seedMorningMail(opts: {
    org?: string;
    toAddress: string;
    sourceId?: string | null;
    createdBy?: string | null;
    source?: string;
    status?: "queued" | "sending" | "suppressed";
    ageInterval?: string;
  }): Promise<string> {
    const mailId = randomUUID();
    const targetOrg = opts.org ?? orgId;
    const status = opts.status ?? "queued";
    const source = opts.source ?? "meetings.morning";
    const age = opts.ageInterval ?? "0 seconds";
    const targetOrgName = targetOrg === otherOrg ? otherOrgName : orgName;
    const targetOrgSlug = targetOrg === otherOrg ? otherOrgSlug : orgSlug;
    const payload = JSON.stringify({
      lang: "vi",
      org: targetOrgName,
      path: `/o/${targetOrgSlug}/meetings`,
      day: new Date().toISOString().slice(0, 10),
    });
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.mail_message
           (org_id, id, stream, source, source_id, template_key, to_address, to_hash, subject, payload, message_id_header, status, created_by, created_at)
         VALUES
           ($1, $2, 'transactional', $3, $4, 'meetings.morning', $5, crove_kernel.mail_address_hash($5),
            'Daily morning briefing', $6::jsonb, $7, $8, $9, now() - $10::interval)`,
        [
          targetOrg,
          mailId,
          source,
          opts.sourceId ?? null,
          opts.toAddress.toLowerCase(),
          payload,
          `<${mailId}@ludy.test>`,
          status,
          opts.createdBy ?? null,
          age,
        ],
      ),
    );
    return mailId;
  }

  async function upsertMorningNotice(
    targetOrg: string,
    userId: string,
    opts: {
      enabled?: boolean;
      content?: "count" | "full";
      vyLines?: boolean;
      timeZone?: string;
      sendMinuteSql?: string;
    } = {},
  ): Promise<void> {
    const enabled = opts.enabled ?? true;
    const content = opts.content ?? "full";
    const vyLines = opts.vyLines ?? false;
    const timeZone = opts.timeZone ?? "Asia/Ho_Chi_Minh";
    const sendMinuteExpr = opts.sendMinuteSql ?? "420";
    const cols = ["org_id", "user_id", "send_minute", "time_zone", "language"];
    const placeholders = ["$1", "$2", sendMinuteExpr, "$3", "'vi'"];
    const updates = [
      "send_minute = EXCLUDED.send_minute",
      "time_zone = EXCLUDED.time_zone",
    ];
    const params: unknown[] = [targetOrg, userId, timeZone];

    if (has.noticeEnabled) {
      cols.push("enabled");
      params.push(enabled);
      placeholders.push(`$${params.length}`);
      updates.push("enabled = EXCLUDED.enabled");
    }
    if (has.noticeContent) {
      cols.push("content");
      params.push(content);
      placeholders.push(`$${params.length}`);
      updates.push("content = EXCLUDED.content");
    }
    if (has.noticeVyLines) {
      cols.push("vy_lines");
      params.push(vyLines);
      placeholders.push(`$${params.length}`);
      updates.push("vy_lines = EXCLUDED.vy_lines");
    }
    await admin((c) =>
      c.query(
        `INSERT INTO crove_meetings.morning_notice (${cols.join(", ")})
         VALUES (${placeholders.join(", ")})
         ON CONFLICT (org_id, user_id) DO UPDATE SET ${updates.join(", ")}`,
        params,
      ),
    );
  }

  async function ensureBriefLinesSeeded(): Promise<void> {
    if (!has.briefLines) return;
    await admin(async (c) => {
      if (!dbIds) throw new Error("dbIds not resolved");
      const lineCols = await c.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'morning_brief_lines'
         ORDER BY ordinal_position`,
        [dbIds.schema("meetings")],
      );

      const insertBriefLine = async (
        lineId: string,
        targetUserId: string,
        targetMeetingId: string,
        lineText: string,
      ) => {
        const names: string[] = [];
        const exprs: string[] = [];
        const vals: unknown[] = [];
        const pushVal = (col: string, val: unknown, cast = "") => {
          vals.push(val);
          names.push(col);
          exprs.push(`$${vals.length}${cast}`);
        };
        const pushExpr = (col: string, expr: string) => {
          names.push(col);
          exprs.push(expr);
        };
        for (const col of lineCols.rows) {
          const n = col.column_name;
          const isContentCol =
            n === "lines" || n === "text" || n === "line" || n === "body" || n === "content" || n === "summary";
          if (n === "org_id") pushVal(n, orgId, "::uuid");
          else if (n === "id") pushVal(n, lineId, "::uuid");
          else if (n === "user_id" || n === "member_user_id") pushVal(n, targetUserId, "::uuid");
          else if (n === "meeting_id") pushVal(n, targetMeetingId, "::uuid");
          else if (n === "run_id") pushVal(n, memberVyRunId, "::uuid");
          else if (n === "day" || n === "brief_day" || col.data_type === "date") pushExpr(n, "current_date");
          else if (n === "expires_at") pushExpr(n, "now() + interval '12 hours'");
          else if (isContentCol) {
            if (col.data_type === "jsonb") pushVal(n, JSON.stringify([lineText]), "::jsonb");
            else if (col.data_type === "ARRAY" || col.udt_name === "_text") pushVal(n, [lineText], "::text[]");
            else pushVal(n, lineText);
          } else if (col.is_nullable === "NO" && col.column_default === null) {
            if (col.data_type === "uuid") pushVal(n, randomUUID(), "::uuid");
            else if (col.data_type.startsWith("timestamp")) pushExpr(n, "now() + interval '12 hours'");
            else if (col.data_type === "boolean") pushVal(n, false, "::boolean");
            else if (col.data_type === "integer" || col.data_type === "smallint" || col.data_type === "bigint") {
              pushVal(n, 1);
            } else if (col.data_type === "jsonb") pushExpr(n, "'[]'::jsonb");
            else if (col.data_type === "ARRAY" || col.udt_name === "_text") pushExpr(n, "ARRAY['x']::text[]");
            else pushVal(n, lineText);
          }
        }
        await c.query(
          `INSERT INTO crove_meetings.morning_brief_lines (${names.join(", ")}) VALUES (${exprs.join(", ")}) ON CONFLICT DO NOTHING`,
          vals,
        );
      };

      await insertBriefLine(ids.briefLineMine, users.member, ids.mRecMine, "Prep for my meeting");
      await insertBriefLine(ids.briefLineOther, users.other, ids.mOrg, "CANARY Other brief line");
      await insertBriefLine(ids.briefLineRevoked, users.member, ids.mAttCanary, "CANARY Revoked brief line");

      const seededIds = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.morning_brief_lines WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
          [orgId, [ids.briefLineMine, ids.briefLineOther, ids.briefLineRevoked]],
        )
      ).rows.map((r) => r.id);
      expect(
        seededIds,
        "all three morning_brief_lines rows must exist without silent conflict skip",
      ).toEqual([ids.briefLineMine, ids.briefLineOther, ids.briefLineRevoked].sort());
    });
  }

  async function expectDeniedOrEmpty(
    c: pg.Client,
    sql: string,
    params: unknown[],
    label: string,
  ): Promise<void> {
    const res = await inSavepoint(c, "sp_probe", () => c.query(sql, params));
    if (res.ok) {
      expect(res.value.rows, `${label} must return zero rows`).toEqual([]);
      return;
    }
    expect(res.code, `${label} must fail closed with 42501`).toBe("42501");
  }

  async function expectWriteRefused(
    c: pg.Client,
    sql: string,
    params: unknown[],
    label: string,
    expectedMessage?: string | RegExp,
  ): Promise<void> {
    const res = await inSavepoint(c, "sp_write", () => c.query(sql, params));
    expect(res, `${label} must be refused`).toMatchObject({
      ok: false,
      code: "42501",
    });
    if (!res.ok && expectedMessage) {
      expect(res.message, `${label} must be blocked by expected guard`).toMatch(
        expectedMessage,
      );
    }
  }

  async function expectMutationBlockedOrZero(
    c: pg.Client,
    sql: string,
    params: unknown[],
    label: string,
  ): Promise<void> {
    const res = await inSavepoint(c, "sp_mut", () => c.query(sql, params));
    if (res.ok) {
      expect(res.value.rowCount, `${label} must affect zero rows`).toBe(0);
      return;
    }
    expect(res.code, `${label} must fail with 42501`).toBe("42501");
  }

  beforeAll(async () => {
    // Pick a time zone where current local hour is in [06..17] (>= 6h away from local midnight on both sides)
    // so calAgendaOther, morning_notice.send_minute, and morning_notices_due share one local date.
    const utcHour = new Date().getUTCHours();
    dueTz = utcHour >= 6 && utcHour < 18 ? "UTC" : utcHour >= 18 ? "Pacific/Honolulu" : "Asia/Tokyo";
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      await root.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await root.end();
    }
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    FEAT = await admin((c) => aiRunFeature(c));

    await setActiveRolePasswords(
      adminUrl,
      { crove_app: "test-app-pw", crove_worker: "test-worker-pw" },
      dbIds,
    );

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(username) : username;
      url.password = password;
      return url.toString();
    };
    appUrl = login("crove_app", "test-app-pw");
    workerUrl = login("crove_worker", "test-worker-pw");

    const runtimeFor = (url: string) => {
      const pool = createDbPool({ connectionString: url, max: 4 }, dbIds);
      pools.push(pool);
      const db = createDb(pool);
      return {
        db,
        runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({
          commands: [...kernelCommands, ...financeCommands],
          queries: [
            ...kernelQueries({ inboundDomain: "in.test" }),
            ...financeQueries,
          ],
        }),
      };
    };

    const api = runtimeFor(appUrl);
    const worker = runtimeFor(workerUrl).runtime;

    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, {
        issuer: "member-briefing",
        subject: key,
        email: emails[key],
        name: `${key} Display`,
      });
    }

    const primaryOrg = await createOrg(api.runtime, asUser(users.owner), "Briefing Org");
    orgId = primaryOrg.orgId;
    orgName = primaryOrg.name;
    orgSlug = primaryOrg.slug;
    const secondaryOrg = await createOrg(api.runtime, asUser(users.other), "Other Briefing Org");
    otherOrg = secondaryOrg.orgId;
    otherOrgName = secondaryOrg.name;
    otherOrgSlug = secondaryOrg.slug;

    await admin(async (c) => {
      branch = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by)
           VALUES ($1, 'Branch Entity', 'branch', $2) RETURNING id`,
          [orgId, users.owner],
        )
      ).rows[0]?.id as string;

      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES
           ($1, $2, 'member'),
           ($1, $3, 'member'),
           ($1, $4, 'member'),
           ($1, $5, 'viewer'),
           ($1, $6, 'member'),
           ($7, $8, 'member')`,
        [orgId, users.member, users.twin, users.other, users.viewer, users.limited, otherOrg, users.stranger],
      );

      // Grant vy.use to viewer so viewer enters member_vy and calendar_agenda RLS (not entry denial) is proven.
      await c.query(
        `INSERT INTO crove_kernel.member_permission_override (org_id, user_id, permission, allowed, set_by)
         VALUES ($1, $2, 'vy.use', true, $3)`,
        [orgId, users.viewer, users.owner],
      );

      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgId, users.limited, branch, users.owner],
      );

      const flags = await c.query<{ r: string; w: boolean }>(`
        SELECT 'entry' AS r, to_regprocedure('crove_kernel.enter_member_briefing_context(uuid,uuid,uuid)') IS NOT NULL AS w
        UNION ALL SELECT 'helper', to_regprocedure('crove_kernel.ctx_briefing_user_id()') IS NOT NULL
        UNION ALL SELECT 'catalog', to_regclass('crove_kernel.member_briefing_table') IS NOT NULL
        UNION ALL SELECT 'briefLines', to_regclass('crove_meetings.morning_brief_lines') IS NOT NULL
        UNION ALL SELECT 'notes', to_regclass('crove_notes.note') IS NOT NULL
        UNION ALL SELECT 'projects', to_regclass('crove_projects.project') IS NOT NULL
        UNION ALL SELECT 'weeklyNoticesDue', to_regprocedure('crove_meetings.weekly_notices_due(integer,uuid,uuid,date,timestamptz)') IS NOT NULL
        UNION ALL SELECT 'seriesNudgesDue', to_regprocedure('crove_meetings.series_nudges_due(integer,uuid,uuid,uuid,timestamptz)') IS NOT NULL
        UNION ALL SELECT 'memberVyHasAgenda', EXISTS (
          SELECT 1 FROM crove_kernel.member_vy_table
          WHERE table_name IN ('crove_meetings.calendar_agenda', 'ludy_meetings.calendar_agenda')
        )
      `);
      for (const row of flags.rows) {
        has[row.r as keyof typeof has] = row.w;
      }

      const noticeCols = await c.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema IN ('crove_meetings', 'ludy_meetings')
          AND table_name = 'morning_notice'
          AND column_name IN ('enabled', 'content', 'vy_lines')
      `);
      for (const col of noticeCols.rows) {
        if (col.column_name === "enabled") has.noticeEnabled = true;
        if (col.column_name === "content") has.noticeContent = true;
        if (col.column_name === "vy_lines") has.noticeVyLines = true;
      }

      await c.query(
        `INSERT INTO crove_kernel.calendar_connection
           (org_id, id, user_id, provider, external_account, display_name, status, read_events)
         VALUES
           ($1, $3, $4, 'google', $5, 'Owner Cal', 'active', true),
           ($1, $6, $7, 'google', $8, 'Member Cal', 'active', true),
           ($1, $9, $10, 'google', $11, 'Other Cal', 'active', true),
           ($1, $12, $13, 'google', $14, 'Viewer Cal', 'active', true),
           ($2, $15, $10, 'google', $11, 'Cross Cal', 'active', true)`,
        [
          orgId,
          otherOrg,
          ids.calConnOwner,
          users.owner,
          emails.owner,
          ids.calConnMember,
          users.member,
          emails.member,
          ids.calConnOther,
          users.other,
          emails.other,
          ids.calConnViewer,
          users.viewer,
          emails.viewer,
          ids.calConnCross,
        ],
      );

      await c.query(
        `INSERT INTO crove_meetings.calendar_agenda
           (org_id, id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, invitee_count, series_id)
         VALUES
           ($1, $3, $4, $5, 'ext-owner-1', 'Owner Private Agenda', now() + interval '1 hour', now() + interval '2 hours', 'Asia/Ho_Chi_Minh', 2, NULL),
           ($1, $6, $7, $8, 'ext-member-1', 'Member Sync Agenda', now() + interval '2 hours', now() + interval '3 hours', 'Asia/Ho_Chi_Minh', 3, NULL),
           ($1, $9, $10, $11, 'ext-other-1', 'CANARY Other Agenda Secret', ((pg_catalog.now() AT TIME ZONE $17)::date::timestamp + interval '12 hours') AT TIME ZONE $17, ((pg_catalog.now() AT TIME ZONE $17)::date::timestamp + interval '13 hours') AT TIME ZONE $17, $17, 1, NULL),
           ($1, $12, $13, $14, 'ext-viewer-1', 'Viewer Private Agenda', now() + interval '4 hours', now() + interval '5 hours', 'Asia/Ho_Chi_Minh', 1, NULL),
           ($2, $15, $16, $11, 'ext-cross-1', 'Cross Org Agenda', now() + interval '5 hours', now() + interval '6 hours', 'Asia/Ho_Chi_Minh', 1, NULL),
           ($2, $18, $16, $11, 'ext-cross-series-1', 'Cross Org Series Agenda', now() + interval '15 minutes', now() + interval '45 minutes', 'Asia/Ho_Chi_Minh', 1, $19)`,
        [
          orgId,
          otherOrg,
          ids.calAgendaOwner,
          ids.calConnOwner,
          users.owner,
          ids.calAgendaMember,
          ids.calConnMember,
          users.member,
          ids.calAgendaOther,
          ids.calConnOther,
          users.other,
          ids.calAgendaViewer,
          ids.calConnViewer,
          users.viewer,
          ids.calAgendaCross,
          ids.calConnCross,
          dueTz,
          ids.calAgendaSeriesCross,
          ids.seriesCrossOrg,
        ],
      );

      await c.query(
        `INSERT INTO crove_meetings.meeting
           (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status,
            consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, series_id)
         VALUES
           ($1, $3, 'Org Weekly All-Hands', 'vi', now() - interval '1 hour', now() - interval '30 minutes', 1800, $8, 'org', 'ready', 'told_at_start', $8, now(), '1.0', current_date + 30, current_date + 365, NULL),
           ($1, $4, 'Shared Deal Review', 'vi', now() - interval '1 hour', now() - interval '30 minutes', 1800, $8, 'attendees', 'ready', 'told_at_start', $8, now(), '1.0', current_date + 30, current_date + 365, NULL),
           ($1, $5, 'My Recorded 1-on-1', 'vi', now() - interval '1 hour', now() - interval '30 minutes', 1800, $9, 'attendees', 'ready', 'told_at_start', $9, now(), '1.0', current_date + 30, current_date + 365, NULL),
           ($1, $6, 'CANARY Private Executive Meeting', 'vi', now() - interval '1 hour', now() - interval '30 minutes', 1800, $8, 'attendees', 'ready', 'told_at_start', $8, now(), '1.0', current_date + 30, current_date + 365, NULL),
           ($2, $7, 'Cross-Org Meeting', 'vi', now() - interval '1 hour', now() - interval '30 minutes', 1800, $8, 'org', 'ready', 'told_at_start', $8, now(), '1.0', current_date + 30, current_date + 365, NULL),
           ($2, $10, 'Cross-Org Previous Series Meeting', 'vi', now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 1800, $8, 'attendees', 'ready', 'told_at_start', $8, now(), '1.0', current_date + 30, current_date + 365, $11)`,
        [
          orgId,
          otherOrg,
          ids.mOrg,
          ids.mSharedMine,
          ids.mRecMine,
          ids.mAttCanary,
          ids.mCrossOrg,
          users.other,
          users.member,
          ids.mSeriesPrevCross,
          ids.seriesCrossOrg,
        ],
      );

      await c.query(
        `INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id)
         VALUES
           ($1, $2, $3, $4),
           ($1, $5, $6, $7)`,
        [orgId, randomUUID(), ids.mSharedMine, users.member, randomUUID(), ids.mAttCanary, users.owner],
      );

      await c.query(
        `INSERT INTO crove_meetings.meeting_result
           (org_id, id, meeting_id, summary, decisions, feature, stage, tainted)
         VALUES
           ($1, $3, $9, 'Org published summary', '["Decision 1"]', 'meetings.summary', 'published', false),
           ($1, $4, $9, 'Org draft secret', '["Draft secret"]', 'meetings.summary', 'draft', true),
           ($1, $5, $10, 'Shared review summary', '["Decision 2"]', 'meetings.summary', 'published', false),
           ($1, $6, $11, 'My recorded summary', '["Decision 3"]', 'meetings.summary', 'published', false),
           ($1, $7, $11, 'My recorded draft', '["My draft"]', 'meetings.summary', 'draft', true),
           ($1, $8, $12, 'CANARY Summary Secret', '["CANARY decision"]', 'meetings.summary', 'published', false),
           ($2, $13, $14, 'Cross org published summary', '["Cross decision"]', 'meetings.summary', 'published', false)`,
        [
          orgId,
          otherOrg,
          ids.resOrgPub,
          ids.resOrgDraft,
          ids.resSharedPub,
          ids.resRecPub,
          ids.resRecDraft,
          ids.resAttCanaryPub,
          ids.mOrg,
          ids.mSharedMine,
          ids.mRecMine,
          ids.mAttCanary,
          ids.resCrossPub,
          ids.mCrossOrg,
        ],
      );

      await c.query(
        `INSERT INTO crove_kernel.task (org_id, id, title, source, created_by_type)
         VALUES
           ($1, $3, 'CANARY Sensitive Task Title', 'human', 'user'),
           ($2, $4, 'CANARY Cross Series Task', 'human', 'user')`,
        [orgId, otherOrg, ids.taskOrg, ids.taskCrossOrg],
      );

      await c.query(
        `INSERT INTO crove_meetings.action_item
           (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, when_parsed, transcript_seconds, stage, status, task_id, flags, tainted)
         VALUES
           ($1, $3, $9, 'Org published action', 'Other', $13, 'Today', '2026-11-27', 5, 'published', 'accepted', NULL, '[]', false),
           ($1, $4, $9, 'Org draft action secret', 'Other', $13, 'Today', '2026-11-27', 10, 'draft', 'suggested', NULL, '[]', true),
           ($1, $5, $10, 'Shared deal follow-up', 'Other', $14, 'Today', '2026-11-27', 15, 'published', 'accepted', NULL, '[]', false),
           ($1, $6, $11, 'My recorded action', 'Member', $14, 'Today', '2026-11-27', 20, 'published', 'accepted', NULL, '[]', false),
           ($1, $7, $11, 'My recorded draft action', 'Member', $14, 'Today', '2026-11-27', 22, 'draft', 'suggested', NULL, '[]', true),
           ($1, $8, $12, 'CANARY Action Secret', 'Other', $13, 'Today', '2026-11-27', 25, 'published', 'accepted', NULL, '[]', false),
           ($2, $15, $16, 'Cross series follow-up', 'Other', $13, 'Today', '2026-11-27', 30, 'published', 'accepted', $17, '[]', false)`,
        [
          orgId,
          otherOrg,
          ids.itemOrgPub,
          ids.itemOrgDraft,
          ids.itemSharedPub,
          ids.itemRecPub,
          ids.itemRecDraft,
          ids.itemAttCanaryPub,
          ids.mOrg,
          ids.mSharedMine,
          ids.mRecMine,
          ids.mAttCanary,
          users.other,
          users.member,
          ids.itemSeriesCrossPub,
          ids.mSeriesPrevCross,
          ids.taskCrossOrg,
        ],
      );

      await c.query(
        `INSERT INTO crove_kernel.party (org_id, id, kind, name)
         VALUES
           ($1, $3, 'organization', 'Partner Org A'),
           ($2, $4, 'organization', 'Partner Cross Org')`,
        [orgId, otherOrg, ids.partyOrg, ids.partyCrossOrg],
      );

      await c.query(
        `INSERT INTO crove_crm.pipeline_stage (org_id, id, name, kind, position)
         VALUES
           ($1, $3, 'Open', 'open', 1),
           ($2, $4, 'Open', 'open', 1)`,
        [orgId, otherOrg, ids.stageOrg, ids.stageCrossOrg],
      );

      await c.query(
        `INSERT INTO crove_crm.deal (org_id, id, party_id, title, stage_id, sort_key, created_by)
         VALUES
           ($1, $3, $4, 'Open Deal Org', $5, 'a0', $6),
           ($2, $7, $8, 'Open Deal Cross', $9, 'a0', $10)`,
        [
          orgId,
          otherOrg,
          ids.dealOrg,
          ids.partyOrg,
          ids.stageOrg,
          users.owner,
          ids.dealCrossOrg,
          ids.partyCrossOrg,
          ids.stageCrossOrg,
          users.other,
        ],
      );

      await c.query(
        `INSERT INTO crove_meetings.meeting_link (org_id, id, meeting_id, party_id, deal_id, created_by)
         VALUES
           ($1, $3, $8, NULL, $13, $15),
           ($1, $4, $9, $12, NULL, $15),
           ($1, $5, $10, NULL, $13, $16),
           ($1, $6, $11, NULL, $13, $15),
           ($2, $7, $14, NULL, $17, $15)`,
        [
          orgId,
          otherOrg,
          ids.linkOrg,
          ids.linkShared,
          ids.linkMine,
          ids.linkCanary,
          ids.linkCrossOrg,
          ids.mOrg,
          ids.mSharedMine,
          ids.mRecMine,
          ids.mAttCanary,
          ids.partyOrg,
          ids.dealOrg,
          ids.mCrossOrg,
          users.other,
          users.member,
          ids.dealCrossOrg,
        ],
      );

      await c.query(
        `INSERT INTO crove_meetings.transcript_segment
           (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage)
         VALUES
           ($1, $2, $5, 0, 10, 'Speaker 1', 'CANARY Org Transcript', 'published'),
           ($1, $3, $6, 0, 10, 'Speaker 1', 'CANARY Mine Transcript', 'published'),
           ($1, $4, $7, 0, 10, 'Speaker 1', 'CANARY Executive Transcript', 'published')`,
        [orgId, ids.segOrgPub, ids.segMinePub, ids.segCanaryPub, ids.mOrg, ids.mRecMine, ids.mAttCanary],
      );

      await c.query(
        `INSERT INTO crove_meetings.meeting_note (org_id, id, meeting_id, body)
         VALUES
           ($1, $2, $4, 'CANARY Mine Recorder Note'),
           ($1, $3, $5, 'CANARY Org Recorder Note')`,
        [orgId, ids.noteRecMine, ids.noteOrg, ids.mRecMine, ids.mOrg],
      );

      if (has.notes) {
        await c.query(
          `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body, tags)
           VALUES
             ($1, $2, $4, 'private', 'CANARY Member Private Note', 'private note body', '{}'),
             ($1, $3, $5, 'org', 'Org Shared Note', 'org note body', '{}')`,
          [orgId, ids.noteMemberPriv, ids.noteOtherOrg, users.member, users.other],
        );
      }

      await c.query(
        `INSERT INTO crove_kernel.member_vy_memory (org_id, id, member_user_id, body)
         VALUES ($1, $2, $3, 'CANARY Member Vy Memory Secret')`,
        [orgId, ids.memMember, users.member],
      );

      await c.query(
        `INSERT INTO crove_kernel.task_comment (org_id, id, task_id, body, author_type, author_id)
         VALUES ($1, $2, $3, 'CANARY Task Comment Secret', 'user', $4)`,
        [orgId, ids.taskCommentOrg, ids.taskOrg, users.member],
      );

      await c.query(
        `INSERT INTO crove_kernel.mail_message
           (org_id, id, stream, source, template_key, to_address, to_hash, subject, payload, message_id_header, status, created_by)
         VALUES
           ($1, $2, 'transactional', 'kernel.invite', 'kernel.invite', $3, crove_kernel.mail_address_hash($3), 'CANARY Mail', '{}'::jsonb, $4, 'sending', $5)`,
        [orgId, ids.mailCanary, emails.owner, `<${ids.mailCanary}@ludy.test>`, users.owner],
      );

      await c.query(
        `INSERT INTO crove_kernel.mail_event (org_id, id, message_id, provider, provider_event_id, kind, occurred_at)
         VALUES ($1, $2, $3, 'ses', 'evt-canary-1', 'delivered', now())`,
        [orgId, ids.mailEventCanary, ids.mailCanary],
      );

      await c.query(
        `INSERT INTO crove_kernel.mail_suppression (org_id, id, to_hash, scope, reason)
         VALUES ($1, $2, crove_kernel.mail_address_hash('suppressed@member-briefing.test'), 'all', 'manual')`,
        [orgId, ids.mailSuppressionCanary],
      );

      await c.query(
        `INSERT INTO crove_kernel.inbound_message (org_id, id, message_id, from_address, subject)
         VALUES ($1, $2, 'inbound-canary-1', 'sender@member-briefing.test', 'CANARY Inbound Subject')`,
        [orgId, ids.inboundCanary],
      );

      await c.query(
        `INSERT INTO crove_kernel.today_mail (org_id, id, user_id, last_sent_day, language)
         VALUES ($1, $2, $3, '2026-11-26', 'vi')`,
        [orgId, ids.todayMailCanary, users.owner],
      );

      await c.query(
        `INSERT INTO crove_kernel.agent_grant
           (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES
           ($1, $2, $3, $4, 'MCP Control', 'mcp.example.test', ARRAY['ludy.read'], $5, now(), now() + interval '1 day', $3, 'member', $3)`,
        [orgId, ids.mcpGrantOwner, users.owner, `client-${ids.mcpGrantOwner}`, `oauth-${ids.mcpGrantOwner}`],
      );

      if (has.projects) {
        await c.query(
          `INSERT INTO crove_projects.project (org_id, id, name, owner_user_id, created_by, visibility)
           VALUES ($1, $2, 'Org Project Canary', $3, $3, 'org')`,
          [orgId, ids.projectOrg, users.owner],
        );
        const projChildren = (
          await c.query<{ relname: string }>(
            `SELECT c.relname
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1
               AND c.relname IN ('project_column', 'project_member', 'project_task')`,
            [dbIds?.schema("projects") ?? "crove_projects"],
          )
        ).rows.map((r) => r.relname);
        if (projChildren.includes("project_column")) {
          await c.query(
            `INSERT INTO crove_projects.project_column (org_id, id, project_id, name, task_status, sort_key)
             VALUES ($1, $2, $3, 'Todo Column', 'todo', 'a0')`,
            [orgId, ids.projectColumnOrg, ids.projectOrg],
          );
        }
        if (projChildren.includes("project_member")) {
          await c.query(
            `INSERT INTO crove_projects.project_member (org_id, id, project_id, user_id)
             VALUES ($1, $2, $3, $4)`,
            [orgId, ids.projectMemberOrg, ids.projectOrg, users.member],
          );
        }
        if (projChildren.includes("project_task")) {
          await c.query(
            `INSERT INTO crove_projects.project_task (org_id, id, project_id, task_id, added_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [orgId, ids.projectTaskOrg, ids.projectOrg, ids.taskOrg, users.owner],
          );
        }
      }

      if (has.weeklyNoticesDue) {
        await c.query(
          `INSERT INTO crove_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language)
           VALUES ($1, $2, 480, 'UTC', 'vi')
           ON CONFLICT (org_id, user_id) DO NOTHING`,
          [otherOrg, users.other],
        );
      }
    });

    // Seed a real member_vy_result owned by users.member so non-leakage checks run against non-empty data.
    const memberRun = await liveVyRun("member");
    memberVyRunId = memberRun.runId;
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.member_vy_result
           (org_id, id, member_user_id, run_id, feature, subject_type, subject_id, status, body, tainted, private_read, expires_at)
         VALUES ($1, $2, $3, $4, 'notes.summary', 'note', $5, 'ready', 'CANARY Member Vy Result', true, true, now() + interval '30 minutes')`,
        [orgId, ids.vyResultMember, users.member, memberRun.runId, ids.noteMemberPriv],
      ),
    );

    await ensureBriefLinesSeeded();

    await upsertMorningNotice(orgId, users.member, { enabled: true, content: "full", vyLines: true });
    await upsertMorningNotice(orgId, users.twin, { enabled: true, content: "full", vyLines: true });
    await upsertMorningNotice(orgId, users.other, {
      enabled: true,
      content: "full",
      vyLines: true,
      timeZone: dueTz,
      sendMinuteSql: "(pg_catalog.date_part('hour', pg_catalog.now() AT TIME ZONE $3)::integer * 60)",
    });
    await upsertMorningNotice(orgId, users.owner, { enabled: true, content: "full", vyLines: true });
    await upsertMorningNotice(orgId, users.limited, { enabled: true, content: "full", vyLines: true });
    await upsertMorningNotice(orgId, users.viewer, { enabled: true, content: "full", vyLines: true });

    const installed = await api.runtime.execute<{
      agentId: string;
      positionId: string;
    }>(
      "kernel.agent.template.install",
      { templateKey: "finance.chief_accountant", reportsTo: null },
      {
        actor: {
          type: "user",
          userId: users.owner,
          aal: "aal2",
          sessionId: randomUUID(),
          mfaAt: Math.floor(Date.now() / 1000),
        },
        orgId,
      },
    );
    await api.runtime.execute(
      "kernel.task.create",
      { title: "Org-chart briefing baseline task", assigneePositionId: installed.positionId },
      { actor: asUser(users.owner), orgId },
    );
    const started = await worker.execute<{ runId: string | null }>(
      "kernel.agent.run.start",
      { agentId: installed.agentId },
      { actor: SYSTEM, orgId },
    );
    orgChart = { agentId: installed.agentId, runId: started.runId as string };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });

  it("keeps member_briefing primitives paired and absent before Slice A", async () => {
    expect(has.entry, "entry definer and catalog must land together").toBe(has.catalog);
    expect(has.entry, "entry definer and ctx_briefing_user_id must land together").toBe(
      has.helper,
    );
    await admin(async (c) => {
      const fnCheck = await c.query<{ exists: boolean }>(
        `SELECT to_regprocedure('crove_kernel.enter_member_briefing_context(uuid,uuid,uuid)') IS NOT NULL AS exists`,
      );
      const helperCheck = await c.query<{ exists: boolean }>(
        `SELECT to_regprocedure('crove_kernel.ctx_briefing_user_id()') IS NOT NULL AS exists`,
      );
      const tblCheck = await c.query<{ exists: boolean }>(
        `SELECT to_regclass('crove_kernel.member_briefing_table') IS NOT NULL AS exists`,
      );
      expect(fnCheck.rows[0]?.exists).toBe(has.entry);
      expect(helperCheck.rows[0]?.exists).toBe(has.helper);
      expect(tblCheck.rows[0]?.exists).toBe(has.catalog);

      if (!has.entry) {
        const procs = await c.query<{ proname: string }>(
          `SELECT p.proname
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('crove_kernel', 'ludy_kernel', 'crove_meetings', 'ludy_meetings')
             AND (p.proname LIKE '%member_briefing%' OR p.proname = 'ctx_briefing_user_id')`,
        );
        expect(procs.rows, "no member_briefing functions before Slice A").toEqual([]);
      }
    });
  });

  it("isolates calendar_agenda, private meetings, meeting_link, notes, memory, and credentials from existing contexts", async () => {
    const agendaIdsFor = (url: string, enter: (c: pg.Client) => Promise<unknown>) =>
      inContext(url, enter, async (c) => {
        const res = await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.calendar_agenda ORDER BY id`,
        );
        return res.rows.map((r) => r.id);
      });

    expect(
      await agendaIdsFor(workerUrl, systemEnter()),
      "system context reads zero calendar_agenda rows",
    ).toEqual([]);
    expect(
      await agendaIdsFor(workerUrl, agentEnter),
      "org_chart agent reads zero calendar_agenda rows",
    ).toEqual([]);
    expect(
      await agendaIdsFor(appUrl, userEnter(users.owner)),
      "owner reads only owner's own calendar_agenda rows",
    ).toEqual([ids.calAgendaOwner]);
    expect(
      await agendaIdsFor(appUrl, userEnter(users.member)),
      "member reads only member's own calendar_agenda rows",
    ).toEqual([ids.calAgendaMember]);

    const memberVyAgenda = await asVy("member", async (c) => {
      const agenda = await c.query<{ id: string }>(
        `SELECT id FROM crove_meetings.calendar_agenda ORDER BY id`,
      );
      const vyRes = await c.query<{ id: string }>(
        `SELECT id FROM crove_kernel.member_vy_result ORDER BY id`,
      );
      return {
        agenda: agenda.rows.map((r) => r.id),
        vyResults: vyRes.rows.map((r) => r.id),
      };
    });
    expect(
      memberVyAgenda.agenda,
      "member_vy calendar_agenda strictly matches member_vy_table contract",
    ).toEqual(has.memberVyHasAgenda ? [ids.calAgendaMember] : []);
    expect(
      memberVyAgenda.vyResults,
      "member_vy baseline control sees member's own member_vy_result",
    ).toContain(ids.vyResultMember);

    const viewerVyAgenda = await asVy("viewer", async (c) => {
      const res = await c.query<{ id: string }>(
        `SELECT id FROM crove_meetings.calendar_agenda ORDER BY id`,
      );
      return res.rows.map((r) => r.id);
    });
    expect(
      viewerVyAgenda,
      "viewer with vy.use and own calendar_agenda reads zero rows in member_vy",
    ).toEqual([]);

    const meetingIdsFor = (url: string, enter: (c: pg.Client) => Promise<unknown>) =>
      inContext(url, enter, async (c) => {
        const res = await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.meeting ORDER BY id`,
        );
        return res.rows.map((r) => r.id);
      });

    expect(
      await meetingIdsFor(workerUrl, systemEnter()),
      "system context reads zero meetings",
    ).toEqual([]);
    expect(
      await meetingIdsFor(workerUrl, agentEnter),
      "org_chart reads zero meetings",
    ).toEqual([]);
    expect(
      await meetingIdsFor(appUrl, userEnter(users.member)),
      "member user reads only readable meetings (never mAttCanary or mCrossOrg)",
    ).toEqual([ids.mOrg, ids.mSharedMine, ids.mRecMine].sort());
    expect(
      await meetingIdsFor(appUrl, userEnter(users.limited)),
      "entity-limited member reads zero org-wide meetings",
    ).toEqual([]);

    await inContext(appUrl, userEnter(users.limited), async (c) => {
      for (const tbl of [
        "crove_meetings.meeting_reader",
        "crove_meetings.meeting_link",
        "crove_meetings.meeting_result",
        "crove_meetings.action_item",
      ]) {
        const rows = (await c.query<{ id: string }>(`SELECT id FROM ${tbl}`)).rows;
        expect(rows, `entity-limited member reads zero rows of ${tbl}`).toEqual([]);
      }
    });

    await inContext(appUrl, userEnter(users.member), async (c) => {
      const seenLinks = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.meeting_link ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(seenLinks).toEqual([ids.linkOrg, ids.linkShared, ids.linkMine].sort());

      const seenResults = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.meeting_result ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(seenResults).not.toContain(ids.resAttCanaryPub);
      expect(seenResults).not.toContain(ids.resOrgDraft);

      const seenItems = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.action_item ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(seenItems).not.toContain(ids.itemAttCanaryPub);
      expect(seenItems).not.toContain(ids.itemOrgDraft);

      // Baseline positive controls proving seeded canary rows exist and are readable in user context.
      const seenSegs = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.transcript_segment ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(seenSegs).toEqual([ids.segOrgPub, ids.segMinePub].sort());

      const seenMeetingNotes = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.meeting_note ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(seenMeetingNotes).toEqual([ids.noteRecMine]);

      const seenComments = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_kernel.task_comment ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(seenComments).toContain(ids.taskCommentOrg);

      const memberReaders = (
        await c.query<{ meeting_id: string }>(
          `SELECT meeting_id FROM crove_meetings.meeting_reader ORDER BY meeting_id`,
        )
      ).rows.map((r) => r.meeting_id);
      expect(memberReaders).toContain(ids.mSharedMine);
      expect(memberReaders).not.toContain(ids.mAttCanary);
    });

    // Owner control proves meeting_reader row on mAttCanary exists in the DB for users.owner.
    await inContext(appUrl, userEnter(users.owner), async (c) => {
      const ownerReaders = (
        await c.query<{ meeting_id: string }>(
          `SELECT meeting_id FROM crove_meetings.meeting_reader ORDER BY meeting_id`,
        )
      ).rows.map((r) => r.meeting_id);
      expect(ownerReaders).toContain(ids.mAttCanary);
    });

    await inContext(workerUrl, systemEnter(), async (c) => {
      if (has.notes) {
        // system reads only org-shared notes for export, never member private notes.
        const sysNotes = (
          await c.query<{ id: string }>(
            `SELECT id FROM crove_notes.note ORDER BY id`,
          )
        ).rows.map((r) => r.id);
        expect(sysNotes).toEqual([ids.noteOtherOrg]);
        await expectDeniedOrEmpty(
          c,
          `SELECT id FROM crove_notes.note WHERE id = $1::uuid`,
          [ids.noteMemberPriv],
          "system read of private note",
        );
      }
      await expectDeniedOrEmpty(
        c,
        `SELECT id FROM crove_kernel.member_vy_memory`,
        [],
        "system read of member_vy_memory",
      );

      // Baseline control checks confirming mail_event, mail_suppression, inbound_message, today_mail, and ai_run hold live rows.
      expect(
        (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.mail_event`)).rows.map((r) => r.id),
      ).toContain(ids.mailEventCanary);
      expect(
        (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.mail_suppression`)).rows.map((r) => r.id),
      ).toContain(ids.mailSuppressionCanary);
      expect(
        (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.inbound_message`)).rows.map((r) => r.id),
      ).toContain(ids.inboundCanary);
      expect(
        (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.today_mail`)).rows.map((r) => r.id),
      ).toContain(ids.todayMailCanary);
      expect(
        (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.ai_run`)).rows.map((r) => r.id),
      ).toContain(orgChart.runId);

      const userAccountRes = await inSavepoint(c, "sp_user_account", () =>
        c.query(`SELECT id, email FROM crove_kernel.user_account`),
      );
      expect(
        userAccountRes,
        "crove_worker cannot select user_account",
      ).toMatchObject({ ok: false, code: "42501" });

      const hasProfilesFn =
        (
          await c.query<{ w: boolean }>(
            `SELECT to_regprocedure('crove_kernel.member_profiles(uuid[])') IS NOT NULL AS w`,
          )
        ).rows[0]?.w === true;
      if (hasProfilesFn) {
        const profilesRes = await inSavepoint(c, "sp_profiles", () =>
          c.query(`SELECT * FROM crove_kernel.member_profiles($1::uuid[])`, [
            [users.member, users.owner],
          ]),
        );
        expect(
          profilesRes,
          "crove_worker cannot execute crove_kernel.member_profiles(uuid[])",
        ).toMatchObject({ ok: false, code: "42501" });
      }
    });

    await inContext(workerUrl, agentEnter, async (c) => {
      if (has.notes) {
        await expectDeniedOrEmpty(
          c,
          `SELECT id FROM crove_notes.note WHERE id = $1::uuid`,
          [ids.noteMemberPriv],
          "org_chart read of private note",
        );
      }
      await expectDeniedOrEmpty(
        c,
        `SELECT id FROM crove_kernel.member_vy_memory`,
        [],
        "org_chart read of member_vy_memory",
      );
    });

    if (has.briefLines) {
      await inContext(appUrl, userEnter(users.member), async (c) => {
        const userLines = (
          await c.query<{ id: string }>(
            `SELECT id FROM crove_meetings.morning_brief_lines ORDER BY id`,
          )
        ).rows.map((r) => r.id);
        expect(userLines, "member user control sees own readable morning_brief_lines").toEqual([
          ids.briefLineMine,
        ]);
      });
      await inContext(workerUrl, systemEnter(), (c) =>
        expectDeniedOrEmpty(
          c,
          `SELECT id FROM crove_meetings.morning_brief_lines`,
          [],
          "system read of morning_brief_lines",
        ),
      );
      await inContext(workerUrl, agentEnter, (c) =>
        expectDeniedOrEmpty(
          c,
          `SELECT id FROM crove_meetings.morning_brief_lines`,
          [],
          "org_chart read of morning_brief_lines",
        ),
      );
      await asVy("member", (c) =>
        expectDeniedOrEmpty(
          c,
          `SELECT id FROM crove_meetings.morning_brief_lines`,
          [],
          "member_vy read of morning_brief_lines",
        ),
      );
    }

    if (has.projects) {
      await inContext(appUrl, userEnter(users.member), async (c) => {
        const seenProjects = (
          await c.query<{ id: string }>(`SELECT id FROM crove_projects.project`)
        ).rows.map((r) => r.id);
        expect(seenProjects, "user control reads org-visible project").toContain(ids.projectOrg);

        for (const [childTbl, expectedId] of [
          ["crove_projects.project_column", ids.projectColumnOrg],
          ["crove_projects.project_member", ids.projectMemberOrg],
          ["crove_projects.project_task", ids.projectTaskOrg],
        ] as const) {
          const exists =
            (
              await c.query<{ w: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS w`, [
                dbIds ? dbIds.table(childTbl) : childTbl,
              ])
            ).rows[0]?.w === true;
          if (exists) {
            const seenChild = (await c.query<{ id: string }>(`SELECT id FROM ${childTbl}`)).rows.map(
              (r) => r.id,
            );
            expect(seenChild, `user control reads org ${childTbl}`).toContain(expectedId);
          }
        }
      });
    }

    await inContext(workerUrl, systemEnter(), async (c) => {
      const dueRows = await c.query<{ org_id: string; user_id: string; events: number }>(
        `SELECT org_id, user_id, events FROM crove_meetings.morning_notices_due(20, $1::uuid, NULL, NULL)`,
        [orgId],
      );
      expect(
        dueRows.rows.some((r) => r.org_id === orgId && r.user_id === users.other && r.events > 0),
        "morning_notices_due sees due calendar event in system context",
      ).toBe(true);

      if (has.weeklyNoticesDue) {
        const weeklyRows = await c.query<{
          org_id: string;
          user_id: string;
          meetings: number;
          decisions: number;
        }>(
          `SELECT org_id, user_id, meetings, decisions
           FROM crove_meetings.weekly_notices_due(
             20,
             $1::uuid,
             NULL,
             NULL,
             ${WEEKLY_DUE_NOW_SQL}
           )`,
          [otherOrg],
        );
        expect(
          weeklyRows.rows.some(
            (r) => r.org_id === otherOrg && r.user_id === users.other && r.meetings > 0 && r.decisions > 0,
          ),
          "weekly_notices_due sees seeded otherOrg weekly notice in system context",
        ).toBe(true);
      }

      if (has.seriesNudgesDue) {
        const nudgeRows = await c.query<{
          org_id: string;
          user_id: string;
          series_id: string;
          open_count: number;
        }>(
          `SELECT org_id, user_id, series_id, open_count
           FROM crove_meetings.series_nudges_due(20, $1::uuid, NULL, NULL, NULL)`,
          [otherOrg],
        );
        expect(
          nudgeRows.rows.some(
            (r) =>
              r.org_id === otherOrg &&
              r.user_id === users.other &&
              r.series_id === ids.seriesCrossOrg &&
              r.open_count > 0,
          ),
          "series_nudges_due sees seeded otherOrg series open items in system context",
        ).toBe(true);
      }
    });
  });

  it("enforces Slice A worker-only entry, ctx_briefing_user_id isolation, full re-checks, and R0 seal shape", async () => {
    if (!has.entry) {
      expect(has.entry).toBe(false);
      expect(has.helper).toBe(false);
      expect(has.catalog).toBe(false);
      return;
    }

    expect(has.helper, "Slice A requires ctx_briefing_user_id()").toBe(true);
    expect(has.noticeEnabled, "Slice A requires morning_notice.enabled").toBe(true);
    expect(has.noticeContent, "Slice A requires morning_notice.content").toBe(true);
    expect(has.briefLines, "Slice A requires morning_brief_lines table").toBe(true);

    await admin(async (c) => {
      if (!dbIds) throw new Error("dbIds not resolved");
      const idsHelper = dbIds;
      const procMeta = await c.query<{
        prosecdef: boolean;
        proconfig: string[] | null;
      }>(
        `SELECT prosecdef, proconfig
         FROM pg_proc
         WHERE oid = to_regprocedure('crove_kernel.enter_member_briefing_context(uuid,uuid,uuid)')`,
      );
      expect(procMeta.rows[0]?.prosecdef, "entry must be SECURITY DEFINER").toBe(
        true,
      );
      expect(
        procMeta.rows[0]?.proconfig ?? [],
        "entry must pin search_path",
      ).toContain("search_path=pg_catalog, pg_temp");

      const execAudit = await auditRoleFunctionExecute(
        c,
        idsHelper,
        ENTRY_FN,
        ["crove_worker"],
        "non_system",
      );
      for (const row of execAudit.rows) {
        expect(row.ok, `role ${row.rolname} EXECUTE expectation`).toBe(
          row.expected,
        );
      }
      expect(execAudit.activeAllowed).toEqual([idsHelper.roleName("crove_worker")]);
      const entryPub = await c.query<{ ok: boolean }>(
        `SELECT has_function_privilege('public', 'crove_kernel.enter_member_briefing_context(uuid,uuid,uuid)'::regprocedure, 'EXECUTE') AS ok`,
      );
      expect(entryPub.rows[0]?.ok, "PUBLIC has zero EXECUTE on entry definer").toBe(false);

      // ctx_briefing_user_id() must be STABLE ('s'), pin search_path, revoke PUBLIC, and match ctx_mcp_member_id() EXECUTE scope.
      const helperMeta = await c.query<{
        provolatile: string;
        proconfig: string[] | null;
      }>(
        `SELECT provolatile::text, proconfig FROM pg_proc WHERE oid = to_regprocedure('crove_kernel.ctx_briefing_user_id()')`,
      );
      expect(
        helperMeta.rows[0]?.provolatile,
        "ctx_briefing_user_id must be STABLE ('s')",
      ).toBe("s");
      expect(
        helperMeta.rows[0]?.proconfig ?? [],
        "ctx_briefing_user_id must pin search_path",
      ).toContain("search_path=pg_catalog, pg_temp");

      const helperPub = await c.query<{ ok: boolean }>(
        `SELECT has_function_privilege('public', 'crove_kernel.ctx_briefing_user_id()'::regprocedure, 'EXECUTE') AS ok`,
      );
      expect(helperPub.rows[0]?.ok, "PUBLIC has zero EXECUTE on ctx_briefing_user_id").toBe(false);

      const helperRoles = await c.query<{
        rolname: string;
        actual: boolean;
        expected: boolean;
      }>(
        `SELECT r.rolname,
                pg_catalog.has_function_privilege(r.oid, to_regprocedure('crove_kernel.ctx_briefing_user_id()'), 'EXECUTE') AS actual,
                pg_catalog.has_function_privilege(r.oid, to_regprocedure('crove_kernel.ctx_mcp_member_id()'), 'EXECUTE') AS expected
         FROM pg_catalog.pg_roles r
         WHERE NOT r.rolsuper
           AND r.rolname NOT LIKE 'pg\\_%'
           AND r.rolname NOT LIKE '%\\_test\\_%'
           AND r.rolname NOT LIKE 'crove\\_test%'
           AND r.rolname NOT LIKE 'ludy\\_test%'
           AND r.rolname <> 'ludy_migrate_test'`,
      );
      for (const row of helperRoles.rows) {
        expect(row.actual, `${HELPER_FN} EXECUTE matches tenant helper scope for ${row.rolname}`).toBe(
          row.expected,
        );
      }
    });

    // ctx_briefing_user_id() returns NULL outside member_briefing (user, system, org_chart, member_vy).
    for (const [why, url, enter] of [
      ["user context", appUrl, userEnter(users.member)],
      ["system context", workerUrl, systemEnter()],
      ["org_chart context", workerUrl, agentEnter],
    ] as const) {
      const val = await inContext(
        url,
        enter,
        async (c) =>
          (
            await c.query<{ u: string | null }>(
              `SELECT crove_kernel.ctx_briefing_user_id() AS u`,
            )
          ).rows[0]?.u ?? null,
      );
      expect(val, `${HELPER_FN} must return NULL in ${why}`).toBeNull();
    }
    const helperInVy = await asVy(
      "member",
      async (c) =>
        (
          await c.query<{ u: string | null }>(
            `SELECT crove_kernel.ctx_briefing_user_id() AS u`,
          )
        ).rows[0]?.u ?? null,
    );
    expect(helperInVy, `${HELPER_FN} must return NULL in member_vy`).toBeNull();

    const helperInMcp = await inContext(
      appUrl,
      (c) =>
        c.query(`SELECT crove_kernel.enter_mcp_member_context($1::uuid, $2::uuid)`, [
          orgId,
          ids.mcpGrantOwner,
        ]),
      async (c) =>
        (
          await c.query<{ u: string | null }>(
            `SELECT crove_kernel.ctx_briefing_user_id() AS u`,
          )
        ).rows[0]?.u ?? null,
    );
    expect(helperInMcp, `${HELPER_FN} must return NULL in mcp_member`).toBeNull();

    // Real system-enqueued morning notice mails have created_by = null and immutable source_id = recipient user_id.
    const validMailId = await seedMorningMail({
      toAddress: emails.member,
      sourceId: users.member,
      createdBy: null,
      status: "queued",
    });

    // Entry from crove_app is refused (worker only), both by EXECUTE grant and internal session_user guard.
    const appAttempt = await outcome(
      inContext(appUrl, briefingEnter(orgId, users.member, validMailId), () =>
        Promise.resolve("ok"),
      ),
    );
    expect(appAttempt, "crove_app cannot call enter_member_briefing_context").toMatchObject({
      ok: false,
      code: "42501",
    });

    await admin((c) =>
      c.query(`GRANT EXECUTE ON FUNCTION crove_kernel.enter_member_briefing_context(uuid,uuid,uuid) TO crove_app`),
    );
    try {
      const innerSessionGuard = await outcome(
        inContext(appUrl, briefingEnter(orgId, users.member, validMailId), () =>
          Promise.resolve("ok"),
        ),
      );
      expect(
        innerSessionGuard,
        "internal session_user check refuses non-worker even when EXECUTE is granted",
      ).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await admin((c) =>
        c.query(`REVOKE EXECUTE ON FUNCTION crove_kernel.enter_member_briefing_context(uuid,uuid,uuid) FROM crove_app`),
      );
    }

    // Re-entry guard: refuses calls inside an already-sealed context.
    for (const [why, enter] of [
      ["system context", systemEnter()],
      ["org_chart agent context", agentEnter],
      ["nested member_briefing context", briefingEnter(orgId, users.member, validMailId)],
    ] as const) {
      const nested = await outcome(
        inContext(workerUrl, enter, (c) => briefingEnter(orgId, users.member, validMailId)(c)),
      );
      expect(nested, `re-entry refused inside ${why}`).toMatchObject({
        ok: false,
        code: "42501",
      });
    }
    const nestedVy = await outcome(
      asVy("member", (c) => briefingEnter(orgId, users.member, validMailId)(c)),
    );
    expect(nestedVy, "re-entry refused inside member_vy context").toMatchObject({
      ok: false,
      code: "42501",
    });

    // Positive entry inside BEGIN READ ONLY + helper & seal verification.
    const userSeal = await inContext(appUrl, userEnter(users.member), (c) =>
      sealOf(c),
    );
    const briefingSeal = await inContext(
      workerUrl,
      briefingEnter(orgId, users.member, validMailId),
      async (c) => {
        const helpers = (
          await c.query<{ briefing: string | null; acting: string | null }>(
            `SELECT crove_kernel.ctx_briefing_user_id() AS briefing,
                    crove_kernel.ctx_acting_user_id() AS acting`,
          )
        ).rows[0];
        expect(helpers?.briefing, "ctx_briefing_user_id matches target member").toBe(
          users.member,
        );
        expect(helpers?.acting, "ctx_acting_user_id stays NULL in member_briefing").toBeNull();
        return sealOf(c);
      },
      { readOnly: true },
    );
    expect(briefingSeal).toMatchObject({
      actor: "agent",
      org: orgId,
      user: null,
      kind: "member_briefing",
      member: users.member,
      max_risk: "R0",
      tainted: true,
      position: null,
      role: userSeal.role,
      le_scope: userSeal.le_scope,
    });
    expect(
      typeof briefingSeal.agent === "string" && briefingSeal.agent.length > 0,
      "member_briefing seal sets non-empty agent identifier",
    ).toBe(true);

    // Entry also succeeds when mail_message status is 'sending'.
    const sendingMailId = await seedMorningMail({
      toAddress: emails.member,
      sourceId: users.member,
      createdBy: null,
      status: "sending",
    });
    const sendingResult = await outcome(
      inContext(
        workerUrl,
        briefingEnter(orgId, users.member, sendingMailId),
        (c) => sealOf(c),
        { readOnly: true },
      ),
    );
    expect(sendingResult.ok, "status = 'sending' allows entry").toBe(true);

    // Entity-scoped member seal matches user role and le_scope ([branch]).
    const limitedMailId = await seedMorningMail({
      toAddress: emails.limited,
      sourceId: users.limited,
      createdBy: null,
      status: "queued",
    });
    const limitedUserSeal = await inContext(appUrl, userEnter(users.limited), (c) =>
      sealOf(c),
    );
    const limitedBriefingSeal = await inContext(
      workerUrl,
      briefingEnter(orgId, users.limited, limitedMailId),
      (c) => sealOf(c),
      { readOnly: true },
    );
    expect(limitedBriefingSeal).toMatchObject({
      kind: "member_briefing",
      member: users.limited,
      role: limitedUserSeal.role,
      le_scope: limitedUserSeal.le_scope,
      max_risk: "R0",
    });

    // Negative entry checks: users.other ALSO has enabled=true/content='full' in orgId,
    // and users.twin shares emails.member with enabled=true/content='full', isolating source_id binding.
    const wrongSourceMail = await seedMorningMail({
      toAddress: emails.member,
      sourceId: users.member,
      createdBy: null,
      source: "kernel.invite",
    });
    const nullSourceIdMail = await seedMorningMail({
      toAddress: emails.member,
      sourceId: null,
      createdBy: null,
      status: "queued",
    });
    const expiredMail = await seedMorningMail({
      toAddress: emails.member,
      sourceId: users.member,
      createdBy: null,
      ageInterval: "37 hours",
    });
    const suppressedMail = await seedMorningMail({
      toAddress: emails.member,
      sourceId: users.member,
      createdBy: null,
      status: "suppressed",
    });
    const sentMail = await seedMorningMail({
      toAddress: emails.member,
      sourceId: users.member,
      createdBy: null,
      status: "sending",
    });
    await admin((c) =>
      c.query(
        `UPDATE crove_kernel.mail_message SET status = 'sent', sent_at = now()
         WHERE org_id = $1 AND id = $2`,
        [orgId, sentMail],
      ),
    );
    const failedMail = await seedMorningMail({
      toAddress: emails.member,
      sourceId: users.member,
      createdBy: null,
      status: "sending",
    });
    await admin((c) =>
      c.query(
        `UPDATE crove_kernel.mail_message SET status = 'failed', error_code = 'SMTP_ERR'
         WHERE org_id = $1 AND id = $2`,
        [orgId, failedMail],
      ),
    );
    const nullAddressMail = await seedMorningMail({
      toAddress: emails.member,
      sourceId: users.member,
      createdBy: null,
      status: "queued",
    });
    await admin((c) =>
      c.query(
        `UPDATE crove_kernel.mail_message SET to_address = NULL WHERE org_id = $1 AND id = $2`,
        [orgId, nullAddressMail],
      ),
    );
    const staleAddressSameSourceMail = await seedMorningMail({
      toAddress: "stale-address@member-briefing.test",
      sourceId: users.member,
      createdBy: null,
      status: "queued",
    });
    const otherOrgMail = await seedMorningMail({
      org: otherOrg,
      toAddress: emails.other,
      sourceId: users.other,
      createdBy: null,
    });
    const viewerMail = await seedMorningMail({
      toAddress: emails.viewer,
      sourceId: users.viewer,
      createdBy: null,
    });

    for (const readOnly of [false, true] as const) {
      for (const [why, targetOrg, targetUser, targetMail] of [
        ["wrong org for valid mail", otherOrg, users.member, validMailId],
        ["cross-org mail passed with orgId", orgId, users.other, otherOrgMail],
        ["wrong member_user_id even when opted-in", orgId, users.other, validMailId],
        ["shared email collision refused via source_id", orgId, users.twin, validMailId],
        ["null source_id mail refused", orgId, users.member, nullSourceIdMail],
        ["stale to_address despite matching source_id", orgId, users.member, staleAddressSameSourceMail],
        ["unknown mail_id", orgId, users.member, randomUUID()],
        ["wrong mail source", orgId, users.member, wrongSourceMail],
        ["expired mail (>36h)", orgId, users.member, expiredMail],
        ["suppressed mail status", orgId, users.member, suppressedMail],
        ["already sent mail status", orgId, users.member, sentMail],
        ["failed mail status", orgId, users.member, failedMail],
        ["purged null to_address on mail", orgId, users.member, nullAddressMail],
        ["viewer role cannot enter member_briefing", orgId, users.viewer, viewerMail],
      ] as const) {
        const res = await outcome(
          inContext(
            workerUrl,
            briefingEnter(targetOrg, targetUser, targetMail),
            () => Promise.resolve("entered"),
            { readOnly },
          ),
        );
        expect(res, `${why} (readOnly=${String(readOnly)})`).toMatchObject({
          ok: false,
          code: "42501",
        });
      }
    }

    const refusedAfterMutation = async (
      why: string,
      apply: () => Promise<unknown>,
      undo: () => Promise<unknown>,
    ) => {
      await apply();
      try {
        for (const readOnly of [false, true] as const) {
          const res = await outcome(
            inContext(
              workerUrl,
              briefingEnter(orgId, users.member, validMailId),
              () => Promise.resolve("entered"),
              { readOnly },
            ),
          );
          expect(res, `${why} (readOnly=${String(readOnly)})`).toMatchObject({
            ok: false,
            code: "42501",
          });
        }
      } finally {
        await undo();
      }
      // Verify restoration succeeded so subsequent checks fail only on their own condition.
      const restored = await outcome(
        inContext(
          workerUrl,
          briefingEnter(orgId, users.member, validMailId),
          () => Promise.resolve("restored"),
          { readOnly: true },
        ),
      );
      expect(restored.ok, `state restored after: ${why}`).toBe(true);
    };

    const runWithReplicaRole = (sql: string, params: unknown[]) =>
      admin(async (c) => {
        await c.query("BEGIN");
        try {
          await c.query("SET LOCAL session_replication_role = replica");
          await c.query(sql, params);
          await c.query("COMMIT");
        } catch (err) {
          await c.query("ROLLBACK").catch(() => {});
          throw err;
        }
      });

    await refusedAfterMutation(
      "morning_notice content = 'count' is refused",
      () =>
        admin((c) =>
          c.query(
            `UPDATE crove_meetings.morning_notice SET content = 'count' WHERE org_id = $1 AND user_id = $2`,
            [orgId, users.member],
          ),
        ),
      () =>
        admin((c) =>
          c.query(
            `UPDATE crove_meetings.morning_notice SET content = 'full' WHERE org_id = $1 AND user_id = $2`,
            [orgId, users.member],
          ),
        ),
    );

    await refusedAfterMutation(
      "member email changed after mail enqueue (source_id still matches) is refused",
      () =>
        admin((c) =>
          c.query(`UPDATE crove_kernel.user_account SET email = $1 WHERE id = $2`, [
            "renamed-member@member-briefing.test",
            users.member,
          ]),
        ),
      () =>
        admin((c) =>
          c.query(`UPDATE crove_kernel.user_account SET email = $1 WHERE id = $2`, [
            emails.member,
            users.member,
          ]),
        ),
    );

    await refusedAfterMutation(
      "morning_notice enabled = false is refused",
      () =>
        admin((c) =>
          c.query(
            `UPDATE crove_meetings.morning_notice SET enabled = false WHERE org_id = $1 AND user_id = $2`,
            [orgId, users.member],
          ),
        ),
      () =>
        admin((c) =>
          c.query(
            `UPDATE crove_meetings.morning_notice SET enabled = true WHERE org_id = $1 AND user_id = $2`,
            [orgId, users.member],
          ),
        ),
    );

    await refusedAfterMutation(
      "missing morning_notice is refused",
      () =>
        admin((c) =>
          c.query(
            `DELETE FROM crove_meetings.morning_notice WHERE org_id = $1 AND user_id = $2`,
            [orgId, users.member],
          ),
        ),
      () => upsertMorningNotice(orgId, users.member, { enabled: true, content: "full", vyLines: true }),
    );

    // Bypass tenant_member_drops_morning_notice via replica role so morning_notice stays present and missing membership itself is isolated.
    await refusedAfterMutation(
      "removed member is refused even while morning_notice remains",
      async () => {
        await runWithReplicaRole(
          `DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`,
          [orgId, users.member],
        );
        const noticeStillThere = await admin(
          async (c) =>
            (
              await c.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM crove_meetings.morning_notice WHERE org_id = $1 AND user_id = $2`,
                [orgId, users.member],
              )
            ).rows[0]?.n ?? 0,
        );
        expect(noticeStillThere, "morning_notice stayed intact during member check").toBe(1);
      },
      async () => {
        await admin((c) =>
          c.query(
            `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`,
            [orgId, users.member],
          ),
        );
        await upsertMorningNotice(orgId, users.member, { enabled: true, content: "full", vyLines: true });
      },
    );

    // Concurrent FOR SHARE lock check: writable entry locks tenant_member so a second tx hits 55P03.
    const holder = createDbClient({ connectionString: workerUrl }, dbIds);
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await briefingEnter(orgId, users.member, validMailId)(holder);
      for (const [why, lockSql] of [
        [
          "demoting member role",
          `UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`,
        ],
        [
          "deleting member row",
          `DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`,
        ],
      ] as const) {
        const blocked = await outcome(
          admin(async (c) => {
            await c.query("BEGIN");
            try {
              await c.query("SET LOCAL lock_timeout = '50ms'");
              await c.query(lockSql, [orgId, users.member]);
            } finally {
              await c.query("ROLLBACK").catch(() => {});
            }
          }),
        );
        expect(blocked, `${why} waits on tenant_member FOR SHARE lock (55P03)`).toMatchObject({
          ok: false,
          code: "55P03",
        });
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }

    await refusedAfterMutation(
      "disabled user_account is refused",
      () =>
        admin((c) =>
          c.query(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1`, [
            users.member,
          ]),
        ),
      () =>
        admin((c) =>
          c.query(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [
            users.member,
          ]),
        ),
    );

    await refusedAfterMutation(
      "closed org is refused",
      () =>
        runWithReplicaRole(`UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`, [
          orgId,
        ]),
      () =>
        runWithReplicaRole(`UPDATE crove_kernel.tenant SET status = 'active' WHERE org_id = $1`, [
          orgId,
        ]),
    );

    await refusedAfterMutation(
      "offboarding org is refused",
      () =>
        runWithReplicaRole(
          `UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`,
          [orgId],
        ),
      () =>
        runWithReplicaRole(`UPDATE crove_kernel.tenant SET status = 'active' WHERE org_id = $1`, [
          orgId,
        ]),
    );

    await refusedAfterMutation(
      "disabled meetings module in apps_off is refused",
      () =>
        runWithReplicaRole(
          `UPDATE crove_kernel.tenant SET apps_off = array_append(apps_off, 'meetings') WHERE org_id = $1`,
          [orgId],
        ),
      () =>
        runWithReplicaRole(
          `UPDATE crove_kernel.tenant SET apps_off = array_remove(apps_off, 'meetings') WHERE org_id = $1`,
          [orgId],
        ),
    );
  });

  it("keeps member_briefing_table migration-only, read-only, allowlisted, and bidirectionally synced with ctx_briefing_user_id policies", async () => {
    if (!has.catalog) {
      expect(has.entry).toBe(false);
      expect(has.helper).toBe(false);
      expect(has.catalog).toBe(false);
      return;
    }

    await admin(async (c) => {
      if (!dbIds) throw new Error("dbIds not resolved");
      const idsHelper = dbIds;

      const privAudit = await auditRoleTablePrivileges(c, idsHelper, CATALOG_TABLE, [
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
      ]);
      for (const row of privAudit) {
        expect(
          row.ok,
          `role ${row.rolname} must not have ${row.privilege} on member_briefing_table`,
        ).toBe(false);
      }

      const extraWritePrivs = await c.query<{ r: string; p: string }>(
        `SELECT role_name AS r, priv AS p FROM (
           SELECT 'public'::text AS role_name, p AS priv,
                  (pg_catalog.has_table_privilege('public', 'crove_kernel.member_briefing_table', p)
                   OR (p IN ('INSERT', 'UPDATE') AND pg_catalog.has_any_column_privilege('public', 'crove_kernel.member_briefing_table', p))) AS ok
           FROM pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
           UNION ALL
           SELECT r.rolname AS role_name, p AS priv,
                  (pg_catalog.has_table_privilege(r.oid, cls.oid, p)
                   OR (p IN ('INSERT', 'UPDATE') AND pg_catalog.has_any_column_privilege(r.oid, cls.oid, p))) AS ok
           FROM pg_catalog.pg_roles r
           CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
           CROSS JOIN (SELECT oid, relowner FROM pg_catalog.pg_class WHERE oid = 'crove_kernel.member_briefing_table'::regclass) AS cls
           WHERE NOT r.rolsuper
             AND r.oid <> cls.relowner
             AND r.rolname NOT LIKE 'pg\\_%'
             AND r.rolname NOT LIKE '%\\_test\\_%'
             AND r.rolname NOT LIKE 'crove\\_test%'
             AND r.rolname NOT LIKE 'ludy\\_test%'
             AND r.rolname <> 'ludy_migrate_test'
         ) s WHERE s.ok`,
      );
      expect(
        extraWritePrivs.rows,
        "PUBLIC and all non-system non-owner roles must have zero write table/column privileges on member_briefing_table",
      ).toEqual([]);

      // Verify via pg_class.relacl (aclexplode grantee = 0) so any PUBLIC privilege, including SELECT, is caught.
      const publicPrivs = await c.query<{ privilege_type: string }>(
        `SELECT a.privilege_type
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
         WHERE n.nspname = $1
           AND c.relname = 'member_briefing_table'
           AND a.grantee = 0`,
        [idsHelper.schema("kernel")],
      );
      expect(publicPrivs.rows, "PUBLIC has zero grants on member_briefing_table").toEqual(
        [],
      );

      const rows = await c.query<{ table_name: string; mode: string }>(
        `SELECT table_name, mode FROM crove_kernel.member_briefing_table ORDER BY table_name`,
      );
      expect(rows.rows.length).toBeGreaterThan(0);

      const cataloged = new Set<string>();
      const lookupTables: string[] = [];

      for (const row of rows.rows) {
        expect(row.mode, `${row.table_name} must be mode = 'read'`).toBe("read");
        const canonical = idsHelper.toCanonicalTable(row.table_name);
        cataloged.add(canonical);

        expect(
          FORBIDDEN_BRIEFING_TABLES.has(canonical),
          `${canonical} must never enter member_briefing_table`,
        ).toBe(false);
        for (const prefix of FORBIDDEN_BRIEFING_PREFIXES) {
          expect(
            canonical.startsWith(prefix),
            `${canonical} must not belong to forbidden schema ${prefix}`,
          ).toBe(false);
        }

        if (canonical.startsWith("crove_meetings.")) {
          expect(
            ALLOWED_MEETINGS_TABLES.has(canonical),
            `unexpected meetings table ${canonical} in member_briefing_table`,
          ).toBe(true);
        } else {
          lookupTables.push(canonical);
          const branded = idsHelper.table(canonical);
          const dot = branded.indexOf(".");
          const schemaName = branded.slice(0, dot);
          const tableName = branded.slice(dot + 1);
          const cols = await c.query<{ column_name: string }>(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2`,
            [schemaName, tableName],
          );
          expect(
            cols.rows.length,
            `cataloged lookup ${canonical} must expose columns in information_schema`,
          ).toBeGreaterThan(0);
          for (const col of cols.rows) {
            expect(
              ALLOWED_LOOKUP_COLUMNS.has(col.column_name),
              `cataloged lookup ${canonical}.${col.column_name} exceeds narrow display-name allowlist`,
            ).toBe(true);
          }

          const relMeta = await c.query<{
            relkind: string;
            relrowsecurity: boolean;
            relforcerowsecurity: boolean;
            reloptions: string[] | null;
          }>(
            `SELECT c.relkind::text, c.relrowsecurity, c.relforcerowsecurity, c.reloptions
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2`,
            [schemaName, tableName],
          );
          const meta = relMeta.rows[0];
          expect(meta, `lookup ${canonical} must exist in pg_class`).toBeDefined();
          if (meta?.relkind === "v") {
            const viewDef = (
              await c.query<{ d: string }>(`SELECT pg_catalog.pg_get_viewdef($1::regclass, true) AS d`, [
                branded,
              ])
            ).rows[0]?.d ?? "";
            const hasInvoker = (meta.reloptions ?? []).includes("security_invoker=true");
            if (!hasInvoker) {
              expect(
                meta.reloptions ?? [],
                `non-invoker lookup view ${canonical} must set security_barrier=true`,
              ).toContain("security_barrier=true");
              expect(
                viewDef,
                `lookup view ${canonical} must bind ctx_org_id and ctx_briefing_user_id`,
              ).toMatch(/ctx_org_id[\s\S]*ctx_briefing_user_id|ctx_briefing_user_id[\s\S]*ctx_org_id/i);
            }
          } else {
            expect(meta).toMatchObject({
              relrowsecurity: true,
              relforcerowsecurity: true,
            });
          }
        }
      }

      expect(
        lookupTables.length,
        "at most one narrow non-meetings display-name lookup table/view may be cataloged",
      ).toBeLessThanOrEqual(1);

      for (const required of REQUIRED_BRIEFING_TABLES) {
        expect(
          cataloged.has(required),
          `member_briefing_table must include ${required}`,
        ).toBe(true);
      }

      // TRUNCATE bypasses RLS and row triggers in PostgreSQL; PUBLIC and all non-system non-owner roles
      // must hold zero TRUNCATE privileges on every briefing table and protected sensitive/write-guarded table.
      const truncateTargets = [
        ...REQUIRED_BRIEFING_TABLES,
        ...lookupTables,
        "crove_kernel.ai_run",
        "crove_kernel.agent_wakeup",
        "crove_kernel.audit_event",
        "crove_kernel.outbox_pending",
        "crove_kernel.refusal_tally",
        "crove_kernel.task",
        "crove_kernel.task_comment",
        "crove_kernel.mail_message",
        "crove_kernel.mail_event",
        "crove_kernel.mail_suppression",
        "crove_kernel.inbound_message",
        "crove_kernel.today_mail",
        "crove_kernel.activity",
        "crove_kernel.proposal",
        "crove_kernel.notification",
        "crove_kernel.idempotency_key",
        "crove_kernel.member_vy_memory",
        "crove_kernel.member_vy_result",
        "crove_kernel.party",
        "crove_crm.deal",
        "crove_notes.note",
        "crove_projects.project",
        "crove_projects.project_column",
        "crove_projects.project_member",
        "crove_projects.project_task",
      ].map((tbl) => idsHelper.table(tbl));
      const truncatePrivs = await c.query<{ tbl: string; r: string }>(
        `WITH targets AS (
           SELECT c.oid, n.nspname || '.' || c.relname AS tbl, c.relowner
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.oid = ANY(ARRAY(
             SELECT pg_catalog.to_regclass(t) FROM pg_catalog.unnest($1::text[]) AS t
           ))
             AND c.relkind IN ('r', 'p')
         )
         SELECT t.tbl, s.role_name AS r
         FROM targets t
         CROSS JOIN LATERAL (
           SELECT 'public'::text AS role_name,
                  pg_catalog.has_table_privilege('public', t.oid, 'TRUNCATE') AS ok
           UNION ALL
           SELECT r.rolname AS role_name,
                  pg_catalog.has_table_privilege(r.oid, t.oid, 'TRUNCATE') AS ok
           FROM pg_catalog.pg_roles r
           WHERE NOT r.rolsuper
             AND r.oid <> t.relowner
             AND r.rolname NOT LIKE 'pg\\_%'
             AND r.rolname NOT LIKE '%\\_test\\_%'
             AND r.rolname NOT LIKE 'crove\\_test%'
             AND r.rolname NOT LIKE 'ludy\\_test%'
             AND r.rolname <> 'ludy_migrate_test'
         ) s
         WHERE s.ok
         ORDER BY t.tbl, s.role_name`,
        [truncateTargets],
      );
      expect(
        truncatePrivs.rows,
        "PUBLIC and all non-system non-owner roles must have zero TRUNCATE privileges on protected tables",
      ).toEqual([]);

      // morning_brief_lines must enforce forced RLS.
      const briefRls = await c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = 'morning_brief_lines'`,
        [idsHelper.schema("meetings")],
      );
      expect(briefRls.rows[0]).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });

      // Bidirectional pg_policy + pg_depend audit on ctx_briefing_user_id() (tracks wrapper functions and views,
      // mirroring member-vy-background.db.test.ts).
      const stripComments = (sql: string): string => {
        let out = "";
        for (let i = 0; i < sql.length; ) {
          const ch = sql[i];
          if (ch === "-" && sql[i + 1] === "-") {
            const nl = sql.indexOf("\n", i + 2);
            i = nl === -1 ? sql.length : nl + 1;
            continue;
          }
          if (ch === "/" && sql[i + 1] === "*") {
            let depth = 1;
            let j = i + 2;
            while (j < sql.length && depth > 0) {
              if (sql[j] === "/" && sql[j + 1] === "*") {
                depth++;
                j += 2;
              } else if (sql[j] === "*" && sql[j + 1] === "/") {
                depth--;
                j += 2;
              } else {
                j++;
              }
            }
            out += " ";
            i = j;
            continue;
          }
          if (ch === "'" || ch === '"') {
            let j = i + 1;
            while (j < sql.length) {
              if (sql[j] === ch) {
                if (sql[j + 1] === ch) {
                  j += 2;
                  continue;
                }
                j++;
                break;
              }
              j++;
            }
            out += sql.slice(i, j);
            i = j;
            continue;
          }
          if (ch === "$") {
            const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
            if (tagMatch) {
              const tag = tagMatch[0];
              const endIdx = sql.indexOf(tag, i + tag.length);
              if (endIdx !== -1) {
                out += sql.slice(i, endIdx + tag.length);
                i = endIdx + tag.length;
                continue;
              }
            }
          }
          out += ch;
          i++;
        }
        return out;
      };
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const fnCall = (qualified: string) => {
        const dot = qualified.indexOf(".");
        const sch = dot === -1 ? "" : qualified.slice(0, dot);
        const fn = dot === -1 ? qualified : qualified.slice(dot + 1);
        const prefix = sch ? `(?:"?${esc(sch)}"?\\s*\\.\\s*)?` : "";
        return new RegExp(`(?:^|[^a-z0-9_."])(${prefix}"?${esc(fn)}"?)\\s*\\(`, "i");
      };
      const viewRef = (qualified: string) => {
        const dot = qualified.indexOf(".");
        const sch = dot === -1 ? "" : qualified.slice(0, dot);
        const rel = dot === -1 ? qualified : qualified.slice(dot + 1);
        const bare = sch ? `"?${esc(sch)}"?\\s*\\.\\s*"?${esc(rel)}"?(?![a-z0-9_"])` : `"?${esc(rel)}"?(?![a-z0-9_"])`;
        return new RegExp(`(?:^|[^a-z0-9_."])(?:${bare})|\\b(?:FROM|JOIN|TABLE)\\b\\s*(?:ONLY\\s+)?\\(?\\s*"?${esc(rel)}"?(?![a-z0-9_"])`, "i");
      };

      const ctxHelperOid =
        (
          await c.query<{ oid: string | null }>(
            `SELECT to_regprocedure('crove_kernel.ctx_briefing_user_id()')::oid::text AS oid`,
          )
        ).rows[0]?.oid ?? null;
      expect(ctxHelperOid, "ctx_briefing_user_id() OID must resolve").not.toBeNull();

      const [procRows, procDepRows, viewRows, viewDepRows, polRows, polDepRows] = await Promise.all([
        c.query<{ oid: string; name: string; body: string }>(
          `SELECT p.oid::text AS oid,
                  n.nspname || '.' || p.proname AS name,
                  CASE WHEN p.prosqlbody IS NULL THEN coalesce(p.prosrc, '')
                       ELSE pg_catalog.pg_get_functiondef(p.oid) END AS body
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND p.prokind IN ('f', 'p')`,
        ),
        c.query<{ proc_oid: string; ref_oid: string }>(
          `SELECT DISTINCT d.objid::text AS proc_oid, d.refobjid::text AS ref_oid
           FROM pg_catalog.pg_depend d
           JOIN pg_catalog.pg_proc p ON p.oid = d.objid
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE d.classid = 'pg_catalog.pg_proc'::regclass
             AND d.refclassid = 'pg_catalog.pg_proc'::regclass
             AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`,
        ),
        c.query<{ oid: string; name: string; def: string }>(
          `SELECT v.oid::text AS oid, n.nspname || '.' || v.relname AS name, pg_catalog.pg_get_viewdef(v.oid) AS def
           FROM pg_catalog.pg_class v
           JOIN pg_catalog.pg_namespace n ON n.oid = v.relnamespace
           WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND v.relkind IN ('v', 'm')`,
        ),
        c.query<{ view_oid: string; refclass: string; ref_oid: string }>(
          `SELECT DISTINCT rw.ev_class::text AS view_oid,
                  CASE WHEN d.refclassid = 'pg_catalog.pg_class'::regclass THEN 'pg_class' ELSE 'pg_proc' END AS refclass,
                  d.refobjid::text AS ref_oid
           FROM pg_catalog.pg_rewrite rw
           JOIN pg_catalog.pg_class v ON v.oid = rw.ev_class
           JOIN pg_catalog.pg_namespace n ON n.oid = v.relnamespace
           JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = rw.oid
           WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND v.relkind IN ('v', 'm')
             AND d.refclassid IN ('pg_catalog.pg_class'::regclass, 'pg_catalog.pg_proc'::regclass)
             AND NOT (d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = rw.ev_class)`,
        ),
        c.query<{ oid: string; t: string; cmd: string }>(
          `SELECT p.oid::text AS oid, n.nspname || '.' || r.relname AS t, p.polcmd::text AS cmd
           FROM pg_catalog.pg_policy p
           JOIN pg_catalog.pg_class r ON r.oid = p.polrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
           WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`,
        ),
        c.query<{ pol_oid: string; refclass: string; ref_oid: string }>(
          `SELECT DISTINCT p.oid::text AS pol_oid,
                  CASE WHEN d.refclassid = 'pg_catalog.pg_class'::regclass THEN 'pg_class' ELSE 'pg_proc' END AS refclass,
                  d.refobjid::text AS ref_oid
           FROM pg_catalog.pg_policy p
           JOIN pg_catalog.pg_class r ON r.oid = p.polrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
           JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_policy'::regclass AND d.objid = p.oid
           WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
             AND d.refclassid IN ('pg_catalog.pg_class'::regclass, 'pg_catalog.pg_proc'::regclass)
             AND NOT (d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = p.polrelid)`,
        ),
      ]);

      const procs = procRows.rows.map((p) => ({ ...p, cleanBody: stripComments(p.body) }));
      const procByOid = new Map(procs.map((p) => [p.oid, p]));
      const viewByOid = new Map(viewRows.rows.map((v) => [v.oid, v]));
      const taintedProcs = new Set<string>(ctxHelperOid ? [ctxHelperOid] : []);
      const taintedViews = new Set<string>();

      let changed = true;
      while (changed) {
        changed = false;
        for (const d of procDepRows.rows) {
          if (!taintedProcs.has(d.proc_oid) && taintedProcs.has(d.ref_oid)) {
            taintedProcs.add(d.proc_oid);
            changed = true;
          }
        }
        for (const d of viewDepRows.rows) {
          if (taintedViews.has(d.view_oid)) continue;
          if (
            (d.refclass === "pg_proc" && taintedProcs.has(d.ref_oid)) ||
            (d.refclass === "pg_class" && taintedViews.has(d.ref_oid))
          ) {
            taintedViews.add(d.view_oid);
            changed = true;
          }
        }
        const taintedFnRes = [...taintedProcs]
          .map((oid) => procByOid.get(oid)?.name)
          .filter((name): name is string => Boolean(name))
          .map((name) => fnCall(name));
        const taintedViewRes = [...taintedViews]
          .map((oid) => viewByOid.get(oid)?.name)
          .filter((name): name is string => Boolean(name))
          .map((name) => viewRef(name));
        for (const p of procs) {
          if (taintedProcs.has(p.oid)) continue;
          if (
            taintedFnRes.some((re) => re.test(p.cleanBody)) ||
            taintedViewRes.some((re) => re.test(p.cleanBody))
          ) {
            taintedProcs.add(p.oid);
            changed = true;
          }
        }
      }

      const depsByPol = new Map<string, Array<{ refclass: string; ref_oid: string }>>();
      for (const d of polDepRows.rows) {
        const list = depsByPol.get(d.pol_oid) ?? [];
        list.push(d);
        depsByPol.set(d.pol_oid, list);
      }

      const briefingPolicies = polRows.rows.filter((pol) =>
        (depsByPol.get(pol.oid) ?? []).some(
          (d) =>
            (d.refclass === "pg_proc" && taintedProcs.has(d.ref_oid)) ||
            (d.refclass === "pg_class" && taintedViews.has(d.ref_oid)),
        ),
      );
      for (const row of briefingPolicies) {
        expect(
          row.cmd,
          `policy on ${row.t} depending on ctx_briefing_user_id must be FOR SELECT ('r') only`,
        ).toBe("r");
        const canonical = idsHelper.toCanonicalTable(row.t);
        expect(
          cataloged.has(canonical),
          `table ${canonical} whose policy depends on ctx_briefing_user_id must be in member_briefing_table`,
        ).toBe(true);
      }
      const policyTables = new Set(
        briefingPolicies.map((r) => idsHelper.toCanonicalTable(r.t)),
      );
      for (const requiredMeetingTbl of REQUIRED_BRIEFING_TABLES) {
        expect(
          policyTables.has(requiredMeetingTbl),
          `meetings table ${requiredMeetingTbl} must have a FOR SELECT policy depending on ctx_briefing_user_id`,
        ).toBe(true);
      }
    });

    await inContext(workerUrl, systemEnter(), async (c) => {
      await expectWriteRefused(
        c,
        `INSERT INTO crove_kernel.member_briefing_table (table_name, mode) VALUES ('crove_notes.note', 'read')`,
        [],
        "worker insert into member_briefing_table",
      );
      await expectWriteRefused(
        c,
        `DELETE FROM crove_kernel.member_briefing_table`,
        [],
        "worker delete on member_briefing_table",
      );
    });
  });

  it("enforces O1 calendar_agenda own-row scope, meeting/reader/link/published bounds, zero leaks, and zero writes inside member_briefing", async () => {
    if (!has.entry) {
      expect(has.entry).toBe(false);
      expect(has.helper).toBe(false);
      expect(has.catalog).toBe(false);
      return;
    }

    const memberMailId = await seedMorningMail({
      toAddress: emails.member,
      sourceId: users.member,
      createdBy: null,
      status: "queued",
    });
    const limitedMailId = await seedMorningMail({
      toAddress: emails.limited,
      sourceId: users.limited,
      createdBy: null,
      status: "queued",
    });

    await ensureBriefLinesSeeded();

    // Intentionally open a writable BEGIN tx as crove_worker to verify DB guards (not just BEGIN READ ONLY) refuse all writes.
    const tallyBefore = await admin(
      async (c) =>
        (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM crove_kernel.refusal_tally WHERE org_id = $1`,
            [orgId],
          )
        ).rows[0]?.n ?? 0,
    );
    let lookupTablesFound: string[] = [];
    await inContext(workerUrl, briefingEnter(orgId, users.member, memberMailId), async (c) => {
      const agendaIds = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.calendar_agenda ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(
        agendaIds,
        "member_briefing O1 reads ONLY own calendar_agenda rows",
      ).toEqual([ids.calAgendaMember]);

      const meetingIds = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.meeting ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(
        meetingIds,
        "member_briefing reads ONLY member-accessible meetings (never mAttCanary or mCrossOrg)",
      ).toEqual([ids.mOrg, ids.mSharedMine, ids.mRecMine].sort());

      const readerMeetings = (
        await c.query<{ meeting_id: string }>(
          `SELECT meeting_id FROM crove_meetings.meeting_reader ORDER BY meeting_id`,
        )
      ).rows.map((r) => r.meeting_id);
      expect(readerMeetings).toEqual([ids.mSharedMine]);

      const linkIds = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.meeting_link ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(
        linkIds,
        "member_briefing reads meeting_link strictly scoped to readable meetings",
      ).toEqual([ids.linkOrg, ids.linkShared, ids.linkMine].sort());

      const resultIds = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.meeting_result ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(
        resultIds,
        "member_briefing reads ONLY stage = 'published' results on readable meetings (never drafts)",
      ).toEqual([ids.resOrgPub, ids.resSharedPub, ids.resRecPub].sort());

      const itemIds = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.action_item ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(
        itemIds,
        "member_briefing reads ONLY stage = 'published' action items on readable meetings (never drafts)",
      ).toEqual([ids.itemOrgPub, ids.itemSharedPub, ids.itemRecPub].sort());

      // morning_brief_lines reads ONLY the member's own line for a currently readable meeting (never other users' or revoked meetings).
      const linesRes = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.morning_brief_lines ORDER BY id`,
        )
      ).rows.map((r) => r.id);
      expect(linesRes).toEqual([ids.briefLineMine]);

      // If a narrow member display-name lookup table/view is cataloged, verify org/membership scoping.
      const catalogEntries = await c.query<{ table_name: string }>(
        `SELECT table_name FROM crove_kernel.member_briefing_table ORDER BY table_name`,
      );
      lookupTablesFound = catalogEntries.rows
        .filter(
          (r) =>
            !r.table_name.startsWith("crove_meetings.") &&
            !r.table_name.startsWith("ludy_meetings."),
        )
        .map((r) => r.table_name);
      for (const entryName of lookupTablesFound) {
        if (!dbIds) throw new Error("dbIds not resolved");
        const canonical = dbIds.toCanonicalTable(entryName);
        const branded = dbIds.table(canonical);
        const dot = branded.indexOf(".");
        const schemaName = branded.slice(0, dot);
        const tableName = branded.slice(dot + 1);
        const colsRes = await c.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
          [schemaName, tableName],
        );
        const colNames = colsRes.rows.map((r) => r.column_name);
        const lookupRows = await c.query<Record<string, unknown>>(`SELECT * FROM ${canonical}`);
        const seenUserIds = new Set<string>();
        for (const r of lookupRows.rows) {
          if (colNames.includes("org_id")) {
            expect(r.org_id, `${canonical} must never leak rows from other orgs`).toBe(orgId);
          }
          const uid = (r.user_id ?? r.id) as string | undefined;
          if (uid) seenUserIds.add(uid);
          const displayName = (r.display_name ?? r.name) as string | undefined;
          if (uid === users.member) {
            expect(displayName, `${canonical} member display name matches`).toBe(expectedNames.member);
            expect(displayName, `${canonical} must never expose member email`).not.toBe(emails.member);
          } else if (uid === users.owner) {
            expect(displayName, `${canonical} owner display name matches`).toBe(expectedNames.owner);
            expect(displayName, `${canonical} must never expose owner email`).not.toBe(emails.owner);
          } else if (uid === users.twin) {
            expect(displayName, `${canonical} twin display name matches`).toBe(expectedNames.twin);
            expect(displayName, `${canonical} must never expose twin email`).not.toBe(emails.twin);
          }
        }
        expect(seenUserIds.has(users.stranger), `${canonical} must exclude other-org users`).toBe(false);
        expect(seenUserIds.has(users.member), `${canonical} includes active org member`).toBe(true);
        expect(seenUserIds.has(users.owner), `${canonical} includes active org owner`).toBe(true);
      }

      // Seeded sensitive tables/functions MUST NOT leak inside member_briefing.
      // (Note: per ADR-0049 O5, crove_kernel.party and crove_crm.* are excluded from member_briefing_table
      // and write-refused, while CRM read-only lookups run via Runtime.lookup in the caller transaction.)
      if (has.notes) {
        await expectDeniedOrEmpty(
          c,
          `SELECT id FROM crove_notes.note`,
          [],
          "member_briefing read of crove_notes.note",
        );
      }
      for (const [label, sql, params] of [
        ["member_vy_memory", `SELECT id FROM crove_kernel.member_vy_memory`, []],
        ["member_vy_result", `SELECT id FROM crove_kernel.member_vy_result`, []],
        ["ai_run", `SELECT id FROM crove_kernel.ai_run`, []],
        ["task", `SELECT id FROM crove_kernel.task`, []],
        ["task_comment", `SELECT id FROM crove_kernel.task_comment`, []],
        ["user_account", `SELECT id, email FROM crove_kernel.user_account`, []],
        [
          "member_emails(uuid[])",
          `SELECT user_id, email FROM crove_kernel.member_emails($1::uuid[])`,
          [[users.member, users.owner]],
        ],
        [
          "today_mail_recipients(uuid[], boolean)",
          `SELECT user_id, email FROM crove_kernel.today_mail_recipients($1::uuid[], false)`,
          [[users.member, users.owner]],
        ],
        [
          "member_profiles(uuid[])",
          `SELECT * FROM crove_kernel.member_profiles($1::uuid[])`,
          [[users.member, users.owner]],
        ],
        [
          "morning_notices_due(integer,uuid,uuid,date)",
          `SELECT org_id, user_id, events FROM crove_meetings.morning_notices_due(20, $1::uuid, NULL, NULL)`,
          [orgId],
        ],
        ["mail_message", `SELECT id FROM crove_kernel.mail_message`, []],
        ["mail_event", `SELECT id FROM crove_kernel.mail_event`, []],
        ["mail_suppression", `SELECT id FROM crove_kernel.mail_suppression`, []],
        ["inbound_message", `SELECT id FROM crove_kernel.inbound_message`, []],
        ["today_mail", `SELECT id FROM crove_kernel.today_mail`, []],
        ["transcript_segment", `SELECT id FROM crove_meetings.transcript_segment`, []],
        ["meeting_note", `SELECT id FROM crove_meetings.meeting_note`, []],
      ] as const) {
        await expectDeniedOrEmpty(c, sql, [...params], `member_briefing read of ${label}`);
      }
      if (has.weeklyNoticesDue) {
        await expectDeniedOrEmpty(
          c,
          `SELECT org_id, user_id, meetings FROM crove_meetings.weekly_notices_due(
             20, NULL, NULL, NULL,
             ${WEEKLY_DUE_NOW_SQL}
           )`,
          [],
          "member_briefing read of weekly_notices_due (all orgs)",
        );
        await expectDeniedOrEmpty(
          c,
          `SELECT org_id, user_id, meetings FROM crove_meetings.weekly_notices_due(
             20, $1::uuid, NULL, NULL,
             ${WEEKLY_DUE_NOW_SQL}
           )`,
          [otherOrg],
          "member_briefing read of weekly_notices_due (otherOrg)",
        );
      }
      if (has.seriesNudgesDue) {
        await expectDeniedOrEmpty(
          c,
          `SELECT org_id, user_id, series_id, open_count FROM crove_meetings.series_nudges_due(20, NULL, NULL, NULL, NULL)`,
          [],
          "member_briefing read of series_nudges_due (all orgs)",
        );
        await expectDeniedOrEmpty(
          c,
          `SELECT org_id, user_id, series_id, open_count FROM crove_meetings.series_nudges_due(20, $1::uuid, NULL, NULL, NULL)`,
          [otherOrg],
          "member_briefing read of series_nudges_due (otherOrg)",
        );
      }
      if (has.projects) {
        await expectDeniedOrEmpty(
          c,
          `SELECT id FROM crove_projects.project`,
          [],
          "member_briefing read of crove_projects.project",
        );
        for (const childTbl of [
          "crove_projects.project_column",
          "crove_projects.project_member",
          "crove_projects.project_task",
        ] as const) {
          const exists =
            (
              await c.query<{ w: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS w`, [
                dbIds ? dbIds.table(childTbl) : childTbl,
              ])
            ).rows[0]?.w === true;
          if (exists) {
            await expectDeniedOrEmpty(
              c,
              `SELECT id FROM ${childTbl}`,
              [],
              `member_briefing read of ${childTbl}`,
            );
          }
        }
      }

      // Dynamic morning_brief_lines INSERT probe: uses DEFAULT VALUES if INSERT is revoked, else fills required cols to hit 42501 guard.
      const canInsertBriefLines =
        (
          await c.query<{ ok: boolean }>(
            `SELECT pg_catalog.has_table_privilege(current_user, 'crove_meetings.morning_brief_lines', 'INSERT') AS ok`,
          )
        ).rows[0]?.ok === true;
      if (!canInsertBriefLines) {
        await expectWriteRefused(
          c,
          `INSERT INTO crove_meetings.morning_brief_lines DEFAULT VALUES`,
          [],
          "insert morning_brief_lines",
        );
      } else {
        if (!dbIds) throw new Error("dbIds not resolved");
        const reqCols = await c.query<{ column_name: string; data_type: string; udt_name: string }>(
          `SELECT column_name, data_type, udt_name
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'morning_brief_lines'
             AND is_nullable = 'NO'
             AND column_default IS NULL
           ORDER BY ordinal_position`,
          [dbIds.schema("meetings")],
        );
        const colNames: string[] = [];
        const colExprs: string[] = [];
        const vals: unknown[] = [];
        const pushExpr = (name: string, expr: string) => {
          colNames.push(name);
          colExprs.push(expr);
        };
        const pushVal = (name: string, val: unknown, cast = "") => {
          vals.push(val);
          pushExpr(name, `$${vals.length}${cast}`);
        };
        for (const col of reqCols.rows) {
          const n = col.column_name;
          if (n === "org_id") pushVal(n, orgId, "::uuid");
          else if (n === "user_id" || n === "member_user_id") pushVal(n, users.member, "::uuid");
          else if (n === "meeting_id") pushVal(n, ids.mRecMine, "::uuid");
          else if (col.data_type === "uuid") pushVal(n, randomUUID(), "::uuid");
          else if (col.data_type === "date") pushExpr(n, "current_date");
          else if (col.data_type.startsWith("timestamp")) pushExpr(n, "now() + interval '1 hour'");
          else if (col.data_type === "boolean") pushVal(n, false, "::boolean");
          else if (col.data_type === "integer" || col.data_type === "smallint" || col.data_type === "bigint") pushVal(n, 1);
          else if (col.data_type === "jsonb") pushExpr(n, "'[]'::jsonb");
          else if (col.data_type === "ARRAY" || col.udt_name === "_text") pushExpr(n, "ARRAY['x']::text[]");
          else pushVal(n, "x");
        }
        const sql =
          colNames.length > 0
            ? `INSERT INTO crove_meetings.morning_brief_lines (${colNames.join(", ")}) VALUES (${colExprs.join(", ")})`
            : `INSERT INTO crove_meetings.morning_brief_lines DEFAULT VALUES`;
        await expectWriteRefused(c, sql, vals, "insert morning_brief_lines");
      }

      // Every INSERT and outbox emission inside member_briefing fails closed (42501).
      const insertProbes: ReadonlyArray<readonly [string, string, unknown[], (string | RegExp)?]> = [
        [
          "insert calendar_agenda",
          `INSERT INTO crove_meetings.calendar_agenda
             (org_id, id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, invitee_count)
           VALUES ($1, $2, $3, $4, 'ext-tamper', 'Tamper', now(), now() + interval '1 hour', 'Asia/Ho_Chi_Minh', 0)`,
          [orgId, randomUUID(), ids.calConnMember, users.member],
        ],
        [
          "insert meeting_link",
          `INSERT INTO crove_meetings.meeting_link (org_id, id, meeting_id, party_id, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [orgId, randomUUID(), ids.mRecMine, ids.partyOrg, users.member],
        ],
        [
          "insert meeting_result",
          `INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, decisions, feature, stage, tainted)
           VALUES ($1, $2, $3, 'tampered', '[]', 'meetings.summary', 'draft', true)`,
          [orgId, randomUUID(), ids.mRecMine],
        ],
        [
          "insert action_item",
          `INSERT INTO crove_meetings.action_item
             (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, when_parsed, transcript_seconds, stage, status, flags, tainted)
           VALUES ($1, $2, $3, 'tampered', 'A', $4, 'now', '2026-11-27', 1, 'draft', 'suggested', '[]', true)`,
          [orgId, randomUUID(), ids.mRecMine, users.member],
        ],
        [
          "insert task",
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type)
           VALUES ($1, 'tampered task', 'human', 'agent')`,
          [orgId],
          /AGENT_FORBIDDEN/,
        ],
        [
          "insert task_comment",
          `INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type)
           VALUES ($1, $2, 'tampered comment', 'agent')`,
          [orgId, ids.taskOrg],
          /AGENT_FORBIDDEN/,
        ],
        [
          "insert idempotency_key",
          `INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256, response)
           VALUES ($1, 'briefing-tamper', $2, 'meetings.brief.render', $3, '{}'::jsonb)`,
          [orgId, randomUUID(), "0".repeat(64)],
        ],
        [
          "insert party",
          `INSERT INTO crove_kernel.party (org_id, id, kind, name)
           VALUES ($1, $2, 'organization', 'Tampered Party')`,
          [orgId, randomUUID()],
        ],
        [
          "insert crm.deal",
          `INSERT INTO crove_crm.deal (org_id, id, party_id, title, stage_id, sort_key, created_by)
           VALUES ($1, $2, $3, 'Tampered Deal', $4, 'b', $5)`,
          [orgId, randomUUID(), ids.partyOrg, ids.stageOrg, users.member],
        ],
        [
          "insert member_vy_memory",
          `INSERT INTO crove_kernel.member_vy_memory (org_id, id, member_user_id, body)
           VALUES ($1, $2, $3, 'tampered memory')`,
          [orgId, randomUUID(), users.member],
        ],
        [
          "insert member_vy_result",
          `INSERT INTO crove_kernel.member_vy_result
             (org_id, id, member_user_id, run_id, feature, subject_type, subject_id, status, body, tainted, private_read, expires_at)
           VALUES ($1, $2, $3, $4, 'notes.summary', 'note', $5, 'ready', 'tampered result', true, true, now() + interval '30 minutes')`,
          [orgId, randomUUID(), users.member, memberVyRunId, ids.noteMemberPriv],
        ],
        [
          "insert activity",
          `INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary)
           VALUES ($1, 'kernel.party', $2, 'note', 'tampered')`,
          [orgId, randomUUID()],
        ],
        [
          "insert proposal",
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, legal_entity_id)
           VALUES ($1, 'x', 'kernel.task.create', 'x', '{}', NULL)`,
          [orgId],
        ],
        [
          "insert notification",
          `INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key)
           VALUES ($1, $2, 'kernel.x', 'tamper-key')`,
          [orgId, users.member],
        ],
        [
          "insert agent_wakeup",
          `INSERT INTO crove_kernel.agent_wakeup (org_id, agent_id, status, reasons)
           VALUES ($1, $2, 'pending', '["tamper"]'::jsonb)`,
          [orgId, orgChart.agentId],
        ],
        [
          "insert audit_event",
          `INSERT INTO crove_kernel.audit_event
             (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
           VALUES ($1, 'agent', $2, 'kernel.task.create', $3, 'denied', $4, '{}'::jsonb)`,
          [orgId, users.member, randomUUID(), "0".repeat(64)],
        ],
        [
          "insert outbox_pending",
          `INSERT INTO crove_kernel.outbox_pending DEFAULT VALUES`,
          [],
        ],
        [
          "emit outbox event via crove_kernel.emit",
          `SELECT crove_kernel.emit('kernel.x', '{"tamper":true}'::jsonb, gen_random_uuid())`,
          [],
        ],
        [
          "record refusal tally via crove_kernel.refusal_tally_note",
          `SELECT crove_kernel.refusal_tally_note('kernel.task.create', 'AGENT_FORBIDDEN', false, 20, 200, 5, 600)`,
          [],
          /AGENT_FORBIDDEN/,
        ],
      ];
      for (const [why, sql, params, expectedMsg] of insertProbes) {
        await expectWriteRefused(c, sql, [...params], why, expectedMsg);
      }
      if (has.notes) {
        await expectWriteRefused(
          c,
          `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body, tags)
           VALUES ($1, $2, $3, 'private', 'tampered note', 'body', '{}')`,
          [orgId, randomUUID(), users.member],
          "insert note",
        );
      }

      // Every UPDATE / DELETE inside member_briefing either fails (42501) or affects zero rows.
      const mutationProbes: ReadonlyArray<readonly [string, string, unknown[]]> = [
        [
          "update own calendar_agenda link",
          `UPDATE crove_meetings.calendar_agenda SET meeting_id = $2 WHERE org_id = $1 AND id = $3`,
          [orgId, ids.mRecMine, ids.calAgendaMember],
        ],
        [
          "delete own calendar_agenda",
          `DELETE FROM crove_meetings.calendar_agenda WHERE org_id = $1 AND id = $2`,
          [orgId, ids.calAgendaMember],
        ],
        [
          "update own meeting",
          `UPDATE crove_meetings.meeting SET title = 'tampered' WHERE org_id = $1 AND id = $2`,
          [orgId, ids.mRecMine],
        ],
        [
          "delete own meeting",
          `DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`,
          [orgId, ids.mRecMine],
        ],
        [
          "delete own meeting_link",
          `DELETE FROM crove_meetings.meeting_link WHERE org_id = $1 AND id = $2`,
          [orgId, ids.linkMine],
        ],
        [
          "update action_item",
          `UPDATE crove_meetings.action_item SET title = 'tampered' WHERE org_id = $1 AND id = $2`,
          [orgId, ids.itemRecPub],
        ],
        [
          "delete action_item",
          `DELETE FROM crove_meetings.action_item WHERE org_id = $1 AND id = $2`,
          [orgId, ids.itemRecPub],
        ],
        [
          "delete own morning_brief_lines row",
          `DELETE FROM crove_meetings.morning_brief_lines WHERE org_id = $1 AND id = $2`,
          [orgId, ids.briefLineMine],
        ],
        [
          "update task",
          `UPDATE crove_kernel.task SET title = 'tampered' WHERE org_id = $1 AND id = $2`,
          [orgId, ids.taskOrg],
        ],
        [
          "delete task",
          `DELETE FROM crove_kernel.task WHERE org_id = $1 AND id = $2`,
          [orgId, ids.taskOrg],
        ],
        [
          "update task_comment",
          `UPDATE crove_kernel.task_comment SET body = 'tampered' WHERE org_id = $1 AND id = $2`,
          [orgId, ids.taskCommentOrg],
        ],
        [
          "delete task_comment",
          `DELETE FROM crove_kernel.task_comment WHERE org_id = $1 AND id = $2`,
          [orgId, ids.taskCommentOrg],
        ],
        [
          "update mail_message",
          `UPDATE crove_kernel.mail_message SET status = 'failed' WHERE org_id = $1 AND id = $2`,
          [orgId, memberMailId],
        ],
        [
          "delete mail_message",
          `DELETE FROM crove_kernel.mail_message WHERE org_id = $1 AND id = $2`,
          [orgId, memberMailId],
        ],
        [
          "update party",
          `UPDATE crove_kernel.party SET name = 'tampered' WHERE org_id = $1 AND id = $2`,
          [orgId, ids.partyOrg],
        ],
        [
          "update crm.deal",
          `UPDATE crove_crm.deal SET title = 'tampered' WHERE org_id = $1 AND id = $2`,
          [orgId, ids.dealOrg],
        ],
        [
          "update member_vy_memory",
          `UPDATE crove_kernel.member_vy_memory SET body = 'tampered' WHERE org_id = $1 AND id = $2`,
          [orgId, ids.memMember],
        ],
        [
          "update member_vy_result",
          `UPDATE crove_kernel.member_vy_result SET body = 'tampered' WHERE org_id = $1 AND id = $2`,
          [orgId, ids.vyResultMember],
        ],
        [
          "delete member_vy_result",
          `DELETE FROM crove_kernel.member_vy_result WHERE org_id = $1 AND id = $2`,
          [orgId, ids.vyResultMember],
        ],
      ];
      for (const [why, sql, params] of mutationProbes) {
        await expectMutationBlockedOrZero(c, sql, [...params], why);
      }
    });

    await admin(async (c) => {
      const stillThere = (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_meetings.morning_brief_lines WHERE org_id = $1 AND id = $2`,
          [orgId, ids.briefLineMine],
        )
      ).rowCount;
      expect(stillThere, "valid morning_brief_lines row survived write probes").toBe(1);

      const tallyAfter =
        (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM crove_kernel.refusal_tally WHERE org_id = $1`,
            [orgId],
          )
        ).rows[0]?.n ?? 0;
      expect(tallyAfter, "refusal_tally count stayed unchanged during member_briefing").toBe(
        tallyBefore,
      );
    });

    // Multi-org boundary check: users.other belongs to BOTH orgId and otherOrg and owns calAgendaOther (orgId)
    // plus calAgendaCross (otherOrg); entering member_briefing for orgId must expose ONLY orgId's rows.
    const otherMemberMailId = await seedMorningMail({
      toAddress: emails.other,
      sourceId: users.other,
      createdBy: null,
      status: "queued",
    });
    await inContext(
      workerUrl,
      briefingEnter(orgId, users.other, otherMemberMailId),
      async (c) => {
        const otherAgendaIds = (
          await c.query<{ id: string }>(
            `SELECT id FROM crove_meetings.calendar_agenda ORDER BY id`,
          )
        ).rows.map((r) => r.id);
        expect(
          otherAgendaIds,
          "multi-org user inside member_briefing sees ONLY orgId calendar_agenda rows, never calAgendaCross",
        ).toEqual([ids.calAgendaOther]);

        const otherMeetingIds = (
          await c.query<{ id: string }>(`SELECT id FROM crove_meetings.meeting ORDER BY id`)
        ).rows.map((r) => r.id);
        expect(otherMeetingIds).toEqual(
          [ids.mOrg, ids.mSharedMine, ids.mAttCanary].sort(),
        );
        expect(otherMeetingIds).not.toContain(ids.mCrossOrg);

        const otherLinkIds = (
          await c.query<{ id: string }>(`SELECT id FROM crove_meetings.meeting_link ORDER BY id`)
        ).rows.map((r) => r.id);
        expect(otherLinkIds).not.toContain(ids.linkCrossOrg);
      },
      { readOnly: true },
    );

    // Distinguishing content='full' from vy_lines=true: turning vyLines off still allows member_briefing
    // entry and factual meeting reads while returning zero morning_brief_lines rows.
    if (has.noticeVyLines) {
      await upsertMorningNotice(orgId, users.member, {
        enabled: true,
        content: "full",
        vyLines: false,
      });
      try {
        await inContext(
          workerUrl,
          briefingEnter(orgId, users.member, memberMailId),
          async (c) => {
            const factualAgenda = (
              await c.query<{ id: string }>(
                `SELECT id FROM crove_meetings.calendar_agenda ORDER BY id`,
              )
            ).rows.map((r) => r.id);
            expect(factualAgenda).toEqual([ids.calAgendaMember]);

            const factualMeetings = (
              await c.query<{ id: string }>(
                `SELECT id FROM crove_meetings.meeting ORDER BY id`,
              )
            ).rows.map((r) => r.id);
            expect(factualMeetings).toEqual([ids.mOrg, ids.mSharedMine, ids.mRecMine].sort());

            const hiddenLines = (
              await c.query<{ id: string }>(
                `SELECT id FROM crove_meetings.morning_brief_lines ORDER BY id`,
              )
            ).rows.map((r) => r.id);
            expect(
              hiddenLines,
              "morning_brief_lines must stay empty when morning_notice.vy_lines = false",
            ).toEqual([]);
          },
          { readOnly: true },
        );
      } finally {
        await upsertMorningNotice(orgId, users.member, {
          enabled: true,
          content: "full",
          vyLines: true,
        });
      }
    }

    // Verify removed org members are excluded from any cataloged display-name lookup.
    if (lookupTablesFound.length > 0) {
      await admin((c) =>
        c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [
          orgId,
          users.other,
        ]),
      );
      try {
        await inContext(workerUrl, briefingEnter(orgId, users.member, memberMailId), async (c) => {
          for (const entryName of lookupTablesFound) {
            if (!dbIds) throw new Error("dbIds not resolved");
            const canonical = dbIds.toCanonicalTable(entryName);
            const lookupRows = await c.query<Record<string, unknown>>(
              `SELECT * FROM ${canonical}`,
            );
            const seenIds = lookupRows.rows
              .map((r) => (r.user_id ?? r.id) as string | undefined)
              .filter(Boolean);
            expect(seenIds).not.toContain(users.other);
          }
        });
      } finally {
        await admin((c) =>
          c.query(
            `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`,
            [orgId, users.other],
          ),
        );
        await upsertMorningNotice(orgId, users.other, {
          enabled: true,
          content: "full",
          vyLines: true,
          timeZone: dueTz,
          sendMinuteSql: "(pg_catalog.date_part('hour', pg_catalog.now() AT TIME ZONE $3)::integer * 60)",
        });
      }
    }

    // Entity-scoped member inside member_briefing sees zero org-wide meetings across all 6 meeting-scoped tables.
    await inContext(workerUrl, briefingEnter(orgId, users.limited, limitedMailId), async (c) => {
      for (const tbl of [
        "crove_meetings.calendar_agenda",
        "crove_meetings.meeting",
        "crove_meetings.meeting_reader",
        "crove_meetings.meeting_link",
        "crove_meetings.meeting_result",
        "crove_meetings.action_item",
      ]) {
        const rows = (await c.query<{ id: string }>(`SELECT id FROM ${tbl} ORDER BY id`)).rows;
        expect(
          rows,
          `entity-limited member_briefing cannot read ${tbl} across org-wide or ungranted rows`,
        ).toEqual([]);
      }
    });
  });
});

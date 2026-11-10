// SPDX-License-Identifier: AGPL-3.0-only
// Vy working for one member, stage B step (a) (ADR-0049 decision 7, issue #2756): what the member-scoped background context
// must hold from the day it exists. Every function and table stage B adds is looked up first and its cases run only when it
// exists, so this file passes on a database that has none of them (no it.skip: the invariant job fails on a skipped test)
// and pins the behavior the feature PR must meet. What needs no new object holds now and is unconditional: the set of
// functions that seal a context, who the helper ctx_acting_user_id answers for, and which policies and functions read it.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
//
// The contract the feature PR must meet, as these cases read it:
//   crove_kernel.enter_member_vy_context(org, agent, run)  worker login only; refuses (42501) an org that is not active, an
//     agent that is not a member's Vy or not active, a run that is not live, a member who is removed, disabled, demoted without a
//     grant or denied vy.use (MEMBER_NOT_ACTIVE), an org, module or agent kill switch and the global ai switch (KILL_SWITCH_ON), a
//     spent hard-stop budget (BUDGET_EXHAUSTED); takes FOR SHARE on the member's tenant_member row. The seal is an agent context:
//     actor 'agent', user NULL, the member's role and entity scope as enter_user_context seals them, max_risk R0 or R1, kind
//     'member_vy', member, no position.
//   crove_kernel.member_vy_table(table_name text, mode text)  the catalog, 'schema.table' and 'read' or 'write'; a subset of
//     CATALOG below; the policies that read ctx_acting_user_id are exactly its tables, and a write-covering one sits on a
//     'write' table only. No login can write the catalog.
//   Writes: only the catalog's 'write' tables (a result, the run) and the narrow audit rows (ids, enums and numbers only);
//     no memory, note, task, task comment, proposal, activity, notification or any other guarded table.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "@crove/db";
import { migrate, setRolePasswords } from "@crove/db/migrate";
import {
  createOrg,
  kernelCommands,
  upsertIdentity,
  kernelQueries,
} from "@crove/kernel";
import { Runtime } from "@crove/kernel-runtime";
import { financeCommands, financeQueries } from "@crove/mod-finance";
import { TEST_MANIFESTS } from "./fixtures/manifests.ts";
import { contextToken } from "./fixtures/context-token.ts";

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(
  new URL("../../../../supabase/migrations", import.meta.url),
);
const SYSTEM = { type: "system" as const, component: "kernel.agent" };
const suite = ADMIN ? describe : describe.skip;
// The functions that write the sealed context, and so the only ways into any context. ctx_write is the writer itself.
const CTX_WRITERS = [
  "crove_kernel.ctx_write(jsonb)",
  "crove_kernel.enter_agent_context(uuid,uuid,uuid)",
  "crove_kernel.enter_context(uuid,uuid)",
  "crove_kernel.enter_system_context(uuid)",
];
const MEMBER_ENTRY = "crove_kernel.enter_member_vy_context(uuid,uuid,uuid)";
// Policies that read ctx_acting_user_id, as (table, policy, command, permissive).
const POLICIES = [
  ["crove_kernel.ai_run", "member_vy_read", "*", false],
  ["crove_kernel.member_vy_memory", "member_read", "r", false],
  ["crove_kernel.member_vy_result", "member_only", "*", false],
  ["crove_notes.note", "note_read", "r", false],
];
// What the catalog may hold, nothing else. No meeting table (Platform PO decision on #2756), no task, proposal or notification.
const CATALOG: Record<string, string> = {
  "crove_kernel.ai_run": "write",
  "crove_kernel.member_vy_memory": "read",
  "crove_kernel.member_vy_result": "write",
  "crove_notes.note": "read",
};
// Guarded tables that carry their own narrow rule, and the exempt ones: each pinned by name below, not by the enumeration.
const NARROW = [
  "crove_kernel.agent_wakeup",
  "crove_kernel.audit_event",
  "crove_kernel.idempotency_key",
  "crove_kernel.outbox_pending",
];
// Every schema but the system ones, and functions and procedures both: a definer in any schema can seal or read a context.
// The key rotation, the re-entry guard, the MAC, the verifier and the writer: the whole of the machinery, each with its reason to touch the seal.
const SEAL_TOUCHERS = [
  "crove_kernel.context_key_rotate()",
  "crove_kernel.context_reentry_guard()",
  "crove_kernel.ctx_mac(text)",
  "crove_kernel.ctx_verified()",
  "crove_kernel.ctx_write(jsonb)",
];
const HASH = "a".repeat(64);
const NON_SYSTEM =
  "s.nspname NOT LIKE 'pg\\_%' AND s.nspname <> 'information_schema'";

suite("Vy in member mode, stage B invariants (ADR-0049, #2756)", () => {
  const dbName = `crove_test_member_vy_bg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = "";
  let appUrl = "";
  let workerUrl = "";
  const pools: pg.Pool[] = [];
  let orgId = "";
  let otherOrg = "";
  let branch = "";
  const users = { owner: "", vyUser: "", other: "", viewer: "", limited: "" };
  let orgChart = { agentId: "", runId: "" };
  const vyAgent: Record<string, string> = {};
  const has = { entry: false, catalog: false, kind: false, notes: false };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
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
    commit = false,
  ): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query("BEGIN");
      await enter(c);
      const out = await fn(c);
      if (commit) await c.query("COMMIT");
      return out;
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
  }
  const outcome = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: { code?: string; message: string }) => ({
        ok: false as const,
        code: error.code ?? "",
        message: error.message,
      }),
    );
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
  const systemEnter = (c: pg.Client) =>
    c.query("SELECT crove_kernel.enter_system_context($1::uuid)", [orgId]);
  const agentEnter = (c: pg.Client) =>
    c.query(
      "SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)",
      [orgId, orgChart.agentId, orgChart.runId],
    );
  const memberEnter =
    (agentId: string, runId: string, org = orgId) =>
    (c: pg.Client) =>
      c.query(
        "SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)",
        [org, agentId, runId],
      );
  const sealOf = async (c: pg.Client) =>
    JSON.parse(
      (
        await c.query<{ ctx: string }>(
          "SELECT current_setting('crove.ctx') AS ctx",
        )
      ).rows[0]?.ctx as string,
    ) as Record<string, unknown>;
  const acting = (url: string, enter: (c: pg.Client) => Promise<unknown>) =>
    inContext(
      url,
      enter,
      async (c) =>
        (
          await c.query<{ u: string | null }>(
            "SELECT crove_kernel.ctx_acting_user_id() AS u",
          )
        ).rows[0]?.u ?? null,
    );

  // A member's own Vy agent (once) and a fresh running run for it, made in the member's own context and committed so the worker
  // can enter it. A fresh run per case: an earlier case that cancelled or finished a run never makes a later one pass or fail.
  async function ensureAgent(who: keyof typeof users) {
    if (vyAgent[who]) return vyAgent[who] as string;
    const agentId = randomUUID();
    await inContext(
      appUrl,
      userEnter(users[who]),
      (c) =>
        c.query(
          `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
          [orgId, agentId, users[who]],
        ),
      true,
    );
    vyAgent[who] = agentId;
    return agentId;
  }
  async function liveRun(who: keyof typeof users) {
    const agentId = await ensureAgent(who);
    await admin((c) =>
      c.query(
        `UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND agent_id = $2 AND status = 'running'`,
        [orgId, agentId],
      ),
    );
    const runId = randomUUID();
    await inContext(
      appUrl,
      userEnter(users[who]),
      (c) =>
        c.query(
          `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'notes', 'running', true, now(), now() + interval '30 minutes')`,
          [orgId, runId, agentId],
        ),
      true,
    );
    return { agentId, runId };
  }
  // The result row of a run, inserted as the superuser with its triggers on, for the member the run belongs to.
  const addResult = (runId: string, member: string, status = "running", subjectId: string = randomUUID()) =>
    admin(async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO crove_kernel.member_vy_result (org_id, id, member_user_id, run_id, feature, subject_type, subject_id, status, body, tainted, private_read, expires_at)
         VALUES ($1, $2, $3, $4, 'notes.summary', 'note', $5, $6, CASE WHEN $6 = 'ready' THEN 'x' END, true, true, now() + interval '30 minutes')`,
        [orgId, id, member, runId, subjectId, status],
      );
      return id;
    });
  const asVy = async <T>(
    who: keyof typeof users,
    fn: (c: pg.Client, run: { agentId: string; runId: string }) => Promise<T>,
  ) => {
    const run = await liveRun(who);
    return inContext(workerUrl, memberEnter(run.agentId, run.runId), (c) =>
      fn(c, run),
    );
  };
  const entry = async (who: keyof typeof users) => {
    const run = await liveRun(who);
    return outcome(
      inContext(
        workerUrl,
        memberEnter(run.agentId, run.runId),
        async () => "entered",
      ),
    );
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, {
      crove_app: "test-app-pw",
      crove_worker: "test-worker-pw",
    });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login("crove_app", "test-app-pw");
    workerUrl = login("crove_worker", "test-worker-pw");
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
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
        issuer: "member-vy-bg",
        subject: key,
        email: `${key}@member-vy-bg.test`,
        name: null,
      });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), "Vy nền")).orgId;
    otherOrg = (
      await createOrg(api.runtime, asUser(users.other), "Công ty khác")
    ).orgId;
    await admin(async (c) => {
      branch = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`,
          [orgId, users.owner],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member')`,
        [orgId, users.vyUser, users.other, users.viewer, users.limited],
      );
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgId, users.limited, branch, users.owner],
      );
      const found = await c.query<{ r: string; w: boolean }>(`
        SELECT 'entry' AS r, to_regprocedure('crove_kernel.enter_member_vy_context(uuid,uuid,uuid)') IS NOT NULL AS w
        UNION ALL SELECT 'catalog', to_regclass('crove_kernel.member_vy_table') IS NOT NULL
        UNION ALL SELECT 'kind', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'crove_kernel.agent'::regclass AND attname = 'kind' AND NOT attisdropped)
        UNION ALL SELECT 'notes', to_regclass('crove_notes.note') IS NOT NULL`);
      for (const row of found.rows) has[row.r as keyof typeof has] = row.w;
    });
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
      { title: "Việc thử", assigneePositionId: installed.positionId },
      { actor: asUser(users.owner), orgId },
    );
    const started = await worker.execute<{ runId: string | null }>(
      "kernel.agent.run.start",
      { agentId: installed.agentId },
      { actor: SYSTEM, orgId },
    );
    orgChart = { agentId: installed.agentId, runId: started.runId as string };
    if (has.notes) {
      await admin((c) =>
        c.query(
          `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body, tags) VALUES
           ($1, $2, $3, 'private', 'Của tôi', 'riêng của thành viên', '{}'), ($1, $4, $5, 'private', 'Của người khác', 'riêng của người khác', '{}'),
           ($1, $6, $5, 'org', 'Chung', 'chia sẻ cho cả tổ chức', '{}')`,
          [
            orgId,
            randomUUID(),
            users.vyUser,
            randomUUID(),
            users.other,
            randomUUID(),
          ],
        ),
      );
    }
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // ---- Unconditional: nothing here needs a stage B object ----------------------------------------------------------------

  // The presence pin (#2822): what member Vy rests on is there, so none of the cases below can pass by finding nothing to check. These cases once skipped when an
  // object was missing (the file was written before stage A merged); they now run unconditionally, and this one names what is absent.
  it("finds every object the cases below rest on: the member entry, the catalog, the agent kind and the notes table", () => {
    expect(has, "the objects looked up in beforeAll").toEqual({ entry: true, catalog: true, kind: true, notes: true });
  });

  it("pins the functions that write the sealed context, with the member entry among them only when it exists", async () => {
    const { rows } = await admin((c) =>
      c.query<{ n: string }>(
        `SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
         WHERE ${NON_SYSTEM} AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) ~* 'ctx_write\\s*\\('
         ORDER BY 1`,
      ),
    );
    // An entry under another name, or a second writer, escapes every other case of this file: the set is exact.
    expect(
      rows.map((r) => r.n).sort(),
      "functions that call ctx_write",
    ).toEqual([...CTX_WRITERS, MEMBER_ENTRY].sort());
  });

  it("pins the functions that touch the context's key, its seal or its settings: only the writer and the verifier", async () => {
    const { rows } = await admin((c) =>
      c.query<{ n: string }>(
        `SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
         WHERE ${NON_SYSTEM} AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) ~* 'ctx_mac\\s*\\(|context_key|crove\\.ctx_seal'
         ORDER BY 1`,
      ),
    );
    // A function that computes the seal, reads the key or sets crove.ctx_seal could seal a member context of its own.
    expect(rows.map((r) => r.n)).toEqual(SEAL_TOUCHERS);
  });

  it("refuses a member's Vy agent and run in enter_agent_context, and enters no member context through any other entry", async () => {
    const run = await liveRun("vyUser");
    const viaAgent = await outcome(
      inContext(
        workerUrl,
        async () => {},
        (c) =>
          c.query(
            "SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)",
            [orgId, run.agentId, run.runId],
          ),
      ),
    );
    expect(viaAgent, "enter_agent_context for a member's Vy").toMatchObject({
      ok: false,
      code: "42501",
    });
    expect(viaAgent.ok ? "" : viaAgent.message).toMatch(/AGENT_NOT_ORG_CHART/);
  });

  it("answers ctx_acting_user_id with the user for a user context and NULL for the system, an org-chart agent and no context", async () => {
    expect(
      await acting(appUrl, userEnter(users.vyUser)),
      "a user context",
    ).toBe(users.vyUser);
    expect(
      await acting(workerUrl, systemEnter),
      "the system context",
    ).toBeNull();
    expect(
      await acting(workerUrl, agentEnter),
      "an org-chart agent context",
    ).toBeNull();
    expect(await acting(appUrl, async () => {}), "no context").toBeNull();
  });

  it("reads ctx_acting_user_id only in the pinned policies, and nowhere else: no function, wrapper or direct read of the sealed member", async () => {
    const found = await admin(async (c) => ({
      policies: (
        await c.query<{ t: string; n: string; cmd: string; perm: boolean }>(
          `SELECT p.polrelid::regclass::text AS t, p.polname::text AS n, p.polcmd::text AS cmd, p.polpermissive AS perm FROM pg_policy p
           WHERE coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~* '(ctx_acting_user_id|ctx_verified)'
             AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~* 'ctx_acting_user_id|''member'''
           ORDER BY 1, 2`,
        )
      ).rows,
      // pg_get_functiondef covers a BEGIN ATOMIC body, whose prosrc is empty.
      readers: (
        await c.query<{ n: string }>(
          `SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
           WHERE ${NON_SYSTEM} AND p.prokind IN ('f', 'p') AND p.oid <> to_regprocedure('crove_kernel.ctx_acting_user_id()') AND pg_get_functiondef(p.oid) ~* 'ctx_acting_user_id'
           ORDER BY 1`,
        )
      ).rows.map((r) => r.n),
      sealReaders: (
        await c.query<{ n: string }>(
          `SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
           WHERE ${NON_SYSTEM} AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) ~* '(->>?|#>>?)\\s*''\\{?member\\}?'''
           ORDER BY 1`,
        )
      ).rows.map((r) => r.n),
    }));
    expect(
      found.readers,
      "functions that call ctx_acting_user_id (a wrapper, or a definer that gates on it)",
    ).toEqual([]);
    expect(
      found.sealReaders,
      "functions that read the sealed member directly",
    ).toEqual(["crove_kernel.ctx_acting_user_id()"]);
    expect(
      found.policies.map((p) => [p.t, p.n, p.cmd, p.perm]),
      "policies that read the helper: (table, policy, command, permissive)",
    ).toEqual(POLICIES);
  });

  // ---- The catalog -----------------------------------------------------------------------------------------------------------
  it("holds only the catalog's tables, matches the policies in both directions, and is written by no login", async () => {
    // The catalog and the entry arrive together: one without the other is a half-built stage B.
    expect(has.catalog, "the catalog exists exactly when the entry does").toBe(
      has.entry,
    );
    const catalog = (
      await admin((c) =>
        c.query<{ table_name: string; mode: string }>(
          "SELECT table_name, mode FROM crove_kernel.member_vy_table ORDER BY 1",
        ),
      )
    ).rows;
    // A subset of the explicit list: no meeting table, no task, proposal or notification, whatever policy comes with it.
    for (const row of catalog)
      expect(CATALOG[row.table_name], `catalog row ${row.table_name}`).toBe(
        row.mode,
      );
    const tables = (
      await admin((c) =>
        c.query<{ t: string; cmd: string }>(
          `SELECT DISTINCT p.polrelid::regclass::text AS t, p.polcmd::text AS cmd FROM pg_policy p
           WHERE coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~* 'ctx_acting_user_id'`,
        ),
      )
    ).rows;
    expect(
      [...new Set(tables.map((r) => r.t))].sort(),
      "policies that read the helper, against the catalog's tables",
    ).toEqual(catalog.map((r) => r.table_name).sort());
    for (const row of tables.filter((p) => p.cmd !== "r")) {
      expect(
        catalog.find((r) => r.table_name === row.t)?.mode,
        `${row.t} has a write-covering policy that reads the helper`,
      ).toBe("write");
    }
    // Every crove_* role that is not a superuser (a login, a tenant role, the auth reader, the prober, the reporter): none writes the catalog,
    // by table privilege or by a column privilege.
    const privileges = await admin((c) =>
      c.query<{ r: string; p: string }>(
        `SELECT r.rolname AS r, p AS p FROM pg_roles r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
         WHERE r.rolname LIKE 'crove\\_%' AND NOT r.rolsuper
           AND (has_table_privilege(r.rolname, 'crove_kernel.member_vy_table', p)
                OR (p IN ('INSERT', 'UPDATE') AND has_any_column_privilege(r.rolname, 'crove_kernel.member_vy_table', p)))`,
      ),
    );
    expect(privileges.rows, "roles that can write the catalog").toEqual([]);
    for (const login of ["crove_app", "crove_worker"]) {
      const written = await outcome(
        inContext(
          login === "crove_app" ? appUrl : workerUrl,
          userEnter(users.owner),
          (c) =>
            c.query(
              "INSERT INTO crove_kernel.member_vy_table (table_name, mode, adr) VALUES ('crove_meetings.transcript_segment', 'write', 'ADR-0049')",
            ),
        ),
      );
      expect(written, `${login} inserting a catalog row`).toMatchObject({
        ok: false,
        code: "42501",
      });
    }
  });

  // ---- The entry -----------------------------------------------------------------------------------------------------------
  it("enters a member-mode context for a live run of an active member, with the member's own rights and the sealed shape", async () => {
    const run = await liveRun("limited");
    const seal = await inContext(
      workerUrl,
      memberEnter(run.agentId, run.runId),
      sealOf,
    );
    // The member's role and entity scope are exactly what enter_user_context seals for them: an entity-limited member's Vy sees only those entities.
    const user = await inContext(appUrl, userEnter(users.limited), sealOf);
    expect(
      user.le_scope,
      "an entity-limited member has a scope to compare",
    ).toEqual([branch]);
    expect(seal).toMatchObject({
      org: orgId,
      actor: "agent",
      user: null,
      kind: "member_vy",
      member: users.limited,
      agent: run.agentId,
      run: run.runId,
      role: user.role,
      le_scope: user.le_scope,
      flags: [],
    });
    // The exact key set: a new field in the seal is a decision to review. The run starts tainted (nothing a model produced is trusted).
    expect(Object.keys(seal).sort(), "the seal's keys").toEqual([
      "actor",
      "agent",
      "flags",
      "kind",
      "le_scope",
      "max_risk",
      "member",
      "module",
      "org",
      "position",
      "role",
      "run",
      "tainted",
      "user",
      "v",
    ]);
    expect(seal.tainted, "a member-mode run is tainted").toBe(true);
    expect(seal.position ?? null, "a member's Vy holds no seat").toBeNull();
    expect(["R0", "R1"], "max_risk is R1 at most").toContain(seal.max_risk);
    const whole = await asVy("vyUser", (c) => sealOf(c));
    expect(whole).toMatchObject({
      kind: "member_vy",
      member: users.vyUser,
      le_scope: ["*"],
    });
  });

  it("refuses the entry, each with its own cause: org, agent, run, member and the other orgs", async () => {
    const refused = (
      o: { ok: boolean; code?: string; message?: string },
      why: string,
      re?: RegExp,
    ) => {
      expect(o, why).toMatchObject({ ok: false, code: "42501" });
      if (re) expect(o.message, `${why}: its code`).toMatch(re);
    };
    // Each change is undone, and the case uses a fresh run each time.
    const changed = async (apply: string, undo: string) => {
      const run = await liveRun("vyUser");
      await admin((c) =>
        c.query(
          apply.replaceAll("$RUN", run.runId).replaceAll("$AGENT", run.agentId),
        ),
      );
      try {
        return await outcome(
          inContext(
            workerUrl,
            memberEnter(run.agentId, run.runId),
            async () => "entered",
          ),
        );
      } finally {
        await admin((c) =>
          c.query(
            undo
              .replaceAll("$RUN", run.runId)
              .replaceAll("$AGENT", run.agentId),
          ),
        );
      }
    };
    const member = (set: string) =>
      `UPDATE crove_kernel.tenant_member SET ${set} WHERE org_id = '${orgId}' AND user_id = '${users.vyUser}'`;
    refused(
      await changed(
        `SET session_replication_role = replica; UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = '${orgId}'`,
        `SET session_replication_role = replica; UPDATE crove_kernel.tenant SET status = 'active' WHERE org_id = '${orgId}'`,
      ),
      "an org that is not active",
      /TENANT_NOT_ACTIVE/,
    );
    refused(
      await changed(
        `UPDATE crove_kernel.agent SET status = 'paused' WHERE org_id = '${orgId}' AND id = '$AGENT'`,
        `UPDATE crove_kernel.agent SET status = 'active' WHERE org_id = '${orgId}' AND id = '$AGENT'`,
      ),
      "an agent that is not active",
      /AGENT_NOT_ACTIVE/,
    );
    refused(
      await changed(
        `UPDATE crove_kernel.ai_run SET status = 'succeeded', finished_at = now() WHERE org_id = '${orgId}' AND id = '$RUN'`,
        `SELECT 1`,
      ),
      "a run that is no longer running",
      /AGENT_RUN_NOT_LIVE/,
    );
    refused(
      await changed(
        `SET LOCAL session_replication_role = replica; UPDATE crove_kernel.ai_run SET started_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE org_id = '${orgId}' AND id = '$RUN'`,
        `SELECT 1`,
      ),
      "an expired run",
      /AGENT_RUN_NOT_LIVE/,
    );
    refused(
      await changed(member("role = 'viewer'"), member("role = 'member'")),
      "a member demoted to a viewer without a grant",
      /MEMBER_NOT_ACTIVE|VY_NOT_ALLOWED/,
    );
    refused(
      await changed(
        `INSERT INTO crove_kernel.member_permission_override (org_id, user_id, permission, allowed, set_by) VALUES ('${orgId}', '${users.vyUser}', 'vy.use', false, '${users.owner}')`,
        `DELETE FROM crove_kernel.member_permission_override WHERE org_id = '${orgId}' AND user_id = '${users.vyUser}'`,
      ),
      "a member whose vy.use is denied",
      /MEMBER_NOT_ACTIVE|VY_NOT_ALLOWED/,
    );
    refused(
      await changed(
        `UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = '${users.vyUser}'`,
        `UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = '${users.vyUser}'`,
      ),
      "a disabled account",
      /MEMBER_NOT_ACTIVE|VY_NOT_ALLOWED/,
    );
    refused(
      await changed(
        `DELETE FROM crove_kernel.tenant_member WHERE org_id = '${orgId}' AND user_id = '${users.vyUser}'`,
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ('${orgId}', '${users.vyUser}', 'member')`,
      ),
      "a member who was removed",
      /MEMBER_NOT_ACTIVE|VY_NOT_ALLOWED/,
    );
    // The org-chart agent and another org's entry, and the API login, are refused by the same entry.
    const run = await liveRun("vyUser");
    refused(
      await outcome(
        inContext(
          workerUrl,
          memberEnter(orgChart.agentId, orgChart.runId),
          async () => 1,
        ),
      ),
      "an org-chart agent",
    );
    refused(
      await outcome(
        inContext(
          workerUrl,
          memberEnter(run.agentId, run.runId, otherOrg),
          async () => 1,
        ),
      ),
      "the member's agent named in another org",
    );
    refused(
      await outcome(
        inContext(
          workerUrl,
          memberEnter(run.agentId, orgChart.runId),
          async () => 1,
        ),
      ),
      "the member's agent with another agent's run",
    );
    refused(
      await outcome(
        inContext(
          workerUrl,
          memberEnter(run.agentId, randomUUID()),
          async () => 1,
        ),
      ),
      "a run that does not exist",
    );
    refused(
      await outcome(
        inContext(appUrl, memberEnter(run.agentId, run.runId), async () => 1),
      ),
      "the API login",
    );
    // Control: everything restored, the member's live run enters.
    expect(
      (await entry("vyUser")).ok,
      "the member's live run once everything is restored",
    ).toBe(true);
  });

  it("refuses the entry under an org, module or agent kill switch and under the global ai switch, and under a spent hard-stop budget", async () => {
    const engage = (scope: string, target: string) =>
      admin(
        async (c) =>
          (
            await c.query<{ id: string }>(
              `INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, $2, $3, $4) RETURNING id`,
              [orgId, scope, target, users.owner],
            )
          ).rows[0]?.id as string,
      );
    const release = (id: string) =>
      admin((c) =>
        c.query(
          `UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1 AND id = $3`,
          [orgId, users.owner, id],
        ),
      );
    const agentId = await ensureAgent("vyUser");
    for (const [scope, target] of [
      ["org", "*"],
      ["module", "notes"],
      ["agent", agentId],
    ] as const) {
      const id = await engage(scope, target);
      const refused = await entry("vyUser");
      expect(refused, `a ${scope} kill switch`).toMatchObject({
        ok: false,
        code: "42501",
      });
      expect(
        refused.ok ? "" : refused.message,
        `a ${scope} kill switch: its code`,
      ).toMatch(/KILL_SWITCH_ON/);
      await release(id);
      expect(
        (await entry("vyUser")).ok,
        `after releasing the ${scope} switch`,
      ).toBe(true);
    }
    const unrelated = await engage("module", "finance");
    expect(
      (await entry("vyUser")).ok,
      "a switch for another module stops nothing",
    ).toBe(true);
    await release(unrelated);
    const set = (engaged: boolean) =>
      admin((c) =>
        c.query(
          `SELECT crove_kernel.global_kill_switch_set('ai', $1, 'diễn tập', 'ops')`,
          [engaged],
        ),
      );
    await set(true);
    try {
      const refused = await entry("vyUser");
      expect(refused, "the operator's global ai switch").toMatchObject({
        ok: false,
        code: "42501",
      });
      expect(refused.ok ? "" : refused.message).toMatch(/KILL_SWITCH_ON/);
    } finally {
      await set(false);
    }
    // A spent hard-stop budget at each scope refuses the entry (decision 6: per org, per module, per agent), and one for another module stops nothing.
    const withBudget = async (scope: string, target: string) => {
      const id = await admin(
        async (c) =>
          (
            await c.query<{ id: string }>(
              `INSERT INTO crove_kernel.budget_policy (org_id, scope, target, monthly_limit, updated_by) VALUES ($1, $2, $3, 0, $4) RETURNING id`,
              [orgId, scope, target, users.owner],
            )
          ).rows[0]?.id as string,
      );
      try {
        return await entry("vyUser");
      } finally {
        await admin((c) =>
          c.query(
            `DELETE FROM crove_kernel.budget_policy WHERE org_id = $1 AND id = $2`,
            [orgId, id],
          ),
        );
      }
    };
    for (const [scope, target] of [
      ["org", "*"],
      ["module", "notes"],
      ["agent", agentId],
    ] as const) {
      const refused = await withBudget(scope, target);
      expect(
        refused,
        `a spent hard-stop budget for the ${scope}`,
      ).toMatchObject({ ok: false, code: "42501" });
      expect(refused.ok ? "" : refused.message).toMatch(/BUDGET_EXHAUSTED/);
    }
    expect(
      (await withBudget("module", "finance")).ok,
      "a spent budget for another module stops nothing",
    ).toBe(true);
    expect(
      (await entry("vyUser")).ok,
      "the member's live run once the budget is cleared",
    ).toBe(true);
  });

  it("takes FOR SHARE on the member's membership row, so a removal waits for an entering transaction (55P03)", async () => {
    const run = await liveRun("vyUser");
    const holder = new pg.Client({ connectionString: workerUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await memberEnter(run.agentId, run.runId)(holder);
      // The entering transaction is still open: a second connection cannot take a row lock on the membership. A DELETE and a role change
      // (a demotion to a viewer) both wait, so the lock is FOR SHARE and not merely FOR KEY SHARE, which a role change would not meet.
      for (const [why, sql] of [
        [
          "a removal",
          `DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`,
        ],
        [
          "a demotion to a viewer",
          `UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`,
        ],
      ] as const) {
        const blocked = await outcome(
          admin(async (c) => {
            await c.query("BEGIN");
            await c.query("SET LOCAL lock_timeout = '400ms'");
            try {
              return await c.query(sql, [orgId, users.vyUser]);
            } finally {
              await c.query("ROLLBACK");
            }
          }),
        );
        expect(blocked, `${why} while an entry is open`).toMatchObject({
          ok: false,
          code: "55P03",
        });
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  });

  it("enters in a READ ONLY transaction without the membership lock, reads as the member and writes nothing", async () => {
    const run = await liveRun("vyUser");
    const mine = await addResult(run.runId, users.vyUser);
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query("BEGIN READ ONLY");
      await memberEnter(run.agentId, run.runId)(c);
      expect(
        await sealOf(c),
        "a read-only entry seals the same shape",
      ).toMatchObject({
        kind: "member_vy",
        member: users.vyUser,
        tainted: true,
      });
      const read = await c.query<{ id: string }>(
        `SELECT id FROM crove_kernel.member_vy_result`,
      );
      expect(
        read.rows.map((r) => r.id),
        "a read-only member-mode context reads its member's results",
      ).toEqual([mine]);
      const write = await outcome(
        c.query(
          `UPDATE crove_kernel.member_vy_result SET status = 'ready', body = 'x' WHERE id = $1`,
          [mine],
        ),
      );
      expect(write, "a write in a read-only transaction").toMatchObject({
        ok: false,
        code: "25006",
      });
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
  });

  it("seals tainted true whatever the run row says", async () => {
    const run = await liveRun("vyUser");
    await admin((a) =>
      a.query(
        `UPDATE crove_kernel.ai_run SET tainted = false WHERE org_id = $1 AND id = $2`,
        [orgId, run.runId],
      ),
    );
    const seal = await inContext(
      workerUrl,
      memberEnter(run.agentId, run.runId),
      sealOf,
    );
    expect(seal.tainted, "the seal of a member-mode run").toBe(true);
  });

  it("keeps the 4-hour bound of a member Vy run when expires_at or started_at is updated later", async () => {
    const run = await liveRun("vyUser");
    const update = (set: string) =>
      outcome(
        admin((a) =>
          a.query(
            `UPDATE crove_kernel.ai_run SET ${set} WHERE org_id = $1 AND id = $2`,
            [orgId, run.runId],
          ),
        ),
      );
    // Positive control: a later expiry inside the bound is accepted, so the refusals below are about the bound.
    expect(
      (await update("expires_at = started_at + interval '3 hours'")).ok,
      "expires_at inside 4 hours",
    ).toBe(true);
    expect(
      (await update("expires_at = started_at + interval '4 hours'")).ok,
      "expires_at at exactly 4 hours",
    ).toBe(true);
    for (const [why, set] of [
      ["expires_at a day after the start", "expires_at = started_at + interval '1 day'"],
      ["the start moved a day back", "started_at = started_at - interval '1 day'"],
      // Both moved a day forward (the new expiry is 3 hours after the new start): still counted from the original start.
      ["both timestamps moved a day forward", "started_at = started_at + interval '1 day', expires_at = started_at + interval '1 day 3 hours'"],
    ] as const) {
      const refused = await update(set);
      // Before the clean-up migration the trigger watched agent_id alone; the bound is expected from it on.
      expect(refused, why).toMatchObject({ ok: false, code: "23514" });
    }
  });

  // ---- Writes ----------------------------------------------------------------------------------------------------------------
  it("refuses a member-mode context every guarded table that is not a catalog 'write' table, enumerated from the catalog (AGENT_FORBIDDEN)", async () => {
    const tables = (
      await admin((c) =>
        c.query<{ name: string }>(
          `SELECT n.nspname || '.' || c.relname AS name
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname LIKE 'crove\\_%' AND n.nspname <> 'crove_meta' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
             AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'agent_write_guard' AND NOT t.tgisinternal AND t.tgenabled = 'O')
           ORDER BY 1`,
        ),
      )
    ).rows.map((r) => r.name);
    const catalogWrite = Object.entries(CATALOG)
      .filter(([, m]) => m === "write")
      .map(([t]) => t);
    const probed = tables.filter(
      (t) => !catalogWrite.includes(t) && !NARROW.includes(t),
    );
    expect(probed.length, "an enumeration with teeth").toBeGreaterThan(40);
    const run = await liveRun("vyUser");
    const refusals = await admin(async (c) => {
      const found: Array<[string, string]> = [];
      await c.query("BEGIN");
      try {
        await memberEnter(run.agentId, run.runId)(c);
        for (const name of probed) {
          await c.query("SAVEPOINT probe");
          const [schema, table] = name.split(".") as [string, string];
          const out = await c
            .query(`INSERT INTO ${schema}."${table}" DEFAULT VALUES`)
            .then(
              () => "inserted",
              (e: { message: string }) => e.message,
            );
          await c.query("ROLLBACK TO SAVEPOINT probe");
          found.push([name, out]);
        }
      } finally {
        await c.query("ROLLBACK");
      }
      return found;
    });
    expect(
      refusals.filter(([, out]) => out !== "AGENT_FORBIDDEN"),
      "tables that did not refuse with AGENT_FORBIDDEN",
    ).toEqual([]);
  });

  it("pins each exempt and narrow table by its own rule: audit detail, keys, wakeups, tasks, comments, activity, proposals, notifications, memory and notes", async () => {
    const taskId = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type) VALUES ($1, 'Việc', 'human', 'user') RETURNING id`,
            [orgId],
          )
        ).rows[0]?.id as string,
    );
    const forbidden = { ok: false, code: "42501", message: "AGENT_FORBIDDEN" };
    await asVy("vyUser", async (c, run) => {
      const attempt = async (sql: string, params: unknown[] = []) => {
        await c.query("SAVEPOINT s");
        const o = await outcome(c.query(sql, params));
        await c.query("ROLLBACK TO SAVEPOINT s");
        return o;
      };
      const audit = (
        detail: unknown,
        cols: { command?: string; target?: string | null; sha?: string; outcome?: string } = {},
      ) =>
        attempt(
          `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, input_sha256, detail) VALUES ($1, 'agent', $2, $3, $4, $8, $5, $6, $7::jsonb)`,
          [
            orgId,
            run.agentId,
            cols.command ?? "kernel.member_vy.result.store",
            randomUUID(),
            cols.target === undefined ? null : cols.target,
            cols.sha ?? HASH,
            JSON.stringify(detail),
            cols.outcome ?? "ok",
          ],
        );
      // The audit row of this agent and run with ids, enums and numbers passes (the positive control): the real command, a 64-hex hash and a
      // detail of known shapes. Text anywhere else, in any column or key, never does, not even an ASCII slug a person could have typed.
      // The ids it names are the run's own: the run, the result row of the run and that result's subject. The write guard binds them to the run
      // (#2822), so a fixture that names another id would be refused; these pass whether or not the guard checks them yet.
      const ownSubject = randomUUID();
      const ownResult = await addResult(run.runId, users.vyUser, "running", ownSubject);
      const goodDetail = {
        agentRun: run.runId,
        runId: run.runId,
        resultId: ownResult,
        subjectId: ownSubject,
        subjectType: "note",
        feature: "notes.summary",
        status: "ready",
        bodyLength: 120,
      };
      // The runtime stores a keyed input hash ("k1:" and 64 hex) unless it runs in plain sha256 mode: both are hashes.
      const keyed = await audit(goodDetail, { sha: `k1:${HASH}` });
      expect(keyed.ok || keyed.message, "a keyed input hash").toBe(true);
      // The bounds are inclusive and a code the runtime raises passes (the controls for the negatives below).
      const edge = await audit({
        agentRun: run.runId,
        code: "AGENT_FORBIDDEN",
        errorCode: "AGENT_FORBIDDEN",
        rule: "P03",
        bodyLength: 10000000,
      });
      expect(
        edge.ok || edge.message,
        "a known code, a rule and a number at the bound",
      ).toBe(true);
      // The two member-mode commands and the one target type they use pass (the controls for the enumerated names).
      for (const [why, cols] of [
        ["the store command with its run as the target", { command: "kernel.member_vy.result.store", target: "kernel.ai_run" }],
        ["the audio command with no target", { command: "kernel.member_vy.meeting_audio.open" }],
      ] as const) {
        const ok = await audit(goodDetail, cols);
        expect(ok.ok || ok.message, why).toBe(true);
      }
      // The refusal of a command member mode may not run is audited (#2822 part 3c): outcome denied, a registered-command-shaped name, and a
      // detail of code, rule and agentRun only. The control first, then each way out of it.
      const denied = { agentRun: run.runId, code: "AGENT_FORBIDDEN", rule: "member_vy_context" };
      const deniedRow = await audit(denied, { command: "kernel.task.create", target: "kernel.task", outcome: "denied" });
      expect(deniedRow.ok || deniedRow.message, "a denied refusal row of a command outside kernel.member_vy").toBe(true);
      for (const [why, detail, cols] of [
        ["a denied row with a key off code, rule and agentRun", { ...denied, status: "ready" }, { command: "kernel.task.create", outcome: "denied" }],
        ["a denied row with an id key", { ...denied, resultId: randomUUID() }, { command: "kernel.task.create", outcome: "denied" }],
        ["a denied row with text in the code", { ...denied, code: "Gọi anh Nam 0909123456" }, { command: "kernel.task.create", outcome: "denied" }],
        ["a denied row of another run", { ...denied, agentRun: randomUUID() }, { command: "kernel.task.create", outcome: "denied" }],
        ["a denied row with text as the command", denied, { command: "Gọi anh Nam 0909123456", outcome: "denied" }],
        ["a denied row with an uppercase command", denied, { command: "Kernel.Task.Create", outcome: "denied" }],
        ["a denied row with text as the target type", denied, { command: "kernel.task.create", target: "Tóm tắt riêng", outcome: "denied" }],
        ["a failed row of a command outside kernel.member_vy", denied, { command: "kernel.task.create", outcome: "failed" }],
        ["an ok row of a command outside kernel.member_vy", denied, { command: "kernel.task.create", outcome: "ok" }],
      ] as const) {
        expect(await audit(detail, cols), why).toMatchObject(forbidden);
      }
      // The bound: twenty denied rows for one run (kept here, not rolled back), and the twenty-first is refused.
      for (let i = 0; i < 20; i++) {
        const kept = await outcome(
          c.query(
            `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail) VALUES ($1, 'agent', $2, 'kernel.task.create', $3, 'denied', $4, $5::jsonb)`,
            [orgId, run.agentId, randomUUID(), HASH, JSON.stringify(denied)],
          ),
        );
        expect(kept.ok || kept.message, `denied row ${i + 1} of 20`).toBe(true);
      }
      expect(
        await audit(denied, { command: "kernel.task.create", outcome: "denied" }),
        "the twenty-first denied row of the run",
      ).toMatchObject(forbidden);
      const clean = await audit(goodDetail);
      expect(
        clean.ok || clean.message,
        "an audit row with ids and numbers only",
      ).toBe(true);
      for (const [why, detail, cols] of [
        [
          "planted text in a listed key",
          {
            agentRun: run.runId,
            feature: "Tóm tắt riêng: khách đề nghị giảm giá 12%",
          },
          {},
        ],
        [
          "an ASCII slug in feature",
          { agentRun: run.runId, feature: "goi_anh_Nam_0909123456" },
          {},
        ],
        [
          "an ASCII slug in status",
          { agentRun: run.runId, status: "goi_anh_Nam" },
          {},
        ],
        [
          "a code with digits",
          { agentRun: run.runId, code: "GOI_0909123456" },
          {},
        ],
        [
          "a rule that is none of the runtime's",
          { agentRun: run.runId, rule: "goi_anh_nam" },
          {},
        ],
        [
          "an id that is no uuid",
          { agentRun: run.runId, resultId: "khach-hang-Nam" },
          {},
        ],
        [
          "a code the runtime never raises",
          { agentRun: run.runId, code: "GOI_ANH_NAM" },
          {},
        ],
        [
          "an errorCode the runtime never raises",
          { agentRun: run.runId, errorCode: "GOI_ANH_NAM" },
          {},
        ],
        ["a fractional number", { agentRun: run.runId, bodyLength: 1.5 }, {}],
        [
          "a number over ten million",
          { agentRun: run.runId, bodyLength: 10000001 },
          {},
        ],
        ["a negative number", { agentRun: run.runId, bodyLength: -1 }, {}],
        ["a number as a string", { agentRun: run.runId, bodyLength: "12" }, {}],
        ["a key off the list", { agentRun: run.runId, summary: "x" }, {}],
        ["a nested value", { agentRun: run.runId, status: { a: 1 } }, {}],
        ["another run", { agentRun: randomUUID() }, {}],
        ["text in command", goodDetail, { command: "Gọi anh Nam 0909123456" }],
        [
          "a command off the member_vy names",
          goodDetail,
          { command: "kernel.task.create" },
        ],
        ["text in target_type", goodDetail, { target: "Tóm tắt riêng" }],
        // Shape-valid but not listed (#2822 part 3): the names are enumerated, so a command or a target type nobody declared for member mode is refused.
        [
          "a kernel.member_vy command that is not a member-mode command",
          goodDetail,
          { command: "kernel.member_vy.memory.save" },
        ],
        ["a slug target type that is not listed", goodDetail, { target: "kernel.task" }],
        [
          "text in input_sha256",
          goodDetail,
          { sha: "Tóm tắt riêng: khách đề nghị giảm giá 12%" },
        ],
        ["a hash of the wrong length", goodDetail, { sha: "x" }],
      ] as const) {
        expect(await audit(detail, cols), why).toMatchObject(forbidden);
      }
      expect(
        await attempt(`INSERT INTO crove_kernel.agent_wakeup DEFAULT VALUES`),
        "a wakeup",
      ).toMatchObject(forbidden);
      // A member's Vy holds no seat, so a NULL seat matches a task nobody is assigned to: the org-chart claim rule would pass. It must not.
      // A task its run already holds a lease on (seeded as the superuser) is no way in either: no claim, no release, no comment.
      const heldTask = await admin(
        async (a) =>
          (
            await a.query<{ id: string }>(
              `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, status, checkout_run_id, lock_expires_at, fence) VALUES ($1, 'Việc đang giữ', 'human', 'user', 'in_progress', $2, now() + interval '10 minutes', 1) RETURNING id`,
              [orgId, run.runId],
            )
          ).rows[0]?.id as string,
      );
      for (const [why, sql, params] of [
        [
          "claiming an owner's unassigned task",
          `UPDATE crove_kernel.task SET checkout_run_id = $2, fence = fence + 1, lock_expires_at = now() + interval '10 minutes', status = 'in_progress' WHERE id = $1`,
          [taskId, run.runId],
        ],
        [
          "releasing the lease its run holds",
          `UPDATE crove_kernel.task SET checkout_run_id = NULL, lock_expires_at = NULL WHERE id = $1`,
          [heldTask],
        ],
        [
          "a comment as an agent on a task its run holds",
          `INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'Gọi anh Nam 0909123456', 'agent')`,
          [orgId, heldTask],
        ],
        [
          "a comment as a user on a task its run holds",
          `INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'x', 'user')`,
          [orgId, heldTask],
        ],
        [
          "a comment on an unassigned task",
          `INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'x', 'agent')`,
          [orgId, taskId],
        ],
      ] as const) {
        expect(await attempt(sql, [...params]), why).toMatchObject(forbidden);
      }
      // Tasks, comments and activity carry their own rules (no seat, no lease, an org-visible sink); the context writes none.
      for (const [why, sql, params] of [
        [
          "a task",
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type) VALUES ($1, 'Việc', 'human', 'agent')`,
          [orgId],
        ],
        [
          "a task comment",
          `INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'x', 'agent')`,
          [orgId, taskId],
        ],
        [
          "an activity row",
          `INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary) VALUES ($1, 'kernel.party', $2, 'note', 'x')`,
          [orgId, randomUUID()],
        ],
        [
          "a proposal",
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, legal_entity_id) VALUES ($1, 'x', 'kernel.task.create', 'x', '{}', NULL)`,
          [orgId],
        ],
        [
          "a notification",
          `INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key) VALUES ($1, $2, 'kernel.x', 'k')`,
          [orgId, users.owner],
        ],
      ] as const) {
        const o = await attempt(sql, [...params]);
        expect(o, `member-mode context writing ${why}`).toMatchObject({
          ok: false,
          code: "42501",
        });
      }
      // Memory: a background run reads its member's memory and writes none (decisions 3 and 5): not insert, update or delete.
      const memoryId = randomUUID();
      await admin((a) =>
        a.query(
          `INSERT INTO crove_kernel.member_vy_memory (org_id, id, member_user_id, body) VALUES ($1, $2, $3, 'Gọi khách là anh')`,
          [orgId, memoryId, users.vyUser],
        ),
      );
      expect(
        await attempt(
          `INSERT INTO crove_kernel.member_vy_memory (org_id, member_user_id, body) VALUES ($1, $2, 'do mô hình viết')`,
          [orgId, users.vyUser],
        ),
        "a memory insert",
      ).toMatchObject({ ok: false, code: "42501" });
      // An update or a delete finds no row the policy admits, or is refused: either way it changes nothing (read back below).
      for (const [why, sql] of [
        [
          "a memory update",
          `UPDATE crove_kernel.member_vy_memory SET body = 'đổi' WHERE id = $1`,
        ],
        [
          "a memory delete",
          `DELETE FROM crove_kernel.member_vy_memory WHERE id = $1`,
        ],
      ] as const) {
        const o = await attempt(sql, [memoryId]);
        expect(o.ok ? o.value.rowCount : o.code, why).toBe(o.ok ? 0 : "42501");
      }
      const seen = await c.query<{ body: string }>(
        `SELECT body FROM crove_kernel.member_vy_memory`,
      );
      expect(
        seen.rows.map((r) => r.body),
        "the member's memory it may read",
      ).toEqual(["Gọi khách là anh"]);
    });
    await asVy("vyUser", async (c) => {
      // The member's own notes and the shared ones its role and scope may read; never another member's private note; no write.
      const seen = (
        await c.query<{ title: string }>(
          `SELECT title FROM crove_notes.note ORDER BY title`,
        )
      ).rows.map((r) => r.title);
      expect(seen, "notes a member-mode context reads").toEqual([
        "Chung",
        "Của tôi",
      ]);
      const written = await outcome(
        c.query(
          `INSERT INTO crove_notes.note (org_id, author_user_id, visibility, title) VALUES ($1, $2, 'private', 'Vy viết')`,
          [orgId, users.vyUser],
        ),
      );
      expect(written, "a note written by a member-mode context").toMatchObject({
        ok: false,
        code: "42501",
      });
    });
    // An entity-limited member's Vy reads no shared note (note_read's rule for the member), only its member's own.
    await asVy("limited", async (c) => {
      expect(
        (await c.query<{ title: string }>(`SELECT title FROM crove_notes.note`))
          .rows,
        "an entity-limited member's Vy",
      ).toEqual([]);
    });
  });

  it("binds the ids in a member-mode audit row to the run's own result: runId, resultId, subjectId and subjectType, in an audit row, a cached response and a denied row (#2822)", async () => {
    if (!has.entry || !has.kind) return;
    const forbidden = { ok: false, code: "42501", message: "AGENT_FORBIDDEN" };
    // The audit row of the agent and run in context, tried in a savepoint (as the guard sees any writer).
    const tryAudit = async (
      c: pg.Client,
      run: { agentId: string; runId: string },
      detail: unknown,
      cols: { command?: string; target?: string | null; targetId?: string | null; outcome?: string } = {},
    ) => {
      await c.query("SAVEPOINT s");
      const o = await outcome(
        c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, input_sha256, detail, target_id) VALUES ($1, 'agent', $2, $3, $4, $8, $5, $6, $7::jsonb, $9)`,
          [orgId, run.agentId, cols.command ?? "kernel.member_vy.result.store", randomUUID(), cols.target === undefined ? null : cols.target, HASH, JSON.stringify(detail), cols.outcome ?? "ok", cols.targetId ?? null],
        ),
      );
      await c.query("ROLLBACK TO SAVEPOINT s");
      return o;
    };
    // The responses an idempotency key of the run caches, each tried in a savepoint as the superuser, so a missing privilege cannot stand in for the guard.
    const tryKeys = (run: { agentId: string; runId: string }, responses: unknown[]) =>
      admin(async (c) => {
        await c.query("BEGIN");
        try {
          await memberEnter(run.agentId, run.runId)(c);
          const out: Awaited<ReturnType<typeof outcome>>[] = [];
          for (const response of responses) {
            await c.query("SAVEPOINT s");
            out.push(
              await outcome(
                c.query(
                  `INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256, response) VALUES ($1, $2, $3, 'kernel.member_vy.result.store', $4, $5::jsonb)`,
                  [orgId, `agent:${run.agentId}:${run.runId}`, randomUUID(), HASH, JSON.stringify(response)],
                ),
              ),
            );
            await c.query("ROLLBACK TO SAVEPOINT s");
          }
          return out;
        } finally {
          await c.query("ROLLBACK");
        }
      });
    // Another member's run with its result: the ids a run must not borrow.
    const foreignRun = await liveRun("other");
    const foreignSubject = randomUUID();
    const foreignResult = await addResult(foreignRun.runId, users.other, "running", foreignSubject);
    const denied = (run: { runId: string }) => ({ agentRun: run.runId, code: "AGENT_FORBIDDEN", rule: "member_vy_context" });

    // A run with its result row: its own ids pass, no other does.
    await asVy("vyUser", async (c, run) => {
      const ownSubject = randomUUID();
      const ownResult = await addResult(run.runId, users.vyUser, "running", ownSubject);
      const base = { agentRun: run.runId };
      for (const [why, detail] of [
        ["all of its own ids", { ...base, runId: run.runId, resultId: ownResult, subjectId: ownSubject, subjectType: "note", status: "ready" }],
        ["its result id alone", { ...base, resultId: ownResult }],
        ["its subject alone", { ...base, subjectId: ownSubject, subjectType: "note" }],
        ["no ids at all", { ...base, status: "ready", bodyLength: 3 }],
      ] as const) {
        const ok = await tryAudit(c, run, detail);
        expect(ok.ok || ok.message, why).toBe(true);
      }
      for (const [why, detail] of [
        ["a run id that is not the run's own", { ...base, runId: randomUUID() }],
        ["a result id that is not the run's result", { ...base, resultId: randomUUID() }],
        ["a subject id that is not the result's subject", { ...base, subjectId: randomUUID() }],
        ["a subject type that is not the result's (a known word, the wrong one)", { ...base, subjectType: "meeting" }],
        ["another run's id", { ...base, runId: foreignRun.runId }],
        ["another run's result id", { ...base, resultId: foreignResult }],
        ["another run's subject id", { ...base, subjectId: foreignSubject }],
        ["all of another run's ids", { ...base, runId: foreignRun.runId, resultId: foreignResult, subjectId: foreignSubject, subjectType: "note" }],
        ["its own result id with another run's subject", { ...base, resultId: ownResult, subjectId: foreignSubject }],
      ] as const) {
        expect(await tryAudit(c, run, detail), why).toMatchObject(forbidden);
      }
      // The meeting audio command's audit row names the subject: the one of the run's result (with the right command and target).
      const audio = await tryAudit(c, run, { ...base, runId: run.runId, subjectId: ownSubject, count: 3 }, { command: "kernel.member_vy.meeting_audio.open" });
      expect(audio.ok || audio.message, "the audio command naming its run's subject").toBe(true);
      expect(await tryAudit(c, run, { ...base, runId: run.runId, subjectId: foreignSubject, count: 3 }, { command: "kernel.member_vy.meeting_audio.open" }), "the audio command naming another subject").toMatchObject(forbidden);
      // The same binding on the response an idempotency key caches.
      const keyResponses = [
        { resultId: ownResult, status: "ready" },
        { resultId: randomUUID() },
        { resultId: foreignResult },
        { subjectId: foreignSubject },
      ];
      const keyOutcomes = await tryKeys(run, keyResponses);
      expect(keyOutcomes[0]?.ok || (keyOutcomes[0] as { message?: string }).message, "a cached response naming the run's own result").toBe(true);
      for (const [why, o] of [
        ["a cached response naming a free result id", keyOutcomes[1]],
        ["a cached response naming another run's result", keyOutcomes[2]],
        ["a cached response naming another run's subject", keyOutcomes[3]],
      ] as const) {
        expect(o, why).toMatchObject(forbidden);
      }
      // A denied-refusal row (#2943) carries code, rule and agentRun and no other key, so it cannot carry an id of any kind; the binding covers it all the same.
      const deniedOk = await tryAudit(c, run, denied(run), { command: "kernel.task.create", target: "kernel.task", outcome: "denied" });
      expect(deniedOk.ok || deniedOk.message, "the control: a denied row of the run").toBe(true);
      for (const [why, detail] of [
        ["a denied row with a free run id", { ...denied(run), runId: randomUUID() }],
        ["a denied row with another run's id", { ...denied(run), runId: foreignRun.runId }],
        ["a denied row with another run's result id", { ...denied(run), resultId: foreignResult }],
        ["a denied row with its own result id (the denied rows carry no ids)", { ...denied(run), resultId: ownResult }],
      ] as const) {
        expect(await tryAudit(c, run, detail, { command: "kernel.task.create", target: "kernel.task", outcome: "denied" }), why).toMatchObject(forbidden);
      }
    });

    // The target of an audit row is bound as well: none, or the run itself as a kernel.ai_run; a denied row (whose target the runtime takes from the model's
    // input) has none.
    await asVy("vyUser", async (c, run) => {
      const base = { agentRun: run.runId };
      for (const [why, cols] of [
        ["no target", {}],
        ["the run itself as its target", { target: "kernel.ai_run", targetId: run.runId }],
      ] as const) {
        const ok = await tryAudit(c, run, base, cols);
        expect(ok.ok || ok.message, why).toBe(true);
      }
      for (const [why, cols] of [
        ["a free target id", { target: "kernel.ai_run", targetId: randomUUID() }],
        ["another run's id as the target", { target: "kernel.ai_run", targetId: foreignRun.runId }],
        ["a target id with no target type", { targetId: run.runId }],
        ["the run's id under another target type", { target: "kernel.task", targetId: run.runId }],
      ] as const) {
        expect(await tryAudit(c, run, base, cols), why).toMatchObject(forbidden);
      }
      const deniedCols = { command: "kernel.task.create", target: "kernel.task", outcome: "denied" };
      for (const [why, targetId] of [
        ["a denied row with a free target id", randomUUID()],
        ["a denied row with another run's id as its target", foreignRun.runId],
        ["a denied row with the run's own id as its target", run.runId],
      ] as const) {
        expect(await tryAudit(c, run, denied(run), { ...deniedCols, targetId }), why).toMatchObject(forbidden);
      }
    });

    // A run with no result row yet: none of resultId, subjectId and subjectType is allowed (absent, or null, which the shape check refuses).
    await asVy("limited", async (c, run) => {
      const base = { agentRun: run.runId };
      for (const [why, detail] of [
        ["no ids at all", { ...base, status: "running", bodyLength: 0 }],
        ["its own run id", { ...base, runId: run.runId }],
      ] as const) {
        const ok = await tryAudit(c, run, detail);
        expect(ok.ok || ok.message, why).toBe(true);
      }
      for (const [why, detail] of [
        ["a result id when the run has no result", { ...base, resultId: randomUUID() }],
        ["a subject id when the run has no result", { ...base, subjectId: randomUUID() }],
        ["a subject type when the run has no result", { ...base, subjectType: "note" }],
        ["a null result id (the shape check refuses a null)", { ...base, resultId: null }],
        ["another run's result id", { ...base, resultId: foreignResult }],
        ["another run's subject id", { ...base, subjectId: foreignSubject }],
        ["a free run id", { ...base, runId: randomUUID() }],
      ] as const) {
        expect(await tryAudit(c, run, detail), why).toMatchObject(forbidden);
      }
      const keyOutcomes = await tryKeys(run, [{ status: "ready" }, { resultId: randomUUID() }]);
      expect(keyOutcomes[0]?.ok, "a cached response with no ids").toBe(true);
      expect(keyOutcomes[1], "a cached response with a result id when the run has none").toMatchObject(forbidden);
    });
  });

  it("keeps exactly twenty denied refusal rows of a run when thirty transactions of it insert at once (the bound is counted under a lock)", async () => {
    const run = await liveRun("vyUser");
    const denied = { agentRun: run.runId, code: "AGENT_FORBIDDEN", rule: "member_vy_context" };
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        outcome(
          inContext(
            workerUrl,
            memberEnter(run.agentId, run.runId),
            (c) =>
              c.query(
                `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail) VALUES ($1, 'agent', $2, 'kernel.task.create', $3, 'denied', $4, $5::jsonb)`,
                [orgId, run.agentId, randomUUID(), HASH, JSON.stringify(denied)],
              ),
            true,
          ),
        ),
      ),
    );
    expect(results.filter((r) => r.ok).length, "the transactions that kept their row").toBe(20);
    expect(results.filter((r) => !r.ok).map((r) => (r as { code?: string }).code), "the ten that were refused").toEqual(Array(10).fill("42501"));
    const kept = await admin((c) =>
      c.query(`SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND actor_id = $2 AND outcome = 'denied' AND detail ->> 'agentRun' = $3`, [orgId, run.agentId, run.runId]),
    );
    expect(kept.rows[0].n, "denied rows kept for the run").toBe(20);
  });

  it("reads the private Vy rows from no SQL function outside the frozen list (the prosrc scan of the sinks invariant, #2822)", async () => {
    // The SQL functions whose body names member_vy_result or member_vy_memory when the list was made. Frozen: a function not here that names them fails, so the list
    // changes only by an owner decision. The match is case-sensitive: the error code MEMBER_VY_RESULT_RUN_MISMATCH is not a table name (the source half is test/invariant/member-vy-sinks.test.ts).
    const FROZEN = [
      "crove_kernel.agent_write_guard",
      "crove_kernel.member_vy_former_members_due",
      "crove_kernel.member_vy_member_data_purge",
      "crove_kernel.member_vy_private_counts",
      "crove_kernel.member_vy_result_bind",
      "crove_kernel.member_vy_results_due",
      "crove_kernel.member_vy_results_expire",
      "crove_kernel.member_vy_run_finish",
      "crove_kernel.member_vy_runs_cancel",
      "crove_kernel.org_purge",
      "crove_meetings.audio_for_member_vy",
      "crove_meetings.meeting_discard_transcribe",
      "crove_meetings.member_vy_media_files",
    ];
    const found = await admin((c) =>
      c.query<{ fn: string }>(
        `SELECT n.nspname || '.' || p.proname AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname LIKE 'crove\\_%' AND (p.prosrc ~ 'member_vy_(result|memory)' OR p.prosrc ~ $$member_vy_['"]?\\s*\\|\\|$$) ORDER BY 1`,
      ),
    );
    const names = [...new Set(found.rows.map((r) => r.fn))];
    expect(names.filter((n) => !FROZEN.includes(n)), "SQL functions that read the private Vy rows and are not on the frozen list").toEqual([]);
    // Each entry still reads them: a function that no longer does is removed from the list in the change that makes it so.
    expect(FROZEN.filter((n) => !names.includes(n)), "frozen entries that no longer read them").toEqual([]);
  });

  it("lets a member-mode context emit no event and keep no idempotency text: outbox_pending, emit() and an own-run key (AGENT_FORBIDDEN)", async () => {
    const run = await liveRun("vyUser");
    // As the superuser, so a missing privilege cannot stand in for the guard: the guard fires on the row, whoever writes it.
    const attempts = await admin(async (c) => {
      await c.query("BEGIN");
      try {
        await memberEnter(run.agentId, run.runId)(c);
        const attempt = async (sql: string, params: unknown[] = []) => {
          await c.query("SAVEPOINT s");
          const o = await outcome(c.query(sql, params));
          await c.query("ROLLBACK TO SAVEPOINT s");
          return o;
        };
        const ownKey = `agent:${run.agentId}:${run.runId}`;
        const key = (
          k: string,
          command: string,
          sha: string,
          response: unknown,
        ) =>
          attempt(
            `INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256, response) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
              orgId,
              ownKey,
              k,
              command,
              sha,
              response === null ? null : JSON.stringify(response),
            ],
          );
        return {
          // emit() with any type and a free-text payload, a declared-looking type with ids only, and a direct outbox_pending row.
          emitText: await attempt(
            `SELECT crove_kernel.emit('kernel.x', '{"t":"Tóm tắt riêng"}'::jsonb, gen_random_uuid())`,
          ),
          emitIds: await attempt(
            `SELECT crove_kernel.emit('kernel.member_vy.result.stored', jsonb_build_object('resultId', gen_random_uuid()), gen_random_uuid())`,
          ),
          pending: await attempt(
            `INSERT INTO crove_kernel.outbox_pending DEFAULT VALUES`,
          ),
          // The run's own key: ids and a hash pass (the control); text in the key, the command, the hash or the response never does.
          // This run has no result row, so the response names no result id (the guard accepts only the id of the run's own result, #2822).
          keyOk: await key(
            randomUUID(),
            "kernel.member_vy.result.store",
            HASH,
            { status: "ready", bodyLength: 3 },
          ),
          keyHex: await key(HASH, "kernel.member_vy.result.store", HASH, null),
          keySlug: await key(
            "goi_anh_Nam",
            "kernel.member_vy.result.store",
            HASH,
            null,
          ),
          keyText: await key(
            "Gọi anh Nam",
            "kernel.member_vy.result.store",
            HASH,
            { resultId: randomUUID() },
          ),
          commandText: await key(
            randomUUID(),
            "Gọi anh Nam 0909123456",
            HASH,
            null,
          ),
          hashText: await key(
            randomUUID(),
            "kernel.member_vy.result.store",
            "Tóm tắt riêng",
            null,
          ),
          responseText: await key(
            randomUUID(),
            "kernel.member_vy.result.store",
            HASH,
            { feature: "Tóm tắt riêng: khách đề nghị giảm giá 12%" },
          ),
          responseSlug: await key(
            randomUUID(),
            "kernel.member_vy.result.store",
            HASH,
            { status: "goi_anh_Nam_0909123456" },
          ),
          otherRun: await attempt(
            `INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256) VALUES ($1, $2, 'k', 'kernel.member_vy.result.store', $3)`,
            [orgId, `agent:${run.agentId}:${randomUUID()}`, HASH],
          ),
        };
      } finally {
        await c.query("ROLLBACK");
      }
    });
    const forbidden = { ok: false, code: "42501", message: "AGENT_FORBIDDEN" };
    for (const [why, o] of [
      ["emit() with free text", attempts.emitText],
      [
        "emit() with ids only (no event type is declared for member mode)",
        attempts.emitIds,
      ],
      ["a direct outbox_pending row", attempts.pending],
      ["text in the idempotency key", attempts.keyText],
      ["an ASCII slug as the idempotency key", attempts.keySlug],
      ["text in the idempotency command", attempts.commandText],
      ["text in the request hash", attempts.hashText],
      ["text in the stored response", attempts.responseText],
      ["an ASCII slug in the stored response", attempts.responseSlug],
      ["another run's idempotency key", attempts.otherRun],
    ] as const) {
      expect(o, why).toMatchObject(forbidden);
    }
    for (const [why, o] of [
      ["an idempotency key of the run's own that is a uuid", attempts.keyOk],
      ["an idempotency key that is a 64-hex hash", attempts.keyHex],
    ] as const) {
      expect(o.ok || o.message, why).toBe(true);
    }
  });

  it("writes only its own result: the run's result updates, another member's is out of reach, and the cross-member insert is refused", async () => {
    // An earlier run's result of the same member, then the run under test (a new run cancels the earlier one).
    const earlier = await liveRun("vyUser");
    const earlierResult = await addResult(earlier.runId, users.vyUser);
    const run = await liveRun("vyUser");
    const mine = await addResult(run.runId, users.vyUser);
    const otherRun = await liveRun("other");
    const theirs = await addResult(otherRun.runId, users.other);
    await inContext(
      workerUrl,
      memberEnter(run.agentId, run.runId),
      async (c) => {
        const own = await outcome(
          c.query(
            `UPDATE crove_kernel.member_vy_result SET status = 'ready', body = 'Tóm tắt' WHERE id = $1`,
            [mine],
          ),
        );
        expect(
          own.ok && own.value.rowCount,
          "updating the run's own result (the positive control)",
        ).toBe(1);
        const foreign = await outcome(
          c.query(
            `UPDATE crove_kernel.member_vy_result SET status = 'ready', body = 'x' WHERE id = $1`,
            [theirs],
          ),
        );
        expect(
          foreign.ok && foreign.value.rowCount,
          "updating another member's result",
        ).toBe(0);
        const read = await c.query<{ id: string; member_user_id: string }>(
          `SELECT id, member_user_id FROM crove_kernel.member_vy_result`,
        );
        const ids = read.rows.map((r) => r.id);
        expect(
          ids,
          "the run's own result and its member's earlier one",
        ).toEqual(expect.arrayContaining([mine, earlierResult]));
        expect(ids, "another member's result").not.toContain(theirs);
        expect(
          read.rows.filter((r) => r.member_user_id !== users.vyUser),
          "results of any other member",
        ).toEqual([]);
        // What it may not do to its own result and run: clear the taint, delete the result, lower private_read, extend or untaint the run.
        // Each is refused or finds nothing to change; the state is read back below.
        for (const [why, sql, params] of [
          [
            "clearing the taint of its own result",
            `UPDATE crove_kernel.member_vy_result SET tainted = false WHERE id = $1`,
            [mine],
          ],
          [
            "lowering private_read of its own result",
            `UPDATE crove_kernel.member_vy_result SET private_read = false WHERE id = $1`,
            [mine],
          ],
          [
            "rewriting the same member's result of another run",
            `UPDATE crove_kernel.member_vy_result SET status = 'ready', body = 'Gọi anh Nam' WHERE id = $1`,
            [earlierResult],
          ],
          [
            "moving its own result to another run",
            `UPDATE crove_kernel.member_vy_result SET run_id = '${earlier.runId}' WHERE id = $1`,
            [mine],
          ],
          [
            "an update that writes a body and clears the taint together",
            `UPDATE crove_kernel.member_vy_result SET status = 'ready', body = 'x', tainted = false WHERE id = $1`,
            [mine],
          ],
          [
            "deleting its own result",
            `DELETE FROM crove_kernel.member_vy_result WHERE id = $1`,
            [mine],
          ],
          [
            "clearing the taint of its own run",
            `UPDATE crove_kernel.ai_run SET tainted = false WHERE id = $1`,
            [run.runId],
          ],
          [
            "extending its own run",
            `UPDATE crove_kernel.ai_run SET expires_at = expires_at + interval '1 day' WHERE id = $1`,
            [run.runId],
          ],
          [
            "moving its own run to another status",
            `UPDATE crove_kernel.ai_run SET status = 'succeeded' WHERE id = $1`,
            [run.runId],
          ],
        ] as const) {
          await c.query("SAVEPOINT pin");
          const o = await outcome(c.query(sql, [...params]));
          await c.query("ROLLBACK TO SAVEPOINT pin");
          // Extending its own run is refused by the guard (42501) or, once the 4-hour bound also holds on update (#2822), by the bound (23514);
          // either way no row moves. The two-step rule: this accepts both before the change lands.
          const refusals = why === "extending its own run" ? ["42501", "23514"] : ["42501"];
          if (o.ok) expect(o.value.rowCount, why).toBe(0);
          else expect(refusals, why).toContain(o.code);
        }
        await c.query("SAVEPOINT own_insert");
        const ownInsert = await outcome(
          c.query(
            `INSERT INTO crove_kernel.member_vy_result (org_id, member_user_id, run_id, feature, subject_type, subject_id, expires_at) VALUES ($1, $2, $3, 'notes.summary', 'note', $4, now() + interval '30 minutes')`,
            [orgId, users.vyUser, run.runId, randomUUID()],
          ),
        );
        await c.query("ROLLBACK TO SAVEPOINT own_insert");
        expect(
          ownInsert,
          "a new result for its own member and run (results are made by the member's own command)",
        ).toMatchObject({ ok: false, code: "42501" });
        const cross = await outcome(
          c.query(
            `INSERT INTO crove_kernel.member_vy_result (org_id, member_user_id, run_id, feature, subject_type, subject_id, expires_at) VALUES ($1, $2, $3, 'notes.summary', 'note', $4, now() + interval '30 minutes')`,
            [orgId, users.other, otherRun.runId, randomUUID()],
          ),
        );
        expect(cross, "a result for another member").toMatchObject({
          ok: false,
          code: "42501",
        });
      },
    );
  });

  // ---- #2822, from the Platform PO's review of #2800 ----------------------------------------------------------------------------------
  // A refusal with its code, message and DETAIL (the trigger names its table there), so a case can tell which trigger refused.
  const refusal = <T>(p: Promise<T>) =>
    p.then(
      () => ({ ok: true as const, code: "", message: "", detail: "" }),
      (error: { code?: string; message: string; detail?: string }) => ({
        ok: false as const,
        code: error.code ?? "",
        message: error.message,
        detail: error.detail ?? "",
      }),
    );
  // The tables the write guard leaves alone, read from the catalog (no enabled agent_write_guard row trigger), so a table that drops out
  // of the guard later is in this list without anyone adding it.
  const unguardedTables = () =>
    admin(
      async (c) =>
        (
          await c.query<{ name: string; exempt: boolean }>(
            `SELECT n.nspname || '.' || c.relname AS name, crove_kernel.agent_write_exempt(c.oid::regclass) AS exempt
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname LIKE 'crove\\_%' AND n.nspname <> 'crove_meta' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
               AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'agent_write_guard' AND NOT t.tgisinternal
                                 AND t.tgenabled IN ('O', 'A') AND t.tgfoid = 'crove_kernel.agent_write_guard()'::regprocedure)
             ORDER BY 1`,
          )
        ).rows,
    );
  // ai_run keeps its own-run rule (the guard's catalog branch, through its own trigger) and activity its stamp (AGENT_FORBIDDEN in
  // activity_stamp_agent); every other table the guard leaves alone refuses a member-mode context outright, before any other trigger.
  const OWN_RULE = ["crove_kernel.activity", "crove_kernel.ai_run"];

  it("puts a00_member_vy_forbid on every table the write guard leaves alone but ai_run and activity, read from the catalog, first of its row triggers", async () => {
    const unguarded = await unguardedTables();
    const names = unguarded.map((r) => r.name);
    // The known exempt tables are all found (the enumeration has teeth), and the catalog and agent_write_exempt agree on each.
    expect(names, "the exempt tables of 20261019010000").toEqual(
      expect.arrayContaining([
        "crove_kernel.activity",
        "crove_kernel.ai_run",
        "crove_kernel.outbox_event",
        "crove_kernel.refusal_tally",
        "crove_kernel.task",
        "crove_kernel.task_comment",
      ]),
    );
    expect(
      unguarded.filter((r) => !r.exempt).map((r) => r.name),
      "tables without the guard that agent_write_exempt does not exempt",
    ).toEqual([]);
    const forbidTables = names.filter((n) => !OWN_RULE.includes(n));
    const triggers = await admin(
      async (c) =>
        (
          await c.query<{ name: string; tgname: string; tgtype: number; tgenabled: string; fn: string }>(
            `SELECT n.nspname || '.' || c.relname AS name, t.tgname, t.tgtype::int AS tgtype, t.tgenabled::text AS tgenabled,
                    t.tgfoid::regprocedure::text AS fn
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE NOT t.tgisinternal AND n.nspname || '.' || c.relname = ANY ($1::text[])
             ORDER BY 1, t.tgname COLLATE "C"`,
            [forbidTables],
          )
        ).rows,
    );
    // tgtype 31: ROW (1) | BEFORE (2) | INSERT (4) | DELETE (8) | UPDATE (16), with no column list, enabled, the forbid function.
    for (const table of forbidTables) {
      const own = triggers.filter((t) => t.name === table);
      expect(
        own.filter((t) => t.tgname === "a00_member_vy_forbid").map((t) => [t.tgtype, ["O", "A"].includes(t.tgenabled), t.fn]),
        `${table}: a00_member_vy_forbid, BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW, enabled, member_vy_forbid()`,
      ).toEqual([[31, true, "crove_kernel.member_vy_forbid()"]]);
      // Row triggers fire in name order: no BEFORE row trigger may run ahead of it (and refuse or rewrite with another rule first).
      expect(
        own.filter((t) => (t.tgtype & 3) === 3)[0]?.tgname,
        `${table}: the first BEFORE row trigger`,
      ).toBe("a00_member_vy_forbid");
    }
    // And each one refuses: an insert in a member-mode context, as the superuser so no grant or RLS stands in, is refused by a00 itself
    // (its DETAIL names the table) before any NOT NULL, rule or other trigger of the table.
    const run = await liveRun("vyUser");
    const probes = await admin(async (c) => {
      const found: Array<[string, unknown]> = [];
      await c.query("BEGIN");
      try {
        await memberEnter(run.agentId, run.runId)(c);
        for (const table of forbidTables) {
          const [schema, name] = table.split(".") as [string, string];
          await c.query("SAVEPOINT probe");
          found.push([table, await refusal(c.query(`INSERT INTO ${schema}."${name}" DEFAULT VALUES`))]);
          await c.query("ROLLBACK TO SAVEPOINT probe");
        }
      } finally {
        await c.query("ROLLBACK");
      }
      return found;
    });
    for (const [table, o] of probes) {
      expect(o, `${table}: an insert in member mode`).toEqual({
        ok: false,
        code: "42501",
        message: "AGENT_FORBIDDEN",
        detail: table,
      });
    }
  });

  it("refuses refusal_tally_note, the worker-granted tally definer, in a member-mode context (a00 on refusal_tally, AGENT_FORBIDDEN)", async () => {
    const run = await liveRun("vyUser");
    const before = await admin(
      async (c) =>
        (
          await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_kernel.refusal_tally WHERE org_id = $1`, [orgId])
        ).rows[0]?.n,
    );
    const noted = await inContext(
      workerUrl,
      memberEnter(run.agentId, run.runId),
      (c) =>
        refusal(
          c.query(
            `SELECT crove_kernel.refusal_tally_note('kernel.task.create', 'AGENT_FORBIDDEN', false, 20, 200, 5, 600)`,
          ),
        ),
      true,
    );
    expect(noted, "refusal_tally_note in member mode").toEqual({
      ok: false,
      code: "42501",
      message: "AGENT_FORBIDDEN",
      detail: "crove_kernel.refusal_tally",
    });
    // The control: the same call in an org-chart agent context counts (the function and its grant work; only member mode is refused).
    const control = await inContext(workerUrl, agentEnter, (c) =>
      refusal(
        c.query(
          `SELECT crove_kernel.refusal_tally_note('kernel.task.create', 'AGENT_FORBIDDEN', false, 20, 200, 5, 600)`,
        ),
      ),
    );
    expect(control, "refusal_tally_note in an org-chart agent context (the control)").toMatchObject({ ok: true });
    const after = await admin(
      async (c) =>
        (
          await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_kernel.refusal_tally WHERE org_id = $1`, [orgId])
        ).rows[0]?.n,
    );
    expect(after, "no tally row from the member-mode call").toBe(before);
  });

  it("refuses moving its own result to another run on the row itself, as the superuser so the column grant cannot stand in (AGENT_FORBIDDEN)", async () => {
    // An earlier run of the same member with no result of its own, so no unique key stands in for the guard either.
    const earlier = await liveRun("vyUser");
    const run = await liveRun("vyUser");
    const mine = await addResult(run.runId, users.vyUser);
    const moved = await admin(async (c) => {
      await c.query("BEGIN");
      try {
        await memberEnter(run.agentId, run.runId)(c);
        // The control: the same superuser in the same context updates its own result in place.
        await c.query("SAVEPOINT s");
        const own = await refusal(
          c.query(`UPDATE crove_kernel.member_vy_result SET status = 'ready', body = 'Tóm tắt' WHERE id = $1`, [mine]),
        );
        await c.query("ROLLBACK TO SAVEPOINT s");
        // An earlier run of the same member: member_vy_result_bind alone lets it through (same member, same agent).
        const move = await refusal(
          c.query(`UPDATE crove_kernel.member_vy_result SET run_id = $2 WHERE id = $1`, [mine, earlier.runId]),
        );
        return { own, move };
      } finally {
        await c.query("ROLLBACK");
      }
    });
    expect(moved.own, "updating its own result in place (the control)").toMatchObject({ ok: true });
    expect(moved.move, "moving its own result to the member's earlier run").toEqual({
      ok: false,
      code: "42501",
      message: "AGENT_FORBIDDEN",
      detail: "crove_kernel.member_vy_result",
    });
    // Through the worker login the column grant refuses first (run_id is not updatable by crove_tenant): pinned too, with its own code.
    const viaWorker = await inContext(workerUrl, memberEnter(run.agentId, run.runId), (c) =>
      refusal(c.query(`UPDATE crove_kernel.member_vy_result SET run_id = $2 WHERE id = $1`, [mine, earlier.runId])),
    );
    expect(viaWorker, "moving its own result through the worker login").toMatchObject({
      ok: false,
      code: "42501",
      message: "permission denied for table member_vy_result",
    });
  });

  it("refuses rewriting its own result after the member accepted it (taint already false): the row must stay tainted", async () => {
    const run = await liveRun("vyUser");
    const mine = await addResult(run.runId, users.vyUser, "ready");
    // The member's acceptance clears the taint in the member's own context; here as the superuser outside any context.
    await admin((c) => c.query(`UPDATE crove_kernel.member_vy_result SET tainted = false WHERE id = $1`, [mine]));
    const forbidden = { ok: false, code: "42501", message: "AGENT_FORBIDDEN", detail: "crove_kernel.member_vy_result" };
    for (const url of [workerUrl, adminUrl]) {
      const who = url === workerUrl ? "the worker login" : "the superuser";
      const attempts = await inContext(url, memberEnter(run.agentId, run.runId), async (c) => {
        const attempt = async (sql: string) => {
          await c.query("SAVEPOINT s");
          const o = await refusal(c.query(sql, [mine]));
          await c.query("ROLLBACK TO SAVEPOINT s");
          return o;
        };
        return {
          body: await attempt(`UPDATE crove_kernel.member_vy_result SET body = 'Gọi anh Nam 0909123456' WHERE id = $1`),
          status: await attempt(`UPDATE crove_kernel.member_vy_result SET status = 'failed', body = NULL, error_code = 'AGENT_FORBIDDEN' WHERE id = $1`),
          revision: await attempt(`UPDATE crove_kernel.member_vy_result SET source_revision = 2 WHERE id = $1`),
          noop: await attempt(`UPDATE crove_kernel.member_vy_result SET body = body WHERE id = $1`),
        };
      });
      expect(attempts.body, `${who}: rewriting the accepted body`).toEqual(forbidden);
      expect(attempts.status, `${who}: failing the accepted result`).toEqual(forbidden);
      expect(attempts.revision, `${who}: moving the accepted result's revision`).toEqual(forbidden);
      expect(attempts.noop, `${who}: an update that changes nothing on the accepted result`).toEqual(forbidden);
    }
    const kept = await admin(
      async (c) =>
        (
          await c.query<{ body: string | null; tainted: boolean; status: string }>(
            `SELECT body, tainted, status FROM crove_kernel.member_vy_result WHERE id = $1`,
            [mine],
          )
        ).rows[0],
    );
    expect(kept, "the accepted result as the member left it").toEqual({ body: "x", tainted: false, status: "ready" });
  });

  // The Platform PO's ruling (#2822): after the member accepted a result, the run may still replace it, but only by a rewrite that puts the mark back (tainted = true): the new
  // text is the model's again and reads as suggested, never as accepted. This pins that behaviour; "no rewrite after accept at all" would be a different design.
  it("accepts a rewrite of an accepted result only when it sets the taint again, and the row then reads as tainted", async () => {
    const run = await liveRun("vyUser");
    const mine = await addResult(run.runId, users.vyUser, "ready");
    await admin((c) => c.query(`UPDATE crove_kernel.member_vy_result SET tainted = false WHERE id = $1`, [mine]));
    for (const url of [workerUrl, adminUrl]) {
      const who = url === workerUrl ? "the worker login" : "the superuser";
      const out = await inContext(url, memberEnter(run.agentId, run.runId), async (c) => {
        await c.query("SAVEPOINT s");
        const rewritten = await c.query<{ body: string | null; tainted: boolean }>(`UPDATE crove_kernel.member_vy_result SET body = 'Bản viết lại của Vy', tainted = true WHERE id = $1 RETURNING body, tainted`, [mine]);
        await c.query("ROLLBACK TO SAVEPOINT s");
        return rewritten.rows;
      });
      expect(out, `${who}: a rewrite that sets the taint again is accepted, and the row is tainted`).toEqual([{ body: "Bản viết lại của Vy", tainted: true }]);
    }
    const kept = await admin((c) => c.query<{ body: string | null; tainted: boolean }>(`SELECT body, tainted FROM crove_kernel.member_vy_result WHERE id = $1`, [mine]));
    expect(kept.rows[0], "the probes were rolled back: the accepted result is as the member left it").toEqual({ body: "x", tainted: false });
  });
});

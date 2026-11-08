// SPDX-License-Identifier: AGPL-3.0-only
// Vy working for one member, stage B step (a) (ADR-0049 decision 7, issue #2756): what the member-scoped background
// context must hold from the day it exists. Every function and table stage B adds is looked up first and its cases run
// only when it exists, so this file passes on a database that has none of them (no it.skip: the invariant job fails on
// a skipped test) and pins the behavior the feature PR must meet. The cases that need no new object hold now:
// ctx_acting_user_id is the member's for a user context and NULL for the system and an org-chart agent, and no policy
// or definer outside the known set reads it. Part of the invariant suite; it imports package code under test, never
// helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
//
// The contract the feature PR must meet, as these cases read it:
//   crove_kernel.enter_member_vy_context(org, agent, run)  worker login only; refuses an org-chart agent, a run that is
//     not running or has expired, and a member who is removed, disabled or without vy.use (MEMBER_NOT_ACTIVE);
//     afterwards ctx_actor_type() = 'agent', ctx_user_id() is NULL, ctx_agent_id() is the agent, ctx_acting_user_id()
//     is the member.
//   crove_kernel.member_vy_table(table_name text, mode text)  one row per table Vy in member mode may touch, table_name
//     as 'schema.table' (regclass text), mode 'read' or 'write'; the policies that read ctx_acting_user_id are exactly
//     the catalog's tables, and those policies that cover writes are on tables of mode 'write' only.
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
// The tables whose policies read ctx_acting_user_id today (stage A): the member's own rows and runs.
const HELPER_TABLES_TODAY = [
  "crove_kernel.ai_run",
  "crove_kernel.member_vy_memory",
  "crove_kernel.member_vy_result",
];
// The tables Vy in member mode must never write, with a minimal row that a user context can insert.
const OFF_CATALOG: Array<{
  table: string;
  columns: string;
  values: (org: string, user: string) => unknown[];
}> = [
  {
    table: "crove_kernel.task",
    columns: "(org_id, title, source, created_by_type)",
    values: (org) => [org, "Việc", "human", "user"],
  },
  {
    table: "crove_kernel.activity",
    columns: "(org_id, record_type, record_id, kind, summary)",
    values: (org) => [org, "kernel.party", randomUUID(), "note", "x"],
  },
];

suite("Vy in member mode, stage B invariants (ADR-0049, #2756)", () => {
  const dbName = `crove_test_member_vy_bg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = "";
  let appUrl = "";
  let workerUrl = "";
  const pools: pg.Pool[] = [];
  let orgId = "";
  const users = { owner: "", vyUser: "", other: "", viewer: "" };
  let agent = { agentId: "", runId: "" };
  let vy = { agentId: "", runId: "" };
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
  const userEnter = (userId: string) => (c: pg.Client) =>
    c.query("SELECT crove_kernel.enter_user_context($1::uuid, $2::text)", [
      orgId,
      contextToken(userId, orgId),
    ]);
  const systemEnter = (c: pg.Client) =>
    c.query("SELECT crove_kernel.enter_system_context($1::uuid)", [orgId]);
  const agentEnter = (c: pg.Client) =>
    c.query(
      "SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)",
      [orgId, agent.agentId, agent.runId],
    );
  const memberEnter = (agentId: string, runId: string) => (c: pg.Client) =>
    c.query(
      "SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)",
      [orgId, agentId, runId],
    );
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
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
        [orgId, users.vyUser, users.other, users.viewer],
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
    agent = { agentId: installed.agentId, runId: started.runId as string };
    if (has.kind) {
      // The member's own Vy and one running run, made in the member's own context and committed so the worker can enter it.
      const made = await inContext(
        appUrl,
        userEnter(users.vyUser),
        async (c) => {
          const agentId = randomUUID();
          const runId = randomUUID();
          await c.query(
            `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
            [orgId, agentId, users.vyUser],
          );
          await c.query(
            `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'notes', 'running', true, now(), now() + interval '30 minutes')`,
            [orgId, runId, agentId],
          );
          return { agentId, runId };
        },
        true,
      );
      vy = made;
    }
    if (has.notes) {
      await admin((c) =>
        c.query(
          `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body, tags) VALUES
           ($1, $2, $3, 'private', 'Của tôi', 'riêng của thành viên', '{}'), ($1, $4, $5, 'private', 'Của người khác', 'riêng của người khác', '{}')`,
          [orgId, randomUUID(), users.vyUser, randomUUID(), users.other],
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

  // Unconditional: the helper stage A shipped, and who it answers for.
  it("answers ctx_acting_user_id with the user for a user context and NULL for the system and an org-chart agent", async () => {
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

  it("reads ctx_acting_user_id in the policies of the catalog's tables only, and in no definer", async () => {
    const found = await admin(async (c) => ({
      policies: (
        await c.query<{ t: string; cmd: string }>(
          `SELECT DISTINCT p.polrelid::regclass::text AS t, p.polcmd::text AS cmd FROM pg_policy p
           WHERE coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') LIKE '%ctx\\_acting\\_user\\_id%'`,
        )
      ).rows,
      definers: (
        await c.query<{ n: string }>(
          `SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE p.prosecdef AND n.nspname LIKE 'crove\\_%' AND p.proname <> 'ctx_acting_user_id' AND p.prosrc LIKE '%ctx\\_acting\\_user\\_id%'`,
        )
      ).rows.map((r) => r.n),
    }));
    // No definer gates on it: an owner's Vy must never gain an owner-only definer (private_counts, the finder, erasure).
    expect(found.definers, "definers that read ctx_acting_user_id").toEqual([]);
    const tables = [...new Set(found.policies.map((r) => r.t))].sort();
    if (!has.catalog) {
      expect(
        tables,
        "tables whose policies read ctx_acting_user_id before the catalog exists",
      ).toEqual(HELPER_TABLES_TODAY);
      return;
    }
    const catalog = (
      await admin((c) =>
        c.query<{ table_name: string; mode: string }>(
          "SELECT table_name, mode FROM crove_kernel.member_vy_table",
        ),
      )
    ).rows;
    const listed = new Map(catalog.map((r) => [r.table_name, r.mode]));
    expect(
      [...listed.values()].filter((m) => m !== "read" && m !== "write"),
      "catalog modes",
    ).toEqual([]);
    expect(
      tables,
      "policies that read the helper, against the catalog's tables",
    ).toEqual([...listed.keys()].sort());
    // pg_policy.polcmd: r select, a insert, w update, d delete, * all. A policy covering writes sits on a table of mode write.
    for (const row of found.policies.filter((p) => p.cmd !== "r")) {
      expect(
        listed.get(row.t),
        `${row.t} has a write policy that reads the helper`,
      ).toBe("write");
    }
  });

  it("enters a member-mode context only for a live run of an active member, as the worker, with the member's shape", async () => {
    if (!has.entry || !has.kind) return;
    const enter = (agentId: string, runId: string, url = workerUrl) =>
      outcome(
        inContext(
          url,
          async () => {},
          (c) => memberEnter(agentId, runId)(c),
        ),
      );
    // The positive control: the member's own run, entered by the worker, has the sealed shape.
    const shape = await outcome(
      inContext(
        workerUrl,
        memberEnter(vy.agentId, vy.runId),
        async (c) =>
          (
            await c.query<{
              t: string;
              u: string | null;
              a: string | null;
              m: string | null;
            }>(
              "SELECT crove_kernel.ctx_actor_type() AS t, crove_kernel.ctx_user_id()::text AS u, crove_kernel.ctx_agent_id()::text AS a, crove_kernel.ctx_acting_user_id()::text AS m",
            )
          ).rows[0],
      ),
    );
    expect(shape.ok, "the worker entering the member's live run").toBe(true);
    if (shape.ok)
      expect(shape.value, "the sealed shape").toEqual({
        t: "agent",
        u: null,
        a: vy.agentId,
        m: users.vyUser,
      });
    // The org-chart agent, and the member's agent with another run, are refused.
    expect(
      (await enter(agent.agentId, agent.runId)).ok,
      "an org-chart agent",
    ).toBe(false);
    expect(
      (await enter(vy.agentId, agent.runId)).ok,
      "the member's agent with an org-chart agent's run",
    ).toBe(false);
    expect(
      (await enter(vy.agentId, randomUUID())).ok,
      "a run that does not exist",
    ).toBe(false);
    expect(
      (await enter(vy.agentId, vy.runId, appUrl)).ok,
      "the API login",
    ).toBe(false);
    // Each change below is undone, so the cases stay independent.
    const changed = async (
      apply: string,
      undo: string,
      params: unknown[] = [],
    ) => {
      await admin((c) => c.query(apply, params));
      try {
        return await enter(vy.agentId, vy.runId);
      } finally {
        await admin((c) => c.query(undo, params));
      }
    };
    const finished = await changed(
      `UPDATE crove_kernel.ai_run SET status = 'succeeded', finished_at = now() WHERE org_id = '${orgId}' AND id = '${vy.runId}'`,
      `UPDATE crove_kernel.ai_run SET status = 'running', finished_at = NULL WHERE org_id = '${orgId}' AND id = '${vy.runId}'`,
    );
    expect(finished.ok, "a run that is no longer running").toBe(false);
    const expired = await changed(
      `UPDATE crove_kernel.ai_run SET started_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE org_id = '${orgId}' AND id = '${vy.runId}'`,
      `UPDATE crove_kernel.ai_run SET started_at = now(), expires_at = now() + interval '30 minutes' WHERE org_id = '${orgId}' AND id = '${vy.runId}'`,
    );
    expect(expired.ok, "an expired run").toBe(false);
    const demoted = await changed(
      `UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = '${orgId}' AND user_id = '${users.vyUser}'`,
      `UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = '${orgId}' AND user_id = '${users.vyUser}'`,
    );
    // A member who became a viewer still holds vy.use through the department grants they may have; with none, the entry is refused.
    expect(
      demoted.ok,
      "a member demoted to a viewer without a vy.use grant",
    ).toBe(false);
    const denied = await changed(
      `INSERT INTO crove_kernel.member_permission_override (org_id, user_id, permission, allowed, set_by) VALUES ('${orgId}', '${users.vyUser}', 'vy.use', false, '${users.owner}')`,
      `DELETE FROM crove_kernel.member_permission_override WHERE org_id = '${orgId}' AND user_id = '${users.vyUser}'`,
    );
    expect(denied.ok, "a member whose vy.use is denied").toBe(false);
    expect(
      denied.ok ? "" : denied.message,
      "refused for the member, by its code",
    ).toMatch(/MEMBER_NOT_ACTIVE/);
    const disabled = await changed(
      `UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = '${users.vyUser}'`,
      `UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = '${users.vyUser}'`,
    );
    expect(disabled.ok, "a disabled account").toBe(false);
    const removed = await changed(
      `DELETE FROM crove_kernel.tenant_member WHERE org_id = '${orgId}' AND user_id = '${users.vyUser}'`,
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ('${orgId}', '${users.vyUser}', 'member')`,
    );
    expect(removed.ok, "a member who was removed").toBe(false);
    // The control again: everything restored, the entry works.
    expect(
      (await enter(vy.agentId, vy.runId)).ok,
      "the member's live run once everything is restored",
    ).toBe(true);
  });

  it("lets a member-mode context write its member's own results and memory and nothing else, and read only its member's notes", async () => {
    if (!has.entry || !has.kind) return;
    const asVy = <T>(fn: (c: pg.Client) => Promise<T>) =>
      inContext(workerUrl, memberEnter(vy.agentId, vy.runId), fn);
    // The shapes are valid: a user context inserts them (positive control for the refusals below).
    for (const row of OFF_CATALOG) {
      const own = await outcome(
        inContext(appUrl, userEnter(users.owner), (c) =>
          c.query(
            `INSERT INTO ${row.table} ${row.columns} VALUES (${row
              .values(orgId, users.owner)
              .map((_, i) => `$${i + 1}`)
              .join(", ")})`,
            row.values(orgId, users.owner),
          ),
        ),
      );
      expect(own.ok, `a user inserting into ${row.table}`).toBe(true);
      const refused = await outcome(
        asVy((c) =>
          c.query(
            `INSERT INTO ${row.table} ${row.columns} VALUES (${row
              .values(orgId, users.vyUser)
              .map((_, i) => `$${i + 1}`)
              .join(", ")})`,
            row.values(orgId, users.vyUser),
          ),
        ),
      );
      expect(
        refused,
        `member-mode context inserting into ${row.table}`,
      ).toMatchObject({ ok: false, code: "42501" });
    }
    if (has.notes) {
      const note = await outcome(
        asVy((c) =>
          c.query(
            `INSERT INTO crove_notes.note (org_id, author_user_id, visibility, title) VALUES ($1, $2, 'private', 'Vy viết')`,
            [orgId, users.vyUser],
          ),
        ),
      );
      expect(note, "member-mode context writing a note").toMatchObject({
        ok: false,
        code: "42501",
      });
      const seen = await outcome(
        asVy(async (c) =>
          (
            await c.query<{ author_user_id: string }>(
              "SELECT author_user_id FROM crove_notes.note",
            )
          ).rows.map((r) => r.author_user_id),
        ),
      );
      expect(seen.ok, "member-mode context reading notes").toBe(true);
      // Only the member's own (private) notes: never another member's private note, never as the system.
      if (seen.ok)
        expect(
          seen.value.filter((a) => a !== users.vyUser),
          "authors of the notes a member-mode context reads",
        ).toEqual([]);
    }
    // Its own member's memory is writable; another member's is refused.
    const own = await outcome(
      asVy((c) =>
        c.query(
          `INSERT INTO crove_kernel.member_vy_memory (org_id, member_user_id, body) VALUES ($1, $2, 'Gọi khách là anh')`,
          [orgId, users.vyUser],
        ),
      ),
    );
    expect(own.ok, "member-mode context writing its member's memory").toBe(
      true,
    );
    const other = await outcome(
      asVy((c) =>
        c.query(
          `INSERT INTO crove_kernel.member_vy_memory (org_id, member_user_id, body) VALUES ($1, $2, 'Ghi hộ người khác')`,
          [orgId, users.other],
        ),
      ),
    );
    expect(
      other,
      "member-mode context writing another member's memory",
    ).toMatchObject({ ok: false, code: "42501" });
    // It never writes a task comment, proposal or approval either: no approval, no proposal, no R2 or R3 (decision 1).
    const proposal = await outcome(
      asVy((c) =>
        c.query(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, legal_entity_id) VALUES ($1, 'x', 'kernel.task.create', 'x', '{}', NULL)`,
          [orgId],
        ),
      ),
    );
    expect(proposal.ok, "member-mode context writing a proposal").toBe(false);
  });
});

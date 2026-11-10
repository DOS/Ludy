// SPDX-License-Identifier: AGPL-3.0-only
// The runtime side of Vy in member mode (ADR-0049, #2756): the member-scoped agent actor enters through enter_member_vy_context, a command or
// query runs for it only when it declares memberVy and its `access` also admits the member's base role, R0 or R1 only, and the rows the
// runtime writes for it pass the write guard. The database cases are in test/invariant/member-vy-background.db.test.ts.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "@crove/db";
import { migrate, setRolePasswords } from "@crove/db/migrate";
import { createOrg, kernelCommands, upsertIdentity } from "@crove/kernel";
import {
  Runtime,
  defineCommand,
  defineQuery,
  memberVyRuntime,
  type CommandDef,
  type QueryDef,
} from "@crove/kernel-runtime";
import { TEST_MANIFESTS } from "./invariant/fixtures/manifests.ts";
import { contextToken } from "./invariant/fixtures/context-token.ts";

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(
  new URL("../../../supabase/migrations", import.meta.url),
);
const suite = ADMIN ? describe : describe.skip;
const ALL = ["owner", "admin", "member", "viewer"] as const;

const cmd = (
  name: string,
  def: Partial<CommandDef<unknown, unknown>>,
  handler: CommandDef<unknown, unknown>["handler"],
): CommandDef<unknown, unknown> =>
  defineCommand({
    sideEffect: "none",
    name,
    input: z.object({}),
    risk: "R1",
    access: ALL,
    writes: [],
    handler,
    ...def,
  }) as CommandDef<unknown, unknown>;
const memberVy = { taint: "propagate" as const };
// Handlers of the commands and queries a member-mode run must be refused before: each counts its runs, so a refusal is shown to come before
// the handler, not from it (#2822).
const handled: Record<string, number> = {};
const counted = (name: string) => () => {
  handled[name] = (handled[name] ?? 0) + 1;
  return Promise.resolve({ ok: true });
};
const COMMANDS = [
  // The audit row of a member-mode command names a command from a short list (#2822 part 3a), so the two commands that succeed here carry the names of the
  // two real member-mode commands; this one audits ids too, which the audit test below reads.
  cmd("kernel.member_vy.result.store", { memberVy }, async (ctx) => {
    ctx.audit({ resultId: randomUUID(), status: "ready", bodyLength: 3 });
    return {
      actor: ctx.actor,
      member: ctx.memberVy,
      agent: ctx.agent,
      role: ctx.role,
    };
  }),
  cmd("kernel.member_vy.t_undeclared", { risk: "R0" }, async () => ({
    ok: true,
  })),
  cmd(
    "kernel.member_vy.t_owner_only",
    { access: ["owner"], memberVy },
    counted("kernel.member_vy.t_owner_only"),
  ),
  // A role list that admits no member role at all: member mode never runs it, whatever the member's role.
  cmd(
    "kernel.member_vy.t_no_role",
    { access: [], memberVy },
    counted("kernel.member_vy.t_no_role"),
  ),
  cmd(
    "kernel.member_vy.meeting_audio.open",
    { access: ["owner", "admin", "member"], memberVy },
    counted("kernel.member_vy.meeting_audio.open"),
  ),
  cmd("kernel.member_vy.t_audit_text", { memberVy }, async (ctx) => {
    ctx.audit({ summary: "Tóm tắt riêng: khách đề nghị giảm giá 12%" });
    return { ok: true };
  }),
];
// The two test commands that carry real names (the audit list names them) stand in for the real ones in this test's runtimes.
const TEST_NAMES = new Set(COMMANDS.map((c) => c.name));
const query = (
  name: string,
  def: Partial<QueryDef<unknown, unknown>>,
): QueryDef<unknown, unknown> =>
  defineQuery({
    name,
    input: z.object({}),
    access: ALL,
    handler: async (ctx) => ({ member: ctx.memberVy?.memberUserId ?? null }),
    ...def,
  }) as QueryDef<unknown, unknown>;
const QUERIES = [
  query("kernel.member_vy.t_q", { memberVy: {} }),
  // A declared query whose access leaves the member's role out (#2822): the same rule as for commands.
  query("kernel.member_vy.t_q_owner_only", {
    access: ["owner"],
    memberVy: {},
    handler: counted("kernel.member_vy.t_q_owner_only"),
  }),
  query("kernel.member_vy.t_q_undeclared", {}),
  query("kernel.member_vy.t_q_iso", {
    memberVy: {},
    handler: async (ctx) => ({
      isolation: (
        await sql<{
          v: string;
        }>`SELECT current_setting('transaction_isolation') AS v`.execute(
          ctx.trx,
        )
      ).rows[0]?.v,
      readOnly: (
        await sql<{
          v: string;
        }>`SELECT current_setting('transaction_read_only') AS v`.execute(
          ctx.trx,
        )
      ).rows[0]?.v,
    }),
  }),
];

suite("member-scoped agent actor in the runtime", () => {
  const dbName = `crove_test_member_vy_rt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = "";
  let appUrl = "";
  let workerUrl = "";
  const pools: pg.Pool[] = [];
  let orgId = "";
  let owner = "";
  let worker: Runtime;
  // The worker with the real kernel commands only, for the test that runs the real member-mode store.
  let realWorker: Runtime;
  let app: Runtime;
  const users: Record<string, string> = {};
  const vy: Record<string, { agentId: string; runId: string }> = {};

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  async function makeVy(
    user: string,
  ): Promise<{ agentId: string; runId: string }> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT crove_kernel.enter_user_context($1::uuid, $2::text)",
        [orgId, contextToken(user, orgId)],
      );
      const agentId = randomUUID();
      const runId = randomUUID();
      await c.query(
        `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
        [orgId, agentId, user],
      );
      await c.query(
        `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'notes', 'running', true, now(), now() + interval '30 minutes')`,
        [orgId, runId, agentId],
      );
      await c.query("COMMIT");
      return { agentId, runId };
    } finally {
      await c.end();
    }
  }
  const run = (who: string) =>
    memberVyRuntime(
      worker,
      orgId,
      vy[who] as { agentId: string; runId: string },
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
    const appPool = createPool({ connectionString: appUrl, max: 2 });
    const workerPool = createPool({ connectionString: workerUrl, max: 4 });
    pools.push(appPool, workerPool);
    const appDb = createDb(appPool);
    worker = new Runtime(createDb(workerPool), {
      manifests: TEST_MANIFESTS,
    }).register({
      commands: [...COMMANDS, ...kernelCommands.filter((c) => !TEST_NAMES.has(c.name))],
      queries: QUERIES,
    });
    realWorker = new Runtime(createDb(workerPool), {
      manifests: TEST_MANIFESTS,
    }).register({ commands: [...kernelCommands], queries: [] });
    app = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands],
      queries: [],
    });
    for (const key of ["owner", "member", "viewer"]) {
      users[key] = await upsertIdentity(appDb, {
        issuer: "member-vy-rt",
        subject: key,
        email: `${key}@member-vy-rt.test`,
        name: null,
      });
    }
    owner = users.owner as string;
    orgId = (
      await createOrg(
        app,
        { type: "user", userId: owner, aal: "aal1" },
        "Vy runtime",
      )
    ).orgId;
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`,
        [orgId, users.member, users.viewer],
      );
      // A viewer holds vy.use only through a grant (ADR-0049 decision 10).
      await c.query(
        `INSERT INTO crove_kernel.member_permission_override (org_id, user_id, permission, allowed, set_by) VALUES ($1, $2, 'vy.use', true, $3)`,
        [orgId, users.viewer, owner],
      );
    });
    vy.member = await makeVy(users.member as string);
    vy.viewer = await makeVy(users.viewer as string);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("runs a declared command as the member-scoped actor, with the member's grant and no org-chart grant", async () => {
    const facade = run("member");
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade).sort()).toEqual([
      "agentId",
      "execute",
      "orgId",
      "query",
      "runId",
    ]);
    const out = await facade.execute<{
      actor: unknown;
      member: Record<string, unknown>;
      agent: unknown;
      role: unknown;
    }>("kernel.member_vy.result.store", {});
    expect(out.actor).toEqual({
      type: "agent",
      agentId: vy.member?.agentId,
      runId: vy.member?.runId,
      memberVy: true,
    });
    expect(out.agent, "no org-chart grant").toBeNull();
    expect(out.role, "no user role either").toBeNull();
    expect(out.member).toMatchObject({
      memberUserId: users.member,
      role: "member",
      module: "notes",
      tainted: true,
    });
    expect(["R0", "R1"]).toContain(out.member.maxRisk);
  });

  it("refuses a command that does not declare memberVy, one whose access leaves the member's role out, and a viewer on a members-only one", async () => {
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => "ran",
        (e: { code?: string; details?: { rule?: string } }) =>
          `${e.code}:${e.details?.rule}`,
      );
    expect(
      await refused(run("member").execute("kernel.member_vy.t_undeclared", {})),
      "no declaration",
    ).toBe("FORBIDDEN:member_vy_access");
    expect(
      await refused(run("member").execute("kernel.member_vy.t_owner_only", {})),
      "a member on an owner-only command",
    ).toBe("FORBIDDEN:member_vy_role");
    expect(
      await refused(
        run("member").execute("kernel.member_vy.meeting_audio.open", {}),
      ),
      "a member on a members command",
    ).toBe("ran");
    // A viewer who was given vy.use runs no command a viewer cannot run.
    expect(
      await refused(
        run("viewer").execute("kernel.member_vy.meeting_audio.open", {}),
      ),
      "a viewer on a members-only command",
    ).toBe("FORBIDDEN:member_vy_role");
    expect(
      await refused(run("viewer").execute("kernel.member_vy.result.store", {})),
      "a viewer on a command open to viewers",
    ).toBe("ran");
  });

  it("refuses a declared command or query whose access does not admit the member's own role, before its handler runs (#2822)", async () => {
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => "ran",
        (e: { code?: string; details?: { rule?: string } }) =>
          `${e.code}:${e.details?.rule}`,
      );
    for (const name of Object.keys(handled)) delete handled[name];
    // Commands: an owner-only one for a member and a viewer, an empty role list for both, and a list without viewer for the viewer.
    for (const [who, name] of [
      ["member", "kernel.member_vy.t_owner_only"],
      ["viewer", "kernel.member_vy.t_owner_only"],
      ["member", "kernel.member_vy.t_no_role"],
      ["viewer", "kernel.member_vy.t_no_role"],
      ["viewer", "kernel.member_vy.meeting_audio.open"],
    ] as const) {
      expect(await refused(run(who).execute(name, {})), `the ${who}'s Vy running ${name}`).toBe(
        "FORBIDDEN:member_vy_role",
      );
    }
    // The control: a declared command whose list holds the member's role runs, and its handler counts (a real member-mode command name, since
    // the audit row of a member-mode command names a listed command).
    expect(
      await refused(run("member").execute("kernel.member_vy.meeting_audio.open", {})),
      "the member's Vy running a command whose access admits members (the control)",
    ).toBe("ran");
    // Queries: an owner-only declared query for a member and a viewer.
    for (const who of ["member", "viewer"] as const) {
      expect(
        await refused(run(who).query("kernel.member_vy.t_q_owner_only", {})),
        `the ${who}'s Vy reading an owner-only query`,
      ).toBe("FORBIDDEN:member_vy_access");
    }
    // No refused handler ran; only the control did, once.
    expect(handled, "the handlers that ran").toEqual({
      "kernel.member_vy.meeting_audio.open": 1,
    });
  });

  it("reads only a query that declares memberVy", async () => {
    expect(await run("member").query("kernel.member_vy.t_q", {})).toEqual({
      member: users.member,
    });
    await expect(
      run("member").query("kernel.member_vy.t_q_undeclared", {}),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { rule: "member_vy_access" },
    });
  });

  it("reads a member-mode query in one REPEATABLE READ, READ ONLY snapshot", async () => {
    expect(await run("member").query("kernel.member_vy.t_q_iso", {})).toEqual({
      isolation: "repeatable read",
      readOnly: "on",
    });
  });

  it("refuses at registration a memberVy command at R2 or with a system access, and a memberVy query with a system access", () => {
    const db = createDb(pools[0] as pg.Pool);
    const make = () => new Runtime(db, { manifests: TEST_MANIFESTS });
    expect(() =>
      make().register({
        commands: [
          cmd(
            "kernel.member_vy.t_r2",
            { risk: "R2", memberVy },
            async () => ({}),
          ),
        ],
      }),
    ).toThrow(/R0 or R1/);
    expect(() =>
      make().register({
        commands: [
          cmd(
            "kernel.member_vy.t_sys",
            { access: "system", memberVy },
            async () => ({}),
          ),
        ],
      }),
    ).toThrow(/role list/);
    expect(() =>
      make().register({
        commands: [
          cmd(
            "kernel.member_vy.t_nowrites",
            { writes: undefined as never, memberVy },
            async () => ({}),
          ),
        ],
      }),
    ).toThrow(/declares its writes/);
    expect(() =>
      make().register({
        queries: [
          query("kernel.member_vy.t_qsys", { access: "system", memberVy: {} }),
        ],
      }),
    ).toThrow(/role list/);
    expect(() =>
      make().register({
        queries: [
          query("kernel.member_vy.t_qstream", { stream: true, memberVy: {} }),
        ],
      }),
    ).toThrow(/streamed/);
  });

  it("writes the audit row of a member-mode command with ids, enums and numbers, and refuses one with text", async () => {
    await run("member").execute("kernel.member_vy.result.store", {});
    const rows = await admin((c) =>
      c.query<{
        actor_type: string;
        actor_id: string;
        detail: Record<string, unknown>;
      }>(
        `SELECT actor_type, actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member_vy.result.store' AND outcome = 'ok'`,
        [orgId],
      ),
    );
    expect(rows.rows[0]).toMatchObject({
      actor_type: "agent",
      actor_id: vy.member?.agentId,
      detail: { agentRun: vy.member?.runId, status: "ready", bodyLength: 3 },
    });
    // Text in the detail is refused by the write guard, so the command fails and no row of it is kept.
    await expect(
      run("member").execute("kernel.member_vy.t_audit_text", {}),
    ).rejects.toBeDefined();
    const text = await admin((c) =>
      c.query(
        `SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member_vy.t_audit_text' AND outcome = 'ok'`,
        [orgId],
      ),
    );
    expect(text.rowCount).toBe(0);
  });

  it("is refused by the database for a wrong flag, a member who left and another org", async () => {
    const plain = {
      type: "agent" as const,
      agentId: vy.member?.agentId as string,
      runId: vy.member?.runId as string,
    };
    // A member's Vy through the org-chart entry (the flag left off), and an unknown agent through the member entry.
    await expect(
      worker.execute("kernel.member_vy.result.store", {}, { actor: plain, orgId }),
    ).rejects.toBeDefined();
    await expect(
      worker.execute(
        "kernel.member_vy.result.store",
        {},
        { actor: { ...plain, agentId: randomUUID(), memberVy: true }, orgId },
      ),
    ).rejects.toBeDefined();
    // The member's agent named in another org.
    await expect(
      worker.execute(
        "kernel.member_vy.result.store",
        {},
        { actor: { ...plain, memberVy: true }, orgId: randomUUID() },
      ),
    ).rejects.toBeDefined();
    // A removed member's run enters no more.
    await admin((c) =>
      c.query(
        `DELETE FROM crove_kernel.member_permission_override WHERE org_id = $1 AND user_id = $2`,
        [orgId, users.viewer],
      ),
    );
    await expect(
      run("viewer").execute("kernel.member_vy.result.store", {}),
    ).rejects.toBeDefined();
  });

  it("stores a result in the background through the real store command, writing the result alone and leaving the run for the worker to close", async () => {
    // The member asks in their own session: run.start makes the run and its waiting result, as in stage A.
    const memberActor = {
      type: "user" as const,
      userId: users.member as string,
      aal: "aal1" as const,
    };
    const started = await app.execute<{ runId: string; resultId: string }>(
      "kernel.member_vy.run.start",
      {
        feature: "notes.summary",
        subjectType: "note",
        subjectId: randomUUID(),
      },
      { actor: memberActor, orgId },
    );
    const agentId = await admin(
      async (c) =>
        (
          await c.query<{ agent_id: string }>(
            "SELECT agent_id FROM crove_kernel.ai_run WHERE id = $1",
            [started.runId],
          )
        ).rows[0]?.agent_id as string,
    );
    const facade = memberVyRuntime(realWorker, orgId, {
      agentId,
      runId: started.runId,
    });
    // The store takes the run the context was sealed for and no other run, not even of the same member.
    await expect(
      facade.execute("kernel.member_vy.result.store", {
        runId: randomUUID(),
        outcome: { status: "ready", body: "x" },
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { rule: "member_vy_context" },
    });
    const stored = await facade.execute<{ stored: boolean; status: string }>(
      "kernel.member_vy.result.store",
      {
        runId: started.runId,
        outcome: { status: "ready", body: "Tóm tắt riêng của thành viên" },
      },
    );
    expect(stored).toEqual({ stored: true, status: "ready" });
    // The result is written, tainted and private; the run is still running, because a member-mode context never writes ai_run.
    const rows = await admin(async (c) => ({
      result: (
        await c.query<{
          status: string;
          tainted: boolean;
          private_read: boolean;
        }>(
          "SELECT status, tainted, private_read FROM crove_kernel.member_vy_result WHERE id = $1",
          [started.resultId],
        )
      ).rows[0],
      run: (
        await c.query<{ status: string }>(
          "SELECT status FROM crove_kernel.ai_run WHERE id = $1",
          [started.runId],
        )
      ).rows[0],
      audit: (
        await c.query<{ actor_type: string; detail: Record<string, unknown> }>(
          `SELECT actor_type, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member_vy.result.store' AND outcome = 'ok'`,
          [orgId],
        )
      ).rows[0],
    }));
    expect(rows.result).toEqual({
      status: "ready",
      tainted: true,
      private_read: true,
    });
    expect(rows.run).toEqual({ status: "running" });
    expect(rows.audit).toMatchObject({
      actor_type: "agent",
      detail: {
        runId: started.runId,
        resultId: started.resultId,
        status: "ready",
        bodyLength: 28,
      },
    });
    // The text is in no audit row.
    expect(JSON.stringify(rows.audit)).not.toContain("Tóm tắt");
    // The worker closes the run afterwards, in the system context.
    const closed = await admin(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("SELECT crove_kernel.enter_system_context($1::uuid)", [
          orgId,
        ]);
        await c.query("SET LOCAL ROLE crove_worker");
        return (
          await c.query<{ r: boolean }>(
            `SELECT crove_kernel.member_vy_run_finish($1::uuid, 'succeeded', NULL) AS r`,
            [started.runId],
          )
        ).rows[0]?.r;
      } finally {
        await c.query("ROLLBACK");
      }
    });
    expect(closed, "the worker closes a run whose result is ready").toBe(true);
    // A second store of the same run finds it no longer waiting.
    await expect(
      facade.execute("kernel.member_vy.result.store", {
        runId: started.runId,
        outcome: { status: "ready", body: "lần hai" },
      }),
    ).rejects.toMatchObject({ code: "VY_RUN_NOT_LIVE" });
  });

  it("sends the stream hints of a member-mode run to its member alone: the real background store sends none, and a member's own hint is heard (#2822)", async () => {
    // A listener on the stream channel, as the kernel's LISTEN connection is. Notifications are delivered in commit order, so a marker sent
    // after a step and heard back closes that step: every hint the step sent arrived before it.
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (n) => {
      if (n.channel === "crove_stream") heard.push(n.payload ?? "");
    });
    await listener.query("LISTEN crove_stream");
    const settle = async () => {
      const marker = `marker ${randomUUID()}`;
      await admin((c) => c.query("SELECT pg_notify('crove_stream', $1)", [marker]));
      const deadline = Date.now() + 10_000;
      while (!heard.includes(marker)) {
        if (Date.now() > deadline) throw new Error("the stream marker never arrived");
        await new Promise((r) => setTimeout(r, 20));
      }
      const before = heard.slice(0, heard.indexOf(marker));
      heard.length = 0;
      return before;
    };
    try {
      const member = users.member as string;
      const started = await app.execute<{ runId: string; resultId: string }>(
        "kernel.member_vy.run.start",
        { feature: "notes.summary", subjectType: "note", subjectId: randomUUID() },
        { actor: { type: "user", userId: member, aal: "aal1" }, orgId },
      );
      const agentId = await admin(
        async (c) =>
          (
            await c.query<{ agent_id: string }>("SELECT agent_id FROM crove_kernel.ai_run WHERE id = $1", [started.runId])
          ).rows[0]?.agent_id as string,
      );
      await settle();
      // The member-mode part: the background store of the run's result, through the real command and the worker login.
      const stored = await memberVyRuntime(realWorker, orgId, { agentId, runId: started.runId }).execute<{ stored: boolean; status: string }>(
        "kernel.member_vy.result.store",
        { runId: started.runId, outcome: { status: "ready", body: "Tóm tắt riêng của thành viên" } },
      );
      expect(stored, "the store ran (the positive control of the write)").toEqual({ stored: true, status: "ready" });
      const fromRun = await settle();
      // The rule: any hint the run sends is addressed to its member (a member's own rows carry " @<user>", as the note, to-do and
      // notification hints do), never org-wide and never to another member.
      expect(
        fromRun.filter((h) => !h.startsWith(`${orgId} `) || !h.split("+")[0]?.endsWith(` @${member}`)),
        "hints of the member-mode run not addressed to its member alone",
      ).toEqual([]);
      // Today the run's writes (its result; its audit row) send none at all: a hint added later is reviewed here.
      expect(fromRun, "the hints of the member-mode store").toEqual([]);
      // The control: a member's own row does send a hint, addressed to that member, and this listener hears it.
      const noteId = randomUUID();
      await admin((c) =>
        c.query(
          `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body, tags) VALUES ($1, $2, $3, 'private', 'Của tôi', 'riêng', '{}')`,
          [orgId, noteId, member],
        ),
      );
      expect(await settle(), "a member's own note hint (the control)").toEqual([`${orgId} note ${noteId} @${member}`]);
    } finally {
      await listener.end();
    }
  });
});

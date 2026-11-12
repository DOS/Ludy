// SPDX-License-Identifier: AGPL-3.0-only
// How the run of a member's background Vy is closed (ADR-0049 stage B, #2756): by the worker, in the system context, through
// member_vy_run_finish, after the member-mode store wrote the result. The member-mode context never touches ai_run (pinned in
// member-vy-background.db.test.ts). Looked up first and run only when the function exists, so this passes on a database without it.
// Part of the invariant suite; imports package code under test, never helpers from outside test/invariant/.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "@crove/db";
import { migrate, setRolePasswords } from "@crove/db/migrate";
import { createOrg, kernelCommands, upsertIdentity } from "@crove/kernel";
import { Runtime } from "@crove/kernel-runtime";
import { TEST_MANIFESTS } from "./fixtures/manifests.ts";
import { contextToken } from "./fixtures/context-token.ts";
import { aiRunFeature, type AiRunFeature } from "./fixtures/ai-run-feature.ts";

// The extra column of an ai_run seed once the table has `feature` (#3029); empty before.
let FEAT: AiRunFeature = { cols: "", vals: "" };

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(
  new URL("../../../../supabase/migrations", import.meta.url),
);
const suite = ADMIN ? describe : describe.skip;
const FN = "crove_kernel.member_vy_run_finish(uuid,text,text)";

suite("closing the run of a member's Vy (ADR-0049, #2756)", () => {
  const dbName = `crove_test_member_vy_fin_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = "";
  let appUrl = "";
  let workerUrl = "";
  const pools: pg.Pool[] = [];
  let orgId = "";
  let otherOrg = "";
  let owner = "";
  let member = "";
  let has = false;
  let agentId = "";

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
  const systemEnter =
    (org = orgId) =>
    (c: pg.Client) =>
      c.query("SELECT crove_kernel.enter_system_context($1::uuid)", [org]);
  const finish = (
    run: string,
    status: string | null,
    code: string | null,
    enter: (c: pg.Client) => Promise<unknown> = systemEnter(),
    url = () => workerUrl,
  ) =>
    outcome(
      inContext(
        url(),
        enter,
        async (c) =>
          (
            await c.query<{ r: boolean }>(
              "SELECT crove_kernel.member_vy_run_finish($1::uuid, $2::text, $3::text) AS r",
              [run, status, code],
            )
          ).rows[0]?.r,
        true,
      ),
    );
  // A running run of the member's Vy with its result row, made as the superuser with the bind triggers on.
  async function runWith(resultStatus: "running" | "ready" | "failed") {
    const runId = randomUUID();
    await admin(async (c) => {
      // One running run per agent: an earlier case's run is put away first.
      await c.query(
        `UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND agent_id = $2 AND status = 'running'`,
        [orgId, agentId],
      );
      await c.query("SET session_replication_role = replica");
      await c.query(
        `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at${FEAT.cols}) VALUES ($1, $2, $3, 'notes', 'running', true, now(), now() + interval '30 minutes'${FEAT.vals})`,
        [orgId, runId, agentId],
      );
      await c.query("SET session_replication_role = DEFAULT");
      await c.query(
        `INSERT INTO crove_kernel.member_vy_result (org_id, member_user_id, run_id, feature, subject_type, subject_id, status, body, error_code, tainted, private_read, expires_at)
         VALUES ($1, $2, $3, 'notes.summary', 'note', $4, $5, CASE WHEN $5 = 'ready' THEN 'x' END, CASE WHEN $5 = 'failed' THEN 'AI_STOPPED' END, true, true, now() + interval '30 minutes')`,
        [orgId, member, runId, randomUUID(), resultStatus],
      );
    });
    return runId;
  }
  const runRow = (run: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ status: string; error: string | null }>(
            "SELECT status, error FROM crove_kernel.ai_run WHERE id = $1",
            [run],
          )
        ).rows[0],
    );
  const resultRow = (run: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ status: string; error_code: string | null }>(
            "SELECT status, error_code FROM crove_kernel.member_vy_result WHERE run_id = $1",
            [run],
          )
        ).rows[0],
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
    FEAT = await admin((c) => aiRunFeature(c));
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
    const pool = createPool({ connectionString: appUrl, max: 2 });
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands],
      queries: [],
    });
    owner = await upsertIdentity(db, {
      issuer: "member-vy-fin",
      subject: "owner",
      email: "owner@member-vy-fin.test",
      name: null,
    });
    member = await upsertIdentity(db, {
      issuer: "member-vy-fin",
      subject: "member",
      email: "member@member-vy-fin.test",
      name: null,
    });
    orgId = (
      await createOrg(
        runtime,
        { type: "user", userId: owner, aal: "aal1" },
        "Vy kết thúc",
      )
    ).orgId;
    otherOrg = (
      await createOrg(
        runtime,
        { type: "user", userId: member, aal: "aal1" },
        "Công ty khác",
      )
    ).orgId;
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`,
        [orgId, member],
      );
      has =
        (
          await c.query<{ ok: boolean }>(
            `SELECT to_regprocedure('${FN}') IS NOT NULL AS ok`,
          )
        ).rows[0]?.ok === true;
      if (!has) throw new Error(`${FN} is missing: the presence pin below names it`);
      agentId = randomUUID();
      // The binding triggers need the member's own context; this fixture sets them aside for the agent row alone.
      await c.query("SET session_replication_role = replica");
      await c.query(
        `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
        [orgId, agentId, member],
      );
      await c.query("SET session_replication_role = DEFAULT");
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });


  // The presence pin (#2822): the function the cases below call is there, so none of them can pass by finding nothing to check (they once skipped when it was missing).
  it("finds the function the cases below rest on", () => {
    expect(has, `${FN} exists`).toBe(true);
  });

  it("is pinned: a definer with a fixed search_path that only the worker login may execute", async () => {
    const { rows } = await admin((c) =>
      c.query<{ definer: boolean; config: string[]; callers: string[] }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config,
                ARRAY(SELECT r FROM unnest(ARRAY['crove_app', 'crove_tenant', 'crove_definer_tenant', 'crove_worker']) r WHERE has_function_privilege(r, p.oid, 'EXECUTE')) AS callers
         FROM pg_proc p WHERE p.oid = to_regprocedure('${FN}')`,
      ),
    );
    expect(rows[0]).toEqual({
      definer: true,
      config: ["search_path=pg_catalog, pg_temp"],
      callers: ["crove_worker"],
    });
  });

  it("closes a run as the worker in the system context: succeeded with a ready result, failed or cancelled with a fixed code", async () => {
    const ok = await runWith("ready");
    expect((await finish(ok, "succeeded", null)).ok, "a ready result").toBe(
      true,
    );
    expect(await runRow(ok)).toMatchObject({
      status: "succeeded",
      error: null,
    });
    const stopped = await runWith("failed");
    expect(await finish(stopped, "failed", "AI_STOPPED")).toMatchObject({
      ok: true,
      value: true,
    });
    expect(await runRow(stopped)).toMatchObject({
      status: "failed",
      error: "AI_STOPPED",
    });
    // A run cancelled before its text arrived fails its waiting result with the same code.
    const waiting = await runWith("running");
    expect(await finish(waiting, "cancelled", "RUN_CANCELLED")).toMatchObject({
      ok: true,
      value: true,
    });
    expect(await runRow(waiting)).toMatchObject({
      status: "cancelled",
      error: "RUN_CANCELLED",
    });
    expect(await resultRow(waiting)).toMatchObject({
      status: "failed",
      error_code: "RUN_CANCELLED",
    });
  });

  it("refuses every other caller: the API login, a user, an agent and a member-mode context, another org, and no context", async () => {
    const run = await runWith("ready");
    const forbidden = { ok: false, code: "42501" };
    expect(
      await finish(
        run,
        "succeeded",
        null,
        async () => {},
        () => workerUrl,
      ),
      "the worker with no context",
    ).toMatchObject(forbidden);
    expect(
      await finish(
        run,
        "succeeded",
        null,
        (c) =>
          c.query(
            "SELECT crove_kernel.enter_user_context($1::uuid, $2::text)",
            [orgId, contextToken(member, orgId)],
          ),
        () => appUrl,
      ),
      "the member itself",
    ).toMatchObject(forbidden);
    expect(
      await finish(
        run,
        "succeeded",
        null,
        (c) =>
          c.query(
            "SELECT crove_kernel.enter_user_context($1::uuid, $2::text)",
            [orgId, contextToken(owner, orgId)],
          ),
        () => appUrl,
      ),
      "an owner",
    ).toMatchObject(forbidden);
    const memberMode = await finish(run, "succeeded", null, (c) =>
      c.query(
        "SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)",
        [orgId, agentId, run],
      ),
    );
    expect(memberMode, "the member-mode context of the same run").toMatchObject(
      forbidden,
    );
    // The API login has no EXECUTE at all, whatever context it holds.
    expect(
      await finish(run, "succeeded", null, systemEnter(), () => appUrl),
      "the API login",
    ).toMatchObject(forbidden);
    // Another org's system context finds no such run: it answers false and changes nothing.
    expect(
      await finish(run, "succeeded", null, systemEnter(otherOrg)),
    ).toMatchObject({ ok: true, value: false });
    expect(await runRow(run)).toMatchObject({ status: "running" });
  });

  it("derives the status from the result when none is given, and takes only a code from the list (#2822 part 3)", async () => {
    // A ready result closes the run as succeeded, a failed one as failed with the code, whatever the caller would have said.
    const ready = await runWith("ready");
    expect((await finish(ready, null, null)).ok, "derived succeeded").toBe(true);
    expect(await runRow(ready)).toMatchObject({ status: "succeeded", error: null });
    const failed = await runWith("failed");
    expect((await finish(failed, null, "AI_STOPPED")).ok, "derived failed").toBe(true);
    expect(await runRow(failed)).toMatchObject({ status: "failed", error: "AI_STOPPED" });
    // A result still running is failed with the code, and the run beside it.
    const waiting = await runWith("running");
    expect((await finish(waiting, null, "TRANSCRIBE_FAILED")).ok, "derived failed over a running result").toBe(true);
    expect(await runRow(waiting)).toMatchObject({ status: "failed", error: "TRANSCRIBE_FAILED" });
    // Refused: derived succeeded with a code, derived failed with none, and a code shaped like one but not on the list. Each run is checked right after its
    // refusals: making the next run cancels the agent's other running runs (runWith), so a run is never checked after another is made.
    const shown = await runWith("ready");
    expect(await finish(shown, null, "AI_STOPPED"), "a ready result with a code").toMatchObject({ ok: false, code: "22023" });
    expect(await runRow(shown)).toMatchObject({ status: "running" });
    const open = await runWith("running");
    expect(await finish(open, null, null), "failed with no code").toMatchObject({ ok: false, code: "22023" });
    expect(await finish(open, "failed", "SOMETHING_ELSE_ENTIRELY"), "a well-formed code that is not listed").toMatchObject({ ok: false, code: "22023" });
    expect(await finish(open, null, "SOMETHING_ELSE_ENTIRELY"), "a derived status with a code that is not listed").toMatchObject({ ok: false, code: "22023" });
    expect(await runRow(open)).toMatchObject({ status: "running" });
  });

  it("refuses a status that disagrees with the result, a code with text, and answers false for a run that is no longer running", async () => {
    const waiting = await runWith("running");
    expect(
      (await finish(waiting, "succeeded", null)).ok,
      "succeeded without a ready result",
    ).toBe(false);
    for (const [why, status, code] of [
      ["an unknown status", "done", null],
      ["succeeded with a code", "succeeded", "X"],
      ["failed with no code", "failed", null],
      ["text as the code", "failed", "Tóm tắt riêng"],
      ["a lower-case code", "failed", "ai_stopped"],
    ] as const) {
      expect(await finish(waiting, status, code), why).toMatchObject({
        ok: false,
        code: "22023",
      });
    }
    expect(await runRow(waiting)).toMatchObject({ status: "running" });
    // A ready result stays beside a succeeded run only: failed or cancelled would leave the member a body the run says it never made.
    const shown = await runWith("ready");
    for (const status of ["failed", "cancelled"]) {
      expect(
        await finish(shown, status, "AI_STOPPED"),
        `${status} beside a ready result`,
      ).toMatchObject({ ok: false, code: "22023" });
    }
    expect(await runRow(shown)).toMatchObject({ status: "running" });
    const done = await runWith("ready");
    expect(await finish(done, "succeeded", null)).toMatchObject({
      ok: true,
      value: true,
    });
    expect(
      await finish(done, "failed", "AI_STOPPED"),
      "a run already closed",
    ).toMatchObject({ ok: true, value: false });
    expect(await runRow(done)).toMatchObject({ status: "succeeded" });
    // An org-chart agent's run is none of this definer's business.
    const orgChartRun = randomUUID();
    expect(await finish(orgChartRun, "failed", "AI_STOPPED")).toMatchObject({
      ok: true,
      value: false,
    });
  });
});

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
import { createDb } from "@ludy/db";
import { migrate } from "@ludy/db/migrate";
import {
  createOrg,
  kernelCommands,
  upsertIdentity,
  kernelQueries,
} from "@ludy/kernel";
import { Runtime } from "@ludy/kernel-runtime";
import { financeCommands, financeQueries } from "@ludy/mod-finance";
import { TEST_MANIFESTS } from "./fixtures/manifests.ts";
import { contextToken } from "./fixtures/context-token.ts";
import { aiRunFeature, type AiRunFeature } from "./fixtures/ai-run-feature.ts";
import { auditRoleFunctionExecute, createDbClient, createDbPool, rawQuery, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

// The extra column of an ai_run seed once the table has `feature` (#3029); empty before.
let FEAT: AiRunFeature = { cols: "", vals: "" };

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
// Five named restrictive read policies may read the sealed context once, to compare its kind with 'mcp_company' (#3731, #3858, #3771):
// `(SELECT <kernel>.ctx_verified() ->> 'kind') = 'mcp_company'`. That comparison (and for meeting_read only, the person-branch role list
// `ARRAY['owner', 'admin', 'member']`, whose string 'member' the net would otherwise take for a read of the sealed member) is set aside per
// exact `(schema.table, policyname)` entry. Eight named restrictive policies on the mail tables (#3956, #4564) may read the sealed context
// only via `pg_catalog.left(((SELECT <kernel>.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_'` (plus `source = 'kernel.conversation.reply'`
// on `mail_message.mcp_sealed_closed` FOR SELECT). Any other policy reading ctx_acting_user_id, ctx_verified (any schema prefix or bare), raw
// current_setting(...) on a sealed-context GUC (current ludy.* or legacy crove.*), pg_settings/pg_show_all_settings, any view/materialized view
// referencing them (transitively if views chain), or any non-standard SQL/PLpgSQL helper function called by a policy or view that reads them
// is flagged.
// Scope boundary: dynamic SQL inside PL/pgSQL EXECUTE that builds a function or GUC name by concatenating string fragments, custom aggregates
// (`prokind = 'a'`), custom operators (`pg_operator`), and postfix composite calls (`r.fn`) fall outside static `pg_depend` / body scanning;
// the 10 standard ctx_* field accessors (ctx_org_id, ctx_user_id, ctx_actor_type, ctx_agent_id, ctx_has_flag, ctx_le_scope, ctx_le_allowed,
// ctx_position_id, ctx_run_id, ctx_run_tainted) are excluded, and the 3 MCP helpers pinned in mcp-grant-read.db.test.ts and
// mcp-engage-write.db.test.ts (ctx_mcp_member_id, conversation_access_mcp_member, ctx_mcp_engage_write) are excluded only on the exact
// policies pinned to use them (calls from other policies, wrappers, or views are flagged).
const COMPANY_READ_POLICIES = [
  { t: "crove_kernel.conversation", n: "conversation_scope_read", allowRoleList: false },
  { t: "crove_kernel.conversation_message", n: "conversation_message_scope_read", allowRoleList: false },
  { t: "crove_meetings.action_item", n: "action_item_read", allowRoleList: false },
  { t: "crove_meetings.meeting", n: "meeting_read", allowRoleList: true },
  { t: "crove_meetings.meeting_result", n: "meeting_result_read", allowRoleList: false },
] as const;
const MCP_SEALED_CLOSED_POLICIES = [
  { t: "crove_kernel.inbound_message", n: "mcp_sealed_closed", cmd: "*", perm: false, expectedCount: 2, allowConversationReply: false },
  { t: "crove_kernel.mail_event", n: "mcp_sealed_closed", cmd: "*", perm: false, expectedCount: 2, allowConversationReply: false },
  { t: "crove_kernel.mail_message", n: "mcp_sealed_closed", cmd: "r", perm: false, expectedCount: 1, allowConversationReply: true },
  { t: "crove_kernel.mail_message", n: "mcp_sealed_closed_delete", cmd: "d", perm: false, expectedCount: 1, allowConversationReply: false },
  { t: "crove_kernel.mail_message", n: "mcp_sealed_closed_insert", cmd: "a", perm: false, expectedCount: 1, allowConversationReply: false },
  { t: "crove_kernel.mail_message", n: "mcp_sealed_closed_update", cmd: "w", perm: false, expectedCount: 2, allowConversationReply: false },
  { t: "crove_kernel.mail_suppression", n: "mcp_sealed_closed", cmd: "*", perm: false, expectedCount: 2, allowConversationReply: false },
  { t: "crove_kernel.today_mail", n: "mcp_sealed_closed", cmd: "*", perm: false, expectedCount: 2, allowConversationReply: false },
] as const;
const KIND_COMPARE = /\(\s*SELECT\s*\((?:crove|ludy)_kernel\.ctx_verified\(\) ->> 'kind'::text\)\s*\)\s*=\s*'mcp_company'::text/g;
const MCP_PREFIX_CLOSED =
  /"?left"?\(\(\(\s*SELECT\s*(?:crove|ludy)_kernel\.ctx_verified\(\)(?:\s+AS\s+ctx_verified)?\)\s*->>\s*'kind'::text\),\s*4\)\s+IS\s+DISTINCT\s+FROM\s+'mcp_'::text/g;
const CONVERSATION_REPLY_PRED = /source\s*=\s*'kernel\.conversation\.reply'::text/g;
const ROLE_LIST = /ARRAY\['owner'::text, 'admin'::text, 'member'::text\]/g;
const ACTING_USER_RE = /\bctx_acting_user_id\b/i;
const CTX_VERIFIED_RE = /\bctx_verified\b/i;
const CTX_VERIFIED_GLOBAL_RE = /\bctx_verified\b/gi;
const MEMBER_LITERAL_RE = /'\{?member\}?'/i;
const UNICODE_ESCAPE_RE = /\bU&["']/i;
const STD_STRINGS_RE = /\bstandard_conforming_strings\b/i;
const RAW_CTX_GUC_RE =
  /(?:crove|ludy)\.(?:ctx(?:_seal)?|org_id|user_id)(?![a-z0-9_])|\b(?:pg_settings|pg_show_all_settings)\b|"?current_setting"?\s*\(\s*(?!'[a-z0-9_]+(?:\.[a-z0-9_]+)?'(?:\s*::\s*text)?\s*(?:,|\)))/i;
const MCP_HELPER_RE = /\b(ctx_mcp_member_id|conversation_access_mcp_member|ctx_mcp_engage_write)\b/i;
const STANDARD_CTX_ACCESSORS = new Set([
  "ctx_org_id()",
  "ctx_user_id()",
  "ctx_actor_type()",
  "ctx_agent_id()",
  "ctx_has_flag(text)",
  "ctx_le_scope()",
  "ctx_le_allowed(uuid)",
  "ctx_position_id()",
  "ctx_run_id()",
  "ctx_run_tainted()",
]);
const PINNED_MCP_HELPER_POLICIES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  "ctx_mcp_member_id()": [
    ["crove_kernel.conversation", "conversation_scope_read"],
    ["crove_kernel.conversation_message", "conversation_message_scope_read"],
  ],
  "conversation_access_mcp_member(text,uuid)": [
    ["crove_kernel.conversation", "conversation_scope_read"],
    ["crove_kernel.conversation_message", "conversation_message_scope_read"],
  ],
  "ctx_mcp_engage_write()": [
    ["crove_crm.deal_next_step", "deal_next_step_update"],
    ["crove_crm.quote", "quote_insert"],
    ["crove_crm.quote", "quote_update"],
    ["crove_crm.quote_line", "quote_line_delete"],
    ["crove_crm.quote_line", "quote_line_insert"],
    ["crove_kernel.conversation", "conversation_scope_read"],
    ["crove_kernel.conversation", "conversation_scope_update"],
    ["crove_kernel.conversation_message", "conversation_message_scope_read"],
    ["crove_kernel.conversation_note", "conversation_note_scope"],
  ],
};

const SQL_IDENT_START_RE = /^[A-Za-z_\u0080-\uFFFF]/;
const SQL_IDENT_CONT_RE = /[A-Za-z0-9_$\u0080-\uFFFF]/;

function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }
    if (ch === '"') {
      out += ch;
      i++;
      while (i < sql.length) {
        const q = sql[i]!;
        out += q;
        i++;
        if (q === '"') {
          if (sql[i] === '"') {
            out += '"';
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }
    if ((ch === "e" || ch === "E") && next === "'" && (i === 0 || !SQL_IDENT_CONT_RE.test(sql[i - 1]!))) {
      out += `${ch}'`;
      i += 2;
      while (i < sql.length) {
        const s = sql[i]!;
        if (s === "\\" && i + 1 < sql.length) {
          out += s + sql[i + 1]!;
          i += 2;
          continue;
        }
        out += s;
        i++;
        if (s === "'") {
          if (sql[i] === "'") {
            out += "'";
            i++;
          } else {
            let k = i;
            let sawNewline = false;
            while (k < sql.length) {
              const ws = sql[k]!;
              if (ws === " " || ws === "\t" || ws === "\f" || ws === "\v") {
                k++;
              } else if (ws === "\n" || ws === "\r") {
                sawNewline = true;
                k++;
              } else if (ws === "-" && sql[k + 1] === "-") {
                k += 2;
                while (k < sql.length && sql[k] !== "\n" && sql[k] !== "\r") k++;
              } else {
                break;
              }
            }
            if (sawNewline && sql[k] === "'") {
              out += "\n'";
              i = k + 1;
            } else {
              break;
            }
          }
        }
      }
      continue;
    }
    if (SQL_IDENT_START_RE.test(ch)) {
      out += ch;
      i++;
      while (i < sql.length && SQL_IDENT_CONT_RE.test(sql[i]!)) {
        out += sql[i]!;
        i++;
      }
      continue;
    }
    if (ch === "'") {
      out += ch;
      i++;
      while (i < sql.length) {
        const s = sql[i]!;
        out += s;
        i++;
        if (s === "'") {
          if (sql[i] === "'") {
            out += "'";
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }
    if (ch === "$") {
      const tagMatch = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(sql.slice(i));
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
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const canonicalizeRelName = (name: string) =>
  name.replace(/^ludy_(kernel|meta|jobs|finance|hr|crm|social|ads|notes|projects|meetings|sign)\./, "crove_$1.");
const qualifiedOrClauseRefRe = (qualifiedName: string, clauseOnly = false) => {
  const dot = qualifiedName.indexOf(".");
  if (dot === -1) return new RegExp(`(?:^|[^a-z0-9_."])"?${escapeRe(qualifiedName)}"?(?![a-z0-9_"])`, "i");
  const qSchema = escapeRe(qualifiedName.slice(0, dot));
  const qRel = escapeRe(qualifiedName.slice(dot + 1));
  const qualifiedBare = `"?${qSchema}"?\\s*\\.\\s*"?${qRel}"?(?![a-z0-9_"])`;
  const qualified = `(?:^|[^a-z0-9_."])${qualifiedBare}`;
  const unqualified = `"?${qRel}"?(?![a-z0-9_"])`;
  return clauseOnly
    ? new RegExp(`${qualified}|(?:\\b(?:FROM|JOIN|TABLE)\\b|,)\\s*(?:(?:ONLY\\b|\\()\\s*)*(?:${qualifiedBare}|${unqualified})`, "i")
    : new RegExp(`(?:^|[^a-z0-9_."])(?:"?${qSchema}"?\\s*\\.\\s*)?"?${qRel}"?(?![a-z0-9_"])`, "i");
};
const fnCallRe = (qualifiedName: string) => {
  const dot = qualifiedName.indexOf(".");
  const schema = dot === -1 ? "" : qualifiedName.slice(0, dot);
  const fn = dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1);
  const prefix = schema ? `(?:"?${escapeRe(schema)}"?\\s*\\.\\s*)?` : "";
  return new RegExp(`(?:^|[^a-z0-9_."])(${prefix}"?${escapeRe(fn)}"?)\\s*\\(`, "i");
};

type SealedPolicyInput = {
  t: string;
  n: string;
  text: string;
  cmd?: string;
  perm?: boolean;
  taintedViewDeps?: readonly string[];
  taintedFnDeps?: readonly string[];
};

function findTaintedViews(views: ReadonlyArray<{ name: string; def: string }>): Set<string> {
  const tainted = new Set<string>();
  for (const v of views) {
    if (ACTING_USER_RE.test(v.def) || CTX_VERIFIED_RE.test(v.def) || RAW_CTX_GUC_RE.test(v.def) || MCP_HELPER_RE.test(v.def)) {
      tainted.add(v.name);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of views) {
      if (tainted.has(v.name)) continue;
      for (const tv of tainted) {
        if (qualifiedOrClauseRefRe(tv, true).test(v.def)) {
          tainted.add(v.name);
          changed = true;
          break;
        }
      }
    }
  }
  return tainted;
}

// The policies of {t, n, text} that the net flags: those that read ctx_acting_user_id, ctx_verified (outside the exact-name allowlists),
// raw current_setting(...) on the sealed-context GUC, tainted views, or non-standard tainted helper functions.
function readsSealedMember(
  policies: ReadonlyArray<SealedPolicyInput>,
  taintedViews?: ReadonlySet<string>,
): Array<{ t: string; n: string }> {
  return policies
    .filter((p) => {
      const viewHit =
        (p.taintedViewDeps?.length ?? 0) > 0 ||
        (taintedViews ? [...taintedViews].some((v) => qualifiedOrClauseRefRe(v, true).test(p.text)) : false);
      const canonT = canonicalizeRelName(p.t);
      const allow = COMPANY_READ_POLICIES.find((entry) => entry.t === canonT && entry.n === p.n);
      if (allow) {
        const extraFnHit = (p.taintedFnDeps ?? []).some((fn) => canonicalizeRelName(fn) !== "crove_kernel.ctx_verified()");
        if (viewHit || extraFnHit) return true;
        if (p.cmd !== undefined && p.cmd !== "r") return true;
        if (p.perm !== undefined && p.perm !== false) return true;
        // Exactly one read of the sealed context in the whole text, and it is the allowed comparison; nothing else of the net's match survives once the allowance is set aside.
        if ((p.text.match(CTX_VERIFIED_GLOBAL_RE) ?? []).length !== 1 || (p.text.match(KIND_COMPARE) ?? []).length !== 1) return true;
        let rest = p.text.replace(KIND_COMPARE, "");
        if (allow.allowRoleList) rest = rest.replace(ROLE_LIST, "");
        return ACTING_USER_RE.test(rest) || CTX_VERIFIED_RE.test(rest) || RAW_CTX_GUC_RE.test(rest) || MEMBER_LITERAL_RE.test(rest);
      }
      const closedAllow = MCP_SEALED_CLOSED_POLICIES.find((entry) => entry.t === canonT && entry.n === p.n);
      if (closedAllow) {
        const extraFnHit = (p.taintedFnDeps ?? []).some((fn) => canonicalizeRelName(fn) !== "crove_kernel.ctx_verified()");
        if (viewHit || extraFnHit) return true;
        if (p.cmd !== undefined && p.cmd !== closedAllow.cmd) return true;
        if (p.perm !== undefined && p.perm !== closedAllow.perm) return true;
        if ((p.text.match(MCP_PREFIX_CLOSED) ?? []).length !== closedAllow.expectedCount) return true;
        let rest = p.text.replace(MCP_PREFIX_CLOSED, "");
        if (closedAllow.allowConversationReply) {
          if ((rest.match(CONVERSATION_REPLY_PRED) ?? []).length !== 1) return true;
          rest = rest.replace(CONVERSATION_REPLY_PRED, "").replace(/\bOR\b/g, "");
        }
        if (ACTING_USER_RE.test(rest) || CTX_VERIFIED_RE.test(rest) || RAW_CTX_GUC_RE.test(rest) || MEMBER_LITERAL_RE.test(rest)) {
          return true;
        }
        return !/^[\s()]*$/.test(rest);
      }
      const fnHit = (p.taintedFnDeps?.length ?? 0) > 0;
      return viewHit || fnHit || ACTING_USER_RE.test(p.text) || CTX_VERIFIED_RE.test(p.text) || RAW_CTX_GUC_RE.test(p.text);
    })
    .map(({ t, n }) => ({ t, n }));
}

type ScannedPolicy = SealedPolicyInput & {
  rawT: string;
  rawText: string;
  cmd: string;
  perm: boolean;
};

async function scanPolicyContextReads(
  c: pg.Client,
  ids?: DbIdentifiers,
): Promise<{
  policies: ScannedPolicy[];
  readers: string[];
  sealReaders: string[];
  taintedViews: string[];
}> {
  const activeKernelSchema = ids ? ids.schema("kernel") : "crove_kernel";
  const toCanonTable = (s: string) => (ids ? ids.toCanonicalTable(s) : s);
  const toCanonSig = (s: string) => (ids ? ids.toCanonicalRegprocedure(s) : s);
  const toCanonText = (s: string) => (ids ? ids.toCanonicalCatalogText(s) : s);

  const [policyRes, viewRes, viewDepRes, polDepRes, procRes] = await Promise.all([
    rawQuery<{ oid: string; t: string; n: string; cmd: string; perm: boolean; text: string }>(
      c,
      `SELECT p.oid::text AS oid, n.nspname || '.' || r.relname AS t, p.polname::text AS n, p.polcmd::text AS cmd, p.polpermissive AS perm,
              coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') AS text
       FROM pg_catalog.pg_policy p
       JOIN pg_catalog.pg_class r ON r.oid = p.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
       ORDER BY 2, 3`,
    ),
    rawQuery<{ oid: string; name: string; def: string }>(
      c,
      `SELECT v.oid::text AS oid, n.nspname || '.' || v.relname AS name, pg_catalog.pg_get_viewdef(v.oid) AS def
       FROM pg_catalog.pg_class v
       JOIN pg_catalog.pg_namespace n ON n.oid = v.relnamespace
       WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND v.relkind IN ('v', 'm')
       ORDER BY 2`,
    ),
    rawQuery<{ view_oid: string; refclass: string; ref_oid: string }>(
      c,
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
    rawQuery<{ pol_oid: string; refclass: string; ref_oid: string }>(
      c,
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
    // pg_get_functiondef covers a BEGIN ATOMIC body, whose prosrc is empty; prosqlbody IS NULL functions expose their inner body in prosrc without the outer AS $function$ wrapper.
    rawQuery<{ oid: string; name: string; sig: string; def: string; body: string }>(
      c,
      `SELECT p.oid::text AS oid, n.nspname || '.' || p.proname AS name,
              CASE WHEN pg_catalog.split_part(p.oid::regprocedure::text, '(', 1) LIKE '%.%'
                   THEN p.oid::regprocedure::text
                   ELSE n.nspname || '.' || p.oid::regprocedure::text END AS sig,
              pg_catalog.pg_get_functiondef(p.oid) AS def,
              CASE WHEN p.prosqlbody IS NULL THEN coalesce(p.prosrc, '')
                   ELSE pg_catalog.pg_get_functiondef(p.oid) END AS body
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND p.prokind IN ('f', 'p')
       ORDER BY 3`,
    ),
  ]);

  const isStandardCtx = (sig: string) =>
    sig.startsWith(`${activeKernelSchema}.`) && STANDARD_CTX_ACCESSORS.has(sig.slice(activeKernelSchema.length + 1));
  const isAllowedMcpHelperForPolicy = (sig: string, canonTable: string, policyName: string) => {
    if (!sig.startsWith(`${activeKernelSchema}.`)) return false;
    const allowed = PINNED_MCP_HELPER_POLICIES[sig.slice(activeKernelSchema.length + 1)];
    return allowed?.some(([t, n]) => t === canonTable && n === policyName) ?? false;
  };

  const procs = procRes.rows.map((p) => ({ ...p, cleanDef: stripSqlComments(p.body) }));
  const matchesProc = (p: { def: string; cleanDef: string }, re: RegExp) => re.test(p.def) || re.test(p.cleanDef);
  const procByOid = new Map(procs.map((p) => [p.oid, p]));
  const viewByOid = new Map(viewRes.rows.map((v) => [v.oid, v]));
  const taintedProcs = new Set<string>();
  for (const p of procs) {
    if (isStandardCtx(p.sig)) continue;
    if (
      p.sig === `${activeKernelSchema}.ctx_verified()` ||
      matchesProc(p, ACTING_USER_RE) ||
      matchesProc(p, CTX_VERIFIED_RE) ||
      matchesProc(p, RAW_CTX_GUC_RE) ||
      matchesProc(p, MCP_HELPER_RE) ||
      matchesProc(p, UNICODE_ESCAPE_RE) ||
      matchesProc(p, STD_STRINGS_RE)
    ) {
      taintedProcs.add(p.oid);
    }
  }
  const taintedViewOids = new Set<string>();
  for (const v of viewRes.rows) {
    if (ACTING_USER_RE.test(v.def) || CTX_VERIFIED_RE.test(v.def) || RAW_CTX_GUC_RE.test(v.def) || MCP_HELPER_RE.test(v.def)) {
      taintedViewOids.add(v.oid);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const d of viewDepRes.rows) {
      if (taintedViewOids.has(d.view_oid)) continue;
      if ((d.refclass === "pg_class" && taintedViewOids.has(d.ref_oid)) || (d.refclass === "pg_proc" && taintedProcs.has(d.ref_oid))) {
        taintedViewOids.add(d.view_oid);
        changed = true;
      }
    }
    const taintedFnCallRes = [...taintedProcs].map((oid) => fnCallRe(procByOid.get(oid)!.name));
    const taintedViewClauseRes = [...taintedViewOids].map((oid) => qualifiedOrClauseRefRe(viewByOid.get(oid)!.name, true));
    for (const v of viewRes.rows) {
      if (taintedViewOids.has(v.oid)) continue;
      if (taintedViewClauseRes.some((re) => re.test(v.def)) || taintedFnCallRes.some((re) => re.test(v.def))) {
        taintedViewOids.add(v.oid);
        changed = true;
      }
    }
    for (const p of procs) {
      if (isStandardCtx(p.sig) || taintedProcs.has(p.oid)) continue;
      if (taintedFnCallRes.some((re) => matchesProc(p, re)) || taintedViewClauseRes.some((re) => matchesProc(p, re))) {
        taintedProcs.add(p.oid);
        changed = true;
      }
    }
  }

  const depsByPolicy = new Map<string, Array<{ refclass: string; ref_oid: string }>>();
  for (const d of polDepRes.rows) {
    const list = depsByPolicy.get(d.pol_oid) ?? [];
    list.push(d);
    depsByPolicy.set(d.pol_oid, list);
  }

  const policies: ScannedPolicy[] = policyRes.rows.map((pol) => {
    const canonTable = toCanonTable(pol.t);
    const deps = depsByPolicy.get(pol.oid) ?? [];
    const taintedViewDeps = deps
      .filter((d) => d.refclass === "pg_class" && taintedViewOids.has(d.ref_oid))
      .map((d) => toCanonTable(viewByOid.get(d.ref_oid)!.name));
    const taintedFnDeps = deps
      .filter((d) => {
        if (d.refclass !== "pg_proc" || !taintedProcs.has(d.ref_oid)) return false;
        const proc = procByOid.get(d.ref_oid)!;
        return !isAllowedMcpHelperForPolicy(proc.sig, canonTable, pol.n);
      })
      .map((d) => {
        const proc = procByOid.get(d.ref_oid)!;
        if (proc.sig === `${activeKernelSchema}.ctx_verified()`) return "crove_kernel.ctx_verified()";
        const canon = toCanonSig(proc.sig);
        return canonicalizeRelName(canon) === "crove_kernel.ctx_verified()" ? `nonkernel:${proc.sig}` : canon;
      });
    return {
      t: canonTable,
      rawT: pol.t,
      n: pol.n,
      cmd: pol.cmd,
      perm: pol.perm,
      text: toCanonText(pol.text),
      rawText: pol.text,
      taintedViewDeps,
      taintedFnDeps,
    };
  });

  const readers = procs
    .filter((p) => p.sig !== `${activeKernelSchema}.ctx_acting_user_id()` && matchesProc(p, ACTING_USER_RE))
    .map((p) => toCanonSig(p.sig))
    .sort();
  const sealReaders = procs
    .filter((p) => matchesProc(p, /(->>?|#>>?)\s*'\{?member\}?'/i))
    .map((p) => toCanonSig(p.sig))
    .sort();

  return {
    policies,
    readers,
    sealReaders,
    taintedViews: [...taintedViewOids].map((oid) => toCanonTable(viewByOid.get(oid)!.name)).sort(),
  };
}
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
  let dbIds: DbIdentifiers | undefined;
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
    commit = false,
  ): Promise<T> {
    const c = createDbClient({ connectionString: url }, dbIds);
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
          `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at${FEAT.cols}) VALUES ($1, $2, $3, 'notes', 'running', true, now(), now() + interval '30 minutes'${FEAT.vals})`,
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    FEAT = await admin((c) => aiRunFeature(c));
    await setActiveRolePasswords(adminUrl, {
      crove_app: "test-app-pw",
      crove_worker: "test-worker-pw",
    }, dbIds);
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

  // The context of a member-bound MCP grant (ADR-0051, design note on #2975 slice 3) adds one writer of the sealed context and one reader of the sealed member, each its own kind, and the
  // context of a company MCP grant (slice 3e) adds one more writer (it seals no member and has no catalog, so no reader), and the write context of the one MCP write command (#3227, step 3)
  // one more writer: they are accepted here once they exist, and only these names (`enter_mcp_member_context`, `ctx_mcp_member_id`, `enter_mcp_company_context` with its core, and
  // `enter_mcp_company_draft_context`, pinned in its own case below); another writer or reader still fails the exact sets below.
  const mcpMemberObjects = async () => {
    const found = await admin((c) =>
      c.query<{ entry: boolean; helper: boolean; company: boolean; core: boolean; draft: boolean; proposal: boolean; write: boolean }>(
        `SELECT to_regprocedure('crove_kernel.enter_mcp_member_context(uuid,uuid)') IS NOT NULL AS entry, to_regprocedure('crove_kernel.ctx_mcp_member_id()') IS NOT NULL AS helper,
                to_regprocedure('crove_kernel.enter_mcp_company_context(uuid,uuid)') IS NOT NULL AS company,
                to_regprocedure('crove_kernel.seal_mcp_company_context(uuid,uuid)') IS NOT NULL AS core,
                to_regprocedure('crove_kernel.enter_mcp_company_draft_context(uuid,uuid)') IS NOT NULL AS draft,
                to_regprocedure('crove_kernel.enter_mcp_company_proposal_context(uuid,uuid,text)') IS NOT NULL AS proposal,
                to_regprocedure('crove_kernel.enter_mcp_company_write_context(uuid,uuid,text)') IS NOT NULL AS write`,
      ),
    );
    const row = found.rows[0];
    // The company context has one sealing function: its entry until step S5 (#2967, #2969) splits it, then the private core `seal_mcp_company_context`, which the API's entry and the
    // worker's wake entry only call. Either way exactly one function of the company kind calls ctx_write; the two entries that call the core never do (pinned in mcp-company-context.db.test.ts).
    return {
      entry: [
        ...(row?.entry ? ['crove_kernel.enter_mcp_member_context(uuid,uuid)'] : []),
        ...(row?.core ? ['crove_kernel.seal_mcp_company_context(uuid,uuid)'] : row?.company ? ['crove_kernel.enter_mcp_company_context(uuid,uuid)'] : []),
        // The write context of the one MCP write command (#3227, step 3, owner decision 2026-11-14): one more writer of the seal, its own kind (`mcp_company_draft`), accepted once it exists.
        ...(row?.draft ? ['crove_kernel.enter_mcp_company_draft_context(uuid,uuid)'] : []),
        // The sealed context in which an MCP call to an R2 or R3 command becomes a proposal (#3858 slice d, ADR-0051 decision 10, owner decision 2026-11-18/19): one more writer of the seal, its own kind
        // (`mcp_company_proposal`), accepted once it exists and pinned in its own case below.
        ...(row?.proposal ? ['crove_kernel.enter_mcp_company_proposal_context(uuid,uuid,text)'] : []),
        // The sealed write contexts of the Engage coworkers (E2, #3861, ADR-0051 decisions 10 and 11): one more writer of the seal for the two line scopes, kinds `mcp_engage_write` and `mcp_ads_draft`,
        // accepted once it exists and pinned in test/invariant/mcp-engage-write.db.test.ts.
        ...(row?.write ? ['crove_kernel.enter_mcp_company_write_context(uuid,uuid,text)'] : []),
      ],
      helper: row?.helper ? ['crove_kernel.ctx_mcp_member_id()'] : [],
    };
  };

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
    ).toEqual([...CTX_WRITERS, MEMBER_ENTRY, ...(await mcpMemberObjects()).entry].sort());
  });

  // The write context of the one MCP write command (#3227): accepted above by name only when it exists, so its properties are pinned here, whatever file later creates it: a weaker writer cannot
  // pass the base copy of this suite. The API login alone runs it, its search path is pinned, and what it seals has no user, R1, taint and its own kind.
  it("pins the write context of the MCP draft command when it exists: the API login alone, a pinned search path, no user, R1, tainted, its own kind", async () => {
    const entry = "crove_kernel.enter_mcp_company_draft_context(uuid,uuid)";
    const found = await admin((c) => c.query<{ ok: boolean }>(`SELECT to_regprocedure('${entry}') IS NOT NULL AS ok`));
    if (found.rows[0]?.ok !== true) return;
    await admin(async (c) => {
      const { rows: logins, activeAllowed } = await auditRoleFunctionExecute(c, dbIds, entry, ["crove_app"], "brand");
      expect(logins.length).toBeGreaterThan(0);
      expect(logins.some((r) => r.rolname === activeAllowed[0] && r.ok), `active role ${activeAllowed[0]} execute the draft entry`).toBe(true);
      for (const { rolname, ok, expected } of logins) {
        expect(ok, `${rolname} execute the draft entry`).toBe(expected);
      }
      expect((await c.query<{ ok: boolean }>(`SELECT has_function_privilege('public', '${entry}', 'EXECUTE') AS ok`)).rows[0]?.ok).toBe(false);
      const row = (await c.query<{ proconfig: string[] | null; secdef: boolean; def: string }>(`SELECT proconfig, prosecdef AS secdef, pg_get_functiondef(oid) AS def FROM pg_proc WHERE oid = '${entry}'::regprocedure`)).rows[0];
      expect(row?.secdef).toBe(true);
      // The whole setting, as one element: `pg_catalog, pg_temp, public` is another element and fails.
      expect(row?.proconfig, "the draft entry's settings").toEqual(["search_path=pg_catalog, pg_temp"]);
      // The shape it seals, read from its own text: an agent-shaped context with no user, at R1, tainted, of its own kind, naming the grant and the grantor.
      for (const part of [/'actor',\s*'agent'/, /'user',\s*NULL/, /'max_risk',\s*'R1'/, /'tainted',\s*true/, /'kind',\s*'mcp_company_draft'/, /'grantor',\s*v_user/]) {
        expect(row?.def, String(part)).toMatch(part);
      }
      expect(row?.def).not.toMatch(/'max_risk',\s*'R[23]'/);
    });
    // The text checks above are supplementary: a later expression in the same function could override a key, so what it seals is read back from a live entry of a real company grant.
    const grantId = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $4, 'Pin client', 'client.example.com', ARRAY['ludy.read', 'ludy.social.draft'], $5, now(), now() + interval '30 days', $3)`,
        [orgId, grantId, users.owner, `pin-client-${grantId}`, `pin-oauth-${grantId}`],
      ),
    );
    const sealed = await inContext(
      appUrl,
      (c) => c.query("SELECT crove_kernel.enter_mcp_company_draft_context($1::uuid, $2::uuid)", [orgId, grantId]),
      sealOf,
    );
    expect(sealed, "the sealed context of the draft entry").toMatchObject({
      actor: "agent",
      user: null,
      max_risk: "R1",
      tainted: true,
      kind: "mcp_company_draft",
      grantor: users.owner,
      org: orgId,
      agent: grantId,
    });
  });

  // The sealed context of an MCP proposal (#3858 slice d): accepted above by name only when it exists, so its properties are pinned here whatever file later creates it: a weaker writer cannot pass the
  // base copy of this suite. The API login alone runs it, its search path is pinned, and what it seals has no user, R1, taint and its own kind.
  it("pins the sealed context of an MCP proposal when it exists: the API login alone, a pinned search path, no user, R1, tainted, its own kind", async () => {
    const entry = "crove_kernel.enter_mcp_company_proposal_context(uuid,uuid,text)";
    const found = await admin((c) => c.query<{ ok: boolean }>(`SELECT to_regprocedure('${entry}') IS NOT NULL AS ok`));
    if (found.rows[0]?.ok !== true) return;
    await admin(async (c) => {
      const { rows: logins, activeAllowed } = await auditRoleFunctionExecute(c, dbIds, entry, ["crove_app"], "brand");
      expect(logins.length).toBeGreaterThan(0);
      expect(logins.some((r) => r.rolname === activeAllowed[0] && r.ok), `active role ${activeAllowed[0]} execute the proposal entry`).toBe(true);
      for (const { rolname, ok, expected } of logins) {
        expect(ok, `${rolname} execute the proposal entry`).toBe(expected);
      }
      expect((await c.query<{ ok: boolean }>(`SELECT has_function_privilege('public', '${entry}', 'EXECUTE') AS ok`)).rows[0]?.ok).toBe(false);
      const row = (await c.query<{ proconfig: string[] | null; secdef: boolean; def: string }>(`SELECT proconfig, prosecdef AS secdef, pg_get_functiondef(oid) AS def FROM pg_proc WHERE oid = '${entry}'::regprocedure`)).rows[0];
      expect(row?.secdef).toBe(true);
      expect(row?.proconfig, "the proposal entry's settings").toEqual(["search_path=pg_catalog, pg_temp"]);
      for (const part of [/'actor',\s*'agent'/, /'user',\s*NULL/, /'max_risk',\s*'R1'/, /'tainted',\s*true/, /'kind',\s*'mcp_company_proposal'/, /'grantor',\s*v_user/]) {
        expect(row?.def, String(part)).toMatch(part);
      }
      expect(row?.def).not.toMatch(/'max_risk',\s*'R[23]'/);
    });
    // A live entry of a real company grant seals what the text says (a later expression could override a key).
    const grantId = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $4, 'Pin client', 'client.example.com', ARRAY['ludy.read', 'ludy.engage.write'], $5, now(), now() + interval '30 days', $3)`,
        [orgId, grantId, users.owner, `pin-proposal-client-${grantId}`, `pin-proposal-oauth-${grantId}`],
      ),
    );
    const sealed = await inContext(
      appUrl,
      (c) => c.query("SELECT crove_kernel.enter_mcp_company_proposal_context($1::uuid, $2::uuid, 'ludy.engage.write')", [orgId, grantId]),
      sealOf,
    );
    expect(sealed, "the sealed context of the proposal entry").toMatchObject({
      actor: "agent",
      user: null,
      max_risk: "R1",
      tainted: true,
      kind: "mcp_company_proposal",
      grantor: users.owner,
      org: orgId,
      agent: grantId,
    });
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
    const found = await admin((c) => scanPolicyContextReads(c, dbIds));
    const activeKernelSchema = dbIds ? dbIds.schema("kernel") : "crove_kernel";
    const activeKindCompare = new RegExp(
      `\\(\\s*SELECT\\s*\\(${escapeRe(activeKernelSchema)}\\.ctx_verified\\(\\) ->> 'kind'::text\\)\\s*\\)\\s*=\\s*'mcp_company'::text`,
      "g",
    );
    const activeMcpPrefixClosed = new RegExp(
      `"?left"?\\(\\(\\(\\s*SELECT\\s*${escapeRe(activeKernelSchema)}\\.ctx_verified\\(\\)(?:\\s+AS\\s+ctx_verified)?\\)\\s*->>\\s*'kind'::text\\),\\s*4\\)\\s+IS\\s+DISTINCT\\s+FROM\\s+'mcp_'::text`,
      "g",
    );
    expect(
      found.readers,
      "functions that call ctx_acting_user_id (a wrapper, or a definer that gates on it)",
    ).toEqual([]);
    expect(
      [...found.sealReaders].sort(),
      "functions that read the sealed member directly",
    ).toEqual(["crove_kernel.ctx_acting_user_id()", ...(await mcpMemberObjects()).helper].sort());
    expect(found.taintedViews, "views or materialized views that touch the sealed context").toEqual([]);
    // The named company-read policies, when they exist, read the sealed kind through the one allowed comparison, once each, as restrictive read policies.
    for (const p of found.policies.filter((x) => COMPANY_READ_POLICIES.some((entry) => entry.t === x.t && entry.n === x.n))) {
      expect([...p.text.matchAll(KIND_COMPARE)].length, `${p.t}.${p.n}: one comparison of the sealed kind`).toBe(1);
      expect([...p.rawText.matchAll(activeKindCompare)].length, `${p.t}.${p.n}: uses active kernel schema ${activeKernelSchema}`).toBe(1);
      expect([p.cmd, p.perm], `${p.t}.${p.n}: a restrictive read policy`).toEqual(["r", false]);
    }
    // The named mail-closed policies, when they exist, read only the 4-char 'mcp_' kind prefix via left(ctx_verified() ->> 'kind', 4) IS DISTINCT FROM 'mcp_'.
    for (const p of found.policies.filter((x) => MCP_SEALED_CLOSED_POLICIES.some((entry) => entry.t === x.t && entry.n === x.n))) {
      const entry = MCP_SEALED_CLOSED_POLICIES.find((e) => e.t === p.t && e.n === p.n)!;
      expect([...p.text.matchAll(MCP_PREFIX_CLOSED)].length, `${p.t}.${p.n}: expected mcp_ prefix checks`).toBe(entry.expectedCount);
      expect([...p.rawText.matchAll(activeMcpPrefixClosed)].length, `${p.t}.${p.n}: uses active kernel schema ${activeKernelSchema}`).toBe(
        entry.expectedCount,
      );
      expect([p.cmd, p.perm], `${p.t}.${p.n}: exact command and restrictive flag`).toEqual([entry.cmd, entry.perm]);
    }
    const byTablePolicy = (a: readonly (string | boolean)[], b: readonly (string | boolean)[]) => {
      const ta = String(a[0]);
      const tb = String(b[0]);
      if (ta !== tb) return ta < tb ? -1 : 1;
      const pa = String(a[1]);
      const pb = String(b[1]);
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    };
    expect(
      found.policies.filter((p) => readsSealedMember([p]).length > 0).map((p) => [p.t, p.n, p.cmd, p.perm]).sort(byTablePolicy),
      "policies that read the helper: (table, policy, command, permissive)",
    ).toEqual([...POLICIES].sort(byTablePolicy));
  });

  it("sets aside only the one comparison of the sealed kind in allowlisted policies, and flags every other match (planted texts)", () => {
    const compare = "(( SELECT (crove_kernel.ctx_verified() ->> 'kind'::text)) = 'mcp_company'::text)";
    const compareLudy = "(( SELECT (ludy_kernel.ctx_verified() ->> 'kind'::text)) = 'mcp_company'::text)";
    const prefixClosed = "(\"left\"((( SELECT crove_kernel.ctx_verified() AS ctx_verified) ->> 'kind'::text), 4) IS DISTINCT FROM 'mcp_'::text)";
    const prefixClosedLudy = "(\"left\"((( SELECT ludy_kernel.ctx_verified() AS ctx_verified) ->> 'kind'::text), 4) IS DISTINCT FROM 'mcp_'::text)";
    const roles = "m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])";
    const meeting = { t: "crove_meetings.meeting", n: "meeting_read" };
    // The real shape is set aside for each allowlisted policy (in both crove_* and ludy_* spellings).
    expect(readsSealedMember([{ ...meeting, text: `(${roles}) OR ${compare}` }])).toEqual([]);
    expect(readsSealedMember([{ t: "ludy_meetings.meeting", n: "meeting_read", text: `(${roles}) OR ${compareLudy}` }])).toEqual([]);
    for (const entry of COMPANY_READ_POLICIES) {
      if (entry.allowRoleList) continue;
      expect(readsSealedMember([{ t: entry.t, n: entry.n, text: `true OR ${compare}` }]), `${entry.t}.${entry.n}`).toEqual([]);
    }
    for (const entry of MCP_SEALED_CLOSED_POLICIES) {
      const pred = entry.expectedCount === 2 ? `${prefixClosed} ${prefixClosed}` : prefixClosed;
      const text = entry.allowConversationReply ? `((source = 'kernel.conversation.reply'::text) OR ${pred})` : pred;
      expect(readsSealedMember([{ t: entry.t, n: entry.n, cmd: entry.cmd, perm: entry.perm, text }]), `${entry.t}.${entry.n}`).toEqual([]);
      const ludyText = entry.allowConversationReply
        ? `((source = 'kernel.conversation.reply'::text) OR ${prefixClosedLudy})`
        : entry.expectedCount === 2
          ? `${prefixClosedLudy} ${prefixClosedLudy}`
          : prefixClosedLudy;
      expect(readsSealedMember([{ t: canonicalizeRelName(entry.t).replace("crove_", "ludy_"), n: entry.n, cmd: entry.cmd, perm: entry.perm, text: ludyText }])).toEqual([]);
    }
    // Tampered mcp_sealed_closed policies are caught (wrong count, missing WITH CHECK, extra OR predicate, reply exception added elsewhere, wrong cmd/perm, or unlisted table).
    expect(readsSealedMember([{ t: "crove_kernel.mail_event", n: "mcp_sealed_closed", cmd: "*", perm: false, text: prefixClosed }])).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_kernel.mail_event", n: "mcp_sealed_closed", cmd: "*", perm: false, text: `${prefixClosed} (${prefixClosed} OR true)` }])).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_kernel.mail_message", n: "mcp_sealed_closed", cmd: "r", perm: false, text: `((source = 'kernel.conversation.reply'::text) OR ${prefixClosed} OR true)` }])).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_kernel.mail_message", n: "mcp_sealed_closed_insert", cmd: "a", perm: false, text: `((source = 'kernel.conversation.reply'::text) OR ${prefixClosed})` }])).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_kernel.mail_message", n: "mcp_sealed_closed_insert", cmd: "*", perm: false, text: prefixClosed }])).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_kernel.mail_message", n: "mcp_sealed_closed_insert", cmd: "a", perm: true, text: prefixClosed }])).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_finance.journal_entry", n: "mcp_sealed_closed", text: prefixClosed }])).toHaveLength(1);
    // The same text on any other policy, table or name is flagged (so are the other allowlisted policies, should they ever hold the role list).
    expect(readsSealedMember([{ t: "crove_meetings.meeting", n: "other_read", text: `(${roles}) OR ${compare}` }])).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_meetings.meeting_result", n: "meeting_result_read", text: `(${roles}) OR ${compare}` }])).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_kernel.conversation", n: "conversation_scope_read", text: `(${roles}) OR ${compare}` }])).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_notes.note", n: "meeting_read", text: `(${roles}) OR ${compare}` }])).toHaveLength(1);
    // Another policy holding the comparison beside any 'member' string is flagged.
    expect(readsSealedMember([{ t: "crove_meetings.meeting_result", n: "meeting_result_read", text: `${compare} OR (x = 'member'::text)` }])).toHaveLength(1);
    // Any non-allowlisted policy reading ctx_verified (with any schema prefix or bare) WITHOUT 'member' or ctx_acting_user_id is flagged (#3771).
    for (const [label, expr] of [
      ["crove_kernel.ctx_verified without 'member'", compare],
      ["ludy_kernel.ctx_verified without 'member'", compareLudy],
      ["bare ctx_verified without 'member'", "(( SELECT (ctx_verified() ->> 'kind'::text)) = 'mcp_company'::text)"],
      ["arbitrary schema ctx_verified", "(( SELECT (other_schema.ctx_verified() ->> 'kind'::text)) = 'mcp_company'::text)"],
      ["raw current_setting('ludy.ctx')", "((current_setting('ludy.ctx'::text, true))::jsonb ->> 'kind'::text) = 'mcp_company'::text"],
      ["raw current_setting('crove.ctx')", "((current_setting('crove.ctx'::text, true))::jsonb ->> 'kind'::text) = 'mcp_company'::text"],
      ["raw current_setting('ludy.ctx_seal')", "current_setting('ludy.ctx_seal'::text, true) IS NOT NULL"],
      ["dynamic current_setting concatenation", "current_setting(('ludy.'::text || 'ctx'::text), true) IS NOT NULL"],
      ["pg_settings catalog query", "EXISTS (SELECT 1 FROM pg_settings WHERE name LIKE '%ctx%')"],
      ["pg_show_all_settings catalog query", "EXISTS (SELECT 1 FROM pg_show_all_settings() s WHERE s.name LIKE '%ctx%')"],
    ] as const) {
      expect(readsSealedMember([{ t: "crove_finance.journal_entry", n: "je_read", text: expr }]), label).toHaveLength(1);
    }
    // meeting_read with any other read of the sealed context or of the helper is flagged, whatever the key or kind it names.
    const extras = [
      "(crove_kernel.ctx_acting_user_id() IS NOT NULL)",
      "((SELECT (crove_kernel.ctx_verified() ->> 'member_vy'::text)) = 'x'::text)",
      "((SELECT (crove_kernel.ctx_verified() ->> 'kind'::text)) = 'mcp_member'::text)",
      "((SELECT (crove_kernel.ctx_verified() #>> '{member}'::text[])) IS NOT NULL)",
      "((SELECT (crove_kernel.ctx_verified() ->> 'member'::text)) IS NOT NULL)",
      `${compare}`,
    ];
    for (const extra of extras) expect(readsSealedMember([{ ...meeting, text: `(${roles}) OR ${compare} OR ${extra}` }]), extra).toHaveLength(1);
    // Direct reads of current or legacy sealed settings are flagged on allowlisted policies as well.
    expect(readsSealedMember([{ ...meeting, text: `(${roles}) OR ${compare} OR ((current_setting('crove.ctx'::text, true))::jsonb ->> 'member'::text) IS NOT NULL` }])).toHaveLength(1);
    expect(readsSealedMember([{ ...meeting, text: `(${roles}) OR ${compare} OR ((current_setting('ludy.ctx'::text, true))::jsonb ->> 'kind'::text) = 'mcp_company'::text` }])).toHaveLength(1);
    // meeting_read without the comparison, or with a different one, is flagged too.
    expect(readsSealedMember([{ ...meeting, text: `(${roles})` }])).toHaveLength(1);
    expect(readsSealedMember([{ ...meeting, text: `(${roles}) OR ((SELECT (crove_kernel.ctx_verified() ->> 'kind'::text)) = 'mcp_member'::text)` }])).toHaveLength(1);
    // Indirect reads through views (1-hop, chained, FROM ONLY, parenthesized) are caught even when the policy has no 'member' or ctx_verified text; harmless views/policies pass.
    const tainted = findTaintedViews([
      { name: "crove_kernel.v_ctx", def: "SELECT (ludy_kernel.ctx_verified() ->> 'kind'::text) AS k" },
      { name: "crove_kernel.v_guc", def: "SELECT (current_setting('crove.ctx'::text, true))::jsonb AS ctx" },
      { name: "crove_kernel.v_chain", def: "SELECT k FROM crove_kernel.v_ctx" },
      { name: "crove_kernel.v_chain_only", def: "SELECT k FROM ONLY (crove_kernel.v_ctx)" },
      { name: "crove_kernel.v_mcp_helper", def: "SELECT crove_kernel.conversation_access_mcp_member('direct', gen_random_uuid()) AS ok" },
      { name: "crove_kernel.v_ok", def: "SELECT 1 AS ok" },
      { name: "crove_kernel.ba_v_ctx", def: "SELECT 1 AS ok" },
    ]);
    expect([...tainted].sort()).toEqual([
      "crove_kernel.v_chain",
      "crove_kernel.v_chain_only",
      "crove_kernel.v_ctx",
      "crove_kernel.v_guc",
      "crove_kernel.v_mcp_helper",
    ]);
    expect(readsSealedMember([{ t: "crove_finance.journal_entry", n: "via_view", text: "(EXISTS (SELECT 1 FROM crove_kernel.v_ctx))" }], tainted)).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_finance.journal_entry", n: "via_only_view", text: "(EXISTS (SELECT 1 FROM ONLY (v_ctx)))" }], tainted)).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_finance.journal_entry", n: "via_chain", text: "(EXISTS (SELECT 1 FROM crove_kernel.v_chain))" }], tainted)).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_finance.journal_entry", n: "via_guc_view", text: "(EXISTS (SELECT 1 FROM crove_kernel.v_guc))" }], tainted)).toHaveLength(1);
    expect(readsSealedMember([{ t: "crove_finance.journal_entry", n: "via_mcp_view", text: "(EXISTS (SELECT 1 FROM crove_kernel.v_mcp_helper))" }], tainted)).toHaveLength(1);
    expect(readsSealedMember([{ ...meeting, text: `(${roles}) OR ${compare} OR (EXISTS (SELECT 1 FROM crove_kernel.v_chain))` }], tainted)).toHaveLength(1);
    expect(
      readsSealedMember(
        [
          {
            t: "crove_finance.journal_entry",
            n: "harmless",
            text: "(org_id = crove_kernel.ctx_org_id()) AND (EXISTS (SELECT 1 FROM crove_kernel.v_ok)) AND (EXISTS (SELECT 1 FROM other_crove_kernel.v_ctx)) AND (current_setting('application_name'::text, true) <> 'x'::text)",
          },
        ],
        tainted,
      ),
    ).toEqual([]);
    // SQL comment stripper lexer regression cases: CR line comments, ident$ identifiers, UTF-8 dollar tags, CASE'x'/ée'x', and E'...' newline continuation.
    expect(stripSqlComments("SELECT 1 -- cr\r+ probe_3771 /* c */ . fn_sql /* c */ ()")).toContain("probe_3771   . fn_sql   ()");
    expect(stripSqlComments("DECLARE a$$foo$ int := 1; RETURN probe_3771 /* c */ . fn_sql /* c */ ();")).toContain("a$$foo$");
    expect(stripSqlComments("DECLARE a text := $é$/*$é$; RETURN probe_3771 /* c */ . fn_sql /* c */ ();")).toContain("probe_3771   . fn_sql   ()");
    expect(stripSqlComments("SELECT CASE'x', ée'x'; RETURN probe_3771 /* c */ . fn_sql /* c */ ();")).toContain("probe_3771   . fn_sql   ()");
    expect(stripSqlComments("SELECT E'a'\r\n-- ignored ' quote\r\n'\\'' || probe_3771 /* c */ . fn_sql /* c */ ();")).toContain(
      "probe_3771   . fn_sql   ()",
    );
  });

  it("catches real PostgreSQL policies that read ctx_verified without 'member', read sealed-context GUCs via current_setting, read via views/chained views, or call tainted helpers", async () => {
    const activeKernel = dbIds ? dbIds.schema("kernel") : "crove_kernel";
    const activeMeetings = dbIds ? dbIds.schema("meetings") : "crove_meetings";
    const tenantRole = dbIds ? dbIds.role("tenant") : "crove_tenant";
    const result = await admin(async (c) => {
      await rawQuery(c, "BEGIN");
      try {
        await rawQuery(
          c,
          `CREATE SCHEMA probe_3771;
           CREATE FUNCTION probe_3771.ctx_verified() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"kind":"mcp_company"}'::jsonb $$;
           CREATE FUNCTION probe_3771.ctx_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (${activeKernel}.ctx_verified() ->> 'org')::uuid $$;
           CREATE FUNCTION probe_3771.ctx_mcp_engage_write() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT (${activeKernel}.ctx_verified() ->> 'kind') = 'mcp_company' $$;
           CREATE FUNCTION probe_3771.fn_sql() RETURNS text LANGUAGE sql STABLE AS $$ SELECT ${activeKernel}.ctx_verified() ->> 'kind' $$;
           CREATE FUNCTION probe_3771.fn_plpgsql() RETURNS text LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN current_setting('ludy.ctx', true)::jsonb ->> 'kind'; END $$;
           CREATE FUNCTION probe_3771.fn_chain() RETURNS text LANGUAGE sql STABLE AS $$ SELECT probe_3771.fn_sql() $$;
           CREATE FUNCTION probe_3771.fn_wrap_engage() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT ${activeKernel}.ctx_mcp_engage_write() $$;
           CREATE FUNCTION probe_3771.fn_comment_call() RETURNS text LANGUAGE plpgsql STABLE AS $$
           BEGIN
             RETURN probe_3771 /* comment */ . fn_sql /* comment */ ();
           END $$;
           CREATE FUNCTION probe_3771.fn_quoted_guc() RETURNS text LANGUAGE plpgsql STABLE AS $$
           BEGIN
             RETURN pg_catalog."current_setting" /* comment */ ('ludy.' || 'ctx', true)::jsonb ->> 'kind';
           END $$;
           CREATE FUNCTION probe_3771.fn_dollar_block() RETURNS text LANGUAGE plpgsql STABLE AS $$
           DECLARE a text := $tag$/*$tag$;
           BEGIN
             IF a IS NOT NULL THEN RETURN probe_3771 /* c */ . fn_sql /* c */ (); END IF;
             RETURN NULL;
           END $$;
           CREATE FUNCTION probe_3771.fn_dollar_line() RETURNS text LANGUAGE plpgsql STABLE AS $$
           BEGIN
             RETURN $tag$--$tag$ || probe_3771 /* c */ . fn_sql /* c */ ();
           END $$;
           CREATE FUNCTION probe_3771.fn_cr_comment() RETURNS text LANGUAGE plpgsql STABLE AS $$
           BEGIN
             RETURN probe_3771
             -- cr comment${"\r"}/* c */ . fn_sql /* c */ ();
           END $$;
           CREATE FUNCTION probe_3771.fn_ident_dollar() RETURNS text LANGUAGE plpgsql STABLE AS $outer$
           DECLARE a$$foo$ text := 'ok';
           BEGIN
             IF a$$foo$ IS NOT NULL THEN RETURN probe_3771 /* c */ . fn_sql /* c */ (); END IF;
             RETURN NULL;
           END $outer$;
           CREATE FUNCTION probe_3771.fn_utf8_dollar() RETURNS text LANGUAGE plpgsql STABLE AS $$
           DECLARE a text := $é$/*$é$;
           BEGIN
             IF a IS NOT NULL THEN RETURN probe_3771 /* c */ . fn_sql /* c */ (); END IF;
             RETURN NULL;
           END $$;
           CREATE FUNCTION probe_3771.fn_escape_continue() RETURNS text LANGUAGE plpgsql STABLE AS $$
           DECLARE a text := E'first'
             -- comment between continued parts
             '\\'';
           BEGIN
             IF a IS NOT NULL THEN RETURN probe_3771 /* c */ . fn_sql /* c */ (); END IF;
             RETURN NULL;
           END $$;
           CREATE FUNCTION probe_3771.fn_case_escape_traps() RETURNS text LANGUAGE plpgsql STABLE AS $$
           BEGIN
             RETURN CASE'x' WHEN 'x' THEN probe_3771 /* c */ . fn_sql /* c */ () END;
           END $$;
           CREATE FUNCTION probe_3771.fn_std_strings() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
           BEGIN
             PERFORM set_config('standard_conforming_strings', 'off', true);
             RETURN true;
           END $$;
           CREATE FUNCTION probe_3771.fn_pos_params(a text, b text) RETURNS text LANGUAGE sql STABLE AS $$
             SELECT COALESCE($1, $2, probe_3771 /* c */ . fn_sql /* c */ ())
           $$;
           CREATE FUNCTION probe_3771.fn_atomic_sql() RETURNS text LANGUAGE sql STABLE
           BEGIN ATOMIC
             RETURN $tên$/*$tên$ || probe_3771 /* c */ . fn_sql /* c */ ();
           END;
           CREATE FUNCTION probe_3771.fn_dollar_apostrophe() RETURNS text LANGUAGE plpgsql STABLE AS $$
           DECLARE a text := $tag$it's$tag$;
           BEGIN
             IF a IS NOT NULL THEN RETURN probe_3771 /* c */ . fn_sql /* c */ (); END IF;
             RETURN NULL;
           END $$;
           CREATE FUNCTION probe_3771.fn_escape_quote() RETURNS text LANGUAGE plpgsql STABLE AS $$
           DECLARE a text := E'\\'';
           BEGIN
             IF a IS NOT NULL THEN RETURN probe_3771 /* c */ . fn_sql /* c */ (); END IF;
             RETURN NULL;
           END $$;
           CREATE FUNCTION probe_3771.fn_quoted_ident_traps() RETURNS text LANGUAGE plpgsql STABLE AS $$
           DECLARE "/*" text := ''; "a'b" text := '';
           BEGIN
             IF "/*" = "a'b" THEN RETURN probe_3771 /* c */ . fn_sql /* c */ (); END IF;
             RETURN NULL;
           END $$;
           CREATE FUNCTION probe_3771.fn_dollar_acting() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
           DECLARE a text := $tag$/*$tag$;
           BEGIN
             IF a IS NOT NULL THEN RETURN ${activeKernel}.ctx_acting_user_id(); END IF;
             RETURN NULL;
           END $$;

           CREATE VIEW probe_3771.v_ctx AS SELECT (${activeKernel}.ctx_verified() ->> 'kind') AS kind;
           CREATE VIEW probe_3771.v_crove_guc WITH (security_invoker = true) AS SELECT (current_setting('crove.ctx', true)::jsonb ->> 'kind') AS kind;
           CREATE VIEW probe_3771.v_chain AS SELECT kind FROM probe_3771.v_crove_guc;
           CREATE VIEW probe_3771.v_ludy_guc AS SELECT (current_setting('ludy.ctx', true)::jsonb ->> 'kind') AS kind;
           CREATE VIEW probe_3771.v_via_fn AS SELECT probe_3771.fn_sql() AS kind;
           CREATE MATERIALIZED VIEW probe_3771.mv_ctx AS SELECT (${activeKernel}.ctx_verified() ->> 'kind') AS kind;
           CREATE VIEW probe_3771.v_ok AS SELECT 1 AS ok;

           CREATE FUNCTION probe_3771.fn_via_view() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM probe_3771.v_ludy_guc) $$;

           CREATE TABLE probe_3771.t (org_id uuid, id uuid);
           ALTER TABLE probe_3771.t ENABLE ROW LEVEL SECURITY;

           CREATE POLICY p_ctx ON probe_3771.t FOR SELECT USING ((SELECT ${activeKernel}.ctx_verified() ->> 'kind') = 'mcp_company');
           CREATE POLICY p_ludy_guc ON probe_3771.t FOR SELECT USING ((current_setting('ludy.ctx', true)::jsonb ->> 'kind') = 'mcp_company');
           CREATE POLICY p_crove_guc ON probe_3771.t FOR SELECT USING ((current_setting('crove.ctx', true)::jsonb ->> 'kind') = 'mcp_company');
           CREATE POLICY p_seal_guc ON probe_3771.t FOR SELECT USING (current_setting('ludy.ctx_seal', true) IS NOT NULL);
           CREATE POLICY p_dyn_guc ON probe_3771.t FOR SELECT USING (current_setting('ludy.' || 'ctx', true) IS NOT NULL);
           CREATE POLICY p_pg_settings ON probe_3771.t FOR SELECT USING (EXISTS (SELECT 1 FROM pg_catalog.pg_settings WHERE name LIKE '%ctx%'));
           CREATE POLICY p_view_ctx ON probe_3771.t FOR SELECT USING (EXISTS (SELECT 1 FROM probe_3771.v_ctx WHERE kind = 'mcp_company'));
           CREATE POLICY p_view_chain ON probe_3771.t FOR SELECT USING (EXISTS (SELECT 1 FROM probe_3771.v_chain WHERE kind = 'mcp_company'));
           CREATE POLICY p_view_with_check ON probe_3771.t FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM probe_3771.v_ludy_guc WHERE kind = 'mcp_company'));
           CREATE POLICY p_view_fn ON probe_3771.t FOR SELECT USING (EXISTS (SELECT 1 FROM probe_3771.v_via_fn WHERE kind = 'mcp_company'));
           CREATE POLICY p_matview ON probe_3771.t FOR SELECT USING (EXISTS (SELECT 1 FROM probe_3771.mv_ctx WHERE kind = 'mcp_company'));
           CREATE POLICY p_fn_sql ON probe_3771.t FOR SELECT USING (probe_3771.fn_sql() = 'mcp_company');
           CREATE POLICY p_fn_plpgsql ON probe_3771.t FOR SELECT USING (probe_3771.fn_plpgsql() = 'mcp_company');
           CREATE POLICY p_fn_chain ON probe_3771.t FOR SELECT USING (probe_3771.fn_chain() = 'mcp_company');
           CREATE POLICY p_fn_view ON probe_3771.t FOR SELECT USING (probe_3771.fn_via_view());
           CREATE POLICY p_fn_comment_call ON probe_3771.t FOR SELECT USING (probe_3771.fn_comment_call() = 'mcp_company');
           CREATE POLICY p_fn_quoted_guc ON probe_3771.t FOR SELECT USING (probe_3771.fn_quoted_guc() = 'mcp_company');
           CREATE POLICY p_fn_dollar_block ON probe_3771.t FOR SELECT USING (probe_3771.fn_dollar_block() = 'mcp_company');
           CREATE POLICY p_fn_dollar_line ON probe_3771.t FOR SELECT USING (probe_3771.fn_dollar_line() = 'mcp_company');
           CREATE POLICY p_fn_cr_comment ON probe_3771.t FOR SELECT USING (probe_3771.fn_cr_comment() = 'mcp_company');
           CREATE POLICY p_fn_ident_dollar ON probe_3771.t FOR SELECT USING (probe_3771.fn_ident_dollar() = 'mcp_company');
           CREATE POLICY p_fn_utf8_dollar ON probe_3771.t FOR SELECT USING (probe_3771.fn_utf8_dollar() = 'mcp_company');
           CREATE POLICY p_fn_escape_continue ON probe_3771.t FOR SELECT USING (probe_3771.fn_escape_continue() = 'mcp_company');
           CREATE POLICY p_fn_case_escape ON probe_3771.t FOR SELECT USING (probe_3771.fn_case_escape_traps() = 'mcp_company');
           CREATE POLICY p_fn_std_strings ON probe_3771.t FOR SELECT USING (probe_3771.fn_std_strings());
           CREATE POLICY p_fn_pos_params ON probe_3771.t FOR SELECT USING (probe_3771.fn_pos_params(NULL, NULL) = 'mcp_company');
           CREATE POLICY p_fn_atomic_sql ON probe_3771.t FOR SELECT USING (probe_3771.fn_atomic_sql() = 'mcp_company');
           CREATE POLICY p_fn_dollar_apostrophe ON probe_3771.t FOR SELECT USING (probe_3771.fn_dollar_apostrophe() = 'mcp_company');
           CREATE POLICY p_fn_escape_quote ON probe_3771.t FOR SELECT USING (probe_3771.fn_escape_quote() = 'mcp_company');
           CREATE POLICY p_fn_quoted_ident ON probe_3771.t FOR SELECT USING (probe_3771.fn_quoted_ident_traps() = 'mcp_company');
           CREATE POLICY p_fn_dollar_acting ON probe_3771.t FOR SELECT USING (probe_3771.fn_dollar_acting() IS NOT NULL);
           CREATE POLICY p_mcp_member_leak ON probe_3771.t FOR SELECT USING (${activeKernel}.ctx_mcp_member_id() IS NOT NULL);
           CREATE POLICY p_spoof_std ON probe_3771.t FOR SELECT USING (org_id = probe_3771.ctx_org_id());
           CREATE POLICY p_spoof_mcp ON probe_3771.t FOR SELECT USING (probe_3771.ctx_mcp_engage_write());
           CREATE POLICY p_wrap_mcp ON probe_3771.t FOR SELECT USING (probe_3771.fn_wrap_engage());
           CREATE POLICY p_ok ON probe_3771.t FOR SELECT USING (
             org_id = ${activeKernel}.ctx_org_id()
             AND EXISTS (SELECT 1 FROM probe_3771.v_ok)
             AND current_setting('application_name', true) <> 'blocked'
           );`,
        );
        // Also verify an unqualified bare ctx_verified() call, Unicode-escaped identifier U&"...", and tampered allowlisted policies are caught.
        await rawQuery(c, "SET LOCAL search_path = probe_3771, pg_catalog");
        await rawQuery(c, `CREATE FUNCTION probe_3771.fn_unicode() RETURNS text LANGUAGE sql STABLE AS $$ SELECT U&"\\0063tx_verified"() ->> 'kind' $$`);
        await rawQuery(c, `CREATE POLICY p_fn_unicode ON probe_3771.t FOR SELECT USING (probe_3771.fn_unicode() = 'mcp_company')`);
        await rawQuery(c, `CREATE POLICY p_bare_ctx ON probe_3771.t FOR SELECT USING ((ctx_verified() ->> 'kind') = 'mcp_company')`);
        await rawQuery(c, "SET LOCAL search_path = pg_catalog, pg_temp");
        await rawQuery(c, `DROP POLICY meeting_result_read ON ${activeMeetings}.meeting_result`);
        await rawQuery(
          c,
          `CREATE POLICY meeting_result_read ON ${activeMeetings}.meeting_result AS RESTRICTIVE FOR SELECT TO ${tenantRole}
           USING (((SELECT ${activeKernel}.ctx_verified() ->> 'kind') = 'mcp_company') OR EXISTS (SELECT 1 FROM probe_3771.v_ctx))`,
        );
        await rawQuery(c, `DROP POLICY mcp_sealed_closed ON ${activeKernel}.mail_event`);
        await rawQuery(
          c,
          `CREATE POLICY mcp_sealed_closed ON ${activeKernel}.mail_event AS RESTRICTIVE FOR ALL TO ${tenantRole}
           USING (pg_catalog.left(((SELECT ${activeKernel}.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_' OR true)`,
        );
        const scan = await scanPolicyContextReads(c, dbIds);
        return {
          taintedViews: scan.taintedViews,
          readers: scan.readers,
          flagged: readsSealedMember(scan.policies).map((p) => `${p.t}.${p.n}`).sort(),
        };
      } finally {
        await rawQuery(c, "ROLLBACK").catch(() => {});
      }
    });

    expect(result.taintedViews).toEqual([
      "probe_3771.mv_ctx",
      "probe_3771.v_chain",
      "probe_3771.v_crove_guc",
      "probe_3771.v_ctx",
      "probe_3771.v_ludy_guc",
      "probe_3771.v_via_fn",
    ]);
    expect(result.readers).toEqual(["probe_3771.fn_dollar_acting()"]);
    const expectedFlagged = [
      ...POLICIES.map(([t, n]) => `${t}.${n}`),
      "crove_kernel.mail_event.mcp_sealed_closed",
      "crove_meetings.meeting_result.meeting_result_read",
      "probe_3771.t.p_bare_ctx",
      "probe_3771.t.p_crove_guc",
      "probe_3771.t.p_ctx",
      "probe_3771.t.p_dyn_guc",
      "probe_3771.t.p_fn_atomic_sql",
      "probe_3771.t.p_fn_case_escape",
      "probe_3771.t.p_fn_chain",
      "probe_3771.t.p_fn_comment_call",
      "probe_3771.t.p_fn_cr_comment",
      "probe_3771.t.p_fn_dollar_acting",
      "probe_3771.t.p_fn_dollar_apostrophe",
      "probe_3771.t.p_fn_dollar_block",
      "probe_3771.t.p_fn_dollar_line",
      "probe_3771.t.p_fn_escape_continue",
      "probe_3771.t.p_fn_escape_quote",
      "probe_3771.t.p_fn_ident_dollar",
      "probe_3771.t.p_fn_plpgsql",
      "probe_3771.t.p_fn_pos_params",
      "probe_3771.t.p_fn_quoted_guc",
      "probe_3771.t.p_fn_quoted_ident",
      "probe_3771.t.p_fn_sql",
      "probe_3771.t.p_fn_std_strings",
      "probe_3771.t.p_fn_unicode",
      "probe_3771.t.p_fn_utf8_dollar",
      "probe_3771.t.p_fn_view",
      "probe_3771.t.p_ludy_guc",
      "probe_3771.t.p_matview",
      "probe_3771.t.p_mcp_member_leak",
      "probe_3771.t.p_pg_settings",
      "probe_3771.t.p_seal_guc",
      "probe_3771.t.p_spoof_mcp",
      "probe_3771.t.p_spoof_std",
      "probe_3771.t.p_view_chain",
      "probe_3771.t.p_view_ctx",
      "probe_3771.t.p_view_fn",
      "probe_3771.t.p_view_with_check",
      "probe_3771.t.p_wrap_mcp",
    ].sort();
    expect(result.flagged).toEqual(expectedFlagged);
    expect(result.flagged).not.toContain("probe_3771.t.p_ok");
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
    ).rows.map((r) => ({ ...r, table_name: dbIds ? dbIds.toCanonicalTable(r.table_name) : r.table_name }));
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
         WHERE ((r.rolname LIKE 'crove\\_%' OR r.rolname LIKE 'ludy\\_%') AND r.rolname NOT LIKE '%\\_test\\_%' AND r.rolname NOT LIKE 'crove\\_test%' AND r.rolname NOT LIKE 'ludy\\_test%' AND r.rolname <> 'ludy_migrate_test') AND NOT r.rolsuper
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
    const holder = createDbClient({ connectionString: workerUrl }, dbIds);
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
    const c = createDbClient({ connectionString: workerUrl }, dbIds);
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
           WHERE (n.nspname LIKE 'crove\\_%' OR n.nspname LIKE 'ludy\\_%') AND n.nspname <> 'crove_meta' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
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
      // The live notes door (#3110): reads the run's waiting result row as audio_for_member_vy does, for the live pieces of the recorder's own meeting.
      "crove_meetings.live_for_member_vy",
    ];
    // Functions whose change has not landed yet (the two-step rule of AGENTS.md: this file runs from the base branch): accepted while absent, and held to the list the moment
    // they exist. Empty: the frozen list above is exact. Add an entry here only in an invariant-only PR that precedes the change.
    const PENDING: string[] = [];
    const found = await admin((c) =>
      c.query<{ fn: string }>(
        `SELECT n.nspname || '.' || p.proname AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE (n.nspname LIKE 'crove\\_%' OR n.nspname LIKE 'ludy\\_%') AND (p.prosrc ~ 'member_vy_(result|memory)' OR p.prosrc ~ $$member_vy_['"]?\\s*\\|\\|$$) ORDER BY 1`,
      ),
    );
    const names = [...new Set(found.rows.map((r) => r.fn))];
    expect(names.filter((n) => !FROZEN.includes(n) && !PENDING.includes(n)), "SQL functions that read the private Vy rows and are not on the frozen list").toEqual([]);
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
             WHERE (n.nspname LIKE 'crove\\_%' OR n.nspname LIKE 'ludy\\_%') AND n.nspname <> 'crove_meta' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
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
        detail: dbIds ? dbIds.table(table) : table,
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
      detail: `${dbIds?.schema("kernel") ?? "crove_kernel"}.refusal_tally`,
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
      detail: `${dbIds?.schema("kernel") ?? "crove_kernel"}.member_vy_result`,
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
    const forbidden = { ok: false, code: "42501", message: "AGENT_FORBIDDEN", detail: `${dbIds?.schema("kernel") ?? "crove_kernel"}.member_vy_result` };
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

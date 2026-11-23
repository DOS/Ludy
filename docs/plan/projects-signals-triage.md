# Projects Omnichannel Roadmap Signals and Pre-Task Triage Inbox

> Plan for Ludy Projects (`modules/projects`, active module schema `crove_projects` pending `#3971` cutover to `ludy_projects`, kernel schema `ludy_kernel`, milestone `M3 Paid pilot`, line `line:projects`, `priority:P1`), 2026-11-23. Builds on [projects.md](projects.md), [projects-v2.md](projects-v2.md), [projects-public-roadmap.md](projects-public-roadmap.md), [ADR-0048](../adr/0048-projects-on-kernel-tasks.md), [ADR-0049](../adr/0049-member-scoped-vy.md), [ADR-0056](../adr/0056-projects-v2-cycles-columns-dependencies-privacy.md), [ADR-0057](../adr/0057-projects-public-roadmap-ideas-voting-changelog.md), [ADR-0018](../adr/0018-untrusted-content.md), [ADR-0031](../adr/0031-module-enablement.md), [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md), [ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md), and the OPC/SME scope gate in [scope.md](../product/scope.md). Owner JOY approved popup `A1` on 2026-11-23 in the `Projects & Notes Product Owner` session ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7090763080)). The governing decision record is [ADR-0058](../adr/0058-projects-omnichannel-signals-and-triage.md) (`Accepted`); the Vietnamese summary for the owner is [projects-signals-triage.vi.md](projects-signals-triage.vi.md).
>
> **Tracking issues:** Plan & ADR-0058 ([#4490](https://github.com/DOS/Ludy/issues/4490)), Step 0 Invariants ([#4491](https://github.com/DOS/Ludy/issues/4491)), Slice 1 Omnichannel Roadmap Signals ([#4492](https://github.com/DOS/Ludy/issues/4492)), Slice 2 Projects Triage Inbox, Vy AI & MCP ([#4493](https://github.com/DOS/Ludy/issues/4493)).

## 1. Goal, benchmark workflow, and OPC/SME 3-gate check

### 1.1 Product goal

Vietnamese SMEs, B2B software agencies, and solo founders already run sales deals in Engage CRM, customer support in Ludy Inbox, client calls in Ludy Meetings, and delivery boards in Ludy Projects + Public Roadmap. Today those signals stay disconnected:

1. **Omnichannel Roadmap Signals (`#4492`, inspired by Productlane & Cycle):** When a customer asks for a capability during a CRM Deal, Inbox Conversation, or Meeting, team members should be able to link that signal onto an internal `roadmap_item` in 1-2 clicks with an optional customer account label, short quote excerpt, and deal value rollup per currency (`VND`, `USD`, etc.) without exposing commercial details on the public board.
2. **Projects Triage Inbox (`#4493`, inspired by Linear Triage):** When raw requests arrive from Public Roadmap items, Inbox Conversations, Meetings, or quick team intake, teams need a dedicated pre-task staging inbox (`Accept`, `Merge`, `Snooze`, `Decline`, `Reopen`) so unvetted requests never pollute `ludy_kernel.task`, My Tasks (`/o/:slug/my-work`), Kanban WIP counters, Cycles, or Gantt charts until accepted.

### 1.2 OPC/SME scope gate ([scope.md](../product/scope.md))

| Gate | Requirement | How this design passes |
| --- | --- | --- |
| **1. Fit** | Weekly or monthly task for OPC/SME owners, PMs, and account/support leads | Reviewing customer requests from deals, chats, and calls and deciding which ones become project tasks is a weekly SME workflow. Out of scope / Icebox: multi-brand enterprise portals, automated SLA escalation rules, custom weighted scoring engines, or automatic CRM-stage-to-roadmap mutations. |
| **2. Smallest slice & zero-setup default** | One person uses it with defaults and zero setup | Both features require zero setup toggles. Projects with zero triage items render a clean empty state (no mandatory workflow columns or routing rules); single-project SMEs pre-select their active org project; capturing a signal from a Deal/Conversation/Meeting pre-fills title, account label, and deal value automatically. |
| **3. AI part named & gated** | Named coworker action per screen, short review, metered via `AI_FEATURES`, 100% AI-off parity | Vy (`gm`, Ludy's cross-app coworker and assistant per [DESIGN.md](../../DESIGN.md) section 1.1; `projects` has no separate coworker) provides two metered helpers under `AI_FEATURES` `'projects'`: `projects.roadmap_signal_match` (`#4492`, ranks matching roadmap items or suggests a new idea draft) and `projects.triage_assist` (`#4493`, checks duplicate open tasks and suggests priority, assignee seat, and cycle). Both are strict proposal cards; with AI off or budget spent, 100% of signal linking, rollups, triage transitions, and MCP reads work deterministically. |
| **4. Human approval** | No unapproved writes or money/customer leaks | Humans click **Confirm Link**, **Accept**, **Merge**, **Snooze**, or **Decline**. AI never creates tasks, merges items, or edits public roadmap items autonomously. |
| **5. Proportionate security** | Caller-scoped cross-module reads, private-project isolation, internal-only signal isolation | Cross-module reads run strictly through `ctxQueryFn` in the caller's own `Runtime` context (`ctx-query-access.db.test.ts`); `roadmap_signal` never leaks into `public_roadmap_view`; `project_triage_item` carries direct `RESTRICTIVE` `project_visibility` RLS (`#2604`); zero unauthenticated HTTP routes are added. |

## 2. Owner decision (`2026-11-23`) and `#3971` schema cutover rule

- **Owner approval (`2026-11-23T10:20+07:00`, popup `A1`):** ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7090763080)) prioritized Omnichannel Roadmap Signals (`#4492`) and Projects Triage Inbox (`#4493`) on `M3 Paid pilot` (`priority:P1`), governed by [ADR-0058](../adr/0058-projects-omnichannel-signals-and-triage.md) and sequenced through Step 0 invariants (`#4491`).
- **SQL identifier note ([ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md)):** Core schema and role renames (`#3970`) have landed on `origin/main` (`ludy_kernel`, `ludy_tenant`, `ludy_app`, `ludy_worker`, `ludy_definer_tenant`, and `@ludy/*` packages). Module schemas (`crove_projects`, `crove_crm`, `crove_meetings`, `crove_notes`) remain `crove_*` on `origin/main` pending `#3971`. Therefore:
  - Examples below use `crove_projects` and `ludy_kernel` / `ludy_tenant` matching `origin/main` today.
  - Whichever of `#4491`, `#4492`, or `#4493` lands after `#3971` swaps `crove_projects` to `ludy_projects` with identical columns, FKs, indexes, policies, and test assertions (`apps/kernel/test/invariant/fixtures/db-identifiers.ts` supports both).

## 3. Step 0 invariants (`#4491`)

Because `.github/workflows/protected.yml` executes `origin/main`'s `apps/kernel/test/invariant/rls-matrix.db.test.ts` on every PR touching `supabase/migrations/`, `#4491` lands on `main` BEFORE `#4492` or `#4493` and registers both planned tables in `PENDING_TABLES` (strictly sorted, one per line) and `ROW_FACTORIES`:

1. **`<projects_schema>.roadmap_signal` (`crove_projects.roadmap_signal` today):**
   - `setup` creates a `roadmap_board` and `roadmap_item` (`source: 'internal'`, `moderation_status: 'pending'`, `stage: 'under_review'`).
   - `row` sets valid `board_id`, `roadmap_item_id`, `source_type: 'crm.deal'`, `source_id: randomUUID()`, `account_label: 'Cong ty ABC'`, `quote_excerpt: 'Can ho tro xuat bao cao theo quy'`, `deal_value: '25000000.00'`, `deal_currency: 'VND'`, `tainted: true`, `created_by: o.owner`.
2. **`<projects_schema>.project_triage_item` (`crove_projects.project_triage_item` today):**
   - `setup` creates a `project` (`visibility: 'org'`).
   - `row` sets `project_id: project.id`, `source_type: 'manual'`, `source_id: null`, `status: 'pending'`, `priority: 'medium'`, `title: 'Xem xet yeu cau khach hang'`, `description: 'Tong hop tu kenh ho tro'`, `tainted: true`, `created_by: o.owner`.

Both entries stay in `PENDING_TABLES` with zero table migrations in `#4491`. `#4492` removes `roadmap_signal` from `PENDING_TABLES` when its migration lands, and `#4493` removes `project_triage_item` when its migration lands.

## 4. Slice 1: Omnichannel Roadmap Signals (`#4492`)

### 4.1 Database schema (`<14d>_crove_projects_roadmap_signals.sql`)

1. **Composite uniqueness on `crove_projects.roadmap_item`:**
   - Ensure `CONSTRAINT roadmap_item_board_uq UNIQUE (org_id, board_id, id)` exists (idempotent `DO $$ ... END $$;`) so `roadmap_signal` enforces board consistency structurally in PostgreSQL.
2. **New internal table `crove_projects.roadmap_signal`:**
   - `org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE`
   - `id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7()`
   - `board_id uuid NOT NULL`
   - `roadmap_item_id uuid NOT NULL`
   - `source_type text NOT NULL CHECK (source_type IN ('crm.deal', 'kernel.conversation', 'meetings.meeting'))`
   - `source_id uuid NOT NULL`
   - `account_label text CHECK (account_label IS NULL OR (pg_catalog.length(account_label) BETWEEN 1 AND 160 AND account_label = pg_catalog.btrim(account_label)))` (`pii`)
   - `quote_excerpt text CHECK (quote_excerpt IS NULL OR (pg_catalog.length(quote_excerpt) BETWEEN 1 AND 1000 AND quote_excerpt = pg_catalog.btrim(quote_excerpt)))` (`pii`)
   - `deal_value NUMERIC(18, 2) CHECK (deal_value IS NULL OR deal_value >= 0)`
   - `deal_currency text CHECK (deal_currency IS NULL OR deal_currency ~ '^[A-Z]{3}$')`
   - `tainted boolean NOT NULL DEFAULT true`
   - `created_by uuid`
   - `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
   - `updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
3. **Keys, checks, indexes, and RLS:**
   - `PRIMARY KEY (org_id, id)`
   - `CONSTRAINT roadmap_signal_currency_pair_ck CHECK ((deal_value IS NULL) = (deal_currency IS NULL))`
   - `CONSTRAINT roadmap_signal_board_fk FOREIGN KEY (org_id, board_id) REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE`
   - `CONSTRAINT roadmap_signal_item_fk FOREIGN KEY (org_id, board_id, roadmap_item_id) REFERENCES crove_projects.roadmap_item (org_id, board_id, id) ON DELETE CASCADE`
   - `CONSTRAINT roadmap_signal_item_source_uq UNIQUE (org_id, roadmap_item_id, source_type, source_id)` (idempotent deduplication per item + source)
   - Supporting btree indexes covering all composite FKs (`conformance.db.test.ts` `fk-index`):
     - `CREATE INDEX IF NOT EXISTS roadmap_signal_board_idx ON crove_projects.roadmap_signal (org_id, board_id, created_at DESC);`
     - `CREATE INDEX IF NOT EXISTS roadmap_signal_item_idx ON crove_projects.roadmap_signal (org_id, board_id, roadmap_item_id, created_at DESC);`
     - `CREATE INDEX IF NOT EXISTS roadmap_signal_source_idx ON crove_projects.roadmap_signal (org_id, source_type, source_id);`
   - RLS & agent guard: `SELECT ludy_kernel.apply_tenant_rls('crove_projects.roadmap_signal');` (strictly `ludy_tenant` isolation + `#285` `agent_write_guard`; org-chart agents and `member_vy` cannot write `roadmap_signal`).
4. **Public non-exposure:**
   - `crove_projects.public_roadmap_view` and every `public_roadmap_*` `SECURITY DEFINER` function NEVER query `roadmap_signal` and NEVER expose `account_label`, `deal_value`, `deal_currency`, or `quote_excerpt`.
   - `roadmap_signal` has no `project_id` column and sits beneath `roadmap_board`, which already blocks linking `visibility = 'private'` projects (`ROADMAP_PRIVATE_PROJECT_FORBIDDEN`).

### 4.2 Caller-scoped cross-module reads (`ctxQueryFn`)

Extend `modules/projects/src/tasks-from-source.ts`:

```ts
export function ctxQueryFn(ctx: QueryContext): SourceQueryFn {
  return async <T>(name: string, input: Record<string, unknown>): Promise<SourceQueryResponse<T>> => {
    if (name.startsWith('notes.') && !ctx.installed('notes')) return { status: 'not_installed' };
    if (name.startsWith('meetings.') && !ctx.installed('meetings')) return { status: 'not_installed' };
    if (name.startsWith('crm.') && !ctx.installed('crm')) return { status: 'not_installed' };
    return await ctx.query<T>(name, input);
  };
}
```

- **CRM Deals (`sourceType === 'crm.deal'`):**
  - Calls `crm.deal.get` (`{ dealId: sourceId }`) via `ctxQueryFn(ctx)`. Returns `MODULE_OFF` (`404`) when CRM is not installed/enabled, or the underlying `404` if caller RLS hides the deal.
  - Reads `deal.title`, `deal.partyName` (fallback for `accountLabel`), `deal.amount`, and `deal.currency` (`'VND'` today, generalized in `roadmap_signal` as 3-letter uppercase ISO currency so future multi-currency deals store cleanly).
  - Source picker searches caller-visible deals via `crm.deal.list` (never querying `crove_crm.deal` directly).
- **Inbox Conversations (`sourceType === 'kernel.conversation'`):**
  - Calls `kernel.conversation.get` (`{ conversationId: sourceId }`) and `kernel.conversation.list` for picker search. Direct/private/restricted conversations hidden by caller RLS fail closed (`CONVERSATION_NOT_FOUND`, `404`).
  - Defaults `accountLabel` from `conversation.contact.partyName ?? conversation.contact.displayName` and bounded `quoteExcerpt` from selected customer message or caller-edited excerpt.
- **Meetings (`sourceType === 'meetings.meeting'`):**
  - Calls `meetings.meeting.get`, `meetings.result.get`, `meetings.notes.get` (strictly gated on `meeting.isRecorder`), and `meetings.transcript.get` fallback via `ctxQueryFn(ctx)`.
- **Audit & boundary discipline:**
  - Zero `@ludy/mod-crm`, `@ludy/mod-meetings`, or `@ludy/mod-notes` dependencies in `modules/projects/package.json` or imports (`pnpm depcruise`).
  - Zero cross-module SQL joins or cross-module PostgreSQL foreign keys (`conformance.db.test.ts`).
  - `ctx.audit(...)` records IDs and `auditValue(...)` markers for `account_label` and `quote_excerpt`; clear-text private conversation/meeting bodies are never written to audit rows.

### 4.3 Per-currency `decimal.js` rollups (`@ludy/l10n-vn`) and item merge behavior

- **Per-currency aggregation (`projects.roadmap.signal.rollup` and board detail summary):**
  - Fetch matching `roadmap_signal` rows for a `boardId` (or single `roadmapItemId`).
  - Accumulate `deal_value` in TypeScript using `money(...)` (`Decimal`) from `@ludy/l10n-vn` strictly partitioned in a `Map<string, { total: Decimal; signalCount: number }>` keyed by uppercase ISO `deal_currency` (and never mixing currencies or using JS `number` floats).
  - Serialize each currency bucket deterministically sorted by currency code: `{ currency, totalAmount: total.toFixed(2), signalCount }`.
  - Also compute deterministic `totalSignals`, `distinctAccountCount` (normalized trimmed lower-case non-null `account_label` count), and `sourceCounts: { crmDeal, conversation, meeting }`.
- **Merge safety (`projects.roadmap.item.merge`):**
  - Extend `roadmapItemMerge` in `modules/projects/src/roadmap.ts` so merging `sourceItemId` into `targetItemId` atomically:
    1. Deletes any `roadmap_signal` on `sourceItemId` whose `(source_type, source_id)` already exists on `targetItemId`.
    2. Updates remaining `roadmap_signal` rows on `sourceItemId` to `roadmap_item_id = targetItemId`.
  - Prevents duplicate deal-value double counting when duplicate ideas are merged.

### 4.4 Contracts, commands, queries, and authenticated oRPC (`apps/kernel/src/rpc.ts`)

- **Contracts (`packages/kernel-contract/src/projects-roadmap.ts`):**
  - `ROADMAP_SIGNAL_SOURCE_TYPES = ['crm.deal', 'kernel.conversation', 'meetings.meeting'] as const`
  - `zRoadmapSignal`, `zRoadmapSignalValueByCurrency` (`currency`, `totalAmount` via `zMoney`, `signalCount`), `zRoadmapSignalItemRollup`
  - `zRoadmapSignalCreateInput`: `{ boardId, roadmapItemId, sourceType, sourceId, accountLabel?, quoteExcerpt?, dealValue?, dealCurrency? }` (validates `(dealValue === undefined) === (dealCurrency === undefined)` when custom values are provided, or auto-hydrates `dealValue`/`dealCurrency`/`accountLabel` from `crm.deal.get` when `sourceType === 'crm.deal'` and omitted)
  - `zRoadmapSignalListInput` (`{ boardId, roadmapItemId? }`), `zRoadmapSignalDeleteInput` (`{ signalId }`), `zRoadmapSignalRollupInput` (`{ boardId, roadmapItemId? }`)
  - `zRoadmapSignalMatchInput` (`{ boardId, sourceType, sourceId, language? }`), `zRoadmapSignalMatchResult`
- **Commands & queries (`modules/projects/src/roadmap-signals.ts`, wired into `modules/projects/src/index.ts`):**
  - `projects.roadmap.signal.create` (`WRITERS`, `R1`, `Runtime.execute()`): verifies `roadmap_item` exists on `boardId` in `orgId` and is not `'merged'` or `'archived'`; verifies caller readability of `(sourceType, sourceId)` via `ctxQueryFn(ctx)` (`crm.deal.get`, `kernel.conversation.get`, `meetings.meeting.get`); inserts `roadmap_signal` with `ON CONFLICT (org_id, roadmap_item_id, source_type, source_id) DO NOTHING` returning `{ signal, alreadyLinked }` idempotently (avoiding double-click errors while keeping `UNIQUE` safety against double-counting); emits `projects.roadmap.signal_linked`; audits IDs + `auditValue(...)`.
  - `projects.roadmap.signal.delete` (`WRITERS`, `R1`, `Runtime.execute()`): deletes signal inside `(org_id, id)` and audits IDs.
  - `projects.roadmap.signal.list` (`READERS`): lists signals for a board or item (internal authenticated members only).
  - `projects.roadmap.signal.rollup` (`READERS`): returns deterministic per-item and board-level `valueByCurrency[]` rollups (`@ludy/l10n-vn` `decimal.js`).
  - `projects.roadmap.ai_signal_match_source` (`READERS`): gathers bounded board items (`id`, `publicTitle`, `publicSummary`, `stage`, `moderationStatus`, `tainted`) and caller-scoped source snippet via `ctxQueryFn(ctx)` (`crm.deal.get`, `kernel.conversation.get`, `meetings.meeting.get`/`result.get`), plus AI availability/budget flags (`checkProjectsVyAccess` pattern) before running Vy outside any transaction.
- **oRPC wiring (`apps/kernel/src/rpc.ts` & `packages/kernel-contract/src/contract.ts`):**
  - Exposed exclusively on authenticated `os.projects.roadmap`: `signalCreate`, `signalDelete`, `signalList`, `signalRollup`, `signalMatchSuggest`.
  - Zero new routes in `apps/kernel/src/http.ts`.

### 4.5 Vy AI coworker (`projects.roadmap_signal_match`)

- Register `'projects.roadmap_signal_match': 'projects'` in `packages/agent/src/meter.ts` (`AI_FEATURES`).
- Implement `roadmapSignalMatchInstructions`, `roadmapSignalMatchPrompt`, `zRoadmapSignalMatchOut`, and `checkRoadmapSignalMatch` in `packages/agent/src/project-roadmap.ts`, wired through `InboxReader.roadmapSignalMatch` (`packages/agent/src/inbox.ts`) and `apps/kernel/src/project-roadmap-ai.ts` (`prepareRoadmapSignalMatch`, `withAiScope` + `metered`, `tools: []`):
  - **Untrusted delimiter fencing:** Wrap source title/quote/body AND any `tainted: true` roadmap item text inside `<<< >>>` fences (`fenced(...)`), explicitly instructing Vy to treat content strictly as untrusted customer text ([ADR-0018](../adr/0018-untrusted-content.md)).
  - **Deterministic post-model validators:**
    - Every suggested match (`roadmapItemId`, `confidence`, `reason`) MUST match an ID in the input board items allowlist (`pending` or `published`, never `merged` or `archived`); unknown UUIDs fail closed with `UNKNOWN_ID`.
    - Optional `newIdeaDraft` (`suggestedTitle`, `suggestedSummary`) is bounded (`<= 180` / `<= 500` chars), marked `tainted: true`, stripped of invisible format characters (`/\p{Cf}/u`), HTML tags (`/<[a-z!/]/i`), and untrusted links (`draftLinksOutside` checked strictly against `!tainted` source/board strings).
    - `reason` checked for `hasMarkdownNoise`, `/\p{Cf}/u`, and `draftLinksOutside`.
  - **UX & AI-off parity:** UI renders at most 3 matched candidates + optional new idea draft with an `"AI"` badge; user clicks **Confirm Link** (calls `projects.roadmap.signal.create`) or **Create Idea & Link**. With AI off/paused/over budget, the user searches/selects any board item directly or creates a new item manually.

### 4.6 UI/UX and accessibility (`apps/app`, `#4492`)

- **Capture entry points:**
  - From **CRM Deal detail**, **Inbox Conversation panel**, and **Meeting detail**: `"Link to Roadmap"` action opens a compact modal pre-filled with source type, `accountLabel`, `dealValue`/`dealCurrency` (for deals), and editable `quoteExcerpt` (`<= 1000` chars), showing optional Vy item match suggestions (`AI` badge) alongside manual search/select of board items.
  - From **Projects Roadmap Moderation console** (`/o/:slug/projects`): `"Add Signal"` button on any `roadmap_item` searches caller-visible Deals, Conversations, or Meetings, plus shows **Demand Rollup** pills (`N signals`, `M accounts`, and stacked per-currency totals like `150.000.000 VND`, `$2,400.00 USD`) and expandable internal signals list.
- **Design & a11y:** EN/VI localization, `@ludy/ui` semantic OKLCH tokens (`tools/ui-colors.mjs`), `>= 44 px` touch targets on modal/list/delete buttons, clean single-column mobile sheet `< 768 px`, and zero signal badges rendered on public `/-/roadmap/:orgSlug/:boardSlug`.

## 5. Slice 2: Projects Triage Inbox, Vy AI, and MCP (`#4493`)

### 5.1 Database schema (`<14d>_crove_projects_triage.sql`)

1. **New table `crove_projects.project_triage_item`:**
   - `org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE`
   - `id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7()`
   - `project_id uuid NOT NULL`
   - `source_type text NOT NULL CHECK (source_type IN ('roadmap.item', 'kernel.conversation', 'meetings.meeting', 'manual'))`
   - `source_id uuid`
   - `status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'snoozed', 'accepted', 'merged', 'declined'))`
   - `priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none'))`
   - `title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 300 AND title = pg_catalog.btrim(title))` (`pii`)
   - `description text CHECK (description IS NULL OR pg_catalog.length(description) <= 10000)` (`pii`)
   - `tainted boolean NOT NULL DEFAULT true`
   - `snoozed_until timestamptz`
   - `accepted_task_id uuid`
   - `merged_into_task_id uuid`
   - `decline_reason text CHECK (decline_reason IS NULL OR pg_catalog.length(decline_reason) <= 1000)` (`pii`)
   - `triaged_by uuid`
   - `triaged_at timestamptz`
   - `created_by uuid`
   - `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
   - `updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
2. **Keys, constraints, and supporting indexes:**
   - `PRIMARY KEY (org_id, id)`
   - `CONSTRAINT project_triage_source_pair_ck CHECK ((source_type = 'manual' AND source_id IS NULL) OR (source_type <> 'manual' AND source_id IS NOT NULL))`
   - `CONSTRAINT project_triage_snooze_ck CHECK ((status = 'snoozed' AND snoozed_until IS NOT NULL) OR (status <> 'snoozed'))`
   - `CONSTRAINT project_triage_accept_ck CHECK (status = 'accepted' OR accepted_task_id IS NULL)` and `CONSTRAINT project_triage_merge_ck CHECK (status = 'merged' OR merged_into_task_id IS NULL)` (allowing `ON DELETE SET NULL` when a downstream `project_task` is detached later without violating check constraints).
   - `CONSTRAINT project_triage_project_fk FOREIGN KEY (org_id, project_id) REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE`
   - `CONSTRAINT project_triage_accepted_task_fk FOREIGN KEY (org_id, project_id, accepted_task_id) REFERENCES crove_projects.project_task (org_id, project_id, task_id) ON DELETE SET NULL (accepted_task_id)`
   - `CONSTRAINT project_triage_merged_task_fk FOREIGN KEY (org_id, project_id, merged_into_task_id) REFERENCES crove_projects.project_task (org_id, project_id, task_id) ON DELETE SET NULL (merged_into_task_id)`
   - Indexes (covering all FKs + triage queue queries):
     - `CREATE INDEX IF NOT EXISTS project_triage_project_status_idx ON crove_projects.project_triage_item (org_id, project_id, status, created_at DESC);`
     - `CREATE INDEX IF NOT EXISTS project_triage_org_status_idx ON crove_projects.project_triage_item (org_id, status, snoozed_until, created_at DESC);`
     - `CREATE INDEX IF NOT EXISTS project_triage_accepted_task_idx ON crove_projects.project_triage_item (org_id, project_id, accepted_task_id) WHERE accepted_task_id IS NOT NULL;`
     - `CREATE INDEX IF NOT EXISTS project_triage_merged_task_idx ON crove_projects.project_triage_item (org_id, project_id, merged_into_task_id) WHERE merged_into_task_id IS NOT NULL;`
3. **RLS & `#2604` private-project parity:**
   - `SELECT ludy_kernel.apply_tenant_rls('crove_projects.project_triage_item');`
   - Direct `RESTRICTIVE` `project_visibility` policy:
     ```sql
     DROP POLICY IF EXISTS project_visibility ON crove_projects.project_triage_item;
     CREATE POLICY project_visibility ON crove_projects.project_triage_item
       AS RESTRICTIVE FOR ALL TO ludy_tenant
       USING (
         (SELECT crove_projects.actor_bypasses_private_projects())
         OR crove_projects.project_visible(org_id, project_id)
       )
       WITH CHECK (crove_projects.project_visible(org_id, project_id));
     ```
   - Update `apps/kernel/test/invariant/projects-private.db.test.ts` expected table list (`expect.arrayContaining([... 'project_triage_item' ...])`) and add actor-matrix tests verifying non-members cannot `SELECT`, `INSERT`, `UPDATE`, or `DELETE` `project_triage_item` rows on a `visibility = 'private'` project, while `org` `owner`/`admin`, `project.owner_user_id`, and invited `project_member`s can.

### 5.2 Commands, queries, state transitions, and canonical lock order (`modules/projects/src/triage.ts`)

1. **`projects.triage.create` (`WRITERS`, `R1`, `Runtime.execute()`):**
   - Verifies caller has write access on target `projectId` (`loadProject` + `assertNotArchived`; private projects naturally enforce `project_visibility` + `assertProjectWriter` if restricted).
   - When `sourceType` is `'kernel.conversation'` or `'meetings.meeting'`, validates caller readability via `ctxQueryFn(ctx)` and defaults `tainted = true`. When `'roadmap.item'`, verifies the `roadmap_item` exists in `orgId` and sets `tainted = item.tainted || item.source === 'public_submission'`. When `'manual'`, accepts `title`, optional `description`, `priority`, and `tainted` (default `false` for internal manual triage or `true` when pasted from untrusted origin; configurable flag `tainted: boolean` clamped true for non-manual sources).
   - Writes `crove_projects.project_triage_item` with `status = 'pending'`, emits `projects.triage.created`, audits IDs + `auditValue(...)`.
2. **`projects.triage.list` (`READERS`):**
   - Supports optional `projectId` (single project tab) or omitted `projectId` (cross-project Triage Inbox across all projects caller RLS exposes), optional `statuses[]`, and cursor/limit (`<= 200`).
   - Returns `items`, per-status counts (`pending`, `snoozed`, `accepted`, `merged`, `declined`), active project seats, and active/upcoming cycles for inline Accept controls.
   - Snoozed items with `snoozed_until <= now` are flagged `snoozeElapsed: true` in read results (and optionally surfaced cleanly in the Active Triage filter without requiring background cron mutation).
3. **`projects.triage.accept` (`WRITERS`, `R1`, `Runtime.execute()`):**
   - Input: `{ triageItemId, title?, description?, assigneePositionId?, dueOn?, timeZone?, columnId?, cycleId? }`.
   - Execution order (strictly deadlock-safe):
     1. Lock `crove_projects.project_triage_item` `FOR UPDATE` (`status IN ('pending', 'snoozed')`, failing `409 TRIAGE_ALREADY_RESOLVED` if `'accepted' | 'merged' | 'declined'`).
     2. Read `crove_projects.project` WITHOUT row lock (`lock = false`) to verify `assertNotArchived(project)` and validate optional `columnId` / `cycleId` belong to `(org_id, project_id)`.
     3. Call internal command `kernel.task.create_from_triage` (`packages/kernel/src/agents.ts`, `access: MEMBERS`, calling `insertHumanTask` with `tainted: item.tainted` and `sourceRef: { type: item.source_type === 'manual' ? 'projects.project_triage_item' : item.source_type, id: item.source_id ?? item.id }`), which acquires the `ludy_kernel.position` row lock FIRST (if `assigneePositionId` is non-null) and creates the `ludy_kernel.task`.
     4. Acquire `crove_projects.project` lock `FOR SHARE` AFTER `kernel.task.create_from_triage` (`position -> project` canonical lock order, matching `tasks-from-note.ts` and `roadmap.ts`), re-verify `assertNotArchived(project)` and `assertSeatsAllowed` (so concurrent `projects.member.remove` cannot assign a removed user's seat on a private or org project).
     5. Insert `crove_projects.project_task` (with validated `column_id` and `cycle_id`), update `project_triage_item` to `status = 'accepted'`, `accepted_task_id = taskId`, `triaged_by = userId`, `triaged_at = ctx.now`.
     6. If `item.source_type === 'roadmap.item'`, optionally link `roadmap_item.linked_task_id` ONLY if the item is currently unlinked and the target `project.visibility <> 'private'` (never attaching a private project task to a public roadmap item!).
     7. Emit `projects.triage.accepted`, record project activity, and audit IDs + `auditValue(...)`.
4. **`projects.triage.merge` (`WRITERS`, `R1`, `Runtime.execute()`):**
   - Input: `{ triageItemId, targetTaskId }`.
   - Locks `project_triage_item` `FOR UPDATE` (`status IN ('pending', 'snoozed')`), verifies `targetTaskId` exists in `crove_projects.project_task` for the same `(org_id, project_id)` and target `project` is not archived, sets `status = 'merged'`, `merged_into_task_id = targetTaskId`, `triaged_by = userId`, `triaged_at = ctx.now`, emits `projects.triage.merged`, and audits IDs.
5. **`projects.triage.snooze` (`WRITERS`, `R1`, `Runtime.execute()`):**
   - Input: `{ triageItemId, snoozedUntil }`. Verifies `snoozedUntil > ctx.now` (`422 INVALID_SNOOZE_TIME`), transitions `'pending' | 'snoozed'` -> `'snoozed'`, sets `snoozed_until`, `triaged_by`, `triaged_at`.
6. **`projects.triage.decline` (`WRITERS`, `R1`, `Runtime.execute()`):**
   - Input: `{ triageItemId, declineReason? }`. Transitions `'pending' | 'snoozed'` -> `'declined'`, stores bounded `decline_reason` (`pii`), `triaged_by`, `triaged_at`.
7. **`projects.triage.reopen` (`WRITERS`, `R1`, `Runtime.execute()`):**
   - Input: `{ triageItemId }`. Transitions `'snoozed' | 'declined'` -> `'pending'`, clears `snoozed_until = null`, `decline_reason = null`, `triaged_by = null`, `triaged_at = null`. Refuses `'accepted' | 'merged'` with `409 TRIAGE_TERMINAL_STATE` so one accepted/merged item never spawns duplicate tasks.
8. **Authenticated oRPC only (`apps/kernel/src/rpc.ts`):**
   - Expose `os.projects.triage.{create,list,accept,merge,snooze,decline,reopen,assist}` strictly via authenticated oRPC handlers; zero new routes in `apps/kernel/src/http.ts`.

### 5.3 Vy AI Triage Coworker (`projects.triage_assist`)

- Register `'projects.triage_assist': 'projects'` in `packages/agent/src/meter.ts` (`AI_FEATURES`).
- Implement `triageAssistInstructions`, `triageAssistPrompt`, `zTriageAssistOut`, and `checkTriageAssist` in `packages/agent/src/project-triage.ts` (or extend `project-roadmap.ts`), wired through `InboxReader.projectTriageAssist` and `apps/kernel/src/project-triage-ai.ts` (`withAiScope` + `metered`, `tools: []`):
  - **Bounded caller-visible facts (`projects.triage.ai_assist_source`):**
    - Target `project_triage_item` (`id`, `title`, `description`, `sourceType`, `tainted`).
    - Up to 40 visible open tasks in the same `project_id` (`id`, `title`, `status`, `tainted`).
    - Active project seats (`positionId`, `title`, `holderName`).
    - Active and upcoming cycles in the same `project_id` (`id`, `name`, `status`).
  - **Untrusted delimiter & deterministic validator rules:**
    - All triage text (`tainted: true`) and any `tainted: true` task titles sit inside `<<< >>>` fences (`fenced(...)`).
    - Strictly check returned fields fail closed:
      - `duplicateTaskId`: `null` or exact UUID inside the input project's visible open tasks allowlist (`UNKNOWN_ID` otherwise).
      - `recommendedPriority`: `'urgent' | 'high' | 'medium' | 'low' | 'none'`.
      - `suggestedAssigneePositionId`: `null` or exact UUID inside the project's active seats allowlist.
      - `suggestedCycleId`: `null` or exact UUID inside the project's active/upcoming cycles allowlist.
      - `reason`: plain text (`<= 280` chars), zero invisible format chars (`/\p{Cf}/u`), zero markdown noise, `draftLinksOutside` checked against `!tainted` texts.
  - **Human approval & AI-off parity:** UI renders the suggestion card (`"AI"`, `"De xuat"`) inside the Triage detail drawer so the human can click **Accept with suggestion** or **Merge into task #...**, or edit every field manually. With AI off, paused, or budget spent, Accept / Merge / Snooze / Decline / Reopen work identically.

### 5.4 Read-only MCP triage summary (`projects.mcp.triage_summary`)

- Added in `modules/projects/src/roadmap-mcp.ts` alongside `projects.mcp.roadmap_ideas` and `projects.mcp.roadmap_demand_summary`:
  - `mcp: { scope: 'ludy.read' }`, `access: ['owner', 'admin']`, calling `requireCompanyGrantor(ctx)` (rejects member-level MCP grants).
  - Input `{ projectId?, status?, limit? }` (`limit` 1..50, default 20).
  - SQL strictly joins `crove_projects.project` and filters `p.visibility <> 'private'` (failing with `404` if a caller explicitly passes a private `projectId`), so private projects never leak over company-grant `/mcp`.
  - Returns per-status triage counts across non-private projects and bounded triage items (`id`, `projectId`, `projectName`, `status`, `priority`, `title`, `sourceType`, `tainted`, `sourceTrust: tainted ? 'external' : 'internal'`, `snoozedUntil`, `createdAt`), omitting `decline_reason` and passing `projectName` and `title` through `plainLine(...)`.

### 5.5 UI/UX and accessibility (`apps/app`, `#4493`)

- **Project Triage tab (`/o/:slug/projects/:id`):** Dedicated **Triage** tab beside Board / List / Timeline showing pending count badge, list + detail split pane (single-column stacked drawer on `< 768 px` mobile), **Accept** (with optional title, assignee seat, priority, column, cycle, due date), **Merge into existing task** (searchable task picker), **Snooze** (`Tomorrow`, `Next week`, custom date), **Decline** (optional reason), **Reopen**, and the Vy **AI Triage Assist** card (`AI` badge + `Tainted / External` origin pill when `tainted = true`).
- **Cross-Project Triage Inbox (`/o/:slug/projects`):** Top-level **Triage** tab/view on the Projects home screen showing pending/due-snoozed items across all projects visible to the caller (`project_visibility` RLS enforced in PostgreSQL) with a project filter pill.
- **1-click Capture ("Send to Triage"):** Available on Inbox Conversations, Meetings, and Public Roadmap moderation items (`sourceType` pre-filled, default active project selected for single-project SMEs).
- **Accessibility & styling:** EN/VI localization, `@ludy/ui` semantic OKLCH tokens (`tools/ui-colors.mjs`), `>= 44 px` touch targets on all action buttons and mobile list items, full keyboard shortcuts/navigation without drag dependencies.

## 6. Cross-cutting lifecycle (`PDPL`, `Offboarding`, `org_purge`, `manifest`, types)

| Registry / artifact | Slice 1 (`#4492`) additions | Slice 2 (`#4493`) additions |
| --- | --- | --- |
| `modules/projects/src/manifest.ts` | Register `roadmap_signal` (`account_label: 'pii'`, `quote_excerpt: 'pii'`, other columns internal) | Register `project_triage_item` (`title: 'pii'`, `description: 'pii'`, `decline_reason: 'pii'`, other columns internal) |
| `packages/kernel/src/personal-data.ts` | Register `roadmap_signal.account_label` & `roadmap_signal.quote_excerpt` (`free_text`, `erase`) + redaction updates | Register `project_triage_item.title`, `description`, `decline_reason` (`free_text`, `erase`) + redaction updates |
| `packages/kernel/src/offboarding.ts` | Add `'projects.roadmap_signal'` to `EXPORT_TABLES` (`omit: []`) | Add `'projects.project_triage_item'` to `EXPORT_TABLES` (`omit: []`) |
| `ludy_kernel.org_purge` migration (`shared-core`) | Cumulative `2027..._ludy_kernel_org_purge_*.sql`: delete `roadmap_signal` before `roadmap_item` and `roadmap_board` in `v_kernel_first` | Cumulative `2027..._ludy_kernel_org_purge_*.sql`: delete `project_triage_item` before `project_task` and `project` in `v_kernel_first` |
| `packages/db/src/schema.ts` & `generated/database.ts` | `pnpm db:types` + refine string-literal unions (`check-unions`) | `pnpm db:types` + refine string-literal unions (`check-unions`) |

## 7. Test plan and phased rollout checklist

### 7.1 Required verification per slice

- **Step 0 (`#4491`):** Run `apps/kernel/test/invariant/rls-matrix.db.test.ts` on PG17 (`CROVE_TEST_ADMIN_URL`), confirming both tables pass `PENDING_TABLES` sorting and row factory validation.
- **Slice 1 (`#4492`):**
  - Unit tests: `packages/agent` (`projects.roadmap_signal_match` prompt fencing, `UNKNOWN_ID` / `draftLinksOutside` / `hasMarkdownNoise` / invisible format rejections), `modules/projects` per-currency `decimal.js` rollup math (`VND` + `USD` separate totals, zero float drift).
  - PG17 DB tests: `roadmap_signal` tenancy & RLS (`rls-matrix.db.test.ts` clean without `roadmap_signal` in `PENDING_TABLES`), caller-scoped `ctxQueryFn` denial when caller lacks CRM/conversation/meeting access (`ctx-query-access` parity), `public_roadmap_view` asserting zero `roadmap_signal` / `account_label` / `deal_value` / `quote_excerpt` exposure, idea merge signal deduplication (no double-counted `deal_value`), PDPL find/erase, `offboarding` export, `org_purge`, AI-off parity, `pnpm lint` + `pnpm depcruise` (zero `@ludy/mod-crm`/`mod-meetings` imports).
- **Slice 2 (`#4493`):**
  - Unit tests: `packages/agent` (`projects.triage_assist` strict duplicate/assignee/cycle UUID allowlist validation, `<<< >>>` fencing, `draftLinksOutside`), `AI_FEATURES` meter coverage (`packages/agent/test/meter-coverage.test.ts`), triage state machine unit guards.
  - PG17 DB tests: `project_triage_item` RLS matrix + `apps/kernel/test/invariant/projects-private.db.test.ts` structural catalog check & full actor matrix (`visibility = 'private'` denial for non-members across `SELECT`/`INSERT`/`UPDATE`/`DELETE`), `projects.triage.accept` creating `ludy_kernel.task` + `project_task` with `tainted` preserved and `position -> project` lock order, terminal state refusal on `reopen` for `accepted`/`merged`, `projects.mcp.triage_summary` private-project exclusion + `plainLine` scrubbing + company grantor enforcement, PDPL find/erase, `offboarding` export, `org_purge`, AI-off parity.
  - UI/E2E tests: Playwright or component verification for signal capture + rollup UI and Triage Inbox (`Accept`, `Merge`, `Snooze`, `Decline`, `Reopen`, `>= 44 px` touch targets, EN/VI, AI off).

### 7.2 Phased delivery & governance

| Phase | Issue | Depends on | Protected / `shared-core` / Review gates |
| --- | --- | --- | --- |
| Plan & ADR-0058 | [#4490](https://github.com/DOS/Ludy/issues/4490) | - | Docs-only PR (`pnpm docs:check`) |
| Step 0 Invariants | [#4491](https://github.com/DOS/Ludy/issues/4491) | `#4490` | Protected invariant file (`rls-matrix.db.test.ts` `PENDING_TABLES` + `ROW_FACTORIES`); Line PO independent security review |
| Slice 1: Omnichannel Signals | [#4492](https://github.com/DOS/Ludy/issues/4492) | `#4490`, `#4491` | Protected (`migrations`, `rls-matrix`, `rpc.ts`, `personal-data.ts`, `offboarding.ts`, `ludy_kernel.org_purge`); Platform PO `shared-core` review + Line PO independent security review + green CI |
| Slice 2: Triage Inbox, Vy AI & MCP | [#4493](https://github.com/DOS/Ludy/issues/4493) | `#4490`, `#4491` | Protected (`migrations`, `rls-matrix`, `projects-private.db.test.ts`, `rpc.ts`, `personal-data.ts`, `offboarding.ts`, `ludy_kernel.org_purge`, `agents.ts`); Platform PO `shared-core` review + Line PO independent security review + green CI |

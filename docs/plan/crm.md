# Ludy CRM, slice 1: deals, one pipeline board, saved views, contact import

> Plan for the first slice of the CRM module (`crm`, product name "Ludy CRM"), 2026-11-01. Owner decision of 2026-11-01 ([#2223](https://github.com/DOS/Ludy/issues/2223), kernel plan Decision 21): open the first CRM slice now, as an exception to Decision 2 for this slice only, like Decision 20 did for Calendar. It follows the shape of [calendar.md](calendar.md). The recommendation it carries out is decision 1 of the [CRM reference study](../research/crm-reference-study.md) (#2122); the study's decisions 2 to 4 (AI agents, capture from email and calendar, Vietnamese channels) are **not** part of this slice and wait for the owner. Focus per the owner's decision of 2026-10-31: one-person companies and SMEs first, no enterprise features. Vietnamese summary for the owner: [crm.vi.md](crm.vi.md).

## 1. Goal

Give a one-person company or a small team a place to see who it might sell to, how much, and how far along each sale is, next to the books it already keeps in Ludy.

After this slice a member can:
- keep **deals** (cơ hội bán hàng) on the contacts and companies Ludy already holds as `party`, each with an amount and an expected close date;
- see every open deal on **one pipeline board**, move a card from stage to stage by dragging it (or from a menu, on a phone), and close it as won or lost;
- **save a view** of the deals or the contacts (a filter and a sort), private or shared with the org;
- **import contacts and companies** from a CSV or Excel file, with a duplicate check on tax code, email and phone and a preview before anything is written.

The pilot deployment runs finance only, so nothing here is customer-visible yet. Build for quality, not speed: each step is one end-to-end PR (migration, command, contract, UI, tests).

## 2. Scope and non-goals

**In slice 1:**
- Deals on `party`: title, amount (a decimal string, NUMERIC in SQL, VND), expected close date, owner (a member), stage, order inside the stage, a reason when lost.
- One pipeline per org: ordered stages, editable by owners and admins, with the terminal stages Won and Lost. Moving a card is a command.
- Saved views for deals and for contacts: simple AND filters and one sort, private or shared.
- A contacts screen (list, search without Vietnamese marks, create) so views and import have somewhere to live.
- Import of contacts and companies: upload, map columns, preview with duplicates, commit as one audited command.
- Deal events on the party's timeline (`activity`).

**Not in slice 1 (they wait for the owner):**

| Out | Why |
|---|---|
| AI of any kind (summaries, next steps, drafts, capture, enrichment) | Study decisions 2 and 3; every AI write is a proposal and needs bulk approval first |
| Email, calendar or Zalo capture onto the timeline | Study decisions 3 and 4; needs the Service inbox and capture rules |
| Custom fields and custom objects | Each field needs a data class before agents may write it; one-person companies rarely need them first |
| A second pipeline, weighted forecast, probability per stage | A one-person company starts with one pipeline (study section 7) |
| Automations, workflow builder, agent templates for deals | The kernel process engine is the place, later |
| Products or line items on a deal, quotes, invoices from a deal | Accounting line decides the hand-off; a deal links to an invoice later |
| Person to company link, deal contacts beyond one party | `record_link` is a Phase 3 kernel item; decide with real demand |
| Record sharing, teams, territories | A one-person company has no sharing need |
| `/v1`, `/mcp`, outbound webhooks, import from another CRM | Not built; file import is enough |
| Native mobile app | The web app is phone-friendly (section 5); a native app waits |

## 3. Fit with what exists

| Need | Reuse | New |
|---|---|---|
| Who the deal is with | `crove_kernel.party` (`organization` or `person`, tax code unique per org, email, phone), its duplicate hints and "mark duplicate" (`packages/kernel/src/parties.ts`) | a `kernel.party.create` command (there is none: parties come from extraction and bookings today) |
| The crm module | `modules/crm` (manifest, event types, bookings), `MODULE_SCREENS.crm`, entitlement `crm` (Decision 10), `CROVE_MODULES` (ADR-0031) | tables, commands and screens for deals, stages and import |
| Timeline | `crove_kernel.activity`, written with `ctx.activity()`; a booking already writes one on its party (Calendar C5) | kinds `deal.created`, `deal.stage_changed`, `deal.won`, `deal.lost`, `party.imported` |
| Saved views | `crove_social.saved_view` (#1300): named filters, private or shared, per-member cap, restrictive RLS | a kernel `saved_view` and a small Filter AST, as the kernel plan lists (Phase 3 "Kernel additions"); Social is not moved in this slice |
| Order of cards | `modules/notes/src/sort-key.ts`: fractional keys, a move rewrites one row | moved to `@crove/kernel-contract` so both modules share it (section 6, CRM-5) |
| Money | NUMERIC in SQL, decimal strings on the wire, `@crove/l10n-vn` money helpers, `apps/app/src/components/amount-input.tsx` | none |
| File intake | `kernel.file` upload (`beginUpload`, `claimUpload`), the preview then import pattern of `finance.bank.preview` and `finance.bank.import` (`modules/finance/src/bank.ts`) | a staging table and the contact mapping |
| Excel | `exceljs` (patched, already used by Finance's exports) | reading `.xlsx` in the crm module (step K6) |
| Search without marks | `crove_kernel.search_fold` (Finance's search, #673), `pg_trgm` | a contact search query using it |
| Drag and drop | the native HTML5 drag events of `apps/app/src/components/social-board.tsx` | the deal board (no new dependency) |
| Org purge, export, personal data | `crove_kernel.org_purge` (#1024), the personal data registry (#923), data classes (#1599) | each new table added to the purge in its own migration; registry entries for the new `pii` columns |
| Notes on a party | `modules/notes` panel (`apps/app/src/components/notes-panel.tsx`) | shown in the contact panel; no change to notes |

## 4. Data model

All tables are tenant tables: `org_id`, `PRIMARY KEY (org_id, id)`, RLS through `crove_kernel.apply_tenant_rls`, foreign keys led by `org_id` and backed by an index, `timestamptz` only, money `numeric`. The crm module reaches only `crove_kernel` (the module schema rule, `tools/test/module-schemas.test.ts`). The G3 tenant conventions are checked by `packages/db/test/invariant/conformance.db.test.ts`: primary key `(org_id, id)`; foreign keys led by `org_id` and backed by an index; no `timestamp without time zone`; money columns `numeric`; no foreign key between module schemas except to `crove_kernel`. Every migration adds its tables to `crove_kernel.org_purge`: it copies the function forward from its newest definition on `main` (not from the CRM one of `20261030130100_crove_kernel_org_purge_crm.sql`, which is older) and adds the new tables in foreign-key order, children before parents. It also updates the module manifest with the class of every column, and regenerates `pnpm db:types`. A CHECK-constraint set is a const array in `packages/db/src/schema.ts` and is listed in `check-unions.db.test.ts`.

### 4.1 `crove_crm.pipeline_stage` (one pipeline per org)

| Column | Notes |
|---|---|
| `name` | 1 to 40 characters, one line |
| `kind` | `open`, `won`, `lost` |
| `position` | integer order, 1 upward, kept gapless by the commands under the pipeline lock; `UNIQUE (org_id, position) DEFERRABLE INITIALLY DEFERRED` so a reorder swaps positions in one transaction and a duplicate fails. The CHECK is `position >= 1` only (changed in K1): the 12-stage cap is the commands', so a cap that changes is not a migration |
| `created_at`, `updated_at` | |

Rules: at most 12 stages; exactly one `won` and one `lost` stage per org (`UNIQUE (org_id, kind) WHERE kind IN ('won','lost')`), always the last two positions; open stages can be renamed, reordered, added and removed (removal only when no deal is in the stage). A fresh org has no rows; `crm.pipeline.setup` creates the defaults on first use: "Mới", "Đã liên hệ", "Báo giá", "Thương lượng" (open), "Thắng" (won), "Thua" (lost). There is no `pipeline` table (CRM-2): a second pipeline later adds one with a backfill.

### 4.2 `crove_crm.deal`

| Column | Notes |
|---|---|
| `party_id` | the contact or company; composite FK `(org_id, party_id)` to `crove_kernel.party`, `ON DELETE RESTRICT` |
| `title` | 1 to 200 characters, one line; class `pii` (a title often carries a name) |
| `amount` | `numeric(20,2) NOT NULL DEFAULT 0 CHECK (amount >= 0)`, a decimal string everywhere else |
| `currency` | `CHECK (currency = 'VND')` for now; widening the check is a later migration (CRM-4) |
| `stage_id` | composite FK to `pipeline_stage`, `ON DELETE RESTRICT` |
| `sort_key` | `text COLLATE "C"`, the fractional order inside the stage (`sort-key.ts`) |
| `expected_close` | `date`, nullable |
| `owner_user_id` | the member in charge; composite FK to `crove_kernel.tenant_member` with `ON DELETE SET NULL (owner_user_id)`, so a removed member leaves the deal unowned |
| `lost_reason` | text up to 200 characters, only on a deal in a `lost` stage; class `pii` |
| `closed_at` | set when the stage kind is `won` or `lost`, cleared when a deal moves back to an open stage |
| `version` | optimistic concurrency, as `party.version`: an edit sends the version it read |
| `created_by`, `created_at`, `updated_by`, `updated_at` | |

Indexes: `(org_id, stage_id, sort_key)` for the board, `(org_id, party_id)` for a contact's panel, `(org_id, owner_user_id)`, and `(org_id, expected_close) WHERE closed_at IS NULL`. A deal's status (open, won, lost) is its stage's kind, never stored twice. Deals are not scoped to a legal entity (CRM-6): a deal is a sales intention, and the legal entity appears with the invoice.

### 4.3 `crove_kernel.saved_view`

A kernel table, because contacts and deals (and later Social, tickets, documents) share one model. Columns: `user_id` (the owner), `scope` (`crm.deal`, `crm.party`; a text matching `^[a-z]+\.[a-z_]+$`, checked by the command against the scope registry in `@crove/kernel-contract`), `name` (1 to 60), `filters` (jsonb object, at most 4 KB), `sort` (jsonb, nullable), `shared`, timestamps. Unique `(org_id, user_id, scope, name)`; at most 30 per member per scope, counted under a lock. The RLS and grants copy `crove_social.saved_view`: a member reads their own views and the org's shared ones; changes their own; an owner or admin may change or delete a shared one; a view goes with the membership (the foreign key cascades); the worker's system context reads and deletes them (purge); an agent context reads none.

**Filter AST**, version 1: `{ "v": 1, "all": [ { "field": "...", "op": "...", "value": ... } ] }`, at most 8 conditions, all ANDed. The registry says, per scope, which fields exist, their type, and which operators each accepts. A view stores only the AST; the server turns it into a Kysely `where`, so a view only ever narrows what RLS already lets the member read. Unknown field or operator: 422. A condition naming a stage or member that no longer exists matches nothing and is shown as "đã xóa" so the person can fix it.

| Scope | Fields (operators) |
|---|---|
| `crm.deal` | `search` on the title (contains, without marks), `stage` (in), `status` (open, won, lost), `owner` (is, is me, is empty), `party` (is), `amount` (at least, at most), `expected_close` (before, after, overdue, within next N days, is empty), `created` (within last N days) |
| `crm.party` | `search` on name, email, phone, tax code (contains, without marks), `kind` (is), `has_email`, `has_phone`, `has_tax_code` (yes or no), `has_open_deal` (yes or no), `created` (within last N days) |

Sort: one of a scope's sortable fields (`created`, `name`, `amount`, `expected_close`, `updated`), ascending or descending, with the id as the tie-breaker so paging is stable. Nested AND/OR groups wait (study section 7: "Later").

### 4.4 Import staging: `crove_crm.import_batch` and `crove_crm.import_row`

`import_batch`: `filename`, `status` (`staged`, `committed`, `cancelled`, `expired`), `on_duplicate` (`skip` or `fill_empty`, set at commit), counts (`total_rows`, `new_rows`, `duplicate_rows`, `conflict_rows`, `invalid_rows`, `created_rows`, `updated_rows`), `created_by`, `created_at`, `decided_at`. The CSV is read in the browser, as the bank statement import does: the file is never stored, so there is no `file_id`, no claim and no parsing sandbox, and no file with personal data to keep or purge.

`import_row`: `batch_id`, `row_no`, the normalized fields (`kind`, `name`, `tax_code`, `email`, `phone`, `address`; classes `pii`, `contact`, `national_id_if_individual` as on `party`), `outcome` (`new`, `duplicate`, `conflict`, `invalid`), `reason` (a fixed code such as `DUPLICATE_TAX_CODE`, never a value), `match_party_id`.

Retention (CRM-9): rows live only while a batch is `staged`. Commit and cancel delete them in the same transaction. A batch staged for more than 7 days is refused (a commit answers `expired`) and its rows are deleted the next time any import command runs in that org (K5, lazy expiry); a scheduled worker sweep deletes them across orgs, so an org that never imports again keeps nothing (K5b). Only the counts stay. Rows carry personal data, so the batch tables join the personal data registry and the org purge.

### 4.5 Phone key

Matching on phone needs one form for `0912...`, `+84 912...` and `84912...`. A pure function `phoneKey()` in `@crove/kernel-contract` (strip spaces and punctuation, turn a leading `+84` or `84` into `0`) has an immutable SQL twin `crove_kernel.phone_key(text)` and an expression index `party (org_id, crove_kernel.phone_key(phone))`; a test runs both on one table of cases. Stored `party.phone` is not rewritten.

## 5. Commands, queries and risk

Every state change is a command through `Runtime.execute()`; each declares risk and side effect, and `apps/kernel/test/side-effects.test.ts` fails on one that does not. All are R1, `sideEffect: 'internal'`: they change only the org's own records, send nothing and post nothing to the ledger. No command is R2 or R3, and none is a proposal. **Agents write none of them**: the agent write allowlist (ADR-0029) is unchanged, and every deal, stage, view and import command refuses a non-user actor. Viewers read only.

| Command | Access | What it does |
|---|---|---|
| `crm.pipeline.setup` | owner, admin, member | Creates the default stages when the org has none; idempotent |
| `crm.stage.add`, `rename`, `reorder`, `remove` | owner, admin | Edits the open stages within the rules of 4.1 |
| `crm.deal.create` | owner, admin, member | Creates a deal in the first open stage (or a chosen one), writes `deal.created` on the party's timeline |
| `crm.deal.update` | owner, admin, member | Title, amount, expected close, owner, party; refused with `STALE_VERSION` when someone saved in between |
| `crm.deal.move` | owner, admin, member | Moves to a stage and a place (`before` or `after` a deal, or the end), sets or clears `closed_at`, takes a `lostReason` for Lost; writes `deal.stage_changed`, `deal.won` or `deal.lost` |
| `crm.deal.delete` | owner, admin, or the deal's creator | Hard delete; the audit row keeps the field names and class markers, never the title or amount (`auditValue`, #1626) |
| `kernel.party.create` | owner, admin, member | A person or company by hand: name, tax code, email, phone, address, validated as `kernel.party.update` is; a tax code already used refuses with the existing party named |
| `kernel.saved_view.save`, `rename`, `set_shared`, `delete` | any member for their own; owner or admin for a shared one | Per section 4.3 |
| `crm.import.stage` | owner, admin, member | Takes the rows the browser read and mapped (at most 2,000), checks each one as `kernel.party.update` does, classifies it, writes `import_row`s; writes no party |
| `crm.import.commit` | owner, admin, member | Re-checks each staged row against the party table now, creates the new parties, optionally fills the empty fields of duplicates, deletes the rows, writes one audit row with the counts and a `party.imported` activity per created party; answers the counts and the rows it skipped, with their reason codes; idempotent on a committed batch, and `expired` on one past 7 days |
| `crm.import.cancel` | the batch's creator, owner, admin | Deletes the staged rows |

Queries (R0, read only; RLS decides what a member sees): `crm.party.search` (a few parties by name or tax code, for the deal form's picker, until K4's contact list), `crm.stage.list`, `crm.deal.board` (open stages with their cards, count and amount sum per stage, plus the closed deals of the last 30 days), `crm.deal.list` (cursor paging, view or ad-hoc filter), `crm.deal.get`, `crm.party.deals`, `crm.contact.list`, `kernel.saved_view.list`, `crm.import.preview` (the staged rows with outcomes, a page at a time).

**Derived facts.** Activity summaries are fixed text plus the stage name, never a deal title, amount or contact value (activity's rule). From K2 the commands emit invalidation hints (`crm.deal`, `crm.party`) carrying only the id, so the board refreshes through the stream (#69); K1's list refreshes after the member's own changes. The new entity `crm.deal` joins the module manifest's `entities` (not legal entity scoped, audited by command).

**Import checks.** A row is classified, in this order of precedence:
1. `invalid`: empty name, or an email, phone or tax code that fails the same normalizers as `kernel.party.update`, or a field over its length. Skipped, with a fixed reason code.
2. `duplicate`: its tax code (exact, after `normalizeTaxCode`), else its email (case-folded), else its `phoneKey` equals one party's. A duplicate of an earlier row of the same file counts too. With `skip` (the default) nothing is written; with `fill_empty` only the existing party's empty fields are filled and a non-empty value is never overwritten.
3. `conflict`: its keys match two different parties (the email of one, the phone of another). Skipped and listed; "mark duplicate" is for the owner to decide afterwards.
4. `new`: everything else.

A phone or email alone is a weak key (a family shares a phone), so the preview names the key that matched and the existing party, and the person can switch a batch to `skip` for all or `fill_empty`. At most 2,000 rows and 5 MB per file (CRM-8).

## 6. UI

The CRM app on the rail gains two items in its group, next to "Lịch hẹn": **Cơ hội** (`/crm/deals`) and **Liên hệ** (`/crm/contacts`), declared in `CRM_SCREENS` (`packages/kernel-contract/src/screens.ts`) with Vietnamese and English labels. With `crm` out of `CROVE_MODULES` none of it appears. Text is Vietnamese first, with the English translations in `apps/app/src/i18n`.

- **Deals, board view.** One column per stage in order, a header with the stage name, the number of cards and the sum of their amounts. A card shows the title, the party's name, the amount, the expected close date (in red when overdue) and the owner's initials. Drag a card to another column or to another place in its column; the move is optimistic and rolls back with a message if the server refuses (a stale version, a removed stage). Every card also has a "Chuyển giai đoạn" menu, so the board works with a keyboard and on a phone, where the columns scroll sideways. Dropping on Thua asks for a reason (optional). Won and Lost show the last 30 days, with a link to the list for all.
- **Deals, list view.** The same deals as a table (title, party, stage, amount, expected close, owner), sortable, with cursor paging. The board and the list share one filter bar and one set of view tabs. Under 640 px the list is the default.
- **Views.** Tabs above the filter bar: "Tất cả", then the member's private views, then the org's shared ones. Changing a filter shows "Lưu thành chế độ xem"; saving asks for a name and private or shared. An owner or admin can edit a shared view.
- **Deal form.** A side panel: title, party (a search over contacts, with "Thêm liên hệ mới" inline), amount (the existing amount input), expected close, owner (default: the creator).
- **Contacts.** A table of every party with search without Vietnamese marks, a kind filter, the same view tabs, "Thêm liên hệ" and "Nhập từ tệp". A row opens a panel with the party's fields (the existing edit form), its deals with "Thêm cơ hội", its notes (the notes panel) and its timeline.
- **Import wizard.** Four steps: choose the file; map columns (guessed from Vietnamese and English headers, editable); preview (counts of new, duplicate, conflict and invalid rows, the first rows of each, the key that matched, the duplicate choice); import. A finished batch shows the counts and a download of the rejected rows.
- **Pipeline settings.** In the deals screen's menu: rename, add, reorder and remove open stages (owners and admins).

## 7. Steps (one PR each, end to end, no milestone, P2, labels `crm` and `line:notes-crm`)

Each step is built in order after the plan merges. "Protected" means the PR touches a path of the protected list (every migration, and any kernel command or other path on that list, is one): the worker reports it READY with its head SHA to the line's PO, who forwards it to the coordinator's Opus security review, and the coordinator merges. The other PRs merge after the line's PO acceptance. Right before every merge: merge `origin/main`, run `pnpm migration:rebase` (migration versions are not reserved), push and wait for green.

| Step | Scope | Protected | Exit |
|---|---|---|---|
| K1 | Deals and the pipeline: migration for `pipeline_stage` and `deal` (with purge, manifest, registry, check-union array, `db:types`); `sort-key.ts` moved to `@crove/kernel-contract`; `crm.pipeline.setup`, `crm.deal.create`, `update`, `move`, `delete`; the queries `crm.stage.list`, `crm.deal.list`, `get`, `party.deals`; screen "Cơ hội" in list view with the deal panel; deals and their events on the party's timeline | yes (migration) | A deal is created, edited, moved and deleted by a member and read back with a decimal-string amount; cross-org and viewer cases refuse; moving into Won sets `closed_at` and out of it clears it; the audit row never holds a title or amount; the org purge removes the rows; RLS, conformance, manifest and write-path suites pass |
| K2 | The board: `crm.deal.board`, drag and drop with optimistic move and rollback, the card menu, Won and Lost handling with the lost reason, pipeline settings (`crm.stage.*`) | no | e2e: create three deals, drag one to Báo giá and one to Thắng, reload, the order and sums hold; two browsers moving one card get one winner and one refusal; the board works with the keyboard and at 375 px |
| K3 | Saved views: migration for `crove_kernel.saved_view`; the Filter AST schema and scope registry in `@crove/kernel-contract`; the filter-to-SQL builder; `kernel.saved_view.*`; view tabs and the filter bar on the deals screen | yes (migration) | A private view is invisible to other members, a shared one is visible and editable only by its owner or an admin; the 31st view of a scope is refused; every operator has a test against real rows; a view cannot widen what RLS allows; an unknown field is a 422; the same filter gives the same rows on the board and the list |
| K4 | Contacts: `kernel.party.create`, `phoneKey` and its SQL twin (migration with the expression index), `crm.contact.list` with search without marks, the "Liên hệ" screen with views (scope `crm.party`), the contact panel with deals, notes and timeline | yes (migration) | Typing "nguyen" finds "Nguyễn"; a duplicate tax code refuses and names the party; the TS and SQL phone keys agree on every case of one table; a contact view works like a deal view |
| K5 | Contact import, CSV: migration for `import_batch` and `import_row`; `crm.import.stage`, `commit`, `cancel`, `preview` (the CSV is read in the browser; the rejected rows come back from the commit as row numbers and reason codes); lazy expiry of staged batches; the wizard | yes (migration) | A 2,000-row file stages and previews with nothing written to `party`; commit creates exactly the `new` rows, a second commit creates none; rows duplicate by tax code, email or phone are skipped or filled as chosen and a non-empty value is never overwritten; two parties matched by one row are a conflict; a batch past 7 days is refused and loses its rows the next time an import command runs in its org; the audit row holds counts only |
| K5b | Sweep of expired import staging across orgs: a definer for the worker (as the notes trash sweep), a daily queue and cron, declared with no egress, the invariant lists it needs | yes (migration and invariant lists) | A staged batch past 7 days in an org that never imports again loses its rows and is marked expired; the function refuses every caller but the worker login; the queue is registered with the module and dropped without it |
| K6 | Contact import, Excel: the first sheet of an `.xlsx` is read in the browser by the app's own reader (`apps/app/src/lib/xlsx.ts`: the zip's parts inflate to a bounded size, no formula is run, only the first sheet; the kernel image parses no document, gate T12), so no new dependency; a number cell's lost leading zero is put back on a phone or tax code; a sample workbook to download | no | The same contacts as an `.xlsx` and as a `.csv` give the same rows; a file that is not a workbook, an oversized one, a workbook with macros and a sheet with a formula cell are refused with a clear message (the issue asks for it; nothing in a file is ever run and no formula is calculated) |
| K7 | Close-out: an e2e of the whole slice (import, create a deal for an imported contact, move it, save a view, see the timeline), the `crm` module alone and switched off in CI, user guide entry, owner summary refreshed | no | `docker compose up` runs the flow with no external account; with `crm` off the app shows no CRM item beyond what is enabled; the slice's exit criteria below are checked one by one in the PR |

K1 to K7 and K5b (#2251) are P2 issues "Part of #2223". Anything a review finds that is not blocking goes to the Icebox as P3, as AGENTS.md says. One follow-up is already known: move `crove_social.saved_view` onto the kernel `saved_view` (Icebox, P3, after K3).

## 8. Exit criteria (slice 1)

- Every state change goes through `Runtime.execute()`; no agent writes any crm table; the invariant suites (RLS matrix, write path, conformance, manifest, org purge) pass for every new table.
- Amounts are NUMERIC and decimal strings end to end, summed in SQL per stage with no JavaScript number arithmetic.
- A member sees only their org's deals and views; a private view is invisible to the others.
- Two people moving one card never lose a move silently: one wins, the other sees a clear refusal.
- An import writes nothing before commit, never overwrites a non-empty field, never imports a row twice, and leaves no personal data in staging after commit, cancel or 7 days.
- `docker compose up` gives a working slice with no external account, and the screens work at 375 px and with a keyboard.

## 9. Decisions and open questions

Decisions the plan makes (the line's PO and the coordinator can overturn any of them before its step starts):

| # | Decision | Why |
|---|---|---|
| CRM-1 | Deals, stages and import live in the `crm` module; saved views live in the kernel | A deal is a CRM concept nothing else needs; a saved view is shared by every module that lists records, and the kernel plan already lists it as a kernel addition |
| CRM-2 | One pipeline per org and no `pipeline` table | The owner's scope says one pipeline; a table with one row per org adds commands and screens nobody uses. A second pipeline later is one migration with a backfill |
| CRM-3 | Stages are rows per org, seeded lazily with Vietnamese defaults; Won and Lost are fixed and last | A board needs ordered, renamable stages; terminal stages need fixed meaning for `closed_at`, sums and filters |
| CRM-4 | Amounts are VND only, `numeric(20,2)`, with a `currency` column checked to `VND` | Pilot customers sell in VND; the column is there so another currency is a widened CHECK and not a new column. Foreign-currency deals are an open question |
| CRM-5 | The fractional sort key moves to `@crove/kernel-contract`, not copied | The module graph forbids crm importing notes; two copies would drift. The move is a refactor with its tests, done in K1 |
| CRM-6 | Deals are not scoped to a legal entity | A deal is not a ledger fact; the entity appears with the invoice. Revisit if a firm runs several entities with separate pipelines |
| CRM-7 | Saved views hold simple ANDed conditions and one sort; the registry lives in the contract so the UI and the server cannot disagree | Study section 7 marks nested AND/OR as later; a typed registry stops a stored view from naming a field the server does not know |
| CRM-8 | Import is staged rows plus one audited command, not proposals; 2,000 rows and 5 MB per file | A person uploads, reviews and commits, so there is no tainted author; 2,000 proposals would bury the Inbox. The cap keeps a commit inside one transaction; raise it when a customer needs more |
| CRM-9 | Staging rows are deleted on commit, on cancel and after 7 days (lazy expiry in K5, a scheduled sweep in K5b) | They carry personal data; only counts are worth keeping, and the audit row has them. The sweep is a definer for the worker, as the notes trash sweep is, so it needs its own migration and invariant step |
| CRM-10 | Imported parties get `source_trust = 'external'` | A customer's spreadsheet is content from outside, as a bank statement is; no agent reads CRM data in this slice, so nothing is blocked today and the stricter default is the safe one |
| CRM-11 | Duplicates are matched on tax code, then email, then phone, and the default is to skip | Tax code is unique per org already; email and phone are weaker, so the preview shows which key matched and nothing is overwritten unless the person picks `fill_empty` |
| CRM-12 | Deleting a deal is a hard delete with an audit row | The audit log is the record; a soft-delete flag would need every query to filter it. Closed deals stay as Won or Lost |
| CRM-13 | Activity rows go on the party's timeline with fixed text and the stage name | Activity summaries never carry classified values; the party's timeline is where a booking already shows |
| CRM-14 | No new dependency for drag and drop, and a menu beside it | The native events of `social-board.tsx` already work; the menu is needed for keyboards and phones anyway |
| CRM-15 | Marking a party duplicate leaves its deals where they are | The kernel cannot reach crm tables (module graph); the deal panel shows a "duplicate of ..." hint and `crm.deal.update` moves the deal to the other party |

Open questions, each with the default the build takes if nobody answers:

| # | Question | Who | Default |
|---|---|---|---|
| CRM-Q1 | Do pilot customers sell in other currencies? | PO, from the pilot | VND only |
| CRM-Q2 | Does an import need an undo? | PO | No in slice 1; the audit row lists the counts, and wrong rows are edited or marked duplicate. A 24-hour undo needs a rule for parties that gained notes or deals since |
| CRM-Q3 | Should a won deal offer "create an invoice"? | Accounting line | Not in slice 1; a link between a deal and a sales invoice is its own plan |
| CRM-Q4 | Is a pipeline of four open stages the right default for Vietnamese SMEs, and do we want a fixed list of lost reasons? | PO | The four stages of 4.1 and a free-text reason |
| CRM-Q5 | Should a person be linked to the company they work for? | PO | Not in slice 1; deals sit on either kind of party |
| CRM-Q6 | Should the contact list hide vendors that only exist from purchase invoices? | PO | No: it shows every party; the `has_open_deal` filter and views cover the rest |

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Crove Notes & Personal To-dos v2: Todoist + Evernote replacement

> Plan for Notes & Personal To-dos v2 (module `notes`, milestone M3 Paid pilot, `priority:P2`, line `line:projects`), 2026-11-17. Builds on [notes.md](notes.md), [ADR-0037](../adr/0037-private-notes-and-todos.md) (Accepted), [ADR-0049](../adr/0049-member-scoped-vy.md) (Accepted), [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) (Accepted), and the OPC/SME scope gate [scope.md](../product/scope.md). Approved by owner JOY on 2026-11-17 (decisions `A1` to `A4`, section 2). Step 0 invariant baseline: [#3555](https://github.com/DOS/Ludy/issues/3555); build slices: [#3556](https://github.com/DOS/Ludy/issues/3556) to [#3564](https://github.com/DOS/Ludy/issues/3564).

## 1. Goal, OPC/SME fit, and boundaries

Upgrade `notes` and `Việc của tôi` (My Work) into a fast, zero-setup replacement for Todoist and Evernote inside Ludy, tailored for Vietnamese one-person companies (OPC) and SMEs.

Checked against [scope.md](../product/scope.md):

1. **Fit:** solo founders, bookkeepers, and small teams capture ad-hoc client notes, web snippets, attachments, and daily recurring to-dos every day/week.
2. **Smallest useful slice (zero-setup defaults):** Inbox / unfiled to-dos and unfiled notes work immediately with zero setup. Built-in Vietnamese SME templates (`Bien ban hop`, `Ghi chu khach hang`, `SOP quy trinh`, `Nhat ky cong viec tuan`) ship out of the box. Extension Quick Capture works with 0 extra browser permissions.
3. **AI part named:** Member-scoped Vy coworker (`ADR-0049`) adds two interactive Stage A capabilities in `My Work` and `Notes`: `notes.todo_plan` ("Vy sap lich hom nay") and `notes.organize` ("Vy don hop thu"). Both run through `metered(...)` under module budgets and kill switches; every output carries the `"De xuat"` tainted badge and requires 1-click human confirmation before any write runs. With AI off or out of budget, 100% of Todoist + Evernote workflows work normally.
4. **Coworker naming:** Vy leads across apps and is both a coworker and assistant; `notes` keeps Vy as its coworker.
5. **Not in scope (no Notion relational database bloat):** real-time multi-user CRDT co-editing, custom relational databases/rollups/formulas, client-held end-to-end encryption keys (`ADR-0037` Option E), public/unauthenticated note pages, email-in to notes, and in-note voice recording (`meetings` already owns voice/video capture).

## 2. Owner decisions (2026-11-17)

| # | Topic | Decision (JOY, 2026-11-17) | Rationale and constraint |
|---|---|---|---|
| A1 | Scope | **Full scope Waves 1-3** (Todoist T1-T4b + Evernote E1-E5b, slices `V2-0` to `V2-9`) | Delivers a complete Todoist + Evernote replacement end to end without Notion relational complexity |
| A2 | Extension permissions | **Optional `activeTab` + `scripting` on Web Clipper toggle only** | Popup Quick Capture needs 0 extra permissions; Web Clipper requests `activeTab` + `scripting` via `chrome.permissions.request` only when the user enables the toggle (and revokes when disabled), reading page text via `apps/extension/src/page-capture.ts` only on explicit Clip click |
| A3 | Attachment storage & search | **Isolated `crove_notes.attachment` (`<= 25 MB`) in `BlobStore` (`notes/<orgId>/<attachmentId>`) + internal `crove-extract` indexing** | Never writes to `crove_kernel.file` (prevents cross-member org read, `sha256` existence oracle, and un-deletable versioned file retention); supports clean blob deletion on delete/trash/purge/PDPL/org purge with zero external egress |
| A4 | Milestone & priority | **`M3 Paid pilot`, `priority:P2`** (`line:projects`) | Ships in M3 Paid pilot after Step 0 invariants (`#3555`) land on `main` |

## 3. Data model, ADR-0037 privacy, PDPL, offboarding, and `org_purge`

Every new table carries `org_id`, `PRIMARY KEY (org_id, id)`, `crove_kernel.apply_tenant_rls`, and remains closed to org-chart agents under the `#285` write guard. None of the five new tables is added to `crove_kernel.member_vy_table`, which stays pinned to `crove_notes.note` (`read`) only (`member-vy-background.db.test.ts`).

### 3.1 New tables

| Table | Key columns (with #1599 class) | ADR-0037 / ADR-0049 RLS rule | Deletion & cleanup |
|---|---|---|---|
| `crove_notes.todo_list` | `org_id`, `id`, `owner_user_id` (no FK to `tenant_member`), `name` (`pii`), `color`, `sections` (`jsonb`, `pii`), `sort_key` (`text COLLATE "C"`), `created_at`, `updated_at` | Strictly author-only (`owner_user_id = crove_kernel.ctx_user_id()`, matching `crove_notes.todo`). System context, other members, owners, admins, viewers, and all agent contexts read/write 0 rows (`AUTHOR_ONLY`: `'false'`; `MEMBER_VY_READS`: `() => 'false'`) | Deleted in `member_items_purge`, PDPL `private_erase`, and `crove_kernel.org_purge` (after `todo`) |
| `crove_notes.notebook` | `org_id`, `id`, `author_user_id` (no FK to `tenant_member`), `visibility` (`'private' | 'org'`), `name` (`pii`), `stack_name` (`pii`), `pinned`, `sort_key` (`text COLLATE "C"`), `created_at`, `updated_at` | Matches `crove_notes.note` using `ctx_user_id()`: private notebooks author-only; `'org'` notebooks read by whole-org owners/admins/members and system context (for org export). Out of `member_vy_table` (`AUTHOR_ONLY`: `visibility = 'org'`; `MEMBER_VY_READS`: `() => 'false'`) | Trigger prevents `'org'` note referencing a `'private'` notebook. Deleted in `member_items_purge` (private), PDPL `private_erase` / owner edit (shared), and `org_purge` |
| `crove_notes.note_template` | `org_id`, `id`, `author_user_id` (no FK to `tenant_member`), `visibility` (`'private' | 'org'`), `name` (`pii`), `title` (`pii`), `body` (`pii`), `tags` (`text[]`, `pii`), `created_at`, `updated_at` | Matches `crove_notes.note` using `ctx_user_id()`: private templates author-only; `'org'` templates read by whole-org members and system context (`AUTHOR_ONLY`: `visibility = 'org'`; `MEMBER_VY_READS`: `() => 'false'`) | Deleted in `member_items_purge` (private), PDPL `private_erase` / owner edit (shared), and `org_purge` |
| `crove_notes.note_version` | `org_id`, `id`, `note_id` (FK to `crove_notes.note` ON DELETE CASCADE), `author_user_id`, `revision` (`integer`), `title` (`pii`), `body` (`pii`), `tags` (`text[]`, `pii`), `created_at` | Inherits parent note visibility with `(SELECT crove_kernel.ctx_agent_id()) IS NULL AND EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = note_version.org_id AND n.id = note_version.note_id)`. Agent contexts (including `member_vy`) read 0 rows (`MEMBER_VY_READS`: `() => 'false'`); system context reads `'org'` note snapshots only (`AUTHOR_ONLY`). 20-snapshot automatic retention per note | Cascades on note delete/trash purge/member purge; PDPL erasure removes/redacts snapshots so erased PII never persists in version history; deleted in `org_purge` |
| `crove_notes.attachment` | `org_id`, `id`, `note_id` (FK to `crove_notes.note` ON DELETE CASCADE), `author_user_id`, `filename` (`pii`), `content_type`, `size_bytes` (`> 0 AND <= 26214400`), `sha256`, `storage_key` (`notes/<orgId>/<attachmentId>`), `extracted_text` (`pii`), `extract_status`, `created_at` | Inherits parent note visibility with `(SELECT crove_kernel.ctx_agent_id()) IS NULL AND EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = attachment.org_id AND n.id = attachment.note_id)` (`MEMBER_VY_READS`: `() => 'false'`; `AUTHOR_ONLY`: parent `visibility = 'org'`). Trigger folds `extracted_text` into parent `crove_notes.note.search`. Never inserts into `crove_kernel.file` | Enqueues `BlobStore` deletion on attachment delete, `trash_empty`, `member_items_purge`, PDPL `private_erase`, and `crove_kernel.org_purge` (returns attachment blob keys in `blob_keys`) |

### 3.2 Extensions to existing `crove_notes` tables

- **`crove_notes.todo`:**
  - `V2-1` (`#3558`): `priority` (`smallint NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4)`), `tags` (`text[] NOT NULL DEFAULT '{}'`, folded into `todo.search` by trigger), `list_id` (`uuid`, FK to `crove_notes.todo_list` ON DELETE SET NULL), `section_id` (`text`).
  - `V2-3` (`#3557`): `recurrence` (`jsonb`, strict CHECK constraining `freq IN ('daily', 'weekly', 'monthly')`, `interval BETWEEN 1 AND 365`, `by_weekday` in `0..6`, `by_month_day = -1 OR BETWEEN 1 AND 31`), `series_id` (`uuid`). Completing a recurring to-do preserves the completed row in history and atomically creates the next open occurrence in one transaction with checklist steps reset to `done: false`, shifted `due_on`/`due_at`/`remind_at`, and shared `series_id`.
- **`crove_notes.note`:**
  - `V2-4` (`#3559`): `notebook_id` (`uuid`, FK to `crove_notes.notebook` ON DELETE SET NULL).

### 3.3 Attachment HTTP edge & extraction security (`A3`)

- Upload/download go through dedicated authenticated routes in `apps/kernel/src/http.ts`: `POST /api/notes/:noteId/attachments` and `GET /api/notes/attachments/:id`.
- Both routes enforce `authenticate()`, parent `crove_notes.note` visibility/author checks via `Runtime`, and explicitly refuse extension tokens (`403 FORBIDDEN`).
- Downloads always send `X-Content-Type-Options: nosniff`, sandboxed/safe inline CSP headers for images and PDFs, and `Content-Disposition: attachment` for all other content types (including DOCX/HTML/SVG).
- Extraction runs asynchronously in a worker job calling `crove-extract` on internal network only (zero external egress); worker reaches private attachments strictly through named `SECURITY DEFINER` functions returning only `org_id`, `id`, `storage_key`, `content_type` and updating `extracted_text`/`extract_status` without returning note text.

### 3.4 PDPL, offboarding, and `org_purge`

- `modules/notes/src/manifest.ts` classifies every new `pii` column (`todo_list.name`, `todo_list.sections`, `todo.tags`, `notebook.name`, `notebook.stack_name`, `note_template.*`, `note_version.*`, `attachment.filename`, `attachment.extracted_text`).
- `packages/kernel/src/personal-data.ts` registers all new `pii` columns (private vs `unless_shared`), updates `private_matches`/`private_notice_items`/`private_erase`, deletes/redacts `note_version` history on erasure, and collects attachment `storage_key`s for blob cleanup.
- `packages/kernel/src/offboarding.ts` exports shared (`visibility = 'org'`) notebooks/templates (never private items; private counts only).
- `crove_kernel.org_purge` deletes all `crove_notes` child and parent tables (returning attachment `blob_keys` for bucket cleanup) before deleting kernel `task` rows.

## 4. Member-scoped Vy AI features (ADR-0049)

Both new features run interactively in Stage A under the caller's own sealed user context, gated by `vy.use`, module AI budget, and kill switches (`AI_FEATURES` keys added in `V2-8` `#3563`; `ADAPTER_NOTES_KEYS` pre-registered in `V2-0` `#3555`):

1. **`notes.todo_plan` ("Vy sap lich hom nay"):** reads the caller's open/overdue to-dos (`crove_notes.todo`), sends 6x JSON-escaped prompt-bounded data to `generateTodoPlanText` (`metered('notes.todo_plan', ...)`), and validates the response against a strict schema that drops any hallucinated `todoId` or invalid date. Returns a tainted `"De xuat"` plan (top-3 focus items + overdue reschedule suggestions); applying runs the caller's own `notes.todo.reschedule` / `notes.todo.update` only on 1-click confirmation.
2. **`notes.organize` ("Vy don hop thu"):** reads the caller's unfiled notes (`crove_notes.note`) and notebooks (`crove_notes.notebook`), sends prompt-bounded data to `generateNoteOrganizeText` (`metered('notes.organize', ...)`), and validates suggested notebook IDs/names and `#tags` deterministically. Applying runs the caller's own `notes.note.update` only on 1-click confirmation.

`packages/agent/src/note-ai-model.ts` retains its single-return AST shape (`maxOutputTokens: 2000`, `maxRetries: 0`, `abortSignal`, zero tools, zero helper branches) enforced by `packages/agent/test/invariant/member-vy-boundary.test.ts`.

## 5. Browser extension scope and write-only boundaries (E4)

- **Scope `'notes'`:** added in `V2-7` (`#3560`) to `EXTENSION_SCOPE_IDS`, `EXTENSION_SCOPES`, `crove_kernel.extension_token` CHECK constraint (allowing standalone `'notes'` or combined scopes), and `apps/kernel/src/auth-extension.ts`.
- **Write-only commands (`REACHABLE_WHEN_LANDED` in `V2-0`, moved to `REACHABLE` in `V2-7`):**
  - `notes.note.clip:notes`: creates a `visibility: 'private'`, `tainted: true` note with bounded Markdown + source URL.
  - `notes.todo.quick_capture:notes`: creates a private to-do with Quick Add metadata.
  - `notes.extension.exchanged:notes`: audits token exchange when connected with `notes` scope without `meetings`.
- **Read routes stay closed to extension tokens (`route-coverage.test.ts`):** `/api/rpc/notes/get`, `/api/rpc/notes/list`, `/api/rpc/notes/search`, `/api/rpc/notes/panel`, `/api/rpc/notes/exportMine`, `/api/rpc/notes/vyResults`, `/api/rpc/notes/privateCounts`, `/api/rpc/notes/todos/list`, `/api/rpc/notes/todos/get`, `/api/rpc/notes/todos/myWork`, `/api/rpc/notes/todos/counts`, and attachment download/upload routes (`/api/notes/:noteId/attachments`, `/api/notes/attachments/:id`) all refuse extension tokens (`403 FORBIDDEN`).
- **Optional Web Clipper permissions (`A2`):** popup Quick Capture uses 0 extra manifest permissions; Web Clipper requests `optional_permissions: ["activeTab", "scripting"]` only when toggled on by the user and revokes them when toggled off.

## 6. Build slices (`V2-0` to `V2-9`)

All slices target milestone `M3 Paid pilot`, `priority:P2`, line `line:projects`.

| Slice | Issue | Scope | Depends on | Acceptance summary | Protected / shared-core |
|---|---|---|---|---|---|
| `V2-0` | [#3555](https://github.com/DOS/Ludy/issues/3555) | Plan doc (`docs/plan/notes-v2.md`) and Step 0 two-step invariants (`rls-matrix.db.test.ts`, `member-vy-boundary.test.ts`, `extension-scope.db.test.ts`, `route-coverage.test.ts`) | - | `docs:check`, `lint`, `typecheck`, `test`, and PG17 invariant DB tests pass; `crove_kernel.member_vy_table` unchanged | Yes (invariant suite; shared-core review if loosening, else two-step additions) |
| `V2-1` (T1) | [#3558](https://github.com/DOS/Ludy/issues/3558) | `crove_notes.todo_list`, sections, `todo.priority` (P1-P4), `todo.tags`, sidebar filtering, PDPL & `org_purge` wiring | `#3555` | Zero-setup Inbox works immediately; lists, sections, P1-P4, `#tags` isolated strictly to owner (ADR-0037) | Yes (migration, `org_purge` shared-core, invariant suite) |
| `V2-2` (T2) | [#3556](https://github.com/DOS/Ludy/issues/3556) | Deterministic `vi`/`en` Quick Add parser (`@crove/l10n-vn`), live dismissible chips, global `Alt+Q` capture shortcut | `#3555` | Deterministic `< 5ms` parsing offline with 0 AI calls; dismissing a chip restores literal text | No |
| `V2-3` (T3 & T4a) | [#3557](https://github.com/DOS/Ludy/issues/3557) | `todo.recurrence` + `series_id` (atomic completion + next occurrence with reset checklist), `notes.todo.reschedule` bulk/1-click overdue, `Sap toi` 7/30-day agenda | `#3555` | Recurring history preserved; timezone-aware `-1` month-end; overdue reschedule & drag/keyboard agenda work under ADR-0037 | Yes (migration) |
| `V2-4` (E1) | [#3559](https://github.com/DOS/Ludy/issues/3559) | `crove_notes.notebook` + 2-level stacks, `note.notebook_id` (no org note in private notebook), preview checkbox toggling, `[[Note]]` wiki-links + RLS-safe Backlinks | `#3555` | Unfiled notes work with zero setup; preview checkboxes persist with revision check; zero private title leakage in Backlinks | Yes (migration, `org_purge` shared-core, invariant suite) |
| `V2-5` (E2) | [#3561](https://github.com/DOS/Ludy/issues/3561) | `crove_notes.attachment` (`<= 25 MB`, `notes/<orgId>/<attachmentId>`), clipboard paste, inline image/PDF preview, `crove-extract` full-text search, blob cleanup | `#3555` | Paste/drop `<= 25 MB` previews inline and indexes text locally; strict ADR-0037 isolation; never touches `crove_kernel.file` | Yes (migration, `http.ts` & `org_purge` shared-core, invariant suite) |
| `V2-6` (E3) | [#3562](https://github.com/DOS/Ludy/issues/3562) | `crove_notes.note_template` + Vietnamese SME starter templates, `crove_notes.note_version` (20-snapshot auto-retention, diff & 1-click restore) | `#3555` | Built-in starters work with zero setup; 20-snapshot restore works; PDPL & trash purge erase historical snapshots | Yes (migration, `org_purge` shared-core, invariant suite) |
| `V2-7` (E4) | [#3560](https://github.com/DOS/Ludy/issues/3560) | Extension `'notes'` scope (`EXTENSION_SCOPE_IDS`, `EXTENSION_SCOPES`, `auth-extension.ts`), write-only `clip` / `quick_capture` / `exchanged`, optional `activeTab` + `scripting` Web Clipper | `#3555` | Quick Capture uses 0 extra permissions; Web Clipper requests `activeTab`+`scripting` on toggle only; all read routes refused `403` to tokens | Yes (migration, `runtime.ts`, `auth-extension.ts`, `extension-scope.db.test.ts` shared-core) |
| `V2-8` (T4b & E5b) | [#3563](https://github.com/DOS/Ludy/issues/3563) | Member-scoped Vy `notes.todo_plan` and `notes.organize` in `packages/agent` & `apps/kernel`, 1-click apply UI with `"De xuat"` badge | `#3555`, `#3558`, `#3559` | Prompt injection cannot write or read outside caller visibility; respects budgets, kill switches, `vy.use`; core works with AI off | No (or `member-vy-boundary` verified) |
| `V2-9` (E5a) | [#3564](https://github.com/DOS/Ludy/issues/3564) | 1-step Evernote `.enex` (XXE/DTD/SSRF-free Markdown + attachments) and Todoist `.csv` (inverted priority `4->P1..1->P4`) importers with dry-run preview | `#3557`, `#3558`, `#3559`, `#3561` | Preserves private notes/attachments and to-dos/lists/sections/checklists/tags/priorities; malformed XML/DTD fails closed | No |

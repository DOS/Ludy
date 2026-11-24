// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 6A self-service portal queries for request drafting context and caller-scoped HR policy Q&A (#4526).
// Reads shared company notes strictly via caller-scoped `ctx.query('notes.note.*', ...)` (never touching `ludy_notes`
// SQL directly and never reading peer salary/employee PII columns). Enforces `STAFF_ROLES` (`viewer` denied) and
// requires `member` callers to be linked to an active non-erased employee profile.
import { sql } from 'kysely';
import {
  extractHrPolicyKeywords,
  foldVietnameseText,
  foldedTextHasWord,
  zHrSelfAiStatusAsk,
  zHrSelfPolicyQaAsk,
  type Note,
  type NoteSummary,
} from '@ludy/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { userOf } from './employees.ts';
import { STAFF_ROLES, selfNotLinked } from './leave-requests.ts';

export interface HrSelfAiStatusContext {
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

export interface HrSelfPolicyNoteCandidate {
  noteId: string;
  title: string;
  tags: string[];
  body: string;
  visibility: 'org' | 'private';
  updatedAt: string;
}

export interface HrSelfPolicySearchContext extends HrSelfAiStatusContext {
  notesAvailable: boolean;
  candidates: HrSelfPolicyNoteCandidate[];
}

const MAX_KEYWORD_SEARCH_CALLS = 3;
const MAX_NOTE_GET_CALLS = 12;

async function assertSelfPortalCallerAccess(ctx: QueryContext): Promise<void> {
  const callerUserId = userOf(ctx.actor);
  if (ctx.role === 'owner' || ctx.role === 'admin') return;
  if (ctx.role !== 'member') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên nội bộ mới sử dụng được cổng tự phục vụ nhân sự');
  }
  const linked = await ctx.trx
    .selectFrom('ludy_hr.payroll_employee')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', callerUserId)
    .where('erased_at', 'is', null)
    .executeTakeFirst();
  if (!linked) throw selfNotLinked();
}

async function readHrSelfAiMeta(ctx: QueryContext, includeNotesKillSwitch: boolean): Promise<HrSelfAiStatusContext> {
  const targets = includeNotesKillSwitch ? ['hr', 'notes'] : ['hr'];
  const { rows } = await sql<{ ai_stopped: boolean; budget_spent: boolean }>`
    SELECT
      (
        ludy_kernel.global_kill_switch_on('ai')
        OR EXISTS (
          SELECT 1 FROM ludy_kernel.kill_switch k
           WHERE k.org_id = ${ctx.orgId}::uuid
             AND k.released_at IS NULL
             AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = ANY(${targets}::text[])))
        )
      ) AS ai_stopped,
      ludy_kernel.ai_budget_exhausted(${ctx.orgId}::uuid, 'hr', NULL::uuid) AS budget_spent
  `.execute(ctx.trx);
  return {
    aiStopped: rows[0]?.ai_stopped === true,
    aiBudgetSpent: rows[0]?.budget_spent === true,
  };
}

function scoreSummaryCandidate(summary: NoteSummary, keywords: readonly string[], searchHits: number): number {
  const foldedTitle = foldVietnameseText(summary.title);
  const foldedTags = foldVietnameseText(summary.tags.join(' '));
  let score = searchHits * 3;
  for (const kw of keywords) {
    if (foldedTextHasWord(foldedTitle, kw)) score += 4;
    if (foldedTextHasWord(foldedTags, kw)) score += 3;
  }
  return score;
}

export const selfRequestDraftContext = defineQuery({
  name: 'hr.self.request_draft.context',
  input: zHrSelfAiStatusAsk,
  access: STAFF_ROLES,
  handler: async (ctx): Promise<HrSelfAiStatusContext> => {
    await assertSelfPortalCallerAccess(ctx);
    return readHrSelfAiMeta(ctx, false);
  },
});

export const selfAiStatus = defineQuery({
  name: 'hr.self.ai_status',
  input: zHrSelfAiStatusAsk,
  access: STAFF_ROLES,
  handler: async (ctx, input): Promise<{ aiStopped: boolean }> => {
    await assertSelfPortalCallerAccess(ctx);
    const meta = await readHrSelfAiMeta(ctx, Boolean(input.includeNotes));
    return { aiStopped: meta.aiStopped };
  },
});

export const selfPolicyQaSearch = defineQuery({
  name: 'hr.self.policy_qa.search',
  input: zHrSelfPolicyQaAsk,
  access: STAFF_ROLES,
  handler: async (ctx, input): Promise<HrSelfPolicySearchContext> => {
    await assertSelfPortalCallerAccess(ctx);
    const meta = await readHrSelfAiMeta(ctx, true);

    if (!ctx.installed('notes')) {
      return { ...meta, notesAvailable: false, candidates: [] };
    }

    const keywords = extractHrPolicyKeywords(input.question);
    const summaryMap = new Map<string, { summary: NoteSummary; hits: number }>();

    const recordSummaries = (rows: readonly NoteSummary[], weight: number) => {
      for (const note of rows) {
        if (note.visibility !== 'org' || note.deletedAt !== null || note.archivedAt !== null) continue;
        const existing = summaryMap.get(note.id);
        if (existing) {
          existing.hits += weight;
        } else {
          summaryMap.set(note.id, { summary: note, hits: weight });
        }
      }
    };

    try {
      const primary = await ctx.query<NoteSummary[]>('notes.note.search', {
        q: input.question.slice(0, 200),
        limit: 20,
      });
      if (primary.status === 'not_installed') {
        return { ...meta, notesAvailable: false, candidates: [] };
      }
      recordSummaries(primary.value, 2);

      for (const kw of keywords.slice(0, MAX_KEYWORD_SEARCH_CALLS)) {
        const res = await ctx.query<NoteSummary[]>('notes.note.search', { q: kw, limit: 20 });
        if (res.status === 'not_installed') {
          return { ...meta, notesAvailable: false, candidates: [] };
        }
        recordSummaries(res.value, 1);
      }

      if (summaryMap.size < 10) {
        const listed = await ctx.query<NoteSummary[]>('notes.note.list', { view: 'shared', limit: 50 });
        if (listed.status === 'not_installed') {
          return { ...meta, notesAvailable: false, candidates: [] };
        }
        recordSummaries(listed.value, 0);
      }
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'MODULE_OFF') {
        return { ...meta, notesAvailable: false, candidates: [] };
      }
      throw error;
    }

    const ordered = [...summaryMap.values()]
      .map((item) => ({
        summary: item.summary,
        score: scoreSummaryCandidate(item.summary, keywords, item.hits),
      }))
      .sort((a, b) => b.score - a.score || b.summary.updatedAt.localeCompare(a.summary.updatedAt))
      .slice(0, MAX_NOTE_GET_CALLS);

    const candidates: HrSelfPolicyNoteCandidate[] = [];
    for (const item of ordered) {
      try {
        const got = await ctx.query<Note>('notes.note.get', { noteId: item.summary.id });
        if (got.status === 'not_installed') {
          return { ...meta, notesAvailable: false, candidates: [] };
        }
        const n = got.value;
        if (n.visibility !== 'org' || n.deletedAt !== null || n.archivedAt !== null) continue;
        candidates.push({
          noteId: n.id,
          title: n.title,
          tags: [...n.tags],
          body: n.body,
          visibility: n.visibility,
          updatedAt: n.updatedAt,
        });
      } catch (error: unknown) {
        if (error instanceof DomainError && error.code === 'NOTE_NOT_FOUND') continue;
        if (error instanceof DomainError && error.code === 'MODULE_OFF') {
          return { ...meta, notesAvailable: false, candidates: [] };
        }
        throw error;
      }
    }

    return {
      ...meta,
      notesAvailable: true,
      candidates,
    };
  },
});

export const hrSelfCoworkerQueries = [selfRequestDraftContext, selfAiStatus, selfPolicyQaSearch];

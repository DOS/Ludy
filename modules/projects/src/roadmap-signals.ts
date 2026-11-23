// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'kysely';
import {
  auditValue,
  ROADMAP_SIGNAL_ACCOUNT_LABEL_MAX,
  ROADMAP_SIGNAL_LIST_LIMIT,
  ROADMAP_SIGNAL_MATCH_MAX_ITEMS,
  ROADMAP_SIGNAL_QUOTE_EXCERPT_MAX,
  tableWrite,
  zRoadmapSignalCreateInput,
  zRoadmapSignalDeleteInput,
  zRoadmapSignalListInput,
  zRoadmapSignalMatchInput,
  zRoadmapSignalRollupInput,
  type ConversationDetail,
  type Deal,
  type MeetingDetail,
  type MeetingResults,
  type Notes,
  type RoadmapItemStage,
  type RoadmapSignal,
  type RoadmapSignalCreateInput,
  type RoadmapSignalCreateResult,
  type RoadmapSignalDeleteInput,
  type RoadmapSignalDeleteResult,
  type RoadmapSignalItemRollup,
  type RoadmapSignalListInput,
  type RoadmapSignalListResult,
  type RoadmapSignalRollupInput,
  type RoadmapSignalRollupResult,
  type RoadmapSignalSourceCounts,
  type RoadmapSignalSourceType,
  type RoadmapSignalValueByCurrency,
  type Transcript,
} from '@ludy/kernel-contract';
import { ERASED_PARTY_NAME, kernelManifest } from '@ludy/kernel';
import { defineCommand, defineQuery, DomainError, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { money } from '@ludy/l10n-vn';
import { projectsManifest } from './manifest.ts';
import { loadBoardSummary, loadProjectsAiMeta } from './roadmap.ts';
import { READERS, userOf, WRITERS } from './shared.ts';
import { ctxQueryFn, formatConversationTaskSource, formatMeetingTaskSource, type SourceQueryResponse } from './tasks-from-source.ts';

const SIGNAL_TABLE = projectsManifest.tables.ludy_projects.roadmap_signal;
type DecimalValue = ReturnType<typeof money>;

export interface RoadmapAiSignalMatchSource {
  boardId: string;
  boardTitle: string;
  todayVn: string;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
  sourceType: RoadmapSignalSourceType;
  sourceId: string;
  sourceTitle: string;
  sourceExcerpt: string;
  sourceIsRecorder: boolean;
  meetingDetail: MeetingDetail | null;
  accountLabel: string | null;
  dealValue: string | null;
  dealCurrency: string | null;
  items: Array<{
    id: string;
    title: string;
    summary: string | null;
    stage: RoadmapItemStage;
  }>;
  inspectedCount: number;
  truncated: boolean;
}

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

function cleanText(raw: string | null | undefined, maxLen: number): string | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = Array.from(raw.replace(/\r\n?/g, '\n'))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f);
    })
    .join('')
    .replace(/\p{Cf}/gu, '')
    .trim();
  if (cleaned.length === 0) return null;
  const sliced = cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
  return sliced.length > 0 ? sliced : null;
}

function normalizeMoneyPair(
  valueRaw: string | null | undefined,
  currencyRaw: string | null | undefined,
): { dealValue: string | null; dealCurrency: string | null } {
  const hasVal = valueRaw !== undefined && valueRaw !== null && valueRaw.trim() !== '';
  const hasCur = currencyRaw !== undefined && currencyRaw !== null && currencyRaw.trim() !== '';
  if (!hasVal && !hasCur) return { dealValue: null, dealCurrency: null };
  if (hasVal !== hasCur) {
    throw new DomainError('VALIDATION', 400, 'dealValue and dealCurrency must both be provided or both omitted');
  }
  const currency = currencyRaw!.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError('VALIDATION', 400, 'dealCurrency must be a 3-letter ISO currency code');
  }
  const valueText = valueRaw!.trim();
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(valueText)) {
    throw new DomainError('VALIDATION', 400, 'dealValue must be a non-negative decimal string with up to 2 decimal places');
  }
  const parsed = money(valueText);
  if (parsed.isNegative()) {
    throw new DomainError('VALIDATION', 400, 'dealValue must not be negative');
  }
  return { dealValue: parsed.toFixed(2), dealCurrency: currency };
}

function tryNormalizeMoneyPair(
  valueRaw: string | null | undefined,
  currencyRaw: string | null | undefined,
): { dealValue: string | null; dealCurrency: string | null } {
  try {
    return normalizeMoneyPair(valueRaw, currencyRaw);
  } catch {
    return { dealValue: null, dealCurrency: null };
  }
}

function mapSignalRow(row: {
  id: string;
  board_id: string;
  roadmap_item_id: string;
  source_type: string;
  source_id: string;
  account_label: string | null;
  quote_excerpt: string | null;
  deal_value: string | null;
  deal_currency: string | null;
  tainted: boolean;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): RoadmapSignal {
  return {
    id: row.id,
    boardId: row.board_id,
    roadmapItemId: row.roadmap_item_id,
    sourceType: row.source_type as RoadmapSignalSourceType,
    sourceId: row.source_id,
    accountLabel: row.account_label,
    quoteExcerpt: row.quote_excerpt,
    dealValue: row.deal_value,
    dealCurrency: row.deal_currency,
    tainted: row.tainted,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface SignalRollupRowInput {
  roadmapItemId: string;
  sourceType: RoadmapSignalSourceType;
  accountLabel: string | null;
  dealValue: string | null;
  dealCurrency: string | null;
}

interface RollupAccumulator {
  totalSignals: number;
  accounts: Set<string>;
  sourceCounts: RoadmapSignalSourceCounts;
  byCurrency: Map<string, { amount: DecimalValue; signalCount: number }>;
}

function newAccumulator(): RollupAccumulator {
  return {
    totalSignals: 0,
    accounts: new Set<string>(),
    sourceCounts: { crmDeal: 0, conversation: 0, meeting: 0 },
    byCurrency: new Map<string, { amount: DecimalValue; signalCount: number }>(),
  };
}

function addToAccumulator(acc: RollupAccumulator, row: SignalRollupRowInput): void {
  acc.totalSignals += 1;
  if (row.accountLabel !== null) {
    const normalized = row.accountLabel.trim().toLowerCase();
    if (normalized.length > 0) acc.accounts.add(normalized);
  }
  if (row.sourceType === 'crm.deal') {
    acc.sourceCounts.crmDeal += 1;
  } else if (row.sourceType === 'kernel.conversation') {
    acc.sourceCounts.conversation += 1;
  } else {
    acc.sourceCounts.meeting += 1;
  }
  if (row.dealValue !== null && row.dealCurrency !== null) {
    const existing = acc.byCurrency.get(row.dealCurrency);
    const amount = money(row.dealValue);
    if (existing) {
      existing.amount = existing.amount.plus(amount);
      existing.signalCount += 1;
    } else {
      acc.byCurrency.set(row.dealCurrency, { amount, signalCount: 1 });
    }
  }
}

function finalizeCurrencies(byCurrency: Map<string, { amount: DecimalValue; signalCount: number }>): RoadmapSignalValueByCurrency[] {
  return [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, entry]) => ({
      currency,
      totalAmount: entry.amount.toFixed(2),
      signalCount: entry.signalCount,
    }));
}

export function computeSignalRollup(
  boardId: string,
  rows: ReadonlyArray<SignalRollupRowInput>,
): RoadmapSignalRollupResult {
  const boardAcc = newAccumulator();
  const itemMap = new Map<string, RollupAccumulator>();

  for (const row of rows) {
    addToAccumulator(boardAcc, row);
    let itemAcc = itemMap.get(row.roadmapItemId);
    if (!itemAcc) {
      itemAcc = newAccumulator();
      itemMap.set(row.roadmapItemId, itemAcc);
    }
    addToAccumulator(itemAcc, row);
  }

  const byItem: RoadmapSignalItemRollup[] = [...itemMap.entries()]
    .map(([roadmapItemId, acc]) => ({
      roadmapItemId,
      totalSignals: acc.totalSignals,
      distinctAccountCount: acc.accounts.size,
      sourceCounts: acc.sourceCounts,
      valueByCurrency: finalizeCurrencies(acc.byCurrency),
    }))
    .sort((a, b) => b.totalSignals - a.totalSignals || (a.roadmapItemId < b.roadmapItemId ? -1 : a.roadmapItemId > b.roadmapItemId ? 1 : 0));

  return {
    boardId,
    totalSignals: boardAcc.totalSignals,
    distinctAccountCount: boardAcc.accounts.size,
    sourceCounts: boardAcc.sourceCounts,
    valueByCurrency: finalizeCurrencies(boardAcc.byCurrency),
    byItem,
  };
}

interface HydratedSource {
  sourceTitle: string;
  sourceExcerpt: string;
  sourceIsRecorder: boolean;
  meetingDetail: MeetingDetail | null;
  partyId: string | null;
  accountLabel: string | null;
  dealValue: string | null;
  dealCurrency: string | null;
}

async function runRequiredSourceQuery<T>(
  fn: () => Promise<SourceQueryResponse<T>>,
  notInstalledCode: string,
  notInstalledMessage: string,
  forbiddenMessage: string,
  notFoundMessage: string,
): Promise<T> {
  let res: SourceQueryResponse<T>;
  try {
    res = await fn();
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.status === 403) throw new DomainError('SOURCE_FORBIDDEN', 403, forbiddenMessage);
      if (err.status === 404) throw new DomainError('SOURCE_NOT_FOUND', 404, notFoundMessage);
    }
    throw err;
  }
  if (res.status === 'not_installed') {
    throw new DomainError(notInstalledCode, 404, notInstalledMessage);
  }
  return res.value;
}

async function readRoadmapSignalSource(
  ctx: QueryContext,
  sourceType: RoadmapSignalSourceType,
  sourceId: string,
): Promise<HydratedSource> {
  const query = ctxQueryFn(ctx);

  if (sourceType === 'crm.deal') {
    const deal = await runRequiredSourceQuery(
      () => query<Deal>('crm.deal.get', { dealId: sourceId }),
      'CRM_NOT_INSTALLED',
      'CRM module is not installed',
      'You do not have access to this CRM deal',
      'CRM deal not found',
    );
    const rawLabel = deal.partyName === ERASED_PARTY_NAME ? null : cleanText(deal.partyName, ROADMAP_SIGNAL_ACCOUNT_LABEL_MAX);
    const pair = tryNormalizeMoneyPair(deal.amount, deal.currency);
    const sourceTitle = cleanText(deal.title, 200) ?? rawLabel ?? sourceId;
    const excerptParts = [deal.title, rawLabel ? `Account: ${rawLabel}` : null, `Stage: ${deal.stageKind}`].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );
    const sourceExcerpt = cleanText(excerptParts.join('\n'), ROADMAP_SIGNAL_QUOTE_EXCERPT_MAX) ?? sourceTitle;
    return {
      sourceTitle,
      sourceExcerpt,
      sourceIsRecorder: false,
      meetingDetail: null,
      partyId: deal.partyId ?? null,
      accountLabel: rawLabel,
      dealValue: pair.dealValue,
      dealCurrency: pair.dealCurrency,
    };
  }

  if (sourceType === 'kernel.conversation') {
    const conv = await runRequiredSourceQuery(
      () => query<ConversationDetail>('kernel.conversation.get', { conversationId: sourceId }),
      'SOURCE_NOT_FOUND',
      'Conversations source is unavailable',
      'You do not have access to this conversation',
      'Conversation not found',
    );
    const formatted = formatConversationTaskSource(conv);
    const accountLabel = cleanText(conv.conversation.contact?.partyName ?? null, ROADMAP_SIGNAL_ACCOUNT_LABEL_MAX);
    const sourceTitle = cleanText(formatted.sourceTitle, 200) ?? accountLabel ?? sourceId;
    const sourceExcerpt = cleanText(formatted.sourceBody, ROADMAP_SIGNAL_QUOTE_EXCERPT_MAX) ?? sourceTitle;
    return {
      sourceTitle,
      sourceExcerpt,
      sourceIsRecorder: false,
      meetingDetail: null,
      partyId: null,
      accountLabel,
      dealValue: null,
      dealCurrency: null,
    };
  }

  // Only read non-sensitive meetings.meeting.get inside ctx.lookup (RLS enforces attendees access).
  // Sensitive meeting sub-queries (result/transcript/notes) are read through audited top-level Runtime.query in RPC.
  const meeting = await runRequiredSourceQuery(
    () => query<MeetingDetail>('meetings.meeting.get', { meetingId: sourceId }),
    'MEETINGS_NOT_INSTALLED',
    'Meetings module is not installed',
    'You do not have access to this meeting',
    'Meeting not found',
  );
  const sourceTitle = cleanText(meeting.title, 200) ?? sourceId;
  return {
    sourceTitle,
    sourceExcerpt: sourceTitle,
    sourceIsRecorder: meeting.isRecorder,
    meetingDetail: meeting,
    partyId: null,
    accountLabel: null,
    dealValue: null,
    dealCurrency: null,
  };
}

export function enrichMeetingSignalMatchSource(
  source: RoadmapAiSignalMatchSource,
  parts: {
    results: MeetingResults | null;
    transcript: Transcript | null;
    notes: Notes | null;
  },
): RoadmapAiSignalMatchSource {
  if (!source.meetingDetail) return source;
  const safeNotes = source.sourceIsRecorder ? parts.notes : null;
  const formatted = formatMeetingTaskSource({
    meeting: source.meetingDetail,
    results: parts.results,
    transcript: parts.transcript,
    notes: safeNotes,
  });
  return {
    ...source,
    sourceTitle: cleanText(formatted.sourceTitle ?? source.meetingDetail.title, 200) ?? source.sourceTitle,
    sourceExcerpt: cleanText(formatted.sourceBody, ROADMAP_SIGNAL_QUOTE_EXCERPT_MAX) ?? source.sourceExcerpt,
  };
}

export const roadmapSignalCreate = defineCommand({
  name: 'projects.roadmap.signal.create',
  input: zRoadmapSignalCreateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(projectsManifest.tables, 'ludy_projects', 'roadmap_signal', [
      'org_id',
      'board_id',
      'roadmap_item_id',
      'source_type',
      'source_id',
      'account_label',
      'quote_excerpt',
      'deal_value',
      'deal_currency',
      'tainted',
      'created_by',
    ]),
  ],
  target: (input) => ({ type: 'projects.roadmap_item', id: input.roadmapItemId }),
  handler: async (ctx, input: RoadmapSignalCreateInput): Promise<RoadmapSignalCreateResult> => {
    const actorId = userOf(ctx.actor);
    await loadBoardSummary(ctx.trx, ctx.orgId, input.boardId);

    const hydrated = await readRoadmapSignalSource(ctx, input.sourceType, input.sourceId);

    // Canonical lock order: party (FOR KEY SHARE) -> roadmap_item (FOR SHARE) -> roadmap_signal,
    // matching personalDataErase (party FOR UPDATE -> roadmap_item -> roadmap_signal) without TOCTOU (#4492).
    let hydratedAccountLabel = hydrated.accountLabel;
    let partyErased = false;
    if (input.sourceType === 'crm.deal' && hydrated.partyId) {
      const { rows: partyRows } = await sql<{ name: string }>`
        SELECT name FROM ludy_kernel.party
         WHERE org_id = ${ctx.orgId}::uuid AND id = ${hydrated.partyId}::uuid
         FOR KEY SHARE
      `.execute(ctx.trx);
      const currentName = partyRows[0]?.name;
      if (currentName !== undefined) {
        partyErased = currentName === ERASED_PARTY_NAME;
        hydratedAccountLabel = partyErased ? null : cleanText(currentName, ROADMAP_SIGNAL_ACCOUNT_LABEL_MAX);
      }
    } else if (input.sourceType === 'crm.deal' && hydrated.accountLabel === ERASED_PARTY_NAME) {
      partyErased = true;
      hydratedAccountLabel = null;
    }

    const item = await ctx.trx
      .selectFrom('ludy_projects.roadmap_item')
      .select(['id', 'board_id', 'moderation_status', 'merged_into_item_id', 'public_title'])
      .where('org_id', '=', ctx.orgId)
      .where('board_id', '=', input.boardId)
      .where('id', '=', input.roadmapItemId)
      .forShare()
      .executeTakeFirst();
    if (!item) {
      throw new DomainError('ROADMAP_ITEM_NOT_FOUND', 404, 'Roadmap item not found');
    }
    if (item.merged_into_item_id !== null || item.moderation_status === 'merged') {
      throw new DomainError('ROADMAP_ITEM_MERGED', 409, 'Cannot attach a signal to a merged roadmap item');
    }
    if (item.moderation_status === 'archived') {
      throw new DomainError('ROADMAP_ITEM_ARCHIVED', 409, 'Cannot attach a signal to an archived roadmap item');
    }

    let accountLabel = cleanText(input.accountLabel, ROADMAP_SIGNAL_ACCOUNT_LABEL_MAX);
    if (input.sourceType === 'crm.deal') {
      if (partyErased || accountLabel === ERASED_PARTY_NAME) {
        accountLabel = null;
      } else if (input.accountLabel === undefined) {
        accountLabel = hydratedAccountLabel;
      }
    }

    const quoteExcerpt = cleanText(input.quoteExcerpt, ROADMAP_SIGNAL_QUOTE_EXCERPT_MAX);

    let dealPair: { dealValue: string | null; dealCurrency: string | null };
    if (input.dealValue === undefined && input.dealCurrency === undefined && input.sourceType === 'crm.deal') {
      dealPair = { dealValue: hydrated.dealValue, dealCurrency: hydrated.dealCurrency };
    } else {
      dealPair = normalizeMoneyPair(input.dealValue ?? null, input.dealCurrency ?? null);
    }

    const inserted = await ctx.trx
      .insertInto('ludy_projects.roadmap_signal')
      .values({
        org_id: ctx.orgId,
        board_id: input.boardId,
        roadmap_item_id: input.roadmapItemId,
        source_type: input.sourceType,
        source_id: input.sourceId,
        account_label: accountLabel,
        quote_excerpt: quoteExcerpt,
        deal_value: dealPair.dealValue,
        deal_currency: dealPair.dealCurrency,
        tainted: true,
        created_by: actorId,
      })
      .onConflict((oc) => oc.columns(['org_id', 'roadmap_item_id', 'source_type', 'source_id']).doNothing())
      .returningAll()
      .executeTakeFirst();

    let alreadyLinked = false;
    let row = inserted;
    if (!row) {
      alreadyLinked = true;
      row = await ctx.trx
        .selectFrom('ludy_projects.roadmap_signal')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('roadmap_item_id', '=', input.roadmapItemId)
        .where('source_type', '=', input.sourceType)
        .where('source_id', '=', input.sourceId)
        .executeTakeFirst();
      if (!row) {
        throw new DomainError('ROADMAP_SIGNAL_CONFLICT', 409, 'Signal could not be created or loaded');
      }
    } else {
      await ctx.emit('projects.roadmap.signal_linked', {
        signalId: row.id,
        boardId: input.boardId,
        roadmapItemId: input.roadmapItemId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      });
      await ctx.activity(
        'projects.roadmap_item',
        input.roadmapItemId,
        'roadmap.signal_linked',
        `Linked ${input.sourceType} signal to roadmap item`,
      );
    }

    ctx.audit({
      signalId: row.id,
      boardId: input.boardId,
      roadmapItemId: input.roadmapItemId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      alreadyLinked,
      accountLabel: auditValue(SIGNAL_TABLE, 'account_label', row.account_label),
      quoteExcerpt: auditValue(SIGNAL_TABLE, 'quote_excerpt', row.quote_excerpt),
      hasDealValue: row.deal_value !== null,
      dealCurrency: row.deal_currency,
    });

    return {
      signal: mapSignalRow(row),
      alreadyLinked,
    };
  },
});

export async function scrubRoadmapSignalIdempotencyResponses(
  trx: CommandContext['trx'],
  orgId: string,
  signalIds: readonly string[],
): Promise<void> {
  if (signalIds.length === 0) return;
  await sql`
    UPDATE ludy_kernel.idempotency_key
       SET response = pg_catalog.jsonb_set(
             pg_catalog.jsonb_set(response, '{value,signal,accountLabel}', 'null'::jsonb, false),
             '{value,signal,quoteExcerpt}',
             'null'::jsonb,
             false
           )
     WHERE org_id = ${orgId}::uuid
       AND command = 'projects.roadmap.signal.create'
       AND response IS NOT NULL
       AND response -> 'value' -> 'signal' ->> 'id' = ANY(${[...signalIds]}::text[])`.execute(trx);
}

export const roadmapSignalDelete = defineCommand({
  name: 'projects.roadmap.signal.delete',
  input: zRoadmapSignalDeleteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(projectsManifest.tables, 'ludy_projects', 'roadmap_signal', ['id']),
    tableWrite(kernelManifest.tables, 'ludy_kernel', 'idempotency_key', ['response']),
  ],
  target: (input) => ({ type: 'projects.roadmap_signal', id: input.signalId }),
  handler: async (ctx, input: RoadmapSignalDeleteInput): Promise<RoadmapSignalDeleteResult> => {
    userOf(ctx.actor);
    const deleted = await ctx.trx
      .deleteFrom('ludy_projects.roadmap_signal')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.signalId)
      .returning(['id', 'board_id', 'roadmap_item_id', 'source_type', 'source_id'])
      .executeTakeFirst();

    if (!deleted) {
      throw new DomainError('ROADMAP_SIGNAL_NOT_FOUND', 404, 'Roadmap signal not found');
    }

    await scrubRoadmapSignalIdempotencyResponses(ctx.trx, ctx.orgId, [deleted.id]);

    ctx.audit({
      signalId: deleted.id,
      boardId: deleted.board_id,
      roadmapItemId: deleted.roadmap_item_id,
      sourceType: deleted.source_type,
      sourceId: deleted.source_id,
    });

    return {
      deleted: true,
      signalId: deleted.id,
      boardId: deleted.board_id,
      roadmapItemId: deleted.roadmap_item_id,
    };
  },
});

export const roadmapSignalList = defineQuery({
  name: 'projects.roadmap.signal.list',
  input: zRoadmapSignalListInput,
  access: READERS,
  target: (input) => ({ type: 'projects.roadmap_board', id: input.boardId }),
  handler: async (ctx, input: RoadmapSignalListInput): Promise<RoadmapSignalListResult> => {
    await loadBoardSummary(ctx.trx, ctx.orgId, input.boardId);
    const limit = Math.min(input.limit ?? ROADMAP_SIGNAL_LIST_LIMIT, ROADMAP_SIGNAL_LIST_LIMIT);
    let q = ctx.trx
      .selectFrom('ludy_projects.roadmap_signal')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('board_id', '=', input.boardId);
    if (input.roadmapItemId !== undefined) {
      q = q.where('roadmap_item_id', '=', input.roadmapItemId);
    }
    const rows = await q
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();

    const meetingIds = [
      ...new Set(
        rows
          .filter((r) => r.source_type === 'meetings.meeting' && Boolean(r.source_id))
          .map((r) => r.source_id),
      ),
    ];
    const visibleMeetingIds = new Set<string>();
    if (meetingIds.length > 0 && ctx.installed('meetings')) {
      const query = ctxQueryFn(ctx);
      const batchSize = Math.min(ROADMAP_SIGNAL_LIST_LIMIT, 200);
      for (let offset = 0; offset < meetingIds.length; offset += batchSize) {
        const batch = meetingIds.slice(offset, offset + batchSize);
        try {
          const res = await query<{ visibleIds: string[] }>('meetings.meeting.visible_ids', { meetingIds: batch });
          if (res.status === 'not_installed') break;
          for (const id of res.value.visibleIds) {
            visibleMeetingIds.add(id);
          }
        } catch (err) {
          if (!(err instanceof DomainError && (err.status === 403 || err.status === 404))) {
            throw err;
          }
        }
      }
    }

    return {
      signals: rows.map((row) =>
        mapSignalRow(
          row.source_type === 'meetings.meeting' && !visibleMeetingIds.has(row.source_id)
            ? { ...row, quote_excerpt: null }
            : row,
        ),
      ),
    };
  },
});

export const roadmapSignalRollup = defineQuery({
  name: 'projects.roadmap.signal.rollup',
  input: zRoadmapSignalRollupInput,
  access: READERS,
  target: (input) => ({ type: 'projects.roadmap_board', id: input.boardId }),
  handler: async (ctx, input: RoadmapSignalRollupInput): Promise<RoadmapSignalRollupResult> => {
    await loadBoardSummary(ctx.trx, ctx.orgId, input.boardId);

    const boardSummary = await ctx.trx
      .selectFrom('ludy_projects.roadmap_signal')
      .select([
        sql<number>`COUNT(*)::int`.as('totalSignals'),
        sql<number>`COUNT(*) FILTER (WHERE source_type = 'crm.deal')::int`.as('crmDeal'),
        sql<number>`COUNT(*) FILTER (WHERE source_type = 'kernel.conversation')::int`.as('conversation'),
        sql<number>`COUNT(*) FILTER (WHERE source_type = 'meetings.meeting')::int`.as('meeting'),
        sql<number>`COUNT(DISTINCT NULLIF(pg_catalog.lower(pg_catalog.btrim(account_label)), ''))::int`.as(
          'distinctAccountCount',
        ),
      ])
      .where('org_id', '=', ctx.orgId)
      .where('board_id', '=', input.boardId)
      .$if(input.roadmapItemId !== undefined, (qb) => qb.where('roadmap_item_id', '=', input.roadmapItemId!))
      .executeTakeFirst();

    const itemCountRows = await ctx.trx
      .selectFrom('ludy_projects.roadmap_signal')
      .select([
        'roadmap_item_id as roadmapItemId',
        sql<number>`COUNT(*)::int`.as('totalSignals'),
        sql<number>`COUNT(*) FILTER (WHERE source_type = 'crm.deal')::int`.as('crmDeal'),
        sql<number>`COUNT(*) FILTER (WHERE source_type = 'kernel.conversation')::int`.as('conversation'),
        sql<number>`COUNT(*) FILTER (WHERE source_type = 'meetings.meeting')::int`.as('meeting'),
        sql<number>`COUNT(DISTINCT NULLIF(pg_catalog.lower(pg_catalog.btrim(account_label)), ''))::int`.as(
          'distinctAccountCount',
        ),
      ])
      .where('org_id', '=', ctx.orgId)
      .where('board_id', '=', input.boardId)
      .$if(input.roadmapItemId !== undefined, (qb) => qb.where('roadmap_item_id', '=', input.roadmapItemId!))
      .groupBy('roadmap_item_id')
      .execute();

    const itemCurrencyRows = await ctx.trx
      .selectFrom('ludy_projects.roadmap_signal')
      .select([
        'roadmap_item_id as roadmapItemId',
        sql<string>`deal_currency`.as('dealCurrency'),
        sql<string>`pg_catalog.sum(deal_value)::text`.as('totalAmount'),
        sql<number>`COUNT(*)::int`.as('signalCount'),
      ])
      .where('org_id', '=', ctx.orgId)
      .where('board_id', '=', input.boardId)
      .where('deal_currency', 'is not', null)
      .where('deal_value', 'is not', null)
      .$if(input.roadmapItemId !== undefined, (qb) => qb.where('roadmap_item_id', '=', input.roadmapItemId!))
      .groupBy(['roadmap_item_id', 'deal_currency'])
      .execute();

    const boardCurrencies = new Map<string, { amount: DecimalValue; signalCount: number }>();
    const itemCurrencies = new Map<string, RoadmapSignalValueByCurrency[]>();

    for (const row of itemCurrencyRows) {
      const amount = money(row.totalAmount);
      const formattedAmount = amount.toFixed(2);
      const existingBoard = boardCurrencies.get(row.dealCurrency);
      if (existingBoard) {
        existingBoard.amount = existingBoard.amount.plus(amount);
        existingBoard.signalCount += row.signalCount;
      } else {
        boardCurrencies.set(row.dealCurrency, { amount, signalCount: row.signalCount });
      }
      const list = itemCurrencies.get(row.roadmapItemId) ?? [];
      list.push({
        currency: row.dealCurrency,
        totalAmount: formattedAmount,
        signalCount: row.signalCount,
      });
      itemCurrencies.set(row.roadmapItemId, list);
    }

    const byItem: RoadmapSignalItemRollup[] = itemCountRows
      .map((row) => ({
        roadmapItemId: row.roadmapItemId,
        totalSignals: row.totalSignals,
        distinctAccountCount: row.distinctAccountCount,
        sourceCounts: {
          crmDeal: row.crmDeal,
          conversation: row.conversation,
          meeting: row.meeting,
        },
        valueByCurrency: (itemCurrencies.get(row.roadmapItemId) ?? []).sort((a, b) =>
          a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0,
        ),
      }))
      .sort(
        (a, b) =>
          b.totalSignals - a.totalSignals ||
          (a.roadmapItemId < b.roadmapItemId ? -1 : a.roadmapItemId > b.roadmapItemId ? 1 : 0),
      );

    return {
      boardId: input.boardId,
      totalSignals: boardSummary?.totalSignals ?? 0,
      distinctAccountCount: boardSummary?.distinctAccountCount ?? 0,
      sourceCounts: {
        crmDeal: boardSummary?.crmDeal ?? 0,
        conversation: boardSummary?.conversation ?? 0,
        meeting: boardSummary?.meeting ?? 0,
      },
      valueByCurrency: finalizeCurrencies(boardCurrencies),
      byItem,
    };
  },
});

export const roadmapAiSignalMatchSource = defineQuery({
  name: 'projects.roadmap.ai_signal_match_source',
  input: zRoadmapSignalMatchInput,
  access: WRITERS,
  target: (input) => ({ type: 'projects.roadmap_board', id: input.boardId }),
  handler: async (ctx, input): Promise<RoadmapAiSignalMatchSource> => {
    const board = await loadBoardSummary(ctx.trx, ctx.orgId, input.boardId);
    const meta = await loadProjectsAiMeta(ctx.trx, ctx.orgId);
    const hydrated = await readRoadmapSignalSource(ctx, input.sourceType, input.sourceId);

    const rows = await ctx.trx
      .selectFrom('ludy_projects.roadmap_item')
      .select(['id', 'public_title', 'public_summary', 'stage'])
      .where('org_id', '=', ctx.orgId)
      .where('board_id', '=', input.boardId)
      .where('merged_into_item_id', 'is', null)
      .where('moderation_status', 'not in', ['merged', 'archived'])
      .orderBy(sql`vote_count DESC, updated_at DESC, id ASC`)
      .limit(ROADMAP_SIGNAL_MATCH_MAX_ITEMS + 1)
      .execute();

    const truncated = rows.length > ROADMAP_SIGNAL_MATCH_MAX_ITEMS;
    const sliced = rows.slice(0, ROADMAP_SIGNAL_MATCH_MAX_ITEMS);

    return {
      boardId: input.boardId,
      boardTitle: board.title,
      todayVn: meta.todayVn,
      aiStopped: meta.aiStopped,
      aiBudgetSpent: meta.aiBudgetSpent,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceTitle: hydrated.sourceTitle,
      sourceExcerpt: hydrated.sourceExcerpt,
      sourceIsRecorder: hydrated.sourceIsRecorder,
      meetingDetail: hydrated.meetingDetail,
      accountLabel: hydrated.accountLabel,
      dealValue: hydrated.dealValue,
      dealCurrency: hydrated.dealCurrency,
      items: sliced.map((r) => ({
        id: r.id,
        title: r.public_title,
        summary: r.public_summary,
        stage: r.stage as RoadmapItemStage,
      })),
      inspectedCount: sliced.length,
      truncated,
    };
  },
});

export const roadmapSignalCommands = [roadmapSignalCreate, roadmapSignalDelete];
export const roadmapSignalQueries = [roadmapSignalList, roadmapSignalRollup, roadmapAiSignalMatchSource];

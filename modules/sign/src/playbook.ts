// SPDX-License-Identifier: AGPL-3.0-only
// SME contract playbook checklist, deterministic clause evaluator, and human verdict overrides (Slice 5d, #4442).
// Every state change runs through Runtime.execute() with zero noIdempotency commands.
// AI findings are tainted proposals verified against extracted PDF pages; core checklist review works identically with AI off.
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  SIGN_PLAYBOOK_MODES,
  SIGN_PLAYBOOK_SEVERITIES,
  type MemberRole,
  type SignPlaybookMode,
  type SignPlaybookSeverity,
} from '@ludy/db';
import {
  SIGN_MAX_PAGES,
  SIGN_PLAYBOOK_MAX_TOTAL_CHARS,
  SIGN_PLAYBOOK_VERDICTS,
  tableWrite,
  zId,
  zSignPlaybookOverrideFindingInput,
  zSignPlaybookRuleDeleteInput,
  zSignPlaybookRulesListInput,
  zSignPlaybookRuleUpsertInput,
  zSignPlaybookSeedDefaultsInput,
  type SignEnvelopePlaybookCheckRecord,
  type SignPlaybookFindingContract,
  type SignPlaybookGetResult,
  type SignPlaybookRuleDeleteResult,
  type SignPlaybookRuleRecord,
  type SignPlaybookRulesListResult,
  type SignPlaybookVerdictContract,
} from '@ludy/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  type CommandContext,
  type QueryContext,
} from '@ludy/kernel-runtime';
import { isSignAiStoppedOnTrx } from './ai.ts';
import { assertCanAccessEnvelopeRow } from './hr-visibility.ts';
import { signManifest } from './manifest.ts';
import { assertCanAccessMeetingMinutesEnvelopeRow } from './meeting-visibility.ts';

const PLAYBOOK_ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const SIGN_MAX_PLAYBOOK_RULES = 50;
const PLAYBOOK_DEFAULT_TIMESTAMP = '2027-01-01T00:00:00.000Z';
const FORMAT_CONTROL_RE = /\p{Cf}+/gu;
const PLAYBOOK_SEVERITY_SET: ReadonlySet<string> = new Set(SIGN_PLAYBOOK_SEVERITIES);
const PLAYBOOK_VERDICT_SET: ReadonlySet<string> = new Set(SIGN_PLAYBOOK_VERDICTS);

export type DefaultPlaybookRuleSlot =
  | 'penalty_cap'
  | 'payment_terms'
  | 'termination_notice'
  | 'auto_renewal_notice'
  | 'dispute_venue'
  | 'acceptance_criteria';

export interface DefaultVietnamSmePlaybookRuleSpec {
  slot: DefaultPlaybookRuleSlot;
  title: string;
  guidance: string;
  severity: SignPlaybookSeverity;
  matchKeywords: readonly string[];
}

export const DEFAULT_VIETNAM_SME_PLAYBOOK_RULES: readonly DefaultVietnamSmePlaybookRuleSpec[] = [
  {
    slot: 'penalty_cap',
    title: 'Giới hạn phạt vi phạm tối đa 8% (Penalty cap <= 8%)',
    guidance:
      'Theo Điều 301 Luật Thương mại 2005, mức phạt vi phạm hợp đồng thương mại không vượt quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm. Cảnh báo nếu hợp đồng quy định mức phạt vượt 8% hoặc không nêu trần phạt.',
    severity: 'critical',
    matchKeywords: [
      'phạt vi phạm',
      'mức phạt',
      'tiền phạt',
      'điều 301',
      'penalty',
      'liquidated damages',
      '8%',
    ],
  },
  {
    slot: 'payment_terms',
    title: 'Thời hạn thanh toán không quá 30 ngày (Payment terms <= 30 days)',
    guidance:
      'Thời hạn thanh toán hóa đơn tiêu chuẩn cho doanh nghiệp nhỏ và vừa tối đa 30 ngày kể từ ngày nghiệm thu hoặc nhận đủ hồ sơ hóa đơn hợp lệ. Cảnh báo nếu thời hạn thanh toán kéo dài trên 30 ngày.',
    severity: 'warn',
    matchKeywords: [
      'thanh toán',
      'thời hạn thanh toán',
      'hóa đơn',
      'payment',
      'invoice',
      'net 30',
      'net 45',
      'net 60',
      'net 90',
    ],
  },
  {
    slot: 'termination_notice',
    title: 'Đơn phương chấm dứt có báo trước cân bằng (Termination notice parity)',
    guidance:
      'Điều khoản đơn phương chấm dứt hợp đồng cần có thời hạn thông báo trước tối thiểu 15 đến 30 ngày và quyền chấm dứt tương xứng giữa hai bên, tránh cho phép một bên chấm dứt ngay lập tức không cần báo trước.',
    severity: 'critical',
    matchKeywords: [
      'chấm dứt',
      'đơn phương chấm dứt',
      'hủy bỏ hợp đồng',
      'thông báo trước',
      'báo trước',
      'termination',
      'terminate',
      'prior written notice',
    ],
  },
  {
    slot: 'auto_renewal_notice',
    title: 'Tự động gia hạn phải có thời hạn từ chối rõ ràng (Auto-renewal notice)',
    guidance:
      'Nếu hợp đồng có điều khoản tự động gia hạn, phải quy định rõ thời hạn thông báo trước để không gia hạn (ví dụ trước ít nhất 30 ngày khi hết hạn) nhằm tránh gia hạn ngoài ý muốn.',
    severity: 'warn',
    matchKeywords: [
      'tự động gia hạn',
      'gia hạn tự động',
      'gia hạn hợp đồng',
      'không gia hạn',
      'auto-renew',
      'automatic renewal',
      'automatically renew',
      'renewal notice',
    ],
  },
  {
    slot: 'dispute_venue',
    title: 'Giải quyết tranh chấp và luật áp dụng tại Việt Nam (Dispute venue in Vietnam)',
    guidance:
      'Hợp đồng trong nước nên áp dụng pháp luật Việt Nam và giải quyết tranh chấp tại Tòa án nhân dân có thẩm quyền tại Việt Nam hoặc Trọng tài thương mại tại Việt Nam (VIAC). Cảnh báo nếu chọn tài phán nước ngoài.',
    severity: 'warn',
    matchKeywords: [
      'giải quyết tranh chấp',
      'tranh chấp',
      'tòa án',
      'trọng tài',
      'viac',
      'luật áp dụng',
      'pháp luật việt nam',
      'dispute',
      'arbitration',
      'governing law',
      'jurisdiction',
    ],
  },
  {
    slot: 'acceptance_criteria',
    title: 'Tiêu chí và thời hạn nghiệm thu bàn giao rõ ràng (Acceptance criteria)',
    guidance:
      'Cần nêu rõ tiêu chí nghiệm thu, biên bản nghiệm thu và số ngày tối đa bên mua phản hồi nghiệm thu (ví dụ 5 đến 7 ngày làm việc) để tránh treo thanh toán vô thời hạn.',
    severity: 'info',
    matchKeywords: [
      'nghiệm thu',
      'bàn giao',
      'biên bản nghiệm thu',
      'chấp thuận',
      'acceptance',
      'deliverables',
      'handover',
      'deemed accepted',
    ],
  },
];

const PLAYBOOK_RULE_WRITE = tableWrite(
  signManifest.tables,
  'ludy_sign',
  'playbook_rule',
  [
    'org_id',
    'id',
    'title',
    'guidance',
    'severity',
    'match_keywords',
    'active',
    'created_by',
    'created_at',
    'updated_at',
  ],
);

const PLAYBOOK_CHECK_RECORD_WRITE = tableWrite(
  signManifest.tables,
  'ludy_sign',
  'playbook_check',
  [
    'org_id',
    'id',
    'envelope_id',
    'source_sha256',
    'mode',
    'findings_json',
    'prompt_version',
    'created_by',
    'created_at',
    'updated_at',
  ],
);

const PLAYBOOK_CHECK_OVERRIDE_WRITE = tableWrite(
  signManifest.tables,
  'ludy_sign',
  'playbook_check',
  ['mode', 'findings_json', 'updated_at'],
);

const ruleDeleteTarget = (input: { ruleId: string }) => ({
  type: 'sign.playbook_rule',
  id: input.ruleId,
});

const checkTarget = <T extends { envelopeId: string }>(input: T) => ({
  type: 'sign.playbook_check',
  id: input.envelopeId,
});

export interface SignPlaybookExtractedPage {
  page: number;
  text: string;
}

export interface SignPlaybookRuleEffective {
  id: string;
  title: string;
  guidance: string;
  severity: SignPlaybookSeverity;
  matchKeywords: string[];
  active: boolean;
  isDefault: boolean;
  revision?: string;
}

export interface SignPlaybookSourceRule extends SignPlaybookRuleEffective {
  revision: string;
}

export interface SignPlaybookSource {
  envelopeId: string;
  status: string;
  inspectStatus: string;
  sourceSha256: string;
  sourceFileId: string;
  sourceStorageKey: string;
  sourceGeneration: string;
  title: string;
  pageCount: number | null;
  aiStopped: boolean;
  activeRules: SignPlaybookSourceRule[];
}

function stripFormatControl(value: string): string {
  return value.replace(FORMAT_CONTROL_RE, '');
}

function cleanSingleLine(value: string, max: number): string {
  const one = stripFormatControl(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(one);
  return points.length <= max ? one : points.slice(0, max).join('').trimEnd();
}

function cleanMultiLine(value: string, max: number): string {
  const cleaned = stripFormatControl(value)
    .replace(/\r\n/g, '\n')
    .replace(/(?!\n)\p{Cc}/gu, '')
    .trim();
  const points = Array.from(cleaned);
  return points.length <= max ? cleaned : points.slice(0, max).join('').trimEnd();
}

function neutralizeEmbeddedTags(value: string): string {
  let out = stripFormatControl(value).replace(/([{}])\p{M}+/gu, '$1');
  while (out.includes('{{') || out.includes('}}')) {
    out = out.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
  }
  return out;
}

function normalizeSearchText(value: string): string {
  return stripFormatControl(value.normalize('NFKC'))
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .toLowerCase()
    .replace(/\s*%/g, '%')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeMatchKeywords(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const cleaned = cleanSingleLine(item, 120);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 25) break;
  }
  return out;
}

function assertUser(ctx: QueryContext | CommandContext): string {
  if (ctx.actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can perform this action');
  }
  return ctx.actor.userId;
}

function assertPlaybookAdmin(ctx: CommandContext): string {
  const userId = assertUser(ctx);
  if (ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new DomainError('FORBIDDEN', 403, 'Only workspace owners and admins can manage playbook rules');
  }
  return userId;
}

export function deterministicPlaybookRuleId(orgId: string, slot: DefaultPlaybookRuleSlot): string {
  const hex = createHash('sha256')
    // Category B (ADR-0054 section 2): keep crove_sign.playbook_rule: hash domain so seeded rule UUIDs stay stable across cutover.
    .update(`crove_sign.playbook_rule:${orgId.toLowerCase()}:${slot}`)
    .digest('hex');
  const timeLow = hex.slice(0, 8);
  const timeMid = hex.slice(8, 12);
  const timeHiAndVersion = `4${hex.slice(13, 16)}`;
  const variantNibble = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const clockSeq = `${variantNibble}${hex.slice(17, 20)}`;
  const node = hex.slice(20, 32);
  return `${timeLow}-${timeMid}-${timeHiAndVersion}-${clockSeq}-${node}`;
}

export function defaultSlotForRuleId(orgId: string, ruleId: string): DefaultPlaybookRuleSlot | null {
  const normalized = ruleId.toLowerCase();
  for (const spec of DEFAULT_VIETNAM_SME_PLAYBOOK_RULES) {
    if (deterministicPlaybookRuleId(orgId, spec.slot) === normalized) {
      return spec.slot;
    }
  }
  return null;
}

function virtualDefaultRuleRecords(orgId: string): SignPlaybookRuleRecord[] {
  return DEFAULT_VIETNAM_SME_PLAYBOOK_RULES.map((spec) => ({
    id: deterministicPlaybookRuleId(orgId, spec.slot),
    title: spec.title,
    guidance: spec.guidance,
    severity: spec.severity,
    matchKeywords: [...spec.matchKeywords],
    active: true,
    isDefault: true,
    createdBy: null,
    createdAt: PLAYBOOK_DEFAULT_TIMESTAMP,
    updatedAt: PLAYBOOK_DEFAULT_TIMESTAMP,
  }));
}

function toRuleRecord(
  orgId: string,
  row: {
    id: string;
    title: string;
    guidance: string;
    severity: SignPlaybookSeverity;
    match_keywords: string[];
    active: boolean;
    created_by: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  },
): SignPlaybookRuleRecord {
  return {
    id: row.id,
    title: row.title,
    guidance: row.guidance,
    severity: row.severity,
    matchKeywords: Array.isArray(row.match_keywords) ? [...row.match_keywords] : [],
    active: row.active,
    isDefault: defaultSlotForRuleId(orgId, row.id) !== null,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function computePlaybookRuleRevision(
  rule: Pick<SignPlaybookRuleEffective, 'id' | 'title' | 'guidance' | 'severity' | 'matchKeywords' | 'active'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: rule.id,
        title: rule.title,
        guidance: rule.guidance,
        severity: rule.severity,
        matchKeywords: [...rule.matchKeywords],
        active: rule.active,
      }),
    )
    .digest('hex');
}

async function isPlaybookInitializedOnTrx(
  trx: QueryContext['trx'],
  orgId: string,
): Promise<boolean> {
  const marker = await trx
    .selectFrom('ludy_kernel.audit_event')
    .select('id')
    .where('org_id', '=', orgId)
    .where('command', 'in', [
      'sign.playbook.rule_upsert',
      'sign.playbook.rule_delete',
      'sign.playbook.seed_defaults',
    ])
    .where('outcome', '=', 'ok')
    .limit(1)
    .executeTakeFirst();
  return Boolean(marker);
}

async function listEffectivePlaybookRulesOnTrx(
  trx: QueryContext['trx'],
  orgId: string,
): Promise<{ items: SignPlaybookRuleRecord[]; isSeeded: boolean }> {
  const rows = await trx
    .selectFrom('ludy_sign.playbook_rule')
    .selectAll()
    .where('org_id', '=', orgId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(SIGN_MAX_PLAYBOOK_RULES + 5)
    .execute();

  if (rows.length === 0) {
    // Only return virtual defaults when the workspace has never initialized playbook rules;
    // deleting all saved rules keeps the workspace at zero rules until defaults are restored.
    if (await isPlaybookInitializedOnTrx(trx, orgId)) {
      return {
        items: [],
        isSeeded: true,
      };
    }
    return {
      items: virtualDefaultRuleRecords(orgId),
      isSeeded: false,
    };
  }

  return {
    items: rows.map((row) => toRuleRecord(orgId, row)),
    isSeeded: true,
  };
}

async function ensurePlaybookRulesMaterialized(
  ctx: CommandContext,
  userId: string,
): Promise<void> {
  const existing = await ctx.trx
    .selectFrom('ludy_sign.playbook_rule')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .limit(1)
    .executeTakeFirst();
  if (existing || (await isPlaybookInitializedOnTrx(ctx.trx, ctx.orgId))) {
    return;
  }

  const baseTimeMs = ctx.now.getTime();
  for (const [index, spec] of DEFAULT_VIETNAM_SME_PLAYBOOK_RULES.entries()) {
    const createdAt = new Date(baseTimeMs + index);
    await ctx.trx
      .insertInto('ludy_sign.playbook_rule')
      .values({
        org_id: ctx.orgId,
        id: deterministicPlaybookRuleId(ctx.orgId, spec.slot),
        title: spec.title,
        guidance: spec.guidance,
        severity: spec.severity,
        match_keywords: [...spec.matchKeywords],
        active: true,
        created_by: userId,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .onConflict((oc) => oc.columns(['org_id', 'id']).doNothing())
      .execute();
  }
}

const SNIPPET_MAX_CHARS = 480;
const SNIPPET_OVERLAP_CHARS = 120;

interface PageClauseSnippet {
  page: number;
  raw: string;
  norm: string;
  sentGroupId: number;
}

interface NumericAnalysis {
  values: number[];
  hasUnsupported: boolean;
}

function adjustSurrogateEnd(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

function adjustSurrogateStart(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

function pushSentenceChunks(
  snippets: PageClauseSnippet[],
  page: number,
  sentence: string,
  sentGroupId: number,
): void {
  let start = 0;
  while (start < sentence.length) {
    const rawEnd = Math.min(sentence.length, start + SNIPPET_MAX_CHARS);
    let end = rawEnd;
    if (rawEnd < sentence.length) {
      const spaceIdx = sentence.lastIndexOf(' ', rawEnd);
      if (spaceIdx >= start + Math.floor(SNIPPET_MAX_CHARS / 2)) {
        end = spaceIdx;
      } else {
        end = adjustSurrogateEnd(sentence, rawEnd);
      }
      if (end <= start) {
        end = rawEnd;
      }
    }
    const chunk = sentence.slice(start, end).trim();
    if (chunk) {
      snippets.push({
        page,
        raw: chunk,
        norm: normalizeSearchText(chunk),
        sentGroupId,
      });
    }
    if (end >= sentence.length) break;
    const overlapTarget = Math.max(start + 1, end - SNIPPET_OVERLAP_CHARS);
    const nextSpace = sentence.indexOf(' ', overlapTarget);
    let nextStart =
      nextSpace !== -1 && nextSpace < end - 1
        ? nextSpace + 1
        : adjustSurrogateStart(sentence, overlapTarget);
    if (nextStart <= start) {
      nextStart = end;
    }
    start = nextStart;
  }
}

function splitPagesIntoSnippets(
  pages: readonly SignPlaybookExtractedPage[],
  pageCount: number,
): PageClauseSnippet[] {
  const snippets: PageClauseSnippet[] = [];
  let nextSentGroupId = 1;
  for (const p of pages) {
    if (!Number.isInteger(p.page) || p.page < 1 || p.page > pageCount) continue;
    const rawPage = stripFormatControl(p.text).replace(/\r\n/g, '\n');
    if (!rawPage.trim()) continue;
    const blocks = rawPage.split(/\n{2,}|\n(?=(?:điều|khoản|mục|article|section|clause|\d+[.)])\s)/iu);
    for (const block of blocks) {
      const trimmed = block.replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;
      if (trimmed.length <= 500) {
        snippets.push({
          page: p.page,
          raw: trimmed,
          norm: normalizeSearchText(trimmed),
          sentGroupId: nextSentGroupId++,
        });
      } else {
        const sentences = trimmed.split(/(?<=[.;!?])\s+/u);
        let acc = '';
        for (const sent of sentences) {
          if (sent.length > SNIPPET_MAX_CHARS) {
            if (acc) {
              snippets.push({
                page: p.page,
                raw: acc,
                norm: normalizeSearchText(acc),
                sentGroupId: nextSentGroupId++,
              });
              acc = '';
            }
            pushSentenceChunks(snippets, p.page, sent, nextSentGroupId++);
            continue;
          }
          const next = acc ? `${acc} ${sent}` : sent;
          if (next.length > SNIPPET_MAX_CHARS && acc) {
            snippets.push({
              page: p.page,
              raw: acc,
              norm: normalizeSearchText(acc),
              sentGroupId: nextSentGroupId++,
            });
            acc = sent;
          } else {
            acc = next;
          }
        }
        if (acc) {
          snippets.push({
            page: p.page,
            raw: acc,
            norm: normalizeSearchText(acc),
            sentGroupId: nextSentGroupId++,
          });
        }
      }
    }
  }
  return snippets;
}

function findMatchingSnippets(
  snippets: readonly PageClauseSnippet[],
  keywords: readonly string[],
): PageClauseSnippet[] {
  const normKeywords = keywords.map((k) => normalizeSearchText(k)).filter((k) => k.length > 0);
  if (normKeywords.length === 0) return [];

  const scored: Array<{ snippet: PageClauseSnippet; score: number; index: number }> = [];
  const matchedGroupIds = new Set<number>();

  for (const [index, snippet] of snippets.entries()) {
    let score = 0;
    for (const kw of normKeywords) {
      if (snippet.norm.includes(kw)) {
        score += kw.length >= 8 ? 3 : 1;
      }
    }
    if (score > 0) {
      scored.push({ snippet, score, index });
      matchedGroupIds.add(snippet.sentGroupId);
    }
  }

  // Include remaining overlapping chunks from an over-long sentence whose head/middle matched a keyword.
  if (matchedGroupIds.size > 0) {
    const directIdx = new Set(scored.map((item) => item.index));
    for (const [index, snippet] of snippets.entries()) {
      if (!directIdx.has(index) && matchedGroupIds.has(snippet.sentGroupId)) {
        scored.push({ snippet, score: 0.5, index });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((item) => item.snippet);
}

function findBestSnippet(
  snippets: readonly PageClauseSnippet[],
  keywords: readonly string[],
): PageClauseSnippet | null {
  return findMatchingSnippets(snippets, keywords)[0] ?? null;
}

// Retain every chunk sharing a sentGroupId with any topic-matched snippet so unpunctuated
// >480-char clauses with the topic keyword in chunk 1 and the value/phrase in chunk 2 stay intact.
function filterTopicSnippets(
  rawMatches: readonly PageClauseSnippet[],
  predicate: (snippet: PageClauseSnippet) => boolean,
): readonly PageClauseSnippet[] {
  const topicMatches = rawMatches.filter(predicate);
  if (topicMatches.length === 0) return rawMatches;
  const topicGroupIds = new Set(topicMatches.map((m) => m.sentGroupId));
  return rawMatches.filter((m) => topicGroupIds.has(m.sentGroupId));
}

function extractPercentAnalysis(text: string): NumericAnalysis {
  const values: number[] = [];
  let hasUnsupported = false;
  for (const m of text.matchAll(/(?<![\p{N}])(?:[.,]\d+|\d+(?:[.,]\d+)*)\s*%/gu)) {
    const full = m[0] ?? '';
    const rawNum = full.replace(/\s*%$/u, '');
    const idx = m.index ?? 0;
    if (idx > 0) {
      const prev = text[idx - 1] ?? '';
      const prev2 = idx > 1 ? (text[idx - 2] ?? '') : '';
      if ((prev === '-' || prev === '\u2212') && !/[\p{N}%]/u.test(prev2)) {
        hasUnsupported = true;
        continue;
      }
    }
    if (/^\d{1,4}(?:[.,]\d{1,2})?$/.test(rawNum)) {
      const num = Number(rawNum.replace(',', '.'));
      if (Number.isFinite(num) && num >= 0) {
        values.push(num);
        continue;
      }
    }
    hasUnsupported = true;
  }
  return { values, hasUnsupported };
}

function pushDayToken(rawNum: string, out: NumericAnalysis): void {
  if (/^\d{1,5}$/.test(rawNum)) {
    const num = Number(rawNum);
    if (Number.isInteger(num) && num >= 0 && num <= 36500) {
      out.values.push(num);
      return;
    }
  }
  out.hasUnsupported = true;
}

function extractDayAnalysis(text: string): NumericAnalysis {
  const out: NumericAnalysis = { values: [], hasUnsupported: false };
  for (const m of text.matchAll(
    /(?<![\p{N}])([.,]\d+|\d+(?:[.,]\d+)*)\s*(?:ngày(?:\s+làm\s+việc)?|(?:calendar\s+|working\s+|business\s+)?days?)\b/giu,
  )) {
    pushDayToken(m[1] ?? '', out);
  }
  for (const m of text.matchAll(/\bnet\s*([.,]\d+|\d+(?:[.,]\d+)*)\b/giu)) {
    pushDayToken(m[1] ?? '', out);
  }
  return out;
}

function extractNoticeBoundDays(text: string): NumericAnalysis {
  const out: NumericAnalysis = { values: [], hasUnsupported: false };
  const patterns: RegExp[] = [
    /(?:báo|thông\s+báo)(?:\s+không\s+gia\s+hạn|\s+từ\s+chối\s+gia\s+hạn|\s+chấm\s+dứt)?(?:\s+bằng\s+văn\s+bản)?(?:\s+trước)?(?:\s+(?:ít\s+nhất|tối\s+thiểu|chậm\s+nhất))?\s+([.,]\d+|\d+(?:[.,]\d+)*)\s*(?:ngày(?:\s+làm\s+việc)?)\b/giu,
    /\b([.,]\d+|\d+(?:[.,]\d+)*)\s*(?:ngày(?:\s+làm\s+việc)?)\s+(?:trước\s+(?:khi\s+)?(?:hết\s+hạn|gia\s+hạn|chấm\s+dứt|ngày\s+hết\s+hạn)|(?:để\s+)?(?:thông\s+báo|báo)\s+trước)/giu,
    /(?:prior|advance)\s+(?:written\s+)?notice(?:\s+(?:of|at\s+least|not\s+less\s+than))?\s+(?:of\s+)?(?:(?:at\s+least|no\s+less\s+than|not\s+less\s+than)\s+)?([.,]\d+|\d+(?:[.,]\d+)*)\s*(?:(?:calendar|working|business)\s+)?days?\b/giu,
    /\b([.,]\d+|\d+(?:[.,]\d+)*)[\s-]+(?:(?:calendar|working|business)\s+)?days?['’]?\s+(?:prior\s+(?:written\s+)?notice|advance\s+(?:written\s+)?notice|notice\s+(?:prior|before|in\s+advance)|before\s+(?:the\s+)?(?:expir|end|renew|terminat))/giu,
    /\bnotice\s+(?:in\s+writing\s+)?(?:of\s+)?(?:at\s+least\s+)?([.,]\d+|\d+(?:[.,]\d+)*)\s*(?:(?:calendar|working|business)\s+)?days?\b/giu,
  ];
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      pushDayToken(m[1] ?? '', out);
    }
  }
  return out;
}

function extractOptOutNoticeDays(text: string): NumericAnalysis {
  // Mask renewal-term durations (e.g. "auto-renew for 90 days") so only opt-out notice deadlines count.
  const masked = text
    .replace(
      /\b(?:auto-?renew(?:ed|s)?|automatically\s+(?:renew(?:ed|s)?|extend(?:ed|s)?))\s+(?:for|by)\s+(?:an?\s+(?:additional\s+)?(?:term|period)\s+of\s+)?[^.;,]+?(?=\b(?:unless|except|if|until|prior|with)\b|[.;,]|$)/giu,
      ' ',
    )
    .replace(
      /\brenew(?:al)?\s+(?:term|period)\s+of\s+[^.;,]+?(?=\b(?:unless|except|if|until|prior|with)\b|[.;,]|$)/giu,
      ' ',
    )
    .replace(
      /(?:tự\s+động\s+gia\s+hạn|gia\s+hạn\s+tự\s+động)\s+(?:thêm|trong(?:\s+thời\s+hạn)?)\s+[^.;,]+?(?=\b(?:trừ\s+khi|nếu|cho\s+đến|trước)\b|[.;,]|$)/giu,
      ' ',
    );
  return extractNoticeBoundDays(masked);
}

function hasTerminationParity(text: string): boolean {
  const hasAsymmetricDenial =
    /(?<![\p{L}\p{N}])(?:only\s+(?:the\s+)?(?:buyer|seller|client|customer|provider|vendor|company|party\s+[ab])|chỉ\s+(?:bên\s+[ab]|bên\s+mua|bên\s+bán|khách\s+hàng|nhà\s+cung\s+cấp)|không\s+có\s+quyền\s+đơn\s+phương\s+chấm\s+dứt)(?![\p{L}\p{N}])/iu.test(
      text,
    );
  if (hasAsymmetricDenial) return false;
  return /(?<![\p{L}\p{N}])(?:mỗi\s+bên|hai\s+bên|cả\s+hai\s+bên|các\s+bên|bất\s+kỳ\s+bên\s+nào|bên\s+nào\s+cũng|tương\s*xứng|either\s+party|each\s+party|both\s+parties|any\s+party|either\s+of\s+the\s+parties|mutually)(?![\p{L}\p{N}])/iu.test(
    text,
  );
}

const VIETNAM_LAW_RE =
  /pháp\s+luật\s+(?:nước\s+cộng\s+hòa\s+xã\s+hội\s+chủ\s+nghĩa\s+)?việt\s*nam|luật\s+(?:pháp\s+)?việt\s*nam|vietnam(?:ese)?\s+law|laws?\s+of\s+viet\s*nam/iu;
const VIETNAM_FORUM_RE =
  /\bviac\b|trung\s+tâm\s+trọng\s+tài\s+quốc\s+tế\s+việt\s*nam|tòa\s+án\s+nhân\s+dân|tòa\s+án\s+có\s+thẩm\s+quyền\s+tại\s+việt\s*nam|trọng\s+tài(?:\s+thương\s+mại)?\s+tại\s+việt\s*nam|courts?\s+(?:of|in)\s+viet\s*nam|arbitration\s+in\s+(?:viet\s*nam|hanoi|hà\s+nội|ho\s+chi\s+minh|hồ\s+chí\s+minh|da\s+nang|đà\s+nẵng)|(?:tại|ở|in|at)\s+(?:hà\s+nội|hồ\s+chí\s+minh|tp\.?\s*hcm|đà\s+nẵng)/iu;
const FOREIGN_VENUE_OR_LAW_RE =
  /\b(?:singapore|siac|hong\s+kong|hkiac|london|lcia|new\s+york|delaware|california|england\s+and\s+wales|english\s+law|swiss\s+law|icc\s+paris|tokyo|kuala\s+lumpur|aiac|bangkok|taiac|seoul|kcab|beijing|cietac|geneva|zurich)\b/iu;

function evaluateCustomOrUnparseableRule(
  rule: SignPlaybookRuleEffective,
  snippets: readonly PageClauseSnippet[],
  extraKeywords: readonly string[],
  unparseableNote?: string,
): SignPlaybookFindingContract {
  const base = {
    ruleId: rule.id,
    ruleTitle: rule.title,
    severity: rule.severity,
    proposedByAi: false,
    manualNote: null,
    overriddenBy: null,
    overriddenAt: null,
  };
  const fallbackWords = rule.title
    .split(/[^\p{L}\p{N}%]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4)
    .slice(0, 6);
  const searchTerms =
    rule.matchKeywords.length > 0
      ? [...new Set([...rule.matchKeywords, ...extraKeywords])]
      : [...new Set([...fallbackWords, ...extraKeywords])];
  const customMatch = findBestSnippet(snippets, searchTerms);
  const fallbackRedline = neutralizeEmbeddedTags(cleanMultiLine(rule.guidance, 600));

  if (customMatch) {
    return {
      ...base,
      verdict: 'warn',
      rationale:
        unparseableNote ??
        `Tìm thấy điều khoản khớp từ khóa của quy tắc "${cleanSingleLine(rule.title, 120)}" tại trang ${customMatch.page}; cần đối chiếu thủ công với hướng dẫn.`,
      pageNumber: customMatch.page,
      quoteExcerpt: cleanMultiLine(customMatch.raw, 600),
      suggestedRedline: fallbackRedline,
    };
  }

  return {
    ...base,
    verdict: unparseableNote ? 'warn' : rule.severity === 'info' ? 'unknown' : 'warn',
    rationale:
      unparseableNote ??
      `Không tìm thấy từ khóa khớp với quy tắc "${cleanSingleLine(rule.title, 120)}" trong văn bản trích xuất; cần rà soát thủ công.`,
    pageNumber: null,
    quoteExcerpt: null,
    suggestedRedline: fallbackRedline,
  };
}

function evaluateSingleRuleDeterministically(
  orgId: string,
  rule: SignPlaybookRuleEffective,
  snippets: readonly PageClauseSnippet[],
): SignPlaybookFindingContract {
  // Only built-in default rules (by deterministic org-scoped ruleId) run slot-specific numeric checks;
  // custom rules never inherit built-in defaults (e.g. 8% cap or 30-day limit).
  const slot = defaultSlotForRuleId(orgId, rule.id);
  const base = {
    ruleId: rule.id,
    ruleTitle: rule.title,
    severity: rule.severity,
    proposedByAi: false,
    manualNote: null,
    overriddenBy: null,
    overriddenAt: null,
  };

  if (slot === 'penalty_cap') {
    const keywords = [
      ...new Set([
        ...rule.matchKeywords,
        'phạt vi phạm',
        'mức phạt',
        'tiền phạt',
        'khoản phạt',
        'bị phạt',
        'penalty',
        'liquidated damages',
      ]),
    ];
    const guidancePercents = extractPercentAnalysis(rule.guidance);
    if (guidancePercents.hasUnsupported || guidancePercents.values.length === 0) {
      return evaluateCustomOrUnparseableRule(
        rule,
        snippets,
        keywords,
        `Hướng dẫn quy tắc "${cleanSingleLine(rule.title, 120)}" không nêu ngưỡng phần trăm cố định; cần rà soát thủ công.`,
      );
    }
    const capPercent = Math.max(...guidancePercents.values);
    const rawMatches = findMatchingSnippets(snippets, keywords);
    const matches = filterTopicSnippets(rawMatches, (m) =>
      /phạt|vi\s+phạm|penalty|liquidated\s+damages|điều\s+301/iu.test(m.raw),
    );
    const redline =
      capPercent === 8
        ? 'Mức phạt vi phạm hợp đồng tối đa không vượt quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm theo Điều 301 Luật Thương mại 2005.'
        : `Mức phạt vi phạm hợp đồng tối đa không vượt quá ${capPercent}% theo quy tắc của tổ chức.`;
    if (matches.length === 0) {
      return {
        ...base,
        verdict: 'unknown',
        rationale: 'Không tìm thấy điều khoản phạt vi phạm hợp đồng trong văn bản trích xuất.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }

    let failHit: { snippet: PageClauseSnippet; highest: number } | null = null;
    let unsupportedHit: PageClauseSnippet | null = null;
    let missingPctHit: PageClauseSnippet | null = null;
    let passHit: { snippet: PageClauseSnippet; highest: number } | null = null;

    for (const match of matches) {
      const analysis = extractPercentAnalysis(match.raw);
      const highest = analysis.values.length > 0 ? Math.max(...analysis.values) : null;
      if (highest !== null && highest > capPercent) {
        if (!failHit || highest > failHit.highest) {
          failHit = { snippet: match, highest };
        }
      } else if (analysis.hasUnsupported) {
        if (!unsupportedHit) unsupportedHit = match;
      } else if (highest === null) {
        if (!missingPctHit) missingPctHit = match;
      } else if (!passHit) {
        passHit = { snippet: match, highest };
      }
    }

    if (failHit) {
      return {
        ...base,
        verdict: 'fail',
        rationale: `Điều khoản phạt ghi nhận mức ${failHit.highest}%, vượt trần ${capPercent}% theo quy tắc đã cấu hình.`,
        pageNumber: failHit.snippet.page,
        quoteExcerpt: cleanMultiLine(failHit.snippet.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (unsupportedHit) {
      return {
        ...base,
        verdict: 'warn',
        rationale: `Điều khoản phạt có giá trị phần trăm vượt độ chính xác hoặc định dạng hỗ trợ; cần rà soát thủ công so với trần ${capPercent}%.`,
        pageNumber: unsupportedHit.page,
        quoteExcerpt: cleanMultiLine(unsupportedHit.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (missingPctHit && !passHit) {
      return {
        ...base,
        verdict: 'warn',
        rationale: `Có điều khoản phạt vi phạm nhưng chưa nêu rõ trần phần trăm <= ${capPercent}%.`,
        pageNumber: missingPctHit.page,
        quoteExcerpt: cleanMultiLine(missingPctHit.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (passHit) {
      return {
        ...base,
        verdict: 'pass',
        rationale: `Mức phạt vi phạm (${passHit.highest}%) nằm trong giới hạn <= ${capPercent}%.`,
        pageNumber: passHit.snippet.page,
        quoteExcerpt: cleanMultiLine(passHit.snippet.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: `Có điều khoản phạt vi phạm nhưng chưa nêu rõ trần phần trăm <= ${capPercent}%.`,
      pageNumber: matches[0]!.page,
      quoteExcerpt: cleanMultiLine(matches[0]!.raw, 600),
      suggestedRedline: redline,
    };
  }

  if (slot === 'payment_terms') {
    const keywords = [
      ...new Set([
        ...rule.matchKeywords,
        'thời hạn thanh toán',
        'thanh toán trong vòng',
        'thanh toán',
        'payment terms',
        'within',
        'net ',
      ]),
    ];
    const guidanceDays = extractDayAnalysis(rule.guidance);
    if (guidanceDays.hasUnsupported || guidanceDays.values.length === 0) {
      return evaluateCustomOrUnparseableRule(
        rule,
        snippets,
        keywords,
        `Hướng dẫn quy tắc "${cleanSingleLine(rule.title, 120)}" không nêu giới hạn số ngày cố định; cần rà soát thủ công.`,
      );
    }
    const maxDays = Math.max(...guidanceDays.values);
    const matches = findMatchingSnippets(snippets, keywords);
    const redline = `Bên mua thanh toán đầy đủ trong vòng ${maxDays} ngày kể từ ngày nghiệm thu và nhận đủ hồ sơ thanh toán, hóa đơn hợp lệ.`;
    if (matches.length === 0) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Chưa tìm thấy điều khoản quy định thời hạn thanh toán cụ thể trong văn bản.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }

    let overHit: { snippet: PageClauseSnippet; longest: number } | null = null;
    let unsupportedHit: PageClauseSnippet | null = null;
    let passHit: { snippet: PageClauseSnippet; longest: number } | null = null;

    for (const match of matches) {
      const days = extractDayAnalysis(match.raw);
      const longest = days.values.length > 0 ? Math.max(...days.values) : null;
      if (longest !== null && longest > maxDays) {
        if (!overHit || longest > overHit.longest) {
          overHit = { snippet: match, longest };
        }
      } else if (days.hasUnsupported) {
        if (!unsupportedHit) unsupportedHit = match;
      } else if (longest !== null && longest >= 1 && longest <= maxDays) {
        if (!passHit) passHit = { snippet: match, longest };
      }
    }

    if (overHit) {
      return {
        ...base,
        verdict: rule.severity === 'critical' ? 'fail' : 'warn',
        rationale: `Thời hạn thanh toán (${overHit.longest} ngày) vượt ngưỡng tiêu chuẩn ${maxDays} ngày của doanh nghiệp.`,
        pageNumber: overHit.snippet.page,
        quoteExcerpt: cleanMultiLine(overHit.snippet.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (unsupportedHit) {
      return {
        ...base,
        verdict: 'warn',
        rationale: `Thời hạn thanh toán có định dạng số ngày không thể đối chiếu tự động với ngưỡng ${maxDays} ngày; cần rà soát thủ công.`,
        pageNumber: unsupportedHit.page,
        quoteExcerpt: cleanMultiLine(unsupportedHit.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (passHit) {
      return {
        ...base,
        verdict: 'pass',
        rationale: `Thời hạn thanh toán (${passHit.longest} ngày) đáp ứng ngưỡng <= ${maxDays} ngày.`,
        pageNumber: passHit.snippet.page,
        quoteExcerpt: cleanMultiLine(passHit.snippet.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: `Có điều khoản thanh toán nhưng chưa nêu rõ số ngày tối đa (<= ${maxDays} ngày).`,
      pageNumber: matches[0]!.page,
      quoteExcerpt: cleanMultiLine(matches[0]!.raw, 600),
      suggestedRedline: redline,
    };
  }

  if (slot === 'termination_notice') {
    const keywords = [
      ...new Set([
        ...rule.matchKeywords,
        'đơn phương chấm dứt',
        'chấm dứt hợp đồng',
        'hủy bỏ hợp đồng',
        'termination',
        'terminate',
      ]),
    ];
    const guidanceDays = extractDayAnalysis(rule.guidance);
    if (guidanceDays.hasUnsupported || guidanceDays.values.length === 0) {
      return evaluateCustomOrUnparseableRule(
        rule,
        snippets,
        keywords,
        `Hướng dẫn quy tắc "${cleanSingleLine(rule.title, 120)}" không nêu số ngày báo trước tối thiểu; cần rà soát thủ công.`,
      );
    }
    const minNoticeDays = Math.min(...guidanceDays.values);
    const requiresParity =
      /tương\s*xứng|cân\s*bằng|hai\s+bên|mỗi\s+bên|both\s+parties|either\s+party|parity|mutual/iu.test(
        rule.guidance,
      );
    const redlineDays = Math.max(30, minNoticeDays);
    const redline = `Mỗi bên có quyền đơn phương chấm dứt hợp đồng khi bên kia vi phạm nghĩa vụ cơ bản không khắc phục hoặc khi gửi thông báo bằng văn bản trước ít nhất ${redlineDays} ngày.`;
    const rawMatches = findMatchingSnippets(snippets, keywords);
    const matches = filterTopicSnippets(rawMatches, (m) =>
      /chấm\s+dứt|hủy\s+bỏ|terminat/iu.test(m.raw),
    );
    if (matches.length === 0) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Không tìm thấy điều khoản quy định thời hạn báo trước khi đơn phương chấm dứt hợp đồng.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }

    let failHit: PageClauseSnippet | null = null;
    let shortOrOneSidedHit: { snippet: PageClauseSnippet; reason: string } | null = null;
    let passHit: { snippet: PageClauseSnippet; noticeDays: number } | null = null;

    for (const match of matches) {
      const immediateNoNotice =
        /không\s+cần\s+(?:thông\s+báo|báo)\s+trước|chấm\s+dứt\s+ngay\s+lập\s+tức\s+mà\s+không|without\s+(?:prior\s+)?(?:written\s+)?notice|immediately\s+at\s+(?:its\s+)?sole\s+discretion|terminate\s+at\s+any\s+time\s+without\s+notice/iu.test(
          match.raw,
        );
      if (immediateNoNotice) {
        if (!failHit) failHit = match;
        continue;
      }

      const hasNoticePhrase =
        /báo\s+trước|thông\s+báo\s+trước|thông\s+báo\s+bằng\s+văn\s+bản\s+trước|prior\s+(?:written\s+)?notice|advance\s+(?:written\s+)?notice|days?['’]?\s+(?:prior\s+)?notice/iu.test(
          match.raw,
        );
      const noticeBound = extractNoticeBoundDays(match.raw);
      const minMatchedNotice = noticeBound.values.length > 0 ? Math.min(...noticeBound.values) : null;
      const parityOk = !requiresParity || hasTerminationParity(match.raw);

      if (hasNoticePhrase && !noticeBound.hasUnsupported && minMatchedNotice !== null) {
        if (minMatchedNotice < minNoticeDays) {
          if (!shortOrOneSidedHit) {
            shortOrOneSidedHit = {
              snippet: match,
              reason: `Thời hạn báo trước (${minMatchedNotice} ngày) thấp hơn ngưỡng tối thiểu ${minNoticeDays} ngày theo quy tắc.`,
            };
          }
          continue;
        }
        if (!parityOk) {
          if (!shortOrOneSidedHit) {
            shortOrOneSidedHit = {
              snippet: match,
              reason: 'Điều khoản có nêu thời hạn báo trước nhưng chưa thể hiện quyền chấm dứt tương xứng cho cả hai bên.',
            };
          }
          continue;
        }
        if (!passHit) {
          passHit = { snippet: match, noticeDays: minMatchedNotice };
        }
      } else if (hasNoticePhrase || /\bđơn\s+phương\s+chấm\s+dứt|\bterminate\b|\btermination\b/iu.test(match.raw)) {
        if (!shortOrOneSidedHit && !parityOk) {
          shortOrOneSidedHit = {
            snippet: match,
            reason: `Cần kiểm tra thời hạn báo trước tối thiểu (>= ${minNoticeDays} ngày) và sự cân bằng quyền chấm dứt giữa hai bên.`,
          };
        }
      }
    }

    if (failHit) {
      return {
        ...base,
        verdict: 'fail',
        rationale: 'Điều khoản cho phép đơn phương chấm dứt ngay lập tức không cần thông báo trước, gây rủi ro mất cân bằng.',
        pageNumber: failHit.page,
        quoteExcerpt: cleanMultiLine(failHit.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (shortOrOneSidedHit) {
      return {
        ...base,
        verdict: 'warn',
        rationale: shortOrOneSidedHit.reason,
        pageNumber: shortOrOneSidedHit.snippet.page,
        quoteExcerpt: cleanMultiLine(shortOrOneSidedHit.snippet.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (passHit) {
      return {
        ...base,
        verdict: 'pass',
        rationale: `Điều khoản chấm dứt có thời hạn báo trước ${passHit.noticeDays} ngày${requiresParity ? ' và quyền chấm dứt tương xứng giữa hai bên' : ''}.`,
        pageNumber: passHit.snippet.page,
        quoteExcerpt: cleanMultiLine(passHit.snippet.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: `Cần kiểm tra thời hạn báo trước tối thiểu (>= ${minNoticeDays} ngày) và sự cân bằng quyền chấm dứt giữa hai bên.`,
      pageNumber: matches[0]!.page,
      quoteExcerpt: cleanMultiLine(matches[0]!.raw, 600),
      suggestedRedline: redline,
    };
  }

  if (slot === 'auto_renewal_notice') {
    const autoKeywords = [
      'tự động gia hạn',
      'gia hạn tự động',
      'tự động kéo dài',
      'auto-renew',
      'auto renew',
      'renews automatically',
      'automatic renewal',
      'automatically renew',
      'automatically extended',
    ];
    const guidanceDays = extractDayAnalysis(rule.guidance);
    const addressesAutoRenewal =
      /gia\s+hạn|auto[\s-]?renew|automatic\s+renewal|non-?renewal|opt[\s-]?out/iu.test(rule.guidance);
    if (!addressesAutoRenewal || guidanceDays.hasUnsupported || guidanceDays.values.length === 0) {
      return evaluateCustomOrUnparseableRule(
        rule,
        snippets,
        [...autoKeywords, 'gia hạn', 'renewal'],
        `Hướng dẫn quy tắc "${cleanSingleLine(rule.title, 120)}" không nêu số ngày báo trước từ chối gia hạn cố định; cần rà soát thủ công.`,
      );
    }
    const minOptOutDays = Math.min(...guidanceDays.values);
    const autoMatches = findMatchingSnippets(snippets, autoKeywords);
    const redline = `Hợp đồng chỉ được gia hạn khi hai bên ký phụ lục gia hạn bằng văn bản, hoặc mỗi bên có quyền từ chối gia hạn tự động bằng thông báo văn bản trước ít nhất ${Math.max(30, minOptOutDays)} ngày trước ngày hết hạn.`;
    if (autoMatches.length === 0) {
      const termMatch = findBestSnippet(snippets, [
        ...rule.matchKeywords,
        'hiệu lực hợp đồng',
        'thời hạn hợp đồng',
        'gia hạn',
        'term of agreement',
        'renewal',
      ]);
      if (termMatch) {
        return {
          ...base,
          verdict: 'pass',
          rationale: 'Không phát hiện cơ chế tự động gia hạn ràng buộc ngoài ý muốn trong điều khoản thời hạn.',
          pageNumber: termMatch.page,
          quoteExcerpt: cleanMultiLine(termMatch.raw, 600),
          suggestedRedline: null,
        };
      }
      return {
        ...base,
        verdict: 'unknown',
        rationale: 'Không tìm thấy điều khoản gia hạn hoặc thời hạn hiệu lực hợp đồng trong văn bản.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: null,
      };
    }

    let warnHit: { snippet: PageClauseSnippet; reason: string } | null = null;
    let passHit: { snippet: PageClauseSnippet; noticeDays: number } | null = null;

    for (const autoMatch of autoMatches) {
      const optOutDays = extractOptOutNoticeDays(autoMatch.raw);
      const hasOptOut =
        /không\s+gia\s+hạn|từ\s+chối\s+gia\s+hạn|chấm\s+dứt\s+gia\s+hạn|báo\s+trước|thông\s+báo\s+trước|non-renewal|not\s+to\s+renew|opt[\s-]out|prior\s+(?:written\s+)?notice|advance\s+(?:written\s+)?notice/iu.test(
          autoMatch.raw,
        );
      const minNotice = optOutDays.values.length > 0 ? Math.min(...optOutDays.values) : null;
      if (hasOptOut && !optOutDays.hasUnsupported && minNotice !== null && minNotice >= minOptOutDays) {
        if (!passHit) passHit = { snippet: autoMatch, noticeDays: minNotice };
      } else {
        if (!warnHit) {
          warnHit = {
            snippet: autoMatch,
            reason:
              minNotice !== null && minNotice < minOptOutDays
                ? `Thời hạn báo trước để từ chối gia hạn tự động (${minNotice} ngày) thấp hơn ngưỡng ${minOptOutDays} ngày.`
                : `Điều khoản tự động gia hạn chưa nêu rõ số ngày báo trước (>= ${minOptOutDays} ngày) gắn với thông báo từ chối gia hạn.`,
          };
        }
      }
    }

    if (warnHit) {
      return {
        ...base,
        verdict: 'warn',
        rationale: warnHit.reason,
        pageNumber: warnHit.snippet.page,
        quoteExcerpt: cleanMultiLine(warnHit.snippet.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (passHit) {
      return {
        ...base,
        verdict: 'pass',
        rationale: `Hợp đồng có tự động gia hạn kèm thời hạn thông báo từ chối trước (${passHit.noticeDays} ngày).`,
        pageNumber: passHit.snippet.page,
        quoteExcerpt: cleanMultiLine(passHit.snippet.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: `Điều khoản tự động gia hạn chưa nêu rõ thời hạn báo trước tối thiểu (>= ${minOptOutDays} ngày) để từ chối gia hạn.`,
      pageNumber: autoMatches[0]!.page,
      quoteExcerpt: cleanMultiLine(autoMatches[0]!.raw, 600),
      suggestedRedline: redline,
    };
  }

  if (slot === 'dispute_venue') {
    const keywords = [
      ...new Set([
        ...rule.matchKeywords,
        'giải quyết tranh chấp',
        'tòa án',
        'trọng tài',
        'luật áp dụng',
        'pháp luật',
        'dispute',
        'arbitration',
        'governing law',
        'jurisdiction',
      ]),
    ];
    const expectsVietnam =
      /việt\s*nam|viet\s*nam|vietnam|\bviac\b|tòa\s+án\s+nhân\s+dân/iu.test(rule.guidance);
    if (!expectsVietnam) {
      return evaluateCustomOrUnparseableRule(
        rule,
        snippets,
        keywords,
        `Hướng dẫn quy tắc "${cleanSingleLine(rule.title, 120)}" đã được tùy chỉnh ngoài chuẩn Việt Nam/VIAC; cần rà soát thủ công.`,
      );
    }

    const matches = findMatchingSnippets(snippets, keywords);
    const redline =
      'Hợp đồng này được điều chỉnh theo pháp luật Việt Nam. Mọi tranh chấp phát sinh không tự thương lượng được sẽ giải quyết tại Tòa án nhân dân có thẩm quyền tại Việt Nam hoặc Trung tâm Trọng tài Quốc tế Việt Nam (VIAC).';
    if (matches.length === 0) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Chưa tìm thấy điều khoản luật áp dụng và cơ quan giải quyết tranh chấp.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }

    const foreignHit = matches.find((m) => FOREIGN_VENUE_OR_LAW_RE.test(m.raw));
    if (foreignHit) {
      return {
        ...base,
        verdict: rule.severity === 'critical' ? 'fail' : 'warn',
        rationale:
          'Điều khoản tranh chấp hoặc luật áp dụng tham chiếu tài phán hay trọng tài nước ngoài, có thể phát sinh chi phí pháp lý cao.',
        pageNumber: foreignHit.page,
        quoteExcerpt: cleanMultiLine(foreignHit.raw, 600),
        suggestedRedline: redline,
      };
    }

    const lawHit = matches.find((m) => VIETNAM_LAW_RE.test(m.raw));
    const forumHit = matches.find((m) => VIETNAM_FORUM_RE.test(m.raw));
    if (lawHit && forumHit) {
      const cited = forumHit.page === lawHit.page ? forumHit : matches[0]!;
      return {
        ...base,
        verdict: 'pass',
        rationale: 'Điều khoản xác định áp dụng pháp luật Việt Nam và giải quyết tranh chấp tại cơ quan tài phán tại Việt Nam.',
        pageNumber: cited.page,
        quoteExcerpt: cleanMultiLine(cited.raw, 600),
        suggestedRedline: null,
      };
    }
    if (lawHit && !forumHit) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Điều khoản có dẫn chiếu pháp luật Việt Nam nhưng chưa nêu rõ cơ quan giải quyết tranh chấp tại Việt Nam.',
        pageNumber: lawHit.page,
        quoteExcerpt: cleanMultiLine(lawHit.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (forumHit && !lawHit) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Điều khoản có nêu cơ quan giải quyết tranh chấp tại Việt Nam nhưng chưa xác định rõ luật áp dụng là pháp luật Việt Nam.',
        pageNumber: forumHit.page,
        quoteExcerpt: cleanMultiLine(forumHit.raw, 600),
        suggestedRedline: redline,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: 'Có điều khoản tranh chấp nhưng chưa xác định rõ pháp luật Việt Nam và cơ quan tài phán tại Việt Nam.',
      pageNumber: matches[0]!.page,
      quoteExcerpt: cleanMultiLine(matches[0]!.raw, 600),
      suggestedRedline: redline,
    };
  }

  if (slot === 'acceptance_criteria') {
    const keywords = [
      ...new Set([
        ...rule.matchKeywords,
        'nghiệm thu',
        'biên bản nghiệm thu',
        'bàn giao',
        'acceptance',
        'deliverables',
        'handover',
      ]),
    ];
    const guidanceDays = extractDayAnalysis(rule.guidance);
    const asksProtocol =
      /nghiệm\s+thu|tiêu\s+chí|biên\s+bản|acceptance|criteria|protocol/iu.test(rule.guidance);
    if (!asksProtocol || guidanceDays.hasUnsupported || guidanceDays.values.length === 0) {
      return evaluateCustomOrUnparseableRule(
        rule,
        snippets,
        keywords,
        `Hướng dẫn quy tắc "${cleanSingleLine(rule.title, 120)}" không nêu ngưỡng số ngày phản hồi nghiệm thu cố định; cần rà soát thủ công.`,
      );
    }
    const maxResponseDays = Math.max(...guidanceDays.values);
    const rawMatches = findMatchingSnippets(snippets, keywords);
    const matches = filterTopicSnippets(rawMatches, (m) =>
      /nghiệm\s+thu|bàn\s+giao|acceptance|deliverables|handover|deemed\s+accepted/iu.test(m.raw),
    );
    const redline = `Bên mua kiểm tra kết quả bàn giao và ký biên bản nghiệm thu hoặc phản hồi bằng văn bản nêu rõ nội dung cần hiệu chỉnh trong vòng ${Math.min(5, maxResponseDays)} ngày làm việc kể từ ngày nhận bàn giao.`;
    if (matches.length === 0) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Chưa tìm thấy điều khoản quy định tiêu chí và thời hạn nghiệm thu bàn giao.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }

    let overHit: { snippet: PageClauseSnippet; days: number } | null = null;
    let passHit: PageClauseSnippet | null = null;
    let partialHit: PageClauseSnippet | null = null;

    for (const match of matches) {
      const days = extractDayAnalysis(match.raw);
      const longest = days.values.length > 0 ? Math.max(...days.values) : null;
      const hasProtocolOrCriteria =
        /biên\s+bản\s+nghiệm\s+thu|tiêu\s+chí\s+nghiệm\s+thu|điều\s+kiện\s+nghiệm\s+thu|acceptance\s+criteria|acceptance\s+certificate|written\s+acceptance|ký\s+nghiệm\s+thu|deemed\s+accepted/iu.test(
          match.raw,
        );
      if (longest !== null && longest > maxResponseDays) {
        if (!overHit || longest > overHit.days) {
          overHit = { snippet: match, days: longest };
        }
        continue;
      }
      if (hasProtocolOrCriteria && !days.hasUnsupported && longest !== null && longest >= 1 && longest <= maxResponseDays) {
        if (!passHit) passHit = match;
      } else if (!partialHit) {
        partialHit = match;
      }
    }

    if (overHit) {
      return {
        ...base,
        verdict: 'warn',
        rationale: `Thời hạn phản hồi nghiệm thu (${overHit.days} ngày) vượt ngưỡng ${maxResponseDays} ngày theo quy tắc.`,
        pageNumber: overHit.snippet.page,
        quoteExcerpt: cleanMultiLine(overHit.snippet.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (passHit) {
      return {
        ...base,
        verdict: 'pass',
        rationale: `Hợp đồng có quy định thủ tục hoặc tiêu chí nghiệm thu kèm thời hạn phản hồi <= ${maxResponseDays} ngày.`,
        pageNumber: passHit.page,
        quoteExcerpt: cleanMultiLine(passHit.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: `Điều khoản nghiệm thu chỉ đáp ứng một phần quy tắc (thiếu tiêu chí/biên bản hoặc thiếu thời hạn phản hồi <= ${maxResponseDays} ngày).`,
      pageNumber: (partialHit ?? matches[0]!).page,
      quoteExcerpt: cleanMultiLine((partialHit ?? matches[0]!).raw, 600),
      suggestedRedline: redline,
    };
  }

  return evaluateCustomOrUnparseableRule(rule, snippets, []);
}

export function evaluatePlaybookDeterministically(
  orgId: string,
  rules: readonly SignPlaybookRuleEffective[],
  pages: readonly SignPlaybookExtractedPage[],
  pageCount: number,
): SignPlaybookFindingContract[] {
  const activeRules = rules.filter((r) => r.active).slice(0, SIGN_MAX_PLAYBOOK_RULES);
  const snippets = splitPagesIntoSnippets(pages, pageCount);
  return activeRules.map((rule) => evaluateSingleRuleDeterministically(orgId, rule, snippets));
}

interface StoredFindingWithRevision {
  finding: SignPlaybookFindingContract;
  ruleRevision: string | null;
}

const HEX_64_RE = /^[0-9a-f]{64}$/;

function parseStoredFindingsInternal(raw: unknown): StoredFindingWithRevision[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: StoredFindingWithRevision[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const ruleIdParsed = zId.safeParse(obj.ruleId);
    if (!ruleIdParsed.success) continue;
    const ruleTitle = typeof obj.ruleTitle === 'string' ? cleanSingleLine(obj.ruleTitle, 200) : '';
    const rationale = typeof obj.rationale === 'string' ? cleanSingleLine(obj.rationale, 600) : '';
    if (!ruleTitle || !rationale) continue;
    const rawSeverity = typeof obj.severity === 'string' ? obj.severity : 'warn';
    const severity: SignPlaybookSeverity = PLAYBOOK_SEVERITY_SET.has(rawSeverity)
      ? (rawSeverity as SignPlaybookSeverity)
      : 'warn';
    const rawVerdict = typeof obj.verdict === 'string' ? obj.verdict : 'unknown';
    const verdict: SignPlaybookVerdictContract = PLAYBOOK_VERDICT_SET.has(rawVerdict)
      ? (rawVerdict as SignPlaybookVerdictContract)
      : 'unknown';
    const pageNumber =
      typeof obj.pageNumber === 'number' &&
      Number.isInteger(obj.pageNumber) &&
      obj.pageNumber >= 1 &&
      obj.pageNumber <= SIGN_MAX_PAGES
        ? obj.pageNumber
        : null;
    const quoteExcerpt =
      typeof obj.quoteExcerpt === 'string' && obj.quoteExcerpt.trim().length > 0
        ? cleanMultiLine(obj.quoteExcerpt, 600)
        : null;
    const suggestedRedline =
      typeof obj.suggestedRedline === 'string' && obj.suggestedRedline.trim().length > 0
        ? neutralizeEmbeddedTags(cleanMultiLine(obj.suggestedRedline, 1200))
        : null;
    const manualNote =
      typeof obj.manualNote === 'string' && obj.manualNote.trim().length > 0
        ? cleanMultiLine(obj.manualNote, 500)
        : null;
    const overriddenByParsed = zId.safeParse(obj.overriddenBy);
    const overriddenBy = overriddenByParsed.success ? overriddenByParsed.data : null;
    const overriddenAt =
      typeof obj.overriddenAt === 'string' && obj.overriddenAt.trim().length > 0
        ? obj.overriddenAt.trim()
        : null;
    const ruleRevision =
      typeof obj.ruleRevision === 'string' && HEX_64_RE.test(obj.ruleRevision)
        ? obj.ruleRevision
        : null;
    out.push({
      finding: {
        ruleId: ruleIdParsed.data,
        ruleTitle,
        severity,
        verdict,
        rationale,
        pageNumber: quoteExcerpt ? pageNumber : null,
        quoteExcerpt: pageNumber ? quoteExcerpt : null,
        suggestedRedline,
        proposedByAi: obj.proposedByAi === true,
        manualNote,
        overriddenBy,
        overriddenAt,
      },
      ruleRevision,
    });
  }
  return out;
}

function serializeStoredFindings(items: readonly StoredFindingWithRevision[]): string {
  return JSON.stringify(
    items.map((item) => ({
      ...item.finding,
      ...(item.ruleRevision ? { ruleRevision: item.ruleRevision } : {}),
    })),
  );
}

export function computePlaybookCheckRevision(params: {
  id: string;
  sourceSha256: string;
  mode: SignPlaybookMode;
  updatedAt: Date | string;
  findings: readonly SignPlaybookFindingContract[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        params.id,
        params.sourceSha256,
        params.mode,
        new Date(params.updatedAt).toISOString(),
        params.findings,
      ]),
    )
    .digest('hex');
}

function isCheckStaleByRules(
  stored: readonly StoredFindingWithRevision[],
  currentRules: readonly SignPlaybookRuleEffective[],
): boolean {
  const activeRules = currentRules.filter((r) => r.active).slice(0, SIGN_MAX_PLAYBOOK_RULES);
  const storedById = new Map(stored.map((item) => [item.finding.ruleId, item]));
  if (stored.length !== activeRules.length || storedById.size !== activeRules.length) {
    return true;
  }
  for (const rule of activeRules) {
    const item = storedById.get(rule.id);
    if (!item) return true;
    const expectedRev = computePlaybookRuleRevision(rule);
    if (item.ruleRevision !== null) {
      if (item.ruleRevision !== expectedRev) return true;
    } else if (item.finding.ruleTitle !== rule.title || item.finding.severity !== rule.severity) {
      return true;
    }
  }
  return false;
}

function toPlaybookCheckRecord(
  row: {
    id: string;
    envelope_id: string;
    source_sha256: string;
    mode: SignPlaybookMode;
    findings_json: unknown;
    prompt_version: string | null;
    created_by: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  },
  currentSourceSha256: string,
  currentRules: readonly SignPlaybookRuleEffective[],
): SignEnvelopePlaybookCheckRecord {
  const parsed = parseStoredFindingsInternal(row.findings_json);
  const findings = parsed.map((item) => item.finding);
  const updatedAtIso = new Date(row.updated_at).toISOString();
  const revision = computePlaybookCheckRevision({
    id: row.id,
    sourceSha256: row.source_sha256,
    mode: row.mode,
    updatedAt: updatedAtIso,
    findings,
  });
  return {
    id: row.id,
    envelopeId: row.envelope_id,
    sourceSha256: row.source_sha256,
    revision,
    isStale: row.source_sha256 !== currentSourceSha256 || isCheckStaleByRules(parsed, currentRules),
    mode: row.mode,
    findings,
    promptVersion: row.prompt_version,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: updatedAtIso,
  };
}

function verifyQuoteOnExtractedPages(
  preferredPage: number | null,
  quote: string,
  pageCount: number,
  pageNormMap: ReadonlyMap<number, string>,
): number | null {
  const normQuote = normalizeSearchText(quote);
  if (normQuote.length < 4) return null;
  if (
    preferredPage !== null &&
    Number.isInteger(preferredPage) &&
    preferredPage >= 1 &&
    preferredPage <= pageCount
  ) {
    const normPage = pageNormMap.get(preferredPage);
    if (normPage && normPage.includes(normQuote)) {
      return preferredPage;
    }
  }
  for (const [page, normPage] of pageNormMap.entries()) {
    if (page >= 1 && page <= pageCount && normPage.includes(normQuote)) {
      return page;
    }
  }
  return null;
}

const zPlaybookAiFindingInput = z.strictObject({
  ruleId: zId,
  verdict: z.enum(SIGN_PLAYBOOK_VERDICTS),
  rationale: z.string().min(1).max(1000),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable(),
  quoteExcerpt: z.string().max(1000).nullable(),
  suggestedRedline: z.string().max(1600).nullable(),
  proposedByAi: z.boolean(),
});

const zPlaybookEvaluatedRuleRef = z.strictObject({
  ruleId: zId,
  revision: z.string().regex(HEX_64_RE),
});

export const zPlaybookRecordCheckInput = z
  .strictObject({
    envelopeId: zId,
    sourceSha256: z.string().regex(HEX_64_RE),
    mode: z.enum(SIGN_PLAYBOOK_MODES),
    promptVersion: z.string().trim().min(1).max(32).nullable(),
    preserveExistingFresh: z.boolean().optional(),
    evaluatedRules: z.array(zPlaybookEvaluatedRuleRef).max(SIGN_MAX_PLAYBOOK_RULES).optional(),
    aiFindings: z.array(zPlaybookAiFindingInput).max(SIGN_MAX_PLAYBOOK_RULES).optional(),
    extractedPages: z
      .array(z.strictObject({ page: z.number().int().min(1).max(SIGN_MAX_PAGES), text: z.string().max(250_000) }))
      .max(SIGN_MAX_PAGES)
      .refine(
        (pages) => pages.reduce((sum, item) => sum + item.text.length, 0) <= SIGN_PLAYBOOK_MAX_TOTAL_CHARS,
        `Total extracted text across all pages must not exceed ${SIGN_PLAYBOOK_MAX_TOTAL_CHARS} characters`,
      ),
  })
  .refine(
    (val) => val.mode !== 'ai' || (Array.isArray(val.evaluatedRules) && val.evaluatedRules.length > 0),
    'evaluatedRules is required when recording AI playbook findings',
  );

export const playbookRulesList = defineQuery({
  name: 'sign.playbook.rules_list',
  input: zSignPlaybookRulesListInput,
  access: READERS,
  handler: async (ctx, input): Promise<SignPlaybookRulesListResult> => {
    assertUser(ctx);
    const { items, isSeeded } = await listEffectivePlaybookRulesOnTrx(ctx.trx, ctx.orgId);
    const filtered = input.activeOnly ? items.filter((r) => r.active) : items;
    return {
      items: filtered,
      canManage: ctx.role === 'owner' || ctx.role === 'admin',
      isSeeded,
    };
  },
});

export const playbookGet = defineQuery({
  name: 'sign.playbook.get',
  input: z.strictObject({ envelopeId: zId }),
  access: READERS,
  handler: async (ctx, input): Promise<SignPlaybookGetResult> => {
    assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'source_kind', 'source_id', 'created_by', 'source_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');

    const [row, effectiveRules] = await Promise.all([
      ctx.trx
        .selectFrom('ludy_sign.playbook_check')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', env.id)
        .executeTakeFirst(),
      listEffectivePlaybookRulesOnTrx(ctx.trx, ctx.orgId),
    ]);

    const activeRulesCount = effectiveRules.items.filter((r) => r.active).length;

    return {
      check: row ? toPlaybookCheckRecord(row, env.source_sha256, effectiveRules.items) : null,
      canEdit: ctx.role === 'owner' || ctx.role === 'admin' || ctx.role === 'member',
      activeRulesCount,
    };
  },
});

export const playbookSource = defineQuery({
  name: 'sign.playbook.source',
  input: z.strictObject({ envelopeId: zId }),
  access: WRITERS,
  handler: async (ctx, input): Promise<SignPlaybookSource> => {
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select([
        'id',
        'status',
        'source_kind',
        'source_id',
        'created_by',
        'inspect_status',
        'source_sha256',
        'source_file_id',
        'source_storage_key',
        'source_generation',
        'title',
        'page_count',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');

    const [aiStopped, effectiveRules] = await Promise.all([
      isSignAiStoppedOnTrx(ctx.trx, ctx.orgId),
      listEffectivePlaybookRulesOnTrx(ctx.trx, ctx.orgId),
    ]);

    const activeRules: SignPlaybookSourceRule[] = effectiveRules.items
      .filter((r) => r.active)
      .slice(0, SIGN_MAX_PLAYBOOK_RULES)
      .map((r) => ({
        id: r.id,
        title: r.title,
        guidance: r.guidance,
        severity: r.severity,
        matchKeywords: r.matchKeywords,
        active: r.active,
        isDefault: r.isDefault,
        revision: computePlaybookRuleRevision(r),
      }));

    return {
      envelopeId: env.id,
      status: env.status,
      inspectStatus: env.inspect_status,
      sourceSha256: env.source_sha256,
      sourceFileId: env.source_file_id,
      sourceStorageKey: env.source_storage_key,
      sourceGeneration: env.source_generation,
      title: cleanSingleLine(env.title, 300),
      pageCount: env.page_count,
      aiStopped,
      activeRules,
    };
  },
});

async function acquirePlaybookRuleOrgLock(trx: CommandContext['trx'], orgId: string): Promise<void> {
  await sql`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${`sign.playbook.rule:${orgId}`}, 0)
    )
  `.execute(trx);
}

export const playbookRuleUpsert = defineCommand({
  name: 'sign.playbook.rule_upsert',
  input: zSignPlaybookRuleUpsertInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: PLAYBOOK_ADMINS,
  writes: [PLAYBOOK_RULE_WRITE],
  handler: async (ctx, input): Promise<SignPlaybookRuleRecord> => {
    const userId = assertPlaybookAdmin(ctx);
    await acquirePlaybookRuleOrgLock(ctx.trx, ctx.orgId);
    await ensurePlaybookRulesMaterialized(ctx, userId);

    const title = cleanSingleLine(input.title, 200);
    const guidance = cleanMultiLine(neutralizeEmbeddedTags(input.guidance), 4000);
    if (!title || !guidance) {
      throw new DomainError('SIGN_PLAYBOOK_RULE_INVALID', 422, 'Playbook rule title and guidance are required');
    }
    if (Array.from(guidance).length > 2000) {
      throw new DomainError(
        'SIGN_PLAYBOOK_RULE_INVALID',
        422,
        'Playbook rule guidance exceeds maximum length of 2000 characters',
      );
    }
    const matchKeywords = sanitizeMatchKeywords(input.matchKeywords);

    if (input.ruleId) {
      const existing = await ctx.trx
        .selectFrom('ludy_sign.playbook_rule')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.ruleId)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) {
        throw new DomainError('SIGN_PLAYBOOK_RULE_NOT_FOUND', 404, 'Playbook rule not found');
      }

      const updated = await ctx.trx
        .updateTable('ludy_sign.playbook_rule')
        .set({
          title,
          guidance,
          severity: input.severity,
          match_keywords: matchKeywords,
          active: input.active,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirst();
      if (!updated) {
        throw new DomainError('INTERNAL', 500, 'Failed to update playbook rule');
      }

      ctx.audit({
        action: 'sign.playbook.rule_upsert',
        ruleId: updated.id,
        severity: updated.severity,
        active: updated.active,
        created: false,
      });
      return toRuleRecord(ctx.orgId, updated);
    }

    const currentRows = await ctx.trx
      .selectFrom('ludy_sign.playbook_rule')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .limit(SIGN_MAX_PLAYBOOK_RULES + 1)
      .execute();
    if (currentRows.length >= SIGN_MAX_PLAYBOOK_RULES) {
      throw new DomainError(
        'SIGN_PLAYBOOK_RULE_LIMIT',
        409,
        `Maximum of ${SIGN_MAX_PLAYBOOK_RULES} playbook rules per workspace`,
      );
    }

    const inserted = await ctx.trx
      .insertInto('ludy_sign.playbook_rule')
      .values({
        org_id: ctx.orgId,
        id: randomUUID(),
        title,
        guidance,
        severity: input.severity,
        match_keywords: matchKeywords,
        active: input.active,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returningAll()
      .executeTakeFirst();
    if (!inserted) {
      throw new DomainError('INTERNAL', 500, 'Failed to create playbook rule');
    }

    ctx.audit({
      action: 'sign.playbook.rule_upsert',
      ruleId: inserted.id,
      severity: inserted.severity,
      active: inserted.active,
      created: true,
    });
    return toRuleRecord(ctx.orgId, inserted);
  },
});

export const playbookRuleDelete = defineCommand({
  name: 'sign.playbook.rule_delete',
  input: zSignPlaybookRuleDeleteInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: PLAYBOOK_ADMINS,
  target: ruleDeleteTarget,
  writes: [PLAYBOOK_RULE_WRITE],
  handler: async (ctx, input): Promise<SignPlaybookRuleDeleteResult> => {
    const userId = assertPlaybookAdmin(ctx);
    await acquirePlaybookRuleOrgLock(ctx.trx, ctx.orgId);
    await ensurePlaybookRulesMaterialized(ctx, userId);

    const deleted = await ctx.trx
      .deleteFrom('ludy_sign.playbook_rule')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.ruleId)
      .returning('id')
      .executeTakeFirst();

    ctx.audit({
      action: 'sign.playbook.rule_delete',
      ruleId: input.ruleId,
      deleted: Boolean(deleted),
    });

    return {
      deleted: Boolean(deleted),
    };
  },
});

export const playbookSeedDefaults = defineCommand({
  name: 'sign.playbook.seed_defaults',
  input: zSignPlaybookSeedDefaultsInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: PLAYBOOK_ADMINS,
  writes: [PLAYBOOK_RULE_WRITE],
  handler: async (ctx): Promise<SignPlaybookRulesListResult> => {
    const userId = assertPlaybookAdmin(ctx);
    await acquirePlaybookRuleOrgLock(ctx.trx, ctx.orgId);
    const existingRows = await ctx.trx
      .selectFrom('ludy_sign.playbook_rule')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .limit(SIGN_MAX_PLAYBOOK_RULES + 5)
      .execute();

    const existingIds = new Set(existingRows.map((r) => r.id));
    const missingSpecs = DEFAULT_VIETNAM_SME_PLAYBOOK_RULES.filter(
      (spec) => !existingIds.has(deterministicPlaybookRuleId(ctx.orgId, spec.slot)),
    );
    if (existingRows.length + missingSpecs.length > SIGN_MAX_PLAYBOOK_RULES) {
      throw new DomainError(
        'SIGN_PLAYBOOK_RULE_LIMIT',
        409,
        `Maximum of ${SIGN_MAX_PLAYBOOK_RULES} playbook rules per workspace`,
      );
    }

    const baseTimeMs = ctx.now.getTime();
    for (const [index, spec] of DEFAULT_VIETNAM_SME_PLAYBOOK_RULES.entries()) {
      const ruleId = deterministicPlaybookRuleId(ctx.orgId, spec.slot);
      const ts = new Date(baseTimeMs + index);
      await ctx.trx
        .insertInto('ludy_sign.playbook_rule')
        .values({
          org_id: ctx.orgId,
          id: ruleId,
          title: spec.title,
          guidance: spec.guidance,
          severity: spec.severity,
          match_keywords: [...spec.matchKeywords],
          active: true,
          created_by: userId,
          created_at: ts,
          updated_at: ts,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'id']).doUpdateSet({
            active: true,
            updated_at: ts,
          }),
        )
        .execute();
    }

    const refreshed = await listEffectivePlaybookRulesOnTrx(ctx.trx, ctx.orgId);
    ctx.audit({
      action: 'sign.playbook.seed_defaults',
      restoredDefaultCount: missingSpecs.length,
      totalRules: refreshed.items.length,
    });

    return {
      items: refreshed.items,
      canManage: true,
      isSeeded: true,
    };
  },
});

export const playbookRecordCheck = defineCommand({
  name: 'sign.playbook.record_check',
  input: zPlaybookRecordCheckInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: checkTarget,
  writes: [PLAYBOOK_CHECK_RECORD_WRITE],
  handler: async (ctx, input): Promise<SignEnvelopePlaybookCheckRecord> => {
    const actorUserId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    if (ctx.actor.type !== 'user' && ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Only workspace members or system workers can record playbook checks');
    }

    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'source_kind', 'source_id', 'created_by', 'source_sha256', 'page_count'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');

    if (env.source_sha256 !== input.sourceSha256) {
      throw new DomainError('SIGN_PLAYBOOK_STALE_SOURCE', 409, 'Envelope PDF changed during playbook evaluation');
    }
    const pageCount = Math.max(1, env.page_count ?? 1);

    const effectiveRules = await listEffectivePlaybookRulesOnTrx(ctx.trx, ctx.orgId);
    const activeRules: SignPlaybookSourceRule[] = effectiveRules.items
      .filter((r) => r.active)
      .slice(0, SIGN_MAX_PLAYBOOK_RULES)
      .map((r) => ({
        id: r.id,
        title: r.title,
        guidance: r.guidance,
        severity: r.severity,
        matchKeywords: r.matchKeywords,
        active: r.active,
        isDefault: r.isDefault,
        revision: computePlaybookRuleRevision(r),
      }));

    const activeRevisionById = new Map(activeRules.map((r) => [r.id, r.revision]));

    if (input.evaluatedRules) {
      const seenRuleIds = new Set<string>();
      let matchesCurrent = input.evaluatedRules.length === activeRules.length;
      if (matchesCurrent) {
        for (const ref of input.evaluatedRules) {
          if (seenRuleIds.has(ref.ruleId) || activeRevisionById.get(ref.ruleId) !== ref.revision) {
            matchesCurrent = false;
            break;
          }
          seenRuleIds.add(ref.ruleId);
        }
      }
      if (!matchesCurrent) {
        throw new DomainError('SIGN_PLAYBOOK_STALE_RULES', 409, 'Playbook rules changed during evaluation');
      }
    }

    const lockedExisting = await ctx.trx
      .selectFrom('ludy_sign.playbook_check')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .forUpdate()
      .executeTakeFirst();

    if (input.preserveExistingFresh && lockedExisting) {
      const existingRecord = toPlaybookCheckRecord(lockedExisting, env.source_sha256, effectiveRules.items);
      if (!existingRecord.isStale && (existingRecord.mode === 'manual' || existingRecord.mode === 'ai')) {
        ctx.audit({
          action: 'sign.playbook.record_check',
          envelopeId: env.id,
          mode: existingRecord.mode,
          preservedExisting: true,
          findingCount: existingRecord.findings.length,
          aiFindingCount: existingRecord.findings.filter((f) => f.proposedByAi).length,
        });
        return existingRecord;
      }
    }

    const deterministicByRuleId = new Map<string, SignPlaybookFindingContract>();
    for (const det of evaluatePlaybookDeterministically(ctx.orgId, activeRules, input.extractedPages, pageCount)) {
      deterministicByRuleId.set(det.ruleId, det);
    }

    const pageNormMap = new Map<number, string>();
    for (const p of input.extractedPages) {
      if (p.page >= 1 && p.page <= pageCount) {
        pageNormMap.set(p.page, normalizeSearchText(p.text));
      }
    }

    const aiByRuleId = new Map<string, SignPlaybookFindingContract>();
    if (input.mode === 'ai' && input.aiFindings) {
      const ruleById = new Map(activeRules.map((r) => [r.id, r]));
      for (const aiItem of input.aiFindings) {
        const rule = ruleById.get(aiItem.ruleId);
        if (!rule || aiByRuleId.has(rule.id)) continue;
        const rationale = neutralizeEmbeddedTags(cleanSingleLine(aiItem.rationale, 600));
        if (!rationale) continue;

        let verifiedPage: number | null = null;
        let verifiedQuote: string | null = null;
        if (aiItem.quoteExcerpt && aiItem.quoteExcerpt.trim().length > 0) {
          const resolved = verifyQuoteOnExtractedPages(
            aiItem.pageNumber,
            aiItem.quoteExcerpt,
            pageCount,
            pageNormMap,
          );
          if (resolved === null) continue;
          verifiedPage = resolved;
          verifiedQuote = cleanMultiLine(aiItem.quoteExcerpt, 600);
        } else if (aiItem.verdict === 'pass' || aiItem.pageNumber !== null) {
          continue;
        }

        const suggestedRedline =
          aiItem.verdict !== 'pass' && aiItem.suggestedRedline && aiItem.suggestedRedline.trim().length > 0
            ? neutralizeEmbeddedTags(cleanMultiLine(aiItem.suggestedRedline, 1200))
            : null;

        aiByRuleId.set(rule.id, {
          ruleId: rule.id,
          ruleTitle: rule.title,
          severity: rule.severity,
          verdict: aiItem.verdict,
          rationale,
          pageNumber: verifiedPage,
          quoteExcerpt: verifiedQuote,
          suggestedRedline,
          proposedByAi: true,
          manualNote: null,
          overriddenBy: null,
          overriddenAt: null,
        });
      }
    }

    const mergedFindingsWithRevisions: StoredFindingWithRevision[] = [];
    for (const rule of activeRules) {
      const fromAi = aiByRuleId.get(rule.id);
      const fromDet = deterministicByRuleId.get(rule.id);
      const chosen = fromAi ?? fromDet;
      if (chosen) {
        mergedFindingsWithRevisions.push({
          finding: chosen,
          ruleRevision: rule.revision,
        });
      }
    }

    const hasAiFinding = mergedFindingsWithRevisions.some((item) => item.finding.proposedByAi);
    const effectiveMode: SignPlaybookMode =
      input.mode === 'ai' && hasAiFinding ? 'ai' : input.mode === 'manual' ? 'manual' : 'deterministic';
    const effectivePromptVersion = effectiveMode === 'ai' ? input.promptVersion : null;
    const serializedFindings = serializeStoredFindings(mergedFindingsWithRevisions);
    const nextCheckId = randomUUID();

    let saved = lockedExisting
      ? await ctx.trx
          .updateTable('ludy_sign.playbook_check')
          .set({
            id: nextCheckId,
            source_sha256: env.source_sha256,
            mode: effectiveMode,
            findings_json: serializedFindings,
            prompt_version: effectivePromptVersion,
            created_by: actorUserId,
            updated_at: ctx.now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', lockedExisting.id)
          .returningAll()
          .executeTakeFirst()
      : await ctx.trx
          .insertInto('ludy_sign.playbook_check')
          .values({
            org_id: ctx.orgId,
            id: nextCheckId,
            envelope_id: env.id,
            source_sha256: env.source_sha256,
            mode: effectiveMode,
            findings_json: serializedFindings,
            prompt_version: effectivePromptVersion,
            created_by: actorUserId,
            created_at: ctx.now,
            updated_at: ctx.now,
          })
          .onConflict((oc) => oc.columns(['org_id', 'envelope_id']).doNothing())
          .returningAll()
          .executeTakeFirst();

    // Handle concurrent first-insert race on (org_id, envelope_id).
    if (!saved) {
      const racedRow = await ctx.trx
        .selectFrom('ludy_sign.playbook_check')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', env.id)
        .forUpdate()
        .executeTakeFirst();
      if (!racedRow) {
        throw new DomainError('INTERNAL', 500, 'Failed to save playbook check');
      }
      if (input.preserveExistingFresh) {
        const racedRecord = toPlaybookCheckRecord(racedRow, env.source_sha256, effectiveRules.items);
        if (!racedRecord.isStale && (racedRecord.mode === 'manual' || racedRecord.mode === 'ai')) {
          ctx.audit({
            action: 'sign.playbook.record_check',
            envelopeId: env.id,
            mode: racedRecord.mode,
            preservedExisting: true,
            findingCount: racedRecord.findings.length,
            aiFindingCount: racedRecord.findings.filter((f) => f.proposedByAi).length,
          });
          return racedRecord;
        }
      }
      saved = await ctx.trx
        .updateTable('ludy_sign.playbook_check')
        .set({
          id: nextCheckId,
          source_sha256: env.source_sha256,
          mode: effectiveMode,
          findings_json: serializedFindings,
          prompt_version: effectivePromptVersion,
          created_by: actorUserId,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', racedRow.id)
        .returningAll()
        .executeTakeFirst();
    }

    if (!saved) {
      throw new DomainError('INTERNAL', 500, 'Failed to save playbook check');
    }

    ctx.audit({
      action: 'sign.playbook.record_check',
      envelopeId: env.id,
      mode: effectiveMode,
      findingCount: mergedFindingsWithRevisions.length,
      aiFindingCount: mergedFindingsWithRevisions.filter((item) => item.finding.proposedByAi).length,
    });

    return toPlaybookCheckRecord(saved, env.source_sha256, effectiveRules.items);
  },
});

export const playbookOverrideFinding = defineCommand({
  name: 'sign.playbook.override_finding',
  input: zSignPlaybookOverrideFindingInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: checkTarget,
  writes: [PLAYBOOK_CHECK_OVERRIDE_WRITE],
  handler: async (ctx, input): Promise<SignEnvelopePlaybookCheckRecord> => {
    const userId = assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'source_kind', 'source_id', 'created_by', 'source_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');

    const [existing, effectiveRules] = await Promise.all([
      ctx.trx
        .selectFrom('ludy_sign.playbook_check')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', env.id)
        .forUpdate()
        .executeTakeFirst(),
      listEffectivePlaybookRulesOnTrx(ctx.trx, ctx.orgId),
    ]);
    if (!existing) {
      throw new DomainError('SIGN_PLAYBOOK_CHECK_NOT_FOUND', 404, 'Playbook check not found for this envelope');
    }

    const existingRecord = toPlaybookCheckRecord(existing, env.source_sha256, effectiveRules.items);
    if (input.checkRevision !== existingRecord.revision) {
      throw new DomainError(
        'SIGN_PLAYBOOK_STALE_CHECK',
        409,
        'Playbook check changed since you opened it. Refresh and try again.',
      );
    }

    const storedItems = parseStoredFindingsInternal(existing.findings_json);
    const targetIdx = storedItems.findIndex((item) => item.finding.ruleId === input.ruleId);
    if (targetIdx < 0) {
      throw new DomainError('SIGN_PLAYBOOK_FINDING_NOT_FOUND', 404, 'Playbook rule finding not found');
    }

    const cleanedNote =
      typeof input.manualNote === 'string' && input.manualNote.trim().length > 0
        ? neutralizeEmbeddedTags(cleanMultiLine(input.manualNote, 500))
        : null;
    const nowIso = ctx.now.toISOString();

    const nextItems: StoredFindingWithRevision[] = storedItems.map((item, idx) =>
      idx === targetIdx
        ? {
            ...item,
            finding: {
              ...item.finding,
              verdict: input.verdict,
              // Preserve AI attribution on retained rationale and redline text;
              // overriddenBy and overriddenAt track human authorship of the verdict.
              manualNote: cleanedNote,
              overriddenBy: userId,
              overriddenAt: nowIso,
            },
          }
        : item,
    );

    const updated = await ctx.trx
      .updateTable('ludy_sign.playbook_check')
      .set({
        mode: 'manual',
        findings_json: serializeStoredFindings(nextItems),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      throw new DomainError('INTERNAL', 500, 'Failed to update playbook finding override');
    }

    ctx.audit({
      action: 'sign.playbook.override_finding',
      envelopeId: env.id,
      ruleId: input.ruleId,
      verdict: input.verdict,
      hasNote: cleanedNote !== null,
    });

    return toPlaybookCheckRecord(updated, env.source_sha256, effectiveRules.items);
  },
});

export const signPlaybookCommands = [
  playbookRuleUpsert,
  playbookRuleDelete,
  playbookSeedDefaults,
  playbookRecordCheck,
  playbookOverrideFinding,
];

export const signPlaybookQueries = [
  playbookRulesList,
  playbookGet,
  playbookSource,
];

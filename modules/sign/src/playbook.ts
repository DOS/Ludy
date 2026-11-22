// SPDX-License-Identifier: AGPL-3.0-only
// SME contract playbook checklist, deterministic clause evaluator, and human verdict overrides (Slice 5d, #4442).
// Every state change runs through Runtime.execute() with zero noIdempotency commands.
// AI findings are tainted proposals verified against extracted PDF pages; core checklist review works identically with AI off.
import { createHash, randomUUID } from 'node:crypto';
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
  'crove_sign',
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
  'crove_sign',
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
  'crove_sign',
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
  activeRules: SignPlaybookRuleEffective[];
}

function stripFormatControl(value: string): string {
  return value.replace(FORMAT_CONTROL_RE, '');
}

function cleanSingleLine(value: string, max: number): string {
  const one = stripFormatControl(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(one);
  return points.length <= max ? one : points.slice(0, max).join('').trimEnd();
}

function cleanMultiLine(value: string, max: number): string {
  const cleaned = stripFormatControl(value).replace(/\r\n/g, '\n').trim();
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

function sanitizeMatchKeywords(raw: readonly string[]): string[] {
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

async function listEffectivePlaybookRulesOnTrx(
  trx: QueryContext['trx'],
  orgId: string,
): Promise<{ items: SignPlaybookRuleRecord[]; isSeeded: boolean }> {
  const rows = await trx
    .selectFrom('crove_sign.playbook_rule')
    .selectAll()
    .where('org_id', '=', orgId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(SIGN_MAX_PLAYBOOK_RULES + 5)
    .execute();

  if (rows.length === 0) {
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
    .selectFrom('crove_sign.playbook_rule')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .limit(1)
    .executeTakeFirst();
  if (existing) {
    return;
  }

  const baseTimeMs = ctx.now.getTime();
  for (const [index, spec] of DEFAULT_VIETNAM_SME_PLAYBOOK_RULES.entries()) {
    const createdAt = new Date(baseTimeMs + index);
    await ctx.trx
      .insertInto('crove_sign.playbook_rule')
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

interface PageClauseSnippet {
  page: number;
  raw: string;
  norm: string;
}

function splitPagesIntoSnippets(
  pages: readonly SignPlaybookExtractedPage[],
  pageCount: number,
): PageClauseSnippet[] {
  const snippets: PageClauseSnippet[] = [];
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
        });
      } else {
        const sentences = trimmed.split(/(?<=[.;!?])\s+/u);
        let acc = '';
        for (const sent of sentences) {
          const next = acc ? `${acc} ${sent}` : sent;
          if (next.length > 480 && acc) {
            snippets.push({ page: p.page, raw: acc, norm: normalizeSearchText(acc) });
            acc = sent.slice(0, 480);
          } else {
            acc = next.slice(0, 480);
          }
        }
        if (acc) {
          snippets.push({ page: p.page, raw: acc, norm: normalizeSearchText(acc) });
        }
      }
    }
  }
  return snippets;
}

function findBestSnippet(
  snippets: readonly PageClauseSnippet[],
  keywords: readonly string[],
): PageClauseSnippet | null {
  const normKeywords = keywords.map((k) => normalizeSearchText(k)).filter((k) => k.length > 0);
  if (normKeywords.length === 0) return null;
  let best: PageClauseSnippet | null = null;
  let bestScore = 0;
  for (const snippet of snippets) {
    let score = 0;
    for (const kw of normKeywords) {
      if (snippet.norm.includes(kw)) {
        score += kw.length >= 8 ? 3 : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = snippet;
    }
  }
  return best;
}

function inferRuleSlot(
  orgId: string,
  rule: Pick<SignPlaybookRuleEffective, 'id' | 'title' | 'guidance' | 'matchKeywords'>,
): DefaultPlaybookRuleSlot | null {
  const byId = defaultSlotForRuleId(orgId, rule.id);
  if (byId) return byId;
  const hay = normalizeSearchText(`${rule.title} ${rule.guidance} ${rule.matchKeywords.join(' ')}`);
  if (hay.includes('điều 301') || hay.includes('phạt vi phạm') || hay.includes('penalty cap') || hay.includes('liquidated damages')) {
    return 'penalty_cap';
  }
  if (hay.includes('thời hạn thanh toán') || hay.includes('payment terms')) {
    return 'payment_terms';
  }
  if (hay.includes('đơn phương chấm dứt') || hay.includes('termination notice')) {
    return 'termination_notice';
  }
  if (hay.includes('tự động gia hạn') || hay.includes('gia hạn tự động') || hay.includes('auto-renew') || hay.includes('automatic renewal')) {
    return 'auto_renewal_notice';
  }
  if (hay.includes('giải quyết tranh chấp') || hay.includes('dispute venue') || hay.includes('viac') || hay.includes('governing law')) {
    return 'dispute_venue';
  }
  if (hay.includes('nghiệm thu') || hay.includes('acceptance criteria') || hay.includes('biên bản nghiệm thu')) {
    return 'acceptance_criteria';
  }
  return null;
}

function extractPercentValues(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s*%/gu)) {
    const num = Number((m[1] ?? '').replace(',', '.'));
    if (Number.isFinite(num) && num >= 0 && num <= 100) {
      out.push(num);
    }
  }
  return out;
}

function extractDayValues(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b(\d{1,3})\s*(?:ngày(?:\s+làm\s+việc)?|(?:calendar\s+|working\s+|business\s+)?days?)\b/giu)) {
    const num = Number(m[1] ?? '');
    if (Number.isInteger(num) && num >= 0 && num <= 365) {
      out.push(num);
    }
  }
  for (const m of text.matchAll(/\bnet\s*(\d{1,3})\b/giu)) {
    const num = Number(m[1] ?? '');
    if (Number.isInteger(num) && num >= 0 && num <= 365) {
      out.push(num);
    }
  }
  return out;
}

function extractCapPercentFromGuidance(guidance: string, fallback: number): number {
  const percents = extractPercentValues(guidance);
  return percents.length > 0 ? Math.max(...percents) : fallback;
}

function extractMaxDaysFromGuidance(guidance: string, fallback: number): number {
  const days = extractDayValues(guidance);
  return days.length > 0 ? Math.max(...days) : fallback;
}

function evaluateSingleRuleDeterministically(
  orgId: string,
  rule: SignPlaybookRuleEffective,
  snippets: readonly PageClauseSnippet[],
): SignPlaybookFindingContract {
  const slot = inferRuleSlot(orgId, rule);
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
    const capPercent = extractCapPercentFromGuidance(rule.guidance, 8);
    const keywords = [
      ...new Set([
        ...rule.matchKeywords,
        'phạt vi phạm',
        'mức phạt',
        'tiền phạt',
        'khoản phạt',
        'penalty',
        'liquidated damages',
      ]),
    ];
    const match = findBestSnippet(snippets, keywords);
    const redline = `Mức phạt vi phạm hợp đồng tối đa không vượt quá ${capPercent}% giá trị phần nghĩa vụ hợp đồng bị vi phạm theo Điều 301 Luật Thương mại 2005.`;
    if (!match) {
      return {
        ...base,
        verdict: 'unknown',
        rationale: 'Không tìm thấy điều khoản phạt vi phạm hợp đồng trong văn bản trích xuất.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }
    const percents = extractPercentValues(match.raw);
    const highest = percents.length > 0 ? Math.max(...percents) : null;
    if (highest !== null && highest > capPercent) {
      return {
        ...base,
        verdict: 'fail',
        rationale: `Điều khoản phạt ghi nhận mức ${highest}%, vượt trần ${capPercent}% theo quy tắc SME (Điều 301 Luật Thương mại 2005).`,
        pageNumber: match.page,
        quoteExcerpt: cleanMultiLine(match.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (highest !== null && highest <= capPercent) {
      return {
        ...base,
        verdict: 'pass',
        rationale: `Mức phạt vi phạm (${highest}%) nằm trong giới hạn <= ${capPercent}%.`,
        pageNumber: match.page,
        quoteExcerpt: cleanMultiLine(match.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: `Có điều khoản phạt vi phạm nhưng chưa nêu rõ trần phần trăm <= ${capPercent}%.`,
      pageNumber: match.page,
      quoteExcerpt: cleanMultiLine(match.raw, 600),
      suggestedRedline: redline,
    };
  }

  if (slot === 'payment_terms') {
    const maxDays = extractMaxDaysFromGuidance(rule.guidance, 30);
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
    const match = findBestSnippet(snippets, keywords);
    const redline = `Bên mua thanh toán đầy đủ trong vòng ${maxDays} ngày kể từ ngày nghiệm thu và nhận đủ hồ sơ thanh toán, hóa đơn hợp lệ.`;
    if (!match) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Chưa tìm thấy điều khoản quy định thời hạn thanh toán cụ thể trong văn bản.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }
    const days = extractDayValues(match.raw);
    const longest = days.length > 0 ? Math.max(...days) : null;
    if (longest !== null && longest > maxDays) {
      return {
        ...base,
        verdict: rule.severity === 'critical' ? 'fail' : 'warn',
        rationale: `Thời hạn thanh toán (${longest} ngày) vượt ngưỡng tiêu chuẩn ${maxDays} ngày của doanh nghiệp.`,
        pageNumber: match.page,
        quoteExcerpt: cleanMultiLine(match.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (longest !== null && longest >= 1 && longest <= maxDays) {
      return {
        ...base,
        verdict: 'pass',
        rationale: `Thời hạn thanh toán (${longest} ngày) đáp ứng ngưỡng <= ${maxDays} ngày.`,
        pageNumber: match.page,
        quoteExcerpt: cleanMultiLine(match.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: `Có điều khoản thanh toán nhưng chưa nêu rõ số ngày tối đa (<= ${maxDays} ngày).`,
      pageNumber: match.page,
      quoteExcerpt: cleanMultiLine(match.raw, 600),
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
    const match = findBestSnippet(snippets, keywords);
    const redline =
      'Mỗi bên có quyền đơn phương chấm dứt hợp đồng khi bên kia vi phạm nghĩa vụ cơ bản không khắc phục hoặc khi gửi thông báo bằng văn bản trước ít nhất 30 ngày.';
    if (!match) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Không tìm thấy điều khoản quy định thời hạn báo trước khi đơn phương chấm dứt hợp đồng.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }
    const immediateNoNotice =
      /không\s+cần\s+(?:thông\s+báo|báo)\s+trước|chấm\s+dứt\s+ngay\s+lập\s+tức\s+mà\s+không|without\s+(?:prior\s+)?(?:written\s+)?notice|immediately\s+at\s+(?:its\s+)?sole\s+discretion|terminate\s+at\s+any\s+time\s+without\s+notice/iu.test(
        match.raw,
      );
    if (immediateNoNotice) {
      return {
        ...base,
        verdict: 'fail',
        rationale: 'Điều khoản cho phép đơn phương chấm dứt ngay lập tức không cần thông báo trước, gây rủi ro mất cân bằng.',
        pageNumber: match.page,
        quoteExcerpt: cleanMultiLine(match.raw, 600),
        suggestedRedline: redline,
      };
    }
    const hasNoticePhrase = /báo\s+trước|thông\s+báo\s+trước|thông\s+báo\s+bằng\s+văn\s+bản\s+trước|prior\s+(?:written\s+)?notice|days['’]?\s+(?:prior\s+)?notice/iu.test(
      match.raw,
    );
    const days = extractDayValues(match.raw);
    const maxNotice = days.length > 0 ? Math.max(...days) : null;
    if (hasNoticePhrase && maxNotice !== null && maxNotice >= 15) {
      return {
        ...base,
        verdict: 'pass',
        rationale: `Điều khoản chấm dứt có thời hạn báo trước ${maxNotice} ngày.`,
        pageNumber: match.page,
        quoteExcerpt: cleanMultiLine(match.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: 'Cần kiểm tra thời hạn báo trước tối thiểu (15 đến 30 ngày) và sự cân bằng quyền chấm dứt giữa hai bên.',
      pageNumber: match.page,
      quoteExcerpt: cleanMultiLine(match.raw, 600),
      suggestedRedline: redline,
    };
  }

  if (slot === 'auto_renewal_notice') {
    const autoKeywords = [
      'tự động gia hạn',
      'gia hạn tự động',
      'auto-renew',
      'auto renew',
      'automatic renewal',
      'automatically renew',
      'automatically extended',
    ];
    const autoMatch = findBestSnippet(snippets, autoKeywords);
    const redline =
      'Hợp đồng chỉ được gia hạn khi hai bên ký phụ lục gia hạn bằng văn bản, hoặc mỗi bên có quyền từ chối gia hạn tự động bằng thông báo văn bản trước ít nhất 30 ngày trước ngày hết hạn.';
    if (!autoMatch) {
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
    const days = extractDayValues(autoMatch.raw);
    const noticeDays = days.length > 0 ? Math.max(...days) : null;
    const hasOptOut =
      /không\s+gia\s+hạn|từ\s+chối\s+gia\s+hạn|chấm\s+dứt\s+gia\s+hạn|báo\s+trước|thông\s+báo\s+trước|non-renewal|not\s+to\s+renew|opt[\s-]out|prior\s+(?:written\s+)?notice/iu.test(
        autoMatch.raw,
      );
    if (hasOptOut && noticeDays !== null && noticeDays >= 15) {
      return {
        ...base,
        verdict: 'pass',
        rationale: `Hợp đồng có tự động gia hạn kèm thời hạn thông báo từ chối trước (${noticeDays} ngày).`,
        pageNumber: autoMatch.page,
        quoteExcerpt: cleanMultiLine(autoMatch.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: 'Điều khoản tự động gia hạn chưa nêu rõ thời hạn báo trước tối thiểu để từ chối gia hạn.',
      pageNumber: autoMatch.page,
      quoteExcerpt: cleanMultiLine(autoMatch.raw, 600),
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
    const match = findBestSnippet(snippets, keywords);
    const redline =
      'Hợp đồng này được điều chỉnh theo pháp luật Việt Nam. Mọi tranh chấp phát sinh không tự thương lượng được sẽ giải quyết tại Tòa án nhân dân có thẩm quyền tại Việt Nam hoặc Trung tâm Trọng tài Quốc tế Việt Nam (VIAC).';
    if (!match) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Chưa tìm thấy điều khoản luật áp dụng và cơ quan giải quyết tranh chấp.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }
    const foreignVenue =
      /\b(?:singapore|siac|hong\s+kong|hkiac|london|lcia|new\s+york|delaware|california|england\s+and\s+wales|swiss\s+law|icc\s+paris|tokyo)\b/iu.test(
        match.raw,
      );
    const vietnamVenue =
      /việt\s*nam|viet\s*nam|vietnam|\bviac\b|tòa\s+án\s+nhân\s+dân|hà\s+nội|hồ\s+chí\s+minh|tp\.?\s*hcm|đà\s+nẵng/iu.test(
        match.raw,
      );
    if (foreignVenue && !vietnamVenue) {
      return {
        ...base,
        verdict: rule.severity === 'critical' ? 'fail' : 'warn',
        rationale: 'Điều khoản tranh chấp tham chiếu tài phán hoặc trọng tài nước ngoài, có thể phát sinh chi phí pháp lý cao.',
        pageNumber: match.page,
        quoteExcerpt: cleanMultiLine(match.raw, 600),
        suggestedRedline: redline,
      };
    }
    if (vietnamVenue) {
      return {
        ...base,
        verdict: 'pass',
        rationale: 'Điều khoản dẫn chiếu pháp luật hoặc cơ quan giải quyết tranh chấp tại Việt Nam.',
        pageNumber: match.page,
        quoteExcerpt: cleanMultiLine(match.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: 'Có điều khoản tranh chấp nhưng chưa xác định rõ cơ quan tài phán tại Việt Nam.',
      pageNumber: match.page,
      quoteExcerpt: cleanMultiLine(match.raw, 600),
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
    const match = findBestSnippet(snippets, keywords);
    const redline =
      'Bên mua kiểm tra kết quả bàn giao và ký biên bản nghiệm thu hoặc phản hồi bằng văn bản nêu rõ nội dung cần hiệu chỉnh trong vòng 05 ngày làm việc kể từ ngày nhận bàn giao.';
    if (!match) {
      return {
        ...base,
        verdict: 'warn',
        rationale: 'Chưa tìm thấy điều khoản quy định tiêu chí và thời hạn nghiệm thu bàn giao.',
        pageNumber: null,
        quoteExcerpt: null,
        suggestedRedline: redline,
      };
    }
    const days = extractDayValues(match.raw);
    const hasProtocol =
      /biên\s+bản\s+nghiệm\s+thu|acceptance\s+certificate|written\s+acceptance|ký\s+nghiệm\s+thu/iu.test(match.raw);
    if (days.length > 0 || hasProtocol) {
      return {
        ...base,
        verdict: 'pass',
        rationale: 'Hợp đồng có quy định thủ tục hoặc thời hạn nghiệm thu bàn giao.',
        pageNumber: match.page,
        quoteExcerpt: cleanMultiLine(match.raw, 600),
        suggestedRedline: null,
      };
    }
    return {
      ...base,
      verdict: 'warn',
      rationale: 'Có nhắc tới bàn giao/nghiệm thu nhưng chưa nêu rõ số ngày phản hồi hoặc biên bản nghiệm thu.',
      pageNumber: match.page,
      quoteExcerpt: cleanMultiLine(match.raw, 600),
      suggestedRedline: redline,
    };
  }

  // Custom workspace rule: match configured keywords (or title words >= 4 chars when matchKeywords is empty).
  const fallbackWords = rule.title
    .split(/[^\p{L}\p{N}%]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4)
    .slice(0, 6);
  const searchTerms = rule.matchKeywords.length > 0 ? rule.matchKeywords : fallbackWords;
  const customMatch = findBestSnippet(snippets, searchTerms);
  const fallbackRedline = neutralizeEmbeddedTags(cleanMultiLine(rule.guidance, 600));

  if (customMatch) {
    return {
      ...base,
      verdict: rule.severity === 'info' ? 'pass' : 'warn',
      rationale:
        rule.severity === 'info'
          ? `Tìm thấy nội dung liên quan đến quy tắc "${cleanSingleLine(rule.title, 120)}" tại trang ${customMatch.page}.`
          : `Tìm thấy điều khoản khớp từ khóa của quy tắc "${cleanSingleLine(rule.title, 120)}" tại trang ${customMatch.page}; cần đối chiếu thủ công với hướng dẫn.`,
      pageNumber: customMatch.page,
      quoteExcerpt: cleanMultiLine(customMatch.raw, 600),
      suggestedRedline: rule.severity === 'info' ? null : fallbackRedline,
    };
  }

  return {
    ...base,
    verdict: rule.severity === 'info' ? 'unknown' : 'warn',
    rationale: `Không tìm thấy từ khóa khớp với quy tắc "${cleanSingleLine(rule.title, 120)}" trong văn bản trích xuất.`,
    pageNumber: null,
    quoteExcerpt: null,
    suggestedRedline: fallbackRedline,
  };
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

function parseStoredFindings(raw: unknown): SignPlaybookFindingContract[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: SignPlaybookFindingContract[] = [];
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
    out.push({
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
    });
  }
  return out;
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
): SignEnvelopePlaybookCheckRecord {
  return {
    id: row.id,
    envelopeId: row.envelope_id,
    sourceSha256: row.source_sha256,
    isStale: row.source_sha256 !== currentSourceSha256,
    mode: row.mode,
    findings: parseStoredFindings(row.findings_json),
    promptVersion: row.prompt_version,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
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

const zPlaybookRecordCheckInput = z.strictObject({
  envelopeId: zId,
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.enum(SIGN_PLAYBOOK_MODES),
  promptVersion: z.string().min(1).max(64).nullable(),
  aiFindings: z.array(zPlaybookAiFindingInput).max(SIGN_MAX_PLAYBOOK_RULES).optional(),
  extractedPages: z
    .array(z.strictObject({ page: z.number().int().min(1).max(SIGN_MAX_PAGES), text: z.string().max(250_000) }))
    .max(SIGN_MAX_PAGES),
});

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
      .selectFrom('crove_sign.envelope')
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
        .selectFrom('crove_sign.playbook_check')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', '=', env.id)
        .executeTakeFirst(),
      listEffectivePlaybookRulesOnTrx(ctx.trx, ctx.orgId),
    ]);

    const activeRulesCount = effectiveRules.items.filter((r) => r.active).length;

    return {
      check: row ? toPlaybookCheckRecord(row, env.source_sha256) : null,
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
      .selectFrom('crove_sign.envelope')
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

    const activeRules: SignPlaybookRuleEffective[] = effectiveRules.items
      .filter((r) => r.active)
      .map((r) => ({
        id: r.id,
        title: r.title,
        guidance: r.guidance,
        severity: r.severity,
        matchKeywords: r.matchKeywords,
        active: r.active,
        isDefault: r.isDefault,
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

export const playbookRuleUpsert = defineCommand({
  name: 'sign.playbook.rule_upsert',
  input: zSignPlaybookRuleUpsertInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: PLAYBOOK_ADMINS,
  writes: [PLAYBOOK_RULE_WRITE],
  handler: async (ctx, input): Promise<SignPlaybookRuleRecord> => {
    const userId = assertPlaybookAdmin(ctx);
    await ensurePlaybookRulesMaterialized(ctx, userId);

    const title = cleanSingleLine(input.title, 200);
    const guidance = neutralizeEmbeddedTags(cleanMultiLine(input.guidance, 2000));
    if (!title || !guidance) {
      throw new DomainError('SIGN_PLAYBOOK_RULE_INVALID', 422, 'Playbook rule title and guidance are required');
    }
    const matchKeywords = sanitizeMatchKeywords(input.matchKeywords);

    if (input.ruleId) {
      const existing = await ctx.trx
        .selectFrom('crove_sign.playbook_rule')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.ruleId)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) {
        throw new DomainError('SIGN_PLAYBOOK_RULE_NOT_FOUND', 404, 'Playbook rule not found');
      }

      const updated = await ctx.trx
        .updateTable('crove_sign.playbook_rule')
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
      .selectFrom('crove_sign.playbook_rule')
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
      .insertInto('crove_sign.playbook_rule')
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
    await ensurePlaybookRulesMaterialized(ctx, userId);

    const deleted = await ctx.trx
      .deleteFrom('crove_sign.playbook_rule')
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
    const existingRows = await ctx.trx
      .selectFrom('crove_sign.playbook_rule')
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
        .insertInto('crove_sign.playbook_rule')
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
      .selectFrom('crove_sign.envelope')
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
    const activeRules: SignPlaybookRuleEffective[] = effectiveRules.items
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
      }));

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

    const mergedFindings: SignPlaybookFindingContract[] = [];
    for (const rule of activeRules) {
      const fromAi = aiByRuleId.get(rule.id);
      const fromDet = deterministicByRuleId.get(rule.id);
      if (fromAi) {
        mergedFindings.push(fromAi);
      } else if (fromDet) {
        mergedFindings.push(fromDet);
      }
    }

    const hasAiFinding = mergedFindings.some((f) => f.proposedByAi);
    const effectiveMode: SignPlaybookMode =
      input.mode === 'ai' && hasAiFinding ? 'ai' : input.mode === 'manual' ? 'manual' : 'deterministic';
    const effectivePromptVersion = effectiveMode === 'ai' ? input.promptVersion : null;

    const saved = await ctx.trx
      .insertInto('crove_sign.playbook_check')
      .values({
        org_id: ctx.orgId,
        id: randomUUID(),
        envelope_id: env.id,
        source_sha256: env.source_sha256,
        mode: effectiveMode,
        findings_json: JSON.stringify(mergedFindings),
        prompt_version: effectivePromptVersion,
        created_by: actorUserId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'envelope_id']).doUpdateSet({
          source_sha256: env.source_sha256,
          mode: effectiveMode,
          findings_json: JSON.stringify(mergedFindings),
          prompt_version: effectivePromptVersion,
          created_by: actorUserId,
          updated_at: ctx.now,
        }),
      )
      .returningAll()
      .executeTakeFirst();
    if (!saved) {
      throw new DomainError('INTERNAL', 500, 'Failed to save playbook check');
    }

    ctx.audit({
      action: 'sign.playbook.record_check',
      envelopeId: env.id,
      mode: effectiveMode,
      findingCount: mergedFindings.length,
      aiFindingCount: mergedFindings.filter((f) => f.proposedByAi).length,
    });

    return toPlaybookCheckRecord(saved, env.source_sha256);
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
      .selectFrom('crove_sign.envelope')
      .select(['id', 'source_kind', 'source_id', 'created_by', 'source_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');

    const existing = await ctx.trx
      .selectFrom('crove_sign.playbook_check')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      throw new DomainError('SIGN_PLAYBOOK_CHECK_NOT_FOUND', 404, 'Playbook check not found for this envelope');
    }

    const findings = parseStoredFindings(existing.findings_json);
    const targetIdx = findings.findIndex((f) => f.ruleId === input.ruleId);
    if (targetIdx < 0) {
      throw new DomainError('SIGN_PLAYBOOK_FINDING_NOT_FOUND', 404, 'Playbook rule finding not found');
    }

    const cleanedNote =
      typeof input.manualNote === 'string' && input.manualNote.trim().length > 0
        ? neutralizeEmbeddedTags(cleanMultiLine(input.manualNote, 500))
        : null;
    const nowIso = ctx.now.toISOString();

    const nextFindings = findings.map((item, idx) =>
      idx === targetIdx
        ? {
            ...item,
            verdict: input.verdict,
            proposedByAi: false,
            manualNote: cleanedNote,
            overriddenBy: userId,
            overriddenAt: nowIso,
          }
        : item,
    );

    const updated = await ctx.trx
      .updateTable('crove_sign.playbook_check')
      .set({
        mode: 'manual',
        findings_json: JSON.stringify(nextFindings),
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

    return toPlaybookCheckRecord(updated, env.source_sha256);
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

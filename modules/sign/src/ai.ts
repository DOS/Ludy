// SPDX-License-Identifier: AGPL-3.0-only
// eSign AI analysis storage, deterministic persistence guards, and read/write Runtime definitions (#3351):
// runs strictly inside Runtime.execute() / Runtime.query() with zero network calls and writes ONLY crove_sign.ai_analysis.
// Proposed fields remain tainted (proposedByAi: true) and never auto-apply to crove_sign.field, alter signers, or send envelopes.
import {
  SIGN_AI_ANALYSIS_STATUSES,
  SIGN_FIELD_TYPES,
  type MemberRole,
  type SignAiAnalysisStatus,
  type SignFieldType,
} from '@crove/db';
import { tableWrite } from '@crove/kernel-contract';
import {
  defineCommand,
  defineQuery,
  DomainError,
  type CommandContext,
  type QueryContext,
} from '@crove/kernel-runtime';
import { sql } from 'kysely';
import { z } from 'zod';
import { signManifest } from './manifest.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const SIGN_AI_MAX_FIELDS = 40;
const SIGN_AI_MAX_CLAUSES = 12;
const SIGN_AI_MIN_SPAN = 0.001;
const SIGN_AI_SUMMARY_MAX = 20_000;
const SIGN_AI_ERROR_MAX = 1_000;

export const SIGN_AI_SEVERITIES = ['low', 'medium', 'high'] as const;
export type SignAiClauseSeverity = (typeof SIGN_AI_SEVERITIES)[number];

const zId = z.uuid();
const zSha256 = z.string().regex(/^[0-9a-f]{64}$/);
const FIELD_TYPE_SET: ReadonlySet<string> = new Set(SIGN_FIELD_TYPES);
const SEVERITY_SET: ReadonlySet<string> = new Set(SIGN_AI_SEVERITIES);

export interface SignAiProposedField {
  signerId: string;
  signerRoleKey: string;
  fieldType: SignFieldType;
  pageNumber: number;
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
  label: string | null;
  confidence: number | null;
  proposedByAi: true;
}

export interface SignAiRiskClause {
  title: string;
  severity: SignAiClauseSeverity;
  pageNumber: number | null;
  quote: string;
  explanation: string;
}

export interface SignAiAnalysisRecord {
  id: string;
  orgId: string;
  envelopeId: string;
  sourceSha256: string;
  status: SignAiAnalysisStatus;
  proposedFields: SignAiProposedField[];
  riskClauses: SignAiRiskClause[];
  summaryText: string | null;
  errorMessage: string | null;
  promptVersion: string;
  completedAt: string | null;
  createdAt: string;
}

export interface SignAiDeclaredSigner {
  signerId: string;
  roleKey: string;
  roleLabel: string;
  signerRole: 'signer' | 'approver';
  routingOrder: number;
}

export interface SignAiSource {
  envelopeId: string;
  version: number;
  status: string;
  inspectStatus: string;
  sourceSha256: string;
  title: string;
  pageCount: number | null;
  pageDimensions: Array<{ page: number; widthPt: number; heightPt: number; rotation?: number }> | null;
  signers: SignAiDeclaredSigner[];
  aiStopped: boolean;
}

export interface SignAiExtractedPage {
  page: number;
  text: string;
}

export interface SanitizedAiAnalysisInput {
  proposedFields: SignAiProposedField[];
  riskClauses: SignAiRiskClause[];
  summaryText: string | null;
  droppedFields: number;
  droppedClauses: number;
  summaryDropped: boolean;
}

const zIncomingProposedField = z.strictObject({
  signerId: zId.optional(),
  signerRoleKey: z.string().min(1).max(160),
  fieldType: z.string().min(1).max(32),
  pageNumber: z.number(),
  xNorm: z.number(),
  yNorm: z.number(),
  wNorm: z.number(),
  hNorm: z.number(),
  label: z.string().max(200).nullable().optional(),
  confidence: z.number().nullable().optional(),
  proposedByAi: z.boolean().optional(),
});

const zIncomingRiskClause = z.strictObject({
  title: z.string().min(1).max(300),
  severity: z.string().min(1).max(16),
  pageNumber: z.number().nullable().optional(),
  quote: z.string().min(1).max(2000),
  explanation: z.string().min(1).max(2000),
});

const zExtractedPage = z.strictObject({
  page: z.number().int().min(1).max(200),
  text: z.string().max(250_000),
});

const zEnvelopeProposeFieldsInput = z.strictObject({
  envelopeId: zId,
  sourceSha256: zSha256,
  expectedVersion: z.number().int().min(1).optional(),
  status: z.enum(['completed', 'failed']).default('completed'),
  proposedFields: z.array(zIncomingProposedField).max(100).default([]),
  riskClauses: z.array(zIncomingRiskClause).max(50).default([]),
  summaryText: z.string().max(SIGN_AI_SUMMARY_MAX).nullable().default(null),
  errorMessage: z.string().max(SIGN_AI_ERROR_MAX).nullable().default(null),
  promptVersion: z.string().trim().min(1).max(32).default('v1'),
  extractedPages: z.array(zExtractedPage).max(200).optional(),
});

const zAiAnalysisRecordInput = z.strictObject({
  envelopeId: zId,
  sourceSha256: zSha256,
  expectedVersion: z.number().int().min(1).optional(),
  status: z.enum(SIGN_AI_ANALYSIS_STATUSES),
  proposedFields: z.array(zIncomingProposedField).max(100).default([]),
  riskClauses: z.array(zIncomingRiskClause).max(50).default([]),
  summaryText: z.string().max(SIGN_AI_SUMMARY_MAX).nullable().default(null),
  errorMessage: z.string().max(SIGN_AI_ERROR_MAX).nullable().default(null),
  promptVersion: z.string().trim().min(1).max(32).default('v1'),
  extractedPages: z.array(zExtractedPage).max(200).optional(),
});

const target = (input: { envelopeId: string }) => ({ type: 'sign.envelope', id: input.envelopeId });

const AI_ANALYSIS_WRITE = tableWrite(signManifest.tables, 'crove_sign', 'ai_analysis', [
  'org_id',
  'envelope_id',
  'source_sha256',
  'status',
  'proposed_fields_json',
  'risk_clauses_json',
  'summary_text',
  'error_message',
  'prompt_version',
  'completed_at',
]);

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeSlice(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  const points = Array.from(trimmed);
  return points.length <= max ? trimmed : points.slice(0, max).join('');
}

function cleanLine(value: string, max: number): string {
  const one = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return safeSlice(one, max).trimEnd();
}

function normalizePreservingCase(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-');
}

function normalizeBaseText(value: string): string {
  return normalizePreservingCase(value).toLowerCase();
}

function normalizeAddressText(value: string): string {
  return normalizePreservingCase(value).replace(/\s+/g, ' ').trim();
}

function normalizeText(value: string): string {
  return normalizeBaseText(value).replace(/\s*%/g, '%').replace(/\s+/g, ' ').trim();
}

const SCHEME_OR_WEB_RE = /(?:https?:\/\/|mailto:|tel:|www\.)\S+/giu;
const ADDRESS_CHUNK_RE = /[^\s<>()[\]]+/gu;
const DOMAIN_RE =
  /(?<![@.\w\p{L}-])(?:[\p{L}0-9](?:[\p{L}0-9-]{0,61}[\p{L}0-9])?\.)+(?:xn--[a-z0-9]{2,}|[\p{L}]{2,24})(?:[/:?#]\S*)?/giu;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/\S*)?/g;
const OBFUSCATED_ADDR_RE =
  /\(\s*at\s*\)|\[\s*at\s*\]|\[\s*\.\s*\]|\(\s*\.\s*\)|\(\s*dot\s*\)|\[\s*dot\s*\]|\p{L}\s+dot\s+\p{L}|@/giu;
const NUMBER_TOKEN_RE = /(?:(?<![\p{L}\p{N}])[-+\u2212]\s*[.,]?|[.,](?=\p{N}))?\p{N}[\p{N}.,/%-]*/gu;
const PAGE_REF_RE = /\b(?:page|trang)\s+(\d+)(?![\d/%-]|\.(?=\d)|,(?=\d))/gi;
const EN_CARDINAL_NO_ONE =
  '(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const EN_CARDINAL = `(?:one|${EN_CARDINAL_NO_ONE})`;
const EN_SCALE = '(?:hundred|thousand|million|billion|trillion|dozen|half)';
const EN_UNIT_MODIFIER =
  '(?:business|working|work|calendar|banking|trading|market|court|statutory|consecutive|successive|full|complete|whole|entire|prior|advance|notice|additional|extra|remaining|initial|grace|waiting|trial|probation|cooling-off|fiscal|contract|billing)';
const AMBIGUOUS_LOWERCASE_CURRENCIES: ReadonlySet<string> = new Set([
  'all',
  'bam',
  'bob',
  'btn',
  'cop',
  'crc',
  'cup',
  'cve',
  'ern',
  'gel',
  'mad',
  'mop',
  'pen',
  'php',
  'rub',
  'sos',
  'svc',
  'top',
  'try',
  'wst',
]);
const EXTRA_CURRENCY_CODES = [
  'vnđ',
  'vnd',
  'usd',
  'eur',
  'gbp',
  'jpy',
  'krw',
  'sgd',
  'aud',
  'cad',
  'cny',
  'cnh',
  'rmb',
  'hkd',
  'twd',
  'thb',
  'chf',
  'myr',
  'idr',
  'inr',
  'nzd',
  'khr',
  'lak',
  'mmk',
  'bnd',
  'brl',
  'mxn',
  'aed',
  'sar',
  'qar',
  'kwd',
  'sek',
  'nok',
  'dkk',
  'pln',
  'czk',
  'huf',
  'ron',
  'zar',
  'ils',
  'pkr',
  'bdt',
  'lkr',
  'ntd',
  'usdt',
  'usdc',
] as const;
const ALL_ISO_CURRENCIES =
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [];
const CURRENCY_CODE_LIST = [
  ...new Set([...ALL_ISO_CURRENCIES.map((c) => c.toLowerCase()), ...EXTRA_CURRENCY_CODES]),
]
  .filter((c) => !AMBIGUOUS_LOWERCASE_CURRENCIES.has(c))
  .sort((a, b) => b.length - a.length || a.localeCompare(b));
const CURRENCY_CODE_ALT = CURRENCY_CODE_LIST.join('|');
const CURRENCY_CODE_SET: ReadonlySet<string> = new Set(
  CURRENCY_CODE_LIST.map((c) => (c === 'vnđ' ? 'vnd' : c)),
);
const NON_CURRENCY_UPPER_CODES: ReadonlySet<string> = new Set([
  'ALL', 'AND', 'ANY', 'API', 'APP', 'ART', 'AES', 'BOX', 'CEO', 'CFO', 'CIF', 'COL', 'COO',
  'CSV', 'CTO', 'CVE', 'CVV', 'DAY', 'DDP', 'DNS', 'DOC', 'DUE', 'END', 'EXT', 'EXW', 'FAQ',
  'FAX', 'FEE', 'FOB', 'FOR', 'GET', 'GMT', 'GST', 'HAD', 'HAS', 'HER', 'HIS', 'HOW', 'HRS',
  'INC', 'ISO', 'ITS', 'JPG', 'JSC', 'KPI', 'LLC', 'LOT', 'LOW', 'LTD', 'MAX', 'MAY', 'MIN',
  'MOS', 'MST', 'NDA', 'NET', 'NEW', 'NOR', 'NOT', 'NOW', 'NUM', 'OFF', 'OLD', 'ONE', 'OPC',
  'OTP', 'OUR', 'OUT', 'OWN', 'PAR', 'PAY', 'PCS', 'PDF', 'PER', 'PII', 'PIN', 'PKG', 'PNG',
  'PUT', 'QTY', 'QTR', 'RAR', 'REF', 'RFC', 'RLS', 'ROW', 'RSA', 'RUN', 'SEC', 'SEE', 'SET',
  'SHA', 'SIX', 'SKU', 'SLA', 'SME', 'SQL', 'SSL', 'SUB', 'SUM', 'SVG', 'TAX', 'TEL', 'TEN',
  'THE', 'TIN', 'TLS', 'TOP', 'TWO', 'URL', 'USA', 'USE', 'UTC', 'VAT', 'VIA', 'VIP', 'VNM',
  'WAS', 'WAY', 'WHO', 'WHY', 'WKS', 'XML', 'YES', 'YRS', 'ZIP',
]);
const RAW_UPPER_SCALE_SET: ReadonlySet<string> = new Set([
  'hundred', 'thousand', 'million', 'billion', 'trillion',
  'trăm', 'nghìn', 'nghin', 'ngàn', 'ngan', 'triệu', 'trieu', 'tỷ', 'tỉ', 'vạn',
  'mn', 'bn', 'tr', 'k', 'm',
]);
const TAIL_UPPER_CODE_DIRECT_RE = /^[ \t]*[-/]?[ \t]*([A-Z]{3})(?![\p{L}\p{N}])/u;
const TAIL_UPPER_CODE_SCALED_RE = /^[ \t]*[-/]?[ \t]*([\p{L}]{1,12})[ \t]*[-/]?[ \t]*([A-Z]{3})(?![\p{L}\p{N}])/u;
const HEAD_UPPER_CODE_RE = /(?<![\p{L}\p{N}])([A-Z]{3})[ \t]*[-:/]?[ \t]*$/u;
const EN_STANDALONE_UNIT = `(?:percent|dollars?|euros?|pounds?|${CURRENCY_CODE_ALT})`;
const EN_NUMBER_UNIT = `(?:percent|dollars?|euros?|pounds?|${CURRENCY_CODE_ALT}|(?:${EN_UNIT_MODIFIER}[\\s-]+){0,2}(?:days?|weeks?|months?|years?|hours?|minutes?|seconds?|quarters?))`;
const EN_INDEFINITE_ARTICLE = '(?:a|an)';
const EN_INDEFINITE_MODIFIER = `(?:${EN_UNIT_MODIFIER}|single)`;
const EN_INDEFINITE_SECOND =
  'second(?![\\s-]+(?!(?:and|or|of|to|for|with|before|after|in|per)(?![\\p{L}]))[\\p{L}])';
const EN_INDEFINITE_UNIT = `(?:percent|dollar|euro|pound|${CURRENCY_CODE_ALT}|(?:${EN_INDEFINITE_MODIFIER}[\\s-]+){0,2}(?:day|week|month|year|hour|minute|quarter|${EN_INDEFINITE_SECOND}))`;
const VI_SCALE_ALT = 'trăm|nghìn|nghin|ngàn|ngan|triệu|trieu|tỷ|tỉ';
const NUMBER_WORD_RE = new RegExp(
  `(?<![\\p{L}])(?:(?:${EN_CARDINAL}|${EN_SCALE})(?:[\\s-]+(?:and[\\s-]+)?(?:${EN_CARDINAL}|${EN_SCALE}))+(?:[\\s-]+${EN_NUMBER_UNIT})?|${EN_CARDINAL}[\\s-]+${EN_NUMBER_UNIT}|${EN_INDEFINITE_ARTICLE}[\\s-]+(?:${EN_SCALE}(?:[\\s-]+(?:${EN_NUMBER_UNIT}|đồng|đô|đ))?|${EN_INDEFINITE_UNIT})|${EN_CARDINAL_NO_ONE}|${EN_SCALE}(?:[\\s-]+(?:${EN_NUMBER_UNIT}|đồng|đô|đ))?|(?:${VI_SCALE_ALT})(?:[\\s-]+(?:${EN_STANDALONE_UNIT}|đồng|đô|đ|ngày|tuần|tháng|quý|năm|giờ|phút|giây|lần))?|${EN_STANDALONE_UNIT}|nửa|phần\\s+trăm)(?![\\p{L}])`,
  'giu',
);
const VI_DAY_KIND_POST_MODIFIER =
  'làm[ \\t]+việc|lam[ \\t]+viec|công[ \\t]+tác|cong[ \\t]+tac|giao[ \\t]+dịch|giao[ \\t]+dich|dương[ \\t]+lịch|duong[ \\t]+lich|theo[ \\t]+lịch|theo[ \\t]+lich';
const VI_CARDINAL_START_ALT = 'một|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|mười|mấy';
const VI_NUMBER_PART_ALT =
  'một|mốt|hai|ba|bốn|tư|năm|lăm|nhăm|sáu|bảy|tám|chín|mười|mươi|linh|lẻ|mấy|trăm|nghìn|nghin|ngàn|ngan|triệu|trieu|tỷ|tỉ|vạn';
const VI_NUMBER_BEFORE_UNIT_RE = new RegExp(
  `(?<![\\p{L}])(?:${VI_CARDINAL_START_ALT})\\s+(?:(?:${VI_NUMBER_PART_ALT})\\s+){0,7}(?:ngày|tuần|tháng|quý|năm|đồng|đô|đ|giờ|phút|giây|trăm|nghìn|nghin|ngàn|ngan|triệu|trieu|tỷ|tỉ|vạn|lần|phần\\s+trăm|percent|${CURRENCY_CODE_ALT})(?:\\s+rưỡi|(?:\\s+(?:${VI_DAY_KIND_POST_MODIFIER})))?(?![\\p{L}])`,
  'giu',
);
const CURRENCY_SYMBOL_RE = /[$€£₫¥₩]/g;
const PAIR_UNIT_MODIFIER_ALT =
  `${EN_UNIT_MODIFIER}|us|u\\.s\\.|united[ \\t]+states|vietnamese|viet[ \\t]+nam|vn|british|uk|sterling|singapore|australian|canadian|hong[ \\t]+kong|new[ \\t]+zealand`;
const PAIR_SCALE_ALT =
  'hundred|thousand|million|billion|trillion|trăm|nghìn|nghin|ngàn|ngan|triệu|trieu|tỷ|tỉ|vạn|mn|bn|tr|k|m';
const PAIR_UNIT_ALT =
  `days?|weeks?|months?|years?|hours?|minutes?|seconds?|quarters?|times?|percent|dollars?|euros?|pounds?|${CURRENCY_CODE_ALT}|hundred|thousand|million|billion|trillion|ngày|tuần|tháng|quý|năm|giờ|phút|giây|lần|đồng|đô|triệu|trieu|tỷ|tỉ|nghìn|nghin|ngàn|ngan|trăm|vạn|phần[ \\t]+trăm|mn|bn|tr|k|m`;
const BOUNDED_NUM_BODY = '\\p{N}+(?:[.,/]\\p{N}+)*%?';
const PAIR_NUM_SCAN_RE = new RegExp(
  `(?:(?<![\\p{L}\\p{N}])[-+\\u2212][ \\t]*[.,]?|[.,](?=\\p{N}))?${BOUNDED_NUM_BODY}`,
  'gu',
);
const TAIL_UNIT_PAIR_RE = new RegExp(
  `^(?:(?:[ \\t]*[-/][ \\t]*|[ \\t]+)((?:(?:${PAIR_UNIT_MODIFIER_ALT})(?:[ \\t]*-[ \\t]*|[ \\t]+)){0,2})|(?=[\\p{L}]))(?:(${PAIR_SCALE_ALT})(?:[ \\t]*[-/][ \\t]*|[ \\t]+)((?:(?:${PAIR_UNIT_MODIFIER_ALT})(?:[ \\t]*-[ \\t]*|[ \\t]+)){0,2}))?(${PAIR_UNIT_ALT})(?:[ \\t]+(${VI_DAY_KIND_POST_MODIFIER}))?(?![\\p{L}\\p{N}])`,
  'iu',
);
const PREFIX_CURRENCY_CODE_PAIR_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${CURRENCY_CODE_ALT})[ \\t]*[-:/]?[ \\t]*((?:[-+\\u2212][ \\t]*[.,]?|[.,](?=\\p{N}))?${BOUNDED_NUM_BODY})(?:(?:[ \\t]+|(?=[\\p{L}]))(${PAIR_SCALE_ALT})(?![\\p{L}\\p{N}]))?`,
  'giu',
);
const TAIL_CURRENCY_CODE_PAIR_RE = new RegExp(
  `^[ \\t]*[-/]?[ \\t]*(${CURRENCY_CODE_ALT})(?![\\p{L}\\p{N}])`,
  'iu',
);
const LEADING_CURRENCY_PAIR_RE = new RegExp(
  `([$€£₫¥₩])[ \\t]*((?:[-+\\u2212][ \\t]*[.,]?|[.,](?=\\p{N}))?${BOUNDED_NUM_BODY})(?:(?:[ \\t]+|(?=[\\p{L}]))(${PAIR_SCALE_ALT})(?![\\p{L}\\p{N}]))?`,
  'giu',
);
const TAIL_CURRENCY_PAIR_RE = new RegExp(
  `^(?:(?:[ \\t]+|(?=[\\p{L}]))(${PAIR_SCALE_ALT})(?:[ \\t]+|(?=[$€£₫¥₩]|đ(?![\\p{L}\\p{N}])))|[ \\t]*)(?:([$€£₫¥₩])|(đ)(?![\\p{L}\\p{N}]))(?![\\p{N}])`,
  'iu',
);
const GROUPED_COMMA_INT_RE = /^[+-]?(?!0+[.,])\p{N}{1,3}(?:,\p{N}{3})+$/u;
const GROUPED_DOT_INT_RE = /^[+-]?(?!0+[.,])\p{N}{1,3}(?:\.\p{N}{3})+$/u;
const MULTI_GROUPED_COMMA_INT_RE = /^[+-]?(?!0+[.,])\p{N}{1,3}(?:,\p{N}{3}){2,}$/u;
const MULTI_GROUPED_DOT_INT_RE = /^[+-]?(?!0+[.,])\p{N}{1,3}(?:\.\p{N}{3}){2,}$/u;
const UNIT_CANONICAL_MAP: Readonly<Record<string, string>> = {
  day: 'day',
  days: 'day',
  ngày: 'day',
  week: 'week',
  weeks: 'week',
  tuần: 'week',
  month: 'month',
  months: 'month',
  tháng: 'month',
  quarter: 'quarter',
  quarters: 'quarter',
  quý: 'quarter',
  year: 'year',
  years: 'year',
  năm: 'year',
  hour: 'hour',
  hours: 'hour',
  giờ: 'hour',
  minute: 'minute',
  minutes: 'minute',
  phút: 'minute',
  second: 'second',
  seconds: 'second',
  giây: 'second',
  time: 'time',
  times: 'time',
  lần: 'time',
  percent: 'percent',
  'phần trăm': 'percent',
  dollar: 'usd',
  dollars: 'usd',
  usd: 'usd',
  đô: 'usd',
  $: 'usd',
  euro: 'eur',
  euros: 'eur',
  eur: 'eur',
  '€': 'eur',
  pound: 'gbp',
  pounds: 'gbp',
  gbp: 'gbp',
  '£': 'gbp',
  vnd: 'vnd',
  vnđ: 'vnd',
  đồng: 'vnd',
  đ: 'vnd',
  '₫': 'vnd',
  jpy: 'jpy',
  '¥': 'jpy',
  krw: 'krw',
  '₩': 'krw',
  sgd: 'sgd',
  aud: 'aud',
  cad: 'cad',
  hundred: 'hundred',
  trăm: 'hundred',
  thousand: 'thousand',
  nghìn: 'thousand',
  nghin: 'thousand',
  ngàn: 'thousand',
  ngan: 'thousand',
  million: 'million',
  triệu: 'million',
  trieu: 'million',
  billion: 'billion',
  tỷ: 'billion',
  tỉ: 'billion',
  vạn: 'wan',
  k: 'thousand',
  m: 'million',
  mn: 'million',
  tr: 'million',
  bn: 'billion',
};
const WORD_SCALE_CURRENCY_MAP: Readonly<Record<string, string>> = {
  hundred: 'hundred',
  trăm: 'hundred',
  thousand: 'thousand',
  nghìn: 'thousand',
  nghin: 'thousand',
  ngàn: 'thousand',
  ngan: 'thousand',
  million: 'million',
  triệu: 'million',
  trieu: 'million',
  billion: 'billion',
  tỷ: 'billion',
  tỉ: 'billion',
  percent: 'percent',
  'phần trăm': 'percent',
  dollar: 'usd',
  dollars: 'usd',
  usd: 'usd',
  đô: 'usd',
  euro: 'eur',
  euros: 'eur',
  eur: 'eur',
  pound: 'gbp',
  pounds: 'gbp',
  gbp: 'gbp',
  vnd: 'vnd',
  vnđ: 'vnd',
  đồng: 'vnd',
  đ: 'vnd',
  jpy: 'jpy',
  krw: 'krw',
  sgd: 'sgd',
  aud: 'aud',
  cad: 'cad',
};
const SCALE_WORDS_SET: ReadonlySet<string> = new Set(['hundred', 'thousand', 'million', 'billion']);
const STANDALONE_CURRENCY_OR_PERCENT_SET: ReadonlySet<string> = new Set([
  'percent',
  ...CURRENCY_CODE_SET,
]);
const TIME_UNITS_SET: ReadonlySet<string> = new Set([
  'day',
  'week',
  'month',
  'year',
  'quarter',
  'hour',
  'minute',
  'second',
]);
const UNIT_KIND_MODIFIER_MAP: Readonly<Record<string, string>> = {
  business: 'business',
  working: 'business',
  work: 'business',
  'làm việc': 'business',
  'lam viec': 'business',
  'công tác': 'business',
  'cong tac': 'business',
  calendar: 'calendar',
  'dương lịch': 'calendar',
  'duong lich': 'calendar',
  'theo lịch': 'calendar',
  'theo lich': 'calendar',
  banking: 'banking',
  trading: 'trading',
  'giao dịch': 'trading',
  'giao dich': 'trading',
  market: 'market',
  court: 'court',
  statutory: 'statutory',
  fiscal: 'fiscal',
};

function stripLeadingBullets(text: string): string {
  return text.replace(/(^|\n)[ \t]*[-\u2013\u2014\u2212][ \t]+/g, '$1');
}

function canonicalizeNumericToken(raw: string): string[] {
  const normalizedSign = raw.replace(/^([-+\u2212])\s+/, '$1').replace(/^\u2212/, '-');
  const cleaned = normalizedSign.replace(/^[/%]+|[.,/-]+$/g, '');
  if (!cleaned || cleaned === '+' || cleaned === '-') return [];
  const pct = cleaned.endsWith('%') ? '%' : '';
  const body = pct ? cleaned.slice(0, -1) : cleaned;
  if (!body || body === '+' || body === '-') return [];

  let compact: string | null = null;
  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastDot > lastComma && body.indexOf('.') === lastDot) {
      const intPart = body.slice(0, lastDot);
      if (GROUPED_COMMA_INT_RE.test(intPart)) {
        compact = `${intPart.replace(/,/g, '')}${body.slice(lastDot)}${pct}`;
      }
    } else if (lastComma > lastDot && body.indexOf(',') === lastComma) {
      const intPart = body.slice(0, lastComma);
      if (GROUPED_DOT_INT_RE.test(intPart)) {
        compact = `${intPart.replace(/\./g, '')}${body.slice(lastComma)}${pct}`;
      }
    }
  } else if (MULTI_GROUPED_COMMA_INT_RE.test(body)) {
    compact = `${body.replace(/,/g, '')}${pct}`;
  } else if (MULTI_GROUPED_DOT_INT_RE.test(body)) {
    compact = `${body.replace(/\./g, '')}${pct}`;
  }
  return compact && compact !== cleaned ? [cleaned, compact] : [cleaned];
}

interface SourceNumberContext {
  numbers: ReadonlySet<string>;
  words: ReadonlySet<string>;
  currencies: ReadonlySet<string>;
  unitPairs: ReadonlySet<string>;
}

function normalizeNumberWord(raw: string): string {
  const simplified = raw
    .replace(/[\s-]+/g, ' ')
    .replace(/^(?:a|an) /i, 'one ')
    .replace(/ (day|week|month|year|hour|minute|second|quarter|dollar|euro|pound)s$/i, ' $1')
    .replace(
      /(?: (?:consecutive|successive|full|complete|whole|entire|prior|advance|notice|additional|extra|remaining|initial|grace|waiting|trial|probation|cooling off|contract|billing|single)){1,2} (day|week|month|year|hour|minute|second|quarter)$/i,
      ' $1',
    )
    .replace(
      / (?:consecutive|successive|full|complete|whole|entire|prior|advance|notice|additional|extra|remaining|initial|grace|waiting|trial|probation|cooling off|contract|billing|single) (business|working|work|calendar|banking|trading|market|court|statutory|fiscal) (day|week|month|year|hour|minute|second|quarter)$/i,
      ' $1 $2',
    )
    .replace(/ (?:working|work) (day|week|month|year|hour|minute|second|quarter)$/i, ' business $1')
    .replace(/phần trăm/gi, 'percent');
  return (
    WORD_SCALE_CURRENCY_MAP[simplified] ??
    simplified
      .split(' ')
      .map((part) => WORD_SCALE_CURRENCY_MAP[part] ?? part)
      .join(' ')
  );
}

function normalizeViNumberPhrase(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/(?<![\p{L}])tỉ(?![\p{L}])/giu, 'tỷ')
    .replace(/(?<![\p{L}])trieu(?![\p{L}])/giu, 'triệu')
    .replace(/(?<![\p{L}])nghin(?![\p{L}])/giu, 'nghìn')
    .replace(/(?<![\p{L}])ngan(?![\p{L}])/giu, 'ngàn')
    .replace(/(?<![\p{L}])(?:vnđ|đồng|đ)(?![\p{L}])/giu, 'vnd')
    .replace(/(?<![\p{L}])đô(?![\p{L}])/giu, 'usd')
    .replace(/(?<![\p{L}])phần trăm(?![\p{L}])/giu, 'percent')
    .replace(/(?:lam viec|công tác|cong tac)/gi, 'làm việc')
    .replace(/(?:duong lich|theo lịch|theo lich)/gi, 'dương lịch')
    .replace(/giao dich/gi, 'giao dịch');
}

function normalizeUnitToken(rawUnit: string): string {
  const collapsed = rawUnit.replace(/\s+/g, ' ').trim();
  return UNIT_CANONICAL_MAP[collapsed] ?? collapsed;
}

function normalizeTimeKind(modifiersRaw?: string): string | null {
  if (!modifiersRaw) return null;
  const collapsed = modifiersRaw.replace(/[\s-]+/g, ' ').trim();
  if (!collapsed) return null;
  for (const [phrase, kind] of Object.entries(UNIT_KIND_MODIFIER_MAP)) {
    if (phrase.includes(' ') && collapsed.includes(phrase)) return kind;
  }
  for (const token of collapsed.split(' ')) {
    const kind = UNIT_KIND_MODIFIER_MAP[token];
    if (kind) return kind;
  }
  return null;
}

function pushUnitPair(
  pairs: Array<[string[], string]>,
  variants: string[],
  rawUnit: string,
  rawScale?: string,
  modifiersRaw?: string,
): void {
  const baseUnit = normalizeUnitToken(rawUnit);
  const timeKind = TIME_UNITS_SET.has(baseUnit) ? normalizeTimeKind(modifiersRaw) : null;
  const unit = timeKind ? `${timeKind}:${baseUnit}` : baseUnit;
  if (rawScale) {
    const scale = normalizeUnitToken(rawScale);
    pairs.push([variants, scale]);
    pairs.push([variants, `${scale}:${unit}`]);
    return;
  }
  pairs.push([variants, unit]);
}

const PAIR_TAIL_MAX_CHARS = 256;

function collectNumberUnitPairs(norm: string): Array<[string[], string]> {
  const pairs: Array<[string[], string]> = [];
  const consumedTrailingStarts = new Set<number>();
  for (const numMatch of norm.matchAll(PAIR_NUM_SCAN_RE)) {
    const rawNum = numMatch[0];
    const numStart = numMatch.index ?? -1;
    if (!rawNum || numStart < 0) continue;
    const variants = canonicalizeNumericToken(rawNum);
    if (variants.length === 0) continue;
    const numEnd = numStart + rawNum.length;
    const tail = norm.slice(numEnd, numEnd + PAIR_TAIL_MAX_CHARS);

    const unitMatch = TAIL_UNIT_PAIR_RE.exec(tail);
    if (unitMatch) {
      const [, preMods, rawScale, postScaleMods, rawUnit, postViMod] = unitMatch;
      if (rawUnit) {
        const modifiersRaw = [preMods, postScaleMods, postViMod].filter(Boolean).join(' ');
        pushUnitPair(pairs, variants, rawUnit, rawScale, modifiersRaw);
        if (!postViMod && CURRENCY_CODE_SET.has(normalizeUnitToken(rawUnit))) {
          consumedTrailingStarts.add(numEnd + unitMatch[0].length - rawUnit.length);
        }
      }
    }

    const codeMatch = TAIL_CURRENCY_CODE_PAIR_RE.exec(tail);
    if (codeMatch?.[1]) {
      pushUnitPair(pairs, variants, codeMatch[1]);
      consumedTrailingStarts.add(numEnd + codeMatch[0].length - codeMatch[1].length);
    }

    const symMatch = TAIL_CURRENCY_PAIR_RE.exec(tail);
    const sym = symMatch ? (symMatch[2] ?? symMatch[3]) : undefined;
    if (symMatch && sym) {
      pushUnitPair(pairs, variants, sym, symMatch[1]);
      consumedTrailingStarts.add(numEnd + symMatch[0].length - sym.length);
    }
  }
  for (const m of norm.matchAll(PREFIX_CURRENCY_CODE_PAIR_RE)) {
    if (consumedTrailingStarts.has(m.index ?? -1)) continue;
    const rawCode = m[1];
    const rawNum = m[2];
    const rawScale = m[3];
    if (!rawCode || !rawNum || rawNum.endsWith('%')) continue;
    const variants = canonicalizeNumericToken(rawNum);
    if (variants.length > 0) pushUnitPair(pairs, variants, rawCode, rawScale);
  }
  for (const m of norm.matchAll(LEADING_CURRENCY_PAIR_RE)) {
    if (consumedTrailingStarts.has(m.index ?? -1)) continue;
    const sym = m[1];
    const rawNum = m[2];
    const rawScale = m[3];
    if (!sym || !rawNum || rawNum.endsWith('%')) continue;
    const variants = canonicalizeNumericToken(rawNum);
    if (variants.length > 0) pushUnitPair(pairs, variants, sym, rawScale);
  }
  return pairs;
}

function collectRawUppercaseCodePairs(rawText: string): Array<[string[], string]> {
  const normRaw = stripLeadingBullets(rawText)
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ');
  const pairs: Array<[string[], string]> = [];
  const consumedTrailingStarts = new Set<number>();

  for (const numMatch of normRaw.matchAll(PAIR_NUM_SCAN_RE)) {
    const rawNum = numMatch[0];
    const numStart = numMatch.index ?? -1;
    if (!rawNum || numStart < 0 || rawNum.endsWith('%')) continue;
    const variants = canonicalizeNumericToken(rawNum);
    if (variants.length === 0) continue;
    const numEnd = numStart + rawNum.length;
    const tail = normRaw.slice(numEnd, numEnd + 128);

    const directTail = TAIL_UPPER_CODE_DIRECT_RE.exec(tail);
    if (directTail?.[1]) {
      const code = directTail[1];
      consumedTrailingStarts.add(numEnd + directTail[0].length - code.length);
      const lower = code.toLowerCase();
      if (!NON_CURRENCY_UPPER_CODES.has(code) && !CURRENCY_CODE_SET.has(lower)) {
        pairs.push([variants, `code:${lower}`]);
      }
    } else {
      const scaledTail = TAIL_UPPER_CODE_SCALED_RE.exec(tail);
      const maybeScale = scaledTail?.[1]?.toLowerCase();
      const code = scaledTail?.[2];
      if (scaledTail && maybeScale && code && RAW_UPPER_SCALE_SET.has(maybeScale)) {
        consumedTrailingStarts.add(numEnd + scaledTail[0].length - code.length);
        const lower = code.toLowerCase();
        if (!NON_CURRENCY_UPPER_CODES.has(code) && !CURRENCY_CODE_SET.has(lower)) {
          const scale = normalizeUnitToken(maybeScale);
          pairs.push([variants, `${scale}:code:${lower}`]);
        }
      }
    }

    const headStart = Math.max(0, numStart - 32);
    const head = normRaw.slice(headStart, numStart);
    const headMatch = HEAD_UPPER_CODE_RE.exec(head);
    if (headMatch?.[1]) {
      const code = headMatch[1];
      const codeOffset = headStart + (headMatch.index ?? 0);
      if (!consumedTrailingStarts.has(codeOffset)) {
        const lower = code.toLowerCase();
        if (!NON_CURRENCY_UPPER_CODES.has(code) && !CURRENCY_CODE_SET.has(lower)) {
          pairs.push([variants, `code:${lower}`]);
        }
      }
    }
  }
  return pairs;
}

function buildSourceNumberContext(rawSource: string): SourceNumberContext {
  const combinedNorm = normalizeText(stripLeadingBullets(rawSource));
  const numbers = new Set<string>();
  for (const m of combinedNorm.matchAll(NUMBER_TOKEN_RE)) {
    for (const variant of canonicalizeNumericToken(m[0])) {
      numbers.add(variant);
    }
  }
  const words = new Set<string>();
  for (const m of combinedNorm.matchAll(NUMBER_WORD_RE)) {
    if (!m[0]) continue;
    const word = normalizeNumberWord(m[0]);
    words.add(word);
    const parts = word.split(' ');
    const first = parts[0];
    const second = parts[1];
    if (
      parts.length === 2 &&
      first &&
      second &&
      SCALE_WORDS_SET.has(first) &&
      STANDALONE_CURRENCY_OR_PERCENT_SET.has(second)
    ) {
      words.add(first);
      words.add(second);
    }
  }
  for (const m of combinedNorm.matchAll(VI_NUMBER_BEFORE_UNIT_RE)) {
    if (m[0]) words.add(normalizeViNumberPhrase(m[0]));
  }
  const currencies = new Set<string>();
  for (const m of combinedNorm.matchAll(CURRENCY_SYMBOL_RE)) {
    if (m[0]) currencies.add(m[0]);
  }
  const unitPairs = new Set<string>();
  for (const [variants, unit] of [
    ...collectNumberUnitPairs(combinedNorm),
    ...collectRawUppercaseCodePairs(rawSource),
  ]) {
    for (const v of variants) {
      unitPairs.add(`${v}\u0000${unit}`);
    }
  }
  return { numbers, words, currencies, unitPairs };
}

function hasInventedNumbers(text: string, source: SourceNumberContext, pageCount: number): boolean {
  const norm = normalizeText(stripLeadingBullets(text));
  const allowedPageRefs = new Map<number, string>();
  for (const m of norm.matchAll(PAGE_REF_RE)) {
    const start = m.index ?? -1;
    const digits = m[1];
    const n = Number(digits);
    if (start >= 0 && digits && Number.isInteger(n) && n >= 1 && n <= pageCount) {
      allowedPageRefs.set(start + m[0].lastIndexOf(digits), digits);
    }
  }
  for (const m of norm.matchAll(NUMBER_TOKEN_RE)) {
    const raw = m[0];
    const index = m.index ?? -1;
    if (!raw) continue;
    const refDigits = allowedPageRefs.get(index);
    if (refDigits && raw.replace(/[.,]+$/, '') === refDigits) continue;
    const variants = canonicalizeNumericToken(raw);
    if (variants.length === 0) continue;
    if (variants.some((v) => source.numbers.has(v))) continue;
    return true;
  }
  for (const [variants, unit] of [
    ...collectNumberUnitPairs(norm),
    ...collectRawUppercaseCodePairs(text),
  ]) {
    if (!variants.some((v) => source.unitPairs.has(`${v}\u0000${unit}`))) return true;
  }
  for (const m of norm.matchAll(CURRENCY_SYMBOL_RE)) {
    if (m[0] && !source.currencies.has(m[0])) return true;
  }
  for (const m of norm.matchAll(NUMBER_WORD_RE)) {
    const word = m[0] ? normalizeNumberWord(m[0]) : '';
    if (word && !source.words.has(word)) return true;
  }
  for (const m of norm.matchAll(VI_NUMBER_BEFORE_UNIT_RE)) {
    const phrase = m[0] ? normalizeViNumberPhrase(m[0]) : '';
    if (phrase && !source.words.has(phrase)) return true;
  }
  return false;
}

function trimAddressToken(raw: string): string {
  return raw
    .replace(/^['"\u2018\u2019\u201c\u201d]+/, '')
    .replace(/[.,;:!?)'"\]\u2018\u2019\u201c\u201d]+$/, '');
}

function canonicalizeAddressToken(token: string): string {
  const schemeMatch = /^(https?:\/\/|mailto:|tel:)(.*)$/iu.exec(token);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    const body = schemeMatch[2] ?? '';
    if (scheme === 'http://' || scheme === 'https://') {
      const splitIdx = body.search(/[/?#]/);
      const authority = splitIdx >= 0 ? body.slice(0, splitIdx) : body;
      const rest = splitIdx >= 0 ? body.slice(splitIdx) : '';
      const atIdx = authority.lastIndexOf('@');
      const normalizedAuthority =
        atIdx >= 0
          ? `${authority.slice(0, atIdx + 1)}${authority.slice(atIdx + 1).toLowerCase()}`
          : authority.toLowerCase();
      return `${scheme}${normalizedAuthority}${rest}`;
    }
    if (scheme === 'mailto:') {
      const splitIdx = body.search(/[?#]/);
      const addr = splitIdx >= 0 ? body.slice(0, splitIdx) : body;
      const rest = splitIdx >= 0 ? body.slice(splitIdx) : '';
      const atIdx = addr.lastIndexOf('@');
      const normalizedAddr =
        atIdx >= 0 ? `${addr.slice(0, atIdx + 1)}${addr.slice(atIdx + 1).toLowerCase()}` : addr;
      return `${scheme}${normalizedAddr}${rest}`;
    }
    return `${scheme}${body}`;
  }
  const splitIdx = token.search(/[/?#]/);
  const hostOrAddr = splitIdx >= 0 ? token.slice(0, splitIdx) : token;
  const rest = splitIdx >= 0 ? token.slice(splitIdx) : '';
  const atIdx = hostOrAddr.lastIndexOf('@');
  if (atIdx >= 0) {
    return `${hostOrAddr.slice(0, atIdx + 1)}${hostOrAddr.slice(atIdx + 1).toLowerCase()}${rest}`;
  }
  return `${hostOrAddr.toLowerCase()}${rest}`;
}

function extractAddressTokens(addrNorm: string): string[] {
  const tokens: string[] = [];
  for (const m of addrNorm.matchAll(SCHEME_OR_WEB_RE)) {
    const item = trimAddressToken(m[0] ?? '');
    if (item) tokens.push(canonicalizeAddressToken(item));
  }
  for (const m of addrNorm.matchAll(ADDRESS_CHUNK_RE)) {
    const chunk = m[0];
    if (!chunk) continue;
    const lastAt = chunk.lastIndexOf('@');
    if (lastAt <= 0 || lastAt >= chunk.length - 1) continue;
    const item = trimAddressToken(chunk);
    if (item) tokens.push(canonicalizeAddressToken(item));
  }
  for (const m of addrNorm.matchAll(DOMAIN_RE)) {
    const item = trimAddressToken(m[0] ?? '');
    if (item) tokens.push(canonicalizeAddressToken(item));
  }
  for (const m of addrNorm.matchAll(IPV4_RE)) {
    const item = trimAddressToken(m[0] ?? '');
    if (item) tokens.push(canonicalizeAddressToken(item));
  }
  for (const m of addrNorm.matchAll(OBFUSCATED_ADDR_RE)) {
    if (m[0]) tokens.push(m[0].toLowerCase());
  }
  return tokens;
}

function hasUnsourcedLinks(text: string, sourceAddresses: ReadonlySet<string>): boolean {
  const norm = normalizeAddressText(text);
  for (const item of extractAddressTokens(norm)) {
    if (!sourceAddresses.has(item)) return true;
  }
  return false;
}

export function signerRoleKeyOf(index: number): string {
  return `signer_${index + 1}`;
}

export function clampAiBox(raw: { xNorm: number; yNorm: number; wNorm: number; hNorm: number }): { xNorm: number; yNorm: number; wNorm: number; hNorm: number } | null {
  if (
    !Number.isFinite(raw.xNorm) ||
    !Number.isFinite(raw.yNorm) ||
    !Number.isFinite(raw.wNorm) ||
    !Number.isFinite(raw.hNorm) ||
    raw.wNorm <= 0 ||
    raw.hNorm <= 0
  ) {
    return null;
  }
  const left = round6(clamp(raw.xNorm, 0, 1));
  const top = round6(clamp(raw.yNorm, 0, 1));
  const right = round6(clamp(raw.xNorm + raw.wNorm, 0, 1));
  const bottom = round6(clamp(raw.yNorm + raw.hNorm, 0, 1));
  const wNorm = round6(right - left);
  const hNorm = round6(bottom - top);
  if (
    wNorm < SIGN_AI_MIN_SPAN ||
    hNorm < SIGN_AI_MIN_SPAN ||
    left < 0 ||
    left >= 1 ||
    top < 0 ||
    top >= 1 ||
    left + wNorm > 1 ||
    top + hNorm > 1
  ) {
    return null;
  }
  return { xNorm: left, yNorm: top, wNorm, hNorm };
}

export function sanitizeSignAiProposals(params: {
  pageCount: number | null;
  signers: ReadonlyArray<{ id: string; role_label: string; signer_role: string; routing_order: number }>;
  proposedFields: ReadonlyArray<z.infer<typeof zIncomingProposedField>>;
  riskClauses: ReadonlyArray<z.infer<typeof zIncomingRiskClause>>;
  summaryText: string | null;
  extractedPages?: readonly SignAiExtractedPage[];
}): SanitizedAiAnalysisInput {
  const assignable = params.signers
    .filter((s) => s.signer_role !== 'cc')
    .sort((a, b) => a.routing_order - b.routing_order || a.id.localeCompare(b.id));

  const roleLookup = new Map<string, { signerId: string; roleKey: string }>();
  const assignableById = new Map<string, { signerId: string; roleKey: string }>();
  const labelCounts = new Map<string, number>();
  for (const s of assignable) {
    const key = cleanLine(s.role_label, 120).toLowerCase();
    if (key) labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  assignable.forEach((s, idx) => {
    const canonicalKey = signerRoleKeyOf(idx);
    const entry = { signerId: s.id, roleKey: canonicalKey };
    assignableById.set(s.id, entry);
    roleLookup.set(canonicalKey, entry);
    roleLookup.set(s.id.toLowerCase(), entry);
    const labelKey = cleanLine(s.role_label, 120).toLowerCase();
    if (labelKey && labelCounts.get(labelKey) === 1 && !roleLookup.has(labelKey)) {
      roleLookup.set(labelKey, entry);
    }
  });

  const proposedFields: SignAiProposedField[] = [];
  let droppedFields = 0;
  const maxPage = params.pageCount ?? 0;

  for (const candidate of params.proposedFields) {
    if (!Number.isInteger(candidate.pageNumber) || candidate.pageNumber < 1 || candidate.pageNumber > maxPage) {
      droppedFields += 1;
      continue;
    }
    const fieldType = candidate.fieldType.trim();
    if (!FIELD_TYPE_SET.has(fieldType)) {
      droppedFields += 1;
      continue;
    }
    const resolved = candidate.signerId
      ? assignableById.get(candidate.signerId)
      : roleLookup.get(candidate.signerRoleKey.trim().toLowerCase());
    if (!resolved) {
      droppedFields += 1;
      continue;
    }
    const box = clampAiBox(candidate);
    if (!box || proposedFields.length >= SIGN_AI_MAX_FIELDS) {
      droppedFields += 1;
      continue;
    }
    const label = typeof candidate.label === 'string' ? cleanLine(candidate.label, 120) : '';
    const confidence =
      typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
        ? round6(clamp(candidate.confidence, 0, 1))
        : null;

    proposedFields.push({
      signerId: resolved.signerId,
      signerRoleKey: resolved.roleKey,
      fieldType: fieldType as SignFieldType,
      pageNumber: candidate.pageNumber,
      ...box,
      label: label.length > 0 ? label : null,
      confidence,
      // Always taint AI proposals regardless of caller input.
      proposedByAi: true,
    });
  }

  const pageParts = new Map<number, string[]>();
  for (const p of params.extractedPages ?? []) {
    if (!Number.isInteger(p.page) || p.page < 1 || (maxPage > 0 && p.page > maxPage)) continue;
    const text = p.text.trim();
    if (!text) continue;
    const list = pageParts.get(p.page);
    if (list) list.push(text);
    else pageParts.set(p.page, [text]);
  }
  const pageNormMap = new Map<number, string>();
  const orderedPages = [...pageParts.entries()].sort((a, b) => a[0] - b[0]);
  for (const [pageNo, parts] of orderedPages) {
    pageNormMap.set(pageNo, normalizeText(parts.join('\n')));
  }
  const combinedRaw = orderedPages.map(([, parts]) => parts.join('\n')).join('\n');
  const combinedNorm = normalizeText(combinedRaw);
  const hasSourceText = combinedNorm.length > 0 && maxPage > 0;
  const sourceAddresses = new Set(hasSourceText ? extractAddressTokens(normalizeAddressText(combinedRaw)) : []);
  const sourceNumbers = hasSourceText ? buildSourceNumberContext(combinedRaw) : null;

  const riskClauses: SignAiRiskClause[] = [];
  let droppedClauses = 0;

  if (!sourceNumbers) {
    droppedClauses = params.riskClauses.length;
  } else {
    for (const item of params.riskClauses) {
      const severity = item.severity.trim().toLowerCase();
      if (!SEVERITY_SET.has(severity)) {
        droppedClauses += 1;
        continue;
      }
      const title = cleanLine(item.title, 200);
      const explanation = cleanLine(item.explanation, 800);
      const quote = item.quote.trim();
      const normQuote = normalizeText(quote);
      if (!title || !explanation || normQuote.length < 6) {
        droppedClauses += 1;
        continue;
      }
      let pageNumber: number | null = null;
      if (item.pageNumber !== null && item.pageNumber !== undefined) {
        if (!Number.isInteger(item.pageNumber) || item.pageNumber < 1 || item.pageNumber > maxPage) {
          droppedClauses += 1;
          continue;
        }
        if (!(pageNormMap.get(item.pageNumber) ?? '').includes(normQuote)) {
          droppedClauses += 1;
          continue;
        }
        pageNumber = item.pageNumber;
      } else {
        for (const [pageNo, pageText] of pageNormMap) {
          if (pageText.includes(normQuote)) {
            pageNumber = pageNo;
            break;
          }
        }
        if (pageNumber === null) {
          droppedClauses += 1;
          continue;
        }
      }

      if (
        hasUnsourcedLinks(title, sourceAddresses) ||
        hasUnsourcedLinks(explanation, sourceAddresses) ||
        hasInventedNumbers(title, sourceNumbers, maxPage) ||
        hasInventedNumbers(explanation, sourceNumbers, maxPage)
      ) {
        droppedClauses += 1;
        continue;
      }

      if (riskClauses.length >= SIGN_AI_MAX_CLAUSES) {
        droppedClauses += 1;
        continue;
      }
      riskClauses.push({
        title,
        severity: severity as SignAiClauseSeverity,
        pageNumber,
        quote: safeSlice(quote, 1000),
        explanation,
      });
    }
  }

  let summaryText: string | null = null;
  let summaryDropped = false;
  if (typeof params.summaryText === 'string' && params.summaryText.replace(/\p{Cf}/gu, '').trim().length > 0) {
    const trimmed = safeSlice(params.summaryText.replace(/\p{Cf}/gu, ''), SIGN_AI_SUMMARY_MAX);
    if (
      !sourceNumbers ||
      hasUnsourcedLinks(trimmed, sourceAddresses) ||
      hasInventedNumbers(trimmed, sourceNumbers, maxPage)
    ) {
      summaryDropped = true;
    } else {
      summaryText = trimmed;
    }
  }

  return {
    proposedFields,
    riskClauses,
    summaryText,
    droppedFields,
    droppedClauses,
    summaryDropped,
  };
}

function assertUser(ctx: CommandContext | QueryContext): void {
  if (ctx.actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can run this action');
  }
}

function assertSystem(ctx: CommandContext): void {
  if (ctx.actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only the system worker can record AI analysis directly');
  }
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toAnalysisRecord(
  row: {
    id: string;
    org_id: string;
    envelope_id: string;
    source_sha256: string;
    status: SignAiAnalysisStatus;
    proposed_fields_json: unknown;
    risk_clauses_json: unknown;
    summary_text: string | null;
    error_message: string | null;
    prompt_version: string;
    completed_at: Date | null;
    created_at: Date;
  },
  activeSignerIds?: ReadonlySet<string>,
): SignAiAnalysisRecord {
  const proposedFields = parseJsonArray<SignAiProposedField>(row.proposed_fields_json)
    .filter((f) => !activeSignerIds || (typeof f.signerId === 'string' && activeSignerIds.has(f.signerId)))
    .map((f) => ({
      ...f,
      proposedByAi: true as const,
    }));
  return {
    id: row.id,
    orgId: row.org_id,
    envelopeId: row.envelope_id,
    sourceSha256: row.source_sha256,
    status: row.status,
    proposedFields,
    riskClauses: parseJsonArray<SignAiRiskClause>(row.risk_clauses_json),
    summaryText: row.summary_text,
    errorMessage: row.error_message,
    promptVersion: row.prompt_version,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function isSignAiStoppedOnTrx(
  trx: QueryContext['trx'] | CommandContext['trx'],
  orgId: string,
): Promise<boolean> {
  const stopped = await trx
    .selectFrom('crove_kernel.kill_switch')
    .select('id')
    .where('org_id', '=', orgId)
    .where('released_at', 'is', null)
    .where((eb) =>
      eb.or([eb('scope', '=', 'org'), eb.and([eb('scope', '=', 'module'), eb('target', '=', 'sign')])]),
    )
    .limit(1)
    .executeTakeFirst();
  const { rows: globalStopped } = await sql<{ on: boolean }>`
    SELECT crove_kernel.global_kill_switch_on('ai') AS on
  `.execute(trx);
  return Boolean(stopped) || globalStopped[0]?.on === true;
}

async function recordAiAnalysisRow(
  ctx: CommandContext,
  input: z.infer<typeof zAiAnalysisRecordInput>,
  options: { requireDraft: boolean },
): Promise<SignAiAnalysisRecord> {
  const env = await ctx.trx
    .selectFrom('crove_sign.envelope')
    .select(['id', 'org_id', 'version', 'status', 'inspect_status', 'source_sha256', 'page_count'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', input.envelopeId)
    .forUpdate()
    .executeTakeFirst();
  if (!env) {
    throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
  }
  if (options.requireDraft && env.status !== 'draft') {
    throw new DomainError('SIGN_ENVELOPE_NOT_DRAFT', 409, 'AI field proposals can only be saved for draft envelopes');
  }
  if (env.source_sha256 !== input.sourceSha256) {
    throw new DomainError('SIGN_VERSION_CONFLICT', 409, 'Envelope document changed before AI analysis was saved');
  }
  if (input.expectedVersion !== undefined && env.version !== input.expectedVersion) {
    throw new DomainError('SIGN_VERSION_CONFLICT', 409, 'Envelope signers or layout changed before AI analysis was saved');
  }
  if (input.status === 'completed' && env.inspect_status !== 'passed') {
    throw new DomainError('SIGN_DOCUMENT_NOT_INSPECTED', 409, 'PDF inspection must pass before storing completed AI proposals');
  }
  if (input.status !== 'failed' && (await isSignAiStoppedOnTrx(ctx.trx, ctx.orgId))) {
    throw new DomainError('SIGN_AI_STOPPED', 409, 'AI features are stopped for this organization');
  }
  const hasSourceText = (input.extractedPages ?? []).some(
    (p) => Number.isInteger(p.page) && p.page >= 1 && (env.page_count ?? 0) >= p.page && p.text.trim().length > 0,
  );
  if (
    input.status === 'completed' &&
    !hasSourceText &&
    (input.proposedFields.length > 0 || input.riskClauses.length > 0 || (input.summaryText !== null && input.summaryText.trim().length > 0))
  ) {
    throw new DomainError(
      'SIGN_AI_SOURCE_TEXT_REQUIRED',
      400,
      'Non-empty extracted PDF pages are required to verify completed AI proposals',
    );
  }

  const signers = await ctx.trx
    .selectFrom('crove_sign.signer')
    .select(['id', 'role_label', 'signer_role', 'routing_order'])
    .where('org_id', '=', ctx.orgId)
    .where('envelope_id', '=', env.id)
    .orderBy('routing_order', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const sanitized =
    input.status === 'completed'
      ? sanitizeSignAiProposals({
          pageCount: env.page_count,
          signers,
          proposedFields: input.proposedFields,
          riskClauses: input.riskClauses,
          summaryText: input.summaryText,
          ...(input.extractedPages !== undefined ? { extractedPages: input.extractedPages } : {}),
        })
      : {
          proposedFields: [],
          riskClauses: [],
          summaryText: null,
          droppedFields: 0,
          droppedClauses: 0,
          summaryDropped: false,
        };

  const completedAt = input.status === 'pending' ? null : ctx.now;
  const errorMessage =
    input.status === 'failed'
      ? cleanLine(input.errorMessage ?? 'AI analysis failed', SIGN_AI_ERROR_MAX)
      : null;

  const inserted = await ctx.trx
    .insertInto('crove_sign.ai_analysis')
    .values({
      org_id: ctx.orgId,
      envelope_id: env.id,
      source_sha256: env.source_sha256,
      status: input.status,
      proposed_fields_json: JSON.stringify(sanitized.proposedFields),
      risk_clauses_json: JSON.stringify(sanitized.riskClauses),
      summary_text: sanitized.summaryText,
      error_message: errorMessage,
      prompt_version: input.promptVersion,
      completed_at: completedAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  ctx.audit({
    envelopeId: env.id,
    analysisId: inserted.id,
    status: inserted.status,
    proposedFieldCount: sanitized.proposedFields.length,
    riskClauseCount: sanitized.riskClauses.length,
  });

  return toAnalysisRecord(inserted);
}

export const envelopeProposeFields = defineCommand({
  name: 'sign.envelope.propose_fields',
  input: zEnvelopeProposeFieldsInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [AI_ANALYSIS_WRITE],
  handler: async (ctx, input) => {
    assertUser(ctx);
    return recordAiAnalysisRow(ctx, input, { requireDraft: true });
  },
});

export const aiAnalysisRecord = defineCommand({
  name: 'sign.ai_analysis.record',
  input: zAiAnalysisRecordInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target,
  writes: [AI_ANALYSIS_WRITE],
  handler: async (ctx, input) => {
    assertSystem(ctx);
    return recordAiAnalysisRow(ctx, input, { requireDraft: false });
  },
});

export const aiAnalysisSource = defineQuery({
  name: 'sign.ai_analysis.source',
  input: z.strictObject({ envelopeId: zId }),
  access: WRITERS,
  handler: async (ctx, input): Promise<SignAiSource> => {
    const env = await ctx.trx
      .selectFrom('crove_sign.envelope')
      .select(['id', 'version', 'status', 'inspect_status', 'source_sha256', 'title', 'page_count', 'page_dimensions_json'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }

    const signers = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['id', 'role_label', 'signer_role', 'routing_order'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('routing_order', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const assignable = signers
      .filter((s): s is typeof s & { signer_role: 'signer' | 'approver' } => s.signer_role !== 'cc')
      .map((s, idx) => ({
        signerId: s.id,
        roleKey: signerRoleKeyOf(idx),
        roleLabel: s.role_label,
        signerRole: s.signer_role,
        routingOrder: s.routing_order,
      }));

    let pageDimensions: SignAiSource['pageDimensions'] = null;
    if (Array.isArray(env.page_dimensions_json)) {
      pageDimensions = env.page_dimensions_json as SignAiSource['pageDimensions'];
    } else if (typeof env.page_dimensions_json === 'string') {
      try {
        const parsed = JSON.parse(env.page_dimensions_json) as unknown;
        if (Array.isArray(parsed)) pageDimensions = parsed as SignAiSource['pageDimensions'];
      } catch {
        pageDimensions = null;
      }
    }

    return {
      envelopeId: env.id,
      version: env.version,
      status: env.status,
      inspectStatus: env.inspect_status,
      sourceSha256: env.source_sha256,
      title: env.title,
      pageCount: env.page_count,
      pageDimensions,
      signers: assignable,
      aiStopped: await isSignAiStoppedOnTrx(ctx.trx, ctx.orgId),
    };
  },
});

export const aiAnalysisGet = defineQuery({
  name: 'sign.ai_analysis.get',
  input: z.strictObject({ envelopeId: zId }),
  access: READERS,
  handler: async (ctx, input): Promise<SignAiAnalysisRecord | null> => {
    const env = await ctx.trx
      .selectFrom('crove_sign.envelope')
      .select(['id', 'source_sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }

    const activeSigners = await ctx.trx
      .selectFrom('crove_sign.signer')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .where('signer_role', '!=', 'cc')
      .execute();
    const activeSignerIds = new Set(activeSigners.map((s) => s.id));

    const completed = await ctx.trx
      .selectFrom('crove_sign.ai_analysis')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .where('source_sha256', '=', env.source_sha256)
      .where('status', '=', 'completed')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (completed) {
      return toAnalysisRecord(completed, activeSignerIds);
    }

    const latest = await ctx.trx
      .selectFrom('crove_sign.ai_analysis')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .where('source_sha256', '=', env.source_sha256)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();

    return latest ? toAnalysisRecord(latest, activeSignerIds) : null;
  },
});

export const signAiCommands = [envelopeProposeFields, aiAnalysisRecord];
export const signAiQueries = [aiAnalysisSource, aiAnalysisGet];

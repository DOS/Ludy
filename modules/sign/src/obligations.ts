// SPDX-License-Identifier: AGPL-3.0-only
// Post-signature agreement terms, renewal notice windows, milestone obligations, and Vy Today surfacing (Slice 4e, #3821).
// Every write runs through Runtime.execute(); contract_value uses NUMERIC(20,4) and decimal.js (@ludy/l10n-vn) end to end;
// AI proposals remain tainted inside proposal_json until explicit human confirmation via sign.obligation.upsert;
// only confirmed obligations on completed envelopes surface on /sign/envelopes Renewals and Vy's Home (sign.obligations.today).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { type MemberRole, type SignObligationStatus } from '@ludy/db';
import {
  SIGN_MAX_PAGES,
  SIGN_OBLIGATION_CITATION_FIELDS,
  SIGN_OBLIGATION_ITEM_STATUSES,
  TODAY_ITEMS_MAX,
  tableWrite,
  vietnamToday,
  zId,
  zSignCurrencyCode,
  zSignDepositProposal,
  zSignObligationCompleteItemInput,
  zSignObligationDate,
  zSignObligationDismissInput,
  zSignObligationRenewalsListInput,
  zSignObligationUpsertInput,
  zTodayItems,
  type SignDepositProposalContract,
  type SignEnvelopeObligationRecordContract,
  type SignObligationCitationContract,
  type SignObligationItemContract,
  type SignObligationProposalContract,
  type SignObligationRenewalListItem,
  type TodayItem,
} from '@ludy/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  type CommandContext,
  type QueryContext,
} from '@ludy/kernel-runtime';
import { Decimal, isValidCalendarDate, money, toMoney } from '@ludy/l10n-vn';
import {
  assertCanAccessEnvelopeRow,
  canAccessEnvelopeRow,
  isHrPrivilegedRole,
} from './hr-visibility.ts';
import { assertCanAccessMeetingMinutesEnvelopeRow } from './meeting-visibility.ts';
import { signManifest } from './manifest.ts';
import { resolvePrimaryEnvelopeDocMap, resolvePrimaryEnvelopeDocMeta } from './shared.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ALL_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const RENEWAL_NOTICE_ALERT_WINDOW_DAYS = 30;
export const OBLIGATION_DUE_SOON_DAYS = 7;
const OBLIGATION_TODAY_ROW_LIMIT = 500;
const MAX_CONTRACT_DECIMAL = new Decimal('9999999999999999.9999');
const FORMAT_CONTROL_RE = /\p{Cf}+/gu;
const CITATION_FIELD_SET: ReadonlySet<string> = new Set(SIGN_OBLIGATION_CITATION_FIELDS);
const ITEM_STATUS_SET: ReadonlySet<string> = new Set(SIGN_OBLIGATION_ITEM_STATUSES);

const target = <T extends { envelopeId: string }>(input: T) => ({
  type: 'sign.envelope_obligation',
  id: input.envelopeId,
});

const OBLIGATION_PROPOSE_WRITE = tableWrite(
  signManifest.tables,
  'ludy_sign',
  'envelope_obligation',
  ['org_id', 'envelope_id', 'proposal_json', 'prompt_version', 'status', 'created_by', 'updated_at'],
);

const OBLIGATION_UPSERT_WRITE = tableWrite(
  signManifest.tables,
  'ludy_sign',
  'envelope_obligation',
  [
    'org_id',
    'envelope_id',
    'counterparty_name',
    'effective_date',
    'expiry_date',
    'renewal_notice_days',
    'auto_renew',
    'contract_value',
    'currency',
    'obligations_json',
    'proposal_json',
    'status',
    'confirmed_by',
    'confirmed_at',
    'created_by',
    'updated_at',
  ],
);

const OBLIGATION_DISMISS_WRITE = tableWrite(
  signManifest.tables,
  'ludy_sign',
  'envelope_obligation',
  ['proposal_json', 'status', 'updated_at'],
);

const OBLIGATION_COMPLETE_ITEM_WRITE = tableWrite(
  signManifest.tables,
  'ludy_sign',
  'envelope_obligation',
  ['obligations_json', 'updated_at'],
);

export interface SignObligationSource {
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
}

export interface SignObligationTodayRow {
  envelopeId: string;
  sourceKind: string;
  createdBy: string;
  expiryDate: string | null;
  renewalNoticeDays: number | null;
  autoRenew: boolean;
  contractValue: string | null;
  currency: string;
  obligations: readonly SignObligationItemContract[];
}

function stripFormatControl(value: string): string {
  return value.replace(FORMAT_CONTROL_RE, '');
}

function cleanLine(value: string, max: number): string {
  const one = stripFormatControl(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(one);
  return points.length <= max ? one : points.slice(0, max).join('').trimEnd();
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

function assertUser(ctx: QueryContext | CommandContext): string {
  if (ctx.actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can perform this action');
  }
  return ctx.actor.userId;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function dateOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const trimmed = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

export function validateIsoCalendarDate(raw: string | null | undefined, fieldLabel: string): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = stripFormatControl(raw).trim();
  if (!isValidCalendarDate(cleaned)) {
    throw new DomainError('SIGN_OBLIGATION_INVALID_DATE', 422, `Invalid calendar date for ${fieldLabel}`);
  }
  return cleaned;
}

export function parseContractValueDecimal(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = stripFormatControl(raw).trim().replace(/\s+/g, '');
  if (cleaned === '') return null;
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) {
    throw new DomainError(
      'SIGN_OBLIGATION_INVALID_VALUE',
      422,
      'Contract value must be a non-negative decimal string with up to 4 decimal places',
    );
  }
  let dec: InstanceType<typeof Decimal>;
  try {
    dec = money(cleaned);
  } catch {
    throw new DomainError(
      'SIGN_OBLIGATION_INVALID_VALUE',
      422,
      'Contract value must be a valid decimal string',
    );
  }
  if (!dec.isFinite() || dec.isNegative() || dec.greaterThan(MAX_CONTRACT_DECIMAL)) {
    throw new DomainError(
      'SIGN_OBLIGATION_INVALID_VALUE',
      422,
      'Contract value exceeds allowed NUMERIC(20,4) bounds',
    );
  }
  return toMoney(dec);
}

function formatStoredContractDecimal(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    return toMoney(money(text));
  } catch {
    return null;
  }
}

export function dayEpochDays(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return Number.NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function addDaysIso(ymd: string, deltaDays: number): string {
  const epochDays = dayEpochDays(ymd);
  const dt = new Date(epochDays * 86_400_000 + deltaDays * 86_400_000);
  return dt.toISOString().slice(0, 10);
}

function parseStoredObligationItems(raw: unknown): SignObligationItemContract[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: SignObligationItemContract[] = [];
  for (const [idx, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? cleanLine(obj.title, 300) : '';
    if (!title) continue;
    const rawId = typeof obj.id === 'string' ? cleanLine(obj.id, 80) : '';
    const id = rawId || `item-${idx + 1}`;
    const rawDue = typeof obj.dueDate === 'string' ? obj.dueDate.trim() : null;
    const dueDate = rawDue && isValidCalendarDate(rawDue) ? rawDue : null;
    const rawStatus = typeof obj.status === 'string' ? obj.status.trim() : 'pending';
    const status = ITEM_STATUS_SET.has(rawStatus) ? (rawStatus as 'pending' | 'completed') : 'pending';
    const completedAt =
      status === 'completed' && typeof obj.completedAt === 'string' && obj.completedAt.trim()
        ? obj.completedAt.trim()
        : null;
    const pageNumber =
      typeof obj.pageNumber === 'number' &&
      Number.isInteger(obj.pageNumber) &&
      obj.pageNumber >= 1 &&
      obj.pageNumber <= SIGN_MAX_PAGES
        ? obj.pageNumber
        : null;
    const quoteExcerpt =
      typeof obj.quoteExcerpt === 'string' && obj.quoteExcerpt.trim().length > 0
        ? cleanLine(obj.quoteExcerpt, 1000)
        : null;
    const proposedByAi = obj.proposedByAi === true;
    out.push({
      id,
      title,
      dueDate,
      status,
      completedAt,
      pageNumber,
      quoteExcerpt,
      proposedByAi,
    });
  }
  return out;
}

function parseStoredProposal(raw: unknown): SignObligationProposalContract | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const counterpartyName =
    typeof rec.counterpartyName === 'string' && rec.counterpartyName.trim().length > 0
      ? cleanLine(rec.counterpartyName, 300)
      : null;
  const effectiveDate =
    typeof rec.effectiveDate === 'string' && isValidCalendarDate(rec.effectiveDate.trim())
      ? rec.effectiveDate.trim()
      : null;
  const expiryDate =
    typeof rec.expiryDate === 'string' && isValidCalendarDate(rec.expiryDate.trim())
      ? rec.expiryDate.trim()
      : null;
  const renewalNoticeDays =
    typeof rec.renewalNoticeDays === 'number' &&
    Number.isInteger(rec.renewalNoticeDays) &&
    rec.renewalNoticeDays >= 0 &&
    rec.renewalNoticeDays <= 365
      ? rec.renewalNoticeDays
      : null;
  const autoRenew = rec.autoRenew === true;
  const contractValue = formatStoredContractDecimal(rec.contractValue);
  const rawCurrency = typeof rec.currency === 'string' ? rec.currency.trim().toUpperCase() : '';
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'VND';

  const citations: SignObligationCitationContract[] = [];
  if (Array.isArray(rec.citations)) {
    for (const c of rec.citations) {
      if (!c || typeof c !== 'object') continue;
      const cite = c as Record<string, unknown>;
      const field = typeof cite.field === 'string' ? cite.field.trim() : '';
      const pageNumber = cite.pageNumber;
      const quoteExcerpt = typeof cite.quoteExcerpt === 'string' ? cleanLine(cite.quoteExcerpt, 1000) : '';
      if (
        CITATION_FIELD_SET.has(field) &&
        typeof pageNumber === 'number' &&
        Number.isInteger(pageNumber) &&
        pageNumber >= 1 &&
        pageNumber <= SIGN_MAX_PAGES &&
        quoteExcerpt.length > 0
      ) {
        citations.push({
          field: field as SignObligationCitationContract['field'],
          pageNumber,
          quoteExcerpt,
        });
      }
    }
  }

  const obligations: SignObligationProposalContract['obligations'] = [];
  if (Array.isArray(rec.obligations)) {
    for (const [idx, item] of rec.obligations.entries()) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const title = typeof o.title === 'string' ? cleanLine(o.title, 300) : '';
      const pageNumber = o.pageNumber;
      const quoteExcerpt = typeof o.quoteExcerpt === 'string' ? cleanLine(o.quoteExcerpt, 1000) : '';
      if (
        !title ||
        typeof pageNumber !== 'number' ||
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > SIGN_MAX_PAGES ||
        !quoteExcerpt
      ) {
        continue;
      }
      const dueDate =
        typeof o.dueDate === 'string' && isValidCalendarDate(o.dueDate.trim()) ? o.dueDate.trim() : null;
      const rawId = typeof o.id === 'string' ? cleanLine(o.id, 80) : '';
      obligations.push({
        id: rawId || `obl-${idx + 1}`,
        title,
        dueDate,
        status: o.status === 'completed' ? 'completed' : 'pending',
        pageNumber,
        quoteExcerpt,
        proposedByAi: true,
      });
    }
  }

  return {
    counterpartyName,
    effectiveDate,
    expiryDate,
    renewalNoticeDays,
    autoRenew,
    contractValue,
    currency,
    citations,
    obligations,
    proposedByAi: true,
  };
}

export interface ObligationDbRow {
  org_id: string;
  id: string;
  envelope_id: string;
  counterparty_name: string | null;
  effective_date: Date | string | null;
  expiry_date: Date | string | null;
  renewal_notice_days: number | null;
  auto_renew: boolean;
  contract_value: string | null;
  currency: string;
  obligations_json: unknown;
  proposal_json: unknown;
  prompt_version: string | null;
  status: SignObligationStatus;
  confirmed_by: string | null;
  confirmed_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toObligationRecord(row: ObligationDbRow): SignEnvelopeObligationRecordContract {
  const rawCurrency = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : '';
  return {
    id: row.id,
    orgId: row.org_id,
    envelopeId: row.envelope_id,
    status: row.status,
    counterpartyName:
      typeof row.counterparty_name === 'string' && row.counterparty_name.trim().length > 0
        ? cleanLine(row.counterparty_name, 300)
        : null,
    effectiveDate: dateOrNull(row.effective_date),
    expiryDate: dateOrNull(row.expiry_date),
    renewalNoticeDays: row.renewal_notice_days ?? null,
    autoRenew: Boolean(row.auto_renew),
    contractValue: formatStoredContractDecimal(row.contract_value),
    currency: /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'VND',
    obligations: parseStoredObligationItems(row.obligations_json),
    proposal: parseStoredProposal(row.proposal_json),
    promptVersion: row.prompt_version ? cleanLine(row.prompt_version, 32) : null,
    confirmedBy: row.confirmed_by ?? null,
    confirmedAt: isoOrNull(row.confirmed_at),
    createdBy: row.created_by ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function isSignAiStoppedOnTrx(
  trx: QueryContext['trx'] | CommandContext['trx'],
  orgId: string,
): Promise<boolean> {
  const stopped = await trx
    .selectFrom('ludy_kernel.kill_switch')
    .select('id')
    .where('org_id', '=', orgId)
    .where('released_at', 'is', null)
    .where((eb) =>
      eb.or([eb('scope', '=', 'org'), eb.and([eb('scope', '=', 'module'), eb('target', '=', 'sign')])]),
    )
    .limit(1)
    .executeTakeFirst();
  const { rows: globalStopped } = await sql<{ on: boolean }>`
    SELECT ludy_kernel.global_kill_switch_on('ai') AS on
  `.execute(trx);
  return Boolean(stopped || globalStopped[0]?.on);
}

const zExtractedPage = z.strictObject({
  page: z.number().int().min(1).max(SIGN_MAX_PAGES),
  text: z.string().max(250_000),
});

const zIncomingProposalCitation = z.strictObject({
  field: z.string().min(1).max(64),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
  quoteExcerpt: z.string().min(1).max(1000),
});

const zIncomingProposedObligation = z.strictObject({
  id: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(300),
  dueDate: zSignObligationDate.nullable().optional(),
  status: z.enum(SIGN_OBLIGATION_ITEM_STATUSES).optional(),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
  quoteExcerpt: z.string().min(1).max(1000),
  proposedByAi: z.boolean().optional(),
});

const zObligationProposeCommandInput = z.strictObject({
  envelopeId: zId,
  promptVersion: z.string().trim().min(1).max(32).default('v1'),
  proposal: z.strictObject({
    counterpartyName: z.string().max(300).nullable().optional(),
    effectiveDate: zSignObligationDate.nullable().optional(),
    expiryDate: zSignObligationDate.nullable().optional(),
    renewalNoticeDays: z.number().int().min(0).max(365).nullable().optional(),
    autoRenew: z.boolean().default(false),
    contractValue: z.string().max(64).nullable().optional(),
    currency: zSignCurrencyCode.default('VND'),
    citations: z.array(zIncomingProposalCitation).max(20).default([]),
    obligations: z.array(zIncomingProposedObligation).max(20).default([]),
    depositProposal: zSignDepositProposal.nullable().optional(),
    proposedByAi: z.boolean().optional(),
  }),
  extractedPages: z.array(zExtractedPage).max(SIGN_MAX_PAGES).optional(),
});

function sanitizeIncomingProposal(
  raw: z.infer<typeof zObligationProposeCommandInput>['proposal'],
  pageCount: number | null,
  extractedPages: readonly { page: number; text: string }[] | undefined,
): SignObligationProposalContract {
  const maxPage = pageCount ?? SIGN_MAX_PAGES;
  const pageNormMap =
    extractedPages && extractedPages.length > 0
      ? new Map(extractedPages.map((p) => [p.page, normalizeSearchText(p.text)]))
      : null;

  const citationsByField = new Map<SignObligationCitationContract['field'], SignObligationCitationContract>();
  for (const c of raw.citations) {
    const field = stripFormatControl(c.field).trim();
    if (!CITATION_FIELD_SET.has(field)) continue;
    const typedField = field as SignObligationCitationContract['field'];
    if (citationsByField.has(typedField)) continue;
    if (c.pageNumber < 1 || c.pageNumber > maxPage) continue;
    const quoteExcerpt = cleanLine(c.quoteExcerpt, 1000);
    const normQuote = normalizeSearchText(quoteExcerpt);
    if (normQuote.length < 4) continue;
    if (pageNormMap && !(pageNormMap.get(c.pageNumber) ?? '').includes(normQuote)) continue;
    citationsByField.set(typedField, { field: typedField, pageNumber: c.pageNumber, quoteExcerpt });
  }

  const keptCitations: SignObligationCitationContract[] = [];

  let counterpartyName: string | null = null;
  if (raw.counterpartyName && raw.counterpartyName.trim().length > 0) {
    const cleaned = cleanLine(raw.counterpartyName, 300);
    const cite = citationsByField.get('counterpartyName');
    if (cleaned && cite && normalizeSearchText(cite.quoteExcerpt).includes(normalizeSearchText(cleaned))) {
      counterpartyName = cleaned;
      keptCitations.push(cite);
    }
  }

  let effectiveDate: string | null = null;
  if (raw.effectiveDate && isValidCalendarDate(raw.effectiveDate)) {
    const cite = citationsByField.get('effectiveDate');
    if (cite) {
      effectiveDate = raw.effectiveDate;
      keptCitations.push(cite);
    }
  }

  let expiryDate: string | null = null;
  if (
    raw.expiryDate &&
    isValidCalendarDate(raw.expiryDate) &&
    (effectiveDate === null || raw.expiryDate >= effectiveDate)
  ) {
    const cite = citationsByField.get('expiryDate');
    if (cite) {
      expiryDate = raw.expiryDate;
      keptCitations.push(cite);
    }
  }

  let renewalNoticeDays: number | null = null;
  if (raw.renewalNoticeDays !== null && raw.renewalNoticeDays !== undefined) {
    const cite = citationsByField.get('renewalNoticeDays');
    if (cite && raw.renewalNoticeDays >= 0 && raw.renewalNoticeDays <= 365) {
      renewalNoticeDays = raw.renewalNoticeDays;
      keptCitations.push(cite);
    }
  }

  let autoRenew = false;
  if (raw.autoRenew === true) {
    const cite = citationsByField.get('autoRenew');
    if (cite) {
      autoRenew = true;
      keptCitations.push(cite);
    }
  }

  let contractValue: string | null = null;
  if (raw.contractValue && raw.contractValue.trim().length > 0) {
    const cite = citationsByField.get('contractValue');
    if (cite) {
      try {
        const parsed = parseContractValueDecimal(raw.contractValue);
        if (parsed !== null) {
          contractValue = parsed;
          keptCitations.push(cite);
        }
      } catch {
        contractValue = null;
      }
    }
  }

  const obligations: SignObligationProposalContract['obligations'] = [];
  for (const [idx, item] of raw.obligations.entries()) {
    if (item.pageNumber < 1 || item.pageNumber > maxPage) continue;
    const title = cleanLine(item.title, 300);
    const quoteExcerpt = cleanLine(item.quoteExcerpt, 1000);
    const normQuote = normalizeSearchText(quoteExcerpt);
    if (!title || normQuote.length < 4) continue;
    if (pageNormMap && !(pageNormMap.get(item.pageNumber) ?? '').includes(normQuote)) continue;
    const dueDate = item.dueDate && isValidCalendarDate(item.dueDate) ? item.dueDate : null;
    const id = item.id ? cleanLine(item.id, 80) : `obl-${idx + 1}-p${item.pageNumber}`;
    obligations.push({
      id: id || `obl-${idx + 1}`,
      title,
      dueDate,
      status: 'pending',
      pageNumber: item.pageNumber,
      quoteExcerpt,
      proposedByAi: true,
    });
  }

  let depositProposal: SignDepositProposalContract | undefined;
  if (raw.depositProposal && raw.depositProposal.currency === 'VND') {
    const depPage = raw.depositProposal.pageNumber;
    const depQuote = cleanLine(raw.depositProposal.quoteExcerpt, 1000);
    const depNorm = normalizeSearchText(depQuote);
    if (
      depPage >= 1 &&
      depPage <= maxPage &&
      depNorm.length >= 4 &&
      (!pageNormMap || (pageNormMap.get(depPage) ?? '').includes(depNorm))
    ) {
      try {
        const depAmount = parseContractValueDecimal(raw.depositProposal.amount);
        const depDueDays =
          raw.depositProposal.dueDays !== null &&
          Number.isInteger(raw.depositProposal.dueDays) &&
          raw.depositProposal.dueDays >= 0 &&
          raw.depositProposal.dueDays <= 365
            ? raw.depositProposal.dueDays
            : null;
        if (depAmount !== null && new Decimal(depAmount).gt(0)) {
          depositProposal = {
            amount: depAmount,
            currency: 'VND',
            dueDays: depDueDays,
            pageNumber: depPage,
            quoteExcerpt: depQuote,
            proposedByAi: true,
          };
        }
      } catch {
        depositProposal = undefined;
      }
    }
  }

  return {
    counterpartyName,
    effectiveDate,
    expiryDate,
    renewalNoticeDays,
    autoRenew,
    contractValue,
    currency: raw.currency,
    citations: keptCitations,
    obligations,
    ...(depositProposal ? { depositProposal } : {}),
    proposedByAi: true,
  };
}

export const obligationPropose = defineCommand({
  name: 'sign.obligation.propose',
  input: zObligationProposeCommandInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [OBLIGATION_PROPOSE_WRITE],
  handler: async (ctx, input): Promise<SignEnvelopeObligationRecordContract> => {
    if (ctx.actor.type !== 'user' && ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Only workspace members or system workers can store obligation proposals');
    }
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'source_id', 'created_by', 'retained_org_visible', 'retained_reader_ids', 'page_count'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');
    if (env.status !== 'completed') {
      throw new DomainError(
        'SIGN_OBLIGATION_ENVELOPE_NOT_COMPLETED',
        409,
        'Post-signature obligations can only be proposed on completed envelopes',
      );
    }

    const primary = await resolvePrimaryEnvelopeDocMeta(ctx.trx, ctx.orgId, env);
    const sanitized = sanitizeIncomingProposal(input.proposal, primary.pageCount, input.extractedPages);
    const existing = await ctx.trx
      .selectFrom('ludy_sign.envelope_obligation')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .forUpdate()
      .executeTakeFirst();

    const now = new Date();
    const actorUserId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    let saved: ObligationDbRow | undefined;

    if (existing) {
      // Preserve human-confirmed status and confirmed terms until a human explicitly saves/confirms the new proposal.
      const nextStatus: SignObligationStatus = existing.status === 'confirmed' ? 'confirmed' : 'proposed';
      saved = await ctx.trx
        .updateTable('ludy_sign.envelope_obligation')
        .set({
          proposal_json: JSON.stringify(sanitized),
          prompt_version: cleanLine(input.promptVersion, 32) || 'v1',
          status: nextStatus,
          updated_at: now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirst();
    } else {
      saved = await ctx.trx
        .insertInto('ludy_sign.envelope_obligation')
        .values({
          org_id: ctx.orgId,
          envelope_id: env.id,
          proposal_json: JSON.stringify(sanitized),
          prompt_version: cleanLine(input.promptVersion, 32) || 'v1',
          status: 'proposed',
          created_by: actorUserId,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirst();
    }

    if (!saved) {
      throw new DomainError('INTERNAL', 500, 'Failed to persist obligation proposal');
    }
    ctx.audit({
      action: 'sign.obligation.propose',
      envelopeId: env.id,
      obligationStatus: saved.status,
      itemCount: sanitized.obligations.length,
    });
    return toObligationRecord(saved);
  },
});

export const obligationUpsert = defineCommand({
  name: 'sign.obligation.upsert',
  input: zSignObligationUpsertInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [OBLIGATION_UPSERT_WRITE],
  handler: async (ctx, input): Promise<SignEnvelopeObligationRecordContract> => {
    const userId = assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'source_id', 'created_by', 'retained_org_visible', 'retained_reader_ids', 'page_count'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');
    if (env.status !== 'completed') {
      throw new DomainError(
        'SIGN_OBLIGATION_ENVELOPE_NOT_COMPLETED',
        409,
        'Post-signature obligations can only be saved on completed envelopes',
      );
    }

    const effectiveDate = validateIsoCalendarDate(input.effectiveDate, 'effectiveDate');
    const expiryDate = validateIsoCalendarDate(input.expiryDate, 'expiryDate');
    if (effectiveDate !== null && expiryDate !== null && expiryDate < effectiveDate) {
      throw new DomainError(
        'SIGN_OBLIGATION_DATE_ORDER',
        422,
        'Expiry date must be on or after the effective date',
      );
    }

    const contractValue = parseContractValueDecimal(input.contractValue);
    const counterpartyName =
      input.counterpartyName && input.counterpartyName.trim().length > 0
        ? cleanLine(input.counterpartyName, 300)
        : null;
    const renewalNoticeDays = input.renewalNoticeDays ?? null;
    const currency = input.currency.toUpperCase();

    const existing = await ctx.trx
      .selectFrom('ludy_sign.envelope_obligation')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .forUpdate()
      .executeTakeFirst();

    const priorCompletedAtById = new Map<string, string | null>();
    if (existing) {
      for (const prev of parseStoredObligationItems(existing.obligations_json)) {
        priorCompletedAtById.set(prev.id, prev.completedAt);
      }
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const usedIds = new Set<string>();
    const primary = await resolvePrimaryEnvelopeDocMeta(ctx.trx, ctx.orgId, env);
    const maxPage = primary.pageCount ?? SIGN_MAX_PAGES;
    const obligations: SignObligationItemContract[] = input.obligations.map((item) => {
      let id = item.id ? cleanLine(item.id, 80) : '';
      if (!id || usedIds.has(id)) {
        id = `item-${randomUUID().slice(0, 8)}`;
      }
      usedIds.add(id);
      const dueDate = validateIsoCalendarDate(item.dueDate, 'dueDate');
      const status = item.status === 'completed' ? 'completed' : 'pending';
      const completedAt =
        status === 'completed' ? (priorCompletedAtById.get(id) ?? nowIso) : null;
      const pageNumber =
        item.pageNumber !== null &&
        item.pageNumber !== undefined &&
        item.pageNumber >= 1 &&
        item.pageNumber <= maxPage
          ? item.pageNumber
          : null;
      const quoteExcerpt =
        item.quoteExcerpt && item.quoteExcerpt.trim().length > 0
          ? cleanLine(item.quoteExcerpt, 1000)
          : null;
      return {
        id,
        title: cleanLine(item.title, 300),
        dueDate,
        status,
        completedAt,
        pageNumber,
        quoteExcerpt,
        proposedByAi: Boolean(item.proposedByAi),
      };
    });

    let saved: ObligationDbRow | undefined;
    if (existing) {
      saved = await ctx.trx
        .updateTable('ludy_sign.envelope_obligation')
        .set({
          counterparty_name: counterpartyName,
          effective_date: effectiveDate,
          expiry_date: expiryDate,
          renewal_notice_days: renewalNoticeDays,
          auto_renew: input.autoRenew,
          contract_value: contractValue,
          currency,
          obligations_json: JSON.stringify(obligations),
          proposal_json: null,
          status: 'confirmed',
          confirmed_by: userId,
          confirmed_at: now,
          updated_at: now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirst();
    } else {
      saved = await ctx.trx
        .insertInto('ludy_sign.envelope_obligation')
        .values({
          org_id: ctx.orgId,
          envelope_id: env.id,
          counterparty_name: counterpartyName,
          effective_date: effectiveDate,
          expiry_date: expiryDate,
          renewal_notice_days: renewalNoticeDays,
          auto_renew: input.autoRenew,
          contract_value: contractValue,
          currency,
          obligations_json: JSON.stringify(obligations),
          proposal_json: null,
          status: 'confirmed',
          confirmed_by: userId,
          confirmed_at: now,
          created_by: userId,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirst();
    }

    if (!saved) {
      throw new DomainError('INTERNAL', 500, 'Failed to save confirmed envelope obligations');
    }

    ctx.audit({
      action: 'sign.obligation.upsert',
      envelopeId: env.id,
      obligationStatus: 'confirmed',
      itemCount: obligations.length,
      autoRenew: input.autoRenew,
      hasContractValue: contractValue !== null,
      currency,
    });
    return toObligationRecord(saved);
  },
});

export const obligationDismissProposal = defineCommand({
  name: 'sign.obligation.dismiss_proposal',
  input: zSignObligationDismissInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [OBLIGATION_DISMISS_WRITE],
  handler: async (ctx, input) => {
    assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'source_id', 'created_by', 'retained_org_visible', 'retained_reader_ids'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');

    const existing = await ctx.trx
      .selectFrom('ludy_sign.envelope_obligation')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      return { envelopeId: env.id, dismissed: false, obligation: null };
    }

    const nextStatus: SignObligationStatus = existing.status === 'confirmed' ? 'confirmed' : 'dismissed';
    const updated = await ctx.trx
      .updateTable('ludy_sign.envelope_obligation')
      .set({
        proposal_json: null,
        status: nextStatus,
        updated_at: new Date(),
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirst();

    ctx.audit({
      action: 'sign.obligation.dismiss_proposal',
      envelopeId: env.id,
      obligationStatus: nextStatus,
    });
    return {
      envelopeId: env.id,
      dismissed: true,
      obligation: updated ? toObligationRecord(updated) : null,
    };
  },
});

export const obligationCompleteItem = defineCommand({
  name: 'sign.obligation.complete_item',
  input: zSignObligationCompleteItemInput.omit({ idempotencyKey: true }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  writes: [OBLIGATION_COMPLETE_ITEM_WRITE],
  handler: async (ctx, input): Promise<SignEnvelopeObligationRecordContract> => {
    assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'source_id', 'created_by', 'retained_org_visible', 'retained_reader_ids'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');

    const existing = await ctx.trx
      .selectFrom('ludy_sign.envelope_obligation')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .forUpdate()
      .executeTakeFirst();
    if (!existing || existing.status !== 'confirmed') {
      throw new DomainError('SIGN_OBLIGATION_NOT_FOUND', 404, 'Confirmed envelope obligations not found');
    }

    const items = parseStoredObligationItems(existing.obligations_json);
    const targetIdx = items.findIndex((it) => it.id === input.itemId);
    if (targetIdx < 0) {
      throw new DomainError('SIGN_OBLIGATION_ITEM_NOT_FOUND', 404, 'Obligation item not found');
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const nextItems: SignObligationItemContract[] = items.map((it, idx) =>
      idx === targetIdx
        ? {
            ...it,
            status: input.completed ? 'completed' : 'pending',
            completedAt: input.completed ? nowIso : null,
          }
        : it,
    );

    const updated = await ctx.trx
      .updateTable('ludy_sign.envelope_obligation')
      .set({
        obligations_json: JSON.stringify(nextItems),
        updated_at: now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      throw new DomainError('INTERNAL', 500, 'Failed to update obligation item');
    }

    ctx.audit({
      action: 'sign.obligation.complete_item',
      envelopeId: env.id,
      itemId: input.itemId,
      completed: input.completed,
    });
    return toObligationRecord(updated);
  },
});

export const obligationGet = defineQuery({
  name: 'sign.obligation.get',
  input: z.strictObject({ envelopeId: zId }),
  access: READERS,
  handler: async (ctx, input) => {
    assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'source_id', 'created_by', 'retained_org_visible', 'retained_reader_ids'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Signing envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env, 'Signing envelope not found');
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env, 'Signing envelope not found');

    const row = await ctx.trx
      .selectFrom('ludy_sign.envelope_obligation')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .executeTakeFirst();

    return {
      obligation: row ? toObligationRecord(row) : null,
      canEdit: ctx.role === 'owner' || ctx.role === 'admin' || ctx.role === 'member',
    };
  },
});

export const obligationSource = defineQuery({
  name: 'sign.obligation.source',
  input: z.strictObject({ envelopeId: zId }),
  access: WRITERS,
  handler: async (ctx, input): Promise<SignObligationSource> => {
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select([
        'id',
        'status',
        'source_kind',
        'source_id',
        'created_by',
        'retained_org_visible',
        'retained_reader_ids',
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

    // Refresh Doc 1 file/hash/page metadata from envelope_document so removing the original Doc 1 in a draft packet
    // does not leave obligation extraction pinned to stale envelope.source_* columns (#4837).
    const doc1 = await ctx.trx
      .selectFrom('ludy_sign.envelope_document')
      .select(['file_id', 'storage_key', 'generation', 'source_sha256', 'inspect_status', 'page_count'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .orderBy('doc_index', 'asc')
      .orderBy('id', 'asc')
      .executeTakeFirst();

    return {
      envelopeId: env.id,
      status: env.status,
      inspectStatus: doc1 ? doc1.inspect_status : env.inspect_status,
      sourceSha256: doc1 ? doc1.source_sha256 : env.source_sha256,
      sourceFileId: doc1 ? doc1.file_id : env.source_file_id,
      sourceStorageKey: doc1 ? doc1.storage_key : env.source_storage_key,
      sourceGeneration: doc1 ? doc1.generation : env.source_generation,
      title: cleanLine(env.title, 300),
      pageCount: doc1 ? doc1.page_count : env.page_count,
      aiStopped: await isSignAiStoppedOnTrx(ctx.trx, ctx.orgId),
    };
  },
});

export function summarizeObligationUrgency(
  obligation: SignEnvelopeObligationRecordContract,
  todayVn: string,
): {
  renewalNoticeDate: string | null;
  daysUntilNotice: number | null;
  daysUntilExpiry: number | null;
  pendingObligationCount: number;
  overdueObligationCount: number;
  nextObligationDueDate: string | null;
  urgencyRank: number;
  urgencyDayEpoch: number;
} {
  const todayEpoch = dayEpochDays(todayVn);
  let renewalNoticeDate: string | null = null;
  let daysUntilNotice: number | null = null;
  let daysUntilExpiry: number | null = null;

  if (obligation.expiryDate !== null) {
    const noticeDays = obligation.renewalNoticeDays ?? 0;
    renewalNoticeDate = addDaysIso(obligation.expiryDate, -noticeDays);
    daysUntilNotice = dayEpochDays(renewalNoticeDate) - todayEpoch;
    daysUntilExpiry = dayEpochDays(obligation.expiryDate) - todayEpoch;
  }

  let pendingObligationCount = 0;
  let overdueObligationCount = 0;
  let nextObligationDueDate: string | null = null;
  let earliestPendingEpoch = Number.POSITIVE_INFINITY;

  for (const item of obligation.obligations) {
    if (item.status !== 'pending') continue;
    pendingObligationCount += 1;
    if (item.dueDate !== null) {
      const dueEpoch = dayEpochDays(item.dueDate);
      if (dueEpoch < todayEpoch) {
        overdueObligationCount += 1;
      }
      if (dueEpoch < earliestPendingEpoch) {
        earliestPendingEpoch = dueEpoch;
        nextObligationDueDate = item.dueDate;
      }
    }
  }

  let urgencyRank = 4;
  if (overdueObligationCount > 0 || (daysUntilExpiry !== null && daysUntilExpiry >= 0 && daysUntilNotice !== null && daysUntilNotice <= 0)) {
    urgencyRank = 0;
  } else if (
    (daysUntilExpiry !== null && daysUntilExpiry >= 0 && daysUntilNotice !== null && daysUntilNotice <= RENEWAL_NOTICE_ALERT_WINDOW_DAYS) ||
    (Number.isFinite(earliestPendingEpoch) && earliestPendingEpoch - todayEpoch <= OBLIGATION_DUE_SOON_DAYS)
  ) {
    urgencyRank = 1;
  } else if (pendingObligationCount > 0 || (daysUntilExpiry !== null && daysUntilExpiry >= 0)) {
    urgencyRank = 2;
  }

  const noticeEpoch = renewalNoticeDate !== null ? dayEpochDays(renewalNoticeDate) : Number.POSITIVE_INFINITY;
  const urgencyDayEpoch = Math.min(earliestPendingEpoch, noticeEpoch);

  return {
    renewalNoticeDate,
    daysUntilNotice,
    daysUntilExpiry,
    pendingObligationCount,
    overdueObligationCount,
    nextObligationDueDate,
    urgencyRank,
    urgencyDayEpoch,
  };
}

export const obligationRenewalsList = defineQuery({
  name: 'sign.obligation.renewals_list',
  input: zSignObligationRenewalsListInput,
  access: READERS,
  handler: async (ctx, input): Promise<{ items: SignObligationRenewalListItem[] }> => {
    const actorUserId = assertUser(ctx);
    const limit = input.limit ?? 50;
    const todayVn = vietnamToday(new Date());

    let q = ctx.trx
      .selectFrom('ludy_sign.envelope_obligation as o')
      .innerJoin('ludy_sign.envelope as e', (join) =>
        join.onRef('e.org_id', '=', 'o.org_id').onRef('e.id', '=', 'o.envelope_id'),
      )
      .selectAll('o')
      .select([
        'e.title as env_title',
        'e.status as env_status',
        'e.routing_mode as env_routing_mode',
        'e.source_kind as env_source_kind',
        'e.source_id as env_source_id',
        'e.source_file_id as env_source_file_id',
        'e.inspect_status as env_inspect_status',
        'e.seal_status as env_seal_status',
        'e.certificate_code as env_certificate_code',
        'e.page_count as env_page_count',
        'e.expires_at as env_expires_at',
        'e.sent_at as env_sent_at',
        'e.completed_at as env_completed_at',
        'e.voided_at as env_voided_at',
        'e.expired_at as env_expired_at',
        'e.version as env_version',
        'e.created_by as env_created_by',
        'e.created_at as env_created_at',
        'e.updated_at as env_updated_at',
      ])
      .where('o.org_id', '=', ctx.orgId)
      .where('o.status', '=', 'confirmed')
      .where('e.status', '=', 'completed');

    if (!isHrPrivilegedRole(ctx.role)) {
      q = q.where((eb) =>
        eb.or([eb('e.source_kind', '!=', 'hr_contract'), eb('e.created_by', '=', actorUserId)]),
      );
    }
    q = q.where((eb) =>
      eb.or([
        eb('e.source_kind', '!=', 'meeting_minutes'),
        sql<boolean>`ludy_sign.can_access_meeting_minutes_envelope_row(${eb.ref('e.org_id')}, ${eb.ref('e.source_id')}, ${eb.ref('e.created_by')}, ${eb.ref('e.status')}, ${eb.ref('e.retained_org_visible')}, ${eb.ref('e.retained_reader_ids')})`,
      ]),
    );

    const joinedRows = await q
      .orderBy(
        sql`CASE
          WHEN o.obligations_json @> '[{"status":"pending"}]'::jsonb THEN 0
          WHEN o.expiry_date IS NOT NULL AND o.expiry_date >= ${todayVn}::date THEN 1
          ELSE 2
        END`,
        'asc',
      )
      .orderBy(sql`(o.expiry_date - COALESCE(o.renewal_notice_days, 0)) ASC NULLS FIRST`)
      .orderBy('o.updated_at', 'desc')
      .orderBy('e.id', 'asc')
      .limit(200)
      .execute();

    const accessibleRows = joinedRows.filter((r) =>
      canAccessEnvelopeRow(ctx, { source_kind: r.env_source_kind, created_by: r.env_created_by }),
    );
    if (accessibleRows.length === 0) {
      return { items: [] };
    }

    const accessibleIds = accessibleRows.map((r) => r.envelope_id);
    const [signerRows, primaryDocByEnvelope] = await Promise.all([
      ctx.trx
        .selectFrom('ludy_sign.signer')
        .select(['envelope_id', 'status'])
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', 'in', accessibleIds)
        .where('signer_role', '!=', 'cc')
        .execute(),
      resolvePrimaryEnvelopeDocMap(ctx.trx, ctx.orgId, accessibleIds),
    ]);

    const summaryByEnvelope = new Map<string, { total: number; signed: number }>();
    for (const signer of signerRows) {
      let entry = summaryByEnvelope.get(signer.envelope_id);
      if (!entry) {
        entry = { total: 0, signed: 0 };
        summaryByEnvelope.set(signer.envelope_id, entry);
      }
      entry.total += 1;
      if (signer.status === 'signed') entry.signed += 1;
    }

    const ranked: Array<{ rank: number; dayEpoch: number; item: SignObligationRenewalListItem }> = [];
    for (const row of accessibleRows) {
      const obligation = toObligationRecord(row);
      const summary = summarizeObligationUrgency(obligation, todayVn);
      const counts = summaryByEnvelope.get(row.envelope_id);
      const primary = primaryDocByEnvelope.get(row.envelope_id);
      ranked.push({
        rank: summary.urgencyRank,
        dayEpoch: summary.urgencyDayEpoch,
        item: {
          envelope: {
            id: row.envelope_id,
            title: row.env_title,
            status: row.env_status,
            routingMode: row.env_routing_mode,
            sourceKind: row.env_source_kind,
            sourceId: row.env_source_id,
            sourceFileId: primary?.fileId ?? row.env_source_file_id,
            inspectStatus: primary?.inspectStatus ?? row.env_inspect_status,
            sealStatus: row.env_seal_status,
            certificateCode: row.env_certificate_code,
            pageCount: primary?.pageCount ?? row.env_page_count,
            expiresAt: isoOrNull(row.env_expires_at),
            sentAt: isoOrNull(row.env_sent_at),
            completedAt: isoOrNull(row.env_completed_at),
            voidedAt: isoOrNull(row.env_voided_at),
            expiredAt: isoOrNull(row.env_expired_at),
            version: row.env_version,
            createdBy: row.env_created_by,
            createdAt: new Date(row.env_created_at).toISOString(),
            updatedAt: new Date(row.env_updated_at).toISOString(),
            signerSummary: {
              total: counts?.total ?? 0,
              signed: counts?.signed ?? 0,
              waitingForMe: false,
            },
          },
          obligation,
          renewalNoticeDate: summary.renewalNoticeDate,
          daysUntilNotice: summary.daysUntilNotice,
          daysUntilExpiry: summary.daysUntilExpiry,
          pendingObligationCount: summary.pendingObligationCount,
          overdueObligationCount: summary.overdueObligationCount,
          nextObligationDueDate: summary.nextObligationDueDate,
        },
      });
    }

    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.dayEpoch === b.dayEpoch ? 0 : a.dayEpoch < b.dayEpoch ? -1 : 1) ||
        (a.item.envelope.id < b.item.envelope.id ? -1 : a.item.envelope.id > b.item.envelope.id ? 1 : 0),
    );

    return { items: ranked.slice(0, limit).map((r) => r.item) };
  },
});

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pure deterministic projection of human-confirmed completed-envelope obligations into Home TodayItems.
 * Emits zero free text in title params (numeric days/count only) so no contract text reaches Vy's Home brief prompt.
 * Viewers cannot mutate obligations and receive no actionable items.
 */
export function signObligationsTodayItemsOf(
  rows: readonly SignObligationTodayRow[],
  options: { role: MemberRole | null; now: Date; totalCount?: number | undefined },
): TodayItem[] {
  if (options.role === null || options.role === 'viewer') return [];
  const todayVn = vietnamToday(options.now);
  const todayEpoch = dayEpochDays(todayVn);

  interface PrioritizedSignItem {
    priority: number;
    dayEpoch: number;
    envelopeId: string;
    item: TodayItem;
  }

  const prioritized: PrioritizedSignItem[] = [];

  for (const row of rows) {
    const href = `/sign/envelopes/${row.envelopeId}`;
    const amountFields =
      row.contractValue !== null
        ? { amount: toMoney(money(row.contractValue)), currency: row.currency }
        : {};

    if (row.expiryDate !== null && isValidCalendarDate(row.expiryDate)) {
      const noticeDays = row.renewalNoticeDays ?? 0;
      const noticeDate = addDaysIso(row.expiryDate, -noticeDays);
      const noticeEpoch = dayEpochDays(noticeDate);
      const expiryEpoch = dayEpochDays(row.expiryDate);
      const daysUntilNotice = noticeEpoch - todayEpoch;
      const daysUntilExpiry = expiryEpoch - todayEpoch;

      if (daysUntilExpiry >= 0 && daysUntilNotice <= RENEWAL_NOTICE_ALERT_WINDOW_DAYS) {
        if (daysUntilNotice <= 0) {
          prioritized.push({
            priority: 1,
            dayEpoch: expiryEpoch,
            envelopeId: row.envelopeId,
            item: {
              kind: 'flag',
              app: 'sign',
              id: `obligation-renewal:${row.envelopeId}`,
              title:
                daysUntilExpiry === 0
                  ? { key: 'sign.obligationExpiryToday', params: {} }
                  : { key: 'sign.obligationRenewalWindowOpen', params: { days: daysUntilExpiry } },
              severity: 'warn',
              dueAt: `${row.expiryDate}T09:00:00+07:00`,
              ...amountFields,
              href,
            },
          });
        } else {
          prioritized.push({
            priority: 4,
            dayEpoch: noticeEpoch,
            envelopeId: row.envelopeId,
            item: {
              kind: 'deadline',
              app: 'sign',
              id: `obligation-renewal:${row.envelopeId}`,
              title: { key: 'sign.obligationRenewalSoon', params: { days: daysUntilNotice } },
              severity: daysUntilNotice <= 7 ? 'warn' : 'info',
              dueAt: `${noticeDate}T09:00:00+07:00`,
              ...amountFields,
              href,
            },
          });
        }
      }
    }

    for (const item of row.obligations) {
      if (item.status !== 'pending' || item.dueDate === null || !isValidCalendarDate(item.dueDate)) {
        continue;
      }
      const dueEpoch = dayEpochDays(item.dueDate);
      const daysUntilDue = dueEpoch - todayEpoch;
      const dueAt = `${item.dueDate}T09:00:00+07:00`;

      if (daysUntilDue < 0) {
        prioritized.push({
          priority: 0,
          dayEpoch: dueEpoch,
          envelopeId: row.envelopeId,
          item: {
            kind: 'flag',
            app: 'sign',
            id: `obligation-item:${row.envelopeId}:${item.id}`,
            title: { key: 'sign.obligationOverdueDays', params: { days: -daysUntilDue } },
            severity: 'warn',
            dueAt,
            href,
          },
        });
      } else if (daysUntilDue === 0) {
        prioritized.push({
          priority: 2,
          dayEpoch: dueEpoch,
          envelopeId: row.envelopeId,
          item: {
            kind: 'deadline',
            app: 'sign',
            id: `obligation-item:${row.envelopeId}:${item.id}`,
            title: { key: 'sign.obligationDueToday', params: {} },
            severity: 'warn',
            dueAt,
            href,
          },
        });
      } else if (daysUntilDue <= OBLIGATION_DUE_SOON_DAYS) {
        prioritized.push({
          priority: 3,
          dayEpoch: dueEpoch,
          envelopeId: row.envelopeId,
          item: {
            kind: 'deadline',
            app: 'sign',
            id: `obligation-item:${row.envelopeId}:${item.id}`,
            title: { key: 'sign.obligationDueSoon', params: { days: daysUntilDue } },
            severity: 'info',
            dueAt,
            href,
          },
        });
      }
    }
  }

  prioritized.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.dayEpoch - b.dayEpoch ||
      byText(a.envelopeId, b.envelopeId) ||
      byText(a.item.id, b.item.id),
  );

  const items = prioritized.map((p) => p.item);
  const totalCount = Math.max(items.length, options.totalCount ?? 0);
  if (totalCount <= TODAY_ITEMS_MAX) {
    return zTodayItems.parse(items);
  }

  const head = items.slice(0, TODAY_ITEMS_MAX - 1);
  const overflow = totalCount - head.length;
  return zTodayItems.parse([
    ...head,
    {
      kind: 'flag',
      app: 'sign',
      id: 'obligations:more',
      title: { key: 'sign.obligationMore', params: { count: overflow } },
      count: overflow,
      severity: 'warn',
      href: '/sign/envelopes',
    },
  ]);
}

export const signObligationsToday = defineQuery({
  name: 'sign.obligations.today',
  input: z.object({ now: z.iso.datetime({ offset: true }).optional() }),
  access: ALL_ROLES,
  handler: async (ctx, input): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user' || ctx.role === null || ctx.role === 'viewer') return [];
    const userId = ctx.actor.userId;
    const now = input.now ? new Date(input.now) : new Date();
    const todayVn = vietnamToday(now);
    const noticeHorizonVn = addDaysIso(todayVn, RENEWAL_NOTICE_ALERT_WINDOW_DAYS);

    let q = ctx.trx
      .selectFrom('ludy_sign.envelope_obligation as o')
      .innerJoin('ludy_sign.envelope as e', (join) =>
        join.onRef('e.org_id', '=', 'o.org_id').onRef('e.id', '=', 'o.envelope_id'),
      )
      .select([
        'e.id as envelopeId',
        'e.source_kind as sourceKind',
        'e.created_by as createdBy',
        'o.expiry_date as expiryDate',
        'o.renewal_notice_days as renewalNoticeDays',
        'o.auto_renew as autoRenew',
        'o.contract_value as contractValue',
        'o.currency as currency',
        'o.obligations_json as obligationsJson',
      ])
      .where('o.org_id', '=', ctx.orgId)
      .where('o.status', '=', 'confirmed')
      .where('e.status', '=', 'completed')
      .where((eb) =>
        eb.or([
          sql<boolean>`(o.expiry_date >= ${todayVn}::date AND (o.expiry_date - COALESCE(o.renewal_notice_days, 0)) <= ${noticeHorizonVn}::date)`,
          sql<boolean>`o.obligations_json @> '[{"status":"pending"}]'::jsonb`,
        ]),
      );

    if (!isHrPrivilegedRole(ctx.role)) {
      q = q.where((eb) =>
        eb.or([eb('e.source_kind', '!=', 'hr_contract'), eb('e.created_by', '=', userId)]),
      );
    }
    q = q.where((eb) =>
      eb.or([
        eb('e.source_kind', '!=', 'meeting_minutes'),
        sql<boolean>`ludy_sign.can_access_meeting_minutes_envelope_row(${eb.ref('e.org_id')}, ${eb.ref('e.source_id')}, ${eb.ref('e.created_by')}, ${eb.ref('e.status')}, ${eb.ref('e.retained_org_visible')}, ${eb.ref('e.retained_reader_ids')})`,
      ]),
    );

    const rows = await q
      .orderBy(
        sql`CASE WHEN o.obligations_json @> '[{"status":"pending"}]'::jsonb THEN 0 ELSE 1 END`,
        'asc',
      )
      .orderBy(sql`(o.expiry_date - COALESCE(o.renewal_notice_days, 0)) ASC NULLS FIRST`)
      .orderBy('o.updated_at', 'desc')
      .orderBy('e.id', 'asc')
      .limit(OBLIGATION_TODAY_ROW_LIMIT)
      .execute();

    if (rows.length === 0) return [];

    let totalCount: number | undefined;
    if (rows.length === OBLIGATION_TODAY_ROW_LIMIT) {
      const dueHorizonVn = addDaysIso(todayVn, OBLIGATION_DUE_SOON_DAYS);
      const countRow = await q
        .clearSelect()
        .select(
          sql<string>`COALESCE(SUM(
            (CASE WHEN o.expiry_date >= ${todayVn}::date AND (o.expiry_date - COALESCE(o.renewal_notice_days, 0)) <= ${noticeHorizonVn}::date THEN 1 ELSE 0 END)
            + COALESCE((
              SELECT pg_catalog.count(*)::int
              FROM pg_catalog.jsonb_array_elements(o.obligations_json) AS elem
              WHERE elem->>'status' = 'pending'
                AND CASE
                  WHEN elem->>'dueDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN CASE
                    WHEN pg_catalog.substring(elem->>'dueDate', 1, 4)::int >= 1
                    THEN CASE
                      WHEN pg_catalog.substring(elem->>'dueDate', 6, 2)::int IN (1, 3, 5, 7, 8, 10, 12)
                        AND pg_catalog.substring(elem->>'dueDate', 9, 2)::int BETWEEN 1 AND 31
                        THEN (elem->>'dueDate')::date <= ${dueHorizonVn}::date
                      WHEN pg_catalog.substring(elem->>'dueDate', 6, 2)::int IN (4, 6, 9, 11)
                        AND pg_catalog.substring(elem->>'dueDate', 9, 2)::int BETWEEN 1 AND 30
                        THEN (elem->>'dueDate')::date <= ${dueHorizonVn}::date
                      WHEN pg_catalog.substring(elem->>'dueDate', 6, 2)::int = 2
                        AND pg_catalog.substring(elem->>'dueDate', 9, 2)::int BETWEEN 1 AND (
                          CASE
                            WHEN (pg_catalog.substring(elem->>'dueDate', 1, 4)::int % 4 = 0 AND pg_catalog.substring(elem->>'dueDate', 1, 4)::int % 100 <> 0)
                              OR (pg_catalog.substring(elem->>'dueDate', 1, 4)::int % 400 = 0)
                            THEN 29
                            ELSE 28
                          END
                        )
                        THEN (elem->>'dueDate')::date <= ${dueHorizonVn}::date
                      ELSE false
                    END
                    ELSE false
                  END
                  ELSE false
                END
            ), 0)
          ), 0)::text`.as('total'),
        )
        .executeTakeFirst();
      totalCount = Number(countRow?.total ?? 0);
    }

    const todayRows: SignObligationTodayRow[] = [];
    for (const r of rows) {
      if (!canAccessEnvelopeRow(ctx, { source_kind: r.sourceKind, created_by: r.createdBy })) {
        continue;
      }
      const rawCurrency = typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : '';
      todayRows.push({
        envelopeId: r.envelopeId,
        sourceKind: r.sourceKind,
        createdBy: r.createdBy,
        expiryDate: dateOrNull(r.expiryDate),
        renewalNoticeDays: r.renewalNoticeDays ?? null,
        autoRenew: Boolean(r.autoRenew),
        contractValue: formatStoredContractDecimal(r.contractValue),
        currency: /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'VND',
        obligations: parseStoredObligationItems(r.obligationsJson),
      });
    }

    return signObligationsTodayItemsOf(todayRows, {
      role: ctx.role,
      now,
      ...(totalCount === undefined ? {} : { totalCount }),
    });
  },
});

export const signObligationCommands = [
  obligationPropose,
  obligationUpsert,
  obligationDismissProposal,
  obligationCompleteItem,
];

export const signObligationQueries = [
  obligationGet,
  obligationSource,
  obligationRenewalsList,
  signObligationsToday,
];

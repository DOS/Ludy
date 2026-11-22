// SPDX-License-Identifier: AGPL-3.0-only
// Permission-scoped Contract Vault deterministic search for eSign Slice 5a (#4439).
// Strictly enforces org_app_on(org_id, 'sign'), hr_contract confidentiality (owner, admin, or created_by only),
// and ADR-0047 meeting_minutes reader visibility (both in SQL WHERE and JS defense-in-depth).
// Searches ONLY human-confirmed obligations (o.status = 'confirmed'; unconfirmed proposal_json is never read),
// completed AI clause summaries, sender shared summaries, and envelope titles/subjects, with 100% AI-off parity.
import { sql } from 'kysely';
import type { MemberRole, SignEnvelopeStatus, SignSourceKind } from '@ludy/db';
import {
  SIGN_MAX_PAGES,
  SIGN_VAULT_CANDIDATES_MAX,
  zSignVaultSearchInput,
  type SignVaultMatchItem,
  type SignVaultMatchSnippet,
  type SignVaultSearchResult,
  type SignVaultSnippetKind,
} from '@ludy/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { isValidCalendarDate, money, toMoney } from '@ludy/l10n-vn';
import { applyEnvelopeVisibilityFilter, canAccessEnvelopeRow } from './hr-visibility.ts';
import { applyMeetingMinutesVisibilityFilter } from './meeting-visibility.ts';
import { parseSharedSummary } from './shared.ts';

const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const SIGN_VAULT_SCAN_LIMIT = 200;
const SNIPPET_EXCERPT_MAX = 400;
const SNIPPETS_PER_ENVELOPE_MAX = 6;
const FORMAT_CONTROL_RE = /\p{Cf}+/gu;

const STOP_WORDS: ReadonlySet<string> = new Set([
  'hop',
  'dong',
  'nao',
  'la',
  'gi',
  'co',
  'cua',
  'trong',
  'cho',
  'voi',
  'nhung',
  'cac',
  'bao',
  'nhieu',
  'khi',
  'o',
  'dau',
  've',
  'va',
  'hay',
  'hoac',
  'duoc',
  'da',
  'dang',
  'se',
  'nay',
  'do',
  'mot',
  'tim',
  'kiem',
  'hoi',
  'vy',
  'kho',
  'ho',
  'so',
  'dieu',
  'khoan',
  'muc',
  'quy',
  'dinh',
  'theo',
  'ben',
  'which',
  'what',
  'where',
  'when',
  'who',
  'how',
  'many',
  'much',
  'are',
  'is',
  'was',
  'were',
  'the',
  'this',
  'that',
  'these',
  'those',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'about',
  'into',
  'any',
  'all',
  'our',
  'contract',
  'contracts',
  'agreement',
  'agreements',
  'envelope',
  'envelopes',
  'clause',
  'clauses',
  'term',
  'terms',
]);

const RENEWAL_INTENT_TOKENS: ReadonlySet<string> = new Set([
  'gia',
  'han',
  'het',
  'hieu',
  'luc',
  'bao',
  'truoc',
  'tu',
  'quy',
  'thang',
  'nam',
  'sap',
  'expire',
  'expires',
  'expiring',
  'expiry',
  'expiration',
  'renew',
  'renewal',
  'renews',
  'auto',
  'quarter',
  'month',
  'year',
  'notice',
  'soon',
]);

const VALUE_INTENT_TOKENS: ReadonlySet<string> = new Set([
  'gia',
  'tri',
  'value',
  'amount',
  'total',
  'vnd',
  'usd',
]);

const OBLIGATION_INTENT_TOKENS: ReadonlySet<string> = new Set([
  'nghia',
  'vu',
  'ban',
  'giao',
  'nghiem',
  'thu',
  'chot',
  'cam',
  'ket',
  'obligation',
  'obligations',
  'deliverable',
  'deliverables',
  'milestone',
  'due',
  'overdue',
  'deadline',
]);

export interface SignVaultCandidateInput {
  envelopeId: string;
  title: string;
  subject: string | null;
  status: SignEnvelopeStatus;
  sourceKind: SignSourceKind;
  pageCount: number | null;
  completedAt: string | null;
  updatedAt: string;
  sharedSummaryJson: unknown;
  obligation: {
    counterpartyName: string | null;
    effectiveDate: string | null;
    expiryDate: string | null;
    renewalNoticeDays: number | null;
    autoRenew: boolean;
    contractValue: string | null;
    currency: string | null;
    obligationsJson: unknown;
  } | null;
  analysis: {
    summaryText: string | null;
    riskClausesJson: unknown;
  } | null;
}

function stripFormatControl(value: string): string {
  return value.replace(FORMAT_CONTROL_RE, '');
}

function cleanExcerpt(value: string, max = SNIPPET_EXCERPT_MAX): string {
  const one = stripFormatControl(value)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(one);
  return points.length <= max ? one : points.slice(0, max).join('').trimEnd();
}

export function foldVaultSearchText(value: string): string {
  return stripFormatControl(value.normalize('NFKC'))
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeExactText(value: string): string {
  return stripFormatControl(value.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ParsedVaultQuery {
  exactPhrase: string;
  foldedPhrase: string;
  exactTokens: string[];
  foldedTokens: string[];
  entityFoldedTokens: string[];
  hasRenewalIntent: boolean;
  hasValueIntent: boolean;
  hasObligationIntent: boolean;
}

export function parseSignVaultQuery(question: string): ParsedVaultQuery {
  const exactPhrase = normalizeExactText(question);
  const foldedPhrase = foldVaultSearchText(question);
  const rawExact = exactPhrase ? exactPhrase.split(' ').filter((t) => t.length >= 2) : [];
  const rawFolded = foldedPhrase ? foldedPhrase.split(' ').filter((t) => t.length >= 2) : [];

  const hasRenewalPhrase =
    /\b(?:het han|gia han|bao truoc|tu dong gia han|sap den han|expir|renew|auto renew|this quarter|quy nay|thang nay)\b/.test(
      foldedPhrase,
    );
  const hasValuePhrase =
    /\b(?:gia tri|thanh toan|phat cham|tien phat|dat coc|tam ung|contract value|payment|penalty|late fee)\b/.test(
      foldedPhrase,
    );
  const hasObligationPhrase =
    /\b(?:nghia vu|ban giao|nghiem thu|qua han|han chot|obligation|deliverable|milestone|overdue|due date)\b/.test(
      foldedPhrase,
    );

  const nonStopExact: string[] = [];
  const nonStopFolded: string[] = [];
  for (let i = 0; i < rawFolded.length; i += 1) {
    const ft = rawFolded[i]!;
    const et = rawExact[i] ?? ft;
    if (!STOP_WORDS.has(ft)) {
      nonStopFolded.push(ft);
      nonStopExact.push(et);
    }
  }

  const exactTokens = [...new Set(nonStopExact.length > 0 ? nonStopExact : rawExact)];
  const foldedTokens = [...new Set(nonStopFolded.length > 0 ? nonStopFolded : rawFolded)];

  const hasRenewalIntent =
    hasRenewalPhrase || foldedTokens.some((t) => RENEWAL_INTENT_TOKENS.has(t));
  const hasValueIntent =
    hasValuePhrase || foldedTokens.some((t) => VALUE_INTENT_TOKENS.has(t));
  const hasObligationIntent =
    hasObligationPhrase || foldedTokens.some((t) => OBLIGATION_INTENT_TOKENS.has(t));

  const entityFoldedTokens = foldedTokens.filter(
    (t) =>
      !RENEWAL_INTENT_TOKENS.has(t) &&
      !VALUE_INTENT_TOKENS.has(t) &&
      !OBLIGATION_INTENT_TOKENS.has(t),
  );

  return {
    exactPhrase,
    foldedPhrase,
    exactTokens,
    foldedTokens,
    entityFoldedTokens,
    hasRenewalIntent,
    hasValueIntent,
    hasObligationIntent,
  };
}

function formatMoneySafe(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    return toMoney(money(trimmed));
  } catch {
    return null;
  }
}

function dateOrNull(raw: Date | string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = String(raw).trim().slice(0, 10);
  return isValidCalendarDate(s) ? s : null;
}

function isoOrNull(raw: Date | string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return new Date(raw).toISOString();
}

function parseJsonSafe(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return raw;
}

function validPage(value: unknown, maxPage: number | null): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  const cap = maxPage ?? SIGN_MAX_PAGES;
  return value <= cap ? value : null;
}

interface SearchableSegment {
  kind: SignVaultSnippetKind;
  pageNumber: number | null;
  excerpt: string;
  searchText: string;
  weight: number;
  intentTag: 'renewal' | 'value' | 'obligation' | 'general';
}

function buildSearchableSegments(cand: SignVaultCandidateInput): SearchableSegment[] {
  const segments: SearchableSegment[] = [];
  const cleanTitle = cleanExcerpt(cand.title, 300);
  if (cleanTitle) {
    const subj = cand.subject ? cleanExcerpt(cand.subject, 200) : '';
    segments.push({
      kind: 'title',
      pageNumber: null,
      excerpt: cleanTitle,
      searchText: subj ? `${cleanTitle} ${subj}` : cleanTitle,
      weight: 2,
      intentTag: 'general',
    });
  }

  const obl = cand.obligation;
  if (obl) {
    if (obl.counterpartyName) {
      const cp = cleanExcerpt(obl.counterpartyName, 300);
      if (cp) {
        segments.push({
          kind: 'counterparty',
          pageNumber: null,
          excerpt: cp,
          searchText: cp,
          weight: 2,
          intentTag: 'general',
        });
      }
    }

    const termParts: string[] = [];
    if (obl.effectiveDate) termParts.push(`effective ${obl.effectiveDate}`);
    if (obl.expiryDate) termParts.push(`expiry ${obl.expiryDate}`);
    if (obl.renewalNoticeDays !== null) termParts.push(`notice ${obl.renewalNoticeDays} days`);
    if (obl.autoRenew) termParts.push('auto-renew true');
    const formattedVal = formatMoneySafe(obl.contractValue);
    if (formattedVal) termParts.push(`value ${formattedVal} ${obl.currency ?? 'VND'}`);

    if (termParts.length > 0) {
      const termSummary = cleanExcerpt(termParts.join(' | '), SNIPPET_EXCERPT_MAX);
      segments.push({
        kind: 'obligation',
        pageNumber: null,
        excerpt: termSummary,
        searchText: termSummary,
        weight: 2,
        intentTag: obl.expiryDate || obl.autoRenew || obl.renewalNoticeDays !== null ? 'renewal' : 'value',
      });
    }

    const items = parseJsonSafe(obl.obligationsJson);
    if (Array.isArray(items)) {
      for (const rawItem of items) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const rec = rawItem as Record<string, unknown>;
        const title = typeof rec.title === 'string' ? cleanExcerpt(rec.title, 260) : '';
        if (!title) continue;
        const due = typeof rec.dueDate === 'string' && isValidCalendarDate(rec.dueDate.trim()) ? rec.dueDate.trim() : null;
        const status = rec.status === 'completed' ? 'completed' : 'pending';
        const quote = typeof rec.quoteExcerpt === 'string' ? cleanExcerpt(rec.quoteExcerpt, 300) : '';
        const pageNumber = validPage(rec.pageNumber, cand.pageCount);
        const excerpt = quote
          ? quote
          : cleanExcerpt(`${title}${due ? ` (${due}, ${status})` : ` (${status})`}`, SNIPPET_EXCERPT_MAX);
        segments.push({
          kind: 'obligation',
          pageNumber,
          excerpt,
          searchText: `${title} ${due ?? ''} ${status} ${quote}`,
          weight: 2,
          intentTag: 'obligation',
        });
      }
    }
  }

  const shared = parseSharedSummary(cand.sharedSummaryJson, cand.pageCount);
  if (shared) {
    if (shared.summaryText && shared.summaryText.trim()) {
      const text = cleanExcerpt(shared.summaryText, SNIPPET_EXCERPT_MAX);
      if (text) {
        segments.push({
          kind: 'shared_summary',
          pageNumber: null,
          excerpt: text,
          searchText: text,
          weight: 1,
          intentTag: 'general',
        });
      }
    }
    for (const kt of shared.keyTerms) {
      const label = cleanExcerpt(kt.label, 120);
      const val = cleanExcerpt(kt.value, 260);
      const quote = kt.quoteExcerpt ? cleanExcerpt(kt.quoteExcerpt, 300) : '';
      if (!label && !val && !quote) continue;
      const pageNumber = validPage(kt.pageNumber, cand.pageCount);
      const combined = cleanExcerpt(label && val ? `${label}: ${val}` : label || val || quote, SNIPPET_EXCERPT_MAX);
      const excerpt = quote ? cleanExcerpt(`${combined} - ${quote}`, SNIPPET_EXCERPT_MAX) : combined;
      segments.push({
        kind: 'shared_summary',
        pageNumber,
        excerpt,
        searchText: `${label} ${val} ${quote}`.trim(),
        weight: 1,
        intentTag: 'general',
      });
    }
  }

  if (cand.analysis) {
    const clauses = parseJsonSafe(cand.analysis.riskClausesJson);
    if (Array.isArray(clauses)) {
      for (const rawClause of clauses) {
        if (!rawClause || typeof rawClause !== 'object') continue;
        const c = rawClause as Record<string, unknown>;
        const quote = typeof c.quote === 'string' ? cleanExcerpt(c.quote, SNIPPET_EXCERPT_MAX) : '';
        const title = typeof c.title === 'string' ? cleanExcerpt(c.title, 200) : '';
        const explanation = typeof c.explanation === 'string' ? cleanExcerpt(c.explanation, 300) : '';
        const excerpt = quote || cleanExcerpt(`${title}: ${explanation}`, SNIPPET_EXCERPT_MAX);
        if (!excerpt) continue;
        const pageNumber = validPage(c.pageNumber, cand.pageCount);
        segments.push({
          kind: 'clause',
          pageNumber,
          excerpt,
          searchText: `${title} ${quote} ${explanation}`,
          weight: 2,
          intentTag: 'value',
        });
      }
    }
    if (cand.analysis.summaryText && cand.analysis.summaryText.trim()) {
      const summary = cleanExcerpt(cand.analysis.summaryText, SNIPPET_EXCERPT_MAX);
      if (summary) {
        segments.push({
          kind: 'summary',
          pageNumber: null,
          excerpt: summary,
          searchText: summary,
          weight: 1,
          intentTag: 'general',
        });
      }
    }
  }

  return segments;
}

export function scoreSignVaultCandidates(
  candidates: readonly SignVaultCandidateInput[],
  question: string,
  limit = SIGN_VAULT_CANDIDATES_MAX,
): SignVaultMatchItem[] {
  const parsed = parseSignVaultQuery(question);
  if (!parsed.foldedPhrase) return [];

  const matched: SignVaultMatchItem[] = [];

  for (const cand of candidates) {
    const segments = buildSearchableSegments(cand);
    if (segments.length === 0) continue;

    let totalScore = 0;
    const matchedEntityTokens = new Set<string>();
    const scoredSnippets: Array<{ score: number; snippet: SignVaultMatchSnippet }> = [];

    for (const seg of segments) {
      const exactSeg = normalizeExactText(seg.searchText);
      const foldedSeg = foldVaultSearchText(seg.searchText);
      let segScore = 0;

      if (parsed.exactPhrase.length >= 3 && exactSeg.includes(parsed.exactPhrase)) {
        segScore += 12 * seg.weight;
      } else if (parsed.foldedPhrase.length >= 3 && foldedSeg.includes(parsed.foldedPhrase)) {
        segScore += 10 * seg.weight;
      }

      for (const et of parsed.exactTokens) {
        if (exactSeg.includes(et)) {
          segScore += 4 * seg.weight;
        }
      }

      for (const ft of parsed.foldedTokens) {
        if (foldedSeg.includes(ft)) {
          segScore += 3 * seg.weight;
          if (parsed.entityFoldedTokens.includes(ft)) {
            matchedEntityTokens.add(ft);
          }
        }
      }

      if (parsed.hasRenewalIntent && seg.intentTag === 'renewal') {
        segScore += 5;
      }
      if (parsed.hasValueIntent && seg.intentTag === 'value' && cand.obligation?.contractValue) {
        segScore += 4;
      }
      if (parsed.hasObligationIntent && seg.intentTag === 'obligation') {
        segScore += 5;
      }

      if (segScore > 0) {
        totalScore += segScore;
        scoredSnippets.push({
          score: segScore,
          snippet: {
            kind: seg.kind,
            pageNumber: seg.pageNumber,
            excerpt: seg.excerpt,
          },
        });
      }
    }

    // When the question names specific non-intent entities/terms (e.g. a counterparty or keyword),
    // require at least one entity token to match so intent-only bonuses never leak unrelated contracts.
    if (parsed.entityFoldedTokens.length > 0 && matchedEntityTokens.size === 0) {
      continue;
    }

    if (totalScore <= 0) continue;

    if (cand.status === 'completed') {
      totalScore += 2;
    } else if (cand.status === 'sent' || cand.status === 'in_progress') {
      totalScore += 1;
    }

    scoredSnippets.sort((a, b) => b.score - a.score);
    const seenExcerpts = new Set<string>();
    const topSnippets: SignVaultMatchSnippet[] = [];
    for (const entry of scoredSnippets) {
      const dedupeKey = `${entry.snippet.pageNumber ?? 'none'}:${entry.snippet.excerpt}`;
      if (seenExcerpts.has(dedupeKey)) continue;
      seenExcerpts.add(dedupeKey);
      topSnippets.push(entry.snippet);
      if (topSnippets.length >= SNIPPETS_PER_ENVELOPE_MAX) break;
    }

    const obl = cand.obligation;
    const formattedValue = formatMoneySafe(obl?.contractValue);
    matched.push({
      envelopeId: cand.envelopeId,
      title: cleanExcerpt(cand.title, 300),
      status: cand.status,
      sourceKind: cand.sourceKind,
      pageCount: cand.pageCount,
      completedAt: cand.completedAt,
      updatedAt: cand.updatedAt,
      counterpartyName: obl?.counterpartyName ? cleanExcerpt(obl.counterpartyName, 300) : null,
      effectiveDate: obl?.effectiveDate ?? null,
      expiryDate: obl?.expiryDate ?? null,
      renewalNoticeDays: obl?.renewalNoticeDays ?? null,
      autoRenew: Boolean(obl?.autoRenew),
      contractValue: formattedValue,
      currency: obl?.currency ?? null,
      score: totalScore,
      snippets: topSnippets,
    });
  }

  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aComp = a.completedAt ?? '';
    const bComp = b.completedAt ?? '';
    if (bComp !== aComp) return bComp < aComp ? -1 : 1;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt < a.updatedAt ? -1 : 1;
    return a.envelopeId < b.envelopeId ? -1 : a.envelopeId > b.envelopeId ? 1 : 0;
  });

  return matched.slice(0, Math.min(SIGN_VAULT_CANDIDATES_MAX, Math.max(1, limit)));
}

function assertUser(ctx: QueryContext): void {
  if (ctx.actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can search the contract vault');
  }
}

export const vaultSearch = defineQuery({
  name: 'sign.vault.search',
  input: zSignVaultSearchInput,
  access: READERS,
  handler: async (ctx, input): Promise<SignVaultSearchResult> => {
    assertUser(ctx);

    const { rows: appRows } = await sql<{ enabled: boolean }>`
      SELECT ludy_kernel.org_app_on(${ctx.orgId}::uuid, 'sign') AS enabled
    `.execute(ctx.trx);
    if (!appRows[0]?.enabled) {
      throw new DomainError('MODULE_OFF', 404, 'Ứng dụng sign chưa được bật cho công ty này', {
        module: 'sign',
      });
    }

    let q = ctx.trx
      .selectFrom('crove_sign.envelope')
      .select([
        'id',
        'title',
        'subject',
        'status',
        'source_kind',
        'source_id',
        'source_sha256',
        'page_count',
        'shared_summary_json',
        'completed_at',
        'updated_at',
        'created_by',
      ])
      .where('org_id', '=', ctx.orgId);

    if (input.status !== undefined) {
      q = q.where('status', '=', input.status);
    } else {
      q = q.where('status', '!=', 'voided');
    }

    q = applyEnvelopeVisibilityFilter(q, ctx);
    q = applyMeetingMinutesVisibilityFilter(q, ctx);

    const envRows = await q
      .orderBy(sql`completed_at DESC NULLS LAST`)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'asc')
      .limit(SIGN_VAULT_SCAN_LIMIT)
      .execute();

    if (envRows.length === 0) {
      return { items: [] };
    }

    const currentUserId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const accessibleEnvRows = envRows.filter((row) => {
      if (!canAccessEnvelopeRow(ctx, row)) return false;
      if (row.source_kind === 'meeting_minutes' && !row.source_id && currentUserId !== row.created_by) {
        return false;
      }
      return true;
    });

    if (accessibleEnvRows.length === 0) {
      return { items: [] };
    }

    const accessibleIds = accessibleEnvRows.map((r) => r.id);

    const [obligationRows, analysisRows] = await Promise.all([
      ctx.trx
        .selectFrom('crove_sign.envelope_obligation')
        .select([
          'envelope_id',
          'counterparty_name',
          'effective_date',
          'expiry_date',
          'renewal_notice_days',
          'auto_renew',
          'contract_value',
          'currency',
          'obligations_json',
        ])
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', 'in', accessibleIds)
        .where('status', '=', 'confirmed')
        .execute(),
      ctx.trx
        .selectFrom('crove_sign.ai_analysis')
        .select(['envelope_id', 'source_sha256', 'summary_text', 'risk_clauses_json'])
        .where('org_id', '=', ctx.orgId)
        .where('envelope_id', 'in', accessibleIds)
        .where('status', '=', 'completed')
        .orderBy(sql`completed_at DESC NULLS LAST`)
        .orderBy('created_at', 'desc')
        .execute(),
    ]);

    const obligationByEnvelope = new Map<string, (typeof obligationRows)[number]>();
    for (const obl of obligationRows) {
      if (!obligationByEnvelope.has(obl.envelope_id)) {
        obligationByEnvelope.set(obl.envelope_id, obl);
      }
    }

    const analysisByKey = new Map<string, { summaryText: string | null; riskClausesJson: unknown }>();
    for (const a of analysisRows) {
      const key = `${a.envelope_id}:${a.source_sha256}`;
      if (!analysisByKey.has(key)) {
        analysisByKey.set(key, {
          summaryText: a.summary_text,
          riskClausesJson: a.risk_clauses_json,
        });
      }
    }

    const candidates: SignVaultCandidateInput[] = accessibleEnvRows.map((env) => {
      const obl = obligationByEnvelope.get(env.id) ?? null;
      const analysis = analysisByKey.get(`${env.id}:${env.source_sha256}`) ?? null;
      return {
        envelopeId: env.id,
        title: env.title,
        subject: env.subject,
        status: env.status,
        sourceKind: env.source_kind,
        pageCount: env.page_count,
        completedAt: isoOrNull(env.completed_at),
        updatedAt: new Date(env.updated_at).toISOString(),
        sharedSummaryJson: env.shared_summary_json,
        obligation: obl
          ? {
              counterpartyName: obl.counterparty_name,
              effectiveDate: dateOrNull(obl.effective_date),
              expiryDate: dateOrNull(obl.expiry_date),
              renewalNoticeDays: obl.renewal_notice_days,
              autoRenew: Boolean(obl.auto_renew),
              contractValue: obl.contract_value,
              currency: obl.currency,
              obligationsJson: obl.obligations_json,
            }
          : null,
        analysis,
      };
    });

    return {
      items: scoreSignVaultCandidates(candidates, input.question, input.limit),
    };
  },
});

export const signVaultQueries = [vaultSearch];

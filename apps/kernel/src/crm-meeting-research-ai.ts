// SPDX-License-Identifier: AGPL-3.0-only
// Dy's pre-meeting research brief orchestration on the API side (#4992, PM2):
//   1. Reads PM1 contact facts, derived company website URL, and AI switches/budget in the member's
//      own read transaction (`crm.contact.meeting_research_source`).
//   2. Outside any DB transaction, optionally performs a single GET of the confirmed company homepage
//      through `guardedFetch` (HTTPS only, max 200 KB, 5 s timeout, same-host redirects only),
//      extracting up to 3,000 plain characters by dropping scripts/styles/hidden elements/tags.
//   3. Runs one metered model call (`crm.meeting_research`) fenced as untrusted data with zero tools,
//      refusing the brief whole on any ungrounded or tainted output.
//   4. Audits only IDs and counts via `crm.contact.meeting_research.audit` (never page text or brief text).
import { AiBudgetExhaustedError, MEETING_RESEARCH_PAGE_CHARS, type InboxReader } from '@ludy/agent';
import type {
  MeetingResearchAiState,
  MeetingResearchAuditInput,
  MeetingResearchInput,
  MeetingResearchOutput,
  MeetingResearchSourceInput,
  MeetingResearchSourceOutput,
  MeetingResearchWebsiteOutcome,
} from '@ludy/kernel-contract';
import { DomainError, EgressError, guardedFetch, type EgressOptions } from '@ludy/kernel-runtime';
import type { DraftBudget } from './ai-draft-limit.ts';

export const MEETING_RESEARCH_FETCH_MAX_BYTES = 200 * 1024;
export const MEETING_RESEARCH_FETCH_TIMEOUT_MS = 5_000;
const MEETING_RESEARCH_FETCH_MAX_REDIRECTS = 5;

export interface MeetingResearchAi {
  reader: Pick<InboxReader, 'meetingResearch'> | null;
  budget: DraftBudget;
  fetch?: typeof guardedFetch;
  fetchOptions?: Partial<EgressOptions>;
}

export interface MeetingResearchPorts {
  readSource(input: MeetingResearchSourceInput): Promise<MeetingResearchSourceOutput>;
  recordAudit(entry: MeetingResearchAuditInput): Promise<void>;
}

export function meetingResearchAi(
  reader: MeetingResearchAi['reader'],
  budget: DraftBudget,
  options?: { fetch?: typeof guardedFetch; fetchOptions?: Partial<EgressOptions> },
): MeetingResearchAi {
  return {
    reader,
    budget,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
    ...(options?.fetchOptions ? { fetchOptions: options.fetchOptions } : {}),
  };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function charsetFromMetaOrHeader(bytes: Uint8Array, contentType: string | null): string {
  const headerMatch = /charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(contentType ?? '');
  if (headerMatch?.[1]) return headerMatch[1].toLowerCase();
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const metaMatch = /<meta[^>]+charset=["']?([a-zA-Z0-9_-]+)/i.exec(head);
  if (metaMatch?.[1]) return metaMatch[1].toLowerCase();
  return 'utf-8';
}

function decodeHtmlBytes(bytes: Uint8Array, contentType: string | null): string {
  const charset = charsetFromMetaOrHeader(bytes, contentType);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

// Linear scanner: strips HTML comments and hidden/executable element blocks (`script`, `style`, etc.) in O(n).
const HIDDEN_BLOCKS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed'] as const;

function stripCommentsAndHiddenBlocks(html: string): string {
  let current = '';
  let i = 0;
  // Pass 1: drop HTML comments <!-- ... --> cleanly.
  while (i < html.length) {
    const start = html.indexOf('<!--', i);
    if (start < 0) {
      current += html.slice(i);
      break;
    }
    current += html.slice(i, start) + ' ';
    const end = html.indexOf('-->', start + 4);
    i = end < 0 ? html.length : end + 3;
  }

  // Pass 2: drop paired hidden/executable tags case-insensitively in linear passes.
  for (const tag of HIDDEN_BLOCKS) {
    const lower = current.toLowerCase();
    const openPrefix = `<${tag}`;
    const closeNeedle = `</${tag}`;
    let out = '';
    let pos = 0;
    while (pos < current.length) {
      const idx = lower.indexOf(openPrefix, pos);
      if (idx < 0) {
        out += current.slice(pos);
        break;
      }
      const nextCh = lower[idx + openPrefix.length] ?? '';
      if (nextCh !== '>' && !/\s/.test(nextCh)) {
        out += current.slice(pos, idx + openPrefix.length);
        pos = idx + openPrefix.length;
        continue;
      }
      out += current.slice(pos, idx) + ' ';
      const openEnd = lower.indexOf('>', idx + openPrefix.length);
      if (openEnd < 0) {
        pos = current.length;
        break;
      }
      if (current[openEnd - 1] === '/') {
        pos = openEnd + 1;
        continue;
      }
      const closeStart = lower.indexOf(closeNeedle, openEnd + 1);
      if (closeStart < 0) {
        pos = current.length;
        break;
      }
      const closeEnd = lower.indexOf('>', closeStart + closeNeedle.length);
      pos = closeEnd < 0 ? current.length : closeEnd + 1;
    }
    current = out;
  }
  return current;
}

const STRONG_CHALLENGE_RE =
  /(?:cf-browser-verification|cdn-cgi\/challenge-platform|ddos protection by cloudflare|attention required!\s*\|\s*cloudflare|checking your browser before accessing|enable javascript and cookies to continue|verify you are human|<title[^>]*>\s*just a moment\.\.\.\s*<\/title>)/i;
const WIDGET_CHALLENGE_RE = /(?:cf-turnstile|h-captcha|g-recaptcha|__cf_chl)/i;

function isChallengeHtml(rawHtml: string, plainText: string): boolean {
  if (STRONG_CHALLENGE_RE.test(rawHtml) || STRONG_CHALLENGE_RE.test(plainText)) return true;
  if (plainText.length < 1_500 && WIDGET_CHALLENGE_RE.test(rawHtml)) return true;
  return false;
}

export function extractWebsiteText(
  body: Uint8Array,
  contentType: string | null,
): { text: string | null; outcome: MeetingResearchWebsiteOutcome } {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') {
    return { text: null, outcome: 'not_html' };
  }

  const rawHtml = decodeHtmlBytes(body, contentType);
  const withoutHidden = stripCommentsAndHiddenBlocks(rawHtml);
  const withoutTags = withoutHidden.replace(/<[^>]*>/g, ' ');
  const decoded = decodeEntities(withoutTags);
  const strippedControls = decoded.replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, ' ');
  const plainText = strippedControls.replace(/\s+/g, ' ').trim();

  if (isChallengeHtml(rawHtml, plainText)) {
    return { text: null, outcome: 'challenge' };
  }

  if (plainText === '') {
    return { text: null, outcome: 'failed' };
  }

  const bounded = Array.from(plainText).slice(0, MEETING_RESEARCH_PAGE_CHARS).join('');
  return { text: bounded, outcome: 'used' };
}

function classifyEgressError(error: unknown): MeetingResearchWebsiteOutcome {
  if (error instanceof EgressError) {
    if (error.code === 'timeout') return 'timeout';
    if (error.code === 'redirects') return 'redirect_blocked';
    if (error.code === 'blocked' || error.code === 'dns' || error.code === 'invalid_url') {
      return /redirect/i.test(error.message) ? 'redirect_blocked' : 'blocked';
    }
    return 'failed';
  }
  return 'failed';
}

export async function fetchCompanyWebsiteText(
  url: string,
  fetchImpl: typeof guardedFetch = guardedFetch,
  fetchOverrides?: Partial<EgressOptions>,
): Promise<{ text: string | null; outcome: MeetingResearchWebsiteOutcome }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { text: null, outcome: 'blocked' };
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') {
    return { text: null, outcome: 'blocked' };
  }
  const expectedHost = parsed.hostname.toLowerCase();
  let hostCheckCount = 0;

  let response;
  try {
    response = await fetchImpl(url, {
      timeoutMs: MEETING_RESEARCH_FETCH_TIMEOUT_MS,
      maxBytes: MEETING_RESEARCH_FETCH_MAX_BYTES,
      overLimit: 'truncate',
      maxRedirects: MEETING_RESEARCH_FETCH_MAX_REDIRECTS,
      httpsOnly: true,
      hostAllowed: (host) => {
        hostCheckCount += 1;
        return host.toLowerCase() === expectedHost;
      },
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      ...fetchOverrides,
    });
  } catch (error: unknown) {
    const classified = classifyEgressError(error);
    return { text: null, outcome: classified === 'blocked' && hostCheckCount > 1 ? 'redirect_blocked' : classified };
  }

  if (response.status === 403) return { text: null, outcome: 'forbidden' };
  if (response.status === 429) return { text: null, outcome: 'rate_limited' };
  if (response.status < 200 || response.status >= 300) return { text: null, outcome: 'failed' };

  return extractWebsiteText(response.body, response.contentType);
}

/** Prepares Dy's pre-meeting research brief outside SQL transactions and records an IDs/counts-only audit row. */
export async function prepareMeetingResearch(
  ai: MeetingResearchAi,
  orgId: string,
  userId: string,
  input: MeetingResearchInput,
  ports: MeetingResearchPorts,
): Promise<MeetingResearchOutput> {
  const source = await ports.readSource({
    targetKind: input.targetKind,
    targetId: input.targetId,
    partyId: input.partyId,
  });

  if (source.contact === null) {
    throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy liên hệ phù hợp cho cuộc họp này');
  }

  const contact = source.contact;
  const modelMessages = source.wordsAllowed ? contact.messages : [];
  const websiteUrl = contact.websiteUrl ?? null;

  const finish = async (
    aiState: MeetingResearchAiState,
    websiteOutcome: MeetingResearchWebsiteOutcome,
    websiteChars: number,
    brief: { summary: string | null; points: readonly string[]; websiteQuotes: readonly string[] },
  ): Promise<MeetingResearchOutput> => {
    await ports.recordAudit({
      targetKind: input.targetKind,
      targetId: input.targetId,
      partyId: contact.partyId,
      aiState,
      dealsCount: contact.deals.length,
      messagesCount: modelMessages.length,
      websiteRequested: input.readWebsite,
      websiteUsed: websiteOutcome === 'used',
      websiteChars,
      quotesCount: brief.websiteQuotes.length,
      pointsCount: brief.points.length,
    });
    return {
      ai: aiState,
      partyId: contact.partyId,
      websiteUrl,
      websiteOutcome,
      summary: brief.summary,
      points: [...brief.points],
      websiteQuotes: [...brief.websiteQuotes],
      tainted: true,
    };
  };

  const initialWebsiteOutcome: MeetingResearchWebsiteOutcome = websiteUrl === null ? 'none' : 'skipped';
  const emptyBrief = { summary: null, points: [] as readonly string[], websiteQuotes: [] as readonly string[] };

  if (!ai.reader) return finish('off', initialWebsiteOutcome, 0, emptyBrief);
  if (source.aiStopped) return finish('paused', initialWebsiteOutcome, 0, emptyBrief);
  if (source.aiBudgetSpent) return finish('budget', initialWebsiteOutcome, 0, emptyBrief);

  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return finish('busy', initialWebsiteOutcome, 0, emptyBrief);

  let aiState: MeetingResearchAiState = 'failed';
  let websiteOutcome: MeetingResearchWebsiteOutcome = initialWebsiteOutcome;
  let websiteText: string | null = null;
  let websiteChars = 0;
  let brief = emptyBrief;

  try {
    const confirmedWebsite =
      input.readWebsite &&
      websiteUrl !== null &&
      (input.expectedWebsiteUrl === undefined || input.expectedWebsiteUrl === websiteUrl);

    if (confirmedWebsite && websiteUrl !== null) {
      const fetched = await fetchCompanyWebsiteText(websiteUrl, ai.fetch ?? guardedFetch, ai.fetchOptions);
      websiteText = fetched.text;
      websiteOutcome = fetched.outcome;
      websiteChars = websiteText === null ? 0 : Array.from(websiteText).length;
    }

    const result = await ai.reader.meetingResearch({
      contactName: contact.contactName,
      deals: contact.deals,
      latestQuote: contact.latestQuote,
      invoices: contact.invoices,
      messages: modelMessages,
      websiteText,
    });

    if (result.kind === 'brief') {
      aiState = 'ok';
      brief = {
        summary: result.brief.summary,
        points: result.brief.points,
        websiteQuotes: result.brief.websiteQuotes,
      };
    } else {
      console.error(`[crm-meeting-research-ai] brief refused: ${result.code}`);
      aiState = 'refused';
    }
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) {
      aiState = 'budget';
      ticket.refund?.();
    } else {
      console.error('[crm-meeting-research-ai] brief failed', error instanceof Error ? error.name : typeof error);
      aiState = 'failed';
    }
  } finally {
    ticket.release();
  }

  return finish(aiState, websiteOutcome, websiteChars, brief);
}

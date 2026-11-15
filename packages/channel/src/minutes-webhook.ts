// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to a Slack or Microsoft Teams channel through a webhook address the org pasted (Meetings B4, #3168, plan docs/plan/meetings-integrations.md section 5.2). Post only:
// no OAuth, no Ludy app, no history read. The address is a secret (anyone holding it can post), so this module never logs it, never puts it in an error, and checks every time that it is an
// https address of the service's own hosts before one request leaves.
//
// Slack: an Incoming Webhook, https://hooks.slack.com/services/T.../B.../..., takes {"text": ...} and answers 200 "ok". The text goes with mrkdwn off, link and media unfurling off, and `&`, `<` and `>`
//   escaped, so what the recorder read is what the channel shows and nothing in the minutes can ping a channel, a group or a person (<!channel>, <@U...> need the angle brackets).
// Teams: a Workflows webhook ("post to a channel when a webhook request is received"), whose address is on a Logic Apps or Power Platform host, takes an Adaptive Card wrapped in a message and answers 200
//   or 202 (accepted, not delivered). Markdown characters in the minutes are escaped so nothing renders as a link or emphasis the recorder did not read.
// [unverified] The hosts, the path shapes, the answer codes, the size limits and the card version below come from the build's knowledge of both services, not from their pages, which the build
// environment cannot reach; docs/runbooks/meeting-chat.md lists each as a live check.
export const SLACK_WEBHOOK_HOSTS = ['hooks.slack.com'] as const;
export const TEAMS_WEBHOOK_HOST_SUFFIXES = ['.logic.azure.com', '.api.powerplatform.com'] as const;
export type MinutesKind = 'slack' | 'teams';

// The minutes as the module builds them (kernel-contract's ChatMessage; the same shape, kept here so this package needs nothing of the contract).
export interface MinutesMessage {
  lang: 'vi' | 'en';
  title: string;
  day: string;
  summary: string;
  decisions: readonly string[];
  items: ReadonlyArray<{ title: string; who: string; when: string }>;
}

const LABELS = {
  vi: { summary: 'Tóm tắt', decisions: 'Quyết định', items: 'Việc cần làm', link: 'Xem cuộc họp', open: 'Mở cuộc họp' },
  en: { summary: 'Summary', decisions: 'Decisions', items: 'Action items', link: 'Open the meeting', open: 'Open the meeting' },
} as const;
const dayText = (lang: 'vi' | 'en', day: string) => (lang === 'vi' ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : day);
const itemLine = (i: { title: string; who: string; when: string }) => {
  const tail = [i.who, i.when].filter((s) => s !== '').join(', ');
  return tail === '' ? i.title : `${i.title} (${tail})`;
};

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------
export interface ParsedMinutesUrl {
  kind: MinutesKind;
  // What a request is sent to (the address as pasted, normalised by the URL parser).
  url: string;
  // The host alone, for the screen and for the check at the send.
  host: string;
}

const SLACK_PATH = /^\/services\/T[A-Z0-9]{2,}\/B[A-Z0-9]{2,}\/[A-Za-z0-9]{10,}$/;
// Logic Apps: /workflows/<id>/triggers/manual/paths/invoke. Power Platform: /powerautomate/automations/direct/workflows/<id>/triggers/manual/paths/invoke [unverified].
const TEAMS_PATH = /^\/(?:powerautomate\/automations\/direct\/)?workflows\/[A-Za-z0-9]+\/triggers\/[A-Za-z0-9_-]+\/paths\/invoke\/?$/;

export const minutesHostAllowed = (kind: MinutesKind, host: string): boolean =>
  kind === 'slack' ? (SLACK_WEBHOOK_HOSTS as readonly string[]).includes(host) : TEAMS_WEBHOOK_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);

/** The address of a Slack or Teams webhook, or null when it is not one: https only, no credentials, the default port, a host of the service's own and the shape of its path. Never throws, never echoes the address. */
export function parseMinutesUrl(kind: MinutesKind, raw: string): ParsedMinutesUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return null;
  if (url.port !== '' && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  if (!minutesHostAllowed(kind, host)) return null;
  if (kind === 'slack' && (url.search !== '' || !SLACK_PATH.test(url.pathname))) return null;
  if (kind === 'teams' && !TEAMS_PATH.test(url.pathname)) return null;
  url.port = '';
  return { kind, url: url.toString(), host };
}

// ---------------------------------------------------------------------------
// The payloads
// ---------------------------------------------------------------------------
// Slack's text: `&`, `<` and `>` escaped (the only characters Slack reads as control sequences).
const slackEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The plain lines of the message, the order the recorder reads them in. */
export function minutesLines(message: MinutesMessage, link: string | null): string[] {
  const l = LABELS[message.lang];
  const out: string[] = [message.title, dayText(message.lang, message.day)];
  if (message.summary !== '') out.push('', l.summary, message.summary);
  if (message.decisions.length > 0) out.push('', l.decisions, ...message.decisions.map((d) => `• ${d}`));
  if (message.items.length > 0) out.push('', l.items, ...message.items.map((i) => `• ${itemLine(i)}`));
  if (link) out.push('', `${l.link}: ${link}`);
  return out;
}

export function slackMinutesBody(message: MinutesMessage, link: string | null): string {
  return JSON.stringify({ text: slackEscape(minutesLines(message, link).join('\n')), mrkdwn: false, unfurl_links: false, unfurl_media: false });
}

// Characters Teams reads as markdown inside a TextBlock, escaped with a backslash.
const teamsEscape = (text: string) => text.replace(/([\\`*_{}[\]()#+!|<>~-])/g, '\\$1');

export function teamsMinutesBody(message: MinutesMessage, link: string | null): string {
  const l = LABELS[message.lang];
  const block = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'TextBlock', text: teamsEscape(text), wrap: true, ...extra });
  const body: unknown[] = [block(message.title, { weight: 'Bolder', size: 'Large' }), block(dayText(message.lang, message.day), { isSubtle: true, spacing: 'None' })];
  if (message.summary !== '') body.push(block(l.summary, { weight: 'Bolder', spacing: 'Medium' }), block(message.summary));
  if (message.decisions.length > 0) body.push(block(l.decisions, { weight: 'Bolder', spacing: 'Medium' }), ...message.decisions.map((d) => block(`• ${d}`, { spacing: 'Small' })));
  if (message.items.length > 0) body.push(block(l.items, { weight: 'Bolder', spacing: 'Medium' }), ...message.items.map((i) => block(`• ${itemLine(i)}`, { spacing: 'Small' })));
  const content: Record<string, unknown> = { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body };
  if (link) content.actions = [{ type: 'Action.OpenUrl', title: l.open, url: link }];
  return JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }] });
}

// ---------------------------------------------------------------------------
// The post
// ---------------------------------------------------------------------------
export type MinutesFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface MinutesPostResult {
  // sent: the service took it (Slack 200, Teams 200 or 202). failed: nothing went out (an address refused before any request, or a refusal answered). ambiguous: a request left and no usable answer came
  // back (a timeout, a dropped connection, a server error), so it may be in the channel: never repeated without the recorder's tick.
  state: 'sent' | 'failed' | 'ambiguous';
  httpStatus: number | null;
  // A fixed code, never the service's words (they can echo the address).
  code: string | null;
  // 429: the seconds the service asked to wait.
  retryAfterSeconds: number | null;
}

const failed = (code: string, httpStatus: number | null = null, retryAfterSeconds: number | null = null): MinutesPostResult => ({ state: 'failed', httpStatus, code, retryAfterSeconds });

function egressCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (error as { name?: unknown }).name === 'EgressError' ? code : null;
}

/** Posts the message once. `send` is the egress guard's fetch (https only, public addresses, no redirect followed, a small answer cap). Never throws; never returns or logs the address. */
export async function postMinutes(kind: MinutesKind, address: string, message: MinutesMessage, link: string | null, send: MinutesFetch): Promise<MinutesPostResult> {
  // The host is checked again here, against this adapter's own list, whatever the table held.
  const parsed = parseMinutesUrl(kind, address);
  if (!parsed) return failed('CHANNEL_ADDRESS_INVALID');
  const body = kind === 'slack' ? slackMinutesBody(message, link) : teamsMinutesBody(message, link);
  let answer: Response;
  try {
    answer = await send(parsed.url, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body });
  } catch (error) {
    const code = egressCodeOf(error);
    // Refused before any request left: the guard did not let it go, or the name did not resolve.
    if (code === 'invalid_url' || code === 'blocked' || code === 'dns') return failed('CHANNEL_UNREACHABLE');
    // A timeout, a dropped connection, an answer too large to read: a request may have been delivered.
    return { state: 'ambiguous', httpStatus: null, code: code === 'timeout' ? 'CHANNEL_TIMEOUT' : 'CHANNEL_NO_ANSWER', retryAfterSeconds: null };
  }
  const status = answer.status;
  if (status >= 200 && status < 300) return { state: 'sent', httpStatus: status, code: null, retryAfterSeconds: null };
  if (status === 429) {
    const header = Number(answer.headers.get('retry-after'));
    return failed('CHANNEL_RATE_LIMITED', status, Number.isFinite(header) && header >= 1 ? Math.min(Math.ceil(header), 3600) : 30);
  }
  if (status >= 300 && status < 400) return failed('CHANNEL_REDIRECTED', status);
  if (status === 404 || status === 410) return failed('CHANNEL_GONE', status);
  if (status === 401 || status === 403) return failed('CHANNEL_REFUSED', status);
  if (status >= 400 && status < 500) return failed('CHANNEL_REJECTED', status);
  return { state: 'ambiguous', httpStatus: status, code: 'CHANNEL_SERVER_ERROR', retryAfterSeconds: null };
}

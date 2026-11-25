// SPDX-License-Identifier: AGPL-3.0-only
// Amazon SES v2 HTTP provider and verified AWS SNS delivery event webhook (#4960, ADR-0034).
// Uses zero AWS SDK dependencies: AWS SigV4 (AWS4-HMAC-SHA256) via node:crypto and RFC 5322 raw MIME
// via nodemailer's MailComposer. SES v2 SendEmail has no idempotency key, so sendRetrySafety is 'never'.
import { createHash, createHmac, createVerify, X509Certificate } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { withDisplayName } from './smtp.ts';
import {
  type MailErrorKind,
  type MailEvent,
  type MailEventKind,
  type MailProvider,
  type OutboundMail,
  type SendResult,
  WebhookRejected,
  type WebhookRequest,
} from './types.ts';

export const SES_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
export const SES_CONFIGURATION_SET_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SES_SNS_TOPIC_ARN_PATTERN = /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[^\s:]+$/;

const SNS_CERT_PATH_PATTERN = /^\/SimpleNotificationService-[a-f0-9]+\.pem$/;
const SNS_TOLERANCE_MS = 15 * 60_000;
const SNS_CERT_MAX_BYTES = 32 * 1024;
const SNS_CERT_CACHE_MAX = 16;
const SNS_CERT_INFLIGHT_MAX = 4;
const SNS_CERT_FAIL_CACHE_MAX = 64;
const SNS_CERT_FAIL_TTL_MS = 60_000;
const SNS_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;
const MAX_ID = 255;

const AUTH_ERROR_TYPES = new Set([
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'SignatureDoesNotMatch',
  'AccessDeniedException',
  'InvalidSignatureException',
  'ExpiredTokenException',
]);

const RECORDED_EVENTS: Record<string, MailEventKind | 'bounce'> = {
  Delivery: 'delivered',
  DeliveryDelay: 'deferred',
  Complaint: 'complaint',
  Bounce: 'bounce',
};

export interface SesOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  from: string;
  senderName?: string | undefined;
  configurationSet?: string | undefined;
  snsTopicArn?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface SesWebhookOptions {
  region: string;
  snsTopicArn: string;
  fetch?: typeof fetch;
  certCache?: Map<string, X509Certificate>;
}

export interface SignedSesRequestInput {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  host: string;
  path: string;
  body: string;
  now?: number;
}

function assertValidRegion(region: string): string {
  if (!SES_REGION_PATTERN.test(region)) {
    throw new Error('invalid SES region');
  }
  return region;
}

function assertValidTopicArn(snsTopicArn: string, region: string): void {
  if (!SES_SNS_TOPIC_ARN_PATTERN.test(snsTopicArn)) {
    throw new Error('invalid SES SNS topic ARN');
  }
  const arnRegion = snsTopicArn.split(':')[3];
  if (arnRegion !== region) {
    throw new Error('SES SNS topic ARN region must match SES region');
  }
}

function sesEndpoint(region: string): URL {
  const validRegion = assertValidRegion(region);
  const expectedHost = `email.${validRegion}.amazonaws.com`;
  const url = new URL(`https://${expectedHost}/v2/email/outbound-emails`);
  if (url.protocol !== 'https:' || url.hostname !== expectedHost || url.port !== '' || url.pathname !== '/v2/email/outbound-emails') {
    throw new Error('unexpected SES endpoint');
  }
  return url;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Signs an Amazon SES v2 POST request using AWS Signature Version 4 (AWS4-HMAC-SHA256). */
export function signSesRequest(input: SignedSesRequestInput): Record<string, string> {
  const region = assertValidRegion(input.region);
  const amzDate = new Date(input.now ?? Date.now()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    host: input.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const sortedEntries = Object.entries(baseHeaders).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = sortedEntries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = sortedEntries.map(([k]) => k).join(';');
  const canonicalRequest = ['POST', input.path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, 'ses');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');
  return {
    ...baseHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function cleanHeader(value: string): string {
  // oxlint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripControl(value: string): string {
  // oxlint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, '').trim();
}

function extractAddress(from: string): string {
  return stripControl(/<([^<>\s]+)>/.exec(from)?.[1] ?? from);
}

function extractCompiledFromHeader(raw: Buffer): string | undefined {
  const text = raw.toString('utf8');
  const headerEnd = text.indexOf('\r\n\r\n');
  const headerBlock = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const unfolded = headerBlock.replace(/\r\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\r\n')) {
    if (line.toLowerCase().startsWith('from:')) {
      const value = line.slice(5).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

async function buildRawMime(
  mail: OutboundMail,
  options: Pick<SesOptions, 'from' | 'senderName'>,
): Promise<{ raw: Buffer; fromEmailAddress: string }> {
  const bareFrom = extractAddress(options.from);
  const defaultFrom = options.from.includes('<') ? cleanHeader(options.from) : { name: options.senderName ?? 'Ludy', address: bareFrom };
  const from = mail.fromName ? withDisplayName(options.from, mail.fromName) : defaultFrom;
  const composer = new MailComposer({
    from,
    to: cleanHeader(mail.to),
    subject: cleanHeader(mail.subject),
    text: mail.text,
    html: mail.html,
    ...(mail.messageId ? { messageId: stripControl(mail.messageId) } : {}),
    ...(mail.replyTo ? { replyTo: cleanHeader(mail.replyTo) } : {}),
    ...(mail.inReplyTo ? { inReplyTo: stripControl(mail.inReplyTo) } : {}),
    ...(mail.references?.length ? { references: mail.references.map(stripControl) } : {}),
    ...(mail.attachments?.length
      ? {
          attachments: mail.attachments.map((a) => ({
            filename: cleanHeader(a.filename),
            contentType: cleanHeader(a.contentType),
            content: typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : Buffer.from(a.content),
          })),
        }
      : {}),
    newline: 'win',
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const raw = await composer.compile().build();
  const fromEmailAddress = extractCompiledFromHeader(raw) ?? bareFrom;
  return { raw, fromEmailAddress };
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : undefined;
}

function normalizeSesErrorType(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const beforeColon = raw.split(':', 1)[0] ?? '';
  const afterHash = beforeColon.includes('#') ? beforeColon.slice(beforeColon.lastIndexOf('#') + 1) : beforeColon;
  const clean = afterHash.replace(/[^A-Za-z0-9_]+/g, '').slice(0, 52);
  return clean.length > 0 ? clean : undefined;
}

function classifyMessageRejected(message: string): MailErrorKind {
  // Only suppress when SES explicitly indicates the destination/recipient address itself failed; generic address syntax
  // errors (such as "Illegal address" or "Missing final '@domain'") can stem from From/Reply-To and stay bad_request.
  if (/\b(?:invalid|malformed)\s+(?:recipient|destination|to)\s+address\b|\bdestination\s+address(?:es)?\s+(?:invalid|rejected)\b|\brecipient\s+address\s+rejected\b/i.test(message)) {
    return 'invalid_recipient';
  }
  if (/(?:account[- ]level )?suppression list|address(?: is)? blacklisted/i.test(message)) {
    return 'suppressed_by_provider';
  }
  return 'bad_request';
}

async function classifySesResponse(response: Response): Promise<SendResult> {
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as { MessageId?: unknown; messageId?: unknown } | null;
    const rawId = typeof body?.MessageId === 'string' ? body.MessageId : typeof body?.messageId === 'string' ? body.messageId : undefined;
    const id = rawId && rawId.length > 0 && rawId.length <= MAX_ID ? rawId : undefined;
    return id ? { status: 'accepted', providerMessageId: id } : { status: 'accepted' };
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const rawBodyType = typeof body?.__type === 'string' ? body.__type : typeof body?.code === 'string' ? body.code : typeof body?.Code === 'string' ? body.Code : undefined;
  const errorType = normalizeSesErrorType(response.headers.get('x-amzn-errortype') ?? rawBodyType);
  const code = errorType ? `SES_${response.status}_${errorType}` : `SES_${response.status}`;

  if (response.status >= 500) {
    return { status: 'unknown', code };
  }
  if (response.status === 429 || errorType === 'LimitExceededException' || errorType === 'TooManyRequestsException' || errorType === 'ThrottlingException') {
    const wait = retryAfterMs(response);
    return { status: 'rejected', error: 'rate_limited', code, ...(wait ? { retryAfterMs: wait } : {}) };
  }
  if (response.status === 401 || response.status === 403 || (errorType !== undefined && AUTH_ERROR_TYPES.has(errorType))) {
    return { status: 'rejected', error: 'auth', code };
  }
  if (errorType === 'MessageRejected') {
    const message = typeof body?.message === 'string' ? body.message : typeof body?.Message === 'string' ? body.Message : '';
    return { status: 'rejected', error: classifyMessageRejected(message), code };
  }
  return { status: 'rejected', error: 'bad_request', code };
}

interface SnsSubscribeExpectation {
  topicArn: string;
  token: string;
}

function validateSnsUrl(raw: string, region: string, kind: 'cert'): URL;
function validateSnsUrl(raw: string, region: string, kind: 'subscribe', expected: SnsSubscribeExpectation): URL;
function validateSnsUrl(raw: string, region: string, kind: 'cert' | 'subscribe', expected?: SnsSubscribeExpectation): URL {
  if (raw.includes('..') || /%2e/i.test(raw) || raw.includes('\\')) {
    throw new WebhookRejected(kind === 'cert' ? 'signature' : 'malformed');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookRejected(kind === 'cert' ? 'signature' : 'malformed');
  }
  const expectedHost = `sns.${region}.amazonaws.com`;
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '' || url.hostname !== expectedHost) {
    throw new WebhookRejected(kind === 'cert' ? 'signature' : 'malformed');
  }
  if (kind === 'cert') {
    if (url.search !== '' || !SNS_CERT_PATH_PATTERN.test(url.pathname)) {
      throw new WebhookRejected('signature');
    }
    return url;
  }
  const actions = url.searchParams.getAll('Action');
  const topics = url.searchParams.getAll('TopicArn');
  const tokens = url.searchParams.getAll('Token');
  if (
    url.pathname !== '/' ||
    actions.length !== 1 ||
    actions[0] !== 'ConfirmSubscription' ||
    topics.length !== 1 ||
    topics[0] !== expected?.topicArn ||
    tokens.length !== 1 ||
    tokens[0] !== expected?.token
  ) {
    throw new WebhookRejected('malformed');
  }
  return url;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new WebhookRejected('signature');
    }
  }
  if (!response.body) {
    let ab: ArrayBuffer;
    try {
      ab = await response.arrayBuffer();
    } catch {
      throw new Error('SNS certificate fetch failed');
    }
    const buf = Buffer.from(ab);
    if (buf.byteLength > maxBytes) throw new WebhookRejected('signature');
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch {
        throw new Error('SNS certificate fetch failed');
      }
      if (step.done) break;
      total += step.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WebhookRejected('signature');
      }
      chunks.push(step.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function assertCertValidAt(cert: X509Certificate, now: number): void {
  const from = cert.validFromDate.getTime();
  const to = cert.validToDate.getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || now < from || now > to) {
    throw new WebhookRejected('signature');
  }
  if (cert.publicKey.asymmetricKeyType !== 'rsa') {
    throw new WebhookRejected('signature');
  }
}

interface CertFetchState {
  inFlight: Map<string, Promise<X509Certificate>>;
  failedUntil: Map<string, number>;
}

const CERT_FETCH_STATES = new WeakMap<Map<string, X509Certificate>, CertFetchState>();

function certFetchStateFor(cache: Map<string, X509Certificate>): CertFetchState {
  let state = CERT_FETCH_STATES.get(cache);
  if (!state) {
    state = { inFlight: new Map(), failedUntil: new Map() };
    CERT_FETCH_STATES.set(cache, state);
  }
  return state;
}

function recordFailedCert(state: CertFetchState, key: string, now: number): void {
  state.failedUntil.delete(key);
  if (state.failedUntil.size >= SNS_CERT_FAIL_CACHE_MAX) {
    const oldest = state.failedUntil.keys().next().value;
    if (oldest !== undefined) state.failedUntil.delete(oldest);
  }
  state.failedUntil.set(key, now + SNS_CERT_FAIL_TTL_MS);
}

async function fetchUncachedCert(key: string, fetchImpl: typeof fetch): Promise<X509Certificate> {
  let response: Response;
  try {
    response = await fetchImpl(key, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(SNS_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error('SNS certificate fetch failed');
  }
  if (response.status >= 500) {
    throw new Error('SNS certificate fetch failed');
  }
  if (!response.ok) {
    throw new WebhookRejected('signature');
  }
  const pem = await readBoundedBytes(response, SNS_CERT_MAX_BYTES);
  try {
    return new X509Certificate(pem);
  } catch {
    throw new WebhookRejected('signature');
  }
}

async function loadSigningCert(certUrl: URL, fetchImpl: typeof fetch, cache: Map<string, X509Certificate>, now: number): Promise<X509Certificate> {
  const key = certUrl.href;
  const cached = cache.get(key);
  if (cached) {
    // Refresh LRU order.
    cache.delete(key);
    try {
      assertCertValidAt(cached, now);
      cache.set(key, cached);
      return cached;
    } catch {
      throw new WebhookRejected('signature');
    }
  }
  const state = certFetchStateFor(cache);
  const failedExp = state.failedUntil.get(key);
  if (failedExp !== undefined) {
    if (now < failedExp) {
      throw new WebhookRejected('signature');
    }
    state.failedUntil.delete(key);
  }
  const pending = state.inFlight.get(key);
  if (pending) {
    const cert = await pending;
    assertCertValidAt(cert, now);
    return cert;
  }
  if (state.inFlight.size >= SNS_CERT_INFLIGHT_MAX) {
    throw new WebhookRejected('signature');
  }
  const work = (async () => {
    try {
      const cert = await fetchUncachedCert(key, fetchImpl);
      assertCertValidAt(cert, now);
      if (cache.size >= SNS_CERT_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, cert);
      return cert;
    } catch (error) {
      if (error instanceof WebhookRejected) {
        recordFailedCert(state, key, now);
      }
      throw error;
    } finally {
      state.inFlight.delete(key);
    }
  })();
  // Prevent unhandled rejection when multiple coalesced callers inspect the shared promise.
  work.catch(() => undefined);
  state.inFlight.set(key, work);
  return work;
}

type SnsEnvelopeType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';

interface SnsEnvelope {
  Type: SnsEnvelopeType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

function parseSnsEnvelope(rawBody: string, expectedTopicArn: string, now: number): SnsEnvelope {
  if (typeof rawBody !== 'string' || rawBody.length === 0) throw new WebhookRejected('malformed');
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    throw new WebhookRejected('malformed');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WebhookRejected('malformed');
  }
  const obj = raw as Record<string, unknown>;
  const type = obj['Type'];
  if (type !== 'Notification' && type !== 'SubscriptionConfirmation' && type !== 'UnsubscribeConfirmation') {
    throw new WebhookRejected('malformed');
  }
  if (typeof obj['TopicArn'] !== 'string' || obj['TopicArn'] !== expectedTopicArn) {
    throw new WebhookRejected('signature');
  }
  const sigVersion = obj['SignatureVersion'];
  if (sigVersion !== '1' && sigVersion !== '2') {
    throw new WebhookRejected('signature');
  }
  const signature = obj['Signature'];
  const signingCertUrl = obj['SigningCertURL'];
  if (typeof signature !== 'string' || signature.length === 0 || typeof signingCertUrl !== 'string' || signingCertUrl.length === 0) {
    throw new WebhookRejected('signature');
  }
  const messageId = obj['MessageId'];
  const message = obj['Message'];
  const timestamp = obj['Timestamp'];
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > MAX_ID || typeof message !== 'string' || typeof timestamp !== 'string' || timestamp.length === 0) {
    throw new WebhookRejected('malformed');
  }
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts) || Math.abs(now - ts) > SNS_TOLERANCE_MS) {
    throw new WebhookRejected('stale');
  }
  if (type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation') {
    const subscribeUrl = obj['SubscribeURL'];
    const token = obj['Token'];
    if (typeof subscribeUrl !== 'string' || subscribeUrl.length === 0 || typeof token !== 'string' || token.length === 0) {
      throw new WebhookRejected('malformed');
    }
    return {
      Type: type,
      MessageId: messageId,
      TopicArn: obj['TopicArn'],
      Message: message,
      Timestamp: timestamp,
      SignatureVersion: sigVersion,
      Signature: signature,
      SigningCertURL: signingCertUrl,
      SubscribeURL: subscribeUrl,
      Token: token,
    };
  }
  const subject = obj['Subject'];
  return {
    Type: type,
    MessageId: messageId,
    TopicArn: obj['TopicArn'],
    Message: message,
    Timestamp: timestamp,
    SignatureVersion: sigVersion,
    Signature: signature,
    SigningCertURL: signingCertUrl,
    ...(typeof subject === 'string' ? { Subject: subject } : {}),
  };
}

function buildSnsSigningString(envelope: SnsEnvelope): string {
  const fields: Array<[string, string]> =
    envelope.Type === 'Notification'
      ? [
          ['Message', envelope.Message],
          ['MessageId', envelope.MessageId],
          ...(typeof envelope.Subject === 'string' ? [['Subject', envelope.Subject] as [string, string]] : []),
          ['Timestamp', envelope.Timestamp],
          ['TopicArn', envelope.TopicArn],
          ['Type', envelope.Type],
        ]
      : [
          ['Message', envelope.Message],
          ['MessageId', envelope.MessageId],
          ['SubscribeURL', envelope.SubscribeURL as string],
          ['Timestamp', envelope.Timestamp],
          ['Token', envelope.Token as string],
          ['TopicArn', envelope.TopicArn],
          ['Type', envelope.Type],
        ];
  return fields.map(([k, v]) => `${k}\n${v}\n`).join('');
}

function verifySnsSignature(envelope: SnsEnvelope, cert: X509Certificate): void {
  const canonical = buildSnsSigningString(envelope);
  const sigBytes = Buffer.from(envelope.Signature, 'base64');
  if (sigBytes.length === 0) throw new WebhookRejected('signature');
  const algorithm = envelope.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  let valid = false;
  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonical, 'utf8');
    valid = verifier.verify(cert.publicKey, sigBytes);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new WebhookRejected('signature');
  }
}

function bounded(value: unknown, max = 64): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

interface SesMessagePayload {
  eventType?: unknown;
  notificationType?: unknown;
  mail?: { messageId?: unknown; timestamp?: unknown };
  delivery?: { timestamp?: unknown };
  deliveryDelay?: { timestamp?: unknown; delayType?: unknown };
  bounce?: { timestamp?: unknown; bounceType?: unknown; bounceSubType?: unknown };
  complaint?: { timestamp?: unknown; complaintFeedbackType?: unknown; complaintSubType?: unknown };
}

function parseSesNotification(envelope: SnsEnvelope, now: number): MailEvent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(envelope.Message);
  } catch {
    throw new WebhookRejected('malformed');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WebhookRejected('malformed');
  }
  const payload = raw as SesMessagePayload;
  const rawType = typeof payload.eventType === 'string' ? payload.eventType : typeof payload.notificationType === 'string' ? payload.notificationType : null;
  if (rawType === null) throw new WebhookRejected('malformed');
  const mapped = RECORDED_EVENTS[rawType];
  if (!mapped) return [];

  const messageId = payload.mail?.messageId;
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > MAX_ID) {
    throw new WebhookRejected('malformed');
  }

  const eventTs =
    mapped === 'delivered'
      ? payload.delivery?.timestamp
      : mapped === 'deferred'
        ? payload.deliveryDelay?.timestamp
        : mapped === 'complaint'
          ? payload.complaint?.timestamp
          : payload.bounce?.timestamp;
  const tsInput = typeof eventTs === 'string' ? eventTs : typeof payload.mail?.timestamp === 'string' ? payload.mail.timestamp : envelope.Timestamp;
  const parsedDate = new Date(tsInput);
  const occurredAt = Number.isNaN(parsedDate.getTime()) ? new Date(now).toISOString() : parsedDate.toISOString();

  const detail: Record<string, string> = {};
  let kind: MailEventKind;
  if (mapped === 'bounce') {
    const bounceType = bounded(payload.bounce?.bounceType);
    const bounceSubType = bounded(payload.bounce?.bounceSubType);
    if (bounceType) detail.bounceType = bounceType;
    if (bounceSubType) detail.bounceSubType = bounceSubType;
    kind = bounceType === 'Permanent' ? 'bounce_hard' : 'bounce_soft';
  } else if (mapped === 'complaint') {
    const feedbackType = bounded(payload.complaint?.complaintFeedbackType);
    const complaintSubType = bounded(payload.complaint?.complaintSubType);
    if (feedbackType) detail.feedbackType = feedbackType;
    if (complaintSubType) detail.complaintSubType = complaintSubType;
    kind = mapped;
  } else if (mapped === 'deferred') {
    const delayType = bounded(payload.deliveryDelay?.delayType);
    if (delayType) detail.delayType = delayType;
    kind = mapped;
  } else {
    kind = mapped;
  }

  return [
    {
      providerEventId: envelope.MessageId,
      providerMessageId: messageId,
      kind,
      occurredAt,
      detail,
    },
  ];
}

/** Verifies an AWS SNS delivery webhook for Amazon SES and extracts MailEvent records. */
export async function parseSesWebhook(options: SesWebhookOptions, request: WebhookRequest, now: number = Date.now()): Promise<MailEvent[]> {
  const region = assertValidRegion(options.region);
  assertValidTopicArn(options.snsTopicArn, region);
  const fetchImpl = options.fetch ?? fetch;
  const cache = options.certCache ?? new Map<string, X509Certificate>();
  const envelope = parseSnsEnvelope(request.body, options.snsTopicArn, now);
  const certUrl = validateSnsUrl(envelope.SigningCertURL, region, 'cert');
  const cert = await loadSigningCert(certUrl, fetchImpl, cache, now);
  verifySnsSignature(envelope, cert);

  if (envelope.Type === 'UnsubscribeConfirmation') {
    return [];
  }
  if (envelope.Type === 'SubscriptionConfirmation') {
    const subscribeUrl = validateSnsUrl(envelope.SubscribeURL as string, region, 'subscribe', {
      topicArn: envelope.TopicArn,
      token: envelope.Token as string,
    });
    let response: Response;
    try {
      response = await fetchImpl(subscribeUrl.href, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(SNS_FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new Error('SNS subscription confirmation failed');
    }
    if (response.status >= 500) {
      throw new Error('SNS subscription confirmation failed');
    }
    if (!response.ok) {
      throw new WebhookRejected('malformed');
    }
    return [];
  }
  return parseSesNotification(envelope, now);
}

/** Creates an Amazon SES v2 outbound mail provider with optional verified SNS webhook support. */
export function createSesProvider(options: SesOptions): MailProvider {
  const region = assertValidRegion(options.region);
  const url = sesEndpoint(region);
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const certCache = new Map<string, X509Certificate>();
  if (options.configurationSet !== undefined && !SES_CONFIGURATION_SET_PATTERN.test(options.configurationSet)) {
    throw new Error('invalid SES configuration set');
  }
  if (options.snsTopicArn !== undefined) {
    assertValidTopicArn(options.snsTopicArn, region);
  }

  return {
    name: 'ses',
    enabled: true,
    sendRetrySafety: 'never',
    async send(mail) {
      let built: { raw: Buffer; fromEmailAddress: string };
      try {
        built = await buildRawMime(mail, options);
      } catch {
        return { status: 'rejected', error: 'bad_request', code: 'SES_MIME_ERROR' };
      }
      const payload = JSON.stringify({
        FromEmailAddress: built.fromEmailAddress,
        ...(options.configurationSet ? { ConfigurationSetName: options.configurationSet } : {}),
        Content: {
          Raw: {
            Data: built.raw.toString('base64'),
          },
        },
      });
      const headers = signSesRequest({
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        host: url.host,
        path: url.pathname,
        body: payload,
        ...(options.now ? { now: options.now() } : {}),
      });
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers,
          body: payload,
        });
      } catch (error) {
        return {
          status: 'unknown',
          code: error instanceof Error && error.name === 'TimeoutError' ? 'SES_TIMEOUT' : 'SES_NETWORK',
        };
      }
      return classifySesResponse(response);
    },
    ...(options.snsTopicArn
      ? {
          parseWebhook: (request: WebhookRequest, now?: number) =>
            parseSesWebhook(
              {
                region: options.region,
                snsTopicArn: options.snsTopicArn as string,
                fetch: fetchImpl,
                certCache,
              },
              request,
              now,
            ),
        }
      : {}),
  };
}

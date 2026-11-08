// Inbound email: a mail worker (e.g. Cloudflare Email Routing) POSTs the raw MIME message to
// /api/inbound/email with a shared secret. The recipient <token>@INBOUND_DOMAIN selects the org.
//
// The API only verifies the secret, limits the size, stores the raw bytes and enqueues them
// (acceptInboundEmail). Resolving the org and kernel.inbound.receive run in the worker (processInboundEmail),
// the only role that may enter system context (External-tenant gate T5). The worker does not parse the MIME
// message itself: crove-extract does, and its answer is validated and treated as untrusted (gate T12).
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { EXTRACT_LIMIT_RETRIES, type ExtractClient, type ExtractedEmail } from '@crove/extract-contract';
import {
  ACCEPTED_ARCHIVE_TYPES,
  ACCEPTED_UPLOAD_TYPES,
  CONVERSATION_BODY_MAX,
  EMAIL_REFS_MAX,
  EMAIL_SUBJECT_MAX,
  isMailAddress,
  MAX_EMAIL_ARCHIVES,
  MAX_UPLOAD_BYTES,
  type ConversationEvent,
  type ConversationIngested,
} from '@crove/kernel-contract';
import type { UsageLimits, UsageOver } from '@crove/kernel';
import { BlobConflictError, DomainError, fileKey, inboundKey, newInboundBlobId, putFile, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { readLookupHints, type LookupHint } from '@crove/l10n-vn';
import { isCsvName, safeFilename, sniffType } from './sniff.ts';
import { mailFilesNote, readMailFiles, type MailImage } from './conversation-mail-files.ts';

export const MAX_EMAIL_BYTES = 40 * 1024 * 1024;
const TOKEN = /^[0-9a-f]{24}$/;
const MAX_ADDRESS_LENGTH = 320;

// Whether the Authorization header carries one of the secrets: INBOUND_SECRET and, during a rotation,
// INBOUND_SECRET_PREVIOUS (#1214). Each is compared in constant time over SHA-256 digests, which have the same length
// whatever the values, and every secret is compared whatever the earlier ones gave: the time taken tells neither which
// one matched nor how long either is.
export function secretMatches(header: string | undefined, secrets: readonly string[]): boolean {
  const presented = createHash('sha256').update(header?.startsWith('Bearer ') ? header.slice(7) : '').digest();
  let matched = false;
  for (const secret of secrets) matched = timingSafeEqual(presented, createHash('sha256').update(secret).digest()) || matched;
  return matched;
}

// The org token of <token>[+tag]@domain, or null (a document address or the Inbox's own: both are a random token before the @).
function tokenOf(address: string, domain: string): string | null {
  const suffix = `@${domain.toLowerCase()}`;
  const normalized = address.toLowerCase().trim();
  if (!normalized.endsWith(suffix)) return null;
  const token = normalized.slice(0, -suffix.length).split('+')[0] ?? '';
  return TOKEN.test(token) ? token : null;
}

// The bounce token of bounce+<token>@domain (#539: the Return-Path of a mail Crove sent over SMTP), or null.
const BOUNCE = /^bounce\+([0-9a-f]{48})$/;
export function bounceTokenOf(address: string, domain: string): string | null {
  const suffix = `@${domain.toLowerCase()}`;
  const normalized = address.toLowerCase().trim();
  if (!normalized.endsWith(suffix)) return null;
  return BOUNCE.exec(normalized.slice(0, -suffix.length))?.[1] ?? null;
}

const unknownRecipient = () => new DomainError('UNKNOWN_RECIPIENT', 404, 'Địa chỉ nhận không hợp lệ');

export interface InboundAcceptDeps {
  runtime: Runtime;
  store: BlobStore;
  domain: string;
}

// API side: no parsing and no tenant context. An envelope recipient on INBOUND_DOMAIN that cannot be a
// Crove address is refused before anything is stored; the token itself is resolved by the worker. A
// recipient on another domain is kept, and the worker falls back to the message headers, as before.
// Each delivery gets its own blob; when the same message to the same recipient is already pending, or the
// enqueue fails (503 past the backlog cap), the new blob is deleted again.
export async function acceptInboundEmail(
  deps: InboundAcceptDeps,
  raw: Uint8Array,
  envelopeRecipient: string | null,
): Promise<{ accepted: true; sha256: string }> {
  if (raw.byteLength === 0) throw new DomainError('EMPTY_MESSAGE', 400, 'Thư rỗng');
  if (raw.byteLength > MAX_EMAIL_BYTES) throw new DomainError('TOO_LARGE', 413, 'Thư vượt quá 40 MB');
  const recipient = envelopeRecipient?.trim().toLowerCase() || null;
  if (recipient !== null) {
    const onDomain = recipient.endsWith(`@${deps.domain.toLowerCase()}`);
    if (recipient.length > MAX_ADDRESS_LENGTH || (onDomain && !tokenOf(recipient, deps.domain) && !bounceTokenOf(recipient, deps.domain))) throw unknownRecipient();
  }
  const sha256 = sha256Hex(raw);
  const blobId = newInboundBlobId();
  const key = inboundKey(blobId);
  await deps.store.put(key, raw, 'message/rfc822');
  let queued = false;
  try {
    queued = await deps.runtime.orgless(async (db) => {
      const { rows } = await sql<{ queued: boolean }>`
        SELECT crove_kernel.inbound_enqueue(${blobId}, ${sha256}, ${raw.byteLength}::bigint, ${recipient}) AS queued`.execute(db);
      return rows[0]?.queued === true;
    });
  } finally {
    if (!queued) await deps.store.delete(key);
  }
  return { accepted: true, sha256 };
}

// Counts a message dropped for an unknown recipient against the org whose address it was, when the token is an
// address that org retired less than 30 days ago; any other token changes nothing (crove_kernel.inbound_drop_record).
// Best effort: the message is dropped either way, so a failure to count is logged and does not retry the job.
async function countDrop(runtime: Runtime, token: string): Promise<void> {
  try {
    await runtime.orgless((db) => sql`SELECT crove_kernel.inbound_drop_record(${token})`.execute(db));
  } catch (error) {
    console.error('[inbound] could not count a dropped message', error);
  }
}

export interface InboundJob {
  blobId: string;
  sha256: string;
  sizeBytes: number;
  recipient: string | null;
}

// The name the receiving mail server writes in its Authentication-Results (INBOUND_AUTHSERV_ID), set once at start as the Message-ID domain is, so the worker's
// dependencies stay as declared (the job egress invariant). A test passes its own through the deps.
let configuredAuthservId: string | undefined;
export function setInboundAuthservId(value: string | null | undefined): void {
  configuredAuthservId = value ?? undefined;
}

export interface InboundProcessDeps {
  runtime: Runtime;
  store: BlobStore;
  domain: string | null;
  // crove-extract parses the message.
  extract: ExtractClient;
  // The per-org abuse limits (#675); without them no limit is checked.
  limits?: UsageLimits | undefined;
  // The name the receiving mail server writes as the authserv-id of its Authentication-Results header (INBOUND_AUTHSERV_ID, RFC 8601). Only a result
  // written by this server is believed; unset, no sender is verified (#2439).
  authservId?: string | undefined;
}

// A message kept for later because its org is over a daily limit (#675): the worker queues it again for retryAt and
// keeps its raw blob.
export interface InboundDeferred {
  deferred: string;
}

// Worker side: has the stored message parsed, resolves the org by token and records it in system context.
// Idempotent: kernel.inbound.receive ignores a messageId the org has already received. The blob must match
// the hash and size the API enqueued; a mismatch is refused like any message no org can receive.
// `attempt` is the job's retry count (0 on the first run).
export async function processInboundEmail(deps: InboundProcessDeps, job: InboundJob, attempt = 0) {
  if (!deps.domain) throw new Error('INBOUND_DOMAIN is not set on the worker');
  const domain = deps.domain;
  const rawSha256 = job.sha256;
  const raw = await deps.store.get(inboundKey(job.blobId));
  if (raw.byteLength !== job.sizeBytes || sha256Hex(raw) !== rawSha256) {
    throw new DomainError('INBOUND_BLOB_MISMATCH', 422, 'Thư lưu không khớp với hàng đợi');
  }
  // A bounce report to a mail's Return-Path (#539): read as a DSN, never filed as an inbound message.
  const bounceToken = job.recipient ? bounceTokenOf(job.recipient, domain) : null;
  if (bounceToken) return processBounceReport(deps, raw, rawSha256, bounceToken, attempt);
  // A message the sandbox finds invalid or too large is dropped like any message no org can receive. A timeout or
  // memory limit can also come from load on the sandbox, so it is retried, but only EXTRACT_LIMIT_RETRIES times:
  // a hostile message must not hold the single parser slot, which every tenant shares, again and again. After
  // that it is dropped too. A sandbox that cannot answer throws ExtractServiceError and is retried as before.
  const parsed = await deps.extract.extract('mime', raw);
  if (!parsed.ok) {
    const limitHit = parsed.code === 'timeout' || parsed.code === 'memory';
    if (limitHit && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${parsed.code}`);
    throw new DomainError('UNREADABLE_MESSAGE', 422, 'Không đọc được thư');
  }
  const email = parsed.email;
  const recipients = [job.recipient, email.deliveredTo, ...email.to].filter((r): r is string => typeof r === 'string' && r !== '');
  // The address this delivery was for: the first of ours, the envelope recipient before the headers'. It alone decides the org, so a retired address is
  // never replaced by another of ours that a header names.
  const token = recipients.map((r) => tokenOf(r, domain)).find((t) => t !== null);
  if (!token) throw unknownRecipient();

  // The org is resolved now, when the message is processed, not when the API accepted it. So mail queued for a token
  // that the org rotated away in between is dropped here like mail to a token that never existed (plan §7.6, #113):
  // right for a leaked address, but a supplier's legitimate mail in that window is lost without a bounce. So the drop
  // is counted for the org that owned a retired token (#139): only the count, nothing about the message.
  // The Inbox's own address (#2439) is a token of its own, so it is tried first and a mail to it never reaches the invoice reader.
  let toConversation = false;
  const orgId = await deps.runtime.orgless(async (db) => {
    const inbox = await sql<{ org_id: string | null }>`SELECT crove_kernel.org_by_conversation_token(${token}) AS org_id`.execute(db);
    if (inbox.rows[0]?.org_id) {
      toConversation = true;
      return inbox.rows[0].org_id;
    }
    const documents = await sql<{ org_id: string | null }>`SELECT crove_kernel.org_by_inbound_token(${token}) AS org_id`.execute(db);
    return documents.rows[0]?.org_id ?? null;
  });
  if (!orgId) {
    await countDrop(deps.runtime, token);
    throw unknownRecipient();
  }

  // Over a daily limit of the org (#675) the message is kept, not filed: the worker tries it again once the org is back
  // under it. The check comes before anything is stored for the org.
  if (deps.limits) {
    const actor = { type: 'system' as const, component: 'inbound.email' };
    const { inbound_emails, attachment_bytes, conversation_emails } = deps.limits;
    // Customer mail to the Inbox has a budget of its own, so spam on a published address never defers an invoice.
    const over = await deps.runtime.query<UsageOver | null>(
      'kernel.usage.over',
      toConversation
        ? { metrics: ['conversation_emails'], limits: { conversation_emails } }
        : { metrics: ['inbound_emails', 'attachment_bytes'], limits: { inbound_emails, attachment_bytes } },
      { actor, orgId },
    );
    if (over) {
      await deps.runtime.execute('kernel.usage.defer', { metric: over.metric, subjectType: 'inbound_email', subjectId: rawSha256, retryAt: over.retryAt }, { actor, orgId });
      return { deferred: over.retryAt } satisfies InboundDeferred;
    }
  }

  if (toConversation) return processConversationEmail(deps, orgId, email, rawSha256, domain);

  const files = [];
  let archives = 0;
  for (const attachment of email.attachments.slice(0, 20)) {
    const decoded = Buffer.from(attachment.content, 'base64');
    const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) continue;
    // Signatures, logos and other attachments that are not invoices are skipped by their content.
    const contentType = sniffType(bytes);
    if (!contentType) continue;
    // A ZIP (#432) is filed like an uploaded one and opened by the extraction job (archive.ts), which files at most
    // MAX_EMAIL_ARCHIVE_DOCUMENTS of its documents; past MAX_EMAIL_ARCHIVES ZIPs the message's others are skipped.
    if (ACCEPTED_ARCHIVE_TYPES.includes(contentType)) {
      if (archives >= MAX_EMAIL_ARCHIVES) continue;
      archives += 1;
    } else if (!ACCEPTED_UPLOAD_TYPES.includes(contentType)) {
      continue;
    } else if (contentType === 'text/csv' && !isCsvName(attachment.filename ?? '')) {
      // A bank statement as CSV (#2142), by its name too: a signature or a note with commas in it is no statement.
      continue;
    }
    const filename = safeFilename(attachment.filename ?? 'tep-dinh-kem', contentType);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(deps.store, storageKey, bytes, contentType, sha256);
    files.push({ filename, contentType, sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'email' as const });
  }
  const messageId = email.messageId ?? `sha256:${rawSha256}`;
  // A mail with no invoice attachment whose text holds the seller's lookup link or code (#2286, plan
  // docs/plan/einvoice-lookup.md): the reader is deterministic and follows no link; where finance does not run there is
  // nobody to look the original up. A reader failure never loses the mail.
  const lookupHints = files.length === 0 && deps.runtime.modules().includes('finance') && email.text ? safeLookupHints(email.text) : [];
  return deps.runtime.execute<{ duplicate: boolean; fileIds: string[] }>(
    'kernel.inbound.receive',
    {
      messageId: messageId.slice(0, 500),
      from: email.from,
      subject: email.subject?.slice(0, 500) ?? null,
      // The mail's text (#779), for an AI draft of a Social post a member may start from it: kept only where the
      // deployment runs Social, so one without it keeps no more of a mail than before; absent from an older extract
      // container's answer.
      text: deps.runtime.modules().includes('social') ? (email.text ?? null) : null,
      ...(lookupHints.length > 0 ? { lookupHints } : {}),
      files,
    },
    { actor: { type: 'system', component: 'inbound.email' }, orgId },
  );
}

const CLOCK_SKEW_MS = 5 * 60_000;
const MESSAGE_ID = /^<[^<>\s]{1,298}>$/;
const NO_TEXT = '[Thư không có nội dung chữ]';
const NO_TEXT_IMAGES = '[Thư không có chữ, chỉ có ảnh đính kèm]';
// A mail dated further ahead than this is dated now: a clock set wrong must not put a thread's newest message in the future.

export type ConversationMail = { event: ConversationEvent; images: MailImage[] } | { ignored: 'automated' | 'own_address' | 'no_sender' };

// The event a customer's mail is in the conversation core's words (#2439), or why it opens none. A bulk, list or auto-generated mail opens no
// conversation, and neither does one sent from this deployment's own mail domain (the system's mail, or the org writing to itself): a
// conversation never replies by itself, so no loop can start. The thread is not decided here: the core finds it from the Message-IDs named in
// `refs`, within the org, and never by subject. Text from the mail is tainted external text and stays text: the extract sandbox reduced any HTML to
// text already. Its attachments are read by readMailFiles (#2758): images are kept (the event says how many, the bytes go to the store, never in the
// event) and every other file is listed by name, size and type at the end of the text.
export function conversationEventOf(email: ExtractedEmail, rawSha256: string, domain: string, now: Date, authservId?: string, storeImages = true): ConversationMail {
  if (email.automated === true) return { ignored: 'automated' };
  if (email.multipleFrom === true) return { ignored: 'no_sender' };
  const sender = (email.from ?? '').trim().toLowerCase();
  // One mailbox only: a header like "<a@x.test,b@y.test>" is read by the parser as one address and by a mailer as two recipients.
  // The contract of a contact id is 200 characters, so a longer (valid) address is not one this intake can keep.
  if (!isMailAddress(sender) || sender.length > 200) return { ignored: 'no_sender' };
  if (sender.endsWith(`@${domain.toLowerCase()}`)) return { ignored: 'own_address' };
  const given = (email.messageId ?? '').trim();
  const messageId = MESSAGE_ID.test(given) ? given : `<sha256-${rawSha256}@mail.invalid>`;
  // In-Reply-To comes last, the nearest ancestor, so the cut to the last ones never drops it.
  const refs = [...new Set([...(email.references ?? []), email.inReplyTo ?? ''].map((r) => r.trim()).filter((r) => MESSAGE_ID.test(r) && r !== messageId))].slice(-EMAIL_REFS_MAX);
  const written = (email.text ?? '').trim();
  const files = readMailFiles(email.attachments, storeImages);
  const note = mailFilesNote(files.lines);
  const body = written === '' ? (files.images.length > 0 ? NO_TEXT_IMAGES : NO_TEXT) : written;
  const text = `${body.slice(0, CONVERSATION_BODY_MAX - note.length - 2)}${note === '' ? '' : `\n\n${note}`}`;
  const sent = email.sentAt ? Date.parse(email.sentAt) : Number.NaN;
  // The sender's clock is trusted a few minutes ahead at most; backdated mail keeps its date (the core dates the thread's activity itself).
  const at = new Date(Number.isNaN(sent) || sent > now.getTime() + CLOCK_SKEW_MS ? now.getTime() : sent).toISOString();
  // A NUL is refused by the conversation contract, which would drop the whole mail: it goes with the line breaks.
  // oxlint-disable-next-line no-control-regex
  const subject = (email.subject ?? '').replace(/[\u0000\r\n\t]+/g, ' ').trim().slice(0, EMAIL_SUBJECT_MAX);
  // oxlint-disable-next-line no-control-regex
  const name = (email.fromName ?? '').replace(/[\u0000\r\n\t]+/g, ' ').trim().slice(0, 200);
  return {
    images: files.images,
    event: {
      kind: 'email',
      threadId: messageId,
      messageId,
      direction: 'in',
      contact: { id: sender, name: name || sender },
      text,
      at,
      ...(subject ? { subject } : {}),
      ...(refs.length > 0 ? { refs } : {}),
      verified: senderVerified(email.authResults ?? [], authservId, sender.slice(sender.lastIndexOf('@') + 1)),
      ...(files.images.length > 0 ? { mailImages: files.images.length, mailImageBytes: files.images.reduce((sum, i) => sum + i.bytes.byteLength, 0) } : {}),
    },
  };
}

// An Authentication-Results value with its comments (RFC 8601 section 2.2: "( ... )", nested, with quoted pairs) removed and its quoted strings emptied,
// except a quoted string that is only letters, digits, dots and hyphens (a domain written in quotes, which the RFC allows for a property value): that is
// kept without its quotes, since nothing in it can end a result or start another. A comment or a quoted string may hold text the sender chose (an envelope
// sender with a quoted local part, the "designates" note of an SPF check) and may hold a ";", so neither is read as a result. Null when the value is not
// well formed (an unclosed comment or quote).
function plainResults(value: string): string | null {
  let out = '';
  let depth = 0;
  let quoted: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (depth > 0) {
      if (ch === '\\') i++;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      continue;
    }
    if (quoted !== null) {
      if (ch === '\\') {
        i++;
        quoted += '\\';
      } else if (ch === '"') {
        out += /^[A-Za-z0-9.-]{1,253}$/.test(quoted) ? quoted : '""';
        quoted = null;
      } else quoted += ch;
      continue;
    }
    if (ch === '(') {
      depth = 1;
      out += ' ';
    } else if (ch === '"') quoted = '';
    else out += ch;
  }
  return depth > 0 || quoted !== null ? null : out;
}

// The authserv-id a header starts with, after any comments and white space before it (RFC 8601 allows CFWS there): a token or a quoted string, lower case.
// Null when it cannot be read (an unclosed comment before it, or nothing).
function authservIdOf(line: string): string | null {
  let i = 0;
  for (;;) {
    while (i < line.length && /\s/.test(line[i] as string)) i++;
    if (line[i] !== '(') break;
    let depth = 0;
    for (; i < line.length; i++) {
      const ch = line[i] as string;
      if (ch === '\\') i++;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) {
        i++;
        break;
      }
    }
    if (depth > 0) return null;
  }
  const quoted = line[i] === '"' ? /^"((?:[^"\\]|\\.)*)"/.exec(line.slice(i))?.[1] : undefined;
  const id = quoted ?? /^[^\s;()"]+/.exec(line.slice(i))?.[0];
  return id ? id.toLowerCase() : null;
}

// Whether the receiving mail server vouched for the sender's domain (RFC 8601): the topmost Authentication-Results header written by our own server
// (its authserv-id is `authservId`; a header any earlier hop wrote could say anything), with dmarc=pass for the From domain (header.from), or dkim=pass for a
// signing domain (header.d) the From domain is, or is a subdomain of. Each result is read as `method=result` at the start of its own `;` segment, after the
// comments and quoted strings are gone. The headers are read from the top: one whose authserv-id cannot be read, or which is ours and not well formed,
// ends the search as not verified, so a header below it can never decide in its place. With no authserv-id configured nothing is verified.
export function senderVerified(results: readonly string[], authservId: string | undefined, fromDomain: string): boolean {
  if (!authservId) return false;
  const ours = authservId.trim().toLowerCase();
  let own: string | null = null;
  for (const line of results) {
    const id = authservIdOf(line);
    if (id === null) return false;
    if (id !== ours) continue;
    own = plainResults(line);
    if (own === null) return false;
    break;
  }
  if (own === null) return false;
  const methods = own
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase());
  const from = fromDomain.toLowerCase();
  const property = (resinfo: string, name: string): string | undefined => new RegExp(`(?:^|\\s)${name.replace('.', '\\.')}=([a-z0-9.-]+)(?:\\s|$)`).exec(resinfo)?.[1];
  return methods.some((m) => {
    if (/^dmarc=pass(?:\s|$)/.test(m)) return property(m, 'header.from') === from;
    if (!/^dkim=pass(?:\s|$)/.test(m)) return false;
    const signer = property(m, 'header.d');
    return signer !== undefined && (from === signer || from.endsWith(`.${signer}`));
  });
}

export interface ConversationMailResult {
  conversation: 'stored' | 'duplicate' | 'ignored';
  reason?: string;
}

// A customer's mail to the org's conversation address: the intake of the Inbox, in the org the address names, as the system. Idempotent: a redelivery
// of the same Message-ID is a duplicate and changes nothing.
async function processConversationEmail(deps: InboundProcessDeps, orgId: string, email: ExtractedEmail, rawSha256: string, domain: string): Promise<ConversationMailResult> {
  const options = { actor: { type: 'system' as const, component: 'inbound.conversation' }, orgId };
  // Mailed images count in the org's day of attachment bytes, but conversation spam may use a quarter of it at most, so a flood on the published address
  // never defers the invoice reader. Over that, the mail's text still arrives and its images are listed like any other file.
  let storeImages = true;
  if (deps.limits && email.attachments.length > 0) {
    const quarter = String(Math.floor(Number(deps.limits.attachment_bytes) / 4));
    storeImages = (await deps.runtime.query<UsageOver | null>('kernel.usage.over', { metrics: ['attachment_bytes'], limits: { attachment_bytes: quarter } }, options)) === null;
  }
  const made = conversationEventOf(email, rawSha256, domain, new Date(), deps.authservId ?? configuredAuthservId, storeImages);
  if ('ignored' in made) return { conversation: 'ignored', reason: made.ignored };
  const out = await deps.runtime.execute<ConversationIngested>('kernel.conversation.email_ingest', { events: [made.event] }, options);
  await storeMailImages(deps, made.images, out.images ?? [], options);
  return { conversation: out.stored > 0 ? 'stored' : out.duplicates > 0 ? 'duplicate' : 'ignored' };
}

// Writes the bytes of a mail's images under the keys the core reserved and records them (#2758). The reserved rows are the mail's last ones: a redelivery
// after a worker died hands out only the rows still waiting, which are the images not yet written (they are written in order), so the images are
// paired from the end. A store that fails throws, so the job is tried again (the rows stay reserved, and an hour later a row nobody wrote is dropped);
// bytes that meet other bytes under their key drop that image alone. Nothing of the image or its name is logged.
async function storeMailImages(
  deps: InboundProcessDeps,
  images: readonly MailImage[],
  slots: ReadonlyArray<{ attachmentId: string; storageKey: string }>,
  options: { actor: { type: 'system'; component: string }; orgId: string },
): Promise<void> {
  const mine = images.slice(Math.max(0, images.length - slots.length));
  for (const [i, slot] of slots.entries()) {
    const image = mine[i];
    if (!image) break;
    let generation: string;
    try {
      generation = await putFile(deps.store, slot.storageKey, image.bytes, image.contentType, image.sha256);
    } catch (error) {
      if (!(error instanceof BlobConflictError)) throw error;
      await deps.runtime.execute('kernel.conversation.attachment_record', { outcome: 'failed', attachmentId: slot.attachmentId, retry: false, code: 'STORE_CONFLICT' }, options);
      continue;
    }
    await deps.runtime.execute(
      'kernel.conversation.attachment_record',
      { outcome: 'stored', attachmentId: slot.attachmentId, sha256: image.sha256, sizeBytes: image.bytes.byteLength, contentType: image.contentType, generation, width: image.width, height: image.height },
      options,
    );
  }
}

function safeLookupHints(text: string): LookupHint[] {
  try {
    return readLookupHints(text);
  } catch {
    return [];
  }
}

// What a recipient's report does (#539): a permanent failure (status 5.x.x) is a hard bounce; a temporary one, or a
// failure without a status, a soft bounce; a delay is deferred; a delivery report says delivered. "relayed" and
// "expanded" say nothing about the mailbox (RFC 3464 §2.3.3), so they record nothing.
const OUTCOMES: ReadonlySet<string> = new Set(['failed', 'delayed', 'delivered']);
function bounceKind(recipient: { action: string; status: string | null }): 'bounce_hard' | 'bounce_soft' | 'deferred' | 'delivered' {
  if (recipient.action === 'failed') return recipient.status?.startsWith('5.') ? 'bounce_hard' : 'bounce_soft';
  if (recipient.action === 'delayed') return 'deferred';
  return 'delivered';
}

export interface BounceResult {
  duplicate: boolean;
  fileIds: string[];
  bounce: 'bounce_hard' | 'bounce_soft' | 'deferred' | 'delivered';
}

// A DSN for one of Crove's SMTP mails (#539): parsed in the sandbox, matched to its mail by the token of the address
// it came to (a made-up or altered token finds nothing), and recorded as that mail's delivery event in the mail's org.
// A report that is not a DSN, names no mail of Crove, or quotes another Message-ID is dropped.
async function processBounceReport(deps: InboundProcessDeps, raw: Uint8Array, rawSha256: string, token: string, attempt: number): Promise<BounceResult> {
  const parsed = await deps.extract.extract('dsn', raw);
  if (!parsed.ok) {
    const limitHit = parsed.code === 'timeout' || parsed.code === 'memory';
    if (limitHit && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${parsed.code}`);
    throw new DomainError('UNREADABLE_BOUNCE', 422, 'Không đọc được báo cáo trạng thái gửi thư');
  }
  const mail = await deps.runtime.orgless(async (db) => {
    const { rows } = await sql<{ org_id: string; message_id: string; message_id_header: string }>`
      SELECT org_id, message_id, message_id_header FROM crove_kernel.mail_message_by_bounce_token(${token})`.execute(db);
    return rows[0] ?? null;
  });
  if (!mail) throw new DomainError('UNKNOWN_BOUNCE', 404, 'Báo cáo trạng thái gửi không ứng với thư nào');
  const report = parsed.report;
  // Compared without case: a relay may change the case of the domain, and the token already names exactly one mail.
  if (report.originalMessageId !== null && report.originalMessageId.toLowerCase() !== mail.message_id_header.toLowerCase()) {
    throw new DomainError('BOUNCE_MISMATCH', 422, 'Báo cáo trạng thái gửi nói về một thư khác');
  }
  // The mail had one recipient, so the report's first outcome is about it.
  const recipient = report.recipients.find((r) => OUTCOMES.has(r.action));
  if (!recipient) throw new DomainError('UNREADABLE_BOUNCE', 422, 'Không đọc được báo cáo trạng thái gửi thư');
  const kind = bounceKind(recipient);
  await deps.runtime.execute(
    'kernel.mail.event.record',
    {
      messageId: mail.message_id,
      provider: 'smtp',
      // The report itself: a redelivered report is the same event.
      providerEventId: `dsn:${rawSha256}`,
      kind,
      occurredAt: new Date().toISOString(),
      detail: recipient.status ? { status: recipient.status } : {},
    },
    { actor: { type: 'system', component: 'inbound.bounce' }, orgId: mail.org_id },
  );
  return { duplicate: false, fileIds: [], bounce: kind };
}

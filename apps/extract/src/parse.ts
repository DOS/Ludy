// The parsers. Runs only inside a parser process started by sandbox.ts: no network, no file writes, no child
// processes, no environment and a capped heap. Every answer is checked against the shared contract before it
// leaves, so the worker never sees a shape it does not expect.
import PostalMime from 'postal-mime';
import type { Address } from 'postal-mime';
import { EXTRACT_LIMITS, zExtractSuccess, type ExtractFailure, type ExtractKind, type ExtractResponse, type ExtractSuccess } from '@crove/extract-contract';
import { DsnError, readDsn } from './dsn.ts';
import { EInvoiceParseError, parseEInvoiceXml } from './einvoice-xml.ts';
import { HtmlMetaError, htmlText, readHtmlMeta } from './html-meta.ts';
import { FeedError, readFeed } from './feed.ts';
import { PortalListError, readPortalList } from './portal-list.ts';
import { ArchiveError, readZip } from './zip.ts';
import { readBankStatement } from './bank-statement.ts';

const MiB = 1024 * 1024;

export function failure(code: ExtractFailure['code'], message: string): ExtractFailure {
  return { ok: false, code, message: message.slice(0, EXTRACT_LIMITS.maxErrorChars) };
}

function cap(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.slice(0, EXTRACT_LIMITS.maxStringChars);
}

async function pdfText(bytes: Uint8Array): Promise<ExtractSuccess> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  // Never let pdf.js evaluate code from the document; the process also refuses code generation from strings.
  const pdf = await getDocumentProxy(bytes, { isEvalSupported: false } as Parameters<typeof getDocumentProxy>[1]);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const joined = Array.isArray(text) ? text.join('\n') : text;
  return { ok: true, kind: 'pdf_text', text: joined.slice(0, EXTRACT_LIMITS.maxTextChars), pages: totalPages };
}

function addressOf(address: Address | undefined): string | null {
  return address && typeof address.address === 'string' && address.address !== '' ? address.address : null;
}

// The Message-IDs a header names, "<id>" each: References holds a list, In-Reply-To one or more. Anything that is not an angle-bracketed id is
// dropped, so a header cannot smuggle text through; at most maxMailRefs, the last ones (the nearest ancestors) kept.
function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  const found = value.match(/<[^<>\s]{1,300}>/g) ?? [];
  return [...new Set(found)].slice(-EXTRACT_LIMITS.maxMailRefs);
}

// A bulk, list or auto-generated mail (RFC 3834 and the usual markers): the Inbox opens no conversation for it and never answers it.
function isAutomated(headers: ReadonlyArray<{ key: string; value: string }>): boolean {
  const header = (name: string): string | undefined => headers.find((h) => h.key.toLowerCase() === name)?.value.trim().toLowerCase();
  const autoSubmitted = header('auto-submitted');
  if (autoSubmitted !== undefined && autoSubmitted !== 'no') return true;
  const precedence = header('precedence');
  if (precedence !== undefined && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return true;
  return ['list-id', 'list-unsubscribe', 'x-autoreply', 'x-autorespond'].some((name) => header(name) !== undefined);
}

// The Authentication-Results headers, topmost first (a receiving server adds its own on top), unfolded and cut; at most maxAuthResults.
function authResultsOf(headers: ReadonlyArray<{ key: string; value: string }>): string[] {
  return headers
    .filter((h) => h.key.toLowerCase() === 'authentication-results')
    .slice(0, EXTRACT_LIMITS.maxAuthResults)
    .map((h) => h.value.replace(/\s+/g, ' ').trim().slice(0, EXTRACT_LIMITS.maxAuthResultChars));
}

function sentAtOf(date: string | undefined): string | null {
  if (!date) return null;
  const time = Date.parse(date);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function base64Of(content: ArrayBuffer | Uint8Array | string, encoding: string | undefined): string {
  if (typeof content === 'string') return encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64');
  return Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content)).toString('base64');
}

// A mail's text (#779): its text/plain part, else its HTML reduced to text, at most maxMailTextChars; null when it has
// none. Control characters are dropped and blank lines collapse to one, so the text stays readable.
function mailText(text: string | undefined, html: string | undefined): string | null {
  const max = EXTRACT_LIMITS.maxMailTextChars;
  if (text && text.trim()) {
    const lines = text
      .replace(/\r\n?/g, '\n')
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd());
    const kept = lines.filter((line, i) => line !== '' || (i > 0 && lines[i - 1] !== '')).join('\n').trim();
    // Cut in UTF-16 units, never inside a surrogate pair: within the contract's length and the column's characters.
    const end = kept.length > max && kept.charCodeAt(max - 1) >= 0xd800 && kept.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
    if (kept) return kept.slice(0, end).trim() || null;
  }
  return html ? htmlText(html, max) : null;
}

async function mime(bytes: Uint8Array): Promise<ExtractSuccess> {
  const email = await PostalMime.parse(bytes, {
    attachmentEncoding: 'base64',
    maxNestingDepth: 32,
    maxHeadersSize: 1 * MiB,
    maxPartCount: 1000,
  });
  return {
    ok: true,
    kind: 'mime',
    email: {
      messageId: cap(email.messageId),
      from: cap(addressOf(email.from)),
      subject: cap(email.subject),
      text: mailText(email.text, email.html),
      deliveredTo: cap(email.deliveredTo),
      to: (email.to ?? [])
        .map(addressOf)
        .filter((a): a is string => a !== null)
        .slice(0, EXTRACT_LIMITS.maxRecipients)
        .map((a) => a.slice(0, EXTRACT_LIMITS.maxStringChars)),
      // Only the first parts are returned, as the worker has always read them.
      attachments: email.attachments.slice(0, EXTRACT_LIMITS.maxAttachments).map((a) => ({
        filename: cap(a.filename),
        content: base64Of(a.content, a.encoding),
      })),
      fromName: cap(email.from?.name?.trim() || null),
      sentAt: sentAtOf(email.date),
      inReplyTo: cap(messageIds(email.inReplyTo)[0] ?? null),
      references: messageIds(email.references),
      automated: isAutomated(email.headers),
      authResults: authResultsOf(email.headers),
    },
  };
}

// A bounce report (#539): the same MIME reader, then the delivery-status part.
async function dsn(bytes: Uint8Array): Promise<ExtractSuccess> {
  const email = await PostalMime.parse(bytes, { attachmentEncoding: 'base64', maxNestingDepth: 32, maxHeadersSize: 1 * MiB, maxPartCount: 1000 });
  return { ok: true, kind: 'dsn', report: readDsn(email) };
}

async function parseKind(kind: ExtractKind, bytes: Uint8Array): Promise<ExtractSuccess> {
  switch (kind) {
    case 'einvoice_xml':
      // fast-xml-parser decoding the predefined XML entities and character references (and HTML names, see its options);
      // DOCTYPE and ENTITY are refused before parsing, so no entity can be declared.
      return { ok: true, kind, invoice: { ...parseEInvoiceXml(bytes), source: 'einvoice_xml' } };
    case 'pdf_text':
      return pdfText(bytes);
    case 'mime':
      return mime(bytes);
    case 'zip':
      // The entries come back as bytes; the worker sniffs and files each one, and each document is then read alone.
      return { ok: true, kind, archive: readZip(bytes) };
    case 'portal_invoice_list':
      // The tax portal's purchase list (#465): the first sheet of an .xlsx, read into checked rows.
      return { ok: true, kind, list: readPortalList(bytes) };
    case 'dsn':
      return dsn(bytes);
    case 'html_meta':
      // A web page's head, for a link preview (#641).
      return { ok: true, kind, page: readHtmlMeta(bytes) };
    case 'feed':
      // A blog's RSS or Atom feed, for Social drafts (#708).
      return { ok: true, kind, feed: readFeed(bytes) };
    case 'bank_statement':
      // A bank's statement (#2142): .xlsx or CSV, the lines read by the browser import's header detection.
      return { ok: true, kind, statement: readBankStatement(bytes) };
  }
}

const UNREADABLE: Record<ExtractKind, string> = {
  einvoice_xml: 'Không đọc được XML hóa đơn điện tử',
  pdf_text: 'Không đọc được tệp PDF',
  mime: 'Không đọc được thư điện tử',
  zip: 'Không mở được tệp ZIP',
  portal_invoice_list: 'Không đọc được danh sách hóa đơn từ cổng thuế',
  dsn: 'Không đọc được báo cáo trạng thái gửi thư',
  html_meta: 'Không đọc được trang web',
  feed: 'Không đọc được nguồn tin',
  bank_statement: 'Không đọc được sao kê ngân hàng',
};

export async function parse(kind: ExtractKind, bytes: Uint8Array): Promise<ExtractResponse> {
  let result: ExtractSuccess;
  try {
    result = await parseKind(kind, bytes);
  } catch (error) {
    // The e-invoice parser and the ZIP reader explain what is wrong; other parser errors are not passed on.
    if (error instanceof EInvoiceParseError || error instanceof ArchiveError || error instanceof PortalListError || error instanceof DsnError || error instanceof HtmlMetaError || error instanceof FeedError) return failure('invalid', error.message);
    // A stack overflow (deeply nested input) or an impossible allocation: the input is beyond what we read.
    if (error instanceof RangeError) return failure('invalid', `${UNREADABLE[kind]}: tệp vượt giới hạn xử lý`);
    return failure('invalid', UNREADABLE[kind]);
  }
  const checked = zExtractSuccess.safeParse(result);
  if (!checked.success) return failure('invalid', `${UNREADABLE[kind]}: dữ liệu vượt giới hạn cho phép`);
  return checked.data;
}

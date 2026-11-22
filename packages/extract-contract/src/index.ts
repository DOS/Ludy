// Wire contract of crove-extract, the parsing sandbox (plan §7.6, External-tenant gate T12): bytes in, JSON
// out. The sandbox and the worker share these limits and schemas. Everything the sandbox returns is untrusted:
// the worker validates it here with strict schemas (unknown keys, oversized strings and arrays are refused)
// and treats the result as tainted. This package holds no parser, so importing it never pulls one in.
import { z } from 'zod';

// zip: a ZIP archive opened in the sandbox (bulk intake, issue #314); the entries come back as bytes and the worker
// files each one as a document of its own.
// portal_invoice_list: the purchase-invoice list exported from the tax authority's e-invoice portal as .xlsx (#465);
// the rows come back read and normalized, and the worker checks them again before they are stored.
// feed: a blog's RSS or Atom feed (#708); its newest items come back read and capped.
// bank_statement: a bank's statement as .xlsx or CSV (#2142), forwarded by email or dropped in the Inbox; the account
// number above the lines and the lines come back read, cells as text, and the worker checks them again.
// marketplace_orders: a Shopee, TikTok Shop or Lazada order report as .xlsx or CSV (#2515); only an allow-list of columns comes back (order, line, dates, status, SKU, product, quantity,
// amounts): the buyer's columns are never read, so they never leave the sandbox.
// docx_text: text from a .docx Word document attached to a note (#3561).
// marketplace_columns: the same kind of file when no platform profile fits its headers (#4035, #3850 slice 1b). The request is a JSON envelope (the file as base64, and with it the platform the person
// picked and the column mapping to check); the answer is the masked sheet (header texts and the SHAPES of a few values, never a value, buyer columns blanked) or the result of checking the mapping on the real file.
export const EXTRACT_KINDS = ['einvoice_xml', 'pdf_text', 'docx_text', 'pdf_inspect', 'pdf_seal', 'pdf_embed_cms', 'mime', 'zip', 'portal_invoice_list', 'dsn', 'html_meta', 'feed', 'bank_statement', 'marketplace_orders', 'marketplace_income', 'marketplace_columns'] as const;
export type ExtractKind = (typeof EXTRACT_KINDS)[number];
export const zExtractKind = z.enum(EXTRACT_KINDS);

const MiB = 1024 * 1024;

export const EXTRACT_LIMITS = {
  // Files (e-invoice XML, PDF): the upload cap; the plan allows the worker to send at most 25 MB.
  maxFileBytes: 25 * MiB,
  // A raw inbound email: the API's cap on POST /api/inbound/email.
  maxEmailBytes: 40 * MiB,
  // Base64 grows an email by a third; anything bigger than this is not a valid answer.
  maxResponseBytes: 64 * MiB,
  // Text taken from a PDF; the AI prompt uses far less.
  maxTextChars: 200_000,
  maxStringChars: 2000,
  maxInvoiceLines: 10_000,
  maxTaxRows: 100,
  maxRecipients: 100,
  maxAttachments: 20,
  maxErrorChars: 500,
  maxPages: 100_000,
  // A ZIP archive (bulk intake, #314): at most this many entries (directories included) and this many bytes once
  // every entry is decompressed. Base64 grows the entries by a third, which still fits maxResponseBytes.
  maxArchiveEntries: 500,
  maxArchiveTotalBytes: 40 * MiB,
  // The tax portal's invoice list (#465): an .xlsx of at most this size, with at most this many invoice rows. The
  // portal searches about a month at a time, so a month of a small company's purchases is far below either.
  maxPortalListBytes: 10 * MiB,
  maxPortalListRows: 20_000,
  // A bounce report (DSN, #539): at most this many recipients are read.
  maxDsnRecipients: 20,
  // A web page for a link preview (#641): the worker sends at most its first bytes, enough for the head.
  maxHtmlBytes: 512 * 1024,
  maxPageTitleChars: 300,
  maxPageDescriptionChars: 1000,
  maxPageSiteChars: 200,
  // The page's main text (#779), for an AI draft written from it.
  maxPageTextChars: 4000,
  // A mail's text (#779): its text/plain part, or its HTML reduced to text, for an AI draft of a Social post.
  maxMailTextChars: 20_000,
  // The Message-IDs of a mail's References header that are kept (#2439).
  maxMailRefs: 50,
  // The Authentication-Results headers a mail carries (#2439): how many are returned, each cut at this length.
  maxAuthResults: 5,
  maxAuthResultChars: 1000,
  // A blog's feed (#708): at most this many bytes, of which the newest items come back.
  maxFeedBytes: 1024 * 1024,
  maxFeedItems: 50,
  maxFeedTitleChars: 300,
  maxFeedSummaryChars: 1000,
  // Rows of the sheet that were not read as invoices (a totals row, a row without a number), reported by number.
  maxPortalListSkipped: 1000,
  // A bank statement (#2142): a file of at most this size, with at most this many lines (a month of a busy account has a
  // few thousand; the finance module takes the same number from the browser import, BANK_IMPORT_MAX_ROWS).
  maxStatementBytes: 10 * MiB,
  maxStatementRows: 5000,
  maxStatementCellChars: 1000,
  // A marketplace order report (#2515): a file of at most this size with at most this many lines (the sheet reader takes about 20,000 rows; Lazada has a row per unit sold).
  maxOrderReportBytes: 10 * MiB,
  maxOrderLines: 20_000,
  // Rows of the report that were not read as lines of an order, reported by number.
  maxOrderSkipped: 1000,
  // The envelope of marketplace_columns (#4035): the report as base64 (a third larger than maxOrderReportBytes) plus the platform and at most one assignment per standard field.
  maxColumnsRequestBytes: Math.ceil((10 * MiB) / 3) * 4 + 16 * 1024,
  // The masked sheet (#4035): at most this many columns, a header text cut at maxColumnHeaderChars, at most maxColumnSamples values of maxColumnSampleChars characters each.
  maxSheetColumns: 60,
  maxColumnHeaderChars: 80,
  maxColumnSamples: 3,
  maxColumnSampleChars: 12,
  // A marketplace income report (#2516): the same file size, with one line per order paid (at most this many) in the first few sheets of the workbook.
  maxIncomeLines: 20_000,
  maxIncomeSheets: 8,
  // eSign PDF inspection and sealing (#3331, #3552, docs/plan/esign.md section 4.2).
  maxPdfSignPages: 200,
  maxPdfAuditCertPages: 25,
  maxPdfInspectTextBytes: 64 * 1024,
  maxPdfDetectedTags: 200,
  maxPdfDetectedTagRoles: 50,
  maxPdfDetectedTagLabelChars: 120,
  maxPdfSealFields: 500,
  maxPdfSealSigners: 50,
  maxSignatureImageBytes: 256 * 1024,
  // Base64-encoded 25 MiB PDF plus signature fields and certificate fits within 40 MiB.
  maxPdfSealRequestBytes: 40 * MiB,
  // eSign PAdES CMS embedding (#3511).
  maxPdfCmsDerBytes: 512 * 1024,
  maxPdfCmsTimestampBytes: 64 * 1024,
  maxPdfCmsOcspBytes: 64 * 1024,
  maxPdfCmsOcspResponses: 16,
  maxPdfEmbedCmsRequestBytes: 40 * MiB,
} as const;

// Why the sandbox did not return an entry of an archive. The whole archive is refused instead (as invalid) when an
// entry name escapes the archive (an absolute path, a drive letter or a .. segment), entries overlap, it is ZIP64 or
// split, or it holds more entries or decompressed bytes than allowed.
export const ARCHIVE_REJECTIONS = ['encrypted', 'unsupported_method', 'nested_archive', 'too_large', 'corrupt'] as const;
export type ArchiveRejection = (typeof ARCHIVE_REJECTIONS)[number];

export function maxRequestBytes(kind: ExtractKind): number {
  if (kind === 'mime' || kind === 'dsn') return EXTRACT_LIMITS.maxEmailBytes;
  if (kind === 'pdf_seal') return EXTRACT_LIMITS.maxPdfSealRequestBytes;
  if (kind === 'pdf_embed_cms') return EXTRACT_LIMITS.maxPdfEmbedCmsRequestBytes;
  if (kind === 'portal_invoice_list') return EXTRACT_LIMITS.maxPortalListBytes;
  if (kind === 'bank_statement') return EXTRACT_LIMITS.maxStatementBytes;
  if (kind === 'marketplace_orders' || kind === 'marketplace_income') return EXTRACT_LIMITS.maxOrderReportBytes;
  if (kind === 'marketplace_columns') return EXTRACT_LIMITS.maxColumnsRequestBytes;
  if (kind === 'html_meta') return EXTRACT_LIMITS.maxHtmlBytes;
  if (kind === 'feed') return EXTRACT_LIMITS.maxFeedBytes;
  return EXTRACT_LIMITS.maxFileBytes;
}

// too_large, timeout, memory and invalid are caused by the input: retrying gives the same answer.
// bad_request, busy and internal are failures of the call or the service and are worth a retry.
export const EXTRACT_ERROR_CODES = ['too_large', 'timeout', 'memory', 'invalid', 'bad_request', 'busy', 'internal'] as const;
export type ExtractErrorCode = (typeof EXTRACT_ERROR_CODES)[number];
export const INPUT_ERROR_CODES: readonly ExtractErrorCode[] = ['too_large', 'timeout', 'memory', 'invalid'];

const zText = z.string().max(EXTRACT_LIMITS.maxStringChars);
const zMoney = z.string().regex(/^-?\d{1,24}(\.\d{1,8})?$/, 'decimal string');

const zParty = z.strictObject({
  name: zText,
  taxCode: zText.nullable(),
  address: zText.nullable(),
  email: zText.nullable(),
  phone: zText.nullable(),
  bankAccount: zText.nullable().optional(),
});

const zLine = z.strictObject({
  lineNo: z.number().int().positive().max(EXTRACT_LIMITS.maxInvoiceLines),
  nature: z.enum(['goods', 'promotion', 'discount', 'note']),
  code: zText.nullable(),
  description: zText,
  unit: zText.nullable(),
  quantity: zMoney.nullable(),
  unitPrice: zMoney.nullable(),
  amount: zMoney,
  vatRate: zText.nullable(),
});

// The invoice a replacement or an adjustment corrects (RelatedInvoice in @ludy/l10n-vn, #916).
const zRelatedInvoice = z.strictObject({
  kind: z.enum(['replacement', 'adjustment']),
  template: zText.nullable(),
  series: zText,
  number: zText,
  issueDate: zText.nullable(),
  note: zText.nullable(),
});

// The signature verification of an e-invoice XML (#674). The same lists as SIGNATURE_STATUSES and SIGNATURE_REASONS
// in @ludy/l10n-vn (apps/extract tests compare them); this package does not depend on it.
export const SIGNATURE_STATUSES = ['verified', 'unverified', 'not_applicable'] as const;
export const SIGNATURE_REASONS = [
  'missing',
  'malformed',
  'ambiguous',
  'not_covering',
  'digest_mismatch',
  'bad_signature',
  'unsupported_algorithm',
  'no_certificate',
  'untrusted_certificate',
  'certificate_expired',
  'signer_mismatch',
  'tax_authority_missing',
  'tax_authority_invalid',
  'tax_authority_untrusted',
  'cash_register',
  'too_large',
] as const;
export const zInvoiceSignature = z
  .strictObject({
    status: z.enum(SIGNATURE_STATUSES),
    reason: z.enum(SIGNATURE_REASONS).nullable(),
    signer: zText.nullable(),
    issuer: zText.nullable(),
    signedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .refine((s) => (s.status === 'verified') === (s.reason === null), 'reason is null exactly when the signature is verified');

// The shape of ParsedInvoice in @ludy/l10n-vn for an e-invoice XML.
export const zExtractedInvoice = z.strictObject({
  source: z.literal('einvoice_xml'),
  invoiceType: zText.nullable(),
  template: zText.nullable(),
  series: zText,
  number: zText,
  issueDate: zText,
  currency: zText,
  exchangeRate: zMoney.nullable(),
  paymentMethod: zText.nullable(),
  seller: zParty,
  buyer: zParty,
  lines: z.array(zLine).max(EXTRACT_LIMITS.maxInvoiceLines),
  taxBreakdown: z
    .array(z.strictObject({ rate: zText, taxableAmount: zMoney, vatAmount: zMoney }))
    .max(EXTRACT_LIMITS.maxTaxRows),
  subtotal: zMoney,
  vatTotal: zMoney,
  total: zMoney,
  totalInWords: zText.nullable(),
  taxAuthorityCode: zText.nullable(),
  hasSignature: z.boolean(),
  // Always set by a sandbox with #674; optional so a worker accepts an older sandbox's answer during a rolling deploy.
  signature: zInvoiceSignature.optional(),
  related: zRelatedInvoice.optional(),
});
export type ExtractedInvoice = z.infer<typeof zExtractedInvoice>;

// The parts of a MIME message the worker uses. Attachments are the first maxAttachments parts, base64.
export const zExtractedEmail = z.strictObject({
  messageId: zText.nullable(),
  from: zText.nullable(),
  subject: zText.nullable(),
  // The mail's text (#779), at most maxMailTextChars; null when it has none. Optional so a worker accepts an older
  // sandbox's answer during a rolling deploy (the worker goes first: this strict object refuses a key it does not know).
  text: z.string().min(1).max(EXTRACT_LIMITS.maxMailTextChars).nullable().optional(),
  deliveredTo: zText.nullable(),
  to: z.array(zText).max(EXTRACT_LIMITS.maxRecipients),
  attachments: z.array(z.strictObject({ filename: zText.nullable(), content: z.base64() })).max(EXTRACT_LIMITS.maxAttachments),
  // What a customer's mail needs beyond the invoice reader's fields (#2439), all optional so a worker accepts an older sandbox's answer: the sender's
  // display name, the Date header, the Message-IDs it answers (In-Reply-To) and follows (References, "<id>" each, at most maxMailRefs), and whether
  // it is automated (Auto-Submitted other than "no", Precedence bulk, junk or list, a List-Id or List-Unsubscribe header, an auto-response
  // suppression header): such a mail opens no conversation and gets no reply.
  fromName: zText.nullable().optional(),
  sentAt: z.iso.datetime({ offset: true }).nullable().optional(),
  inReplyTo: zText.nullable().optional(),
  references: z.array(zText).max(EXTRACT_LIMITS.maxMailRefs).optional(),
  automated: z.boolean().optional(),
  // The From header names more than one mailbox (a list, or several From headers): `from` is only the first of them, so the Inbox ignores the mail.
  multipleFrom: z.boolean().optional(),
  // The Authentication-Results headers of the mail, topmost first, as written (RFC 8601): the receiving server's verdict on SPF, DKIM and DMARC. The
  // sandbox only copies them; the worker believes the topmost one written by its own server (INBOUND_AUTHSERV_ID) and no other.
  authResults: z.array(z.string().max(EXTRACT_LIMITS.maxAuthResultChars)).max(EXTRACT_LIMITS.maxAuthResults).optional(),
});
export type ExtractedEmail = z.infer<typeof zExtractedEmail>;

// A delivery status notification (RFC 3464, #539): each recipient's action and status code, and the Message-ID of the
// bounced mail when the report quotes its headers. No address or diagnostic text leaves the sandbox.
export const DSN_ACTIONS = ['failed', 'delayed', 'delivered', 'relayed', 'expanded'] as const;
// What a web page says about itself (#641): Open Graph first, then Twitter cards, then the HTML title and description.
// Text only, already decoded and trimmed; nothing here is ever sent to a platform.
export const zExtractedPage = z.strictObject({
  title: z.string().min(1).max(EXTRACT_LIMITS.maxPageTitleChars).nullable(),
  description: z.string().min(1).max(EXTRACT_LIMITS.maxPageDescriptionChars).nullable(),
  siteName: z.string().min(1).max(EXTRACT_LIMITS.maxPageSiteChars).nullable(),
  text: z.string().min(1).max(EXTRACT_LIMITS.maxPageTextChars).nullable(),
});
export type ExtractedPage = z.infer<typeof zExtractedPage>;

const zFeedUrl = z.string().regex(/^https?:\/\/\S+$/i).max(2000);
export const zExtractedFeed = z.strictObject({
  title: z.string().min(1).max(EXTRACT_LIMITS.maxFeedTitleChars).nullable(),
  items: z
    .array(
      z.strictObject({
        // The item's guid or id, else its link or title: what tells it from the others.
        key: z.string().min(1).max(EXTRACT_LIMITS.maxStringChars),
        title: z.string().min(1).max(EXTRACT_LIMITS.maxFeedTitleChars).nullable(),
        link: zFeedUrl.nullable(),
        publishedAt: z.iso.datetime().nullable(),
        summary: z.string().min(1).max(EXTRACT_LIMITS.maxFeedSummaryChars).nullable(),
        image: zFeedUrl.nullable(),
      }),
    )
    .max(EXTRACT_LIMITS.maxFeedItems),
});
export type ExtractedFeed = z.infer<typeof zExtractedFeed>;

export const zExtractedDsn = z.strictObject({
  originalMessageId: z
    .string()
    .regex(/^<[^<>\s]{3,253}>$/)
    .nullable(),
  recipients: z
    .array(
      z.strictObject({
        action: z.enum(DSN_ACTIONS),
        status: z
          .string()
          .regex(/^[245]\.\d{1,3}\.\d{1,3}$/)
          .nullable(),
      }),
    )
    .min(1)
    .max(EXTRACT_LIMITS.maxDsnRecipients),
});
export type ExtractedDsn = z.infer<typeof zExtractedDsn>;

// The file entries of a ZIP archive, in central directory order (directories and __MACOSX entries left out). name is
// the path inside the archive with / separators; sizeBytes is the decompressed size the archive declares, checked
// against the bytes for every returned entry. content is null exactly when the entry was rejected.
export const zExtractedArchive = z.strictObject({
  entries: z
    .array(
      z
        .strictObject({
          name: zText,
          sizeBytes: z.number().int().min(0).max(0xffff_ffff),
          content: z.base64().nullable(),
          rejected: z.enum(ARCHIVE_REJECTIONS).nullable(),
        })
        .refine((entry) => (entry.content === null) === (entry.rejected !== null), 'content is null exactly when the entry is rejected'),
    )
    .max(EXTRACT_LIMITS.maxArchiveEntries),
});
export type ExtractedArchive = z.infer<typeof zExtractedArchive>;

// The fields of the portal's invoice list Crove reads (#465). Required: the reader refuses a sheet whose header lacks
// any of them. The others are read when their column is there.
export const PORTAL_LIST_REQUIRED_FIELDS = ['sellerTaxCode', 'series', 'number', 'issueDate'] as const;
export const PORTAL_LIST_FIELDS = [
  ...PORTAL_LIST_REQUIRED_FIELDS,
  'template',
  'sellerName',
  'buyerTaxCode',
  'subtotal',
  'vatAmount',
  'total',
  'currency',
  'status',
  'checkResult',
] as const;
export type PortalListField = (typeof PORTAL_LIST_FIELDS)[number];

// Why a row of the sheet below the header was not read as an invoice.
export const PORTAL_LIST_SKIP_REASONS = ['no_tax_code', 'bad_tax_code', 'no_number', 'no_series', 'bad_date', 'bad_amount', 'too_long'] as const;
export type PortalListSkipReason = (typeof PORTAL_LIST_SKIP_REASONS)[number];

const zLocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zTaxCode = z.string().regex(/^\d{10}(-\d{3})?$|^\d{12}$/);

export const zExtractedPortalList = z.strictObject({
  sheetName: zText,
  // The sheet row holding the column headers, and which header each field was read from.
  headerRow: z.number().int().positive().max(1_048_576),
  columns: z
    .array(z.strictObject({ field: z.enum(PORTAL_LIST_FIELDS), header: zText }))
    .max(PORTAL_LIST_FIELDS.length),
  // What the sheet says about the lookup above the header, when it says it.
  listFrom: zLocalDate.nullable(),
  listTo: zLocalDate.nullable(),
  buyerTaxCode: zTaxCode.nullable(),
  rows: z
    .array(
      z.strictObject({
        rowNo: z.number().int().positive().max(1_048_576),
        sellerTaxCode: zTaxCode,
        sellerName: z.string().max(500),
        // The buyer's tax code on the row (the portal's list names both parties); null when the column is absent.
        buyerTaxCode: zTaxCode.nullable(),
        template: z.string().regex(/^[0-9A-Z]{1,11}$/).nullable(),
        series: z.string().min(1).max(20),
        number: z.string().min(1).max(20),
        issueDate: zLocalDate,
        currency: z.string().regex(/^[A-Z]{3}$/),
        subtotal: zMoney.nullable(),
        vatAmount: zMoney.nullable(),
        total: zMoney.nullable(),
        statusLabel: z.string().max(200).nullable(),
        checkResult: z.string().max(200).nullable(),
      }),
    )
    .max(EXTRACT_LIMITS.maxPortalListRows),
  skipped: z
    .array(z.strictObject({ rowNo: z.number().int().positive().max(1_048_576), reason: z.enum(PORTAL_LIST_SKIP_REASONS) }))
    .max(EXTRACT_LIMITS.maxPortalListSkipped),
  // Every row skipped, including those past maxPortalListSkipped that are not listed.
  skippedCount: z.number().int().min(0).max(1_048_576),
});
export type ExtractedPortalList = z.infer<typeof zExtractedPortalList>;

// A bank statement as the sandbox read it (#2142). recognized is false when the file is no statement: not a workbook or
// text, or no row names a date and an amount; the other fields are then empty. A statement has its lines as cells of
// text (a number cell as stored, a date cell as its calendar day), which the module judges as it does the browser
// import's. tooMany: more lines than maxStatementRows; rows is then empty and nothing is read.
const zStatementCell = z.strictObject({
  kind: z.enum(['number', 'text']),
  value: z.string().max(EXTRACT_LIMITS.maxStatementCellChars),
});
export const zExtractedBankStatement = z.strictObject({
  recognized: z.boolean(),
  // The digits of the account number named above the lines, or null when none is.
  accountNumber: z.string().regex(/^\d{6,20}$/).nullable(),
  tooMany: z.boolean(),
  rows: z
    .array(
      z.strictObject({
        rowNo: z.number().int().positive().max(1_048_576),
        date: z.string().max(40),
        description: z.string().max(1000),
        reference: z.string().max(100),
        counterpartyAccount: z.string().max(40).default(''),
        moneyIn: zStatementCell.nullable(),
        moneyOut: zStatementCell.nullable(),
        balance: zStatementCell.nullable(),
      }),
    )
    .max(EXTRACT_LIMITS.maxStatementRows),
});
export type ExtractedBankStatement = z.infer<typeof zExtractedBankStatement>;

// A marketplace order report as the sandbox read it (#2515). recognized is false when the file is no order report of a platform the profiles know: no row names an order number and a
// quantity, or no header carries a word only one platform uses, or two fit equally; every other field is then empty. The lines are the allow-listed fields only: the buyer's name,
// phone, email and address are columns of these files and have no field here, so they are not read, not returned and not stored. tooMany: more lines than maxOrderLines; lines is then empty.
// Every mapping is `confirmed: false` until the golden files of real sellers (#2521) check it.
export const MARKETPLACE_PLATFORMS = ['shopee', 'tiktok_shop', 'lazada'] as const;
export const MARKETPLACE_ORDER_STAGES = ['placed', 'shipped', 'completed', 'cancelled', 'returned', 'unknown'] as const;
export const MARKETPLACE_ORDER_FIELDS = ['orderNo', 'lineKey', 'orderedAt', 'shippedAt', 'deliveredAt', 'status', 'returnStatus', 'sku', 'itemName', 'variation', 'quantity', 'unitPrice', 'amount'] as const;
export const MARKETPLACE_SKIP_REASONS = ['no_order_no', 'bad_quantity', 'bad_amount', 'bad_date', 'bad_id', 'too_long'] as const;
export const zExtractedMarketplaceOrders = z.strictObject({
  recognized: z.boolean(),
  // Only when recognized is false: whether the same file is a marketplace income report (#2753), so the worker classifies a received spreadsheet with this one call and does not parse a bank
  // statement or any other sheet a second time just to find out. Absent from a sandbox that does not say (the worker then asks for the income report as before).
  incomeReport: z.boolean().optional(),
  platform: z.enum(MARKETPLACE_PLATFORMS).nullable(),
  // The profile that read the file: its version and whether a real seller's file confirmed it.
  profile: z.strictObject({ version: z.string().max(40), confirmed: z.boolean() }).nullable(),
  // The header the sheet had for each field read (the file's own words for the columns, never a cell of data).
  columns: z.array(z.strictObject({ field: z.enum(MARKETPLACE_ORDER_FIELDS), header: z.string().max(200) })).max(MARKETPLACE_ORDER_FIELDS.length),
  tooMany: z.boolean(),
  lines: z
    .array(
      z.strictObject({
        rowNo: z.number().int().positive().max(1_048_576),
        orderNo: z.string().min(1).max(64),
        lineKey: z.string().min(1).max(120),
        orderedAt: zLocalDate.nullable(),
        shippedAt: zLocalDate.nullable(),
        // A staged read stored before this field existed has none: it reads as null.
        deliveredAt: zLocalDate.nullable().default(null),
        stage: z.enum(MARKETPLACE_ORDER_STAGES),
        statusLabel: z.string().max(100).nullable(),
        sku: z.string().max(100).nullable(),
        itemName: z.string().max(200).nullable(),
        quantity: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, 'positive decimal string'),
        unitPrice: zMoney.nullable(),
        amount: zMoney.nullable(),
      }),
    )
    .max(EXTRACT_LIMITS.maxOrderLines),
  skipped: z.array(z.strictObject({ rowNo: z.number().int().positive().max(1_048_576), reason: z.enum(MARKETPLACE_SKIP_REASONS) })).max(EXTRACT_LIMITS.maxOrderSkipped),
  // Every row skipped, including those past maxOrderSkipped that are not listed.
  skippedCount: z.number().int().min(0).max(1_048_576),
  // Status labels the profile does not know (cut, at most 20): their lines have the stage `unknown` and move nothing.
  unknownStatuses: z.array(z.string().max(100)).max(20),
});
export type ExtractedMarketplaceOrders = z.infer<typeof zExtractedMarketplaceOrders>;

// A marketplace income report (#2516, ADR-0045): the per-order table of Shopee's or TikTok Shop's income export, read through the platform's profile. Like the order report, only an allow-list of columns
// comes back (the order, the payment date, the amounts): the buyer's name, phone, email and address have no field here, so they are not read, not returned and not stored.
export const MARKETPLACE_INCOME_PLATFORMS = ['shopee', 'tiktok_shop', 'lazada'] as const;
export const MARKETPLACE_INCOME_FIELDS = ['orderNo', 'paidAt', 'sales', 'sellerDiscount', 'commission', 'serviceFee', 'paymentFee', 'shipping', 'taxVat', 'taxPit', 'refund', 'net'] as const;
export const MARKETPLACE_INCOME_SKIP_REASONS = ['no_order_no', 'bad_amount', 'bad_date', 'bad_id', 'too_long'] as const;
// A deduction is a positive amount taken from the seller; `other` is the net the file states less what the named columns explain, and may be negative.
const zSignedMoney = z.string().regex(/^-?\d{1,16}(\.\d{1,4})?$/, 'decimal string');
export const zExtractedMarketplaceIncome = z.strictObject({
  recognized: z.boolean(),
  platform: z.enum(MARKETPLACE_INCOME_PLATFORMS).nullable(),
  // The profile that read the file: its version and whether a real seller's file confirmed it.
  profile: z.strictObject({ version: z.string().max(40), confirmed: z.boolean() }).nullable(),
  // The name of the sheet the table was found on, and the header the sheet had for each field read (the file's own words for the columns, never a cell of data).
  sheet: z.string().max(200).nullable(),
  columns: z.array(z.strictObject({ field: z.enum(MARKETPLACE_INCOME_FIELDS), header: z.string().max(200) })).max(MARKETPLACE_INCOME_FIELDS.length),
  tooMany: z.boolean(),
  lines: z
    .array(
      z.strictObject({
        rowNo: z.number().int().positive().max(1_048_576),
        orderNo: z.string().min(1).max(64),
        lineKey: z.string().min(1).max(120),
        paidAt: zLocalDate.nullable(),
        sales: zMoney,
        sellerDiscount: zMoney,
        commission: zMoney,
        serviceFee: zMoney,
        paymentFee: zMoney,
        shipping: zMoney,
        taxWithheld: zMoney,
        refund: zMoney,
        other: zSignedMoney,
        net: zSignedMoney,
      }),
    )
    .max(EXTRACT_LIMITS.maxIncomeLines),
  // The net of the totals row below the table, when the file has exactly one; null otherwise (the report states no total, or states several).
  statedNet: zSignedMoney.nullable(),
  skipped: z.array(z.strictObject({ rowNo: z.number().int().positive().max(1_048_576), reason: z.enum(MARKETPLACE_INCOME_SKIP_REASONS) })).max(EXTRACT_LIMITS.maxOrderSkipped),
  // Every row skipped, including those past maxOrderSkipped that are not listed.
  skippedCount: z.number().int().min(0).max(1_048_576),
});
export type ExtractedMarketplaceIncome = z.infer<typeof zExtractedMarketplaceIncome>;

const MAX_PDF_BASE64_CHARS = Math.ceil(EXTRACT_LIMITS.maxFileBytes / 3) * 4;
const MAX_SIGNATURE_PNG_BASE64_CHARS = Math.ceil(EXTRACT_LIMITS.maxSignatureImageBytes / 3) * 4;
const MAX_CMS_DER_BASE64_CHARS = Math.ceil(EXTRACT_LIMITS.maxPdfCmsDerBytes / 3) * 4;
const MAX_TIMESTAMP_BASE64_CHARS = Math.ceil(EXTRACT_LIMITS.maxPdfCmsTimestampBytes / 3) * 4;
const MAX_OCSP_BASE64_CHARS = Math.ceil(EXTRACT_LIMITS.maxPdfCmsOcspBytes / 3) * 4;
const zSha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase 64-char sha256 hex');
const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

export const PDF_DETECTED_TAG_FIELD_TYPES = ['signature', 'initials', 'date', 'text', 'checkbox', 'dropdown', 'radio', 'attachment'] as const;
export type PdfDetectedTagFieldType = (typeof PDF_DETECTED_TAG_FIELD_TYPES)[number];

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const zPdfDetectedTagOption = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !hasLoneSurrogate(s), 'option must be well-formed Unicode without lone surrogates');

export const zPdfDetectedTag = z
  .strictObject({
    pageNumber: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfSignPages),
    fieldType: z.enum(PDF_DETECTED_TAG_FIELD_TYPES),
    roleOrder: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfDetectedTagRoles),
    roleKey: z.string().regex(/^r(?:[1-9]|[1-4]\d|50)$/, 'role key r1..r50'),
    required: z.boolean(),
    label: z
      .string()
      .min(1)
      .max(EXTRACT_LIMITS.maxPdfDetectedTagLabelChars)
      .refine((s) => !hasLoneSurrogate(s), 'label must be well-formed Unicode without lone surrogates')
      .nullable(),
    options: z.array(zPdfDetectedTagOption).min(1).max(50).optional(),
    xNorm: z.number().finite().min(0).lt(1),
    yNorm: z.number().finite().min(0).lt(1),
    wNorm: z.number().finite().gt(0).lte(1),
    hNorm: z.number().finite().gt(0).lte(1),
  })
  .superRefine((tag, ctx) => {
    if (tag.roleKey !== `r${tag.roleOrder}`) {
      ctx.addIssue({ code: 'custom', path: ['roleKey'], message: 'roleKey must match roleOrder' });
    }
    if (tag.fieldType === 'dropdown' || tag.fieldType === 'radio') {
      if (!tag.options || tag.options.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'dropdown and radio tags require options' });
      }
    } else if (tag.options !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'options are only valid on dropdown and radio tags' });
    }
    if (tag.xNorm + tag.wNorm > 1.000001) {
      ctx.addIssue({ code: 'custom', path: ['wNorm'], message: 'xNorm + wNorm must be <= 1' });
    }
    if (tag.yNorm + tag.hNorm > 1.000001) {
      ctx.addIssue({ code: 'custom', path: ['hNorm'], message: 'yNorm + hNorm must be <= 1' });
    }
  });
export type PdfDetectedTag = z.infer<typeof zPdfDetectedTag>;

export const zPdfInspectPage = z.strictObject({
  page: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfSignPages),
  widthPt: z.number().finite().positive().max(20_000),
  heightPt: z.number().finite().positive().max(20_000),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  text: z.string().max(EXTRACT_LIMITS.maxPdfInspectTextBytes),
});
export type PdfInspectPage = z.infer<typeof zPdfInspectPage>;

export const zPdfInspectResult = z
  .strictObject({
    ok: z.literal(true),
    kind: z.literal('pdf_inspect'),
    pageCount: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfSignPages),
    pages: z.array(zPdfInspectPage).min(1).max(EXTRACT_LIMITS.maxPdfSignPages),
    // Optional on input so a worker accepts an older sandbox's answer during a rolling deploy.
    detectedTags: z.array(zPdfDetectedTag).max(EXTRACT_LIMITS.maxPdfDetectedTags).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.pages.length !== value.pageCount) {
      ctx.addIssue({ code: 'custom', path: ['pages'], message: 'pages length must equal pageCount' });
    }
    let totalBytes = 0;
    for (let i = 0; i < value.pages.length; i++) {
      const entry = value.pages[i];
      if (!entry) continue;
      if (entry.page !== i + 1) {
        ctx.addIssue({ code: 'custom', path: ['pages', i, 'page'], message: `page ${i + 1} must be numbered sequentially` });
      }
      totalBytes += utf8ByteLength(entry.text);
    }
    if (totalBytes > EXTRACT_LIMITS.maxPdfInspectTextBytes) {
      ctx.addIssue({ code: 'custom', path: ['pages'], message: `total extracted text exceeds ${EXTRACT_LIMITS.maxPdfInspectTextBytes} bytes` });
    }
    for (let i = 0; i < value.detectedTags.length; i++) {
      const tag = value.detectedTags[i];
      if (tag && tag.pageNumber > value.pageCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['detectedTags', i, 'pageNumber'],
          message: `detectedTag pageNumber ${tag.pageNumber} exceeds pageCount ${value.pageCount}`,
        });
      }
    }
  });
export type PdfInspectResult = z.infer<typeof zPdfInspectResult>;

export const PDF_SEAL_FIELD_TYPES = ['signature', 'initial', 'date', 'text', 'checkbox', 'dropdown', 'radio'] as const;
export type PdfSealFieldType = (typeof PDF_SEAL_FIELD_TYPES)[number];

const zNormalizedBox = {
  page: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfSignPages),
  xNorm: z.number().finite().min(0).lt(1),
  yNorm: z.number().finite().min(0).lt(1),
  wNorm: z.number().finite().gt(0).lte(1),
  hNorm: z.number().finite().gt(0).lte(1),
};

const zPdfSealFieldVariant = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('signature'),
    ...zNormalizedBox,
    imagePngBase64: z.base64().min(1).max(MAX_SIGNATURE_PNG_BASE64_CHARS),
  }),
  z.strictObject({
    type: z.literal('initial'),
    ...zNormalizedBox,
    imagePngBase64: z.base64().min(1).max(MAX_SIGNATURE_PNG_BASE64_CHARS).optional(),
    text: z.string().max(EXTRACT_LIMITS.maxStringChars).optional(),
    fontSizePt: z.number().finite().min(6).max(36).optional(),
  }),
  z.strictObject({
    type: z.literal('date'),
    ...zNormalizedBox,
    text: z.string().max(EXTRACT_LIMITS.maxStringChars),
    fontSizePt: z.number().finite().min(6).max(36).optional(),
  }),
  z.strictObject({
    type: z.literal('text'),
    ...zNormalizedBox,
    text: z.string().max(EXTRACT_LIMITS.maxStringChars),
    fontSizePt: z.number().finite().min(6).max(36).optional(),
  }),
  z.strictObject({
    type: z.literal('checkbox'),
    ...zNormalizedBox,
    checked: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('dropdown'),
    ...zNormalizedBox,
    text: z.string().max(EXTRACT_LIMITS.maxStringChars),
    fontSizePt: z.number().finite().min(6).max(36).optional(),
  }),
  z.strictObject({
    type: z.literal('radio'),
    ...zNormalizedBox,
    text: z.string().max(EXTRACT_LIMITS.maxStringChars).optional(),
    checked: z.boolean().optional(),
    fontSizePt: z.number().finite().min(6).max(36).optional(),
  }),
]);

export const zPdfSealField = zPdfSealFieldVariant.superRefine((field, ctx) => {
  if (field.xNorm + field.wNorm > 1.000001) {
    ctx.addIssue({ code: 'custom', path: ['wNorm'], message: 'xNorm + wNorm must be <= 1' });
  }
  if (field.yNorm + field.hNorm > 1.000001) {
    ctx.addIssue({ code: 'custom', path: ['hNorm'], message: 'yNorm + hNorm must be <= 1' });
  }
  if (field.type === 'initial' && field.imagePngBase64 === undefined && field.text === undefined) {
    ctx.addIssue({ code: 'custom', path: ['imagePngBase64'], message: 'initial field requires imagePngBase64 or text' });
  }
  if (field.type === 'radio' && field.text === undefined && field.checked === undefined) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: 'radio field requires text or checked' });
  }
});
export type PdfSealField = z.infer<typeof zPdfSealField>;

export const PDF_SEAL_OTP_STATUSES = ['not_required', 'verified', 'unverified'] as const;
export type PdfSealOtpStatus = (typeof PDF_SEAL_OTP_STATUSES)[number];

export const zPdfSealCertificateAttachment = z.strictObject({
  label: z.string().min(1).max(120),
  filename: z.string().min(1).max(255),
  sha256: zSha256Hex,
});
export type PdfSealCertificateAttachment = z.infer<typeof zPdfSealCertificateAttachment>;

export const zPdfSealCertificateSigner = z.strictObject({
  name: z.string().min(1).max(200),
  roleLabel: z.string().min(1).max(100),
  maskedEmail: z.string().min(1).max(200).nullable(),
  deliveryMode: z.enum(['link', 'email']),
  otpStatus: z.enum(PDF_SEAL_OTP_STATUSES),
  signedAtIso: z.iso.datetime({ offset: true }),
  ipHashPrefix: z
    .string()
    .regex(/^[0-9a-f]{8,64}$/, 'lowercase hex ip hash prefix')
    .nullable(),
  signatureKind: z.enum(['draw', 'type']).optional(),
  delegatedFromName: z.string().min(1).max(200).nullable().optional(),
  delegatedFromMaskedEmail: z.string().min(1).max(200).nullable().optional(),
  delegationCount: z.number().int().min(0).max(2).optional(),
  recipientCorrected: z.boolean().optional(),
  attachments: z.array(zPdfSealCertificateAttachment).max(50).optional(),
});
export type PdfSealCertificateSigner = z.infer<typeof zPdfSealCertificateSigner>;

export const zPdfSealCertificate = z.strictObject({
  certificateCode: z.string().min(1).max(64),
  envelopeTitle: z.string().min(1).max(300),
  sourceSha256: zSha256Hex,
  completedAtIso: z.iso.datetime({ offset: true }),
  eventChainTipHash: zSha256Hex,
  signers: z.array(zPdfSealCertificateSigner).min(1).max(EXTRACT_LIMITS.maxPdfSealSigners),
});
export type PdfSealCertificate = z.infer<typeof zPdfSealCertificate>;

export const zPdfSealInput = z.strictObject({
  pdfBase64: z.base64().min(1).max(MAX_PDF_BASE64_CHARS),
  fields: z.array(zPdfSealField).max(EXTRACT_LIMITS.maxPdfSealFields),
  certificate: zPdfSealCertificate,
});
export type PdfSealInput = z.infer<typeof zPdfSealInput>;

export const zPdfSealResult = z.strictObject({
  ok: z.literal(true),
  kind: z.literal('pdf_seal'),
  sealedPdfBase64: z.base64().min(1).max(MAX_PDF_BASE64_CHARS),
  pageCount: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfSignPages + EXTRACT_LIMITS.maxPdfAuditCertPages),
});
export type PdfSealResult = z.infer<typeof zPdfSealResult>;

export class PdfSealInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfSealInputError';
  }
}

function formatZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ')
    .slice(0, EXTRACT_LIMITS.maxErrorChars);
}

function encodeJsonContractInput<T>(
  kind: 'pdf_seal' | 'pdf_embed_cms' | 'marketplace_columns',
  schema: z.ZodType<T>,
  input: T,
  createError: (message: string) => Error,
): Uint8Array {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw createError(`invalid ${kind} input: ${formatZodIssues(parsed.error.issues)}`);
  const encoded = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (encoded.byteLength > maxRequestBytes(kind)) {
    throw createError(`${kind} input is larger than allowed`);
  }
  return encoded;
}

function decodeJsonContractInput<T>(
  kind: 'pdf_seal' | 'pdf_embed_cms' | 'marketplace_columns',
  schema: z.ZodType<T>,
  bytes: Uint8Array,
  createError: (message: string) => Error,
): T {
  if (bytes.byteLength === 0) throw createError(`${kind} input is empty`);
  if (bytes.byteLength > maxRequestBytes(kind)) throw createError(`${kind} input is larger than allowed`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw createError(`${kind} input is not valid UTF-8`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw createError(`${kind} input is not valid JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw createError(`invalid ${kind} input: ${formatZodIssues(parsed.error.issues)}`);
  return parsed.data;
}

export function encodePdfSealInput(input: PdfSealInput): Uint8Array {
  return encodeJsonContractInput('pdf_seal', zPdfSealInput, input, (msg) => new PdfSealInputError(msg));
}

export function decodePdfSealInput(bytes: Uint8Array): PdfSealInput {
  return decodeJsonContractInput('pdf_seal', zPdfSealInput, bytes, (msg) => new PdfSealInputError(msg));
}

export const PDF_CMS_SUBFILTERS = ['ETSI.CAdES.detached', 'adbe.pkcs7.detached'] as const;
export type PdfCmsSubFilter = (typeof PDF_CMS_SUBFILTERS)[number];

export const zPdfEmbedCmsInput = z.strictObject({
  pdfBase64: z.base64().min(1).max(MAX_PDF_BASE64_CHARS),
  cmsDerBase64: z.base64().min(1).max(MAX_CMS_DER_BASE64_CHARS),
  signerName: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500).optional(),
  location: z.string().trim().min(1).max(200).optional(),
  signedAtIso: z.iso.datetime({ offset: true }),
  // ISO 32000-1 section 12.7.3.2 forbids '.' inside partial field name /T.
  fieldName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid signature field name').optional(),
  subFilter: z.enum(PDF_CMS_SUBFILTERS).optional(),
  placeholderBytes: z.number().int().min(64).max(EXTRACT_LIMITS.maxPdfCmsDerBytes).optional(),
  timestampTokenBase64: z.base64().min(1).max(MAX_TIMESTAMP_BASE64_CHARS).optional(),
  ocspResponsesBase64: z.array(z.base64().min(1).max(MAX_OCSP_BASE64_CHARS)).max(EXTRACT_LIMITS.maxPdfCmsOcspResponses).optional(),
});
export type PdfEmbedCmsInput = z.infer<typeof zPdfEmbedCmsInput>;

export const zPdfEmbedCmsResult = z
  .strictObject({
    ok: z.literal(true),
    kind: z.literal('pdf_embed_cms'),
    pdfBase64: z.base64().min(1).max(MAX_PDF_BASE64_CHARS),
    signedSha256: zSha256Hex,
    byteRange: z.tuple([
      z.literal(0),
      z.number().int().positive(),
      z.number().int().positive(),
      z.number().int().positive(),
    ]),
  })
  .superRefine((value, ctx) => {
    if (value.byteRange[2] <= value.byteRange[1] + 2) {
      ctx.addIssue({ code: 'custom', path: ['byteRange'], message: 'byteRange[2] must follow byteRange[1]' });
    }
  });
export type PdfEmbedCmsResult = z.infer<typeof zPdfEmbedCmsResult>;

export class PdfEmbedCmsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfEmbedCmsInputError';
  }
}

export function encodePdfEmbedCmsInput(input: PdfEmbedCmsInput): Uint8Array {
  return encodeJsonContractInput('pdf_embed_cms', zPdfEmbedCmsInput, input, (msg) => new PdfEmbedCmsInputError(msg));
}

export function decodePdfEmbedCmsInput(bytes: Uint8Array): PdfEmbedCmsInput {
  return decodeJsonContractInput('pdf_embed_cms', zPdfEmbedCmsInput, bytes, (msg) => new PdfEmbedCmsInputError(msg));
}

export const zExtractFailure = z.strictObject({
  ok: z.literal(false),
  code: z.enum(EXTRACT_ERROR_CODES),
  message: z.string().max(EXTRACT_LIMITS.maxErrorChars),
});
export type ExtractFailure = z.infer<typeof zExtractFailure>;

// marketplace_columns (#4035): the masked sheet of a report no platform profile fits, and the check of a column mapping on the real file. Nothing a buyer typed can be in the answer: a column
// the headers mark as the buyer's is returned as an empty shell (no header, no samples), and the samples of every other column are SHAPES (a digit is 9, any other character that is not on the short
// list below is a), which the schema enforces, so a value can not pass for one.
export const COLUMN_REFUSAL_REASONS = ['no_header', 'bad_column', 'buyer_column', 'field_twice', 'column_twice', 'no_order_no', 'no_line', 'nothing_read', 'row_stops_file', 'too_many_rows', 'rows_without_order', 'return_without_status', 'quantity_exceeds_amount', 'dates_swapped', 'buyer_text'] as const;
const MAX_COLUMN_INDEX = 16_383;
const zColumnIndex = z.number().int().min(0).max(MAX_COLUMN_INDEX);
const zSampleShape = z
  .string()
  .max(EXTRACT_LIMITS.maxColumnSampleChars)
  .regex(/^[9a \-/.,:;@#()+%_]*$/, 'a masked shape');
export const zExtractedMarketplaceColumns = z.strictObject({
  sheet: z
    .strictObject({
      headerRow: z.number().int().min(0).max(1_048_576),
      // sha-256 (hex) of the header row's text (@ludy/l10n-vn headerRowText), the key a saved column mapping is found by (#4037); the sandbox always sets it, and a sheet without one (an older sandbox) simply cannot be saved. A hash of header words: no value, no buyer text can be read back from it.
      headerDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      columns: z
        .array(
          z
            .strictObject({
              index: zColumnIndex,
              header: z.string().max(EXTRACT_LIMITS.maxColumnHeaderChars),
              samples: z.array(zSampleShape).max(EXTRACT_LIMITS.maxColumnSamples),
              buyer: z.boolean(),
            })
            .refine((c) => !c.buyer || (c.header === '' && c.samples.length === 0), 'a buyer column carries nothing'),
        )
        .max(EXTRACT_LIMITS.maxSheetColumns),
    })
    .nullable(),
  // null when the request carried no mapping. A mapping that reads the file comes back with the lines and the summary of marketplace_orders; one that does not, with the check's reason.
  check: z
    .union([z.strictObject({ ok: z.literal(true), orders: zExtractedMarketplaceOrders }), z.strictObject({ ok: z.literal(false), reason: z.enum(COLUMN_REFUSAL_REASONS) })])
    .nullable(),
});
export type ExtractedMarketplaceColumns = z.infer<typeof zExtractedMarketplaceColumns>;

// The request: the report as base64 (the sandbox refuses a decoded file over maxOrderReportBytes) and, to check a mapping, the platform the person picked and one assignment of a column to a standard
// field per field at most. The mapping travels in the envelope as the eSign kinds' input does, so the sandbox reads one body and the request has no query string a mapping could leak into.
const MAX_REPORT_BASE64_CHARS = Math.ceil(EXTRACT_LIMITS.maxOrderReportBytes / 3) * 4;
export const zMarketplaceColumnsInput = z.strictObject({
  fileBase64: z.base64().min(1).max(MAX_REPORT_BASE64_CHARS),
  mapping: z
    .strictObject({
      platform: z.enum(MARKETPLACE_PLATFORMS),
      assignments: z.array(z.strictObject({ index: zColumnIndex, field: z.enum(MARKETPLACE_ORDER_FIELDS) })).min(1).max(MARKETPLACE_ORDER_FIELDS.length),
    })
    .optional(),
});
export type MarketplaceColumnsInput = z.infer<typeof zMarketplaceColumnsInput>;

export class MarketplaceColumnsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplaceColumnsInputError';
  }
}

export function encodeMarketplaceColumnsInput(input: MarketplaceColumnsInput): Uint8Array {
  return encodeJsonContractInput('marketplace_columns', zMarketplaceColumnsInput, input, (msg) => new MarketplaceColumnsInputError(msg));
}

export function decodeMarketplaceColumnsInput(bytes: Uint8Array): MarketplaceColumnsInput {
  return decodeJsonContractInput('marketplace_columns', zMarketplaceColumnsInput, bytes, (msg) => new MarketplaceColumnsInputError(msg));
}

export const zExtractSuccess = z.discriminatedUnion('kind', [
  z.strictObject({ ok: z.literal(true), kind: z.literal('einvoice_xml'), invoice: zExtractedInvoice }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('pdf_text'),
    text: z.string().max(EXTRACT_LIMITS.maxTextChars),
    pages: z.number().int().min(0).max(EXTRACT_LIMITS.maxPages),
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('docx_text'),
    text: z.string().max(EXTRACT_LIMITS.maxTextChars),
  }),
  zPdfInspectResult,
  zPdfSealResult,
  zPdfEmbedCmsResult,
  z.strictObject({ ok: z.literal(true), kind: z.literal('mime'), email: zExtractedEmail }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('zip'), archive: zExtractedArchive }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('portal_invoice_list'), list: zExtractedPortalList }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('dsn'), report: zExtractedDsn }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('html_meta'), page: zExtractedPage }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('feed'), feed: zExtractedFeed }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('bank_statement'), statement: zExtractedBankStatement }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('marketplace_orders'), orders: zExtractedMarketplaceOrders }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('marketplace_income'), income: zExtractedMarketplaceIncome }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('marketplace_columns'), columns: zExtractedMarketplaceColumns }),
]);
export type ExtractSuccess = z.infer<typeof zExtractSuccess>;

export const zExtractResponse = z.union([zExtractSuccess, zExtractFailure]);
export type ExtractResponse = z.infer<typeof zExtractResponse>;
export type ExtractResult<K extends ExtractKind> = Extract<ExtractSuccess, { kind: K }> | ExtractFailure;

// HTTP status the sandbox uses for each failure code.
export const EXTRACT_ERROR_STATUS: Record<ExtractErrorCode, 400 | 413 | 422 | 500 | 503> = {
  too_large: 413,
  timeout: 422,
  memory: 422,
  invalid: 422,
  bad_request: 400,
  busy: 503,
  internal: 500,
};

// The worker's view of the sandbox.
export interface ExtractClient {
  extract<K extends ExtractKind>(kind: K, bytes: Uint8Array): Promise<ExtractResult<K>>;
  // How many calls this client keeps in flight to the sandbox at most (a client made by createExtractClient holds the
  // rest back), which is also how many extract jobs the worker runs at once (#2119). Absent: 1.
  readonly concurrency?: number;
}

export type ExtractServiceFailure = 'unreachable' | 'timeout' | 'unavailable' | 'response_too_large' | 'malformed';

// The sandbox could not give a trustworthy answer. Callers retry and, after the last attempt, record a failure.
// The message never carries response content.
export class ExtractServiceError extends Error {
  readonly reason: ExtractServiceFailure;
  constructor(reason: ExtractServiceFailure, message: string) {
    super(message);
    this.name = 'ExtractServiceError';
    this.reason = reason;
  }
}

export interface ExtractClientOptions {
  // Base URL of crove-extract, e.g. http://crove-extract:8090
  url: string;
  // The whole call, including waiting for a free parser slot (plan §7.6: 60 s).
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  // Calls in flight at once, at most the sandbox's own EXTRACT_CONCURRENCY (its slots); a call over it waits here, its
  // timeout starting once it is sent. Default 1, as the sandbox's default.
  concurrency?: number;
}

// Timing shared by the service defaults and the client (plan §7.6: 60 s per call). A request can wait for every
// queued call ahead of it and then run its own; each one holds its slot while its body is read and then while it
// is parsed. The client allows for all of them plus time to send the answer: a queued request is never abandoned
// in the middle of its parse.
export const EXTRACT_TIMING = {
  parseTimeoutMs: 25_000,
  concurrency: 1,
  maxQueue: 1,
  // A body that sends nothing for this long ends with a typed failure and frees its slot.
  bodyIdleTimeoutMs: 2_000,
  // The whole body read, once the slot is free (25 MB or 40 MB over the internal network). A body that keeps
  // sending a byte now and then cannot hold the slot longer than this.
  bodyTimeoutMs: 3_000,
  // Sending the answer over the internal network.
  answerSlackMs: 4_000,
} as const;

export interface ExtractTiming {
  parseTimeoutMs: number;
  concurrency: number;
  maxQueue: number;
  bodyTimeoutMs: number;
  answerSlackMs: number;
}

// Worst case for one call: the calls queued ahead of it, then its own, each reading its body and parsing it.
export function worstCaseCallMs(timing: ExtractTiming): number {
  const slotMs = timing.bodyTimeoutMs + timing.parseTimeoutMs;
  return (Math.ceil(timing.maxQueue / timing.concurrency) + 1) * slotMs + timing.answerSlackMs;
}

export const EXTRACT_CLIENT_TIMEOUT_MS = 60_000;

// A timeout or memory answer can come from load as well as from the file, so a caller may retry it, but at most
// this many times for the same input: a hostile file must not hold the single parser slot again and again.
export const EXTRACT_LIMIT_RETRIES = 1;

async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new ExtractServiceError('response_too_large', 'crove-extract answer is larger than allowed');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ExtractServiceError('response_too_large', 'crove-extract answer is larger than allowed');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch {
    throw new ExtractServiceError('malformed', 'crove-extract answer is not UTF-8');
  }
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function createExtractClient(options: ExtractClientOptions): ExtractClient {
  const base = new URL(options.url);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('EXTRACT_URL must be an http(s) URL');
  const endpoint = new URL('extract', base.href.endsWith('/') ? base.href : `${base.href}/`);
  const timeoutMs = options.timeoutMs ?? EXTRACT_CLIENT_TIMEOUT_MS;
  const maxResponse = options.maxResponseBytes ?? EXTRACT_LIMITS.maxResponseBytes;
  const fetchImpl = options.fetch ?? fetch;
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('the extract client needs a whole concurrency of at least 1');
  const slots = createSlots(concurrency);

  return {
    concurrency,
    async extract<K extends ExtractKind>(kind: K, bytes: Uint8Array): Promise<ExtractResult<K>> {
      if (bytes.byteLength > maxRequestBytes(kind)) {
        return { ok: false, code: 'too_large', message: 'file is larger than crove-extract accepts' };
      }
      const release = await slots.take();
      try {
        return await call(kind, bytes);
      } finally {
        release();
      }
    },
  };

  async function call<K extends ExtractKind>(kind: K, bytes: Uint8Array): Promise<ExtractResult<K>> {
    const url = new URL(endpoint);
    url.searchParams.set('kind', kind);
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = () => new ExtractServiceError('timeout', `crove-extract did not answer within ${timeoutMs} ms`);
    let text: string;
    let status: number;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        body: requestBody(bytes),
        headers: { 'content-type': 'application/octet-stream' },
        // The sandbox must answer itself; a redirect would point the worker somewhere else.
        redirect: 'error',
        signal,
      });
      status = response.status;
      text = await readCapped(response, maxResponse);
    } catch (error) {
      if (error instanceof ExtractServiceError) throw error;
      if (signal.aborted) throw timedOut();
      throw new ExtractServiceError('unreachable', 'crove-extract is unreachable');
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ExtractServiceError('malformed', `crove-extract answered ${status} without JSON`);
    }
    const parsed = zExtractResponse.safeParse(json);
    if (!parsed.success) throw new ExtractServiceError('malformed', `crove-extract answer failed validation (${status})`);
    const result = parsed.data;
    if (result.ok) {
      if (status !== 200) throw new ExtractServiceError('malformed', `crove-extract answered ${status} with a result`);
      if (result.kind !== kind) throw new ExtractServiceError('malformed', 'crove-extract answered for another kind');
      return result as ExtractResult<K>;
    }
    if (status !== EXTRACT_ERROR_STATUS[result.code]) {
      throw new ExtractServiceError('malformed', `crove-extract answered ${status} for ${result.code}`);
    }
    if (!INPUT_ERROR_CODES.includes(result.code)) throw new ExtractServiceError('unavailable', `crove-extract failed: ${result.code}`);
    return result;
  }
}

// At most `size` holders at once; the others wait in order. take() resolves with the function that gives the slot back,
// which hands it straight to the oldest waiter.
function createSlots(size: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    async take(): Promise<() => void> {
      if (active < size) {
        active += 1;
        return release;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
      return release;
    },
  };
}

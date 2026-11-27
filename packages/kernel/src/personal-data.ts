// The personal-data registry (issue #923, PDPL: Law 91/2025 and Decree 356/2025, plan §7.9 deletion map): every column
// of a tenant schema that holds data about a person, and what an erasure request does to it. The finder and the erase
// command (kernel.personal_data.*) work from this list only. An invariant test
// (apps/kernel/test/invariant/personal-data.db.test.ts) compares it with the database catalog: a column whose name looks
// like personal data (an email, a phone, an address, a tax code, a person's name, a recipient) must be listed here,
// and every listed column must exist, so a new column cannot slip past an erasure unclassified.
//
// handling:
// - erase: cleared (set to null, or the person's entry removed from a list) when the person asks.
// - keep_legal: kept, because accounting or tax law requires it (Accounting Law 88/2015, Art. 41: at least 10 years);
//   the erasure reports it with its reason.
// - keep_org: the tenant's own identity (the business, not a person), kept while the org exists.
// - keep_record: part of an append-only record (an invite, a client's review feedback) that the erase command cannot
//   change; it goes with the org (offboarding), and crypto-shredding (ADR-0017) is the later answer.
// - hashed: a keyed hash, not the value; kept so a suppression still holds after the address itself is gone.
// - not_personal: the name matches the pattern but the column holds no data about a person.
import { sql, type RawBuilder } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  FOLLOWUP_MAIL_SOURCE,
  TRACKER_ALERT_MAIL_SOURCE,
  NOTE_BODY_MAX,
  NOTE_TEMPLATE_NAME_MAX,
  NOTE_TITLE_MAX,
  NOTEBOOK_NAME_MAX,
  NOTEBOOK_STACK_MAX,
  PROJECT_COLUMN_NAME_MAX,
  PROJECT_CYCLE_GOAL_MAX,
  PROJECT_CYCLE_NAME_MAX,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  PROJECT_TASK_TITLE_MAX,
  PROJECT_TEMPLATE_TASK_DESCRIPTION_MAX,
  PROJECT_TIME_NOTE_MAX,
  PROJECT_WEEKLY_STATUS_MAIL_SOURCE,
  ROADMAP_ANNOUNCEMENT_BODY_MAX,
  ROADMAP_ANNOUNCEMENT_TITLE_MAX,
  ROADMAP_DESCRIPTION_MAX,
  ROADMAP_ITEM_SUMMARY_MAX,
  ROADMAP_ITEM_TITLE_MAX,
  ROADMAP_SHIPPED_MAIL_SOURCE,
  ROADMAP_SIGNAL_ACCOUNT_LABEL_MAX,
  ROADMAP_SIGNAL_QUOTE_EXCERPT_MAX,
  ROADMAP_TITLE_MAX,
  zPersonalDataQuery,
  personalDataProbe,
  type Probe,
  type PersonalDataErasure,
  type PersonalDataNotice,
  type PersonalDataResult,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, type QueryContext } from '@ludy/kernel-runtime';
import { MAIL_SOURCES_LEFT_OUT } from './offboarding.ts';

export { personalDataProbe, type Probe };

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const OWNERS: readonly MemberRole[] = ['owner'];

export const PERSONAL_DATA_HANDLINGS = ['erase', 'keep_legal', 'keep_org', 'keep_record', 'hashed', 'not_personal'] as const;
export type PersonalDataHandling = (typeof PERSONAL_DATA_HANDLINGS)[number];

// What a value is, for the finder: which columns a searched email, phone or code is compared with. free_text: words
// among which a value may be written (a note's body, an activity line, a comment, a description; #1678, #1948), matched
// by freeTextMatch below.
// account_number: a bank account number kept as its digits (6 to 20), compared with a searched code of digits (#2402).
// national_id: a person's national ID (CCCD, 12 digits) matched by digits (#3682); ASCII letters stay significant so alphanumeric IDs (passports) do not match digit probes.
export const PERSONAL_DATA_KINDS = ['email', 'phone', 'address', 'name', 'tax_code', 'email_list', 'free_text', 'account_number', 'national_id', 'other'] as const;
export type PersonalDataKind = (typeof PERSONAL_DATA_KINDS)[number];

// The handlings of personal data held in the org's own tables: what the finder reports and an erasure reads.
const SEARCHABLE_HANDLINGS = ['erase', 'keep_legal', 'keep_org', 'keep_record'] as const;
type SearchableHandling = (typeof SEARCHABLE_HANDLINGS)[number];
const searchable = (handling: PersonalDataHandling): handling is SearchableHandling => (SEARCHABLE_HANDLINGS as readonly string[]).includes(handling);

export interface PersonalDataColumn {
  kind: PersonalDataKind;
  handling: PersonalDataHandling;
  reason: string;
  // A row whose boolean column `when` is true is handled as this says instead (the org's default legal entity is the
  // business itself; the other entities are the businesses and households it keeps books for).
  override?: { when: string; handling: SearchableHandling; reason: string };
  // Private items (ADR-0037): the finder lists a row only when it is shared ('unless_shared': its visibility is 'org'),
  // or never ('always'); private ones are counted per author through ludy_notes.private_matches instead, with no text.
  privateRows?: 'unless_shared' | 'always';
  // A machinery table closed to ludy_tenant (such as ludy_sign.signing_otp): findPersonalData skips direct SELECT,
  // while erase invokes the table's narrow SECURITY DEFINER helper.
  machinery?: true;
  // A text[] column searched as its items joined by a space, as ludy_notes.private_matches reads a note's tags.
  list?: true;
  // A jsonb array of { text, done } steps searched by joining each step's text, keeping adjacent numbers separate.
  jsonbSteps?: true;
}

// Keyed by schema.table.column.
export const PERSONAL_DATA_COLUMNS = {
  // Parties: suppliers, customers and other counterparties, people among them.
  'ludy_kernel.party.name': {
    kind: 'name',
    handling: 'keep_legal',
    reason: 'The legal name of a party on recorded invoices and vouchers is part of the accounting records; a party with no document is erased',
  },
  'ludy_kernel.party.tax_code': {
    kind: 'tax_code',
    handling: 'keep_legal',
    reason: 'The tax code of a party on recorded invoices and vouchers is part of the accounting records; a party with no document is erased',
  },
  'ludy_kernel.party.email': { kind: 'email', handling: 'erase', reason: 'Contact detail, not part of the books' },
  'ludy_kernel.party.phone': { kind: 'phone', handling: 'erase', reason: 'Contact detail, not part of the books' },
  // A visitor's booking on a public booking page (#1318).
  'ludy_crm.booking.visitor_name': { kind: 'name', handling: 'erase', reason: 'The name a visitor gave when booking a meeting' },
  'ludy_crm.booking.email': { kind: 'email', handling: 'erase', reason: 'The address a visitor gave when booking a meeting' },
  'ludy_crm.booking.phone': { kind: 'phone', handling: 'erase', reason: 'The number a visitor gave when booking a meeting' },
  'ludy_crm.booking.note': { kind: 'other', handling: 'erase', reason: 'Free text a visitor wrote when booking a meeting, which may name or describe them' },
  // Rows of a contact import waiting for the member's go-ahead (#2229): the contact as read from the file. They are deleted
  // on commit, on cancel and once the batch is 7 days old (on the next import command of the org, or by the daily sweep); the erasure deletes the rows that name the person sooner.
  'ludy_crm.import_row.email': { kind: 'email', handling: 'erase', reason: 'The address as read from a contact file waiting to be imported; the row is deleted on commit, on cancel and once the batch is 7 days old (on the next import command of the org, or by the daily sweep)' },
  'ludy_crm.import_row.phone': { kind: 'phone', handling: 'erase', reason: 'The number as read from a contact file waiting to be imported; the row is deleted on commit, on cancel and once the batch is 7 days old (on the next import command of the org, or by the daily sweep)' },
  'ludy_crm.import_row.tax_code': { kind: 'tax_code', handling: 'erase', reason: 'The tax code as read from a contact file waiting to be imported; the row is deleted on commit, on cancel and once the batch is 7 days old (on the next import command of the org, or by the daily sweep)' },
  'ludy_crm.import_row.address': { kind: 'address', handling: 'erase', reason: 'The address as read from a contact file waiting to be imported; the row is deleted on commit, on cancel and once the batch is 7 days old (on the next import command of the org, or by the daily sweep)' },
  'ludy_kernel.party.address': {
    kind: 'address',
    handling: 'erase',
    reason: 'Contact detail; the address printed on an invoice stays in the stored invoice file',
  },
  // Invites and mail.
  'ludy_kernel.member_invite.email': {
    kind: 'email',
    handling: 'keep_record',
    reason: 'An invite is an append-only record of who was invited by whom; the retention purge deletes it 90 days after it is accepted, revoked or expired',
  },
  'ludy_kernel.mail_message.to_address': {
    kind: 'email',
    handling: 'erase',
    reason: 'The recipient of a mail Ludy sent; the keyed hash stays so a suppression still holds. A mail already delivered cannot be recalled: the erasure drops the copy Ludy holds (and, for a meeting follow-up mail, the copy of its text), not the copies in the recipients\' mailboxes',
  },
  'ludy_kernel.mail_message.to_hash': { kind: 'other', handling: 'hashed', reason: 'Keyed hash of the recipient (ludy_kernel.mail_address_hash), not the address' },
  'ludy_kernel.mail_suppression.to_hash': { kind: 'other', handling: 'hashed', reason: 'Keyed hash; keeps a bounced or unsubscribed address suppressed after erasure' },
  'ludy_kernel.inbound_message.from_address': { kind: 'email', handling: 'erase', reason: 'The sender of a forwarded mail; the stored file keeps the document itself' },
  'ludy_kernel.inbound_message.body_text': { kind: 'other', handling: 'erase', reason: 'The text of a forwarded mail (#779), which may name or describe its sender; erased with the address of its sender' },
  'ludy_kernel.conversation_identity.display_name': {
    kind: 'name',
    handling: 'keep_record',
    reason:
      'The name a platform gave for a customer who commented or wrote to the org (#2303): the erasure of that contact (kernel.conversation.erase_contact), the retention purge, the data deletion callback of Meta and the offboarding of the org delete the identity with its threads, so the generic erase leaves it alone',
  },
  'ludy_kernel.conversation_identity.external_user_id': {
    kind: 'email',
    handling: 'keep_record',
    reason:
      "For an email conversation the customer's address (#2439), found by a search of that address: erased with its threads by kernel.conversation.erase_contact, the retention purge and the offboarding of the org, as the display name is, so the generic erase leaves it alone",
  },
  'ludy_kernel.conversation_message.email_refs': {
    kind: 'other',
    handling: 'not_personal',
    reason:
      'The Message-IDs a mail answers (#2439), kept only to join a reply to its thread: opaque ids made by mail programs, not addresses or text. They go with the message when the contact is erased, the retention purge runs or the org is offboarded',
  },
  'ludy_kernel.inbound_drop.address_id': { kind: 'other', handling: 'not_personal', reason: 'The id of an inbound address row' },
  // The org itself.
  'ludy_kernel.tenant.tax_code': { kind: 'tax_code', handling: 'keep_org', reason: "The business's own tax code" },
  'ludy_kernel.tenant.address': { kind: 'address', handling: 'keep_org', reason: "The business's registered address, printed on its returns" },
  'ludy_kernel.tenant.contact_email': { kind: 'email', handling: 'erase', reason: 'A contact person of the business' },
  // Legal entities (#1278): the companies, branches and household businesses the org keeps books for. In an accounting
  // firm's org they are its clients, and a household's name and 12-digit code are usually its owner's name and national
  // ID number, so only the default entity, the org itself, is the org's own identity (#1312).
  'ludy_kernel.legal_entity.name': {
    kind: 'name',
    handling: 'keep_legal',
    reason: "The legal name of a business or household the org keeps books for; a household's is usually its owner's name. Kept with its books",
    override: { when: 'is_default', handling: 'keep_org', reason: "The name of the org's default legal entity, the business itself" },
  },
  'ludy_kernel.legal_entity.tax_code': {
    kind: 'tax_code',
    handling: 'keep_legal',
    reason: "The tax code of a business or household the org keeps books for; a household's is its owner's national ID number. Kept with its books",
    override: { when: 'is_default', handling: 'keep_org', reason: "The tax code of the org's default legal entity, the org's own" },
  },
  // The household business profile (#2517): the name printed with the signature place of the household's books (Circular 152), usually its owner's. It is part of those books, so it is kept with
  // them; the profile rows go with the org (offboarding) and are never edited, a correction being a later row.
  'ludy_finance.household_profile.representative_name': {
    kind: 'name',
    handling: 'keep_legal',
    reason: "The name of the household's representative, printed on its books of Circular 152 beside the signature; part of the accounting records, kept with them and removed with the org",
  },
  // Agents and connected accounts.
  'ludy_kernel.agent.display_name': { kind: 'other', handling: 'not_personal', reason: 'The name of an AI agent' },
  'ludy_kernel.channel_connection.display_name': {
    kind: 'name',
    handling: 'erase',
    reason: 'The name of a connected social account, which may be a person; disconnecting removes the account',
  },
  // The sealed secrets of connected accounts (#3854, #3875): the MISA AMIS access code is one of them, a credential of the org's own account that may name a person who made it. The column holds only the sealed
  // envelope (sealed with the channel broker's key, bound to the org, the provider and the entity); it is closed to the tenant role, so the finder does not read it, and it is deleted when the connection is closed.
  'ludy_kernel.credential.envelope': {
    kind: 'other',
    handling: 'keep_org',
    machinery: true,
    reason: 'The sealed secret of a connected account (a social token, the MISA AMIS access code); never readable by the tenant, deleted when the connection is closed (disconnect) and with the org',
  },
  // A member's connected outside calendar (#2123): the member's own account address, kept only for them.
  'ludy_kernel.calendar_connection.display_name': {
    kind: 'email',
    handling: 'erase',
    reason: "The member's own address in an outside calendar (their Google account), the same value as external_account; disconnecting removes it, and it is not exported with the org",
  },
  'ludy_kernel.calendar_connection.external_account': {
    kind: 'email',
    handling: 'erase',
    reason: "The member's own address in an outside calendar (their Google account); disconnecting removes it, and it is not exported with the org. Its row policy hides it from the admin who runs an erasure: the member disconnects it",
  },
  // A member's connected meeting platform (meetings integrations C1, #3173): the member's own account on Google Meet, Zoom or Microsoft Teams, kept only for them.
  'ludy_kernel.meeting_platform_connection.display_name': {
    kind: 'email',
    handling: 'erase',
    reason: "The member's own account on a meeting platform (their address there), the same value as external_account; disconnecting removes it, and it is not exported with the org",
  },
  'ludy_kernel.meeting_platform_connection.external_account': {
    kind: 'email',
    handling: 'erase',
    reason: "The member's own account on a meeting platform; disconnecting removes it, and it is not exported with the org. Its row policy hides it from the admin who runs an erasure: the member disconnects it",
  },
  // The title of a recording the platform offers to import: the platform's words, which may name or describe a person. Read by the member alone (row security), kept as a suggestion for at most
  // The title of a recording a meeting platform offers the member (meetings integrations C1, #3173), read by that member alone through row security. A suggested or dismissed row is deleted 14 days after the
  // recording's date; a failed or imported row keeps it until the member disconnects the platform, the org is purged or the retry is dismissed; an import also starts the new meeting's own title as a copy of it, and
  // that copy follows the meeting's text rules, not this row's.
  'ludy_kernel.meeting_platform_recording.title': {
    kind: 'free_text',
    handling: 'erase',
    reason: "The title of a recording a meeting platform offers the member, which may name or describe a person: read by that member alone; a suggestion is deleted 14 days after the recording, a failed or imported row keeps it until the member disconnects the platform or the org is purged, and an import copies it into the new meeting's own title",
  },
  // Bank feeds (ADR-0039, #2044): the accounts a connection reaches, as the worker listed them; not the books.
  'ludy_finance.bank_feed_listed_account.display_name': {
    kind: 'name',
    handling: 'erase',
    reason: "The name of a bank account a bank feed reaches, which may be its holder's; the next listing replaces it and disconnecting removes it",
  },
  'ludy_finance.bank_feed_listed_account.external_account_id': {
    kind: 'other',
    handling: 'erase',
    reason: "The provider's id of a bank account a bank feed reaches, which may be its number; the next listing replaces it and disconnecting removes it",
  },
  // Finance records.
  'ludy_finance.cash_voucher.person_name': {
    kind: 'name',
    handling: 'keep_legal',
    reason: 'The payer or payee named on a phiếu thu or phiếu chi is part of the accounting voucher',
  },
  // A sales e-invoice draft (#2500): the buyer as the person typed it or took it from a customer. A draft becomes the record of an invoice, kept like the books.
  // An e-invoice provider connection (#2501): the tax code of the entity it issues for, which is a household's owner's national ID when the entity is a household. The row
  // is deleted when the connection is closed and with the org's working rows, so there is nothing to keep.
  'ludy_finance.einvoice_connection.seller_tax_code': { kind: 'tax_code', handling: 'erase', reason: "The tax code of the legal entity an e-invoice provider connection issues for; a household's is its owner's national ID number. Deleted when the connection is closed" },
  'ludy_finance.einvoice_draft.buyer_tax_code': { kind: 'tax_code', handling: 'keep_legal', reason: 'The buyer on a sales e-invoice draft, which becomes the record of an invoice kept by law (Accounting Law 88/2015, Art. 41)' },
  'ludy_finance.einvoice_draft.buyer_name': { kind: 'name', handling: 'keep_legal', reason: 'The buyer on a sales e-invoice draft, which becomes the record of an invoice kept by law (Accounting Law 88/2015, Art. 41)' },
  'ludy_finance.einvoice_draft.buyer_address': { kind: 'address', handling: 'keep_legal', reason: 'The buyer on a sales e-invoice draft, which becomes the record of an invoice kept by law (Accounting Law 88/2015, Art. 41)' },
  'ludy_finance.einvoice_draft.buyer_identity': { kind: 'national_id', handling: 'keep_legal', reason: "The CCCD, passport number or budget-relation unit code an individual buyer gave on a sales e-invoice draft, which becomes the record of an invoice kept by law (Accounting Law 88/2015, Art. 41)" },
  'ludy_finance.einvoice_draft.buyer_nationality': { kind: 'other', handling: 'keep_legal', reason: "The nationality a foreign buyer gave with a passport on a sales e-invoice draft (Decree 254 Appendix point 4.b, #3709), which becomes the record of an invoice kept by law (Accounting Law 88/2015, Art. 41); it is classified with the identity it belongs to" },
  'ludy_finance.einvoice_draft.buyer_email': { kind: 'email', handling: 'keep_legal', reason: 'Where the buyer asked for the invoice on a sales e-invoice draft, which becomes the record of an invoice kept by law (Accounting Law 88/2015, Art. 41)' },
  // A sent quote (#2694): the buyer as the customer's contact was when the quote was sent. The quote is frozen once sent (a guard trigger), so the erase command cannot change it;
  // it goes with the org. The seller's own letterhead on the org's quote settings is the business's, not a person's.
  'ludy_crm.quote.buyer_name': { kind: 'name', handling: 'keep_record', reason: 'The buyer on a sent quote, a frozen document the customer holds; it cannot be changed after it was sent' },
  'ludy_crm.quote.buyer_tax_code': { kind: 'tax_code', handling: 'keep_record', reason: 'The buyer on a sent quote, a frozen document the customer holds; it cannot be changed after it was sent' },
  'ludy_crm.quote.buyer_address': { kind: 'address', handling: 'keep_record', reason: 'The buyer on a sent quote, a frozen document the customer holds; it cannot be changed after it was sent' },
  'ludy_crm.quote.buyer_email': { kind: 'email', handling: 'keep_record', reason: 'Where the buyer was written to on a sent quote, a frozen document the customer holds; it cannot be changed after it was sent' },
  'ludy_crm.quote.seller_name': { kind: 'name', handling: 'keep_org', reason: "The seller on a sent quote, the business's own letterhead frozen when it was sent; it cannot be changed after it was sent" },
  'ludy_crm.quote.seller_tax_code': { kind: 'tax_code', handling: 'keep_org', reason: "The seller on a sent quote, the business's own letterhead frozen when it was sent; it cannot be changed after it was sent" },
  'ludy_crm.quote.seller_address': { kind: 'address', handling: 'keep_org', reason: "The seller on a sent quote, the business's own letterhead frozen when it was sent; it cannot be changed after it was sent" },
  'ludy_crm.quote.seller_phone': { kind: 'phone', handling: 'keep_org', reason: "The seller on a sent quote, the business's own letterhead frozen when it was sent; it cannot be changed after it was sent" },
  'ludy_crm.quote.seller_email': { kind: 'email', handling: 'keep_org', reason: "The seller on a sent quote, the business's own letterhead frozen when it was sent; it cannot be changed after it was sent" },
  // A sales order (#2696): the frozen copy of the buyer on the quote it was made from.
  'ludy_crm.sales_order.buyer_name': { kind: 'name', handling: 'keep_record', reason: 'The buyer on a sales order, a frozen copy of the sent quote it was made from; the order is not changed after it is made. Whether the copy is redacted or kept on an erasure request stays open under #2820' },
  'ludy_crm.sales_order.buyer_tax_code': { kind: 'tax_code', handling: 'keep_record', reason: 'The buyer on a sales order, a frozen copy of the sent quote it was made from; the order is not changed after it is made. Whether the copy is redacted or kept on an erasure request stays open under #2820' },
  'ludy_crm.sales_order.buyer_address': { kind: 'address', handling: 'keep_record', reason: 'The buyer on a sales order, a frozen copy of the sent quote it was made from; the order is not changed after it is made. Whether the copy is redacted or kept on an erasure request stays open under #2820' },
  'ludy_crm.sales_order.buyer_email': { kind: 'email', handling: 'keep_record', reason: 'The buyer on a sales order, a frozen copy of the sent quote it was made from; the order is not changed after it is made. Whether the copy is redacted or kept on an erasure request stays open under #2820' },
  'ludy_crm.quote_setting.phone': { kind: 'phone', handling: 'keep_org', reason: "The business's own phone number, printed on its quotes" },
  'ludy_crm.quote_setting.email': { kind: 'email', handling: 'keep_org', reason: "The business's own email address, printed on its quotes" },
  'ludy_finance.portal_invoice_list.buyer_tax_code': { kind: 'tax_code', handling: 'keep_legal', reason: "The tax portal's invoice list, kept like the books" },
  'ludy_finance.portal_invoice_row.buyer_tax_code': { kind: 'tax_code', handling: 'keep_legal', reason: "The tax portal's invoice list, kept like the books" },
  'ludy_finance.portal_invoice_row.seller_tax_code': { kind: 'tax_code', handling: 'keep_legal', reason: "The tax portal's invoice list, kept like the books" },
  'ludy_finance.portal_invoice_row.seller_name': { kind: 'name', handling: 'keep_legal', reason: "The tax portal's invoice list, kept like the books" },
  // Free text that can name a person (#1948): searched for the value anywhere inside it. Social's posts and comments
  // are left out while Social is paused (decision D5).
  'ludy_kernel.activity.summary': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A line of a record's timeline, which may quote a person's email or phone; the value is replaced inside it",
  },
  'ludy_kernel.task_comment.body': {
    kind: 'free_text',
    handling: 'keep_record',
    reason: 'A comment on a task is an append-only record of the work, which the erase command cannot change; it goes with the org',
  },
  'ludy_finance.journal_entry.description': {
    kind: 'free_text',
    handling: 'keep_legal',
    reason: 'The description of a posted journal entry is part of the books, append-only and anchored in the WORM archive',
  },
  'ludy_finance.cash_voucher.description': {
    kind: 'free_text',
    handling: 'keep_legal',
    reason: 'The reason written on a phiếu thu or phiếu chi is part of the accounting voucher, append-only and kept by law (Accounting Law 88/2015, Art. 41)',
  },
  'ludy_finance.journal_voucher.description': {
    kind: 'free_text',
    handling: 'keep_legal',
    reason: 'The reason written on a journal voucher is part of the accounting voucher, append-only and kept by law (Accounting Law 88/2015, Art. 41)',
  },
  // MISA AMIS's own text for a voucher it refused (#4015): untrusted, at most 500 characters, and it may quote a party's name, tax code or an invoice number. An erasure clears the whole text of a refused row that
  // mentions the value and keeps the row and its state (ludy_finance.personal_data_clear_misa_amis_push_reason); a short number is left and listed, as in the activity lines.
  'ludy_finance.misa_amis_push.reason': {
    kind: 'free_text',
    handling: 'erase',
    reason: "MISA AMIS's own words for a voucher it refused, which may quote a party or an invoice; an erasure clears the text of a refused row that mentions the value and keeps the row's state",
  },
  // The tax code a MISA catalogue check looked a party up by (#4112): the key of one stored result (matched, unknown or ambiguous) per party of a connection's batch. An erasure deletes the party's rows
  // whole (the row holds nothing but the key, the state and the matched entry's code and id), and the next check files them anew. Item rows hold an item code and are not matched.
  'ludy_finance.misa_amis_match.match_key': {
    kind: 'tax_code',
    handling: 'erase',
    reason: "The tax code a check of a MISA AMIS connection looked a party up by; an erasure deletes the party's stored results and the next check makes them anew",
  },
  // The name of the catalogue entry a MISA catalogue check proposed for a party with no tax code (#4124): it can be a person's name (a household business), so it is kept on the proposal row alone, cleared when a
  // person confirms it (the row is replaced by one that holds the code only) and deleted with the party it was proposed for when an erasure reaches that party (a name is never a probe); the next check proposes the
  // entry anew if the books still carry the party.
  'ludy_finance.misa_amis_match.candidate_name': {
    kind: 'name',
    handling: 'erase',
    reason: "The name of the MISA catalogue entry proposed for a party with no tax code; an erasure that reaches the party deletes its name matches and the next check makes them anew",
  },
  // The preview of a column check on an unrecognised marketplace order report (#4036): at most 20 parsed lines (order no, line key, SKU, item name, variation, quantity, amount, status) a member looks at before
  // anything is saved. A line can carry a buyer's text when an unflagged column is mapped to a text field (the limit stated in #4178). An erasure deletes the check whose preview quotes the value (the file stays; the
  // person asks again); the preview is also deleted with its file, with the org, and by the nightly retention seven days after the check finished.
  'ludy_finance.marketplace_column_check.preview': {
    kind: 'free_text',
    handling: 'erase',
    reason: "The preview of an order report's parsed lines, which may quote a buyer when a column was mapped by hand; an erasure deletes the check that quotes the value and the member asks again",
  },
  // The raw body of a bank feed provider's signed notice waiting for the worker (#4203, Tingee S3): the transfer content and the payer's name as the provider sent them. A claim deletes it when the worker takes it; any notice
  // older than ten minutes is deleted by the next claim or the nightly sweep (so a worker that is down leaves it until then); it is never logged, is deleted by an erasure that its text mentions, and goes with the hook, the connection and the org.
  'ludy_finance.bank_feed_webhook_notice.body': {
    kind: 'free_text',
    handling: 'erase',
    // A machinery table closed to the tenant role: the finder does not read it, and the erasure goes through ludy_finance.personal_data_erase_bank_feed_notice.
    machinery: true,
    reason: "The raw body of a bank feed provider's signed notice, which carries the transfer content and the payer's name: deleted when the worker claims it, and any notice older than ten minutes by the next claim or the nightly sweep; also deleted by an erasure whose value its text mentions, and with the connection and the org",
  },
  // The raw body of a marketplace push waiting for the worker (#4316, S1 of #4315): ids, statuses and times in the subscribed order, return and authorization topics, but a seller can subscribe chat or address topics, so
  // it is treated as personal data. A claim deletes it when the worker takes it; any push older than ten minutes is deleted by the next claim or the nightly sweep; it is never logged, is deleted by an erasure that its text
  // mentions, and goes with the hook, the connection and the org.
  'ludy_finance.marketplace_hook_notice.body': {
    kind: 'free_text',
    handling: 'erase',
    // A machinery table closed to the tenant role: the finder does not read it, and the erasure goes through ludy_finance.personal_data_erase_marketplace_hook_notice.
    machinery: true,
    reason: "The raw body of a marketplace's signed push, which holds ids, statuses and times (and could hold a buyer's message or address if a seller subscribed such a topic): deleted when the worker claims it, and any push older than ten minutes by the next claim or the nightly sweep; also deleted by an erasure whose value its text mentions, and with the hook, the connection and the org",
  },
  // More free text (#1961): a task's title and description, which members and agents write, are replaced where they
  // quote the value; a bank statement line and a journal line's memo are kept.
  'ludy_kernel.task.title': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A task's title, which may quote a person's email or phone; the value is replaced inside it",
  },
  'ludy_kernel.task.description': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A task's description, which may quote a person's email or phone; the value is replaced inside it",
  },
  'ludy_kernel.task.checklist': {
    kind: 'free_text',
    handling: 'erase',
    jsonbSteps: true,
    reason: "A task's checklist steps, which may quote a person's email or phone; each matching step text is redacted in place",
  },
  'ludy_finance.bank_line.description': {
    kind: 'free_text',
    handling: 'keep_legal',
    reason: "A line of an imported bank statement as the bank wrote it, evidence for the books; append-only and kept by law (Accounting Law 88/2015, Art. 41)",
  },
  'ludy_finance.bank_line.counterparty_account': {
    kind: 'account_number',
    handling: 'keep_legal',
    reason: "The other side's account number (its digits) on an imported bank statement line (#2402); evidence for the books, append-only and kept by law (Accounting Law 88/2015, Art. 41). Found by a code of 8 to 20 digits: an account of 6 or 7 digits cannot be searched, since such a short value would also match amounts in free text. The learned rule that points at a party by it holds only a keyed hash, and goes when the erasure reaches the party",
  },
  'ludy_finance.journal_line.memo': {
    kind: 'free_text',
    handling: 'keep_legal',
    reason: 'The memo of a posted journal line is part of the books, append-only and anchored in the WORM archive with its entry',
  },
  // Social.
  'ludy_social.report_branding.display_name': { kind: 'name', handling: 'keep_org', reason: "The agency's name on its white-label client reports (#1053), the business itself" },
  'ludy_social.report_schedule.recipients': { kind: 'email_list', handling: 'erase', reason: 'Addresses a scheduled client report is mailed to' },
  'ludy_social.review_feedback.reviewer_name': {
    kind: 'name',
    handling: 'keep_record',
    reason: 'Review feedback is an append-only record of what a client said about a post; it is removed with the org',
  },
  // Notes and to-dos (#1678, notes step N9, ADR-0037 section 5): free text a member wrote, which may name or describe a
  // person. A shared note is listed with its text; a private note and every to-do (always private) are counted per
  // author, never shown, and the erasure deletes them once their author was told. The folded search words are rebuilt
  // from the text, so they are not searched themselves.
  'ludy_notes.note.title': { kind: 'free_text', handling: 'erase', reason: 'A shared note: the erasure edits the value out of its title, body and tags, and the note stays', privateRows: 'unless_shared' },
  'ludy_notes.note.body': { kind: 'free_text', handling: 'erase', reason: 'A shared note: the erasure edits the value out of its title, body and tags, and the note stays', privateRows: 'unless_shared' },
  'ludy_notes.note.tags': { kind: 'free_text', handling: 'erase', reason: 'A shared note: the erasure edits the value out of its title, body and tags, and the note stays', privateRows: 'unless_shared', list: true },
  'ludy_notes.note.search': { kind: 'other', handling: 'erase', reason: "The folded search words of a note's title, tags, body and attachments, rebuilt from them" },
  'ludy_notes.attachment.filename': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Filename of a note attachment: on a shared note, the erasure deletes the attachment and queues its blob; on a private note, counted per author and deleted once the author was told',
    privateRows: 'unless_shared',
  },
  'ludy_notes.attachment.extracted_text': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Extracted text of a note attachment: on a shared note, the erasure deletes the attachment and queues its blob; on a private note, counted per author and deleted once the author was told',
    privateRows: 'unless_shared',
  },
  'ludy_notes.attachment.search': { kind: 'other', handling: 'erase', reason: "The folded search words of a note attachment's filename and extracted text, rebuilt from them" },
  'ludy_notes.notebook.name': { kind: 'free_text', handling: 'erase', reason: 'A shared notebook: the erasure edits the value out of its name and stack name, and the notebook stays; a private notebook is counted per author and deleted once the author was told', privateRows: 'unless_shared' },
  'ludy_notes.notebook.stack_name': { kind: 'free_text', handling: 'erase', reason: 'A shared notebook stack name: the erasure edits the value out of its name and stack name, and the notebook stays; a private notebook is counted per author and deleted once the author was told', privateRows: 'unless_shared' },
  'ludy_notes.todo.title': { kind: 'free_text', handling: 'erase', reason: 'Free text of a to-do, private to its owner: counted per owner, never shown, and deleted by the erasure once the owner was told', privateRows: 'always' },
  'ludy_notes.todo.details': { kind: 'free_text', handling: 'erase', reason: 'Free text of a to-do, private to its owner: counted per owner, never shown, and deleted by the erasure once the owner was told', privateRows: 'always' },
  'ludy_notes.todo.checklist': { kind: 'free_text', handling: 'erase', reason: 'Steps of a to-do, private to its owner: counted per owner, never shown, and deleted by the erasure once the owner was told', privateRows: 'always' },
  'ludy_notes.todo.tags': { kind: 'free_text', handling: 'erase', reason: 'Tags of a to-do, private to its owner: counted per owner, never shown, and deleted by the erasure once the owner was told', privateRows: 'always', list: true },
  'ludy_notes.todo.search': { kind: 'other', handling: 'erase', reason: "The folded search words of a to-do's title, details, tags and steps, rebuilt from them" },
  'ludy_notes.todo_list.name': { kind: 'free_text', handling: 'erase', reason: 'Name of a personal to-do list, private to its owner: counted per owner, never shown, and deleted by the erasure once the owner was told', privateRows: 'always' },
  'ludy_notes.todo_list.sections': { kind: 'free_text', handling: 'erase', reason: 'Section names of a personal to-do list, private to its owner: counted per owner, never shown, and deleted by the erasure once the owner was told', privateRows: 'always' },
  'ludy_notes.note_template.name': { kind: 'free_text', handling: 'erase', reason: 'A shared note template: the erasure edits the value out of its name, title, body and tags, and the template stays; a private template is counted per author and deleted once the author was told', privateRows: 'unless_shared' },
  'ludy_notes.note_template.title': { kind: 'free_text', handling: 'erase', reason: 'A shared note template: the erasure edits the value out of its name, title, body and tags, and the template stays; a private template is counted per author and deleted once the author was told', privateRows: 'unless_shared' },
  'ludy_notes.note_template.body': { kind: 'free_text', handling: 'erase', reason: 'A shared note template: the erasure edits the value out of its name, title, body and tags, and the template stays; a private template is counted per author and deleted once the author was told', privateRows: 'unless_shared' },
  'ludy_notes.note_template.tags': { kind: 'free_text', handling: 'erase', reason: 'A shared note template: the erasure edits the value out of its name, title, body and tags, and the template stays; a private template is counted per author and deleted once the author was told', privateRows: 'unless_shared', list: true },
  'ludy_notes.note_version.title': { kind: 'free_text', handling: 'erase', reason: 'A version snapshot of a shared note: the erasure deletes matching snapshots; snapshots of a private note are counted with the note and deleted with it once the author was told', privateRows: 'unless_shared' },
  'ludy_notes.note_version.body': { kind: 'free_text', handling: 'erase', reason: 'A version snapshot of a shared note: the erasure deletes matching snapshots; snapshots of a private note are counted with the note and deleted with it once the author was told', privateRows: 'unless_shared' },
  'ludy_notes.note_version.tags': { kind: 'free_text', handling: 'erase', reason: 'A version snapshot of a shared note: the erasure deletes matching snapshots; snapshots of a private note are counted with the note and deleted with it once the author was told', privateRows: 'unless_shared', list: true },
  // Meetings (ADR-0047 points 7 and 11, issues #2579, #2594): a recording holds voices (its file references are not classified: a column named file_id is shared by every table, and a class on that name would force auditValue on every file fact of the books), and
  // what was said, summarized and promised may name or describe a person. The text columns are free text the finder searches (freeTextMatch): the rows an actor reads
  // are listed like any other (row security keeps an attendees-only meeting and every draft to its readers), and what the owner cannot read is counted per recorder through
  // ludy_meetings.personal_matches, never listed. A person's request is also answered by deleting the meeting, which the recorder does (meetings.meeting.delete) and an
  // owner may do without reading it (meetings.meeting.owner_delete, R3); the nightly job deletes every meeting at its own text date and shreds audio and video at theirs.
  'ludy_meetings.meeting.title': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A meeting's title, which may name a person: found where the actor reads the meeting; counted per recorder where the owner cannot; deleted with the meeting (its recorder, an owner for a personal-data request, or the retention job)",
  },
  // The place of a meeting (#5013, #5014): one line the recorder types for the biên bản ("Phòng họp tầng 3, 12 Nguyễn Huệ"), which may name or describe a person or an address. It is handled as the title is: the finder
  // lists it where the actor reads the meeting (ludy_meetings.personal_row_ids, with the title as one hit of kind 4), counts it per recorder where the owner cannot (ludy_meetings.personal_matches, as a title), and the
  // erasure redacts the value in it by the rule of the title (ludy_meetings.personal_erase, counted in the titles, cut to 200 characters). A place the owner cannot read is part of the stamp of the notice (ludy_meetings.text_stamp),
  // so a place added or changed after a notice is not covered by it; a meeting with no place keeps the stamp it had. It goes with the meeting (the recorder's delete, an owner's delete, the retention job, the org purge).
  'ludy_meetings.meeting.place': {
    kind: 'free_text',
    handling: 'erase',
    reason: "The place of a meeting, which may name or describe a person or an address: found where the actor reads the meeting; counted per recorder where the owner cannot; the owner's erasure edits the value out of it as out of a meeting title; deleted with the meeting (its recorder, an owner for a personal-data request, the retention job or the org purge)",
  },
  // The transcript (ADR-0047 point 7, issue #2578): what was said and who it is attributed to. A draft is the recorder's alone and
  // a published line is read by the meeting's readers.
  'ludy_meetings.transcript_segment.text': {
    kind: 'free_text',
    handling: 'erase',
    reason: "What was said in a meeting, which may name or describe a person: found where the actor reads the meeting; counted per recorder where the owner cannot; deleted with the meeting (its recorder, an owner, or the retention job)",
  },
  // The live preview of a meeting being recorded (ADR-0052 L4a-2, issue #3110): the recorder's own Vy's transcription of the pieces sent so far. Only the recorder reads it (no
  // finder, owner or admin can), the batch transcript replaces it, and it goes with the meeting, so a request is answered the way it is for the transcript: by deleting the meeting.
  'ludy_meetings.live_line.text': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A draft of what was said in a meeting being recorded, which may name or describe a person: read by its recorder alone, replaced by the transcript after the meeting, deleted with the meeting (its recorder, an owner, or the retention job), 30 days after it was made, and 30 days after its recorder was removed (the former-member purge of their Vy data)",
  },
  // Short-lived Vy daily briefing prep lines (#5080, ADR-0049): held privately for the opted-in member for at most 36 hours.
  // No finder reads them; counts per org are reported via morning_brief_lines_counts(), matching rows are erased via
  // morning_brief_lines_erase() and personal_erase(), and rows cascade with meeting deletion, member removal, retention purge, and org purge.
  'ludy_meetings.morning_brief_lines.lines': {
    kind: 'free_text',
    handling: 'erase',
    privateRows: 'always',
    reason: 'Short-lived Vy daily briefing prep lines of each member (auto-expire within 36 hours): held privately for that member, deleted on meeting delete, member removal, retention purge, archive shred, org purge, or personal-data erasure',
  },
  // The machine translation of a meeting's summary (meetings integrations E1, issue #3184): a member's own Vy's translation of the summary, its decisions and its item titles, private to the
  // member who asked. No finder, owner or admin reads it; it goes with the meeting, with the summary it translated, and an erasure that touches the meeting DROPS it (never redacts it:
  // a name cannot be located reliably in another language), so a request is answered the way it is for the transcript.
  'ludy_meetings.translation.body': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A machine translation of a meeting's summary, which may name or describe a person: read by the member who asked alone, deleted with the meeting (its recorder, an owner, the retention job or the org purge), with the summary it translated, and 30 days after the member who asked was removed (the former-member purge of their Vy data), and dropped, not redacted, by an erasure that touches the meeting",
  },
  // The second-language version of a meeting's published minutes (Meetings, issue #4777): the text the recorder reviewed, edited and published beside the original, read by every reader of the
  // meeting. It holds no figure, link, address or number that identifies someone (8 digits or more) that its original does not hold ITSELF, each one by name: the publish command (versionTextProblem,
  // modules/meetings/src/minutes-version.ts) holds the text to the database's own matching (text_mention_pattern, here the probe's), from the safe side: on the texts as stored and on their NFKC fold, an address is a
  // whole word with an "@" (the characters the pattern refuses beside an address stay part of it) and a number is each run of 8 to 20 digits the pattern can find, with its own boundary rules and
  // leading zeros kept, so what the pattern finds in a version it finds in the original (a db test holds the code to the real function). So the finder reads the person's value in the original and a
  // redaction of the original reaches the version by the database: it DROPS the version (never redacts it: a name cannot be located reliably in another language) the moment the published
  // summary, a decision or an action item title changes, is replaced or is unpublished, and it goes with the meeting (the recorder, an owner, the retention job or the org purge). ludy_meetings.personal_erase also
  // DROPS it directly (#4857), for every meeting the erasure touches and whether or not the original could be redacted, so no path depends on those triggers alone.
  'ludy_meetings.minutes_version.body': {
    kind: 'free_text',
    handling: 'erase',
    reason: "The recorder's reviewed translation of a meeting's published minutes, which may name or describe a person: read where the actor reads the meeting, deleted with the meeting (its recorder, an owner, the retention job or the org purge) and with the minutes it sits beside, and dropped, not redacted, by an erasure that touches the meeting",
  },
  // The body of a minutes-webhook event waiting to be sent (meetings integrations A6, issue #3164): the title, summary, decisions and action items the recorder ticked, copied at publish and kept
  // only while the event waits. The database wipes it (sets it to NULL) the moment the delivery settles, and drops a waiting event, wiping it, when the meeting's title, its published summary or
  // decisions or an action item change (which is what the erasure's redaction does), when the hook is turned off or its address changes, when the member leaves, the owner turns the feature off, or
  // the meeting is deleted. No finder reads it; a copy already sent leaves Ludy and cannot be recalled (the screen says so).
  'ludy_meetings.hook_delivery.body': {
    kind: 'free_text',
    handling: 'erase',
    reason: "The text of minutes the recorder chose to send to their own address, which may name or describe a person: kept only while the event waits (minutes, at most 8 hours), wiped when it is sent, fails or is dropped, and dropped, wiped, by an erasure that touches the meeting's text, by the member turning the hook off or changing its address, and with the meeting, the member and the org; a copy already sent cannot be recalled",
  },
  // The recorder's own rough notes of a meeting (meetings integrations A5, issue #3163): typed by the recorder, read, written and deleted by the recorder alone (row security: an owner, an
  // admin, an attendee, an agent and the system context read none). The finder lists the row for the recorder acting as owner (ludy_meetings.personal_row_ids, kind 5) and counts the notes of
  // other recorders per recorder (ludy_meetings.personal_note_counts), never listing them. The org is the data controller: the owner's erasure redacts the value in the notes of every recorder
  // (ludy_meetings.personal_note_erase) and reports the count per recorder, as it deletes every member's translations of a touched meeting.
  'ludy_meetings.meeting_note.body': {
    kind: 'free_text',
    handling: 'erase',
    reason: "The recorder's own rough notes of a meeting, which may name or describe a person: read by the recorder alone; the owner's erasure edits the value out of every recorder's notes and counts them per recorder; deleted with the meeting (its recorder, an owner for a personal-data request, the retention job or the org purge)",
  },
  // The chapters (table of contents) of a meeting (#3844): a short title and the second of the transcript line it starts at, typed by the recorder (or copied from a run of their own Vy, tainted until
  // they review it), a draft that only the recorder reads until they publish it with the minutes, then read by the readers of the meeting. A title may name a person, so it is handled as the title of a
  // meeting is, whatever the probes can match (the command refuses an email address and a run of eight or more digits in it, but nothing here rests on that): the finder lists it where the actor reads
  // the meeting (ludy_meetings.personal_row_ids, kind 6), counts it per recorder where the owner cannot (ludy_meetings.personal_matches, as a title), and the erasure redacts the value in it by the rule
  // of the other meeting rows (ludy_meetings.personal_erase, counted in the titles). It goes with the meeting, and a draft after 30 days.
  'ludy_meetings.meeting_chapter.title': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A chapter title of a meeting, which may name or describe a person: read by the recorder alone until published, then by the meeting's readers; the owner's erasure edits the value out of it as out of a meeting title; deleted with the meeting (its recorder, an owner for a personal-data request, the retention job or the org purge), and a draft 30 days after it was made",
  },
  // The labels the recorder puts on a meeting (#4955, #4964): up to five short plain-text tags ("Khách Hoa Sen", "Họp tuần") that the meetings list filters by. A label may still name a person (the
  // command refuses an "@", a line break and a run of seven digits, but nothing here rests on that), so it is handled as the title of a meeting is: the finder lists it where the actor reads the meeting
  // (ludy_meetings.personal_row_ids, kind 7), counts it per recorder where the owner cannot (ludy_meetings.personal_matches, as a title), and the erasure redacts the value in it by the rule of the title
  // (ludy_meetings.personal_erase, counted in the titles); a redaction that would leave two labels alike on one meeting drops the later one, so the label list never holds the same text twice. A label
  // that an owner cannot read is part of the stamp of the notice, so a label added after a notice is not covered by it. It goes with the meeting (the recorder's delete, an owner's delete, the org purge).
  'ludy_meetings.meeting_label.label': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A label the recorder put on a meeting, which may name or describe a person: read by the recorder and the meeting's readers; the owner's erasure edits the value out of it as out of a meeting title (or drops the label when the edit would repeat another label of the meeting); deleted with the meeting (its recorder, an owner for a personal-data request, the retention job or the org purge)",
  },
  // The title of an event of a member's own Google Calendar (meetings B1, issue #3165): an 8-day cache (1 day back to 7 ahead) kept only while the member's switch "Cho Ludy đọc tên và giờ
  // cuộc họp trong lịch" is on. Read by that member alone (row security: an owner, an admin, another member, an agent and the system context read none), so there is no finder and no
  // erasure of a value inside it: a request is answered the way it is for the live preview, by the member turning the read off, which deletes it at once, or by disconnecting the calendar.
  'ludy_meetings.calendar_agenda.title': {
    kind: 'free_text',
    handling: 'erase',
    reason: "The title of an event of a member's own calendar, which may name or describe a person: a cache of the next 7 days and the last day, read by that member alone, deleted at once when they switch the read off or disconnect the calendar, a day after the event ended at the next sync (a row the member linked to a meeting stays until that meeting goes), and with the org",
  },
  // The message of a post of approved minutes to a Slack or Teams channel waiting to be sent (meetings integrations B4, issue #3168): the title, day, summary, decisions, action items and link back, copied at
  // the recorder's click and kept only while the post is queued. The database DELETES the row the moment the post settles, and drops a queued post, deleting it, when the meeting's title, its published summary
  // or decisions or an action item change (which is what the erasure's redaction does), when the channel is removed or its saver stops standing (the job drops it), and with the meeting and the org. No finder
  // reads it; a copy already sent leaves Ludy and cannot be recalled (the dialog says so).
  'ludy_meetings.chat_post_body.body': {
    kind: 'free_text',
    handling: 'erase',
    reason: "The text of minutes the recorder chose to post to a channel of the org, which may name or describe a person: kept only while the post waits (a minute or so, and at most 8 hours while the worker runs), deleted when it is sent, fails, is dropped or expires, dropped by an erasure that touches the meeting's text, and deleted with the channel, the meeting and the org; a copy already sent to the channel cannot be recalled and the dialog says so.",
  },
  'ludy_meetings.transcript_segment.speaker_label': {
    kind: 'free_text',
    handling: 'erase',
    reason: "The name a transcript line is attributed to (the recorder may set it to a real name): found where the actor reads the meeting; counted per recorder where the owner cannot; deleted with the meeting",
  },
  // The folded words of a line's text (search across meetings, L2 #2589): a generated column rebuilt from the text by every UPDATE of it, so the erasure of a mention in a line
  // takes it out of the words in the same statement, and it goes with its row. Not searched itself.
  'ludy_meetings.transcript_segment.search': { kind: 'other', handling: 'erase', reason: "The folded search words of a transcript line's text, rebuilt from it by the database (a generated column): an erasure of a mention in the text takes it out of the words in the same statement, and they go with the line" },
  // The summary, the decisions and the action items (issue #2580): what was said, drafted by the recorder or copied from the result of their own Vy.
  'ludy_meetings.meeting_result.summary': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A meeting's summary, which may name or describe a person: found where the actor reads the meeting; counted per recorder where the owner cannot; deleted with the meeting (its recorder, an owner, or the retention job)",
  },
  'ludy_meetings.meeting_result.decisions': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A meeting's decisions, which may name or describe a person: found where the actor reads the meeting; counted per recorder where the owner cannot; deleted with the meeting",
  },
  'ludy_meetings.action_item.title': {
    kind: 'free_text',
    handling: 'erase',
    reason: "What somebody said they would do, which may name a person: found where the actor reads the meeting; counted per recorder where the owner cannot; deleted with the meeting (a task made from it keeps the title its confirmer saw, as the org's own work record)",
  },
  'ludy_meetings.action_item.who_drafted': {
    kind: 'free_text',
    handling: 'erase',
    reason: "Who, as said in the meeting, an action item was for: found where the actor reads the meeting; counted per recorder where the owner cannot; deleted with the meeting",
  },
  'ludy_meetings.action_item.when_drafted': {
    kind: 'free_text',
    handling: 'erase',
    reason: "When, as said in the meeting, an action item was due (free words): found where the actor reads the meeting; counted per recorder where the owner cannot; deleted with the meeting",
  },
  'ludy_meetings.media_key.wrapped_key': {
    kind: 'other',
    handling: 'erase',
    reason: "The wrapped data key of a meeting's audio or video: deleting it is the shredding, and no copy of the ciphertext opens without it",
  },
  // The people payroll is run for (#2530, payroll plan 6.6). Their names and addresses are cleared by the owner's erasure of an ended employee after the retention
  // (hr.payroll.employee.erase), which also deletes the person's key; the finder does not match them by an email, a phone or a number (their numbers are sealed, below).
  'ludy_hr.payroll_employee.display_name': { kind: 'name', handling: 'erase', reason: "An employee's name; hr.payroll.employee.erase replaces it with a placeholder once the retention after the last day of work has passed" },
  'ludy_hr.payroll_employee.address': { kind: 'address', handling: 'erase', reason: "An employee's address; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.payroll_employee.birth_date': { kind: 'other', handling: 'erase', reason: "An employee's birth date; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.payroll_employee.bank_code': { kind: 'other', handling: 'erase', reason: "The code of the bank an employee is paid at (#2897); hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.payroll_employee.work_permit_expires_on': { kind: 'other', handling: 'erase', reason: "A foreign employee's work permit expiry date; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.payroll_dependent.display_name': { kind: 'name', handling: 'erase', reason: "A dependent's name; hr.payroll.employee.erase replaces it with a placeholder together with its employee's record" },
  'ludy_hr.leave_request.reason': { kind: 'other', handling: 'erase', reason: "An employee's free-text leave reason; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.leave_request.decision_note': { kind: 'other', handling: 'erase', reason: "An approver's note on an employee's leave request; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.attendance_log.note': { kind: 'other', handling: 'erase', reason: "An employee's or HR admin's free-text note on a daily attendance log; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.attendance_qr_config.qr_secret_hash': { kind: 'other', handling: 'not_personal', machinery: true, reason: 'Org/entity-scoped SHA-256 hash of the office attendance QR check-in token; identifies an office entity only, never an individual' },
  'ludy_hr.onboarding_submission.address': { kind: 'address', handling: 'erase', reason: "An employee's submitted onboarding address; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.onboarding_submission.birth_date': { kind: 'other', handling: 'erase', reason: "An employee's submitted onboarding birth date; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.onboarding_submission.bank_code': { kind: 'other', handling: 'erase', reason: "An employee's submitted bank code; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.onboarding_submission.note': { kind: 'other', handling: 'erase', reason: "An employee's onboarding checklist note; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.onboarding_submission.decision_note': { kind: 'other', handling: 'erase', reason: "An approver's note on an onboarding submission; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.overtime_request.reason': { kind: 'other', handling: 'erase', reason: "An employee's free-text overtime reason; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.overtime_request.decision_note': { kind: 'other', handling: 'erase', reason: "An approver's note on an employee's overtime request; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.probation_review.completed_tasks_snapshot': { kind: 'other', handling: 'erase', reason: "Task evidence snapshot recorded during an employee's probation review; hr.payroll.employee.erase resets it once the retention after the last day of work has passed" },
  'ludy_hr.probation_review.attendance_snapshot': { kind: 'other', handling: 'erase', reason: "Attendance evidence snapshot recorded during an employee's probation review; hr.payroll.employee.erase resets it once the retention after the last day of work has passed" },
  'ludy_hr.probation_review.review_note': { kind: 'other', handling: 'erase', reason: "Human reviewer note on an employee's probation evaluation; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.probation_review.ai_draft_note': { kind: 'other', handling: 'erase', reason: "Optional AI summary draft saved on an employee's probation evaluation; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.salary_advance_request.reason': { kind: 'other', handling: 'erase', reason: "An employee's free-text salary advance reason; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.salary_advance_request.decision_note': { kind: 'other', handling: 'erase', reason: "An approver's note on an employee's salary advance request; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.payroll_adjustment_item.reason': { kind: 'other', handling: 'erase', reason: "A manager's free-text note on an employee's retro pay or offset deduction item; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.payroll_adjustment_item.decision_note': { kind: 'other', handling: 'erase', reason: "An approver's note on an employee's payroll adjustment item; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.business_trip_request.destination': { kind: 'other', handling: 'erase', reason: "An employee's business trip destination text; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.business_trip_request.purpose': { kind: 'other', handling: 'erase', reason: "An employee's free-text business trip purpose; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.business_trip_request.decision_note': { kind: 'other', handling: 'erase', reason: "An approver's note on an employee's business trip request; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.contract_addendum.change_summary': { kind: 'other', handling: 'erase', reason: "Free-text contract amendment summary on an employee's addendum; hr.payroll.employee.erase redacts it once the retention after the last day of work has passed" },
  'ludy_hr.contract_addendum.previous_title': { kind: 'other', handling: 'erase', reason: "Previous role title recorded on an employee's contract addendum; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.contract_addendum.new_title': { kind: 'other', handling: 'erase', reason: "New role title recorded on an employee's contract addendum; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.contract_addendum.void_reason': { kind: 'other', handling: 'erase', reason: "Optional void reason recorded on an employee's contract addendum; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.employee_asset_handover.serial_number': { kind: 'other', handling: 'erase', reason: "Assigned equipment serial number linked to an employee handover row; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.employee_asset_handover.notes': { kind: 'other', handling: 'erase', reason: "Free-text handover/return note on an employee asset checklist row; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.okr_objective.title': { kind: 'other', handling: 'erase', reason: "Quarterly OKR objective title; hr.payroll.employee.erase redacts scope = 'individual' titles to '[erased]' once retention after the last day of work has passed (company and department objectives hold organizational goals)" },
  'ludy_hr.okr_key_result.last_checkin_note': { kind: 'other', handling: 'erase', reason: "Optional human check-in note on an employee's quarterly OKR key result; hr.payroll.employee.erase clears it once retention after the last day of work has passed" },
  'ludy_hr.shift_assignment.note': { kind: 'other', handling: 'erase', reason: "Optional manager or coordinator note on a scheduled shift assignment; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.shift_swap_request.reason': { kind: 'other', handling: 'erase', reason: "An employee's free-text reason on a shift swap request; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.shift_swap_request.decision_note': { kind: 'other', handling: 'erase', reason: "An approver's decision note on a shift swap request; hr.payroll.employee.erase clears it once the retention after the last day of work has passed" },
  'ludy_hr.candidate.display_name': { kind: 'name', handling: 'erase', reason: 'A job applicant name; erased by personal-data erasure or hr.recruiting.candidate.erase' },
  'ludy_hr.candidate.email': { kind: 'email', handling: 'erase', reason: 'A job applicant email; erased by personal-data erasure or hr.recruiting.candidate.erase' },
  'ludy_hr.candidate.phone': { kind: 'phone', handling: 'erase', reason: 'A job applicant phone number; erased by personal-data erasure or hr.recruiting.candidate.erase' },
  'ludy_hr.candidate.notes': { kind: 'free_text', handling: 'erase', reason: 'Recruiting notes for a candidate, which may mention personal details: cleared on direct erasure and mentions redacted on text match' },
  'ludy_projects.project.name': { kind: 'free_text', handling: 'erase', reason: "A project's title, which may name a person: mentions are replaced with a redaction marker" },
  'ludy_projects.project.description': { kind: 'free_text', handling: 'erase', reason: "A project's description, which may name a person: mentions are replaced with a redaction marker" },
  'ludy_projects.project.template_tasks': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Template task titles and descriptions in a project template, which may mention a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.project_column.name': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A project board column's name, which may name a person: mentions are replaced with a redaction marker",
  },
  'ludy_projects.project_cycle.name': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A project cycle's name, which may mention a person: mentions are replaced with a redaction marker",
  },
  'ludy_projects.project_cycle.goal': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A project cycle's goal, which may mention a person: mentions are replaced with a redaction marker",
  },
  'ludy_projects.roadmap_board.title': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Public roadmap board title, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.roadmap_board.description': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Public roadmap board description, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.roadmap_item.public_title': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Public roadmap item title, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.roadmap_item.public_summary': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Public roadmap item summary, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.roadmap_item.submitter_display_name': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Optional public submitter display name on a roadmap item; erased on personal-data match',
  },
  'ludy_projects.roadmap_signal.account_label': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Internal roadmap signal customer attribution label, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.roadmap_signal.quote_excerpt': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Internal roadmap signal customer quote excerpt, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.roadmap_announcement.title': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Public roadmap changelog announcement title, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.roadmap_announcement.body_md': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Public roadmap changelog announcement Markdown body, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.roadmap_vote.voter_email_hash': {
    kind: 'other',
    handling: 'hashed',
    reason: 'Org-scoped keyed HMAC-SHA256 hash of voter email preserving anonymous vote deduplication without storing an address',
  },
  'ludy_projects.roadmap_otp.email': {
    kind: 'email',
    handling: 'erase',
    machinery: true,
    reason: 'Ephemeral public roadmap email OTP challenge address; erased by ludy_projects.personal_erase_roadmap_machinery and swept nightly',
  },
  'ludy_projects.roadmap_otp.email_hash': {
    kind: 'other',
    handling: 'hashed',
    machinery: true,
    reason: 'Org-scoped keyed hash on ephemeral OTP row; row is deleted together with roadmap_otp.email on erasure',
  },
  'ludy_projects.roadmap_subscriber.voter_email_hash': {
    kind: 'other',
    handling: 'hashed',
    machinery: true,
    reason: 'Org-scoped keyed hash of subscriber email; row is deleted together with roadmap_subscriber.email_sealed on erasure',
  },
  'ludy_projects.roadmap_subscriber.email_sealed': {
    kind: 'email',
    handling: 'erase',
    machinery: true,
    reason: 'Sealed subscriber email for opt-in shipped notifications; erased by ludy_projects.personal_erase_roadmap_machinery',
  },
  'ludy_projects.roadmap_subscriber.mail_hash': {
    kind: 'other',
    handling: 'hashed',
    machinery: true,
    reason: 'Keyed mail hash on roadmap_subscriber used to enforce org mail suppressions; row is deleted on erasure',
  },
  'ludy_projects.time_entry.note': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'A project time entry note written by a member, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.project_triage_item.title': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'A project triage item title (internal or external signal), which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.project_triage_item.description': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'A project triage item description, which may name a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.project_triage_item.decline_reason': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'A project triage item decline reason written by a member, which may name a person: mentions are replaced with a redaction marker',
  },
  // Projects GitHub integration (#5158, ADR-0060): repository slugs are org operational configuration, whereas
  // external GitHub titles/authors and buffered PAT notices may quote a person and erase when matched.
  'ludy_projects.github_project_repo.repo_full_name': {
    kind: 'other',
    handling: 'not_personal',
    reason: 'Bound GitHub repository slug (owner/repo) configured for project sync, not a personal-data record',
  },
  'ludy_projects.github_task_link.repo_full_name': {
    kind: 'other',
    handling: 'not_personal',
    reason: 'Bound GitHub repository slug (owner/repo) on a linked issue or pull request, not a personal-data record',
  },
  'ludy_projects.github_sync_delivery.repo_full_name': {
    kind: 'other',
    handling: 'not_personal',
    machinery: true,
    reason: 'Definer-only delivery ledger repository slug (owner/repo), not a personal-data record',
  },
  'ludy_projects.github_task_link.external_title': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Linked GitHub issue or pull request title, which may quote a person: mentions are replaced with a redaction marker',
  },
  'ludy_projects.github_task_link.author_login': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'External GitHub handle on a linked issue or pull request; cleared to NULL when matched by an erasure probe',
  },
  'ludy_projects.github_webhook_notice.body': {
    kind: 'free_text',
    handling: 'erase',
    machinery: true,
    reason: 'Transient raw PAT GitHub webhook body deleted on claim and 10m sweep; deleted on erasure via ludy_projects.personal_data_erase_github_notice',
  },
  'ludy_projects.github_webhook_pending.body': {
    kind: 'free_text',
    handling: 'erase',
    machinery: true,
    reason: 'Transient orgless GitHub App webhook payload deleted on worker claim and within 10 minutes by github_webhook_sweep',
  },
  // eSign (#3323, #3427): unsealed signers (draft, voided, expired, or declined with sealed_file_id IS NULL) are removed on erasure; active, completed, and sealed signer records and append-only audit events stay for statutory verification; ephemeral email OTP rows erase via definer.
  'ludy_sign.signer.name': {
    kind: 'name',
    handling: 'keep_record',
    reason: 'Signer legal name preserved on active, completed, or sealed e-signature envelope and audit certificate under statutory e-transaction evidence retention; a signer on an unsealed envelope is erased',
  },
  'ludy_sign.signer.email': {
    kind: 'email',
    handling: 'keep_record',
    reason: 'Signer email address preserved on active, completed, or sealed e-signature envelope and audit certificate under statutory e-transaction evidence retention; a signer on an unsealed envelope is erased',
  },
  'ludy_sign.signer.phone': {
    kind: 'phone',
    handling: 'keep_record',
    reason: 'Signer phone number preserved on active, completed, or sealed e-signature envelope record under statutory e-transaction evidence retention; a signer on an unsealed envelope is erased',
  },
  'ludy_sign.signer.delegated_from_name': {
    kind: 'name',
    handling: 'keep_record',
    reason: 'Delegator legal name preserved on active, completed, or sealed e-signature envelope and audit certificate under statutory e-transaction evidence retention; delegation provenance on an unsealed envelope is erased',
  },
  'ludy_sign.signer.delegated_from_email': {
    kind: 'email',
    handling: 'keep_record',
    reason: 'Delegator email address preserved on active, completed, or sealed e-signature envelope and audit certificate under statutory e-transaction evidence retention; delegation provenance on an unsealed envelope is erased',
  },
  'ludy_sign.signer.delegation_reason': {
    kind: 'other',
    handling: 'keep_record',
    reason: 'Audited delegation reason preserved on active, completed, or sealed e-signature envelope record under statutory e-transaction evidence retention; delegation provenance on an unsealed envelope is erased',
  },
  'ludy_sign.signer.signature_typed_text': { kind: 'name', handling: 'keep_record', reason: 'Typed signature representation preserved on executed e-signature signer record' },
  'ludy_sign.signer.signer_user_agent': { kind: 'other', handling: 'keep_record', reason: 'Device user-agent string preserved in execution evidence for e-signature dispute resolution' },
  'ludy_sign.signer.signer_ip_hash': { kind: 'other', handling: 'hashed', reason: 'Keyed SHA-256 hash of signer IP address preserved for execution integrity without storing raw IP' },
  'ludy_sign.signer.require_email_otp': { kind: 'other', handling: 'not_personal', reason: 'Boolean flag configuring whether email OTP is required to view and sign' },
  'ludy_sign.field.signature_png_base64': { kind: 'other', handling: 'keep_record', reason: 'Handwritten signature bitmap embedded inside sealed e-signature document and evidence record' },
  'ludy_sign.signing_otp.email': { kind: 'email', handling: 'erase', machinery: true, reason: 'Ephemeral email OTP target address; erased by ludy_sign.personal_erase_otp and swept within 24 hours' },
  'ludy_sign.signing_otp.claim_sha256': { kind: 'other', handling: 'not_personal', machinery: true, reason: 'SHA-256 hash of short-lived pre-envelope direct-link OTP verification claim token' },
  'ludy_sign.signing_event.actor_label': { kind: 'other', handling: 'keep_record', reason: 'Append-only hash-chained signing_event actor label retained for statutory verification' },
  'ludy_sign.signing_event.ip_hash': { kind: 'other', handling: 'hashed', reason: 'Keyed SHA-256 hash of event actor IP address preserved in append-only hash-chained signing_event' },
  'ludy_sign.signing_event.user_agent': { kind: 'other', handling: 'keep_record', reason: 'Event actor user-agent string preserved in append-only hash-chained signing_event for dispute resolution' },
  'ludy_sign.template_role.require_email_otp': { kind: 'other', handling: 'not_personal', reason: 'Boolean flag configuring whether template role signers require email OTP' },
  'ludy_sign.template_direct_link.require_email_otp': { kind: 'other', handling: 'not_personal', machinery: true, reason: 'Boolean flag configuring whether template direct signing links require email OTP' },
  'ludy_sign.template_direct_link.token_sha256': { kind: 'other', handling: 'not_personal', machinery: true, reason: 'SHA-256 hash of reusable template direct signing capability token' },
  'ludy_sign.api_key.key_sha256': { kind: 'other', handling: 'not_personal', machinery: true, reason: 'SHA-256 hash of scoped org eSign REST API key' },
  'ludy_sign.ca_connection.secret_envelope': {
    kind: 'other',
    handling: 'keep_org',
    machinery: true,
    reason: 'The sealed credentials of an org CA provider connection (sealed with CredentialBroker, bound to org, provider, and connection id); never readable by the tenant, wiped on disable, and deleted with the org',
  },
  'ludy_sign.webhook.secret_envelope': {
    kind: 'other',
    handling: 'keep_org',
    machinery: true,
    reason: 'The sealed HMAC signing secret of an org eSign webhook endpoint (sealed with CredentialBroker, bound to org, provider, and webhook id); never readable by the tenant and deleted with the webhook or org',
  },
  'ludy_sign.webhook.previous_secret_envelope': {
    kind: 'other',
    handling: 'keep_org',
    machinery: true,
    reason: 'The previous sealed HMAC signing secret kept during a 24-hour rotation grace window (sealed with CredentialBroker, bound to org, provider, and webhook id); never readable by the tenant and deleted with the webhook or org',
  },
  'ludy_sign.envelope_obligation.counterparty_name': {
    kind: 'name',
    handling: 'keep_record',
    reason: 'Counterparty name on post-signature contract obligation record preserved alongside executed agreement terms; purged on org deletion',
  },
  'ludy_sign.kyc_check.findings_json': {
    kind: 'free_text',
    handling: 'erase',
    reason: 'Sender-side KYC attachment verification findings (extracted tax IDs, CCCD numbers, or signer/entity names under Vietnam PDPL Law 91/2025/QH15): an erasure deletes any kyc_check row whose findings quote the value while leaving sealed agreement files intact, and a member may run the check again',
  },
  // ludy_sign.kyc_check.file_id stays unclassified as internal in manifest (shared `file_id` column name, see line 428);
  // deleted kyc_check attachment link counts are still reported in personalDataErase via `ludy_sign.kyc_check.file_id`.
  'ludy_sign.field.attachment_file_id': {
    kind: 'other',
    handling: 'keep_record',
    reason: 'Uploaded signer KYC attachment link on an e-signature field: cleared on unsealed envelopes when its KYC findings are erased so reads block immediately, while completed/sealed envelope evidence remains intact',
  },
  'ludy_sign.member_signature.signature_typed_text': {
    kind: 'other',
    handling: 'erase',
    privateRows: 'always',
    reason: "A member's own saved typed signature text, readable and deletable by that member alone and removed when the member leaves the org",
  },
  'ludy_sign.member_signature.signature_png_base64': {
    kind: 'other',
    handling: 'erase',
    privateRows: 'always',
    reason: "A member's own saved signature or initials PNG image, readable and deletable by that member alone and removed when the member leaves the org",
  },
  'ludy_sign.deposit_profile.bank_code': {
    kind: 'other',
    handling: 'keep_org',
    reason: "Organization's own VietQR deposit bank code configured in eSign settings; deleted with the profile or org",
  },
  'ludy_sign.deposit_profile.account_number': {
    kind: 'account_number',
    handling: 'keep_org',
    reason: "Organization's own bank account number configured to receive eSign post-sign deposits; deleted with the profile or org",
  },
  'ludy_sign.deposit_profile.account_holder': {
    kind: 'name',
    handling: 'keep_org',
    reason: "Organization's own bank account holder name configured to receive eSign post-sign deposits; deleted with the profile or org",
  },
  'ludy_sign.envelope_deposit.snapshot_bank_code': {
    kind: 'other',
    handling: 'keep_record',
    reason: 'Immutable send-time bank code snapshot shown to signer on an executed eSign deposit request; purged on org deletion',
  },
  'ludy_sign.envelope_deposit.snapshot_account_number': {
    kind: 'account_number',
    handling: 'keep_record',
    reason: 'Immutable send-time receiving bank account number snapshot on an executed eSign deposit request; purged on org deletion',
  },
  'ludy_sign.envelope_deposit.snapshot_account_holder': {
    kind: 'name',
    handling: 'keep_record',
    reason: 'Immutable send-time receiving account holder snapshot on an executed eSign deposit request; purged on org deletion',
  },
  'ludy_sign.envelope_deposit.snapshot_emvco_payload': {
    kind: 'other',
    handling: 'keep_record',
    reason: 'Immutable send-time EMVCo VietQR payload snapshot containing receiving bank account details; purged on org deletion',
  },
  'ludy_sign.envelope_deposit.signer_ip_hash': {
    kind: 'other',
    handling: 'hashed',
    reason: 'Keyed SHA-256 hash of signer IP address recorded on post-sign deposit transfer notice without storing raw IP',
  },
} as const satisfies Record<string, PersonalDataColumn>;

export type PersonalDataColumnKey = keyof typeof PERSONAL_DATA_COLUMNS;

// Columns that hold personal data the finder and the erasure cannot handle yet, with the step that registers them
// (#1874). Empty since notes step N9 registered the notes' text (#1678); a column a module classifies as pii before the
// finder can reach it waits here. apps/kernel/test/personal-data.test.ts asks every pii column of ludy_notes to be in
// one list or the other.
export const PERSONAL_DATA_PENDING: Readonly<Record<string, string>> = {};

// Columns that hold a value sealed under its subject's key (ADR-0017, #2640; `<schema>.<table>.<column>`, the place ctx.seal takes). An erasure
// deletes the subject's key (ludy_kernel.subject_key_shred), so the value stays in its row, byte for byte, and can no longer be opened: handling
// `shred`, never the clear the finder's erase makes in a mutable row. Empty until the first product use (#2530) seals a column; a column listed
// here is in no other registry above (apps/kernel/test/personal-data.test.ts).
export const SEALED_COLUMNS: Readonly<Record<string, { handling: 'shred'; reason: string }>> = {
  'ludy_hr.payroll_employee.national_id_sealed': {
    handling: 'shred',
    reason: "An employee's identity number, sealed under the subject key employee:<id>; hr.payroll.employee.erase deletes the key, so the text that stays in the row can never be opened again",
  },
  'ludy_hr.payroll_employee.tax_code_sealed': {
    handling: 'shred',
    reason: "An employee's tax code (in most cases the identity number), sealed under the subject key employee:<id>; hr.payroll.employee.erase deletes the key, so the text that stays in the row can never be opened again",
  },
  'ludy_hr.payroll_employee.insurance_number_sealed': {
    handling: 'shred',
    reason: "An employee's social insurance number, sealed under the subject key employee:<id>; hr.payroll.employee.erase deletes the key, so the text that stays in the row can never be opened again",
  },
  'ludy_hr.payroll_employee.bank_account_sealed': {
    handling: 'shred',
    reason: "An employee's bank account number, sealed under the subject key employee:<id>; hr.payroll.employee.erase deletes the key, so the text that stays in the row can never be opened again",
  },
  'ludy_hr.payroll_employee.work_permit_number_sealed': {
    handling: 'shred',
    reason: "A foreign employee's work permit number, sealed under the subject key employee:<id>; hr.payroll.employee.erase deletes the key, so the text that stays in the row can never be opened again",
  },
  'ludy_hr.onboarding_submission.national_id_sealed': {
    handling: 'shred',
    reason: "An employee's submitted identity number, sealed under the subject key employee:<id>; hr.payroll.employee.erase clears the column and deletes the key",
  },
  'ludy_hr.onboarding_submission.tax_code_sealed': {
    handling: 'shred',
    reason: "An employee's submitted personal tax code, sealed under the subject key employee:<id>; hr.payroll.employee.erase clears the column and deletes the key",
  },
  'ludy_hr.onboarding_submission.insurance_number_sealed': {
    handling: 'shred',
    reason: "An employee's submitted social insurance number, sealed under the subject key employee:<id>; hr.payroll.employee.erase clears the column and deletes the key",
  },
  'ludy_hr.onboarding_submission.bank_account_sealed': {
    handling: 'shred',
    reason: "An employee's submitted bank account number, sealed under the subject key employee:<id>; hr.payroll.employee.erase clears the column and deletes the key",
  },
  'ludy_finance.supplier_bank_account.account_holder_sealed': {
    handling: 'shred',
    reason: "A supplier's account holder name, sealed under the subject key supplier:<party_id>; finance.supplier_bank_account.erase deletes the key, so the text that stays in the row can never be opened again",
  },
  'ludy_finance.supplier_bank_account.number_sealed': {
    handling: 'shred',
    reason: "A supplier's bank account number, sealed under the subject key supplier:<party_id>; finance.supplier_bank_account.erase deletes the key, so the text that stays in the row can never be opened again",
  },
};

// The column names the invariant test treats as personal data. A column of ludy_kernel, ludy_finance, ludy_social,
// ludy_crm, ludy_notes, ludy_hr or ludy_meetings whose name matches must be in PERSONAL_DATA_COLUMNS. Control-plane tables (the user's own
// sign-in account and the deployment's own records) are not tenant data and are left out: the identity provider
// handles a user's own account, and no tenant code reads them (control-plane-reads.test.ts).
export const PERSONAL_DATA_NAME_PATTERN =
  '(^|_)(email|emails|phone|phones|address|addresses|tax_code|recipient|recipients|person_name|reviewer_name|display_name|from_address|to_address|national_id|id_number|birth_date|full_name)($|_)';
export const PERSONAL_DATA_SCHEMAS = ['ludy_kernel', 'ludy_finance', 'ludy_social', 'ludy_crm', 'ludy_notes', 'ludy_hr', 'ludy_meetings', 'ludy_projects', 'ludy_sign'] as const;

// The finder (#923): an owner or admin looks up one person by email address, phone number, or tax code or national ID
// (digits), across the columns above that hold such a value, and gets every matching row as JSON (the search column
// left out). Read in the org's context, so row security keeps it to the org. Each column returns at most
// PERSONAL_DATA_ROW_LIMIT rows; `truncated` says when one had more.
export const PERSONAL_DATA_ROW_LIMIT = 200;

// Free text (#1678, shared with #1948): whether a text column mentions the probe's email address or digits among other
// words, and the text with every mention replaced by a mark. Both go through ludy_kernel.text_mentions and
// text_redact (20261106200000), which hold the one pattern: a whole address, not part of a longer one; digits with the
// spaces, dots, brackets or dashes people write between them, and a phone with or without +84. A column of another
// type is read as text (an array or jsonb as its text form, where an address or a number reads as itself).
export function freeTextMatch(probe: Probe, column: RawBuilder<unknown>): RawBuilder<boolean> {
  return sql<boolean>`ludy_kernel.text_mentions(${column}::text, ${probe.kind}, ${probeValue(probe)})`;
}

export function freeTextRedact(probe: Probe, column: RawBuilder<unknown>, mark: string): RawBuilder<string> {
  return sql<string>`ludy_kernel.text_redact(${column}::text, ${probe.kind}, ${probeValue(probe)}, ${mark})`;
}

const templateTasksMatch = (probe: Probe, column: RawBuilder<unknown>): RawBuilder<boolean> => sql<boolean>`
  EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(${column}) AS item
     WHERE ${freeTextMatch(probe, sql`item ->> 'title'`)}
        OR (pg_catalog.jsonb_typeof(item -> 'description') = 'string'
            AND ${freeTextMatch(probe, sql`item ->> 'description'`)})
  )`;

const templateTasksRedact = (probe: Probe, column: RawBuilder<unknown>, mark: string): RawBuilder<unknown> => sql`
  COALESCE(
    (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object(
            'title',
            COALESCE(
              NULLIF(pg_catalog.btrim(pg_catalog.left(
                CASE
                  WHEN ${freeTextMatch(probe, sql`elem.item ->> 'title'`)}
                    THEN ${freeTextRedact(probe, sql`elem.item ->> 'title'`, mark)}
                  ELSE elem.item ->> 'title'
                END,
                ${PROJECT_TASK_TITLE_MAX}::int
              )), ''),
              ${mark}
            ),
            'description',
            CASE
              WHEN pg_catalog.jsonb_typeof(elem.item -> 'description') = 'string' THEN
                pg_catalog.left(
                  CASE
                    WHEN ${freeTextMatch(probe, sql`elem.item ->> 'description'`)}
                      THEN ${freeTextRedact(probe, sql`elem.item ->> 'description'`, mark)}
                    ELSE elem.item ->> 'description'
                  END,
                  ${PROJECT_TEMPLATE_TASK_DESCRIPTION_MAX}::int
                )
              ELSE NULL
            END,
            'dueOffsetDays',
            CASE
              WHEN pg_catalog.jsonb_typeof(elem.item -> 'dueOffsetDays') = 'number'
                THEN elem.item -> 'dueOffsetDays'
              ELSE NULL
            END,
            'tainted',
            CASE
              WHEN pg_catalog.jsonb_typeof(elem.item -> 'tainted') = 'boolean'
                THEN elem.item -> 'tainted'
              ELSE NULL
            END
          )
        )
        ORDER BY elem.ord
      )
      FROM pg_catalog.jsonb_array_elements(${column}) WITH ORDINALITY AS elem(item, ord)
    ),
    '[]'::jsonb
  )`;

const probeValue = (probe: Probe): string => (probe.kind === 'email' ? probe.email : probe.digits);

// The columns a probe is compared with, and how. Phone numbers match with or without Vietnam's +84. Free text is
// searched for the value anywhere inside it (#1678, #1948): freeTextMatch.
function columnMatch(kind: PersonalDataKind, probe: Probe, column: RawBuilder<unknown>): RawBuilder<boolean> | null {
  if (kind === 'free_text') return freeTextMatch(probe, column);
  if (probe.kind === 'email') {
    if (kind === 'email') return sql<boolean>`pg_catalog.lower(${column}) = ${probe.email}`;
    if (kind === 'email_list') return sql<boolean>`EXISTS (SELECT 1 FROM pg_catalog.unnest(${column}) AS r(v) WHERE pg_catalog.lower(r.v) = ${probe.email})`;
    return null;
  }
  const digits = sql`pg_catalog.regexp_replace(${column}, '[^0-9]', '', 'g')`;
  if (kind === 'tax_code' || kind === 'account_number') return sql<boolean>`${digits} = ${probe.digits}`;
  if (kind === 'national_id') return sql<boolean>`pg_catalog.regexp_replace(${column}, '[^0-9A-Za-z]', '', 'g') = ${probe.digits}`;
  if (kind === 'phone') {
    const local = probe.digits.startsWith('84') ? `0${probe.digits.slice(2)}` : probe.digits;
    const international = local.startsWith('0') ? `84${local.slice(1)}` : local;
    return sql<boolean>`${digits} IN (${local}, ${international})`;
  }
  return null;
}

// What an erasure does to one matched row: the column's handling, or its override when the row says so.
export function rowHandling(entry: PersonalDataColumn, row: Record<string, unknown>): { handling: PersonalDataHandling; reason: string } {
  const override = entry.override;
  if (override && row[override.when] === true) return { handling: override.handling, reason: override.reason };
  return { handling: entry.handling, reason: entry.reason };
}

function requireProbe(value: string): Probe {
  const probe = personalDataProbe(value);
  if (!probe) throw new DomainError('PERSONAL_DATA_QUERY', 422, 'Hãy nhập một địa chỉ email, một số điện thoại, hoặc một mã số thuế hay số căn cước');
  return probe;
}

// A scan of meeting text under a statement timeout of its own (the connection's, or 10 s if that is longer: SQLSTATE 57014), in a savepoint: when the org holds more meeting text than one
// search reads in time, the search goes on without it and says so (meetingTextSkipped), so the other rows are still found and an erasure of everything else is never blocked by meeting
// volume. Any other error (a refusal by the database included) fails the search. The scan changes nothing; an erasure's redaction is in a savepoint too and is rolled back whole.
const MEETING_SCAN_TIMEOUT_MS = 10_000;
async function meetingScan<T>(trx: QueryContext['trx'], run: () => Promise<T>): Promise<T | null> {
  await sql`SAVEPOINT meeting_text_scan`.execute(trx);
  try {
    // Never raised above the connection's own timeout, and put back after the scan.
    const { rows } = await sql<{ was: string; ms: string }>`SELECT pg_catalog.current_setting('statement_timeout') AS was, setting AS ms FROM pg_catalog.pg_settings WHERE name = 'statement_timeout'`.execute(trx);
    const pool = Number(rows[0]?.ms ?? 0);
    const ms = pool > 0 ? Math.min(pool, MEETING_SCAN_TIMEOUT_MS) : MEETING_SCAN_TIMEOUT_MS;
    await sql`SELECT pg_catalog.set_config('statement_timeout', ${`${ms}ms`}, true)`.execute(trx);
    const out = await run();
    await sql`SELECT pg_catalog.set_config('statement_timeout', ${rows[0]?.was ?? '0'}, true)`.execute(trx);
    await sql`RELEASE SAVEPOINT meeting_text_scan`.execute(trx);
    return out;
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code !== '57014' && code !== '40P01') throw error;
    // The rollback also puts the timeout back (a local setting made inside the savepoint goes with it).
    await sql`ROLLBACK TO SAVEPOINT meeting_text_scan`.execute(trx);
    await sql`RELEASE SAVEPOINT meeting_text_scan`.execute(trx);
    // A deadlock with a recorder's edit of the same meeting (the database chose this transaction to end): nothing was changed, and the owner can simply ask again.
    if (code === '40P01') throw new DomainError('PERSONAL_DATA_BUSY', 409, 'Một cuộc họp đang được sửa hoặc đang gửi thư cùng lúc; hãy thử lại sau ít phút');
    return null;
  }
}

// The tables of ludy_meetings.personal_row_ids's kind codes.
const MEETING_ROW_TABLES: Record<number, string> = { 1: 'transcript_segment', 2: 'meeting_result', 3: 'action_item', 4: 'meeting', 5: 'meeting_note', 6: 'meeting_chapter', 7: 'meeting_label' };

// Caller-RLS meeting visibility and active text retention check for meetings.meeting roadmap signals (#4600, ADR-0047).
function meetingSignalReadable(alias: 't' | 's'): RawBuilder<boolean> {
  const orgRef = sql.ref(`${alias}.org_id`);
  const sourceIdRef = sql.ref(`${alias}.source_id`);
  return sql<boolean>`EXISTS (
    SELECT 1
      FROM ludy_meetings.meeting m
     WHERE m.org_id = ${orgRef}
       AND m.id = ${sourceIdRef}
       AND (m.text_retention_date IS NULL OR m.text_retention_date > (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date)
  )`;
}

// Scrubs roadmap_signal.quote_excerpt to NULL whenever a meetings.meeting row is unreadable, past text retention, or deleted.
function roadmapSignalRowExpr(alias: 't' | 's'): RawBuilder<Record<string, unknown>> {
  const rowRef = sql.ref(alias);
  const sourceTypeRef = sql.ref(`${alias}.source_type`);
  return sql<Record<string, unknown>>`CASE
    WHEN ${sourceTypeRef} = 'meetings.meeting' AND NOT ${meetingSignalReadable(alias)}
      THEN (pg_catalog.to_jsonb(${rowRef}) - 'search') || pg_catalog.jsonb_build_object('quote_excerpt', NULL)
    ELSE pg_catalog.to_jsonb(${rowRef}) - 'search'
  END`;
}

// Every row of the org that holds the value, column by column (the finder's answer), and, when privateCounts, per author
// how many of their private notes and to-dos mention it (ADR-0037: counted, never shown, whoever runs the finder).
async function findPersonalData(
  trx: QueryContext['trx'],
  orgId: string,
  probe: Probe,
  privateCounts: boolean,
  documentedPartyIds: readonly string[] = [],
  options: { includePendingNoteAttachments?: boolean } = {},
): Promise<PersonalDataResult> {
  const includePendingNoteAttachments = options.includePendingNoteAttachments ?? true;
  const matches: PersonalDataResult['matches'] = [];
  let truncated = false;
  let pendingSharedAttachments = 0;
  let privateItems: PersonalDataResult['privateItems'] = null;
  let pendingPrivateAttachments: number | null = null;
  type AttachmentColSpec = {
    key: string;
    entry: PersonalDataColumn;
    schema: string;
    table: string;
    match: RawBuilder<unknown>;
    shared: RawBuilder<unknown>;
    rowExpr: RawBuilder<unknown>;
  };
  const attachmentSpecs: AttachmentColSpec[] = [];
  let attachmentExecuted = false;
  const runAttachmentSnapshot = async () => {
    if (!includePendingNoteAttachments || attachmentExecuted) return;
    attachmentExecuted = true;
    // Read shared attachment matches (each capped at 201 rows before JSONB projection, streamed without AS MATERIALIZED),
    // shared/private pending counts, and (for owners) private_matches() in one MVCC snapshot so concurrent worker extraction
    // or note visibility flips cannot emit contradictory pending warnings and match counts (#5127).
    const ctes: RawBuilder<unknown>[] = attachmentSpecs.map((spec, i) => {
      const cteName = sql.raw(`c_${i}`);
      return sql`${cteName} AS (
        SELECT ${spec.rowExpr} AS row
          FROM ${sql.table(`${spec.schema}.${spec.table}`)} AS t
         WHERE t.org_id = ${orgId}::uuid AND ${spec.match} ${spec.shared}
         LIMIT ${PERSONAL_DATA_ROW_LIMIT + 1}
      )`;
    });
    ctes.push(sql`shared_pending AS (
      SELECT pg_catalog.count(*)::text AS n
        FROM ludy_notes.attachment a
        JOIN ludy_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
       WHERE a.org_id = ${orgId}::uuid
         AND n.visibility = 'org'
         AND a.extract_status = 'pending'
    )`);
    if (privateCounts) {
      ctes.push(sql`private_pending AS (
        SELECT ludy_notes.private_pending_attachment_count()::text AS n
      )`);
      ctes.push(sql`private_matched AS (
        SELECT m.author_user_id, m.notes::text AS notes, m.todos::text AS todos
          FROM ludy_notes.private_matches(${probe.kind}, ${probeValue(probe)}) m
      )`);
    }
    const branches: RawBuilder<unknown>[] = [
      privateCounts
        ? sql`SELECT 'counts'::text AS row_kind, NULL::text AS col_key, sp.n AS pending_shared, pp.n AS pending_private, NULL::jsonb AS row, NULL::uuid AS author_user_id, NULL::text AS notes, NULL::text AS todos FROM shared_pending sp, private_pending pp`
        : sql`SELECT 'counts'::text AS row_kind, NULL::text AS col_key, sp.n AS pending_shared, NULL::text AS pending_private, NULL::jsonb AS row, NULL::uuid AS author_user_id, NULL::text AS notes, NULL::text AS todos FROM shared_pending sp`,
      ...attachmentSpecs.map((spec, i) => {
        const cteName = sql.raw(`c_${i}`);
        return sql`SELECT 'match'::text AS row_kind, ${spec.key}::text AS col_key, NULL::text AS pending_shared, NULL::text AS pending_private, ${cteName}.row AS row, NULL::uuid AS author_user_id, NULL::text AS notes, NULL::text AS todos FROM ${cteName}`;
      }),
      ...(privateCounts
        ? [
            sql`SELECT 'private_match'::text AS row_kind, NULL::text AS col_key, NULL::text AS pending_shared, NULL::text AS pending_private, NULL::jsonb AS row, pm.author_user_id, pm.notes, pm.todos FROM private_matched pm`,
          ]
        : []),
    ];
    const { rows } = await sql<{
      row_kind: 'counts' | 'match' | 'private_match';
      col_key: string | null;
      pending_shared: string | null;
      pending_private: string | null;
      row: Record<string, unknown> | null;
      author_user_id: string | null;
      notes: string | null;
      todos: string | null;
    }>`WITH ${sql.join(ctes, sql`, `)} ${sql.join(branches, sql` UNION ALL `)}`.execute(trx);
    const countsRow = rows.find((r) => r.row_kind === 'counts');
    pendingSharedAttachments = Number(countsRow?.pending_shared ?? 0);
    if (privateCounts) pendingPrivateAttachments = Number(countsRow?.pending_private ?? 0);
    const byCol = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      if (r.row_kind !== 'match' || r.col_key === null || r.row === null) continue;
      const list = byCol.get(r.col_key);
      if (list) list.push(r.row);
      else byCol.set(r.col_key, [r.row]);
    }
    for (const spec of attachmentSpecs) {
      const matchedRows = byCol.get(spec.key) ?? [];
      if (matchedRows.length > PERSONAL_DATA_ROW_LIMIT) truncated = true;
      for (const row of matchedRows.slice(0, PERSONAL_DATA_ROW_LIMIT)) {
        const { handling, reason } = rowHandling(spec.entry, row);
        if (!searchable(handling)) continue;
        matches.push({ column: spec.key, handling, reason, rowId: typeof row.id === 'string' ? row.id : null, row });
      }
    }
    if (privateCounts) {
      privateItems = rows.flatMap((r) =>
        r.row_kind === 'private_match' && r.author_user_id !== null
          ? [{ authorUserId: r.author_user_id, notes: Number(r.notes), todos: Number(r.todos) }]
          : [],
      );
    }
  };
  // Meeting text: the ids of the rows that hold the value and that the actor reads, found by the text first (row security would check every row's meeting before testing
  // the text, which costs seconds on a large transcript); the rows are then read by id, still under row security.
  const meetingRows = new Map<string, string[]>();
  let meetingTextSkipped = false;
  const rowIds = await meetingScan(trx, async () => (await sql<{ kind: number; id: string }>`SELECT kind, id FROM ludy_meetings.personal_row_ids(${probe.kind}, ${probeValue(probe)})`.execute(trx)).rows);
  if (rowIds === null) meetingTextSkipped = true;
  for (const { kind, id } of rowIds ?? []) {
    const table = MEETING_ROW_TABLES[kind];
    // A kind code this build does not know is a version mismatch between the database and the code: it fails loudly, never a silent gap in what an erasure covers.
    if (!table) throw new Error(`ludy_meetings.personal_row_ids answered an unknown kind ${kind}`);
    meetingRows.set(table, [...(meetingRows.get(table) ?? []), id]);
  }
  for (const [key, entry] of Object.entries(PERSONAL_DATA_COLUMNS) as Array<[string, PersonalDataColumn]>) {
    if (!searchable(entry.handling)) continue;
    if (entry.privateRows === 'always') continue;
    if (entry.machinery) continue;
    const [schema, table, column] = key.split('.') as [string, string, string];
    const ref = sql.ref(`t.${column}`);
    const expr = entry.list
      ? sql`pg_catalog.array_to_string(${ref}, ' ')`
      : entry.jsonbSteps
        ? sql`(SELECT coalesce(pg_catalog.string_agg(s.step ->> 'text', ' | '), '') FROM pg_catalog.jsonb_array_elements(${ref}) AS s(step))`
        : ref;
    const match = key === 'ludy_projects.project.template_tasks' ? templateTasksMatch(probe, ref) : columnMatch(entry.kind, probe, expr);
    if (!match) continue;
    // Row security already hides other members' private notes; the finder's own private ones are counted below too,
    // not listed, so every author's are reported alike.
    const shared =
      entry.privateRows === 'unless_shared'
        ? schema === 'ludy_notes' && (table === 'attachment' || table === 'note_version')
          ? sql`AND EXISTS (SELECT 1 FROM ludy_notes.note n WHERE n.org_id = t.org_id AND n.id = t.note_id AND n.visibility = 'org')`
          : sql`AND t.visibility = 'org'`
        : sql``;
    let byId = sql``;
    if (schema === 'ludy_meetings') {
      const ids = meetingRows.get(table) ?? [];
      if (ids.length === 0) continue;
      byId = sql`AND t.id = ANY(${ids}::uuid[])`;
    }
    const signalVisibility =
      key === 'ludy_projects.roadmap_signal.quote_excerpt'
        ? sql`AND (t.source_type <> 'meetings.meeting' OR ${meetingSignalReadable('t')})`
        : sql``;
    // A mail of a source in MAIL_SOURCES_LEFT_OUT (follow-up, weekly, summary-ready and morning meeting mails and the tracked-word alert, #4533, #4967, #5018, #4873) is found by its address but shown as its id, address, status and time only: its payload, subject and source id hold a meeting's text, link or per-member
    // counts, which an owner or admin who may not read an attendees-only meeting or private calendar count must not get through the finder. The row stays findable and erasable (the erasure works on the column, not on this view).
    const rowExpr =
      schema === 'ludy_projects' && table === 'roadmap_signal'
        ? roadmapSignalRowExpr('t')
        : schema === 'ludy_kernel' && table === 'mail_message'
          ? sql`CASE WHEN t.source IN (${sql.join(MAIL_SOURCES_LEFT_OUT)}) THEN pg_catalog.jsonb_build_object('id', t.id, 'to_address', t.to_address, 'status', t.status, 'created_at', t.created_at) ELSE pg_catalog.to_jsonb(t) - 'search' END`
          : sql`pg_catalog.to_jsonb(t) - 'search'`;
    const isUnsealedExpr =
      schema === 'ludy_sign' && table === 'signer'
        ? sql<boolean>`EXISTS (
            SELECT 1 FROM ludy_sign.envelope e
             WHERE e.org_id = t.org_id
               AND e.id = t.envelope_id
               AND e.status IN ('draft', 'voided', 'expired', 'declined')
               AND e.sealed_file_id IS NULL
          )`
        : sql<boolean>`false`;
    if (includePendingNoteAttachments && schema === 'ludy_notes' && table === 'attachment') {
      attachmentSpecs.push({ key, entry, schema, table, match, shared, rowExpr });
      continue;
    }
    const { rows } = await sql<{ row: Record<string, unknown>; is_unsealed: boolean }>`
      SELECT ${rowExpr} AS row, ${isUnsealedExpr} AS is_unsealed
        FROM ${sql.table(`${schema}.${table}`)} AS t
       WHERE t.org_id = ${orgId}::uuid AND ${match} ${shared} ${byId} ${signalVisibility}
       LIMIT ${PERSONAL_DATA_ROW_LIMIT + 1}`.execute(trx);
    if (rows.length > PERSONAL_DATA_ROW_LIMIT) truncated = true;
    for (const { row, is_unsealed } of rows.slice(0, PERSONAL_DATA_ROW_LIMIT)) {
      const base = rowHandling(entry, row);
      const { handling, reason } =
        schema === 'ludy_sign' && table === 'signer' && is_unsealed
          ? {
              handling: 'erase' as const,
              reason: 'Signer on an unsealed e-signature envelope (draft, voided, expired, or declined) is erased on request',
            }
          : base;
      if (!searchable(handling)) continue;
      matches.push({ column: key, handling, reason, rowId: typeof row.id === 'string' ? row.id : null, row });
    }
  }
  await runAttachmentSnapshot();
  // Project weekly status mails (#2609): summary and subject are free text typed by a manager or seeded by AI; search both for personal data.
  const weeklyMails = await sql<{ id: string; org_id: string; source: string; source_id: string | null; status: string; subject: string | null; created_at: Date }>`
    SELECT m.id, m.org_id, m.source, m.source_id, m.status, m.subject, m.created_at
      FROM ludy_kernel.mail_message m
     WHERE m.org_id = ${orgId}::uuid
       AND m.source IN (${PROJECT_WEEKLY_STATUS_MAIL_SOURCE}, ${ROADMAP_SHIPPED_MAIL_SOURCE})
       AND (m.payload IS NOT NULL OR m.subject IS NOT NULL)
       AND (${freeTextMatch(probe, sql.ref('m.subject'))} OR ${freeTextMatch(probe, sql.ref('m.payload'))})
     ORDER BY m.created_at DESC, m.id
     LIMIT ${PERSONAL_DATA_ROW_LIMIT + 1}`.execute(trx);
  if (weeklyMails.rows.length > PERSONAL_DATA_ROW_LIMIT) truncated = true;
  for (const row of weeklyMails.rows.slice(0, PERSONAL_DATA_ROW_LIMIT)) {
    matches.push({
      column: 'ludy_kernel.mail_message.payload',
      handling: 'erase',
      reason: PROJECT_WEEKLY_MAIL_REASON,
      rowId: row.id,
      row,
    });
  }
  const seenDealSignalIds = new Set(
    matches.filter((m) => m.column === 'ludy_projects.roadmap_signal.account_label' && m.rowId !== null).map((m) => m.rowId!),
  );
  const partySignalNever = sql<boolean>`false`;
  const partySignalMatch = sql<boolean>`(${columnMatch('email', probe, sql.ref('p.email')) ?? partySignalNever} OR ${columnMatch('phone', probe, sql.ref('p.phone')) ?? partySignalNever} OR ${columnMatch('tax_code', probe, sql.ref('p.tax_code')) ?? partySignalNever})`;
  const partySignalFilter =
    documentedPartyIds.length > 0
      ? sql<boolean>`(${partySignalMatch} OR p.id = ANY(${documentedPartyIds}::uuid[]))`
      : partySignalMatch;
  const partyDealSignals = await sql<{ id: string; documented: boolean; row: Record<string, unknown> }>`
    SELECT s.id,
           pg_catalog.bool_or(
             EXISTS (SELECT 1 FROM ludy_finance.purchase_document pd WHERE pd.org_id = p.org_id AND pd.party_id = p.id)
             OR EXISTS (SELECT 1 FROM ludy_finance.cash_voucher v WHERE v.org_id = p.org_id AND v.party_id = p.id)
             OR EXISTS (SELECT 1 FROM ludy_finance.journal_line l WHERE l.org_id = p.org_id AND l.party_id = p.id)
           ) AS documented,
           ${roadmapSignalRowExpr('s')} AS row
      FROM ludy_projects.roadmap_signal s
      LEFT JOIN ludy_crm.deal d ON s.source_type = 'crm.deal' AND d.org_id = s.org_id AND d.id = s.source_id
      JOIN ludy_kernel.party p
        ON p.org_id = s.org_id
       AND (p.id = s.source_party_id OR (s.source_type = 'crm.deal' AND p.id = d.party_id))
     WHERE s.org_id = ${orgId}::uuid
       AND s.account_label IS NOT NULL
       AND ${partySignalFilter}
     GROUP BY s.org_id, s.id, s.source_type, s.source_id
     ORDER BY s.created_at DESC, s.id
     LIMIT ${PERSONAL_DATA_ROW_LIMIT + 1}`.execute(trx);
  if (partyDealSignals.rows.length > PERSONAL_DATA_ROW_LIMIT) truncated = true;
  for (const r of partyDealSignals.rows.slice(0, PERSONAL_DATA_ROW_LIMIT)) {
    if (seenDealSignalIds.has(r.id)) continue;
    matches.push({
      column: 'ludy_projects.roadmap_signal.account_label',
      handling: r.documented ? 'keep_org' : 'erase',
      reason: r.documented
        ? 'CRM deal roadmap signal customer label for a party named on accounting records'
        : 'CRM deal roadmap signal customer label copied from a matched party',
      rowId: r.id,
      row: r.row,
    });
  }
  // Meeting text the owner cannot read (an attendees-only meeting, a draft that is not theirs): counted per recorder, never listed (#2594, ADR-0047 points 2 and 7).
  let meetingText: PersonalDataResult['meetingText'] = null;
  if (privateCounts) {
    const counts = await meetingScan(
      trx,
      async () =>
        (
          await sql<{ recorder_user_id: string; meetings: string; lines: string; results: string; items: string; titles: string }>`
            SELECT recorder_user_id, meetings, lines, results, items, titles FROM ludy_meetings.personal_matches(${probe.kind}, ${probeValue(probe)})`.execute(trx)
        ).rows,
    );
    if (counts === null) meetingTextSkipped = true;
    meetingText = (counts ?? []).map((m) => ({ recorderUserId: m.recorder_user_id, meetings: Number(m.meetings), lines: Number(m.lines), results: Number(m.results), items: Number(m.items), titles: Number(m.titles) }));
    // The recorders' own rough notes (A5, #3163) that the owner cannot read: counted per recorder like the rest, in their own field, and only where there are some.
    const noteCounts = await meetingScan(
      trx,
      async () => (await sql<{ recorder_user_id: string; notes: string }>`SELECT recorder_user_id, notes FROM ludy_meetings.personal_note_counts(${probe.kind}, ${probeValue(probe)})`.execute(trx)).rows,
    );
    if (noteCounts === null) meetingTextSkipped = true;
    for (const n of noteCounts ?? []) {
      const entry = meetingText.find((m) => m.recorderUserId === n.recorder_user_id);
      if (entry) entry.notes = Number(n.notes);
      else meetingText.push({ recorderUserId: n.recorder_user_id, meetings: 0, lines: 0, results: 0, items: 0, titles: 0, notes: Number(n.notes) });
    }
  }
  if (privateCounts && privateItems === null) {
    privateItems = (
      await sql<{ author_user_id: string; notes: string; todos: string }>`
        SELECT author_user_id, notes, todos FROM ludy_notes.private_matches(${probe.kind}, ${probeValue(probe)})`.execute(trx)
    ).rows.map((p) => ({ authorUserId: p.author_user_id, notes: Number(p.notes), todos: Number(p.todos) }));
  }
  const hasPendingNoteAttachments =
    pendingSharedAttachments > 0 || (pendingPrivateAttachments !== null && pendingPrivateAttachments > 0);
  return {
    kind: probe.kind === 'email' ? 'email' : 'digits',
    matches,
    privateItems,
    meetingText,
    meetingTextSkipped,
    ...(hasPendingNoteAttachments
      ? { pendingNoteAttachments: { shared: pendingSharedAttachments, private: pendingPrivateAttachments } }
      : {}),
    truncated,
  };
}

// The finder (#923), a command so that every search leaves an audit row (#1678 review): the counts of private items are
// an oracle, since a probe of a guessed value (a salary, an ID number) tells whether some member's private note holds
// it (ADR-0037 section 3). The row records who searched, the kind and the counts, never the value. Owners and admins
// find rows; only owners, who send the notice and erase, get the private counts (privateItems null for an admin). It
// changes nothing else.
export const personalDataFind = defineCommand({
  name: 'kernel.personal_data.find',
  input: zPersonalDataQuery,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input): Promise<PersonalDataResult> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới tìm được dữ liệu cá nhân');
    const probe = requireProbe(input.value);
    const result = await findPersonalData(ctx.trx, ctx.orgId, probe, ctx.role === 'owner');
    ctx.audit({
      kind: probe.kind,
      matches: result.matches.length,
      truncated: result.truncated,
      private: result.privateItems === null
        ? null
        : { authors: result.privateItems.length, notes: result.privateItems.reduce((n, p) => n + p.notes, 0), todos: result.privateItems.reduce((n, p) => n + p.todos, 0) },
      meeting_text: result.meetingText === null
        ? null
        : { recorders: result.meetingText.length, meetings: result.meetingText.reduce((n, m) => n + m.meetings, 0), lines: result.meetingText.reduce((n, m) => n + m.lines, 0) },
      // Never write pending_note_attachments.private (or depend on private existence) in audit_event, which admins can list/export (#5127).
      ...(result.pendingNoteAttachments && result.pendingNoteAttachments.shared > 0
        ? { pending_shared_note_attachments: result.pendingNoteAttachments.shared }
        : {}),
    });
    return result;
  },
});

// What an erasure says of meeting text it left or could not search (#2594).
export const MEETING_TEXT_SKIPPED_REASON = 'The meeting text of this organization was too large to search in time, so it was not searched: search again, or ask support, before relying on this erasure for meeting text';
export const PENDING_NOTE_ATTACHMENT_REASON =
  'Text extraction is still pending for shared note attachments, so their extracted text could not be searched yet: search or erase again once extraction completes';
export const PENDING_PRIVATE_NOTE_ATTACHMENT_REASON =
  'Text extraction is still pending for private note attachments, so their extracted text could not be searched yet (no filenames or notes are disclosed): run find, notify, and erase again once extraction completes';
export const FAILED_NOTE_ATTACHMENT_REASON =
  'Text extraction failed for shared note attachments, so their extracted text could not be searched (filenames were still scanned): inspect or remove those attachments manually if they may contain personal data';
export const FAILED_PRIVATE_NOTE_ATTACHMENT_REASON =
  'Text extraction failed for private note attachments, so their extracted text could not be searched (filenames were still scanned; no filenames or notes are disclosed): ask note owners to review their failed attachments if needed';
export const UNTOLD_MEETING_REASON =
  'Text of a meeting the owner cannot read, where no notice covers its recorder and its text as it is now (not sent, the recorder not told 24 hours ago, or the text changed since): send the notice, wait 24 hours, then erase again; the recorder or an owner can also delete the meeting';
// The statuses of a mail that has left Ludy or may have (the mail table's own set): handed to the worker (sending), outcome unknown (ambiguous), or sent on to its recipient (sent,
// delivered, bounced, complained). Its copies in the recipients' mailboxes cannot be taken back; a queued, failed or suppressed mail never reached one.
const DELIVERED_MAIL_STATUSES: readonly string[] = ['sending', 'ambiguous', 'sent', 'delivered', 'bounced', 'complained'];
export const FOLLOWUP_MAIL_HIDDEN_REASON =
  'Follow-up mails whose own text mentions the value, of a meeting the owner cannot read: the copy of a meeting text stays here as the meeting rows do, since dropping a mail that is still queued would destroy another member\'s pending send unannounced. When the recorder or an owner deletes the meeting its mails lose their payload and subject at once; otherwise the payload expires 30 days after the mail\'s final status and the subject after 13 months';
export const FOLLOWUP_MAIL_SHORT_NUMBER_REASON =
  'Follow-up mails whose text holds a number of fewer than 10 digits: such a number may as well be an amount, a date or a figure of the meeting, and dropping a mail cannot be undone, so the erasure leaves these mails as they are (the meeting text is left too, see the ludy_meetings entries); check them and tell the person, or ask for a longer value';
// A number of fewer than 10 digits may as well be a date or a figure in meeting text (#3064), and a redaction cannot be undone: the meeting text is left as it is, counted, and the finder still lists it.
export const MEETING_TEXT_SHORT_NUMBER_REASON =
  'A number of fewer than 10 digits may also be a date, an amount or a figure in meeting text (a transcript line, a summary, a decision, an action item or a title), so the erasure does not redact it there; check these rows and tell the person, or ask for a longer value, or have the recorder or an owner delete the meeting';
export const FOLLOWUP_MAIL_SKIPPED_REASON =
  'The follow-up mails of this organization were too many to search in time, so their own text was not searched (the mails of meetings whose rows changed were still handled): erase again, or ask support, before relying on this erasure for follow-up mails';
export const FOLLOWUP_MAIL_DELIVERED_REASON =
  'Follow-up mails of a meeting that were already handed to their recipients (delivered, or possibly delivered) cannot be recalled: the erasure dropped the copy of the text that Ludy holds, not the copies in the recipients\' mailboxes';
export const PROJECT_WEEKLY_MAIL_REASON =
  "Text or subject of a project's weekly status email (#2609); erased by dropping the mail's payload and subject (the keyed recipient hash stays so suppressions still hold)";
export const PROJECT_WEEKLY_MAIL_SHORT_NUMBER_REASON =
  'Project weekly status mails whose text holds a number of fewer than 10 digits: such a number may as well be a date, task count or figure, and dropping a mail cannot be undone, so the erasure leaves these mails as they are; check them and tell the person, or ask for a longer value';
export const PROJECT_WEEKLY_MAIL_DELIVERED_REASON =
  'Project weekly status mails that were already handed to their recipients (delivered, or possibly delivered) cannot be recalled: the erasure dropped the copy of the text that Ludy holds, not the copies in the recipients\' mailboxes';
export const MEMBER_VY_RESULT_REASON =
  "Answers of each member's Vy (the row count is all of the organization's, not this person's) are held privately for that member and cannot be read here; they expire on their own (at most 31 days) and are never sent anywhere";
// What the owner is told when a member's private meeting rows are counted, not read (#3584): a member's machine translations of meetings and the live preview lines of the meetings they recorded
// are sealed to that member, so an erasure cannot read them; they go with their meeting and, once the member is removed, in the 30-day former-member purge of their Vy data.
export const MEMBER_TRANSLATION_REASON =
  "Machine translations of meetings (the row count is all of the organization's, not this person's) are held privately for the member who asked and cannot be read here; they go with their meeting, and 30 days after that member is removed";
export const MEMBER_LIVE_LINE_REASON =
  "Live preview lines of meetings being recorded or not yet transcribed (the row count is all of the organization's, not this person's) are held privately for the recorder and cannot be read here; they are replaced by the transcript, expire 30 days after they were made, go with their meeting, and go 30 days after their recorder is removed";
export const MEMBER_BRIEF_LINES_REASON =
  "Short-lived Vy daily briefing prep lines (the row count is all of the organization's, not this person's) are held privately for the opted-in member and cannot be read here; matching lines were erased, and remaining lines auto-expire within 36 hours, go with their meeting, and go when that member is removed";
export function meetingMediaReason(kind: 'audio' | 'video', dates: readonly string[], hidden: number): string {
  const first = [...dates].sort()[0];
  const word = kind === 'audio' ? 'The audio' : 'The video';
  const own = dates.length > 0 ? `it is kept until its retention date (the earliest ${first} among the meetings the owner can read) and then shredded` : 'it is kept until its retention date and then shredded';
  // A hidden meeting's date would tell roughly when it took place: only how many there are.
  const more = hidden > 0 ? `; ${hidden} more held in meetings the owner cannot read, kept until their own retention date` : '';
  return `${word} of meetings that held the value cannot be edited, so ${own}${more}; an owner can delete a meeting at once (meetings.meeting.owner_delete), the recorder too`;
}
// Why an erasure keeps the original files of posted invoices (issue #1009), with the end of their retention hold.
export function heldFilesReason(until: Date | null): string {
  const kept = until ? `held in storage until ${new Date(until).toISOString().slice(0, 10)}` : 'kept for the legal period';
  return `Original files behind posted entries that name this party: accounting evidence, ${kept} and never deleted by Ludy (Accounting Law 88/2015, Art. 41)`;
}

// The fewest digits a value needs before the erasure replaces it inside activity lines and tasks (#1948, #1961): a
// shorter number may be an amount or a voucher number there, so those rows are listed for the owner instead, with this
// reason.
export const ACTIVITY_REDACT_MIN_DIGITS = 10;
// What a quoted value becomes in free text the erasure changes, as ludy_kernel.personal_data_redact_activity writes it.
export const REDACTED_MARK = '[đã xóa]';
const SHORT_NUMBER_COLUMNS = new Set([
  'ludy_kernel.activity.summary',
  'ludy_kernel.task.title',
  'ludy_kernel.task.description',
  'ludy_kernel.task.checklist',
  'ludy_projects.project.name',
  'ludy_projects.project.description',
  'ludy_projects.project.template_tasks',
  'ludy_projects.project_column.name',
  'ludy_projects.project_cycle.name',
  'ludy_projects.project_cycle.goal',
  'ludy_projects.roadmap_board.title',
  'ludy_projects.roadmap_board.description',
  'ludy_projects.roadmap_item.public_title',
  'ludy_projects.roadmap_item.public_summary',
  'ludy_projects.roadmap_item.submitter_display_name',
  'ludy_projects.roadmap_signal.account_label',
  'ludy_projects.roadmap_signal.quote_excerpt',
  'ludy_projects.roadmap_announcement.title',
  'ludy_projects.roadmap_announcement.body_md',
  'ludy_projects.time_entry.note',
  'ludy_projects.project_triage_item.title',
  'ludy_projects.project_triage_item.description',
  'ludy_projects.project_triage_item.decline_reason',
  'ludy_projects.github_task_link.external_title',
  'ludy_projects.github_task_link.author_login',
  'ludy_hr.candidate.notes',
]);
// The meeting text columns the redaction of ludy_meetings.personal_erase would change, left as they are for a short number (#3064).
const SHORT_NUMBER_MEETING_COLUMNS = new Set([
  'ludy_meetings.meeting.title',
  'ludy_meetings.meeting.place',
  'ludy_meetings.transcript_segment.text',
  'ludy_meetings.transcript_segment.speaker_label',
  'ludy_meetings.meeting_result.summary',
  'ludy_meetings.meeting_result.decisions',
  'ludy_meetings.action_item.title',
  'ludy_meetings.action_item.who_drafted',
  'ludy_meetings.action_item.when_drafted',
  'ludy_meetings.meeting_note.body',
  'ludy_meetings.meeting_chapter.title',
  'ludy_meetings.meeting_label.label',
]);
// The same for MISA AMIS's refusal text on a pushed voucher (#4015): a short number there may be an amount or an invoice number MISA quoted.
export const MISA_PUSH_REASON_SHORT_NUMBER_REASON =
  "A number of fewer than 10 digits may also be an amount or an invoice number in MISA AMIS's refusal text, so the erasure does not clear it there; check these rows and tell the person, or ask for a longer value";
export const ACTIVITY_SHORT_NUMBER_REASON =
  'A number of fewer than 10 digits may also be an amount or a voucher number in a timeline line or a task, so the erasure does not replace it there; check these rows and tell the person, or ask for a longer value';

// The name an erased party keeps: a party row cannot lose its name, and nothing in the books names it.
export const ERASED_PARTY_NAME = 'Đã xóa theo yêu cầu';
// What an erasure leaves in a shared note's text where the value was (#1678).
export const ERASED_TEXT_MARK = '[đã xóa]';
// Private items one notice names at most, and so authors (each has one at least); a request that matches more is
// refused, never named in part.
export const PERSONAL_DATA_NOTICE_ITEMS = 1000;
// Why an erasure keeps a private item that mentions the value: no notice named it as it is now (written or changed since
// the last one), or the notice's notification has not reached its author yet or did less than 24 hours ago, so the
// author has not had the time to read it and take their items (ludy_notes.private_erase).
export const UNTOLD_PRIVATE_REASON =
  'A private item whose author was not told at least 24 hours ago (written or changed since the last notice, its notification not sent yet, or sent less than 24 hours ago): send the notice if needed, wait 24 hours, then erase again';

// The owner's notice before an erasure (#1678, ADR-0037 section 5): the authors of private notes and to-dos that mention
// the value are told how many of theirs do, so they know before the erasure deletes them. Nobody but the author reads
// a private item: ludy_notes.private_notice_items answers their ids and authors only, the audit row records the ids
// with the value's keyed notice key (which the erasure checks, ludy_notes.private_erase: it deletes only what a notice
// for the same value named, at its current revision, and only once its author got the notification), and the event
// kernel.personal_data.notified carries the authors and counts, which kernel.notification.dispatch turns into one
// notification each, sent even when the author turned that kind off. The value itself is in neither.
export const personalDataNotify = defineCommand({
  name: 'kernel.personal_data.notify',
  input: zPersonalDataQuery,
  risk: 'R2',
  sideEffect: 'internal',
  access: OWNERS,
  handler: async (ctx, input): Promise<PersonalDataNotice> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới gửi được thông báo này');
    const probe = requireProbe(input.value);
    const { rows } = await sql<{ item_type: string; item_id: string; author_user_id: string; revision: number }>`
      SELECT item_type, item_id, author_user_id, revision FROM ludy_notes.private_notice_items(${probe.kind}, ${probeValue(probe)})`.execute(ctx.trx);
    if (rows.length > PERSONAL_DATA_NOTICE_ITEMS) {
      throw new DomainError('PERSONAL_DATA_NOTICE_TOO_MANY', 422, `Có hơn ${PERSONAL_DATA_NOTICE_ITEMS} ghi chú riêng và việc nhắc đến giá trị này; hãy liên hệ hỗ trợ`);
    }
    // Meetings whose text the owner cannot read and that hold the value (#2594): the recorder is told how many of their meetings do, as an author is of private notes. A scan the statement
    // timeout stopped does not stop the notice of the notes: it is left out and recorded as skipped in the audit row, and the erasure then reports those meetings as kept, never as erased.
    const scanned = await meetingScan(ctx.trx, async () =>
      (await sql<{ meeting_id: string; recorder_user_id: string; stamp: string; key: Uint8Array }>`
        SELECT meeting_id, recorder_user_id, stamp::text AS stamp, key FROM ludy_meetings.personal_notice_items(${probe.kind}, ${probeValue(probe)})`.execute(ctx.trx)).rows,
    );
    const meetingsSkipped = scanned === null;
    const meetingRows = scanned ?? [];
    if (rows.length + meetingRows.length > PERSONAL_DATA_NOTICE_ITEMS) {
      throw new DomainError('PERSONAL_DATA_NOTICE_TOO_MANY', 422, `Có hơn ${PERSONAL_DATA_NOTICE_ITEMS} mục riêng và cuộc họp nhắc đến giá trị này; hãy liên hệ hỗ trợ`);
    }
    const authors = new Map<string, { authorUserId: string; notes: number; todos: number; meetings: number }>();
    for (const row of rows) {
      const a = authors.get(row.author_user_id) ?? { authorUserId: row.author_user_id, notes: 0, todos: 0, meetings: 0 };
      if (row.item_type === 'note' || row.item_type === 'note_template' || row.item_type === 'note_attachment' || row.item_type === 'notebook') a.notes += 1;
      else a.todos += 1;
      authors.set(row.author_user_id, a);
    }
    for (const row of meetingRows) {
      const a = authors.get(row.recorder_user_id) ?? { authorUserId: row.recorder_user_id, notes: 0, todos: 0, meetings: 0 };
      a.meetings += 1;
      authors.set(row.recorder_user_id, a);
    }
    const named = [...authors.values()];
    const { rows: keys } = await sql<{ key: string }>`SELECT ludy_notes.private_notice_key(${probe.kind}, ${probeValue(probe)}) AS key`.execute(ctx.trx);
    // The authors a notification reaches: members now, but the owner sending it (dispatch leaves out the actor).
    const actor = ctx.actor.userId;
    const members = named.length === 0 ? [] : await ctx.trx
      .selectFrom('ludy_kernel.tenant_member')
      .select('user_id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', 'in', named.map((a) => a.authorUserId))
      .execute();
    const told = members.filter((m) => m.user_id !== actor).length;
    const event =
      named.length > 0 ? await ctx.emit('kernel.personal_data.notified', { authors: named.map((a) => ({ userId: a.authorUserId, notes: a.notes, todos: a.todos, meetings: a.meetings })) }) : null;
    // What the erasure checks: the value's notice key, each item as '<id>:<revision>' (one changed since is not covered),
    // and the event whose notifications prove the authors were told. A keyed hash, ids and counts, never the value or
    // the text.
    const items = (type: string) => rows.filter((r) => r.item_type === type).map((r) => `${r.item_id}:${r.revision}`);
    // The meetings the same way, as '<meeting id>:<stamp of its text>' under the meetings' own key (a hash of the value, as the notes' is): the erasure redacts an unreadable meeting only at
    // the text a notice saw.
    const meetingKey = meetingRows[0]?.key ? Buffer.from(meetingRows[0].key).toString('hex') : null;
    ctx.audit({
      kind: probe.kind,
      key: keys[0]?.key ?? null,
      notes: items('note'),
      note_templates: items('note_template'),
      note_attachments: items('note_attachment'),
      notebooks: items('notebook'),
      todos: items('todo'),
      todo_lists: items('todo_list'),
      meeting_key: meetingKey,
      meetings: meetingRows.map((m) => `${m.meeting_id}:${m.stamp}`),
      meetings_skipped: meetingsSkipped,
      authors: named.length,
      told,
      event,
    });
    return { authors: named, told };
  },
});

// The erase command (#923): an owner erases a person's data on their request, identified by the same value the finder
// takes. R3: it cannot be undone, so it needs a fresh second factor. In the command's transaction it clears
// (`erase` in the registry):
// - on every party the value matches (by email, phone or tax code): its email, phone and address; a party that no
//   recorded invoice, voucher or journal line names also loses its tax code and its name (a placeholder);
// - the sender of forwarded mails and the recipient of mails Ludy sent (the keyed hash stays, so a suppression holds);
// - the org's contact email;
// - the visitor's name, email, phone and note on bookings from a public booking page;
// - the address in Social report schedules (a schedule left with nobody to mail is deleted);
// - every mention of the value in shared notes (edited out, the note stays), and the private notes and to-dos that
//   mention it and that an earlier notice told their authors about (deleted whole, unread; #1678, ADR-0037 section 5);
// - the value wherever an activity line (#1948) or a task's title or description (#1961) quotes it, replaced inside the
//   text; a number under 10 digits is left there and listed (it may be an amount or a voucher number).
// What the law or an append-only record keeps (the names and tax codes of parties in the books and of the legal entities
// the org keeps books for, #1312, cash vouchers, the tax portal's lists, invites, review feedback, task comments and the
// descriptions of journal entries and vouchers that quote the value, #1948, bank statement lines and journal line
// memos, #1961, and the original files of posted invoices naming the party, under their retention hold, #1009) is left
// as it is and listed with its reason.
// The audit row holds counts only, never the value or the rows.
export const personalDataErase = defineCommand({
  name: 'kernel.personal_data.erase',
  input: zPersonalDataQuery,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: OWNERS,
  handler: async (ctx, input): Promise<PersonalDataErasure> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xóa được dữ liệu cá nhân');
    const probe = requireProbe(input.value);
    const erased = new Map<string, number>();
    const add = (column: string, rows: number) => {
      if (rows > 0) erased.set(column, (erased.get(column) ?? 0) + rows);
    };
    const match = (kind: PersonalDataKind, column: string) => columnMatch(kind, probe, sql.ref(column));
    const never = sql<boolean>`false`;

    // Parties the value identifies, and whether the books name them.
    const partyMatch = sql<boolean>`(${match('email', 'p.email') ?? never} OR ${match('phone', 'p.phone') ?? never} OR ${match('tax_code', 'p.tax_code') ?? never})`;
    const { rows: parties } = await sql<{ id: string; email: boolean; phone: boolean; address: boolean; tax_code: boolean; company: boolean; documented: boolean }>`
      SELECT p.id, p.email IS NOT NULL AS email, p.phone IS NOT NULL AS phone, p.address IS NOT NULL AS address,
             p.tax_code IS NOT NULL AS tax_code, p.company_id IS NOT NULL AS company,
             (EXISTS (SELECT 1 FROM ludy_finance.purchase_document d WHERE d.org_id = p.org_id AND d.party_id = p.id)
              OR EXISTS (SELECT 1 FROM ludy_finance.cash_voucher v WHERE v.org_id = p.org_id AND v.party_id = p.id)
              OR EXISTS (SELECT 1 FROM ludy_finance.journal_line l WHERE l.org_id = p.org_id AND l.party_id = p.id)) AS documented
        FROM ludy_kernel.party p
       WHERE p.org_id = ${ctx.orgId}::uuid AND ${partyMatch}
       -- personalDataErase never changes party PK (org_id, id) or deletes party rows; FOR NO KEY UPDATE blocks concurrent party edits without conflicting with FK FOR KEY SHARE inserts (e.g. notes.link.add -> private_erase).
       FOR NO KEY UPDATE OF p`.execute(ctx.trx);
    let keptParties = 0;
    const forgottenPartyIds: string[] = [];
    const documentedPartyIds: string[] = [];
    for (const party of parties) {
      const forget = !party.documented;
      if (forget) forgottenPartyIds.push(party.id);
      else documentedPartyIds.push(party.id);
      await ctx.trx
        .updateTable('ludy_kernel.party')
        .set((eb) => ({
          email: null,
          phone: null,
          address: null,
          // The company a person works at (#2438) is a fact about the person, not a line of the books: it goes with the contact details, for a party the books name
          // (which keeps its name and tax code) as for one they do not (which loses its name too).
          company_id: null,
          ...(forget ? { tax_code: null, name: ERASED_PARTY_NAME } : {}),
          version: eb('version', '+', 1),
          updated_at: ctx.now,
        }))
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', party.id)
        .execute();
      // The people who worked at a forgotten company are not left pointing at the placeholder name.
      if (forget) {
        // The matched parties count their own link in the loop; the others are counted here.
        const unlinked = await ctx.trx
          .updateTable('ludy_kernel.party')
          .set((eb) => ({ company_id: null, version: eb('version', '+', 1), updated_at: ctx.now }))
          .where('org_id', '=', ctx.orgId)
          .where('company_id', '=', party.id)
          .$if(parties.length > 0, (qb) => qb.where('id', 'not in', parties.map((p) => p.id)))
          .executeTakeFirst();
        add('ludy_kernel.party.company_id', Number(unlinked.numUpdatedRows));
      }
      add('ludy_kernel.party.email', Number(party.email));
      add('ludy_kernel.party.phone', Number(party.phone));
      add('ludy_kernel.party.address', Number(party.address));
      add('ludy_kernel.party.company_id', Number(party.company));
      if (forget) {
        add('ludy_kernel.party.name', 1);
        add('ludy_kernel.party.tax_code', Number(party.tax_code));
      } else {
        keptParties += 1;
      }
    }
    // The learned bank-line rules of those parties (#2402): the keyed hash of a payer's name in a statement line points at the
    // person, and a party the books keep (a voucher names it) is never deleted, so the cascade never reaches them. They go,
    // documented or not; the vouchers they were learned from stay as the books keep them.
    if (parties.length > 0) {
      const { rows: rules } = await sql<{ id: string }>`
        DELETE FROM ludy_finance.bank_party_rule
         WHERE org_id = ${ctx.orgId}::uuid AND party_id = ANY(${parties.map((p) => p.id)}::uuid[])
         RETURNING id`.execute(ctx.trx);
      add('ludy_finance.bank_party_rule.key_hash', rules.length);
      // The name matches of those parties (#4124): a proposal holds the name of a catalogue entry that was found because it is the party's name, and a confirmation says the entry is that party. They go whole, documented
      // party or not (the next check proposes again for a party the books still carry). A name is never a probe, so this is where the proposal's name is erased: with the party it belongs to. The checks are locked first and
      // the waiting ones moved on, as for a tax code above, so a job that read the party's name before this erasure cannot put the proposal back.
      await sql`SELECT 1 FROM ludy_finance.misa_amis_match_check WHERE org_id = ${ctx.orgId}::uuid FOR UPDATE`.execute(ctx.trx);
      const { rows: nameMatches } = await sql<{ proposal: boolean }>`
        DELETE FROM ludy_finance.misa_amis_match
         WHERE org_id = ${ctx.orgId}::uuid AND kind = 'party_name' AND match_key = ANY(${parties.map((p) => p.id)}::text[])
         RETURNING candidate_name IS NOT NULL AS proposal`.execute(ctx.trx);
      add('ludy_finance.misa_amis_match.candidate_name', nameMatches.filter((r) => r.proposal).length);
      // Always, not only when a row went: a job may have read the party's name and not yet recorded a proposal for it, and that proposal is exactly what must not land after this erasure.
      await sql`UPDATE ludy_finance.misa_amis_match_check SET requested_at = pg_catalog.clock_timestamp() WHERE org_id = ${ctx.orgId}::uuid AND state = 'requested'`.execute(ctx.trx);
    }
    if (forgottenPartyIds.length > 0) {
      const { rows: clearedDealSignals } = await sql<{ id: string; had_label: boolean }>`
        UPDATE ludy_projects.roadmap_signal s
           SET account_label = NULL,
               source_party_id = CASE WHEN s.source_party_id = ANY(${forgottenPartyIds}::uuid[]) THEN NULL ELSE s.source_party_id END,
               updated_at = ${ctx.now}
          FROM ludy_projects.roadmap_signal o
         WHERE o.org_id = s.org_id
           AND o.id = s.id
           AND s.org_id = ${ctx.orgId}::uuid
           AND (s.account_label IS NOT NULL OR s.source_party_id = ANY(${forgottenPartyIds}::uuid[]))
           AND (
             s.source_party_id = ANY(${forgottenPartyIds}::uuid[])
             OR (
               s.source_type = 'crm.deal'
               AND EXISTS (
                 SELECT 1
                   FROM ludy_crm.deal d
                  WHERE d.org_id = s.org_id
                    AND d.id = s.source_id
                    AND d.party_id = ANY(${forgottenPartyIds}::uuid[])
               )
             )
           )
         RETURNING s.id, (o.account_label IS NOT NULL) AS had_label`.execute(ctx.trx);
      add('ludy_projects.roadmap_signal.account_label', clearedDealSignals.filter((r) => r.had_label).length);
      if (clearedDealSignals.length > 0) {
        const clearedIds = clearedDealSignals.map((r) => r.id);
        await sql`
          UPDATE ludy_kernel.idempotency_key
             SET response = pg_catalog.jsonb_set(response, '{value,signal,accountLabel}', 'null'::jsonb, false)
           WHERE org_id = ${ctx.orgId}::uuid
             AND command = 'projects.roadmap.signal.create'
             AND response IS NOT NULL
             AND response -> 'value' -> 'signal' ->> 'id' = ANY(${clearedIds}::text[])`.execute(ctx.trx);
      }
    }

    // Bookings the visitor made on a public booking page (#1318), matched by their email or phone: the visitor's name,
    // email, phone and note all go (the booking keeps its time and its link to the calendar event).
    const bookingMatch = sql<boolean>`(${match('email', 'b.email') ?? never} OR ${match('phone', 'b.phone') ?? never})`;
    const { rows: bookings } = await sql<{ visitor_name: boolean; email: boolean; phone: boolean; note: boolean }>`
      UPDATE ludy_crm.booking b SET visitor_name = NULL, email = NULL, phone = NULL, note = NULL
        FROM ludy_crm.booking o
       WHERE o.org_id = b.org_id AND o.id = b.id AND b.org_id = ${ctx.orgId}::uuid AND ${bookingMatch}
       RETURNING o.visitor_name IS NOT NULL AS visitor_name, o.email IS NOT NULL AS email, o.phone IS NOT NULL AS phone,
                 o.note IS NOT NULL AS note`.execute(ctx.trx);
    for (const b of bookings) {
      add('ludy_crm.booking.visitor_name', Number(b.visitor_name));
      add('ludy_crm.booking.email', Number(b.email));
      add('ludy_crm.booking.phone', Number(b.phone));
      add('ludy_crm.booking.note', Number(b.note));
    }

    // Recruiting candidates matched by their email or phone: their name, email, phone and notes are cleared (their stage and links stay).
    const candidateMatch = sql<boolean>`(${match('email', 'c.email') ?? never} OR ${match('phone', 'c.phone') ?? never})`;
    const { rows: candidates } = await sql<{ display_name: boolean; email: boolean; phone: boolean; notes: boolean }>`
      UPDATE ludy_hr.candidate c
         SET display_name = ${ERASED_PARTY_NAME}, email = NULL, phone = NULL, notes = NULL,
             erased_at = COALESCE(c.erased_at, ${ctx.now}), updated_at = ${ctx.now}
        FROM ludy_hr.candidate o
       WHERE o.org_id = c.org_id AND o.id = c.id AND c.org_id = ${ctx.orgId}::uuid AND ${candidateMatch}
       RETURNING o.display_name <> ${ERASED_PARTY_NAME} AS display_name, o.email IS NOT NULL AS email,
                 o.phone IS NOT NULL AS phone, o.notes IS NOT NULL AS notes`.execute(ctx.trx);
    for (const c of candidates) {
      add('ludy_hr.candidate.display_name', Number(c.display_name));
      add('ludy_hr.candidate.email', Number(c.email));
      add('ludy_hr.candidate.phone', Number(c.phone));
      add('ludy_hr.candidate.notes', Number(c.notes));
    }

    // Rows of a contact import not yet committed (#2229), matched by email, phone or tax code: deleted whole, for the row
    // holds the person's name and details as read from the file. The batch keeps its counts.
    const importMatch = sql<boolean>`(${match('email', 'r.email') ?? never} OR ${match('phone', 'r.phone') ?? never} OR ${match('tax_code', 'r.tax_code') ?? never})`;
    const { rows: staged } = await sql<{ batch_id: string; email: boolean; phone: boolean; tax_code: boolean; address: boolean }>`
      DELETE FROM ludy_crm.import_row r
       WHERE r.org_id = ${ctx.orgId}::uuid AND ${importMatch}
       RETURNING r.batch_id, r.email IS NOT NULL AS email, r.phone IS NOT NULL AS phone, r.tax_code IS NOT NULL AS tax_code,
                 r.address IS NOT NULL AS address`.execute(ctx.trx);
    // The staged batches that lost rows count what is left, so the preview and the Import button do not promise rows that are gone.
    const touched = [...new Set(staged.map((r) => r.batch_id))];
    if (touched.length > 0) {
      await sql`
        UPDATE ludy_crm.import_batch b SET
          total_rows = (SELECT count(*)::int FROM ludy_crm.import_row r WHERE r.org_id = b.org_id AND r.batch_id = b.id),
          new_rows = (SELECT count(*)::int FROM ludy_crm.import_row r WHERE r.org_id = b.org_id AND r.batch_id = b.id AND r.outcome = 'new'),
          duplicate_rows = (SELECT count(*)::int FROM ludy_crm.import_row r WHERE r.org_id = b.org_id AND r.batch_id = b.id AND r.outcome = 'duplicate'),
          conflict_rows = (SELECT count(*)::int FROM ludy_crm.import_row r WHERE r.org_id = b.org_id AND r.batch_id = b.id AND r.outcome = 'conflict'),
          invalid_rows = (SELECT count(*)::int FROM ludy_crm.import_row r WHERE r.org_id = b.org_id AND r.batch_id = b.id AND r.outcome = 'invalid'),
          new_companies = (SELECT count(DISTINCT ludy_kernel.search_fold(r.company_name))::int FROM ludy_crm.import_row r
                           WHERE r.org_id = b.org_id AND r.batch_id = b.id AND r.outcome = 'new' AND r.company_state = 'new')
        WHERE b.org_id = ${ctx.orgId}::uuid AND b.status = 'staged' AND b.id = ANY(${touched}::uuid[])`.execute(ctx.trx);
    }
    for (const r of staged) {
      add('ludy_crm.import_row.email', Number(r.email));
      add('ludy_crm.import_row.phone', Number(r.phone));
      add('ludy_crm.import_row.tax_code', Number(r.tax_code));
      add('ludy_crm.import_row.address', Number(r.address));
    }

    // The stored results of a MISA catalogue check (#4112), keyed by the party's tax code: the rows of a party matching the probe are deleted whole (an item row's key is an item code, so only party rows are looked at).
    // Through the command's own transaction: the delete policy of the table lets an owner's context delete. A short tax code (fewer than 10 digits) is never matched here, as the stored keys are 10 or 13 digits.
    const matchKey = match('tax_code', 'm.match_key');
    if (matchKey) {
      // The checks are locked first (record_check locks its row too): a record that is writing results finishes before the delete looks, or waits and then finds its request moved on.
      await sql`SELECT 1 FROM ludy_finance.misa_amis_match_check WHERE org_id = ${ctx.orgId}::uuid FOR UPDATE`.execute(ctx.trx);
      const { rows: misaMatches } = await sql<{ n: number }>`
        WITH gone AS (
          DELETE FROM ludy_finance.misa_amis_match m
           WHERE m.org_id = ${ctx.orgId}::uuid AND m.kind = 'party' AND ${matchKey}
           RETURNING 1)
        SELECT count(*)::int AS n FROM gone`.execute(ctx.trx);
      add('ludy_finance.misa_amis_match.match_key', Number(misaMatches[0]?.n ?? 0));
      // A check that waits may have read the tax code before this erasure: its time is moved on, so a job that took the old time has its record ignored (record_check compares it) and cannot put the code back. The
      // check stays waiting until its ten minutes pass or a person asks again. Known limit (decided in #4128, noted for #4124): a job that only starts after this erasure takes the new time and may record a match
      // again for a tax code the books still carry (the vouchers keep their party's tax code under the legal hold); the match is derived data and the next erasure deletes it.
      await sql`UPDATE ludy_finance.misa_amis_match_check SET requested_at = pg_catalog.clock_timestamp() WHERE org_id = ${ctx.orgId}::uuid AND state = 'requested'`.execute(ctx.trx);
    }

    if (probe.kind === 'email') {
      // A mail from the person goes with its text (#779), which may name or describe them.
      const { rows: inbound } = await sql<{ body_text: boolean }>`
        UPDATE ludy_kernel.inbound_message t SET from_address = NULL, body_text = NULL
          FROM ludy_kernel.inbound_message o
         WHERE o.org_id = t.org_id AND o.id = t.id AND t.org_id = ${ctx.orgId}::uuid AND ${match('email', 't.from_address') ?? never}
         RETURNING o.body_text IS NOT NULL AS body_text`.execute(ctx.trx);
      add('ludy_kernel.inbound_message.from_address', inbound.length);
      add('ludy_kernel.inbound_message.body_text', inbound.filter((m) => m.body_text).length);
      const mails = await sql`
        UPDATE ludy_kernel.mail_message t SET to_address = NULL
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match('email', 't.to_address') ?? never}`.execute(ctx.trx);
      add('ludy_kernel.mail_message.to_address', Number(mails.numAffectedRows ?? 0));
      const contact = await sql`
        UPDATE ludy_kernel.tenant t SET contact_email = NULL
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match('email', 't.contact_email') ?? never}`.execute(ctx.trx);
      add('ludy_kernel.tenant.contact_email', Number(contact.numAffectedRows ?? 0));
      // A schedule keeps its other recipients; one left with nobody is deleted (it mailed only this person).
      // Deleted first, so an address listed twice in different cases never leaves an empty list.
      const dropped = await sql`
        DELETE FROM ludy_social.report_schedule t
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match('email_list', 't.recipients') ?? never}
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(t.recipients) AS r(v) WHERE pg_catalog.lower(r.v) <> ${probe.email})`.execute(ctx.trx);
      const schedules = await sql`
        UPDATE ludy_social.report_schedule t
           SET recipients = ARRAY(SELECT r.v FROM pg_catalog.unnest(t.recipients) AS r(v) WHERE pg_catalog.lower(r.v) <> ${probe.email})
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match('email_list', 't.recipients') ?? never}`.execute(ctx.trx);
      add('ludy_social.report_schedule.recipients', Number(schedules.numAffectedRows ?? 0) + Number(dropped.numAffectedRows ?? 0));
    }

    // Unsealed eSign recipients (#3323, #3427): erase unsealed signers (locking envelope -> signer -> signing_token ->
    // field -> signing_otp) BEFORE ludy_sign.personal_erase_otp so we never acquire signing_otp prior to parent locks.
    const { rows: erasedSignRows } = await sql<{
      counts: {
        signers: number;
        emails: number;
        phones: number;
        typedSignatures: number;
        userAgents: number;
        fieldSignatures: number;
        otps: number;
        delegatedNames?: number;
        delegatedEmails?: number;
        delegationReasons?: number;
      };
    }>`
      SELECT ludy_sign.personal_erase_unsealed_signers(${probe.kind}, ${probeValue(probe)}) AS counts
    `.execute(ctx.trx);
    const erasedSign = erasedSignRows[0]?.counts;
    if (erasedSign) {
      add('ludy_sign.signing_otp.email', erasedSign.otps);
      add('ludy_sign.signer.name', erasedSign.signers);
      add('ludy_sign.signer.email', erasedSign.emails);
      add('ludy_sign.signer.phone', erasedSign.phones);
      add('ludy_sign.signer.signature_typed_text', erasedSign.typedSignatures);
      add('ludy_sign.signer.signer_user_agent', erasedSign.userAgents);
      add('ludy_sign.field.signature_png_base64', erasedSign.fieldSignatures);
      add('ludy_sign.signer.delegated_from_name', erasedSign.delegatedNames ?? 0);
      add('ludy_sign.signer.delegated_from_email', erasedSign.delegatedEmails ?? 0);
      add('ludy_sign.signer.delegation_reason', erasedSign.delegationReasons ?? 0);
    }
    if (probe.kind === 'email') {
      const { rows: signOtp } = await sql<{ count: number }>`
        SELECT ludy_sign.personal_erase_otp(${probe.email}) AS count`.execute(ctx.trx);
      add('ludy_sign.signing_otp.email', Number(signOtp[0]?.count ?? 0));

      const { rows: roadmapMachinery } = await sql<{ counts: { otps: number; subscribers: number } }>`
        SELECT ludy_projects.personal_erase_roadmap_machinery(${probe.email}) AS counts`.execute(ctx.trx);
      add('ludy_projects.roadmap_otp.email', Number(roadmapMachinery[0]?.counts?.otps ?? 0));
      add('ludy_projects.roadmap_subscriber.email_sealed', Number(roadmapMachinery[0]?.counts?.subscribers ?? 0));
    }

    // The raw body of a bank feed notice that waits for the worker (#4203): a notice whose text mentions the value is deleted (it is only a hint to pull and is deleted, not redacted, so the short-number guard below does not apply to it: a short number can only delete a hint that is rebuilt by the next notice). Through the owner-only definer: the table has no login role grant.
    const { rows: hookNotices } = await sql<{ rows: number }>`
      SELECT ludy_finance.personal_data_erase_bank_feed_notice(${probe.kind}, ${probeValue(probe)}) AS rows`.execute(ctx.trx);
    add('ludy_finance.bank_feed_webhook_notice.body', Number(hookNotices[0]?.rows ?? 0));

    // The raw body of a marketplace push that waits for the worker (#4316): the same, deleted when its text mentions the value.
    const { rows: marketplaceNotices } = await sql<{ rows: number }>`
      SELECT ludy_finance.personal_data_erase_marketplace_hook_notice(${probe.kind}, ${probeValue(probe)}) AS rows`.execute(ctx.trx);
    add('ludy_finance.marketplace_hook_notice.body', Number(marketplaceNotices[0]?.rows ?? 0));

    // Transient raw GitHub webhook notice waiting for worker claim (#5158): deleted when its text mentions the value.
    const { rows: githubNotices } = await sql<{ rows: number }>`
      SELECT ludy_projects.personal_data_erase_github_notice(${probe.kind}, ${probeValue(probe)}) AS rows`.execute(ctx.trx);
    add('ludy_projects.github_webhook_notice.body', Number(githubNotices[0]?.rows ?? 0));

    // Sender-side KYC attachment checks (#4443, PDPL Law 91/2025/QH15; summary counts #4510): delete any
    // kyc_check row in the org whose findings_json quotes the value (including 8/9-digit legacy CMND numbers
    // and rows on attendees-only meeting_minutes envelopes via the owner-only definer), detach matching unsealed
    // attachment links, and report both KYC row and attachment counts; sealed agreement files stay untouched.
    const { rows: kycRows } = await sql<{
      summary: { rows?: number; attachments?: number; unsealedAttachments?: number };
    }>`
      SELECT ludy_sign.personal_data_erase_kyc_check_summary(${probe.kind}, ${probeValue(probe)}) AS summary`.execute(ctx.trx);
    const kycSummary = kycRows[0]?.summary;
    add('ludy_sign.kyc_check.findings_json', Number(kycSummary?.rows ?? 0));
    add('ludy_sign.kyc_check.file_id', Number(kycSummary?.attachments ?? 0));
    add('ludy_sign.field.attachment_file_id', Number(kycSummary?.unsealedAttachments ?? 0));

    // Notes (#1678, ADR-0037 section 5). A shared note stays and has every mention of the value edited out, the one
    // case where someone other than its author edits a note: ERASED_TEXT_MARK in its title and body where the value
    // was, cut to the column's limit should the mark be longer than the value, and a tag that mentions it goes (all of
    // them, when the value only shows across tags). Its search words
    // follow by trigger. A private note or to-do is its author's alone: ludy_notes.private_erase deletes it whole,
    // unread, once an earlier notice told the author (kernel.personal_data.notify); one never named stays, reported
    // below as kept.
    const mentions = (column: string) => freeTextMatch(probe, sql.ref(column));
    const tagsOf = (alias: string) => sql`pg_catalog.array_to_string(${sql.ref(`${alias}.tags`)}, ' ')`;
    const keptTags = sql`ARRAY(SELECT g.v FROM pg_catalog.unnest(t.tags) WITH ORDINALITY AS g(v, i) WHERE NOT ${freeTextMatch(probe, sql.ref('g.v'))} ORDER BY g.i)`;
    const stillAcross = freeTextMatch(probe, sql`pg_catalog.array_to_string(${keptTags}, ' ')`);
    // Acquire the single bounded org erasure barrier before any ludy_notes lock/update and update shared notebooks
    // before shared/private notes so concurrent notebook-referencing writes (noteUpdate/noteSetVisibility/notebookUpdate)
    // stay strictly deadlock-free in canonical notes.erase -> notebook[id ASC] -> note[id ASC] order.
    const notesEraseLockKey = `notes.erase:${ctx.orgId.toLowerCase()}`;
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${notesEraseLockKey}, 0))`.execute(ctx.trx);
    await sql`
      SELECT b.id FROM ludy_notes.notebook b
       WHERE b.org_id = ${ctx.orgId}::uuid AND b.visibility = 'org'
         AND (${mentions('b.name')} OR (b.stack_name IS NOT NULL AND ${mentions('b.stack_name')}))
       ORDER BY b.id
       FOR NO KEY UPDATE OF b`.execute(ctx.trx);
    const { rows: notebooks } = await sql<{ name: boolean; stack_name: boolean }>`
      UPDATE ludy_notes.notebook t
         SET name = COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('t.name'), ERASED_TEXT_MARK)}, ${NOTEBOOK_NAME_MAX}::int)), ''), ${ERASED_TEXT_MARK}),
             stack_name = CASE
               WHEN t.stack_name IS NOT NULL AND ${mentions('t.stack_name')}
                 THEN COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('t.stack_name'), ERASED_TEXT_MARK)}, ${NOTEBOOK_STACK_MAX}::int)), ''), ${ERASED_TEXT_MARK})
               ELSE t.stack_name
             END,
             revision = t.revision + 1, updated_at = GREATEST(t.updated_at, pg_catalog.clock_timestamp(), ${ctx.now})
        FROM ludy_notes.notebook o
       WHERE o.org_id = t.org_id AND o.id = t.id AND t.org_id = ${ctx.orgId}::uuid AND t.visibility = 'org'
         AND (${mentions('t.name')} OR (t.stack_name IS NOT NULL AND ${mentions('t.stack_name')}))
       RETURNING ${mentions('o.name')} AS name, (o.stack_name IS NOT NULL AND ${mentions('o.stack_name')}) AS stack_name`.execute(ctx.trx);
    add('ludy_notes.notebook.name', notebooks.filter((b) => b.name).length);
    add('ludy_notes.notebook.stack_name', notebooks.filter((b) => b.stack_name).length);
    // Lock every shared note whose text, snapshot, or attachment names the value first, in id order (#3562, #5035).
    // Keep this two-step explicit query separate from the later DELETE FROM ludy_notes.attachment (#5127):
    // 1) Locking every matched note upfront in ORDER BY n.id BEFORE updating note/note_template or deleting
    //    note_version/attachment guarantees canonical notes.erase -> notebook[id ASC] -> note[id ASC] -> attachment
    //    lock acquisition order (matching noteAttachmentDelete and avoiding AB-BA deadlocks when only a snapshot or
    //    attachment matches).
    // 2) Folding this into an un-materialized CTE inside DELETE FROM attachment would let PostgreSQL pipeline/reorder
    //    joins and lock attachment rows before every parent note is locked, and would skip notes matched only via
    //    note_version/attachment prior to the note/note_version steps above.
    const { rows: lockedSharedNotes } = await sql<{ id: string }>`
      SELECT n.id FROM ludy_notes.note n
       WHERE n.org_id = ${ctx.orgId}::uuid AND n.visibility = 'org'
         AND (${mentions('n.title')} OR ${mentions('n.body')} OR ${freeTextMatch(probe, tagsOf('n'))}
              OR EXISTS (
                SELECT 1 FROM ludy_notes.note_version v
                 WHERE v.org_id = n.org_id AND v.note_id = n.id
                   AND (${mentions('v.title')} OR ${mentions('v.body')} OR ${freeTextMatch(probe, tagsOf('v'))}))
              OR EXISTS (
                SELECT 1 FROM ludy_notes.attachment a
                 WHERE a.org_id = n.org_id AND a.note_id = n.id
                   AND (${mentions('a.filename')} OR ${mentions('a.extracted_text')})))
       ORDER BY n.id
       -- personalDataErase only redacts non-key text columns on shared notes; FOR NO KEY UPDATE blocks concurrent edits without conflicting with FK FOR KEY SHARE inserts (e.g. todoCreate/todoAcceptSuggestions).
       FOR NO KEY UPDATE OF n`.execute(ctx.trx);
    const lockedSharedNoteIds = lockedSharedNotes.map((n) => n.id);
    const { rows: notes } = await sql<{ title: boolean; body: boolean; tags: boolean }>`
      UPDATE ludy_notes.note t
         SET title = pg_catalog.left(${freeTextRedact(probe, sql.ref('t.title'), ERASED_TEXT_MARK)}, ${NOTE_TITLE_MAX}::int),
             body = pg_catalog.left(${freeTextRedact(probe, sql.ref('t.body'), ERASED_TEXT_MARK)}, ${NOTE_BODY_MAX}::int),
             tags = CASE WHEN ${stillAcross} THEN '{}'::text[] ELSE ${keptTags} END,
             revision = t.revision + 1, updated_at = GREATEST(t.updated_at, pg_catalog.clock_timestamp(), ${ctx.now})
        FROM ludy_notes.note o
       WHERE o.org_id = t.org_id AND o.id = t.id AND t.org_id = ${ctx.orgId}::uuid AND t.visibility = 'org'
         AND (${mentions('t.title')} OR ${mentions('t.body')} OR ${freeTextMatch(probe, tagsOf('t'))})
       RETURNING ${mentions('o.title')} AS title, ${mentions('o.body')} AS body, ${freeTextMatch(probe, tagsOf('o'))} AS tags`.execute(ctx.trx);
    add('ludy_notes.note.title', notes.filter((n) => n.title).length);
    add('ludy_notes.note.body', notes.filter((n) => n.body).length);
    add('ludy_notes.note.tags', notes.filter((n) => n.tags).length);
    // Shared note templates (#3562): redact mentions in place so the org's template stays usable, matching shared notes.
    const { rows: noteTemplates } = await sql<{ name: boolean; title: boolean; body: boolean; tags: boolean }>`
      UPDATE ludy_notes.note_template t
         SET name = COALESCE(
               NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('t.name'), ERASED_TEXT_MARK)}, ${NOTE_TEMPLATE_NAME_MAX}::int)), ''),
               ${ERASED_TEXT_MARK}
             ),
             title = pg_catalog.left(${freeTextRedact(probe, sql.ref('t.title'), ERASED_TEXT_MARK)}, ${NOTE_TITLE_MAX}::int),
             body = pg_catalog.left(${freeTextRedact(probe, sql.ref('t.body'), ERASED_TEXT_MARK)}, ${NOTE_BODY_MAX}::int),
             tags = CASE WHEN ${stillAcross} THEN '{}'::text[] ELSE ${keptTags} END,
             revision = t.revision + 1, updated_at = GREATEST(t.updated_at, pg_catalog.clock_timestamp(), ${ctx.now})
        FROM ludy_notes.note_template o
       WHERE o.org_id = t.org_id AND o.id = t.id AND t.org_id = ${ctx.orgId}::uuid AND t.visibility = 'org'
         AND (${mentions('t.name')} OR ${mentions('t.title')} OR ${mentions('t.body')} OR ${freeTextMatch(probe, tagsOf('t'))})
       RETURNING ${mentions('o.name')} AS name, ${mentions('o.title')} AS title, ${mentions('o.body')} AS body, ${freeTextMatch(probe, tagsOf('o'))} AS tags`.execute(ctx.trx);
    add('ludy_notes.note_template.name', noteTemplates.filter((n) => n.name).length);
    add('ludy_notes.note_template.title', noteTemplates.filter((n) => n.title).length);
    add('ludy_notes.note_template.body', noteTemplates.filter((n) => n.body).length);
    add('ludy_notes.note_template.tags', noteTemplates.filter((n) => n.tags).length);
    // Version snapshots of shared notes (#3562): immutable rows, so matching snapshots are deleted rather than edited in place.
    const { rows: noteVersions } = await sql<{ title: boolean; body: boolean; tags: boolean }>`
      DELETE FROM ludy_notes.note_version t
       WHERE t.org_id = ${ctx.orgId}::uuid
         AND EXISTS (SELECT 1 FROM ludy_notes.note n WHERE n.org_id = t.org_id AND n.id = t.note_id AND n.visibility = 'org')
         AND (${mentions('t.title')} OR ${mentions('t.body')} OR ${freeTextMatch(probe, tagsOf('t'))})
       RETURNING ${mentions('t.title')} AS title, ${mentions('t.body')} AS body, ${freeTextMatch(probe, tagsOf('t'))} AS tags`.execute(ctx.trx);
    add('ludy_notes.note_version.title', noteVersions.filter((n) => n.title).length);
    add('ludy_notes.note_version.body', noteVersions.filter((n) => n.body).length);
    add('ludy_notes.note_version.tags', noteVersions.filter((n) => n.tags).length);
    const { rows: sharedNoteAttachments } =
      lockedSharedNoteIds.length === 0
        ? { rows: [] }
        : await sql<{ note_id: string; filename: boolean; extracted_text: boolean }>`
            DELETE FROM ludy_notes.attachment a
             WHERE a.org_id = ${ctx.orgId}::uuid
               AND a.note_id = ANY(${lockedSharedNoteIds}::uuid[])
               AND (${mentions('a.filename')} OR ${mentions('a.extracted_text')})
             RETURNING a.note_id, ${mentions('a.filename')} AS filename, ${mentions('a.extracted_text')} AS extracted_text`.execute(ctx.trx);
    add('ludy_notes.attachment.filename', sharedNoteAttachments.filter((a) => a.filename).length);
    add('ludy_notes.attachment.extracted_text', sharedNoteAttachments.filter((a) => a.extracted_text).length);
    const touchedSharedNoteIds = [...new Set(sharedNoteAttachments.map((a) => a.note_id))];
    if (touchedSharedNoteIds.length > 0) {
      await ctx.trx
        .updateTable('ludy_notes.note')
        .set({ updated_at: sql<Date>`GREATEST(updated_at, pg_catalog.clock_timestamp(), ${ctx.now})` })
        .where('org_id', '=', ctx.orgId)
        .where('id', 'in', touchedSharedNoteIds)
        .execute();
    }
    const { rows: incompleteSharedAttRows } = await sql<{ pending: string; failed: string }>`
      SELECT pg_catalog.count(*) FILTER (WHERE a.extract_status = 'pending')::text AS pending,
             pg_catalog.count(*) FILTER (WHERE a.extract_status = 'failed')::text AS failed
        FROM ludy_notes.attachment a
        JOIN ludy_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
       WHERE a.org_id = ${ctx.orgId}::uuid
         AND n.visibility = 'org'
         AND a.extract_status IN ('pending', 'failed')`.execute(ctx.trx);
    const pendingSharedAttachments = Number(incompleteSharedAttRows[0]?.pending ?? 0);
    const failedSharedAttachments = Number(incompleteSharedAttRows[0]?.failed ?? 0);
    const { rows: privateRows } = await sql<{ notes: string; todos: string; untold_notes: string; untold_todos: string; note_ids: string[]; todo_ids: string[] }>`
      SELECT notes, todos, untold_notes, untold_todos, note_ids, todo_ids FROM ludy_notes.private_erase(${probe.kind}, ${probeValue(probe)})`.execute(ctx.trx);
    // Count still-pending and extraction-failed private attachments after private_erase so erased rows are not falsely reported in kept[].
    const { rows: pendingPrivateAttRows } = await sql<{ pending: string }>`
      SELECT ludy_notes.private_pending_attachment_count()::text AS pending`.execute(ctx.trx);
    const pendingPrivateAttachments = Number(pendingPrivateAttRows[0]?.pending ?? 0);
    const { rows: failedPrivateAttRows } = await sql<{ failed: string }>`
      SELECT ludy_notes.private_failed_attachment_count()::text AS failed`.execute(ctx.trx);
    const failedPrivateAttachments = Number(failedPrivateAttRows[0]?.failed ?? 0);
    const sum = (key: 'notes' | 'todos' | 'untold_notes' | 'untold_todos') => privateRows.reduce((n, r) => n + Number(r[key]), 0);
    const privateDeleted = { notes: sum('notes'), todos: sum('todos') };
    const untold = { notes: sum('untold_notes'), todos: sum('untold_todos') };
    add('ludy_notes.note', privateDeleted.notes);
    add('ludy_notes.todo', privateDeleted.todos);
    // Meeting text (#2594, ADR-0047 points 2 and 7, ADR-0037 section 5): every whole mention of the value is redacted in place. In a row the owner reads (their own meeting, a
    // published row of a meeting they are a reader of) at once: the owner's own erasure is the authority, as for a shared note. In a row the owner cannot read, only when an earlier
    // notice named its meeting at the text it has now and its recorder was told at least 24 hours ago (ludy_meetings.personal_erase): the rest stays, counted. Nothing but the text
    // changes: the taint of a draft, the audio, the video, the files and the Vy results stay as they are. A scan the statement timeout stopped redacts nothing and is said so.
    // A number of fewer than 10 digits may as well be a date or a figure in the text (#3064), and a redaction cannot be undone: the definer is not called, nothing of the meeting text (nor its
    // follow-up mails, nor the retention dates it would have reported) changes, and the rows are counted below, as the activity lines and tasks are (ACTIVITY_REDACT_MIN_DIGITS).
    const shortNumber = probe.kind === 'digits' && probe.digits.length < ACTIVITY_REDACT_MIN_DIGITS;
    const briefLinesErased = shortNumber
      ? 0
      : await meetingScan(ctx.trx, async () =>
          Number(
            (
              await sql<{ erased: string }>`
                SELECT ludy_meetings.morning_brief_lines_erase(${probe.kind}, ${probeValue(probe)})::text AS erased`.execute(ctx.trx)
            ).rows[0]?.erased ?? 0,
          ),
        );
    add('ludy_meetings.morning_brief_lines.lines', briefLinesErased ?? 0);
    const redaction = shortNumber
      ? []
      : await meetingScan(ctx.trx, async () =>
          (
            await sql<{ meeting_id: string; lines: string; results: string; items: string; titles: string; kept: string; audio_until: string | null; video_until: string | null }>`
              SELECT meeting_id, lines, results, items, titles, kept, audio_until::text AS audio_until, video_until::text AS video_until
                FROM ludy_meetings.personal_erase(${probe.kind}, ${probeValue(probe)})`.execute(ctx.trx)
          ).rows,
        );
    // The recorders' rough notes (A5, #3163): the value is redacted in the notes of every recorder of the org (the org is the data controller and the owner's erasure is its authority, as it is for
    // the machine translations), and the changed notes are counted per recorder. A short number is left (as above) and counted below.
    const noteErase = shortNumber
      ? []
      : await meetingScan(ctx.trx, async () =>
          (await sql<{ recorder_user_id: string; erased: string }>`SELECT recorder_user_id, erased FROM ludy_meetings.personal_note_erase(${probe.kind}, ${probeValue(probe)})`.execute(ctx.trx)).rows.map((r) => ({
            recorderUserId: r.recorder_user_id,
            notes: Number(r.erased),
          })),
        );
    add('ludy_meetings.meeting_note.body', (noteErase ?? []).reduce((n, r) => n + r.notes, 0));
    // The rows the owner cannot read, counted for the answer (the finder below lists the ones they read): read only, by the same matcher, under the same timeout.
    const shortMeetingCounts = shortNumber
      ? await meetingScan(ctx.trx, async () =>
          (
            await sql<{ lines: string; results: string; items: string; titles: string }>`
              SELECT lines, results, items, titles FROM ludy_meetings.personal_matches(${probe.kind}, ${probeValue(probe)})`.execute(ctx.trx)
          ).rows,
        )
      : [];
    const meetingsKept = { rows: 0, meetings: 0 };
    const mediaOf: { id: string; audio: string | null; video: string | null }[] = [];
    for (const r of redaction ?? []) {
      add('ludy_meetings.transcript_segment.text', Number(r.lines));
      add('ludy_meetings.meeting_result.summary', Number(r.results));
      add('ludy_meetings.action_item.title', Number(r.items));
      add('ludy_meetings.meeting.title', Number(r.titles));
      if (Number(r.kept) > 0) {
        meetingsKept.rows += Number(r.kept);
        meetingsKept.meetings += 1;
      }
      if (r.audio_until || r.video_until) mediaOf.push({ id: r.meeting_id, audio: r.audio_until, video: r.video_until });
    }
    // The copy of a meeting's text in its follow-up mails (#3020, ADR-0047 point 7): meetings.followup.send stores the shared summary, decisions and owners as the mail's payload, and the
    // recorder may type meeting content into its subject. When the redaction changed rows of a meeting, those two columns of that meeting's follow-up mails are dropped in the same
    // transaction (the mail guard lets them only be dropped; the tenant role holds UPDATE on exactly them). A meeting where nothing changed keeps its mails. The lock is the one of
    // modules/meetings/src/followup-erase.ts, so a send running at the same moment either finishes first (its mail is dropped too) or is refused its retry. The definer above already holds the
    // meeting rows, while the meeting delete commands take this lock first and the row after: waiting for the lock here could deadlock with them, so it is only tried, and a busy meeting
    // answers the same retryable PERSONAL_DATA_BUSY as a deadlock in the scan (the whole erasure rolls back, nothing is half done). Only the count reaches the audit row.
    let followupMails = 0;
    let followupDelivered = 0;
    // The tracked-word alert mails of a meeting whose rows changed (#5012): their payload holds a count of words found in the meeting and its link, so it goes with the meeting's text like the follow-up
    // mail's. They hold no value an erasure looks for, so only this per-meeting pass applies (not the by-text pass below). Counted apart: the follow-up numbers and the delivered-mail note stay as they were.
    let trackerAlertMails = 0;
    let projectWeeklyMails = 0;
    let projectWeeklyDelivered = 0;
    for (const r of redaction ?? []) {
      if (Number(r.lines) + Number(r.results) + Number(r.items) + Number(r.titles) === 0) continue;
      const { rows: lock } = await sql<{ ok: boolean }>`SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(${`meetings.followup:${ctx.orgId}:${r.meeting_id}`}, 0)) AS ok`.execute(ctx.trx);
      if (lock[0]?.ok !== true) throw new DomainError('PERSONAL_DATA_BUSY', 409, 'Một cuộc họp đang được sửa hoặc đang gửi thư cùng lúc; hãy thử lại sau ít phút');
      const dropped = await ctx.trx
        .updateTable('ludy_kernel.mail_message')
        .set({ payload: null, subject: null })
        .where('org_id', '=', ctx.orgId)
        .where('source', '=', FOLLOWUP_MAIL_SOURCE)
        .where('source_id', '=', r.meeting_id)
        .where((eb) => eb.or([eb('payload', 'is not', null), eb('subject', 'is not', null)]))
        .returning('status')
        .execute();
      followupMails += dropped.length;
      followupDelivered += dropped.filter((m) => DELIVERED_MAIL_STATUSES.includes(m.status)).length;
      const alerts = await ctx.trx
        .updateTable('ludy_kernel.mail_message')
        .set({ payload: null, subject: null })
        .where('org_id', '=', ctx.orgId)
        .where('source', '=', TRACKER_ALERT_MAIL_SOURCE)
        .where('source_id', '=', r.meeting_id)
        .where((eb) => eb.or([eb('payload', 'is not', null), eb('subject', 'is not', null)]))
        .executeTakeFirst();
      trackerAlertMails += Number(alerts.numUpdatedRows);
    }
    // The follow-up mails whose OWN text mentions the value (#3025), whether or not the meeting's rows changed: the recorder may have edited the value out of the summary after the send
    // (the meeting then has no hit), or typed it only into the subject. The same matcher (text_mentions) reads the subject and the payload; the rows of the first pass are already dropped
    // in this transaction, so none is counted twice. Only mails of a meeting the owner reads (row security shows its row) are dropped, as the meeting rows follow the notice rule: a mail of a
    // meeting the owner cannot read, or of one that no longer exists, stays and is counted. A meeting's mails are dropped under the same try-lock as above (busy: the same retryable refusal).
    const scanned = await meetingScan(
      ctx.trx,
      async () =>
        (
          await sql<{ source_id: string; readable: boolean; text_kept: boolean }>`
            SELECT m.source_id,
                   EXISTS (SELECT 1 FROM ludy_meetings.meeting g WHERE g.org_id = m.org_id AND g.id = m.source_id) AS readable,
                   m.payload IS NOT NULL AS text_kept
              FROM ludy_kernel.mail_message m
             WHERE m.org_id = ${ctx.orgId}::uuid AND m.source = ${FOLLOWUP_MAIL_SOURCE} AND (m.payload IS NOT NULL OR m.subject IS NOT NULL)
               AND (${freeTextMatch(probe, sql.ref('m.subject'))} OR ${freeTextMatch(probe, sql.ref('m.payload'))})`.execute(ctx.trx)
        ).rows,
    );
    // A scan the statement timeout stopped drops nothing and is said so (the per-meeting pass above is not affected). A number of fewer than 10 digits may as well be a date or a figure in
    // the text, and a dropped mail cannot be undone: the mails are counted and left, as the activity redaction leaves its lines.
    const followupSkipped = scanned === null;
    const shortFollowupNumber = probe.kind === 'digits' && probe.digits.length < ACTIVITY_REDACT_MIN_DIGITS;
    const followupShort = shortFollowupNumber ? (scanned ?? []).length : 0;
    const leftovers = shortFollowupNumber ? [] : (scanned ?? []);
    // A mail whose payload is already gone (its meeting was deleted or its text purged) fails to render when it is still queued, so dropping what is left of its subject destroys no pending
    // send: it is dropped whatever its meeting's readability. Every other mail of a meeting the owner cannot read, or that no longer exists, stays and is counted.
    const followupHidden = leftovers.filter((m) => !m.readable && m.text_kept).length;
    const leftoverMeetings = new Map<string, boolean>();
    for (const m of leftovers) if (m.readable || !m.text_kept) leftoverMeetings.set(m.source_id, (leftoverMeetings.get(m.source_id) ?? false) || m.readable);
    for (const [meetingId, readable] of leftoverMeetings) {
      const { rows: lock } = await sql<{ ok: boolean }>`SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(${`meetings.followup:${ctx.orgId}:${meetingId}`}, 0)) AS ok`.execute(ctx.trx);
      if (lock[0]?.ok !== true) throw new DomainError('PERSONAL_DATA_BUSY', 409, 'Một cuộc họp đang được sửa hoặc đang gửi thư cùng lúc; hãy thử lại sau ít phút');
      // Selected again by the meeting once the lock is held, so a send that committed after the scan above is dropped too.
      const dropped = await sql<{ status: string }>`
        UPDATE ludy_kernel.mail_message m SET payload = NULL, subject = NULL
         WHERE m.org_id = ${ctx.orgId}::uuid AND m.source = ${FOLLOWUP_MAIL_SOURCE} AND m.source_id = ${meetingId}::uuid
           AND (m.payload IS NOT NULL OR m.subject IS NOT NULL)
           AND (${freeTextMatch(probe, sql.ref('m.subject'))} OR ${freeTextMatch(probe, sql.ref('m.payload'))})
           AND (${readable} OR m.payload IS NULL)
        RETURNING m.status`.execute(ctx.trx);
      followupMails += dropped.rows.length;
      followupDelivered += dropped.rows.filter((m) => DELIVERED_MAIL_STATUSES.includes(m.status)).length;
    }
    // The retention dates of the meetings the owner reads (row security shows only those); the others are counted, their dates never shown.
    const readable = new Set(
      mediaOf.length === 0
        ? []
        : (await sql<{ id: string }>`SELECT id FROM ludy_meetings.meeting WHERE id = ANY(${mediaOf.map((m) => m.id)}::uuid[])`.execute(ctx.trx)).rows.map((r) => r.id),
    );
    const media = { audio: [] as string[], video: [] as string[], audioHidden: 0, videoHidden: 0 };
    for (const m of mediaOf) {
      if (m.audio) { if (readable.has(m.id)) media.audio.push(m.audio); else media.audioHidden++; }
      if (m.video) { if (readable.has(m.id)) media.video.push(m.video); else media.videoHidden++; }
    }
    // Activity lines that quote the person (#1948): the mention is replaced inside the line, through the owner-only
    // definer (tenant roles may not update activity rows). Comments and the books' descriptions are append-only and
    // stay; the finder's answer below lists them with their reasons.
    // A number of 8 or 9 digits may as well be an amount or a voucher number in a line, and a redaction cannot be
    // undone: those lines are left as they are and listed with ACTIVITY_SHORT_NUMBER_REASON (the definer refuses them
    // too).
    if (!shortNumber) {
      const { rows: redacted } = await sql<{ rows: number }>`
        SELECT ludy_kernel.personal_data_redact_activity(${probe.kind}, ${probeValue(probe)}) AS rows`.execute(ctx.trx);
      add('ludy_kernel.activity.summary', Number(redacted[0]?.rows ?? 0));

      // MISA AMIS's refusal text on a pushed voucher (#4015): cleared on the refused rows that quote the value, through the owner-only definer (the table's guard lets a tenant role move a row only along its graph);
      // the row and its state stay.
      const { rows: misaReasons } = await sql<{ rows: number }>`
        SELECT ludy_finance.personal_data_clear_misa_amis_push_reason(${probe.kind}, ${probeValue(probe)}) AS rows`.execute(ctx.trx);
      add('ludy_finance.misa_amis_push.reason', Number(misaReasons[0]?.rows ?? 0));

      // The preview of a column check (#4036): a check whose preview of parsed lines quotes the value is deleted whole (a preview is personal data kept for seven days at most); the file is not touched, and a member
      // asks for the check again. Through the command's own transaction: the tenant role deletes a check of its own org by the table's policy.
      const previewMatch = freeTextMatch(probe, sql.ref('c.preview'));
      const { rows: previewRows } = await sql<{ id: string }>`
        DELETE FROM ludy_finance.marketplace_column_check c
         WHERE c.org_id = ${ctx.orgId}::uuid AND c.preview IS NOT NULL AND coalesce(${previewMatch}, false)
         RETURNING c.id`.execute(ctx.trx);
      add('ludy_finance.marketplace_column_check.preview', previewRows.length);

      // Project triage items BEFORE tasks (#4493) and roadmap items/boards BEFORE projects (#4689): preserves canonical lock order
      // ludy_projects.project_triage_item -> ludy_kernel.task -> ludy_projects.roadmap_item -> ludy_projects.roadmap_board -> ludy_projects.project
      // matching projectTriageAccept, roadmapItemConvertToTask, roadmapBoardUpdate, roadmap_board_guard_tr, and roadmap_item_privacy_guard_tr
      // (zero deadlock) and closing both READ COMMITTED races:
      // if projectTriageAccept locks pti first, erase waits for commit and then redacts the new task;
      // if erase updates pti first, projectTriageAccept waits on FOR UPDATE and reads the already-redacted text.
      const triageTitle = freeTextMatch(probe, sql.ref('pti.title'));
      const triageDesc = freeTextMatch(probe, sql.ref('pti.description'));
      const triageDecline = freeTextMatch(probe, sql.ref('pti.decline_reason'));
      const { rows: triageRows } = await sql<{
        triage_id: string;
        next_title: string;
        next_description: string | null;
        next_decline_reason: string | null;
        title: boolean;
        description: boolean;
        decline_reason: boolean;
      }>`
        UPDATE ludy_projects.project_triage_item pti
           SET title = CASE
                         WHEN ${triageTitle} THEN COALESCE(
                           NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('pti.title'), REDACTED_MARK)}, 300)), ''),
                           ${REDACTED_MARK}
                         )
                         ELSE pti.title
                       END,
               description = CASE
                               WHEN ${triageDesc} THEN pg_catalog.left(${freeTextRedact(probe, sql.ref('pti.description'), REDACTED_MARK)}, 10000)
                               ELSE pti.description
                             END,
               decline_reason = CASE
                                  WHEN ${triageDecline} THEN pg_catalog.left(${freeTextRedact(probe, sql.ref('pti.decline_reason'), REDACTED_MARK)}, 1000)
                                  ELSE pti.decline_reason
                                END,
               updated_at = ${ctx.now}
          FROM ludy_projects.project_triage_item o
         WHERE o.org_id = pti.org_id AND o.id = pti.id AND pti.org_id = ${ctx.orgId}::uuid
           AND (${triageTitle} OR coalesce(${triageDesc}, false) OR coalesce(${triageDecline}, false))
         RETURNING pti.id AS triage_id,
                   pti.title AS next_title,
                   pti.description AS next_description,
                   pti.decline_reason AS next_decline_reason,
                   ${freeTextMatch(probe, sql.ref('o.title'))} AS title,
                   coalesce(${freeTextMatch(probe, sql.ref('o.description'))}, false) AS description,
                   coalesce(${freeTextMatch(probe, sql.ref('o.decline_reason'))}, false) AS decline_reason`.execute(ctx.trx);
      add('ludy_projects.project_triage_item.title', triageRows.filter((r) => r.title).length);
      add('ludy_projects.project_triage_item.description', triageRows.filter((r) => r.description).length);
      add('ludy_projects.project_triage_item.decline_reason', triageRows.filter((r) => r.decline_reason).length);
      if (triageRows.length > 0) {
        const ids = triageRows.map((r) => r.triage_id);
        const nextTitles = triageRows.map((r) => r.next_title);
        const nextDescriptions = triageRows.map((r) => r.next_description);
        const nextDeclines = triageRows.map((r) => r.next_decline_reason);
        await sql`
          UPDATE ludy_kernel.idempotency_key k
             SET response = pg_catalog.jsonb_set(
                   pg_catalog.jsonb_set(
                     pg_catalog.jsonb_set(
                       k.response,
                       '{value,item,title}',
                       pg_catalog.to_jsonb(u.next_title),
                       false
                     ),
                     '{value,item,description}',
                     coalesce(pg_catalog.to_jsonb(u.next_description), 'null'::jsonb),
                     false
                   ),
                   '{value,item,declineReason}',
                   coalesce(pg_catalog.to_jsonb(u.next_decline_reason), 'null'::jsonb),
                   false
                 )
            FROM ROWS FROM (
                   pg_catalog.unnest(${ids}::text[]),
                   pg_catalog.unnest(${nextTitles}::text[]),
                   pg_catalog.unnest(${nextDescriptions}::text[]),
                   pg_catalog.unnest(${nextDeclines}::text[])
                 ) AS u(triage_id, next_title, next_description, next_decline_reason)
           WHERE k.org_id = ${ctx.orgId}::uuid
             AND k.command IN (
               'projects.triage.create',
               'projects.triage.accept',
               'projects.triage.merge',
               'projects.triage.snooze',
               'projects.triage.decline',
               'projects.triage.reopen'
             )
             AND k.response IS NOT NULL
             AND k.response -> 'value' -> 'item' ->> 'id' = u.triage_id`.execute(ctx.trx);
      }

      // Tasks that quote the person (#1961): the value is replaced in the title and the description, as the owner (an
      // owner's update passes the task guards, which hold agents; taint, lease, status and entity stay as they are, and
      // updated_at moves to now). Through the command's own transaction: the tenant role may update tasks, so no definer
      // is needed. The lengths stay within the columns' limits, in case the mark is longer than a short address.
      const title = freeTextMatch(probe, sql.ref('t.title'));
      const description = freeTextMatch(probe, sql.ref('t.description'));
      const checklistStepText = sql`s.step ->> 'text'`;
      const checklistStepMatch = freeTextMatch(probe, checklistStepText);
      const checklist = sql`EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(t.checklist) AS s(step) WHERE ${checklistStepMatch})`;
      const oldChecklist = sql`EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(o.checklist) AS s(step) WHERE ${checklistStepMatch})`;
      const checklistStepRedact = sql`coalesce(
        nullif(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, checklistStepText, REDACTED_MARK)}, 300)), ''),
        ${REDACTED_MARK}
      )`;
      const { rows: tasks } = await sql<{ title: boolean; description: boolean; checklist: boolean }>`
        UPDATE ludy_kernel.task t
           SET title = CASE WHEN ${title} THEN pg_catalog.left(${freeTextRedact(probe, sql.ref('t.title'), REDACTED_MARK)}, 300) ELSE t.title END,
               description = CASE WHEN ${description} THEN pg_catalog.left(${freeTextRedact(probe, sql.ref('t.description'), REDACTED_MARK)}, 10000)
                                  ELSE t.description END,
               checklist = CASE WHEN ${checklist}
                                THEN coalesce((
                                  SELECT pg_catalog.jsonb_agg(
                                    pg_catalog.jsonb_build_object(
                                      'text',
                                      CASE WHEN ${checklistStepMatch} THEN ${checklistStepRedact} ELSE s.step ->> 'text' END,
                                      'done',
                                      (s.step -> 'done')
                                    )
                                    ORDER BY s.ord
                                  )
                                  FROM pg_catalog.jsonb_array_elements(t.checklist) WITH ORDINALITY AS s(step, ord)
                                ), '[]'::jsonb)
                                ELSE t.checklist END
          FROM ludy_kernel.task o
         WHERE o.org_id = t.org_id AND o.id = t.id AND t.org_id = ${ctx.orgId}::uuid
           AND (${title} OR coalesce(${description}, false) OR ${checklist})
         RETURNING ${freeTextMatch(probe, sql.ref('o.title'))} AS title,
                   coalesce(${freeTextMatch(probe, sql.ref('o.description'))}, false) AS description,
                   ${oldChecklist} AS checklist`.execute(ctx.trx);
      add('ludy_kernel.task.title', tasks.filter((t) => t.title).length);
      add('ludy_kernel.task.description', tasks.filter((t) => t.description).length);
      add('ludy_kernel.task.checklist', tasks.filter((t) => t.checklist).length);

      // Take the exclusive advisory lock paired with projects.weekly_status.send_mail's shared lock before dropping weekly mails and redacting projects:
      // a concurrent send_mail either committed before this lock or sees redacted project text after it; if one is mid-flight, fail fast with PERSONAL_DATA_BUSY.
      const { rows: mailLock } = await sql<{ ok: boolean }>`
        SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(${`projects.weekly_mail:${ctx.orgId}`}, 0)) AS ok`.execute(ctx.trx);
      if (mailLock[0]?.ok !== true) {
        throw new DomainError('PERSONAL_DATA_BUSY', 409, 'Một báo cáo tuần dự án đang được gửi cùng lúc; hãy thử lại sau ít phút');
      }
      // Project weekly status mails that quote the person directly or belong to a project whose name or description quoted them (#2609):
      // drop payload and subject before redacting ludy_projects.project so source_id matches still see unredacted project text.
      const { rows: droppedWeekly } = await sql<{ status: string }>`
        UPDATE ludy_kernel.mail_message m
           SET payload = NULL, subject = NULL
         WHERE m.org_id = ${ctx.orgId}::uuid
           AND m.source IN (${PROJECT_WEEKLY_STATUS_MAIL_SOURCE}, ${ROADMAP_SHIPPED_MAIL_SOURCE})
           AND (m.payload IS NOT NULL OR m.subject IS NOT NULL)
           AND (
             ${freeTextMatch(probe, sql.ref('m.subject'))}
             OR ${freeTextMatch(probe, sql.ref('m.payload'))}
             OR EXISTS (
               SELECT 1
                 FROM ludy_projects.project p
                WHERE p.org_id = m.org_id
                  AND p.id = m.source_id
                  AND (${freeTextMatch(probe, sql.ref('p.name'))} OR ${freeTextMatch(probe, sql.ref('p.description'))})
             )
             OR EXISTS (
               SELECT 1
                 FROM ludy_projects.roadmap_announcement a
                WHERE a.org_id = m.org_id
                  AND a.id = m.source_id
                  AND (${freeTextMatch(probe, sql.ref('a.title'))} OR ${freeTextMatch(probe, sql.ref('a.body_md'))})
             )
           )
         RETURNING m.status`.execute(ctx.trx);
      projectWeeklyMails = droppedWeekly.length;
      projectWeeklyDelivered = droppedWeekly.filter((m) => DELIVERED_MAIL_STATUSES.includes(m.status)).length;
      add('ludy_kernel.mail_message.payload', projectWeeklyMails);
      // Public roadmap items and boards (#4399, ADR-0057) BEFORE projects (#4689):
      // preserves canonical lock order (roadmap_item -> roadmap_board -> project) matching
      // roadmap_item_privacy_guard_tr, roadmap_board_guard_tr, and roadmapItemConvertToTask,
      // while staying after mail_message drop so mail predicates still see unredacted project text.
      const itemTitleMatch = freeTextMatch(probe, sql.ref('i.public_title'));
      const itemSummaryMatch = freeTextMatch(probe, sql.ref('i.public_summary'));
      const itemSubmitterMatch = freeTextMatch(probe, sql.ref('i.submitter_display_name'));
      const { rows: roadmapItems } = await sql<{ public_title: boolean; public_summary: boolean; submitter_display_name: boolean }>`
        UPDATE ludy_projects.roadmap_item i
           SET public_title = CASE
                                WHEN ${itemTitleMatch}
                                  THEN COALESCE(
                                    NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('i.public_title'), REDACTED_MARK)}, ${ROADMAP_ITEM_TITLE_MAX}::int)), ''),
                                    ${REDACTED_MARK}
                                  )
                                ELSE i.public_title
                              END,
               public_summary = CASE WHEN ${itemSummaryMatch} THEN pg_catalog.left(${freeTextRedact(probe, sql.ref('i.public_summary'), REDACTED_MARK)}, ${ROADMAP_ITEM_SUMMARY_MAX}::int)
                                     ELSE i.public_summary END,
               submitter_display_name = CASE WHEN ${itemSubmitterMatch} THEN NULL ELSE i.submitter_display_name END,
               updated_at = ${ctx.now}
          FROM ludy_projects.roadmap_item o
         WHERE o.org_id = i.org_id AND o.id = i.id AND i.org_id = ${ctx.orgId}::uuid
           AND (${itemTitleMatch} OR coalesce(${itemSummaryMatch}, false) OR coalesce(${itemSubmitterMatch}, false))
         RETURNING ${freeTextMatch(probe, sql.ref('o.public_title'))} AS public_title, coalesce(${freeTextMatch(probe, sql.ref('o.public_summary'))}, false) AS public_summary, coalesce(${freeTextMatch(probe, sql.ref('o.submitter_display_name'))}, false) AS submitter_display_name`.execute(ctx.trx);
      add('ludy_projects.roadmap_item.public_title', roadmapItems.filter((r) => r.public_title).length);
      add('ludy_projects.roadmap_item.public_summary', roadmapItems.filter((r) => r.public_summary).length);
      add('ludy_projects.roadmap_item.submitter_display_name', roadmapItems.filter((r) => r.submitter_display_name).length);

      const boardTitleMatch = freeTextMatch(probe, sql.ref('b.title'));
      const boardDescMatch = freeTextMatch(probe, sql.ref('b.description'));
      const { rows: roadmapBoards } = await sql<{ title: boolean; description: boolean }>`
        UPDATE ludy_projects.roadmap_board b
           SET title = CASE
                         WHEN ${boardTitleMatch}
                           THEN COALESCE(
                             NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('b.title'), REDACTED_MARK)}, ${ROADMAP_TITLE_MAX}::int)), ''),
                             ${REDACTED_MARK}
                           )
                         ELSE b.title
                       END,
               description = CASE WHEN ${boardDescMatch} THEN pg_catalog.left(${freeTextRedact(probe, sql.ref('b.description'), REDACTED_MARK)}, ${ROADMAP_DESCRIPTION_MAX}::int)
                                  ELSE b.description END,
               updated_at = ${ctx.now}
          FROM ludy_projects.roadmap_board o
         WHERE o.org_id = b.org_id AND o.id = b.id AND b.org_id = ${ctx.orgId}::uuid
           AND (${boardTitleMatch} OR coalesce(${boardDescMatch}, false))
         RETURNING ${freeTextMatch(probe, sql.ref('o.title'))} AS title, coalesce(${freeTextMatch(probe, sql.ref('o.description'))}, false) AS description`.execute(ctx.trx);
      add('ludy_projects.roadmap_board.title', roadmapBoards.filter((r) => r.title).length);
      add('ludy_projects.roadmap_board.description', roadmapBoards.filter((r) => r.description).length);

      // Projects and project templates that quote the person (#2591, #2607): replace mentions in name, description, and template_tasks, bounded to column limits.
      const projectName = freeTextMatch(probe, sql.ref('p.name'));
      const projectDescription = freeTextMatch(probe, sql.ref('p.description'));
      const projectTemplateTasks = templateTasksMatch(probe, sql.ref('p.template_tasks'));
      const { rows: projects } = await sql<{ name: boolean; description: boolean; template_tasks: boolean }>`
        UPDATE ludy_projects.project p
           SET name = CASE
                        WHEN ${projectName}
                          THEN COALESCE(
                            NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('p.name'), REDACTED_MARK)}, ${PROJECT_NAME_MAX}::int)), ''),
                            ${REDACTED_MARK}
                          )
                        ELSE p.name
                      END,
               description = CASE WHEN ${projectDescription} THEN pg_catalog.left(${freeTextRedact(probe, sql.ref('p.description'), REDACTED_MARK)}, ${PROJECT_DESCRIPTION_MAX}::int)
                                  ELSE p.description END,
               template_tasks = CASE WHEN ${projectTemplateTasks} THEN ${templateTasksRedact(probe, sql.ref('p.template_tasks'), REDACTED_MARK)}
                                     ELSE p.template_tasks END,
               updated_at = ${ctx.now}
          FROM ludy_projects.project o
         WHERE o.org_id = p.org_id AND o.id = p.id AND p.org_id = ${ctx.orgId}::uuid AND (${projectName} OR coalesce(${projectDescription}, false) OR ${projectTemplateTasks})
         RETURNING ${freeTextMatch(probe, sql.ref('o.name'))} AS name, coalesce(${freeTextMatch(probe, sql.ref('o.description'))}, false) AS description, ${templateTasksMatch(probe, sql.ref('o.template_tasks'))} AS template_tasks`.execute(ctx.trx);
      add('ludy_projects.project.name', projects.filter((p) => p.name).length);
      add('ludy_projects.project.description', projects.filter((p) => p.description).length);
      add('ludy_projects.project.template_tasks', projects.filter((p) => p.template_tasks).length);

      // Project custom board columns that quote the person (#2605): replace mentions in name, bounded to column limit.
      const projectColumnName = freeTextMatch(probe, sql.ref('pc.name'));
      const { rows: projectColumns } = await sql<{ name: boolean }>`
        UPDATE ludy_projects.project_column pc
           SET name = COALESCE(
                 NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('pc.name'), REDACTED_MARK)}, ${PROJECT_COLUMN_NAME_MAX}::int)), ''),
                 ${REDACTED_MARK}
               ),
               updated_at = ${ctx.now}
          FROM ludy_projects.project_column o
         WHERE o.org_id = pc.org_id AND o.id = pc.id AND pc.org_id = ${ctx.orgId}::uuid AND ${projectColumnName}
         RETURNING ${freeTextMatch(probe, sql.ref('o.name'))} AS name`.execute(ctx.trx);
      add('ludy_projects.project_column.name', projectColumns.filter((c) => c.name).length);

      // Project cycles whose name or goal quotes the person (#4361): replace mentions bounded to column limits.
      const cycleName = freeTextMatch(probe, sql.ref('c.name'));
      const cycleGoal = freeTextMatch(probe, sql.ref('c.goal'));
      const { rows: cycles } = await sql<{ name: boolean; goal: boolean }>`
        UPDATE ludy_projects.project_cycle c
           SET name = CASE
                        WHEN ${cycleName}
                          THEN COALESCE(
                            NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('c.name'), REDACTED_MARK)}, ${PROJECT_CYCLE_NAME_MAX}::int)), ''),
                            ${REDACTED_MARK}
                          )
                        ELSE c.name
                      END,
               goal = CASE WHEN ${cycleGoal} THEN pg_catalog.left(${freeTextRedact(probe, sql.ref('c.goal'), REDACTED_MARK)}, ${PROJECT_CYCLE_GOAL_MAX}::int)
                           ELSE c.goal END,
               updated_at = ${ctx.now}
          FROM ludy_projects.project_cycle o
         WHERE o.org_id = c.org_id AND o.id = c.id AND c.org_id = ${ctx.orgId}::uuid AND (${cycleName} OR coalesce(${cycleGoal}, false))
         RETURNING ${freeTextMatch(probe, sql.ref('o.name'))} AS name, coalesce(${freeTextMatch(probe, sql.ref('o.goal'))}, false) AS goal`.execute(ctx.trx);
      add('ludy_projects.project_cycle.name', cycles.filter((c) => c.name).length);
      add('ludy_projects.project_cycle.goal', cycles.filter((c) => c.goal).length);

      const signalAccountMatch = freeTextMatch(probe, sql.ref('s.account_label'));
      const signalQuoteMatch = freeTextMatch(probe, sql.ref('s.quote_excerpt'));
      const { rows: roadmapSignals } = await sql<{
        signal_id: string;
        source_type: string;
        next_account_label: string | null;
        next_quote_excerpt: string | null;
        account_label: boolean;
        quote_excerpt: boolean;
      }>`
        UPDATE ludy_projects.roadmap_signal s
           SET account_label = CASE
                                 WHEN s.account_label IS NOT NULL AND ${signalAccountMatch}
                                   THEN NULLIF(
                                     NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('s.account_label'), REDACTED_MARK)}, ${ROADMAP_SIGNAL_ACCOUNT_LABEL_MAX}::int)), ''),
                                     ${REDACTED_MARK}
                                   )
                                 ELSE s.account_label
                               END,
               quote_excerpt = CASE
                                 WHEN s.quote_excerpt IS NOT NULL AND ${signalQuoteMatch}
                                   THEN NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('s.quote_excerpt'), REDACTED_MARK)}, ${ROADMAP_SIGNAL_QUOTE_EXCERPT_MAX}::int)), '')
                                 ELSE s.quote_excerpt
                               END,
               updated_at = ${ctx.now}
          FROM ludy_projects.roadmap_signal o
         WHERE o.org_id = s.org_id AND o.id = s.id AND s.org_id = ${ctx.orgId}::uuid
           AND ((s.account_label IS NOT NULL AND ${signalAccountMatch}) OR coalesce(${signalQuoteMatch}, false))
         RETURNING s.id AS signal_id,
                   s.source_type AS source_type,
                   s.account_label AS next_account_label,
                   s.quote_excerpt AS next_quote_excerpt,
                   (o.account_label IS NOT NULL AND coalesce(${freeTextMatch(probe, sql.ref('o.account_label'))}, false)) AS account_label,
                   coalesce(${freeTextMatch(probe, sql.ref('o.quote_excerpt'))}, false) AS quote_excerpt`.execute(ctx.trx);
      add('ludy_projects.roadmap_signal.account_label', roadmapSignals.filter((r) => r.account_label).length);
      add('ludy_projects.roadmap_signal.quote_excerpt', roadmapSignals.filter((r) => r.quote_excerpt).length);
      if (roadmapSignals.length > 0) {
        const ids = roadmapSignals.map((r) => r.signal_id);
        const nextAccounts = roadmapSignals.map((r) => r.next_account_label);
        const nextQuotes = roadmapSignals.map((r) => (r.source_type === 'meetings.meeting' ? null : r.next_quote_excerpt));
        await sql`
          UPDATE ludy_kernel.idempotency_key k
             SET response = pg_catalog.jsonb_set(
                   pg_catalog.jsonb_set(
                     k.response,
                     '{value,signal,accountLabel}',
                     coalesce(pg_catalog.to_jsonb(u.next_account_label), 'null'::jsonb),
                     false
                   ),
                   '{value,signal,quoteExcerpt}',
                   CASE
                     WHEN k.response -> 'value' -> 'signal' ->> 'sourceType' = 'meetings.meeting'
                       THEN 'null'::jsonb
                     ELSE coalesce(pg_catalog.to_jsonb(u.next_quote_excerpt), 'null'::jsonb)
                   END,
                   false
                 )
            FROM ROWS FROM (
                   pg_catalog.unnest(${ids}::text[]),
                   pg_catalog.unnest(${nextAccounts}::text[]),
                   pg_catalog.unnest(${nextQuotes}::text[])
                 ) AS u(signal_id, next_account_label, next_quote_excerpt)
           WHERE k.org_id = ${ctx.orgId}::uuid
             AND k.command = 'projects.roadmap.signal.create'
             AND k.response IS NOT NULL
             AND k.response -> 'value' -> 'signal' ->> 'id' = u.signal_id`.execute(ctx.trx);
      }

      const annTitleMatch = freeTextMatch(probe, sql.ref('a.title'));
      const annBodyMatch = freeTextMatch(probe, sql.ref('a.body_md'));
      const { rows: roadmapAnnouncements } = await sql<{ title: boolean; body_md: boolean }>`
        UPDATE ludy_projects.roadmap_announcement a
           SET title = CASE
                         WHEN ${annTitleMatch}
                           THEN COALESCE(
                             NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('a.title'), REDACTED_MARK)}, ${ROADMAP_ANNOUNCEMENT_TITLE_MAX}::int)), ''),
                             ${REDACTED_MARK}
                           )
                         ELSE a.title
                       END,
               body_md = CASE
                           WHEN ${annBodyMatch}
                             THEN COALESCE(
                               NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('a.body_md'), REDACTED_MARK)}, ${ROADMAP_ANNOUNCEMENT_BODY_MAX}::int)), ''),
                               ${REDACTED_MARK}
                             )
                           ELSE a.body_md
                         END,
               updated_at = ${ctx.now}
          FROM ludy_projects.roadmap_announcement o
         WHERE o.org_id = a.org_id AND o.id = a.id AND a.org_id = ${ctx.orgId}::uuid
           AND (${annTitleMatch} OR ${annBodyMatch})
         RETURNING ${freeTextMatch(probe, sql.ref('o.title'))} AS title, ${freeTextMatch(probe, sql.ref('o.body_md'))} AS body_md`.execute(ctx.trx);
      add('ludy_projects.roadmap_announcement.title', roadmapAnnouncements.filter((r) => r.title).length);
      add('ludy_projects.roadmap_announcement.body_md', roadmapAnnouncements.filter((r) => r.body_md).length);

      // Project time entry notes that quote the person (#2600): replace mentions in note, bounded to 500 chars.
      const timeEntryNote = freeTextMatch(probe, sql.ref('te.note'));
      const { rows: timeEntries } = await sql<{ note: boolean }>`
        UPDATE ludy_projects.time_entry te
           SET note = COALESCE(
                 NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('te.note'), REDACTED_MARK)}, ${PROJECT_TIME_NOTE_MAX}::int)), ''),
                 ${REDACTED_MARK}
               ),
               updated_at = ${ctx.now}
          FROM ludy_projects.time_entry o
         WHERE o.org_id = te.org_id AND o.id = te.id AND te.org_id = ${ctx.orgId}::uuid AND ${timeEntryNote}
         RETURNING ${freeTextMatch(probe, sql.ref('o.note'))} AS note`.execute(ctx.trx);
      add('ludy_projects.time_entry.note', timeEntries.filter((e) => e.note).length);

      const githubLinkTitle = freeTextMatch(probe, sql.ref('gtl.external_title'));
      const githubLinkAuthor = freeTextMatch(probe, sql.ref('gtl.author_login'));
      const { rows: githubLinkRows } = await sql<{ external_title: boolean; author_login: boolean }>`
        UPDATE ludy_projects.github_task_link gtl
           SET external_title = CASE WHEN ${githubLinkTitle} THEN COALESCE(
                 NULLIF(pg_catalog.btrim(pg_catalog.left(${freeTextRedact(probe, sql.ref('gtl.external_title'), REDACTED_MARK)}, 300)), ''),
                 ${REDACTED_MARK}
               ) ELSE gtl.external_title END,
               author_login = CASE WHEN gtl.author_login IS NOT NULL AND ${githubLinkAuthor} THEN NULL ELSE gtl.author_login END,
               updated_at = ${ctx.now}
          FROM ludy_projects.github_task_link o
         WHERE o.org_id = gtl.org_id AND o.id = gtl.id AND gtl.org_id = ${ctx.orgId}::uuid
           AND (${githubLinkTitle} OR (gtl.author_login IS NOT NULL AND ${githubLinkAuthor}))
         RETURNING ${freeTextMatch(probe, sql.ref('o.external_title'))} AS external_title,
                   (o.author_login IS NOT NULL AND ${freeTextMatch(probe, sql.ref('o.author_login'))}) AS author_login`.execute(ctx.trx);
      add('ludy_projects.github_task_link.external_title', githubLinkRows.filter((r) => r.external_title).length);
      add('ludy_projects.github_task_link.author_login', githubLinkRows.filter((r) => r.author_login).length);

      // Recruiting candidate notes that quote the person (#3425): replace mentions, bounded to 2000 chars.
      const candidateNotes = freeTextMatch(probe, sql.ref('c.notes'));
      const { rows: candidateNoteRows } = await sql<{ notes: boolean }>`
        UPDATE ludy_hr.candidate c
           SET notes = CASE WHEN ${candidateNotes} THEN pg_catalog.left(${freeTextRedact(probe, sql.ref('c.notes'), REDACTED_MARK)}, 2000)
                            ELSE c.notes END,
               updated_at = ${ctx.now}
          FROM ludy_hr.candidate o
         WHERE o.org_id = c.org_id AND o.id = c.id AND c.org_id = ${ctx.orgId}::uuid AND coalesce(${candidateNotes}, false)
         RETURNING coalesce(${freeTextMatch(probe, sql.ref('o.notes'))}, false) AS notes`.execute(ctx.trx);
      add('ludy_hr.candidate.notes', candidateNoteRows.filter((r) => r.notes).length);
    }

    // What stays, with its reason: the finder's answer after the erasure (the cleared values no longer match);
    // skip recounting pending note attachments here since erase already queried both pending and failed attachment queues.
    const after = await findPersonalData(ctx.trx, ctx.orgId, probe, false, documentedPartyIds, {
      includePendingNoteAttachments: false,
    });
    // Count all unredacted quote_excerpt rows skipped by shortNumber in one org-scoped aggregate (both readable rows
    // beyond PERSONAL_DATA_ROW_LIMIT and unreadable, expired, or deleted meeting rows omitted by findPersonalData),
    // keeping kept[] accurate and count-only without leaking text or meeting IDs (#4600).
    const shortQuoteExcerptCount = shortNumber
      ? Number(
          (
            await sql<{ rows: string }>`
              SELECT pg_catalog.count(*)::text AS rows
                FROM ludy_projects.roadmap_signal s
               WHERE s.org_id = ${ctx.orgId}::uuid
                 AND s.quote_excerpt IS NOT NULL
                 AND ${freeTextMatch(probe, sql.ref('s.quote_excerpt'))}`.execute(ctx.trx)
          ).rows[0]?.rows ?? 0,
        )
      : 0;
    // Grouped by column and reason: rows of one column may be kept for different reasons (the default legal entity and
    // the others).
    const kept = new Map<string, { column: string; rows: number; reason: string }>();
    for (const m of after.matches) {
      if (shortNumber && m.column === 'ludy_projects.roadmap_signal.quote_excerpt') continue;
      const reason = !shortNumber
        ? m.reason
        : m.column === 'ludy_finance.misa_amis_push.reason'
          ? MISA_PUSH_REASON_SHORT_NUMBER_REASON
          : SHORT_NUMBER_COLUMNS.has(m.column)
            ? ACTIVITY_SHORT_NUMBER_REASON
            : SHORT_NUMBER_MEETING_COLUMNS.has(m.column)
              ? MEETING_TEXT_SHORT_NUMBER_REASON
              : m.column === 'ludy_kernel.mail_message.payload'
                ? PROJECT_WEEKLY_MAIL_SHORT_NUMBER_REASON
                : m.reason;
      const group = `${m.column}\n${reason}`;
      const k = kept.get(group) ?? { column: m.column, rows: 0, reason };
      k.rows += 1;
      kept.set(group, k);
    }
    if (shortQuoteExcerptCount > 0) {
      const column = 'ludy_projects.roadmap_signal.quote_excerpt';
      kept.set(`${column}\n${ACTIVITY_SHORT_NUMBER_REASON}`, {
        column,
        rows: shortQuoteExcerptCount,
        reason: ACTIVITY_SHORT_NUMBER_REASON,
      });
    }
    // The original files behind posted entries that name these parties (issue #1009, #2334): accounting evidence the
    // erasure never deletes, held in the bucket for the legal period, including attached original e-invoice XMLs.
    const partyIds = parties.map((p) => p.id);
    if (partyIds.length > 0) {
      const { rows: held } = await sql<{ files: string; until: Date | null }>`
        WITH party_docs AS (
          SELECT d.org_id, d.source_file_id, d.proposal_id
            FROM ludy_finance.purchase_document d
            JOIN ludy_finance.journal_entry e ON e.org_id = d.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = d.id
           WHERE d.org_id = ${ctx.orgId}::uuid AND d.party_id = ANY(${partyIds}::uuid[])
        ), doc_files AS (
          SELECT pd.org_id, pd.source_file_id AS file_id
            FROM party_docs pd
           WHERE pd.source_file_id IS NOT NULL
          UNION
          SELECT pd.org_id, x.file_id
            FROM party_docs pd
            JOIN ludy_kernel.extraction x ON x.org_id = pd.org_id AND x.original_of_proposal_id = pd.proposal_id
           WHERE pd.proposal_id IS NOT NULL
        )
        SELECT count(*) AS files,
               -- A date only when every file has a recorded hold, and then the earliest: never a date one file lacks.
               CASE WHEN bool_and(f.held_until IS NOT NULL) THEN min(f.held_until) END AS until
          FROM doc_files df
          JOIN ludy_kernel.file f ON f.org_id = df.org_id AND f.id = df.file_id`.execute(ctx.trx);
      const files = Number(held[0]?.files ?? 0);
      if (files > 0) kept.set('ludy_kernel.file', { column: 'ludy_kernel.file', rows: files, reason: heldFilesReason(held[0]?.until ?? null) });
    }
    // Meeting text the redaction could not reach (#2594): a meeting the owner cannot read that no notice covers at its text now, or the redaction itself stopped by the timeout.
    if (redaction === null || shortMeetingCounts === null) kept.set('ludy_meetings', { column: 'ludy_meetings', rows: 0, reason: MEETING_TEXT_SKIPPED_REASON });
    // A short number: the rows of meetings the owner cannot read are counted under the short-number reason (the ones they read are listed above by column, with the same reason).
    const shortNoteRows = shortNumber
      ? ((await meetingScan(ctx.trx, async () => (await sql<{ notes: string }>`SELECT notes FROM ludy_meetings.personal_note_counts(${probe.kind}, ${probeValue(probe)})`.execute(ctx.trx)).rows)) ?? []).reduce((n, c) => n + Number(c.notes), 0)
      : 0;
    const shortMeetingRows = (shortMeetingCounts ?? []).reduce((n, c) => n + Number(c.lines) + Number(c.results) + Number(c.items) + Number(c.titles), 0) + shortNoteRows;
    if (shortMeetingRows > 0) kept.set('ludy_meetings.text.short', { column: 'ludy_meetings.text', rows: shortMeetingRows, reason: MEETING_TEXT_SHORT_NUMBER_REASON });
    if (meetingsKept.rows > 0) kept.set('ludy_meetings.text', { column: 'ludy_meetings.text', rows: meetingsKept.rows, reason: UNTOLD_MEETING_REASON });
    if (noteErase === null) kept.set('ludy_meetings.meeting_note.skipped', { column: 'ludy_meetings.meeting_note', rows: 0, reason: MEETING_TEXT_SKIPPED_REASON });
    // Follow-up mail copies (#3025): the ones of a meeting the owner cannot read stay, counted; and the copies that already reached their recipients cannot be taken back.
    if (followupSkipped) kept.set('ludy_meetings.followup_mail.skipped', { column: 'ludy_meetings.followup_mail', rows: 0, reason: FOLLOWUP_MAIL_SKIPPED_REASON });
    if (followupShort > 0) kept.set('ludy_meetings.followup_mail.short', { column: 'ludy_meetings.followup_mail', rows: followupShort, reason: FOLLOWUP_MAIL_SHORT_NUMBER_REASON });
    if (followupHidden > 0) kept.set('ludy_meetings.followup_mail', { column: 'ludy_meetings.followup_mail', rows: followupHidden, reason: FOLLOWUP_MAIL_HIDDEN_REASON });
    if (followupDelivered > 0) kept.set('ludy_kernel.mail_message.payload', { column: 'ludy_kernel.mail_message.payload', rows: followupDelivered, reason: FOLLOWUP_MAIL_DELIVERED_REASON });
    if (projectWeeklyDelivered > 0) {
      kept.set('ludy_kernel.mail_message.payload.projects', {
        column: 'ludy_kernel.mail_message.payload',
        rows: projectWeeklyDelivered,
        reason: PROJECT_WEEKLY_MAIL_DELIVERED_REASON,
      });
    }
    // The voices of the meetings that held the value stay until their retention dates: a voice cannot be edited out. The owner deletes a meeting at once with meetings.meeting.owner_delete.
    if (mediaOf.some((m) => m.audio)) kept.set('ludy_meetings.audio', { column: 'ludy_meetings.audio', rows: media.audio.length + media.audioHidden, reason: meetingMediaReason('audio', media.audio, media.audioHidden) });
    if (mediaOf.some((m) => m.video)) kept.set('ludy_meetings.video', { column: 'ludy_meetings.video', rows: media.video.length + media.videoHidden, reason: meetingMediaReason('video', media.video, media.videoHidden) });
    // What each member's Vy keeps privately (ADR-0049): sealed to its member, so the erasure cannot read it; it expires on its own. Counted per org, never read.
    const vyResults = Number(
      (await sql<{ n: string }>`SELECT COALESCE(pg_catalog.sum(results), 0)::text AS n FROM ludy_kernel.member_vy_private_counts()`.execute(ctx.trx)).rows[0]?.n ?? 0,
    );
    const meetingCounts = (
      await sql<{ translations: string; live_lines: string }>`SELECT COALESCE(pg_catalog.sum(translations), 0)::text AS translations, COALESCE(pg_catalog.sum(live_lines), 0)::text AS live_lines FROM ludy_meetings.member_private_counts()`.execute(ctx.trx)
    ).rows[0];
    if (vyResults > 0) kept.set('ludy_kernel.member_vy_result.body', { column: 'ludy_kernel.member_vy_result.body', rows: vyResults, reason: MEMBER_VY_RESULT_REASON });
    // A member's translations of meetings and the preview lines of the meetings they recorded (#3584): private to that member, counted per org as the results are, never read.
    const vyTranslations = Number(meetingCounts?.translations ?? 0);
    if (vyTranslations > 0) kept.set('ludy_meetings.translation.body', { column: 'ludy_meetings.translation.body', rows: vyTranslations, reason: MEMBER_TRANSLATION_REASON });
    const vyLiveLines = Number(meetingCounts?.live_lines ?? 0);
    if (vyLiveLines > 0) kept.set('ludy_meetings.live_line.text', { column: 'ludy_meetings.live_line.text', rows: vyLiveLines, reason: MEMBER_LIVE_LINE_REASON });
    const vyBriefLines = Number(
      (await sql<{ n: string }>`SELECT COALESCE(pg_catalog.sum(brief_lines), 0)::text AS n FROM ludy_meetings.morning_brief_lines_counts()`.execute(ctx.trx)).rows[0]?.n ?? 0,
    );
    if (vyBriefLines > 0) kept.set('ludy_meetings.morning_brief_lines.lines', { column: 'ludy_meetings.morning_brief_lines.lines', rows: vyBriefLines, reason: MEMBER_BRIEF_LINES_REASON });
    // Private items no notice named: counted, never listed (the finder's privateItems after the erasure).
    if (untold.notes > 0) kept.set('ludy_notes.note', { column: 'ludy_notes.note', rows: untold.notes, reason: UNTOLD_PRIVATE_REASON });
    if (untold.todos > 0) kept.set('ludy_notes.todo', { column: 'ludy_notes.todo', rows: untold.todos, reason: UNTOLD_PRIVATE_REASON });
    // Meeting text the search could not read in time: said in the answer, never left out silently (#2594).
    if (after.meetingTextSkipped) kept.set('ludy_meetings', { column: 'ludy_meetings', rows: 0, reason: MEETING_TEXT_SKIPPED_REASON });
    if (pendingSharedAttachments > 0) {
      kept.set('ludy_notes.attachment.extracted_text', {
        column: 'ludy_notes.attachment.extracted_text',
        rows: pendingSharedAttachments,
        reason: PENDING_NOTE_ATTACHMENT_REASON,
      });
    }
    if (failedSharedAttachments > 0) {
      kept.set('ludy_notes.attachment.extracted_text.failed', {
        column: 'ludy_notes.attachment.extracted_text',
        rows: failedSharedAttachments,
        reason: FAILED_NOTE_ATTACHMENT_REASON,
      });
    }
    if (pendingPrivateAttachments > 0) {
      kept.set('ludy_notes.attachment', {
        column: 'ludy_notes.attachment',
        rows: pendingPrivateAttachments,
        reason: PENDING_PRIVATE_NOTE_ATTACHMENT_REASON,
      });
    }
    if (failedPrivateAttachments > 0) {
      kept.set('ludy_notes.attachment.failed', {
        column: 'ludy_notes.attachment',
        rows: failedPrivateAttachments,
        reason: FAILED_PRIVATE_NOTE_ATTACHMENT_REASON,
      });
    }
    const keptRows = new Map<string, number>();
    for (const k of kept.values()) {
      // Never write private attachment counts (ludy_notes.attachment) to audit_event, which admins can list/export (#5127).
      if (k.column === 'ludy_notes.attachment') continue;
      keptRows.set(k.column, (keptRows.get(k.column) ?? 0) + k.rows);
    }
    const result: PersonalDataErasure = {
      erased: [...erased].map(([column, rows]) => ({ column, rows })),
      ...((noteErase ?? []).length > 0 ? { meetingNotes: noteErase ?? [] } : {}),
      kept: [...kept.values()].map((k) => ({ column: k.column, rows: k.rows, reason: k.reason })),
    };
    // Counts and ids only: the value and the text never reach the audit log.
    ctx.audit({ kind: probe.kind, erased: Object.fromEntries(erased), kept: Object.fromEntries(keptRows), kept_parties: keptParties, follow_up_mails: followupMails, tracker_alert_mails: trackerAlertMails, project_weekly_mails: projectWeeklyMails, private_deleted: { notes: privateRows.flatMap((r) => r.note_ids), todos: privateRows.flatMap((r) => r.todo_ids) } });
    return result;
  },
});

export const personalDataCommands = [personalDataFind, personalDataNotify, personalDataErase];

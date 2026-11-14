// Kysely types for the Crove schemas: the types generated from the migrated database (./generated/database.ts,
// `pnpm db:types`, issue #48) with the refinements the catalog cannot express, such as CHECK-constraint unions and
// columns only a trigger or a definer writes. numeric, int8 and date columns are strings (see the pool type parsers);
// timestamptz is Date.
//
// The generated Database holds only the tables crove_tenant may read. crove_kernel.user_account (identity) and the
// other control-plane tables (plan §3.6, Decision 14) have no Kysely type on purpose: tenant code reaches them only
// through definers (crove_kernel.member_profiles, identity_resolve, my_orgs and the like), so a direct selectFrom does
// not compile. The invariant test control-plane-reads.test.ts catches raw SQL.
import type { ColumnType, Generated, InsertType, SelectType, UpdateType } from 'kysely';
import type * as G from './generated/database.ts';

// A refinement narrows what a column holds (a CHECK-constraint union) or restricts how it is written (never, insert
// only); it never contradicts the database. Each refined column must exist in the generated table, its select type
// must fit the generated one, it is nullable exactly when the column is, and it is optional on insert only when the
// column has a default or is nullable, unless the column is listed as assigned by a trigger (the third parameter).
// A migration that renames, retypes, changes the nullability or drops the default of a refined column fails
// typecheck here until the refinement follows (the default check means little for a column crove_tenant may not
// insert, whose insert type is undefined). The generated write types follow crove_tenant's privileges (issue #266):
// a column the role may not insert or update has the write type G.NotGranted there, which a refinement keeps
// whatever it says, so a refinement cannot make a forbidden write compile; a refinement's never is treated the same.
//
// Each CHECK-constraint union is a const array below with the type derived from it; check-unions.db.test.ts
// compares every such array with the values its CHECK constraint allows on a freshly migrated database, and fails
// when a migration widens or narrows the constraint without the union following.

// Kysely lets an insert omit a column whose insert type takes undefined or null.
type Optional<T> = undefined extends T ? true : null extends T ? true : false;
type NullMismatch<Column, Refined> = unknown extends SelectType<Column> // json: null is part of unknown
  ? never
  : null extends SelectType<Column>
    ? null extends SelectType<Refined>
      ? never
      : 'the column is nullable in the database'
    : never;
type DefaultMismatch<Column, Refined, ByTrigger extends boolean> = Optional<InsertType<Refined>> extends true
  ? Optional<InsertType<Column>> extends true
    ? never
    : ByTrigger extends true
      ? never
      : 'the column has no default in the database (list it as assigned by a trigger if one sets it)'
  : never;
type Mismatch<Column, Refined, ByTrigger extends boolean> = [SelectType<Refined>] extends [SelectType<Column>]
  ? NullMismatch<Column, Refined> | DefaultMismatch<Column, Refined, ByTrigger>
  : 'the select type does not fit the database column';
type Refinement<Table, R, ByTrigger> = {
  [K in keyof R]: K extends keyof Table
    ? [Mismatch<Table[K], R[K], K extends ByTrigger ? true : false>] extends [never]
      ? R[K]
      : Mismatch<Table[K], R[K], K extends ByTrigger ? true : false>
    : 'not a column of the generated table';
};
// The refined column under the generated column's privileges: an insert or update crove_tenant is not granted
// (G.NotGranted) stays NotGranted whatever the refinement says, and a refinement's never becomes NotGranted too
// (Kysely drops a never column, so an object carrying it, or a table left with no writable column, would pass).
type WriteType<Column, Refined> = [Column] extends [G.NotGranted] ? G.NotGranted : [Refined] extends [never] ? G.NotGranted : Refined;
type Granted<Column, Refined> = ColumnType<
  SelectType<Refined>,
  WriteType<InsertType<Column>, InsertType<Refined>>,
  WriteType<UpdateType<Column>, UpdateType<Refined>>
>;
export type Refine<Table, R extends Refinement<Table, R, ByTrigger>, ByTrigger extends keyof R = never> = {
  [K in keyof Table]: K extends keyof R ? Granted<Table[K], R[K]> : Table[K];
};
type Tables<R extends { [K in keyof R]: K extends keyof G.Database ? unknown : 'not a table of the generated Database' }> = R;

export const MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const ACTOR_TYPES = ['user', 'system', 'agent'] as const;
type ActorType = (typeof ACTOR_TYPES)[number];

export const TENANT_STATUSES = ['active', 'offboarding', 'closed'] as const;
// How often the org files its VAT return (issue #318); null until an owner or admin chooses.
export const VAT_FILING_PERIODS = ['month', 'quarter'] as const;

export type TenantTable = Refine<
  G.KernelTenantTable,
  {
    // 'offboarding': only owners may enter (kernel.org.offboard, issue #38); 'closed' is set by staff.
    status: Generated<(typeof TENANT_STATUSES)[number]>;
    vat_filing_period: (typeof VAT_FILING_PERIODS)[number] | null;
    // inbound_token is the active inbound token. Every token ever issued, retired ones included, is in
    // crove_kernel.inbound_address, which only definers read and write; rotation is the command kernel.inbound.rotate.
  }
>;

export type TenantMemberTable = Refine<G.KernelTenantMemberTable, { role: MemberRole }>;

// The tax calendar of an org (issue #921): the obligations that apply to it and its settings (one row per org), and
// the obligations marked done per period. The rules themselves are data in @crove/kernel-contract (tax-calendar.ts).
export const TAX_OBLIGATION_CODES = ['vat_return', 'pit_withholding', 'cit_provisional', 'cit_finalization', 'pit_finalization', 'financial_statements', 'license_fee'] as const;
export const PIT_FILING_PERIODS = ['month', 'quarter'] as const;
export type TaxProfileTable = Refine<
  G.KernelTaxProfileTable,
  {
    obligations: Generated<Array<(typeof TAX_OBLIGATION_CODES)[number]>>;
    pit_filing_period: (typeof PIT_FILING_PERIODS)[number] | null;
  }
>;
// The org-wide records a link to a legal entity can name (#1280 part 3b, crove_kernel.record_le).
// The language of the daily brief mail (#2406): the member's choice when they opted in; NULL is Vietnamese.
export const TODAY_MAIL_LANGUAGES = ['vi', 'en'] as const;
export type TodayMailTable = Refine<G.KernelTodayMailTable, { language: ColumnType<(typeof TODAY_MAIL_LANGUAGES)[number] | null, (typeof TODAY_MAIL_LANGUAGES)[number] | null, never> }>;

export const RECORD_LE_TYPES = ['kernel.party'] as const;
export type RecordLeTable = Refine<G.KernelRecordLeTable, { record_type: ColumnType<(typeof RECORD_LE_TYPES)[number], (typeof RECORD_LE_TYPES)[number], never> }>;

// Inbox items the system raises (#1720): a job that failed its last retry, in its own org; and (#2286) a mail with no
// invoice attachment but with the seller's lookup link or code, whose original invoice is needed. Only a system context
// inserts them; tenant roles update the dismissal columns only.
export const INBOX_ITEM_KINDS = ['kernel.job.dead_lettered', 'finance.invoice.original_needed'] as const;
export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];
export type InboxItemTable = Refine<G.KernelInboxItemTable, { kind: ColumnType<InboxItemKind, InboxItemKind, never> }>;

export type TaxObligationDoneTable = Refine<G.KernelTaxObligationDoneTable, { obligation: (typeof TAX_OBLIGATION_CODES)[number] }>;

// Gapless numbering (ADR-0021 section 2, #1401): the reset policy of a document type's series in a legal entity.
// Tenant roles only read the numbering tables; the kernel's definers write them.
export const NUMBER_RESETS = ['yearly', 'monthly', 'never'] as const;
export type NumberSeriesPolicyTable = Refine<G.KernelNumberSeriesPolicyTable, { reset: (typeof NUMBER_RESETS)[number] }>;

// The calendar core (issue #1313): a member's weekly working hours and the events on their calendar. Holidays and the
// slot rules are in @crove/kernel-contract (calendar.ts).
export const CALENDAR_EVENT_KINDS = ['manual', 'time_off', 'booking', 'google', 'microsoft', 'caldav'] as const;
export const CALENDAR_CONNECTION_STATUSES = ['active', 'expired', 'disconnecting'] as const;
export const CALENDAR_PROVIDERS = ['google', 'microsoft', 'caldav'] as const;
export const CALENDAR_LINK_STATES = ['written', 'removed', 'error'] as const;
export const CALENDAR_EVENT_STATUSES = ['active', 'cancelled'] as const;
export type CalendarEventTable = Refine<
  G.KernelCalendarEventTable,
  {
    kind: Generated<(typeof CALENDAR_EVENT_KINDS)[number]>;
    status: Generated<(typeof CALENDAR_EVENT_STATUSES)[number]>;
  }
>;

export type CalendarEventLinkTable = Refine<G.KernelCalendarEventLinkTable, { state: (typeof CALENDAR_LINK_STATES)[number] }>;
export type CalendarConnectionTable = Refine<
  G.KernelCalendarConnectionTable,
  {
    provider: ColumnType<(typeof CALENDAR_PROVIDERS)[number], (typeof CALENDAR_PROVIDERS)[number], never>;
    status: Generated<(typeof CALENDAR_CONNECTION_STATUSES)[number]>;
  }
>;

// The legal entities of an org (issue #1278): a company or other organization, a branch or other dependent unit, or a
// household or individual business. One default per org, created with the org.
export const LEGAL_ENTITY_KINDS = ['company', 'branch', 'household'] as const;
export type LegalEntityKind = (typeof LEGAL_ENTITY_KINDS)[number];
export type LegalEntityTable = Refine<G.KernelLegalEntityTable, { kind: Generated<LegalEntityKind> }>;

// The built-in roles a member can hold on top of their base role (issue #1279, plan §4.6), and their assignments: an
// org-wide role covers the whole org, a legal_entity role (external_accountant) names one legal entity. Tenant roles
// only read the three tables; crove_kernel.role_assignment_grant() and role_assignment_revoke() write assignments.
export const ROLE_SCOPES = ['org', 'legal_entity'] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];
export type RoleTable = Refine<G.KernelRoleTable, { scope: RoleScope }>;
export type RoleAssignmentTable = Refine<G.KernelRoleAssignmentTable, { scope: RoleScope }>;

// A pending, accepted or revoked invite (issue #35). Tenant roles insert invites and may only set status,
// revoked_at and revoked_by; crove_kernel.invite_accept() is the only writer of accepted_at and accepted_by.
export const INVITE_ROLES = ['admin', 'member', 'viewer'] as const;
export const INVITE_STATUSES = ['pending', 'accepted', 'revoked'] as const;
export type MemberInviteTable = Refine<
  G.KernelMemberInviteTable,
  {
    role: (typeof INVITE_ROLES)[number];
    token_sha256: string;
    status: Generated<(typeof INVITE_STATUSES)[number]>;
    expires_at: ColumnType<Date, Date | string, Date | string>;
    accepted_at: ColumnType<Date | null, never, never>;
    accepted_by: ColumnType<string | null, never, never>;
  }
>;

export const AUDIT_OUTCOMES = ['ok', 'pending_approval', 'denied', 'failed'] as const;

export type AuditEventTable = Refine<
  G.KernelAuditEventTable,
  {
    actor_type: ActorType;
    outcome: (typeof AUDIT_OUTCOMES)[number];
  }
>;

export const PARTY_KINDS = ['organization', 'person'] as const;
export const PARTY_SOURCE_TRUSTS = ['external', 'user', 'system'] as const;

export type PartyTable = Refine<
  G.KernelPartyTable,
  {
    kind: Generated<(typeof PARTY_KINDS)[number]>;
    source_trust: Generated<(typeof PARTY_SOURCE_TRUSTS)[number]>;
  }
>;

// generation is the object version the bytes were written as (ADR-0013); null only on rows from before it.
// A file row never changes, for every role (trigger file_guard; a move to another org is refused by RLS): crove_tenant
// keeps UPDATE only to lock the row (SELECT ... FOR UPDATE), so no column has an update type here.
// social: an image uploaded for a Social post (#372); import: a spreadsheet for a module's import (#465). Neither is
// extracted or shown in the Inbox. meeting_audio and meeting_video: encrypted meeting recordings (#2576).
export const FILE_SOURCES = ['upload', 'email', 'social', 'import', 'meeting_audio', 'meeting_video'] as const;
type Frozen<T> = ColumnType<SelectType<T>, InsertType<T>, G.NotGranted>;
export type FileTable = Refine<
  G.KernelFileTable,
  { [K in Exclude<keyof G.KernelFileTable, 'source'>]: Frozen<G.KernelFileTable[K]> } & { source: Frozen<(typeof FILE_SOURCES)[number]> }
>;

export const FILE_UPLOAD_PURPOSES = ['document', 'social', 'import', 'meeting_audio', 'meeting_video'] as const;
export type FileUploadPurpose = (typeof FILE_UPLOAD_PURPOSES)[number];
export type FileUploadTable = Refine<G.KernelFileUploadTable, { purpose: Generated<FileUploadPurpose> }>;

// archive: a ZIP whose entries were filed as files of their own (#314); such a run never has a proposal.
export const EXTRACTION_METHODS = ['einvoice_xml', 'pdf_text_ai', 'image_ai', 'unsupported', 'archive'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const EXTRACTION_STATUSES = ['pending', 'done', 'failed'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

// requested_by is the user who asked for a re-extraction; NULL for the first extraction.
export type ExtractionTable = Refine<
  G.KernelExtractionTable,
  {
    // NULL only while a re-extraction is pending (or for one that timed out before it was read).
    method: ExtractionMethod | null;
    status: ExtractionStatus;
    // 1, 2, 3, ... per file; assigned by the database on insert (trigger extraction_assign_version).
    version: Generated<number>;
    // How many entries an archive run's result lists (#432); NULL for every other run. Set by the database from the
    // result on every insert and update (trigger extraction_entry_count), never by the code.
    entry_count: ColumnType<number | null, never, never>;
    legal_entity_id: LegalEntityColumn;
  },
  'version' | 'legal_entity_id'
>;

// 'approved' exists only inside the transaction of kernel.proposal.approve today: it marks the proposal approved for
// its command while that command runs (the runtime's proposal state gate), and the same transaction ends 'executed'.
// 'expired' (#876) is terminal like 'rejected': a proposal left pending past its org's expiry, which nobody decides
// any more; its author may ask for it again as a new proposal.
export const PROPOSAL_STATUSES = ['pending', 'approved', 'executed', 'rejected', 'failed', 'expired'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

// eligible_approvers is set on every new proposal; NULL only on proposals decided before the approval policy existed.
// legal_entity_id: filled by the trigger b_legal_entity (the extraction's, the writer's or the default entity), never
// changed (#1538).
export type ProposalTable = Refine<G.KernelProposalTable, { status: Generated<ProposalStatus>; legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type NotificationTable = Refine<G.KernelNotificationTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;

// ADR-0029 Phase 1 (issue #79): agents in an org chart shared with humans. See the migration
// 20261018050000_crove_kernel_agents_org_chart.sql for the rules the database enforces.
export const AGENT_RISKS = ['R0', 'R1', 'R2'] as const;
export type AgentRisk = (typeof AGENT_RISKS)[number];

export type AgentTemplateTable = Refine<
  G.KernelAgentTemplateTable,
  {
    max_risk: AgentRisk;
    subscribes: string[];
    daily_run_cap: number;
  }
>;

export const AGENT_STATUSES = ['active', 'paused', 'retired'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const AGENT_KINDS = ['org_chart', 'member_vy'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const MEMBER_PERMISSION_OVERRIDE_PERMISSIONS = ['vy.use'] as const;
export const MEMBER_VY_TABLE_MODES = ['read', 'write'] as const;
export const MCP_MEMBER_TABLE_MODES = ['read'] as const;
export const MEMBER_VY_RESULT_STATUSES = ['running', 'ready', 'failed'] as const;
export type MemberVyResultStatus = (typeof MEMBER_VY_RESULT_STATUSES)[number];
export const AGENT_RUNTIMES = ['builtin', 'external'] as const;

export type AgentTable = Refine<
  G.KernelAgentTable,
  {
    runtime: Generated<(typeof AGENT_RUNTIMES)[number]>;
    kind: Generated<AgentKind>;
    status: Generated<AgentStatus>;
    max_risk: Generated<AgentRisk>;
  }
>;

export const POSITION_STATUSES = ['active', 'paused', 'archived'] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

export type PositionTable = Refine<G.KernelPositionTable, { status: Generated<PositionStatus> }>;

export const AI_RUN_STATUSES = ['running', 'succeeded', 'failed', 'expired', 'cancelled'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

export type AiRunTable = Refine<G.KernelAiRunTable, { status: Generated<AiRunStatus> }>;

export const TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_KINDS = ['general', 'proposal_review', 'escalation', 'delegation'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_SOURCES = ['event', 'proposal', 'human', 'schedule'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export type TaskTable = Refine<
  G.KernelTaskTable,
  {
    kind: Generated<TaskKind>;
    source: TaskSource;
    // Stamped from the context by a trigger, with created_by_id and created_by_run.
    created_by_type: ActorType;
    status: Generated<TaskStatus>;
    fence: ColumnType<string, string | number | undefined, string | number>;
  }
>;

export type TaskCommentTable = Refine<
  G.KernelTaskCommentTable,
  {
    // Stamped from the context by a trigger, with author_id and run_id.
    author_type: ActorType;
  }
>;

export const CHANNEL_CONNECTION_STATUSES = ['active', 'expired', 'revoked', 'error'] as const;
export type ChannelConnectionStatus = (typeof CHANNEL_CONNECTION_STATUSES)[number];

// A connected social or messaging account (ADR-0025). Its sealed tokens live in crove_kernel.credential, which has
// no Kysely type: only the credential_* definers reach it.
export type ChannelConnectionTable = Refine<G.KernelChannelConnectionTable, { status: Generated<ChannelConnectionStatus> }>;

// The ledger of visible calls to outside services (Social plan §3.4): a call is recorded as started before it is made.
export const EXTERNAL_CALL_STATES = ['started', 'succeeded', 'failed', 'ambiguous'] as const;
export type ExternalCallState = (typeof EXTERNAL_CALL_STATES)[number];
export const EXTERNAL_CALL_RETRY_SAFETIES = ['safe', 'idempotent', 'reconcile_only', 'never'] as const;
export const EXTERNAL_CALL_ERROR_KINDS = ['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown'] as const;
export type ExternalCallTable = Refine<
  G.KernelExternalCallTable,
  {
    retry_safety: (typeof EXTERNAL_CALL_RETRY_SAFETIES)[number];
    state: Generated<ExternalCallState>;
    error_kind: (typeof EXTERNAL_CALL_ERROR_KINDS)[number] | null;
  }
>;

// Outbound mail (Email plan §3.2-3.3, #538): one row per mail, and the addresses an org must not mail.
export const MAIL_STREAMS = ['system', 'transactional', 'marketing'] as const;
export const MAIL_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'ambiguous'] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];
export type MailMessageTable = Refine<
  G.KernelMailMessageTable,
  { stream: (typeof MAIL_STREAMS)[number]; status: Generated<MailStatus> }
>;
export const MAIL_SUPPRESSION_SCOPES = ['all', 'marketing'] as const;
export const MAIL_SUPPRESSION_REASONS = ['hard_bounce', 'complaint', 'unsubscribe_all', 'manual', 'provider'] as const;
export type MailSuppressionTable = Refine<
  G.KernelMailSuppressionTable,
  { scope: (typeof MAIL_SUPPRESSION_SCOPES)[number]; reason: (typeof MAIL_SUPPRESSION_REASONS)[number] }
>;
// Delivery events from the mail provider (Email plan §3.3, #539), one row per provider event.
export const MAIL_EVENT_KINDS = ['delivered', 'deferred', 'bounce_hard', 'bounce_soft', 'complaint'] as const;
export type MailEventTable = Refine<G.KernelMailEventTable, { kind: (typeof MAIL_EVENT_KINDS)[number] }>;

// Per-org abuse limits (#675): what an org used, and the items kept for its next day's budget.
export const USAGE_METRICS = ['inbound_emails', 'attachment_bytes', 'extraction_pages', 'ai_cost', 'conversation_emails'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
// What a deferral may wait for: a limit above, or the AI budget of the month (#2382).
export const USAGE_DEFERRAL_METRICS = [...USAGE_METRICS, 'ai_budget'] as const;
export type UsageDeferralMetric = (typeof USAGE_DEFERRAL_METRICS)[number];
export const USAGE_DEFERRAL_SUBJECTS = ['inbound_email', 'file'] as const;
export type UsageDeferralSubject = (typeof USAGE_DEFERRAL_SUBJECTS)[number];
export type OrgUsageTable = Refine<G.KernelOrgUsageTable, { metric: UsageMetric }>;
export type UsageDeferralTable = Refine<G.KernelUsageDeferralTable, { metric: UsageDeferralMetric; subject_type: UsageDeferralSubject }>;

export const AGENT_WAKEUP_STATUSES = ['pending', 'claimed', 'done'] as const;
export type AgentWakeupTable = Refine<G.KernelAgentWakeupTable, { status: Generated<(typeof AGENT_WAKEUP_STATUSES)[number]> }>;

export const AGENT_SCOPES = ['org', 'module', 'agent'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export type KillSwitchTable = Refine<G.KernelKillSwitchTable, { scope: AgentScope }>;

export type BudgetPolicyTable = Refine<G.KernelBudgetPolicyTable, { scope: AgentScope }>;

// A purchase (the org bought; party_id is the seller) or a sale (the org issued the invoice; party_id is the
// customer), issue #313. Both live in purchase_document; the table keeps its name.
export const DOCUMENT_DIRECTIONS = ['purchase', 'sale'] as const;
export type DocumentDirection = (typeof DOCUMENT_DIRECTIONS)[number];
// A replacement (thay thế) or an adjustment (điều chỉnh) invoice of another (#916).
export const CORRECTION_KINDS = ['replacement', 'adjustment'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
// Where the exchange rate of a foreign-currency document comes from (#918): the e-invoice's own TGia, or the accountant.
export const EXCHANGE_RATE_SOURCES = ['invoice', 'entered'] as const;
export type ExchangeRateSource = (typeof EXCHANGE_RATE_SOURCES)[number];

// The legal entity of a finance or kernel row (#1280): the parent's, or the one the writer names, or the org's default
// entity, filled in by the insert trigger b_legal_entity (crove_finance.legal_entity_fill, crove_kernel.legal_entity_fill)
// and never changed afterwards.
type LegalEntityColumn = ColumnType<string, string | undefined, never>;

export type PurchaseDocumentTable = Refine<
  G.FinancePurchaseDocumentTable,
  {
    // The voided document of the same invoice that this one replaces (#165), or null for the first one.
    replaces_document_id: ColumnType<string | null, string | null | undefined, never>;
    direction: ColumnType<DocumentDirection, DocumentDirection | undefined, never>;
    correction_kind: ColumnType<CorrectionKind | null, CorrectionKind | null | undefined, never>;
    // A foreign-currency document's rate and original totals (#918); null on a VND document.
    exchange_rate: ColumnType<string | null, string | null | undefined, never>;
    exchange_rate_source: ColumnType<ExchangeRateSource | null, ExchangeRateSource | null | undefined, never>;
    foreign_subtotal: ColumnType<string | null, string | null | undefined, never>;
    foreign_vat_amount: ColumnType<string | null, string | null | undefined, never>;
    foreign_total: ColumnType<string | null, string | null | undefined, never>;
    legal_entity_id: LegalEntityColumn;
  },
  'legal_entity_id'
>;

// Entries are written only by crove_finance.post_journal_entry().
export type JournalEntryTable = Refine<
  G.FinanceJournalEntryTable,
  {
    // xid8 stamped by a trigger.
    created_xact_id: ColumnType<string | null, never, never>;
    // Start of that transaction, stamped by the same trigger: xid8 alone repeats after a logical restore.
    created_xact_start: ColumnType<Date | null, never, never>;
    // The entry this one reverses (its mirror), or null; set only by the posting function.
    reverses_entry_id: ColumnType<string | null, never, never>;
  }
>;

// An org's sub-accounts under the TT133 chart (#319). The insert trigger fills root_code (the TT133 account the code
// rolls up to) and makes every new sub-account active; code, parent and root never change.
export type OrgAccountTable = Refine<
  G.FinanceOrgAccountTable,
  {
    root_code: ColumnType<string, never, never>;
    active: ColumnType<boolean, never, boolean>;
  },
  'root_code'
>;

// Cash and bank vouchers (#327): phiếu thu, phiếu chi, giấy báo Có, giấy báo Nợ. The insert trigger numbers each one
// per org and type (any number given is replaced), and rows never change.
export const VOUCHER_TYPES = ['cash_receipt', 'cash_payment', 'bank_credit', 'bank_debit'] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];
export type CashVoucherTable = Refine<
  G.FinanceCashVoucherTable,
  {
    voucher_type: ColumnType<VoucherType, VoucherType, never>;
    number: ColumnType<number, never, never>;
    legal_entity_id: LegalEntityColumn;
    // Set with number by the insert trigger, from the kernel's number series (#1401); a row written with triggers off
    // (replica mode) keeps number_period '-' and has no allocation.
    number_period: ColumnType<string, never, never>;
    number_allocation_id: ColumnType<string | null, never, never>;
  },
  'number' | 'legal_entity_id' | 'number_period' | 'number_allocation_id'
>;

// The accountant's marks on input invoices that need proof of non-cash payment (#917). Append-only; the latest mark
// of a document is its state.
export const INPUT_VAT_CHECK_OUTCOMES = ['paid_by_bank', 'not_deductible', 'cleared'] as const;
export type InputVatCheckOutcome = (typeof INPUT_VAT_CHECK_OUTCOMES)[number];
export type InputVatCheckTable = Refine<
  G.FinanceInputVatCheckTable,
  { outcome: ColumnType<InputVatCheckOutcome, InputVatCheckOutcome, never>; legal_entity_id: LegalEntityColumn },
  'legal_entity_id'
>;

// The VAT return 01/GTGT marked filed for a period (#1400), with [22], [25] and [43] as filed. Append-only; the latest
// row of a period is its state. source: 'entered' on the VAT screen, 'computed' when marked done from the tax calendar.
export const VAT_RETURN_FILED_STATUSES = ['filed', 'withdrawn'] as const;
export const VAT_RETURN_FILED_SOURCES = ['entered', 'computed'] as const;
export type VatReturnFiledTable = Refine<
  G.FinanceVatReturnFiledTable,
  {
    status: ColumnType<(typeof VAT_RETURN_FILED_STATUSES)[number], (typeof VAT_RETURN_FILED_STATUSES)[number], never>;
    source: ColumnType<(typeof VAT_RETURN_FILED_SOURCES)[number] | null, (typeof VAT_RETURN_FILED_SOURCES)[number] | null, never>;
  }
>;

// Learned bank-line rules (#2402): what a statement line's key is the key of. The key is stored only as a keyed hash.
export const BANK_PARTY_RULE_KINDS = ['text', 'account'] as const;
export type BankPartyRuleKind = (typeof BANK_PARTY_RULE_KINDS)[number];
// A sales e-invoice draft (#2500, ADR-0044): its state, and the kind of buyer it is for (a business, a named individual, a consumer).
export const EINVOICE_DRAFT_STATES = ['draft', 'submitting', 'pending', 'issued', 'rejected', 'failed'] as const;
export const EINVOICE_BUYER_KINDS = ['business', 'individual', 'consumer'] as const;
export type EInvoiceDraftTable = Refine<
  G.FinanceEinvoiceDraftTable,
  { state: Generated<(typeof EINVOICE_DRAFT_STATES)[number]>; buyer_kind: (typeof EINVOICE_BUYER_KINDS)[number]; legal_entity_id: LegalEntityColumn },
  'legal_entity_id'
>;
// Stock (#2512, ADR-0045 point 1): the kind of an item, the trade it is sold in, and where a move of stock comes from.
export const STOCK_ITEM_KINDS = ['goods'] as const;
export type StockItemKind = (typeof STOCK_ITEM_KINDS)[number];
export const STOCK_TRADES = ['goods', 'services', 'catering', 'other'] as const;
export type StockTrade = (typeof STOCK_TRADES)[number];
// The household business kind (#2517): the fixed sets its CHECK constraints keep.
export const HOUSEHOLD_PIT_METHODS = ['percentage', 'income'] as const;
export const HOUSEHOLD_RULE_STATUSES = ['commentary', 'confirmed'] as const;
export const HOUSEHOLD_EXPENSE_GROUPS = ['materials_goods', 'wages_insurance', 'depreciation', 'outside_services', 'interest', 'other'] as const;
export const HOUSEHOLD_BOOKS = ['S1a', 'S2a', 'S2b', 'S2c', 'S2d', 'S2e', 'S3a'] as const;
export type HouseholdPitMethod = (typeof HOUSEHOLD_PIT_METHODS)[number];
export type HouseholdRuleStatus = (typeof HOUSEHOLD_RULE_STATUSES)[number];
export type HouseholdExpenseGroup = (typeof HOUSEHOLD_EXPENSE_GROUPS)[number];
export type HouseholdBook = (typeof HOUSEHOLD_BOOKS)[number];
export const STOCK_MOVE_SOURCES = ['document_line', 'manual', 'reversal', 'order_line', 'count', 'crm_order_line'] as const;
export type StockMoveSource = (typeof STOCK_MOVE_SOURCES)[number];
export type StockItemTable = Refine<
  G.FinanceStockItemTable,
  { kind: ColumnType<StockItemKind, StockItemKind | undefined, G.NotGranted>; trade: Generated<StockTrade>; legal_entity_id: LegalEntityColumn },
  'legal_entity_id'
>;
export type StockAliasTable = Refine<G.FinanceStockAliasTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
// The household business kind (#2517): the profile of an entity of kind household, and the law as dated rows (global, read-only for every org).
export type HouseholdProfileTable = Refine<
  G.FinanceHouseholdProfileTable,
  { pit_method: HouseholdPitMethod | null; trades: StockTrade[]; legal_entity_id: LegalEntityColumn },
  'legal_entity_id'
>;
export type HouseholdThresholdTable = Refine<G.FinanceHouseholdThresholdTable, { status: HouseholdRuleStatus }>;
export type HouseholdTradeRateTable = Refine<G.FinanceHouseholdTradeRateTable, { trade: StockTrade; status: HouseholdRuleStatus }>;
export type HouseholdExpenseGroupMapTable = Refine<G.FinanceHouseholdExpenseGroupMapTable, { expense_group: HouseholdExpenseGroup; status: HouseholdRuleStatus }>;
export type HouseholdFormVersionTable = Refine<G.FinanceHouseholdFormVersionTable, { book: HouseholdBook; pit_methods: Array<'none' | HouseholdPitMethod>; status: HouseholdRuleStatus }>;
// Marketplace orders (#2515, ADR-0045 point 5): the platform, how far a line has got, and which move of an order line a stock move is (a shipment out, a return in).
export const CHANNEL_PLATFORMS = ['shopee', 'tiktok_shop', 'lazada'] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];
export const CHANNEL_STAGES = ['placed', 'shipped', 'completed', 'cancelled', 'returned', 'unknown'] as const;
export type ChannelStage = (typeof CHANNEL_STAGES)[number];
export const STOCK_ORDER_MOVES = ['ship', 'return'] as const;
export type StockOrderMove = (typeof STOCK_ORDER_MOVES)[number];
export type StockMoveTable = Refine<
  G.FinanceStockMoveTable,
  { source_type: ColumnType<StockMoveSource, StockMoveSource, G.NotGranted>; order_move: ColumnType<StockOrderMove | null, StockOrderMove | null | undefined, G.NotGranted>; legal_entity_id: LegalEntityColumn },
  'legal_entity_id'
>;
// The close of a month of stock (#2513): a closed month and what it held of each item, both append-only.
export type StockPeriodTable = Refine<G.FinanceStockPeriodTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type StockPeriodItemTable = Refine<G.FinanceStockPeriodItemTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
// The count of stock (#2513 part b): a header that is a draft until it is confirmed or cancelled, and what was counted of each item.
export const STOCK_COUNT_STATUSES = ['draft', 'confirmed', 'cancelled'] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];
export type StockCountTable = Refine<G.FinanceStockCountTable, { status: ColumnType<StockCountStatus, StockCountStatus | undefined, StockCountStatus>; legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type StockCountLineTable = Refine<G.FinanceStockCountLineTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type ChannelOrderTable = Refine<G.FinanceChannelOrderTable, { platform: ColumnType<ChannelPlatform, ChannelPlatform, G.NotGranted>; legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type ChannelOrderLineTable = Refine<G.FinanceChannelOrderLineTable, { stage: ChannelStage; legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
// The income reports of the marketplaces (#2516): a settlement per platform and period and what the platform paid for each order of it, both append-only.
export type ChannelSettlementTable = Refine<G.FinanceChannelSettlementTable, { platform: ColumnType<ChannelPlatform, ChannelPlatform, G.NotGranted>; legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type ChannelSettlementLineTable = Refine<G.FinanceChannelSettlementLineTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
// A connection to an e-invoice provider (#2501): the result of its last test, as a state and never the provider's own text.
export const EINVOICE_CONNECTION_STATES = ['works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable', 'signing_needs_person'] as const;
export type EInvoiceConnectionState = (typeof EINVOICE_CONNECTION_STATES)[number];
export type EInvoiceConnectionTable = Refine<
  G.FinanceEinvoiceConnectionTable,
  { last_test_state: EInvoiceConnectionState | null; legal_entity_id: LegalEntityColumn },
  'legal_entity_id'
>;
// A connection to a marketplace (#2519): the result of its last test and of its last poll, as states and never the platform's own text.
export const MARKETPLACE_TEST_STATES = ['works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable'] as const;
export type MarketplaceTestState = (typeof MARKETPLACE_TEST_STATES)[number];
export const MARKETPLACE_POLL_STATES = ['ok', 'unreachable', 'credentials', 'rate_limited', 'too_large', 'not_recognized'] as const;
export type MarketplacePollState = (typeof MARKETPLACE_POLL_STATES)[number];
export type MarketplaceConnectionTable = Refine<
  G.FinanceMarketplaceConnectionTable,
  { platform: ColumnType<ChannelPlatform, ChannelPlatform, G.NotGranted>; last_test_state: MarketplaceTestState | null; last_poll_state: MarketplacePollState | null; legal_entity_id: LegalEntityColumn },
  'legal_entity_id'
>;
export type BankPartyRuleTable = Refine<G.FinanceBankPartyRuleTable, { kind: ColumnType<BankPartyRuleKind, BankPartyRuleKind, never>; legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;

// Learned account rules (#1399): the line's whole item description, normalized, or a keyword in it. What a rule matches
// never changes in place.
export const CATEGORIZATION_RULE_MATCH_KINDS = ['description', 'keyword'] as const;
export type CategorizationRuleMatchKind = (typeof CATEGORIZATION_RULE_MATCH_KINDS)[number];
export type CategorizationRuleTable = Refine<
  G.FinanceCategorizationRuleTable,
  { match_kind: ColumnType<CategorizationRuleMatchKind, CategorizationRuleMatchKind, never>; legal_entity_id: LegalEntityColumn },
  'legal_entity_id'
>;

// The charts of accounts Crove knows (#1403): a regime and its version. Read only for tenant roles.
export const BOOKS_REGIMES = ['tt133', 'tt99'] as const;
export type BooksRegime = (typeof BOOKS_REGIMES)[number];
export type ChartTable = Refine<G.FinanceChartTable, { regime: ColumnType<BooksRegime, never, never> }>;
// The chart an entity's books follow from a fiscal year on (no row: TT133 2026.1). Read only for tenant roles.
export type LegalEntityBooksTable = Refine<G.FinanceLegalEntityBooksTable, { regime: ColumnType<BooksRegime, never, never> }>;

// The register of fixed assets and prepaid costs (#919). Tenant roles update only the end of a schedule, once.
export const FIXED_ASSET_KINDS = ['fixed_asset', 'prepaid_cost'] as const;
export type FixedAssetKind = (typeof FIXED_ASSET_KINDS)[number];
export type FixedAssetTable = Refine<
  G.FinanceFixedAssetTable,
  {
    kind: ColumnType<FixedAssetKind, FixedAssetKind, never>;
    accumulated_account: ColumnType<string | null, string | null | undefined, never>;
    source_document_id: ColumnType<string | null, string | null | undefined, never>;
    source_line_no: ColumnType<number | null, number | null | undefined, never>;
    ended_month: ColumnType<string | null, string | null | undefined, string | null>;
    end_reason: ColumnType<string | null, string | null | undefined, string | null>;
    ended_by: ColumnType<string | null, string | null | undefined, string | null>;
    created_by: ColumnType<string | null, string | null | undefined, never>;
    legal_entity_id: LegalEntityColumn;
  },
  'legal_entity_id'
>;

// General journal vouchers (#888): phiếu kế toán khác, NVK. The insert trigger numbers each one per org (any number
// given is replaced), and rows never change.
export type JournalVoucherTable = Refine<
  G.FinanceJournalVoucherTable,
  {
    number: ColumnType<number, never, never>;
    legal_entity_id: LegalEntityColumn;
    // Set with number by the insert trigger, from the kernel's number series (#1401); a row written with triggers off
    // (replica mode) keeps number_period '-' and has no allocation.
    number_period: ColumnType<string, never, never>;
    number_allocation_id: ColumnType<string | null, never, never>;
  },
  'number' | 'legal_entity_id' | 'number_period' | 'number_allocation_id'
>;

// The tax portal's purchase-invoice lists (#465). A list starts pending; the insert trigger stamps created_at and the
// update trigger stamps recorded_at and removed_at with the database clock. Rows are append-only.
export const PORTAL_LIST_STATUSES = ['pending', 'done', 'failed'] as const;
export const PORTAL_INVOICE_STATUSES = ['original', 'replacement', 'adjustment', 'replaced', 'adjusted', 'cancelled', 'unknown'] as const;
// The org is the buyer (the purchase list) or the seller (the sales list, #2141).
export const PORTAL_LIST_DIRECTIONS = ['purchase', 'sale'] as const;

export type PortalInvoiceListTable = Refine<
  G.FinancePortalInvoiceListTable,
  {
    status: ColumnType<(typeof PORTAL_LIST_STATUSES)[number], (typeof PORTAL_LIST_STATUSES)[number] | undefined, (typeof PORTAL_LIST_STATUSES)[number]>;
    direction: ColumnType<(typeof PORTAL_LIST_DIRECTIONS)[number], (typeof PORTAL_LIST_DIRECTIONS)[number] | undefined, never>;
    legal_entity_id: LegalEntityColumn;
  },
  'legal_entity_id'
>;

export type PortalInvoiceRowTable = Refine<
  G.FinancePortalInvoiceRowTable,
  { status: ColumnType<(typeof PORTAL_INVOICE_STATUSES)[number], (typeof PORTAL_INVOICE_STATUSES)[number], never>; legal_entity_id: LegalEntityColumn },
  'legal_entity_id'
>;

// Finance tables refined only for their legal entity (#1280).
export type BankLineTable = Refine<G.FinanceBankLineTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type DepreciationLineTable = Refine<G.FinanceDepreciationLineTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type PurchaseLineTable = Refine<G.FinancePurchaseLineTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type PurchaseTaxRateTable = Refine<G.FinancePurchaseTaxRateTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type PurchaseDocumentVoidTable = Refine<G.FinancePurchaseDocumentVoidTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;

// Crove Social (Social plan §3.2, S3).
export const SOCIAL_POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled'] as const;
export const SOCIAL_VARIANT_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'rejected',
  'approved',
  'scheduled',
  'publishing',
  'processing',
  'published',
  'failed',
  'ambiguous',
  'needs_attention',
  'paused',
  'cancelled',
  // Taken down from its platform (#860).
  'removed',
] as const;
export const SOCIAL_ORIGINS = ['human', 'ai'] as const;
export const SOCIAL_ACTOR_ORIGINS = ['ui', 'api', 'mcp', 'agent', 'system'] as const;
export const SOCIAL_DECISIONS = ['approved', 'changes_requested', 'rejected'] as const;
// What a client said through a review link (#589): a signal for the team, never an approval.
export const SOCIAL_REVIEW_VERDICTS = ['approved', 'changes_requested', 'comment'] as const;
// A review link of one post (#589), or of a content plan's posts (#902).
export const SOCIAL_REVIEW_LINK_KINDS = ['post', 'plan'] as const;
// What an in-app notification is about (#637); a member may turn each kind off. weekly_digest is the weekly email
// digest (#1104): never a notification row, only a member's switch to turn the digest off.
export const SOCIAL_NOTIFICATION_KINDS = ['review_requested', 'decided', 'failed', 'needs_attention', 'channel_expired', 'comment', 'client_answer', 'assigned', 'review_reminder', 'feed_paused', 'mention', 'publishing_hold', 'queue_low', 'weekly_digest', 'post_outperforming', 'assignment_due'] as const;
// Why a channel's daily account snapshot has no counts (#645), and why a bring-in of its outside posts found none (#1054).
export const SOCIAL_ACCOUNT_SNAPSHOT_ERRORS = ['no_answer', 'token_expired', 'permission'] as const;
export const SOCIAL_ERROR_KINDS = ['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown'] as const;
// Where a correction of a published variant's text stands (#1223): on its way, refused, or unclear.
export const SOCIAL_EDIT_STATES = ['pending', 'failed', 'unknown'] as const;
export type SocialEditState = (typeof SOCIAL_EDIT_STATES)[number];
// A link preview card (#641): waiting for the worker, read, or not readable and why.
export const SOCIAL_LINK_PREVIEW_STATUSES = ['pending', 'ready', 'failed'] as const;
export const SOCIAL_LINK_PREVIEW_ERRORS = ['invalid_url', 'blocked', 'dns', 'timeout', 'too_large', 'redirects', 'encoding', 'network', 'http', 'not_html'] as const;
export type SocialLinkPreviewStatus = (typeof SOCIAL_LINK_PREVIEW_STATUSES)[number];
export type SocialLinkPreviewError = (typeof SOCIAL_LINK_PREVIEW_ERRORS)[number];
// A channel's options for the composer (#1120): what a list holds (a Pinterest board's sections; since #1131 a YouTube
// channel's playlists and a WordPress site's categories and tags; since #1497 a TikTok account's creator options),
// where its read stands and why it failed.
export const SOCIAL_CHANNEL_OPTION_KINDS = ['pinterest_section', 'youtube_playlist', 'wordpress_term', 'tiktok_creator'] as const;
export const SOCIAL_CHANNEL_OPTION_STATUSES = ['pending', 'ready', 'failed'] as const;
export const SOCIAL_CHANNEL_OPTION_ERRORS = ['token_expired', 'permission', 'not_found', 'no_answer'] as const;
export type SocialChannelOptionKind = (typeof SOCIAL_CHANNEL_OPTION_KINDS)[number];
export type SocialChannelOptionStatus = (typeof SOCIAL_CHANNEL_OPTION_STATUSES)[number];
export type SocialChannelOptionError = (typeof SOCIAL_CHANNEL_OPTION_ERRORS)[number];
// The palette a label's colour comes from (#639); the app maps each name to a theme tone.
export const SOCIAL_LABEL_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
// Where a library file saved from a stock photo site came from (#1106).
export const SOCIAL_MEDIA_ATTRIBUTION_PROVIDERS = ['pexels'] as const;
export type SocialMediaAttributionProvider = (typeof SOCIAL_MEDIA_ATTRIBUTION_PROVIDERS)[number];
// The corner of an image the org's logo watermark goes in (#834).
export const SOCIAL_WATERMARK_CORNERS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const;
// The org's team chat for Social alerts (#863): where it is, and the kinds of alert it may get.
export const SOCIAL_CHAT_ALERT_TARGETS = ['telegram', 'discord'] as const;
export const SOCIAL_CHAT_ALERT_KINDS = ['needs_approval', 'failed', 'published', 'client_answered'] as const;
// The stages of an idea on the ideas board (#701).
export const SOCIAL_IDEA_STAGES = ['new', 'planned', 'drafted', 'archived'] as const;
// Where an idea came from (#1181): a person, or an AI suggestion the member kept. Set at insert only.
export const SOCIAL_IDEA_ORIGINS = ['human', 'ai'] as const;
// Scheduled client report mail (#704): how often, the period each mail covers, and a run's kind.
export const SOCIAL_REPORT_CADENCES = ['weekly', 'monthly'] as const;
export const SOCIAL_REPORT_PERIODS = ['previous_week', 'previous_month', 'last_7_days', 'last_30_days'] as const;
export const SOCIAL_REPORT_RUN_KINDS = ['scheduled', 'test'] as const;
// The sections of a client report (#1259), on a report link and a report schedule: a list of these, each at most once
// (an array CHECK, which check-unions.db.test.ts does not read), or null for every section.
export const SOCIAL_REPORT_SECTIONS = ['note', 'goals', 'totals', 'comparison', 'channels', 'top', 'reels', 'stories', 'audience', 'clicks'] as const;
// A banned or sensitive word (#1055): shown as a warning, or blocking submit, approval and scheduling.
export const SOCIAL_BANNED_WORD_LEVELS = ['warn', 'block'] as const;
// A suggested edit on a post comment (#1236): the text it changes (the post's own, or the comment's channel's own), and
// where it stands.
export const SOCIAL_SUGGEST_FIELDS = ['post', 'channel'] as const;
export const SOCIAL_SUGGEST_STATES = ['open', 'accepted', 'skipped', 'outdated'] as const;
export type SocialSuggestField = (typeof SOCIAL_SUGGEST_FIELDS)[number];
export type SocialSuggestState = (typeof SOCIAL_SUGGEST_STATES)[number];
export type SocialVariantStatus = (typeof SOCIAL_VARIANT_STATUSES)[number];
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];
export type SocialActorOrigin = (typeof SOCIAL_ACTOR_ORIGINS)[number];
export type SocialDecision = (typeof SOCIAL_DECISIONS)[number];
export type SocialReviewVerdict = (typeof SOCIAL_REVIEW_VERDICTS)[number];
export type SocialReviewLinkKind = (typeof SOCIAL_REVIEW_LINK_KINDS)[number];
export type SocialAccountSnapshotError = (typeof SOCIAL_ACCOUNT_SNAPSHOT_ERRORS)[number];
export type SocialNotificationKind = (typeof SOCIAL_NOTIFICATION_KINDS)[number];
export type SocialLabelColor = (typeof SOCIAL_LABEL_COLORS)[number];
export type SocialIdeaStage = (typeof SOCIAL_IDEA_STAGES)[number];
export type SocialIdeaOrigin = (typeof SOCIAL_IDEA_ORIGINS)[number];
export type SocialWatermarkCorner = (typeof SOCIAL_WATERMARK_CORNERS)[number];
export type SocialChatAlertTarget = (typeof SOCIAL_CHAT_ALERT_TARGETS)[number];
export type SocialChatAlertKind = (typeof SOCIAL_CHAT_ALERT_KINDS)[number];
export type SocialReportCadence = (typeof SOCIAL_REPORT_CADENCES)[number];
export type SocialReportPeriod = (typeof SOCIAL_REPORT_PERIODS)[number];
export type SocialReportRunKind = (typeof SOCIAL_REPORT_RUN_KINDS)[number];
export type SocialReportSection = (typeof SOCIAL_REPORT_SECTIONS)[number];
export type SocialBannedWordLevel = (typeof SOCIAL_BANNED_WORD_LEVELS)[number];

export type SocialPostTable = Refine<
  G.SocialPostTable,
  {
    origin: Generated<(typeof SOCIAL_ORIGINS)[number]>;
    actor_origin: Generated<SocialActorOrigin>;
    status: Generated<SocialPostStatus>;
  }
>;
export type SocialPostVariantTable = Refine<
  G.SocialPostVariantTable,
  {
    status: Generated<SocialVariantStatus>;
    error_kind: (typeof SOCIAL_ERROR_KINDS)[number] | null;
    edit_state: SocialEditState | null;
  }
>;
export type SocialReviewFeedbackTable = Refine<G.SocialReviewFeedbackTable, { verdict: ColumnType<SocialReviewVerdict, never, never> }>;
export type SocialReviewLinkTable = Refine<G.SocialReviewLinkTable, { kind: ColumnType<SocialReviewLinkKind, SocialReviewLinkKind | undefined, never> }>;
export type SocialAccountSnapshotTable = Refine<G.SocialAccountSnapshotTable, { error: ColumnType<SocialAccountSnapshotError | null, SocialAccountSnapshotError | null | undefined, never> }>;
export type SocialExternalImportTable = Refine<G.SocialExternalImportTable, { error: ColumnType<SocialAccountSnapshotError | null, SocialAccountSnapshotError | null | undefined, SocialAccountSnapshotError | null> }>;
export type SocialLinkPreviewTable = Refine<
  G.SocialLinkPreviewTable,
  {
    status: ColumnType<SocialLinkPreviewStatus, SocialLinkPreviewStatus, SocialLinkPreviewStatus>;
    error: ColumnType<SocialLinkPreviewError | null, SocialLinkPreviewError | null | undefined, SocialLinkPreviewError | null>;
  }
>;
export type SocialChannelOptionTable = Refine<
  G.SocialChannelOptionTable,
  {
    kind: ColumnType<SocialChannelOptionKind, SocialChannelOptionKind, never>;
    status: ColumnType<SocialChannelOptionStatus, SocialChannelOptionStatus, SocialChannelOptionStatus>;
    error: ColumnType<SocialChannelOptionError | null, SocialChannelOptionError | null | undefined, SocialChannelOptionError | null>;
  }
>;
export type SocialNotificationTable = Refine<G.SocialNotificationTable, { kind: ColumnType<SocialNotificationKind, SocialNotificationKind, never> }>;
export type SocialNotificationMuteTable = Refine<G.SocialNotificationMuteTable, { kind: ColumnType<SocialNotificationKind, SocialNotificationKind, never> }>;
export type SocialCalendarNoteTable = Refine<G.SocialCalendarNoteTable, { color: Generated<SocialLabelColor> }>;
export type SocialMediaAttributionTable = Refine<G.SocialMediaAttributionTable, { provider: SocialMediaAttributionProvider }>;
export type SocialWatermarkTable = Refine<G.SocialWatermarkTable, { corner: SocialWatermarkCorner }>;
export type SocialChatAlertTable = Refine<G.SocialChatAlertTable, { kind: SocialChatAlertTarget; events: SocialChatAlertKind[] }>;
export type SocialLabelTable = Refine<G.SocialLabelTable, { color: Generated<SocialLabelColor> }>;
export type SocialIdeaTable = Refine<G.SocialIdeaTable, { stage: Generated<SocialIdeaStage>; origin: ColumnType<SocialIdeaOrigin, SocialIdeaOrigin | undefined, never> }>;
export type SocialReportScheduleTable = Refine<G.SocialReportScheduleTable, { cadence: SocialReportCadence; period: SocialReportPeriod; sections: SocialReportSection[] | null }>;
export type SocialReportLinkTable = Refine<G.SocialReportLinkTable, { sections: SocialReportSection[] | null }>;
export type SocialReportScheduleRunTable = Refine<G.SocialReportScheduleRunTable, { kind: SocialReportRunKind }>;
export type SocialBannedWordTable = Refine<G.SocialBannedWordTable, { level: SocialBannedWordLevel }>;
export type SocialPostCommentTable = Refine<G.SocialPostCommentTable, { suggest_field: SocialSuggestField | null; suggest_state: SocialSuggestState | null }>;

export type SocialPostApprovalTable = Refine<
  G.SocialPostApprovalTable,
  {
    decision: ColumnType<SocialDecision, SocialDecision, never>;
    actor_origin: ColumnType<SocialActorOrigin, SocialActorOrigin | undefined, never>;
  }
>;

// The crm module (issue #1314): event types of booking pages.
export const EVENT_TYPE_LOCATION_KINDS = ['in_person', 'phone', 'video', 'google_meet'] as const;
// Who hosts a booking of the type (#1373): the lead host alone, one free host of the team, or every host together.
export const EVENT_TYPE_ASSIGNMENTS = ['single', 'round_robin', 'collective'] as const;
export type CrmEventTypeTable = Refine<
  G.CrmEventTypeTable,
  { location_kind: Generated<(typeof EVENT_TYPE_LOCATION_KINDS)[number]>; assignment: Generated<(typeof EVENT_TYPE_ASSIGNMENTS)[number]> }
>;
// The CRM pipeline (#2225): a stage is open, or closes its deals as won or lost; a deal's amount is in VND for now.
export const PIPELINE_STAGE_KINDS = ['open', 'won', 'lost'] as const;
export const DEAL_CURRENCIES = ['VND'] as const;
export type CrmPipelineStageTable = Refine<G.CrmPipelineStageTable, { kind: (typeof PIPELINE_STAGE_KINDS)[number] }>;
export type CrmDealTable = Refine<G.CrmDealTable, { currency: Generated<(typeof DEAL_CURRENCIES)[number]> }>;
// A quote of a deal (#2693): a draft until a person sends it (crm.quote.send, #2694); the status, the number and the sent columns change only through the guard trigger's transitions.
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'superseded'] as const;
export const QUOTE_SENT_VIA = ['link', 'email'] as const;
export const QUOTE_LINE_KINDS = ['item', 'text'] as const;
export type CrmQuoteTable = Refine<
  G.CrmQuoteTable,
  { status: Generated<(typeof QUOTE_STATUSES)[number]>; sent_via: (typeof QUOTE_SENT_VIA)[number] | null }
>;
export type CrmQuoteLineTable = Refine<G.CrmQuoteLineTable, { kind: (typeof QUOTE_LINE_KINDS)[number] }>;
// The sales order of an accepted quote (#2696, ADR-0050): confirmed until a person cancels it; a person records how the customer's yes arrived.
export const SALES_ORDER_STATUSES = ['confirmed', 'cancelled'] as const;
export const QUOTE_ACCEPTED_VIA = ['chat', 'email', 'phone', 'in_person', 'other'] as const;
export type CrmSalesOrderTable = Refine<
  G.CrmSalesOrderTable,
  { status: Generated<(typeof SALES_ORDER_STATUSES)[number]>; accepted_via: (typeof QUOTE_ACCEPTED_VIA)[number] | null }
>;
// The delivery of a sales order line (Q4b, #2697): a delivery or the reversal of one (the same set as the CHECK constraint, compared by check-unions.db.test.ts).
export const SALES_ORDER_DELIVERY_KINDS = ['delivery', 'reversal'] as const;
export type CrmSalesOrderDeliveryTable = Refine<G.CrmSalesOrderDeliveryTable, { kind: (typeof SALES_ORDER_DELIVERY_KINDS)[number] }>;
export type CrmSalesOrderLineTable = Refine<G.CrmSalesOrderLineTable, { kind: (typeof QUOTE_LINE_KINDS)[number] }>;
// The next step a stale deal raises (#2381): why it was raised, whether it is open, done by a person or closed by the deal's own change, and why it
// closed. Written by the stale-deal rule (system context) and by the commands that mark it done, snooze it or close it.
export const DEAL_NEXT_STEP_REASONS = ['no_activity', 'past_close', 'quote_unanswered', 'quote_expiring'] as const;
export const DEAL_NEXT_STEP_STATUSES = ['open', 'done', 'closed'] as const;
export const DEAL_NEXT_STEP_CLOSE_REASONS = ['deal_edited', 'deal_moved', 'deal_closed', 'quote_decided'] as const;
export type CrmDealNextStepTable = Refine<
  G.CrmDealNextStepTable,
  {
    reason: (typeof DEAL_NEXT_STEP_REASONS)[number];
    status: Generated<(typeof DEAL_NEXT_STEP_STATUSES)[number]>;
    closed_reason: (typeof DEAL_NEXT_STEP_CLOSE_REASONS)[number] | null;
  }
>;
// Contact import staging (#2229): a batch is staged until it is committed, cancelled or expired; a row is classified as
// new, a duplicate of a party or of an earlier row, a conflict between two parties, or invalid.
export const IMPORT_BATCH_STATUSES = ['staged', 'committed', 'cancelled', 'expired'] as const;
export const IMPORT_ON_DUPLICATE_CHOICES = ['skip', 'fill_empty'] as const;
export const IMPORT_ROW_OUTCOMES = ['new', 'duplicate', 'conflict', 'invalid'] as const;
// What the company cell of a staged person's row came to (#2438).
export const IMPORT_ROW_COMPANY_STATES = ['none', 'matched', 'new', 'in_file', 'unknown_tax_code', 'ambiguous'] as const;
export type CrmImportBatchTable = Refine<
  G.CrmImportBatchTable,
  { status: Generated<(typeof IMPORT_BATCH_STATUSES)[number]>; on_duplicate: Generated<(typeof IMPORT_ON_DUPLICATE_CHOICES)[number]> }
>;
export type CrmImportRowTable = Refine<
  G.CrmImportRowTable,
  { kind: Generated<(typeof PARTY_KINDS)[number]>; outcome: (typeof IMPORT_ROW_OUTCOMES)[number]; company_state: Generated<(typeof IMPORT_ROW_COMPANY_STATES)[number]> }
>;
// The conversation core (#2303): a thread is a comment thread or a private message, and is new until a member answers, pending
// while the customer has not, resolved when a person closes it; an outbound message is queued, sending, sent, failed or unknown.
export const CONVERSATION_KINDS = ['comment_thread', 'direct', 'email'] as const;
export const CONVERSATION_STATUSES = ['new', 'pending', 'resolved'] as const;
// The intent a person applies to a conversation (CV3, #2306); what the AI coworker suggests is never stored, only this decision is.
export const CONVERSATION_INTENTS = ['question', 'order_or_price', 'complaint', 'invoice_request', 'spam'] as const;
export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;
export const MESSAGE_AUTHOR_KINDS = ['contact', 'member', 'system'] as const;
export const MESSAGE_SEND_STATES = ['queued', 'sending', 'sent', 'failed', 'unknown'] as const;
export const MESSAGE_HIDE_REQUESTS = ['hide', 'unhide'] as const;
export type ConversationTable = Refine<
  G.KernelConversationTable,
  { kind: (typeof CONVERSATION_KINDS)[number]; status: Generated<(typeof CONVERSATION_STATUSES)[number]>; intent: (typeof CONVERSATION_INTENTS)[number] | null }
>;
export type ConversationMessageTable = Refine<
  G.KernelConversationMessageTable,
  {
    kind: (typeof CONVERSATION_KINDS)[number];
    direction: (typeof MESSAGE_DIRECTIONS)[number];
    author_kind: (typeof MESSAGE_AUTHOR_KINDS)[number];
    send_state: (typeof MESSAGE_SEND_STATES)[number] | null;
    hide_request: (typeof MESSAGE_HIDE_REQUESTS)[number] | null;
  }
>;
// A customer's image of a message (#2357): pending while only the platform's address is known, stored once its bytes are.
export const ATTACHMENT_STATES = ['pending', 'stored'] as const;
export const ATTACHMENT_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
// Vy's reply draft of a thread (#2310): asked for (requested), written (live), then used, discarded or made stale by a newer customer message.
export const DRAFT_STATES = ['requested', 'live', 'used', 'discarded', 'stale'] as const;
export const DRAFT_SOURCES = ['auto', 'asked'] as const;
export type ConversationDraftTable = Refine<
  G.KernelConversationDraftTable,
  { kind: (typeof CONVERSATION_KINDS)[number]; source: (typeof DRAFT_SOURCES)[number]; state: Generated<(typeof DRAFT_STATES)[number]> }
>;
// The inbox (#2306): the marker of a member typing a reply to a thread (its kind is the thread's), and a member's availability for new conversations.
export const MEMBER_AVAILABILITY_STATUSES = ['available', 'away'] as const;
export type ConversationComposingTable = Refine<G.KernelConversationComposingTable, { kind: (typeof CONVERSATION_KINDS)[number] }>;
export type MemberPermissionOverrideTable = Refine<G.KernelMemberPermissionOverrideTable, { permission: (typeof MEMBER_PERMISSION_OVERRIDE_PERMISSIONS)[number] }>;
export type MemberVyTableTable = Refine<G.KernelMemberVyTableTable, { mode: (typeof MEMBER_VY_TABLE_MODES)[number] }>;
export type McpMemberTableTable = Refine<G.KernelMcpMemberTableTable, { mode: (typeof MCP_MEMBER_TABLE_MODES)[number] }>;
export type PermissionDefaultTable = Refine<G.KernelPermissionDefaultTable, { base_role: MemberRole }>;
export type MemberVyResultTable = Refine<G.KernelMemberVyResultTable, { status: Generated<MemberVyResultStatus> }>;
export type MemberAvailabilityTable = Refine<G.KernelMemberAvailabilityTable, { status: Generated<(typeof MEMBER_AVAILABILITY_STATUSES)[number]> }>;
export type ConversationAttachmentTable = Refine<
  G.KernelConversationAttachmentTable,
  { kind: (typeof CONVERSATION_KINDS)[number]; state: Generated<(typeof ATTACHMENT_STATES)[number]>; content_type: (typeof ATTACHMENT_CONTENT_TYPES)[number] | null }
>;
// Bookings of the public booking page (#1318): requested, then confirmed or refused by the worker.
export const BOOKING_STATUSES = ['pending', 'confirmed', 'refused', 'cancelled'] as const;
export const BOOKING_REFUSALS = ['taken', 'unavailable'] as const;
// The Google Meet of a booking (C7, #1375).
export const BOOKING_MEETING_STATES = ['none', 'pending', 'ready', 'failed'] as const;
// A visitor's ask from a manage link (#1319), and the worker's answer to it.
export const BOOKING_MANAGE_ACTIONS = ['cancel', 'move'] as const;
export const BOOKING_MANAGE_OUTCOMES = ['cancelled', 'moved', 'taken', 'unavailable'] as const;
export type CrmBookingTable = Refine<
  G.CrmBookingTable,
  {
    status: Generated<(typeof BOOKING_STATUSES)[number]>;
    refusal: (typeof BOOKING_REFUSALS)[number] | null;
    meeting_state: Generated<(typeof BOOKING_MEETING_STATES)[number]>;
    manage_action: (typeof BOOKING_MANAGE_ACTIONS)[number] | null;
    manage_outcome: (typeof BOOKING_MANAGE_OUTCOMES)[number] | null;
  }
>;

// The notes module (issue #1671, ADR-0037): a note is private to its author or shared with the org, and links to a
// party, a file, a purchase document, a journal entry or a booking (#1672).
export const NOTE_VISIBILITIES = ['private', 'org'] as const;
export const NOTE_LINK_TARGET_TYPES = ['kernel.party', 'kernel.file', 'finance.purchase_document', 'finance.journal_entry', 'crm.booking'] as const;
export type NotesNoteTable = Refine<G.NotesNoteTable, { visibility: Generated<(typeof NOTE_VISIBILITIES)[number]> }>;
export type NotesLinkTable = Refine<G.NotesLinkTable, { target_type: (typeof NOTE_LINK_TARGET_TYPES)[number] }>;
// A member's own to-do (#1673): open, done, handed over to a position (N5) or cancelled.
export const TODO_STATUSES = ['open', 'done', 'handed_over', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
export type NotesTodoTable = Refine<G.NotesTodoTable, { status: Generated<TodoStatus> }>;

// The ads module (#2217, ADR-0040): the level of a row of daily figures (the account, or one of its campaigns), how a sync
// of an ad account ended, and how it failed (the channel layer's typed errors).
export const AD_LEVELS = ['account', 'campaign'] as const;
export const AD_SYNC_RUN_STATUSES = ['ok', 'failed'] as const;
export const AD_ERROR_KINDS = ['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown'] as const;
export type AdErrorKind = (typeof AD_ERROR_KINDS)[number];
export type AdsAdAccountTable = Refine<G.AdsAdAccountTable, { last_error_kind: AdErrorKind | null }>;
export type AdsAdSpendDayTable = Refine<G.AdsAdSpendDayTable, { level: ColumnType<(typeof AD_LEVELS)[number], (typeof AD_LEVELS)[number], never> }>;
export type AdsAdSyncRunTable = Refine<
  G.AdsAdSyncRunTable,
  {
    status: ColumnType<(typeof AD_SYNC_RUN_STATUSES)[number], (typeof AD_SYNC_RUN_STATUSES)[number], never>;
    error_kind: ColumnType<AdErrorKind | null, AdErrorKind | null, never>;
  }
>;

// Running ads (#2294, ADR-0043): whose cap a row of ad_spend_cap is (the org's or one account's) and its period. Insert-only.
export const AD_CAP_SCOPES = ['org', 'account'] as const;
export const AD_CAP_PERIODS = ['daily', 'monthly'] as const;
export type AdsAdSpendCapTable = Refine<
  G.AdsAdSpendCapTable,
  {
    scope: ColumnType<(typeof AD_CAP_SCOPES)[number], (typeof AD_CAP_SCOPES)[number], never>;
    period: ColumnType<(typeof AD_CAP_PERIODS)[number], (typeof AD_CAP_PERIODS)[number], never>;
  }
>;

// A campaign draft (#2295, W1): its objective, where it stands (a draft, approved by an approved proposal, or discarded) and who wrote it.
export const AD_OBJECTIVES = ['traffic', 'engagement', 'messenger'] as const;
export const AD_DRAFT_STATUSES = ['draft', 'approved', 'discarded'] as const;
export const AD_DRAFT_ORIGINS = ['human', 'ai'] as const;
export type AdsAdCampaignDraftTable = Refine<
  G.AdsAdCampaignDraftTable,
  {
    objective: (typeof AD_OBJECTIVES)[number];
    status: Generated<(typeof AD_DRAFT_STATUSES)[number]>;
    origin: Generated<(typeof AD_DRAFT_ORIGINS)[number]>;
  }
>;

// A request to the AI coworker for a campaign draft (#2295, W1b): waiting, written (a draft exists) or none (a code says why).
export const AD_REQUEST_STATES = ['requested', 'written', 'none'] as const;
export type AdsAdCampaignRequestTable = Refine<
  G.AdsAdCampaignRequestTable,
  {
    objective: (typeof AD_OBJECTIVES)[number];
    state: Generated<(typeof AD_REQUEST_STATES)[number]>;
  }
>;

// The launch ledger (#2296, W2-2): where an approved plan's launch stands (queued until W2-3's writer runs it). The database's guard holds the moves.
export const AD_LAUNCH_STATES = ['queued', 'launching', 'live', 'needs_attention', 'stopped', 'failed', 'cancelled'] as const;
export type AdsAdLaunchTable = Refine<
  G.AdsAdLaunchTable,
  {
    state: Generated<(typeof AD_LAUNCH_STATES)[number]>;
  }
>;

// What a launch created at the platform (#2296, W2-3): the level of each object and what Ludy set it to (paused or archived; nothing here un-pauses). The
// database's guard holds who writes it.
export const AD_OBJECT_LEVELS = ['campaign', 'ad_set', 'creative', 'ad'] as const;
export const AD_OBJECT_STATUSES = ['paused', 'archived'] as const;
export type AdsAdObjectTable = Refine<
  G.AdsAdObjectTable,
  {
    level: (typeof AD_OBJECT_LEVELS)[number];
    configured_status: Generated<(typeof AD_OBJECT_STATUSES)[number]>;
  }
>;

// The revoke at the platform of a closed ads connection's token (#2296, W2-1): which token it was, where the obligation stands, how it ended or why it gave
// up, and the kinds of error a try ended in. Read only for tenant roles: the definers write it.
export const AD_TOKEN_KINDS = ['write', 'read_spend'] as const;
export const AD_REVOKE_STATES = ['pending', 'done', 'gave_up'] as const;
export const AD_REVOKE_HOWS = ['revoked', 'already_invalid', 'sandbox', 'shared_grant', 'reconnected'] as const;
export const AD_REVOKE_GIVE_UPS = ['attempts', 'age', 'unrevocable'] as const;
export const AD_REVOKE_ERROR_KINDS = ['rate_limited', 'transient', 'permission', 'bad_request', 'unknown'] as const;
export type AdsAdTokenRevokeTable = Refine<
  G.AdsAdTokenRevokeTable,
  {
    kind: (typeof AD_TOKEN_KINDS)[number];
    state: Generated<(typeof AD_REVOKE_STATES)[number]>;
    how_done: (typeof AD_REVOKE_HOWS)[number] | null;
    give_up: (typeof AD_REVOKE_GIVE_UPS)[number] | null;
    last_error_kind: (typeof AD_REVOKE_ERROR_KINDS)[number] | null;
  }
>;

// The HR module (#2530, payroll plan 6.1): an employee is active or ended; the terms of an employment name a contract type and a wage region (Decree 74/2024).
export const HR_EMPLOYEE_STATUSES = ['active', 'ended'] as const;
export const HR_CONTRACT_TYPES = ['indefinite', 'fixed_term', 'none'] as const;
export const HR_REGIONS = ['I', 'II', 'III', 'IV'] as const;
export const HR_PAY_FUNCTIONS = ['admin', 'sales', 'production', 'overhead', 'construction'] as const;
// A bank template (#2532): the entity is filled by the trigger b_legal_entity (the one the writer names or the org's default); the layout is a JSON object checked by the database.
export type HrPayrollBankTemplateTable = Refine<G.HrPayrollBankTemplateTable, { legal_entity_id: LegalEntityColumn }, 'legal_entity_id'>;
export type HrPayrollEmployeeTable = Refine<G.HrPayrollEmployeeTable, { status: Generated<(typeof HR_EMPLOYEE_STATUSES)[number]> }>;
export type HrPayrollEmploymentTable = Refine<
  G.HrPayrollEmploymentTable,
  { contract_type: ColumnType<(typeof HR_CONTRACT_TYPES)[number], (typeof HR_CONTRACT_TYPES)[number], never>; region: ColumnType<(typeof HR_REGIONS)[number], (typeof HR_REGIONS)[number], never>; pay_function: ColumnType<(typeof HR_PAY_FUNCTIONS)[number], (typeof HR_PAY_FUNCTIONS)[number] | undefined, never> }
>;
// The pay run (#2531): a run is a draft until a person approves it; the posting and payment builds (#2532) take it on to paid and closed. A line is a pay line or a signed adjustment, and
// is calculated or refused by the calculator.
export const HR_RUN_STATUSES = ['draft', 'approved', 'paid', 'closed'] as const;
export const HR_LINE_KINDS = ['pay', 'adjustment'] as const;
export const HR_LINE_STATUSES = ['calculated', 'refused'] as const;
export type HrPayrollRunTable = Refine<G.HrPayrollRunTable, { status: Generated<(typeof HR_RUN_STATUSES)[number]> }>;
export type HrPayrollLineTable = Refine<
  G.HrPayrollLineTable,
  { kind: ColumnType<(typeof HR_LINE_KINDS)[number], (typeof HR_LINE_KINDS)[number] | undefined, never>; status: Generated<(typeof HR_LINE_STATUSES)[number]> }
>;

// The meetings module (#2576, ADR-0047): recorded meetings with consent records, retention dates and reader permissions.
export const MEETING_VISIBILITIES = ['attendees', 'org'] as const;
export type MeetingVisibility = (typeof MEETING_VISIBILITIES)[number];
export const MEETING_LANGUAGES = ['vi', 'en'] as const;
export type MeetingLanguage = (typeof MEETING_LANGUAGES)[number];
export const MEETING_STATUSES = ['ready', 'processing', 'completed', 'error'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
export const MEETING_CONSENT_METHODS = ['told_at_start', 'in_invite', 'in_writing', 'in_call_chat'] as const;
export type MeetingConsentMethod = (typeof MEETING_CONSENT_METHODS)[number];
// Why a recording stopped without the recorder's own click (A1, #3159): a code, never text.
export const MEETING_RECORDING_STOP_REASONS = ['tab_closed', 'mic_lost', 'permission_lost', 'storage_full', 'left_screen', 'unknown'] as const;
export type MeetingRecordingStopReason = (typeof MEETING_RECORDING_STOP_REASONS)[number];

export type MeetingsMeetingTable = Refine<
  G.MeetingsMeetingTable,
  {
    visibility: Generated<MeetingVisibility>;
    language: Generated<MeetingLanguage>;
    status: Generated<MeetingStatus>;
    consent_method: MeetingConsentMethod;
    recording_stop_reason: ColumnType<MeetingRecordingStopReason | null, MeetingRecordingStopReason | null | undefined, MeetingRecordingStopReason | null>;
  }
>;

// The transcript of a meeting (#2578): a segment is a draft, the recorder's own copy, until the recorder publishes it.
export const TRANSCRIPT_STAGES = ['draft', 'published'] as const;
export type TranscriptStageValue = (typeof TRANSCRIPT_STAGES)[number];

export type MeetingsTranscriptSegmentTable = Refine<
  G.MeetingsTranscriptSegmentTable,
  {
    stage: ColumnType<TranscriptStageValue, TranscriptStageValue | undefined, never>;
  }
>;

// The summary and the action items of a meeting (#2580): a row is a draft, the recorder's own, until the recorder publishes it.
export const MEETING_RESULT_STAGES = ['draft', 'published'] as const;
export type MeetingResultStage = (typeof MEETING_RESULT_STAGES)[number];
export const MEETING_RESULT_FEATURES = ['manual', 'meetings.summary', 'meetings.live_notes'] as const;
export type MeetingResultFeature = (typeof MEETING_RESULT_FEATURES)[number];
export const ACTION_ITEM_STATUSES = ['suggested', 'accepted'] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export type MeetingsMeetingResultTable = Refine<
  G.MeetingsMeetingResultTable,
  {
    feature: MeetingResultFeature;
    stage: Generated<MeetingResultStage>;
  }
>;

// status is written only by crove_meetings.action_item_accept (the generated type keeps it NotGranted for update).
export type MeetingsActionItemTable = Refine<
  G.MeetingsActionItemTable,
  {
    stage: Generated<MeetingResultStage>;
    status: Generated<ActionItemStatus>;
  }
>;

type Refined = Tables<{
  'crove_ads.ad_account': AdsAdAccountTable;
  'crove_ads.ad_campaign_draft': AdsAdCampaignDraftTable;
  'crove_ads.ad_campaign_request': AdsAdCampaignRequestTable;
  'crove_ads.ad_launch': AdsAdLaunchTable;
  'crove_ads.ad_object': AdsAdObjectTable;
  'crove_ads.ad_spend_cap': AdsAdSpendCapTable;
  'crove_ads.ad_spend_day': AdsAdSpendDayTable;
  'crove_ads.ad_sync_run': AdsAdSyncRunTable;
  'crove_ads.ad_token_revoke': AdsAdTokenRevokeTable;
  'crove_crm.booking': CrmBookingTable;
  'crove_crm.deal': CrmDealTable;
  'crove_crm.deal_next_step': CrmDealNextStepTable;
  'crove_crm.event_type': CrmEventTypeTable;
  'crove_crm.import_batch': CrmImportBatchTable;
  'crove_crm.import_row': CrmImportRowTable;
  'crove_crm.pipeline_stage': CrmPipelineStageTable;
  'crove_crm.quote': CrmQuoteTable;
  'crove_crm.quote_line': CrmQuoteLineTable;
  'crove_crm.sales_order': CrmSalesOrderTable;
  'crove_crm.sales_order_delivery': CrmSalesOrderDeliveryTable;
  'crove_crm.sales_order_line': CrmSalesOrderLineTable;
  'crove_hr.payroll_bank_template': HrPayrollBankTemplateTable;
  'crove_hr.payroll_employee': HrPayrollEmployeeTable;
  'crove_hr.payroll_employment': HrPayrollEmploymentTable;
  'crove_hr.payroll_line': HrPayrollLineTable;
  'crove_hr.payroll_run': HrPayrollRunTable;
  'crove_meetings.action_item': MeetingsActionItemTable;
  'crove_meetings.meeting': MeetingsMeetingTable;
  'crove_meetings.meeting_result': MeetingsMeetingResultTable;
  'crove_meetings.transcript_segment': MeetingsTranscriptSegmentTable;
  'crove_notes.link': NotesLinkTable;
  'crove_notes.note': NotesNoteTable;
  'crove_notes.todo': NotesTodoTable;
  'crove_kernel.calendar_connection': CalendarConnectionTable;
  'crove_kernel.calendar_event': CalendarEventTable;
  'crove_kernel.calendar_event_link': CalendarEventLinkTable;
  'crove_kernel.legal_entity': LegalEntityTable;
  'crove_kernel.number_series_policy': NumberSeriesPolicyTable;
  'crove_kernel.role': RoleTable;
  'crove_kernel.role_assignment': RoleAssignmentTable;
  'crove_kernel.tax_obligation_done': TaxObligationDoneTable;
  'crove_kernel.tax_profile': TaxProfileTable;
  'crove_kernel.tenant': TenantTable;
  'crove_kernel.tenant_member': TenantMemberTable;
  'crove_kernel.member_invite': MemberInviteTable;
  'crove_kernel.audit_event': AuditEventTable;
  'crove_kernel.party': PartyTable;
  'crove_kernel.file': FileTable;
  'crove_kernel.file_upload': FileUploadTable;
  'crove_kernel.extraction': ExtractionTable;
  'crove_kernel.notification': NotificationTable;
  'crove_kernel.inbox_item': InboxItemTable;
  'crove_kernel.record_le': RecordLeTable;
  'crove_kernel.proposal': ProposalTable;
  'crove_kernel.agent_template': AgentTemplateTable;
  'crove_kernel.agent': AgentTable;
  'crove_kernel.position': PositionTable;
  'crove_kernel.ai_run': AiRunTable;
  'crove_kernel.task': TaskTable;
  'crove_kernel.task_comment': TaskCommentTable;
  'crove_kernel.agent_wakeup': AgentWakeupTable;
  'crove_kernel.kill_switch': KillSwitchTable;
  'crove_kernel.budget_policy': BudgetPolicyTable;
  'crove_kernel.channel_connection': ChannelConnectionTable;
  'crove_kernel.conversation': ConversationTable;
  'crove_kernel.conversation_message': ConversationMessageTable;
  'crove_kernel.conversation_attachment': ConversationAttachmentTable;
  'crove_kernel.conversation_composing': ConversationComposingTable;
  'crove_kernel.conversation_draft': ConversationDraftTable;
  'crove_kernel.external_call': ExternalCallTable;
  'crove_kernel.member_availability': MemberAvailabilityTable;
  'crove_kernel.member_permission_override': MemberPermissionOverrideTable;
  'crove_kernel.member_vy_result': MemberVyResultTable;
  'crove_kernel.member_vy_table': MemberVyTableTable;
  'crove_kernel.mcp_member_table': McpMemberTableTable;
  'crove_kernel.permission_default': PermissionDefaultTable;
  'crove_kernel.mail_message': MailMessageTable;
  'crove_kernel.mail_suppression': MailSuppressionTable;
  'crove_kernel.mail_event': MailEventTable;
  'crove_kernel.org_usage': OrgUsageTable;
  'crove_kernel.today_mail': TodayMailTable;
  'crove_kernel.usage_deferral': UsageDeferralTable;
  'crove_finance.purchase_document': PurchaseDocumentTable;
  'crove_finance.journal_entry': JournalEntryTable;
  'crove_finance.org_account': OrgAccountTable;
  'crove_finance.cash_voucher': CashVoucherTable;
  'crove_finance.fixed_asset': FixedAssetTable;
  'crove_finance.bank_party_rule': BankPartyRuleTable;
  'crove_finance.einvoice_draft': EInvoiceDraftTable;
  'crove_finance.einvoice_connection': EInvoiceConnectionTable;
  'crove_finance.marketplace_connection': MarketplaceConnectionTable;
  'crove_finance.stock_item': StockItemTable;
  'crove_finance.channel_order': ChannelOrderTable;
  'crove_finance.channel_order_line': ChannelOrderLineTable;
  'crove_finance.channel_settlement': ChannelSettlementTable;
  'crove_finance.channel_settlement_line': ChannelSettlementLineTable;
  'crove_finance.stock_alias': StockAliasTable;
  'crove_finance.household_profile': HouseholdProfileTable;
  'crove_finance.household_threshold': HouseholdThresholdTable;
  'crove_finance.household_trade_rate': HouseholdTradeRateTable;
  'crove_finance.household_expense_group_map': HouseholdExpenseGroupMapTable;
  'crove_finance.household_form_version': HouseholdFormVersionTable;
  'crove_finance.stock_move': StockMoveTable;
  'crove_finance.stock_period': StockPeriodTable;
  'crove_finance.stock_period_item': StockPeriodItemTable;
  'crove_finance.stock_count': StockCountTable;
  'crove_finance.stock_count_line': StockCountLineTable;
  'crove_finance.categorization_rule': CategorizationRuleTable;
  'crove_finance.chart': ChartTable;
  'crove_finance.legal_entity_books': LegalEntityBooksTable;
  'crove_finance.input_vat_check': InputVatCheckTable;
  'crove_finance.vat_return_filed': VatReturnFiledTable;
  'crove_finance.journal_voucher': JournalVoucherTable;
  'crove_finance.portal_invoice_list': PortalInvoiceListTable;
  'crove_finance.portal_invoice_row': PortalInvoiceRowTable;
  'crove_finance.bank_line': BankLineTable;
  'crove_finance.depreciation_line': DepreciationLineTable;
  'crove_finance.purchase_line': PurchaseLineTable;
  'crove_finance.purchase_tax_rate': PurchaseTaxRateTable;
  'crove_finance.purchase_document_void': PurchaseDocumentVoidTable;
  'crove_social.post': SocialPostTable;
  'crove_social.post_variant': SocialPostVariantTable;
  'crove_social.post_approval': SocialPostApprovalTable;
  'crove_social.review_feedback': SocialReviewFeedbackTable;
  'crove_social.review_link': SocialReviewLinkTable;
  'crove_social.account_snapshot': SocialAccountSnapshotTable;
  'crove_social.external_import': SocialExternalImportTable;
  'crove_social.link_preview': SocialLinkPreviewTable;
  'crove_social.channel_option': SocialChannelOptionTable;
  'crove_social.notification': SocialNotificationTable;
  'crove_social.notification_mute': SocialNotificationMuteTable;
  'crove_social.calendar_note': SocialCalendarNoteTable;
  'crove_social.media_attribution': SocialMediaAttributionTable;
  'crove_social.watermark': SocialWatermarkTable;
  'crove_social.chat_alert': SocialChatAlertTable;
  'crove_social.label': SocialLabelTable;
  'crove_social.idea': SocialIdeaTable;
  'crove_social.report_schedule': SocialReportScheduleTable;
  'crove_social.report_link': SocialReportLinkTable;
  'crove_social.report_schedule_run': SocialReportScheduleRunTable;
  'crove_social.banned_word': SocialBannedWordTable;
  'crove_social.post_comment': SocialPostCommentTable;
}>;

// Every table crove_tenant may read: the generated table type, or its refinement above.
export type Database = { [K in keyof G.Database]: K extends keyof Refined ? Refined[K] : G.Database[K] };

// SPDX-License-Identifier: AGPL-3.0-only
// The AI budget meter (#2382): every model call of Ludy goes through `metered`, which asks the deployment's meter
// whether the org may spend before the call and tells it what the call used after. At 100% of a budget the meter
// refuses a new call with AiBudgetExhaustedError; calls already in flight finish. The meter itself (the ledger, the
// budgets, the notices) lives in the kernel; this file is the one door to the model, so nothing can reach the endpoint
// without passing it:
//   - a call names its feature from AI_FEATURES, which also says which module's budget it counts against;
//   - the org (and the agent, when an agent run makes the call) and the meter that speaks for the caller's authority
//     (the API's user context, the worker's system context) come from the scope the caller entered with `withAiScope`,
//     never from a parameter the call could leave out; a call outside a scope is refused.
// packages/agent/test/meter-coverage.test.ts fails when a model call is made anywhere else, or a feature is not here.
// What the meter is given is ids, the feature key and the tokens the provider reported: never a prompt, the text of a
// document or a model's answer.
import { AsyncLocalStorage } from 'node:async_hooks';
import { NoObjectGeneratedError } from 'ai';
import { Decimal } from '@ludy/l10n-vn';

// Every use of a model, by feature key ('<module>.<what>'), with the module whose budget it counts against. A new use
// (Marketing's campaign drafts, Vy's reply drafts, the daily brief) is added here first.
export const AI_FEATURES = {
  'finance.invoice_extract': 'finance',
  'social.draft': 'social',
  'social.rewrite': 'social',
  'social.hashtags': 'social',
  'social.alt_text': 'social',
  'social.ideas': 'social',
  'social.summary': 'social',
  'crm.booking_schedule': 'crm',
  // The reply drafts of the conversation core (CV8, #2310).
  'conversation.draft': 'conversation',
  // Vy's daily brief on Home (#2383): it spans the apps, so it counts against the kernel's own budget line.
  'today.brief': 'kernel',
  // Vy's "Tuần này" on Home (#3257, Vy plan C5): the status of the last 7 days written from figures that code computed in the member's own context, and dropped sentence by sentence when it states a number they do not hold.
  'today.weekly': 'kernel',
  // The AI coworker's campaign drafts for running ads (W1b, #2295): the creative part only, never money.
  'ads.campaign_draft': 'ads',
  // The Inbox's suggestions (CV3, #2306): the intent of a conversation, and which contact a customer most likely is.
  'conversation.intent': 'conversation',
  'conversation.contact_rank': 'conversation',
  // The finance coworker's wording of a payment reminder (#2488): the lead-in and the closing only, never a fact of the books.
  'finance.payment_reminder': 'finance',
  // The meetings coworker's wording of a follow-up email after a meeting (L3, #2590): the lead-in and the closing only, told none of the meeting's content.
  'meetings.followup_words': 'meetings',
  // The finance coworker's sentence on the Kế toán overview (#2631): written from the aggregated figures only, and dropped when it states a number they do not hold.
  'finance.overview_explain': 'finance',
  // The finance coworker's note on the month-close checklist: it puts the open items in the order to do them and says why, told which items are open and no count or date; refused when it states a number, a date, a link, a promise or a done step, or when its order is not exactly the open items.
  'finance.month_close_explain': 'finance',
  // The finance coworker's possible reason per flagged expense line on the expense variance card (#4392): code found which costs moved and who is behind them; the model is told no figure at all (a fixed kind of expense, the direction, a supplier name when it may be told, the kind of voucher, single or several) and a note is dropped when it states any number, date or name it was not given, claims certainty or is not marked as a possibility. A read; a person decides.
  'finance.expense_variance_note': 'finance',
  // The accounting coworker's note on the 30/60/90-day cash forecast (#4391): written from the figures and dates code computed, in words only (it states no figure and no date, the card carries them), and refused
  // when it holds a digit, a link, advice about money or a promise.
  'finance.cash_forecast_explain': 'finance',
  // The finance coworker's sentence naming the late sales invoices of a VAT working and their original periods (#3540): written from invoice numbers and periods only, dropped when it names one that is not in the lists.
  'finance.vat_late_explain': 'finance',
  // The finance coworker on stock (#2514): which item of the org a line of an invoice or an order is most likely about (it only suggests; a person confirms), and the wording of a reorder
  // message to a supplier from the item names and quantities it was given (a figure, link or address it was not given refuses the text).
  'finance.stock_match': 'finance',
  'finance.stock_reorder': 'finance',
  // The finance coworker on a sales e-invoice draft (#2505): the lines, the VAT rate the text states and the customer it is for, proposed from a text a person typed or pasted. A figure the text
  // does not hold, or a rate the invoice date does not allow, refuses the proposal; a person reads the whole draft and issues it.
  'finance.einvoice_draft': 'finance',
  // The accounting coworker's plain-Vietnamese reason for the VAT rate a correcting e-invoice proposes (#3709): code decided the basis and the rate, a person confirms; the model is told the nature, two
  // dates and the rates only, and its text is refused when it states a figure or a rate the facts do not hold.
  'finance.einvoice_rate_explain': 'finance',
  // The accounting coworker's plain-Vietnamese explanation of the surplus of a count of stock (#3712 slice 2b): code reads the items, the amount and the supplier the goods were last received
  // from, and its text is refused when it states a figure the facts do not hold, advises an account or claims a step was done.
  'finance.stock_surplus_explain': 'finance',
  // The accounting coworker's proposal of the reason code of an adjusting or replacing e-invoice (#3690): the model answers a number into the list of Appendix XVII codes it is shown, so a code outside
  // the list cannot come out; its one-line why is refused when it states a figure the note, the lines or the labels do not hold. A person confirms by starting the correction.
  'finance.einvoice_reason_suggest': 'finance',
  // The finance coworker on payroll (#2534): prepare the month from the diff of last month, put the anomalies code found in a sentence, explain one payslip. The model sees the pseudonymized sheet only
  // (an alias per employee, fixed component labels and amounts); every text is refused when it states a figure it was not given, and a person decides.
  'finance.payroll_prepare': 'finance',
  'finance.payroll_flag': 'finance',
  'finance.payroll_explain': 'finance',
  // The finance coworker's pre-export compliance review for Sổ quản lý lao động and Báo cáo 01/PLI (#3372): code computes every finding and count, and the model summarizes pseudonymized readiness.
  'finance.labor_check': 'finance',
  // The finance coworker's one line on why a bank statement line may be a payroll payment (#2532): code decided by the amount, the model only words it from the kind, month, amount and date (no name, no
  // description, no account); a line that states a figure it was not given is refused, and a person asks for the payment and approves it.
  'finance.bank_match_explain': 'finance',
  // The finance coworker's one line on the Sàn screen (#2516 slice E): code read the facts from the books (settlements waiting to be posted, what the platforms owe, fees awaiting an invoice), the model
  // only words them from those four numbers; a line that states a figure it was not given, a link, or says something was posted, approved or paid is refused. A read, never a post.
  'finance.marketplace_line': 'finance',
  // The finance coworker's one line above the received invoices to pay (#3113 S4c): code read the facts (how many invoices wait, their total, the oldest date, how many are of a supplier whose bank account
  // changed recently), the model only words them; a line that states a figure it was not given, a link, advice, or says something was paid or sent is refused. A read, it asks for no payment.
  'finance.supplier_payable_line': 'finance',
  // The finance coworker's one line above the MISA export check (#3848 slice B): code ran the deterministic check over the rows of the file and counted what it found per kind, the model only explains those
  // counts (what each kind means in MISA and how to fix it in Ludy); a line that states a number it was not given, sets a count against the wrong kind, has a link or says something was fixed is refused. A read.
  'finance.misa_check_line': 'finance',
  // The finance coworker's notes on the AMIS preview (#3904, S5 of #3854): code built the preview and listed its blockers, the model only words what each KIND of blocker on the list means in AMIS and how to fix it in Ludy,
  // told the set of kinds and nothing else (no count, voucher, item or party); a note with a number, a link, a claim that something was done or a promise is dropped. A read: the list decides, a person sends.
  'finance.misa_amis_blocker_notes': 'finance',
  // The finance coworker's notes under the Sàn table (#3711 slice 7): code read, per platform, the fees waiting on its 331, how old the oldest is and whether that is past one settlement cycle; the model only
  // words what that means, told those figures per numbered row and no platform name; a note with a number that is not its row's, a name, a link, a claim that something was done or a promise is dropped. A read.
  'finance.marketplace_fee_note': 'finance',
  // The finance coworker's note on a pending marketplace settlement or payout proposal (#4389): code read the stored proposal and computed every figure in whole dong; the model words them in at most three sentences, told no platform, party, order, buyer or date; a text with a number that is not given, a link, a claim that something was done, a promise or advice on an account is refused as a whole and the screen shows a fixed template. A read.
  'finance.marketplace_proposal_note': 'finance',
  // The finance coworker's proposal for which standard field each column of a marketplace order report is, when no profile knows its header (#3850): told only the header texts and masked sample shapes of the
  // columns that are not buyer data; the proposal is read against the real file by code and confirmed by a person. A read.
  'finance.stock_columns': 'finance',
  // The sales coworker's guess at the company a contact works at (#2438): only ranks the companies whose name matches the address a contact writes from.
  'crm.company_rank': 'crm',
  // The sales coworker's proposal for the lines of a quote (#2698): from the deal, what the customer wrote and the earlier quotes to them; a price no source holds stays empty, and a person applies each line.
  'crm.quote_suggest': 'crm',
  // The sales coworker's lead-in and closing of a follow-up message about a quiet deal or an unanswered quote (#3101): told none of the facts (the name, the quote, the total, the link and the days are
  // composed by code), and its words are refused when they hold a figure, a link or a name; a person reads, edits and sends the message.
  'crm.followup_draft': 'crm',
  // The sales coworker's brief before a booking linked to a deal (#3115): a short summary and 2 to 3 points to raise, written from the deal, its latest sent quote and the customer's latest words that the member may read. Every figure, date and name in it must be one of the facts' own, or the brief is refused and the person reads the facts list alone; nothing is stored or sent.
  'crm.meeting_brief': 'crm',
  // Speech to text for the meetings module (#2578, M4a): one call per audio chunk of a meeting, through the deployment's OpenAI-compatible transcription endpoint.
  'meetings.transcribe': 'meetings',
  // The recorder's Vy summarizing one meeting (#2580, M6 part B2): one call over the transcript, the member waiting for it, through their own meter.
  'meetings.summary': 'meetings',
  // The member's Vy translating a meeting summary between Vietnamese and English (meetings integrations E1, #3184): one call over the summary, its decisions and item titles, the member waiting for it. A key of its own, so a translation never cuts off a transcription, a summary or live notes (#3029).
  'meetings.translate': 'meetings',
  // The member's Vy answering one question across the meetings the member reads (meetings integrations A3, #3161): one call over at most 40 transcript lines the member's own search found, the member waiting for it. A key of its own, so a question never cuts off a transcription, a summary, a translation or live notes (#3029). Nothing of the answer is stored.
  'meetings.ask': 'meetings',
  // The member's Vy writing the two or three sentences of the brief before a meeting (#3543): one call over at most 23 short facts the member's own reads found, the member waiting for it, through their own meter.
  'meetings.brief': 'meetings',
  // The member's Vy writing the few sentences of the weekly digest across meetings (#3949): one call over at most 60 short facts the member's own reads found, the member waiting for it, through their own meter.
  'meetings.digest': 'meetings',
  // The member's Vy naming who an action item belongs to from the name said in the meeting (#3921): one call over a name and at most 100 names, the member waiting for it, through their own meter.
  'meetings.assignee': 'meetings',
  // The recorder's Vy checking whether a meeting covered its agenda (#3959): one call over a short agenda and the transcript the recorder reads, the recorder waiting for it, through their own meter.
  'meetings.adherence': 'meetings',
  // The recorder's Vy writing the table of contents of one meeting (#3844): one call over the transcript, the member waiting for it, through their own meter.
  'meetings.chapters': 'meetings',
  // The recorder's Vy suggesting a title for one meeting (#3947): one call over the transcript, the member waiting for it, through their own meter.
  'meetings.title': 'meetings',
  // The recorder's Vy listing what each speaker committed to or decided (#3954): one call over the transcript, the member waiting for it, through their own meter.
  'meetings.commitments': 'meetings',
  // Vy's weekly status of one project (projects P6, #2597): transient 3 to 5 plain sentences from deterministic counts and task titles/comments only, never reading notes.
  'projects.weekly_status': 'projects',
  // Member-scoped Vy proposing project tasks from one note (projects P7, #2598, ADR-0049): one call over the note text and project members' active seats; nothing is created until explicit human confirmation.
  'projects.tasks_from_note': 'projects',
  // Member-scoped Vy proposing project tasks from a note, meeting, or conversation (#2608, ADR-0049): one call over caller-readable source text and project members' active seats; nothing is created until explicit human confirmation.
  'projects.tasks_from_source': 'projects',
  // Ly's pseudonymized recruiting screening brief and interview focus questions (#3403 Stage 3 slice 3b-1 / #3413): reads alias C1, role facts, readiness flags, and scrubbed untrusted notes only; never decides hire or reject.
  'hr.recruiting_brief': 'hr',
  // Vy (the general manager) proposing signing field placements on a draft eSign PDF (#3351): one call over page sizes, declared signer role keys and bounded page text per ask, the member waiting for it. A key of its own, so field proposals never cut off risky clause summaries or other AI features.
  'sign.field_propose': 'sign',
  // Vy (the general manager) summarizing risky clauses with exact verbatim quotes from a draft eSign PDF (#3351): one call over bounded page text per ask, the member waiting for it.
  'sign.clause_summary': 'sign',
  // Vy (the general manager) summarizing completed project tasks into 3 to 5 handover deliverable bullets for a draft eSign acceptance minutes PDF (#3812): one call over the project name and caller-readable completed tasks only, nothing persisted or sent automatically.
  'sign.acceptance_draft': 'sign',
  // Vy (the general manager) summarizing commercial and legal risk deltas between two PDF contract revisions (#3822): one call over bounded changed hunks, every delta citing verbatim quotes from v1 or v2.
  'sign.version_diff': 'sign',
  // Vy (the general manager) proposing customized Vietnamese SME contract clauses for human editing before PDF generation (#3822): one call over structured contract variables and plain-language instructions, neutralized against tag injection.
  'sign.contract_draft': 'sign',
  // Vy (the general manager) extracting post-signature renewal dates, contract value, auto-renewal notice window and milestone obligations from a completed eSign PDF (#3821): one call over bounded page text per ask, every term pinned to a verbatim quote and tainted until human confirmation.
  'sign.obligation_extract': 'sign',
  // Member-scoped Vy summarizing one readable note (notes N8, #1677, ADR-0049): stores a private member_vy_result until the author explicitly accepts it.
  'notes.summary': 'notes',
  // Member-scoped Vy suggesting personal to-dos from one readable note (notes N8, #1677, ADR-0049): stores private suggestions until the reader explicitly confirms them.
  'notes.todo_suggest': 'notes',
  // Member-scoped Vy daily focus planner & overdue reschedule suggestions on My Work (notes v2 T4b, #3563, ADR-0049): stores counts only; caller confirms every reschedule.
  'notes.todo_plan': 'notes',
  // Member-scoped Vy inbox organizer proposing notebooks & #tags for unfiled notes (notes v2 E5b, #3563, ADR-0049): stores counts only; caller confirms every move/tag update.
  'notes.organize': 'notes',
} as const satisfies Record<string, string>;
export type AiFeature = keyof typeof AI_FEATURES;
export const AI_FEATURE_KEYS = Object.keys(AI_FEATURES) as AiFeature[];

// The tokens one model call used, as the provider reported them (0 when it reported none).
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  // Speech to text (#2578): the seconds of audio the call transcribed, as the caller measured them. Absent for a call priced by tokens.
  audioSeconds?: number | undefined;
}
export type AiUsageSink = (usage: AiUsage) => void;

// Who a call is for: the org whose budget it counts against, the agent that made it, if one did, and the meter that asks
// the database in the caller's own authority.
export interface AiScope {
  orgId: string;
  agentId?: string | undefined;
  // Vy working for one member (ADR-0049 decision 6): the run this call belongs to. The member is the meter's own user and the agent is
  // the kernel's (the member's own Vy), never a value of the call.
  memberRunId?: string | undefined;
  meter: AiMeter;
}

export interface AiCall {
  feature: AiFeature;
  module: string;
  orgId: string;
  agentId: string | null;
  // Set for a call made by Vy in member mode: the run it belongs to, ids only.
  memberRunId?: string | null | undefined;
  // What the call is expected to use, when the caller knows it before the call (a transcription chunk's measured audio seconds): a meter may admit the call on its projected cost
  // (#2863 item 8). Absent for a call priced only by what the provider reports.
  expected?: AiUsage | undefined;
}

export interface AiMeter {
  // Before the call. Throws AiBudgetExhaustedError when a budget that covers it is spent.
  admit(call: AiCall): Promise<void>;
  // After the call, with what it used. A failure here never fails the call: the caller logs it.
  record(call: AiCall, usage: AiUsage): Promise<void>;
}

// A budget that covers the call is spent: the org's, the module's or the agent's. retryAt: when the month turns and
// the budget starts again (an owner can raise it sooner).
export class AiBudgetExhaustedError extends Error {
  readonly scope: 'org' | 'module' | 'agent';
  readonly retryAt: string | null;
  constructor(scope: 'org' | 'module' | 'agent', retryAt: string | null) {
    super(`AI budget spent (${scope})`);
    this.name = 'AiBudgetExhaustedError';
    this.scope = scope;
    this.retryAt = retryAt;
  }
}

// A call made outside withAiScope: refused, never sent unmetered.
export class AiMeterMissingError extends Error {
  constructor(feature: string) {
    super(`AI call ${feature} refused: it was made outside an AI scope`);
    this.name = 'AiMeterMissingError';
  }
}

const scopes = new AsyncLocalStorage<AiScope>();

// Runs fn with the org (and agent) its model calls count against. The API enters it per request, the worker per job.
export function withAiScope<T>(scope: AiScope, fn: () => Promise<T>): Promise<T> {
  return scopes.run(scope, fn);
}

// For the evals and the conformance suite, which measure the model itself against no org: calls count nowhere. Never
// import it from product code (meter-coverage.test.ts fails when something outside a test directory does).
export const UNMETERED: AiMeter = {
  admit: async () => {},
  record: async () => {},
};

function tokens(usage: { inputTokens: number | undefined; outputTokens: number | undefined; audioSeconds?: number | undefined } | undefined): AiUsage {
  const used: AiUsage = { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 };
  if (usage?.audioSeconds !== undefined) used.audioSeconds = usage.audioSeconds;
  return used;
}

// The one door to the model: `call` is the generateText call, made only once the meter admitted it. The caller's own
// sink (onUsage) sees the same tokens. Counts what the call used even when the answer was unusable (the model was paid
// for it); a call that failed before an answer counts nothing. `expected` is what the caller knows the call will use before it is made; the meter sees it in admit().
export async function metered<R extends { usage: { inputTokens: number | undefined; outputTokens: number | undefined; audioSeconds?: number | undefined } }>(
  feature: AiFeature,
  call: () => Promise<R>,
  onUsage?: AiUsageSink,
  expected?: AiUsage,
): Promise<R> {
  const scope = scopes.getStore();
  if (!scope) throw new AiMeterMissingError(feature);
  const { meter } = scope;
  const info: AiCall = { feature, module: AI_FEATURES[feature], orgId: scope.orgId, agentId: scope.agentId ?? null, memberRunId: scope.memberRunId ?? null };
  if (expected) info.expected = expected;
  await meter.admit(info);
  const settle = async (used: AiUsage) => {
    onUsage?.(used);
    try {
      await meter.record(info, used);
    } catch (error: unknown) {
      console.error(`[ai-meter] could not record a ${feature} call`, error instanceof Error ? error.name : typeof error);
    }
  };
  let result: R;
  try {
    result = await call();
  } catch (error: unknown) {
    if (NoObjectGeneratedError.isInstance(error) && error.usage) await settle(tokens(error.usage));
    throw error;
  }
  await settle(tokens(result.usage));
  return result;
}

// The estimated cost of calls in the deployment's price unit (AI_PRICE_*, per million tokens, and per minute of audio for speech to
// text), as a decimal string with 6 decimals. Without a price AI costs nothing to count: the budget then counts calls' tokens only
// through its report.
export function aiCost(usage: readonly AiUsage[], price: { inputPerMTok: string; outputPerMTok: string; audioPerMinute?: string | undefined } | undefined): string {
  if (!price) return '0';
  let tokenCost = new Decimal(0);
  let audioCost = new Decimal(0);
  for (const call of usage) {
    tokenCost = tokenCost.plus(new Decimal(call.inputTokens).times(price.inputPerMTok)).plus(new Decimal(call.outputTokens).times(price.outputPerMTok));
    if (call.audioSeconds !== undefined && price.audioPerMinute) audioCost = audioCost.plus(new Decimal(call.audioSeconds).dividedBy(60).times(price.audioPerMinute));
  }
  return tokenCost.dividedBy(1_000_000).plus(audioCost).toFixed(6);
}

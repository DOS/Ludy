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
import { Decimal } from '@crove/l10n-vn';

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
  // The AI coworker's campaign drafts for running ads (W1b, #2295): the creative part only, never money.
  'ads.campaign_draft': 'ads',
  // The Inbox's suggestions (CV3, #2306): the intent of a conversation, and which contact a customer most likely is.
  'conversation.intent': 'conversation',
  'conversation.contact_rank': 'conversation',
  // The finance coworker's wording of a payment reminder (#2488): the lead-in and the closing only, never a fact of the books.
  'finance.payment_reminder': 'finance',
  // The finance coworker's sentence on the Kế toán overview (#2631): written from the aggregated figures only, and dropped when it states a number they do not hold.
  'finance.overview_explain': 'finance',
  // The finance coworker on stock (#2514): which item of the org a line of an invoice or an order is most likely about (it only suggests; a person confirms), and the wording of a reorder
  // message to a supplier from the item names and quantities it was given (a figure, link or address it was not given refuses the text).
  'finance.stock_match': 'finance',
  'finance.stock_reorder': 'finance',
  // The finance coworker on a sales e-invoice draft (#2505): the lines, the VAT rate the text states and the customer it is for, proposed from a text a person typed or pasted. A figure the text
  // does not hold, or a rate the invoice date does not allow, refuses the proposal; a person reads the whole draft and issues it.
  'finance.einvoice_draft': 'finance',
  // The finance coworker on payroll (#2534): prepare the month from the diff of last month, put the anomalies code found in a sentence, explain one payslip. The model sees the pseudonymized sheet only
  // (an alias per employee, fixed component labels and amounts); every text is refused when it states a figure it was not given, and a person decides.
  'finance.payroll_prepare': 'finance',
  'finance.payroll_flag': 'finance',
  'finance.payroll_explain': 'finance',
  // The finance coworker's one line on why a bank statement line may be a payroll payment (#2532): code decided by the amount, the model only words it from the kind, month, amount and date (no name, no
  // description, no account); a line that states a figure it was not given is refused, and a person asks for the payment and approves it.
  'finance.bank_match_explain': 'finance',
  // The sales coworker's guess at the company a contact works at (#2438): only ranks the companies whose name matches the address a contact writes from.
  'crm.company_rank': 'crm',
  // The sales coworker's proposal for the lines of a quote (#2698): from the deal, what the customer wrote and the earlier quotes to them; a price no source holds stays empty, and a person applies each line.
  'crm.quote_suggest': 'crm',
  // Speech to text for the meetings module (#2578, M4a): one call per audio chunk of a meeting, through the deployment's OpenAI-compatible transcription endpoint.
  'meetings.transcribe': 'meetings',
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
// for it); a call that failed before an answer counts nothing.
export async function metered<R extends { usage: { inputTokens: number | undefined; outputTokens: number | undefined; audioSeconds?: number | undefined } }>(
  feature: AiFeature,
  call: () => Promise<R>,
  onUsage?: AiUsageSink,
): Promise<R> {
  const scope = scopes.getStore();
  if (!scope) throw new AiMeterMissingError(feature);
  const { meter } = scope;
  const info: AiCall = { feature, module: AI_FEATURES[feature], orgId: scope.orgId, agentId: scope.agentId ?? null, memberRunId: scope.memberRunId ?? null };
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

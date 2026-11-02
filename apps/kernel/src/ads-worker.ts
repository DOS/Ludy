// SPDX-License-Identifier: AGPL-3.0-only
// The worker side of the AI coworker's campaign drafts (W1b, issue #2295, plan docs/plan/ads-write.md section 10, ADR-0043). A member's request
// (ads.campaign.draft_request) emits an event the outbox relay turns into a job with ids only; the job reads the request through a system query, calls the
// model in packages/agent through the AI budget meter, and records the answer as a system command: a draft with origin `ai`, or a code that says why there
// is none. The model writes the creative part only; the dates and the daily budget are the module's rules (assembleDraft), so no model ever sets spend.
// Nothing the member wrote is logged or put in a job: ids and codes only.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { AiBudgetExhaustedError, withAiScope, type AdsCampaignWriter, type AiMeter, type CampaignDraftResult } from '@crove/agent';
import { zAdsCampaignPlanDraft, type AdsCampaignDraftSource } from '@crove/kernel-contract';
import type { Runtime } from '@crove/kernel-runtime';
import { assembleDraft } from '@crove/mod-ads';
import type { DraftBudget } from './ai-draft-limit.ts';

const SYSTEM = { type: 'system' as const, component: 'ads' };

export type AdsCampaignDraftJob = { orgId: string; requestId: string };

export interface AdsDraftDeps {
  runtime: Runtime;
  writer: Pick<AdsCampaignWriter, 'draft'>;
  // The AI budget meter (#2382) the model call counts against, as the system: the meter records each call, so this job records no cost of its own.
  meter?: AiMeter | undefined;
  // The existing per-minute budget of AI drafting (ai-draft-limit.ts): a model call is made only when it allows one for the org.
  budget?: DraftBudget | undefined;
}

// Writes one waiting request: what became of it, as a short word for the log ('written', 'none', 'rate', 'budget', 'error', or 'gone' when the
// request was settled or went while the job waited). A failure of the model call, a refusal and a draft the checks refused leave no draft (the member
// edits the brief and asks again): they are not retried, so a failing endpoint costs one call per request, not a loop.
export async function runAdsCampaignDraft(deps: AdsDraftDeps, job: AdsCampaignDraftJob): Promise<string> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const none = (code: string) => deps.runtime.execute('ads.campaign.draft_record', { requestId: job.requestId, outcome: 'none', code }, options);
  const source = await deps.runtime.query<AdsCampaignDraftSource | null>('ads.campaign.draft_source', { requestId: job.requestId }, options);
  if (!source) return 'gone';
  // The org's per-minute budget of AI drafts (a request a member made was already rationed per member by the API): over it, no draft now, and the member
  // can ask again. The ticket is per request, so the per-member part never refuses a job whose member the API already let through.
  const ticket = deps.budget?.take(job.orgId, `ads:${job.requestId}`);
  if (ticket && !ticket.allowed) {
    await none('RATE_LIMITED');
    return 'rate';
  }
  let result: CampaignDraftResult | null = null;
  let budgetSpent = false;
  try {
    const request = { objective: source.objective, brief: source.brief, language: 'vi' as const };
    // The call counts against the org's AI budget of the month (the meter records its cost and refuses the call when the budget is spent). The daily AI cost
    // limit bounds the invoice extraction queue and the replies' half of it, not this: a campaign draft is asked for by a member, rarely, and rationed below.
    result = deps.meter ? await withAiScope({ orgId: job.orgId, meter: deps.meter }, () => deps.writer.draft(request)) : await deps.writer.draft(request);
  } catch (error) {
    // The org's budget is spent (#2382): no draft now; the member writes the plan, and everything that needs no AI goes on.
    budgetSpent = error instanceof AiBudgetExhaustedError;
    // Any other failure (the model, the endpoint, the network): nothing of the error (it may quote the prompt) goes to the log.
  } finally {
    ticket?.release();
  }
  if (budgetSpent) {
    await none('AI_BUDGET');
    return 'budget';
  }
  if (!result) {
    await none('AI_ERROR');
    return 'error';
  }
  if (result.kind === 'none') {
    await none(result.code);
    return 'none';
  }
  const { plan, aiFields } = assembleDraft(source, result.plan);
  // A plan the contract refuses (a link that is not https, a name too long) is no draft: nothing is repaired.
  if (!zAdsCampaignPlanDraft.safeParse(plan).success) {
    await none('INVALID');
    return 'none';
  }
  const done = await deps.runtime.execute<{ recorded: boolean }>('ads.campaign.draft_record', { requestId: job.requestId, outcome: 'written', plan, aiFields }, options);
  return done.recorded ? 'written' : 'gone';
}

// A request made where this worker has no model (no AI endpoint is configured): settled at once as none, so the member sees why and nothing stays waiting
// with no job.
export async function failUnaskable(runtime: Runtime, job: AdsCampaignDraftJob): Promise<void> {
  await runtime.execute('ads.campaign.draft_record', { requestId: job.requestId, outcome: 'none', code: 'AI_OFF' }, { actor: SYSTEM, orgId: job.orgId });
}

// Requests the job never answered (ads.campaign_request_sweep, the worker login's): older than 15 minutes, settled as none (EXPIRED) so the member can ask
// again. The relay runs it whether or not a model is configured. Not more often than every ten seconds.
const SWEEP_MS = 10_000;
let lastSweep = 0;
export async function sweepAdsCampaignRequests(deps: { workerDb: Db; now?: () => number; force?: boolean }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastSweep < SWEEP_MS) return 0;
  lastSweep = now;
  const { rows } = await sql<{ settled: number }>`SELECT crove_ads.campaign_request_sweep() AS settled`.execute(deps.workerDb);
  return rows[0]?.settled ?? 0;
}

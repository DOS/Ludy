// SPDX-License-Identifier: AGPL-3.0-only
// A budget for the writes of one MCP grant (E2 of epic #3857, issue #3861): a connected coworker does the routine steps of Hộp thư, CRM and ads drafts one call at a time, and a client that loops (or a
// customer's message that talks one into looping) must not write thousands of notes or deals a minute. Each grant gets a few writes a minute, on top of the grant's own request rate and concurrency
// (the endpoint's). A refused write runs nothing, so nothing is half done. In this process's memory like the other edge limits (rate-limit.ts): N API instances allow up to N times the budget.
import { RateLimiter, type RateLimitDecision } from './rate-limit.ts';

export interface McpWriteBudgetOptions {
  perGrantPerMinute?: number;
  now?: () => number;
}

export const MCP_WRITES_PER_MINUTE_DEFAULT = 20;

export class McpWriteBudget {
  private readonly grants: RateLimiter;

  constructor(options: McpWriteBudgetOptions = {}) {
    this.grants = new RateLimiter({ perMinute: options.perGrantPerMinute ?? MCP_WRITES_PER_MINUTE_DEFAULT, ...(options.now ? { now: options.now } : {}) });
  }

  // One write of this grant, or the seconds to wait.
  take(grantId: string): RateLimitDecision {
    return this.grants.take(grantId);
  }
}

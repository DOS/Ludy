// SPDX-License-Identifier: AGPL-3.0-only
// The one ads command an MCP grant that holds `ludy.ads.draft` may run (epic #3857, E2, issue #3861; ADR-0051 decisions 2, 10 and 11): save a new campaign draft for a person to read, change and submit. It is
// the draft the builder writes (saveCampaignDraft: the same checks, the same revision and the largest amount worked out in decimal), marked `origin ai` with the plan fields the agent set, in the grant's sealed
// write context (the migration 20270122180000), where the database lets it insert that one row and nothing else. It never submits, approves, launches, boosts or pauses (R2 and R3: proposals in E4), spends
// nothing and is a new draft each time: it edits no draft, a person's or its own (the database's draft guard lets only a person take an AI field out of the list). Audited with the ids, the amounts and the
// state, never the creative text.
import { z } from 'zod';
import { zAdsCampaignPlanDraft, zId, type AdsCampaignDraftView } from '@crove/kernel-contract';
import { defineCommand } from '@crove/kernel-runtime';
import { saveCampaignDraft } from './campaign-draft.ts';

export const zMcpAdsDraftSave = z.strictObject({ adAccountId: zId, plan: zAdsCampaignPlanDraft });

export const mcpAdsCampaignDraftSave = defineCommand({
  name: 'ads.mcp.campaign_draft_save',
  input: zMcpAdsDraftSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  mcp: { scope: 'ludy.ads.draft' },
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: (ctx, input): Promise<AdsCampaignDraftView> => saveCampaignDraft(ctx, input, null, 'ai'),
});

export const mcpAdsDraftCommands = [mcpAdsCampaignDraftSave];

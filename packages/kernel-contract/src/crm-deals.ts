// SPDX-License-Identifier: AGPL-3.0-only
// CRM deals and the pipeline (issue #2225, plan docs/plan/crm.md §4.1 and §4.2, step K1): the org's one pipeline of
// ordered stages and the deals that sit in them. The amount is a decimal string, never a number; a deal's status is its
// stage's kind.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const DEAL_STAGE_KINDS = ['open', 'won', 'lost'] as const;
export type DealStageKind = (typeof DEAL_STAGE_KINDS)[number];
// A deal's status is its stage's kind.
export type DealStatus = DealStageKind;

// Most stages of the pipeline, the two closing ones included.
export const PIPELINE_STAGE_MAX = 12;
export const DEAL_TITLE_MAX = 200;
export const DEAL_LOST_REASON_MAX = 200;
export const DEAL_PAGE_SIZE = 50;
// The stages a fresh org gets (plan CRM-3): the open ones, then Won and Lost.
export const DEFAULT_PIPELINE_STAGES: readonly { name: string; kind: DealStageKind }[] = [
  { name: 'Mới', kind: 'open' },
  { name: 'Đã liên hệ', kind: 'open' },
  { name: 'Báo giá', kind: 'open' },
  { name: 'Thương lượng', kind: 'open' },
  { name: 'Thắng', kind: 'won' },
  { name: 'Thua', kind: 'lost' },
];

// A VND amount with at most two decimals (the column is numeric(20,2)).
export const zDealAmount = z.string().regex(/^\d{1,18}(\.\d{1,2})?$/, 'decimal string, at most two decimals');
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const zTitle = z.string().trim().min(1).max(DEAL_TITLE_MAX);

export interface PipelineStage {
  id: string;
  name: string;
  kind: DealStageKind;
  position: number;
}

export interface Deal {
  id: string;
  partyId: string;
  partyName: string;
  title: string;
  amount: string;
  currency: 'VND';
  stageId: string;
  stageKind: DealStageKind;
  expectedClose: string | null;
  ownerUserId: string | null;
  lostReason: string | null;
  closedAt: string | null;
  version: number;
  // Whether the caller may delete it: owners and admins any deal, a member the ones they made.
  canDelete: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DealPage {
  items: Deal[];
  next: DealCursor | null;
}

export const zDealCursor = z.strictObject({ createdAt: z.string(), id: zId });
export type DealCursor = z.infer<typeof zDealCursor>;

export const zDealCreate = z.strictObject({
  partyId: zId,
  title: zTitle,
  amount: zDealAmount,
  expectedClose: zDate.nullable(),
  // Defaults to the member who creates it.
  ownerUserId: zId.nullable().optional(),
  // Defaults to the first open stage.
  stageId: zId.optional(),
});
export type DealCreate = z.infer<typeof zDealCreate>;

export const zDealUpdate = z.strictObject({
  dealId: zId,
  // The version the editor read: someone else's save in between refuses the edit.
  version: z.number().int().min(1),
  partyId: zId,
  title: zTitle,
  amount: zDealAmount,
  expectedClose: zDate.nullable(),
  ownerUserId: zId.nullable(),
});
export type DealUpdate = z.infer<typeof zDealUpdate>;

// Moves a deal to a stage and a place in it: after `afterDealId`, before `beforeDealId`, or at the end of the stage when
// neither is named. Won and Lost close the deal; a reason may go with Lost.
export const zDealMove = z
  .strictObject({
    dealId: zId,
    version: z.number().int().min(1),
    stageId: zId,
    beforeDealId: zId.nullable().optional(),
    afterDealId: zId.nullable().optional(),
    lostReason: z.string().trim().max(DEAL_LOST_REASON_MAX).nullable().optional(),
  })
  .refine((v) => !(v.beforeDealId && v.afterDealId), { message: 'name at most one of beforeDealId and afterDealId' });
export type DealMove = z.infer<typeof zDealMove>;

export const zDealRef = z.strictObject({ dealId: zId });
export const zDealDeleted = z.object({ dealId: zId, deleted: z.literal(true) });

export const zDealListQuery = z.strictObject({
  stageId: zId.optional(),
  partyId: zId.optional(),
  status: z.enum(DEAL_STAGE_KINDS).optional(),
  ownerUserId: zId.optional(),
  cursor: zDealCursor.nullable().optional(),
  limit: z.number().int().min(1).max(DEAL_PAGE_SIZE).optional(),
});
export type DealListQuery = z.infer<typeof zDealListQuery>;

export const zPartyDealsQuery = z.strictObject({ partyId: zId });

// A search over the org's parties for the deal form's picker: by name or tax code, a few at a time. The full contacts
// list with search without Vietnamese marks comes with step K4.
export const PARTY_SEARCH_LIMIT = 20;
export const zPartySearchQuery = z.strictObject({ q: z.string().trim().max(100), limit: z.number().int().min(1).max(PARTY_SEARCH_LIMIT).optional() });
export const zPartyChoice = z.object({ id: zId, name: z.string(), kind: z.enum(['organization', 'person']), taxCode: z.string().nullable() });
export type PartyChoice = z.infer<typeof zPartyChoice>;

export const zPipelineStage = z.object({ id: zId, name: z.string(), kind: z.enum(DEAL_STAGE_KINDS), position: z.number().int() });
export const zDeal = z.object({
  id: zId,
  partyId: zId,
  partyName: z.string(),
  title: z.string(),
  amount: zDealAmount,
  currency: z.literal('VND'),
  stageId: zId,
  stageKind: z.enum(DEAL_STAGE_KINDS),
  expectedClose: z.string().nullable(),
  ownerUserId: zId.nullable(),
  lostReason: z.string().nullable(),
  closedAt: z.string().nullable(),
  version: z.number().int(),
  canDelete: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const zDealPage = z.object({ items: z.array(zDeal), next: zDealCursor.nullable() });

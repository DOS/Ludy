// SPDX-License-Identifier: AGPL-3.0-only
// Per-member, per-org Global Home block layout contract (#4923 Phase 1, #4925).
import { z } from 'zod';

export const HOME_BLOCK_IDS = [
  'finance_tax_deadlines',
  'finance_approvals',
  'teamwork_my_work',
  'engage_pipeline',
  'hr_pending',
  'esign_pending',
] as const;
export type HomeBlockId = (typeof HOME_BLOCK_IDS)[number];

export const zHomeLayoutBlock = z.strictObject({
  id: z.enum(HOME_BLOCK_IDS),
  visible: z.boolean(),
});
export type HomeLayoutBlock = z.infer<typeof zHomeLayoutBlock>;

export const zHomeLayoutSaveInput = z.union([
  z.strictObject({ reset: z.literal(true) }),
  z.strictObject({
    blocks: z
      .array(zHomeLayoutBlock)
      .min(1)
      .max(HOME_BLOCK_IDS.length)
      .refine((blocks) => new Set(blocks.map((b) => b.id)).size === blocks.length, {
        message: 'duplicate home block id',
      }),
  }),
]);
export type HomeLayoutSaveInput = z.infer<typeof zHomeLayoutSaveInput>;

export const zHomeLayoutBlockView = z.strictObject({
  id: z.enum(HOME_BLOCK_IDS),
  visible: z.boolean(),
  moduleEnabled: z.boolean(),
  permitted: z.boolean(),
});
export type HomeLayoutBlockView = z.infer<typeof zHomeLayoutBlockView>;

export const zHomeLayoutView = z.strictObject({
  customized: z.boolean(),
  blocks: z.array(zHomeLayoutBlockView),
  defaults: z.array(zHomeLayoutBlockView),
});
export type HomeLayoutView = z.infer<typeof zHomeLayoutView>;

export const zStoredHomeLayout = z.strictObject({
  v: z.literal(1),
  blocks: z
    .array(zHomeLayoutBlock)
    .min(1)
    .max(HOME_BLOCK_IDS.length)
    .refine((blocks) => new Set(blocks.map((b) => b.id)).size === blocks.length, {
      message: 'duplicate home block id',
    }),
});
export type StoredHomeLayout = z.infer<typeof zStoredHomeLayout>;

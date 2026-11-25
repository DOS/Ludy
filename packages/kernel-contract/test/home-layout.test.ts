// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { HOME_BLOCK_IDS, zHomeLayoutBlock, zHomeLayoutSaveInput, zHomeLayoutView, zStoredHomeLayout } from '../src/home-layout.ts';

describe('home-layout contract schemas', () => {
  it('accepts valid block entries and save payloads', () => {
    expect(HOME_BLOCK_IDS).toEqual([
      'finance_tax_deadlines',
      'finance_approvals',
      'teamwork_my_work',
      'engage_pipeline',
      'hr_pending',
      'esign_pending',
    ]);
    expect(zHomeLayoutBlock.parse({ id: 'teamwork_my_work', visible: true })).toEqual({ id: 'teamwork_my_work', visible: true });
    expect(zHomeLayoutSaveInput.parse({ reset: true })).toEqual({ reset: true });
    expect(
      zHomeLayoutSaveInput.parse({
        blocks: [
          { id: 'teamwork_my_work', visible: true },
          { id: 'finance_tax_deadlines', visible: false },
        ],
      }),
    ).toEqual({
      blocks: [
        { id: 'teamwork_my_work', visible: true },
        { id: 'finance_tax_deadlines', visible: false },
      ],
    });
    expect(
      zHomeLayoutView.parse({
        customized: false,
        blocks: [{ id: 'teamwork_my_work', visible: true, moduleEnabled: true, permitted: true }],
        defaults: [{ id: 'teamwork_my_work', visible: true, moduleEnabled: true, permitted: true }],
      }).customized,
    ).toBe(false);
    expect(zStoredHomeLayout.parse({ v: 1, blocks: [{ id: 'hr_pending', visible: false }] }).v).toBe(1);
  });

  it('rejects unknown block ids, duplicates, empty lists, extra keys, and reset: false', () => {
    expect(zHomeLayoutSaveInput.safeParse({ blocks: [] }).success).toBe(false);
    expect(zHomeLayoutSaveInput.safeParse({ blocks: [{ id: 'unknown_block', visible: true }] }).success).toBe(false);
    expect(
      zHomeLayoutSaveInput.safeParse({
        blocks: [
          { id: 'teamwork_my_work', visible: true },
          { id: 'teamwork_my_work', visible: false },
        ],
      }).success,
    ).toBe(false);
    expect(zHomeLayoutSaveInput.safeParse({ reset: false }).success).toBe(false);
    expect(zHomeLayoutSaveInput.safeParse({ reset: true, blocks: [{ id: 'teamwork_my_work', visible: true }] }).success).toBe(false);
    expect(zHomeLayoutBlock.safeParse({ id: 'teamwork_my_work', visible: true, extra: 1 }).success).toBe(false);
    expect(zStoredHomeLayout.safeParse({ v: 2, blocks: [{ id: 'teamwork_my_work', visible: true }] }).success).toBe(false);
  });
});

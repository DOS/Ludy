// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeHomeBlockEligibility, createEntitlementsReader, mergeHomeLayout, mergeSavedBlocks } from '../src/home-layout.ts';

const allModulesOn = () => true;

describe('home-layout eligibility and merging', () => {
  it('computes Role x Enabled-App defaults accurately', () => {
    const owner = computeHomeBlockEligibility({ role: 'owner', permissions: new Set(), roleKeys: new Set(), isModuleOn: allModulesOn });
    expect(owner.map((b) => [b.id, b.moduleEnabled, b.permitted, b.defaultVisible])).toEqual([
      ['finance_tax_deadlines', true, true, true],
      ['finance_approvals', true, true, true],
      ['teamwork_my_work', true, true, true],
      ['engage_pipeline', true, true, true],
      ['hr_pending', true, true, true],
      ['esign_pending', true, true, true],
    ]);

    const plainMember = computeHomeBlockEligibility({ role: 'member', permissions: new Set(), roleKeys: new Set(['crm.sales']), isModuleOn: allModulesOn });
    expect(plainMember.map((b) => [b.id, b.permitted, b.defaultVisible])).toEqual([
      ['finance_tax_deadlines', true, false],
      ['finance_approvals', false, false],
      ['teamwork_my_work', true, true],
      ['engage_pipeline', true, true],
      ['hr_pending', true, true],
      ['esign_pending', true, true],
    ]);

    const financeMember = computeHomeBlockEligibility({ role: 'member', permissions: new Set(), roleKeys: new Set(['finance.accountant']), isModuleOn: allModulesOn });
    expect(financeMember.find((b) => b.id === 'finance_tax_deadlines')).toMatchObject({ permitted: true, defaultVisible: true });
    expect(financeMember.find((b) => b.id === 'finance_approvals')).toMatchObject({ permitted: true, defaultVisible: true });

    const financeViewerMember = computeHomeBlockEligibility({ role: 'member', permissions: new Set(), roleKeys: new Set(['finance.viewer']), isModuleOn: allModulesOn });
    expect(financeViewerMember.find((b) => b.id === 'finance_tax_deadlines')).toMatchObject({ permitted: true, defaultVisible: true });
    expect(financeViewerMember.find((b) => b.id === 'finance_approvals')).toMatchObject({ permitted: false, defaultVisible: false });

    const viewerNotesOn = computeHomeBlockEligibility({ role: 'viewer', permissions: new Set(), roleKeys: new Set(), isModuleOn: allModulesOn });
    expect(viewerNotesOn.filter((b) => b.moduleEnabled && b.permitted).map((b) => b.id)).toEqual(['teamwork_my_work']);

    const viewerNotesOff = computeHomeBlockEligibility({ role: 'viewer', permissions: new Set(), roleKeys: new Set(), isModuleOn: (m) => m !== 'notes' });
    expect(viewerNotesOff.filter((b) => b.moduleEnabled && b.permitted)).toEqual([]);
  });

  it('merges saved preference, filters disabled/unpermitted blocks, and appends newly eligible defaults', () => {
    const eligibility = computeHomeBlockEligibility({
      role: 'member',
      permissions: new Set(['finance.proposal.approve']),
      roleKeys: new Set(),
      isModuleOn: (m) => m !== 'hr',
    });
    const merged = mergeHomeLayout(eligibility, {
      v: 1,
      blocks: [
        { id: 'hr_pending', visible: true },
        { id: 'esign_pending', visible: false },
        { id: 'finance_approvals', visible: true },
      ],
    });
    expect(merged.customized).toBe(true);
    expect(merged.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['esign_pending', false],
      ['finance_approvals', true],
      ['finance_tax_deadlines', true],
      ['teamwork_my_work', true],
      ['engage_pipeline', true],
    ]);
    expect(merged.defaults.map((b) => b.id)).toEqual([
      'finance_tax_deadlines',
      'finance_approvals',
      'teamwork_my_work',
      'engage_pipeline',
      'esign_pending',
    ]);
  });

  afterEach(() => vi.useRealTimers());

  it('preserves saved visibility and anchor placement for disabled or concurrently re-enabled unedited blocks', () => {
    const stored = mergeSavedBlocks(
      [
        { id: 'hr_pending', visible: false },
        { id: 'teamwork_my_work', visible: true },
        { id: 'engage_pipeline', visible: true },
        { id: 'esign_pending', visible: true },
      ],
      {
        v: 1,
        blocks: [
          { id: 'finance_approvals', visible: false },
          { id: 'teamwork_my_work', visible: true },
          { id: 'finance_tax_deadlines', visible: false },
          { id: 'hr_pending', visible: true },
          { id: 'engage_pipeline', visible: true },
          { id: 'esign_pending', visible: true },
        ],
      },
    );
    expect(stored).toEqual([
      { id: 'finance_approvals', visible: false },
      { id: 'hr_pending', visible: false },
      { id: 'teamwork_my_work', visible: true },
      { id: 'finance_tax_deadlines', visible: false },
      { id: 'engage_pipeline', visible: true },
      { id: 'esign_pending', visible: true },
    ]);
  });

  it('caches billing entitlements and falls back to last known answer or full on errors/timeouts', async () => {
    vi.useFakeTimers();
    let now = 100_000;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const port = vi
        .fn<(_: string) => Promise<readonly string[]>>()
        .mockRejectedValueOnce(new Error('billing down'))
        .mockResolvedValueOnce(['notes'])
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(['finance', 'hr']);

      const read = createEntitlementsReader(port, () => now);

      // Initial outage falls back to ['full'] and caches negative result for 10s.
      expect(await read('org-1')).toEqual(['full']);
      now += 5_000;
      expect(await read('org-1')).toEqual(['full']);
      expect(port).toHaveBeenCalledTimes(1);

      // After 10s retry window, reads fresh answer and caches for 60s.
      now += 6_000;
      expect(await read('org-1')).toEqual(['notes']);
      now += 30_000;
      expect(await read('org-1')).toEqual(['notes']);
      expect(port).toHaveBeenCalledTimes(2);

      // After 60s TTL, a hanging port times out at 3s and falls back to last cached answer (['notes']).
      now += 31_000;
      const pending = read('org-1');
      await vi.advanceTimersByTimeAsync(3_000);
      now += 3_000;
      expect(await pending).toEqual(['notes']);
      expect(port).toHaveBeenCalledTimes(3);

      // After 10s retry window, recovers fresh entitlements.
      now += 11_000;
      expect(await read('org-1')).toEqual(['finance', 'hr']);
      expect(port).toHaveBeenCalledTimes(4);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// The register form (#919): its defaults per kind, its checks and the input it sends, and the months offered for a
// depreciation.
import { describe, expect, it } from 'vitest';
import { defaultAccounts, findDuplicateAsset, FIXED_ASSET_FORM_FIELDS, fixedAssetFieldProblem, fixedAssetFormProblem, fixedAssetInput, monthLabel, previousMonth, recentMonths, type FixedAssetForm } from '../src/lib/fixed-assets.ts';

const form = (over: Partial<FixedAssetForm> = {}): FixedAssetForm => ({
  kind: 'fixed_asset',
  name: 'Máy in',
  cost: '36.000.000',
  ...defaultAccounts('fixed_asset'),
  startMonth: '2026-10',
  months: '36',
  ...over,
});

describe('the fixed asset form', () => {
  it('sends a valid entry as the kernel takes it', () => {
    expect(fixedAssetFormProblem(form())).toBeNull();
    expect(fixedAssetInput(form())).toEqual({ kind: 'fixed_asset', name: 'Máy in', cost: '36000000', assetAccount: '2111', accumulatedAccount: '2141', expenseAccount: '6422', startMonth: '2026-10', months: 36 });
    const prepaid = form({ kind: 'prepaid_cost', ...defaultAccounts('prepaid_cost'), months: '12' });
    expect(fixedAssetFormProblem(prepaid)).toBeNull();
    expect(fixedAssetInput(prepaid).accumulatedAccount).toBeNull();
  });

  it('refuses a missing name, an amount that is not whole dong, accounts of the wrong kind and a bad schedule', () => {
    expect(fixedAssetFormProblem(form({ name: ' ' }))).toBe('name');
    expect(fixedAssetFormProblem(form({ cost: '0' }))).toBe('cost');
    expect(fixedAssetFormProblem(form({ cost: '-1000' }))).toBe('cost');
    expect(fixedAssetFormProblem(form({ accumulatedAccount: '' }))).toBe('accounts');
    expect(fixedAssetFormProblem(form({ kind: 'prepaid_cost' }))).toBe('accounts');
    expect(fixedAssetFormProblem(form({ expenseAccount: '511' }))).toBe('accounts');
    expect(fixedAssetFormProblem(form({ expenseAccount: '1541' }))).toBeNull();
    expect(fixedAssetFormProblem(form({ startMonth: '2026-13' }))).toBe('startMonth');
    expect(fixedAssetFormProblem(form({ months: '0' }))).toBe('months');
    expect(fixedAssetFormProblem(form({ months: '601' }))).toBe('months');
    expect(fixedAssetFormProblem(form({ months: '1.5' }))).toBe('months');
  });

  it('marks each field on its own, so every error sits under its field (#2004)', () => {
    const bad = form({ name: '', cost: 'abc', expenseAccount: '511', months: '0' });
    expect(FIXED_ASSET_FORM_FIELDS.filter((field) => fixedAssetFieldProblem(bad, field))).toEqual(['name', 'cost', 'accounts', 'months']);
    expect(FIXED_ASSET_FORM_FIELDS.filter((field) => fixedAssetFieldProblem(form(), field))).toEqual([]);
    // The cost as AmountInput keeps it while focused: grouped with dots or commas, it is still whole dong.
    expect(fixedAssetFieldProblem(form({ cost: '36,000,000' }), 'cost')).toBe(false);
  });

  it('offers the months up to the one before today, newest first', () => {
    expect(previousMonth('2026-10-21')).toBe('2026-09');
    expect(previousMonth('2027-01-05')).toBe('2026-12');
    expect(recentMonths('2027-02', 3)).toEqual(['2027-02', '2027-01', '2026-12']);
    expect(monthLabel('2026-09')).toBe('09/2026');
  });
});

// The hint shown while an entry is typed (#3607): the same name and cost as one in the register.
describe('the duplicate asset hint', () => {
  const asset = (patch: Record<string, unknown> = {}) => ({ name: 'Máy in văn phòng', cost: '12000000.0000', ended: null as unknown, ...patch });

  it('finds the asset with the same name and cost, ignoring case, spaces and the spelling of the amount', () => {
    expect(findDuplicateAsset([asset()], 'máy in văn phòng ', '12.000.000')).not.toBeNull();
    expect(findDuplicateAsset([asset({ cost: '12000000' })], 'Máy in văn phòng', '12000000')).not.toBeNull();
  });

  it('finds nothing when the name or the cost differs, or the asset was stopped', () => {
    expect(findDuplicateAsset([asset()], 'Máy in màu', '12.000.000')).toBeNull();
    expect(findDuplicateAsset([asset()], 'Máy in văn phòng', '12.000.001')).toBeNull();
    expect(findDuplicateAsset([asset({ ended: { month: '2026-10', reason: 'Thanh lý' } })], 'Máy in văn phòng', '12.000.000')).toBeNull();
  });

  it('says nothing before there is a name and a cost', () => {
    expect(findDuplicateAsset([asset()], '', '12.000.000')).toBeNull();
    expect(findDuplicateAsset([asset()], 'Máy in văn phòng', '')).toBeNull();
    expect(findDuplicateAsset([asset()], 'Máy in văn phòng', '0')).toBeNull();
  });
});

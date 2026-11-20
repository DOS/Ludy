// SPDX-License-Identifier: AGPL-3.0-only
// What a check asks of the catalogue for the vouchers of an ask (#4124, S3b of #4103): the tax codes of the parties that have one, the names of the parties that have NONE (none, or blank), and nothing for a
// party whose tax code is present but cannot be used (it stays a blocker for a person to fix, never matched to a same-name entry).
import { describe, expect, it } from 'vitest';
import { amisContextOf, loadAmisEntries } from '../src/misa-amis-build.ts';
import type { CashVoucher } from '../src/misa.ts';

const cash = (n: number, party: CashVoucher['party']): CashVoucher => ({
  sourceId: `0192f0a1-2b3c-7d4e-8f50-6172839a4b${String(n).padStart(2, '0')}`,
  type: 'cash_payment',
  code: `PC${n}`,
  numberPeriod: '2026',
  date: '2026-10-07',
  cashAccount: '1111',
  party,
  personName: null,
  description: 'x',
  lines: [{ lineNo: 1, account: '331', amount: '1000', memo: null }],
});
const P = (n: number) => `77777777-7777-4777-8777-7777777777${String(n).padStart(2, '0')}`;
const ask = { kind: 'cash_payment' as const, from: '2026-10-01', to: '2026-10-31' };

describe('what the vouchers need looked up (#4124)', () => {
  it('looks up a tax code for a party that has a usable one, a name for a party that has none, and nothing for a tax code that is present and unusable', async () => {
    const vouchers = [
      cash(1, { id: P(1), name: 'Có mã số thuế', taxCode: '0101234564', address: null }),
      cash(2, { id: P(2), name: 'Không có mã', taxCode: null, address: null }),
      cash(3, { id: P(3), name: 'Mã trống', taxCode: '   ', address: null }),
      cash(4, { id: P(4), name: 'Mã gõ sai', taxCode: '12345', address: null }),
      cash(5, { id: P(5), name: 'Mã chữ', taxCode: 'không có', address: null }),
      cash(6, { name: 'Không có id', taxCode: null, address: null }),
      cash(7, null),
      cash(8, { id: P(2), name: 'Không có mã', taxCode: null, address: null }),
    ];
    const { wanted } = await loadAmisEntries(async () => vouchers as never, ask, amisContextOf(ask), 501);
    expect(wanted.taxCodes).toEqual(['0101234564']);
    // Each party once, by id in a fixed order; the unusable tax codes and the party with no id are not asked about.
    expect(wanted.names).toEqual([
      { partyId: P(2), name: 'Không có mã' },
      { partyId: P(3), name: 'Mã trống' },
    ]);
  });
});

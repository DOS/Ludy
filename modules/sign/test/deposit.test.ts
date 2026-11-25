// SPDX-License-Identifier: AGPL-3.0-only
// Pure unit tests for eSign VietQR EMVCo TLV + CRC-16/CCITT-FALSE builder and VND decimal validation (#4723).
import { describe, expect, it } from 'vitest';
import { zSignDepositProfileUpsertInput } from '@ludy/kernel-contract';
import {
  buildVietQrEmvcoPayload,
  computeEmvcoCrc16,
  parseDepositAmountDecimal,
  trimDepositDecimalString,
} from '../src/deposit.ts';

describe('eSign VietQR deposit helpers (#4723)', () => {
  it('computes standard CRC-16/CCITT-FALSE check values', () => {
    expect(computeEmvcoCrc16('123456789')).toBe('29B1');
  });

  it('returns null when no verified NAPAS BIN is present (#2535 no fabricated BINs)', () => {
    expect(
      buildVietQrEmvcoPayload({
        bankCode: 'vcb',
        accountNumber: '0123456789',
        amount: '5000000',
        memoToken: 'CK-AB12CD',
      }),
    ).toBeNull();
  });

  it('builds a valid EMVCo NAPAS 247 (QRIBFTTA) payload with trailing CRC when verified 6-digit BIN is provided', () => {
    const payload = buildVietQrEmvcoPayload({
      bankCode: 'vcb',
      accountNumber: '0123456789',
      amount: '5000000',
      memoToken: 'CK-AB12CD',
      napasBin: '970436',
    });
    expect(payload).not.toBeNull();
    expect(payload!.startsWith('000201010212')).toBe(true);
    expect(payload).toContain('A000000727');
    expect(payload).toContain('QRIBFTTA');
    expect(payload).toContain('970436');
    expect(payload).toContain('0123456789');
    expect(payload).toContain('5303704');
    expect(payload).toContain('54075000000');
    expect(payload).toContain('5802VN');
    expect(payload).toContain('CK-AB12CD');
    const bodyWithoutCrc = payload!.slice(0, -4);
    const crc = payload!.slice(-4);
    expect(bodyWithoutCrc.endsWith('6304')).toBe(true);
    expect(computeEmvcoCrc16(bodyWithoutCrc)).toBe(crc);
  });

  it('rejects non-integer VND decimals, negatives, zeros, and non-numeric strings cleanly', () => {
    expect(trimDepositDecimalString('5000000.0000')).toBe('5000000');
    expect(parseDepositAmountDecimal('5000000')).toBe('5000000');
    expect(parseDepositAmountDecimal(' 5000000.00 ')).toBe('5000000');
    expect(() => parseDepositAmountDecimal('1000.5')).toThrow();
    expect(() => parseDepositAmountDecimal('1250000.25')).toThrow();
    expect(() => parseDepositAmountDecimal('0.5')).toThrow();
    expect(
      buildVietQrEmvcoPayload({
        bankCode: 'vcb',
        accountNumber: '0123456789',
        amount: '1000.5',
        memoToken: 'CK-AB12CD',
        napasBin: '970436',
      }),
    ).toBeNull();
    expect(() => parseDepositAmountDecimal('0')).toThrow();
    expect(() => parseDepositAmountDecimal('0.0000')).toThrow();
    expect(() => parseDepositAmountDecimal('-1000')).toThrow();
    expect(() => parseDepositAmountDecimal('5.12345')).toThrow();
    expect(() => parseDepositAmountDecimal('1e6')).toThrow();
  });

  it('accepts dot-suffixed Finance subaccount codes and rejects malformed codes', () => {
    const normalized = zSignDepositProfileUpsertInput.parse({
      bankCode: 'vcb',
      accountNumber: '0123456789',
      accountHolder: 'CONG TY TEST',
      financeBankAccount: ' 1121.vcb ',
    });
    expect(normalized.financeBankAccount).toBe('1121.VCB');

    const parent = zSignDepositProfileUpsertInput.parse({
      bankCode: 'vcb',
      accountNumber: '0123456789',
      accountHolder: 'CONG TY TEST',
      financeBankAccount: '1121',
    });
    expect(parent.financeBankAccount).toBe('1121');

    expect(() =>
      zSignDepositProfileUpsertInput.parse({
        bankCode: 'vcb',
        accountNumber: '0123456789',
        accountHolder: 'CONG TY TEST',
        financeBankAccount: '1121.',
      }),
    ).toThrow();

    expect(() =>
      zSignDepositProfileUpsertInput.parse({
        bankCode: 'vcb',
        accountNumber: '0123456789',
        accountHolder: 'CONG TY TEST',
        financeBankAccount: '12',
      }),
    ).toThrow();
  });
});

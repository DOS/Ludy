// SPDX-License-Identifier: AGPL-3.0-only
// Shared HR payslip breakdown display helpers (decoupled from admin payroll route bundle).
import { money, toMoney, type PayrollBreakdown } from '@ludy/l10n-vn';

/**
 * Separates regular bonus and retroactive pay for payslip display.
 * Handles both new stored breakdowns (where pay.retroPay is stored explicitly) and legacy
 * pre-#4597 breakdowns (where retroPay was folded into pay.bonus).
 * Uses integer VND rounding (.toDecimalPlaces(0)) matching @ludy/l10n-vn calculator.ts.
 */
export function splitBonusAndRetroPay(
  b: PayrollBreakdown,
  inputs: Record<string, unknown>,
): { bonus: string; retroPay: string } {
  if (typeof b.pay.retroPay === 'string') {
    return { bonus: b.pay.bonus, retroPay: b.pay.retroPay };
  }
  const inputRetro = typeof inputs.retroPay === 'string' ? inputs.retroPay : '0';
  if (!money(inputRetro).greaterThan(0)) {
    return { bonus: b.pay.bonus, retroPay: '0' };
  }
  const rawBonus = typeof inputs.bonus === 'string' ? toMoney(money(inputs.bonus).toDecimalPlaces(0)) : '0';
  const retro = money(b.pay.bonus).minus(money(rawBonus));
  if (retro.greaterThan(0)) {
    return { bonus: rawBonus, retroPay: toMoney(retro) };
  }
  return { bonus: b.pay.bonus, retroPay: '0' };
}

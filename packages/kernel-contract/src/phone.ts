// SPDX-License-Identifier: AGPL-3.0-only
// The key a phone number is matched on (CRM plan 4.5, step K4, #2228): `0912 345 678`, `+84 912 345 678`, `84912345678`
// and `0084 912 345 678` are one number, and all four give `0912345678`. Contact search, the duplicate check of the
// contact import (K5) and the expression index on party use it. Its immutable SQL twin is crove_kernel.phone_key(text)
// (migration 20261115100000); packages/kernel-contract/src/phone-cases.ts is the one table of cases both run, so the two
// cannot drift.
//
// The rules, in order:
//   1. Every character but the digits is dropped (spaces, dots, dashes, brackets); only a leading `+` is remembered, after
//      ASCII white space alone (a no-break space is not skipped), so the SQL twin does not depend on the database's locale.
//   2. A leading `00` is the international call prefix, as a `+`: `0084...` is `+84...`.
//   3. International `84` (after a `+` or `00`), or a bare `84` in front of 9 or 10 more digits, is Vietnam's country
//      code: it becomes `0`, and a trunk `0` written after it (`+84 (0) 912...`) is not doubled.
//   4. Anything else keeps its digits (another country's number keeps its country code, a local number its `0`).
// A number with no digit has no key (null).
export function phoneKey(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits === '') return null;
  let international = /^[ \t\n\r\f\v]*\+/.test(phone);
  if (digits.startsWith('00')) {
    international = true;
    digits = digits.slice(2);
  }
  if (digits.startsWith('84') && (international || digits.length === 11 || digits.length === 12)) {
    return `0${digits.slice(2).replace(/^0/, '')}`;
  }
  return digits === '' ? null : digits;
}

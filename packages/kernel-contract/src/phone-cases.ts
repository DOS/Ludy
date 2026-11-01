// SPDX-License-Identifier: AGPL-3.0-only
// The one table of phone key cases (CRM plan 4.5, #2228): [what is stored, its key]. The unit test runs phoneKey() over it
// and the database test runs crove_kernel.phone_key() over the same table, so the TypeScript function and its SQL twin
// agree on every row.
export const PHONE_KEY_CASES: ReadonlyArray<readonly [string, string | null]> = [
  ['0912345678', '0912345678'],
  ['0912 345 678', '0912345678'],
  ['091.234.5678', '0912345678'],
  ['(091) 234-5678', '0912345678'],
  ['+84 912 345 678', '0912345678'],
  ['+84912345678', '0912345678'],
  ['+84 (0) 912 345 678', '0912345678'],
  ['84912345678', '0912345678'],
  ['84 912 345 678', '0912345678'],
  ['0084 912 345 678', '0912345678'],
  ['  +84-912-345-678  ', '0912345678'],
  // A landline, with and without the country code.
  ['024 3826 0000', '02438260000'],
  ['+84 24 3826 0000', '02438260000'],
  ['842438260000', '02438260000'],
  // Another country keeps its own country code.
  ['+1 (415) 555-0100', '14155550100'],
  ['001 415 555 0100', '14155550100'],
  // A short or odd local number stays as typed, digits only; `84` in front of too few digits is not a country code.
  ['12345', '12345'],
  ['8412345', '8412345'],
  ['1900 1234', '19001234'],
  // Only ASCII white space may stand before the `+`: a no-break space does not, whatever the database's locale.
  ['\u00a0+84 123', '84123'],
  // No digit, no key.
  ['', null],
  ['   ', null],
  ['+', null],
  ['abc', null],
];

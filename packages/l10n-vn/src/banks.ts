// SPDX-License-Identifier: AGPL-3.0-only
// The banks in Vietnam an employee may be paid at (issue #2897, payroll plan docs/plan/payroll.md 6.4), as data: a short code the org's records store, the name people say, and the full
// Vietnamese name. The bank bulk-salary file writes the name from this list, or the header text of a saved template.
//
// STATUS: commentary. This list was written by hand from public knowledge on 2026-11-08 and is NOT checked against a first-party list (NAPAS or the State Bank of Vietnam): the session that wrote it
// could not reach napas.com.vn (blocked network). It carries no NAPAS BIN on purpose: a code is never written from memory, because a wrong one sends a payment to the wrong bank; the BINs are
// added when a sourced list is in hand. THE ACCOUNTANT CHECKS IT, in the same pass as the payroll rows (#2535); until then nothing here is a conclusion about which banks exist or how they are named.
// A bank missing from the list is added here (a data change), never typed free into a person's record.

/** A bank of the list. `code` is the stored key: 2 to 12 capital letters or digits, never changed once records hold it. */
export interface VnBank {
  code: string;
  /** The name people say and the bulk-salary file writes (kept short). */
  shortName: string;
  /** The full name in Vietnamese. */
  name: string;
}

/** Where the list comes from and how far to trust it. */
export const VN_BANKS_SOURCE = {
  status: 'commentary',
  writtenOn: '2026-11-08',
  firstParty: false,
  checkedBy: 'the accountant, with the payroll rows (#2535)',
} as const;

export const VN_BANK_CODE_PATTERN = /^[A-Z0-9]{2,12}$/;

export const VN_BANKS: readonly VnBank[] = [
  // State-owned and policy banks.
  { code: 'AGRIBANK', shortName: 'Agribank', name: 'Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam' },
  { code: 'BIDV', shortName: 'BIDV', name: 'Ngân hàng Thương mại cổ phần Đầu tư và Phát triển Việt Nam' },
  { code: 'VCB', shortName: 'Vietcombank', name: 'Ngân hàng Thương mại cổ phần Ngoại thương Việt Nam' },
  { code: 'CTG', shortName: 'VietinBank', name: 'Ngân hàng Thương mại cổ phần Công thương Việt Nam' },
  { code: 'COOPBANK', shortName: 'Co-opBank', name: 'Ngân hàng Hợp tác xã Việt Nam' },
  { code: 'VBSP', shortName: 'NHCSXH', name: 'Ngân hàng Chính sách xã hội' },
  // Joint-stock commercial banks.
  { code: 'ABB', shortName: 'ABBANK', name: 'Ngân hàng Thương mại cổ phần An Bình' },
  { code: 'ACB', shortName: 'ACB', name: 'Ngân hàng Thương mại cổ phần Á Châu' },
  { code: 'BAB', shortName: 'BacABank', name: 'Ngân hàng Thương mại cổ phần Bắc Á' },
  { code: 'BVB', shortName: 'BaoVietBank', name: 'Ngân hàng Thương mại cổ phần Bảo Việt' },
  { code: 'CBB', shortName: 'CBBank', name: 'Ngân hàng Thương mại TNHH MTV Xây dựng Việt Nam' },
  { code: 'DAB', shortName: 'DongA Bank', name: 'Ngân hàng Thương mại cổ phần Đông Á' },
  { code: 'EIB', shortName: 'Eximbank', name: 'Ngân hàng Thương mại cổ phần Xuất Nhập khẩu Việt Nam' },
  { code: 'GPB', shortName: 'GPBank', name: 'Ngân hàng Thương mại TNHH MTV Dầu khí Toàn cầu' },
  { code: 'HDB', shortName: 'HDBank', name: 'Ngân hàng Thương mại cổ phần Phát triển Thành phố Hồ Chí Minh' },
  { code: 'KLB', shortName: 'KienlongBank', name: 'Ngân hàng Thương mại cổ phần Kiên Long' },
  { code: 'LPB', shortName: 'LPBank', name: 'Ngân hàng Thương mại cổ phần Lộc Phát Việt Nam' },
  { code: 'MBB', shortName: 'MB', name: 'Ngân hàng Thương mại cổ phần Quân đội' },
  { code: 'MSB', shortName: 'MSB', name: 'Ngân hàng Thương mại cổ phần Hàng Hải Việt Nam' },
  { code: 'NAB', shortName: 'Nam A Bank', name: 'Ngân hàng Thương mại cổ phần Nam Á' },
  { code: 'NCB', shortName: 'NCB', name: 'Ngân hàng Thương mại cổ phần Quốc Dân' },
  { code: 'OCB', shortName: 'OCB', name: 'Ngân hàng Thương mại cổ phần Phương Đông' },
  { code: 'OJB', shortName: 'OceanBank', name: 'Ngân hàng Thương mại TNHH MTV Đại Dương' },
  { code: 'PGB', shortName: 'PG Bank', name: 'Ngân hàng Thương mại cổ phần Thịnh vượng và Phát triển' },
  { code: 'PVCB', shortName: 'PVcomBank', name: 'Ngân hàng Thương mại cổ phần Đại Chúng Việt Nam' },
  { code: 'SCB', shortName: 'SCB', name: 'Ngân hàng Thương mại cổ phần Sài Gòn' },
  { code: 'SGB', shortName: 'Saigonbank', name: 'Ngân hàng Thương mại cổ phần Sài Gòn Công Thương' },
  { code: 'SHB', shortName: 'SHB', name: 'Ngân hàng Thương mại cổ phần Sài Gòn - Hà Nội' },
  { code: 'SSB', shortName: 'SeABank', name: 'Ngân hàng Thương mại cổ phần Đông Nam Á' },
  { code: 'STB', shortName: 'Sacombank', name: 'Ngân hàng Thương mại cổ phần Sài Gòn Thương Tín' },
  { code: 'TCB', shortName: 'Techcombank', name: 'Ngân hàng Thương mại cổ phần Kỹ thương Việt Nam' },
  { code: 'TPB', shortName: 'TPBank', name: 'Ngân hàng Thương mại cổ phần Tiên Phong' },
  { code: 'VAB', shortName: 'VietABank', name: 'Ngân hàng Thương mại cổ phần Việt Á' },
  { code: 'VCCB', shortName: 'BVBank', name: 'Ngân hàng Thương mại cổ phần Bản Việt' },
  { code: 'VIB', shortName: 'VIB', name: 'Ngân hàng Thương mại cổ phần Quốc tế Việt Nam' },
  { code: 'VPB', shortName: 'VPBank', name: 'Ngân hàng Thương mại cổ phần Việt Nam Thịnh Vượng' },
  // Digital banks.
  { code: 'CAKE', shortName: 'Cake by VPBank', name: 'Ngân hàng số Cake by VPBank' },
  { code: 'UBANK', shortName: 'Ubank by VPBank', name: 'Ngân hàng số Ubank by VPBank' },
  { code: 'TIMO', shortName: 'Timo', name: 'Ngân hàng số Timo (Bản Việt)' },
  // Foreign-owned and joint-venture banks.
  { code: 'ANZVL', shortName: 'ANZ', name: 'Ngân hàng TNHH MTV ANZ Việt Nam' },
  { code: 'CIMB', shortName: 'CIMB', name: 'Ngân hàng TNHH MTV CIMB Việt Nam' },
  { code: 'HLBVN', shortName: 'Hong Leong Bank', name: 'Ngân hàng TNHH MTV Hong Leong Việt Nam' },
  { code: 'HSBC', shortName: 'HSBC', name: 'Ngân hàng TNHH MTV HSBC (Việt Nam)' },
  { code: 'IVB', shortName: 'Indovina Bank', name: 'Ngân hàng TNHH Indovina' },
  { code: 'PBVN', shortName: 'Public Bank', name: 'Ngân hàng TNHH MTV Public Việt Nam' },
  { code: 'SCVN', shortName: 'Standard Chartered', name: 'Ngân hàng TNHH MTV Standard Chartered Bank Việt Nam' },
  { code: 'SHBVN', shortName: 'Shinhan Bank', name: 'Ngân hàng TNHH MTV Shinhan Việt Nam' },
  { code: 'UOB', shortName: 'UOB', name: 'Ngân hàng TNHH MTV United Overseas Bank (Việt Nam)' },
  { code: 'VRB', shortName: 'VRB', name: 'Ngân hàng Liên doanh Việt - Nga' },
  { code: 'WOO', shortName: 'Woori Bank', name: 'Ngân hàng TNHH MTV Woori Việt Nam' },
];

const BY_CODE: ReadonlyMap<string, VnBank> = new Map(VN_BANKS.map((bank) => [bank.code, bank]));

/** The bank with this code, or undefined for a code that is not in the list. */
export const bankByCode = (code: string): VnBank | undefined => BY_CODE.get(code);
/** Whether `code` is a code of the list. */
export const isBankCode = (code: string): boolean => BY_CODE.has(code);

// A search text as the people type it: lower case, no diacritics (đ too), single spaces.
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();

/** The banks whose code, short name or full name holds every word of `query` (no diacritics needed, any case); the whole list for an empty query. Code matches come first, then the order of the list. */
export function searchBanks(query: string): readonly VnBank[] {
  const words = fold(query).split(' ').filter((word) => word !== '');
  if (words.length === 0) return VN_BANKS;
  const hits = VN_BANKS.filter((bank) => {
    const haystack = fold(`${bank.code} ${bank.shortName} ${bank.name}`);
    return words.every((word) => haystack.includes(word));
  });
  const first = fold(query);
  return [...hits.filter((bank) => fold(bank.code) === first || fold(bank.shortName) === first), ...hits.filter((bank) => fold(bank.code) !== first && fold(bank.shortName) !== first)];
}

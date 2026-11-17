// SPDX-License-Identifier: AGPL-3.0-only
// "Nguyễn Văn Nam" and "nguyen van nam" are one name: no marks, lower case, single spaces.
export function plainName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// SPDX-License-Identifier: AGPL-3.0-only
// A money amount as a person types it in Vietnam (#3641, Engage audit AD-5, DESIGN.md 4.2): "5000000", "5.000.000" (the Vietnamese grouping), "5,000,000" (the English
// one), "20,5" or "20.5", "5.000.000,50". It becomes the canonical decimal string the server takes ("5000000", "20.5"), never a JS number, so no digit is lost or
// rounded on the way. A dot or comma followed by exactly three digits, repeated, is a group mark; followed by one or two digits it is the decimal mark.
const PLAIN = /^\d+$/;
// A first group of a grouped number never starts with 0: "0.500" is half, not five hundred.
const GROUPED = /^[1-9]\d{0,2}(?:([.,])\d{3})+$/;
const DECIMAL = /^\d+[.,]\d{1,2}$/;
const VI_GROUPED_DECIMAL = /^[1-9]\d{0,2}(?:\.\d{3})+,\d{1,2}$/;
const EN_GROUPED_DECIMAL = /^[1-9]\d{0,2}(?:,\d{3})+\.\d{1,2}$/;

const trimZeros = (digits: string): string => digits.replace(/^0+(?=\d)/, '');

// The canonical decimal string of what was typed, or null when it is not an amount.
export function parseMoneyInput(text: string): string | null {
  const t = text.replace(/[\s  ]/g, '');
  if (t === '') return null;
  if (PLAIN.test(t)) return trimZeros(t);
  const grouped = GROUPED.exec(t);
  if (grouped) {
    // Every separator must be the same one ("1.234,567" is not an amount).
    const mark = grouped[1] as string;
    return t.split(mark).every((part, i) => (i === 0 ? part.length <= 3 : part.length === 3)) ? trimZeros(t.split(mark).join('')) : null;
  }
  if (DECIMAL.test(t)) {
    const [whole = '', frac = ''] = t.split(/[.,]/);
    return `${trimZeros(whole)}.${frac}`;
  }
  if (VI_GROUPED_DECIMAL.test(t)) {
    const [whole = '', frac = ''] = t.split(',');
    return `${trimZeros(whole.split('.').join(''))}.${frac}`;
  }
  if (EN_GROUPED_DECIMAL.test(t)) {
    const [whole = '', frac = ''] = t.split('.');
    return `${trimZeros(whole.split(',').join(''))}.${frac}`;
  }
  return null;
}

// The canonical amount written for reading, the Vietnamese way: "5000000" as "5.000.000", "20.5" as "20,5". What the field shows after the person leaves it.
export function groupMoneyInput(canonical: string): string {
  const [whole = '', frac] = canonical.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return frac === undefined ? grouped : `${grouped},${frac}`;
}

// The text of a field made tidy when it is valid and left as typed when it is not, so a person never loses what they wrote.
export function tidyMoneyInput(text: string): string {
  const canonical = parseMoneyInput(text);
  return canonical === null ? text : groupMoneyInput(canonical);
}

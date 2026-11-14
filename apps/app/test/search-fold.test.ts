// SPDX-License-Identifier: AGPL-3.0-only
// Which words of a found line the meeting search marks (L2, #2589): the same fold as the server's (marks, đ and case ignored), a typed word matching the start of a word.
import { describe, expect, it } from 'vitest';
import { foldWord, markMatches } from '../src/lib/search-fold.ts';

describe('foldWord', () => {
  it('drops Vietnamese marks and đ and lower-cases', () => {
    expect(foldWord('Chiết')).toBe('chiet');
    expect(foldWord('KHẤU')).toBe('khau');
    expect(foldWord('Đồng')).toBe('dong');
    expect(foldWord('đơn')).toBe('don');
    expect(foldWord('abc9')).toBe('abc9');
  });
  it('folds a decomposed letter the same as a composed one', () => {
    expect(foldWord('Chiết'.normalize('NFD'))).toBe(foldWord('Chiết'.normalize('NFC')));
  });
});

describe('markMatches', () => {
  const joined = (parts: ReturnType<typeof markMatches>) => parts.map((p) => (p.mark ? `[${p.text}]` : p.text)).join('');
  it('marks the words that start with a typed word, with or without marks on either side', () => {
    expect(joined(markMatches('Anh Tuấn đề nghị chiết khấu 5% cho đơn hàng', 'chiet khau'))).toBe('Anh Tuấn đề nghị [chiết] [khấu] 5% cho đơn hàng');
    expect(joined(markMatches('Anh Tuấn đề nghị chiết khấu', 'CHIẾT kh'))).toBe('Anh Tuấn đề nghị [chiết] [khấu]');
    expect(joined(markMatches('Chị Hà đồng ý', 'dong y'))).toBe('Chị Hà [đồng] [ý]');
  });
  it('returns the line whole when nothing is typed that can match', () => {
    expect(markMatches('Chị Hà đồng ý', '!!!')).toEqual([{ text: 'Chị Hà đồng ý', mark: false }]);
    expect(markMatches('Chị Hà đồng ý', 'zzz')).toEqual([{ text: 'Chị Hà đồng ý', mark: false }]);
  });
  it('keeps every character of the line, in order', () => {
    const line = 'Gửi báo giá (chiết khấu 10%) cho khách, ok?';
    expect(markMatches(line, 'chiet khau 10').map((p) => p.text).join('')).toBe(line);
  });
});

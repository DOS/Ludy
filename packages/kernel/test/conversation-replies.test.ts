// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of Vy's drafts and the saved replies (CV8, #2310): how a customer's words are read for matching (no diacritics, no case, whole words),
// which saved replies answer them, and how far a sent reply is from the draft it began from.
import { describe, expect, it } from 'vitest';
import { editSize, matchSavedReplies, replyWords } from '../src/conversations.ts';

const reply = (title: string, keywords: string[], useCount = 0) => ({ title, keywords, useCount });

describe('replyWords', () => {
  it('reads Vietnamese without diacritics or case, with đ as d, and splits on anything that is not a letter or a digit', () => {
    expect(replyWords('Giờ MỞ cửa của Đồng Khởi?')).toEqual(['gio', 'mo', 'cua', 'cua', 'dong', 'khoi']);
    expect(replyWords('  giá-bao nhiêu...  ')).toEqual(['gia', 'bao', 'nhieu']);
    expect(replyWords('size M, 2 cái')).toEqual(['size', 'm', '2', 'cai']);
    expect(replyWords('')).toEqual([]);
    expect(replyWords('!!! ...')).toEqual([]);
  });
});

describe('matchSavedReplies', () => {
  const replies = [reply('Giá', ['giá', 'bao nhiêu']), reply('Địa chỉ', ['địa chỉ', 'ở đâu']), reply('Giờ mở cửa', ['giờ mở cửa', 'mấy giờ']), reply('Giao hàng', ['ship', 'giao hàng'], 5)];

  it('offers the replies whose keywords the text contains as whole words or phrases, best first', () => {
    expect(matchSavedReplies('Shop ơi áo này GIÁ bao nhiêu vậy, ship về Hà Nội mất bao lâu?', replies).map((r) => r.title)).toEqual(['Giá', 'Giao hàng']);
    expect(matchSavedReplies('Cho mình xin địa chỉ và giờ mở cửa với', replies).map((r) => r.title)).toEqual(['Địa chỉ', 'Giờ mở cửa']);
    // More matched keywords first, then the one used more often, then by title.
    expect(matchSavedReplies('giá bao nhiêu, ship', replies).map((r) => r.title)).toEqual(['Giá', 'Giao hàng']);
    expect(matchSavedReplies('ship', [reply('B', ['ship'], 1), reply('A', ['ship'], 1), reply('C', ['ship'], 9)]).map((r) => r.title)).toEqual(['C', 'A', 'B']);
  });

  it('matches whole words, never a part of one, and nothing for a text with no words or a reply with no usable keyword', () => {
    expect(matchSavedReplies('cái áo này đẹp quá', [reply('Giá', ['gi'])])).toEqual([]);
    expect(matchSavedReplies('giáo viên', [reply('Giá', ['giá'])])).toEqual([]);
    expect(matchSavedReplies('...', replies)).toEqual([]);
    expect(matchSavedReplies('giá', [reply('Trống', []), reply('Rỗng', ['  ', '!!'])])).toEqual([]);
  });

  it('offers at most the limit', () => {
    const many = Array.from({ length: 6 }, (_, i) => reply(`R${i}`, ['giá']));
    expect(matchSavedReplies('giá', many)).toHaveLength(3);
    expect(matchSavedReplies('giá', many, 5)).toHaveLength(5);
  });
});

describe('editSize', () => {
  it('is the larger of what was cut from the draft and what was put in its place, between the common beginning and ending', () => {
    expect(editSize('Dạ giá [giá] ạ', 'Dạ giá 150.000đ ạ')).toBe(8);
    expect(editSize('Dạ vâng ạ', 'Dạ vâng ạ')).toBe(0);
    expect(editSize('Dạ vâng', 'Dạ vâng ạ')).toBe(2);
    expect(editSize('abc', 'xyz')).toBe(3);
    expect(editSize('', 'abc')).toBe(3);
    expect(editSize('abc', '')).toBe(3);
  });

  it('counts characters, not UTF-16 units, so Vietnamese and emoji are not counted twice', () => {
    expect(editSize('Dạ 😀 ạ', 'Dạ 😀😀 ạ')).toBe(1);
    expect(editSize('Dạ ạ', 'Dạ ơi ạ')).toBe(3);
  });
});

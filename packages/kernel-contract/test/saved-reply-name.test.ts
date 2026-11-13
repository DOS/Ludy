// SPDX-License-Identifier: AGPL-3.0-only
// The contact-name placeholder of a saved reply (#3102): `{tên}` is filled with the contact's name, and with no usable name it is dropped cleanly, so no
// brace ever stays in a text that goes to a customer.
import { describe, expect, it } from 'vitest';
import { fillNamePlaceholder, hasNamePlaceholder, SAVED_REPLY_NAME_PLACEHOLDER } from '../src/index.ts';

describe('hasNamePlaceholder', () => {
  it('sees the placeholder in its spellings and nothing else', () => {
    expect(SAVED_REPLY_NAME_PLACEHOLDER).toBe('{tên}');
    expect(hasNamePlaceholder('Chào {tên}!')).toBe(true);
    expect(hasNamePlaceholder('Chào {Tên}!')).toBe(true);
    expect(hasNamePlaceholder('Chào {TÊN}!')).toBe(true);
    expect(hasNamePlaceholder('Chào {ten}!')).toBe(true);
    expect(hasNamePlaceholder('Chào { tên }!')).toBe(true);
    // A name typed with combining marks (NFD) is the same name.
    expect(hasNamePlaceholder('Chào {tên}!')).toBe(true);
    // Called twice on the same text, it answers the same (no state kept between calls).
    expect(hasNamePlaceholder('{tên}')).toBe(true);
    expect(hasNamePlaceholder('{tên}')).toBe(true);
    expect(hasNamePlaceholder('Chào anh!')).toBe(false);
    expect(hasNamePlaceholder('Giá [giá] ạ')).toBe(false);
    expect(hasNamePlaceholder('{tên khách}')).toBe(false);
    expect(hasNamePlaceholder('{giá}')).toBe(false);
    expect(hasNamePlaceholder('')).toBe(false);
  });
});

describe('fillNamePlaceholder', () => {
  it('puts the name in every place the placeholder stands', () => {
    expect(fillNamePlaceholder('Chào {tên}, cảm ơn {tên} đã nhắn shop ạ.', 'Mai Hương')).toBe('Chào Mai Hương, cảm ơn Mai Hương đã nhắn shop ạ.');
    expect(fillNamePlaceholder('Dạ {Tên} ơi', '  Linh  ')).toBe('Dạ Linh ơi');
  });

  it('leaves a text with no placeholder exactly as it is', () => {
    const body = 'Dạ  shop còn hàng ạ ,  mời bạn ghé shop .';
    expect(fillNamePlaceholder(body, 'Lan')).toBe(body);
    expect(fillNamePlaceholder(body, null)).toBe(body);
  });

  it('never lets a name write a placeholder or a special replacement pattern', () => {
    expect(fillNamePlaceholder('Chào {tên}!', '{tên}')).toBe('Chào tên!');
    expect(hasNamePlaceholder(fillNamePlaceholder('Chào {tên}!', '{ten} {Tên}'))).toBe(false);
    // "$&" and "$1" are plain text in a name, not a replacement pattern.
    expect(fillNamePlaceholder('Chào {tên}!', "$& $1 $'")).toBe("Chào $& $1 $'!");
  });

  it('cleans a name: one line, no control or invisible characters, at most 100 characters', () => {
    expect(fillNamePlaceholder('Chào {tên}!', 'Lan\nAnh\t​Nguyễn')).toBe('Chào Lan Anh Nguyễn!');
    const long = 'a'.repeat(300);
    expect(fillNamePlaceholder('{tên}', long)).toBe('a'.repeat(100));
    // A name that is nothing once cleaned is no name.
    expect(fillNamePlaceholder('Chào {tên}!', '​ \n')).toBe('Chào!');
    expect(fillNamePlaceholder('Chào {tên}!', '{}')).toBe('Chào!');
  });

  it('drops the placeholder cleanly when there is no name: no braces, no double space, no stray mark', () => {
    for (const name of [null, undefined, '', '   ']) {
      expect(fillNamePlaceholder('Chào {tên}, shop còn hàng ạ.', name)).toBe('Chào, shop còn hàng ạ.');
    }
    expect(fillNamePlaceholder('Chào anh {tên}!', null)).toBe('Chào anh!');
    expect(fillNamePlaceholder('Cảm ơn {tên} nhiều nhé', null)).toBe('Cảm ơn nhiều nhé');
    expect(fillNamePlaceholder('Cảm ơn bạn {tên}.', null)).toBe('Cảm ơn bạn.');
    expect(fillNamePlaceholder('{tên}, shop còn hàng ạ', null)).toBe('shop còn hàng ạ');
    expect(fillNamePlaceholder('Chào,\n{tên}: shop còn hàng ạ', null)).toBe('Chào,\nshop còn hàng ạ');
    expect(fillNamePlaceholder('Dạ {tên} {tên} ơi', null)).toBe('Dạ ơi');
    expect(fillNamePlaceholder('Dạ chào bạn, {tên}!', null)).toBe('Dạ chào bạn!');
    expect(fillNamePlaceholder('{tên}', null)).toBe('');
  });

  it('keeps line breaks and the words around a dropped placeholder', () => {
    expect(fillNamePlaceholder('Chào {tên}\nShop mở cửa 8h đến 21h.\n\nCảm ơn {tên}', null)).toBe('Chào\nShop mở cửa 8h đến 21h.\n\nCảm ơn');
  });

  it('never leaves a placeholder behind, whichever name or none is given', () => {
    const bodies = ['{tên}', 'a {tên}{tên} b', '{ten}, {Tên}; { TÊN }!', 'Xin chào {tên}'];
    for (const body of bodies) {
      for (const name of [null, '', 'Lan', '{tên}', '{{tên}}']) {
        const out = fillNamePlaceholder(body, name);
        expect(hasNamePlaceholder(out)).toBe(false);
        expect(out).not.toMatch(/[{}]/u);
      }
    }
  });
});

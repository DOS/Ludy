// The command palette's matching, order, shortcut and arrow keys (issue #439), and how the org's search results join
// the list (#673).
import { describe, expect, it } from 'vitest';
import {
  MAX_PALETTE_RECENTS,
  filterPalette,
  findSubmenuEntry,
  fold,
  isPaletteShortcut,
  moveActive,
  resolvePaletteResults,
  searchTerm,
  withFound,
  type PaletteEntry,
  type PaletteItem,
} from '../src/lib/palette.ts';

const items: PaletteItem[] = [
  { id: 'go:inbox', group: 'go', label: 'Chứng từ chờ duyệt' },
  { id: 'go:ledger', group: 'go', label: 'Sổ sách' },
  { id: 'go:vat', group: 'go', label: 'Tờ khai GTGT', keywords: 'vat thue' },
  { id: 'p1', group: 'proposals', label: 'Công ty CP Bao Bì Phú Thịnh', detail: 'HĐ 00001284, 32.832.000 ₫' },
  { id: 'p2', group: 'proposals', label: 'Điện lực EVN', detail: 'Hoá đơn điện tháng 9' },
  { id: 'sign-out', group: 'actions', label: 'Đăng xuất' },
  { id: 'org:b', group: 'orgs', label: 'Chuyển sang Gạo Sạch Mekong' },
];

const ids = (query: string, perGroup?: number) => filterPalette(items, query, perGroup).map((i) => i.id);

describe('fold', () => {
  it('drops case and Vietnamese marks, including đ', () => {
    expect(fold('Sổ Sách')).toBe('so sach');
    expect(fold('Điện lực ĐÀ NẴNG')).toBe('dien luc da nang');
    expect(fold('Hoá đơn')).toBe(fold('Hóa đơn'));
  });
});

describe('filterPalette', () => {
  it('shows every entry for an empty query, groups in order', () => {
    expect(ids('')).toEqual(['go:inbox', 'go:ledger', 'go:vat', 'p1', 'p2', 'org:b', 'sign-out']);
  });

  it('matches without marks, in the label, the detail or the keywords', () => {
    expect(ids('so sach')).toEqual(['go:ledger']);
    expect(ids('dien')).toEqual(['p2']);
    expect(ids('00001284')).toEqual(['p1']);
    expect(ids('vat')).toEqual(['go:vat']);
  });

  it('needs every typed word, in any order', () => {
    expect(ids('thinh bao')).toEqual(['p1']);
    expect(ids('thinh evn')).toEqual([]);
  });

  it('puts a label that starts with the query before one that only contains it', () => {
    const list: PaletteItem[] = [
      { id: 'a', group: 'go', label: 'Bút toán' },
      { id: 'b', group: 'go', label: 'Toán học' },
    ];
    expect(filterPalette(list, 'toan').map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('caps each group', () => {
    expect(ids('', 1)).toEqual(['go:inbox', 'p1', 'org:b', 'sign-out']);
  });
});

describe('isPaletteShortcut', () => {
  const key = (k: string, extra: Partial<Parameters<typeof isPaletteShortcut>[0]> = {}) =>
    isPaletteShortcut({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...extra });

  it('is Ctrl K or Cmd K, in either case', () => {
    expect(key('k', { ctrlKey: true })).toBe(true);
    expect(key('K', { metaKey: true })).toBe(true);
  });

  it('ignores K alone, other modifiers and a held key', () => {
    expect(key('k')).toBe(false);
    expect(key('k', { ctrlKey: true, altKey: true })).toBe(false);
    expect(key('k', { ctrlKey: true, shiftKey: true })).toBe(false);
    expect(key('k', { ctrlKey: true, repeat: true })).toBe(false);
    expect(key('j', { ctrlKey: true })).toBe(false);
  });
});

describe('moveActive', () => {
  it('moves with the arrows and wraps', () => {
    expect(moveActive('ArrowDown', 0, 3)).toBe(1);
    expect(moveActive('ArrowDown', 2, 3)).toBe(0);
    expect(moveActive('ArrowUp', 0, 3)).toBe(2);
  });

  it('leaves Home, End and other keys to the text field, and does nothing without results', () => {
    expect(moveActive('Home', 2, 3)).toBeNull();
    expect(moveActive('End', 0, 3)).toBeNull();
    expect(moveActive('a', 0, 3)).toBeNull();
    expect(moveActive('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('searchTerm', () => {
  it('asks the server for two characters or more with a letter or a digit', () => {
    expect(searchTerm('  dien  ')).toBe('dien');
    expect(searchTerm('12')).toBe('12');
    expect(searchTerm('đ')).toBeNull();
    expect(searchTerm('  ')).toBeNull();
    expect(searchTerm('!!')).toBeNull();
    expect(searchTerm('x'.repeat(150))).toHaveLength(100);
  });
});

describe('withFound', () => {
  it('places found entries in group order, unfiltered, so the arrows walk the list as shown', () => {
    const local = filterPalette(items, 'dien');
    const found: PaletteItem[] = [
      { id: 'entry:1', group: 'entries', label: 'Tiền điện tháng 9' },
      { id: 'party:1', group: 'parties', label: 'Công ty Điện lực', detail: 'MST 0101234564' },
      // An amount match: nothing in the label says "dien", and it stays.
      { id: 'entry:2', group: 'entries', label: 'Mua hàng', detail: '1.980.000 ₫' },
    ];
    expect(withFound(local, found).map((i) => i.id)).toEqual(['p2', 'party:1', 'entry:1', 'entry:2']);
    expect(withFound(filterPalette(items, 'xyz'), []).map((i) => i.id)).toEqual([]);
  });
});

describe('recent group and inline submenus (#4525)', () => {
  it('shows recent entries before Go to on empty query, caps recent at 5, and omits recent when searching', () => {
    const withRecents: PaletteItem[] = [
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `recent:${i}`,
        group: 'recent' as const,
        label: `Gần đây ${i}`,
      })),
      ...items,
    ];
    const emptyIds = filterPalette(withRecents, '').map((i) => i.id);
    expect(emptyIds.slice(0, MAX_PALETTE_RECENTS + 1)).toEqual([
      'recent:0',
      'recent:1',
      'recent:2',
      'recent:3',
      'recent:4',
      'go:inbox',
    ]);
    expect(emptyIds).not.toContain('recent:5');

    // Non-empty query drops recent items so screens are not duplicated.
    const queryIds = filterPalette(withRecents, 'gan day').map((i) => i.id);
    expect(queryIds).toEqual([]);
    expect(filterPalette(withRecents, 'so sach').map((i) => i.id)).toEqual(['go:ledger']);
  });

  it('resolves submenu entries separately from root entries and server search results', () => {
    const none = () => undefined;
    const entries: PaletteEntry[] = [
      { id: 'go:ledger', group: 'go', label: 'Sổ sách', run: none },
      {
        id: 'action:switch-theme',
        group: 'actions',
        label: 'Đổi giao diện',
        run: none,
        children: [
          { id: 'theme:light', group: 'actions', label: 'Sáng', run: none },
          { id: 'theme:dark', group: 'actions', label: 'Tối', keywords: 'dark', run: none },
        ],
      },
    ];
    const found: PaletteEntry[] = [{ id: 'party:1', group: 'parties', label: 'Điện lực', run: none }];

    const submenu = findSubmenuEntry(entries, 'action:switch-theme');
    expect(submenu?.id).toBe('action:switch-theme');
    expect(findSubmenuEntry(entries, 'go:ledger')).toBeNull();

    expect(resolvePaletteResults(entries, '', found, submenu).map((e) => e.id)).toEqual(['theme:light', 'theme:dark']);
    expect(resolvePaletteResults(entries, 'dark', found, submenu).map((e) => e.id)).toEqual(['theme:dark']);
    expect(resolvePaletteResults(entries, 'so sach', found, null).map((e) => e.id)).toEqual(['go:ledger', 'party:1']);

    // Submenus with > 8 items keep all options visible without truncating trailing actions.
    const manyOrgsEntry: PaletteEntry = {
      id: 'action:switch-org',
      group: 'actions',
      label: 'Đổi tổ chức',
      run: none,
      children: [
        ...Array.from({ length: 9 }, (_, i) => ({ id: `org:${i}`, group: 'orgs' as const, label: `Org ${i}`, run: none })),
        { id: 'switch-org:add', group: 'orgs' as const, label: 'Thêm tổ chức', run: none },
      ],
    };
    expect(resolvePaletteResults([manyOrgsEntry], '', found, manyOrgsEntry)).toHaveLength(10);
  });
});

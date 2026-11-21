// SPDX-License-Identifier: AGPL-3.0-only
// One icon per menu item (SH-6, #3588): Tài sản and Hàng hóa, Hóa đơn bán ra and Chứng từ, Nhân viên and Tuyển dụng drew the same one.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { ADMIN_ITEMS, APPS, BELL_ITEM, TOP_ITEMS, type NavItem } from '../src/lib/apps.ts';
import { APP_ICON, menuIcon } from '../src/lib/menu-icons.ts';

// What the browser draws: two names that map to one lucide icon are the same picture.
const drawn = (name: Parameters<typeof menuIcon>[0] | (typeof APP_ICON)[keyof typeof APP_ICON]) => renderToStaticMarkup(createElement(NavIcon, { name: name as never }));

const MENU_ITEMS: readonly NavItem[] = [...TOP_ITEMS, ...APPS.flatMap((a) => a.groups.flatMap((g) => g.items)), ...(BELL_ITEM ? [BELL_ITEM] : []), ...ADMIN_ITEMS];

describe('the icons of the shell menus (SH-6)', () => {
  it('gives every item of every menu, the rail included, a picture of its own', () => {
    const byPicture = new Map<string, string[]>();
    for (const item of MENU_ITEMS) {
      const picture = drawn(menuIcon(item.label));
      byPicture.set(picture, [...(byPicture.get(picture) ?? []), `${item.label} (${menuIcon(item.label)})`]);
    }
    const shared = [...byPicture.values()].filter((names) => names.length > 1);
    expect(shared, `items that share an icon: ${JSON.stringify(shared)}`).toEqual([]);
  });

  it('keeps the app switcher icons apart from each other', () => {
    const pictures = Object.values(APP_ICON).map(drawn);
    expect(new Set(pictures).size).toBe(pictures.length);
  });

  it('keeps the pairs the audit named apart', () => {
    for (const [a, b] of [
      ['fixedAssets', 'stock'],
      ['documents', 'salesInvoices'],
      ['documents', 'declarations'],
      ['employees', 'recruiting'],
      ['vouchers', 'payroll'],
      ['vouchers', 'aiUsage'],
      ['notes', 'signTemplates'],
      ['overview', 'accountingOverview'],
      ['settings', 'aiConnections'],
    ] as const) {
      expect(drawn(menuIcon(a)), `${a} vs ${b}`).not.toBe(drawn(menuIcon(b)));
    }
  });
});

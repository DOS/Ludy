// SPDX-License-Identifier: AGPL-3.0-only
// Settings has eleven sub-pages, each with its own address (ST-1, #3589; moved into the left sidebar in #4499): a spec that opens a card clicks the Settings item in the sidebar.
import type { Page } from '@playwright/test';

export const SETTINGS_TAB = {
  org: 'Tổ chức',
  members: 'Thành viên và quyền',
  apps: 'Ứng dụng',
  bookings: 'Lịch hẹn',
  sales: 'Bán hàng',
  quotes: 'Báo giá',
  accounting: 'Kế toán và thuế',
  connections: 'Kết nối',
  notifications: 'Thông báo của tôi',
  security: 'Bảo mật tài khoản',
  data: 'Dữ liệu và xóa tổ chức',
} as const;

// Clicks a Settings sub-page link in the left sidebar (on desktop after opening Settings, or inside an open mobile drawer).
export async function openSettingsTab(page: Page, tab: keyof typeof SETTINGS_TAB): Promise<void> {
  await page.getByRole('navigation').getByRole('region', { name: 'Cài đặt', exact: true }).getByRole('link', { name: SETTINGS_TAB[tab], exact: true }).click();
}

// SPDX-License-Identifier: AGPL-3.0-only
// Settings is seven tabs, each with its own address (ST-1, #3589): a spec that opens a card clicks the tab that holds it.
import type { Page } from '@playwright/test';

export const SETTINGS_TAB = {
  org: 'Tổ chức',
  members: 'Thành viên và quyền',
  apps: 'Ứng dụng',
  bookings: 'Lịch hẹn',
  sales: 'Bán hàng',
  accounting: 'Kế toán và thuế',
  connections: 'Kết nối',
  security: 'Bảo mật tài khoản',
  data: 'Dữ liệu và xóa tổ chức',
} as const;

// Clicks a tab of the strip over the Settings screen (after the sidebar's "Cài đặt" link, or on any tab).
export async function openSettingsTab(page: Page, tab: keyof typeof SETTINGS_TAB): Promise<void> {
  await page.getByRole('list', { name: 'Các thẻ của màn hình' }).getByRole('link', { name: SETTINGS_TAB[tab], exact: true }).click();
}

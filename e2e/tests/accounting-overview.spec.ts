// SPDX-License-Identifier: AGPL-3.0-only
// The Tổng quan of the Kế toán app (#2631), end to end on the stack: opening the app from the rail lands on it, it is the first item of the app's menu,
// a new org reads as empty with every card at 0 and the first steps linked, the period picker changes the period shown, and every card links to the screen
// behind it. With no model on the stack the coworker's sentence is hidden and nothing in its place. The figures against the books are checked on PostgreSQL
// in apps/kernel/test/finance-overview.db.test.ts.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('the Kế toán app opens on Tổng quan, with every card at 0 for a new org and the first steps linked', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('accounting-overview'));
  const slug = await createOrg(page, 'Công ty Tổng Quan Kế Toán');
  const nav = page.getByRole('navigation');

  await test.step('opening the app lands on Tổng quan, the first item of its menu', async () => {
    await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/accounting$`));
    await expect(page.getByRole('heading', { name: 'Tổng quan', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Tổng quan tài chính', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Chứng từ', exact: true })).toBeVisible();
  });

  await test.step('a new org has every card at 0 and points at the first steps, with no sentence from the coworker', async () => {
    for (const [card, label] of [
      ['cash', 'Tiền mặt và tiền gửi'],
      ['profit', 'Lợi nhuận trước thuế'],
      ['receivables', 'Khách hàng còn nợ'],
      ['payables', 'Nợ nhà cung cấp'],
    ] as const) {
      const cardBox = page.getByTestId(`overview-card-${card}`);
      await expect(cardBox).toContainText(label);
      await expect(cardBox).toContainText('30 ngày trước đó:');
    }
    await expect(page.getByText('Chưa có số liệu để hiển thị')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tải hóa đơn lên' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nhập sao kê ngân hàng' })).toBeVisible();
    await expect(page.getByTestId('overview-explanation')).toHaveCount(0);
  });

  await test.step('the period picker changes the period shown', async () => {
    const period = page.getByText(/^Kỳ này:/);
    const before = await period.textContent();
    await page.getByLabel('Kỳ xem').selectOption('this_year');
    await expect(period).not.toHaveText(before ?? '');
    await page.getByLabel('Kỳ xem').selectOption('last_month');
    await expect(period).toBeVisible();
  });

  await test.step('each card links to the screen behind its figure', async () => {
    for (const [card, link, path] of [
      ['cash', 'Mở sao kê ngân hàng', 'bank'],
      ['profit', 'Xem báo cáo kết quả', 'ledger'],
      ['receivables', 'Mở Khách hàng', 'customers'],
      ['payables', 'Mở Nhà cung cấp', 'vendors'],
    ] as const) {
      await page.goto(`/o/${slug}/accounting`);
      await page.getByTestId(`overview-card-${card}`).getByRole('link', { name: link }).click();
      await expect(page, card).toHaveURL(new RegExp(`/o/${slug}/${path}(\\?.*)?$`));
    }
  });
});

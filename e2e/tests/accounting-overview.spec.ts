// SPDX-License-Identifier: AGPL-3.0-only
// The Tổng quan of the Kế toán app (#2631), end to end on the stack: opening the app from the rail lands on it, it is the first item of the app's menu,
// a new org reads as empty with no cards (the first steps stand alone, #3602) and the first steps linked, and the period picker changes the period shown. The screen each
// card links to is checked on the card in apps/app/test/accounting-overview-cards.test.tsx. With no model on the stack the coworker's sentence is hidden and nothing in its place. The figures against the books are checked on PostgreSQL
// in apps/kernel/test/finance-overview.db.test.ts.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('the Kế toán app opens on Tổng quan, with no cards for a new org and the first steps linked', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('accounting-overview'));
  const slug = await createOrg(page, 'Công ty Tổng Quan Kế Toán');
  const nav = page.getByRole('navigation');

  await test.step('opening the app lands on Tổng quan, the first item of its menu', async () => {
    await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/accounting$`));
    // Not the same name as Home's "Tổng quan" (#3591): the heading and the tab title tell them apart.
    await expect(page.getByRole('heading', { name: 'Tổng quan tài chính', exact: true })).toBeVisible();
    await expect(page).toHaveTitle(/^Tổng quan tài chính · /);
    await expect(nav.getByRole('link', { name: 'Tổng quan tài chính', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^Chứng từ(\s+\d+\+?)?$/ })).toBeVisible();
  });

  await test.step('a new org has no cards and points at the first steps, with no sentence from the coworker', async () => {
    for (const card of ['cash', 'profit', 'receivables', 'payables']) await expect(page.getByTestId(`overview-card-${card}`)).toHaveCount(0);
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
});

// SPDX-License-Identifier: AGPL-3.0-only
// The quote editor's suggestion panel and the "Báo giá" report (#2699, Q5 #2698): with no model on the stack the sales coworker's button answers with one sentence and the editor
// keeps working; the screen passes an axe scan with the panel in it; the report tab counts the draft quote just made.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { exec } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('the suggestion panel answers when no model is on, the editor still works, and the Báo giá report counts the draft (#2698, #2699)', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('quote-suggest'));
  const slug = await createOrg(page, 'Công ty Báo Giá');
  exec(`INSERT INTO crove_kernel.party (org_id, name, kind) SELECT org_id, 'Khách hàng ABC', 'organization' FROM crove_kernel.tenant WHERE slug = :'slug'`, { slug });

  await page.getByRole('navigation').getByRole('link', { name: 'Engage', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Cơ hội' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/deals$`));

  await test.step('a deal and a quote made from it', async () => {
    await page.getByRole('button', { name: 'Thêm cơ hội' }).click();
    const form = page.getByRole('form', { name: 'Thêm cơ hội' });
    await form.getByLabel('Tên cơ hội').fill('Gói kế toán năm');
    await form.getByRole('searchbox', { name: 'Khách hàng' }).fill('ABC');
    await page.getByRole('button', { name: 'Khách hàng ABC' }).click();
    await form.getByLabel('Số tiền (VND)').fill('5000000');
    await form.getByRole('button', { name: 'Thêm', exact: true }).click();
    const card = page.getByTestId('deal-card').filter({ hasText: 'Gói kế toán năm' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Báo giá' }).click();
    await page.getByRole('button', { name: 'Tạo báo giá' }).click();
    await expect(page.getByTestId('quote-editor')).toBeVisible();
  });

  await test.step('the sales coworker says in one sentence that no model is on; the editor keeps working', async () => {
    await page.getByTestId('quote-suggest-ask').click();
    await expect(page.getByTestId('quote-suggest-state')).toHaveAttribute('data-state', 'off');
    await expect(page.getByTestId('quote-suggest-state')).toContainText('vẫn lập báo giá như bình thường');
    await expect(page.getByTestId('quote-suggest-line')).toHaveCount(0);
    await page.getByRole('button', { name: 'Thêm dòng hàng' }).click();
    await expect(page.getByTestId('quote-line')).toHaveCount(1);
  });

  await test.step('the screen passes an axe scan with the panel in it', async () => {
    const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.impact} ${v.id}`)).toEqual([]);
  });

  await test.step('the Báo giá report counts the draft quote', async () => {
    await page.goto(`/o/${slug}/reports?area=quotes`);
    await expect(page.getByRole('heading', { name: 'Báo giá theo trạng thái' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Nháp', exact: true })).toBeVisible();
    const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.impact} ${v.id}`)).toEqual([]);
  });
});

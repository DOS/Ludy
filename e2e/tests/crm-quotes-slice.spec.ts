// SPDX-License-Identifier: AGPL-3.0-only
// CRM quotes, the whole slice end to end (#2699, docs/plan/crm-quotes.md section 9): a deal, a quote made from it with a priced line, the quote sent by link (the send
// panel inside the editor does not submit the editor's own save, #2825), the public page that link opens with no sign-in, the customer's yes recorded by a person,
// the order that makes, and "Lập hóa đơn" on that order switched off until Kế toán's side lands (#2818). The Báo giá report then counts the accepted quote. It runs with no
// external account: nothing is mailed, nothing is posted to the books.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { exec } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('a deal becomes a quote, is sent by link, opens on the public page, is accepted into an order, and the report counts it (#2699)', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await signInNewUser(page, newEmail('quote-slice'));
  const slug = await createOrg(page, 'Công ty Cả Luồng Báo Giá');
  exec(`INSERT INTO crove_kernel.party (org_id, name, kind) SELECT org_id, 'Khách hàng ABC', 'organization' FROM crove_kernel.tenant WHERE slug = :'slug'`, { slug });
  const nav = page.getByRole('navigation');
  const dealCard = () => page.getByTestId('deal-card').filter({ hasText: 'Gói kế toán năm' });

  await test.step('a deal for the customer', async () => {
    await nav.getByRole('link', { name: 'Engage', exact: true }).click();
    await nav.getByRole('link', { name: 'Cơ hội' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/deals$`));
    await page.getByRole('button', { name: 'Thêm cơ hội' }).click();
    const form = page.getByRole('form', { name: 'Thêm cơ hội' });
    await form.getByLabel('Tên cơ hội').fill('Gói kế toán năm');
    await form.getByRole('searchbox', { name: 'Khách hàng' }).fill('ABC');
    await page.getByRole('button', { name: 'Khách hàng ABC' }).click();
    await form.getByLabel('Số tiền (VND)').fill('1500000');
    await form.getByRole('button', { name: 'Thêm', exact: true }).click();
    await expect(dealCard()).toBeVisible();
  });

  await test.step('a quote from the deal in one click, a priced line, saved as a draft', async () => {
    await dealCard().getByRole('button', { name: 'Báo giá' }).click();
    await page.getByRole('button', { name: 'Tạo báo giá' }).click();
    const editor = page.getByTestId('quote-editor');
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Thêm dòng hàng' }).click();
    const line = editor.getByTestId('quote-line').first();
    await line.getByLabel('Dòng 1: mô tả').fill('Gói kế toán năm');
    await line.getByLabel('Đơn giá (trước thuế)').fill('1500000');
    // The totals are the server's rule, shown while typing: 1.500.000 + 10% VAT.
    await expect(editor.getByTestId('quote-totals')).toContainText('1.650.000');
    await editor.getByRole('button', { name: 'Lưu báo giá' }).click();
    await expect(page.getByTestId('quote-row')).toHaveCount(1);
  });

  let link = '';
  await test.step('sent by link: the send panel does not submit the editor, and the link shows', async () => {
    await page.getByTestId('quote-row').getByRole('button', { name: 'Sửa', exact: true }).click();
    const editor = page.getByTestId('quote-editor');
    await expect(editor.getByTestId('quote-send')).toBeVisible();
    await editor.getByTestId('quote-send').getByRole('button', { name: 'Gửi và tạo liên kết' }).click();
    await expect(page.getByTestId('quote-new-link')).toBeVisible();
    link = await page.getByTestId('quote-new-link').getByLabel('Liên kết báo giá').inputValue();
    expect(link).toMatch(/^https?:\/\//);
    const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.impact} ${v.id}`)).toEqual([]);
  });

  await test.step('the link opens the quote on a public page with no sign-in', async () => {
    const stranger = await browser.newContext();
    try {
      const open = await stranger.newPage();
      await open.goto(link);
      await expect(open.getByText('Gói kế toán năm').first()).toBeVisible();
      await expect(open.getByText('1.650.000').first()).toBeVisible();
      // Nothing of the app around it: no menu, no sign-in.
      await expect(open.getByRole('navigation')).toHaveCount(0);
    } finally {
      await stranger.close();
    }
  });

  await test.step('the customer says yes: a person records it and the order is made', async () => {
    await page.goto(`/o/${slug}/deals`);
    await dealCard().getByRole('button', { name: 'Báo giá' }).click();
    await expect(page.getByTestId('quote-row')).toHaveCount(1);
    await page.getByTestId('quote-accept-open').click();
    const panel = page.getByTestId('quote-accept');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Ghi nhận và tạo đơn hàng' }).click();
    const orders = page.getByTestId('deal-orders');
    await expect(orders.getByTestId('order-row')).toHaveCount(1);
    await expect(orders.getByTestId('order-row')).toContainText('Đã xác nhận');
    // "Lập hóa đơn" stays off until Kế toán's side is switched on; nothing was invoiced or moved out of stock.
    await expect(orders.getByTestId('order-invoice')).toBeDisabled();
  });

  await test.step('a second acceptance is not offered, and the Báo giá report counts the accepted quote', async () => {
    await expect(page.getByTestId('quote-accept-open')).toHaveCount(0);
    await page.goto(`/o/${slug}/reports?area=quotes`);
    await expect(page.getByRole('heading', { name: 'Báo giá theo trạng thái' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Đã chấp nhận', exact: true })).toBeVisible();
    await expect(page.getByText('1.650.000').first()).toBeVisible();
  });
});

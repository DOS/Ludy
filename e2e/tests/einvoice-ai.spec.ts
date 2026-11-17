// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on a sales e-invoice draft (#2505), end to end with AI OFF (the stack has no model): the draft form shows the coworker's box, asking it says plainly that AI is not on
// and fills nothing, and the form works exactly as before: a person types the lines, sees the amounts computed by the server and saves the draft. Nothing leaves the stack.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

test('with AI off the coworker says so, fills nothing, and the draft form works as before', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await signUp(page, newEmail('einvoice-ai'));
  await createOrg(page, 'Công ty Soạn Hóa Đơn E2E');
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
  await nav.getByRole('link', { name: 'Hóa đơn bán ra' }).click();
  await page.getByTestId('invoice-new').click();
  const form = page.getByTestId('invoice-form');

  await test.step('asking the coworker with AI off gives a plain answer and changes no field', async () => {
    const ask = page.getByTestId('invoice-ai-ask');
    await expect(ask).toBeDisabled();
    await page.getByTestId('invoice-ai-text').fill('bán 10 hộp bánh A giá 120k cho anh Nam, thuế 8%');
    await ask.click();
    await expect(page.getByTestId('invoice-ai-state')).toHaveAttribute('data-state', 'off');
    await expect(page.getByTestId('invoice-ai-state')).toContainText('chưa bật AI');
    await expect(form.getByLabel('Tên hàng hóa, dịch vụ').first()).toHaveValue('');
    await expect(form.getByLabel('Đơn giá').first()).toHaveValue('');
    await expect(page.getByTestId('invoice-line-ai')).toHaveCount(0);
    await expect(page.getByTestId('invoice-buyer-ai')).toHaveCount(0);
  });

  await test.step('the previous-invoice source is there, offers no copy until a customer with an issued invoice is chosen, and needs no model (#2721)', async () => {
    const picker = page.getByTestId('invoice-previous-customer');
    await expect(picker).toBeVisible();
    await expect(page.getByTestId('invoice-previous-copy')).toHaveCount(0);
    await expect(page.getByTestId('invoice-ai-source')).toHaveCount(0);
    // A new org has no CRM deal or booking yet: the CRM source shows nothing and the form is unchanged (#2721).
    await expect(page.getByTestId('invoice-crm')).toHaveCount(0);
  });

  await test.step('the person types the lines and the server computes the amounts', async () => {
    await form.getByLabel('Tên hàng hóa, dịch vụ').first().fill('Bánh A');
    await form.getByLabel('Số lượng').first().fill('10');
    await form.getByLabel('Đơn giá').first().fill('120000');
    await expect(page.getByTestId('invoice-total')).toContainText(/1\.320\.000/);
    await page.getByTestId('invoice-save').click();
    await expect(page.getByTestId('invoice-form')).toBeHidden();
    await expect(page.getByTestId('invoice-draft')).toContainText('Bản nháp');
  });
});

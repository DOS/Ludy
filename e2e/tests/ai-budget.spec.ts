// SPDX-License-Identifier: AGPL-3.0-only
// The AI budget meter on the compose stack (#2382): this month's use by feature on the Agents page, an owner setting the
// org's monthly budget with a fresh second factor (R3), a spent budget shown as spent, and the core going on regardless:
// an e-invoice XML is still read into a proposal while the budget is spent. The e2e stack has no AI endpoint (AI_BASE_URL
// is empty), so the meter says AI is off here; the refusal at 100%, the photo that waits and its reading once the budget is
// raised are walked against PostgreSQL in apps/kernel/test/ai-budget.db.test.ts.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { exec } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

test('the AI meter says AI is off, the Agents page shows the month by feature, a spent budget stays spent, and XML is still read', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('ai-budget'));
  const slug = await createOrg(page, 'Công ty Ngân Sách AI');

  await test.step('with no AI endpoint the Inbox says so, and that the books keep working', async () => {
    await page.goto(`/o/${slug}/inbox`);
    await expect(page.getByRole('heading', { name: 'Chứng từ chờ duyệt' })).toBeVisible();
    const meter = page.getByTestId('ai-meter');
    await expect(meter).toHaveAttribute('data-state', 'off');
    await expect(meter).toContainText('AI đang tắt trên máy chủ này');
    await expect(meter).toContainText('Sổ sách, duyệt chứng từ và xuất báo cáo vẫn chạy bình thường');
  });

  await test.step('the month so far, by feature, from the ledger (numbers only)', async () => {
    for (const [feature, module, amount] of [
      ['social.draft', 'social', '0.003'],
      ['finance.invoice_extract', 'finance', '0.001'],
    ] as const) {
      exec(
        `INSERT INTO crove_kernel.org_usage (org_id, metric, amount, feature, module, input_tokens, output_tokens)
         SELECT t.org_id, 'ai_cost', :'amount'::numeric, :'feature', :'module', 1000, 100 FROM crove_kernel.tenant t WHERE t.slug = :'slug'`,
        { slug, feature, module, amount },
      );
    }
    await page.getByRole('navigation').getByRole('link', { name: 'Ludy AI', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Ngân sách AI' }).click();
    await expect(page.getByRole('heading', { name: 'Dùng AI tháng này' })).toBeVisible();
    const rows = page.getByTestId('ai-use-feature');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Soạn bài đăng' })).toBeVisible();
    await expect(rows.filter({ hasText: 'Đọc hóa đơn từ PDF và ảnh' })).toBeVisible();
    await expect(page.getByTestId('ai-use-total')).toContainText('2 lượt gọi');
  });

  await test.step('an owner sets the monthly budget with a fresh second factor, and it shows as spent', async () => {
    await page.getByLabel('Hạn mức mỗi tháng').fill('0.004');
    await page.getByRole('button', { name: 'Đặt ngân sách' }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    const budget = page.getByTestId('budget-row');
    await expect(budget).toHaveCount(1);
    await expect(budget).toContainText('Toàn tổ chức');
    await expect(budget).toContainText('Chặn cứng khi dùng hết');
    await expect(budget).toContainText('Đã hết');
  });

  await test.step('at 100% the core goes on: an e-invoice XML is read into a proposal', async () => {
    await page.goto(`/o/${slug}/inbox`);
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('recent-file').filter({ hasText: 'einvoice-basic.xml' })).toContainText('Chờ duyệt');
  });
});

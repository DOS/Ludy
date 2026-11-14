// SPDX-License-Identifier: AGPL-3.0-only
// Issuing a sales e-invoice (#2502, ADR-0044), end to end on the offline provider and the stack's own worker: the org sets its tax code and connects the provider ->
// drafts an invoice -> asks to issue it (a one-person org approves its own request with a second factor) -> the worker sends it, the draft is issued with its number and
// its signed XML stored -> the XML is read into a sale in the Inbox, approved like any sale, and it is in the books. Nothing leaves the stack.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { nextTotp } from '../lib/totp.ts';

// Synthetic tax codes with a valid check digit (the draft's checks read the buyer's).
const SELLER_TAX_CODE = '0100109106';
const BUYER_TAX_CODE = '0309876547';
const BUYER = 'Công ty Mua Thử E2E';

test('asks to issue a draft, sees it issued by the worker with its original stored, and posts the sale read from that original', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await signUp(page, newEmail('einvoice-issue'));
  await createOrg(page, 'Công ty Phát hành E2E');
  const nav = page.getByRole('navigation');

  await test.step('the org sets its tax code and connects the offline provider, whose series are read', async () => {
    await nav.getByRole('link', { name: 'Cài đặt' }).click();
    await page.getByRole('button', { name: 'Nhập', exact: true }).click();
    const form = page.getByRole('form', { name: 'Mã số thuế' });
    await form.getByLabel('Mã số thuế').fill(SELLER_TAX_CODE);
    await form.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.getByRole('definition').getByText(SELLER_TAX_CODE, { exact: true })).toBeVisible();
    const card = page.getByLabel('Hóa đơn điện tử: nhà cung cấp của bạn');
    await card.getByRole('button', { name: 'Kết nối', exact: true }).click();
    await expect(card.getByText('Nhà cung cấp hóa đơn thử nghiệm', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Kiểm tra kết nối' }).click();
    await expect(card.getByText('Kết nối dùng được')).toBeVisible();
  });

  await test.step('a draft for a business buyer is saved', async () => {
    await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await nav.getByRole('link', { name: 'Hóa đơn bán ra' }).click();
    await page.getByTestId('invoice-new').click();
    const form = page.getByTestId('invoice-form');
    await form.getByLabel('Mã số thuế').fill(BUYER_TAX_CODE);
    await form.getByLabel('Tên người mua').fill(BUYER);
    await form.getByLabel('Địa chỉ').fill('1 Phố Thử, Hà Nội');
    await form.getByLabel('Tên hàng hóa, dịch vụ').first().fill('Dịch vụ tư vấn');
    await form.getByLabel('Số lượng').first().fill('2');
    await form.getByLabel('Đơn giá').first().fill('500000');
    await expect(page.getByTestId('invoice-total')).toContainText(/1\.100\.000/);
    await page.getByTestId('invoice-save').click();
    await expect(page.getByTestId('invoice-form')).toBeHidden();
    await expect(page.getByTestId('invoice-draft')).toContainText('Bản nháp');
  });

  await test.step('asking to issue needs a second factor; the owner alone approves their own request', async () => {
    await page.getByTestId('invoice-issue-button').click();
    await expect(page.getByText('Việc này cần xác thực hai lớp.')).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
  });

  await test.step('the worker sends it: the draft is issued with the provider\'s number and its original stored', async () => {
    const row = page.getByTestId('invoice-draft');
    await expect(row).toContainText('Đã phát hành', { timeout: 120_000 });
    await expect(row).toContainText(/Số \d+/);
    // The original is stored a moment after the number comes back; the screen looks again by itself.
    await expect(row).not.toContainText('Đang lưu bản gốc', { timeout: 120_000 });
    await expect(page.getByTestId('invoice-issue-button')).toHaveCount(0);
    await expect(page.getByTestId('invoice-edit')).toHaveCount(0);
  });

  await test.step('the signed XML is read into a sale of the org in the Inbox', async () => {
    await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await nav.getByRole('link', { name: 'Chứng từ', exact: true }).click();
    const proposal = page.getByRole('row').filter({ has: page.getByRole('link', { name: BUYER }) });
    await expect(proposal).toBeVisible({ timeout: 120_000 });
    await expect(proposal.getByText('Bán ra')).toBeVisible();
    await proposal.getByRole('link', { name: BUYER }).click();
    await expect(page.getByText('Hóa đơn bán ra: người bán có mã số thuế của tổ chức.', { exact: false })).toBeVisible();
  });

  await test.step('approving it posts the sale to the books', async () => {
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await expect(page.getByText('Không có đề xuất nào chờ duyệt')).toBeVisible();
    await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await nav.getByRole('link', { name: 'Chứng từ', exact: true }).click();
    await page.getByRole('link', { name: 'Tất cả chứng từ' }).click();
    const document = page.getByRole('row').filter({ hasText: BUYER });
    await expect(document).toContainText('Bán ra');
    await expect(document).toContainText('Đã ghi sổ');
  });
});

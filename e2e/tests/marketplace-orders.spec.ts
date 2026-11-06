// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order reports (#2515, ADR-0045), end to end: a Shopee order report is dropped on the Inbox, waits there as a card that
// says what it holds and says nothing of the buyer, is imported, and its shipped line that matches no stock item waits on the
// "Hàng hóa" screen until a member assigns it to an item, which takes the quantity out of stock and lists the order with that item.
// The reader and the stock rules are checked in apps/extract, packages/l10n-vn and apps/kernel/test/finance-marketplace.db.test.ts.
import { expect, test } from '@playwright/test';
import { buildXlsx, type XlsxCell } from '../../apps/extract/test/xlsx-fixture.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

// What the report carries about the buyer: the importer never reads these columns, so none of it may appear anywhere.
const BUYER = { name: 'Lê Thị Mua Thử', phone: '0900000004', email: 'mua.thu.e2e@example.com', address: '42 Phố Thử, Quận Thử, Hà Nội' };
const SKU = 'E2E-AO-01';
const HEAD: XlsxCell[] = ['Mã đơn hàng', 'Ngày đặt hàng', 'Trạng Thái Đơn Hàng', 'Người Mua', 'Số điện thoại', 'Địa chỉ nhận hàng', 'Email', 'SKU phân loại hàng', 'Tên sản phẩm', 'Giá ưu đãi', 'Số lượng', 'Tổng giá bán (sản phẩm)'];
const row = (order: string, status: string, qty: number): XlsxCell[] => [order, '2026-10-30 14:05', status, BUYER.name, BUYER.phone, BUYER.address, BUYER.email, SKU, 'Áo thun cổ tròn', 50000, qty, 50000 * qty];
const REPORT = buildXlsx([['Báo cáo đơn hàng'], HEAD, row('E2E-U1', 'Đang giao', 3), row('E2E-U2', 'Chờ xác nhận', 1)]);

test('an imported report waits for its shipped line to be assigned, then takes the stock out and lists the order', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('marketplace'));
  await createOrg(page, 'Công ty bán trên sàn');
  await expect(page.getByRole('heading', { name: 'Chứng từ chờ duyệt' })).toBeVisible();

  await test.step('the report waits in the Inbox as a card with the counts and no buyer value', async () => {
    await page.locator('input[type=file]').setInputFiles({
      name: 'bao-cao-don-hang-shopee.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(REPORT),
    });
    const card = page.getByTestId('staged-marketplace-report');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card).toContainText('Shopee');
    await expect(card).toContainText('2 đơn, 2 dòng');
    for (const value of Object.values(BUYER)) await expect(page.getByText(value, { exact: false })).toHaveCount(0);
  });

  await test.step('importing it stores the orders; the shipped line matches no item so it moves nothing yet', async () => {
    await page.getByTestId('staged-marketplace-import').click();
    await expect(page.getByText('Đã nhập 2 dòng, ghi 0 phát sinh kho')).toBeVisible();
    await expect(page.getByTestId('staged-marketplace-report')).toHaveCount(0);
  });

  await test.step('the shipped line waits on the stock screen, and no item exists yet to assign it to', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Hàng hóa' }).click();
    await expect(page.getByRole('heading', { name: 'Hàng hóa' })).toBeVisible();
    const waiting = page.getByTestId('marketplace-unassigned-line');
    await expect(waiting).toHaveCount(1);
    await expect(waiting).toContainText('E2E-U1');
    await expect(waiting).toContainText(SKU);
    await expect(page.getByText('Hãy thêm mặt hàng trước khi gán.')).toBeVisible();
    // The placed order has not shipped, so only the confirmed orders list shows it.
    const orders = page.getByTestId('marketplace-order');
    await expect(orders).toHaveCount(2);
    await expect(orders.filter({ hasText: 'E2E-U2' })).toContainText('Chờ giao');
  });

  await test.step('a new item and the assignment: stock goes out once, the line leaves the waiting list, the order shows its item', async () => {
    await page.getByTestId('stock-new').click();
    const form = page.getByTestId('stock-item-form');
    await form.getByLabel('Mã', { exact: true }).fill('AO01');
    await form.getByLabel('Tên', { exact: true }).fill('Áo thun cổ tròn');
    await form.getByLabel('Đơn vị').fill('cái');
    await page.getByTestId('stock-item-save').click();
    await expect(page.getByTestId('stock-item')).toHaveCount(1);

    const waiting = page.getByTestId('marketplace-unassigned-line');
    await waiting.getByLabel('Chọn mặt hàng').selectOption({ label: 'AO01 Áo thun cổ tròn' });
    await waiting.getByTestId('marketplace-assign').click();
    await expect(page.getByTestId('marketplace-unassigned')).toHaveCount(0);
    // Three went out of an empty store, which the screen shows as a negative balance, not as an error.
    await expect(page.getByTestId('stock-item')).toContainText('-3');
    await expect(page.getByTestId('marketplace-order').filter({ hasText: 'E2E-U1' })).toContainText('AO01');
    for (const value of Object.values(BUYER)) await expect(page.getByText(value, { exact: false })).toHaveCount(0);
  });

  await test.step('taking the line back from its item puts the stock back and the line in the waiting list again', async () => {
    await page.getByTestId('marketplace-order').filter({ hasText: 'E2E-U1' }).getByTestId('marketplace-unassign').click();
    await page.getByTestId('marketplace-unassign-confirm').click();
    await expect(page.getByTestId('marketplace-unassigned-line')).toHaveCount(1);
    await expect(page.getByTestId('stock-item')).not.toContainText('-3');
    await expect(page.getByTestId('marketplace-order').filter({ hasText: 'E2E-U1' })).not.toContainText('AO01');
  });

  await test.step('the month of the order cannot be closed while an item is below zero: the screen says so and nothing is closed (#2513)', async () => {
    await page.locator('#stock-month').fill('2026-10');
    await expect(page.getByTestId('stock-report-state')).toContainText('Tạm tính');
    await page.getByTestId('stock-close-open').click();
    await expect(page.getByTestId('stock-close-confirm')).toBeVisible();
    await page.getByTestId('stock-close-submit').click();
    await expect(page.getByTestId('stock-close-confirm')).toContainText('âm kho');
    await expect(page.getByTestId('stock-report-state')).toContainText('Tạm tính');
  });
});

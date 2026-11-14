// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace income reports (#2516, ADR-0045), end to end with AI off: a Shopee order report is imported so its orders are known, then an income report is dropped on the Inbox, waits there as
// a card that shows the period, the totals and the net the file states and says nothing of the buyer, and is confirmed by a person. A second report that names orders the org does not know shows
// its refusal in words, holds the confirm button, and is skipped. No model is called: the screen is code, and a person decides each report. The reader is checked in apps/extract and the
// checks and guards in apps/kernel/test/finance-marketplace-income.db.test.ts.
import { expect, test } from '@playwright/test';
import { buildXlsx, type XlsxCell } from '../../apps/extract/test/xlsx-fixture.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

// What the reports carry about the buyer: neither reader takes these columns, so none of it may appear anywhere.
const BUYER = { name: 'Trần Thị Mua Thử', phone: '0900000007', email: 'mua.thu.income.e2e@example.com' };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ORDER_HEAD: XlsxCell[] = ['Mã đơn hàng', 'Ngày đặt hàng', 'Trạng Thái Đơn Hàng', 'Người Mua', 'Số điện thoại', 'Email', 'SKU phân loại hàng', 'Tên sản phẩm', 'Giá ưu đãi', 'Số lượng', 'Tổng giá bán (sản phẩm)'];
const orderRow = (order: string): XlsxCell[] => [order, '2026-11-01 10:00', 'Hoàn thành', BUYER.name, BUYER.phone, BUYER.email, 'E2E-INC-01', 'Áo thun cổ tròn', 50000, 1, 50000];
const ORDER_REPORT = buildXlsx([['Báo cáo đơn hàng'], ORDER_HEAD, orderRow('2611A1'), orderRow('2611A2')]);

const INCOME_HEAD: XlsxCell[] = ['Mã đơn hàng', 'Người Mua', 'Số điện thoại', 'Email', 'Ngày hoàn tất thanh toán', 'Giá sản phẩm', 'Mã giảm giá của Shop', 'Phí cố định', 'Phí dịch vụ', 'Phí giao dịch', 'Thuế GTGT', 'Thuế TNCN', 'Tổng số tiền đã thanh toán'];
const incomeRow = (order: string, paid: string, sales: number, discount: number, commission: number, service: number, payment: number, vat: number, pit: number, net: number): XlsxCell[] => [
  order, BUYER.name, BUYER.phone, BUYER.email, paid, sales, -discount, -commission, -service, -payment, -vat, -pit, net,
];
const SUMMARY: XlsxCell[][] = [['Tóm tắt'], ['Kỳ báo cáo', '01/11/2026 - 07/11/2026']];
const incomeReport = (rows: XlsxCell[][], total: number) => buildXlsx(SUMMARY, { sheetName: 'Summary', moreSheets: [{ name: 'Income', rows: [['Báo cáo thu nhập'], INCOME_HEAD, ...rows, ['', '', '', '', '', '', '', '', '', '', '', '', total]] }] });
const KNOWN = incomeReport([incomeRow('2611A1', '2026-11-03', 100000, 10000, 5000, 2000, 1500, 500, 500, 80500), incomeRow('2611A2', '2026-11-04', 50000, 0, 2500, 1000, 750, 250, 250, 45250)], 125750);
const UNKNOWN = incomeReport([incomeRow('2611Z9', '2026-11-05', 100000, 0, 5000, 2000, 1500, 500, 500, 90500)], 90500);

test('an income report waits as a card, is confirmed by a person; one naming unknown orders shows its refusal and is skipped', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('marketplace-income'));
  await createOrg(page, 'Công ty bán trên sàn');
  // A new org opens on the overview (#3225); the uploads are on the Inbox.
  await page.goto(page.url().replace(/\/overview$/, '/inbox'));
  await expect(page.getByRole('heading', { name: 'Chứng từ chờ duyệt' })).toBeVisible();
  const upload = (name: string, buffer: Uint8Array) => page.locator('input[type=file]').setInputFiles({ name, mimeType: XLSX, buffer: Buffer.from(buffer) });
  const noBuyer = async () => {
    for (const value of Object.values(BUYER)) await expect(page.getByText(value, { exact: false })).toHaveCount(0);
  };

  await test.step('the order report is imported first, so the orders of the income report are known', async () => {
    await upload('bao-cao-don-hang-shopee.xlsx', ORDER_REPORT);
    await expect(page.getByTestId('staged-marketplace-report')).toBeVisible({ timeout: 90_000 });
    await page.getByTestId('staged-marketplace-import').click();
    await expect(page.getByTestId('staged-marketplace-report')).toHaveCount(0);
  });

  await test.step('the income report waits as a card with the period, the totals and the net the file states, and no buyer value', async () => {
    await upload('bao-cao-thu-nhap-shopee.xlsx', KNOWN);
    const card = page.getByTestId('staged-income-report');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card).toContainText('Shopee');
    await expect(card).toContainText('2 đơn, 2 dòng');
    await expect(card).toContainText('03/11/2026 đến 04/11/2026');
    await expect(card.getByTestId('staged-income-total-net')).toContainText('125.750');
    await expect(card.getByTestId('staged-income-net')).toContainText('Tệp ghi tổng sàn thực trả là');
    await expect(card.getByTestId('staged-income-blockers')).toHaveCount(0);
    await noBuyer();
  });

  await test.step('confirming stores the settlement; the card leaves the Inbox', async () => {
    await page.getByTestId('staged-income-confirm').click();
    await expect(page.getByText('Đã nhập 2 dòng, sàn thực trả')).toBeVisible();
    await expect(page.getByTestId('staged-income-report')).toHaveCount(0);
  });

  await test.step('a report that names an order the org does not know shows the refusal in words and cannot be confirmed', async () => {
    await upload('bao-cao-thu-nhap-shopee-2.xlsx', UNKNOWN);
    const card = page.getByTestId('staged-income-report');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card.getByTestId('staged-income-blocker-UNKNOWN_ORDERS')).toContainText('hãy nhập báo cáo đơn hàng của cùng kỳ trước');
    await expect(card.getByTestId('staged-income-blocker-UNKNOWN_ORDERS')).toContainText('2611Z9');
    await expect(card.getByTestId('staged-income-confirm')).toBeDisabled();
    await noBuyer();
  });

  await test.step('skipping it stores nothing and the card leaves the Inbox', async () => {
    await page.getByTestId('staged-income-reject').click();
    await expect(page.getByText('Đã bỏ qua báo cáo; không có gì được lưu')).toBeVisible();
    await expect(page.getByTestId('staged-income-report')).toHaveCount(0);
  });
});

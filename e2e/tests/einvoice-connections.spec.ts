// SPDX-License-Identifier: AGPL-3.0-only
// The e-invoice provider card in Settings (#2501), end to end on the offline provider: an owner connects it (the org has no tax code yet, so the form asks for one),
// tests the connection and sees the series read in words, makes the second the default, and disconnects. Nothing is issued and nothing leaves the server.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

test('connects the offline e-invoice provider from Settings, tests it, picks the default series and disconnects', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('einvoice-connect'));
  await createOrg(page, 'Công ty Kết nối E2E');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
  const card = page.getByLabel('Hóa đơn điện tử: nhà cung cấp của bạn');

  await test.step('the card is there, with nothing connected and a form that asks for the tax code', async () => {
    // Under the section the owner looks for by its name, with the bank feed's card beside it where the deployment offers one.
    await expect(page.getByRole('heading', { name: 'Tích hợp', exact: true })).toBeVisible();
    await expect(page.getByText('Kết nối Ludy với ngân hàng và đơn vị phát hành hóa đơn của công ty.')).toBeVisible();
    await expect(card).toBeVisible();
    await expect(card.getByText('Chưa kết nối nhà cung cấp nào.')).toBeVisible();
    await expect(card.getByText('Nhà cung cấp thử nghiệm chạy ngay trên máy chủ này')).toBeVisible();
    await expect(card.getByLabel('Mã số thuế người bán')).toBeVisible();
  });

  await test.step('connecting needs the seller tax code the entity does not have yet', async () => {
    await card.getByRole('button', { name: 'Kết nối', exact: true }).click();
    await expect(card.getByText('Hãy nhập mã số thuế cho pháp nhân này')).toBeVisible();
    await card.getByLabel('Mã số thuế người bán').fill('0100109106');
    await card.getByRole('button', { name: 'Kết nối', exact: true }).click();
    await expect(card.getByText('Nhà cung cấp hóa đơn thử nghiệm', { exact: true })).toBeVisible();
    await expect(card.getByText('Mã số thuế người bán 0100109106')).toBeVisible();
    await expect(card.getByText('Đang kết nối')).toBeVisible();
    await expect(card.getByText('Chưa kiểm tra')).toBeVisible();
    await expect(card.getByText('Chưa có ký hiệu nào.')).toBeVisible();
  });

  await test.step('the test reads the provider\'s series and says the connection works', async () => {
    await card.getByRole('button', { name: 'Kiểm tra kết nối' }).click();
    await expect(card.getByText('Kết nối dùng được')).toBeVisible();
    await expect(card.getByText('Mẫu 1, ký hiệu C26TSB')).toBeVisible();
    await expect(card.getByText('Mẫu 2, ký hiệu C26TSM')).toBeVisible();
    await expect(card.getByText('có mã của cơ quan thuế').first()).toBeVisible();
    await expect(card.getByText('năm 2026').first()).toBeVisible();
    // The first series is the default; the other offers to become it.
    await expect(card.getByText('Mặc định', { exact: true })).toHaveCount(1);
    await expect(card.getByRole('button', { name: 'Chọn làm mặc định' })).toHaveCount(1);
  });

  await test.step('the default moves to the second series', async () => {
    await card.getByRole('button', { name: 'Chọn làm mặc định' }).click();
    const series = card.getByTestId('einvoice-series');
    await expect(series.filter({ hasText: 'ký hiệu C26TSM' }).getByText('Mặc định', { exact: true })).toBeVisible();
    await expect(series.filter({ hasText: 'ký hiệu C26TSB' }).getByText('Mặc định', { exact: true })).toBeHidden();
    await expect(series.filter({ hasText: 'ký hiệu C26TSB' }).getByRole('button', { name: 'Chọn làm mặc định' })).toBeVisible();
  });

  await test.step('the series are the ones the invoice form offers', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Hóa đơn bán ra' }).click();
    await expect(page.getByTestId('invoice-no-series')).toBeHidden();
  });

  await test.step('disconnecting asks first, then drops the connection and keeps the series', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
    await card.getByRole('button', { name: 'Ngắt kết nối' }).click();
    await card.getByRole('button', { name: 'Ngắt kết nối' }).last().click();
    await expect(card.getByText('Chưa kết nối nhà cung cấp nào.')).toBeVisible();
    // The series are the entity's and stay: the invoice form still offers them.
    await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Hóa đơn bán ra' }).click();
    await expect(page.getByTestId('invoice-no-series')).toBeHidden();
  });
});

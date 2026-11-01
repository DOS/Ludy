// SPDX-License-Identifier: AGPL-3.0-only
// CRM slice 1 end to end (#2231, docs/plan/crm.md step K7): a member imports contacts from a CSV, finds one without typing
// its Vietnamese marks, saves a view of the contacts, adds a deal for an imported contact, moves it to Won on the board, and
// reads the contact's timeline. It runs the flow the owner asked for in one go, with no external account.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

const CSV = ['Tên,Mã số thuế,Email,Số điện thoại', 'Công ty ABC,0123456780,abc@khach.test,0901 111 222', 'Nguyễn Văn An,,an@khach.test,0902 333 444', 'Trần Thị Bình,,,0903 555 666'].join('\n');

test('import contacts, find and save a view, add a deal, move it to Won, read the timeline', async ({ page }) => {
  const email = newEmail('crm-slice');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Cả Luồng');
  const nav = page.getByRole('navigation');

  await test.step('imports three contacts from a CSV', async () => {
    await nav.getByRole('link', { name: 'CRM', exact: true }).click();
    await nav.getByRole('link', { name: 'Liên hệ' }).click();
    await page.getByRole('link', { name: 'Nhập từ tệp' }).click();
    await page.getByLabel('Tệp Excel hoặc CSV').setInputFiles({ name: 'khach-hang.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf-8') });
    await page.getByRole('button', { name: 'Xem trước' }).click();
    await expect(page.getByText('3 dòng mới')).toBeVisible();
    await page.getByRole('button', { name: 'Nhập 3 liên hệ mới' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã nhập 3 liên hệ mới' })).toBeVisible();
    await page.getByRole('link', { name: 'Về danh sách liên hệ' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/contacts$`));
    await expect(page.getByText('Trần Thị Bình')).toBeVisible();
  });

  await test.step('searching without marks finds "Nguyễn Văn An"', async () => {
    await page.getByRole('searchbox').first().fill('nguyen van');
    await expect(page.getByText('Nguyễn Văn An')).toBeVisible();
    await expect(page.getByText('Công ty ABC')).toHaveCount(0);
    await page.getByRole('searchbox').first().fill('');
    await expect(page.getByText('Công ty ABC')).toBeVisible();
  });

  await test.step('a filter saved as a view comes back as a tab after a reload', async () => {
    await page.getByRole('combobox', { name: 'Có email' }).selectOption({ label: 'Có' });
    await expect(page.getByText('Trần Thị Bình')).toHaveCount(0);
    await page.getByRole('button', { name: 'Lưu thành chế độ xem' }).click();
    await page.getByLabel('Tên chế độ xem').fill('Khách có email');
    await page.getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Khách có email' })).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Khách có email' }).click();
    await expect(page.getByText('Công ty ABC')).toBeVisible();
    await expect(page.getByText('Trần Thị Bình')).toHaveCount(0);
  });

  await test.step('adds a deal for an imported contact and moves it to Won on the board', async () => {
    await nav.getByRole('link', { name: 'Cơ hội' }).click();
    await page.getByRole('button', { name: 'Thêm cơ hội' }).click();
    const form = page.getByRole('form', { name: 'Thêm cơ hội' });
    await form.getByLabel('Tên cơ hội').fill('Gói kế toán năm');
    await form.getByRole('searchbox', { name: 'Khách hàng' }).fill('ABC');
    await page.getByRole('button', { name: 'Công ty ABC' }).click();
    await form.getByLabel('Số tiền (VND)').fill('15000000');
    await form.getByRole('button', { name: 'Thêm', exact: true }).click();
    const board = page.getByTestId('deal-board');
    await expect(board.getByRole('region', { name: 'Mới' }).getByTestId('deal-card').filter({ hasText: 'Gói kế toán năm' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Giai đoạn của cơ hội Gói kế toán năm' }).selectOption({ label: 'Báo giá' });
    await expect(board.getByRole('region', { name: 'Báo giá' }).getByTestId('deal-card').filter({ hasText: 'Gói kế toán năm' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Giai đoạn của cơ hội Gói kế toán năm' }).selectOption({ label: 'Thắng' });
    await expect(board.getByRole('region', { name: 'Thắng' }).getByTestId('deal-card').filter({ hasText: 'Gói kế toán năm' })).toBeVisible();
  });

  await test.step("the contact's panel shows the deal and a timeline of what happened", async () => {
    await nav.getByRole('link', { name: 'Liên hệ' }).click();
    await page.getByRole('button', { name: 'Mở Công ty ABC' }).click();
    await expect(page.getByTestId('contact-deals')).toContainText('Gói kế toán năm');
    const timeline = page.getByTestId('contact-timeline');
    await expect(timeline).toContainText('Nhập từ tệp');
    await expect(timeline).toContainText('Tạo cơ hội bán hàng');
    await expect(timeline).toContainText('Chuyển cơ hội sang giai đoạn khác');
    await expect(timeline).toContainText('Cơ hội đã thắng');
    // The timeline holds no title or amount.
    await expect(timeline).not.toContainText('Gói kế toán năm');
    await expect(timeline).not.toContainText('15.000.000');
  });
});

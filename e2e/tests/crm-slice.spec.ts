// SPDX-License-Identifier: AGPL-3.0-only
// CRM slice 1 end to end (#2231, docs/plan/crm.md step K7): a member imports contacts from a CSV, finds one without typing
// its Vietnamese marks, saves a view of the contacts, adds a deal for an imported contact, moves it to Won on the board, and
// reads the contact's timeline. It runs the flow the owner asked for in one go, with no external account.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

const CSV = ['Tên,Mã số thuế,Email,Số điện thoại', 'Công ty ABC,0123456780,abc@khach.test,0901 111 222', 'Nguyễn Văn An,,an@khach.test,0900 333 333', 'Trần Thị Bình,,,0900 555 555'].join('\n');

test('import contacts, find and save a view, add a deal, move it to Won, read the timeline', async ({ page }) => {
  const email = newEmail('crm-slice');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Cả Luồng');
  const nav = page.getByRole('navigation');

  await test.step('imports three contacts from a CSV', async () => {
    await nav.getByRole('link', { name: 'Engage', exact: true }).click();
    await nav.getByRole('link', { name: 'Người liên hệ' }).click();
    await page.getByRole('link', { name: 'Nhập từ tệp' }).click();
    await page.getByLabel('Tệp Excel hoặc CSV').setInputFiles({ name: 'khach-hang.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf-8') });
    await page.getByRole('button', { name: 'Xem trước' }).click();
    await expect(page.getByText('3 dòng mới')).toBeVisible();
    await page.getByRole('button', { name: 'Nhập 3 liên hệ mới' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã nhập 3 liên hệ mới' })).toBeVisible();
    // #3650: back goes to the screen the import came from; a link when the page was opened directly, a button when it was reached in the app.
    await page.getByRole('link', { name: 'Quay lại danh sách' }).or(page.getByRole('button', { name: 'Quay lại danh sách' })).first().click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/contacts$`));
    await expect(page.getByText('Trần Thị Bình')).toBeVisible();
  });

  await test.step('searching without marks finds "Nguyễn Văn An"', async () => {
    await page.getByRole('searchbox').first().fill('nguyen van');
    await expect(page.getByText('Nguyễn Văn An')).toBeVisible();
    await expect(page.getByText('Trần Thị Bình')).toHaveCount(0);
    await page.getByRole('searchbox').first().fill('');
    await expect(page.getByText('Trần Thị Bình')).toBeVisible();
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
    await expect(page.getByText('Nguyễn Văn An')).toBeVisible();
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
    // The card shows in its new column at once and carries the old version until the board is read again: the next move waits
    // for that, as a person's second move would.
    const moveTo = async (stage: string) => {
      const moved = page.waitForResponse((r) => r.url().includes('/crm/deals/move'));
      const refreshed = page.waitForResponse((r) => r.url().includes('/crm/deals/board'));
      await page.getByRole('combobox', { name: 'Giai đoạn của cơ hội Gói kế toán năm' }).selectOption({ label: stage });
      await moved;
      await refreshed;
    };
    await moveTo('Báo giá');
    await expect(board.getByRole('region', { name: 'Báo giá' }).getByTestId('deal-card').filter({ hasText: 'Gói kế toán năm' })).toBeVisible();
    await moveTo('Thắng');
    await expect(board.getByRole('region', { name: 'Thắng' }).getByTestId('deal-card').filter({ hasText: 'Gói kế toán năm' })).toBeVisible();
  });

  await test.step("the contact's panel shows the deal and a timeline of what happened", async () => {
    // Công ty ABC has a tax code, so the import made it a company: it is on the Companies screen (#2438).
    await nav.getByRole('link', { name: 'Công ty', exact: true }).click();
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

  await test.step('the screens fit a 375 px phone with no sideways scroll of the page, and the deal form opens from the keyboard', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    const sidewaysScroll = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    for (const [path, ready] of [
      ['contacts', page.getByRole('searchbox').first()],
      ['deals', page.getByRole('button', { name: 'Thêm cơ hội' })],
      ['contacts/import', page.getByLabel('Tệp Excel hoặc CSV')],
    ] as const) {
      await page.goto(`/o/${slug}/${path}`);
      await expect(ready).toBeVisible();
      expect(await sidewaysScroll(), path).toBeLessThanOrEqual(0);
    }
    // The keyboard alone: focus the button, press Enter, the form is there.
    await page.goto(`/o/${slug}/deals`);
    await page.getByRole('button', { name: 'Thêm cơ hội' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('form', { name: 'Thêm cơ hội' })).toBeVisible();
  });
});

// #3292: a contact added inside the deal form, a duplicate tax code refused with the owner's name, a deal added from the contact's panel.
test('add a contact inside the deal form, and a deal from the contact panel', async ({ page }) => {
  const email = newEmail('crm-inline');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Thêm Nhanh');
  const dealForm = () => page.getByRole('form', { name: 'Thêm cơ hội' });
  const group = () => page.getByRole('group', { name: 'Thêm liên hệ mới' });
  const openForm = async () => {
    await page.goto(`/o/${slug}/deals`);
    await page.getByRole('button', { name: 'Thêm cơ hội' }).click();
    await expect(dealForm()).toBeVisible();
  };

  await test.step('a deal for a customer who is not yet a contact, without leaving the form', async () => {
    await openForm();
    await dealForm().getByLabel('Tên cơ hội').fill('Gói tư vấn');
    await dealForm().getByRole('searchbox', { name: 'Khách hàng' }).fill('Khách Mới');
    await expect(page.getByText('Không thấy khách hàng nào khớp.')).toBeVisible();
    await page.getByRole('button', { name: 'Thêm liên hệ mới' }).click();
    await expect(group().getByLabel('Tên', { exact: true })).toHaveValue('Khách Mới');
    await group().getByLabel('Điện thoại').fill('0912 345 678');
    await group().getByRole('button', { name: 'Thêm liên hệ', exact: true }).click();
    await expect(group()).toHaveCount(0);
    await expect(dealForm().getByText('Khách Mới')).toBeVisible();
    await dealForm().getByLabel('Số tiền (VND)').fill('5000000');
    await dealForm().getByRole('button', { name: 'Thêm', exact: true }).click();
    await expect(page.getByTestId('deal-board').getByTestId('deal-card').filter({ hasText: 'Gói tư vấn' })).toBeVisible();
  });

  await test.step('a tax code that already belongs to a contact is refused and names it; the deal is not created', async () => {
    await openForm();
    await dealForm().getByLabel('Tên cơ hội').fill('Gói thuế');
    await dealForm().getByRole('searchbox', { name: 'Khách hàng' }).fill('Công ty Thuế');
    await page.getByRole('button', { name: 'Thêm liên hệ mới' }).click();
    await group().getByLabel('Loại').selectOption('organization');
    await group().getByLabel('Mã số thuế').fill('0123456780');
    await group().getByRole('button', { name: 'Thêm liên hệ', exact: true }).click();
    await expect(dealForm().getByText('Công ty Thuế')).toBeVisible();
    await dealForm().getByRole('button', { name: 'Hủy' }).click();
    await openForm();
    await dealForm().getByRole('searchbox', { name: 'Khách hàng' }).fill('Công ty Trùng');
    await page.getByRole('button', { name: 'Thêm liên hệ mới' }).click();
    await group().getByLabel('Loại').selectOption('organization');
    await group().getByLabel('Mã số thuế').fill('0123456780');
    await group().getByRole('button', { name: 'Thêm liên hệ', exact: true }).click();
    await expect(group().getByText('Công ty Thuế')).toBeVisible();
    await expect(group()).toBeVisible();
    await group().getByRole('button', { name: 'Hủy' }).click();
    await expect(page.getByRole('searchbox', { name: 'Khách hàng' })).toBeVisible();
  });

  await test.step('a phone number already on a contact offers that contact instead of making a second one', async () => {
    await openForm();
    await dealForm().getByRole('searchbox', { name: 'Khách hàng' }).fill('Người Khác');
    await page.getByRole('button', { name: 'Thêm liên hệ mới' }).click();
    // The same number as "Khách Mới", written another way.
    await group().getByLabel('Điện thoại').fill('+84 912 345 678');
    await group().getByRole('button', { name: 'Thêm liên hệ', exact: true }).click();
    await expect(group().getByTestId('deal-new-party-existing')).toContainText('Khách Mới');
    await group().getByRole('button', { name: 'Chọn liên hệ này' }).click();
    await expect(group()).toHaveCount(0);
    await expect(dealForm().getByText('Khách Mới')).toBeVisible();
    await page.goto(`/o/${slug}/contacts`);
    await expect(page.getByText('Người Khác')).toHaveCount(0);
  });

  await test.step("the contact's panel adds a deal for that contact, owner defaulted to the member", async () => {
    await page.goto(`/o/${slug}/contacts`);
    await page.getByRole('button', { name: 'Mở Khách Mới' }).click();
    const deals = page.getByTestId('contact-deals');
    await expect(deals).toContainText('Gói tư vấn');
    await page.getByRole('button', { name: 'Thêm cơ hội cho Khách Mới' }).click();
    const form = deals.getByRole('form', { name: 'Thêm cơ hội' });
    await expect(form.getByText('Khách Mới')).toBeVisible();
    await expect(form.getByRole('searchbox')).toHaveCount(0);
    await expect(form.getByLabel('Người phụ trách')).toHaveValue('me');
    await form.getByLabel('Tên cơ hội').fill('Gói gia hạn');
    await form.getByLabel('Số tiền (VND)').fill('2000000');
    await form.getByRole('button', { name: 'Thêm', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(deals).toContainText('Gói gia hạn');
    await expect(deals).toContainText('Gói tư vấn');
  });

  await test.step('on a 375 px phone nothing scrolls sideways and the keyboard opens the inline group', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openForm();
    await dealForm().getByRole('searchbox', { name: 'Khách hàng' }).fill('Người Chưa Có');
    await page.getByRole('button', { name: 'Thêm liên hệ mới' }).focus();
    await page.keyboard.press('Enter');
    await expect(group()).toBeVisible();
    await group().getByLabel('Loại').selectOption('organization');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

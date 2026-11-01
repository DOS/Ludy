// SPDX-License-Identifier: AGPL-3.0-only
// Ads end to end (ADR-0040, #2217, plan docs/plan/ads.md slice A1): from the Social app on the left rail an owner opens
// Ads, connects the offline sandbox ad platform in dong, and sees the figures its worker reads within seconds appear on
// their own: the totals with a spend and, once a result kind is chosen, a cost per result; the months, campaigns and days
// (a day not final yet marked in words); the books strip beside the ledger's advertising expense, with its difference. A
// second test account in dollars is not set beside the books in dong. The screen passes an axe scan with data, at desktop
// and phone width, in both themes. Disconnecting an account asks first and leaves its stored figures readable, in a quiet
// "disconnected" state with Refresh off. Nothing here posts to the books or changes a campaign: Ads only reads.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

// The rules of the layout walk (layout.spec.ts): WCAG 2.2 AA, then landmarks and heading order by id.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const STRUCTURE_RULES = ['landmark-one-main', 'region', 'landmark-unique', 'page-has-heading-one', 'heading-order'];

// The figure beside a label of the totals ("Chi phí quảng cáo" and its amount).
const stat = (totals: Locator, label: string): Locator => totals.locator(`dt:text-is("${label}") + dd`).first();

// The page at 1280 and at 360 pixels, in light and dark: it never scrolls sideways, axe finds no serious or critical
// violation, and no landmark or heading rule is broken.
async function problemsOf(page: Page, url: string): Promise<string[]> {
  const problems: string[] = [];
  for (const [width, theme] of [[1280, 'light'], [360, 'light'], [360, 'dark']] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
    await page.goto(url);
    await expect(page.getByRole('region', { name: 'Tổng cộng' })).toBeVisible();
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
    if (widths.page > widths.view) problems.push(`${width} ${theme}: scrolls sideways (${widths.page}px in ${widths.view}px)`);
    const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    for (const v of scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')) {
      problems.push(`${width} ${theme}: ${v.impact} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
    }
    const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
    for (const v of structure.violations) problems.push(`${width} ${theme}: ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  return problems;
}

test('an owner connects a sandbox ad account and reads its spend, results and cost per result next to the books', async ({ page }) => {
  test.setTimeout(420_000);
  await signInNewUser(page, newEmail('ads'));
  const slug = await createOrg(page, 'Công ty Quảng cáo');
  const nav = page.getByRole('navigation');
  const totals = page.getByRole('region', { name: 'Tổng cộng' });
  const settings = page.getByRole('form', { name: 'Cài đặt tài khoản quảng cáo' });
  const books = page.getByRole('region', { name: 'So với sổ sách' });

  await test.step('Ads is a group of the Social app on the rail', async () => {
    await nav.getByRole('link', { name: 'Mạng xã hội' }).click();
    const group = nav.getByRole('region', { name: 'Quảng cáo' });
    await expect(group).toBeVisible();
    await group.getByRole('link', { name: 'Quảng cáo' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/ads$`));
    await expect(page.getByRole('heading', { name: 'Quảng cáo', level: 1 })).toBeVisible();
  });

  await test.step('with no account yet it says what Ads shows and offers a test account', async () => {
    await expect(page.getByText('Chưa có tài khoản quảng cáo nào')).toBeVisible();
    await expect(page.getByText('không tạo, sửa hay tắt chiến dịch nào', { exact: false })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Kết nối tài khoản quảng cáo thử' })).toBeVisible();
    // Nothing is asked of a name left empty: the form says what is missing and nothing is connected.
    await page.getByRole('button', { name: 'Kết nối tài khoản thử' }).click();
    await expect(page.getByText('Nhập tên cho tài khoản quảng cáo này.')).toBeVisible();
  });

  await test.step('connect a test ad account in dong', async () => {
    const form = page.getByRole('form', { name: 'Kết nối tài khoản quảng cáo thử' });
    await form.getByLabel('Tên tài khoản quảng cáo').fill('Quảng cáo cửa hàng E2E');
    await form.getByLabel('Đơn vị tiền').selectOption('VND');
    await form.getByRole('button', { name: 'Kết nối tài khoản thử' }).click();
    await expect(page).toHaveURL(/\/ads\?account=[0-9a-f-]{36}/);
    // The sandbox says plainly that its figures are made up.
    await expect(page.getByText('Thử nghiệm (số liệu mẫu)')).toBeVisible();
    const rows = sql<{ provider: string }>(`SELECT a.provider FROM crove_ads.ad_account a JOIN crove_kernel.tenant t ON t.org_id = a.org_id WHERE t.slug = :'slug'`, { slug });
    expect(rows).toEqual([{ provider: 'sandbox_ads' }]);
  });

  await test.step('the worker reads the first figures within seconds and the screen follows by itself', async () => {
    // The platform's currency and time zone arrive with the first read, in place of "syncing for the first time".
    await expect(page.getByText('Tiền tệ VND, múi giờ Asia/Ho_Chi_Minh')).toBeVisible({ timeout: 90_000 });
    // The whole history the app keeps, so every slice of the first read counts, whatever day it is.
    await page.getByLabel('Khoảng thời gian').selectOption('last13Months');
    await expect(totals).toBeVisible();
    await expect(stat(totals, 'Chi phí quảng cáo')).toHaveText(/[1-9]/, { timeout: 60_000 });
    await expect(stat(totals, 'Lượt hiển thị')).toHaveText(/[1-9]/);
    await expect(stat(totals, 'Lượt nhấp')).toHaveText(/[1-9]/);
    // By month, by campaign and by day, with a header row and at least one row each.
    for (const name of ['Theo tháng', 'Theo chiến dịch', 'Theo ngày']) {
      await expect.poll(() => page.getByRole('region', { name }).getByRole('row').count(), { message: `rows of ${name}` }).toBeGreaterThan(1);
    }
    await expect(page.getByRole('region', { name: 'Theo chiến dịch' }).getByText('Khuyến mãi mùa hè')).toBeVisible();
    // The platform still revises its latest days: the screen says which are not final, in words.
    await expect(page.getByRole('region', { name: 'Theo ngày' }).getByText('chưa chốt', { exact: true }).first()).toBeVisible();
    const stored = sql<{ days: number }>(
      `SELECT count(*)::int AS days FROM crove_ads.ad_spend_day d JOIN crove_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug' AND d.level = 'account'`,
      { slug },
    );
    expect(stored[0]?.days).toBeGreaterThan(30);
  });

  await test.step('with no result kind chosen the results give way to a prompt, not to a made-up cost', async () => {
    await expect(totals.getByText('Chọn hành động được tính là một kết quả', { exact: false })).toBeVisible();
    await expect(totals.locator('dt:text-is("Chi phí mỗi kết quả")')).toHaveCount(0);
  });

  await test.step('choose purchases as the result: the results and the cost per result appear', async () => {
    await settings.getByLabel('Loại kết quả được tính').selectOption('purchase');
    await settings.getByRole('button', { name: 'Lưu cài đặt' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã lưu cài đặt tài khoản quảng cáo.' })).toBeVisible();
    await expect(stat(totals, 'Kết quả')).toHaveText(/[1-9]/);
    await expect(totals.getByText('Mua hàng', { exact: true })).toBeVisible();
    await expect(stat(totals, 'Chi phí mỗi kết quả')).toHaveText(/[1-9]/);
    const rows = sql<{ result_kind: string | null }>(`SELECT a.result_kind FROM crove_ads.ad_account a JOIN crove_kernel.tenant t ON t.org_id = a.org_id WHERE t.slug = :'slug'`, { slug });
    expect(rows).toEqual([{ result_kind: 'purchase' }]);
  });

  await test.step('without an expense account the books strip only says how to get it', async () => {
    await expect(books).toBeVisible();
    await expect(books.getByText('chọn tài khoản chi phí quảng cáo ở phần cài đặt', { exact: false })).toBeVisible();
    await expect(books.getByRole('table')).toHaveCount(0);
  });

  await test.step('a code that is not an account is refused on the spot', async () => {
    await settings.getByLabel('Tài khoản chi phí quảng cáo trong sổ').fill('64');
    await settings.getByRole('button', { name: 'Lưu cài đặt' }).click();
    await expect(settings.getByText('Mã tài khoản gồm 3 đến 10 chữ số', { exact: false })).toBeVisible();
  });

  await test.step('with the advertising expense account, each month with spend sits beside the books, and the difference is shown', async () => {
    await settings.getByLabel('Tài khoản chi phí quảng cáo trong sổ').fill('6421');
    await settings.getByRole('button', { name: 'Lưu cài đặt' }).click();
    await expect(books.getByRole('columnheader', { name: 'Nền tảng báo' })).toBeVisible();
    await expect(books.getByRole('columnheader', { name: 'Đã ghi sổ' })).toBeVisible();
    await expect(books.getByRole('columnheader', { name: 'Chênh lệch' })).toBeVisible();
    await expect.poll(() => books.getByRole('row').count(), { message: 'a row per month with spend' }).toBeGreaterThan(1);
    // The books hold nothing for advertising yet, so the whole spend is the difference: shown, not explained away.
    await expect(books.getByText('không sửa sổ sách và không đoán nguyên nhân', { exact: false })).toBeVisible();
    const rows = sql<{ expense_account_code: string | null }>(`SELECT a.expense_account_code FROM crove_ads.ad_account a JOIN crove_kernel.tenant t ON t.org_id = a.org_id WHERE t.slug = :'slug'`, { slug });
    expect(rows).toEqual([{ expense_account_code: '6421' }]);
  });

  await test.step('the screen passes an axe scan with data, at desktop and phone width, in both themes', async () => {
    expect(await problemsOf(page, page.url())).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => localStorage.setItem('crove-theme', 'light'));
  });

  await test.step('a second test account, in dollars, is not set beside the books in dong', async () => {
    await page.goto(`/o/${slug}/ads`);
    await page.getByRole('button', { name: 'Kết nối tài khoản thử khác' }).click();
    const form = page.getByRole('form', { name: 'Kết nối tài khoản quảng cáo thử' });
    await form.getByLabel('Tên tài khoản quảng cáo').fill('Quảng cáo bằng đô la');
    await form.getByLabel('Đơn vị tiền').selectOption('USD');
    await form.getByRole('button', { name: 'Kết nối tài khoản thử' }).click();
    await expect(page).toHaveURL(/\/ads\?account=[0-9a-f-]{36}/);
    await expect(page.getByText('Tiền tệ USD, múi giờ America/Los_Angeles')).toBeVisible({ timeout: 90_000 });
    // Each account is picked from the list, and the address keeps the pick.
    const picker = page.getByLabel('Tài khoản quảng cáo', { exact: true });
    await expect(picker.locator('option')).toHaveCount(2);
    await page.getByLabel('Khoảng thời gian').selectOption('last13Months');
    await expect(stat(totals, 'Chi phí quảng cáo')).toHaveText(/[1-9]/, { timeout: 60_000 });
    await settings.getByLabel('Tài khoản chi phí quảng cáo trong sổ').fill('6421');
    await settings.getByRole('button', { name: 'Lưu cài đặt' }).click();
    await expect(books.getByText('Sổ sách ghi bằng đồng, còn tài khoản này tính bằng USD', { exact: false })).toBeVisible();
    await expect(books.getByRole('table')).toHaveCount(0);
    // Back to the account in dong: its comparison is there again.
    await picker.selectOption({ label: 'Quảng cáo cửa hàng E2E' });
    await expect(books.getByRole('columnheader', { name: 'Chênh lệch' })).toBeVisible();
  });

  await test.step('Refresh now asks the worker again, and a second ask within a minute is told calmly', async () => {
    const refresh = page.getByRole('button', { name: 'Làm mới ngay' });
    await refresh.click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã yêu cầu làm mới số liệu.' })).toBeVisible();
    await refresh.click();
    // The screen reads the kernel's own Vietnamese for the refusal.
    await expect(page.getByText('Vừa mới làm mới tài khoản này', { exact: false })).toBeVisible();
    // Told, not alarmed: no error alert.
    await expect(page.getByRole('alert').filter({ hasText: 'Vừa mới làm mới tài khoản này' })).toHaveCount(0);
  });

  await test.step('Disconnect asks first, keeps the stored figures readable, and leaves the account quiet and not refreshable', async () => {
    // Ads is the only place to disconnect an ad account: the channels screen does not list it.
    const trigger = page.getByRole('button', { name: 'Ngắt kết nối', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Ngắt kết nối tài khoản quảng cáo này?' });
    await trigger.click();
    await expect(dialog.getByText('Số liệu đã lưu vẫn được giữ; bạn có thể kết nối lại sau.', { exact: false })).toBeVisible();
    // Cancel leaves everything as it was.
    await dialog.getByRole('button', { name: 'Hủy' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Đã ngắt kết nối', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Làm mới ngay' })).toBeEnabled();

    await trigger.click();
    await dialog.getByRole('button', { name: 'Ngắt kết nối', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã ngắt kết nối tài khoản quảng cáo.' })).toBeVisible();

    // A quiet "disconnected" state: the account stays in the picker, Refresh is off, and nothing says it is live.
    await expect(page.getByText('Đã ngắt kết nối', { exact: true })).toBeVisible();
    await expect(page.getByText('Tài khoản này đã được ngắt kết nối nên không được cập nhật nữa.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Làm mới ngay' })).toBeDisabled();
    await expect(page.getByText('Số liệu đã cập nhật đến')).toHaveCount(0);
    await expect(page.getByText('Lần cập nhật tiếp theo')).toHaveCount(0);
    await expect(page.getByText('Số liệu đã lưu đến hết ngày', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ngắt kết nối', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Tài khoản quảng cáo', { exact: true }).locator('option')).toHaveCount(2);

    // The stored figures are still there to read, with their tables and the books strip.
    await expect(stat(totals, 'Chi phí quảng cáo')).toHaveText(/[1-9]/);
    await expect.poll(() => page.getByRole('region', { name: 'Theo tháng' }).getByRole('row').count(), { message: 'the months still listed' }).toBeGreaterThan(1);
    await expect(books.getByRole('columnheader', { name: 'Chênh lệch' })).toBeVisible();

    // In the database only that connection is revoked, and no figure was dropped.
    const connections = sql<{ name: string; status: string }>(
      `SELECT a.name, c.status FROM crove_ads.ad_account a
         JOIN crove_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.channel_connection_id
         JOIN crove_kernel.tenant t ON t.org_id = a.org_id
        WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(connections).toHaveLength(2);
    expect(connections).toEqual(
      expect.arrayContaining([
        { name: 'Quảng cáo cửa hàng E2E', status: 'revoked' },
        { name: 'Quảng cáo bằng đô la', status: 'active' },
      ]),
    );
    const kept = sql<{ days: number }>(
      `SELECT count(*)::int AS days FROM crove_ads.ad_spend_day d
         JOIN crove_ads.ad_account a ON a.org_id = d.org_id AND a.id = d.ad_account_id
         JOIN crove_kernel.tenant t ON t.org_id = d.org_id
        WHERE t.slug = :'slug' AND a.name = 'Quảng cáo cửa hàng E2E' AND d.level = 'account'`,
      { slug },
    );
    expect(kept[0]?.days).toBeGreaterThan(30);

    // A reload shows the same.
    await page.reload();
    await expect(page.getByText('Đã ngắt kết nối', { exact: true })).toBeVisible();
    await expect(stat(totals, 'Chi phí quảng cáo')).toHaveText(/[1-9]/);
  });
});

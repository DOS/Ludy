// SPDX-License-Identifier: AGPL-3.0-only
// Settings "Ứng dụng" (ADR-0053, slice d of #3307): an owner starts with every app on, switches Social off after the confirmation, and its screen no longer opens
// (the address goes to the overview, as for an app the deployment leaves out); switching it back on opens it again. The AI coworker here: none acts, every change is a person's.
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { openSettingsTab } from '../lib/settings.ts';

// The receiving tab's stream is up before the owner changes anything: a hint sent before it subscribed would never reach it.
const streamUp = (page: Page) => page.waitForResponse((r) => /\/api\/stream(\?|$)/.test(r.url()) && !r.url().includes('/tickets'));

test('an owner switches Social off and on again from Settings', async ({ page }) => {
  await signUp(page, newEmail('org-apps'));
  const slug = await createOrg(page, 'Công ty chọn ứng dụng');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
  await openSettingsTab(page, 'apps');

  const social = page.getByTestId('org-app-social');
  await expect(social).toBeVisible();
  await expect(social.getByRole('checkbox')).toBeChecked();

  // Turning off asks first and says what is kept.
  await social.getByRole('checkbox').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Tắt Hộp thư & Bài đăng?')).toBeVisible();
  await expect(dialog.getByText('Dữ liệu được giữ nguyên')).toBeVisible();
  await dialog.getByRole('button', { name: 'Giữ nguyên' }).click();
  await expect(social.getByRole('checkbox')).toBeChecked();

  await social.getByRole('checkbox').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận tắt' }).click();
  await expect(social.getByText('Đã tắt')).toBeVisible();
  await expect(social.getByRole('checkbox')).not.toBeChecked();

  // The screen does not open for anyone in the company: the address goes to the overview.
  await page.goto(`/o/${slug}/social`);
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/overview$`));

  // Back on: everything is where it was.
  await page.goto(`/o/${slug}/settings/apps`);
  await page.getByTestId('org-app-social').getByRole('checkbox').click();
  await expect(page.getByTestId('org-app-social').getByRole('checkbox')).toBeChecked();
  await page.goto(`/o/${slug}/social`);
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/social`));
  // The screen is there, not a loading or an error state: Engage is back in the menu and the Social page shows its own subtitle.
  await expect(page.getByRole('complementary').getByRole('list', { name: 'Ứng dụng' }).getByRole('link', { name: 'Engage' })).toBeVisible();
  await expect(page.getByRole('main').getByText('Soạn một lần, chỉnh theo từng kênh')).toBeVisible();
});

// Another open tab of the same company follows within seconds, through the stream: a screen of the app that was switched off goes to the overview.
test('an open screen of an app goes to the overview when the owner switches the app off in another tab', async ({ page, context }) => {
  await signUp(page, newEmail('org-apps-live'));
  const slug = await createOrg(page, 'Công ty hai thẻ');
  const other = await context.newPage();
  const up = streamUp(other);
  await other.goto(`/o/${slug}/social`);
  await expect(other).toHaveURL(new RegExp(`/o/${slug}/social`));
  await up;

  await page.goto(`/o/${slug}/settings/apps`);
  await page.getByTestId('org-app-social').getByRole('checkbox').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận tắt' }).click();
  await expect(page.getByTestId('org-app-social').getByText('Đã tắt')).toBeVisible();

  await expect(other).toHaveURL(new RegExp(`/o/${slug}/overview$`), { timeout: 15_000 });
});

// A screen that stays is rendered again, not rebuilt: what its user has typed is kept while its app list changes.
test('the Settings of another open tab drops the cards of an app that was switched off, and keeps what is typed in its own field', async ({ page, context }) => {
  await signUp(page, newEmail('org-apps-rerender'));
  const slug = await createOrg(page, 'Công ty giữ nội dung');
  const other = await context.newPage();
  const up = streamUp(other);
  // The members tab holds the approval rule, a finance card, and the invite form.
  await other.goto(`/o/${slug}/settings/members`);
  await expect(other.getByText('Nhắc duyệt đề xuất').first()).toBeVisible();
  // Typed into a field the screen itself owns (the invite form's email), not sent.
  await other.getByRole('button', { name: 'Mời thành viên' }).click();
  await other.getByPlaceholder('email@congty.vn').fill('dang-go-do@example.test');
  await up;

  await page.goto(`/o/${slug}/settings/apps`);
  await page.getByTestId('org-app-finance').getByRole('checkbox').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận tắt' }).click();
  await expect(page.getByTestId('org-app-finance').getByText('Đã tắt')).toBeVisible();

  // Finance's cards (the approval rule with its reminders) are gone from the other tab, and the typed text is still there: the screen was rendered again, not rebuilt.
  await expect(other.getByText('Nhắc duyệt đề xuất')).toHaveCount(0, { timeout: 15_000 });
  await expect(other.getByPlaceholder('email@congty.vn')).toHaveValue('dang-go-do@example.test');
});

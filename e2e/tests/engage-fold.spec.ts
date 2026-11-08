// SPDX-License-Identifier: AGPL-3.0-only
// The CRM folded into the one Engage app (#2435), end to end on the stack with every module on: the rail has the one app and no CRM app, its three
// groups (Hộp thư, Khách hàng & Bán hàng, Marketing) and the Báo cáo item open their screens, an old `crm/...` address opens the screen in the
// app with its search, and the reports have a tab for each area. Which groups and tabs show for which modules is checked by the unit tests
// (apps/app/test/apps.test.ts, module-screens.test.ts and reports.test.ts); a stack with some module off is not started here.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('the Engage app holds the CRM screens in its groups, an old CRM link opens them and the reports have a tab for each area', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('engage-fold'));
  const slug = await createOrg(page, 'Công ty Gộp Ứng Dụng');
  const nav = page.getByRole('navigation');

  await test.step('the rail has the one Engage app and no CRM app, with the groups and the reports item', async () => {
    await expect(nav.getByRole('link', { name: 'CRM', exact: true })).toHaveCount(0);
    await nav.getByRole('link', { name: 'Engage', exact: true }).click();
    await expect(nav.getByRole('region', { name: 'Hộp thư' }).getByRole('link', { name: 'Hội thoại', exact: true })).toBeVisible();
    const sales = nav.getByRole('region', { name: 'Khách hàng & Bán hàng' });
    for (const name of ['Người liên hệ', 'Công ty', 'Cơ hội', 'Lịch hẹn']) await expect(sales.getByRole('link', { name, exact: true })).toBeVisible();
    const marketing = nav.getByRole('region', { name: 'Marketing' });
    for (const name of ['Bài đăng', 'Quảng cáo']) await expect(marketing.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(nav.getByRole('region', { name: 'Báo cáo' }).getByRole('link', { name: 'Báo cáo', exact: true })).toBeVisible();
  });

  await test.step('each group opens its screens and the Engage menu stays on', async () => {
    for (const [group, name, path] of [
      ['Hộp thư', 'Hội thoại', 'social/inbox'],
      ['Khách hàng & Bán hàng', 'Người liên hệ', 'contacts'],
      ['Khách hàng & Bán hàng', 'Công ty', 'companies'],
      ['Khách hàng & Bán hàng', 'Cơ hội', 'deals'],
      ['Khách hàng & Bán hàng', 'Lịch hẹn', 'bookings'],
      ['Marketing', 'Bài đăng', 'social'],
      ['Marketing', 'Quảng cáo', 'ads'],
    ] as const) {
      await nav.getByRole('region', { name: group }).getByRole('link', { name, exact: true }).click();
      await expect(page, `${name}`).toHaveURL(new RegExp(`/o/${slug}/${path}(\\?.*)?$`));
      await expect(nav.getByRole('region', { name: group }), `${name}`).toBeVisible();
    }
  });

  await test.step('an old CRM address opens the screen in the app, with its search', async () => {
    await page.goto(`/o/${slug}/crm/deals?tab=next`);
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/deals\\?tab=next$`));
    await expect(nav.getByRole('region', { name: 'Khách hàng & Bán hàng' })).toBeVisible();
    for (const [old, now] of [
      ['crm/contacts', 'contacts'],
      ['crm/bookings', 'bookings'],
      ['crm', 'bookings'],
    ] as const) {
      await page.goto(`/o/${slug}/${old}`);
      await expect(page, old).toHaveURL(new RegExp(`/o/${slug}/${now}$`));
    }
  });

  await test.step('the reports have a tab for each area, and each opens', async () => {
    await nav.getByRole('link', { name: 'Báo cáo', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/reports$`));
    const tabs = page.getByRole('tablist', { name: 'Mảng báo cáo' });
    await expect(tabs.getByRole('tab')).toHaveText(['Hội thoại', 'Bán hàng', 'Bài đăng', 'Quảng cáo']);
    await expect(page.getByRole('region', { name: 'Hội thoại hiện tại' })).toBeVisible();
    for (const [tab, area, panel] of [
      ['Bán hàng', 'sales', 'Cơ hội theo giai đoạn'],
      ['Bài đăng', 'posts', 'Bài đăng trong 30 ngày qua'],
      ['Quảng cáo', 'ads', 'Quảng cáo tháng này'],
    ] as const) {
      await tabs.getByRole('tab', { name: tab }).click();
      await expect(page, tab).toHaveURL(new RegExp(`/o/${slug}/reports\\?area=${area}$`));
      await expect(page.getByRole('region', { name: panel }), tab).toBeVisible();
    }
  });
});

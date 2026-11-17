// SPDX-License-Identifier: AGPL-3.0-only
// A new owner finds the booking link (#3643, audit CR-1, CR-11, CR-19, CR-20): Lịch hẹn with no event type leads to Settings, the first event type is added with
// its name alone, then Lịch hẹn shows the link to copy and "Mở thử", which opens the public page; the screen passes an axe scan at desktop and phone width.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('a new owner reaches a copyable booking link from Lịch hẹn, and "Mở thử" opens the page clients see', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await signInNewUser(page, newEmail('booking-link'));
  const slug = await createOrg(page, 'Công ty Liên Kết Đặt Lịch');
  const nav = page.getByRole('navigation');
  const openBookings = async () => {
    await nav.getByRole('link', { name: 'Engage', exact: true }).click();
    await nav.getByRole('link', { name: 'Lịch hẹn' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/bookings$`));
  };

  await test.step('with no event type, Lịch hẹn says so and its action leads to Settings', async () => {
    await openBookings();
    await expect(page.getByText('Tạo loại lịch hẹn đầu tiên để khách đặt lịch')).toBeVisible();
    await page.getByRole('link', { name: 'Tạo loại lịch hẹn', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings#booking-event-types$`));
    // On screen, not only in the page: the jump waits for the cards and lands on the event types.
    await expect(page.getByRole('form', { name: 'Thêm loại lịch hẹn' })).toBeInViewport();
  });

  await test.step('the first event type needs only a name; the link it will have is shown, not a slug box', async () => {
    const form = page.getByRole('form', { name: 'Thêm loại lịch hẹn' });
    await expect(form.getByText('sẽ hiện khi bạn đặt tên.')).toBeVisible();
    await expect(form.getByLabel('Nghỉ trước', { exact: false })).toHaveCount(0);
    await form.getByLabel('Tên', { exact: true }).fill('Tư vấn thuế 30 phút');
    await expect(form.getByTestId('event-type-link')).toContainText(`/-/b/${slug}/tu-van-thue-30-phut`);
    await form.getByRole('button', { name: 'Thêm', exact: true }).click();
    const row = page.getByRole('listitem').filter({ hasText: 'Tư vấn thuế 30 phút' });
    await expect(row.getByRole('button', { name: /Sao chép liên kết đặt lịch/ })).toBeVisible();
    await expect(row.getByRole('link', { name: /Xem trang/ })).toHaveAttribute('href', new RegExp(`/-/b/${slug}/tu-van-thue-30-phut$`));
  });

  await test.step('Lịch hẹn now shows the link, copies it, and "Mở thử" opens the public page', async () => {
    await openBookings();
    await expect(page.getByText('Gửi liên kết đặt lịch cho khách để họ chọn giờ')).toBeVisible();
    const field = page.getByLabel('Liên kết đặt lịch', { exact: true });
    await expect(field).toHaveValue(new RegExp(`/-/b/${slug}/tu-van-thue-30-phut$`));
    await page.getByRole('button', { name: 'Sao chép liên kết đặt lịch', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Đã sao chép' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await field.inputValue());
    const popup = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Mở thử', exact: true }).click();
    const opened = await popup;
    await expect(opened.getByRole('heading', { name: 'Tư vấn thuế 30 phút' })).toBeVisible();
    await opened.close();
  });

  await test.step('the screen passes an axe scan at desktop and phone width', async () => {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await page.reload();
      await expect(page.getByLabel('Liên kết đặt lịch', { exact: true })).toBeVisible();
      const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(scrolls, `scrolls sideways at ${width}`).toBe(false);
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
    }
  });
});

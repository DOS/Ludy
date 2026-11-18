// The org's overview (issue #1249), end to end: a new org says nothing waits and offers the upload; once an invoice is
// in, the overview counts its proposal once and one click on its row opens the proposal.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

test('the overview counts what waits and opens the screen that clears it', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('overview'));
  await createOrg(page, 'Công ty Tổng Quan');
  const overview = page.getByRole('navigation').getByRole('link', { name: 'Tổng quan', exact: true });

  await test.step('a new org has nothing waiting, and the tax box offers the choice as a button', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await overview.click();
    await expect(page.getByRole('heading', { name: 'Tổng quan', exact: true })).toBeVisible();
    await expect(page.getByText('Hôm nay chưa có việc nào cần bạn')).toBeVisible();
    await expect(page.getByText('Chưa chọn kỳ khai thuế')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Chọn kỳ khai' })).toBeVisible();
    // The tax deadlines come right after what needs the owner today: inside the first screen of a 1440 x 900 window (#3591).
    await expect(page.getByRole('heading', { name: 'Việc thuế trong 30 ngày tới' })).toBeInViewport();
  });

  await test.step('no card of an app that has nothing to show: one line of links into the apps (#1528, #3591)', async () => {
    await expect(page.locator('[data-app-card]')).toHaveCount(0);
    const apps = page.getByRole('region', { name: 'Ứng dụng' });
    await apps.getByRole('link', { name: 'Ludy Tài chính', exact: true }).click();
    await expect(page).toHaveURL(/\/accounting$/);
    // The overview is the first entry of the switcher.
    await overview.click();
    await expect(page).toHaveURL(/\/overview$/);
  });

  await test.step('an invoice in the Inbox shows as one proposal to approve', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Tài chính', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: /^Chứng từ(\s+\d+\+?)?$/ }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await overview.click();
    // One invoice is one row of "Hôm nay cần bạn", counted once (#3591), and the row opens the proposal.
    const proposals = page.getByRole('link', { name: /^1 hóa đơn .* chờ bạn duyệt/ });
    await expect(proposals).toBeVisible();
    await expect(page.getByTestId('today-total')).toHaveText('1');
    await proposals.click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]+$/);
  });
});

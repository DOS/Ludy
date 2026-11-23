// The Inbox list and the open proposal side by side on a wide screen (DESIGN.md §3.4, issue #1514): the proposals
// waiting for review stay beside the open one, the open one is marked, and approving opens the next one in its place
// instead of going back to the list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url)), 'utf8');
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

// The fixture with another invoice number, so each upload is its own proposal and none is a duplicate.
const invoice = (number: number) => ({
  name: `hd-${number}.xml`,
  mimeType: 'application/xml',
  buffer: Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`)),
});

test.use({ viewport: { width: 1440, height: 900 } });

test('on a wide screen the pending list stays beside the proposal, and approving opens the next one', async ({ page }) => {
  await signInNewUser(page, newEmail('inbox-split'));
  const slug = await createOrg(page, 'Công ty Màn hình rộng');
  // A new org opens on the overview (#3225); the uploads are on the Inbox.
  await page.goto(page.url().replace(/\/overview$/, '/inbox'));
  await page.locator('input[type=file]').setInputFiles([invoice(4101), invoice(4102)]);
  await expect(page.getByRole('main').getByRole('link', { name: SELLER })).toHaveCount(2, { timeout: 90_000 });

  const queue = page.getByRole('region', { name: 'Đề xuất chờ duyệt' });
  const queued = queue.getByRole('link', { name: SELLER });

  await test.step('the open proposal is marked in the list beside it', async () => {
    await page.getByRole('main').getByRole('link', { name: SELLER }).first().click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox/[^/]+$`));
    await expect(queued).toHaveCount(2);
    const open = page.url().split('/').at(-1) ?? '';
    await expect(queue.locator(`a[href$="/inbox/${open}"]`)).toHaveAttribute('aria-current', 'page');
  });

  await test.step('approving opens the other proposal in place', async () => {
    const open = page.url().split('/').at(-1) ?? '';
    const other = (await queued.evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).pathname.split('/').at(-1)))).find((id) => id !== open) ?? '';
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    // Approving is R3: the page asks for a second factor, then approves by itself.
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox/${other}$`));
    await expect(queued).toHaveCount(1);
    await expect(queue.locator(`a[href$="/inbox/${other}"]`)).toHaveAttribute('aria-current', 'page');
  });
});

test('at xl (1280px), the Inbox shows inline split preview, switches rows, approves in place, and collapses on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInNewUser(page, newEmail('inbox-inline-split'));
  const slug = await createOrg(page, 'Công ty Tách màn hình');
  await page.goto(page.url().replace(/\/overview$/, '/inbox'));
  await page.locator('input[type=file]').setInputFiles([invoice(4201), invoice(4202)]);
  const links = page.getByRole('main').getByRole('link', { name: SELLER });
  await expect(links).toHaveCount(2, { timeout: 90_000 });

  await test.step('xl layout keeps one h1 and renders the first pending proposal inline beside the queue', async () => {
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    expect(await page.title()).toBe('Chứng từ chờ duyệt · Ludy');
    await expect(page.locator('main h1')).toHaveCount(1);
    await expect(page.getByTestId('inbox-split-layout')).toBeVisible();
    const preview = page.getByTestId('inbox-split-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('heading', { level: 2, name: SELLER })).toBeVisible();
    await expect(preview.getByRole('link', { name: 'Mở trang chi tiết' })).toHaveAttribute('href', /\/inbox\/[^/]+$/);
    const firstSubtitle = preview.getByText(/Hóa đơn C26TAB · số 420[12]/);
    await expect(firstSubtitle).toBeVisible();
    const firstNumber = ((await firstSubtitle.textContent()) ?? '').includes('4201') ? '4201' : '4202';
    const secondNumber = firstNumber === '4201' ? '4202' : '4201';
    const buttons = page.getByTestId('inbox-preview-select');
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'false');
    await buttons.nth(1).click();
    await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(preview.getByText(new RegExp(`số ${secondNumber}`))).toBeVisible();

    await test.step('approving from the inline preview advances to the remaining proposal on /inbox', async () => {
      await preview.getByRole('checkbox', { name: 'Tôi đã kiểm tra hóa đơn gốc và vẫn muốn duyệt' }).check();
      await preview.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
      await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
      const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
      await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
      await page.getByRole('button', { name: 'Xác nhận' }).click();
      await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
      await expect(page.getByRole('status').filter({ hasText: `Đã duyệt và ghi sổ ${SELLER}` })).toBeVisible();
      await expect(links).toHaveCount(1);
      await expect(preview.getByRole('heading', { level: 2, name: SELLER })).toBeVisible();
      await expect(preview.getByText(new RegExp(`số ${firstNumber}`))).toBeVisible();
    });
  });

  await test.step('medium desktop (< 1280px) renders the full DataTable without split preview', async () => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByTestId('inbox-split-layout')).toHaveCount(0);
    await expect(links).toHaveCount(1);
    await expect(page.getByRole('columnheader', { name: 'Ngày hóa đơn' })).toBeVisible();
  });

  await test.step('narrow phone view (< 640px) stacks rows without split preview or horizontal scroll', async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(page.getByTestId('inbox-split-layout')).toHaveCount(0);
    await expect(links).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await links.first().click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox/[^/]+$`));
    await expect(page.getByRole('button', { name: 'Duyệt và ghi sổ' })).toBeVisible();
  });
});

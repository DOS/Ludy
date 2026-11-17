// SPDX-License-Identifier: AGPL-3.0-only
// The first approval as a guided step (#3599): the Inbox offers two-factor before it is needed, approving without a second factor opens a dialog over the proposal (the page
// behind does not move, and focus goes back to the approve button), and the account of a line is readable in full under the line's text. The step-up rule itself is walked in
// inbox.spec.ts and bulk-approve.spec.ts.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

async function inboxWithProposal(page: import('@playwright/test').Page, name: string): Promise<string> {
  await page.goto('/');
  await signUp(page, newEmail(name));
  const slug = await createOrg(page, 'Công ty E2E');
  await page.goto(page.url().replace(/\/overview$/, '/inbox'));
  await page.locator('input[type=file]').setInputFiles(INVOICE);
  await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
  return slug;
}

test('the Inbox offers two-factor before the first approval, and the setup is a dialog', async ({ page }) => {
  await inboxWithProposal(page, 'tf-offer');
  const offer = page.getByTestId('two-factor-offer');
  await expect(offer).toContainText('Bật xác thực hai lớp trước khi duyệt');
  await offer.getByRole('button', { name: 'Thiết lập' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Bật xác thực hai lớp' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await dialog.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  await dialog.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
  await dialog.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('two-factor-offer')).toHaveCount(0);
});

test('approving without a second factor opens a dialog over a proposal that does not move; the account of a line is readable', async ({ page }) => {
  await inboxWithProposal(page, 'tf-dialog');
  await page.getByRole('link', { name: SELLER }).click();
  const title = page.getByRole('heading', { name: SELLER });
  await expect(title).toBeVisible();
  // Who proposed it (DESIGN.md §5.1).
  await expect(page.getByText(/Đề xuất bởi Ly/)).toBeVisible();

  // The account select is under the line's text and as wide as the lines card: its name is not cut at the card's edge.
  const select = page.getByLabel('Tài khoản nợ cho dòng 1');
  const region = await page.getByRole('region', { name: 'Dòng hàng hóa, dịch vụ' }).boundingBox();
  const box = await select.boundingBox();
  if (!region || !box) throw new Error('lines card or account select not drawn');
  expect(box.x + box.width).toBeLessThanOrEqual(region.x + region.width);
  expect(box.width).toBeGreaterThan(250);

  // The fixture's signature is a placeholder (#674): it is confirmed once before approving.
  await page.getByRole('checkbox', { name: 'Tôi đã kiểm tra hóa đơn gốc và vẫn muốn duyệt' }).check();
  const approve = page.getByRole('button', { name: 'Duyệt và ghi sổ' });
  const before = await title.boundingBox();
  await approve.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Bật xác thực hai lớp để duyệt' })).toBeVisible();
  await expect(dialog.getByText('Đang chờ: duyệt và ghi sổ chứng từ này.')).toBeVisible();
  // The proposal behind the dialog has not moved.
  expect((await title.boundingBox())?.y).toBe(before?.y);

  // Escape drops the request and the focus goes back to the same button.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(approve).toBeFocused();
});

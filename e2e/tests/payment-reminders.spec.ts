// SPDX-License-Identifier: AGPL-3.0-only
// Customer payment reminders (#2488), end to end: an approved sales invoice past its 30 day terms -> its customer is on "Nhắc thu nợ" with its notice
// level -> the owner adds the customer's email -> opens the draft, edits the opening words and sends -> the mail reaches the customer's inbox (Mailpit)
// with the invoice, the amount and the total built from the books, whatever the edit says -> a second send of the same level asks to be confirmed.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { MAILPIT_URL } from '../lib/mail.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
// The fixture's synthetic tax codes: checksum-invalid on purpose (#157). The org is the fixture's seller here.
const SELLER_TAX_CODE = '0101234564';
const BUYER = 'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU';
const BUYER_EMAIL = `ketoan-${Date.now().toString(36)}@nguoimua.test`;

// The fixture sale is dated 15/09/2026 and falls due 30 days later; its notice level is the one for today's days late (the clock is the stack's).
const DUE = Date.UTC(2026, 9, 15);
const DAYS_LATE = Math.floor((Date.now() + 7 * 3_600_000 - DUE) / 86_400_000);
const NOTICE = DAYS_LATE >= 30 ? 'Thông báo cuối' : DAYS_LATE >= 15 ? 'Nhắc lần hai' : 'Nhắc lần đầu';
const SUBJECT = DAYS_LATE >= 30 ? /Thông báo cuối/ : DAYS_LATE >= 15 ? /Nhắc lần hai/ : /Nhắc thanh toán/;
// The template's opening words for that level: the final notice drops the "Theo ghi nhận" sentence of the first two.
const OPENING = DAYS_LATE >= 30 ? /Đây là thông báo cuối cùng của chúng tôi/ : /Theo ghi nhận của chúng tôi/;

interface Summary {
  ID: string;
}

async function mailTo(to: string): Promise<{ Subject: string; Text: string; HTML: string } | null> {
  const found = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  if (!found.ok) throw new Error(`Mailpit search: ${found.status}`);
  const { messages } = (await found.json()) as { messages: Summary[] | null };
  const first = messages?.[0];
  if (!first) return null;
  const message = await fetch(`${MAILPIT_URL}/api/v1/message/${first.ID}`);
  if (!message.ok) throw new Error(`Mailpit message: ${message.status}`);
  return (await message.json()) as { Subject: string; Text: string; HTML: string };
}

test('lists an overdue customer, drafts the reminder, sends it on a click with the facts from the books, and asks before a repeat', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('reminders'));
  const slug = await createOrg(page, 'Công ty Nhắc nợ E2E');
  const nav = page.getByRole('navigation');

  await test.step('the org tax code, so the invoice is read as a sale', async () => {
    await nav.getByRole('link', { name: 'Cài đặt' }).click();
    await page.getByRole('button', { name: 'Nhập', exact: true }).click();
    const taxForm = page.getByRole('form', { name: 'Mã số thuế' });
    await taxForm.getByLabel('Mã số thuế').fill(SELLER_TAX_CODE);
    await taxForm.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.getByRole('definition').getByText(SELLER_TAX_CODE, { exact: true })).toBeVisible();
  });

  await test.step('nothing is overdue before a sale is booked', async () => {
    await nav.getByRole('link', { name: 'Kế toán', exact: true }).click();
    await nav.getByRole('link', { name: 'Nhắc thu nợ' }).click();
    await expect(page.getByRole('heading', { name: 'Nhắc thu nợ' })).toBeVisible();
    await expect(page.getByText('Không có khách hàng nào quá hạn thanh toán.')).toBeVisible();
  });

  await test.step('book the sale (dated 15/09/2026) with a second factor', async () => {
    await nav.getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await nav.getByRole('link', { name: 'Chứng từ chờ duyệt' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    const proposal = page.getByRole('row').filter({ has: page.getByRole('link', { name: BUYER }) });
    await expect(proposal).toBeVisible({ timeout: 60_000 });
    await proposal.getByRole('link', { name: BUYER }).click();
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  });

  await test.step('the customer has no email yet: the reminder cannot be sent', async () => {
    await nav.getByRole('link', { name: 'Kế toán', exact: true }).click();
    await nav.getByRole('link', { name: 'Nhắc thu nợ' }).click();
    const row = page.getByTestId('reminder-row').filter({ hasText: BUYER });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Chưa có email');
    await expect(row).toContainText(NOTICE);
    await expect(row).toContainText('1.980.000');
    await row.getByRole('button', { name: `Soạn thư nhắc cho ${BUYER}` }).click();
    const draft = page.getByTestId('reminder-draft');
    await expect(draft.getByText('Khách hàng này chưa có email nên chưa gửi được.')).toBeVisible();
    await expect(page.getByTestId('reminder-send')).toBeDisabled();
  });

  await test.step('the owner adds the email in the customers screen', async () => {
    await nav.getByRole('link', { name: 'Khách hàng' }).click();
    const customer = page.getByRole('row').filter({ hasText: BUYER });
    await customer.getByRole('button', { name: `Sửa thông tin của ${BUYER}` }).click();
    const form = page.getByRole('form', { name: `Sửa thông tin của ${BUYER}` });
    await form.getByLabel('Email').fill(BUYER_EMAIL);
    await form.getByRole('button', { name: 'Lưu' }).click();
    await expect(form).toBeHidden();
  });

  await test.step('review the draft, edit the opening words and send', async () => {
    await nav.getByRole('link', { name: 'Nhắc thu nợ' }).click();
    const row = page.getByTestId('reminder-row').filter({ hasText: BUYER });
    await row.getByRole('button', { name: `Soạn thư nhắc cho ${BUYER}` }).click();
    const draft = page.getByTestId('reminder-draft');
    await expect(draft.getByLabel('Tiêu đề')).toHaveValue(SUBJECT);
    await expect(draft.getByText('Số 1', { exact: false }).first()).toBeVisible();
    // The deployment has no model: the coworker's wording says so and the template words stay.
    await draft.getByTestId('reminder-wording').click();
    await expect(draft.getByTestId('reminder-wording-state')).toContainText('chưa bật AI');
    await expect(draft.getByLabel('Mở đầu')).toHaveValue(OPENING);
    // The words are editable; what they say about money is only words.
    await draft.getByLabel('Mở đầu').fill('Kính nhờ Quý khách kiểm tra giúp các hóa đơn dưới đây. Con số 1 đồng trong câu này chỉ là lời, không phải số liệu.');
    await page.getByTestId('reminder-send').click();
    await expect(page.getByTestId('reminder-sent')).toBeVisible();
  });

  await test.step('the mail is in the customer inbox with the facts from the books', async () => {
    const found: { mail: Awaited<ReturnType<typeof mailTo>> } = { mail: null };
    await expect.poll(async () => (found.mail = await mailTo(BUYER_EMAIL)), { message: `mail to ${BUYER_EMAIL}`, timeout: 60_000 }).not.toBeNull();
    const mail = found.mail;
    expect(mail?.Subject).toMatch(SUBJECT);
    expect(mail?.Text).toContain('Kính nhờ Quý khách kiểm tra giúp các hóa đơn dưới đây.');
    expect(mail?.Text).toContain('1.980.000 đồng');
    expect(mail?.Text).toContain('Tổng cộng: 1.980.000 đồng');
    expect(mail?.Text).not.toContain('Tổng cộng: 1 đồng');
  });

  await test.step('the list shows the reminder, and a second send of the level asks to be confirmed', async () => {
    const row = page.getByTestId('reminder-row').filter({ hasText: BUYER });
    await expect(row).toContainText(NOTICE);
    await row.getByRole('button', { name: `Soạn thư nhắc cho ${BUYER}` }).click();
    await page.getByTestId('reminder-send').click();
    await expect(page.getByText(/đã được nhắc ở mức này trong 3 ngày qua/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gửi lại, tôi xác nhận' })).toBeVisible();
  });

  await test.step('pausing the customer takes it out of the list, lists it apart, and lifting the pause brings it back', async () => {
    const draft = page.getByTestId('reminder-draft');
    await draft.getByText('Hạn thanh toán riêng và tạm dừng nhắc khách này').click();
    // Five days from today in Vietnam, typed as dd/mm/yyyy.
    const day = new Date(Date.now() + 7 * 3_600_000 + 5 * 86_400_000).toISOString().slice(0, 10).split('-');
    await draft.getByLabel('Tạm dừng nhắc đến hết ngày').fill(`${day[2]}/${day[1]}/${day[0]}`);
    await draft.getByTestId('reminder-customer-save').click();
    const paused = page.getByTestId('reminder-paused');
    await expect(paused).toContainText(BUYER);
    await expect(page.getByTestId('reminder-row').filter({ hasText: BUYER })).toHaveCount(0);
    await paused.getByRole('button', { name: `Bỏ tạm dừng nhắc ${BUYER}` }).click();
    await expect(page.getByTestId('reminder-row').filter({ hasText: BUYER })).toBeVisible();
    await expect(page.getByTestId('reminder-paused')).toHaveCount(0);
  });

  await test.step('the org\'s payment terms move every due date: with long terms nobody is overdue, and the list returns with the terms back', async () => {
    const settings = page.getByTestId('reminder-settings');
    await settings.getByLabel('Hạn thanh toán (ngày kể từ ngày hóa đơn)').fill('365');
    await settings.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.getByText('Không có khách hàng nào quá hạn thanh toán.')).toBeVisible();
    await settings.getByLabel('Hạn thanh toán (ngày kể từ ngày hóa đơn)').fill('30');
    await settings.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.getByTestId('reminder-row').filter({ hasText: BUYER })).toBeVisible();
  });
});

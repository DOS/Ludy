// SPDX-License-Identifier: AGPL-3.0-only
// The matches of bank lines in groups (issue #2385), end to end: an e-invoice is approved into the books, a bank statement
// with the line that pays it is imported, the line shows as one clean match, one action asks for its voucher and approves it
// (one step-up for the batch, already given when the invoice was approved), and the review page lists the matched line with
// its voucher, its approver and how the party was found. A line that names no one stays out of the group.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url)), 'utf8');
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
// The fixture's seller tax code and its invoice's total, which the transfer line repeats.
const SELLER_TAX_CODE = '0101234564';
const NUMBER = 4101;

const HEADER = 'SAO KÊ TÀI KHOẢN\nSố tài khoản: 0011000000000\n\nNgày giao dịch;Số tham chiếu;Nội dung;Số tiền ghi nợ;Số tiền ghi có;Số dư';
const LINES = [`05/11/2026;GR001;TT HD ${NUMBER} MST ${SELLER_TAX_CODE};1.980.000;;48.020.000`, '06/11/2026;GR002;Phí SMS banking;11.000;;48.009.000'];

test('a clean bank match is asked for and approved in one action, then listed with its approver and reason', async ({ page }) => {
  let secret = '';
  let usedStep = -1;
  const slug = await test.step('sign up, create an org and approve the e-invoice the line will pay', async () => {
    await page.goto('/');
    await signUp(page, newEmail('match'));
    const created = await createOrg(page, 'Công ty khớp sao kê');
    // A new org opens on the overview (#3225); the uploads are on the Inbox.
    await page.goto(page.url().replace(/\/overview$/, '/inbox'));
    await expect(page.getByRole('heading', { name: 'Chứng từ chờ duyệt' })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles({
      name: `hd-${NUMBER}.xml`,
      mimeType: 'application/xml',
      buffer: Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${NUMBER}</SHDon>`)),
    });
    await expect(page.getByRole('link', { name: SELLER })).toHaveCount(1, { timeout: 90_000 });
    await page.getByText('Chọn tất cả mục duyệt chung được (1)').click();
    await page.getByText('Có 1 hóa đơn đã chọn chưa xác minh được chữ ký số', { exact: false }).click();
    await page.getByRole('button', { name: 'Duyệt 1 đề xuất' }).click();
    await expect(page.getByText('Đang chờ: duyệt và ghi sổ 1 đề xuất.')).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    const first = await nextTotp(secret);
    usedStep = first.step;
    await page.getByLabel('Mã xác thực').fill(first.code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByText('Đã duyệt và ghi sổ 1 đề xuất.')).toBeVisible();
    return created;
  });

  await test.step('import the statement: the line that pays the invoice is the clean group, the fee line is in none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crove-match-'));
    const path = join(dir, 'thang-11.csv');
    writeFileSync(path, `﻿${HEADER}\n${LINES.join('\n')}\nTổng cộng;;;1.991.000;;\n`);
    await page.getByRole('navigation').getByRole('link', { name: 'Tài chính', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Ngân hàng' }).click();
    await expect(page.getByRole('heading', { name: 'Sao kê ngân hàng' })).toBeVisible();
    await page.getByLabel('Tháng').fill('2026-11');
    await page.getByLabel('File sao kê (.xlsx, .csv)').setInputFiles(path);
    await page.getByRole('button', { name: 'Nhập 2 dòng' }).click();
    await expect(page.getByText('Đã nhập 2 dòng (0 dòng đã có được bỏ qua).')).toBeVisible();
    const groups = page.getByTestId('match-groups');
    await expect(groups.getByText('1 dòng khớp chắc chắn')).toBeVisible();
    const clean = groups.getByTestId('match-clean-line');
    await expect(clean).toHaveCount(1);
    await expect(clean).toContainText(`hóa đơn ${NUMBER}`);
    await expect(groups.getByTestId('match-look-line')).toHaveCount(0);
  });

  await test.step('one action asks for the voucher and approves it', async () => {
    await page.getByTestId('match-clean-action').click();
    // The step-up of the invoice's approval may have gone stale; if so the page asks again and sends the batch by itself.
    const prompt = page.getByRole('button', { name: 'Xác nhận' });
    const summary = page.getByTestId('match-summary');
    await expect(summary.or(prompt)).toBeVisible({ timeout: 60_000 });
    if (await prompt.isVisible()) {
      // A code is never submitted twice: the next time step's.
      await page.getByLabel('Mã xác thực').fill((await nextTotp(secret, usedStep)).code);
      await prompt.click();
    }
    await expect(summary).toHaveText('Đã lập 1 đề xuất; đã duyệt và ghi sổ 1.', { timeout: 60_000 });
  });

  await test.step('the review page lists the matched line with its voucher, approver and reason', async () => {
    await page.getByRole('link', { name: 'Dòng đã khớp chứng từ' }).click();
    await expect(page.getByRole('heading', { name: 'Dòng sao kê đã khớp' })).toBeVisible();
    await page.getByLabel('Tháng').fill('2026-11');
    const row = page.getByTestId('matched-line');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('BN00001');
    await expect(row).toContainText('Đã ghi sổ');
    await expect(page.getByTestId('matched-how')).toContainText(`Gợi ý khớp: mã số thuế có trong nội dung chuyển khoản, và số tiền bằng hóa đơn ${NUMBER}`);
    await expect(row.getByRole('button', { name: 'Hoàn tác chứng từ BN00001' })).toBeVisible();
  });

  await test.step('the books hold the voucher, tied to the line and the proposal', async () => {
    const rows = sql<{ voucher_type: string; number: number; amount: string; has_line: boolean; has_proposal: boolean }>(
      `SELECT v.voucher_type, v.number, v.amount::text, (v.bank_line_id IS NOT NULL) AS has_line, (v.proposal_id IS NOT NULL) AS has_proposal
         FROM crove_finance.cash_voucher v JOIN crove_kernel.tenant t ON t.org_id = v.org_id WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ voucher_type: 'bank_debit', number: 1, has_line: true, has_proposal: true });
    expect(Number(rows[0]?.amount)).toBe(1980000);
  });
});

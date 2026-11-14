// SPDX-License-Identifier: AGPL-3.0-only
// Clean invoices grouped by vendor and learned rule (issue #2379), end to end: an approver teaches a rule on a first
// invoice, the vendor's next two invoices wait in the Inbox as one group naming the rule, one button approves the group
// under one step-up, and a later correction of the rule shows its count in Settings. The fixture invoices carry no
// verifiable signature and a seller tax code that fails its checksum, so the test marks the two pending ones as having
// no warning in the database, as a provider's signed invoices have none, to make them clean; a proposal with a warning
// is never in a group (covered by the unit tests).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { nextTotp } from '../lib/totp.ts';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url)), 'utf8');
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

// The fixture under another number, with its internet line dated in another month.
const invoice = (number: number, month: string) => ({
  name: `hd-${number}.xml`,
  mimeType: 'application/xml',
  buffer: Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('tháng 9/2026', `tháng ${month}`)),
});

async function goToInbox(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Tài chính', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Chứng từ', exact: true }).click();
}

test('a vendor group of clean invoices is approved in one action, and a rule shows how often it was corrected', async ({ page }) => {
  let secret = '';
  let usedStep = -1;
  const slug = await test.step('teach the vendor rule: change the internet line to 242 on the first invoice and approve it', async () => {
    await signInNewUser(page, newEmail('groups'));
    const created = await createOrg(page, 'Công ty nhóm hóa đơn');
    await goToInbox(page);
    await page.locator('input[type=file]').setInputFiles(invoice(4201, '9/2026'));
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: SELLER }).click();
    await page.getByRole('combobox', { name: 'Tài khoản nợ cho dòng 1' }).selectOption('242');
    await page.getByRole('button', { name: 'Lưu chỉnh sửa' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Cước dịch vụ internet' }).getByText('Người dùng chọn')).toBeVisible();
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    const first = await nextTotp(secret);
    usedStep = first.step;
    await page.getByLabel('Mã xác thực').fill(first.code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${created}/inbox$`));
    return created;
  });

  await test.step('the vendor sends two more invoices: both wait, proposed by the learned rule', async () => {
    await page.locator('input[type=file]').setInputFiles([invoice(4202, '10/2026'), invoice(4203, '11/2026')]);
    await expect(page.getByRole('link', { name: SELLER })).toHaveCount(2, { timeout: 90_000 });
    // An unverified signature is a warning, so neither is clean yet: no group.
    await expect(page.getByTestId('proposal-groups')).toHaveCount(0);
  });

  await test.step('with no warning left they are clean, and the Inbox groups them under the rule', async () => {
    exec(
      `UPDATE crove_kernel.proposal p
          SET payload = jsonb_set(
                jsonb_set(p.payload, '{signature}', '{"status":"verified","reason":null}'::jsonb),
                '{checks}',
                (SELECT jsonb_agg(CASE WHEN c ->> 'id' = 'signature' THEN c || '{"status":"pass","code":"signature.verified"}'::jsonb
                                  WHEN c ->> 'status' = 'warn' THEN c || '{"status":"pass"}'::jsonb ELSE c END)
                   FROM jsonb_array_elements(p.payload -> 'checks') c))
         FROM crove_kernel.tenant t
        WHERE t.org_id = p.org_id AND t.slug = :'slug' AND p.status = 'pending' AND p.kind = 'finance.purchase'`,
      { slug },
    );
    const group = page.getByTestId('proposal-group');
    await expect(group).toHaveCount(1, { timeout: 30_000 });
    await expect(group).toContainText(SELLER);
    await expect(group).toContainText('2 hóa đơn, tổng');
    await expect(group.getByTestId('group-item')).toHaveCount(2);
    const rule = group.getByTestId('group-rule');
    await expect(rule).toContainText('Theo quy tắc đã học: Cước dịch vụ internet tháng 9/2026');
    await expect(rule.getByTestId('group-rule-corrections')).toHaveText('Chưa bị sửa lần nào');
    // Each invoice says why its accounts are what they are.
    await expect(group.getByTestId('group-item').first()).toContainText('Theo quy tắc đã học');
  });

  await test.step('one button approves the group under one step-up', async () => {
    await page.getByRole('button', { name: `Duyệt nhóm ${SELLER}` }).click();
    // The step-up of the first approval may have gone stale; if so the page asks again and sends the batch by itself.
    const prompt = page.getByRole('button', { name: 'Xác nhận' });
    const done = page.getByText('Đã duyệt và ghi sổ 2 đề xuất.');
    await expect(done.or(prompt)).toBeVisible({ timeout: 60_000 });
    if (await prompt.isVisible()) {
      // A code is never submitted twice: the next time step's.
      const next = await nextTotp(secret, usedStep);
      usedStep = next.step;
      await page.getByLabel('Mã xác thực').fill(next.code);
      await prompt.click();
    }
    await expect(done).toBeVisible({ timeout: 60_000 });
    // Both left the pending list.
    await expect(page.getByRole('link', { name: SELLER })).toHaveCount(0);
    const documents = sql<{ n: number }>(
      `SELECT count(*) AS n FROM crove_finance.purchase_document d JOIN crove_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(documents[0]?.n).toBe(3);
  });

  await test.step('a later invoice whose rule line an approver corrects raises the rule\'s count in Settings', async () => {
    await page.locator('input[type=file]').setInputFiles(invoice(4204, '12/2026'));
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: SELLER }).click();
    await expect(page.getByRole('combobox', { name: 'Tài khoản nợ cho dòng 1' })).toHaveValue('242');
    await page.getByRole('combobox', { name: 'Tài khoản nợ cho dòng 1' }).selectOption('6422');
    await page.getByRole('button', { name: 'Lưu chỉnh sửa' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Cước dịch vụ internet' }).getByText('Người dùng chọn')).toBeVisible();
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    const prompt = page.getByRole('button', { name: 'Xác nhận' });
    const back = page.getByRole('heading', { name: 'Chứng từ chờ duyệt' });
    await expect(back.or(prompt)).toBeVisible({ timeout: 60_000 });
    if (await prompt.isVisible()) {
      const next = await nextTotp(secret, usedStep);
      usedStep = next.step;
      await page.getByLabel('Mã xác thực').fill(next.code);
      await prompt.click();
    }
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
    const card = page.locator('[aria-label="Quy tắc định khoản đã học"]');
    const row = card.getByRole('listitem');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('rule-corrections')).toHaveText('Đã bị sửa 1 lần');
    await expect(row).toContainText('Ghi vào TK 6422');
  });
});

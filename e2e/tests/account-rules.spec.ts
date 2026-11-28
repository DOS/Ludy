// Learned account rules (issue #1399) end to end: the approver changes a line's account and approves, Settings lists the
// rule with its provenance, an owner adds and removes a keyword rule, and the vendor's next invoice is proposed by the
// learned rule, with the line saying so.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { nextTotp } from '../lib/totp.ts';
import { openSettingsTab } from '../lib/settings.ts';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url)), 'utf8');
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

// The fixture under another number, with its internet line dated in another month.
const invoice = (number: number, month: string) => ({
  name: `hd-${number}.xml`,
  mimeType: 'application/xml',
  buffer: Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('tháng 9/2026', `tháng ${month}`)),
});

const internetRow = (page: Page) => page.getByRole('row').filter({ hasText: 'Cước dịch vụ internet' });

async function openProposal(page: Page, file: ReturnType<typeof invoice>) {
  await page.getByRole('navigation').getByRole('link', { name: 'Tài chính', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: /^Chứng từ(\s+\d+\+?)?$/ }).click();
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: SELLER }).click();
  await expect(page.getByRole('heading', { name: SELLER })).toBeVisible();
}

test('an approver teaches a line rule, Settings lists and removes rules, and the next invoice uses it', async ({ page }) => {
  const email = newEmail('rules');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Quy tắc định khoản');

  await test.step('change the account of the internet line and approve', async () => {
    await openProposal(page, invoice(4101, '9/2026'));
    await expect(internetRow(page).getByText('Từ khóa có sẵn')).toBeVisible();
    await page.getByRole('combobox', { name: 'Tài khoản nợ cho dòng 1' }).selectOption('242');
    await page.getByRole('button', { name: 'Lưu chỉnh sửa' }).click();
    await expect(internetRow(page).getByText('Người dùng chọn')).toBeVisible();
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    // Approving is R3: the page asks for a second factor, then approves by itself.
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await expect(page.getByRole('status').filter({ hasText: `Đã duyệt và ghi sổ ${SELLER}` })).toBeVisible();
  });

  const card = page.locator('[aria-label="Quy tắc định khoản đã học"]');

  await test.step('Settings lists the learned rule with its provenance', async () => {
    await page.getByRole('banner').getByRole('link', { name: 'Cài đặt', exact: true }).click();
    await openSettingsTab(page, 'accounting');
    const rule = card.getByRole('listitem').filter({ hasText: 'Cước dịch vụ internet tháng 9/2026' });
    await expect(rule).toBeVisible();
    await expect(rule.getByText('Cùng mặt hàng')).toBeVisible();
    await expect(rule.getByText(SELLER)).toBeVisible();
    await expect(rule.getByText('Ghi vào TK 242')).toBeVisible();
    const provenance = rule.getByText(`Do ${email} xác nhận ngày`, { exact: false });
    await expect(provenance).toBeVisible();
    await expect(provenance).toContainText('khi duyệt hóa đơn C26TAB/4101');
  });

  await test.step('an owner adds keyword rules for every vendor and for one vendor, filters by vendor, and removes them', async () => {
    // The form is a dialog behind a button (#3608).
    await card.getByRole('button', { name: 'Thêm quy tắc theo từ khóa' }).click();
    const add = page.getByRole('form', { name: 'Thêm quy tắc theo từ khóa' });
    await add.getByLabel('Từ khóa').fill('Chiết khấu');
    await add.getByLabel('Tài khoản').selectOption('6422');
    await add.getByRole('button', { name: 'Thêm', exact: true }).click();
    const sharedRule = card.getByRole('listitem').filter({ hasText: 'Chiết khấu' });
    await expect(sharedRule.getByText('Từ khóa', { exact: true })).toBeVisible();
    await expect(sharedRule.getByText('Mọi nhà cung cấp')).toBeVisible();
    await expect(sharedRule.getByText('Ghi vào TK 6422')).toBeVisible();

    // Add a keyword rule scoped to one existing org party via the vendor search picker (#1453).
    await card.getByRole('button', { name: 'Thêm quy tắc theo từ khóa' }).click();
    await add.getByLabel('Từ khóa').fill('Vận chuyển');
    const vendorInput = add.getByLabel('Nhà cung cấp (không bắt buộc)');
    await vendorInput.fill('Dịch vụ mẫu');
    await add.getByRole('option', { name: new RegExp(SELLER) }).click();
    await expect(vendorInput).toHaveValue(SELLER);
    await expect(add.getByTestId('account-rule-vendor-clear')).toBeVisible();
    await add.getByLabel('Tài khoản').selectOption('6421');
    await add.getByRole('button', { name: 'Thêm', exact: true }).click();
    const vendorRule = card.getByRole('listitem').filter({ hasText: 'Vận chuyển' });
    await expect(vendorRule.getByText('Từ khóa', { exact: true })).toBeVisible();
    await expect(vendorRule.getByText(SELLER)).toBeVisible();
    await expect(vendorRule.getByText('Ghi vào TK 6421')).toBeVisible();

    // Filter the rules list by vendor (shared rules, specific vendor, and reset to all).
    await expect(card.getByRole('listitem')).toHaveCount(3);
    const vendorFilter = card.getByLabel('Lọc theo nhà cung cấp');
    await vendorFilter.selectOption({ label: 'Mọi nhà cung cấp' });
    await expect(card.getByRole('listitem')).toHaveCount(1);
    await expect(card.getByRole('listitem').first()).toContainText('Chiết khấu');
    await vendorFilter.selectOption({ label: SELLER });
    await expect(card.getByRole('listitem')).toHaveCount(2);
    await expect(card.getByRole('listitem').filter({ hasText: 'Chiết khấu' })).toHaveCount(0);
    await card.getByTestId('account-rules-vendor-filter-clear').click();
    await expect(card.getByRole('listitem')).toHaveCount(3);

    // The same words without marks are the same rule: flagged while typing per vendor scope, before anything is saved.
    await card.getByRole('button', { name: 'Thêm quy tắc theo từ khóa' }).click();
    await add.getByLabel('Từ khóa').fill('chiet khau');
    await add.getByLabel('Tài khoản').selectOption('6422');
    await expect(add.getByTestId('keyword-rule-duplicate')).toContainText('Đã có quy tắc cho từ khóa');
    await expect(add.getByRole('button', { name: 'Thêm', exact: true })).toBeDisabled();

    // Picking a vendor lets the org-wide keyword stand beside a vendor-specific rule; Escape closes only the listbox,
    // ArrowDown+Enter picks via keyboard, and Clear resets cleanly without reopening the listbox.
    const dupVendorInput = add.getByLabel('Nhà cung cấp (không bắt buộc)');
    await dupVendorInput.fill('Dịch vụ mẫu');
    await expect(add.getByRole('listbox')).toBeVisible();
    await dupVendorInput.press('Escape');
    await expect(add.getByRole('listbox')).toHaveCount(0);
    await expect(add).toBeVisible();
    await dupVendorInput.press('ArrowDown');
    await expect(add.getByRole('listbox')).toBeVisible();
    await dupVendorInput.press('Enter');
    await expect(dupVendorInput).toHaveValue(SELLER);
    await expect(add.getByTestId('keyword-rule-duplicate')).toHaveCount(0);
    await add.getByLabel('Từ khóa').fill('van chuyen');
    await expect(add.getByTestId('keyword-rule-duplicate')).toContainText(`của ${SELLER}`);
    await expect(add.getByRole('button', { name: 'Thêm', exact: true })).toBeDisabled();
    await add.getByTestId('account-rule-vendor-clear').click();
    await expect(add.getByRole('listbox')).toHaveCount(0);
    await expect(add.getByTestId('keyword-rule-duplicate')).toHaveCount(0);

    // Unpicked vendor search text refuses submit with inline guidance until cleared or picked.
    await dupVendorInput.fill('Không tồn tại');
    await add.getByLabel('Từ khóa').fill('phi moi');
    await add.getByRole('button', { name: 'Thêm', exact: true }).click();
    await expect(add.getByText('Hãy chọn một nhà cung cấp từ danh sách')).toBeVisible();
    await add.getByTestId('account-rule-vendor-clear').click();

    await add.getByRole('button', { name: 'Hủy' }).click();
    await page.getByRole('button', { name: 'Bỏ thay đổi' }).click();
    await expect(add).toHaveCount(0);

    await vendorRule.getByRole('button', { name: 'Xóa quy tắc Vận chuyển' }).click();
    await vendorRule.getByRole('button', { name: 'Xóa quy tắc', exact: true }).click();
    await expect(card.getByRole('listitem').filter({ hasText: 'Vận chuyển' })).toHaveCount(0);

    await sharedRule.getByRole('button', { name: 'Xóa quy tắc Chiết khấu' }).click();
    await sharedRule.getByRole('button', { name: 'Xóa quy tắc', exact: true }).click();
    await expect(card.getByRole('listitem').filter({ hasText: 'Chiết khấu' })).toHaveCount(0);
    await expect(card.getByRole('listitem')).toHaveCount(1);
  });

  await test.step('the next invoice of the vendor is proposed by the learned rule, whatever its month', async () => {
    await openProposal(page, invoice(4102, '10/2026'));
    await expect(page.getByRole('combobox', { name: 'Tài khoản nợ cho dòng 1' })).toHaveValue('242');
    await expect(internetRow(page).getByText('Quy tắc đã học')).toBeVisible();
    await expect(internetRow(page).getByText('Theo quy tắc đã học: cùng mặt hàng của nhà cung cấp này')).toBeVisible();
  });

  await test.step('the rule row keeps its provenance in the database', async () => {
    const rows = sql<{ match_kind: string; match_text: string; debit_account: string; confirmed_by: string; invoice_number: string }>(
      `SELECT r.match_kind, r.match_text, r.debit_account, u.email AS confirmed_by, d.invoice_number
         FROM ludy_finance.categorization_rule r
         JOIN ludy_kernel.tenant t ON t.org_id = r.org_id
         JOIN ludy_kernel.user_account u ON u.id = r.confirmed_by
         JOIN ludy_finance.purchase_document d ON d.org_id = r.org_id AND d.id = r.source_document_id
        WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(rows).toEqual([{ match_kind: 'description', match_text: 'cuoc dich vu internet thang', debit_account: '242', confirmed_by: email, invoice_number: '4101' }]);
  });
});

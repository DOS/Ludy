// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on stock (#2514), end to end with AI off (the e2e stack has no AI endpoint): a goods line of a posted invoice waits on the "Hàng hóa" screen, asking the coworker
// for an item says plainly that AI is off and leaves the screen exactly as it was, and the person assigns the line by hand as before (which moves the stock and teaches the name). No
// item runs low, so neither the "Hàng sắp hết" section nor Home's item shows. The model's side (what it may see, what is refused, each state) is checked in packages/agent,
// apps/kernel/test/stock-ai.test.ts and apps/kernel/test/finance-stock-low.db.test.ts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { exec } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

test('with AI off the coworker says so, the line is assigned by hand, and nothing shows as running low', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('stock-coworker'));
  const slug = await createOrg(page, 'Công ty Kho E2E');
  const nav = page.getByRole('navigation');

  await test.step('post an invoice whose first line is on 156, so it is a goods line that matches no item', async () => {
    await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await nav.getByRole('link', { name: /^Chứng từ(\s+\d+\+?)?$/ }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: SELLER }).click();
    await expect(page.getByRole('heading', { name: SELLER })).toBeVisible();
    await page.getByLabel('Tài khoản nợ cho dòng 1').selectOption('156');
    await page.getByRole('button', { name: 'Lưu chỉnh sửa' }).click();
    await expect(page.getByRole('button', { name: 'Lưu chỉnh sửa' })).toHaveCount(0);
    // `check` waits until the box is checked, so a click lost to the page's refresh after the save is repeated.
    await page.getByRole('checkbox', { name: 'Tôi đã kiểm tra hóa đơn gốc và vẫn muốn duyệt' }).check();
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await expect(page.getByText('Việc này cần xác thực hai lớp.')).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  });

  await test.step('on the stock screen the line waits; nothing is running low, so there is no such section', async () => {
    await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await nav.getByRole('link', { name: 'Hàng hóa' }).click();
    await expect(page.getByRole('heading', { name: 'Hàng hóa' })).toBeVisible();
    await expect(page.getByTestId('stock-unassigned-line')).toHaveCount(1);
    await expect(page.getByTestId('stock-low')).toHaveCount(0);
  });

  await test.step('a new item to assign it to; asking the coworker for a suggestion says AI is off and changes nothing', async () => {
    await page.getByTestId('stock-new').click();
    const form = page.getByTestId('stock-item-form');
    await form.getByLabel('Mã', { exact: true }).fill('NET');
    await form.getByLabel('Tên', { exact: true }).fill('Dịch vụ internet');
    await form.getByLabel('Đơn vị').fill('tháng');
    await page.getByTestId('stock-item-save').click();
    await expect(page.getByTestId('stock-item')).toHaveCount(1);

    await page.getByTestId('stock-suggest').click();
    await expect(page.getByTestId('stock-suggest-state')).toContainText('chưa bật AI');
    await expect(page.getByTestId('stock-suggestion')).toHaveCount(0);
    await expect(page.getByTestId('stock-unassigned-line')).toHaveCount(1);
  });

  await test.step('the person assigns the line by hand as before: the stock moves and the line leaves the list', async () => {
    const line = page.getByTestId('stock-unassigned-line');
    await line.getByLabel('Chọn mặt hàng').selectOption({ label: 'NET Dịch vụ internet' });
    await line.getByTestId('stock-assign').click();
    await expect(page.getByTestId('stock-unassigned')).toHaveCount(0);
    await expect(page.getByTestId('stock-item')).toContainText('1');
  });

  await test.step('Home has no running-low item either', async () => {
    await nav.getByRole('link', { name: 'Tổng quan', exact: true }).click();
    await expect(page.getByText('sắp hết, nên đặt thêm')).toHaveCount(0);
  });
});

// The rows are written by the database owner with triggers off: the books insist that a document is posted with its entry, which this screen does not look at.
const ORG = `(SELECT org_id FROM crove_kernel.tenant WHERE slug = :'slug')`;
const ENTITY = `(SELECT l.id FROM crove_kernel.legal_entity l WHERE l.org_id = ${ORG} AND l.is_default)`;
const ITEM = `(SELECT id FROM crove_finance.stock_item WHERE org_id = ${ORG} AND code = 'A1')`;

test('an item that sells faster than it lasts shows as running low, with the supplier, and its reorder message is a template to edit when AI is off', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('stock-low'));
  const slug = await createOrg(page, 'Công ty Hết hàng E2E');
  const nav = page.getByRole('navigation');

  await test.step('an item bought from a supplier 60 days ago and sold at a unit a day since: ten are left, ten days of sales', async () => {
    await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await nav.getByRole('link', { name: 'Hàng hóa' }).click();
    await page.getByTestId('stock-new').click();
    const form = page.getByTestId('stock-item-form');
    await form.getByLabel('Mã', { exact: true }).fill('A1');
    await form.getByLabel('Tên', { exact: true }).fill('Áo thun trắng M');
    await form.getByLabel('Đơn vị').fill('cái');
    await page.getByTestId('stock-item-save').click();
    await expect(page.getByTestId('stock-item')).toHaveCount(1);
    exec(
      `SET session_replication_role = replica;
       INSERT INTO crove_kernel.party (org_id, id, name, email) VALUES (${ORG}, :'supplier'::uuid, 'Nhà cung cấp Phương Nam', 'ncc@example.com');
       INSERT INTO crove_kernel.party (org_id, id, name) VALUES (${ORG}, :'customer'::uuid, 'Khách lẻ');
       INSERT INTO crove_finance.purchase_document (org_id, id, legal_entity_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction) VALUES
         (${ORG}, :'buy'::uuid, ${ENTITY}, :'supplier'::uuid, 'AA', '000001', current_date - 60, 100, 0, 100, 'purchase'),
         (${ORG}, :'sell'::uuid, ${ENTITY}, :'customer'::uuid, 'AA', '000002', current_date - 10, 100, 0, 100, 'sale');
       INSERT INTO crove_finance.purchase_line (org_id, document_id, line_no, description, unit, quantity, amount, debit_account, credit_account) VALUES
         (${ORG}, :'buy'::uuid, 1, 'Áo thun trắng M', 'cái', 66, 100, '156', NULL::text),
         (${ORG}, :'sell'::uuid, 1, 'Áo thun trắng M', 'cái', 56, 100, NULL::text, '5111');
       INSERT INTO crove_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type, document_id, line_no, line_attempt) VALUES
         (${ORG}, ${ENTITY}, ${ITEM}, current_date - 60, 66, 'document_line', :'buy'::uuid, 1, 1),
         (${ORG}, ${ENTITY}, ${ITEM}, current_date - 10, -56, 'document_line', :'sell'::uuid, 1, 1)`,
      { slug, supplier: randomUUID(), customer: randomUUID(), buy: randomUUID(), sell: randomUUID() },
    );
    await page.reload();
    await expect(page.getByTestId('stock-item')).toContainText('10');
  });

  await test.step('the running-low section lists it under its supplier with the quantity the list suggests', async () => {
    const group = page.getByTestId('stock-low-group');
    await expect(group).toHaveCount(1);
    await expect(group).toContainText('Nhà cung cấp Phương Nam');
    await expect(group).toContainText('ncc@example.com');
    const row = group.getByTestId('stock-low-item');
    await expect(row).toContainText('A1');
    await expect(row).toContainText('10 ngày');
    // Two lead times of sales (28) less the ten on hand.
    await expect(row.getByTestId('stock-low-quantity')).toHaveValue('18');
  });

  await test.step('drafting the message with AI off says so and gives the fixed template, which the person can edit', async () => {
    const group = page.getByTestId('stock-low-group');
    await group.getByTestId('stock-low-draft').click();
    const message = group.getByTestId('stock-low-message');
    await expect(group.getByTestId('stock-low-state')).toContainText('chưa bật AI');
    const text = message.getByRole('textbox', { name: 'Tin đặt hàng' });
    await expect(text).toHaveValue(/Chào Nhà cung cấp Phương Nam,/);
    await expect(text).toHaveValue(/- Áo thun trắng M: 18 cái/);
    await expect(text).toHaveValue(/Công ty Hết hàng E2E/);
    // Nothing is sent from here: the buttons only copy the text or open the person's own mail app.
    await expect(message.getByRole('button', { name: 'Mở trong ứng dụng thư' })).toBeVisible();
    await expect(message.getByTestId('stock-low-copy')).toBeVisible();
    // Another quantity makes the message out of date, so it is dropped until it is drafted again.
    await group.getByTestId('stock-low-quantity').fill('20');
    await expect(group.getByTestId('stock-low-message')).toHaveCount(0);
    await group.getByTestId('stock-low-draft').click();
    await expect(group.getByRole('textbox', { name: 'Tin đặt hàng' })).toHaveValue(/- Áo thun trắng M: 20 cái/);  });

  await test.step('a quantity that is not above zero cannot be drafted', async () => {
    const group = page.getByTestId('stock-low-group');
    await group.getByTestId('stock-low-quantity').fill('0');
    await expect(group.getByTestId('stock-low-draft')).toBeDisabled();
    // The field is marked wrong when the person leaves it, and the message is tied to it.
    await group.getByTestId('stock-low-quantity').blur();
    await expect(group.getByText('Số lượng phải lớn hơn không')).toBeVisible();
    await expect(group.getByTestId('stock-low-quantity')).toHaveAttribute('aria-invalid', 'true');
    await expect(group.getByTestId('stock-low-quantity')).toHaveAttribute('aria-describedby', /.+/);
  });

  await test.step('Home counts the item for the people who can act', async () => {
    await nav.getByRole('link', { name: 'Tổng quan', exact: true }).click();
    await expect(page.getByText('1 mặt hàng sắp hết, nên đặt thêm')).toBeVisible();
  });
});

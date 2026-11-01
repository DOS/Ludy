// SPDX-License-Identifier: AGPL-3.0-only
// Contact import end to end (#2229, docs/plan/crm.md step K5): a member chooses a CSV, maps its columns, reads the preview
// (new, duplicate and invalid rows), imports, and downloads the rows that were not imported. Nothing reaches the contacts
// before the Import button, and the file itself is never stored.
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

const CSV = [
  'Tên,Mã số thuế,Email,Số điện thoại,Địa chỉ',
  'Công ty ABC,0123456780,abc@khach.test,0901 111 222,"12 Lê Lợi, Quận 1"',
  'Nguyễn Văn An,,an@khach.test,0902 333 444,',
  'Trùng Email,,co@khach.test,,',
  'Email hỏng,,khong-phai-email,,',
  'Công ty ABC lần nữa,0123456780,,,',
].join('\n');

test('a member imports contacts from a CSV after reading the preview', async ({ page }) => {
  const email = newEmail('import');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Nhập Liệu');
  exec(`INSERT INTO crove_kernel.party (org_id, name, kind, email) SELECT org_id, 'Khách Có Sẵn', 'person', 'co@khach.test' FROM crove_kernel.tenant WHERE slug = :'slug'`, { slug });
  const stored = () => sql<{ name: string; kind: string; source_trust: string }>(`SELECT p.name, p.kind, p.source_trust FROM crove_kernel.party p JOIN crove_kernel.tenant t ON t.org_id = p.org_id WHERE t.slug = :'slug' ORDER BY p.name`, { slug });

  await page.getByRole('navigation').getByRole('link', { name: 'CRM', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Liên hệ' }).click();
  await page.getByRole('link', { name: 'Nhập từ tệp' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/contacts/import$`));

  await test.step('choosing the file shows its columns, already matched by their headers', async () => {
    await page.getByLabel('Tệp CSV').setInputFiles({ name: 'khach-hang.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf-8') });
    await expect(page.getByText('Tệp khach-hang.csv có 5 dòng')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Thông tin của cột Mã số thuế' })).toHaveValue('taxCode');
    await expect(page.getByRole('combobox', { name: 'Thông tin của cột Số điện thoại' })).toHaveValue('phone');
  });

  await test.step('the preview counts new, duplicate and invalid rows, and writes no contact', async () => {
    await page.getByRole('button', { name: 'Xem trước' }).click();
    await expect(page.getByText('2 dòng mới')).toBeVisible();
    await expect(page.getByText('2 dòng trùng')).toBeVisible();
    await expect(page.getByText('1 dòng lỗi')).toBeVisible();
    await expect(page.getByTestId('import-row')).toHaveCount(5);
    await expect(page.getByTestId('import-row').filter({ hasText: 'Trùng Email' })).toContainText('Trùng với Khách Có Sẵn');
    await expect(page.getByTestId('import-row').filter({ hasText: 'Email hỏng' })).toContainText('Email không hợp lệ');
    await page.getByRole('tab', { name: 'Lỗi' }).click();
    await expect(page.getByTestId('import-row')).toHaveCount(1);
    await page.getByRole('tab', { name: 'Tất cả' }).click();
    expect(await stored()).toEqual([{ name: 'Khách Có Sẵn', kind: 'person', source_trust: 'user' }]);
  });

  await test.step('importing makes exactly the new contacts, and the rows left out can be downloaded', async () => {
    await page.getByRole('button', { name: 'Nhập 2 liên hệ mới' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã nhập 2 liên hệ mới, bổ sung 0, bỏ qua 3 dòng.' })).toBeVisible();
    expect(await stored()).toEqual([
      { name: 'Công ty ABC', kind: 'organization', source_trust: 'external' },
      { name: 'Khách Có Sẵn', kind: 'person', source_trust: 'user' },
      { name: 'Nguyễn Văn An', kind: 'person', source_trust: 'external' },
    ]);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Tải 3 dòng chưa nhập' }).click()]);
    const text = await readFile(await download.path(), 'utf-8');
    expect(text).toContain('Lý do chưa nhập');
    expect(text).toContain('Trùng email');
    expect(text).toContain('Email không hợp lệ');
    expect(text).toContain('Trùng một dòng trước trong tệp');
    // The staged rows are gone with the commit.
    expect(sql<{ n: number }>(`SELECT count(*)::int AS n FROM crove_crm.import_row r JOIN crove_kernel.tenant t ON t.org_id = r.org_id WHERE t.slug = :'slug'`, { slug })[0]?.n).toBe(0);
  });

  await test.step('the contacts list shows the new contacts', async () => {
    await page.getByRole('link', { name: 'Về danh sách liên hệ' }).first().click();
    await expect(page.getByText('Nguyễn Văn An')).toBeVisible();
    await expect(page.getByText('Công ty ABC')).toBeVisible();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The company a person works at end to end (#2438, CRM-Q5): the people and the companies are two lists of the Engage app; a member links
// a person to a company from the person's panel, the company's panel and list show the link, the link is removed from the company's side,
// and the same person is linked again from the company's side. The rules (one company, never a person, never a merged one) are checked
// against the database in apps/kernel/test/contacts.db.test.ts.
import { expect, test } from '@playwright/test';
import { exec } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('a member links a person to a company from either side and sees it on both lists', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('company-link'));
  const slug = await createOrg(page, 'Công ty Gắn Liên Kết');
  for (const [name, kind] of [['Lan Trần', 'person'], ['Công ty Acme', 'organization']] as const) {
    exec(`INSERT INTO crove_kernel.party (org_id, name, kind) SELECT org_id, :'name', :'kind' FROM crove_kernel.tenant WHERE slug = :'slug'`, { slug, name, kind });
  }
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Engage', exact: true }).click();

  await test.step('the people list holds the person and the companies list the company, apart', async () => {
    await nav.getByRole('link', { name: 'Người liên hệ' }).click();
    await expect(page.getByText('Lan Trần')).toBeVisible();
    await expect(page.getByText('Công ty Acme')).toHaveCount(0);
    await nav.getByRole('link', { name: 'Công ty', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/companies$`));
    await expect(page.getByText('Công ty Acme')).toBeVisible();
    await expect(page.getByText('Lan Trần')).toHaveCount(0);
  });

  await test.step('links the person to the company from the person’s panel', async () => {
    await nav.getByRole('link', { name: 'Người liên hệ' }).click();
    await page.getByRole('button', { name: 'Mở Lan Trần' }).click();
    const link = page.getByTestId('person-company');
    await expect(link).toContainText('Chưa gắn công ty');
    await link.getByRole('button', { name: 'Gắn công ty' }).click();
    await link.getByRole('searchbox', { name: 'Tìm công ty theo tên hoặc mã số thuế' }).fill('acme');
    await link.getByRole('button', { name: 'Chọn Công ty Acme' }).click();
    await expect(link).toContainText('Công ty Acme');
    // The list row names the company.
    await expect(page.getByRole('row', { name: /Lan Trần/ }).first()).toContainText('Công ty Acme');
  });

  await test.step('the company’s panel lists the person and its row counts them; removing the link is one click', async () => {
    await nav.getByRole('link', { name: 'Công ty', exact: true }).click();
    await expect(page.getByRole('row', { name: /Công ty Acme/ }).first()).toContainText('1');
    await page.getByRole('button', { name: 'Mở Công ty Acme' }).click();
    const people = page.getByTestId('company-people');
    await expect(people).toContainText('Lan Trần');
    await people.getByRole('button', { name: 'Bỏ liên kết: Lan Trần' }).click();
    await expect(people).toContainText('Chưa có người liên hệ nào làm việc ở đây.');
  });

  await test.step('links the person again from the company’s side', async () => {
    const people = page.getByTestId('company-people');
    await people.getByRole('button', { name: 'Thêm người liên hệ' }).click();
    await people.getByRole('searchbox', { name: 'Tìm người liên hệ theo tên hoặc điện thoại' }).fill('lan');
    await people.getByRole('button', { name: 'Chọn Lan Trần' }).click();
    await expect(people).toContainText('Lan Trần');
    await nav.getByRole('link', { name: 'Người liên hệ' }).click();
    await expect(page.getByRole('row', { name: /Lan Trần/ }).first()).toContainText('Công ty Acme');
  });
});

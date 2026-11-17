// SPDX-License-Identifier: AGPL-3.0-only
// Adding a person or a company in the side panel (docs/plan/crm.md, K4): a person takes Email, Tên, Điện thoại and a company (a new one typed
// here is made and linked), with no tax code; the contact that already has the typed email is shown under the field and saving waits for
// "Vẫn thêm mới"; a company takes the tax code, and one that already exists is shown the same way; Esc closes the panel and
// "Lưu và thêm người khác" keeps it open for the next one.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('add a person with a new company, see the duplicate email, add a company and the next person', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('contact-panel'));
  const slug = await createOrg(page, 'Công ty Thêm Liên Hệ');
  const panel = () => page.getByTestId('add-contact-panel');

  await test.step('the panel opens on the right, a person has no tax code, and Esc closes it', async () => {
    await page.goto(`/o/${slug}/contacts`);
    await page.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click();
    await expect(panel()).toBeVisible();
    await expect(panel().getByLabel('Email')).toBeFocused();
    await expect(panel().getByLabel('Mã số thuế')).toHaveCount(0);
    // The address sits in a folded section.
    await expect(panel().getByLabel('Địa chỉ')).toHaveCount(0);
    await panel().getByRole('button', { name: 'Thông tin thêm' }).click();
    await expect(panel().getByLabel('Địa chỉ')).toBeVisible();
    await expect(page.getByTestId('add-contact-kind')).toHaveCount(0);
    const box = await panel().boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.x + box.width >= viewport.width - 1).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
  });

  await test.step('a person with a company typed here: the company is made and linked, and the person opens', async () => {
    await page.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click();
    await panel().getByLabel('Email').fill('an@abc.test');
    await panel().getByLabel('Tên', { exact: true }).fill('Nguyễn Văn An');
    await panel().getByLabel('Điện thoại').fill('0901 111 222');
    await panel().getByLabel('Công ty', { exact: true }).fill('Công ty ABC');
    await expect(panel().getByText('Sẽ tạo công ty mới “Công ty ABC” khi lưu.')).toBeVisible();
    await panel().getByLabel('Công ty', { exact: true }).press('Enter');
    await expect(panel()).toHaveCount(0);
    const company = page.getByTestId('person-company');
    await expect(company).toContainText('Công ty ABC');
    await expect(page.getByRole('cell', { name: 'Nguyễn Văn An', exact: true })).toBeVisible();
  });

  await test.step('an email that is already a contact is shown, and saving needs "Vẫn thêm mới"', async () => {
    await page.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click();
    await panel().getByLabel('Email').fill('AN@abc.test');
    const duplicate = panel().getByTestId('add-contact-duplicate-email');
    await expect(duplicate).toContainText('Nguyễn Văn An');
    await panel().getByLabel('Tên', { exact: true }).fill('An khác');
    await expect(panel().getByRole('button', { name: 'Lưu', exact: true })).toBeDisabled();
    await expect(panel().getByRole('button', { name: 'Lưu và thêm người khác' })).toBeDisabled();
    await duplicate.getByRole('button', { name: 'Vẫn thêm mới' }).click();
    await expect(panel().getByRole('button', { name: 'Lưu', exact: true })).toBeEnabled();
    await panel().getByLabel('Email').fill('binh@abc.test');
    await expect(duplicate).toHaveCount(0);
  });

  await test.step('"Lưu và thêm người khác" keeps the panel open and empties it', async () => {
    await panel().getByLabel('Tên', { exact: true }).fill('Trần Thị Bình');
    await panel().getByRole('button', { name: 'Lưu và thêm người khác' }).click();
    await expect(panel().getByTestId('add-contact-note')).toContainText('Đã thêm Trần Thị Bình');
    await expect(panel().getByLabel('Email')).toHaveValue('');
    await expect(panel().getByLabel('Email')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
  });

  await test.step('a company takes a tax code, and one that already exists is shown', async () => {
    await page.goto(`/o/${slug}/companies`);
    await page.getByRole('button', { name: 'Thêm công ty', exact: true }).click();
    await panel().getByLabel('Tên', { exact: true }).fill('Công ty Xanh');
    await panel().getByLabel('Mã số thuế').fill('0123456780');
    await panel().getByRole('button', { name: 'Thông tin thêm' }).click();
    await panel().getByLabel('Địa chỉ').fill('12 Lê Lợi, Quận 1');
    await panel().getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(panel()).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'Công ty Xanh', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Thêm công ty', exact: true }).click();
    await panel().getByLabel('Mã số thuế').fill('0123 456 780');
    await expect(panel().getByTestId('add-contact-duplicate-taxCode')).toContainText('Công ty Xanh');
    await panel().getByTestId('add-contact-duplicate-taxCode').getByRole('button', { name: 'Mở Công ty Xanh' }).click();
    await expect(panel()).toHaveCount(0);
    await expect(page.getByRole('searchbox').first()).toHaveValue('Công ty Xanh');
  });
});

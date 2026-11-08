// SPDX-License-Identifier: AGPL-3.0-only
// The HR app's declaration lists (#2533), end to end on the stack: an owner records what the forms need of a person (birth date, tax code, insurance number, the authorization to finalize), opens
// "Bảng kê khai báo", reads a list that says it is a list to declare from with its layout version and draft banner, downloads the xlsx from the authenticated route, and has the print button.
// A month cannot be approved while a payroll rule is still `commentary` (#2535), so a real approved run cannot exist on the stack yet: the figures against approved runs are checked on PostgreSQL in
// apps/kernel/test/hr-payroll-run.db.test.ts; here the lists are empty and say so.
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('an owner records the identifiers, reads each declaration list with its layout version and draft banner, and downloads the xlsx', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('hr-declarations'));
  const slug = await createOrg(page, 'Công ty Bảng Kê Khai Báo');

  await test.step('the staff form takes the birth date, the tax code and the insurance number, and the authorization is kept for the year', async () => {
    await page.goto(`/o/${slug}/hr/employees`);
    await page.getByTestId('hr-employee-new').click();
    const form = page.getByTestId('hr-employee-form');
    await form.getByLabel('Họ và tên').fill('Nguyễn Thị Kê Khai');
    await form.getByLabel('Ngày sinh').fill('1990-05-17');
    await form.getByLabel('Mã số thuế cá nhân').fill('8123456789');
    await form.getByLabel('Số sổ BHXH').fill('7305186294');
    // The bank the person is paid at (#2897) sits next to the sealed account number.
    await form.getByLabel('Ngân hàng', { exact: true }).fill('Vietcombank');
    await form.getByLabel('Lương cơ bản (đ/tháng)').fill('15000000');
    await page.getByTestId('hr-employee-save').click();
    await page.getByTestId('hr-employee-row').filter({ hasText: 'Nguyễn Thị Kê Khai' }).getByTestId('hr-employee-open').click();
    const detail = page.getByTestId('hr-employee-detail');
    await expect(detail.getByTestId('hr-employee-birth')).not.toHaveText('');
    await expect(detail.getByTestId('hr-employee-bank')).toHaveText('Vietcombank');
    // The sealed numbers are masked until the person asks to see them.
    await expect(detail.getByTestId('hr-employee-tax')).toHaveText('••••••••');
    await detail.getByTestId('hr-employee-reveal').click();
    await expect(detail.getByTestId('hr-employee-tax')).toHaveText('8123456789');
    await expect(detail.getByTestId('hr-employee-insurance')).toHaveText('7305186294');
    const authorized = detail.getByTestId('hr-employee-authorized').getByRole('checkbox');
    // The box shows what the server stored, so it changes once the command has answered: click and wait for it, not `check()`, which fails if the state does not flip at once.
    await authorized.click();
    await expect(authorized).toBeChecked();
  });

  await test.step('the list says it is a list to declare from, names its layout version and draft banner, and is empty without an approved run', async () => {
    await page.goto(`/o/${slug}/hr/declarations`);
    await expect(page.getByRole('heading', { name: 'Bảng kê khai báo', exact: true })).toBeVisible();
    await page.getByTestId('hr-decl-kind').selectOption('kk');
    await page.getByTestId('hr-decl-view').click();
    // Opening everyone's identifiers needs a second factor used in the last 5 minutes: the first read asks for it, and runs again once it is verified.
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    const doc = page.getByTestId('hr-declaration');
    await expect(doc.getByTestId('hr-declaration-notice')).toHaveText(/bảng kê để khai báo/i);
    await expect(doc.getByTestId('hr-declaration-layout')).toContainText('ludy-hr-05kk/1');
    await expect(doc.getByTestId('hr-declaration-draft')).toContainText('dòng 14');
    await expect(doc).toContainText('Ludy không nộp và không ký');
    await expect(page.getByTestId('hr-decl-print')).toBeVisible();
  });

  await test.step('the print path is recorded like a download', async () => {
    await expect(page.getByTestId('hr-decl-print')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => {
        (window as unknown as { printed: number }).printed += 1;
      };
    });
    await page.getByTestId('hr-decl-print').click();
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
    // The view the print comes from left the same audit row a file leaves (counts only), written by the server.
    const rows = sql<{ via: string; kind: string }>(
      `SELECT a.detail->>'via' AS via, a.detail->>'kind' AS kind FROM crove_kernel.audit_event a JOIN crove_kernel.tenant t ON t.org_id = a.org_id WHERE t.slug = :'slug' AND a.command = 'hr.payroll.declaration.export' AND a.outcome = 'ok'`,
      { slug },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.via === 'view')).toBe(true);
  });

  await test.step('each kind opens with its own layout version', async () => {
    for (const [kind, version, row] of [
      ['d02lt', 'ludy-hr-d02lt/1', 'dòng 9'],
      ['qtt', 'ludy-hr-05qtt/1', 'dòng 14'],
      ['certificate', 'ludy-hr-03tncn/1', 'dòng 15'],
    ] as const) {
      await page.getByTestId('hr-decl-kind').selectOption(kind);
      await page.getByTestId('hr-decl-view').click();
      await expect(page.getByTestId('hr-declaration-layout')).toContainText(version);
      await expect(page.getByTestId('hr-declaration-draft')).toContainText(row);
    }
  });

  await test.step('the xlsx comes from the authenticated route, with the period in its name', async () => {
    await page.getByTestId('hr-decl-kind').selectOption('kk');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('hr-decl-download').click()]);
    expect(download.suggestedFilename()).toMatch(/^bang-ke-kk-\d{4}-Q[1-4]\.xlsx$/);
  });

  await test.step('the route refuses a request with no sign-in', async () => {
    const response = await page.context().request.get(`/api/payroll-export/kk.xlsx?period=2026-Q3`, { headers: { 'x-crove-org': slug } });
    expect(response.status()).toBe(401);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on payroll (#2534), end to end with the model OFF (the stack runs without AI_BASE_URL): an owner opens a month, the sheet and its totals are complete, asking the coworker
// to look answers with a notice and never an error or a gap, and a payslip opens, with its own "explain" button that also answers with a notice. The wording of a text a model wrote is covered
// by the unit tests of packages/agent and apps/kernel (a fake model); the real stack proves that nothing in the payroll needs AI.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('with AI off the pay run and the payslip are complete, and the coworker answers with a notice', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('hr-coworker'));
  const slug = await createOrg(page, 'Công ty Bảng Lương Có Trợ Lý');

  await test.step('a person is on the staff list', async () => {
    await page.goto(`/o/${slug}/hr/employees`);
    await page.getByTestId('hr-employee-new').click();
    const form = page.getByTestId('hr-employee-form');
    await form.getByLabel('Họ và tên').fill('Phạm Thị Thử Việc');
    await form.getByLabel('Lương cơ bản (đ/tháng)').fill('15000000');
    await page.getByTestId('hr-employee-save').click();
    await expect(page.getByTestId('hr-employee-row').filter({ hasText: 'Phạm Thị Thử Việc' })).toBeVisible();
  });

  await test.step('the month opens with its sheet and totals, and the coworker says AI is off without a gap', async () => {
    await page.goto(`/o/${slug}/hr/payroll`);
    await page.getByTestId('hr-run-open').click();
    await expect(page.getByTestId('hr-sheet-title')).toBeVisible();
    await expect(page.getByTestId('hr-employer-total')).not.toHaveText('');
    await page.getByTestId('hr-coworker-ask').click();
    await expect(page.getByTestId('hr-coworker-state').first()).toContainText('AI');
    await expect(page.getByTestId('hr-coworker-prepare')).toHaveCount(0);
    await expect(page.getByTestId('hr-employer-total')).not.toHaveText('');
  });

  await test.step('the payslip is complete and asking to explain it answers with a notice', async () => {
    await page.getByTestId('hr-payslip-open').first().click();
    await expect(page.getByTestId('hr-payslip')).toContainText('Phạm Thị Thử Việc');
    await page.getByTestId('hr-explain').click();
    await expect(page.getByTestId('hr-coworker-state')).toContainText('AI');
    await expect(page.getByTestId('hr-explanation')).toHaveCount(0);
    await expect(page.getByTestId('hr-payslip-print')).toBeVisible();
  });
});

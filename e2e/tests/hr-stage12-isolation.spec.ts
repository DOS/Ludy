// SPDX-License-Identifier: AGPL-3.0-only
// Stage 1 (#2540) + Stage 2 (#2541) HR workflow with AI off, and Phase 7 non-admin salary isolation across HR pages,
// RPCs, xlsx exports, global search, and Coworker Ly (#3430, payroll plan section 6.6, crove-os-kernel Phase 7).
import { expect, test, type APIRequestContext, type Download, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { createOrg, newEmail, signInNewUser, storedSession } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

function vietnamDateParts(): {
  today: string;
  currentYear: number;
  currentMonth: string;
  contractStartDate: string;
  expectedContractEndDate: string;
  quarterPeriod: string;
  halfPeriod: string;
} {
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const currentYear = Number(today.slice(0, 4));
  const monthNum = Number(today.slice(5, 7));
  const quarter = Math.floor((monthNum - 1) / 3) + 1;
  return {
    today,
    currentYear,
    currentMonth: today.slice(0, 7),
    contractStartDate: `${currentYear - 1}-01-01`,
    expectedContractEndDate: `${currentYear}-12-31`,
    quarterPeriod: `${currentYear}-Q${quarter}`,
    halfPeriod: `${currentYear}-H1`,
  };
}

function parseVndAmount(text: string | null): number {
  const digits = (text ?? '').replace(/\D/g, '');
  return digits === '' ? 0 : Number(digits);
}

async function enrollTotp(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  if (!secret) throw new Error('Expected non-empty TOTP setup key');
  const { code } = await nextTotp(secret);
  await page.getByLabel('Mã xác thực').fill(code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  return secret;
}

async function requireAccessToken(page: Page): Promise<string> {
  const session = await storedSession(page);
  if (!session?.access_token) throw new Error('Expected active browser session with access_token');
  return session.access_token;
}

async function postRpc(
  request: APIRequestContext,
  path: string,
  token: string,
  slug: string,
  input: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const response = await request.post(`/api/rpc/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-crove-org': slug,
      'content-type': 'application/json',
    },
    data: { json: input },
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status(), text, json };
}

async function workbookText(download: Download): Promise<string> {
  const filePath = await download.path();
  if (!filePath) throw new Error('Expected downloaded file path on disk');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const parts: string[] = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      for (const value of row.values as unknown[]) {
        if (value !== null && value !== undefined) parts.push(String(value));
      }
    });
  }
  return parts.join('\n');
}

function errorCodeOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  if (record.json && typeof record.json === 'object') {
    const nested = (record.json as Record<string, unknown>).code;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

test('Stage 1 (#2540) and Stage 2 (#2541) owner workflow completes with AI off', async ({ page }) => {
  const { today, currentYear, currentMonth, contractStartDate, expectedContractEndDate } = vietnamDateParts();
  const employeeName = 'Nguyễn Minh Nhân Sự';

  await page.goto('/');
  await signInNewUser(page, newEmail('hr-stage12-owner'));
  const slug = await createOrg(page, 'Công ty Nhân Sự Giai Đoạn 1 2');

  await test.step('owner creates an employee with fixed-term labor contract fields', async () => {
    await page.goto(`/o/${slug}/hr/employees`);
    await page.getByTestId('hr-employee-new').click();
    const form = page.getByTestId('hr-employee-form');
    await form.getByLabel('Họ và tên').fill(employeeName);
    await form.getByLabel('Địa chỉ').fill('12 Nguyễn Huệ, Quận 1, TP.HCM');
    await form.getByLabel('Số căn cước / hộ chiếu').fill('001090000001');
    await form.getByLabel('Số tài khoản ngân hàng').fill('001100000001');
    await form.getByLabel('Tìm ngân hàng').fill('ngoai thuong');
    await form.getByLabel('Ngân hàng', { exact: true }).selectOption('VCB');
    await form.getByLabel('Ngày sinh').fill('1992-08-15');
    await form.getByLabel('Mã số thuế cá nhân').fill('8123456789');
    await form.getByLabel('Số sổ BHXH').fill('7305186294');

    await form.locator('#hr-add-from').fill(contractStartDate);
    await form.locator('#hr-add-contract').selectOption('fixed_term');
    await form.getByLabel('Lương cơ bản (đ/tháng)').fill('18000000');

    await form.getByTestId('hr-contract-details-toggle').click();
    await expect(form.getByTestId('hr-contract-details-panel')).toBeVisible();
    await form.locator('#hr-add-contract-form').selectOption('written');
    await form.locator('#hr-add-term-months').fill('24');
    await expect(form.getByTestId('hr-contract-auto-end')).toBeVisible();
    await form.locator('#hr-add-fixed-seq').selectOption('1');
    await expect(form.getByTestId('hr-contract-validation-errors')).toHaveCount(0);

    await page.getByTestId('hr-employee-save').click();
    const row = page.getByTestId('hr-employee-row').filter({ hasText: employeeName });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Xác định thời hạn');
    await expect(row).toContainText('18.000.000');

    await row.getByTestId('hr-employee-open').click();
    const detail = page.getByTestId('hr-employee-detail');
    await expect(detail.getByTestId('hr-terms-row').first()).toContainText('Xác định thời hạn');
    await expect(detail.getByTestId('hr-terms-row').first()).toContainText('24 tháng');
  });

  await test.step('owner records annual leave and unpaid leave in LeaveBalancePanel', async () => {
    const detail = page.getByTestId('hr-employee-detail');
    await detail.getByTestId('hr-leave-toggle').click();
    const leavePanel = detail.getByTestId('hr-leave-panel');
    await expect(leavePanel).toBeVisible();
    await expect(leavePanel.getByTestId('hr-leave-remaining')).toBeVisible();

    const initialRemaining = Number((await leavePanel.getByTestId('hr-leave-remaining').textContent())?.trim() ?? '0');
    expect(initialRemaining).toBeGreaterThanOrEqual(12);

    await leavePanel.getByTestId('hr-leave-month').fill(currentMonth);
    await leavePanel.getByTestId('hr-leave-kind').selectOption('annual_leave');
    await leavePanel.getByTestId('hr-leave-days').fill('1');
    await expect(leavePanel.getByTestId('hr-leave-approved')).toBeChecked();
    await leavePanel.getByTestId('hr-leave-save').click();

    await expect(leavePanel.getByTestId('hr-leave-entry-row')).toHaveCount(1);
    await expect(leavePanel.getByTestId('hr-leave-entry-row').first()).toContainText('Nghỉ phép năm');
    await expect(leavePanel.getByTestId('hr-leave-remaining')).toHaveText(String(initialRemaining - 1));

    await leavePanel.getByTestId('hr-leave-month').fill(currentMonth);
    await leavePanel.getByTestId('hr-leave-kind').selectOption('unpaid_leave');
    await leavePanel.getByTestId('hr-leave-days').fill('2');
    await leavePanel.getByTestId('hr-leave-save').click();

    await expect(leavePanel.getByTestId('hr-leave-entry-row')).toHaveCount(2);
    const unpaidRow = leavePanel.getByTestId('hr-leave-entry-row').filter({ hasText: 'Nghỉ không lương' });
    await expect(unpaidRow).toContainText(currentMonth);
    await expect(unpaidRow).toContainText('2');
  });

  await test.step('owner checks Art. 46 severance panel with AI off', async () => {
    const detail = page.getByTestId('hr-employee-detail');
    await detail.getByTestId('hr-severance-toggle').click();
    const panel = detail.getByTestId('hr-severance-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('hr-severance-readonly-note')).toBeVisible();
    const result = panel.getByTestId('hr-severance-result');
    await expect(result).toContainText('Đủ điều kiện');

    const initialText = await result.getByTestId('hr-severance-amount').textContent();
    const initialAmount = parseVndAmount(initialText);
    expect(initialAmount).toBeGreaterThan(0);
    await expect(result.getByTestId('hr-severance-exempt')).toHaveText(initialText ?? '');
    await expect(result.getByTestId('hr-severance-excess')).toHaveText(/^0\s*[₫đ]$/);

    await panel.getByTestId('hr-severance-insured-months').fill('6');
    await panel.getByTestId('hr-severance-calculate').click();
    await expect
      .poll(async () => parseVndAmount(await result.getByTestId('hr-severance-amount').textContent()))
      .toBeLessThan(initialAmount);
  });

  await test.step('owner opens draft pay run, imports timekeeping CSV, syncs unpaid leave, and applies 13th-month proration with AI off', async () => {
    await page.goto(`/o/${slug}/hr/payroll`);
    await page.locator('#hr-month').fill(currentMonth);
    await page.getByTestId('hr-run-open').click();
    await expect(page.getByTestId('hr-sheet-title')).toContainText(currentMonth);
    await expect(page.getByTestId('hr-employer-total')).not.toHaveText('');

    // Verify AI-off state on the payroll sheet.
    await page.getByTestId('hr-coworker-ask').click();
    await expect(page.getByTestId('hr-coworker-state').first()).toBeVisible();
    await expect(page.getByTestId('hr-coworker-sentence')).toHaveCount(0);

    // Import timekeeping CSV (sets unpaid leave to 0 first and adds 4h normal OT + 2h night work).
    await page.getByTestId('hr-timekeeping-toggle').click();
    const importPanel = page.getByTestId('hr-timekeeping-import');
    await expect(importPanel).toBeVisible();
    await importPanel.getByTestId('hr-timekeeping-file').setInputFiles({
      name: 'cham-cong.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`Họ tên,Nghỉ không lương,Làm thêm ngày thường,Giờ làm đêm\n${employeeName},0,4,2\n`, 'utf8'),
    });
    const previewRow = importPanel.getByTestId('hr-timekeeping-preview-row');
    await expect(previewRow).toHaveCount(1);
    await expect(previewRow).toContainText(employeeName);
    await expect(previewRow).toContainText('Sẵn sàng');
    await importPanel.getByTestId('hr-timekeeping-apply').click();
    await expect(importPanel).toHaveCount(0);

    await page.getByTestId('hr-line-open').first().click();
    const breakdown = page.getByTestId('hr-breakdown');
    await expect(breakdown).toContainText('Làm thêm giờ (ngày thường, 4 giờ)');
    await expect(breakdown).toContainText('Phụ cấp làm đêm (2 giờ)');

    // Sync unpaid leave (2 days) from the leave ledger and confirm timekeeping OT/night hours survive.
    await page.getByTestId('hr-sync-leave').click();
    await page.getByTestId('hr-inputs-open').click();
    const inputsForm = page.getByTestId('hr-inputs-form');
    await expect(inputsForm.getByLabel('Nghỉ không lương (ngày)')).toHaveValue('2');
    await expect(inputsForm.getByLabel('Giờ làm đêm')).toHaveValue('2');
    await inputsForm.getByRole('button', { name: 'Hủy' }).click();
    await expect(breakdown).toContainText('Làm thêm giờ (ngày thường, 4 giờ)');
    await expect(breakdown).toContainText('Phụ cấp làm đêm (2 giờ)');

    await expect
      .poll(async () => {
        const unpaidValue = await breakdown
          .locator('dt', { hasText: 'Trừ nghỉ không lương và ngày chưa làm' })
          .locator('..')
          .locator('dd')
          .textContent();
        return parseVndAmount(unpaidValue);
      })
      .toBeGreaterThan(0);

    // Trigger 13th-month bonus proration with AI off.
    await page.getByTestId('hr-13th-month-toggle').click();
    const thirteenthPanel = page.getByTestId('hr-13th-month-panel');
    await expect(thirteenthPanel).toBeVisible();
    await expect(thirteenthPanel.getByTestId('hr-13th-month-row')).toHaveCount(1);
    await expect(thirteenthPanel.getByTestId('hr-13th-month-row')).toContainText(employeeName);
    const proratedTotal = (await thirteenthPanel.getByTestId('hr-13th-month-total').textContent())?.trim() ?? '';
    expect(parseVndAmount(proratedTotal)).toBeGreaterThan(0);

    await thirteenthPanel.getByTestId('hr-13th-month-apply').click();
    await expect(thirteenthPanel).toHaveCount(0);
    await expect(breakdown).toContainText(proratedTotal);
  });

  await test.step('owner enables TOTP 2FA, views and downloads Sổ quản lý lao động and Mẫu 01/PLI on /hr/declarations', async () => {
    await page.goto(`/o/${slug}/hr/declarations`);
    await page.getByTestId('hr-decl-kind').selectOption('labor_register');

    // Run deterministic Ly compliance check with AI off before viewing the export.
    await page.getByTestId('hr-decl-ly-check').click();
    const lyResult = page.getByTestId('hr-decl-ly-result');
    await expect(lyResult).toBeVisible();
    await expect(lyResult).toContainText('Chưa bật AI');

    await page.getByTestId('hr-decl-view').click();
    await enrollTotp(page);

    const doc = page.getByTestId('hr-declaration');
    await expect(doc).toBeVisible();
    await expect(doc.getByTestId('hr-declaration-layout')).toContainText('ludy-hr-labor-register/1');
    await expect(doc.getByTestId('hr-declaration-sheet')).toContainText(employeeName);
    await expect(doc.getByTestId('hr-declaration-sheet')).toContainText('Xác định thời hạn');
    await expect(doc.getByTestId('hr-declaration-sheet')).toContainText(contractStartDate);
    await expect(doc.getByTestId('hr-declaration-sheet')).toContainText(expectedContractEndDate);

    const [laborDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('hr-decl-download').click(),
    ]);
    expect(laborDownload.suggestedFilename()).toBe(`bang-ke-labor_register-${today}.xlsx`);
    expect(await workbookText(laborDownload)).toContain(employeeName);

    await page.getByTestId('hr-decl-kind').selectOption('01pli');
    await page.getByTestId('hr-decl-half').selectOption('H1');
    await page.getByTestId('hr-decl-view').click();
    await expect(doc.getByTestId('hr-declaration-layout')).toContainText('ludy-hr-01pli/1');
    await expect(doc.getByTestId('hr-declaration-sheet').nth(1)).toContainText(employeeName);
    await expect(doc.getByTestId('hr-declaration-sheet').nth(1)).toContainText('Xác định thời hạn');

    const [pliDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('hr-decl-download').click(),
    ]);
    expect(pliDownload.suggestedFilename()).toBe(`bang-ke-01pli-${currentYear}-H1.xlsx`);
    expect(await workbookText(pliDownload)).toContain(employeeName);
  });
});

test('Phase 7 non-admin salary isolation blocks a chief accountant member across UI, RPCs, exports, search, and Coworker Ly', async ({ page, browser }) => {
  const { today, currentYear, currentMonth, contractStartDate, quarterPeriod, halfPeriod } = vietnamDateParts();
  const employeeName = 'Trần Minh Cách Ly';
  const baseWage = '19750000';
  const formattedWage = '19.750.000';
  const identityNumber = '001091000002';
  const accountNumber = '001100000002';

  await page.goto('/');
  await signInNewUser(page, newEmail('hr-iso-owner'));
  const slug = await createOrg(page, 'Công ty Cách Ly Lương');

  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
  await enrollTotp(page);
  await expect(page.getByText('Đang bật')).toBeVisible();

  await page.goto(`/o/${slug}/hr/employees`);
  await page.getByTestId('hr-employee-new').click();
  const form = page.getByTestId('hr-employee-form');
  await form.getByLabel('Họ và tên').fill(employeeName);
  await form.getByLabel('Số căn cước / hộ chiếu').fill(identityNumber);
  await form.getByLabel('Số tài khoản ngân hàng').fill(accountNumber);
  await form.getByLabel('Tìm ngân hàng').fill('ngoai thuong');
  await form.getByLabel('Ngân hàng', { exact: true }).selectOption('VCB');
  await form.getByLabel('Ngày sinh').fill('1991-04-20');
  await form.getByLabel('Mã số thuế cá nhân').fill('8123456789');
  await form.getByLabel('Số sổ BHXH').fill('7305186294');
  await form.locator('#hr-add-from').fill(contractStartDate);
  await form.getByLabel('Lương cơ bản (đ/tháng)').fill(baseWage);
  await page.getByTestId('hr-employee-save').click();
  await expect(page.getByTestId('hr-employee-row').filter({ hasText: employeeName })).toBeVisible();

  await page.goto(`/o/${slug}/hr/payroll`);
  await page.locator('#hr-month').fill(currentMonth);
  await page.getByTestId('hr-run-open').click();
  await expect(page.getByTestId('hr-sheet-title')).toContainText(currentMonth);

  const ownerToken = await requireAccessToken(page);
  const employeesRes = await postRpc(page.request, 'hr/payroll/employees/list', ownerToken, slug, { status: 'active', limit: 20 });
  expect(employeesRes.status).toBe(200);
  const employeesList = ((employeesRes.json as { json?: Array<{ id: string; displayName: string }> })?.json ?? []) as Array<{ id: string; displayName: string }>;
  const employeeId = employeesList.find((e) => e.displayName === employeeName)?.id ?? '';
  expect(employeeId).not.toBe('');

  const runsRes = await postRpc(page.request, 'hr/payroll/runs/list', ownerToken, slug, { limit: 24 });
  expect(runsRes.status).toBe(200);
  const runsList = ((runsRes.json as { json?: Array<{ id: string; month: string }> })?.json ?? []) as Array<{ id: string; month: string }>;
  const runId = runsList.find((r) => r.month === currentMonth)?.id ?? '';
  expect(runId).not.toBe('');

  const sheetRes = await postRpc(page.request, 'hr/payroll/runs/sheet', ownerToken, slug, { runId });
  expect(sheetRes.status).toBe(200);
  const sheetData = (sheetRes.json as { json?: { lines?: Array<{ id: string; employeeId: string }> } })?.json;
  const lineId = sheetData?.lines?.find((l) => l.employeeId === employeeId)?.id ?? '';
  expect(lineId).not.toBe('');

  // Invite a second user as org `member` and assign the built-in `Kế toán trưởng` role (`finance.chief_accountant`).
  const memberEmail = newEmail('hr-iso-member');
  await page.goto(`/o/${slug}/settings`);
  await page.getByPlaceholder(/^email@/).fill(memberEmail);
  await page.getByLabel('Vai trò', { exact: true }).selectOption('member');
  await page.getByRole('button', { name: 'Mời', exact: true }).click();
  const created = page.getByRole('status').filter({ hasText: `Đã tạo lời mời cho ${memberEmail}` });
  const inviteLink = (await created.getByText(/\/-\/invite#/).textContent())?.trim() ?? '';
  expect(inviteLink).toMatch(/\/-\/invite#/);

  const memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const memberPage = await memberContext.newPage();
    await signInNewUser(memberPage, memberEmail);
    await memberPage.goto(inviteLink);
    await memberPage.getByRole('button', { name: 'Chấp nhận lời mời' }).click();
    await expect(memberPage).toHaveURL(new RegExp(`/o/${slug}/overview$`));

    await page.reload();
    const memberRow = page.getByRole('listitem').filter({ hasText: memberEmail }).first();
    const rolesGroup = memberRow.getByRole('group', { name: `Vai trò nghiệp vụ của ${memberEmail}` });
    await rolesGroup.getByRole('button', { name: `Giao vai trò cho ${memberEmail}` }).click();
    await rolesGroup.getByLabel('Vai trò nghiệp vụ', { exact: true }).selectOption({ label: 'Kế toán trưởng' });
    await rolesGroup.getByRole('button', { name: 'Giao vai trò', exact: true }).click();
    await expect(rolesGroup.getByText('Kế toán trưởng', { exact: true })).toBeVisible();

    // Verify on the member's own session: `member` + `Kế toán trưởng` can read accounting (`journal/list` 200),
    // and enable fresh TOTP 2FA so export/declaration rejections prove RBAC FORBIDDEN rather than missing step-up.
    await memberPage.goto(`/o/${slug}/settings`);
    await enrollTotp(memberPage);
    await expect(memberPage.getByText('Đang bật')).toBeVisible();

    const memberToken = await requireAccessToken(memberPage);
    const orgCheck = await postRpc(memberPage.request, 'org/get', memberToken, slug, undefined);
    expect(orgCheck.status).toBe(200);
    expect((orgCheck.json as { json?: { role?: string } })?.json?.role).toBe('member');

    const journalCheck = await postRpc(memberPage.request, 'journal/list', memberToken, slug, {});
    expect(journalCheck.status).toBe(200);

    // HR navigation is hidden for non-admin/non-owner roles.
    await memberPage.goto(`/o/${slug}/overview`);
    await expect(memberPage.getByRole('navigation').getByText('Nhân sự', { exact: true })).toHaveCount(0);

    await test.step('Vector 1: HR pages and RPCs refuse member + Kế toán trưởng with 403 and zero salary leakage', async () => {
      for (const path of [`/o/${slug}/hr/employees`, `/o/${slug}/hr/payroll`, `/o/${slug}/hr/declarations`]) {
        await memberPage.goto(path);
        if (path.endsWith('/hr/declarations')) {
          await memberPage.getByTestId('hr-decl-kind').selectOption('labor_register');
          await memberPage.getByTestId('hr-decl-view').click();
        }
        await expect(memberPage.getByRole('alert').first()).toBeVisible();
        await expect(memberPage.getByTestId('hr-employee-row')).toHaveCount(0);
        await expect(memberPage.getByTestId('hr-run-row')).toHaveCount(0);
        await expect(memberPage.getByTestId('hr-line-row')).toHaveCount(0);
        await expect(memberPage.getByTestId('hr-declaration')).toHaveCount(0);

        const bodyText = (await memberPage.locator('main').textContent()) ?? '';
        expect(bodyText).not.toContain(employeeName);
        expect(bodyText).not.toContain(formattedWage);
        expect(bodyText).not.toContain(baseWage);
        expect(bodyText).not.toContain(identityNumber);
        expect(bodyText).not.toContain(accountNumber);
      }

      const forbiddenRpcs: Array<[string, unknown]> = [
        ['hr/payroll/employees/list', { status: 'active', limit: 20 }],
        ['hr/payroll/employees/get', { employeeId }],
        ['hr/payroll/employees/severance', { employeeId }],
        ['hr/payroll/leave/balance', { employeeId, year: String(currentYear), category: 'standard' }],
        ['hr/payroll/leave/set', { employeeId, month: currentMonth, kind: 'unpaid_leave', days: '1', approved: true }],
        ['hr/payroll/runs/list', { limit: 24 }],
        ['hr/payroll/runs/sheet', { runId }],
        ['hr/payroll/runs/thirteenthMonthPreview', { runId, year: currentYear }],
        ['hr/payroll/runs/syncLeave', { runId }],
        ['hr/payroll/lines/payslip', { lineId }],
        ['hr/payroll/bankTemplates/list', {}],
      ];

      for (const [rpcPath, input] of forbiddenRpcs) {
        const res = await postRpc(memberPage.request, rpcPath, memberToken, slug, input);
        expect(res.status, `${rpcPath} should return 403 (got ${res.status}: ${res.text})`).toBe(403);
        expect(errorCodeOf(res.json), `${rpcPath} error code`).toBe('FORBIDDEN');
        expect(res.text).not.toContain(employeeName);
        expect(res.text).not.toContain(baseWage);
        expect(res.text).not.toContain(identityNumber);
        expect(res.text).not.toContain(accountNumber);
      }
    });

    await test.step('Vector 2: authenticated payroll export and bank-file routes return 403 FORBIDDEN', async () => {
      const exportPaths = [
        `/api/payroll-export/kk.xlsx?period=${quarterPeriod}`,
        `/api/payroll-export/d02lt.xlsx?period=${currentMonth}`,
        `/api/payroll-export/labor_register.xlsx?period=${today}`,
        `/api/payroll-export/labor_register.json?period=${today}`,
        `/api/payroll-export/01pli.xlsx?period=${halfPeriod}`,
        `/api/payroll-bank-file/${runId}.xlsx?bank=VCB`,
      ];

      for (const exportPath of exportPaths) {
        const response = await memberPage.request.get(exportPath, {
          headers: {
            authorization: `Bearer ${memberToken}`,
            'x-crove-org': slug,
          },
        });
        expect(response.status(), `${exportPath} should return 403`).toBe(403);
        const body = (await response.json()) as { code?: string };
        expect(body.code, `${exportPath} error code`).toBe('FORBIDDEN');
      }
    });

    await test.step('Vector 3: global search and command palette return zero HR employee or salary results', async () => {
      for (const q of [employeeName, 'Cách Ly', baseWage, formattedWage]) {
        const res = await postRpc(memberPage.request, 'search/query', memberToken, slug, { q });
        expect(res.status, `search/query for ${q}`).toBe(200);
        const result = (res.json as { json?: { parties: unknown[]; documents: unknown[]; entries: unknown[] } })?.json;
        expect(result).toEqual({ parties: [], documents: [], entries: [] });
        expect(res.text).not.toContain(employeeName);
        expect(res.text).not.toContain(baseWage);
      }

      await memberPage.goto(`/o/${slug}/overview`);
      await expect(memberPage.getByRole('navigation')).toBeVisible();
      await memberPage.keyboard.press('Control+k');
      const palette = memberPage.getByRole('dialog', { name: 'Bảng lệnh' });
      await expect(palette).toBeVisible();
      const combobox = palette.getByRole('combobox');

      await combobox.fill(employeeName);
      await expect(palette.getByText('Không tìm thấy kết quả phù hợp.')).toBeVisible();
      await expect(palette).not.toContainText(employeeName);

      await combobox.fill(baseWage);
      await expect(palette.getByText('Không tìm thấy kết quả phù hợp.')).toBeVisible();
      await expect(palette).not.toContainText(formattedWage);
      await memberPage.keyboard.press('Escape');
    });

    await test.step('Vector 4: AI Coworker Ly HR endpoints refuse member + Kế toán trưởng with 403 FORBIDDEN', async () => {
      await memberPage.goto(`/o/${slug}/hr/declarations`);
      await memberPage.getByTestId('hr-decl-kind').selectOption('labor_register');
      await memberPage.getByTestId('hr-decl-ly-check').click();
      await expect(memberPage.getByTestId('hr-decl-ly-result')).toHaveCount(0);
      await expect(memberPage.getByRole('alert').first()).toBeVisible();

      const lyRpcs: Array<[string, unknown]> = [
        ['hr/payroll/coworker/prepare', { runId, lang: 'vi' }],
        ['hr/payroll/coworker/flag', { runId, lang: 'vi' }],
        ['hr/payroll/laborCheck', { kind: 'labor_register', period: today, lang: 'vi' }],
        ['hr/payroll/laborCheck', { kind: '01pli', period: halfPeriod, lang: 'vi' }],
        ['hr/payroll/coworker/explain', { lineId, lang: 'vi' }],
      ];

      for (const [rpcPath, input] of lyRpcs) {
        const res = await postRpc(memberPage.request, rpcPath, memberToken, slug, input);
        expect(res.status, `${rpcPath} should return 403 (got ${res.status}: ${res.text})`).toBe(403);
        expect(errorCodeOf(res.json), `${rpcPath} error code`).toBe('FORBIDDEN');
        expect(res.text).not.toContain(employeeName);
        expect(res.text).not.toContain(baseWage);
      }
    });
  } finally {
    await memberContext.close();
  }
});

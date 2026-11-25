// SPDX-License-Identifier: AGPL-3.0-only
// Stage 3a HR departments workflow (#3412), PDPL erasure, and Phase 7 non-admin department & wage-rollup isolation E2E (#3439).
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser, storedSession } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';
import { openSettingsTab } from '../lib/settings.ts';

function vietnamDates(): { today: string; hireDate: string; endedOn: string } {
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const currentYear = Number(today.slice(0, 4));
  // Past effective/end dates beyond HR_RETENTION_YEARS (10 years) allow UI PDPL erasure without direct DB edits.
  return {
    today,
    hireDate: `${currentYear - 12}-01-01`,
    endedOn: `${currentYear - 11}-12-31`,
  };
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
      'x-ludy-org': slug,
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

test('Stage 3a departments owner workflow, zero-setup default, and PDPL erasure complete with AI off', async ({ page }) => {
  const { hireDate, endedOn } = vietnamDates();
  const unassignedEmployee = 'Nguyễn Văn Mặc Định';
  const salesEmployee = 'Trần Thị Kinh Doanh';
  const salesJobTitle = 'Chuyên viên tư vấn';
  const salesWage = '20000000';
  const formattedSalesWage = '20.000.000';

  await page.goto('/');
  await signInNewUser(page, newEmail('hr-dept-owner'));
  const slug = await createOrg(page, 'Công ty Phòng Ban Giai Đoạn 3a');

  await test.step('zero-setup SME default allows creating an unassigned employee with no departments', async () => {
    await page.goto(`/o/${slug}/hr/employees`);
    const deptCard = page.getByTestId('hr-departments-card');
    await expect(deptCard).toBeVisible();
    await expect(deptCard.getByTestId('hr-departments-empty')).toBeVisible();

    await page.getByTestId('hr-employee-new').click();
    const form = page.getByTestId('hr-employee-form');
    await expect(form.getByTestId('hr-add-department')).toHaveValue('');
    await expect(form.locator('#hr-add-function')).toHaveValue('admin');
    await form.getByLabel('Họ và tên').fill(unassignedEmployee);
    await form.getByLabel('Lương cơ bản (đ/tháng)').fill('15000000');
    await page.getByTestId('hr-employee-save').click();

    const row = page.getByTestId('hr-employee-row').filter({ hasText: unassignedEmployee });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('hr-employee-dept-cell')).toHaveText('-');
    await expect(row).toContainText('15.000.000');

    await row.getByTestId('hr-employee-open').click();
    const detail = page.getByTestId('hr-employee-detail');
    await expect(detail.getByTestId('hr-employee-department')).toHaveText('(chưa có)');
    await expect(detail.getByTestId('hr-employee-job-title')).toHaveText('(chưa có)');
    await detail.getByRole('button', { name: 'Đóng' }).click();
    await expect(detail).toHaveCount(0);
  });

  await test.step('owner creates Kinh doanh (sales) and Kỹ thuật (production) departments', async () => {
    const deptCard = page.getByTestId('hr-departments-card');

    await deptCard.getByTestId('hr-department-new').click();
    await deptCard.getByTestId('hr-dept-add-name').fill('Kinh doanh');
    await deptCard.getByTestId('hr-dept-add-code').fill('KD');
    await deptCard.getByTestId('hr-dept-add-pay-function').selectOption('sales');
    await deptCard.getByTestId('hr-dept-add-save').click();

    const salesDeptRow = deptCard.getByTestId('hr-department-row').filter({ hasText: 'Kinh doanh' });
    await expect(salesDeptRow).toBeVisible();
    await expect(salesDeptRow).toContainText('KD');
    await expect(salesDeptRow).toContainText('Bán hàng');
    await expect(salesDeptRow.getByTestId('hr-department-headcount')).toHaveText('0');
    await expect(salesDeptRow.getByTestId('hr-department-wage-total')).toHaveText(/^0\s*[₫đ]$/);

    await deptCard.getByTestId('hr-department-new').click();
    await deptCard.getByTestId('hr-dept-add-name').fill('Kỹ thuật');
    await deptCard.getByTestId('hr-dept-add-code').fill('KT');
    await deptCard.getByTestId('hr-dept-add-pay-function').selectOption('production');
    await deptCard.getByTestId('hr-dept-add-save').click();

    const techDeptRow = deptCard.getByTestId('hr-department-row').filter({ hasText: 'Kỹ thuật' });
    await expect(techDeptRow).toBeVisible();
    await expect(techDeptRow).toContainText('KT');
    await expect(techDeptRow).toContainText('Sản xuất trực tiếp');
    await expect(techDeptRow.getByTestId('hr-department-headcount')).toHaveText('0');
    await expect(techDeptRow.getByTestId('hr-department-wage-total')).toHaveText(/^0\s*[₫đ]$/);
  });

  await test.step('assigning Kinh doanh defaults payFunction to sales, persists metadata, and updates active rollups', async () => {
    await page.getByTestId('hr-employee-new').click();
    const form = page.getByTestId('hr-employee-form');
    await form.getByLabel('Họ và tên').fill(salesEmployee);
    await expect(form.locator('#hr-add-function')).toHaveValue('admin');

    await form.getByTestId('hr-add-department').selectOption({ label: 'Kỹ thuật (KT)' });
    await expect(form.locator('#hr-add-function')).toHaveValue('production');

    await form.getByTestId('hr-add-department').selectOption({ label: 'Kinh doanh (KD)' });
    await expect(form.locator('#hr-add-function')).toHaveValue('sales');

    await form.getByTestId('hr-add-job-title').fill(salesJobTitle);
    await form.getByLabel('Địa chỉ').fill('25 Lê Lợi, Quận 1, TP.HCM');
    await form.getByLabel('Số căn cước / hộ chiếu').fill('001090000003');
    await form.getByLabel('Số tài khoản ngân hàng').fill('001100000003');
    await form.getByLabel('Tìm ngân hàng').fill('ngoai thuong');
    await form.getByLabel('Ngân hàng', { exact: true }).selectOption('VCB');
    await form.getByLabel('Ngày sinh').fill('1993-03-10');
    await form.getByLabel('Mã số thuế cá nhân').fill('8123456789');
    await form.getByLabel('Số sổ BHXH').fill('7305186294');
    await form.locator('#hr-add-from').fill(hireDate);
    await form.getByLabel('Lương cơ bản (đ/tháng)').fill(salesWage);
    await page.getByTestId('hr-employee-save').click();

    const row = page.getByTestId('hr-employee-row').filter({ hasText: salesEmployee });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('hr-employee-dept-cell')).toHaveText(`Kinh doanh - ${salesJobTitle}`);
    await expect(row).toContainText(formattedSalesWage);

    await row.getByTestId('hr-employee-open').click();
    const detail = page.getByTestId('hr-employee-detail');
    await expect(detail.getByTestId('hr-employee-department')).toHaveText('Kinh doanh');
    await expect(detail.getByTestId('hr-employee-job-title')).toHaveText(salesJobTitle);
    await expect(detail.getByTestId('hr-terms-row').first()).toContainText(formattedSalesWage);
    await detail.getByRole('button', { name: 'Đóng' }).click();
    await expect(detail).toHaveCount(0);

    const deptCard = page.getByTestId('hr-departments-card');
    const salesDeptRow = deptCard.getByTestId('hr-department-row').filter({ hasText: 'Kinh doanh' });
    await expect(salesDeptRow.getByTestId('hr-department-headcount')).toHaveText('1');
    await expect(salesDeptRow.getByTestId('hr-department-wage-total')).toContainText(formattedSalesWage);

    const techDeptRow = deptCard.getByTestId('hr-department-row').filter({ hasText: 'Kỹ thuật' });
    await expect(techDeptRow.getByTestId('hr-department-headcount')).toHaveText('0');
    await expect(techDeptRow.getByTestId('hr-department-wage-total')).toHaveText(/^0\s*[₫đ]$/);
  });

  await test.step('filtering employees by department narrows and restores the list', async () => {
    const filter = page.getByTestId('hr-employee-dept-filter');
    await expect(page.getByTestId('hr-employee-row')).toHaveCount(2);

    await filter.selectOption({ label: 'Kinh doanh' });
    await expect(page.getByTestId('hr-employee-row')).toHaveCount(1);
    await expect(page.getByTestId('hr-employee-row').first()).toContainText(salesEmployee);

    await filter.selectOption('');
    await expect(page.getByTestId('hr-employee-row')).toHaveCount(2);
  });

  await test.step('owner edits Kỹ thuật and archives it with archived badge toggle behavior', async () => {
    const deptCard = page.getByTestId('hr-departments-card');
    const techRow = deptCard.getByTestId('hr-department-row').filter({ hasText: 'Kỹ thuật' });
    await techRow.getByTestId('hr-department-edit').click();

    await deptCard.getByTestId('hr-dept-edit-name').fill('Kỹ thuật Phần mềm');
    await deptCard.getByTestId('hr-dept-edit-code').fill('KTPM');
    await deptCard.getByTestId('hr-dept-edit-save').click();

    const renamedRow = deptCard.getByTestId('hr-department-row').filter({ hasText: 'Kỹ thuật Phần mềm' });
    await expect(renamedRow).toBeVisible();
    await expect(renamedRow).toContainText('KTPM');

    await renamedRow.getByTestId('hr-department-archive').click();
    await expect(deptCard.getByTestId('hr-department-row')).toHaveCount(1);
    await expect(deptCard.getByTestId('hr-department-row').filter({ hasText: 'Kỹ thuật Phần mềm' })).toHaveCount(0);

    await deptCard.getByTestId('hr-departments-show-archived').check();
    await expect(deptCard.getByTestId('hr-department-row')).toHaveCount(2);
    const archivedRow = deptCard.getByTestId('hr-department-row').filter({ hasText: 'Kỹ thuật Phần mềm' });
    await expect(archivedRow).toContainText('Đã lưu trữ');
    await expect(archivedRow.getByTestId('hr-department-edit')).toHaveCount(0);
    await expect(archivedRow.getByTestId('hr-department-archive')).toHaveCount(0);
    await expect(page.getByTestId('hr-employee-dept-filter').locator('option', { hasText: 'Kỹ thuật Phần mềm (Đã lưu trữ)' })).toHaveCount(1);

    await deptCard.getByTestId('hr-departments-show-archived').uncheck();
    await expect(deptCard.getByTestId('hr-department-row')).toHaveCount(1);
  });

  await test.step('owner ends employment, enrolls TOTP 2FA, and performs R3 PDPL erasure', async () => {
    const salesRow = page.getByTestId('hr-employee-row').filter({ hasText: salesEmployee });
    await salesRow.getByTestId('hr-employee-open').click();

    const detail = page.getByTestId('hr-employee-detail');
    await detail.locator('#hr-end-date').fill(endedOn);
    await detail.getByTestId('hr-employee-end').click();
    await expect(detail.getByTestId('hr-employee-erase')).toBeVisible();

    const deptCard = page.getByTestId('hr-departments-card');
    const salesDeptRow = deptCard.getByTestId('hr-department-row').filter({ hasText: 'Kinh doanh' });
    await expect(salesDeptRow.getByTestId('hr-department-headcount')).toHaveText('0');
    await expect(salesDeptRow.getByTestId('hr-department-wage-total')).toHaveText(/^0\s*[₫đ]$/);

    await detail.getByTestId('hr-employee-erase').click();
    await detail.getByTestId('hr-employee-erase-confirm').click();
    await enrollTotp(page);

    await expect(detail.getByTestId('hr-employee-erased')).toBeVisible();
    await expect(detail.getByTestId('hr-employee-erased')).toContainText('Hồ sơ này đã được xóa theo yêu cầu');
    await expect(detail).toContainText('Hồ sơ: Đã xóa theo yêu cầu');
    await expect(detail).not.toContainText(salesEmployee);
    await expect(detail).not.toContainText('Kinh doanh');
    await expect(detail).not.toContainText(salesJobTitle);

    await page.getByLabel('Hiện cả người đã nghỉ').check();
    const erasedRow = page.getByTestId('hr-employee-row').filter({ hasText: 'Đã xóa theo yêu cầu' });
    await expect(erasedRow).toBeVisible();
    await expect(erasedRow).toContainText('Đã nghỉ');
    await expect(erasedRow.getByTestId('hr-employee-dept-cell')).toHaveText('-');
    await expect(erasedRow).not.toContainText(salesEmployee);
    await expect(erasedRow).not.toContainText('Kinh doanh');
    await expect(erasedRow).not.toContainText(salesJobTitle);

    await page.getByTestId('hr-employee-dept-filter').selectOption({ label: 'Kinh doanh' });
    await expect(page.getByTestId('hr-employee-row')).toHaveCount(0);
    await page.getByTestId('hr-employee-dept-filter').selectOption('');

    await expect(salesDeptRow.getByTestId('hr-department-headcount')).toHaveText('0');
    await expect(salesDeptRow.getByTestId('hr-department-wage-total')).toHaveText(/^0\s*[₫đ]$/);

    const ownerToken = await requireAccessToken(page);
    const endedRes = await postRpc(page.request, 'hr/payroll/employees/list', ownerToken, slug, { status: 'ended', limit: 20 });
    expect(endedRes.status).toBe(200);
    const endedRows = ((endedRes.json as { json?: Array<{ id: string; displayName: string; departmentId: string | null; departmentName: string | null; jobTitle: string | null }> })?.json ?? []);
    const erasedSummary = endedRows.find((r) => r.displayName === 'Đã xóa theo yêu cầu');
    expect(erasedSummary).toBeDefined();
    expect(erasedSummary?.departmentId).toBeNull();
    expect(erasedSummary?.departmentName).toBeNull();
    expect(erasedSummary?.jobTitle).toBeNull();

    const getRes = await postRpc(page.request, 'hr/payroll/employees/get', ownerToken, slug, { employeeId: erasedSummary?.id });
    expect(getRes.status).toBe(200);
    const erasedDetail = (
      getRes.json as {
        json?: {
          erased?: boolean;
          displayName?: string;
          departmentId?: string | null;
          departmentName?: string | null;
          jobTitle?: string | null;
          current?: { payFunction?: string } | null;
        };
      }
    )?.json;
    expect(erasedDetail).toMatchObject({
      erased: true,
      displayName: 'Đã xóa theo yêu cầu',
      departmentId: null,
      departmentName: null,
      jobTitle: null,
      current: { payFunction: 'sales' },
    });
  });
});

test('Phase 7 non-admin (member + Kế toán trưởng) department and wage-rollup isolation holds across RPCs, UI, and global search', async ({ page, browser }) => {
  const { hireDate } = vietnamDates();
  const salesDeptName = 'Phòng Kinh doanh Cách Ly';
  const techDeptName = 'Phòng Kỹ thuật Cách Ly';
  const salesDeptCode = 'KDCL';
  const techDeptCode = 'KTCL';
  const employeeName = 'Lê Minh Cách Ly';
  const jobTitle = 'Trưởng phòng Cách Ly';
  const baseWage = '24500000';
  const formattedWage = '24.500.000';

  await page.goto('/');
  await signInNewUser(page, newEmail('hr-dept-iso-owner'));
  const slug = await createOrg(page, 'Công ty Cách Ly Phòng Ban');

  await page.getByRole('banner').getByRole('link', { name: 'Cài đặt', exact: true }).click();
  await openSettingsTab(page, 'security');
  await enrollTotp(page);
  await expect(page.getByText('Đang bật')).toBeVisible();

  await page.goto(`/o/${slug}/hr/employees`);
  const deptCard = page.getByTestId('hr-departments-card');

  await deptCard.getByTestId('hr-department-new').click();
  await deptCard.getByTestId('hr-dept-add-name').fill(salesDeptName);
  await deptCard.getByTestId('hr-dept-add-code').fill(salesDeptCode);
  await deptCard.getByTestId('hr-dept-add-pay-function').selectOption('sales');
  await deptCard.getByTestId('hr-dept-add-save').click();
  await expect(deptCard.getByTestId('hr-department-row').filter({ hasText: salesDeptName })).toBeVisible();

  await deptCard.getByTestId('hr-department-new').click();
  await deptCard.getByTestId('hr-dept-add-name').fill(techDeptName);
  await deptCard.getByTestId('hr-dept-add-code').fill(techDeptCode);
  await deptCard.getByTestId('hr-dept-add-pay-function').selectOption('production');
  await deptCard.getByTestId('hr-dept-add-save').click();
  await expect(deptCard.getByTestId('hr-department-row').filter({ hasText: techDeptName })).toBeVisible();

  await page.getByTestId('hr-employee-new').click();
  const form = page.getByTestId('hr-employee-form');
  await form.getByLabel('Họ và tên').fill(employeeName);
  await form.getByTestId('hr-add-department').selectOption({ label: `${salesDeptName} (${salesDeptCode})` });
  await form.getByTestId('hr-add-job-title').fill(jobTitle);
  await form.locator('#hr-add-from').fill(hireDate);
  await form.getByLabel('Lương cơ bản (đ/tháng)').fill(baseWage);
  await page.getByTestId('hr-employee-save').click();

  const salesRow = deptCard.getByTestId('hr-department-row').filter({ hasText: salesDeptName });
  await expect(salesRow.getByTestId('hr-department-headcount')).toHaveText('1');
  await expect(salesRow.getByTestId('hr-department-wage-total')).toContainText(formattedWage);

  const ownerToken = await requireAccessToken(page);
  const deptsRes = await postRpc(page.request, 'hr/departments/list', ownerToken, slug, { includeArchived: false });
  expect(deptsRes.status).toBe(200);
  const deptList = ((deptsRes.json as { json?: Array<{ id: string; name: string }> })?.json ?? []);
  const salesDeptId = deptList.find((d) => d.name === salesDeptName)?.id ?? '';
  expect(salesDeptId).not.toBe('');

  // Invite a second user as org `member` and assign `Kế toán trưởng`.
  const memberEmail = newEmail('hr-dept-member');
  await page.goto(`/o/${slug}/settings/members`);
  await page.getByRole('button', { name: 'Mời thành viên' }).click();
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

    const memberToken = await requireAccessToken(memberPage);
    const orgCheck = await postRpc(memberPage.request, 'org/get', memberToken, slug, undefined);
    expect(orgCheck.status).toBe(200);
    expect((orgCheck.json as { json?: { role?: string } })?.json?.role).toBe('member');

    const journalCheck = await postRpc(memberPage.request, 'journal/list', memberToken, slug, {});
    expect(journalCheck.status).toBe(200);

    await memberPage.goto(`/o/${slug}/overview`);
    const nav = memberPage.getByRole('navigation');
    const hrNavLink = nav.getByRole('link', { name: 'Nhân sự', exact: true });
    await expect(hrNavLink).toHaveAttribute('href', `/o/${slug}/hr/my`);
    for (const adminPath of ['/hr/employees', '/hr/recruiting', '/hr/payroll', '/hr/declarations']) {
      await expect(nav.locator(`a[href*="${adminPath}"]`)).toHaveCount(0);
    }

    await test.step('all 4 department RPCs return 403 FORBIDDEN for member + Kế toán trưởng', async () => {
      const departmentRpcs: Array<[string, unknown]> = [
        ['hr/departments/list', { includeArchived: true }],
        ['hr/departments/add', { name: 'Phòng Trái Phép', payFunction: 'admin' }],
        ['hr/departments/edit', { departmentId: salesDeptId, name: 'Đổi Tên Trái Phép' }],
        ['hr/departments/archive', { departmentId: salesDeptId }],
      ];

      for (const [rpcPath, input] of departmentRpcs) {
        const res = await postRpc(memberPage.request, rpcPath, memberToken, slug, input);
        expect(res.status, `${rpcPath} should return 403 (got ${res.status}: ${res.text})`).toBe(403);
        expect(errorCodeOf(res.json), `${rpcPath} error code`).toBe('FORBIDDEN');
        expect(res.text).not.toContain(salesDeptName);
        expect(res.text).not.toContain(techDeptName);
        expect(res.text).not.toContain(salesDeptCode);
        expect(res.text).not.toContain(techDeptCode);
        expect(res.text).not.toContain(employeeName);
        expect(res.text).not.toContain(jobTitle);
        expect(res.text).not.toContain(baseWage);
        expect(res.text).not.toContain(formattedWage);
      }
    });

    await test.step('/o/$slug/hr/employees hides all department rows, names, and activeBaseWageTotal figures behind FORBIDDEN alerts', async () => {
      await memberPage.goto(`/o/${slug}/hr/employees`);
      const memberDeptCard = memberPage.getByTestId('hr-departments-card');
      await expect(memberDeptCard).toBeVisible();
      await expect(memberDeptCard.getByRole('alert')).toBeVisible();
      await expect(memberPage.getByRole('alert')).toHaveCount(2);
      await expect(memberPage.getByTestId('hr-department-row')).toHaveCount(0);
      await expect(memberPage.getByTestId('hr-departments-empty')).toHaveCount(0);
      await expect(memberPage.getByTestId('hr-employee-row')).toHaveCount(0);
      await expect(memberPage.getByTestId('hr-employee-dept-filter').locator('option')).toHaveCount(1);

      const mainText = (await memberPage.locator('main').textContent()) ?? '';
      expect(mainText).not.toContain(salesDeptName);
      expect(mainText).not.toContain(techDeptName);
      expect(mainText).not.toContain(salesDeptCode);
      expect(mainText).not.toContain(techDeptCode);
      expect(mainText).not.toContain(employeeName);
      expect(mainText).not.toContain(jobTitle);
      expect(mainText).not.toContain(baseWage);
      expect(mainText).not.toContain(formattedWage);
    });

    await test.step('global search RPC and Command Palette (Control+k) return empty results for department names and wage figures', async () => {
      for (const q of [salesDeptName, techDeptName, salesDeptCode, jobTitle, baseWage, formattedWage]) {
        const res = await postRpc(memberPage.request, 'search/query', memberToken, slug, { q });
        expect(res.status, `search/query for ${q}`).toBe(200);
        const result = (res.json as { json?: { parties: unknown[]; documents: unknown[]; entries: unknown[] } })?.json;
        expect(result).toEqual({ parties: [], documents: [], entries: [] });
        expect(res.text).not.toContain(salesDeptName);
        expect(res.text).not.toContain(techDeptName);
        expect(res.text).not.toContain(employeeName);
        expect(res.text).not.toContain(jobTitle);
        expect(res.text).not.toContain(baseWage);
        expect(res.text).not.toContain(formattedWage);
      }

      await memberPage.goto(`/o/${slug}/overview`);
      await expect(memberPage.getByRole('navigation')).toBeVisible();
      await memberPage.keyboard.press('Control+k');
      const palette = memberPage.getByRole('dialog', { name: 'Bảng lệnh' });
      await expect(palette).toBeVisible();
      const combobox = palette.getByRole('combobox');

      for (const term of [salesDeptName, techDeptName, baseWage]) {
        await Promise.all([
          memberPage.waitForResponse((response) => response.url().includes('/api/rpc/search/query') && response.status() === 200),
          combobox.fill(term),
        ]);
        await expect(palette.getByRole('status')).toHaveCount(0);
        await expect(palette.getByText('Không tìm thấy kết quả phù hợp.')).toBeVisible();
        await expect(palette).not.toContainText(salesDeptName);
        await expect(palette).not.toContainText(techDeptName);
        await expect(palette).not.toContainText(formattedWage);
        await expect(palette).not.toContainText(employeeName);
        await expect(palette).not.toContainText(jobTitle);
      }

      await memberPage.keyboard.press('Escape');
    });
  } finally {
    await memberContext.close();
  }
});

// SPDX-License-Identifier: AGPL-3.0-only
// Stage 3b HR recruiting workflow (#3425), calendar interview, 1-click hire, Ly brief, PDPL erasure,
// and Phase 7 non-admin recruiting and wage isolation E2E (#3459).
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser, storedSession } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';
import { openSettingsTab } from '../lib/settings.ts';

function vietnamToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

async function enrollTotp(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  if (!secret) throw new Error('Expected non-empty TOTP setup key');
  const { code } = await nextTotp(secret);
  await page.getByLabel('Mã xác thực').fill(code);
  await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
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

test('Stage 3b recruiting owner workflow, calendar interview, 1-click hire, Ly brief, and PDPL erasure complete with AI off', async ({ page }) => {
  const today = vietnamToday();
  const openingTitle = 'Kế toán tổng hợp';
  const openingDepartmentName = 'Phòng Kế toán';
  const hireCandidateName = 'Nguyễn Minh Thư';
  const hireCandidateEmail = 'thu.nguyen@example.com';
  const hireCandidatePhone = '0901234567';
  const expectedWage = '18000000';
  const formattedExpectedWage = '18.000.000';
  const agreedWage = '19500000';
  const formattedAgreedWage = '19.500.000';

  const rejectCandidateName = 'Phạm Hoàng Long';
  const rejectCandidateEmail = 'long.pham@example.com';
  const rejectCandidatePhone = '0912345678';
  const rejectCandidateNotes = 'Ứng viên cần xóa dữ liệu cá nhân theo PDPL.';

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');
  await signInNewUser(page, newEmail('hr-rec-owner'));
  const slug = await createOrg(page, 'Công ty Tuyển Dụng Giai Đoạn 3b');

  await test.step('zero-setup SME default allows adding a candidate before creating any openings or departments', async () => {
    await page.goto(`/o/${slug}/hr/recruiting`);
    await expect(page.getByText('Chưa có vị trí tuyển dụng nào')).toBeVisible();
    await expect(page.getByText('Chưa có ứng viên nào')).toBeVisible();

    await page.getByTestId('hr-candidate-new').click();
    const form = page.getByTestId('hr-candidate-form');
    await expect(form).toBeVisible();
    await expect(form.locator('#hr-cand-opening')).toHaveValue('');
    await expect(form.locator('#hr-cand-opening option')).toHaveCount(1);

    await form.getByTestId('hr-candidate-name').fill(hireCandidateName);
    await form.locator('#hr-cand-email').fill(hireCandidateEmail);
    await form.locator('#hr-cand-phone').fill(hireCandidatePhone);
    await form.locator('#hr-cand-exp').fill('4');
    await form.locator('#hr-cand-expected').fill(expectedWage);
    await form.locator('#hr-cand-skills').fill('MISA, Excel');
    await form.locator('#hr-cand-notes').fill('Kinh nghiệm làm báo cáo tài chính và thuế GTGT.');
    await form.getByTestId('hr-candidate-save').click();
    await expect(form).toHaveCount(0);

    const row = page.getByTestId('hr-candidate-row').filter({ hasText: hireCandidateName });
    await expect(row).toBeVisible();
    await expect(row.locator('td').nth(1)).toHaveText('-');
    await expect(row).toContainText('Mới nộp');
    await expect(row).toContainText(formattedExpectedWage);
  });

  await test.step('owner creates a fixed-term job opening, links the candidate, and advances through screening and interview', async () => {
    await page.getByTestId('hr-opening-new').click();
    const openingForm = page.getByTestId('hr-opening-form');
    await expect(openingForm).toBeVisible();
    await openingForm.getByTestId('hr-opening-title').fill(openingTitle);
    await openingForm.locator('#hr-open-dept-name').fill(openingDepartmentName);
    await openingForm.locator('#hr-open-contract').selectOption('fixed_term');
    await openingForm.locator('#hr-open-region').selectOption('II');
    await openingForm.locator('#hr-open-payfn').selectOption('admin');
    await openingForm.locator('#hr-open-min').fill('15000000');
    await openingForm.locator('#hr-open-max').fill('22000000');
    await openingForm.locator('#hr-open-skills').fill('MISA, Excel, Thuế GTGT');
    await openingForm.getByTestId('hr-opening-save').click();
    await expect(openingForm).toHaveCount(0);

    const openingRow = page.getByTestId('hr-opening-row').filter({ hasText: openingTitle });
    await expect(openingRow).toBeVisible();
    await expect(openingRow).toContainText(openingDepartmentName);
    await expect(openingRow).toContainText('15.000.000');
    await expect(openingRow).toContainText('22.000.000');

    const candRow = page.getByTestId('hr-candidate-row').filter({ hasText: hireCandidateName });
    await candRow.getByTestId('hr-candidate-open').click();
    const detail = page.getByTestId('hr-candidate-detail');
    await expect(detail).toBeVisible();

    await detail.getByRole('button', { name: 'Sửa', exact: true }).click();
    const editForm = detail.getByTestId('hr-candidate-form');
    await editForm.locator('#hr-cand-opening').selectOption({ label: openingTitle });
    await editForm.getByTestId('hr-candidate-save').click();
    await expect(editForm).toHaveCount(0);

    await expect(detail).toContainText(openingTitle);
    await expect(candRow.locator('td').nth(1)).toHaveText(openingTitle);
    await expect(openingRow.locator('td').nth(3)).toHaveText('1');

    await detail.getByTestId('hr-stage-screening').click();
    await expect(candRow).toContainText('Sàng lọc');
    await expect(detail.getByTestId('hr-stage-screening')).toHaveCount(0);

    await detail.getByTestId('hr-stage-interview').click();
    await expect(candRow).toContainText('Phỏng vấn');
    await expect(detail.getByTestId('hr-stage-interview')).toHaveCount(0);
  });

  await test.step('owner schedules a calendar interview without candidate PII in the calendar event title', async () => {
    const detail = page.getByTestId('hr-candidate-detail');
    const interviewPanel = detail.getByTestId('hr-interview-panel');
    await expect(interviewPanel).toContainText('Chưa có lịch phỏng vấn.');

    await interviewPanel.getByTestId('hr-interview-toggle').click();
    const firstSlot = interviewPanel.getByTestId('hr-interview-slot').first();
    await expect(firstSlot).toBeVisible();
    await firstSlot.click();

    await expect(interviewPanel).toContainText('Đã đặt lịch vào');
    await expect(interviewPanel).not.toContainText('Chưa có lịch phỏng vấn.');
    const candRow = page.getByTestId('hr-candidate-row').filter({ hasText: hireCandidateName });
    await expect(candRow.locator('td').nth(4)).not.toHaveText('-');

    const ownerToken = await requireAccessToken(page);
    const candListRes = await postRpc(page.request, 'hr/recruiting/candidates/list', ownerToken, slug, { limit: 20 });
    expect(candListRes.status).toBe(200);
    const candidates = (candListRes.json as { json?: Array<{ id: string; displayName: string; interviewEventId: string | null }> })?.json ?? [];
    const candidate = candidates.find((c) => c.displayName === hireCandidateName);
    expect(candidate?.interviewEventId).toBeTruthy();

    const calRes = await postRpc(page.request, 'calendar/get', ownerToken, slug, {
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 21 * 86_400_000).toISOString(),
    });
    expect(calRes.status).toBe(200);
    const calEvents = (calRes.json as { json?: { events?: Array<{ id: string; title: string | null; kind: string }> } })?.json?.events ?? [];
    const interviewEvent = calEvents.find((e) => e.id === candidate?.interviewEventId);
    expect(interviewEvent).toBeDefined();
    expect(interviewEvent?.kind).toBe('manual');
    expect(interviewEvent?.title).toBe(`Phỏng vấn: ${openingTitle}`);

    const serializedEvent = JSON.stringify(interviewEvent);
    expect(serializedEvent).not.toContain(hireCandidateName);
    expect(serializedEvent).not.toContain('Minh Thư');
    expect(serializedEvent).not.toContain(hireCandidateEmail);
    expect(serializedEvent).not.toContain(hireCandidatePhone);
  });

  await test.step('Ly screening brief runs deterministically with AI off without uncaught errors', async () => {
    const detail = page.getByTestId('hr-candidate-detail');
    const lyPanel = detail.getByTestId('hr-recruiting-ly-panel');
    await lyPanel.getByTestId('hr-recruiting-ly-brief').click();

    const lyResult = lyPanel.getByTestId('hr-recruiting-ly-result');
    await expect(lyResult).toBeVisible();
    await expect(lyResult).toContainText('Chưa bật AI; đang hiển thị kiểm tra xác định và câu hỏi gợi ý mặc định.');
    await expect(lyResult).toContainText('Trong khung lương dự kiến');
    await expect(lyResult).toContainText('Kỹ năng khớp: 2/3');
    await expect(lyResult).toContainText('Còn thiếu kỹ năng yêu cầu');
    await expect(lyResult).toContainText('Gợi ý câu hỏi phỏng vấn');
    await expect(lyResult.locator('li').first()).toBeVisible();
    await expect(lyPanel.getByRole('alert')).toHaveCount(0);
  });

  await test.step('owner moves candidate to offer, runs 1-click fixed-term hire, and confirms employee on /hr/employees', async () => {
    const detail = page.getByTestId('hr-candidate-detail');
    const candRow = page.getByTestId('hr-candidate-row').filter({ hasText: hireCandidateName });

    await detail.getByRole('button', { name: 'Sửa', exact: true }).click();
    const editForm = detail.getByTestId('hr-candidate-form');
    await editForm.locator('#hr-cand-agreed').fill(agreedWage);
    await editForm.locator('#hr-cand-start').fill(today);
    await editForm.getByTestId('hr-candidate-save').click();
    await expect(editForm).toHaveCount(0);
    await expect(detail).toContainText(formattedAgreedWage);

    await detail.getByTestId('hr-stage-offer').click();
    await expect(candRow).toContainText('Đề nghị nhận việc');
    await expect(detail.getByTestId('hr-stage-offer')).toHaveCount(0);

    const hirePanel = detail.getByTestId('hr-hire-panel');
    await expect(hirePanel.locator('#hr-hire-wage')).toHaveValue(/^19500000(\.00)?$/);
    await expect(hirePanel.locator('#hr-hire-date')).toHaveValue(today);
    await expect(hirePanel.locator('#hr-hire-title')).toHaveValue(openingTitle);
    await expect(hirePanel.locator('#hr-hire-contract')).toHaveValue('fixed_term');
    await expect(hirePanel.getByTestId('hr-hire-fixed-term-hint')).toBeVisible();
    await expect(hirePanel.getByTestId('hr-candidate-hire')).toBeDisabled();

    await hirePanel.getByTestId('hr-hire-term-months').fill('12');
    await expect(hirePanel.getByTestId('hr-hire-fixed-term-hint')).toHaveCount(0);
    await expect(hirePanel.getByTestId('hr-candidate-hire')).toBeEnabled();
    await hirePanel.getByTestId('hr-candidate-hire').click();

    await expect(detail.getByTestId('hr-hire-done')).toBeVisible();
    await expect(detail.getByTestId('hr-hire-done')).toContainText('Đã tạo hồ sơ nhân viên');
    await expect(candRow).toContainText('Đã nhận việc');

    await page.goto(`/o/${slug}/hr/employees`);
    const empRow = page.getByTestId('hr-employee-row').filter({ hasText: hireCandidateName });
    await expect(empRow).toBeVisible();
    await expect(empRow.getByTestId('hr-employee-dept-cell')).toHaveText(openingTitle);
    await expect(empRow).toContainText('Xác định thời hạn');
    await expect(empRow).toContainText('Vùng II');
    await expect(empRow).toContainText(formattedAgreedWage);

    await empRow.getByTestId('hr-employee-open').click();
    const empDetail = page.getByTestId('hr-employee-detail');
    await expect(empDetail.getByTestId('hr-employee-job-title')).toHaveText(openingTitle);
    const termsRow = empDetail.getByTestId('hr-terms-row').first();
    await expect(termsRow).toContainText('Xác định thời hạn');
    await expect(termsRow).toContainText('12 tháng');
    await expect(termsRow).toContainText('Vùng II');
    await expect(termsRow).toContainText(formattedAgreedWage);
  });

  await test.step('owner adds and rejects a second candidate, enrolls TOTP in StepUpPrompt, and executes PDPL erasure', async () => {
    await page.goto(`/o/${slug}/hr/recruiting`);
    await page.getByTestId('hr-candidate-new').click();
    const form = page.getByTestId('hr-candidate-form');
    await form.getByTestId('hr-candidate-name').fill(rejectCandidateName);
    await form.locator('#hr-cand-opening').selectOption({ label: openingTitle });
    await form.locator('#hr-cand-email').fill(rejectCandidateEmail);
    await form.locator('#hr-cand-phone').fill(rejectCandidatePhone);
    await form.locator('#hr-cand-expected').fill('25000000');
    await form.locator('#hr-cand-notes').fill(rejectCandidateNotes);
    await form.getByTestId('hr-candidate-save').click();
    await expect(form).toHaveCount(0);

    const rejectRow = page.getByTestId('hr-candidate-row').filter({ hasText: rejectCandidateName });
    await expect(rejectRow).toBeVisible();
    await rejectRow.getByTestId('hr-candidate-open').click();

    const detail = page.getByTestId('hr-candidate-detail');
    await expect(detail.getByTestId('hr-candidate-erase-panel')).toHaveCount(0);

    await detail.getByTestId('hr-stage-rejected').click();
    await expect(rejectRow).toContainText('Từ chối');

    const erasePanel = detail.getByTestId('hr-candidate-erase-panel');
    await expect(erasePanel).toBeVisible();
    await erasePanel.getByTestId('hr-candidate-erase-ask').click();
    await erasePanel.getByTestId('hr-candidate-erase-confirm').click();

    await enrollTotp(page);

    await expect(detail).toContainText('Thông tin cá nhân của ứng viên này đã được xóa lúc');
    await expect(detail).toContainText('Đã xóa theo yêu cầu');
    await expect(detail).not.toContainText(rejectCandidateName);
    await expect(detail).not.toContainText(rejectCandidateEmail);
    await expect(detail).not.toContainText(rejectCandidatePhone);
    await expect(detail).not.toContainText(rejectCandidateNotes);

    const erasedRow = page.getByTestId('hr-candidate-row').filter({ hasText: 'Đã xóa theo yêu cầu' });
    await expect(erasedRow).toBeVisible();
    await expect(erasedRow).toContainText('Từ chối');
    await expect(page.getByTestId('hr-candidate-row').filter({ hasText: rejectCandidateName })).toHaveCount(0);

    const ownerToken = await requireAccessToken(page);
    const listRes = await postRpc(page.request, 'hr/recruiting/candidates/list', ownerToken, slug, { stage: 'rejected', limit: 20 });
    expect(listRes.status).toBe(200);
    const rejectedList =
      (listRes.json as { json?: Array<{ id: string; displayName: string; email: string | null; phone: string | null; notes: string | null; erasedAt: string | null }> })?.json ?? [];
    const erasedView = rejectedList.find((c) => c.displayName === 'Đã xóa theo yêu cầu');
    expect(erasedView).toBeDefined();
    expect(erasedView?.email).toBeNull();
    expect(erasedView?.phone).toBeNull();
    expect(erasedView?.notes).toBeNull();
    expect(erasedView?.erasedAt).not.toBeNull();
  });

  expect(pageErrors).toEqual([]);
});

test('Phase 7 non-admin (member + Kế toán trưởng) recruiting and wage isolation holds across RPCs, UI, and global search', async ({ page, browser }) => {
  const today = vietnamToday();
  const openingTitle = 'Kế toán Thuế Cách Ly';
  const budgetMinWage = '16500000';
  const formattedMinWage = '16.500.000';
  const budgetMaxWage = '23500000';
  const formattedMaxWage = '23.500.000';

  const candidateName = 'Võ Minh Cách Ly';
  const candidateEmail = 'cachly.candidate@example.com';
  const candidatePhone = '0987654321';
  const expectedWage = '19250000';
  const formattedExpectedWage = '19.250.000';
  const agreedWage = '20500000';
  const formattedAgreedWage = '20.500.000';
  const candidateNotes = 'Ghi chú lương thỏa thuận bí mật của ứng viên.';

  await page.goto('/');
  await signInNewUser(page, newEmail('hr-rec-iso-owner'));
  const slug = await createOrg(page, 'Công ty Cách Ly Tuyển Dụng');

  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
  await openSettingsTab(page, 'security');
  await enrollTotp(page);
  await expect(page.getByText('Đang bật')).toBeVisible();

  await page.goto(`/o/${slug}/hr/recruiting`);
  await page.getByTestId('hr-opening-new').click();
  const openingForm = page.getByTestId('hr-opening-form');
  await openingForm.getByTestId('hr-opening-title').fill(openingTitle);
  await openingForm.locator('#hr-open-min').fill(budgetMinWage);
  await openingForm.locator('#hr-open-max').fill(budgetMaxWage);
  await openingForm.locator('#hr-open-skills').fill('MISA, Quyết toán thuế');
  await openingForm.getByTestId('hr-opening-save').click();
  await expect(page.getByTestId('hr-opening-row').filter({ hasText: openingTitle })).toBeVisible();

  await page.getByTestId('hr-candidate-new').click();
  const candForm = page.getByTestId('hr-candidate-form');
  await candForm.getByTestId('hr-candidate-name').fill(candidateName);
  await candForm.locator('#hr-cand-opening').selectOption({ label: openingTitle });
  await candForm.locator('#hr-cand-email').fill(candidateEmail);
  await candForm.locator('#hr-cand-phone').fill(candidatePhone);
  await candForm.locator('#hr-cand-expected').fill(expectedWage);
  await candForm.locator('#hr-cand-agreed').fill(agreedWage);
  await candForm.locator('#hr-cand-start').fill(today);
  await candForm.locator('#hr-cand-notes').fill(candidateNotes);
  await candForm.getByTestId('hr-candidate-save').click();
  await expect(page.getByTestId('hr-candidate-row').filter({ hasText: candidateName })).toBeVisible();

  const ownerToken = await requireAccessToken(page);
  const openingsRes = await postRpc(page.request, 'hr/recruiting/openings/list', ownerToken, slug, { status: 'all', limit: 20 });
  expect(openingsRes.status).toBe(200);
  const openingId = ((openingsRes.json as { json?: Array<{ id: string; title: string }> })?.json ?? []).find((o) => o.title === openingTitle)?.id ?? '';
  expect(openingId).not.toBe('');

  const candsRes = await postRpc(page.request, 'hr/recruiting/candidates/list', ownerToken, slug, { limit: 20 });
  expect(candsRes.status).toBe(200);
  const candidateId = ((candsRes.json as { json?: Array<{ id: string; displayName: string }> })?.json ?? []).find((c) => c.displayName === candidateName)?.id ?? '';
  expect(candidateId).not.toBe('');

  const slotsRes = await postRpc(page.request, 'hr/recruiting/interviewSlots', ownerToken, slug, { durationMinutes: 45, maxSlots: 4 });
  expect(slotsRes.status).toBe(200);
  const firstSlot = ((slotsRes.json as { json?: { slots?: Array<{ startIso: string; endIso: string }> } })?.json?.slots ?? [])[0];
  expect(firstSlot).toBeDefined();

  // Invite a second user as org `member` and assign `Kế toán trưởng`.
  const memberEmail = newEmail('hr-rec-member');
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

    // Enroll TOTP on the member session so R3 erase refusal proves RBAC FORBIDDEN rather than missing step-up.
    await memberPage.goto(`/o/${slug}/settings/security`);
    await enrollTotp(memberPage);
    await expect(memberPage.getByText('Đang bật')).toBeVisible();

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
    await expect(nav.getByText('Tuyển dụng', { exact: true })).toHaveCount(0);

    const sensitiveStrings = [
      openingTitle,
      candidateName,
      candidateEmail,
      candidatePhone,
      candidateNotes,
      budgetMinWage,
      formattedMinWage,
      budgetMaxWage,
      formattedMaxWage,
      expectedWage,
      formattedExpectedWage,
      agreedWage,
      formattedAgreedWage,
    ];

    await test.step('all recruiting RPCs (including Ly brief with AI off) return 403 FORBIDDEN with zero leaks', async () => {
      const recruitingRpcs: Array<[string, unknown]> = [
        ['hr/recruiting/openings/list', { status: 'all', limit: 20 }],
        ['hr/recruiting/openings/add', { title: 'Vị trí trái phép', contractType: 'indefinite', region: 'I', payFunction: 'admin', requiredSkills: [] }],
        ['hr/recruiting/openings/edit', { openingId, title: 'Đổi tên trái phép' }],
        ['hr/recruiting/openings/close', { openingId, reopen: false }],
        ['hr/recruiting/candidates/list', { limit: 20 }],
        ['hr/recruiting/candidates/get', { candidateId }],
        ['hr/recruiting/candidates/add', { openingId, displayName: 'Ứng viên trái phép' }],
        ['hr/recruiting/candidates/edit', { candidateId, notes: 'Sửa trái phép' }],
        ['hr/recruiting/candidates/moveStage', { candidateId, toStage: 'screening' }],
        ['hr/recruiting/candidates/scheduleInterview', { candidateId, startsAt: firstSlot!.startIso, endsAt: firstSlot!.endIso }],
        ['hr/recruiting/candidates/hire', { candidateId, effectiveFrom: today, baseWage: '15000000', allowDirectHire: true }],
        ['hr/recruiting/candidates/erase', { candidateId }],
        ['hr/recruiting/interviewSlots', { durationMinutes: 45, maxSlots: 5 }],
        ['hr/recruiting/brief', { candidateId, lang: 'vi' }],
      ];

      for (const [rpcPath, input] of recruitingRpcs) {
        const res = await postRpc(memberPage.request, rpcPath, memberToken, slug, input);
        expect(res.status, `${rpcPath} should return 403 (got ${res.status}: ${res.text})`).toBe(403);
        expect(errorCodeOf(res.json), `${rpcPath} error code`).toBe('FORBIDDEN');
        for (const secretText of sensitiveStrings) {
          expect(res.text).not.toContain(secretText);
        }
      }
    });

    await test.step('/o/$slug/hr/recruiting renders 403 FORBIDDEN alerts with zero rows and zero wage figures', async () => {
      const openingsWait = memberPage.waitForResponse((response) => response.url().includes('/api/rpc/hr/recruiting/openings/list'));
      const candidatesWait = memberPage.waitForResponse((response) => response.url().includes('/api/rpc/hr/recruiting/candidates/list'));
      await memberPage.goto(`/o/${slug}/hr/recruiting`);
      expect((await openingsWait).status()).toBe(403);
      expect((await candidatesWait).status()).toBe(403);

      await expect(memberPage.getByRole('alert')).toHaveCount(2);
      await expect(memberPage.getByRole('alert').nth(0)).toBeVisible();
      await expect(memberPage.getByRole('alert').nth(1)).toBeVisible();
      await expect(memberPage.getByTestId('hr-opening-row')).toHaveCount(0);
      await expect(memberPage.getByTestId('hr-candidate-row')).toHaveCount(0);

      const mainText = (await memberPage.locator('main').textContent()) ?? '';
      for (const secretText of sensitiveStrings) {
        expect(mainText).not.toContain(secretText);
      }
    });

    await test.step('search/query RPC and Command Palette (Control+k) return empty results for recruiting data', async () => {
      for (const q of [openingTitle, candidateName, 'Cách Ly', candidateEmail, candidatePhone, budgetMinWage, budgetMaxWage, expectedWage, agreedWage, formattedAgreedWage]) {
        const res = await postRpc(memberPage.request, 'search/query', memberToken, slug, { q });
        expect(res.status, `search/query for ${q}`).toBe(200);
        const result = (res.json as { json?: { parties: unknown[]; documents: unknown[]; entries: unknown[] } })?.json;
        expect(result).toEqual({ parties: [], documents: [], entries: [] });
        for (const secretText of sensitiveStrings) {
          expect(res.text).not.toContain(secretText);
        }
      }

      await memberPage.goto(`/o/${slug}/overview`);
      await expect(memberPage.getByRole('navigation')).toBeVisible();
      await memberPage.keyboard.press('Control+k');
      const palette = memberPage.getByRole('dialog', { name: 'Bảng lệnh' });
      await expect(palette).toBeVisible();
      const combobox = palette.getByRole('combobox');

      for (const term of [openingTitle, candidateName, candidateEmail, candidatePhone, agreedWage]) {
        await Promise.all([
          memberPage.waitForResponse((response) => response.url().includes('/api/rpc/search/query') && response.status() === 200),
          combobox.fill(term),
        ]);
        await expect(palette.getByRole('status')).toHaveCount(0);
        await expect(palette.getByText('Không tìm thấy kết quả phù hợp.')).toBeVisible();
        for (const secretText of sensitiveStrings) {
          expect(await palette.textContent()).not.toContain(secretText);
        }
      }

      await memberPage.keyboard.press('Escape');
    });
  } finally {
    await memberContext.close();
  }
});

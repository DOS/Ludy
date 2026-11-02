// SPDX-License-Identifier: AGPL-3.0-only
// The next steps of stale deals end to end (#2381, docs/plan/crm.md): a member's deals that nobody touched show the "Cần theo dõi" badge and a
// "Việc tiếp theo" list; done and snooze are one click each, and a bulk of picked rows is one action; an owner sets the days. The daily rule runs in the
// worker at 04:00 and is tested against the database (apps/kernel/test/crm-stale-deals.db.test.ts), so the steps it would raise are written here as
// the stack's database owner, the way the deals board spec writes its contacts.
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('stale deals show a badge and a next steps list, done and snooze are one click, a bulk is one action, and the owner sets the days', async ({ page }) => {
  const email = newEmail('next-steps');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Theo Dõi');
  exec(`INSERT INTO crove_kernel.party (org_id, name, kind) SELECT org_id, 'Khách hàng ABC', 'organization' FROM crove_kernel.tenant WHERE slug = :'slug'`, { slug });

  await page.getByRole('navigation').getByRole('link', { name: 'CRM', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Cơ hội' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/deals$`));

  const titles = ['Gói kế toán năm', 'Tư vấn thuế', 'Báo cáo tài chính', 'Quyết toán cuối năm'];
  await test.step('adds four deals', async () => {
    for (const title of titles) {
      await page.getByRole('button', { name: 'Thêm cơ hội' }).click();
      const form = page.getByRole('form', { name: 'Thêm cơ hội' });
      await form.getByLabel('Tên cơ hội').fill(title);
      await form.getByRole('searchbox', { name: 'Khách hàng' }).fill('ABC');
      await page.getByRole('button', { name: 'Khách hàng ABC' }).click();
      await form.getByLabel('Số tiền (VND)').fill('5000000');
      await form.getByRole('button', { name: 'Thêm', exact: true }).click();
      await expect(page.getByTestId('deal-card').filter({ hasText: title })).toBeVisible();
    }
    // None is stale yet: no badge, and no number on the tab.
    await expect(page.getByTestId('follow-up-badge')).toHaveCount(0);
    await expect(page.getByTestId('next-steps-tab')).toHaveText('Việc tiếp theo');
  });

  await test.step('the steps the daily rule raises show as a badge on the cards and as a count on the tab', async () => {
    exec(
      `INSERT INTO crove_crm.deal_next_step (org_id, deal_id, reason, assignee_user_id, since_on)
       SELECT d.org_id, d.id, 'no_activity', d.owner_user_id, current_date - 20 FROM crove_crm.deal d JOIN crove_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug'`,
      { slug },
    );
    await page.reload();
    await expect(page.getByTestId('follow-up-badge')).toHaveCount(4);
    await expect(page.getByTestId('deal-card').filter({ hasText: 'Tư vấn thuế' }).getByTestId('follow-up-badge')).toHaveText('Cần theo dõi');
    await expect(page.getByTestId('next-steps-tab')).toHaveText('Việc tiếp theo (4)');
  });

  await test.step('the list is mine by default; done is one click', async () => {
    await page.getByTestId('next-steps-tab').click();
    const steps = page.getByTestId('next-step');
    await expect(steps).toHaveCount(4);
    await expect(steps.first()).toContainText('Lâu chưa có thay đổi');
    await expect(steps.first()).toContainText('Thy nhắc: cơ hội này chưa có thay đổi từ ngày');
    await page.getByRole('button', { name: 'Đánh dấu xong việc của cơ hội Tư vấn thuế' }).click();
    await expect(steps).toHaveCount(3);
    await expect(page.getByRole('status').filter({ hasText: 'Đã đánh dấu xong 1 việc.' })).toBeVisible();
    await expect(page.getByTestId('next-steps-tab')).toHaveText('Việc tiếp theo (3)');
  });

  await test.step('snooze is one click and hides the step', async () => {
    await page.getByRole('button', { name: 'Hoãn việc của cơ hội Báo cáo tài chính 7 ngày' }).click();
    await expect(page.getByTestId('next-step')).toHaveCount(2);
    await expect(page.getByRole('status').filter({ hasText: 'Đã hoãn 1 việc.' })).toBeVisible();
    // The badge follows: the snoozed and the done deals show none.
    await page.getByRole('tab', { name: 'Bảng' }).click();
    await expect(page.getByTestId('follow-up-badge')).toHaveCount(2);
    await expect(page.getByTestId('deal-card').filter({ hasText: 'Báo cáo tài chính' }).getByTestId('follow-up-badge')).toHaveCount(0);
  });

  await test.step('a bulk of picked rows is one action', async () => {
    await page.getByTestId('next-steps-tab').click();
    await page.getByRole('button', { name: 'Chọn tối đa 20 việc đầu' }).click();
    await expect(page.getByText('Đã chọn 2')).toBeVisible();
    await page.getByRole('button', { name: 'Xong cả 2 việc' }).click();
    await expect(page.getByTestId('next-step')).toHaveCount(0);
    await expect(page.getByText('Không có việc tiếp theo nào.')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Đã đánh dấu xong 2 việc.' })).toBeVisible();
    // One audit row for the two, ids only.
    const audits = sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM crove_kernel.audit_event a JOIN crove_kernel.tenant t ON t.org_id = a.org_id WHERE t.slug = :'slug' AND a.command = 'crm.next_step.done' AND jsonb_array_length(a.detail -> 'nextStepIds') = 2`,
      { slug },
    );
    expect(audits).toEqual([{ n: 1 }]);
    const stored = sql<{ status: string; n: number }>(
      `SELECT n.status, count(*)::int AS n FROM crove_crm.deal_next_step n JOIN crove_kernel.tenant t ON t.org_id = n.org_id WHERE t.slug = :'slug' GROUP BY n.status ORDER BY n.status`,
      { slug },
    );
    expect(stored).toEqual([{ status: 'done', n: 3 }, { status: 'open', n: 1 }]);
  });

  await test.step('the owner sets the days, within 7 to 60', async () => {
    await page.getByRole('button', { name: 'Giai đoạn' }).click();
    const setting = page.getByTestId('stale-setting');
    await expect(setting.getByLabel('Số ngày')).toHaveValue('14');
    await setting.getByLabel('Số ngày').fill('5');
    await expect(setting.getByText('Nhập số ngày từ 7 đến 60.')).toBeVisible();
    await expect(setting.getByRole('button', { name: 'Lưu' })).toBeDisabled();
    await setting.getByLabel('Số ngày').fill('30');
    await setting.getByRole('button', { name: 'Lưu' }).click();
    await expect(setting.getByText('Đã lưu.')).toBeVisible();
    const stored = sql<{ stale_days: number }>(`SELECT s.stale_days FROM crove_crm.deal_setting s JOIN crove_kernel.tenant t ON t.org_id = s.org_id WHERE t.slug = :'slug'`, { slug });
    expect(stored).toEqual([{ stale_days: 30 }]);
  });
});

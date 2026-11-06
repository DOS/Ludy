// SPDX-License-Identifier: AGPL-3.0-only
// The campaign builder end to end (W1c, #2295, plan docs/plan/ads-write.md section 10), on the offline sandbox ad platform: an owner starts from a Social post,
// the builder pre-fills from it, the daily budget and the dates make the largest amount the plan can spend (one sentence), saving checks the plan against the
// spend caps and the switches of running ads and lists what is to fix in words, asking for approval is held back until nothing is to fix, and a draft can be
// discarded. This stack has no AI endpoint, so the panel that asks the AI coworker for a draft is not offered (the core works with AI off). Nothing here
// calls an ad platform: the plan stays in Ludy.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// A day `offset` days from now, as the date fields read it (dd/mm/yyyy). A few days ahead, so the account's own time zone never makes it a past day.
function day(offset: number): string {
  const d = new Date(Date.now() + offset * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

test('an owner starts a campaign from a post, sees the most it can spend, and what is still to fix before it can be approved', async ({ page }) => {
  test.setTimeout(420_000);
  await signInNewUser(page, newEmail('ads-campaigns'));
  const slug = await createOrg(page, 'Công ty Chiến dịch');
  const nav = page.getByRole('navigation');
  const builder = page.getByTestId('campaign-builder');
  let postId = '';

  await test.step('a Social post to start from', async () => {
    await nav.getByRole('link', { name: 'Engage' }).click();
    await nav.getByRole('link', { name: 'Bài đăng', exact: true }).click();
    await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
    await page.getByLabel('Tên kênh thử').fill('Trang Chiến dịch');
    await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
    await expect(page.getByText('Trang Chiến dịch').first()).toBeVisible();
    await page.getByRole('link', { name: 'Quay lại' }).click();
    await page.getByRole('link', { name: 'Soạn bài' }).click();
    await page.getByLabel('Nội dung chung').fill('Khai trương chi nhánh mới vào thứ Bảy này. Mời bạn ghé thử cà phê mới.');
    await page.getByRole('button', { name: 'Lưu nháp' }).click();
    await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
    postId = page.url().split('/').pop() ?? '';
  });

  await test.step('Campaigns is an item of the Marketing group, and with no ad account it says to connect one first', async () => {
    await nav.getByRole('link', { name: 'Engage' }).click();
    const group = nav.getByRole('region', { name: 'Marketing' });
    await expect(group).toBeVisible();
    await group.getByRole('link', { name: 'Chiến dịch', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/ads/campaigns$`));
    await expect(page.getByRole('heading', { name: 'Chiến dịch', level: 1 })).toBeVisible();
    await expect(page.getByText('Hãy kết nối một tài khoản quảng cáo ở màn Quảng cáo trước.')).toBeVisible();
    await page.getByRole('link', { name: 'Mở màn Quảng cáo' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/ads$`));
  });

  await test.step('connect a test ad account in dong and wait for its first read (the plan needs its currency)', async () => {
    const form = page.getByRole('form', { name: 'Kết nối tài khoản quảng cáo thử' });
    await form.getByLabel('Tên tài khoản quảng cáo').fill('Quảng cáo chiến dịch E2E');
    await form.getByLabel('Đơn vị tiền').selectOption('VND');
    await form.getByRole('button', { name: 'Kết nối tài khoản thử' }).click();
    await expect(page.getByText('Tiền tệ VND, múi giờ Asia/Ho_Chi_Minh')).toBeVisible({ timeout: 90_000 });
  });

  await test.step('the builder is there with the account, and without AI no request panel is offered', async () => {
    await page.goto(`/o/${slug}/ads/campaigns`);
    await expect(builder).toBeVisible();
    await expect(page.getByTestId('campaign-ask')).toHaveCount(0);
    await expect(page.getByText('Hãy lưu bản nháp để kiểm tra với ngày chạy và hạn mức chi tiêu.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('campaign-max-spend')).toHaveText('Hãy đặt ngân sách mỗi ngày và ngày chạy để biết tối đa có thể chi bao nhiêu.');
    await expect(builder.getByRole('button', { name: 'Gửi duyệt' })).toBeDisabled();
  });

  await test.step('"Bắt đầu từ bài đăng" pre-fills the name and the first text from the post', async () => {
    await page.getByRole('button', { name: 'Bắt đầu từ bài đăng' }).click();
    const dialog = page.getByRole('dialog', { name: 'Chọn một bài đăng' });
    await expect(dialog.getByText('Khai trương chi nhánh mới vào thứ Bảy này.', { exact: false }).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Dùng bài này' }).first().click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('campaign-post-based')).toContainText('Bắt đầu từ bài đăng');
    await expect(page.getByLabel('Tên chiến dịch')).toHaveValue(/Khai trương chi nhánh mới/);
    await expect(builder.getByLabel('Nội dung', { exact: true })).toHaveValue(/Mời bạn ghé thử cà phê mới/);
  });

  await test.step('the daily budget and the dates give the most it can spend, in one sentence', async () => {
    await builder.getByLabel('Ngân sách mỗi ngày', { exact: true }).fill('100000');
    await builder.getByLabel('Bắt đầu', { exact: true }).fill(day(3));
    await builder.getByLabel('Kết thúc', { exact: true }).fill(day(9));
    const sentence = page.getByTestId('campaign-max-spend');
    await expect(sentence).toContainText('Tối đa có thể chi');
    await expect(sentence).toContainText(/700[.,\s ]?000/);
    await expect(sentence).toContainText('trong 7 ngày');
    await expect(sentence).toContainText(/mỗi ngày [^.]*100[.,\s ]?000/);
  });

  await test.step('a format problem sits under its field and nothing is saved', async () => {
    await builder.getByLabel('Trang mà quảng cáo mở ra').fill('http://khong-an-toan.example');
    await builder.getByRole('button', { name: 'Lưu bản nháp' }).click();
    await expect(builder.getByText('Đường dẫn phải là địa chỉ đầy đủ bắt đầu bằng https://.')).toBeVisible();
    expect(sql<{ n: number }>(`SELECT count(*)::int AS n FROM crove_ads.ad_campaign_draft d JOIN crove_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug'`, { slug })).toEqual([{ n: 0 }]);
  });

  await test.step('saving keeps the draft and lists what is to fix in words: no spend cap yet and running ads off', async () => {
    await builder.getByLabel('Trang mà quảng cáo mở ra').fill('https://example.com/khai-truong');
    await builder.getByRole('button', { name: 'Lưu bản nháp' }).click();
    await expect(page.getByText('Đã lưu bản nháp.')).toBeVisible();
    await expect(page).toHaveURL(/\/ads\/campaigns\?draft=[0-9a-f-]{36}/);
    const issues = page.getByTestId('campaign-issues');
    await expect(issues).toContainText('Cần sửa trước khi được duyệt');
    await expect(issues).toContainText('Chưa đặt hạn mức chi tiêu nào.');
    await expect(issues).toContainText('Việc chạy quảng cáo đang tắt cho tổ chức.');
    // Held back until nothing is to fix, and the draft is listed.
    await expect(builder.getByRole('button', { name: 'Gửi duyệt' })).toBeDisabled();
    await expect(page.getByTestId('campaign-drafts').getByText('Khai trương chi nhánh mới', { exact: false })).toBeVisible();
    const rows = sql<{ status: string; origin: string; source_post_id: string | null; budget_ok: boolean; spend_ok: boolean }>(
      `SELECT d.status, d.origin, d.source_post_id::text AS source_post_id, d.daily_budget = 100000 AS budget_ok, d.max_spend = 700000 AS spend_ok
         FROM crove_ads.ad_campaign_draft d JOIN crove_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug'`,
      { slug },
    );
    // The post is kept as an opaque id, and a draft a person wrote is not marked as the AI's.
    expect(rows).toEqual([{ status: 'draft', origin: 'human', source_post_id: postId, budget_ok: true, spend_ok: true }]);
    await expect(builder.getByText(/^Do .+ soạn$/)).toHaveCount(0);
  });

  await test.step('the screen passes an axe scan, at desktop and phone width', async () => {
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(builder).toBeVisible();
      const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
      expect(widths.page, `${width}px: no sideways scroll`).toBeLessThanOrEqual(widths.view);
      const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const serious = scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious.map((v) => `${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`), `${width}px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  await test.step('a draft is discarded after asking, and leaves the list', async () => {
    await builder.getByRole('button', { name: 'Bỏ', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Bỏ bản nháp này?' });
    await dialog.getByRole('button', { name: 'Hủy' }).click();
    await expect(dialog).toHaveCount(0);
    await builder.getByRole('button', { name: 'Bỏ', exact: true }).click();
    await dialog.getByRole('button', { name: 'Bỏ', exact: true }).click();
    await expect(page.getByText('Đã bỏ bản nháp.')).toBeVisible();
    await expect(page.getByTestId('campaign-drafts')).toHaveCount(0);
    const rows = sql<{ status: string }>(`SELECT d.status FROM crove_ads.ad_campaign_draft d JOIN crove_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug'`, { slug });
    expect(rows).toEqual([{ status: 'discarded' }]);
  });
});

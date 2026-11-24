// SPDX-License-Identifier: AGPL-3.0-only
// Boost a published Social post, end to end (ads W3, #3834, plan docs/plan/ads-write.md section 10), on the offline sandbox ad platform: a post published to the test
// channel has no boost action while running ads is off; once an owner has switched it on (set here as the approvals leave it: the guards are lifted for the seeding
// statements only, the approval flow itself is covered by the kernel's tests), the post shows the action, the side panel makes a draft from the post (goal, the most
// to spend, days, audience), the draft says the most it can spend, the owner sends it for approval, and the post shows it waiting. Nothing here calls an ad platform.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// The statements that leave an org as its approved proposals would: running ads on, the test ad account allowed, a daily cap, and a Facebook Page an ad can run as.
// The database's guards hold these tables for signed-in owners and approved executions, so each is lifted for the one statement and put back (always on, as the
// migration sets it), which the stack's superuser may do.
function seedRunningAds(slug: string, writeOn: boolean): void {
  const org = `(SELECT org_id FROM ludy_kernel.tenant WHERE slug = :'slug')`;
  exec(
    `ALTER TABLE ludy_ads.ad_org_setting DISABLE TRIGGER switch_guard;
     INSERT INTO ludy_ads.ad_org_setting (org_id) SELECT ${org} WHERE NOT EXISTS (SELECT 1 FROM ludy_ads.ad_org_setting WHERE org_id = ${org});
     UPDATE ludy_ads.ad_org_setting SET write_enabled = ${writeOn ? 'true' : 'false'}, launches_blocked = false WHERE org_id = ${org};
     ALTER TABLE ludy_ads.ad_org_setting ENABLE ALWAYS TRIGGER switch_guard;
     ALTER TABLE ludy_ads.ad_account DISABLE TRIGGER switch_guard;
     UPDATE ludy_ads.ad_account SET write_enabled = ${writeOn ? 'true' : 'false'} WHERE org_id = ${org};
     ALTER TABLE ludy_ads.ad_account ENABLE ALWAYS TRIGGER switch_guard`,
    { slug },
  );
}

test('an owner boosts a published post: no action while running ads is off, then the panel, the draft with its largest amount, the request for approval and the state on the post', async ({ page }) => {
  test.setTimeout(480_000);
  await signInNewUser(page, newEmail('ads-boost'));
  const slug = await createOrg(page, 'Công ty Quảng bá');
  const nav = page.getByRole('navigation');
  const card = page.getByTestId('boost-card');
  let postUrl = '';
  let postId = '';

  await test.step('a post published to the test channel', async () => {
    await nav.getByRole('link', { name: 'Engage' }).click();
    await nav.getByRole('link', { name: 'Bài đăng', exact: true }).click();
    await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
    await page.getByLabel('Tên kênh thử').fill('Trang Đẩy bài E2E');
    await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
    await expect(page.getByText('Trang Đẩy bài E2E').first()).toBeVisible();
    await page.getByRole('link', { name: 'Về Bài đăng' }).click();
    await page.getByRole('link', { name: 'Soạn bài' }).first().click();
    await page.getByLabel('Nội dung chung').fill('Khai trương chi nhánh mới vào thứ Bảy này. Mời bạn ghé thử cà phê mới.');
    await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
    await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
    await expect(page.getByText('Lên lịch 1 kênh đã duyệt')).toBeVisible();
    await page.getByRole('button', { name: 'Lên lịch', exact: true }).click();
    postUrl = page.url();
    postId = postUrl.split('/').pop() ?? '';
    // Due now, so the worker's sweep publishes it to the sandbox.
    exec(`UPDATE ludy_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = :'post'`, { post: postId });
    await expect(page.getByTestId('published-summary').getByText(/Đã đăng lúc/)).toBeVisible({ timeout: 60_000 });
  });

  await test.step('with no ad account and running ads off, the published post has no boost action at all', async () => {
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Đẩy bài', exact: true })).toHaveCount(0);
  });

  await test.step('a test ad account in dong, read once (the plan needs its currency)', async () => {
    await page.goto(`/o/${slug}/ads`);
    const form = page.getByRole('form', { name: 'Kết nối tài khoản quảng cáo thử' });
    await form.getByLabel('Tên tài khoản quảng cáo').fill('Quảng cáo đẩy bài E2E');
    await form.getByLabel('Đơn vị tiền').selectOption('VND');
    await form.getByRole('button', { name: 'Kết nối tài khoản thử' }).click();
    await expect(page.getByText('Tiền tệ VND, giờ Việt Nam (UTC+7)')).toBeVisible({ timeout: 90_000 });
  });

  await test.step('the account is connected but running ads is still off: still no boost action', async () => {
    await page.goto(postUrl);
    await expect(page.getByTestId('published-summary')).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Đẩy bài', exact: true })).toHaveCount(0);
  });

  await test.step('running ads on as its approvals leave it, with a daily cap and a Page an ad runs as', async () => {
    seedRunningAds(slug, true);
    exec(
      `ALTER TABLE ludy_ads.ad_spend_cap DISABLE TRIGGER cap_guard;
       INSERT INTO ludy_ads.ad_spend_cap (org_id, id, scope, period, amount, currency, set_by)
         SELECT t.org_id, gen_random_uuid(), 'org', 'daily', 200000, 'VND', m.user_id FROM ludy_kernel.tenant t JOIN ludy_kernel.tenant_member m ON m.org_id = t.org_id AND m.role = 'owner' WHERE t.slug = :'slug' LIMIT 1;
       ALTER TABLE ludy_ads.ad_spend_cap ENABLE ALWAYS TRIGGER cap_guard;
       INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by)
         SELECT t.org_id, gen_random_uuid(), 'facebook_page', '1' || lpad((random() * 999999999)::bigint::text, 9, '0'), 'Trang Facebook E2E', m.user_id FROM ludy_kernel.tenant t JOIN ludy_kernel.tenant_member m ON m.org_id = t.org_id AND m.role = 'owner' WHERE t.slug = :'slug' LIMIT 1`,
      { slug },
    );
  });

  await test.step('the post now offers "Đẩy bài" and says what a boost is', async () => {
    await page.goto(postUrl);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole('heading', { name: 'Đẩy bài này' })).toBeVisible();
    await expect(card).toContainText('chủ sở hữu hoặc quản trị viên duyệt số tiền tối đa');
    await expect(page.getByTestId('boost-open')).toBeVisible();
  });

  await test.step('the side panel asks for the goal, the most to spend, the days and the audience, and is accessible', async () => {
    await page.getByTestId('boost-open').click();
    const panel = page.getByRole('dialog', { name: 'Đẩy bài này' });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('Mục tiêu')).toBeVisible();
    await expect(panel.getByLabel('Số tiền tối đa muốn chi')).toBeVisible();
    await expect(panel.getByLabel('Số ngày')).toBeVisible();
    await expect(panel.getByLabel('Ai sẽ thấy')).toBeVisible();
    // The words of the ad come from the post.
    await expect(panel.getByLabel('Nội dung', { exact: true })).toHaveValue(/Mời bạn ghé thử cà phê mới/);
    const scan = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG_TAGS).analyze();
    expect(scan.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  await test.step('a budget that is not an amount sits under its field and nothing is made', async () => {
    const panel = page.getByRole('dialog', { name: 'Đẩy bài này' });
    await panel.getByLabel('Số tiền tối đa muốn chi').fill('abc');
    await panel.getByRole('button', { name: 'Tạo bản nháp' }).click();
    await expect(panel.getByText('Hãy nhập một số tiền lớn hơn 0, tối đa hai chữ số thập phân.')).toBeVisible();
    expect(sql<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_ads.ad_campaign_draft d JOIN ludy_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug'`, { slug })).toEqual([{ n: 0 }]);
  });

  await test.step('the draft says the most it can spend, and nothing is approved or sent', async () => {
    const panel = page.getByRole('dialog', { name: 'Đẩy bài này' });
    // The test channel has no link of its own to open, so the goal is the conversation with the Page; the Page is the one an ad runs as.
    await panel.getByLabel('Mục tiêu').selectOption({ label: 'Nhận tin nhắn' });
    await panel.getByLabel('Số tiền tối đa muốn chi').fill('300000');
    await panel.getByLabel('Số ngày').selectOption({ label: '3 ngày' });
    await panel.getByRole('button', { name: 'Tạo bản nháp' }).click();
    const result = page.getByTestId('boost-result');
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('boost-max-spend')).toContainText(/300[.,\s ]?000/);
    await expect(page.getByTestId('boost-max-spend')).toContainText('trong 3 ngày');
    await expect(page.getByTestId('boost-max-spend')).toContainText(/mỗi ngày [^.]*100[.,\s ]?000/);
    await expect(page.getByTestId('boost-issues')).toHaveCount(0);
    const rows = sql<{ status: string; origin: string; objective: string; source_post_id: string | null; max_spend: string; proposals: number }>(
      `SELECT d.status, d.origin, d.objective, d.source_post_id::text AS source_post_id, d.max_spend::text AS max_spend,
              (SELECT count(*)::int FROM ludy_kernel.proposal p WHERE p.org_id = d.org_id AND p.command = 'ads.campaign.launch') AS proposals
         FROM ludy_ads.ad_campaign_draft d JOIN ludy_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug'`,
      { slug },
    );
    // The post is kept as an opaque id, a person wrote the draft, and no request for approval exists yet.
    expect(rows).toEqual([{ status: 'draft', origin: 'human', objective: 'messenger', source_post_id: postId, max_spend: '300000', proposals: 0 }]);
  });

  await test.step('the owner sends it for approval: the same request any plan makes, waiting in the Inbox', async () => {
    await page.getByTestId('boost-send').click();
    await expect(page.getByTestId('boost-waiting')).toContainText('Đang chờ duyệt trong Hộp thư.');
    await expect(page.getByTestId('boost-waiting').getByRole('link', { name: 'Mở đề xuất trong Hộp thư' })).toBeVisible();
    const proposals = sql<{ kind: string; status: string; amount: string }>(
      `SELECT p.kind, p.status, p.payload ->> 'amount' AS amount FROM ludy_kernel.proposal p JOIN ludy_kernel.tenant t ON t.org_id = p.org_id WHERE t.slug = :'slug' AND p.command = 'ads.campaign.launch'`,
      { slug },
    );
    expect(proposals).toEqual([{ kind: 'ads.campaign_launch', status: 'pending', amount: '300000' }]);
  });

  await test.step('the post shows the boost waiting, with its amount and the way to the request, and offers no second boost', async () => {
    // After the draft the panel is titled by its result ("Bản nháp đẩy bài"), not by the form's title, so the dialog is found as the one open dialog; its footer has the
    // close button (the corner one has the same name). A bounded wait: a locator that matches nothing fails here, not at the test's own limit.
    await page.getByRole('dialog').getByRole('button', { name: 'Đóng', exact: true }).first().click({ timeout: 15_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const state = page.getByTestId('boost-state');
    await expect(state).toHaveAttribute('data-state', 'waiting_approval');
    await expect(state).toContainText('Chờ duyệt');
    await expect(state).toContainText('Tối đa có thể chi');
    await expect(state.getByRole('link', { name: 'Mở đề xuất trong Hộp thư' })).toBeVisible();
    await expect(page.getByTestId('boost-open')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('boost-state')).toHaveAttribute('data-state', 'waiting_approval');
  });

  await test.step('with running ads switched off again the waiting boost is still shown, and there is no way to start another', async () => {
    seedRunningAds(slug, false);
    await page.reload();
    await expect(page.getByTestId('boost-state')).toHaveAttribute('data-state', 'waiting_approval');
    await expect(page.getByTestId('boost-open')).toHaveCount(0);
  });
});

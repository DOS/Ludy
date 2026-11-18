// SPDX-License-Identifier: AGPL-3.0-only
// Managing a running ad end to end (ads W4, #3835, plan docs/plan/ads-write.md), on the offline sandbox ad platform: an owner opens the Campaigns screen on a launch that is
// live and finds the Manage section under its note: the budget and the end date, the objects with their status, the changes asked so far in words (done, could not confirm,
// did not go through and why), and a line that says the platform has not confirmed a raise yet. This stack runs with running ads off (an approval with a second factor turns it
// on, which this spec does not do), so the controls can only pause: it says so in words and offers Pause alone, no budget or schedule form. Pausing the campaign makes a change
// that waits for the platform and is listed at once. The screen passes an axe scan at desktop and phone width.
// The launch is seeded as the superuser (a raw statement outside any context is the table owner's: the guards of the ledger hold what a person's command writes), since a real
// launch needs approvals with a second factor and the launch worker, which the launch's own specs cover.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const CAMPAIGN = 'Chiến dịch quản lý E2E';
const AD_SET = 'Nhóm quảng cáo quản lý E2E';

test('an owner sees a live launch under Manage, reads its changes in words, and pauses the campaign', async ({ page }) => {
  test.setTimeout(420_000);
  await signInNewUser(page, newEmail('ads-manage'));
  const slug = await createOrg(page, 'Công ty Quản lý quảng cáo');
  const draftId = randomUUID();
  const launchId = randomUUID();

  await test.step('connect a test ad account in dong and wait for its first read (the launch needs its currency and time zone)', async () => {
    const nav = page.getByRole('navigation');
    await nav.getByRole('link', { name: 'Engage' }).click();
    await nav.getByRole('region', { name: 'Marketing' }).getByRole('link', { name: 'Quảng cáo', exact: true }).click();
    const form = page.getByRole('form', { name: 'Kết nối tài khoản quảng cáo thử' });
    await form.getByLabel('Tên tài khoản quảng cáo').fill('Quảng cáo quản lý E2E');
    await form.getByLabel('Đơn vị tiền').selectOption('VND');
    await form.getByRole('button', { name: 'Kết nối tài khoản thử' }).click();
    await expect(page.getByText('Tiền tệ VND, giờ Việt Nam (UTC+7)')).toBeVisible({ timeout: 90_000 });
  });

  await test.step('a live launch with its objects and its changes, seeded as the superuser', async () => {
    const vars = { slug, draft: draftId, launch: launchId, campaign: CAMPAIGN, adSet: AD_SET };
    // An approved plan of ten days (two days ago to seven days ahead, in the account's zone) at 100,000 a day: at most 1,000,000.
    // The draft guard holds a draft to being born a draft, so it is lifted for this one statement and put back (always on, as the migration sets it), which the stack's superuser may do.
    exec(
      `ALTER TABLE crove_ads.ad_campaign_draft DISABLE TRIGGER campaign_draft_guard;
       INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, legal_entity_id, name, objective, status, daily_budget, start_on, end_on, targeting, link_url, variants, max_spend, proposal_id, approved_at, created_by)
       SELECT a.org_id, :'draft', a.id, a.legal_entity_id, :'campaign', 'traffic', 'approved', 100000,
              (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 2, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 7,
              '{"locations":[{"country":"VN"}],"ageMin":22,"ageMax":45,"gender":"all","interests":[]}'::jsonb, 'https://example.com/quan-ly',
              '[{"headline":"Quản lý","primaryText":"Mời bạn ghé thử.","callToAction":"learn_more"}]'::jsonb, 1000000, gen_random_uuid(), now(),
              (SELECT m.user_id FROM crove_kernel.tenant_member m WHERE m.org_id = a.org_id LIMIT 1)
       FROM crove_ads.ad_account a JOIN crove_kernel.tenant t ON t.org_id = a.org_id WHERE t.slug = :'slug';
       ALTER TABLE crove_ads.ad_campaign_draft ENABLE ALWAYS TRIGGER campaign_draft_guard`,
      vars,
    );
    exec(
      `INSERT INTO crove_ads.ad_launch (org_id, id, ad_account_id, legal_entity_id, draft_id, proposal_id, plan_hash, state, attempt, step, currency, daily_budget, start_on, end_on, amount, commit_until, created_by, started_at)
       SELECT d.org_id, :'launch', d.ad_account_id, d.legal_entity_id, d.id, d.proposal_id, 'sha256:' || repeat('0', 64), 'live', 1, 'live', 'VND', 100000, d.start_on, d.end_on, 1000000, d.end_on, d.created_by, now()
       FROM crove_ads.ad_campaign_draft d WHERE d.id = :'draft'`,
      vars,
    );
    exec(
      `INSERT INTO crove_ads.ad_object (org_id, ad_account_id, legal_entity_id, launch_id, slot, level, external_id, name)
       SELECT l.org_id, l.ad_account_id, l.legal_entity_id, l.id, o.slot, o.level, o.external_id, o.name
       FROM crove_ads.ad_launch l
       CROSS JOIN (VALUES ('campaign', 'campaign', 'e2e-manage-campaign', :'campaign'), ('ad_set', 'ad_set', 'e2e-manage-ad-set', :'adSet'),
                          ('creative_1', 'creative', 'e2e-manage-creative-1', 'Mẫu quảng cáo quản lý E2E'), ('ad_1', 'ad', 'e2e-manage-ad-1', 'Quảng cáo quản lý E2E 1')) AS o(slot, level, external_id, name)
       WHERE l.id = :'launch'`,
      vars,
    );
    // The history of the ad set's changes: a lower budget the platform confirmed, a raise it could not confirm (its amount stays held), and a shorter schedule that did not go through.
    exec(
      `INSERT INTO crove_ads.ad_manage_change (org_id, ad_account_id, launch_id, kind, slot, level, object_id, state, from_budget, to_budget, from_end_on, to_end_on, proposal_id, code, settled_on, requested_by, settled_at)
       SELECT l.org_id, l.ad_account_id, l.id, c.kind, 'ad_set', 'ad_set', 'e2e-manage-ad-set', c.state, c.from_budget, c.to_budget, c.from_end_on, c.to_end_on, c.proposal_id, c.code, c.settled_on, l.created_by, now()
       FROM crove_ads.ad_launch l
       CROSS JOIN LATERAL (VALUES
         ('budget_lower', 'applied', 120000::numeric, 100000::numeric, NULL::date, NULL::date, NULL::uuid, NULL::text, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1),
         ('budget_raise', 'unclear', 100000::numeric, 150000::numeric, NULL::date, NULL::date, gen_random_uuid(), 'reconcile_unclear', NULL::date),
         ('schedule_shorten', 'failed', NULL::numeric, NULL::numeric, l.end_on, l.end_on - 2, NULL::uuid, 'token_expired', NULL::date)
       ) AS c(kind, state, from_budget, to_budget, from_end_on, to_end_on, proposal_id, code, settled_on)
       WHERE l.id = :'launch'`,
      vars,
    );
    const rows = sql<{ state: string; objects: number; changes: number }>(
      `SELECT l.state, (SELECT count(*)::int FROM crove_ads.ad_object o WHERE o.launch_id = l.id) AS objects, (SELECT count(*)::int FROM crove_ads.ad_manage_change c WHERE c.launch_id = l.id) AS changes
         FROM crove_ads.ad_launch l WHERE l.id = :'launch'`,
      vars,
    );
    expect(rows).toEqual([{ state: 'live', objects: 4, changes: 3 }]);
  });

  const manage = page.getByTestId('campaign-manage');

  await test.step('the Manage section sits under the live launch note with the state in words', async () => {
    await page.goto(`/o/${slug}/ads/campaigns?draft=${draftId}`);
    await expect(page.getByTestId('campaign-launch')).toContainText('Lần chạy này đang hoạt động trên nền tảng quảng cáo.');
    await expect(manage).toBeVisible();
    await expect(manage.getByRole('heading', { name: 'Quản lý lần chạy này', level: 3 })).toBeVisible();
    await expect(manage.getByTestId('manage-now')).toContainText(/Ngân sách mỗi ngày: [^\n]*100[.,\s ]?000/);
    // The platform has not confirmed the raise, so the higher budget stays held against the caps.
    await expect(manage.getByTestId('manage-held-budget')).toContainText('Nền tảng chưa xác nhận mức ngân sách cao hơn');
    await expect(manage.getByTestId('manage-objects').getByTestId('manage-object')).toHaveCount(3);
    await expect(manage.getByText(CAMPAIGN).first()).toBeVisible();
    await expect(manage.getByText(AD_SET).first()).toBeVisible();
  });

  await test.step('the changes asked so far are listed with their state and why one did not go through', async () => {
    const list = manage.getByTestId('manage-changes');
    await expect(list.getByTestId('manage-change')).toHaveCount(3);
    await expect(list.locator('[data-state="applied"]')).toContainText('Đã xong');
    await expect(list.locator('[data-state="unclear"]')).toContainText('Chưa xác nhận được, hãy kiểm tra trên nền tảng');
    await expect(list.locator('[data-state="unclear"]')).toContainText('số tiền tăng thêm vẫn được giữ chỗ');
    await expect(list.locator('[data-state="failed"]')).toContainText('Không thực hiện được');
    await expect(list.locator('[data-state="failed"]')).toContainText('Lý do: kết nối tài khoản quảng cáo đã hết hạn; hãy kết nối lại ở màn Quảng cáo.');
  });

  await test.step('running ads is off here, so only Pause is offered, with the reason, and no form', async () => {
    await expect(manage.getByTestId('manage-limited')).toContainText('Lúc này chỉ tạm dừng được');
    await expect(manage.getByRole('button', { name: `Tạm dừng ${CAMPAIGN}` })).toBeVisible();
    await expect(manage.getByRole('button', { name: /^Bật lại/ })).toHaveCount(0);
    await expect(manage.getByRole('button', { name: /^Lưu trữ/ })).toHaveCount(0);
    await expect(manage.getByRole('button', { name: 'Giảm ngân sách', exact: true })).toHaveCount(0);
    await expect(manage.getByRole('button', { name: 'Xin tăng', exact: true })).toHaveCount(0);
    await expect(manage.locator('form')).toHaveCount(0);
  });

  await test.step('the screen passes an axe scan, at desktop and phone width, with no sideways scroll', async () => {
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(manage).toBeVisible();
      const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
      expect(widths.page, `${width}px: no sideways scroll`).toBeLessThanOrEqual(widths.view);
      const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const serious = scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious.map((v) => `${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`), `${width}px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  await test.step('pausing the campaign applies without approval: it is queued and listed at once', async () => {
    await manage.getByRole('button', { name: `Tạm dừng ${CAMPAIGN}` }).click();
    // Whatever the platform answers later, the change is recorded and listed with its own sentence.
    await expect(manage.getByTestId('manage-change').filter({ hasText: `Tạm dừng ${CAMPAIGN}` })).toBeVisible();
    const rows = sql<{ kind: string; slot: string; proposal_id: string | null }>(
      `SELECT c.kind, c.slot, c.proposal_id::text AS proposal_id FROM crove_ads.ad_manage_change c WHERE c.launch_id = :'launch' AND c.kind = 'pause'`,
      { launch: launchId },
    );
    // A pause only reduces spend: it carries no approval.
    expect(rows).toEqual([{ kind: 'pause', slot: 'campaign', proposal_id: null }]);
    // Nothing was asked of the Inbox.
    await expect(manage.getByTestId('manage-asked')).toHaveCount(0);
  });
});

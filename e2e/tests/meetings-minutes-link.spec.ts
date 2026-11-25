// SPDX-License-Identifier: AGPL-3.0-only
// The read-only link to the published minutes, end to end in a real browser with no AI (#4822, with #4850, #4855 and #4947): the owner turns the org switch on, the recorder of a meeting with published minutes
// makes a link, a fresh browser context with no session opens it and sees the title, the summary, the decisions and the action items and nothing else, the recorder revokes it and the page then shows the one
// neutral "does not open" view, and an admin who is not the recorder sees another link in a manager view (no create button) and ends it. The meeting and its published minutes are seeded straight into the
// database (e2e/lib/meetings-seed.ts), as the other Meetings specs do; a transcript line, a speaker and an unpublished action item carry canary words that must never reach the page. Its own users, created
// confirmed without the sign-up form.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { publishOutcome, seedMeeting } from '../lib/meetings-seed.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const TITLE = 'Họp chốt hợp đồng với khách Hoa Sen';
const DECISION = 'Chốt hợp đồng ba mươi ngày';
const ITEM = 'Gửi bản hợp đồng cho khách Hoa Sen';
const CANARY_LINE = 'Nội dung bản ghi lời không được lộ cho người ngoài';
const CANARY_SPEAKER = 'Người Nói Kín Đáo';
const CANARY_DRAFT_ITEM = 'Việc nháp chưa xuất bản không được lộ';

// A confirmed user made through the helper, added to the org by the database with the given role, signed in on their own page.
async function memberPage(browser: Browser, slug: string, email: string, role: 'member' | 'admin'): Promise<Page> {
  const page = await browser.newPage();
  await signInNewUser(page, email);
  await expect.poll(() => sql<{ id: string }>(`SELECT id FROM ludy_kernel.user_account WHERE lower(email) = lower(:'email')`, { email }).length).toBe(1);
  exec(
    `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
     SELECT t.org_id, u.id, :'role' FROM ludy_kernel.tenant t, ludy_kernel.user_account u
      WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { slug, email, role },
  );
  return page;
}

// The recorder's panel makes a link and shows its address once; the address is read from the field, then hidden.
async function makeLink(page: Page): Promise<string> {
  const panel = page.getByTestId('minutes-link');
  await panel.getByTestId('minutes-link-create').click();
  const made = panel.getByTestId('minutes-link-made');
  await expect(made).toBeVisible();
  const url = await made.getByTestId('minutes-link-url').inputValue();
  expect(url).toMatch(/\/-\/minutes#[A-Za-z0-9_-]{20,}$/);
  await made.getByTestId('minutes-link-dismiss').click();
  await expect(made).toHaveCount(0);
  return url;
}

// Ends the first live link of the panel after the confirmation.
async function revokeFirstLive(page: Page): Promise<void> {
  const panel = page.getByTestId('minutes-link');
  await panel.getByRole('button', { name: /^Thu hồi liên kết tạo/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Thu hồi', exact: true }).click();
}

test('the owner turns sharing on, the recorder shares the minutes by a link, an outsider reads only the minutes, a revoke closes it and an admin can end a link too (#4822)', async ({ browser, page }) => {
  test.setTimeout(240_000);
  const ownerEmail = newEmail('minutes-link-owner');
  const recorderEmail = newEmail('minutes-link-recorder');
  const adminEmail = newEmail('minutes-link-admin');
  await signInNewUser(page, ownerEmail);
  const slug = await createOrg(page, 'Công ty Hoa Sen Biên Bản');
  const recorder = await memberPage(browser, slug, recorderEmail, 'member');
  const admin = await memberPage(browser, slug, adminEmail, 'admin');
  // A browser with no session. Each visit is a new page of it: the same address opened again would only be a move inside the page (the token is after the #), not a new read.
  const outsiderContext = await browser.newContext();
  const visit = async (url: string): Promise<Page> => {
    const outsider = await outsiderContext.newPage();
    await outsider.goto(url);
    return outsider;
  };

  try {
    const meetingId = seedMeeting(slug, recorderEmail, TITLE, {
      visibility: 'org',
      segments: [{ from: 0, to: 10, who: CANARY_SPEAKER, said: CANARY_LINE }],
    });
    publishOutcome(meetingId, [DECISION], [ITEM]);
    exec(
      `INSERT INTO ludy_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, tainted, transcript_seconds)
       SELECT m.org_id, gen_random_uuid(), m.id, :'title', 'Lan', m.recorder_user_id, 'thứ sáu', 'draft', 'suggested', false, 10 FROM ludy_meetings.meeting m WHERE m.id = :'id'::uuid`,
      { id: meetingId, title: CANARY_DRAFT_ITEM },
    );

    await test.step('while the org switch is off the recorder is told so and cannot make a link', async () => {
      await recorder.goto(`/o/${slug}/meetings/${meetingId}`);
      const panel = recorder.getByTestId('minutes-link');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByTestId('minutes-link-off')).toContainText('chưa bật chia sẻ biên bản ra ngoài');
      await expect(panel.getByTestId('minutes-link-create')).toHaveCount(0);
    });

    await test.step('the owner turns the switch on in the Meetings settings', async () => {
      await page.goto(`/o/${slug}/meetings`);
      await page.getByTestId('meetings-settings-trigger').click();
      const card = page.getByTestId('meetings-settings-sheet').getByTestId('minutes-link-switch-card');
      await expect(card.getByTestId('minutes-link-switch-state')).toHaveText('Đang tắt');
      await card.getByTestId('minutes-link-switch-toggle').click();
      await expect(card.getByTestId('minutes-link-switch-state')).toHaveText('Đang bật');
    });

    let firstUrl = '';
    await test.step('the recorder makes a link, shown once, and the list holds no address', async () => {
      await recorder.reload();
      const panel = recorder.getByTestId('minutes-link');
      await expect(panel.getByTestId('minutes-link-create')).toBeVisible({ timeout: 30_000 });
      firstUrl = await makeLink(recorder);
      const items = panel.getByTestId('minutes-link-item');
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText('Còn hạn');
      await expect(items.first()).toContainText('Chưa ai mở');
      expect(await panel.innerText()).not.toContain(firstUrl.split('#')[1] as string);
    });

    await test.step('a browser with no session opens the link and reads only the published minutes', async () => {
      const outsider = await visit(firstUrl);
      await expect(outsider.getByTestId('minutes-shared-by')).toContainText('Công ty Hoa Sen Biên Bản');
      await expect(outsider.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
      await expect(outsider.getByTestId('minutes-summary')).toContainText('Tóm tắt cuộc họp');
      await expect(outsider.getByTestId('minutes-decisions')).toContainText(DECISION);
      await expect(outsider.getByTestId('minutes-actions').getByTestId('minutes-action')).toHaveCount(1);
      await expect(outsider.getByTestId('minutes-actions')).toContainText(ITEM);
      await expect(outsider.getByTestId('minutes-read-only')).toBeVisible();
      // Nothing else of the meeting or the org: no transcript line, no speaker, no unpublished item, no address of a member, and no way into the org's screens.
      const text = await outsider.locator('body').innerText();
      for (const leak of [CANARY_LINE, CANARY_SPEAKER, CANARY_DRAFT_ITEM, recorderEmail, adminEmail, ownerEmail]) expect(text, leak).not.toContain(leak);
      await expect(outsider.locator('a[href*="/o/"]')).toHaveCount(0);
      await expect(outsider.getByTestId('minutes-invalid')).toHaveCount(0);
      // The session of the app is not in this browser.
      expect(await outsider.evaluate(() => window.localStorage.getItem('ludy-auth'))).toBeNull();
    });

    await test.step('the recorder sees the link was opened once, then revokes it', async () => {
      await recorder.reload();
      const panel = recorder.getByTestId('minutes-link');
      await expect(panel.getByTestId('minutes-link-item').first()).toContainText('1 lượt mở', { timeout: 30_000 });
      await revokeFirstLive(recorder);
      await expect(panel.getByTestId('minutes-link-item').first()).toContainText('Đã thu hồi');
      await expect(panel.getByRole('button', { name: /^Thu hồi liên kết tạo/ })).toHaveCount(0);
    });

    await test.step('the same address now shows the one neutral view and none of the minutes', async () => {
      const outsider = await visit(firstUrl);
      const invalid = outsider.getByTestId('minutes-invalid');
      await expect(invalid).toBeVisible();
      await expect(invalid).toContainText('Liên kết này không mở được');
      await expect(outsider.getByTestId('minutes-summary')).toHaveCount(0);
      await expect(outsider.getByTestId('minutes-shared-by')).toHaveCount(0);
      expect(await outsider.locator('body').innerText()).not.toContain(TITLE);
    });

    let secondUrl = '';
    await test.step('the recorder makes a second link', async () => {
      secondUrl = await makeLink(recorder);
      expect(secondUrl).not.toBe(firstUrl);
      const outsider = await visit(secondUrl);
      await expect(outsider.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
    });

    await test.step('an admin who is not the recorder sees the link, cannot make one and can end it', async () => {
      await admin.goto(`/o/${slug}/meetings/${meetingId}`);
      const panel = admin.getByTestId('minutes-link');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByTestId('minutes-link-create')).toHaveCount(0);
      await expect(panel.getByTestId('minutes-link-item')).toHaveCount(2);
      await expect(panel.getByRole('button', { name: /^Thu hồi liên kết tạo/ })).toHaveCount(1);
      await revokeFirstLive(admin);
      await expect(panel.getByRole('button', { name: /^Thu hồi liên kết tạo/ })).toHaveCount(0);
      await expect(panel.getByTestId('minutes-link-item').filter({ hasText: 'Còn hạn' })).toHaveCount(0);
    });

    await test.step('the second address is closed too', async () => {
      const outsider = await visit(secondUrl);
      await expect(outsider.getByTestId('minutes-invalid')).toBeVisible();
    });

    await test.step('the owner, who is not the recorder either, sees the same manager view with no create button', async () => {
      await page.goto(`/o/${slug}/meetings/${meetingId}`);
      const panel = page.getByTestId('minutes-link');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByTestId('minutes-link-create')).toHaveCount(0);
    });
  } finally {
    await outsiderContext.close();
    await admin.close();
    await recorder.close();
  }
});

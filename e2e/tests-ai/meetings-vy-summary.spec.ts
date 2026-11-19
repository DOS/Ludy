// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy summary of a meeting, end to end against a FAKE model (#3805, part 3). This spec runs only in the AI job (`pnpm --filter @crove/e2e stack:up:ai`, then `test:ai`), on a stack that has
// MEETINGS_SUMMARY on and a fixed-answer model service (e2e/fake-model); the default stack has no model and its specs rely on that. The meeting and its three-line transcript are stored directly (speech
// to text has its own tests); the model's answer is fixed, and the app's checks run on it as they would on a real one. The recorder asks Vy, is told it is ready, copies the result into their own draft,
// cannot share it until they have read what Vy wrote, edits it, shares it, and has the "draft ready" notice in the notifications. Its own user, created confirmed without the sign-up form.
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('Vy summarizes a stored transcript, the recorder reads, edits and shares it, and the draft ready notice arrives (#3805)', async ({ page }) => {
  const email = newEmail('meetings-vy');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Vy Tóm Tắt Họp');

  await test.step('a stored meeting of the recorder with a three-line transcript', async () => {
    exec(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       SELECT t.org_id, gen_random_uuid(), 'Họp báo giá khách A', 'vi', now(), now() + interval '30 minutes', 1800, u.id, 'attendees', 'ready', 'told_at_start', u.id, now(), '1.0', current_date + 30, current_date + 365
         FROM crove_kernel.tenant t, crove_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );
    exec(
      `INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage)
       SELECT m.org_id, m.id, v.from_s, v.to_s, v.who, v.said, 'draft'
         FROM crove_meetings.meeting m JOIN crove_kernel.tenant tn ON tn.org_id = m.org_id,
              (VALUES (0, 10, 'Hà', 'Chúng ta chốt giá cũ cho khách A.'), (10, 20, 'Nam', 'Em sẽ gửi báo giá vào thứ sáu.'), (20, 30, 'Hà', 'Được, họp tiếp tuần sau.')) AS v(from_s, to_s, who, said)
        WHERE tn.slug = :'slug'`,
      { slug },
    );
  });
  const meetingId = (sql<{ id: string }>(`SELECT m.id FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug'`, { slug })[0] as { id: string }).id;

  const panel = page.getByTestId('meeting-results');
  await test.step('the recorder asks Vy and is told, in a live region, that the summary is ready', async () => {
    await page.goto(`/o/${slug}/meetings/${meetingId}`);
    const vy = page.getByTestId('vy-summary');
    await expect(vy).toBeVisible();
    await vy.getByRole('button', { name: 'Nhờ Vy tóm tắt' }).click();
    const live = vy.getByTestId('vy-live');
    await expect(live).toContainText('Vy đã xong');
    await expect(live).toHaveAttribute('role', 'status');
    // Nothing is in the draft until the recorder copies it.
    await expect(panel.getByLabel('Tóm tắt', { exact: true })).toHaveValue('');
  });

  await test.step('copying puts what Vy wrote into the recorder\'s own draft, marked as Vy\'s', async () => {
    await page.getByTestId('vy-summary').getByRole('button', { name: 'Chép vào bản nháp của tôi' }).click();
    await expect(page.getByTestId('vy-live')).toContainText('Đã chép');
    await expect(panel.getByLabel('Tóm tắt', { exact: true })).toHaveValue('Cuộc họp bàn việc báo giá cho khách A. Hai bên thống nhất giữ giá cũ.');
    await expect(panel.getByLabel('Quyết định', { exact: true })).toHaveValue('Giữ giá cũ cho khách A');
    await expect(panel.getByTestId('action-item')).toHaveCount(1);
    await expect(panel.getByTestId('action-item')).toContainText('Vy đã viết');
  });

  await test.step('it cannot be shared before the recorder has read what Vy wrote', async () => {
    await expect(panel.getByTestId('vy-review')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Chia sẻ cho người dự họp' })).toBeDisabled();
  });

  await test.step('the recorder edits the summary, confirms they read it, and shares', async () => {
    await panel.getByLabel('Tóm tắt', { exact: true }).fill('Đã sửa: hai bên giữ giá cũ cho khách A.');
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && /saveSummary/.test(r.url()));
    await panel.getByRole('button', { name: 'Lưu bản nháp' }).click();
    expect((await saved).ok()).toBe(true);
    await panel.getByTestId('vy-review').getByRole('button', { name: 'Tôi đã đọc' }).click();
    const share = panel.getByRole('button', { name: 'Chia sẻ cho người dự họp' });
    await expect(share).toBeEnabled();
    await share.click();
    await expect(panel.getByRole('heading', { name: 'Đã chia sẻ cho người dự họp' })).toBeVisible();
    await expect(panel).toContainText('Đã sửa: hai bên giữ giá cũ cho khách A.');
    await expect(panel).toContainText('Giữ giá cũ cho khách A');
  });

  await test.step('the draft ready notice is in the notifications, and leads to the meeting', async () => {
    // The notice reaches the recorder through the outbox relay and a worker job, so it can come after the run's last click by longer than any fixed wait on the page (#3805: one CI run missed it at 45 s).
    // Wait for the SIGNAL, the notification row itself, then open the page: the list is read once when the page loads, so a page opened before the row exists would never show it.
    await expect
      .poll(() => sql<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.notification WHERE kind = 'meetings.summary_ready' AND subject_id = :'meeting'`, { meeting: meetingId })[0]?.n, {
        message: 'the draft ready notification row exists',
        timeout: 90_000,
        intervals: [500, 1_000, 2_000, 5_000],
      })
      .toBeGreaterThanOrEqual(1);
    await page.goto(`/o/${slug}/notifications`);
    const notice = page.getByText('Bản nháp biên bản của cuộc họp bạn ghi đã sẵn sàng');
    await expect(notice).toBeVisible();
    // A notification is a button that opens what it is about.
    await notice.click();
    await expect(page).toHaveURL(new RegExp(`/meetings/${meetingId}$`));
  });
});

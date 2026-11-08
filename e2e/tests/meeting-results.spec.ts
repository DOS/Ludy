// SPDX-License-Identifier: AGPL-3.0-only
// The manual path of a meeting's summary and action items, end to end with no AI (#2580, M6 part A2): the recorder adds an item and a summary, nobody else
// sees the draft, one click shares it, a reader makes a team task from the item, and the task links back to the meeting for that reader only.
// The meeting itself is stored directly (recording it needs a microphone and is covered by meeting-record.spec.ts).
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('the recorder shares a summary and an action item, a reader makes a task from it, and the task links back', async ({ browser, page }) => {
  const recorderEmail = newEmail('meeting-results-rec');
  const readerEmail = newEmail('meeting-results-reader');
  const outsiderEmail = newEmail('meeting-results-out');
  await page.goto('/');
  await signInNewUser(page, recorderEmail);
  const slug = await createOrg(page, 'Công ty Tóm Tắt Họp');

  const joinOrg = (email: string) =>
    exec(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       SELECT t.org_id, u.id, 'member' FROM crove_kernel.tenant t, crove_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );
  const reader = await browser.newPage();
  await reader.goto('/');
  await signInNewUser(reader, readerEmail);
  joinOrg(readerEmail);
  const outsider = await browser.newPage();
  await outsider.goto('/');
  await signInNewUser(outsider, outsiderEmail);
  joinOrg(outsiderEmail);

  await test.step('a stored meeting of the recorder, shared with the reader, and the reader holds one seat', async () => {
    exec(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       SELECT t.org_id, gen_random_uuid(), 'Họp giao ban tuần', 'vi', now(), now() + interval '30 minutes', 1800, u.id, 'attendees', 'ready', 'told_at_start', u.id, now(), '1.0', current_date + 30, current_date + 365
         FROM crove_kernel.tenant t, crove_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email: recorderEmail },
    );
    exec(
      `INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id)
       SELECT m.org_id, gen_random_uuid(), m.id, u.id FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id, crove_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email: readerEmail },
    );
    exec(
      `INSERT INTO crove_kernel.position (org_id, id, title, module, role_key, holder_user_id)
       SELECT t.org_id, gen_random_uuid(), 'Nhân viên bán hàng', 'kernel', 'member', u.id
         FROM crove_kernel.tenant t, crove_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email: readerEmail },
    );
  });
  const [{ id: meetingId }] = sql<{ id: string }>(`SELECT m.id FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug'`, { slug }) as [{ id: string }];

  await test.step('the recorder writes a summary and an item, naming the attendee by name, never by id', async () => {
    await page.goto(`/o/${slug}/meetings/${meetingId}`);
    const panel = page.getByTestId('meeting-results');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Tóm tắt', { exact: true }).fill('Chốt báo giá tuần này.');
    await panel.getByLabel('Quyết định', { exact: true }).fill('Giữ giá cũ');
    await panel.getByRole('button', { name: 'Lưu bản nháp' }).click();
    await panel.getByLabel('Việc cần làm', { exact: true }).fill('Gửi báo giá cho khách');
    await panel.getByLabel('Người dự họp', { exact: true }).selectOption({ label: readerEmail });
    await panel.getByRole('button', { name: 'Thêm mục' }).click();
    await expect(panel.getByTestId('action-item')).toHaveCount(1);
    await expect(panel).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  await test.step('nobody else sees the draft', async () => {
    await reader.goto(`/o/${slug}/meetings/${meetingId}`);
    await expect(reader.getByText('Họp giao ban tuần').first()).toBeVisible();
    await expect(reader.getByTestId('meeting-results')).toHaveCount(0);
    await outsider.goto(`/o/${slug}/meetings/${meetingId}`);
    await expect(outsider.getByTestId('meeting-results')).toHaveCount(0);
    expect(sql(`SELECT 1 FROM crove_meetings.action_item i JOIN crove_kernel.tenant t ON t.org_id = i.org_id WHERE t.slug = :'slug' AND i.stage = 'published'`, { slug })).toHaveLength(0);
  });

  await test.step('one click shares the summary and the item', async () => {
    await page.getByRole('button', { name: 'Chia sẻ cho người dự họp' }).click();
    await expect(page.getByText('Đã chia sẻ cho người dự họp')).toBeVisible();
    expect(sql(`SELECT i.stage FROM crove_meetings.action_item i JOIN crove_kernel.tenant t ON t.org_id = i.org_id WHERE t.slug = :'slug'`, { slug })).toEqual([{ stage: 'published' }]);
  });

  await test.step('the reader sees what was shared and makes a task from the item', async () => {
    await reader.goto(`/o/${slug}/meetings/${meetingId}`);
    const panel = reader.getByTestId('meeting-results');
    await expect(panel).toContainText('Chốt báo giá tuần này.');
    await expect(panel).toContainText('Giữ giá cũ');
    await expect(panel.getByRole('button', { name: 'Lưu bản nháp' })).toHaveCount(0);
    await expect(panel.getByLabel('Vị trí', { exact: true })).toHaveValue(/.+/);
    await panel.getByRole('button', { name: 'Tạo việc', exact: true }).click();
    await expect(panel.getByText('Đã tạo việc')).toBeVisible();
    expect(sql(`SELECT i.status FROM crove_meetings.action_item i JOIN crove_kernel.tenant t ON t.org_id = i.org_id WHERE t.slug = :'slug'`, { slug })).toEqual([{ status: 'accepted' }]);
  });

  await test.step('the task links back to the meeting for the reader, and the outsider is told the record cannot be opened', async () => {
    await reader.goto(`/o/${slug}/tasks`);
    await reader.getByRole('link', { name: 'Gửi báo giá cho khách' }).first().click();
    await reader.getByRole('link', { name: 'Mở cuộc họp đã sinh ra việc này' }).click();
    await expect(reader).toHaveURL(new RegExp(`/meetings/${meetingId}$`));
    await outsider.goto(`/o/${slug}/tasks`);
    await outsider.getByRole('link', { name: 'Gửi báo giá cho khách' }).first().click();
    await expect(outsider.getByText('Bản ghi không mở được.')).toBeVisible();
    await expect(outsider.getByRole('link', { name: 'Mở cuộc họp đã sinh ra việc này' })).toHaveCount(0);
  });

  await reader.close();
  await outsider.close();
});

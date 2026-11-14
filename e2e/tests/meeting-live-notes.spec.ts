// SPDX-License-Identifier: AGPL-3.0-only
// The live notes pane of a meeting the recorder opted into (ADR-0052 L4a-2, #3110): "Bản nháp trực tiếp" is on the recorder's meeting page and nowhere else.
// This stack runs with MEETINGS_TRANSCRIBE off (the default), so the pane says why it is empty and the meeting works as before; the transcription, the tick, the running
// notes and the budget and kill switch states are covered against a real database with a fake provider in apps/kernel/test/meetings-live-notes.db.test.ts.
// The meeting itself is stored directly (recording it needs a microphone and is covered by meeting-record.spec.ts).
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('a meeting the recorder opted into shows the live pane to the recorder only, and says why it is empty when the server cannot transcribe', async ({ browser, page }) => {
  const recorderEmail = newEmail('meeting-live-rec');
  const otherEmail = newEmail('meeting-live-other');
  await page.goto('/');
  await signInNewUser(page, recorderEmail);
  const slug = await createOrg(page, 'Công ty Ghi Chú Trực Tiếp');
  const other = await browser.newPage();
  await other.goto('/');
  await signInNewUser(other, otherEmail);
  exec(
    `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
     SELECT t.org_id, u.id, 'member' FROM crove_kernel.tenant t, crove_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { slug, email: otherEmail },
  );
  exec(
    `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, live_notes)
     SELECT t.org_id, gen_random_uuid(), 'Họp ghi chú trực tiếp', 'vi', now(), u.id, 'attendees', 'ready', 'told_at_start', u.id, now(), '1.0', current_date + 30, current_date + 365, true
       FROM crove_kernel.tenant t, crove_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { slug, email: recorderEmail },
  );
  const [{ id: meetingId }] = sql<{ id: string }>(`SELECT m.id FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug'`, { slug }) as [{ id: string }];
  await page.goto(`/o/${slug}/meetings/${meetingId}`);
  const pane = page.getByTestId('live-pane');
  await expect(pane).toBeVisible();
  await expect(pane).toContainText('Bản nháp trực tiếp');
  await expect(page.getByTestId('live-notice')).toContainText('Bản ghi này không phiên âm được ở máy chủ của bạn.');
  await expect(page.getByTestId('live-notice')).toContainText('Việc ghi âm vẫn tiếp tục');
  await expect(pane.getByRole('button', { name: 'Bắt đầu ghi chú trực tiếp' })).toHaveCount(0);

  // Another member of the org is not the recorder and not a reader: no pane (the page itself says the meeting cannot be opened).
  await other.goto(`/o/${slug}/meetings/${meetingId}`);
  await expect(other.getByTestId('live-pane')).toHaveCount(0);
});

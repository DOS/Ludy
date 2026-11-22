// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end tests for #4001 Slice 3: recorder's draft PII review dialog, quiet non-blocking
// pre-publish nudge with count, D1-D5 disclosures, draft translation cleanup, reader post-publish isolation,
// and WCAG 2.2 AA accessibility across desktop and 360px mobile in light and dark themes.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const STRUCTURE_RULES = ['landmark-one-main', 'region', 'landmark-unique', 'page-has-heading-one', 'heading-order'];

// Synthetic values shaped so crove_kernel.text_detect catches every kind while tools/ci/pii-scan.mjs recognizes them as synthetic.
const PHONE = '0912 345 678';
const EMAIL = 'khach@example.com';
const CCCD = '001200000001';
const MST = '0100000003';
const BANK = '1234567890123456';

async function scanDialogA11y(page: Page, label: string): Promise<string[]> {
  const problems: string[] = [];
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  if (widths.page > widths.view) problems.push(`${label}: scrolls sideways (${widths.page}px in ${widths.view}px)`);
  const scan = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG_TAGS).analyze();
  for (const v of scan.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
    problems.push(`${label}: ${v.impact} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  return problems;
}

async function scanPageA11y(page: Page, label: string): Promise<string[]> {
  const problems: string[] = [];
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  if (widths.page > widths.view) problems.push(`${label}: scrolls sideways (${widths.page}px in ${widths.view}px)`);
  const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  for (const v of scan.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
    problems.push(`${label}: ${v.impact} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  for (const v of structure.violations) {
    problems.push(`${label}: ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  return problems;
}

test('recorder reviews PII candidates, confirms redaction without blocking publish, drops draft translations, and reader sees only marks (#4001)', async ({ browser, page }) => {
  test.setTimeout(180_000);
  const recorderEmail = newEmail('meetings-redact-rec');
  const readerEmail = newEmail('meetings-redact-read');

  await page.goto('/');
  await signInNewUser(page, recorderEmail);
  const slug = await createOrg(page, 'Công ty Ẩn Thông Tin');

  const reader = await browser.newPage();
  await reader.goto('/');
  await signInNewUser(reader, readerEmail);
  exec(
    `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
     SELECT t.org_id, u.id, 'member' FROM crove_kernel.tenant t, crove_kernel.user_account u
      WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { slug, email: readerEmail },
  );

  let meetingId = '';
  await test.step('seed draft meeting across surfaces with non-PII numbers and draft translation', async () => {
    exec(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       SELECT t.org_id, gen_random_uuid(), :'title', 'vi', now(), now() + interval '30 minutes', 1800, u.id, 'attendees', 'ready', 'told_at_start', u.id, now(), '1.0', current_date + 30, current_date + 365
         FROM crove_kernel.tenant t, crove_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email: recorderEmail, title: `Họp chốt ${PHONE} năm 2026` },
    );
    meetingId = (sql<{ id: string }>(`SELECT m.id FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug'`, { slug })[0] as { id: string }).id;

    exec(
      `INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id)
       SELECT m.org_id, gen_random_uuid(), m.id, u.id
         FROM crove_meetings.meeting m, crove_kernel.user_account u
        WHERE m.id = :'id'::uuid AND lower(u.email) = lower(:'email')`,
      { id: meetingId, email: readerEmail },
    );

    exec(
      `INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage)
       SELECT m.org_id, m.id, v.from_s, v.to_s, v.who, v.said, 'draft'
         FROM crove_meetings.meeting m,
              jsonb_to_recordset(:'segments'::jsonb) AS v(from_s int, to_s int, who text, said text)
        WHERE m.id = :'id'::uuid`,
      {
        id: meetingId,
        segments: JSON.stringify([
          { from_s: 0, to_s: 15, who: 'Anh Minh', said: `Liên hệ ${EMAIL} hoặc ${PHONE} cho đơn 150.000 đ` },
          { from_s: 15, to_s: 30, who: 'Chị Lan', said: `CCCD ${CCCD} và MST ${MST}, STK ${BANK}` },
        ]),
      },
    );

    exec(
      `INSERT INTO crove_meetings.meeting_chapter (org_id, meeting_id, stage, position, title, start_seconds, tainted)
       SELECT m.org_id, m.id, 'draft', 1, :'title', 0, false
         FROM crove_meetings.meeting m WHERE m.id = :'id'::uuid`,
      { id: meetingId, title: `Mở đầu ${PHONE}` },
    );

    // Recorder's draft translation (dropped on redaction per D5) and attendee's published translation (kept).
    exec(
      `INSERT INTO crove_meetings.translation (org_id, meeting_id, member_user_id, kind, target_language, source_stage, source_hash, body)
       SELECT m.org_id, m.id, m.recorder_user_id, 'summary', 'en', 'draft', repeat('a', 64), :'draftBody'::jsonb
         FROM crove_meetings.meeting m WHERE m.id = :'id'::uuid`,
      { id: meetingId, draftBody: JSON.stringify([{ key: 'summary', text: `Call ${PHONE}`, state: 'ok', codes: [] }]) },
    );
    exec(
      `INSERT INTO crove_meetings.translation (org_id, meeting_id, member_user_id, kind, target_language, source_stage, source_hash, body)
       SELECT m.org_id, m.id, u.id, 'summary', 'en', 'published', repeat('b', 64), '[]'::jsonb
         FROM crove_meetings.meeting m, crove_kernel.user_account u
        WHERE m.id = :'id'::uuid AND lower(u.email) = lower(:'email')`,
      { id: meetingId, email: readerEmail },
    );
  });

  await test.step('recorder saves draft summary, decision, and action item, sees quiet non-blocking pre-publish nudge count', async () => {
    await page.goto(`/o/${slug}/meetings/${meetingId}`);
    const resultsPanel = page.getByTestId('meeting-results');
    await expect(resultsPanel).toBeVisible();
    await resultsPanel.getByLabel('Tóm tắt', { exact: true }).fill(`Tóm tắt gọi ${PHONE}, giá 150.000 đ, năm 2026, 5 hộp.`);
    await resultsPanel.getByLabel('Quyết định', { exact: true }).fill(`Chuyển khoản STK ${BANK}`);
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && /saveSummary/.test(r.url()));
    await resultsPanel.getByRole('button', { name: 'Lưu bản nháp' }).click();
    expect((await saved).ok()).toBe(true);

    await resultsPanel.getByLabel('Việc cần làm', { exact: true }).fill(`Gọi lại ${PHONE}`);
    const added = page.waitForResponse((r) => r.request().method() === 'POST' && /actionItems\/create/.test(r.url()));
    await resultsPanel.getByRole('button', { name: 'Thêm mục' }).click();
    expect((await added).ok()).toBe(true);

    const prePublishNudge = page.getByTestId('redaction-prepublish-nudge');
    await expect(prePublishNudge).toBeVisible();
    await expect(prePublishNudge).toContainText('10');
    await expect(page.getByTestId('transcript-redaction-nudge')).toBeVisible();
    // D6: publish button stays enabled and is never blocked by detected candidates.
    await expect(resultsPanel.getByRole('button', { name: 'Chia sẻ cho người dự họp' })).toBeEnabled();

    // Full-page WCAG 2.2 AA scan on recorder draft page with nudges visible (desktop & 360px).
    expect(await scanPageA11y(page, 'light 1280px recorder draft')).toEqual([]);
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await scanPageA11y(page, 'light 360px recorder draft')).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await test.step('non-recorder reader never sees redaction nudges or drafts before publish', async () => {
    await reader.goto(`/o/${slug}/meetings/${meetingId}`);
    await expect(reader.getByTestId('redaction-prepublish-nudge')).toHaveCount(0);
    await expect(reader.getByTestId('transcript-redaction-nudge')).toHaveCount(0);
    await expect(reader.getByTestId('redaction-detail-nudge')).toHaveCount(0);
    await expect(reader.getByTestId('meeting-results')).toHaveCount(0);
  });

  await test.step('review dialog displays D1-D5 disclosures, marks, toggles, passes Axe (desktop & 360px light/dark), and Escape cancels safely', async () => {
    await page.getByTestId('redaction-prepublish-nudge-open').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const disclosures = dialog.getByTestId('redaction-disclosures');
    await expect(disclosures).toContainText('không thể hoàn tác');
    await expect(disclosures).toContainText('xóa toàn bộ kết quả Vy riêng và bản dịch nháp');
    await expect(disclosures).toContainText('Bản ghi âm và video không bị chỉnh sửa');
    await expect(disclosures).toContainText('chỉ chạy bằng mã (không gọi AI)');

    await expect(dialog.getByTestId('redaction-candidate')).toHaveCount(10);
    await expect(dialog).toContainText('[đã ẩn: số điện thoại]');
    await expect(dialog).toContainText('[đã ẩn: email]');
    await expect(dialog).toContainText('[đã ẩn: CCCD]');
    await expect(dialog).toContainText('[đã ẩn: mã số thuế]');
    await expect(dialog).toContainText('[đã ẩn: số tài khoản]');
    // Non-PII numbers are not flagged as matched PII marks.
    const marksText = (await dialog.locator('[data-testid="redaction-candidate"] mark').allTextContents()).join(' | ');
    expect(marksText).not.toContain('150.000');
    expect(marksText).not.toContain('2026');
    expect(marksText).not.toContain('5 hộp');

    // Toggle individual candidate checkbox off and back on, plus clear-all / select-all.
    const firstBox = dialog.getByRole('checkbox').first();
    await expect(firstBox).toBeChecked();
    await firstBox.click();
    await expect(firstBox).not.toBeChecked();
    await expect(dialog.getByTestId('redaction-selected-count')).toContainText('9 / 10');
    await dialog.getByTestId('redaction-clear-all').click();
    await expect(dialog.getByTestId('redaction-confirm')).toBeDisabled();
    await dialog.getByTestId('redaction-select-all').click();
    await expect(dialog.getByTestId('redaction-confirm')).toBeEnabled();

    // Axe & touch target audit in light mode (desktop + 360px mobile).
    expect(await scanDialogA11y(page, 'light 1280px dialog')).toEqual([]);
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await scanDialogA11y(page, 'light 360px dialog')).toEqual([]);
    for (const btnTestId of ['redaction-confirm', 'redaction-cancel', 'redaction-rescan']) {
      const box = await dialog.getByTestId(btnTestId).boundingBox();
      expect(box?.height ?? 0, `${btnTestId} height at 360px`).toBeGreaterThanOrEqual(44);
    }

    // Pressing Escape closes without modifying any text in DB and returns focus to trigger button.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('redaction-prepublish-nudge-open')).toBeFocused();
    const stillUnredacted = sql<{ summary: string }>(
      `SELECT summary FROM crove_meetings.meeting_result WHERE meeting_id = :'id'::uuid AND stage = 'draft'`,
      { id: meetingId },
    );
    expect(stillUnredacted[0]?.summary).toContain(PHONE);

    // Verify dark mode on 360px and 1280px with dialog open.
    await page.evaluate(() => localStorage.setItem('ludy-theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.getByTestId('redaction-prepublish-nudge-open').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await scanDialogA11y(page, 'dark 360px dialog')).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await scanDialogA11y(page, 'dark 1280px dialog')).toEqual([]);
  });

  await test.step('confirming redaction replaces PII with typed marks, keeps non-PII, drops recorder draft translation, and hides nudges', async () => {
    const dialog = page.getByRole('dialog');
    const redactRes = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('transcript/redact'));
    await dialog.getByTestId('redaction-confirm').click();
    expect((await redactRes).ok()).toBe(true);
    await expect(dialog).toBeHidden();

    const doneStatus = page.getByTestId('redaction-done-status');
    await expect(doneStatus).toBeVisible();
    await expect(doneStatus).toBeFocused();
    await expect(doneStatus).toContainText('10');
    await expect(doneStatus).toContainText('1 bản dịch nháp');
    await expect(page.getByTestId('redaction-prepublish-nudge')).toHaveCount(0);
    await expect(page.getByTestId('transcript-redaction-nudge')).toHaveCount(0);

    // Draft UI updated cleanly without reload, keeping non-PII numbers intact.
    const resultsPanel = page.getByTestId('meeting-results');
    await expect(resultsPanel.getByLabel('Tóm tắt', { exact: true })).toHaveValue('Tóm tắt gọi [đã ẩn: số điện thoại], giá 150.000 đ, năm 2026, 5 hộp.');
    await expect(resultsPanel.getByLabel('Quyết định', { exact: true })).toHaveValue('Chuyển khoản STK [đã ẩn: số tài khoản]');
    await expect(resultsPanel.getByLabel('Tên việc', { exact: true })).toHaveValue('Gọi lại [đã ẩn: số điện thoại]');
    await expect(page.locator('h1')).toContainText('[đã ẩn: số điện thoại]');
    await expect(page.locator('h1')).toContainText('2026');

    // Original values are gone from DB and recorder draft translation is dropped while attendee published translation remains.
    const translations = sql<{ source_stage: string }>(
      `SELECT source_stage FROM crove_meetings.translation WHERE meeting_id = :'id'::uuid`,
      { id: meetingId },
    );
    expect(translations).toEqual([{ source_stage: 'published' }]);

    const segs = sql<{ text: string }>(
      `SELECT text FROM crove_meetings.transcript_segment WHERE meeting_id = :'id'::uuid ORDER BY start_seconds`,
      { id: meetingId },
    );
    expect(segs.map((s) => s.text)).toEqual([
      'Liên hệ [đã ẩn: email] hoặc [đã ẩn: số điện thoại] cho đơn 150.000 đ',
      'CCCD [đã ẩn: CCCD] và MST [đã ẩn: mã số thuế], STK [đã ẩn: số tài khoản]',
    ]);
  });

  await test.step('recorder publishes and reader sees only redacted marks and never original PII, passing page a11y', async () => {
    const publishRes = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('results/publish'));
    await page.getByRole('button', { name: 'Chia sẻ cho người dự họp' }).click();
    expect((await publishRes).ok()).toBe(true);
    await expect(page.getByRole('heading', { name: 'Đã chia sẻ cho người dự họp' })).toBeVisible();

    await reader.goto(`/o/${slug}/meetings/${meetingId}`);
    const readerResults = reader.getByTestId('meeting-results');
    await expect(readerResults).toBeVisible();
    await expect(readerResults).toContainText('[đã ẩn: số điện thoại]');
    await expect(readerResults).toContainText('[đã ẩn: số tài khoản]');
    await expect(readerResults).toContainText('150.000 đ');
    await expect(readerResults).toContainText('2026');
    for (const secret of [PHONE, EMAIL, CCCD, MST, BANK]) {
      await expect(reader.locator('main')).not.toContainText(secret);
    }

    // Light + dark, desktop + 360px page scan on published redacted meeting.
    await reader.setViewportSize({ width: 1280, height: 800 });
    expect(await scanPageA11y(reader, 'light 1280px reader')).toEqual([]);
    await reader.setViewportSize({ width: 360, height: 780 });
    expect(await scanPageA11y(reader, 'light 360px reader')).toEqual([]);
    await reader.evaluate(() => localStorage.setItem('ludy-theme', 'dark'));
    await reader.reload();
    await expect(reader.locator('html')).toHaveClass(/\bdark\b/);
    expect(await scanPageA11y(reader, 'dark 360px reader')).toEqual([]);
  });

  await reader.close();
});

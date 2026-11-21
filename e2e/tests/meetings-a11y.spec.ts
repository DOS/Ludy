// SPDX-License-Identifier: AGPL-3.0-only
// The accessibility audit of the Meetings screens in a real browser (#3805, docs/qa/meetings-a11y-2026-11.md). The sidebar walk (layout.spec.ts) opens the Meetings list on an empty org; this
// spec opens every Meetings route with data, as a user left it: the list with a meeting, the recorder, the meeting's page with a published result and a draft editor, the printable biên bản
// and the template settings card with its form open. Each is scanned by axe (WCAG 2.2 AA, serious and critical, plus the landmark and heading rules) in light and dark, at desktop width and
// at 360px, and must not scroll sideways. A second test walks the recorder with the keyboard alone: Start, Pause, Resume and Stop, with the focus kept on the screen and the touch size of
// the buttons measured. The recording is the real MediaRecorder on Chromium's fake microphone, as in meeting-record.spec.ts. Its own user, created confirmed without the sign-up form.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({
  viewport: { width: 1280, height: 800 },
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

// The landmark and heading rules of axe (best-practice): one <main>, all content inside a landmark, landmarks told apart, one h1, and no heading that skips a level.
const STRUCTURE_RULES = ['landmark-one-main', 'region', 'landmark-unique', 'page-has-heading-one', 'heading-order'];

interface Screen {
  name: string;
  path: string;
  // What shows once the screen has loaded its data, so the scan sees the real content and not a skeleton.
  ready: (page: Page) => Promise<void>;
}

// What fails on the screen on show: a page that scrolls sideways, a serious or critical violation of the WCAG 2.2 AA rules, any landmark or heading order violation.
async function problemsOf(page: Page, label: string): Promise<string[]> {
  const problems: string[] = [];
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  if (widths.page > widths.view) problems.push(`${label}: scrolls sideways (${widths.page}px in ${widths.view}px)`);
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  for (const v of scan.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
    problems.push(`${label}: ${v.impact} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  for (const v of structure.violations) problems.push(`${label}: ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  return problems;
}

// A user with a meeting that has a published result and a draft editor, and a template of the org: the screens the scans open. Each width runs in its own test with its own user, so
// both fit the 180 second budget and one width failing does not hide the other.
async function prepare(page: Page, tag: string): Promise<Screen[]> {
  const email = newEmail(tag);
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Họp Dễ Dùng');
  let meetingId = '';

  await test.step('a stored meeting of the recorder, with a published result, so every panel has content', async () => {
    exec(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       SELECT t.org_id, gen_random_uuid(), 'Họp rà soát truy cập', 'vi', now(), now() + interval '30 minutes', 1800, u.id, 'attendees', 'ready', 'told_at_start', u.id, now(), '1.0', current_date + 30, current_date + 365
         FROM crove_kernel.tenant t, crove_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );
    meetingId = (sql<{ id: string }>(`SELECT m.id FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug'`, { slug })[0] as { id: string }).id;
    await page.goto(`/o/${slug}/meetings/${meetingId}`);
    const panel = page.getByTestId('meeting-results');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Tóm tắt', { exact: true }).fill('Rà soát các màn hình họp.');
    await panel.getByLabel('Quyết định', { exact: true }).fill('Sửa trước khi mở rộng');
    await panel.getByRole('button', { name: 'Lưu bản nháp' }).click();
    await panel.getByLabel('Việc cần làm', { exact: true }).fill('Kiểm tra bằng bàn phím');
    await panel.getByRole('button', { name: 'Thêm mục' }).click();
    await expect(panel.getByTestId('action-item')).toHaveCount(1);
  });

  await test.step('sharing from the keyboard moves the focus to the heading of what was shared (WCAG 2.4.3, 4.1.3)', async () => {
    const share = page.getByRole('button', { name: 'Chia sẻ cho người dự họp' });
    await share.focus();
    await page.keyboard.press('Enter');
    const shared = page.getByRole('heading', { name: 'Đã chia sẻ cho người dự họp' });
    await expect(shared).toBeVisible();
    await expect(shared).toBeFocused();
  });

  const screens: Screen[] = [
    { name: 'list', path: `/o/${slug}/meetings`, ready: (p) => expect(p.getByText('Họp rà soát truy cập').first()).toBeVisible() },
    { name: 'recorder', path: `/o/${slug}/meetings/record`, ready: (p) => expect(p.getByRole('button', { name: 'Bắt đầu ghi' })).toBeVisible() },
    { name: 'meeting', path: `/o/${slug}/meetings/${meetingId}`, ready: (p) => expect(p.getByTestId('meeting-results').getByRole('heading', { name: 'Đã chia sẻ cho người dự họp' })).toBeVisible() },
    { name: 'minutes', path: `/o/${slug}/print/meeting-minutes/${meetingId}`, ready: (p) => expect(p.getByTestId('minutes-sheet')).toBeVisible() },
  ];

  await test.step('the template settings card, then its form open, are scanned too', async () => {
    await page.goto(`/o/${slug}/settings/apps`);
    const card = page.getByTestId('minutes-templates-card');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Thêm mẫu' }).click();
    // Opening the form moves the focus into it (WCAG 2.4.3).
    await expect(card.getByLabel('Tên mẫu')).toBeFocused();
    await card.getByLabel('Tên mẫu').fill('Giao ban truy cập');
    await card.getByLabel('Tiêu đề mục 1').fill('Kết quả');
    await card.getByRole('button', { name: 'Tạo mẫu' }).click();
    await expect(card.getByTestId('minutes-template')).toHaveCount(1);
    // The row's buttons say which template they act on (the name is their description).
    await expect(card.getByRole('button', { name: 'Sửa', exact: true })).toHaveAccessibleDescription('Giao ban truy cập');
    await card.getByRole('button', { name: 'Thêm mẫu' }).click();
    screens.push({
      name: 'settings (template form open)',
      path: `/o/${slug}/settings/apps`,
      ready: async (p) => {
        const c = p.getByTestId('minutes-templates-card');
        await expect(c).toBeVisible();
        await c.getByRole('button', { name: 'Thêm mẫu' }).click();
        await expect(c.getByLabel('Tên mẫu')).toBeVisible();
      },
    });
  });

  return screens;
}

// Every screen in light and dark at one width: what fails is listed together, so one problem does not hide the others.
async function scanAt(page: Page, screens: Screen[], width: number, height: number): Promise<string[]> {
  const problems: string[] = [];
  await page.setViewportSize({ width, height });
  for (const theme of ['light', 'dark'] as const) {
    // The theme the app reads at load (lib/theme.ts), from this browser only.
    await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
    for (const screen of screens) {
      await page.goto(screen.path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      await screen.ready(page);
      problems.push(...(await problemsOf(page, `${theme} ${width}px ${screen.name}`)));
    }
  }
  return problems;
}

test('every Meetings route with data passes axe and fits the screen at desktop width, in light and dark (#3805)', async ({ page }) => {
  const screens = await prepare(page, 'meetings-a11y-wide');
  expect(await scanAt(page, screens, 1280, 800)).toEqual([]);
});

test('every Meetings route with data passes axe and fits the screen at 360px, in light and dark (#3805)', async ({ page }) => {
  const screens = await prepare(page, 'meetings-a11y-phone');
  expect(await scanAt(page, screens, 360, 780)).toEqual([]);
});

// How many chunks the recorder has kept on the device, read through the page's own IndexedDB (one every 5 seconds, as in meeting-record.spec.ts).
async function storedChunks(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('crove-meeting-recordings');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const count = db.transaction(['chunks'], 'readonly').objectStore('chunks').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
        };
      }),
  );
}

test('the recorder works from the keyboard: Start, Pause, Resume and Stop keep the focus on the screen, and the buttons are touch sized (#3805)', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewUser(page, newEmail('meetings-a11y-kb'));
  const slug = await createOrg(page, 'Công ty Ghi Bằng Phím');
  await page.goto(`/o/${slug}/meetings/record`);

  await test.step('the form is filled and Start pressed with the keyboard; the focus goes to the recording status, not to the top of the page', async () => {
    await page.getByLabel('Tiêu đề cuộc họp').fill('Họp bằng bàn phím');
    await page.getByLabel('Hình thức thông báo').selectOption('told_at_start');
    const agreed = page.getByRole('checkbox', { name: /Tôi xác nhận đã thông báo/ });
    await agreed.focus();
    await page.keyboard.press('Space');
    await expect(agreed).toBeChecked();
    const start = page.getByRole('button', { name: 'Bắt đầu ghi' });
    await expect(start).toBeEnabled();
    await start.focus();
    await page.keyboard.press('Enter');
    const status = page.getByRole('status').filter({ hasText: 'Đang ghi' });
    await expect(status).toBeVisible();
    await expect(status).toBeFocused();
  });

  await test.step('the clock is a timer outside the live region, so it is not read every half second', async () => {
    const timer = page.getByRole('timer', { name: 'Thời gian đã ghi' });
    await expect(timer).toHaveText(/^\d\d:\d\d$/);
    await expect(page.getByRole('status').filter({ hasText: 'Đang ghi' })).not.toContainText(/\d\d:\d\d/);
  });

  await test.step('the buttons are 44px high at phone width (DESIGN.md section 7)', async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    for (const name of ['Tạm dừng', 'Dừng và tải lên']) {
      const button = page.getByRole('button', { name, exact: true });
      const box = await button.boundingBox();
      // What the page says about itself, so a failure names the cause (the viewport the media queries see, the minimum height the button computed).
      const seen = await button.evaluate((el) => ({ innerWidth: window.innerWidth, minHeight: getComputedStyle(el).minHeight, className: el.className.slice(-60) }));
      expect(box?.height ?? 0, `${name} ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(44);
    }
    // The bar in the corner keeps its own Stop: smaller by design, never under the 24px of WCAG 2.5.8.
    const chipStop = await page.getByTestId('recording-chip-stop').boundingBox();
    expect(chipStop?.height ?? 0).toBeGreaterThanOrEqual(24);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await test.step('Tab reaches Pause, Enter pauses and the same button now resumes, still focused', async () => {
    await page.getByRole('status').filter({ hasText: 'Đang ghi' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Tạm dừng', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Đang tạm dừng' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tiếp tục', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Đang ghi' })).toBeVisible();
  });

  await test.step('Stop with the keyboard uploads the recording and opens the meeting', async () => {
    // One chunk is stored every 5 seconds: wait for the first, so there is a recording to upload.
    await expect.poll(() => storedChunks(page), { timeout: 40_000 }).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Dừng và tải lên', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  });
});

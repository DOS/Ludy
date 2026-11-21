// SPDX-License-Identifier: AGPL-3.0-only
// The accessibility pass over the newest Meetings screens in a real browser (#4055, docs/qa/meetings-a11y-2026-11-new-screens.md). The first audit's spec (meetings-a11y.spec.ts) scans the older
// routes; this one opens what came after it, as a user left it: the Settings tab "Thông báo của tôi" with the morning-notice card (moved there from the bell's screen, #3592) (off, then on), and the meetings list with the Today view (an event of the member's
// calendar that is recorded and one that is not) and the weekly card (a published decision). Each is scanned by axe (WCAG 2.2 AA, serious and critical, plus the landmark and heading rules) in
// light and dark, at desktop width and at 360px, and must not scroll sideways. A third test walks the same screens by keyboard and by accessible name: the morning switch is named and described,
// saving says so, each Today row's link names its meeting, and the weekly card says which window it shows. The Vy result screens (title, commitments, adherence, recap) need the fake model of the AI
// end-to-end specs and are covered by their markup tests until then. Its own user, created confirmed without the sign-up form.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ viewport: { width: 1280, height: 800 } });

// The landmark and heading rules of axe (best-practice), as in meetings-a11y.spec.ts.
const STRUCTURE_RULES = ['landmark-one-main', 'region', 'landmark-unique', 'page-has-heading-one', 'heading-order'];

const EVENT_TITLES = { recorded: 'Họp đã ghi trong lịch', open: 'Họp chưa ghi trong lịch' };

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

// Puts the morning notice on or off from the card and waits until the database says so (the switch moves at once, before the save), so the next page load reads what was saved.
async function ensureMorning(page: Page, slug: string, on: boolean): Promise<void> {
  const toggle = page.getByTestId('morning-notice-setting').getByRole('checkbox', { name: /mỗi buổi sáng/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== on) await toggle.click();
  await expect(toggle).toBeChecked({ checked: on });
  const stored = () =>
    sql<{ n: number }>(`SELECT count(*)::int AS n FROM crove_meetings.morning_notice m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug'`, { slug })[0]?.n ?? 0;
  await expect.poll(stored).toBe(on ? 1 : 0);
  // Saved: the switch can be used again (it waits while the save is on its way).
  await expect(toggle).toBeEnabled();
}

// A user with a published meeting (a decision the weekly card lists) and a connected calendar with two events today, one of them recorded: the data the screens read. Each width runs in its own test
// with its own user, so both fit the 180 second budget and one width failing does not hide the other.
async function prepare(page: Page, tag: string): Promise<{ slug: string; screens: Screen[] }> {
  const email = newEmail(tag);
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Màn Hình Mới');
  let meetingId = '';

  await test.step('a stored meeting with a published decision, so the weekly card has a line', async () => {
    exec(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       SELECT t.org_id, gen_random_uuid(), 'Họp tuần cho màn hình mới', 'vi', now(), now() + interval '30 minutes', 1800, u.id, 'attendees', 'ready', 'told_at_start', u.id, now(), '1.0', current_date + 30, current_date + 365
         FROM crove_kernel.tenant t, crove_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );
    meetingId = (sql<{ id: string }>(`SELECT m.id FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug'`, { slug })[0] as { id: string }).id;
    await page.goto(`/o/${slug}/meetings/${meetingId}`);
    const panel = page.getByTestId('meeting-results');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Tóm tắt', { exact: true }).fill('Họp tuần.');
    await panel.getByLabel('Quyết định', { exact: true }).fill('Chốt lịch rà soát truy cập');
    await panel.getByRole('button', { name: 'Lưu bản nháp' }).click();
    await page.getByRole('button', { name: 'Chia sẻ cho người dự họp' }).click();
    await expect(page.getByRole('heading', { name: 'Đã chia sẻ cho người dự họp' })).toBeVisible();
  });

  await test.step('a connected calendar that reads events, with two events today: one recorded (linked to the meeting), one not', async () => {
    exec(
      `INSERT INTO crove_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events)
       SELECT t.org_id, gen_random_uuid(), u.id, 'google', 'a11y@calendar.test', 'a11y', '{}', true
         FROM crove_kernel.tenant t, crove_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );
    exec(
      `INSERT INTO crove_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, meeting_id)
       SELECT c.org_id, c.id, c.user_id, 'a11y-recorded', :'recorded', (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '12 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh', (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '12 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh' + interval '30 minutes', 'Asia/Ho_Chi_Minh', :'meeting'::uuid
         FROM crove_kernel.calendar_connection c JOIN crove_kernel.tenant t ON t.org_id = c.org_id WHERE t.slug = :'slug'`,
      { slug, recorded: EVENT_TITLES.recorded, meeting: meetingId },
    );
    exec(
      `INSERT INTO crove_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone)
       SELECT c.org_id, c.id, c.user_id, 'a11y-open', :'open', (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '12 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh', (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '12 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh' + interval '45 minutes', 'Asia/Ho_Chi_Minh'
         FROM crove_kernel.calendar_connection c JOIN crove_kernel.tenant t ON t.org_id = c.org_id WHERE t.slug = :'slug'`,
      { slug, open: EVENT_TITLES.open },
    );
  });

  const screens: Screen[] = [
    {
      name: 'notifications (morning notice off)',
      path: `/o/${slug}/settings/notifications`,
      ready: (p) => ensureMorning(p, slug, false),
    },
    {
      name: 'meetings list (Today view and weekly card)',
      path: `/o/${slug}/meetings`,
      ready: async (p) => {
        await expect(p.getByTestId('meeting-agenda')).toBeVisible();
        await expect(p.getByTestId('meeting-agenda-event')).toHaveCount(2);
        await expect(p.getByTestId('meeting-digest')).toBeVisible();
        await expect(p.getByTestId('digest-meeting').first()).toBeVisible();
      },
    },
  ];

  screens.push({
    name: 'notifications (morning notice on)',
    path: `/o/${slug}/settings/notifications`,
    ready: async (p) => {
      await ensureMorning(p, slug, true);
      await expect(p.getByTestId('morning-notice-time')).toBeEnabled();
    },
  });

  return { slug, screens };
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

test('the newest Meetings screens pass axe and fit the screen at desktop width, in light and dark (#4055)', async ({ page }) => {
  const { screens } = await prepare(page, 'meetings-a11y-new-wide');
  expect(await scanAt(page, screens, 1280, 800)).toEqual([]);
});

test('the newest Meetings screens pass axe and fit the screen at 360px, in light and dark (#4055)', async ({ page }) => {
  const { screens } = await prepare(page, 'meetings-a11y-new-phone');
  expect(await scanAt(page, screens, 360, 780)).toEqual([]);
});

test('names, descriptions and announcements: the morning switch, the Today rows and the weekly card tell a screen reader what they do (#4055)', async ({ page }) => {
  const { slug } = await prepare(page, 'meetings-a11y-new-names');

  await test.step('the morning notice: the switch has a name and the hint as its description, the time field a name and, once on, the zone', async () => {
    await page.goto(`/o/${slug}/settings/notifications`);
    const card = page.getByTestId('morning-notice-setting');
    await expect(card).toBeVisible();
    await ensureMorning(page, slug, true);
    const toggle = card.getByRole('checkbox', { name: 'Báo cho tôi các cuộc họp trong ngày vào mỗi buổi sáng' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAccessibleDescription(/Chỉ có số lượng và đường dẫn/);
    await expect(card.getByLabel('Lúc')).toBeVisible();
    // On: the zone line describes the field.
    await expect(toggle).toBeChecked();
    await expect(card.getByTestId('morning-notice-time')).toHaveAccessibleDescription(/Theo múi giờ của bạn/);
  });

  await test.step('saving from the keyboard says so (the toaster is a live region), and the switch keeps the focus', async () => {
    const card = page.getByTestId('morning-notice-setting');
    const toggle = card.getByRole('checkbox', { name: 'Báo cho tôi các cuộc họp trong ngày vào mỗi buổi sáng' });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).not.toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' }).first()).toBeVisible();
    await expect(toggle).toBeFocused();
  });

  await test.step('the Today view: each row\'s link says which meeting it is for', async () => {
    await page.goto(`/o/${slug}/meetings`);
    const rows = page.getByTestId('meeting-agenda-event');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: EVENT_TITLES.open }).getByRole('link', { name: 'Ghi cuộc họp này' })).toHaveAccessibleDescription(EVENT_TITLES.open);
    await expect(rows.filter({ hasText: EVENT_TITLES.recorded }).getByRole('link', { name: /Đã ghi/ })).toHaveAccessibleDescription(EVENT_TITLES.recorded);
  });

  await test.step('the weekly card: its picker has a name, and changing the window says which one is shown', async () => {
    const card = page.getByTestId('meeting-digest');
    const picker = card.getByRole('combobox', { name: 'Xem lại bao lâu' });
    await expect(picker).toBeVisible();
    const status = card.getByTestId('digest-window-status');
    await expect(status).toBeEmpty();
    // Focused first: selectOption sets the value but does not move the focus, and the point is that a member who changes the window from the picker stays on it.
    await picker.focus();
    await picker.selectOption('14');
    await expect(status).toHaveText('Đang xem 14 ngày gần đây');
    await expect(picker).toBeFocused();
  });
});

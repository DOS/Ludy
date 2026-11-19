// SPDX-License-Identifier: AGPL-3.0-only
// The accessibility pass over the Vy result screens in a real browser, against the FAKE model (#4055, docs/qa/meetings-a11y-2026-11-new-screens.md; the AI end-to-end specs of #4050 are the model of every flow here).
// What the other a11y spec (tests/meetings-a11y-new-screens.spec.ts) could not reach without a model: the title dialog, the commitments list and the adherence panel with an answer on screen. Two tests drive the three
// features on one meeting and scan the three cards with axe (WCAG 2.2 AA serious and critical) in light and dark, at 1280 and at 360px; a third walks them by name, description, announcement and focus (the findings D1 to D3,
// C1 to C3 and A1 of the audit); a fourth fails the weekly card's request for a new window and checks that the card, its picker and an error stay (W2). Only the cards are scanned (the rest of the meeting page has its own
// scans), and the answers are those the other specs already pin. A spec of its own, so nothing here edits the files of #4050. Its own user and org, created without the sign-up form.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { publishOutcome, seedMeeting } from '../lib/meetings-seed.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ viewport: { width: 1280, height: 800 } });

const AGENDA = ['Chốt giá cho khách A', 'Tuyển nhân sự mới', 'Chọn địa điểm tiệc cuối năm'];
const CARDS = ['[data-testid="title-suggest"]', '[data-testid="meeting-commitments"]', '[data-testid="meeting-adherence"]'];

// Opens the meeting and has Vy answer the three features, one click each, so every result is on screen.
async function answersOnScreen(page: Page, slug: string, meetingId: string): Promise<void> {
  await page.goto(`/o/${slug}/meetings/${meetingId}`);
  await page.getByTestId('title-suggest-run').click();
  await expect(page.getByTestId('title-candidate')).toHaveCount(2);
  await page.getByTestId('commitments-run').click();
  await expect(page.getByTestId('commitments-answer')).toBeVisible();
  await page.getByTestId('adherence-typed').fill(AGENDA.join('\n'));
  await page.getByTestId('adherence-check').click();
  await expect(page.getByTestId('adherence-answer')).toBeVisible();
}

// What fails in the cards on show: a card wider than the screen, a serious or critical violation of the WCAG 2.2 AA rules inside the three cards.
async function problemsOf(page: Page, label: string, include: readonly string[] = CARDS): Promise<string[]> {
  const problems: string[] = [];
  // The cards must fit the screen (the rest of the meeting page has its own scans, and an overflow of another widget is not this spec's to report).
  const overflow = await page.evaluate((selectors) => selectors.flatMap((selector) => [...document.querySelectorAll(selector)].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map(() => selector)), [...include]);
  for (const selector of overflow) problems.push(`${label}: ${selector} runs past the edge of the screen`);
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  for (const selector of include) builder = builder.include(selector);
  for (const v of (await builder.analyze()).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
    problems.push(`${label}: ${v.impact} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  return problems;
}

// Every theme at one width: the answers are in the page's own state, so each theme opens the meeting afresh and has Vy answer again. Mind the budget: title and commitments share the kernel's `summaries`
// bucket (4 runs per user a minute, refilled one every 15 seconds), and this makes two of each, so one more theme, width or run in here would meet a "busy" answer.
async function scanAt(page: Page, slug: string, meetingId: string, width: number, height: number): Promise<string[]> {
  const problems: string[] = [];
  await page.setViewportSize({ width, height });
  for (const theme of ['light', 'dark'] as const) {
    // The theme the app reads at load (lib/theme.ts), from this browser only.
    await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
    await answersOnScreen(page, slug, meetingId);
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    problems.push(...(await problemsOf(page, `${theme} ${width}px`)));
  }
  return problems;
}

async function prepare(page: Page, tag: string, orgName: string): Promise<{ slug: string; email: string; meetingId: string }> {
  const email = newEmail(tag);
  await signInNewUser(page, email);
  const slug = await createOrg(page, orgName);
  return { slug, email, meetingId: seedMeeting(slug, email, 'Họp báo giá khách A') };
}

test('the title, commitments and adherence results pass axe in light and dark at desktop width (#4055)', async ({ page }) => {
  const { slug, meetingId } = await prepare(page, 'meetings-a11y-vy-wide', 'Công ty Kết Quả Vy Rộng');
  expect(await scanAt(page, slug, meetingId, 1280, 800)).toEqual([]);
});

test('the title, commitments and adherence results pass axe in light and dark at 360px (#4055)', async ({ page }) => {
  const { slug, meetingId } = await prepare(page, 'meetings-a11y-vy-phone', 'Công ty Kết Quả Vy Hẹp');
  expect(await scanAt(page, slug, meetingId, 360, 780)).toEqual([]);
});

test('names, descriptions, announcements and focus of the Vy results: pick buttons say which title, the answers are announced, the focus comes back, the time buttons are named and sized (#4055)', async ({ page }) => {
  const { slug, meetingId } = await prepare(page, 'meetings-a11y-vy-names', 'Công ty Kết Quả Vy Tên');
  await answersOnScreen(page, slug, meetingId);
  const title = page.getByTestId('title-suggest');
  const run = page.getByTestId('title-suggest-run');

  await test.step('title dialog: each "use" button is described by its candidate, and the count is said in the live region (D1, D2)', async () => {
    const picks = page.getByTestId('title-pick');
    await expect(picks).toHaveCount(2);
    await expect(picks.nth(0)).toHaveAccessibleDescription('Chốt giá cũ cho khách A');
    await expect(picks.nth(1)).toHaveAccessibleDescription('Gửi báo giá cho khách A vào thứ sáu');
    await expect(title.getByRole('status')).toContainText('Có 2 gợi ý tên');
  });

  await test.step('title dialog: "none of these" from the keyboard puts the focus back on the button that asked (D3)', async () => {
    const dismiss = page.getByTestId('title-dismiss');
    await dismiss.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('title-candidate')).toHaveCount(0);
    await expect(run).toBeFocused();
  });

  await test.step('title dialog: a pick puts the focus back on the button too (D3)', async () => {
    await run.click();
    await expect(page.getByTestId('title-candidate')).toHaveCount(2);
    const pick = page.getByTestId('title-pick').nth(1);
    await pick.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('title-renamed')).toBeVisible();
    await expect(run).toBeFocused();
  });

  await test.step('commitments: the count is said, and each time button is named by what it does, contains its time and is not smaller than 24px (C1 to C3)', async () => {
    const card = page.getByTestId('meeting-commitments');
    // Three lines from two speakers (the answer the commitments spec pins).
    await expect(card.getByRole('status')).toContainText('3 dòng của 2 người');
    const jumps = page.getByTestId('commitments-jump');
    await expect(jumps).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      const jump = jumps.nth(i);
      const time = ((await jump.textContent()) ?? '').trim();
      await expect(jump).toHaveAccessibleName(`Mở bản ghi lời nói ở ${time}`);
      expect((await jump.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(24);
    }
  });

  await test.step('adherence: the hint describes the box, and typing more than eight lines is said in the status that was in the page already (A1)', async () => {
    const typed = page.getByTestId('adherence-typed');
    const hint = ((await page.locator('#adherence-typed-hint').textContent()) ?? '').trim();
    expect(hint.length).toBeGreaterThan(0);
    await expect(typed).toHaveAccessibleDescription(hint);
    const status = page.getByTestId('adherence-typed-overflow-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toBeEmpty();
    await typed.fill(Array.from({ length: 9 }, (_, i) => `Mục thứ ${i + 1}`).join('\n'));
    await expect(status).not.toBeEmpty();
  });
});

test('a window of the weekly card that fails to load keeps the card, its picker and an error, and the card passes axe in that state (W2, #4055)', async ({ page }) => {
  const { slug, meetingId } = await prepare(page, 'meetings-a11y-vy-digest', 'Công ty Tuần Lỗi');
  publishOutcome(meetingId, ['Chốt lịch rà soát truy cập'], []);
  await page.goto(`/o/${slug}/meetings`);
  const card = page.getByTestId('meeting-digest');
  const picker = card.getByRole('combobox', { name: 'Xem lại bao lâu' });
  await expect(picker).toBeVisible();
  await expect(card.getByTestId('digest-meeting').first()).toBeVisible();

  await test.step('the request for the 14 day window fails; the card stays with its picker and says so in an alert', async () => {
    await page.route('**/api/rpc/meetings/digest/facts**', (route) => (route.request().postData()?.includes('14') ? route.abort('failed') : route.continue()));
    await picker.focus();
    await picker.selectOption('14');
    await expect(card.getByRole('alert')).toBeVisible({ timeout: 40_000 });
    await expect(card).toBeVisible();
    await expect(picker).toBeVisible();
    // The focus stayed on the picker (the card was not replaced), and the facts of the failed window are not drawn.
    await expect(picker).toBeFocused();
    await expect(card.getByTestId('digest-meeting')).toHaveCount(0);
    // It said nothing about showing 14 days: they are not shown.
    await expect(card.getByTestId('digest-window-status')).toBeEmpty();
  });

  await test.step('the card in that state passes axe', async () => {
    expect(await problemsOf(page, 'weekly card with an error', ['[data-testid="meeting-digest"]'])).toEqual([]);
  });
});

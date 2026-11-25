// SPDX-License-Identifier: AGPL-3.0-only
// Cross-viewport (360px, 768px, 1280px, 1920px), light/dark theme parity, keyboard, and WCAG 2.2 AA Playwright
// regression suite for the Global Top Bar, stable left rail, 2-column Notifications, and customizable Global Home
// (#4923 Phase 5, closes #4929).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectCspViolations } from '../lib/csp.ts';
import { exec, sql } from '../lib/db.ts';
import { tabTo } from '../lib/inbox.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { openSettingsTab } from '../lib/settings.ts';
import { nextTotp } from '../lib/totp.ts';

const VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
] as const;

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const STRUCTURE_RULES = ['landmark-one-main', 'region', 'landmark-unique', 'page-has-heading-one', 'heading-order'];
const DEFAULT_OWNER_BLOCKS = [
  'finance_tax_deadlines',
  'finance_approvals',
  'teamwork_my_work',
  'engage_pipeline',
  'hr_pending',
  'esign_pending',
] as const;

interface RouteTarget {
  name: string;
  path: string;
  hasSecondaryNav: boolean;
  ready: (page: Page) => Promise<void>;
}

function shellRoutes(slug: string): RouteTarget[] {
  return [
    {
      name: 'overview',
      path: `/o/${slug}/overview`,
      hasSecondaryNav: false,
      ready: async (page) => {
        await expect(page.getByRole('heading', { name: 'Tổng quan', exact: true })).toBeVisible();
        await expect(page.getByTestId('home-customize-btn')).toBeEnabled();
      },
    },
    {
      name: 'notifications',
      path: `/o/${slug}/notifications`,
      hasSecondaryNav: false,
      ready: async (page) => {
        await expect(page.getByRole('heading', { name: 'Thông báo', exact: true })).toBeVisible();
        await expect(page.getByTestId('notifications-feed')).toBeVisible();
      },
    },
    {
      name: 'ledger',
      path: `/o/${slug}/ledger`,
      hasSecondaryNav: true,
      ready: async (page) => {
        await expect(page.getByRole('heading', { name: 'Sổ sách', exact: true })).toBeVisible();
      },
    },
    {
      name: 'settings',
      path: `/o/${slug}/settings`,
      hasSecondaryNav: true,
      ready: async (page) => {
        await expect(page.getByRole('heading', { name: 'Cài đặt', exact: true })).toBeVisible();
        await expect(page.getByText(slug, { exact: true })).toBeVisible();
      },
    },
  ];
}

// Seed deterministic notification fixtures via e2e/lib/db.ts (matching meetings-a11y.spec.ts / deal-next-steps.spec.ts)
// while real state transitions (Home layout save/reset, notification read) exercise Runtime.execute() through the UI.
function seedNotifications(slug: string, email: string): void {
  exec(
    `INSERT INTO ludy_kernel.notification (org_id, user_id, kind, dedupe_key, detail, created_at, read_at, legal_entity_id)
     SELECT t.org_id,
            u.id,
            v.kind,
            v.dedupe_key,
            v.detail::jsonb,
            v.created_at,
            v.read_at,
            e.id
     FROM ludy_kernel.tenant t
     JOIN ludy_kernel.user_account u ON lower(u.email) = lower(:'email')
     JOIN ludy_kernel.legal_entity e ON e.org_id = t.org_id AND e.is_default
     CROSS JOIN (
       VALUES
         ('finance.bank_attention', 'e2e-4929-bank-1121', '{"bankAccount":"1121","lines":"3"}', now(), NULL::timestamptz),
         ('meetings.morning', 'e2e-4929-meetings-morning', '{"count":"2"}', now() - interval '5 minutes', NULL::timestamptz),
         ('finance.period_closing', 'e2e-4929-period-closing', '{"period":"2026-10","dueDate":"2026-11-20"}', now() - interval '10 minutes', now() - interval '10 minutes')
     ) AS v(kind, dedupe_key, detail, created_at, read_at)
     WHERE t.slug = :'slug'
     ON CONFLICT (org_id, user_id, dedupe_key) DO NOTHING`,
    { slug, email },
  );
  const count = sql<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM ludy_kernel.notification n
     JOIN ludy_kernel.tenant t ON t.org_id = n.org_id
     WHERE t.slug = :'slug' AND n.dedupe_key LIKE 'e2e-4929-%'`,
    { slug },
  )[0]?.n;
  expect(count).toBe(3);
}

async function gotoChecked(
  page: Page,
  path: string,
  cspViolations: () => Promise<string[]>,
  label: string,
): Promise<void> {
  // collectCspViolations resets on each document load, so verify the outgoing document first.
  expect(await cspViolations(), `CSP before leaving ${label}`).toEqual([]);
  await page.goto(path);
}

async function assertNoHorizontalOverflow(page: Page, context: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    widths.scrollWidth,
    `${context}: horizontal overflow (${widths.scrollWidth}px in ${widths.clientWidth}px)`,
  ).toBeLessThanOrEqual(widths.clientWidth);
}

async function assertMinTargetSize(locator: Locator, label: string, minPx = 44): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box?.height ?? 0, `${label} height`).toBeGreaterThanOrEqual(minPx);
  expect(box?.width ?? 0, `${label} width`).toBeGreaterThanOrEqual(minPx);
}

async function measurePrimaryRailY(page: Page): Promise<Record<string, { linkY: number; iconY: number }>> {
  const apps = page.getByRole('complementary').getByRole('list', { name: 'Ứng dụng' });
  const result: Record<string, { linkY: number; iconY: number }> = {};
  for (const name of ['Tổng quan', 'Tài chính', 'Cộng tác']) {
    const link = apps.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    const linkBox = await link.boundingBox();
    const iconBox = await link.locator('svg').first().boundingBox();
    result[name] = {
      linkY: Math.round(linkBox?.y ?? -1),
      iconY: Math.round(iconBox?.y ?? -1),
    };
    expect(result[name].linkY, `${name} rail link y`).toBeGreaterThanOrEqual(0);
    expect(result[name].iconY, `${name} rail icon y`).toBeGreaterThanOrEqual(0);
  }
  return result;
}

async function assertDesktopTopBarStability(
  page: Page,
  viewportWidth: number,
  label: string,
): Promise<{ accountRightGap: number; accountY: number }> {
  const topBar = page.getByRole('banner');
  await expect(topBar).toBeVisible();
  await expect(topBar).toHaveAttribute('data-testid', 'global-top-bar');

  const homeLogo = topBar.getByTestId('topbar-home-link');
  const searchBtn = topBar.getByTestId('topbar-search-btn');
  const vyBtn = topBar.getByTestId('topbar-vy-btn');
  const quickCreateBtn = topBar.getByTestId('shell-quick-capture-btn');
  const bellLink = topBar.getByTestId('topbar-notifications-link');
  const settingsLink = topBar.getByTestId('topbar-settings-link');
  const accountBtn = topBar.getByTestId('account-menu-trigger');

  for (const control of [homeLogo, searchBtn, vyBtn, quickCreateBtn, bellLink, settingsLink, accountBtn]) {
    await expect(control, `${label} top bar control`).toBeVisible();
    await expect(control, `${label} top bar control in viewport`).toBeInViewport();
  }

  const bannerBox = await topBar.boundingBox();
  const accountBox = await accountBtn.boundingBox();
  expect(bannerBox, `${label} banner boundingBox`).not.toBeNull();
  expect(accountBox, `${label} account boundingBox`).not.toBeNull();
  expect(accountBox!.x, `${label} AccountPopover stays in right utility cluster`).toBeGreaterThan(viewportWidth / 2);
  expect(accountBox!.y, `${label} AccountPopover stays inside banner top`).toBeGreaterThanOrEqual(bannerBox!.y - 1);
  expect(
    accountBox!.y + accountBox!.height,
    `${label} AccountPopover stays inside banner bottom`,
  ).toBeLessThanOrEqual(bannerBox!.y + bannerBox!.height + 1);
  return {
    accountRightGap: Math.round(bannerBox!.x + bannerBox!.width - (accountBox!.x + accountBox!.width)),
    accountY: Math.round(accountBox!.y),
  };
}

async function axeScanProblems(page: Page, label: string): Promise<string[]> {
  const problems: string[] = [];
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (widths.scrollWidth > widths.clientWidth) {
    problems.push(`${label}: horizontal overflow (${widths.scrollWidth}px in ${widths.clientWidth}px)`);
  }
  const wcag = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  for (const v of wcag.violations) {
    problems.push(`${label}: ${v.impact ?? 'unknown'} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  for (const v of structure.violations) {
    problems.push(`${label}: ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  return problems;
}

async function assertAppliedTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
  const domState = await page.evaluate(() => ({
    hasDarkClass: document.documentElement.classList.contains('dark'),
    colorScheme: document.documentElement.style.colorScheme,
    storedTheme: window.localStorage.getItem('ludy-theme'),
  }));
  expect(domState).toEqual({
    hasDarkClass: theme === 'dark',
    colorScheme: theme,
    storedTheme: theme,
  });
}

async function switchThemeViaTopBar(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const topBar = page.getByRole('banner');
  await topBar.getByTestId('account-menu-trigger').click();
  const popover = topBar.getByTestId('account-popover');
  await expect(popover).toBeVisible();
  const themeGroup = popover.getByRole('radiogroup', { name: 'Giao diện' });
  const radioName = theme === 'dark' ? 'Tối' : 'Sáng';
  await themeGroup.getByRole('radio', { name: radioName }).click();
  await expect(themeGroup.getByRole('radio', { name: radioName })).toHaveAttribute('aria-checked', 'true');
  await assertAppliedTheme(page, theme);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
}

async function switchThemeViaPhoneDrawer(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('button', { name: 'Mở menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Menu chính' });
  await expect(drawer).toBeVisible();
  await drawer.getByTestId('account-menu-trigger').click();
  const popover = drawer.getByTestId('account-popover');
  await expect(popover).toBeVisible();
  const themeGroup = popover.getByRole('radiogroup', { name: 'Giao diện' });
  const radioName = theme === 'dark' ? 'Tối' : 'Sáng';
  await themeGroup.getByRole('radio', { name: radioName }).click();
  await expect(themeGroup.getByRole('radio', { name: radioName })).toHaveAttribute('aria-checked', 'true');
  await assertAppliedTheme(page, theme);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Đóng menu' }).click();
  await expect(drawer).toBeHidden();
}

async function assertVisibleBlockOrder(page: Page, expected: readonly string[], label: string): Promise<void> {
  for (const id of expected) {
    await expect(page.getByTestId(`home-block-${id}`), `${label}: block ${id} should be visible`).toBeVisible();
  }
  const actual = await page
    .getByTestId('overview-modular-blocks')
    .locator('section[data-testid^="home-block-"]')
    .evaluateAll((els) =>
      els
        .map((el) => el.getAttribute('data-testid')?.replace(/^home-block-/, '') ?? '')
        .filter(Boolean),
    );
  expect(actual, `${label}: block order`).toEqual([...expected]);
}

test('shell stability across 4 viewports, light/dark WCAG 2.2 AA parity, 2-column notifications, and role-filtered customizable Home (#4929)', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const cspViolations = await collectCspViolations(page);

  const ownerEmail = newEmail('shell-home-owner');
  await signInNewUser(page, ownerEmail);
  const slug = await createOrg(page, 'Công ty Kiểm thử Giao diện');
  seedNotifications(slug, ownerEmail);

  await gotoChecked(page, `/o/${slug}/overview`, cspViolations, 'initial onboarding');
  await expect(page.getByTestId('home-customize-btn')).toBeEnabled();
  await expect(page.getByTestId('topbar-notifications-badge')).toHaveText('2');

  const routes = shellRoutes(slug);

  await test.step('1 & 2. four viewports zero overflow, phone >=44px targets, Top Bar persistence, and 0px rail icon shift', async () => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      let baselineRailY: Record<string, { linkY: number; iconY: number }> | null = null;
      let baselineAccountPos: { accountRightGap: number; accountY: number } | null = null;

      for (const route of routes) {
        await gotoChecked(page, route.path, cspViolations, `viewport ${viewport.width}x${viewport.height}`);
        await route.ready(page);
        await page.waitForLoadState('networkidle');
        await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} ${route.name}`);

        if (viewport.width < 768) {
          await assertMinTargetSize(page.getByRole('button', { name: 'Mở menu' }), `${route.name} openMenu`);
          await assertMinTargetSize(page.getByTestId('phone-home-link'), `${route.name} phone-home-link`);
          await assertMinTargetSize(page.getByTestId('phone-quick-create-btn'), `${route.name} phone-quick-create-btn`);
          await assertMinTargetSize(page.getByTestId('phone-search'), `${route.name} phone-search`);

          if (route.name === 'overview') {
            const customizeBtn = page.getByTestId('home-customize-btn');
            expect((await customizeBtn.boundingBox())?.height ?? 0, 'phone Tùy chỉnh button height').toBeGreaterThanOrEqual(44);
            await customizeBtn.click();
            const panel = page.getByTestId('home-customize-panel');
            await expect(panel).toBeVisible();
            await assertNoHorizontalOverflow(page, '360x780 overview customize open');
            for (const blockId of DEFAULT_OWNER_BLOCKS) {
              await assertMinTargetSize(panel.getByTestId(`home-customize-up-${blockId}`), `phone move-up ${blockId}`);
              await assertMinTargetSize(panel.getByTestId(`home-customize-down-${blockId}`), `phone move-down ${blockId}`);
              await assertMinTargetSize(panel.getByTestId(`home-customize-switch-${blockId}`), `phone switch ${blockId}`);
            }
            // Text buttons get max-md:min-h-11 from Button (width scales with label length and satisfies WCAG 2.5.8).
            expect((await panel.getByTestId('home-customize-save').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
            expect((await panel.getByTestId('home-customize-cancel').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
            expect((await panel.getByTestId('home-customize-reset').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
            await panel.getByTestId('home-customize-cancel').click();
            await expect(panel).toHaveCount(0);
          }
        } else {
          const accountPos = await assertDesktopTopBarStability(page, viewport.width, `${viewport.width}x${viewport.height} ${route.name}`);
          if (baselineAccountPos === null) {
            baselineAccountPos = accountPos;
          } else {
            expect(
              Math.abs(accountPos.accountRightGap - baselineAccountPos.accountRightGap),
              `${viewport.width}x${viewport.height} ${route.name} AccountPopover right-edge column lock`,
            ).toBeLessThanOrEqual(1);
            expect(
              Math.abs(accountPos.accountY - baselineAccountPos.accountY),
              `${viewport.width}x${viewport.height} ${route.name} AccountPopover y position lock`,
            ).toBeLessThanOrEqual(1);
          }
          const desktopSidebar = page.getByTestId('desktop-sidebar');
          const sidebarBox = await desktopSidebar.boundingBox();
          expect(Math.round(sidebarBox?.width ?? 0), `${viewport.width}x${viewport.height} ${route.name} sidebar width`).toBe(
            route.hasSecondaryNav ? 288 : 64,
          );

          if (viewport.width === 768 && route.name === 'notifications') {
            // Shell switches to desktop top bar at md (768px), while Notifications stays single-column until lg (1024px).
            await expect(page.getByTestId('notifications-mobile')).toBeVisible();
            await expect(page.getByTestId('notifications-master-detail')).toHaveCount(0);
          }

          const railY = await measurePrimaryRailY(page);
          if (baselineRailY === null) {
            baselineRailY = railY;
          } else {
            expect(railY, `${viewport.width}x${viewport.height} ${route.name} rail 0px shift`).toEqual(baselineRailY);
          }

          if (viewport.width === 1280 && route.name === 'ledger') {
            await page.keyboard.press('[');
            await expect
              .poll(() => desktopSidebar.boundingBox().then((b) => Math.round(b?.width ?? 0)))
              .toBe(64);
            expect(await measurePrimaryRailY(page), '1280x800 ledger collapsed rail 0px shift').toEqual(baselineRailY);
            await page.keyboard.press('[');
            await expect
              .poll(() => desktopSidebar.boundingBox().then((b) => Math.round(b?.width ?? 0)))
              .toBe(288);
          }
        }
      }
    }
  });

  await test.step('3. light and dark theme parity via AccountPopover with WCAG 2.2 AA axe and CSP checks', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoChecked(page, `/o/${slug}/overview`, cspViolations, 'step 2 end');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('home-customize-btn')).toBeEnabled();

    const problems: string[] = [];
    // Default theme on a fresh browser context is 'light' (ludy-theme unset), so toggle to 'dark' first, then back to 'light'
    // so both invocations fire a real ThemeSwitcher change event and persist ludy-theme.
    for (const theme of ['dark', 'light'] as const) {
      await switchThemeViaTopBar(page, theme);

      await gotoChecked(page, `/o/${slug}/overview`, cspViolations, `${theme} theme toggle`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      await expect(page.getByTestId('topbar-notifications-badge')).toHaveText('2');
      await expect(page.getByTestId('home-customize-btn')).toBeEnabled();
      problems.push(...(await axeScanProblems(page, `${theme} overview`)));

      await page.getByTestId('home-customize-btn').click();
      await expect(page.getByTestId('home-customize-panel')).toBeVisible();
      problems.push(...(await axeScanProblems(page, `${theme} overview customize open`)));
      await page.getByTestId('home-customize-cancel').click();
      await expect(page.getByTestId('home-customize-panel')).toHaveCount(0);

      await gotoChecked(page, `/o/${slug}/notifications`, cspViolations, `${theme} overview`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      await expect(page.getByTestId('notifications-master-detail')).toBeVisible();
      await expect(page.getByTestId('notification-detail-title')).toBeVisible();
      problems.push(...(await axeScanProblems(page, `${theme} notifications master-detail`)));
    }

    expect(await cspViolations(), 'light notifications master-detail').toEqual([]);
    expect(problems).toEqual([]);
  });

  await test.step('4. Clarify-style 2-column Notifications filters, J/K shortcuts, and phone Sheet focus + axe in light & dark', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoChecked(page, `/o/${slug}/notifications`, cspViolations, 'step 3 end');
    const masterDetail = page.getByTestId('notifications-master-detail');
    const feedPane = page.getByTestId('notifications-feed-pane');
    const detailPane = page.getByTestId('notification-detail-pane');
    await expect(masterDetail).toBeVisible();
    await expect(feedPane).toBeVisible();
    await expect(detailPane).toBeVisible();

    const feedBox = await feedPane.boundingBox();
    const detailBox = await detailPane.boundingBox();
    expect(feedBox!.x, 'feed pane sits left of detail pane').toBeLessThan(detailBox!.x);
    expect(Math.abs(feedBox!.y - detailBox!.y), 'panes align at the top of 2-column grid').toBeLessThan(4);

    const rows = page.getByTestId('notification-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
    const detailTitle = detailPane.getByTestId('notification-detail-title');
    await expect(detailTitle).toHaveText('Sao kê ngân hàng cần xem lại');
    await expect(detailPane.getByTestId('notification-detail-metadata')).toContainText('1121');
    await expect(detailPane.getByTestId('notification-detail-metadata')).toContainText('3');

    await rows.nth(0).focus();
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(detailTitle).toHaveText('Lịch họp hôm nay');

    await page.keyboard.press('j');
    await expect(rows.nth(2)).toBeFocused();
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true');
    await expect(detailTitle).toHaveText('Kỳ sắp đến hạn nộp tờ khai');

    await page.keyboard.press('k');
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(detailTitle).toHaveText('Lịch họp hôm nay');

    await page.getByTestId('notifications-filter-unread').click();
    await expect(rows).toHaveCount(2);

    await expect(page.getByTestId('notifications-app-filters')).toBeVisible();
    await page.getByTestId('notifications-app-teamwork').click();
    await expect(rows).toHaveCount(1);
    await expect(detailTitle).toHaveText('Lịch họp hôm nay');

    await page.getByTestId('notifications-app-all').click();
    await expect(rows).toHaveCount(2);
    await page.getByTestId('notifications-filter-all').click();
    await expect(rows).toHaveCount(3);

    await page.setViewportSize({ width: 360, height: 780 });
    await gotoChecked(page, `/o/${slug}/notifications`, cspViolations, 'desktop notifications');
    await expect(page.getByTestId('notifications-mobile')).toBeVisible();
    await expect(page.getByTestId('notification-detail-sheet')).toHaveCount(0);
    await expect(page.getByTestId('notifications-unread-count')).toHaveText('2');

    const mobileRows = page.getByTestId('notification-row');
    await expect(mobileRows).toHaveCount(3);
    await mobileRows.nth(0).click();

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-testid', 'notification-detail-sheet');
    await expect(sheet).toContainText('Sao kê ngân hàng cần xem lại');
    await expect(sheet.getByTestId('notification-detail-metadata')).toContainText('1121');
    await expect(sheet.getByTestId('notification-detail-metadata')).toContainText('3');
    await expect(page.getByTestId('notifications-unread-count')).toHaveText('1');
    expect(await axeScanProblems(page, 'light 360px notifications sheet')).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('notification-detail-sheet')).toHaveCount(0);
    await expect(mobileRows.nth(0)).toBeFocused();

    await switchThemeViaPhoneDrawer(page, 'dark');
    await mobileRows.nth(1).click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Lịch họp hôm nay');
    expect(await axeScanProblems(page, 'dark 360px notifications sheet')).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('notification-detail-sheet')).toHaveCount(0);
    await expect(mobileRows.nth(1)).toBeFocused();
    await switchThemeViaPhoneDrawer(page, 'light');
  });

  await test.step('5a. HomeVyBar AI-off deterministic state and Tùy chỉnh persistence across reload & viewport switch + reset', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoChecked(page, `/o/${slug}/overview`, cspViolations, 'mobile notifications');
    await expect(page.getByTestId('home-customize-btn')).toBeEnabled();

    // Standard E2E runs with AI off (compose.e2e.yml); assert deterministic aiOff fallback with zero prompt input.
    const vyStatus = page.getByTestId('home-vy-status');
    await expect(vyStatus).toBeVisible();
    await expect(vyStatus).toHaveAttribute('data-vy-status', 'aiOff');
    await expect(vyStatus).toContainText('đang ở chế độ không dùng AI');
    await expect(page.getByTestId('home-vy-bar')).toHaveCount(0);
    await expect(page.getByTestId('home-vy-input')).toHaveCount(0);
    await expect(page.getByRole('banner').getByTestId('topbar-vy-btn')).toHaveAttribute('data-ai-state', 'off');
    await expect(page.getByRole('alert')).toHaveCount(0);

    await assertVisibleBlockOrder(page, DEFAULT_OWNER_BLOCKS, 'initial owner overview');

    const customizeBtn = page.getByTestId('home-customize-btn');
    await customizeBtn.click();
    await expect(customizeBtn).toBeFocused();
    const panel = page.getByTestId('home-customize-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('home-customize-up-finance_tax_deadlines')).toBeDisabled();
    await expect(panel.getByTestId('home-customize-down-esign_pending')).toBeDisabled();

    const upApprovals = panel.getByTestId('home-customize-up-finance_approvals');
    await tabTo(page, upApprovals);
    await page.keyboard.press('Enter');
    await expect(upApprovals).toBeDisabled();
    await expect(panel.getByTestId('home-customize-down-finance_approvals')).toBeFocused();
    await expect(panel.getByTestId('home-customize-announcement')).toHaveText(
      'Đã chuyển Chứng từ chờ duyệt đến vị trí 1 trên 6.',
    );

    const downHr = panel.getByTestId('home-customize-down-hr_pending');
    await tabTo(page, downHr);
    await page.keyboard.press('Enter');
    await expect(downHr).toBeDisabled();
    await expect(panel.getByTestId('home-customize-up-hr_pending')).toBeFocused();
    await expect(panel.getByTestId('home-customize-announcement')).toHaveText(
      'Đã chuyển Nhân sự chờ duyệt đến vị trí 6 trên 6.',
    );

    const engageSwitch = panel.getByTestId('home-customize-switch-engage_pipeline');
    await expect(engageSwitch).toBeChecked();
    await engageSwitch.click();
    await expect(engageSwitch).not.toBeChecked();

    await panel.getByTestId('home-customize-save').click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('home-customize-status')).toHaveText('Đã lưu bố cục Trang chủ.');
    await expect(page.getByTestId('home-customize-btn')).toBeFocused();

    const expectedCustomOrder = [
      'finance_approvals',
      'finance_tax_deadlines',
      'teamwork_my_work',
      'esign_pending',
      'hr_pending',
    ];
    await expect(page.getByTestId('home-block-engage_pipeline')).toHaveCount(0);
    await assertVisibleBlockOrder(page, expectedCustomOrder, 'customized after save');

    expect(await cspViolations(), 'before customized reload').toEqual([]);
    await page.reload();
    await expect(page.getByTestId('home-customize-btn')).toBeEnabled();
    await expect(page.getByTestId('home-block-engage_pipeline')).toHaveCount(0);
    await assertVisibleBlockOrder(page, expectedCustomOrder, 'customized after reload');

    await page.setViewportSize({ width: 360, height: 780 });
    await expect(page.getByTestId('home-block-engage_pipeline')).toHaveCount(0);
    await assertVisibleBlockOrder(page, expectedCustomOrder, 'customized at 360x780');
    await assertNoHorizontalOverflow(page, '360x780 customized overview');

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId('home-customize-btn').click();
    await page.getByTestId('home-customize-reset').click();
    await expect(page.getByTestId('home-customize-panel')).toHaveCount(0);
    await expect(page.getByTestId('home-customize-status')).toHaveText('Đã đặt lại bố cục mặc định theo vai trò.');
    await expect(page.getByTestId('home-customize-btn')).toBeFocused();
    await assertVisibleBlockOrder(page, DEFAULT_OWNER_BLOCKS, 'reset to role defaults');

    expect(await cspViolations(), 'before reset reload').toEqual([]);
    await page.reload();
    await expect(page.getByTestId('home-customize-btn')).toBeEnabled();
    await assertVisibleBlockOrder(page, DEFAULT_OWNER_BLOCKS, 'reset after reload');
  });

  await test.step('5b. invited member excludes finance_approvals and produces zero >=400 RPCs on /overview', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('banner').getByTestId('topbar-settings-link').click();
    await openSettingsTab(page, 'security');
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    expect(secret).not.toBe('');
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByText('Đang bật')).toBeVisible();

    await openSettingsTab(page, 'members');
    const memberEmail = newEmail('shell-home-member');
    await page.getByRole('button', { name: 'Mời thành viên' }).click();
    await page.getByPlaceholder(/^email@/).fill(memberEmail);
    await page.getByLabel('Vai trò', { exact: true }).selectOption('member');
    await page.getByRole('button', { name: 'Mời', exact: true }).click();
    const created = page.getByRole('status').filter({ hasText: `Đã tạo lời mời cho ${memberEmail}` });
    const inviteLink = (await created.getByText(/\/-\/invite#/).textContent())?.trim() ?? '';
    expect(inviteLink).toMatch(/\/-\/invite#/);

    const memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const memberPage = await memberContext.newPage();
      await memberPage.setViewportSize({ width: 1280, height: 800 });
      const memberCsp = await collectCspViolations(memberPage);
      await signInNewUser(memberPage, memberEmail);

      await gotoChecked(memberPage, inviteLink, memberCsp, 'member onboarding');
      await memberPage.getByRole('button', { name: 'Chấp nhận lời mời' }).click();
      await expect(memberPage).toHaveURL(new RegExp(`/o/${slug}/overview$`));
      await expect(memberPage.getByTestId('home-customize-btn')).toBeEnabled();
      await expect(memberPage.getByTestId('overview-modular-blocks')).toBeVisible();
      await memberPage.waitForLoadState('networkidle');

      // Attach listener after invite acceptance settles so InvitePage's invalidated invites.peek (409 INVITE_USED)
      // is never misattributed to the standalone /overview load.
      const failedRpcs: Array<{ url: string; status: number }> = [];
      memberPage.on('response', (response) => {
        if (response.url().includes('/api/rpc/') && response.status() >= 400) {
          failedRpcs.push({ url: response.url(), status: response.status() });
        }
      });

      await gotoChecked(memberPage, `/o/${slug}/overview`, memberCsp, 'member post-accept overview');
      await expect(memberPage.getByTestId('home-customize-btn')).toBeEnabled();
      await expect(memberPage.getByTestId('overview-modular-blocks')).toBeVisible();
      await memberPage.waitForLoadState('networkidle');

      expect(failedRpcs, 'member /overview must trigger zero >=400 RPCs').toEqual([]);
      expect(await memberCsp(), 'member /overview CSP').toEqual([]);
      await expect(memberPage.getByRole('alert')).toHaveCount(0);
      await expect(memberPage.getByTestId('home-block-finance_approvals')).toHaveCount(0);
      await expect(memberPage.getByTestId('home-block-finance_tax_deadlines')).toHaveCount(0);
      await expect(memberPage.getByTestId('home-block-hr_pending')).toBeVisible();
      await expect(memberPage.getByTestId('home-block-hr_pending')).toContainText('Cổng nhân viên');
      await expect(memberPage.getByTestId('home-block-teamwork_my_work')).toBeVisible();
      await expect(memberPage.getByTestId('home-block-engage_pipeline')).toBeVisible();
      await expect(memberPage.getByTestId('home-block-esign_pending')).toBeVisible();

      await memberPage.getByTestId('home-customize-btn').click();
      const memberPanel = memberPage.getByTestId('home-customize-panel');
      await expect(memberPanel).toBeVisible();
      await expect(memberPanel.getByTestId('home-customize-row-finance_approvals')).toHaveCount(0);
      await expect(memberPanel.getByTestId('home-customize-switch-finance_tax_deadlines')).not.toBeChecked();
      await memberPanel.getByTestId('home-customize-cancel').click();
    } finally {
      await memberContext.close();
    }
  });

  expect(await cspViolations(), 'owner final document CSP').toEqual([]);
});

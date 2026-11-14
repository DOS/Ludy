// The landing page's performance budget (#1655; DESIGN.md §6.3), measured on the built site in Chromium: LCP under
// 2.5 s, CLS under 0.1 and INP under 200 ms on every page (the home page and the app pages, each in both languages), on a throttled phone and on a desktop; at most two font
// families, each self-hosted, subset and preloaded; raster images only as AVIF or WebP, small, with their dimensions in
// the markup; and a cap on the client JavaScript the page loads. The numbers are in perf-budget.ts.
import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { BUDGET, PROFILES } from './perf-budget';
import { auditResources, measureVitals } from './perf-checks';

// Both languages share one URL per page (#2360): English is the visitor's cookie, set before the first request.
const baseUrl = () => process.env.WEB_BASE_URL ?? 'http://localhost:3000';
const chosen = (value: 'vi' | 'en') => (context: BrowserContext) => context.addCookies([{ name: 'ludy-lang', value, url: baseUrl() }]);
const vietnamese = chosen('vi');
const english = chosen('en');
// Each visit names its language, so a machine whose browser language is English still measures the Vietnamese pages.
const VISITS = ['/', '/cong-tac', '/ke-toan', '/engage', '/privacy'].flatMap((path) => [
  { path, label: path, setup: vietnamese },
  { path, label: `${path} in English`, setup: english },
]);

for (const { path, label, setup } of VISITS) {
  for (const profile of PROFILES) {
    test(`${label} on ${profile.name} keeps LCP, CLS and INP in budget`, async ({ browser }) => {
      const { vitals, problems, summary } = await measureVitals(browser, path, profile, BUDGET.runs, setup);
      // In the CI log too, so the margin left under the budget is seen on every run.
      console.log(`${label} ${profile.name}: ${summary}`);
      test.info().annotations.push({ type: 'vitals', description: `${label} ${profile.name}: ${summary}` });
      expect(problems).toEqual([]);
      expect(vitals.clicks, 'no interactive piece was clicked').toBeGreaterThan(0);
    });

    test(`${label} on ${profile.name} keeps its fonts, images and scripts in budget`, async ({ browser }) => {
      const { problems, summary } = await auditResources(browser, path, profile, setup);
      console.log(`${label} ${profile.name}: ${summary}`);
      test.info().annotations.push({ type: 'resources', description: `${label} ${profile.name}: ${summary}` });
      expect(problems).toEqual([]);
    });
  }
}

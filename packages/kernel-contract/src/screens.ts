// Each module's screens in the app and its menu items (plan §5.2 `routes` and `nav`, DESIGN.md §9, ADR-0031, #1652).
// Every module's manifest names its entry here (`...MODULE_SCREENS.crm`), and the app's shell builds its apps, menus,
// command palette and module guard from this list, so the shell names no module's screen itself. They live in
// @crove/kernel-contract because the app's bundle already reads it and it carries no server code.
// apps/app/test/module-screens.test.ts fails when a route of the app's router, under /o/$slug or outside it (#1660),
// has no entry or two, or a label has no message in Vietnamese or English; apps/kernel/test/manifest-screens.test.ts fails when a manifest drifts
// from its entry or a route names an undeclared permission. Modules are in the order of the app switcher.
import type { ModuleScreens } from './manifest.ts';

const KERNEL_SCREENS = {
  routes: [
    // What waits for the user in this org today (#1249), first in the menu; opening an org still lands on its Inbox.
    { path: 'overview' },
    { path: 'inbox' },
    { path: 'inbox/$id' },
    // In-app notifications of the kernel and finance (#671), with the unread count.
    { path: 'notifications' },
    // AI agents and tasks (ADR-0029) belong to the kernel, so every deployment has them.
    { path: 'tasks' },
    { path: 'tasks/$id' },
    { path: 'agents' },
    { path: 'settings' },
    // The audit log (#672): owners and admins only, which the page checks and the server enforces.
    { path: 'audit' },
    { path: 'personal-data' },
  ],
  // Signing in and the screens before an org: the landing redirect, the home of several orgs, sign-in, the second
  // factor, a password reset, an invite to accept and a new org.
  outside: [{ path: '/' }, { path: '/clients' }, { path: '/login' }, { path: '/mfa' }, { path: '/reset-password' }, { path: '/-/invite' }, { path: '/onboarding' }, { path: '/calendar/oauth/$provider/callback' }],
  nav: [
    { app: 'home', group: 'work', path: 'overview', label: 'overview' },
    { app: 'home', group: 'work', path: 'inbox', label: 'inbox' },
    { app: 'home', group: 'work', path: 'notifications', label: 'alerts' },
    { app: 'home', group: 'work', path: 'tasks', label: 'tasks' },
    // The org's own screens, under every app.
    { app: null, path: 'agents', label: 'agents' },
    { app: null, path: 'settings', label: 'settings' },
  ],
} as const satisfies ModuleScreens;

const FINANCE_SCREENS = {
  routes: [
    { path: 'documents' },
    { path: 'journal' },
    // Opening balances from Excel (#320), reached from the journal.
    { path: 'bank/matched' },
    { path: 'journal/opening-balances' },
    { path: 'vouchers' },
    // The drafts of the sales e-invoices a business will issue (#2500).
    { path: 'sales-invoices' },
    // The items of stock, their moves and the goods lines not yet assigned to an item (#2512).
    { path: 'stock' },
    { path: 'bank' },
    { path: 'fixed-assets' },
    { path: 'ledger' },
    { path: 'vat' },
    { path: 'portal-invoices' },
    { path: 'customers' },
    // The overdue customers and the reminder mails a person sends (#2488).
    { path: 'payment-reminders' },
    { path: 'vendors' },
    // The Vietnamese quick guide (issue #310), linked from the empty Inbox; it walks through finance screens.
    { path: 'guide', app: 'accounting' },
  ],
  nav: [
    { app: 'accounting', group: 'books', path: 'documents', label: 'documents' },
    { app: 'accounting', group: 'books', path: 'journal', label: 'journal' },
    { app: 'accounting', group: 'books', path: 'vouchers', label: 'vouchers' },
    { app: 'accounting', group: 'books', path: 'sales-invoices', label: 'salesInvoices' },
    { app: 'accounting', group: 'books', path: 'stock', label: 'stock' },
    { app: 'accounting', group: 'books', path: 'bank', label: 'bank' },
    { app: 'accounting', group: 'books', path: 'fixed-assets', label: 'fixedAssets' },
    { app: 'accounting', group: 'books', path: 'ledger', label: 'ledger' },
    // The VAT and the tax portal's list, then the customers, their reminders and the vendors: in the one group of the app, because a headed group each made the menu longer than a
    // 1366x768 window holds once "Hàng hóa" joined it.
    { app: 'accounting', group: 'books', path: 'vat', label: 'vat' },
    { app: 'accounting', group: 'books', path: 'portal-invoices', label: 'portalList' },
    { app: 'accounting', group: 'books', path: 'customers', label: 'customers' },
    { app: 'accounting', group: 'books', path: 'payment-reminders', label: 'paymentReminders' },
    { app: 'accounting', group: 'books', path: 'vendors', label: 'vendors' },
  ],
} as const satisfies ModuleScreens;

const SOCIAL_SCREENS = {
  routes: [
    { path: 'social' },
    { path: 'social/new' },
    { path: 'social/channels' },
    { path: 'social/import' },
    { path: 'social/snippets' },
    { path: 'social/labels' },
    { path: 'social/ideas' },
    { path: 'social/feeds' },
    { path: 'social/bio' },
    { path: 'social/notifications' },
    // The Inbox (CV3, #2306): comments and private messages together, in three panes. The path `inbox` is the kernel's documents Inbox, so Social's is
    // under `social/`. The comment inbox of CV1 (#2303) keeps its address and redirects here.
    { path: 'social/inbox' },
    { path: 'social/comments' },
    { path: 'social/$id' },
    // The content plan to print (#978), outside the org's frame so only the plan reaches the paper.
    { path: 'print/social-plan' },
    // The reports of the one Engage app (#2435): a tab for each area whose module runs (conversations and posts: social; sales: crm;
    // ads: ads). The screen belongs to no one module, so it opens, and its menu item shows, where any of the three runs.
    { path: 'reports', modules: ['social', 'crm', 'ads'] },
  ],
  outside: [
    // A page shared into a new draft (#1235), before the org is known.
    { path: '/-/share' },
    // Where a channel provider's OAuth dialog sends the browser back (S6), one address for every org. The call that
    // finishes it is the kernel's, but only social's channel screen starts an attempt.
    { path: '/channels/oauth/$provider/callback' },
    // A client's review and report links (#589, #643): the token in the fragment is the only credential.
    { path: '/-/review', public: true },
    { path: '/-/report', public: true },
  ],
  // One app, "Ludy Engage" (app id `social`, #2435), with four groups in the order apps/app/src/lib/apps.ts fixes: Hộp thư (`inbox`), Khách hàng & Bán
  // hàng (`sales`, the crm module's), Marketing (`marketing`: posts here, Ads from its module) and Báo cáo (`reports`, a single item).
  nav: [
    // The Hộp thư group (CV3): one Inbox, shown when this module is enabled, with the comments of the org's posts and the private
    // messages together (a private message only to those who may read it).
    { app: 'social', group: 'inbox', path: 'social/inbox', label: 'socialInbox' },
    { app: 'social', group: 'marketing', path: 'social', label: 'social' },
    { app: 'social', group: 'marketing', path: 'social/notifications', label: 'notifications' },
    { app: 'social', group: 'reports', path: 'reports', label: 'reports' },
  ],
} as const satisfies ModuleScreens;

// The crm module's screens sit in the Engage app since #2435 (the rail no longer has a CRM app); the screens keep their addresses. The `crm/...`
// addresses the plan once wrote (docs/plan/crm.md) redirect to them.
const CRM_SCREENS = {
  // Bookings of the public booking page (#1320).
  routes: [
    { path: 'bookings' },
    { path: 'deals' },
    { path: 'contacts' },
    { path: 'contacts/import' },
    // The companies, apart from the people (#2438): the same parties, the kind `organization`.
    { path: 'companies' },
    { path: 'crm' },
    { path: 'crm/bookings' },
    { path: 'crm/deals' },
    { path: 'crm/contacts' },
    { path: 'crm/contacts/import' },
  ],
  // The public booking page (#1318), no account.
  outside: [{ path: '/-/b/$org/$type', public: true }],
  nav: [
    // The contacts: the org's parties with search, filters and saved views (K4, #2228).
    { app: 'social', group: 'sales', path: 'contacts', label: 'contacts' },
    // The companies the people work at (#2438).
    { app: 'social', group: 'sales', path: 'companies', label: 'companies' },
    // The deals of the org's one pipeline (#2225, docs/plan/crm.md).
    { app: 'social', group: 'sales', path: 'deals', label: 'deals' },
    { app: 'social', group: 'sales', path: 'bookings', label: 'bookings' },
  ],
} as const satisfies ModuleScreens;

// Members' notes (#1671, notes plan §3.10): the notes screen (?note= opens one), in the Home app beside the team's tasks.
// My work (#1673): the member's own to-dos, after it.
const NOTES_SCREENS = {
  routes: [{ path: 'notes' }, { path: 'my-work' }],
  nav: [
    { app: 'home', group: 'work', path: 'notes', label: 'notes' },
    { app: 'home', group: 'work', path: 'my-work', label: 'myWork' },
  ],
} as const satisfies ModuleScreens;

// Ads (#2217, ads plan docs/plan/ads.md section 2 "Where Ads sits in the app"): an item of the Marketing group of the Social app on the rail,
// after the posts (#2435). Its module's own entry, so the item shows only where the deployment runs the module; with Social off the app
// still shows, with this item alone.
const ADS_SCREENS = {
  routes: [{ path: 'ads' }, { path: 'ads/campaigns' }],
  nav: [
    { app: 'social', group: 'marketing', path: 'ads', label: 'ads' },
    // The campaign builder (W1c, #2295): drafts, the AI coworker's drafts and the requests for approval; an item of its own, after the figures.
    { app: 'social', group: 'marketing', path: 'ads/campaigns', label: 'adsCampaigns' },
  ],
} as const satisfies ModuleScreens;

export const MODULE_SCREENS = {
  kernel: KERNEL_SCREENS,
  finance: FINANCE_SCREENS,
  social: SOCIAL_SCREENS,
  ads: ADS_SCREENS,
  crm: CRM_SCREENS,
  notes: NOTES_SCREENS,
} as const;

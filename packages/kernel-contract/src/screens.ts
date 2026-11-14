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
    // What waits for the user in this org today (#1249): the landing page of an org (#3225), first in the app switcher and an app of no one.
    { path: 'overview' },
    // The AI Inbox of proposals: the first tab ("Chờ duyệt") of Tài chính > Chứng từ (#3225), where finance runs.
    { path: 'inbox', app: 'finance', find: 'inbox' },
    { path: 'inbox/$id', app: 'finance' },
    // In-app notifications of the kernel and finance (#671), with the unread count: the bell of the shell, not an app (#3225).
    { path: 'notifications' },
    // The team's tasks (ADR-0029) are in Cộng tác; the AI agents are in Ludy AI, with the AI use and the connections of other AI tools (#3225).
    { path: 'tasks' },
    { path: 'tasks/$id', app: 'teamwork' },
    { path: 'agents' },
    { path: 'ai-usage' },
    { path: 'ai-connections' },
    { path: 'settings' },
    // The audit log (#672): owners and admins only, which the page checks and the server enforces.
    { path: 'audit' },
    { path: 'personal-data' },
  ],
  // Signing in and the screens before an org: the landing redirect, the home of several orgs, sign-in, the second
  // factor, a password reset, an invite to accept and a new org.
  outside: [{ path: '/' }, { path: '/clients' }, { path: '/login' }, { path: '/mfa' }, { path: '/reset-password' }, { path: '/-/invite' }, { path: '/-/extension/connect' }, { path: '/oauth/interaction/$uid' }, { path: '/onboarding' }, { path: '/calendar/oauth/$provider/callback' }],
  nav: [
    { app: null, rail: 'top', path: 'overview', label: 'overview' },
    { app: null, rail: 'bell', path: 'notifications', label: 'alerts' },
    { app: 'teamwork', group: 'work', path: 'tasks', label: 'tasks' },
    // The Inbox is Finance's "Chứng từ" (its first tab is "Chờ duyệt"): shown where finance runs.
    { app: 'finance', group: 'books', path: 'inbox', label: 'documents', modules: ['finance'] },
    { app: 'ai', group: 'ai', path: 'agents', label: 'agents' },
    { app: 'ai', group: 'ai', path: 'ai-usage', label: 'aiUsage' },
    { app: 'ai', group: 'ai', path: 'ai-connections', label: 'aiConnections' },
    // The org's own screens, under every app.
    { app: null, rail: 'foot', path: 'settings', label: 'settings' },
  ],
} as const satisfies ModuleScreens;

const FINANCE_SCREENS = {
  routes: [
    // The Tổng quan of the Tài chính app (#2631, #3225): the cash, the profit, what customers owe and what is owed, first in its menu and where opening the app lands.
    { path: 'accounting' },
    // The list of the documents: the second tab of Chứng từ, after the Inbox's "Chờ duyệt".
    { path: 'documents', app: 'finance', find: 'documentsAll' },
    { path: 'journal' },
    // Opening balances from Excel (#320), reached from the journal.
    { path: 'bank/matched' },
    { path: 'journal/opening-balances' },
    { path: 'vouchers' },
    // The drafts of the sales e-invoices a business will issue (#2500).
    { path: 'sales-invoices' },
    // The items of stock, their moves and the goods lines not yet assigned to an item (#2512).
    { path: 'stock' },
    // The books of a household business (#2517): reached from Settings (Pháp nhân) for an entity of kind household, and found with Ctrl K.
    { path: 'household', app: 'finance', find: 'household' },
    // Where each platform's money stands in the books: the Sàn screen (#2516), the second tab of Hàng hóa and found with Ctrl K.
    { path: 'marketplace', app: 'finance', find: 'marketplace' },
    { path: 'bank' },
    { path: 'fixed-assets' },
    { path: 'ledger' },
    { path: 'vat' },
    // The tax portal's list: the second tab of Thuế, after the VAT return.
    { path: 'portal-invoices', app: 'finance', find: 'portalList' },
    { path: 'customers' },
    // The overdue customers and the reminder mails a person sends (#2488): the second tab of Khách hàng.
    { path: 'payment-reminders', app: 'finance', find: 'paymentReminders' },
    { path: 'vendors' },
    // The Vietnamese quick guide (issue #310), linked from the empty Inbox; it walks through finance screens.
    { path: 'guide', app: 'finance' },
  ],
  // The menu of Tài chính (#3225): the overview and the documents first, then Bán hàng, Mua hàng and Sổ sách & Thuế, each a short list (apps/app/src/lib/apps.ts fixes the order). The
  // Inbox is the kernel's, shown in the first group as "Chứng từ".
  nav: [
    { app: 'finance', group: 'books', path: 'accounting', label: 'accountingOverview' },
    { app: 'finance', group: 'books', path: 'vouchers', label: 'vouchers' },
    { app: 'finance', group: 'books', path: 'bank', label: 'bank' },
    { app: 'finance', group: 'sell', path: 'sales-invoices', label: 'salesInvoices' },
    { app: 'finance', group: 'sell', path: 'customers', label: 'customers' },
    { app: 'finance', group: 'sell', path: 'stock', label: 'stock' },
    { app: 'finance', group: 'buy', path: 'vendors', label: 'vendors' },
    { app: 'finance', group: 'ledger', path: 'journal', label: 'journal' },
    { app: 'finance', group: 'ledger', path: 'ledger', label: 'ledger' },
    { app: 'finance', group: 'ledger', path: 'fixed-assets', label: 'fixedAssets' },
    { app: 'finance', group: 'ledger', path: 'vat', label: 'tax' },
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
    // The updates of the posts: the second tab of Bài đăng (#3225).
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
  // One app, "Engage" (app id `engage`, #2435, #3225), with four groups in the order apps/app/src/lib/apps.ts fixes: Hộp thư (`inbox`), CRM (`crm`, the crm module's),
  // Marketing (`marketing`: posts here, Ads from its module) and Báo cáo (`reports`, a single item).
  nav: [
    // The Hộp thư group (CV3): one Inbox, shown when this module is enabled, with the comments of the org's posts and the private
    // messages together (a private message only to those who may read it).
    { app: 'engage', group: 'inbox', path: 'social/inbox', label: 'socialInbox' },
    // The post updates are a tab of Bài đăng, not an item of their own.
    { app: 'engage', group: 'marketing', path: 'social', label: 'social' },
    { app: 'engage', group: 'marketing', path: 'social/notifications', label: 'socialNotifications' },
    { app: 'engage', group: 'reports', path: 'reports', label: 'reports' },
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
    { path: 'crm', app: 'engage' },
    { path: 'crm/bookings', app: 'engage' },
    { path: 'crm/deals', app: 'engage' },
    { path: 'crm/contacts', app: 'engage' },
    { path: 'crm/contacts/import', app: 'engage' },
  ],
  // The public booking page (#1318) and a sent quote's page (#2694), no account.
  outside: [{ path: '/-/b/$org/$type', public: true }, { path: '/-/quote', public: true }],
  nav: [
    // The contacts: the org's parties with search, filters and saved views (K4, #2228).
    { app: 'engage', group: 'crm', path: 'contacts', label: 'contacts' },
    // The companies the people work at (#2438).
    { app: 'engage', group: 'crm', path: 'companies', label: 'companies' },
    // The deals of the org's one pipeline (#2225, docs/plan/crm.md).
    { app: 'engage', group: 'crm', path: 'deals', label: 'deals' },
    { app: 'engage', group: 'crm', path: 'bookings', label: 'bookings' },
  ],
} as const satisfies ModuleScreens;

// Members' notes (#1671, notes plan §3.10): the notes screen (?note= opens one), in Cộng tác beside the team's tasks (#3225).
// My work (#1673): the member's own to-dos, after it.
const NOTES_SCREENS = {
  routes: [{ path: 'notes' }, { path: 'my-work' }],
  nav: [
    { app: 'teamwork', group: 'work', path: 'notes', label: 'notes' },
    { app: 'teamwork', group: 'work', path: 'my-work', label: 'myWork' },
  ],
} as const satisfies ModuleScreens;

// Ads (#2217, ads plan docs/plan/ads.md section 2 "Where Ads sits in the app"): an item of the Marketing group of the Social app on the rail,
// after the posts (#2435). Its module's own entry, so the item shows only where the deployment runs the module; with Social off the app
// still shows, with this item alone.
const ADS_SCREENS = {
  // The campaign builder (W1c, #2295): drafts, the AI coworker's drafts and the requests for approval; the second tab of Quảng cáo, after the figures (#3225).
  routes: [{ path: 'ads' }, { path: 'ads/campaigns', find: 'adsCampaigns' }],
  nav: [{ app: 'engage', group: 'marketing', path: 'ads', label: 'ads' }],
} as const satisfies ModuleScreens;

// HR (#2530, payroll plan 6.1): the people payroll is run for, in an app of its own (Ludy Nhân sự, owner decision 2026-11-04). Owners and admins only, which the database's policies and
// every query enforce; the item is hidden from everyone else by the app's role check.
const HR_SCREENS = {
  // The bank templates of the salary file are the second tab of Bảng lương (#3225).
  routes: [{ path: 'hr/employees' }, { path: 'hr/payroll' }, { path: 'hr/declarations' }, { path: 'hr/bank-templates', find: 'bankTemplates' }],
  nav: [
    { app: 'hr', group: 'people', path: 'hr/employees', label: 'employees' },
    { app: 'hr', group: 'people', path: 'hr/payroll', label: 'payroll' },
    { app: 'hr', group: 'people', path: 'hr/declarations', label: 'declarations' },
  ],
} as const satisfies ModuleScreens;

// AI Meeting Notes (issue #2576, ADR-0047, meetings plan M2): "Cuộc họp" is an item of Cộng tác (#3225); the Cuộc họp tab inside Ghi chú stays; the in-app recorder at /o/$slug/meetings/record (M7, #2581)
// and individual meetings at /o/$slug/meetings/$id belong to the same app. The printable minutes ("Xem biên bản", A4, #3162) are outside the org's frame so only the sheet reaches the paper.
export const MEETINGS_SCREENS = {
  routes: [{ path: 'meetings' }, { path: 'meetings/record' }, { path: 'meetings/$id' }, { path: 'print/meeting-minutes/$id' }],
  nav: [{ app: 'teamwork', group: 'work', path: 'meetings', label: 'meetings' }],
} as const satisfies ModuleScreens;

export const MODULE_SCREENS = {
  kernel: KERNEL_SCREENS,
  finance: FINANCE_SCREENS,
  hr: HR_SCREENS,
  social: SOCIAL_SCREENS,
  ads: ADS_SCREENS,
  crm: CRM_SCREENS,
  notes: NOTES_SCREENS,
  meetings: MEETINGS_SCREENS,
} as const;

// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworkers on ludy.vn (DESIGN.md 1.1, issues #2409 and #2440): one roster, keyed by what each coworker COVERS, never
// by name (the owner's decisions, 2026-11-02 and 2026-11-03: Ludy CRM folds into Ludy Engage, default names an org can rename).
// The copy files read the names from here (`N.finance`, `N.sales`), so a name is a change of one line in this file and the copy
// is never edited for it. The app has its own roster by the same keys (packages/kernel-contract/src/coworkers.ts); the two are
// kept in step by hand.
export type CoworkerKey = 'gm' | 'finance' | 'sales' | 'marketing' | 'system';

interface Coworker {
  name: string;
  // The job title, in each language.
  title: { vi: string; en: string };
  // What the coworker does today, in each language: only work that ships (DESIGN.md 6.2). A coworker with no scope is not
  // shown on the site.
  scope?: { vi: string; en: string };
}

export const ROSTER: Readonly<Record<CoworkerKey, Coworker>> = {
  // The general manager across every app and Ludy Cộng tác.
  gm: {
    name: 'Vy',
    title: { vi: 'Tổng quản', en: 'General manager' },
    scope: { vi: 'Điều phối cả đội, xuyên suốt mọi ứng dụng', en: 'Coordinates the whole team, across every app' },
  },
  // Ludy Tài chính and Ludy Nhân sự (#3225).
  finance: {
    name: 'Ly',
    title: { vi: 'Giám đốc tài chính', en: 'CFO' },
    scope: { vi: 'Ludy Tài chính và Nhân sự: đọc hoá đơn, soạn sẵn bút toán và rà bảng lương', en: 'Ludy Finance and HR: reads invoices, drafts the entries and reviews payroll' },
  },
  // Ludy Engage's Inbox and CRM (customers and sales).
  sales: {
    name: 'Dy',
    title: { vi: 'Trưởng phòng bán hàng và chăm sóc khách hàng', en: 'Head of sales and customer care' },
    // CRM is the group of Ludy Engage that the former Ludy CRM folded into (#2435, #2440, #3225).
    scope: { vi: 'Ludy Engage: Hộp thư và CRM (khách hàng và bán hàng)', en: 'Ludy Engage: the Inbox and CRM (customers and sales)' },
  },
  // Ludy Engage's marketing: publishing and ads.
  marketing: {
    name: 'Uy',
    title: { vi: 'Giám đốc marketing', en: 'CMO' },
    scope: { vi: 'Ludy Engage: marketing, soạn và lên lịch bài đăng', en: 'Ludy Engage: marketing, drafting and scheduling posts' },
  },
  // Reserved: no scope, so the site does not list it.
  system: { name: 'Hy', title: { vi: 'Giám đốc công nghệ', en: 'CTO' } },
};

// The names, by key, for the copy to read: `${N.finance}`.
export const N: Readonly<Record<CoworkerKey, string>> = {
  gm: ROSTER.gm.name,
  finance: ROSTER.finance.name,
  sales: ROSTER.sales.name,
  marketing: ROSTER.marketing.name,
  system: ROSTER.system.name,
};

// The team block of the agents section: every coworker that has work to show, the general manager first.
export function team(lang: 'vi' | 'en'): Array<{ name: string; role: string; scope: string }> {
  return (Object.values(ROSTER) as Coworker[]).flatMap((c) => (c.scope ? [{ name: c.name, role: c.title[lang], scope: c.scope[lang] }] : []));
}

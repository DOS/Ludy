// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworkers on ludy.vn (DESIGN.md 1.1, issue #2409): one roster, keyed by ROLE, never by name. The copy files read the
// names from here (`N.finance`, `N.sales`), so a name is a change of one line in this file and the copy is never edited for it.
// The names are proposed, not final (owner decision pending, 2026-11-02); the app has its own roster by the same roles
// (packages/kernel-contract/src/coworkers.ts); the two are kept in step by hand.
export type CoworkerRole = 'gm' | 'finance' | 'sales' | 'marketing' | 'system';

interface Coworker {
  name: string;
  // The job title, in each language.
  title: { vi: string; en: string };
  // What the coworker does today, in each language: only work that ships (DESIGN.md 6.2). A role with no scope is not
  // shown on the site.
  scope?: { vi: string; en: string };
}

export const ROSTER: Readonly<Record<CoworkerRole, Coworker>> = {
  gm: {
    name: 'Vy',
    title: { vi: 'Tổng quản', en: 'General manager' },
    scope: { vi: 'Điều phối cả đội, xuyên suốt mọi ứng dụng', en: 'Coordinates the whole team, across every app' },
  },
  finance: {
    name: 'Ly',
    title: { vi: 'Giám đốc tài chính', en: 'CFO' },
    scope: { vi: 'Ludy Kế toán: đọc hoá đơn và soạn sẵn bút toán', en: 'Ludy Accounting: reads invoices and drafts the entries' },
  },
  sales: {
    name: 'Dy',
    title: { vi: 'Trưởng phòng bán hàng và chăm sóc khách hàng', en: 'Head of sales and customer care' },
    scope: { vi: 'Ludy CRM: gợi ý giờ hẹn và soạn thư trả lời', en: 'Ludy CRM: suggests meeting times and drafts the reply' },
  },
  marketing: {
    name: 'Uy',
    title: { vi: 'Giám đốc marketing', en: 'CMO' },
    scope: { vi: 'Social và Ads: soạn và lên lịch bài đăng', en: 'Social and Ads: drafts and schedules posts' },
  },
  // Reserved for a future app: no scope, so the site does not list it.
  system: { name: 'Hy', title: { vi: 'Giám đốc công nghệ', en: 'CTO' } },
};

// The names, by role, for the copy to read: `${N.finance}`.
export const N: Readonly<Record<CoworkerRole, string>> = {
  gm: ROSTER.gm.name,
  finance: ROSTER.finance.name,
  sales: ROSTER.sales.name,
  marketing: ROSTER.marketing.name,
  system: ROSTER.system.name,
};

// The team block of the agents section: every role that has work to show, the general manager first.
export function team(lang: 'vi' | 'en'): Array<{ name: string; role: string; scope: string }> {
  return (Object.values(ROSTER) as Coworker[]).flatMap((c) => (c.scope ? [{ name: c.name, role: c.title[lang], scope: c.scope[lang] }] : []));
}

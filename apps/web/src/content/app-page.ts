// SPDX-License-Identifier: AGPL-3.0-only
// The copy every app page shares the shape of (/ke-toan, /en/accounting, and the pages of the other apps). The layout is
// components/apps/app-page.tsx; an app adds its own fragments (the pieces of the product it draws) and their copy in
// its own file, e.g. accounting-vi.ts. Both languages are typed from the Vietnamese file, as the home page's are, so a
// string missing from the English copy fails typecheck. Claims follow DESIGN.md 6.2: only what is merged and usable on
// main today, planned work labelled as such.
export interface AppPageCopy {
  // The product's name as DESIGN.md 1.1 spells it in this language.
  appName: string;
  meta: { title: string; description: string };
  // The social preview line under the title; the page title is the image's headline.
  ogTitle: string;
  crumbLabel: string;
  hero: { title: string; lead: string; primary: string; secondary: string; note: string };
  // The sequence the product follows, as numbered steps with what each one leaves behind.
  how: { title: string; lead: string; steps: ReadonlyArray<{ name: string; body: string; outcome: string; tone: 'ok' | 'warn' | 'accent' | 'neutral' }> };
  groups: {
    title: string;
    lead: string;
    items: ReadonlyArray<{ id: string; title: string; lead: string; points: readonly string[] }>;
  };
  soon?: { title: string; lead: string; label: string; items: ReadonlyArray<{ title: string; body: string }> };
  assistant?: { title: string; lead: string; doesTitle: string; does: readonly string[]; doesNotTitle: string; doesNot: readonly string[] };
  audience: { title: string; lead: string; items: ReadonlyArray<{ title: string; body: string }> };
  faq: { title: string; items: ReadonlyArray<{ q: string; a: string }> };
  cta: { title: string; body: string; primary: string; secondary: string };
}

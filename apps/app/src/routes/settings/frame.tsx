// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { ErrorText, PageHeader, PageSkeleton } from '../../components/ui.tsx';
import { errorMessage, orpc } from '../../lib/api.ts';
import { installedModules, useModulesVersion } from '../../lib/org-modules.ts';

const useOrg = () => useQuery(orpc.org.get.queryOptions());
const useMe = () => useQuery(orpc.me.get.queryOptions());

export interface SettingsContext {
  org: NonNullable<ReturnType<typeof useOrg>['data']>;
  me: ReturnType<typeof useMe>['data'];
  // Owners and admins change the org's settings; everyone else sees them.
  canManage: boolean;
  isOwner: boolean;
  // The modules the org runs, read when the frame renders, which it does again when the org's apps change: a page reads them here, never once outside the render function.
  modules: string[];
}

// The frame every Settings sub-page shares: the title, the org read, and a one-column list of cards (ST-8: no two-column grid, so no card leaves half a row empty). The Settings navigation
// menu is rendered by the shell in the left sidebar (#4499). "Cài đặt lịch hẹn" and "Tạo loại lịch hẹn" on Lịch hẹn, the quote and sales-process links and the like point at a card of a
// Settings page by its #fragment (#3643). The cards come in as the reads answer (the org, the member, then the cards grow with their own lists), so the jump waits for the card, keeps it at
// the top while the page settles, and lets go at the first touch, wheel or key of the person, or after five seconds.
export function SettingsFrame({ children }: { children: (context: SettingsContext) => ReactNode }) {
  // Re-renders when the org's apps change, so the cards of an app that was switched off or on come and go (the shell does not remount this screen: its switches keep their focus).
  useModulesVersion();
  const t = useTranslations('settings');
  const org = useOrg();
  const me = useMe();
  const { hash } = useLocation();
  const ready = org.data !== undefined && me.data !== undefined;
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    const first = id ? document.getElementById(id) : null;
    if (!ready || !id || !first) return;
    const align = () => document.getElementById(id)?.scrollIntoView({ block: 'start' });
    align();
    first.focus({ preventScroll: true });
    const observer = new ResizeObserver(align);
    if (first.parentElement) observer.observe(first.parentElement);
    const events = ['wheel', 'touchmove', 'keydown', 'mousedown'] as const;
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
      for (const type of events) window.removeEventListener(type, stop);
    };
    const timer = setTimeout(stop, 5000);
    for (const type of events) window.addEventListener(type, stop, { passive: true });
    return stop;
  }, [ready, hash]);

  if (org.isLoading) return <PageSkeleton body="cards" />;
  if (org.error) return <ErrorText>{errorMessage(org.error)}</ErrorText>;
  if (!org.data) return null;
  const canManage = org.data.role === 'owner' || org.data.role === 'admin';
  return (
    <>
      <PageHeader title={t('title')} subtitle={org.data.name} />
      {/* Sibling cards keyed by the org carry a key of their own: with one key shared, React loses a card when a slot before it renders nothing, and the old one stays in the page next to its new copy. */}
      <div className="grid max-w-4xl gap-6">{children({ org: org.data, me: me.data, canManage, isOwner: org.data.role === 'owner', modules: installedModules() })}</div>
    </>
  );
}

// A card of a tab that other screens link to: the anchor, focusable so the jump lands the reader on it.
export function Anchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} tabIndex={-1} className="scroll-mt-20 outline-none">
      {children}
    </div>
  );
}

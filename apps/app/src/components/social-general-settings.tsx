// SPDX-License-Identifier: AGPL-3.0-only
// "Cài đặt chung" of the Channels screen (#3651): the settings of the whole Engage line (voice, watermark, report branding,
// publish hold, banned words, review checklist, channel access, chat alert, share, channel sets, saved replies) sit below
// the channel list in one group, so the first thing on a phone is the connect card and the channels, not a pile of
// settings. Folded on a phone, open from 1024 px up (where it sits under the channels, out of the way of the connect card).
// The cards stay mounted while folded, so a half-typed setting is kept.
import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { cn } from '@crove/ui/lib/utils';

// The width at which the page has two columns (Tailwind's lg).
const WIDE = '(min-width: 1024px)';

export function startsOpen(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches;
}

export function GeneralSettings({ children, open: initial }: { children: ReactNode; open?: boolean }) {
  const t = useTranslations('social');
  const [open, setOpen] = useState(() => initial ?? startsOpen());
  const id = useId();
  return (
    <section className="space-y-3" aria-label={t('generalSettingsTitle')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span>
          <span className="block text-sm font-medium text-foreground">{t('generalSettingsTitle')}</span>
          <span className="block text-xs text-subtle-foreground">{t('generalSettingsHint')}</span>
        </span>
        <span aria-hidden="true" className={cn('text-muted-foreground transition-transform', open && 'rotate-180')}>
          ▾
        </span>
      </button>
      <div id={id} hidden={!open} className="space-y-3">
        {children}
      </div>
    </section>
  );
}

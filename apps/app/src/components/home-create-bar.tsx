// SPDX-License-Identifier: AGPL-3.0-only
// The create actions of Home on a phone (#4784): the 3 or 4 jobs a small business does every week, in a row at the foot of
// the screen where the thumb rests (the same PhoneActionBar the record screens use). Plain links, so each opens the screen
// where the coworker has already read or drafted; nothing is created, approved or sent from here. Hidden from sm up, where the
// Global Top Bar `+` and the desktop Home carry the same actions.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { buttonVariants } from '@ludy/ui/components/button';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import { homeCreateItems, type QuickCreateItem } from '../lib/quick-create.ts';
import { PhoneActionBar } from './ui.tsx';

export function HomeCreateBar({ slug, items }: { slug: string; items: readonly QuickCreateItem[] }) {
  const t = useTranslations('nav.quickCreate');
  const picked = homeCreateItems(items);
  if (picked.length === 0) return null;
  return (
    <>
      {/* Room for the bar below, so the last of Home is not hidden under it. */}
      <div aria-hidden="true" className="h-[calc(9.5rem+env(safe-area-inset-bottom))] sm:hidden" />
      <PhoneActionBar data-testid="home-create-bar" aria-label={t('homeRow')} className="grid grid-cols-2 items-stretch justify-stretch">
        {picked.map((item, index) => (
          <Link
            key={item.id}
            to={item.to}
            params={{ slug }}
            {...(item.search ? { search: item.search as never } : {})}
            data-testid={`home-create-${item.id}`}
            className={cn(
              buttonVariants({ variant: index === 0 ? 'default' : 'outline', size: 'lg' }),
              'h-auto min-h-11 justify-center gap-2 px-3 py-2 text-center whitespace-normal',
              // An odd last link takes the whole row instead of leaving a hole.
              picked.length % 2 === 1 && index === picked.length - 1 && 'col-span-2',
            )}
          >
            <NavIcon name={item.icon} />
            <span>{t(item.id)}</span>
          </Link>
        ))}
      </PhoneActionBar>
    </>
  );
}

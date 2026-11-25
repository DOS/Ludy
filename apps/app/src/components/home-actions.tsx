// SPDX-License-Identifier: AGPL-3.0-only
// The row of fixed create actions at the top of Home (UI/UX P2-2, #4783): the jobs an owner starts most, one tap each. The names and targets are
// HOME_ACTIONS in lib/home-actions.ts. Each opens a screen where the finance or sales coworker has already read or drafted; a person still
// approves money and messages there, so nothing is created from this row.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { buttonVariants } from '@ludy/ui/components/button';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import type { HomeAction } from '../lib/home-actions.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

export function HomeActions({ slug, actions }: { slug: string; actions: readonly HomeAction[] }) {
  const t = useTranslations('overview.actions');
  if (actions.length === 0) return null;
  return (
    <nav aria-label={t('label')} data-testid="home-actions" className="mb-4">
      {/* Two to a line on a phone (44 px targets within thumb reach), one row from sm. */}
      <ul className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {actions.map((action, index) => (
          <li key={action.id} className="min-w-0">
            <Link
              to={action.to}
              params={{ slug }}
              {...(action.search ? { search: action.search as never } : {})}
              data-testid={`home-action-${action.id}`}
              className={cn(buttonVariants({ variant: index === 0 ? 'default' : 'outline' }), 'w-full justify-start gap-2 sm:w-auto', PHONE_TARGET)}
            >
              <NavIcon name={action.icon} />
              <span className="truncate">{t(`items.${action.id}`)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

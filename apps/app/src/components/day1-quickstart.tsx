// SPDX-License-Identifier: AGPL-3.0-only
// Three-step Day-1 SME quick-start panel shown on Home when a brand-new org has zero active work (#4644).
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { buttonVariants } from '@ludy/ui/components/button';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import type { QuickStartStep } from '../lib/overview.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

export function Day1QuickStart({
  slug,
  steps,
  financeOn,
}: {
  slug: string;
  steps: readonly QuickStartStep[];
  financeOn: boolean;
}) {
  const t = useTranslations('today.quickstart');
  if (steps.length === 0) return null;

  return (
    <div data-testid="overview-quickstart">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
          <p className="mt-0.5 text-xs text-subtle-foreground">{t('subtitle')}</p>
        </div>
        {financeOn && (
          <Link to="/o/$slug/guide" params={{ slug }} className={cn('text-xs text-link hover:underline', PHONE_TARGET)}>
            {t('guideLink')}
          </Link>
        )}
      </div>
      <ol className={cn('grid divide-y md:divide-x md:divide-y-0', steps.length >= 3 ? 'md:grid-cols-3' : steps.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-1')}>
        {steps.map((step, index) => (
          <li key={step.id} data-testid={`quickstart-step-${step.id}`} className="flex flex-col gap-2.5 p-4">
            <div className="flex items-center gap-2">
              <span
                aria-label={t('stepLabel', { step: String(index + 1) })}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-xs font-medium tabular-nums text-foreground"
              >
                {index + 1}
              </span>
              <NavIcon name={step.icon} className="text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">{t(`steps.${step.id}.title`)}</span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t(`steps.${step.id}.description`)}</p>
            <div className="mt-auto pt-1">
              <Link
                to={step.to}
                params={{ slug }}
                className={cn(buttonVariants({ variant: index === 0 ? 'default' : 'outline', size: 'sm' }), 'w-full sm:w-auto', PHONE_TARGET)}
              >
                {t(`steps.${step.id}.action`)}
              </Link>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// The day-1 "Bắt đầu" card on Home (#4644, #4783): up to three steps for a new org. It is its own card under the queue; Home hides it once the
// org's first invoice is approved (lib/home-actions.ts showStartCard) and the member can close it with the button.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import type { QuickStartStep } from '../lib/overview.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

export function Day1QuickStart({
  slug,
  steps,
  financeOn,
  onDismiss,
}: {
  slug: string;
  steps: readonly QuickStartStep[];
  financeOn: boolean;
  onDismiss: () => void;
}) {
  const t = useTranslations('today.quickstart');
  if (steps.length === 0) return null;

  return (
    <section aria-labelledby="overview-quickstart-title" data-testid="overview-quickstart" className="mt-4">
      <Card className="block overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-3">
          <div>
            <h2 id="overview-quickstart-title" className="text-sm font-semibold text-foreground">
              {t('title', { count: steps.length })}
            </h2>
            <p className="mt-0.5 text-xs text-subtle-foreground">{t('subtitle')}</p>
          </div>
          <div className="flex items-center gap-3">
            {financeOn && (
              <Link to="/o/$slug/guide" params={{ slug }} className={cn('text-xs text-link hover:underline', PHONE_TARGET)}>
                {t('guideLink')}
              </Link>
            )}
            <Button type="button" variant="ghost" size="sm" data-testid="quickstart-dismiss" onClick={onDismiss}>
              {t('dismiss')}
            </Button>
          </div>
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
                  {...(step.hash ? { hash: step.hash } : {})}
                  className={cn(buttonVariants({ variant: index === 0 ? 'default' : 'outline', size: 'sm' }), 'w-full sm:w-auto', PHONE_TARGET)}
                >
                  {t(`steps.${step.id}.action`)}
                </Link>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </section>
  );
}

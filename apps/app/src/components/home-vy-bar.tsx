// SPDX-License-Identifier: AGPL-3.0-only
// Compact inline Vy prompt bar inside/adjacent to "Hôm nay cần bạn" on Global Home (#4923 Phase 4, #4928).
// Gated on `vy.use` and `orpc.ai.meter`; stays deterministic when AI is off or out of budget, and never bypasses human approval.
import { useId, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { AiMeter } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import { buildHomeVyChips, dispatchOpenVyDrawer } from '../lib/home-vy.ts';
import type { Role } from '../lib/members.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';
import { resolveVyDrawerStatus } from '../lib/vy.ts';

export function HomeVyBar({
  slug,
  gmName,
  canUseVy,
  permissionsLoaded,
  canApproveFinance,
  canViewAiBudgets,
  aiMeter,
  role,
  modules,
}: {
  slug: string;
  gmName: string;
  canUseVy: boolean;
  permissionsLoaded: boolean;
  canApproveFinance: boolean;
  canViewAiBudgets: boolean;
  aiMeter: AiMeter | undefined;
  role: Role | undefined;
  modules: readonly string[];
}) {
  const t = useTranslations('overview.vy');
  const inputId = useId();
  const [prompt, setPrompt] = useState('');

  if (!permissionsLoaded || aiMeter === undefined) return null;

  const status = resolveVyDrawerStatus({ canUseVy, permissionsLoaded, meter: aiMeter });
  if (status === 'noPermission') return null;

  if (status === 'aiOff' || status === 'budgetStop') {
    return (
      <div
        data-testid="home-vy-status"
        data-vy-status={status}
        className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground"
      >
        <span className="flex min-w-0 items-center gap-2">
          <NavIcon name="appAi" className="size-3.5 text-muted-foreground" />
          <span>{status === 'aiOff' ? t('aiOff', { name: gmName }) : t('budgetStop', { name: gmName })}</span>
        </span>
        {status === 'budgetStop' && canViewAiBudgets && (
          <Link to="/o/$slug/ai-usage" params={{ slug }} className={cn('shrink-0 text-link hover:underline', PHONE_TARGET)}>
            {t('budgetLink')}
          </Link>
        )}
      </div>
    );
  }

  const chips = buildHomeVyChips({ modules, role, canApproveFinance });
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = prompt.trim();
    dispatchOpenVyDrawer(trimmed ? { prompt: trimmed } : {});
    if (trimmed) setPrompt('');
  };

  return (
    <section
      aria-label={t('label', { name: gmName })}
      data-testid="home-vy-bar"
      data-vy-status="ready"
      className="mt-2.5 rounded-xl border bg-card px-3 py-2"
    >
      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
        <NavIcon name="appAi" className="size-4 text-proposal" />
        <label htmlFor={inputId} className="sr-only">
          {t('inputLabel', { name: gmName })}
        </label>
        <Input
          id={inputId}
          value={prompt}
          maxLength={300}
          placeholder={t('placeholder', { name: gmName })}
          onChange={(event) => setPrompt(event.target.value)}
          data-testid="home-vy-input"
          className="h-8 min-w-44 flex-1 text-sm max-md:min-h-11"
        />
        <Button type="submit" variant="outline" size="sm" data-testid="home-vy-submit">
          {t('submit', { name: gmName })}
        </Button>
      </form>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        {chips.length > 0 && (
          <ul className="flex flex-wrap items-center gap-1.5" data-testid="home-vy-chips">
            {chips.map((chip) => (
              <li key={chip.id}>
                <Link
                  to={chip.to}
                  params={{ slug }}
                  data-testid={`home-vy-chip-${chip.id}`}
                  className={cn(
                    'inline-flex items-center rounded-md border bg-muted/40 px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    PHONE_TARGET,
                  )}
                >
                  {t(`chips.${chip.id}`)}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-subtle-foreground" data-testid="home-vy-approval-note">
          {t('approvalNote')}
        </p>
      </div>
    </section>
  );
}

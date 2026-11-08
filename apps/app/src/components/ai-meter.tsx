// SPDX-License-Identifier: AGPL-3.0-only
// The small meter wherever Vy works (#2382): where this org's AI budget of the month stands. A warning from the budget's
// warning percentage (80% unless the owner chose another) and the stop message at 100%; with no AI endpoint it says AI is
// off. The core never depends on it: the books, approvals and exports keep working with AI off or out of budget. Every
// member sees it; it shows percentages only, never amounts.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { cn } from '@crove/ui/lib/utils';
import { useFormat } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';

const TONE = { ok: 'text-muted-foreground', warn: 'text-warning', stop: 'text-destructive' } as const;
const BAR = { ok: 'bg-primary', warn: 'bg-warning', stop: 'bg-destructive' } as const;

// module: the module whose panel this is, so a budget set for it counts too ('finance' in the Inbox, 'social' in the
// composer). compact: one line, no reset date.
export function AiMeter({ module, className }: { module?: string; className?: string }) {
  const t = useTranslations('aiMeter');
  const f = useFormat();
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: module ? { module } : {} }), refetchInterval: 60_000, staleTime: 15_000 });
  const data = meter.data;
  if (!data) return null;
  if (!data.aiOn) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)} data-testid="ai-meter" data-state="off">
        {t('off')}
      </p>
    );
  }
  // No budget covers this panel: nothing to show beyond what the owner sees in Settings.
  if (data.state === 'none' || data.percent === null) return null;
  const state = data.state;
  return (
    <div className={cn('space-y-1', className)} data-testid="ai-meter" data-state={state}>
      <div
        className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={data.percent}
        aria-label={t(state, { percent: String(data.percent) })}
      >
        <div className={cn('h-full', BAR[state])} style={{ width: `${data.percent}%` }} />
      </div>
      <p className={cn('text-xs', TONE[state])}>
        {t(state, { percent: String(data.percent) })}
        {state !== 'ok' ? <span className="text-subtle-foreground"> {t('resets', { date: f.date(data.resetAt) })}</span> : null}
      </p>
    </div>
  );
}

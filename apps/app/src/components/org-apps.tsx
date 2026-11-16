// SPDX-License-Identifier: AGPL-3.0-only
// Settings "Ứng dụng" (ADR-0053, slice d of #3307): one switch per app the build ships, every app on with no setup. An owner or admin switches an app off or on
// (kernel.org.set_app, audited); every other member sees the same list read-only. Turning an app off asks first and says what it keeps: the data, and the connections,
// which pause; an app that is busy (an open recording) refuses with its own message. The AI coworker here: none acts, every change is a person's. Menus and screens follow
// the answer of kernel.org.apps through lib/org-modules.ts, not this card.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Card } from '@crove/ui/components/card';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText, RowsSkeleton } from './ui.tsx';

// The apps the messages name; one the build adds later shows its id until it has a name.
const NAMED = ['finance', 'social', 'ads', 'crm', 'notes', 'hr', 'meetings', 'projects', 'sign'] as const;
type Named = (typeof NAMED)[number];
const isNamed = (id: string): id is Named => (NAMED as readonly string[]).includes(id);
// The apps that hold connections or public addresses, whose confirmation says what stays and pauses.
const KEEPS = ['finance', 'social', 'ads', 'crm', 'meetings'] as const;
type Keeps = (typeof KEEPS)[number];
const keepsText = (id: string): id is Keeps => (KEEPS as readonly string[]).includes(id);

export function OrgAppsCard() {
  const t = useTranslations('orgApps');
  const apps = useQuery(orpc.org.apps.queryOptions());
  const [asking, setAsking] = useState<string | null>(null);
  const set = useMutation(
    orpc.org.setApp.mutationOptions({
      // The shell reads the list again (the stream's hint does the same in other tabs), so the menus change at once.
      onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.org.apps.key() }),
    }),
  );
  const nameOf = (id: string) => (isNamed(id) ? t(`names.${id}`) : id);
  if (apps.isLoading) return <RowsSkeleton />;
  if (!apps.data) return apps.isError ? <ErrorText>{errorMessage(apps.error)}</ErrorText> : null;
  const rows = apps.data.apps.filter((a) => a.deployment);
  if (rows.length === 0) return null;
  const canChange = apps.data.canChange;
  const change = (module: string, enabled: boolean) => {
    set.reset();
    set.mutate({ module, enabled });
  };
  const target = rows.find((a) => a.id === asking);
  return (
    <Card className="block space-y-3 p-4" data-testid="org-apps">
      <div>
        <h2 className="text-sm font-medium text-muted-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-subtle-foreground">{t('hint')}</p>
      </div>
      <ul className="divide-y rounded-lg border">
        {rows.map((app) => {
          const status = !app.entitled ? 'notInPlan' : app.enabled ? 'on' : 'off';
          return (
            <li key={app.id} className="flex items-center justify-between gap-3 p-3 text-sm" data-testid={`org-app-${app.id}`}>
              <label className="flex min-w-0 items-center gap-2 text-foreground">
                <input
                  type="checkbox"
                  checked={app.enabled && app.entitled}
                  disabled={!canChange || !app.entitled || set.isPending}
                  aria-label={t('switchLabel', { app: nameOf(app.id) })}
                  onChange={(e) => (e.target.checked ? change(app.id, true) : setAsking(app.id))}
                />
                <span className="font-medium">{nameOf(app.id)}</span>
              </label>
              <Badge variant={status === 'on' ? 'default' : 'outline'}>{t(`status.${status}`)}</Badge>
            </li>
          );
        })}
      </ul>
      {!canChange && <p className="text-xs text-subtle-foreground">{t('readOnly')}</p>}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
      {target && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setAsking(null)}
          title={t('offTitle', { app: nameOf(target.id) })}
          description={`${t('offBody', { app: nameOf(target.id) })} ${keepsText(target.id) ? t(`keeps.${target.id}`) : t('keeps.other')}`}
          confirm={t('offConfirm')}
          cancel={t('keep')}
          destructive
          onConfirm={() => change(target.id, false)}
        />
      )}
    </Card>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Settings "Ứng dụng & Phân hệ" (ADR-0053, slice d of #3307): toggle per-org switchable modules grouped under their
// Apps in switcher order. Every module starts on with no setup. An owner or admin switches one off or on
// (kernel.org.set_app, audited); every other member sees the same list read-only. Turning one off asks first and says
// what it keeps: the data, and any connections, which pause; busy work (an open recording or live ad launch) refuses
// with its own message. Menus and screens follow the answer of kernel.org.apps through lib/org-modules.ts.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { APP_IDS, isKnownModule, modulesOfApp, type AppId } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Card } from '@ludy/ui/components/card';
import { Switch } from '@ludy/ui/components/switch';
import { cn } from '@ludy/ui/lib/utils';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText, RowsSkeleton } from './ui.tsx';

// The modules that hold connections or public addresses, whose confirmation says what stays and pauses.
const KEEPS = ['finance', 'social', 'ads', 'crm', 'meetings'] as const;
type Keeps = (typeof KEEPS)[number];
const keepsText = (id: string): id is Keeps => (KEEPS as readonly string[]).includes(id);

interface OrgAppEntry {
  readonly id: string;
  readonly deployment: boolean;
  readonly entitled: boolean;
  readonly enabled: boolean;
  readonly effective: boolean;
}

type OrgAppsSection =
  | { readonly kind: 'single'; readonly row: OrgAppEntry }
  | { readonly kind: 'group'; readonly appId: AppId; readonly rows: readonly OrgAppEntry[] };

function groupByApp(rows: readonly OrgAppEntry[]): OrgAppsSection[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const used = new Set<string>();
  const sections: OrgAppsSection[] = [];
  for (const appId of APP_IDS) {
    const appModules = modulesOfApp(appId);
    const matched = appModules.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      used.add(id);
      return [row];
    });
    if (matched.length === 0) continue;
    if (appModules.length === 1 && matched[0]) {
      sections.push({ kind: 'single', row: matched[0] });
    } else {
      sections.push({ kind: 'group', appId, rows: matched });
    }
  }
  for (const row of rows) {
    if (!used.has(row.id)) sections.push({ kind: 'single', row });
  }
  return sections;
}

export function OrgAppsCard() {
  const t = useTranslations('orgApps');
  const tModules = useTranslations('modules');
  const tNav = useTranslations('nav');
  const apps = useQuery(orpc.org.apps.queryOptions());
  const [asking, setAsking] = useState<string | null>(null);
  const set = useMutation(
    orpc.org.setApp.mutationOptions({
      // The shell reads the list again (the stream's hint does the same in other tabs), so the menus change at once.
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.org.apps.key() }),
    }),
  );
  const nameOf = (id: string) => (isKnownModule(id) ? tModules(id) : id);
  if (apps.isLoading) return <RowsSkeleton />;
  if (!apps.data) return apps.isError ? <ErrorText>{errorMessage(apps.error)}</ErrorText> : null;
  const rows = apps.data.apps.filter((a) => a.deployment);
  if (rows.length === 0) return null;
  const canChange = apps.data.canChange;
  const sections = groupByApp(rows);
  const change = (module: string, enabled: boolean) => {
    if (set.isPending) return;
    set.reset();
    set.mutate({ module, enabled });
  };
  const target = rows.find((a) => a.id === asking);
  const renderRow = (row: OrgAppEntry, isSingle: boolean) => {
    const status = !row.entitled ? 'notInPlan' : row.enabled ? 'on' : 'off';
    const label = nameOf(row.id);
    return (
      <li
        key={row.id}
        className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
        data-testid={`org-app-${row.id}`}
      >
        <span className={cn('min-w-0 text-foreground', isSingle ? 'font-medium' : 'font-normal')}>{label}</span>
        <div className="flex shrink-0 items-center gap-2.5">
          {/* One signal per row (ST-2): a row in use shows only its checked switch; a badge says why a row is not. */}
          {status !== 'on' && <Badge variant="outline">{t(`status.${status}`)}</Badge>}
          <Switch
            checked={row.enabled && row.entitled}
            // Another row's change is under way: this one waits (its own stays enabled, so focus is not lost when the dialog closes).
            disabled={!canChange || !row.entitled || (set.isPending && set.variables?.module !== row.id)}
            aria-label={t('switchLabel', { app: label })}
            aria-busy={set.isPending && set.variables?.module === row.id ? true : undefined}
            onCheckedChange={(checked) => {
              // A change is under way: this row takes no second one (and opens no second confirmation).
              if (set.isPending) return;
              if (checked) change(row.id, true);
              else setAsking(row.id);
            }}
          />
        </div>
      </li>
    );
  };
  return (
    <Card className="block space-y-3 p-4" data-testid="org-apps">
      <div>
        <h2 className="text-sm font-medium text-muted-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-subtle-foreground">{t('hint')}</p>
      </div>
      <div className="space-y-3">
        {sections.map((section) => {
          if (section.kind === 'single') {
            return (
              <ul key={section.row.id} className="overflow-hidden rounded-lg border">
                {renderRow(section.row, true)}
              </ul>
            );
          }
          const labelId = `org-app-group-${section.appId}-label`;
          return (
            <div
              key={`group:${section.appId}`}
              data-testid={`org-app-group-${section.appId}`}
              role="group"
              aria-labelledby={labelId}
              className="overflow-hidden rounded-lg border"
            >
              <p id={labelId} className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                {tNav(`apps.${section.appId}`)}
              </p>
              <ul className="divide-y">{section.rows.map((row) => renderRow(row, false))}</ul>
            </div>
          );
        })}
      </div>
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

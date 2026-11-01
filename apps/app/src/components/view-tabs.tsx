// SPDX-License-Identifier: AGPL-3.0-only
// Tabs of saved views above a list's filter bar (CRM plan 6, steps K3 and K4, #2227, #2228): "Tất cả", then the member's
// own views, then the org's shared ones. Picking a tab hands its filter and sort to the screen (`onApply`); once the
// screen's filter or sort moves away from the picked view, the tabs offer to save the change into that view (its owner, or
// an owner or admin for a shared one) or as a new one, which asks for a name and whether to share it. The views come from
// kernel.saved_view.* of one scope, so every list of the app (the contacts today, the deals next) shares this component and
// the server's rules: at most 30 per member and scope, a private view seen by its owner alone.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { SAVED_VIEW_LIMIT, type FilterAst, type SavedViewSort } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { sameFilter, sameSort } from '../lib/view-filter.ts';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText } from './ui.tsx';

type SavedView = Awaited<ReturnType<typeof client.savedViews.list>>[number];
export interface ViewState {
  filters: FilterAst;
  sort: SavedViewSort | null;
}

const ALL = 'all';
export const NO_FILTER: FilterAst = { v: 1, all: [] };

export function ViewTabs({ scope, filters, sort, onApply }: { scope: string; filters: FilterAst; sort: SavedViewSort | null; onApply: (next: ViewState) => void }) {
  const t = useTranslations('savedViews');
  const nameId = useId();
  const org = useQuery(orpc.org.get.queryOptions());
  // Viewers read only, but keep private views of their own: they may not share one with the org.
  const canShare = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  const views = useQuery(orpc.savedViews.list.queryOptions({ input: { scope } }));
  const list = views.data ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = list.find((v) => v.id === activeId) ?? null;
  // The picked view is gone (deleted here or by its owner): the screen leaves its filter too, not only the tab.
  const gone = activeId !== null && views.isSuccess && active === null;
  useEffect(() => {
    if (!gone) return;
    setActiveId(null);
    onApply({ filters: NO_FILTER, sort: null });
    // onApply is the screen's setter pair; the effect runs once per disappearance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone]);
  const [mode, setMode] = useState<'none' | 'create' | 'rename'>('none');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.savedViews.key() });

  const dirty = active ? !(sameFilter(active.filters, filters) && sameSort(active.sort, sort)) : filters.all.length > 0 || sort !== null;
  const mine = list.filter((v) => v.mine);
  const others = list.filter((v) => !v.mine);
  const full = mine.length >= SAVED_VIEW_LIMIT;

  const done = (message: string | null) => {
    setMode('none');
    setName('');
    setNotice(message);
    void refresh();
  };
  const create = useMutation({
    mutationFn: (input: { name: string; shared: boolean }) => client.savedViews.save({ scope, name: input.name, filters, sort, shared: input.shared }),
    onSuccess: ({ viewId }, input) => {
      setActiveId(viewId);
      done(t('saved', { name: input.name }));
    },
  });
  const update = useMutation({
    mutationFn: (view: SavedView) => client.savedViews.save({ viewId: view.id, filters, sort }),
    onSuccess: (_, view) => done(t('updated', { name: view.name })),
  });
  const rename = useMutation({
    mutationFn: (input: { view: SavedView; name: string }) => client.savedViews.rename({ viewId: input.view.id, name: input.name }),
    onSuccess: (_, input) => done(t('renamed', { name: input.name })),
  });
  const share = useMutation({
    mutationFn: (view: SavedView) => client.savedViews.setShared({ viewId: view.id, shared: !view.shared }),
    onSuccess: (_, view) => done(view.shared ? t('madePrivate', { name: view.name }) : t('madeShared', { name: view.name })),
  });
  const remove = useMutation({
    mutationFn: (view: SavedView) => client.savedViews.remove({ viewId: view.id }),
    onSuccess: (_, view) => {
      setActiveId(null);
      onApply({ filters: NO_FILTER, sort: null });
      done(t('removed', { name: view.name }));
    },
  });
  const error = views.error ?? create.error ?? update.error ?? rename.error ?? share.error ?? remove.error;
  const busy = create.isPending || update.isPending || rename.isPending || share.isPending || remove.isPending;

  const pick = (value: string) => {
    setNotice(null);
    setMode('none');
    const view = list.find((v) => v.id === value) ?? null;
    setActiveId(view?.id ?? null);
    onApply(view ? { filters: view.filters as FilterAst, sort: view.sort } : { filters: NO_FILTER, sort: null });
  };
  const tab = (v: SavedView) => (
    <TabsTrigger key={v.id} value={v.id}>
      {v.name}
      {v.shared && (
        <Badge variant="outline" className="ml-2">
          {t('sharedBadge')}
        </Badge>
      )}
    </TabsTrigger>
  );
  const resetErrors = () => {
    create.reset();
    update.reset();
    rename.reset();
    share.reset();
    remove.reset();
  };

  return (
    <div className="mb-3 space-y-2">
      <div className="max-w-full overflow-x-auto">
        <Tabs value={active?.id ?? ALL} onValueChange={(value) => pick(String(value))}>
          <TabsList aria-label={t('label')}>
            <TabsTrigger value={ALL}>{t('all')}</TabsTrigger>
            {mine.map(tab)}
            {others.map((v) => (
              <TabsTrigger key={v.id} value={v.id} title={t('sharedBy')}>
                {v.name}
                <Badge variant="outline" className="ml-2">
                  {t('sharedBadge')}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {dirty && active?.canChange && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => update.mutate(active)}>
            {t('update', { name: active.name })}
          </Button>
        )}
        {dirty && mode !== 'create' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={full}
            onClick={() => {
              resetErrors();
              setNotice(null);
              setShared(false);
              setName('');
              setMode('create');
            }}
          >
            {t('save')}
          </Button>
        )}
        {active?.canChange && mode !== 'rename' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              resetErrors();
              setNotice(null);
              setName(active.name);
              setMode('rename');
            }}
          >
            {t('rename')}
          </Button>
        )}
        {active?.canChange && (active.mine ? canShare || active.shared : false) && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => share.mutate(active)}>
            {active.shared ? t('unshare') : t('share')}
          </Button>
        )}
        {active?.canChange && (
          <ConfirmDialog
            render={<Button variant="ghost" size="sm" disabled={busy} />}
            title={t('deleteTitle', { name: active.name })}
            description={active.shared ? t('deleteSharedDescription') : t('deleteDescription')}
            confirm={t('delete')}
            destructive
            onConfirm={() => remove.mutate(active)}
          >
            {t('delete')}
          </ConfirmDialog>
        )}
      </div>
      {full && dirty && <p className="text-xs text-warning">{t('limit', { limit: String(SAVED_VIEW_LIMIT) })}</p>}
      {mode !== 'none' && (
        <form
          aria-label={mode === 'create' ? t('save') : t('rename')}
          className="flex flex-wrap items-end gap-3 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = name.trim();
            if (!value) return;
            if (mode === 'create') create.mutate({ name: value, shared: canShare && shared });
            else if (active) rename.mutate({ view: active, name: value });
          }}
        >
          <div className="min-w-48 flex-1 sm:max-w-80">
            <label htmlFor={nameId} className="text-xs text-subtle-foreground">
              {t('name')}
            </label>
            <Input id={nameId} className="mt-1" value={name} maxLength={60} required autoFocus placeholder={t('namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </div>
          {mode === 'create' && canShare && (
            <label className="flex items-center gap-2 pb-2 text-xs text-muted-foreground" title={t('shareHint')}>
              <Checkbox checked={shared} onCheckedChange={(on) => setShared(on === true)} />
              {t('shareWithOrg')}
            </label>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              {mode === 'create' ? t('create') : t('renameDo')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setMode('none');
                resetErrors();
              }}
            >
              {t('cancel')}
            </Button>
          </div>
          {mode === 'create' && canShare && shared && <p className="w-full text-xs text-subtle-foreground">{t('shareHint')}</p>}
        </form>
      )}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
      <p role="status" className="text-xs text-muted-foreground empty:hidden">
        {notice}
      </p>
    </div>
  );
}

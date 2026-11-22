// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { StepUpPrompt } from '../../components/two-factor.tsx';
import { CardSkeleton, ErrorText } from '../../components/ui.tsx';
import { apiFetch, errorMessage, isStepUpRequired, orpc, queryClient } from '../../lib/api.ts';
import { useFormat } from '../../i18n/provider.tsx';
import { exportFileName, exportPhase, formatBytes, offboardErrorMessage, ownerRunFileComplete, slugConfirmed } from '../../lib/offboarding.ts';

// Owner only (issue #212). Starts offboarding (kernel.org.offboard, R3): the owner types the org's slug, and without a
// second factor in the last 5 minutes the server answers STEP_UP_REQUIRED and the step-up prompt asks for one (#32);
// after the code the refused request runs again as sent, with its key. One idempotency key per confirmation.
// Then shows the export's state, polling while it is made, and the downloads of the manifest and of each table.
export function Offboarding({ name, slug }: { name: string; slug: string }) {
  const root = useTranslations();
  const locale = useLocale();
  const t = useTranslations('offboarding');
  const tc = useTranslations('common');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const state = useQuery({
    ...orpc.org.export.queryOptions(),
    // While an export is being made, look again every 10 seconds.
    refetchInterval: (query) => (query.state.data && exportPhase(query.state.data).phase === 'pending' ? 10_000 : false),
  });
  const offboard = useMutation(
    orpc.org.offboard.mutationOptions({
      onSuccess: () => {
        setConfirming(false);
        setTyped('');
        setIdempotencyKey(crypto.randomUUID());
        void queryClient.invalidateQueries({ queryKey: orpc.org.export.key() });
      },
    }),
  );
  const download = useMutation({
    mutationFn: async (part: string) => {
      const response = await apiFetch(`/api/org-export/${encodeURIComponent(part)}`);
      const blob = await response.blob();
      // A staff or pay file is the owner's only copy: one that was cut short is refused, never saved as if it were whole.
      if (state.data?.ownerRunTables.includes(part) && !ownerRunFileComplete(await blob.text())) throw new Error(t('errors.incomplete'));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(slug, part);
      a.click();
      // Revoked a little later: some browsers cancel a download whose URL is revoked at once.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });

  if (state.isLoading) return <CardSkeleton className="lg:col-span-2" />;
  if (state.error) return <ErrorText>{errorMessage(state.error)}</ErrorText>;
  const data = state.data;
  if (!data) return null;
  const { phase, downloadable } = exportPhase(data);
  const exported = data.export;

  return (
    <Card className="block p-4 lg:col-span-2">
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-3 text-sm text-muted-foreground">{t('intro')}</p>
      {data.status === 'offboarding' && (
        <p className="mt-3 text-sm text-warning" role="status">
          {t('offboarding')}
        </p>
      )}
      {data.status === 'closed' && <p className="mt-3 text-sm text-muted-foreground">{t('closed')}</p>}
      {phase === 'pending' && (
        <p className="mt-3 text-sm text-foreground" role="status">
          {t('pending', { at: f.dateTime(data.requestedAt) })}
        </p>
      )}
      {exported?.expired && (
        <p className="mt-3 text-sm text-muted-foreground">{t('expired', { at: f.dateTime(exported.createdAt), expires: f.dateTime(exported.expiresAt) })}</p>
      )}
      {exported && downloadable && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-foreground">{t('ready', { at: f.dateTime(exported.createdAt), expires: f.dateTime(exported.expiresAt) })}</p>
          <p className="text-subtle-foreground">
            {exported.encryption === 'aes-256-gcm' ? t('encrypted') : t('unencrypted')} {t('files', { count: exported.fileCount })}
          </p>
          <Button variant="outline" size="sm" disabled={download.isPending} onClick={() => download.mutate('manifest')}>
            {t('manifest')}
          </Button>
          <ul className="divide-y">
            {exported.tables.map((table) => (
              <li key={table.table} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-foreground">{table.table}</p>
                  <p className="text-xs text-subtle-foreground">{t('tableRows', { rows: f.number(table.rows), size: formatBytes(table.bytes, f.number) })}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={download.isPending}
                  onClick={() => download.mutate(table.table)}
                  aria-label={`${t('download')} ${table.table}`}
                >
                  {download.isPending && download.variables === table.table ? t('downloading') : t('download')}
                </Button>
              </li>
            ))}
          </ul>
          {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
        </div>
      )}
      {data.status === 'offboarding' && data.ownerRunTables.length > 0 && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-foreground">{t('people')}</p>
          <p className="text-subtle-foreground">{t('peopleNote')}</p>
          <ul className="divide-y">
            {data.ownerRunTables.map((table) => (
              <li key={table} className="flex items-center justify-between gap-3 py-2">
                <p className="min-w-0 truncate font-mono text-foreground">{table}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={download.isPending}
                  loading={download.isPending && download.variables === table}
                  onClick={() => download.mutate(table)}
                  aria-label={`${t('download')} ${table}`}
                >
                  {t('download')}
                </Button>
              </li>
            ))}
          </ul>
          {!(exported && downloadable) && download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
        </div>
      )}
      {data.status !== 'closed' && !confirming && (
        <div className="mt-4">
          <Button
            variant={data.status === 'active' ? 'destructive' : 'outline'}
            disabled={phase === 'pending'}
            onClick={() => {
              offboard.reset();
              setTyped('');
              setConfirming(true);
            }}
          >
            {data.status === 'active' ? t('start') : t('requestAgain')}
          </Button>
        </div>
      )}
      {confirming && (
        <form
          className="mt-4 space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          role="alertdialog"
          aria-label={t('confirmLabel')}
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (slugConfirmed(typed, slug)) offboard.mutate({ confirmSlug: typed.trim(), idempotencyKey });
          }}
        >
          <p className="font-medium text-foreground">{t('confirmTitle', { name })}</p>
          <p className="text-muted-foreground">{t('confirmBody', { slug })}</p>
          <Input value={typed} maxLength={48} placeholder={t('confirmPlaceholder')} onChange={(e) => setTyped(e.target.value)} aria-label={t('confirmPlaceholder')} autoComplete="off" />
          <p className="text-subtle-foreground">{t('confirmMfa')}</p>
          <div className="flex gap-2">
            <Button type="submit" variant="destructive" disabled={offboard.isPending || !slugConfirmed(typed, slug)}>
              {t('confirm')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={offboard.isPending}
              onClick={() => {
                offboard.reset();
                setConfirming(false);
              }}
            >
              {tc('cancel')}
            </Button>
          </div>
          {offboard.error && !isStepUpRequired(offboard.error) && <ErrorText>{offboardErrorMessage(offboard.error, root, locale)}</ErrorText>}
        </form>
      )}
      {confirming && isStepUpRequired(offboard.error) && (
        // Outside the form above: the prompt has a form of its own.
        <div className="mt-4">
          <StepUpPrompt
            action={t('stepUpAction', { name })}
            onVerified={() => offboard.variables && offboard.mutate(offboard.variables)}
            onCancel={() => offboard.reset()}
          />
        </div>
      )}
    </Card>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// The shared minutes page (#4822, docs/plan/meetings.md): /-/minutes#<token>, opened from a link the recorder sent to a person outside the org, with no account. It shows the PUBLISHED minutes of one meeting and
// nothing else: the title, the dates, the summary, the decisions and the action items, with the name of the org that shared it. Every text is shown as text (the summary keeps its line breaks), never as markup.
// The token stays after the # and goes to the API in a POST body only, with no cookie and no Referer; a link that does not open gets one neutral message. The page asks search engines to keep it out
// of their index while it is open, and prints on A4 like the quote page. There is no AI part here: the page is the recorder's published text.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { vietnamToday, type MinutesPage } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { ErrorText, Logo, ScreenTitle, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { ApiError } from '../lib/errors.ts';
import { addNoindexMeta, loadMinutesPage } from '../lib/minutes-link.ts';
import { minutesTokenOfHash, subscribeToHash } from '../lib/minutes-hash.ts';
import { usePrintInLight } from '../lib/print.ts';

// What the page is showing: the minutes, a wait, the one refusal for a link that does not open, a too-busy answer or any other failure.
export type MinutesView =
  | { kind: 'loading' }
  | { kind: 'ok'; page: MinutesPage }
  | { kind: 'invalid' }
  | { kind: 'rateLimited' }
  | { kind: 'error' };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function MinutesPageView({ view, onRetry }: { view: MinutesView; onRetry?: (() => void) | undefined }) {
  const t = useTranslations('minutesPage');
  const f = useFormat();
  const day = (iso: string) => f.date(vietnamToday(new Date(iso)));
  const page = view.kind === 'ok' ? view.page : null;
  const title = page ? page.title.trim() || t('untitled') : '';
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 print:max-w-none print:p-0" data-testid="minutes-page">
      <ScreenTitle name={page ? title : t('heading')} />
      {view.kind === 'loading' && <Spinner />}
      {view.kind === 'invalid' && (
        // A link that does not open says the same thing whatever the reason (expired, revoked, never made, switched off): the reader cannot fix it, the sender can.
        <div className="space-y-1 rounded-md border border-border p-6 text-sm text-muted-foreground" role="alert" data-testid="minutes-invalid">
          <p>{t('invalid')}</p>
          <p className="text-foreground">{t('invalidNext')}</p>
        </div>
      )}
      {view.kind === 'rateLimited' && (
        <div className="space-y-3" data-testid="minutes-rate-limited">
          <ErrorText>{t('rateLimited')}</ErrorText>
          {onRetry && (
            <Button variant="outline" className="min-h-11" onClick={onRetry}>
              {t('retry')}
            </Button>
          )}
        </div>
      )}
      {view.kind === 'error' && (
        <div className="space-y-3" data-testid="minutes-error">
          <ErrorText>{t('error')}</ErrorText>
          {onRetry && (
            <Button variant="outline" className="min-h-11" onClick={onRetry}>
              {t('retry')}
            </Button>
          )}
        </div>
      )}
      {page && (
        <article className="space-y-6 text-sm" aria-labelledby="minutes-title">
          <header className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground" data-testid="minutes-shared-by">
              {t('sharedBy', { org: page.orgName })}
            </p>
            <h1 id="minutes-title" className="break-words text-xl font-semibold text-foreground">
              {title}
            </h1>
            <p className="text-muted-foreground">
              {[page.startedAt ? t('meetingDate', { date: day(page.startedAt) }) : '', t('publishedOn', { date: day(page.publishedAt) })].filter(Boolean).join(' · ')}
            </p>
            <p className="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground print:hidden" data-testid="minutes-read-only">
              {t('readOnly')}
            </p>
            <div className="flex justify-start print:hidden">
              <Button variant="outline" className="min-h-11" onClick={() => window.print()}>
                {t('print')}
              </Button>
            </div>
          </header>

          {page.summary.trim() !== '' && (
            <section className="space-y-1 print:break-inside-avoid" aria-labelledby="minutes-summary-title">
              <h2 id="minutes-summary-title" className="text-xs font-medium uppercase text-muted-foreground">
                {t('summary')}
              </h2>
              {/* Text with its line breaks kept; a tag in it stays a tag on the screen. */}
              <p className="break-words whitespace-pre-line text-foreground" data-testid="minutes-summary">
                {page.summary}
              </p>
            </section>
          )}

          <section className="space-y-1 print:break-inside-avoid" aria-labelledby="minutes-decisions-title">
            <h2 id="minutes-decisions-title" className="text-xs font-medium uppercase text-muted-foreground">
              {t('decisions')}
            </h2>
            {page.decisions.length === 0 ? (
              <p className="text-muted-foreground">{t('noDecisions')}</p>
            ) : (
              <ol className="list-decimal space-y-1 pl-5 text-foreground" data-testid="minutes-decisions">
                {page.decisions.map((d, i) => (
                  <li key={i} className="break-words whitespace-pre-line">
                    {d}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="space-y-1" aria-labelledby="minutes-actions-title">
            <h2 id="minutes-actions-title" className="text-xs font-medium uppercase text-muted-foreground">
              {t('actions')}
            </h2>
            {page.actionItems.length === 0 ? (
              <p className="text-muted-foreground">{t('noActions')}</p>
            ) : (
              <ul role="list" className="divide-y divide-border border-y border-border" data-testid="minutes-actions">
                {page.actionItems.map((a, i) => (
                  <li key={i} className="space-y-0.5 py-3 print:break-inside-avoid" data-testid="minutes-action">
                    <p className="break-words whitespace-pre-line font-medium text-foreground">{a.text}</p>
                    {(a.owner.trim() !== '' || a.due !== null) && (
                      <p className="break-words text-muted-foreground">
                        {[a.owner.trim() !== '' ? t('owner', { owner: a.owner }) : '', a.due !== null && a.due !== '' ? t('due', { due: ISO_DAY.test(a.due) ? f.date(a.due) : a.due }) : '']
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </article>
      )}
      <footer className="flex justify-center pt-2 text-xs text-subtle-foreground print:hidden">
        <Logo />
      </footer>
    </main>
  );
}

export function MinutesPublicPage() {
  // The token follows the address: a hash-only change in this tab shows the other minutes (the query is keyed by the token).
  const token = useSyncExternalStore(subscribeToHash, minutesTokenOfHash, minutesTokenOfHash);
  // Every request counts as an open of the link on the recorder's list, so the page asks once per token and never again on its own (no refetch on focus or on reconnect).
  const query = useQuery({
    queryKey: ['minutes-page', token],
    queryFn: () => loadMinutesPage(token as string),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  usePrintInLight();
  // Search engines keep the page out of their index while it is open; the tag is taken out when the page goes.
  useEffect(() => addNoindexMeta(document), []);
  const view = minutesViewOf(token, query);
  return <MinutesPageView view={view} onRetry={query.isFetching ? undefined : () => void query.refetch()} />;
}

// The state of the query as one of the views; a missing or malformed token is the same refusal as a link the server does not know.
export function minutesViewOf(token: string | null, query: { isLoading: boolean; isFetching?: boolean; error: unknown; data: MinutesPage | null | undefined }): MinutesView {
  if (token === null) return { kind: 'invalid' };
  // Minutes already on screen stay on screen: a failed request after them (a network blip, a 429) does not replace them.
  if (query.data) return { kind: 'ok', page: query.data };
  // A retry in flight shows the wait, not the earlier error.
  if (query.isLoading || query.isFetching) return { kind: 'loading' };
  if (query.error) return query.error instanceof ApiError && query.error.status === 429 ? { kind: 'rateLimited' } : { kind: 'error' };
  return query.data === null ? { kind: 'invalid' } : { kind: 'loading' };
}

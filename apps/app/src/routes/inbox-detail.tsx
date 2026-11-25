import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { ProposalDetail } from '../components/proposal-detail.tsx';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { SPLIT_UP, useMediaQuery } from '../lib/media.ts';
import { proposalName } from '../lib/review.ts';

// One page per proposal: moving to the next one (J or N) mounts a fresh page, so no unsaved account, confirmation or
// approval idempotency key carries over from the previous proposal. On a wide screen the pending list stays beside it
// (DESIGN.md §3.4, #1514); it lives outside the keyed page, so it does not reload from one proposal to the next.
export function InboxDetailPage() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const split = useMediaQuery(SPLIT_UP);
  const detail = <ProposalDetail key={id} slug={slug} id={id} split={split} mode="page" />;
  if (!split) return detail;
  return (
    <div className="grid grid-cols-[15rem_minmax(0,1fr)] items-start gap-6">
      <InboxQueue slug={slug} current={id} />
      <div className="min-w-0">{detail}</div>
    </div>
  );
}

// The proposals waiting for review, beside the open one: the open one is marked, and a click opens another. A region,
// not a second navigation landmark: the app's menu stays the page's one navigation.
function InboxQueue({ slug, current }: { slug: string; current: string }) {
  const t = useTranslations('inboxDetail');
  const f = useFormat();
  const pending = useQuery(orpc.inbox.list.queryOptions({ input: { status: 'pending' } }));
  const items = pending.data ?? [];
  return (
    <section aria-label={t('queue')} className="sticky top-16 max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-lg border bg-card">
      <p className="border-b px-3 py-2 text-xs font-medium text-subtle-foreground">{t('queue')}</p>
      {pending.isPending ? (
        <div className="px-3">
          <RowsSkeleton />
        </div>
      ) : pending.error ? (
        // A failed load is not an empty queue.
        <div className="p-3">
          <ErrorText>{errorMessage(pending.error)}</ErrorText>
        </div>
      ) : items.length === 0 ? (
        <p className="px-3 py-3 text-xs text-subtle-foreground">{t('queueEmpty')}</p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => {
            const open = item.id === current;
            return (
              <li key={item.id}>
                <Link
                  to="/o/$slug/inbox/$id"
                  params={{ slug, id: item.id }}
                  aria-current={open ? 'page' : undefined}
                  className={`block px-3 py-2 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 ${open ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground'}`}
                >
                  <span className="block truncate">{proposalName(item)}</span>
                  {item.total ? <span className="block text-xs tabular-nums text-subtle-foreground">{f.money(item.total)}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link to="/o/$slug/inbox" params={{ slug }} className="block border-t px-3 py-2 text-xs text-link hover:underline">
        {t('queueAll')}
      </Link>
    </section>
  );
}

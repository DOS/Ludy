// SPDX-License-Identifier: AGPL-3.0-only
// Search across the meetings a member can read (L2, #2589). A box on the meetings screen: words typed with or without Vietnamese marks find the transcript lines that hold all
// of them, in the meetings the caller reads only (the server decides, row by row); a hit shows the meeting, its date, the line and its time, and opens the transcript at that
// line. A plain search: no AI coworker takes part, no model is called, it works with AI off and there is nothing to approve. A search is a sensitive read that leaves an audit
// row, so it runs when the member asks (Enter or the button), not on every key.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { MEETING_SEARCH_HITS_MAX, type MeetingSearchHit, type MeetingSearchResult } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { markMatches } from '../lib/search-fold.ts';

export const SEARCH_PAGE = 20;
const MIN_CHARS = 2;

function Hit({ slug, hit, typed }: { slug: string; hit: MeetingSearchHit; typed: string }) {
  const t = useTranslations('meetings.contentSearch');
  const f = useFormat();
  const time = clock(hit.startSeconds);
  return (
    <li>
      <Link
        to="/o/$slug/meetings/$id"
        params={{ slug, id: hit.meetingId }}
        search={{ seg: hit.segmentId }}
        className="block space-y-1 p-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
        data-testid="meeting-search-hit"
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 break-words font-semibold text-foreground">{hit.meetingTitle}</span>
          <span>{f.date(hit.heldAt)}</span>
          <span className="font-mono">{time}</span>
          <span>{hit.speakerLabel}</span>
          {hit.stage === 'draft' && <Badge variant="outline">{t('draft')}</Badge>}
        </div>
        <p className="line-clamp-3 whitespace-pre-wrap text-sm">
          {markMatches(hit.text, typed).map((part, i) => (part.mark ? <mark key={i} className="rounded bg-warning/25 px-0.5 text-foreground">{part.text}</mark> : <span key={i}>{part.text}</span>))}
        </p>
      </Link>
    </li>
  );
}

// The hits of one page, with the paging and the notes (none found, capped). Rendered from the answer alone.
export function SearchResults({ slug, result, typed, page, onPage }: { slug: string; result: MeetingSearchResult; typed: string; page: number; onPage: (delta: -1 | 1) => void }) {
  const t = useTranslations('meetings.contentSearch');
  return (
    <div className="space-y-2">
      {result.hits.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="meeting-search-none">
          {t('none')}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border border-border bg-card">
          {result.hits.map((hit) => (
            <Hit key={hit.segmentId} slug={slug} hit={hit} typed={typed} />
          ))}
        </ul>
      )}
      {result.capped && <p className="text-xs text-muted-foreground">{t('capped', { max: String(MEETING_SEARCH_HITS_MAX) })}</p>}
      {(page > 1 || result.hasMore) && (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(-1)}>
            {t('previous')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('page', { page: String(page) })}</span>
          <Button type="button" size="sm" variant="outline" disabled={!result.hasMore || result.capped} onClick={() => onPage(1)}>
            {t('next')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function MeetingSearch({ slug }: { slug: string }) {
  const t = useTranslations('meetings.contentSearch');
  const [text, setText] = useState('');
  const [asked, setAsked] = useState<{ q: string; offset: number } | null>(null);
  const [tooShort, setTooShort] = useState(false);
  const query = useQuery({
    ...orpc.meetings.search.queryOptions({ input: { q: asked?.q ?? '-', limit: SEARCH_PAGE, offset: asked?.offset ?? 0 } }),
    enabled: asked !== null,
    // Each search leaves an audit row: asking again for the same page within half a minute shows what is held; a removed reader loses the text on the next ask after that.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (q.length < MIN_CHARS) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    setAsked({ q, offset: 0 });
  };
  const clear = () => {
    setAsked(null);
    setText('');
    setTooShort(false);
  };
  const result = asked ? query.data : undefined;
  const page = asked ? Math.floor(asked.offset / SEARCH_PAGE) + 1 : 1;

  return (
    <section className="space-y-3" aria-labelledby="meeting-content-search-label" data-testid="meeting-content-search">
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit} role="search">
        <div className="w-full max-w-sm space-y-1">
          <Label id="meeting-content-search-label" htmlFor="meeting-content-search">
            {t('label')}
          </Label>
          <Input id="meeting-content-search" type="search" maxLength={200} placeholder={t('placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Button type="submit" loading={query.isFetching && asked !== null}>
          {t('submit')}
        </Button>
        {asked && (
          <Button type="button" variant="ghost" onClick={clear}>
            {t('clear')}
          </Button>
        )}
      </form>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {tooShort && <ErrorText>{t('tooShort')}</ErrorText>}
      {asked && query.error && <ErrorText>{errorMessage(query.error)}</ErrorText>}
      <div aria-live="polite">
      {result && asked && (
        <SearchResults
          slug={slug}
          result={result}
          typed={asked.q}
          page={page}
          onPage={(delta) => setAsked({ q: asked.q, offset: asked.offset + delta * SEARCH_PAGE })}
        />
      )}
      </div>
    </section>
  );
}

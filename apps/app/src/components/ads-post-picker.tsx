// SPDX-License-Identifier: AGPL-3.0-only
// "Start from a post" (W1c, issue #2295): the member picks one of the org's Social posts and the campaign builder pre-fills from it. The app reads the post
// through Social's own query (orpc.social.posts.list), so nothing of Social's tables is read by Ads; only the post's id travels on, as an opaque reference.
// The dialog's list is read only while it is open.
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { errorMessage, orpc } from '../lib/api.ts';
import { cutAt, startFromPost, type PostStart } from '../lib/ads-campaigns.ts';
import { Empty, ErrorText, RowsSkeleton } from './ui.tsx';

// How many posts the list shows at a time: the newest changed first, narrowed by a search.
const POST_LIMIT = 20;

function PostList({ onPick }: { onPick: (start: PostStart) => void }) {
  const t = useTranslations('ads');
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');
  const posts = useQuery(orpc.social.posts.list.queryOptions({ input: { ...(search === '' ? {} : { search }), limit: POST_LIMIT } }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(term.trim());
  };
  return (
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={submit} role="search">
        <Input aria-label={t('campaigns.postSearch')} placeholder={t('campaigns.postSearch')} maxLength={200} value={term} onChange={(e) => setTerm(e.target.value)} />
        <Button type="submit" variant="outline">
          {t('campaigns.postSearchGo')}
        </Button>
      </form>
      {posts.error ? (
        <ErrorText>{errorMessage(posts.error)}</ErrorText>
      ) : !posts.data ? (
        <RowsSkeleton rows={4} />
      ) : posts.data.length === 0 ? (
        <Empty title={t('campaigns.postNone')} />
      ) : (
        <ul className="max-h-80 space-y-2 overflow-y-auto" data-testid="post-picker-list">
          {posts.data.map((post) => {
            const label = (post.title ?? '').trim() || post.body.trim().split('\n')[0] || t('campaigns.postUntitled');
            return (
              <li key={post.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{cutAt(label, 80)}</p>
                  {post.body.trim() !== '' && <p className="line-clamp-2 text-xs text-muted-foreground">{cutAt(post.body, 160)}</p>}
                </div>
                <DialogClose render={<Button type="button" size="sm" variant="outline" />} onClick={() => onPick(startFromPost(post))}>
                  {t('campaigns.postPick')}
                </DialogClose>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function PostPicker({ onPick }: { onPick: (start: PostStart) => void }) {
  const t = useTranslations('ads');
  const common = useTranslations('common');
  return (
    <Dialog>
      <DialogTrigger render={<Button type="button" variant="outline" size="lg" />}>{t('campaigns.startFromPost')}</DialogTrigger>
      <DialogContent closeLabel={common('close')}>
        <DialogHeader>
          <DialogTitle>{t('campaigns.postPickerTitle')}</DialogTitle>
          <DialogDescription>{t('campaigns.postPickerHint')}</DialogDescription>
        </DialogHeader>
        <PostList onPick={onPick} />
      </DialogContent>
    </Dialog>
  );
}

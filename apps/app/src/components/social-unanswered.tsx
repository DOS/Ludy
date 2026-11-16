// SPDX-License-Identifier: AGPL-3.0-only
// The platform comments nobody has answered yet, on a post's row, board card and calendar chip (#3298, plan docs/plan/conversations.md section 11). One read for the
// whole screen (`kernel.conversation.post_counts` asks for every published post shown at once, never one query a row); the provider hands each row its own number.
// The number is the reader's own (the database shows a member only the threads of the channels they may use); it carries no text and no name. When the read fails
// (conversations unavailable, a role that may not read) the rows show nothing, and the screen is as it was.
import { keepPreviousData, useQueries } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { CONVERSATION_POST_COUNTS_MAX } from '@crove/kernel-contract';
import { orpc } from '../lib/api.ts';

// A minute: the Inbox polls faster, but a post list is a place to plan, not to answer, and the badge only points at the post's Bình luận tab.
const REFRESH_MS = 60_000;

interface CountedPost {
  id: string;
  variants: ReadonlyArray<{ connectionId: string; status: string; externalPostId: string | null }>;
}

export interface PostRef {
  connectionId: string;
  externalPostId: string;
}

const key = (r: PostRef): string => `${r.connectionId}\n${r.externalPostId}`;

/** The platform posts the comments sit under: each published channel of the posts shown, once (#3298). */
export function postRefsOf(posts: readonly CountedPost[]): PostRef[] {
  const refs = new Map<string, PostRef>();
  for (const p of posts) {
    for (const v of p.variants) {
      if (v.status !== 'published' || !v.externalPostId) continue;
      const ref = { connectionId: v.connectionId, externalPostId: v.externalPostId };
      refs.set(key(ref), ref);
    }
  }
  return [...refs.values()];
}

/** The refs in reads of at most what the kernel takes at once: a screen of up to 200 posts on several channels is a few reads, never a silent cut. */
export function readsOf(refs: readonly PostRef[]): PostRef[][] {
  const reads: PostRef[][] = [];
  for (let i = 0; i < refs.length; i += CONVERSATION_POST_COUNTS_MAX) reads.push(refs.slice(i, i + CONVERSATION_POST_COUNTS_MAX));
  return reads;
}

/** Each post's number of unanswered threads: the sum over its published channels; a post with none is left out (#3298). */
export function unansweredByPost(posts: readonly CountedPost[], counts: ReadonlyArray<PostRef & { unanswered: number }>): Map<string, number> {
  const by = new Map(counts.map((c) => [key(c), c.unanswered]));
  const out = new Map<string, number>();
  for (const p of posts) {
    let n = 0;
    const seen = new Set<string>();
    for (const v of p.variants) {
      if (v.status !== 'published' || !v.externalPostId) continue;
      const k = key({ connectionId: v.connectionId, externalPostId: v.externalPostId });
      if (seen.has(k)) continue;
      seen.add(k);
      n += by.get(k) ?? 0;
    }
    if (n > 0) out.set(p.id, n);
  }
  return out;
}

const Unanswered = createContext<ReadonlyMap<string, number>>(new Map());

export function UnansweredProvider({ posts, children }: { posts: readonly CountedPost[]; children: ReactNode }) {
  const reads = useMemo(() => readsOf(postRefsOf(posts)), [posts]);
  // keepPreviousData: a page or month change asks again, and the badges stay until the new numbers come instead of blinking out.
  const answers = useQueries({
    queries: reads.map((refs) => ({
      ...orpc.conversations.postCounts.queryOptions({ input: { posts: refs } }),
      retry: false,
      refetchInterval: REFRESH_MS,
      placeholderData: keepPreviousData,
    })),
  });
  // A read that failed shows nothing, even when an earlier answer is still held: a number out of date for as long as the connection is down is worse than none.
  // The answers array is new on every render; what changed is told by when each read last brought data and whether it failed.
  const fresh = answers.map((a) => `${a.dataUpdatedAt}${a.isError ? 'x' : ''}`).join(',');
  const byPost = useMemo(() => unansweredByPost(posts, answers.flatMap((a) => (a.isError ? [] : (a.data?.counts ?? [])))), [posts, fresh]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Unanswered.Provider value={byPost}>{children}</Unanswered.Provider>;
}

/** "N bình luận chưa trả lời" for a post, or nothing when it has none or the count is not known. */
export function UnansweredComments({ postId }: { postId: string }) {
  const t = useTranslations('social');
  const count = useContext(Unanswered).get(postId) ?? 0;
  if (count <= 0) return null;
  return (
    <Badge variant="warning" data-testid="unanswered-comments">
      {t('unansweredComments', { count })}
    </Badge>
  );
}

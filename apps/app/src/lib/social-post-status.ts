// SPDX-License-Identifier: AGPL-3.0-only
// The one sentence under a post's title (#3656): where the post stands as a whole, from the statuses of its channels, so a
// person sees the next step without reading each channel's chip. Pure, so it is tested without a screen.
import type { VariantStatus } from './social.ts';

export type PostStatusKey = 'draft' | 'review' | 'changes' | 'approved' | 'scheduled' | 'publishing' | 'published' | 'attention' | 'cancelled' | 'archived';

interface StatusVariant {
  status: VariantStatus;
  effectiveAt: string | null;
}

// A channel cancelled or taken down no longer counts; the first of these that holds names the post, most urgent first:
// a failure, a change asked for, a review waiting, a draft, an approval waiting for a time, a channel on its way, then
// published. A post with a channel on its way and another already out reads as scheduled: what is still to happen.
export function postStatus(post: { archivedAt: string | null; variants: readonly StatusVariant[] }): { key: PostStatusKey; at: string | null } {
  if (post.archivedAt !== null) return { key: 'archived', at: null };
  const live = post.variants.filter((v) => v.status !== 'cancelled' && v.status !== 'removed');
  const has = (...statuses: VariantStatus[]) => live.some((v) => statuses.includes(v.status));
  const times = (...statuses: VariantStatus[]) => live.filter((v) => statuses.includes(v.status) && v.effectiveAt !== null).map((v) => v.effectiveAt as string).sort();
  if (live.length === 0) return { key: 'cancelled', at: null };
  if (has('failed', 'needs_attention', 'ambiguous', 'rejected')) return { key: 'attention', at: null };
  if (has('changes_requested')) return { key: 'changes', at: null };
  if (has('in_review')) return { key: 'review', at: null };
  if (has('draft')) return { key: 'draft', at: null };
  if (has('approved')) return { key: 'approved', at: null };
  if (has('publishing', 'processing')) return { key: 'publishing', at: null };
  if (has('scheduled', 'paused')) return { key: 'scheduled', at: times('scheduled', 'paused')[0] ?? null };
  // Published: the latest time among the channels.
  return { key: 'published', at: times('published').at(-1) ?? null };
}

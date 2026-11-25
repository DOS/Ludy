// Posts a channel published outside Ludy (#1054), next to Ludy's own on the Metrics tab: one list, newest first, and
// a link to the post only when it is an https page.

export interface LudyPublished {
  variantId: string;
  publishedAt: string | null;
}
export interface OutsidePublished {
  id: string;
  publishedAt: string;
}
export type PublishedItem<C extends LudyPublished, O extends OutsidePublished> = { kind: 'ludy'; row: C } | { kind: 'outside'; row: O };

// Ludy's rows and the outside ones in one list, newest first. Both come newest first from the server; they are merged
// without reordering either, so Ludy's rows keep the server's order (with no outside post the list is Ludy's as is),
// and an outside post goes before the first Ludy row published before it (a Ludy row without a time counts as oldest).
export function mergePublished<C extends LudyPublished, O extends OutsidePublished>(ludy: readonly C[], outside: readonly O[]): PublishedItem<C, O>[] {
  const at = (iso: string | null) => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);
  const out: PublishedItem<C, O>[] = [];
  let i = 0;
  let j = 0;
  while (i < ludy.length || j < outside.length) {
    const c = ludy[i];
    const o = outside[j];
    if (o && (!c || at(o.publishedAt) > at(c.publishedAt))) {
      out.push({ kind: 'outside', row: o });
      j += 1;
    } else if (c) {
      out.push({ kind: 'ludy', row: c });
      i += 1;
    }
  }
  return out;
}

// The post's page on its platform when the address is https; anything else is not a link.
export function outsideUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

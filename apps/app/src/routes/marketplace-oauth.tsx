// SPDX-License-Identifier: AGPL-3.0-only
// Where a marketplace's consent page sends the seller back (/marketplace/oauth/:provider/callback, Lazada S2b, #4238). The code and the state are taken out of the address and the address is cleaned at once
// (a reload never replays the code); the card that started the authorization remembered the org the same way the other OAuth screens do. The page only hands the two to the API: the code is sealed there and
// traded by the worker, so the answer is "received", and the card shows how it ended.
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { ErrorText, ScreenTitle, Spinner } from '../components/ui.tsx';
import { client, errorMessage, queryClient, setCurrentOrg } from '../lib/api.ts';
import { takeOAuthAttempt } from '../lib/oauth.ts';

// The marketplaces with an authorization step: a fixed list, so an address with any other name finishes nothing.
const KNOWN = ['lazada', 'tiktok_shop'] as const;

type Callback = { kind: 'finish'; slug: string; state: string; code: string } | { kind: 'cancelled'; slug: string | null } | { kind: 'lost' };

// Read once per page load: the address bar is cleaned right after.
function readCallback(known: boolean): Callback {
  const params = new URLSearchParams(window.location.search);
  window.history.replaceState(null, '', window.location.pathname);
  if (!known) return { kind: 'lost' };
  const state = params.get('state') ?? '';
  const slug = state ? takeOAuthAttempt(state) : null;
  if (params.get('error')) return { kind: 'cancelled', slug };
  const code = params.get('code');
  if (!slug || !code) return { kind: 'lost' };
  return { kind: 'finish', slug, state, code };
}

export function MarketplaceOAuthCallbackPage() {
  const { provider } = useParams({ strict: false }) as { provider: string };
  const t = useTranslations('marketplaceConnections.oauth');
  const known = (KNOWN as readonly string[]).includes(provider);
  // Read in an effect, not during render (reading takes the entry out of sessionStorage); the ref keeps the first read when Strict Mode runs the effect twice.
  const read = useRef<Callback | null>(null);
  const [callback, setCallback] = useState<Callback | null>(null);
  useEffect(() => {
    read.current ??= readCallback(known);
    setCallback(read.current);
  }, [known]);
  const started = useRef(false);
  const finish = useMutation({
    mutationFn: (c: Extract<Callback, { kind: 'finish' }>) => {
      setCurrentOrg(c.slug);
      return client.marketplace.connections.authorizeFinish({ state: c.state, code: c.code });
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  useEffect(() => {
    if (callback?.kind !== 'finish' || started.current) return;
    started.current = true;
    finish.mutate(callback);
  }, [callback, finish]);

  const slug = !callback || callback.kind === 'lost' ? null : callback.slug;
  const busy = !callback || (callback.kind === 'finish' && (finish.isPending || finish.isIdle));
  const back = slug ? (
    <Link to="/o/$slug/settings/connections" params={{ slug }} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">
      {t('back')}
    </Link>
  ) : (
    <Link to="/" className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">
      {t('back')}
    </Link>
  );
  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4">
      <Card className="block w-full max-w-md space-y-4 p-6">
        <ScreenTitle name={t('title')} />
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        {callback?.kind === 'cancelled' && <p className="text-sm text-muted-foreground">{t('cancelled')}</p>}
        {callback?.kind === 'lost' && <ErrorText>{t('lost')}</ErrorText>}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t('finishing')}
          </div>
        )}
        {finish.data && (
          <p role="status" className="text-sm text-foreground">
            {t('received')}
          </p>
        )}
        {finish.error && <ErrorText>{errorMessage(finish.error)}</ErrorText>}
        {!busy && back}
      </Card>
    </main>
  );
}

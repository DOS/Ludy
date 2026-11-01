// Where a provider's OAuth dialog sends the browser back (/channels/oauth/:provider/callback). The code and state are
// taken out of the address bar at once, then the attempt is finished for the org it was started in.
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { OAUTH_MAX_ACCOUNTS_PER_GRANT, type OAUTH_AD_PROVIDERS, type OAUTH_CHANNEL_PROVIDERS } from '@crove/kernel-contract';
import { Card } from '@crove/ui/components/card';
import { ErrorText, ScreenTitle, Spinner } from '../components/ui.tsx';
import { adProviderName, isAdOAuthProvider } from '../lib/ads.ts';
import { client, errorMessage, queryClient, setCurrentOrg } from '../lib/api.ts';
import { takeOAuthAttempt } from '../lib/oauth.ts';
import { providerName } from '../lib/social.ts';

type OAuthProvider = (typeof OAUTH_CHANNEL_PROVIDERS)[number] | (typeof OAUTH_AD_PROVIDERS)[number];
type Callback = { kind: 'finish'; slug: string; state: string; code: string } | { kind: 'cancelled'; slug: string | null } | { kind: 'lost' };

// Read once per page load: the address bar is cleaned right after, so a reload never replays the code.
function readCallback(): Callback {
  const params = new URLSearchParams(window.location.search);
  window.history.replaceState(null, '', window.location.pathname);
  const state = params.get('state') ?? '';
  const slug = state ? takeOAuthAttempt(state) : null;
  if (params.get('error')) return { kind: 'cancelled', slug };
  const code = params.get('code');
  if (!slug || !code) return { kind: 'lost' };
  return { kind: 'finish', slug, state, code };
}

export function OAuthCallbackPage() {
  const { provider } = useParams({ strict: false }) as { provider: string };
  const t = useTranslations('social');
  const ta = useTranslations('ads');
  // An ad platform (Meta ads, #2218) is connected from the Ads screen and goes back to it; Social keeps its own words.
  const ads = isAdOAuthProvider(provider);
  const name = ads ? adProviderName(provider) : providerName(provider);
  const title = ads ? ta('oauth.title') : t('oauthTitle');
  const connectedText = (list: string) => (ads ? ta('oauth.connected', { list }) : t('oauthConnected', { list }));
  // Read in an effect, not during render: reading takes the entry out of sessionStorage and cleans the address bar.
  // The ref keeps the first read when Strict Mode runs the effect twice.
  const read = useRef<Callback | null>(null);
  const [callback, setCallback] = useState<Callback | null>(null);
  useEffect(() => {
    read.current ??= readCallback();
    setCallback(read.current);
  }, []);
  const started = useRef(false);
  const finish = useMutation({
    mutationFn: (c: Extract<Callback, { kind: 'finish' }>) => {
      setCurrentOrg(c.slug);
      // The oauth providers are a fixed list in the contract; the server refuses any other.
      return client.channels.oauthFinish({ provider: provider as OAuthProvider, state: c.state, code: c.code });
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  useEffect(() => {
    if (callback?.kind !== 'finish' || started.current) return;
    started.current = true;
    finish.mutate(callback);
  }, [callback, finish]);

  const slug = !callback || callback.kind === 'lost' ? null : callback.slug;
  // Waiting for the first read or for the server.
  const busy = !callback || (callback.kind === 'finish' && (finish.isPending || finish.isIdle));
  const back = slug ? (
    ads ? (
      <Link to="/o/$slug/ads" params={{ slug }} className="text-sm font-medium text-primary hover:underline">
        {ta('oauth.backToAds')}
      </Link>
    ) : (
      <Link to="/o/$slug/social/channels" params={{ slug }} className="text-sm font-medium text-primary hover:underline">
        {t('backToChannels')}
      </Link>
    )
  ) : (
    <Link to="/" className="text-sm font-medium text-primary hover:underline">
      {ads ? ta('oauth.backToAds') : t('backToChannels')}
    </Link>
  );

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4">
      <Card className="block w-full max-w-md space-y-4 p-6">
        <ScreenTitle name={`${title}: ${name}`} />
        <h1 className="text-lg font-semibold text-foreground">
          {title}: {name}
        </h1>
        {callback?.kind === 'cancelled' && <p className="text-sm text-muted-foreground">{t('oauthCancelled')}</p>}
        {callback?.kind === 'lost' && <ErrorText>{ads ? ta('oauth.lost') : t('oauthLost')}</ErrorText>}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t('oauthFinishing')}
          </div>
        )}
        {finish.data && <p className="text-sm text-foreground">{connectedText(finish.data.connections.map((c) => c.displayName).join(', '))}</p>}
        {finish.data && (finish.data.failed?.length ?? 0) > 0 && <ErrorText>{ads ? ta('oauth.failed', { list: (finish.data.failed ?? []).map((c) => c.displayName).join(', ') }) : t('oauthFailed', { list: (finish.data.failed ?? []).map((c) => c.displayName).join(', ') })}</ErrorText>}
        {finish.data && (finish.data.skipped ?? 0) > 0 && <p className="text-sm text-muted-foreground">{ads ? ta('oauth.skipped', { count: finish.data.skipped, max: OAUTH_MAX_ACCOUNTS_PER_GRANT }) : t('oauthSkipped', { count: finish.data.skipped, max: OAUTH_MAX_ACCOUNTS_PER_GRANT })}</p>}
        {finish.error && <ErrorText>{errorMessage(finish.error)}</ErrorText>}
        {!busy && back}
      </Card>
    </main>
  );
}

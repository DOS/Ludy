// Where a provider's OAuth dialog or GitHub App setup sends the browser back (/channels/oauth/:provider/callback).
// The code and state are taken out of the address bar at once, then the attempt is finished for the org it was started in.
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { OAUTH_MAX_ACCOUNTS_PER_GRANT, type OAUTH_AD_PROVIDERS, type OAUTH_CHANNEL_PROVIDERS } from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { ErrorText, ScreenTitle, Spinner } from '../components/ui.tsx';
import { adProviderName, isAdOAuthProvider, isAdWriteOAuthProvider } from '../lib/ads.ts';
import { client, errorMessage, queryClient, setCurrentOrg } from '../lib/api.ts';
import { kernelErrorMessage } from '../lib/kernel-errors.ts';
import { takeGithubOAuthAttempt, takeOAuthAttempt, type GithubOAuthAttempt } from '../lib/oauth.ts';
import { providerName } from '../lib/social.ts';

type OAuthProvider = (typeof OAUTH_CHANNEL_PROVIDERS)[number] | (typeof OAUTH_AD_PROVIDERS)[number];
type GithubPendingCallback = GithubOAuthAttempt & { installationId?: string };
type Callback =
  | { kind: 'finish'; slug: string; state: string; code: string; github?: GithubPendingCallback }
  | { kind: 'cancelled'; slug: string | null; projectId?: string }
  | { kind: 'lost' };

type FinishResult =
  | { kind: 'channels'; connections: { displayName: string }[]; failed?: { displayName: string; code: string }[]; skipped?: number }
  | { kind: 'github'; displayName: string; projectId: string };

// Read once per page load: the address bar is cleaned right after, so a reload never replays the code.
function readCallback(provider: string): Callback {
  const params = new URLSearchParams(window.location.search);
  window.history.replaceState(null, '', window.location.pathname);
  const state = params.get('state') ?? '';
  const code = params.get('code');

  if (provider === 'github_app') {
    const github = state ? takeGithubOAuthAttempt(state) : null;
    if (params.get('error') || params.get('setup_action') === 'request') {
      return { kind: 'cancelled', slug: github?.slug ?? null, ...(github ? { projectId: github.projectId } : {}) };
    }
    if (!github || !code) return { kind: 'lost' };
    const rawInstallationId = params.get('installation_id')?.trim();
    const installationId = rawInstallationId && /^[1-9][0-9]{0,19}$/.test(rawInstallationId) ? rawInstallationId : undefined;
    return {
      kind: 'finish',
      slug: github.slug,
      state,
      code,
      github: { ...github, ...(installationId ? { installationId } : {}) },
    };
  }

  const slug = state ? takeOAuthAttempt(state) : null;
  if (params.get('error')) return { kind: 'cancelled', slug };
  if (!slug || !code) return { kind: 'lost' };
  return { kind: 'finish', slug, state, code };
}

export function OAuthCallbackPage() {
  const { provider } = useParams({ strict: false }) as { provider: string };
  const t = useTranslations('social');
  const ta = useTranslations('ads');
  const tg = useTranslations('projects.github');
  const root = useTranslations();
  const isGithub = provider === 'github_app';
  // An ad platform (Meta ads, #2218) is connected from the Ads screen and goes back to it; Social keeps its own words. The
  // connection that can run ads (ADR-0043, W0b) has its own words in the same place: it reads no figures, it can change campaigns.
  const ads = !isGithub && isAdOAuthProvider(provider);
  const write = !isGithub && isAdWriteOAuthProvider(provider);
  const name = isGithub ? 'GitHub' : ads ? adProviderName(provider) : providerName(provider);
  const title = isGithub ? tg('oauthTitle') : ads ? ta(write ? 'oauth.writeTitle' : 'oauth.title') : t('oauthTitle');
  const connectedText = (list: string) => (ads ? ta(write ? 'oauth.writeConnected' : 'oauth.connected', { list }) : t('oauthConnected', { list }));
  const failedText = (list: string) => (ads ? ta(write ? 'oauth.writeFailed' : 'oauth.failed', { list }) : t('oauthFailed', { list }));
  // Read in an effect, not during render: reading takes the entry out of sessionStorage and cleans the address bar.
  // The ref keeps the first read when Strict Mode runs the effect twice.
  const read = useRef<Callback | null>(null);
  const [callback, setCallback] = useState<Callback | null>(null);
  useEffect(() => {
    read.current ??= readCallback(provider);
    setCallback(read.current);
  }, [provider]);
  const started = useRef(false);
  const finish = useMutation({
    mutationFn: async (c: Extract<Callback, { kind: 'finish' }>): Promise<FinishResult> => {
      setCurrentOrg(c.slug);
      if (isGithub && c.github) {
        const res = await client.projects.github.connectApp({
          projectId: c.github.projectId,
          state: c.state,
          code: c.code,
          ...(c.github.installationId ? { installationId: c.github.installationId } : {}),
          ...(c.github.taskKeyPrefix ? { taskKeyPrefix: c.github.taskKeyPrefix, backfillTaskNumbers: c.github.backfillTaskNumbers } : {}),
          idempotencyKey: crypto.randomUUID(),
        });
        return {
          kind: 'github',
          displayName: res.binding.connectionDisplayName,
          projectId: res.binding.projectId,
        };
      }
      // The oauth providers are a fixed list in the contract; the server refuses any other.
      const res = await client.channels.oauthFinish({ provider: provider as OAuthProvider, state: c.state, code: c.code });
      return { kind: 'channels', ...res };
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  useEffect(() => {
    if (callback?.kind !== 'finish' || started.current) return;
    started.current = true;
    finish.mutate(callback);
  }, [callback, finish]);

  const slug = !callback || callback.kind === 'lost' ? null : callback.slug;
  const projectId =
    finish.data?.kind === 'github'
      ? finish.data.projectId
      : callback?.kind === 'finish'
        ? callback.github?.projectId
        : callback?.kind === 'cancelled'
          ? callback.projectId
          : undefined;
  // Waiting for the first read or for the server.
  const busy = !callback || (callback.kind === 'finish' && (finish.isPending || finish.isIdle));
  const back = slug ? (
    isGithub ? (
      projectId ? (
        <Link to="/o/$slug/projects/$id" params={{ slug, id: projectId }} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">
          {tg('backToProject')}
        </Link>
      ) : (
        <Link to="/o/$slug/projects" params={{ slug }} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">
          {tg('backToProject')}
        </Link>
      )
    ) : ads ? (
      <Link to="/o/$slug/ads" params={{ slug }} className="text-sm font-medium text-primary hover:underline">
        {ta('oauth.backToAds')}
      </Link>
    ) : (
      <Link to="/o/$slug/social/channels" params={{ slug }} className="text-sm font-medium text-primary hover:underline">
        {t('backToChannels')}
      </Link>
    )
  ) : (
    <Link to="/" className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">
      {isGithub ? tg('backToProject') : ads ? ta('oauth.backToAds') : t('backToChannels')}
    </Link>
  );

  const githubTakenError =
    isGithub && finish.error && (finish.error as { code?: unknown } | null)?.code === 'CHANNEL_ACCOUNT_TAKEN';

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4">
      <Card className="block w-full max-w-md space-y-4 p-6">
        <ScreenTitle name={`${title}: ${name}`} />
        <h1 className="text-lg font-semibold text-foreground">
          {title}: {name}
        </h1>
        {callback?.kind === 'cancelled' && <p className="text-sm text-muted-foreground">{isGithub ? tg('oauthCancelled') : t('oauthCancelled')}</p>}
        {callback?.kind === 'lost' && <ErrorText>{isGithub ? tg('oauthLost') : ads ? ta('oauth.lost') : t('oauthLost')}</ErrorText>}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {isGithub ? tg('oauthFinishing') : t('oauthFinishing')}
          </div>
        )}
        {finish.data?.kind === 'github' && (
          <p className="text-sm text-foreground">{tg('oauthConnected', { name: finish.data.displayName })}</p>
        )}
        {finish.data?.kind === 'channels' && (
          <>
            <p className="text-sm text-foreground">{connectedText(finish.data.connections.map((c) => c.displayName).join(', '))}</p>
            {(finish.data.failed?.length ?? 0) > 0 && <ErrorText>{failedText((finish.data.failed ?? []).map((c) => c.displayName).join(', '))}</ErrorText>}
            {/* An account refused because its token can change campaigns while running ads is off: the person is told to remove the app, not only that it failed. */}
            {finish.data.failed?.some((c) => c.code === 'OAUTH_WRITE_PERMISSION') && <ErrorText>{kernelErrorMessage('OAUTH_WRITE_PERMISSION', undefined, root, { server: null })}</ErrorText>}
            {(finish.data.skipped ?? 0) > 0 && <p className="text-sm text-muted-foreground">{ads ? ta('oauth.skipped', { count: String(finish.data.skipped ?? 0), max: String(OAUTH_MAX_ACCOUNTS_PER_GRANT) }) : t('oauthSkipped', { count: finish.data.skipped ?? 0, max: OAUTH_MAX_ACCOUNTS_PER_GRANT })}</p>}
          </>
        )}
        {finish.error && <ErrorText>{githubTakenError ? tg('installationTakenError') : errorMessage(finish.error)}</ErrorText>}
        {!busy && back}
      </Card>
    </main>
  );
}

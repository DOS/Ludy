// SPDX-License-Identifier: AGPL-3.0-only
// Where a meeting platform's OAuth dialog sends the browser back (/meetings/oauth/:provider/callback, meetings integrations C3, #3175). The code and state are taken out of the address bar at once,
// then the attempt is finished for the org it was started in. The same shape as the calendar's page (calendar-oauth.tsx): the screen that started the attempt remembered its org under the state.
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { zMeetingPlatformConnectProvider } from '@crove/kernel-contract';
import { Card } from '@crove/ui/components/card';
import { ErrorText, ScreenTitle, Spinner } from '../components/ui.tsx';
import { client, errorMessage, queryClient, setCurrentOrg } from '../lib/api.ts';
import { takeOAuthAttempt } from '../lib/oauth.ts';

type Callback = { kind: 'finish'; slug: string; state: string; code: string } | { kind: 'cancelled'; slug: string | null } | { kind: 'lost' };

// Read once per page load: the address bar is cleaned right after, so a reload never replays the code.
function readCallback(known: boolean): Callback {
  const params = new URLSearchParams(window.location.search);
  window.history.replaceState(null, '', window.location.pathname);
  // An address with a platform name this app does not connect finishes nothing: the same words as a lost attempt, and nothing is taken out of the browser's storage.
  if (!known) return { kind: 'lost' };
  const state = params.get('state') ?? '';
  const slug = state ? takeOAuthAttempt(state) : null;
  if (params.get('error')) return { kind: 'cancelled', slug };
  const code = params.get('code');
  if (!slug || !code) return { kind: 'lost' };
  return { kind: 'finish', slug, state, code };
}

export function MeetingPlatformOAuthCallbackPage() {
  const { provider } = useParams({ strict: false }) as { provider: string };
  const t = useTranslations('meetings.platform.oauth');
  // Read in an effect, not during render: reading takes the entry out of sessionStorage and cleans the address bar. The ref keeps the first read when Strict Mode runs the effect twice.
  const read = useRef<Callback | null>(null);
  const [callback, setCallback] = useState<Callback | null>(null);
  // The platforms with a connect dialog are a fixed list in the contract; an address with any other name finishes nothing.
  const known = zMeetingPlatformConnectProvider.safeParse(provider);
  useEffect(() => {
    read.current ??= readCallback(known.success);
    setCallback(read.current);
  }, [known.success]);
  const started = useRef(false);
  const finish = useMutation({
    mutationFn: (c: Extract<Callback, { kind: 'finish' }>) => {
      if (!known.success) throw new Error('unknown provider');
      setCurrentOrg(c.slug);
      return client.meetingPlatform.connectFinish({ provider: known.data, state: c.state, code: c.code });
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
    <Link to="/o/$slug/settings/security" params={{ slug }} hash="meeting-platforms" className="text-sm font-medium text-primary hover:underline">
      {t('back')}
    </Link>
  ) : (
    <Link to="/" className="text-sm font-medium text-primary hover:underline">
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
        {finish.data && <p className="text-sm text-foreground">{t('connected', { name: finish.data.displayName })}</p>}
        {finish.error && <ErrorText>{errorMessage(finish.error)}</ErrorText>}
        {!busy && back}
      </Card>
    </main>
  );
}

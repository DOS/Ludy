// SPDX-License-Identifier: AGPL-3.0-only
// Where a calendar provider's OAuth dialog sends the browser back (/calendar/oauth/:provider/callback). The code and
// state are taken out of the address bar at once, then the attempt is finished for the org it was started in.
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { CalendarOAuthProvider } from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { ErrorText, ScreenTitle, Spinner } from '../components/ui.tsx';
import { client, errorMessage, queryClient, setCurrentOrg } from '../lib/api.ts';
import { needsAdminConsent, takeAdminLink } from '../lib/calendar-oauth.ts';
import { takeOAuthAttempt } from '../lib/oauth.ts';

type Callback = { kind: 'finish'; slug: string; state: string; code: string; adminLink: string | null } | { kind: 'cancelled'; slug: string | null; adminConsent: boolean; adminLink: string | null } | { kind: 'lost' };

// Read once per page load: the address bar is cleaned right after, so a reload never replays the code.
function readCallback(provider: string): Callback {
  const params = new URLSearchParams(window.location.search);
  window.history.replaceState(null, '', window.location.pathname);
  const state = params.get('state') ?? '';
  const slug = state ? takeOAuthAttempt(state) : null;
  // Kept for either way an administrator's consent can turn up: Microsoft's redirect with an error, or its refusal of the code a moment later.
  const adminLink = state ? takeAdminLink(state) : null;
  // A refusal that a Microsoft tenant's administrator has to lift is told apart from the member's own "no".
  if (params.get('error')) {
    const adminConsent = needsAdminConsent(provider, params);
    return { kind: 'cancelled', slug, adminConsent, adminLink: adminConsent ? adminLink : null };
  }
  const code = params.get('code');
  if (!slug || !code) return { kind: 'lost' };
  return { kind: 'finish', slug, state, code, adminLink };
}

export function CalendarOAuthCallbackPage() {
  const { provider } = useParams({ strict: false }) as { provider: string };
  const t = useTranslations('workingHours');
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
    mutationFn: (c: Extract<Callback, { kind: 'finish' }>) => {
      setCurrentOrg(c.slug);
      // The OAuth providers are a fixed list in the contract; the server refuses any other.
      return client.calendar.connectFinish({ provider: provider as CalendarOAuthProvider, state: c.state, code: c.code });
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
    <Link to="/o/$slug/settings/bookings" params={{ slug }} hash="booking-settings" className="text-sm font-medium text-primary hover:underline">
      {t('oauthBack')}
    </Link>
  ) : (
    <Link to="/" className="text-sm font-medium text-primary hover:underline">
      {t('oauthBack')}
    </Link>
  );

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4">
      <Card className="block w-full max-w-md space-y-4 p-6">
        <ScreenTitle name={t('oauthTitle')} />
        <h1 className="text-lg font-semibold text-foreground">{t('oauthTitle')}</h1>
        {callback?.kind === 'cancelled' && !callback.adminConsent && <p className="text-sm text-muted-foreground">{t('oauthCancelled')}</p>}
        {callback?.kind === 'cancelled' && callback.adminConsent && (
          <div className="space-y-2 text-sm text-foreground" data-testid="calendar-admin-consent">
            <p>{t('oauthAdminConsent')}</p>
            {callback.adminLink && (
              <>
                <p className="text-xs text-muted-foreground">{t('oauthAdminConsentLink')}</p>
                <code className="block break-all rounded bg-muted p-2 text-xs" data-testid="calendar-admin-link">
                  {callback.adminLink}
                </code>
              </>
            )}
          </div>
        )}
        {callback?.kind === 'lost' && <ErrorText>{t('oauthLost')}</ErrorText>}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t('oauthFinishing')}
          </div>
        )}
        {finish.data && <p className="text-sm text-foreground">{t('oauthConnected', { name: finish.data.displayName })}</p>}
        {finish.error && <ErrorText>{errorMessage(finish.error)}</ErrorText>}
        {finish.error && (finish.error as { code?: string }).code === 'OAUTH_ADMIN_CONSENT_REQUIRED' && callback?.kind === 'finish' && callback.adminLink && (
          <div className="space-y-2 text-sm text-foreground" data-testid="calendar-admin-consent">
            <p className="text-xs text-muted-foreground">{t('oauthAdminConsentLink')}</p>
            <code className="block break-all rounded bg-muted p-2 text-xs" data-testid="calendar-admin-link">
              {callback.adminLink}
            </code>
          </div>
        )}
        {!busy && back}
      </Card>
    </main>
  );
}

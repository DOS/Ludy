// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in page of the Ludy extension (/-/extension/connect, issue #2582, ADR-0047 point 10). The extension opens it in
// a browser window; the member, signed in as usual, chooses the org and says whether the extension may work with it. The
// extension never sees a password or a session: it gets a one-time code, which it trades for its own token.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ErrorText, ScreenTitle, Spinner } from '../components/ui.tsx';
import { apiFetch, errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { connectRedirect, forgetConnect, pendingConnect, type ConnectRequest } from '../lib/extension-connect.ts';

// Which roles may connect a device: a viewer holds no feature's permission (the kernel refuses them as well).
const CONNECTORS = new Set(['owner', 'admin', 'member']);

export function ExtensionConnectPage() {
  const t = useTranslations('extensionConnect');
  // Read once: the request was moved from the address bar to this tab's storage before sign-in.
  const read = useRef<ConnectRequest | null | undefined>(undefined);
  if (read.current === undefined) read.current = pendingConnect();
  const request = read.current;
  const me = useQuery(orpc.me.get.queryOptions());
  const [chosen, setChosen] = useState<string | null>(null);
  const orgs = (me.data?.orgs ?? []).filter((org) => CONNECTORS.has(org.role));
  const org = orgs.find((o) => o.slug === chosen) ?? (orgs.length === 1 ? orgs[0] : undefined);
  const needsModule = request?.scopes.includes('meetings') === true && !getConfig().modules.includes('meetings');

  const approve = useMutation({
    mutationFn: async () => {
      if (!request || !org) throw new Error('no request');
      const response = await apiFetch('/api/extension/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-crove-org': org.slug },
        body: JSON.stringify({
          codeChallenge: request.codeChallenge,
          codeChallengeMethod: 'S256',
          scopes: request.scopes,
          deviceName: request.deviceName || t('defaultDevice'),
        }),
      });
      const body = (await response.json()) as { code: string };
      return body.code;
    },
    onSuccess: (code) => {
      if (!request || !org) return;
      forgetConnect();
      window.location.assign(connectRedirect(request, { code, org: org.slug }));
    },
  });

  const deny = () => {
    if (!request) return;
    forgetConnect();
    window.location.assign(connectRedirect(request, { error: 'access_denied' }));
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4">
      <Card className="block w-full max-w-md space-y-4 p-6">
        <ScreenTitle name={t('title')} />
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        {!request && <ErrorText>{t('lost')}</ErrorText>}
        {request && needsModule && <ErrorText>{t('noFeature')}</ErrorText>}
        {request && !needsModule && me.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t('loading')}
          </div>
        )}
        {request && !needsModule && me.data && orgs.length === 0 && <ErrorText>{t('noOrg')}</ErrorText>}
        {request && !needsModule && orgs.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">{t('intro', { device: request.deviceName || t('defaultDevice') })}</p>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">{t('chooseOrg')}</legend>
              {orgs.map((o) => (
                <label key={o.slug} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm text-foreground">
                  <input type="radio" name="org" value={o.slug} checked={org?.slug === o.slug} onChange={() => setChosen(o.slug)} />
                  <span className="truncate">{o.name}</span>
                </label>
              ))}
            </fieldset>
            {org && <p className="text-sm font-medium text-foreground">{t('allow', { org: org.name })}</p>}
            <p className="break-all text-xs text-subtle-foreground">{t('extensionId', { id: new URL(request.redirect).hostname.split('.')[0] ?? '' })}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {request.scopes.map((scope) => (
                <li key={scope}>{t(`scope.${scope}`)}</li>
              ))}
              <li>{t('limits')}</li>
              <li>{t('revokeHint')}</li>
            </ul>
            {approve.error && <ErrorText>{errorMessage(approve.error)}</ErrorText>}
            <div className="flex flex-wrap gap-2">
              <Button size="lg" loading={approve.isPending} disabled={!org} onClick={() => approve.mutate()}>
                {t('approve')}
              </Button>
              <Button size="lg" variant="outline" disabled={approve.isPending} onClick={deny}>
                {t('deny')}
              </Button>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}

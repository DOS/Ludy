// SPDX-License-Identifier: AGPL-3.0-only
// The consent page of an MCP client (/oauth/interaction/<uid>, ADR-0051 decision 2, issue #2975). The person, signed in as usual, sees who is asking (the
// name the client gave itself, marked as not verified, and the address it returns to, which is the one fact they can check), picks the org, reads in plain words
// what the connection may read, and answers. An owner or admin may answer for the company or for themself; a member or viewer only for themself, and only where an owner turned that on. The client never sees a password or a session: it gets a one-time
// code, which it trades for its own tokens. No AI takes part on this page.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ErrorText, ScreenTitle, Spinner } from '../components/ui.tsx';
import { apiFetch, errorMessage } from '../lib/api.ts';
import { forgetInteraction, safeResume, type ConsentDetails } from '../lib/oauth-consent.ts';

// The write scopes a client may ask for, each a choice the person ticks (ADR-0051 decision 11, #3858): the scope id, its message keys and its test id. Listed in the order of MCP_WRITE_SCOPE_IDS.
const WRITE_OPTIONS = [
  { scope: 'ludy.social.draft', option: 'draftOption', detail: 'scope.draft', testId: 'oauth-consent-draft' },
  { scope: 'ludy.engage.write', option: 'engageOption', detail: 'scope.engage', testId: 'oauth-consent-engage' },
  { scope: 'ludy.ads.draft', option: 'adsOption', detail: 'scope.ads', testId: 'oauth-consent-ads' },
] as const;

export function OauthConsentPage({ uid }: { uid: string }) {
  const t = useTranslations('oauthConsent');
  const details = useQuery({
    queryKey: ['oauth-interaction', uid],
    retry: false,
    queryFn: async () => (await (await apiFetch(`/oauth/interaction/${encodeURIComponent(uid)}/details`)).json()) as ConsentDetails,
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [chosenKind, setChosenKind] = useState<'company' | 'member'>('company');
  const orgs = details.data?.orgs ?? [];
  const org = orgs.find((o) => o.orgId === chosen) ?? (orgs.length === 1 ? orgs[0] : undefined);
  // A member or viewer can only connect for themself; an owner or admin picks.
  const privileged = org?.role === 'owner' || org?.role === 'admin';
  const kind: 'company' | 'member' = privileged ? chosenKind : 'member';
  // A write scope (Social drafts #3227; Engage and Ads per line, #3858) is a choice, off by default: offered only when the client asked for it, and only for the company (a member grant never carries a write).
  // Each can be ticked or unticked on its own; the grant holds exactly the ticked ones.
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const askedWrites = WRITE_OPTIONS.filter((option) => details.data?.scopes.includes(option.scope) === true);
  const offeredWrites = org !== undefined && kind === 'company' ? askedWrites : [];
  const writesOn = offeredWrites.filter((option) => ticked.includes(option.scope));
  const toggle = (scope: string, on: boolean) => setTicked((current) => (on ? [...current.filter((s) => s !== scope), scope] : current.filter((s) => s !== scope)));

  const answer = useMutation({
    mutationFn: async (decision: 'approve' | 'deny') => {
      const response = await apiFetch(`/oauth/interaction/${encodeURIComponent(uid)}/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decision === 'approve' ? { decision, orgId: org?.orgId, kind, writes: writesOn.map((option) => option.scope) } : { decision }),
      });
      const body = (await response.json()) as { redirectTo?: string };
      return safeResume(body.redirectTo ?? '', window.location.origin);
    },
    onSuccess: (resume) => {
      forgetInteraction();
      if (resume) window.location.assign(resume);
    },
  });

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4">
      <Card className="block w-full max-w-md space-y-4 p-6" data-testid="oauth-consent">
        <ScreenTitle name={t('title')} />
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        {details.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t('loading')}
          </div>
        )}
        {details.error && <ErrorText>{t('lost')}</ErrorText>}
        {details.data && orgs.length === 0 && <ErrorText>{t('noOrg')}</ErrorText>}
        {details.data && orgs.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">{t('intro', { client: details.data.client.name })}</p>
            <p className="break-all text-xs text-subtle-foreground">{t('selfDeclared', { host: details.data.client.redirectHost })}</p>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">{t('chooseOrg')}</legend>
              {orgs.map((o) => (
                <label key={o.orgId} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm text-foreground">
                  <input type="radio" name="org" value={o.orgId} checked={org?.orgId === o.orgId} onChange={() => setChosen(o.orgId)} />
                  <span className="truncate">{o.name}</span>
                </label>
              ))}
            </fieldset>
            {org && privileged && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">{t('chooseKind')}</legend>
                {(['company', 'member'] as const).map((k) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm text-foreground">
                    <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setChosenKind(k)} />
                    <span>{t(k === 'company' ? 'kindCompany' : 'kindMember')}</span>
                  </label>
                ))}
              </fieldset>
            )}
            {offeredWrites.length > 0 && (
              <fieldset className="space-y-2" data-testid="oauth-consent-writes">
                <legend className="text-sm font-medium text-foreground">{t('chooseWrites')}</legend>
                {offeredWrites.map((option) => (
                  <label key={option.scope} className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm text-foreground" data-testid={option.testId}>
                    <input type="checkbox" className="mt-1" checked={ticked.includes(option.scope)} onChange={(event) => toggle(option.scope, event.target.checked)} />
                    <span>
                      <span className="block font-medium">{t(option.option)}</span>
                      <span className="block text-muted-foreground">{t(option.detail)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {askedWrites.length > 0 && org && kind === 'member' && (
              <p className="text-sm text-muted-foreground" data-testid="oauth-consent-draft-company-only">
                {t(privileged ? 'writeCompanyOnly' : 'writeOwnerOnly')}
              </p>
            )}
            {org && <p className="text-sm font-medium text-foreground">{t(writesOn.length > 0 ? 'allowWrite' : 'allow', { client: details.data.client.name, org: org.name })}</p>}
            {org && kind === 'member' && (
              <p className="text-sm text-foreground" data-testid="oauth-consent-member-only">
                {t('memberOnly', { org: org.name })}
              </p>
            )}
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t(writesOn.length > 0 ? 'scope.readWriteOn' : 'scope.read')}</li>
              {writesOn.map((option) => (
                <li key={option.scope}>{t(option.detail)}</li>
              ))}
              {kind === 'company' && <li data-testid="oauth-consent-meetings">{t('scope.meetings')}</li>}
              <li>{t(writesOn.length > 0 ? 'limitsWrite' : 'limits')}</li>
              <li>{t('actsAs')}</li>
              <li>{t('revokeHint', { days: details.data.expiresInDays })}</li>
            </ul>
            {answer.error && <ErrorText>{errorMessage(answer.error)}</ErrorText>}
            <div className="flex flex-wrap gap-2">
              <Button size="lg" loading={answer.isPending && answer.variables === 'approve'} disabled={!org || answer.isPending} onClick={() => answer.mutate('approve')}>
                {t('approve')}
              </Button>
              <Button size="lg" variant="outline" disabled={answer.isPending} onClick={() => answer.mutate('deny')}>
                {t('deny')}
              </Button>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}

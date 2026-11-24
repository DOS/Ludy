// SPDX-License-Identifier: AGPL-3.0-only
// "AI connections" in Ludy AI (was in Settings before #3225) (ADR-0051 decision 2, issue #2975): for owners and admins, the MCP clients that were given read access to this org, each with
// a one-click disconnect and, per client, an optional signed wake-up webhook (OrgMcpWake). A member sees only their own connections; an owner also holds the org's
// switch for member-bound connections (off by default). The kernel lists and revokes with kernel.mcp.grant.list and revoke and never returns a token; a disconnected client is refused on its next
// request (its tokens stop at once) and the revoke writes an audit row. The name a client shows is the one it gave itself. No AI takes part on this screen.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { MCP_WRITE_SCOPE_IDS } from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { OrgMcpWake } from './org-mcp-wake.tsx';
import { StepUpPrompt } from './two-factor.tsx';
import { ErrorText, RowsSkeleton } from './ui.tsx';

// Message keys cannot hold a dot, so a scope id has its own key.
const SCOPE_KEY = {
  'ludy.read': 'ludy_read',
  'ludy.member.read': 'ludy_member_read',
  'ludy.social.draft': 'ludy_social_draft',
  'ludy.engage.write': 'ludy_engage_write',
  'ludy.ads.draft': 'ludy_ads_draft',
} as const;
// A connection that may write is not "read only": it gets one badge that says it reads and writes, then one badge per write scope (a write scope always comes with the read scope), never a "read only"
// one beside a write.
const badgeKeys = (scopes: readonly (keyof typeof SCOPE_KEY)[]): Array<(typeof SCOPE_KEY)[keyof typeof SCOPE_KEY] | 'ludy_reads_writes'> => {
  const writes = scopes.filter((s) => (MCP_WRITE_SCOPE_IDS as readonly string[]).includes(s));
  return writes.length > 0 ? ['ludy_reads_writes', ...scopes.filter((s) => s !== 'ludy.read').map((s) => SCOPE_KEY[s])] : scopes.map((s) => SCOPE_KEY[s]);
};

export interface GrantMember {
  userId: string;
  displayName: string | null;
  email: string;
}

// The pairing code (#4591; ADR-0051 decision 2): the fallback for an AI app that cannot sign in through OAuth. An owner or admin names the connection and gets a single-use code, shown once and valid for
// 10 minutes; the app trades it at the redeem address for a token of a read-only company connection, which then appears in the list below like any other and is disconnected the same way. The kernel
// makes the code and keeps only its hash; no AI takes part here.
function PairingCode() {
  const t = useTranslations('orgMcpGrants.pairing');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  // The form disappears when the code appears, so focus moves to the code's block (a keyboard or screen reader user is not left on a button that is gone) and back to the opener when it closes.
  const codeRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const issue = useMutation(
    orpc.mcp.pairing.issue.mutationOptions({
      onError: () => void queryClient.invalidateQueries({ queryKey: orpc.mcp.key() }),
    }),
  );
  useEffect(() => {
    if (issue.data) codeRef.current?.focus();
  }, [issue.data]);
  const done = () => {
    issue.reset();
    setOpen(false);
    setLabel('');
    setCopied('no');
    void queryClient.invalidateQueries({ queryKey: orpc.mcp.key() });
    queueMicrotask(() => openerRef.current?.focus());
  };
  const copy = (code: string) => {
    // No clipboard (a page on plain http, an old browser) or a refusal: say so, and the code stays selectable on screen.
    const write = navigator.clipboard?.writeText(code);
    if (!write) return setCopied('failed');
    void write.then(
      () => setCopied('yes'),
      () => setCopied('failed'),
    );
  };
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm" data-testid="org-mcp-pairing">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{t('title')}</p>
          <p className="text-xs text-subtle-foreground">{t('hint')}</p>
        </div>
        {!open && (
          <Button ref={openerRef} size="sm" variant="outline" aria-expanded={false} onClick={() => setOpen(true)}>
            {t('open')}
          </Button>
        )}
      </div>
      {open && !issue.data && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim() !== '') issue.mutate({ label: label.trim() });
          }}
        >
          <label className="block space-y-1">
            <span className="text-foreground">{t('label')}</span>
            <Input autoFocus autoComplete="off" maxLength={120} placeholder={t('labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <p className="text-xs text-subtle-foreground">{t('scopeNote')}</p>
          <div className="space-y-1 text-xs text-subtle-foreground" data-testid="org-mcp-pairing-data">
            <p>{t('dataRead')}</p>
            <p>{t('dataMeetings')}</p>
            <p>{t('dataEngage')}</p>
          </div>
          {issue.error && !isStepUpRequired(issue.error) && <ErrorText>{errorMessage(issue.error)}</ErrorText>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={issue.isPending} disabled={label.trim() === ''}>
              {t('create')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={done}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {open && !issue.data && isStepUpRequired(issue.error) && (
        // Outside the pairing form: its challenge and enrollment forms are forms of their own, and a nested form submits the outer one too.
        <StepUpPrompt action={t('stepUp')} onVerified={() => issue.mutate({ label: label.trim() })} onCancel={() => issue.reset()} />
      )}
      {issue.data && (
        <div ref={codeRef} tabIndex={-1} className="space-y-2 rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none" role="group" aria-labelledby="org-mcp-pairing-once" data-testid="org-mcp-pairing-code">
          <p id="org-mcp-pairing-once" className="font-medium text-foreground">{t('codeOnce')}</p>
          <code className="block select-all break-all rounded bg-muted px-2 py-2 text-center text-lg font-semibold tracking-widest text-foreground">{issue.data.code}</code>
          <p className="text-xs text-subtle-foreground">{t('expires', { at: f.dateTime(issue.data.expiresAt) })}</p>
          <p className="text-xs text-subtle-foreground">{t('howTo', { url: `${origin}/oauth/pairing/redeem` })}</p>
          {copied === 'failed' && <ErrorText>{t('copyFailed')}</ErrorText>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => copy(issue.data.code)}>
              {copied === 'yes' ? t('copied') : t('copy')}
            </Button>
            <span role="status" className="sr-only">
              {copied === 'yes' ? t('copied') : ''}
            </span>
            <Button size="sm" onClick={done}>
              {t('done')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// The org's switch for member-bound grants: an owner turns it on or off. Off by default. Turning it off ends every non-admin member's connection at its next request.
function MemberGrantsSwitch() {
  const t = useTranslations('orgMcpGrants');
  const current = useQuery(orpc.mcp.memberGrants.get.queryOptions({ input: {} }));
  const set = useMutation(
    orpc.mcp.memberGrants.set.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.mcp.key() }),
      onError: () => void queryClient.invalidateQueries({ queryKey: orpc.mcp.key() }),
    }),
  );
  if (!current.data) return null;
  return (
    <div className="space-y-1 rounded-lg border p-3 text-sm" data-testid="org-mcp-member-grants">
      <label className="flex items-center gap-2 text-foreground">
        <input type="checkbox" checked={current.data.enabled} disabled={set.isPending} onChange={(e) => set.mutate({ enabled: e.target.checked })} />
        <span className="font-medium">{t('memberSwitch')}</span>
      </label>
      <p className="text-xs text-subtle-foreground">{t('memberSwitchHint')}</p>
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </div>
  );
}

// `viewerRole` decides what is shown: an owner or admin sees every connection of the org, with its wake-up; any other member only their own, and an owner also has the switch.
// The receiver's host of a wake-up an owner or admin may not change: the kernel sends `https://host` and no more.
function hostOf(url: string | undefined): string | null {
  const host = url?.replace(/^https:\/\//, '').split('/')[0] ?? '';
  return host === '' ? null : host;
}

export function OrgMcpGrants({ members, viewerRole = 'admin' }: { members: readonly GrantMember[]; viewerRole?: string }) {
  const canManage = viewerRole === 'owner' || viewerRole === 'admin';
  const t = useTranslations('orgMcpGrants');
  const f = useFormat();
  const grants = useQuery(orpc.mcp.grant.list.queryOptions({ input: {} }));
  // Every role asks: the kernel answers an owner or admin the org's wake-ups (another member's by host only) and anyone else their own.
  const wakes = useQuery(orpc.mcp.wake.get.queryOptions({ input: {} }));
  const [confirm, setConfirm] = useState<string | null>(null);
  const revoke = useMutation(
    orpc.mcp.grant.revoke.mutationOptions({
      onSuccess: () => {
        setConfirm(null);
        void queryClient.invalidateQueries({ queryKey: orpc.mcp.key() });
      },
      onError: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.mcp.key() });
      },
    }),
  );
  const ask = (id: string | null) => {
    revoke.reset();
    setConfirm(id);
  };
  const now = Date.now();
  const rows = grants.data ?? [];
  const live = rows.filter((r) => r.revokedAt === null && new Date(r.expiresAt).getTime() > now);
  const ended = rows.filter((r) => !live.includes(r));
  const nameOf = (userId: string) => {
    const m = members.find((x) => x.userId === userId);
    return m ? (m.displayName ?? m.email) : t('formerMember');
  };
  return (
    <Card className="block space-y-3 p-4" data-testid="org-mcp-grants">
      <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t(canManage ? 'intro' : 'introOwn')}</p>
      {viewerRole === 'owner' && <MemberGrantsSwitch />}
      {canManage && <PairingCode />}
      {grants.isPending && <RowsSkeleton rows={2} />}
      {grants.error && <ErrorText>{errorMessage(grants.error)}</ErrorText>}
      {grants.data && live.length === 0 && <p className="text-sm text-muted-foreground">{t('none')}</p>}
      <ul className="divide-y">
        {live.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm" data-testid="org-mcp-grant">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-foreground">
                <span className="truncate font-medium">{r.clientName}</span>
                <span className="truncate text-muted-foreground">{r.clientHost}</span>
                {r.kind === 'member' && <Badge variant="outline">{t('memberKind')}</Badge>}
                {r.clientId.startsWith('pairing:') && <Badge variant="outline">{t('pairingKind')}</Badge>}
                {badgeKeys(r.scopes).map((key) => (
                  <Badge key={key}>{t(`scope.${key}`)}</Badge>
                ))}
              </p>
              <p className="text-xs text-subtle-foreground">
                {t('givenBy', { name: nameOf(r.userId) })}
                {` · ${r.lastUsedAt ? t('lastUsed', { at: f.dateTime(r.lastUsedAt) }) : t('neverUsed')} · ${t('expiresAt', { at: f.dateTime(r.expiresAt) })}`}
              </p>
              {wakes.data && (r.kind === 'company' ? canManage : r.mine) && <OrgMcpWake key={`${r.id}:${wakes.dataUpdatedAt}`} grantId={r.id} view={wakes.data.find((w) => w.grantId === r.id)} />}
              {/* Another member's wake-up: an owner or admin sees that there is one and its host, and cuts it off by disconnecting; they cannot change it. */}
              {r.kind === 'member' && !r.mine && canManage && hostOf(wakes.data?.find((w) => w.grantId === r.id)?.url) && (
                <p className="mt-1 text-xs text-subtle-foreground" data-testid="org-mcp-wake-host">
                  {t('wakeHostOnly', { host: hostOf(wakes.data?.find((w) => w.grantId === r.id)?.url) ?? '' })}
                </p>
              )}
              {revoke.error && revoke.variables?.grantId === r.id && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
            </div>
            {confirm === r.id ? (
              <div className="flex shrink-0 gap-2" role="alertdialog" aria-label={t('confirm', { name: r.clientName })}>
                <Button size="sm" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate({ grantId: r.id })}>
                  {t('revoke')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => ask(null)}>
                  {t('cancel')}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="shrink-0" aria-label={t('disconnectOf', { name: r.clientName })} onClick={() => ask(r.id)}>
                {t('disconnect')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {ended.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-subtle-foreground">{t('ended', { count: ended.length })}</summary>
          <ul className="mt-1 divide-y">
            {ended.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-foreground">{`${r.clientName} · ${nameOf(r.userId)}`}</span>
                <Badge variant="destructive">{r.revokedAt ? t('revoked') : t('expired')}</Badge>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

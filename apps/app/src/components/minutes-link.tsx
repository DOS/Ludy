// SPDX-License-Identifier: AGPL-3.0-only
// The link to the published minutes for people outside the org (Meetings, #4822). Two parts:
//   MinutesLinkSwitchCard  in the Meetings settings, for every member to read and an owner or admin to change: "Chia sẻ biên bản ra ngoài", off by default. While it is off no link can be made or opened.
//   MinutesLinkPanel       on the recorder's meeting page, under the published minutes: "Tạo liên kết" makes a read-only link and shows the full address ONCE with a Copy button (the server keeps only a hash of
//                          the token and cannot show it again); the list says which links are live, expired or revoked and how often each was opened, never a token; "Thu hồi" ends a live link after a confirm.
// No money and no AI part here: a person decides what to share and with whom, and the core works with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import { MINUTES_LINKS_MAX, MINUTES_LINK_DAYS, type MinutesLinkItem } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { copyText, minutesShareUrl } from '../lib/minutes-link.ts';
import { toast } from '../lib/toast.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText } from './ui.tsx';

// ---------------------------------------------------------------------------
// The org setting (Meetings settings)
// ---------------------------------------------------------------------------
export function MinutesLinkSwitchCard() {
  const t = useTranslations('meetings.minutesLinkSwitch');
  const query = useQuery(orpc.meetings.minutesLink.switch.get.queryOptions({ input: {} }));
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const canEdit = orgQuery.data?.role === 'owner' || orgQuery.data?.role === 'admin';
  const enabled = query.data?.enabled === true;
  const flip = useMutation({
    mutationFn: (next: boolean) => orpc.meetings.minutesLink.switch.set.call({ enabled: next }),
    onSuccess: async () => {
      // The panels of the meeting pages read the setting through their own list.
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.minutesLink.key() });
      toast(t('saved'), 'success');
    },
  });

  if (query.isPending) return null;
  return (
    <Card data-testid="minutes-link-switch-card">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>{t('title')}</CardTitle>
        <CardDescription>{t('hint', { days: MINUTES_LINK_DAYS })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={enabled ? 'default' : 'outline'} data-testid="minutes-link-switch-state">
            {enabled ? t('stateOn') : t('stateOff')}
          </Badge>
          {canEdit ? (
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-0" loading={flip.isPending} onClick={() => flip.mutate(!enabled)} data-testid="minutes-link-switch-toggle">
              {enabled ? t('turnOff') : t('turnOn')}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
          )}
        </div>
        {flip.error ? <ErrorText>{errorMessage(flip.error)}</ErrorText> : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The recorder's panel
// ---------------------------------------------------------------------------
export type CopyOutcome = 'idle' | 'copied' | 'failed';

export interface MinutesLinkViewProps {
  slug: string | undefined;
  enabled: boolean;
  items: readonly MinutesLinkItem[];
  // An owner or admin can turn the org setting on; the others are told whom to ask.
  canEnable: boolean;
  // The address of the link made a moment ago, kept in this page only until it is hidden or left.
  made: { url: string; expiresAt: string } | null;
  copy: CopyOutcome;
  creating: boolean;
  revokingId: string | null;
  error: unknown;
  urlRef?: RefObject<HTMLInputElement | null> | undefined;
  onCreate: () => void;
  onRevoke: (linkId: string) => void;
  onCopy: () => void;
  onDismiss: () => void;
}

export function MinutesLinkView({ slug, enabled, items, canEnable, made, copy, creating, revokingId, error, urlRef, onCreate, onRevoke, onCopy, onDismiss }: MinutesLinkViewProps) {
  const t = useTranslations('meetings.minutesLink');
  const f = useFormat();
  const live = items.filter((i) => i.state === 'live').length;
  const full = live >= MINUTES_LINKS_MAX;
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-labelledby="minutes-link-title" data-testid="minutes-link">
      <div className="space-y-1">
        <h3 id="minutes-link-title" className="text-sm font-medium text-foreground">
          {t('title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>

      {!enabled ? (
        <div className="space-y-1 text-sm text-muted-foreground" data-testid="minutes-link-off">
          <p>{t('offNote')}</p>
          {canEnable ? (
            <p>
              {t('offAdmin')}{' '}
              {slug && (
                <Link to="/o/$slug/meetings" params={{ slug }} className="inline-flex min-h-11 items-center text-link underline sm:min-h-0">
                  {t('offAdminLink')}
                </Link>
              )}
            </p>
          ) : (
            <p>{t('offMember')}</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="min-h-11 sm:min-h-0" loading={creating} disabled={full} onClick={onCreate} data-testid="minutes-link-create">
              {t('create')}
            </Button>
          </div>
          {full && (
            <p className="text-xs text-warning" role="status" data-testid="minutes-link-limit">
              {t('limit', { max: MINUTES_LINKS_MAX })}
            </p>
          )}
        </div>
      )}

      {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}

      {made && (
        <div className="space-y-2 rounded-lg border border-primary/40 p-3" data-testid="minutes-link-made">
          <h4 className="text-sm font-medium text-foreground">{t('madeTitle')}</h4>
          <p className="text-xs font-medium text-warning" data-testid="minutes-link-once">
            {t('madeWarn')}
          </p>
          <p className="text-xs text-muted-foreground">{t('madeUntil', { at: f.dateTime(made.expiresAt) })}</p>
          <div className="space-y-1">
            <Label htmlFor="minutes-link-url">{t('linkLabel')}</Label>
            <div className="flex flex-wrap gap-2">
              <Input id="minutes-link-url" ref={urlRef} readOnly value={made.url} className="min-w-0 flex-1" autoComplete="off" spellCheck={false} onFocus={(e) => e.target.select()} data-testid="minutes-link-url" />
              <Button size="sm" variant="outline" className="min-h-11 sm:min-h-0" onClick={onCopy} data-testid="minutes-link-copy">
                {t('copy')}
              </Button>
            </div>
            {/* Always in the page, so a screen reader reads the words when they appear. */}
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground" data-testid="minutes-link-copy-status">
              {copy === 'copied' ? t('copied') : copy === 'failed' ? t('copyFailed') : ''}
            </p>
          </div>
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={onDismiss} data-testid="minutes-link-dismiss">
            {t('dismiss')}
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="minutes-link-empty">
          {t('empty')}
        </p>
      ) : (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">{t('listTitle')}</h4>
          <ul className="divide-y rounded-lg border text-sm" data-testid="minutes-link-list">
            {items.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="minutes-link-item">
                <Badge variant={l.state === 'live' ? 'default' : 'outline'}>{t(`state.${l.state}`)}</Badge>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-foreground">{t('created', { at: f.dateTime(l.createdAt) })}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[
                      l.state === 'revoked' && l.revokedAt ? t('revokedAt', { at: f.dateTime(l.revokedAt) }) : t('expires', { at: f.dateTime(l.expiresAt) }),
                      t('views', { count: l.views }),
                      l.firstViewedAt ? t('firstViewed', { at: f.dateTime(l.firstViewedAt) }) : t('neverViewed'),
                    ].join(' · ')}
                  </span>
                </span>
                {l.state === 'live' && (
                  <ConfirmDialog
                    render={<Button variant="ghost" size="sm" className="min-h-11 sm:min-h-0" loading={revokingId === l.id} aria-label={t('revokeFor', { at: f.dateTime(l.createdAt) })} />}
                    destructive
                    title={t('revokeTitle')}
                    description={t('revokeConfirm')}
                    confirm={t('revoke')}
                    onConfirm={() => onRevoke(l.id)}
                  >
                    {t('revoke')}
                  </ConfirmDialog>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('listNote')}</p>
        </div>
      )}
    </section>
  );
}

// Rendered for the recorder of a meeting with published minutes (the page decides); the list is the recorder's own and holds no token.
export function MinutesLinkPanel({ meetingId, slug }: { meetingId: string; slug?: string | undefined }) {
  const list = useQuery(orpc.meetings.minutesLink.list.queryOptions({ input: { meetingId } }));
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copy, setCopy] = useState<CopyOutcome>('idle');
  const urlRef = useRef<HTMLInputElement | null>(null);
  const t = useTranslations('meetings.minutesLink');
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.meetings.minutesLink.list.key() });
  const create = useMutation({
    // The answer holds the one-time address: the cache keeps nothing of it once nobody observes the mutation.
    gcTime: 0,
    mutationFn: () => orpc.meetings.minutesLink.create.call({ meetingId }),
    onSuccess: async (r) => {
      // The only time the address exists on this screen: built from the path the command answered, kept in this component only.
      setMade({ url: minutesShareUrl(window.location.origin, r.path), expiresAt: r.expiresAt });
      setCopy('idle');
      await refresh();
    },
    // A refusal (the switch went off, ten live links) is read again, so the panel shows how things stand now.
    onError: () => void refresh(),
  });
  const revoke = useMutation({
    mutationFn: (linkId: string) => orpc.meetings.minutesLink.revoke.call({ meetingId, linkId }),
    onSuccess: async () => {
      toast(t('revoked'), 'success');
      // A refusal of an earlier create (ten live links) no longer stands once a link is ended.
      create.reset();
      await refresh();
    },
  });
  // Where the address appears the keyboard goes with it, ready to copy.
  useEffect(() => {
    if (made) urlRef.current?.focus();
  }, [made]);

  if (list.isPending) return null;
  if (list.error) return <ErrorText>{errorMessage(list.error)}</ErrorText>;
  const role = orgQuery.data?.role;
  return (
    <MinutesLinkView
      slug={slug}
      enabled={list.data.enabled}
      items={list.data.items}
      canEnable={role === 'owner' || role === 'admin'}
      made={made}
      copy={copy}
      creating={create.isPending}
      revokingId={revoke.isPending ? (revoke.variables ?? null) : null}
      error={create.error ?? revoke.error}
      urlRef={urlRef}
      onCreate={() => create.mutate()}
      onRevoke={(linkId) => revoke.mutate(linkId)}
      onCopy={() => {
        if (!made) return;
        void copyText(made.url, {
          clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard,
          execCopy: () => {
            urlRef.current?.select();
            return document.execCommand('copy');
          },
        }).then((ok) => setCopy(ok ? 'copied' : 'failed'));
      }}
      onDismiss={() => {
        create.reset();
        setMade(null);
        setCopy('idle');
      }}
    />
  );
}

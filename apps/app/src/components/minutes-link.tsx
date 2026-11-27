// SPDX-License-Identifier: AGPL-3.0-only
// The link to the published minutes for people outside the org (Meetings, #4822). Two parts:
//   MinutesLinkSwitchCard  in the Meetings settings, for every member to read and an owner or admin to change: "Chia sẻ biên bản ra ngoài", off by default. While it is off no link can be made or opened.
//                          For an owner or admin (#4952), also lists the org's live minutes links with safe title hiding for unreadable attendees-only meetings and a Revoke action.
//   MinutesLinkPanel       on the recorder's meeting page (and, for an owner or admin who is not the recorder, a manager view: the same list and "Thu hồi", no create button; #4947), under the published minutes: "Tạo liên kết" makes a read-only link and shows the full address ONCE with a Copy button (the server keeps only a hash of
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
export function MinutesLinkSwitchCard({ slug }: { slug?: string | undefined } = {}) {
  const t = useTranslations('meetings.minutesLinkSwitch');
  const tLink = useTranslations('meetings.minutesLink');
  const f = useFormat();
  const query = useQuery(orpc.meetings.minutesLink.switch.get.queryOptions({ input: {} }));
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const canEdit = orgQuery.data?.role === 'owner' || orgQuery.data?.role === 'admin';
  const orgListQuery = useQuery({ ...orpc.meetings.minutesLink.orgList.queryOptions({ input: {} }), enabled: canEdit, refetchOnWindowFocus: false });
  const enabled = query.data?.enabled === true;
  const flip = useMutation({
    mutationFn: (next: boolean) => orpc.meetings.minutesLink.switch.set.call({ enabled: next }),
    onSuccess: async () => {
      // The panels of the meeting pages read the setting through their own list.
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.minutesLink.key() });
      toast(t('saved'), 'success');
    },
  });
  const revoke = useMutation({
    mutationFn: (args: { meetingId: string; linkId: string }) => orpc.meetings.minutesLink.revoke.call(args),
    onError: () => void queryClient.invalidateQueries({ queryKey: orpc.meetings.minutesLink.key() }),
    onSuccess: async () => {
      toast(tLink('revoked'), 'success');
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.minutesLink.key() });
    },
  });

  if (query.isPending) return null;
  const orgItems = orgListQuery.data?.items ?? [];
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
        {canEdit && (orgListQuery.data !== undefined || orgListQuery.error) ? (
          <div className="space-y-2 border-t pt-3" data-testid="org-minutes-links">
            <h3 className="text-xs font-medium text-muted-foreground">{t('orgListTitle')}</h3>
            {orgListQuery.error ? (
              <ErrorText>{errorMessage(orgListQuery.error)}</ErrorText>
            ) : orgItems.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="org-minutes-links-empty">
                {t('orgListEmpty')}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border text-sm" data-testid="org-minutes-links-list">
                {orgItems.map((l) => {
                  const meetingLabel = l.canOpenMeeting && l.meetingTitle !== null ? l.meetingTitle : t('orgListPrivate');
                  return (
                    <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-testid="org-minutes-link-item">
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="min-w-0">
                          {l.canOpenMeeting && l.meetingTitle !== null ? (
                            slug ? (
                              <Link
                                to="/o/$slug/meetings/$id"
                                params={{ slug, id: l.meetingId }}
                                className="inline-flex min-h-11 items-center font-medium text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-0"
                                data-testid="org-minutes-link-meeting"
                              >
                                <span className="min-w-0 break-words">{l.meetingTitle}</span>
                              </Link>
                            ) : (
                              <span className="font-medium text-foreground break-words" data-testid="org-minutes-link-meeting">
                                {l.meetingTitle}
                              </span>
                            )
                          ) : (
                            <span className="italic text-muted-foreground" data-testid="org-minutes-link-private">
                              {t('orgListPrivate')}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {[
                            l.createdByName ? t('orgListCreatedBy', { name: l.createdByName }) : null,
                            tLink('views', { count: l.views }),
                            tLink('created', { at: f.dateTime(l.createdAt) }),
                            tLink('expires', { at: f.dateTime(l.expiresAt) }),
                            l.firstViewedAt ? tLink('firstViewed', { at: f.dateTime(l.firstViewedAt) }) : tLink('neverViewed'),
                          ]
                            .filter((part): part is string => part !== null)
                            .join(' · ')}
                        </p>
                      </div>
                      <ConfirmDialog
                        disabled={revoke.isPending}
                        render={
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-11 shrink-0"
                            loading={revoke.isPending && revoke.variables?.linkId === l.id}
                            disabled={revoke.isPending}
                            aria-label={t('orgListRevokeFor', { meeting: meetingLabel, at: f.dateTime(l.createdAt) })}
                            data-testid="org-minutes-link-revoke"
                          />
                        }
                        destructive
                        title={tLink('revokeTitle')}
                        description={tLink('revokeConfirmManager')}
                        confirm={tLink('revoke')}
                        onConfirm={() => revoke.mutate({ meetingId: l.meetingId, linkId: l.id })}
                      >
                        {tLink('revoke')}
                      </ConfirmDialog>
                    </li>
                  );
                })}
              </ul>
            )}
            {revoke.error ? <ErrorText>{errorMessage(revoke.error)}</ErrorText> : null}
          </div>
        ) : null}
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
  // False for an owner or admin who is not the recorder (#4947): they see the links and can end one, they cannot make one.
  canCreate?: boolean | undefined;
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

export function MinutesLinkView({ slug, enabled, items, canEnable, canCreate = true, made, copy, creating, revokingId, error, urlRef, onCreate, onRevoke, onCopy, onDismiss }: MinutesLinkViewProps) {
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
        <p className="text-xs text-muted-foreground">{canCreate ? t('hint') : t('managerHint')}</p>
      </div>

      {!canCreate ? null : !enabled ? (
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
                    description={canCreate ? t('revokeConfirm') : t('revokeConfirmManager')}
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

// Rendered for the recorder of a meeting with published minutes (the page decides); the list is the recorder's own and holds no token. With `manager` it is the view of an owner or admin who is not
// the recorder (#4947): nothing is asked or drawn for anyone else, there is no create button, and a meeting with no link draws nothing (an owner or admin sees a panel only when there is a link to end).
export function MinutesLinkPanel({ meetingId, slug, manager = false }: { meetingId: string; slug?: string | undefined; manager?: boolean | undefined }) {
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const isAdmin = orgQuery.data?.role === 'owner' || orgQuery.data?.role === 'admin';
  // A reader who is neither recorder nor owner or admin would be refused (403): the list is not even asked for.
  const list = useQuery({ ...orpc.meetings.minutesLink.list.queryOptions({ input: { meetingId } }), enabled: !manager || isAdmin });
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copy, setCopy] = useState<CopyOutcome>('idle');
  const urlRef = useRef<HTMLInputElement | null>(null);
  const t = useTranslations('meetings.minutesLink');
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.meetings.minutesLink.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.meetings.minutesLink.orgList.key() }),
    ]);
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
    // A refusal (the link is gone, the org changed) is read again, so the list shows how things stand now.
    onError: () => void refresh(),
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

  if (manager && !isAdmin) return null;
  if (list.isPending) return null;
  if (list.error) return <ErrorText>{errorMessage(list.error)}</ErrorText>;
  if (manager && list.data.items.length === 0) return null;
  return (
    <MinutesLinkView
      slug={slug}
      enabled={list.data.enabled}
      items={list.data.items}
      canEnable={isAdmin}
      canCreate={!manager}
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

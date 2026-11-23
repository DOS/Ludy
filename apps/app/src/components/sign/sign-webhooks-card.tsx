// SPDX-License-Identifier: AGPL-3.0-only
// Owner/admin outbound HMAC webhook management & delivery log section for eSign Settings (Slice 5b, #4440).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { ConfirmDialog } from '../confirm-dialog.tsx';
import { Empty, ErrorText, ListSkeleton } from '../ui.tsx';
import { useFormat } from '../../i18n/provider.tsx';
import { errorMessage, queryClient } from '../../lib/api.ts';
import {
  SIGN_WEBHOOK_EVENT_TYPES,
  signApi,
  type SignWebhookDeliveryRecord,
  type SignWebhookEventType,
  type SignWebhookListResult,
  type SignWebhookRecord,
} from '../../lib/sign-api.ts';
import { toast } from '../../lib/toast.ts';

export function canManageSignWebhooks(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

const EVENT_I18N_KEY: Record<
  SignWebhookEventType,
  'envelope_sent' | 'signer_signed' | 'envelope_completed' | 'envelope_declined' | 'envelope_expired'
> = {
  'sign.envelope.sent': 'envelope_sent',
  'sign.signer.signed': 'signer_signed',
  'sign.envelope.completed': 'envelope_completed',
  'sign.envelope.declined': 'envelope_declined',
  'sign.envelope.expired': 'envelope_expired',
};

export interface SignWebhooksViewProps {
  role: string | null | undefined;
  list: SignWebhookListResult | null;
  deliveries: SignWebhookDeliveryRecord[];
  selectedWebhookId: string | null;
  revealedSecret: { webhookUrl: string; secret: string; hint: string } | null;
  busyAction?: string | null;
  onSelectWebhook?: (webhookId: string | null) => void;
  onDismissSecret?: () => void;
  onCreate?: (input: { url: string; events: SignWebhookEventType[] }) => void;
  onUpdate?: (input: {
    webhookId: string;
    url: string;
    events: SignWebhookEventType[];
    enabled: boolean;
  }) => void;
  onRotateSecret?: (webhook: SignWebhookRecord) => void;
  onPing?: (webhook: SignWebhookRecord) => void;
  onDelete?: (webhook: SignWebhookRecord) => void;
}

export function SignWebhooksView({
  role,
  list,
  deliveries,
  selectedWebhookId,
  revealedSecret,
  busyAction = null,
  onSelectWebhook,
  onDismissSecret,
  onCreate,
  onUpdate,
  onRotateSecret,
  onPing,
  onDelete,
}: SignWebhooksViewProps) {
  const t = useTranslations('sign.webhooks');
  const f = useFormat();
  const canManage = canManageSignWebhooks(role);

  const [newUrl, setNewUrl] = useState('');
  const [newEvents, setNewEvents] = useState<SignWebhookEventType[]>([...SIGN_WEBHOOK_EVENT_TYPES]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editEvents, setEditEvents] = useState<SignWebhookEventType[]>([]);
  const [editEnabled, setEditEnabled] = useState(true);
  const [deletingTarget, setDeletingTarget] = useState<SignWebhookRecord | null>(null);
  const [rotatingTarget, setRotatingTarget] = useState<SignWebhookRecord | null>(null);

  if (!canManage) {
    return (
      <Card data-testid="sign-webhooks-readonly-card">
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert data-testid="sign-webhooks-readonly-notice">
            <AlertDescription>{t('memberReadOnlyNotice')}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const webhooks = list?.items ?? [];
  const brokerAvailable = list?.brokerAvailable ?? true;

  const toggleEventInList = (
    current: readonly SignWebhookEventType[],
    event: SignWebhookEventType,
  ): SignWebhookEventType[] =>
    current.includes(event) ? current.filter((item) => item !== event) : [...current, event];

  const handleCreateSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newUrl.trim();
    if (!trimmed || newEvents.length === 0) return;
    onCreate?.({ url: trimmed, events: newEvents });
    setNewUrl('');
  };

  const beginEdit = (wh: SignWebhookRecord) => {
    setEditingId(wh.id);
    setEditUrl(wh.url);
    setEditEvents([...wh.events]);
    setEditEnabled(wh.enabled);
  };

  const handleCopySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      toast(t('secretCopiedToast'));
    } catch {
      toast(t('secretCopyFailedToast'), 'error');
    }
  };

  const nowMs = Date.now();

  return (
    <div className="space-y-4" data-testid="sign-webhooks-section">
      <Card data-testid="sign-webhooks-card">
        <CardHeader className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">{t('title')}</CardTitle>
            <Badge variant="outline" data-testid="sign-webhooks-count-badge">
              {t('endpointCountBadge', { count: f.number(webhooks.length) })}
            </Badge>
          </div>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <Alert data-testid="sign-webhooks-privacy-banner">
            <AlertDescription>{t('privacyExclusionNotice')}</AlertDescription>
          </Alert>

          {!brokerAvailable ? (
            <Alert data-testid="sign-webhooks-broker-missing">
              <AlertDescription>{t('brokerMissingNotice')}</AlertDescription>
            </Alert>
          ) : null}

          {revealedSecret ? (
            <Alert data-testid="sign-webhooks-secret-reveal">
              <AlertDescription className="space-y-2.5">
                <p className="font-medium text-foreground">
                  {t('secretRevealTitle', { url: revealedSecret.webhookUrl, hint: revealedSecret.hint })}
                </p>
                <p className="text-xs text-muted-foreground">{t('secretRevealHint')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code
                    className="rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-xs break-all text-foreground"
                    data-testid="sign-webhooks-secret-value"
                  >
                    {revealedSecret.secret}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleCopySecret(revealedSecret.secret)}
                    data-testid="sign-webhooks-secret-copy"
                  >
                    {t('copySecretButton')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onDismissSecret?.()}
                    data-testid="sign-webhooks-secret-dismiss"
                  >
                    {t('dismissSecretButton')}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          {brokerAvailable ? (
            <form
              onSubmit={handleCreateSubmit}
              className="space-y-3 rounded-lg border border-border bg-muted/30 p-4"
              data-testid="sign-webhooks-create-form"
            >
              <div className="space-y-1.5">
                <Label htmlFor="sign-webhook-new-url">{t('urlLabel')}</Label>
                <Input
                  id="sign-webhook-new-url"
                  type="url"
                  className="min-h-11"
                  value={newUrl}
                  placeholder={t('urlPlaceholder')}
                  onChange={(e) => setNewUrl(e.target.value)}
                  data-testid="sign-webhook-new-url-input"
                />
                <p className="text-xs text-muted-foreground">{t('urlHint')}</p>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-foreground">{t('eventsLabel')}</span>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {SIGN_WEBHOOK_EVENT_TYPES.map((ev) => {
                    const inputId = `sign-webhook-new-ev-${ev}`;
                    const checked = newEvents.includes(ev);
                    return (
                      <label
                        key={ev}
                        htmlFor={inputId}
                        className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                      >
                        <Checkbox
                          id={inputId}
                          checked={checked}
                          onCheckedChange={() => setNewEvents((prev) => toggleEventInList(prev, ev))}
                        />
                        <span>{t(`events.${EVENT_I18N_KEY[ev]}`)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  loading={busyAction === 'create'}
                  disabled={!newUrl.trim() || newEvents.length === 0}
                  data-testid="sign-webhook-create-submit"
                >
                  {t('addEndpointButton')}
                </Button>
              </div>
            </form>
          ) : null}

          {webhooks.length === 0 ? (
            <Empty title={t('emptyTitle')} hint={t('emptyHint')} />
          ) : (
            <div className="space-y-3" data-testid="sign-webhooks-list">
              {webhooks.map((wh) => {
                const isEditing = editingId === wh.id;
                const graceActive =
                  wh.previousExpiresAt !== null && Date.parse(wh.previousExpiresAt) > nowMs;
                const isSelected = selectedWebhookId === wh.id;

                return (
                  <div
                    key={wh.id}
                    className="space-y-3 rounded-lg border border-border bg-card p-4"
                    data-testid={`sign-webhook-row-${wh.id}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs break-all text-foreground">{wh.url}</span>
                          <Badge
                            variant={
                              wh.pausedReason === 'failing'
                                ? 'destructive'
                                : wh.enabled
                                  ? 'success'
                                  : 'secondary'
                            }
                            data-testid={`sign-webhook-status-${wh.id}`}
                          >
                            {wh.pausedReason === 'failing'
                              ? t('statusPausedFailing')
                              : wh.enabled
                                ? t('statusActive')
                                : t('statusDisabled')}
                          </Badge>
                          {graceActive && wh.previousExpiresAt ? (
                            <Badge variant="warning" data-testid={`sign-webhook-grace-${wh.id}`}>
                              {t('rotationGraceBadge', { time: f.dateTime(wh.previousExpiresAt) })}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>
                            {t('keyHintLabel')}: <code className="font-mono">{wh.secretHint}</code>
                          </span>
                          {wh.lastDeliveryAt ? (
                            <span>
                              {t('lastDeliveryLabel', {
                                time: f.dateTime(wh.lastDeliveryAt),
                              })}
                            </span>
                          ) : (
                            <span>{t('neverDeliveredLabel')}</span>
                          )}
                          {wh.consecutiveFailures > 0 ? (
                            <span className="text-destructive">
                              {t('consecutiveFailuresLabel', { count: f.number(wh.consecutiveFailures) })}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!wh.enabled || !brokerAvailable}
                          loading={busyAction === `ping:${wh.id}`}
                          onClick={() => onPing?.(wh)}
                          data-testid={`sign-webhook-ping-${wh.id}`}
                        >
                          {t('pingButton')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!brokerAvailable}
                          loading={busyAction === `rotate:${wh.id}`}
                          onClick={() => setRotatingTarget(wh)}
                          data-testid={`sign-webhook-rotate-${wh.id}`}
                        >
                          {t('rotateSecretButton')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => (isEditing ? setEditingId(null) : beginEdit(wh))}
                          data-testid={`sign-webhook-edit-${wh.id}`}
                        >
                          {isEditing ? t('cancelButton') : t('editButton')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={isSelected ? 'secondary' : 'ghost'}
                          onClick={() => onSelectWebhook?.(isSelected ? null : wh.id)}
                          data-testid={`sign-webhook-filter-deliveries-${wh.id}`}
                        >
                          {t('viewDeliveriesButton')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          loading={busyAction === `delete:${wh.id}`}
                          onClick={() => setDeletingTarget(wh)}
                          data-testid={`sign-webhook-delete-${wh.id}`}
                        >
                          {t('deleteButton')}
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {wh.events.map((ev) => (
                        <Badge key={ev} variant="outline">
                          {t(`events.${EVENT_I18N_KEY[ev]}`)}
                        </Badge>
                      ))}
                    </div>

                    {wh.pausedReason === 'failing' ? (
                      <Alert data-testid={`sign-webhook-paused-alert-${wh.id}`}>
                        <AlertDescription>{t('pausedFailingHint')}</AlertDescription>
                      </Alert>
                    ) : null}

                    {isEditing ? (
                      <div
                        className="space-y-3 rounded-md border border-border bg-muted/30 p-3"
                        data-testid={`sign-webhook-edit-panel-${wh.id}`}
                      >
                        <div className="space-y-1.5">
                          <Label htmlFor={`sign-webhook-edit-url-${wh.id}`}>{t('urlLabel')}</Label>
                          <Input
                            id={`sign-webhook-edit-url-${wh.id}`}
                            type="url"
                            className="min-h-11"
                            value={editUrl}
                            onChange={(e) => setEditUrl(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {SIGN_WEBHOOK_EVENT_TYPES.map((ev) => {
                            const checkId = `sign-webhook-edit-${wh.id}-${ev}`;
                            return (
                              <label
                                key={ev}
                                htmlFor={checkId}
                                className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                              >
                                <Checkbox
                                  id={checkId}
                                  checked={editEvents.includes(ev)}
                                  onCheckedChange={() =>
                                    setEditEvents((prev) => toggleEventInList(prev, ev))
                                  }
                                />
                                <span>{t(`events.${EVENT_I18N_KEY[ev]}`)}</span>
                              </label>
                            );
                          })}
                        </div>
                        <label
                          htmlFor={`sign-webhook-edit-enabled-${wh.id}`}
                          className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                        >
                          <Checkbox
                            id={`sign-webhook-edit-enabled-${wh.id}`}
                            checked={editEnabled}
                            onCheckedChange={(checked) => setEditEnabled(checked === true)}
                          />
                          <span>{t('enabledToggleLabel')}</span>
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            loading={busyAction === `update:${wh.id}`}
                            disabled={!editUrl.trim() || editEvents.length === 0}
                            onClick={() => {
                              onUpdate?.({
                                webhookId: wh.id,
                                url: editUrl.trim(),
                                events: editEvents,
                                enabled: editEnabled,
                              });
                              setEditingId(null);
                            }}
                            data-testid={`sign-webhook-save-${wh.id}`}
                          >
                            {t('saveChangesButton')}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="sign-webhook-deliveries-card">
        <CardHeader className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">{t('deliveriesTitle')}</CardTitle>
            {selectedWebhookId ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onSelectWebhook?.(null)}
                data-testid="sign-webhook-deliveries-show-all"
              >
                {t('showAllDeliveriesButton')}
              </Button>
            ) : null}
          </div>
          <CardDescription className="text-xs">{t('deliveriesSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {deliveries.length === 0 ? (
            <Empty title={t('deliveriesEmptyTitle')} hint={t('deliveriesEmptyHint')} />
          ) : (
            <div className="overflow-x-auto" data-testid="sign-webhook-deliveries-list">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t('deliveryColEvent')}</th>
                    <th className="py-2 pr-3 font-medium">{t('deliveryColStatus')}</th>
                    <th className="py-2 pr-3 font-medium">{t('deliveryColCode')}</th>
                    <th className="py-2 pr-3 font-medium">{t('deliveryColAttempts')}</th>
                    <th className="py-2 font-medium">{t('deliveryColTime')}</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr
                      key={d.id}
                      className="border-b border-border/60 last:border-b-0"
                      data-testid={`sign-webhook-delivery-row-${d.id}`}
                    >
                      <td className="py-2.5 pr-3 font-mono text-foreground">
                        {d.eventType === 'ping' ? t('pingEventLabel') : t(`events.${EVENT_I18N_KEY[d.eventType]}`)}
                      </td>
                      <td className="py-2.5 pr-3">
                        <Badge
                          variant={
                            d.status === 'sent'
                              ? 'success'
                              : d.status === 'failed'
                                ? 'destructive'
                                : d.status === 'dropped'
                                  ? 'secondary'
                                  : 'outline'
                          }
                        >
                          {t(`deliveryStatuses.${d.status}`)}
                        </Badge>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-muted-foreground">
                        {d.lastCode !== null ? String(d.lastCode) : '-'}
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{d.attempts}</td>
                      <td className="py-2.5 text-muted-foreground">
                        {f.dateTime(d.sentAt ?? d.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={rotatingTarget !== null}
        onOpenChange={(open) => !open && setRotatingTarget(null)}
        title={t('rotateConfirmTitle')}
        description={t('rotateConfirmDescription')}
        confirm={t('rotateSecretButton')}
        disabled={rotatingTarget !== null && busyAction === `rotate:${rotatingTarget.id}`}
        onConfirm={() => {
          if (rotatingTarget) {
            onRotateSecret?.(rotatingTarget);
            setRotatingTarget(null);
          }
        }}
      />

      <ConfirmDialog
        open={deletingTarget !== null}
        onOpenChange={(open) => !open && setDeletingTarget(null)}
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirmDescription', { url: deletingTarget?.url ?? '' })}
        confirm={t('deleteButton')}
        destructive
        disabled={deletingTarget !== null && busyAction === `delete:${deletingTarget.id}`}
        onConfirm={() => {
          if (deletingTarget) {
            onDelete?.(deletingTarget);
            setDeletingTarget(null);
          }
        }}
      />
    </div>
  );
}

export function SignWebhooksSection({ role }: { role: string | null | undefined }) {
  const t = useTranslations('sign.webhooks');
  const canManage = canManageSignWebhooks(role);
  const [selectedWebhookId, setSelectedWebhookId] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{
    webhookUrl: string;
    secret: string;
    hint: string;
  } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const webhooksQuery = useQuery({
    queryKey: ['sign', 'webhooks'],
    queryFn: () => signApi.listWebhooks(),
    enabled: canManage,
  });

  const deliveriesQuery = useQuery({
    queryKey: ['sign', 'webhook-deliveries', selectedWebhookId ?? 'all'],
    queryFn: () =>
      signApi.listWebhookDeliveries({
        ...(selectedWebhookId ? { webhookId: selectedWebhookId } : {}),
        limit: 30,
      }),
    enabled: canManage,
  });

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sign', 'webhooks'] }),
      queryClient.invalidateQueries({ queryKey: ['sign', 'webhook-deliveries'] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: async (input: { url: string; events: SignWebhookEventType[] }) => {
      setBusyAction('create');
      return signApi.createWebhook(input);
    },
    onSuccess: async (res) => {
      toast(t('createdToast'));
      if (res.secret) {
        setRevealedSecret({
          webhookUrl: res.webhook.url,
          secret: res.secret,
          hint: res.webhook.secretHint,
        });
      }
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setBusyAction(null),
  });

  const updateMutation = useMutation({
    mutationFn: async (input: {
      webhookId: string;
      url: string;
      events: SignWebhookEventType[];
      enabled: boolean;
    }) => {
      setBusyAction(`update:${input.webhookId}`);
      return signApi.updateWebhook(input);
    },
    onSuccess: async () => {
      toast(t('updatedToast'));
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setBusyAction(null),
  });

  const rotateMutation = useMutation({
    mutationFn: async (wh: SignWebhookRecord) => {
      setBusyAction(`rotate:${wh.id}`);
      return signApi.rotateWebhookSecret(wh.id);
    },
    onSuccess: async (res) => {
      toast(t('rotatedToast'));
      if (res.secret) {
        setRevealedSecret({
          webhookUrl: res.webhook.url,
          secret: res.secret,
          hint: res.webhook.secretHint,
        });
      }
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setBusyAction(null),
  });

  const pingMutation = useMutation({
    mutationFn: async (wh: SignWebhookRecord) => {
      setBusyAction(`ping:${wh.id}`);
      return signApi.pingWebhook(wh.id);
    },
    onSuccess: async () => {
      toast(t('pingQueuedToast'));
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setBusyAction(null),
  });

  const deleteMutation = useMutation({
    mutationFn: async (wh: SignWebhookRecord) => {
      setBusyAction(`delete:${wh.id}`);
      return signApi.deleteWebhook(wh.id);
    },
    onSuccess: async (res) => {
      toast(t('deletedToast'));
      if (selectedWebhookId === res.webhookId) {
        setSelectedWebhookId(null);
      }
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setBusyAction(null),
  });

  if (!canManage) {
    return (
      <SignWebhooksView
        role={role}
        list={null}
        deliveries={[]}
        selectedWebhookId={null}
        revealedSecret={null}
      />
    );
  }

  if (webhooksQuery.isPending) {
    return <ListSkeleton />;
  }

  if (webhooksQuery.error) {
    return <ErrorText>{errorMessage(webhooksQuery.error)}</ErrorText>;
  }

  return (
    <SignWebhooksView
      role={role}
      list={webhooksQuery.data}
      deliveries={deliveriesQuery.data?.items ?? []}
      selectedWebhookId={selectedWebhookId}
      revealedSecret={revealedSecret}
      busyAction={busyAction}
      onSelectWebhook={setSelectedWebhookId}
      onDismissSecret={() => setRevealedSecret(null)}
      onCreate={(input) => createMutation.mutate(input)}
      onUpdate={(input) => updateMutation.mutate(input)}
      onRotateSecret={(wh) => rotateMutation.mutate(wh)}
      onPing={(wh) => pingMutation.mutate(wh)}
      onDelete={(wh) => deleteMutation.mutate(wh)}
    />
  );
}

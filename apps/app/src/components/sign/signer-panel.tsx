// SPDX-License-Identifier: AGPL-3.0-only
// Left-rail signer roster, routing toggle, delivery/OTP settings, and active Zalo/email controls (#3325).
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { cn } from '@ludy/ui/lib/utils';
import type { SignSignerRecord } from '../../lib/sign-api.ts';
import {
  SIGN_DELIVERY_MODES,
  SIGN_ROUTING_MODES,
  SIGN_SIGNER_ROLES,
  signerChipStyle,
  type SignDeliveryMode,
  type SignEnvelopeStatus,
  type SignRoutingMode,
  type SignSignerRole,
} from '../../lib/sign-fields.ts';
import { ErrorText, isEmailAddress } from '../ui.tsx';

export interface AddSignerFormInput {
  name: string;
  email?: string;
  phone?: string;
  signerRole: SignSignerRole;
  roleLabel?: string;
  deliveryMode: SignDeliveryMode;
  requireEmailOtp: boolean;
}

export interface SignerPanelProps {
  envelopeStatus: SignEnvelopeStatus;
  routingMode: SignRoutingMode;
  signers: readonly SignSignerRecord[];
  activeSignerId: string | null;
  busy?: boolean;
  onSelectSigner: (signerId: string) => void;
  onChangeRoutingMode: (mode: SignRoutingMode) => void;
  onAddSigner: (input: AddSignerFormInput) => Promise<void>;
  onRemoveSigner: (signerId: string) => Promise<void>;
  onMoveSigner: (signerId: string, direction: -1 | 1) => Promise<void>;
  onCopyZaloLink?: ((signerId: string) => Promise<void>) | undefined;
  onRemindSigner?: ((signerId: string) => Promise<void>) | undefined;
  onCorrectSigner?: ((signer: SignSignerRecord) => void) | undefined;
  onStartInPerson?: ((signerId: string) => void) | undefined;
  // False when the caller reads the draft but may not change it (a meeting-minutes envelope of another member, #4530): the add form and the order and remove controls are not offered. Default true.
  canEditDraft?: boolean | undefined;
}

const SIGNER_STATUS_VARIANT = {
  waiting: 'outline',
  pending: 'warning',
  viewed: 'secondary',
  signed: 'success',
  declined: 'destructive',
  voided: 'destructive',
  expired: 'outline',
} as const;

export function SignerPanel({
  envelopeStatus,
  routingMode,
  signers,
  activeSignerId,
  busy = false,
  onSelectSigner,
  onChangeRoutingMode,
  onAddSigner,
  onRemoveSigner,
  onMoveSigner,
  onCopyZaloLink,
  onRemindSigner,
  onCorrectSigner,
  onStartInPerson,
  canEditDraft = true,
}: SignerPanelProps) {
  const t = useTranslations('sign');
  const isDraft = envelopeStatus === 'draft';
  const canEdit = isDraft && canEditDraft;
  const isActiveEnvelope = envelopeStatus === 'sent' || envelopeStatus === 'in_progress';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [signerRole, setSignerRole] = useState<SignSignerRole>('signer');
  const [roleLabel, setRoleLabel] = useState('');
  const [deliveryMode, setDeliveryMode] = useState<SignDeliveryMode>('link');
  const [requireEmailOtp, setRequireEmailOtp] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      setFormError(t('signer.nameLabel'));
      return;
    }
    if ((deliveryMode === 'email' || requireEmailOtp) && !isEmailAddress(trimmedEmail)) {
      setFormError(t('signer.emailNeededForOtp'));
      return;
    }
    setSubmitting(true);
    try {
      await onAddSigner({
        name: trimmedName,
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        signerRole,
        ...(roleLabel.trim() ? { roleLabel: roleLabel.trim() } : {}),
        deliveryMode,
        requireEmailOtp,
      });
      setName('');
      setEmail('');
      setPhone('');
      setRoleLabel('');
      setRequireEmailOtp(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{t('signer.panelTitle', { count: String(signers.length) })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="sign-routing-mode" className="text-xs">
            {t('routing.label')}
          </Label>
          <NativeSelect
            id="sign-routing-mode"
            value={routingMode}
            disabled={!canEdit || busy}
            className="w-full"
            onChange={(e) => onChangeRoutingMode(e.target.value as SignRoutingMode)}
          >
            {SIGN_ROUTING_MODES.map((mode) => (
              <NativeSelectOption key={mode} value={mode}>
                {t(`routing.${mode}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            {routingMode === 'sequential' ? t('routing.hintSequential') : t('routing.hintParallel')}
          </p>
        </div>

        {signers.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t('signer.noSignersYet')}</p>
        ) : (
          <ul className="space-y-2" data-testid="signer-list">
            {signers.map((signer, index) => {
              const palette = signerChipStyle(index);
              const isSelected = signer.id === activeSignerId;
              const canLinkOrRemind = !isDraft && (signer.status === 'pending' || signer.status === 'viewed');
              const isUnsigned = signer.status === 'waiting' || signer.status === 'pending' || signer.status === 'viewed';
              const canCorrect = Boolean(onCorrectSigner && isActiveEnvelope && isUnsigned);
              return (
                <li
                  key={signer.id}
                  data-testid={`signer-row-${signer.id}`}
                  className={cn(
                    'rounded-lg border p-2.5 transition-colors',
                    isSelected ? 'border-primary bg-primary/5' : 'bg-card',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      disabled={signer.signerRole === 'cc'}
                      onClick={() => onSelectSigner(signer.id)}
                      data-testid={`signer-select-${signer.id}`}
                      className={cn(
                        'flex min-w-0 flex-1 items-start gap-2 text-left',
                        signer.signerRole === 'cc' && 'cursor-default opacity-80',
                      )}
                    >
                      <span className={cn('mt-1 size-2.5 shrink-0 rounded-full', palette.dot)} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{signer.name}</span>
                        {signer.email ? (
                          <span className="block truncate text-xs text-muted-foreground">{signer.email}</span>
                        ) : null}
                        {signer.delegatedFromName ? (
                          <span
                            className="mt-0.5 block truncate text-[11px] text-muted-foreground"
                            data-testid={`signer-delegated-${signer.id}`}
                          >
                            {signer.delegatedFromEmail
                              ? t('signer.delegatedBy', { name: signer.delegatedFromName, email: signer.delegatedFromEmail })
                              : t('signer.delegatedByNameOnly', { name: signer.delegatedFromName })}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <Badge variant={SIGNER_STATUS_VARIANT[signer.status]} className="shrink-0">
                      {t(`signer.statuses.${signer.status}`)}
                    </Badge>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="secondary">{t(`signer.roles.${signer.signerRole}`)}</Badge>
                    <Badge variant="outline">{t(`signer.deliveries.${signer.deliveryMode}`)}</Badge>
                    {routingMode === 'sequential' ? (
                      <Badge variant="outline">{t('signer.orderBadge', { order: String(signer.routingOrder) })}</Badge>
                    ) : null}
                    {signer.requireEmailOtp ? <Badge variant="outline">OTP</Badge> : null}
                    {signer.preExpiryRemindedAt ? (
                      signer.preExpiryRemindStatus === 'suppressed' ? (
                        <Badge variant="warning" data-testid={`signer-pre-expiry-suppressed-${signer.id}`}>
                          {t('signer.preExpirySuppressedBadge')}
                        </Badge>
                      ) : signer.preExpiryRemindStatus === 'failed' || signer.preExpiryRemindStatus === 'bounced' ? (
                        <Badge variant="destructive" data-testid={`signer-pre-expiry-failed-${signer.id}`}>
                          {t('signer.preExpiryFailedBadge')}
                        </Badge>
                      ) : signer.preExpiryRemindStatus === 'sent' || signer.preExpiryRemindStatus === 'delivered' ? (
                        <Badge variant="outline" data-testid={`signer-pre-expiry-reminded-${signer.id}`}>
                          {t('signer.preExpiryRemindedBadge')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" data-testid={`signer-pre-expiry-queued-${signer.id}`}>
                          {t('signer.preExpiryQueuedBadge')}
                        </Badge>
                      )
                    ) : null}
                    {isSelected && isDraft ? (
                      <Badge variant="default">{t('signer.activeChip')}</Badge>
                    ) : null}
                  </div>
                  {signer.status === 'declined' && signer.declineReason ? (
                    <p
                      className="mt-1.5 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
                      data-testid={`signer-decline-reason-${signer.id}`}
                    >
                      {t('signer.declineReasonNote', { reason: signer.declineReason })}
                    </p>
                  ) : null}

                  {canEdit ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {routingMode === 'sequential' ? (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={index === 0 || busy}
                            onClick={() => void onMoveSigner(signer.id, -1)}
                          >
                            {t('signer.moveUp')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={index === signers.length - 1 || busy}
                            onClick={() => void onMoveSigner(signer.id, 1)}
                          >
                            {t('signer.moveDown')}
                          </Button>
                        </>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void onRemoveSigner(signer.id)}
                      >
                        {t('signer.removeButton')}
                      </Button>
                    </div>
                  ) : null}

                  {(canLinkOrRemind &&
                    ((onStartInPerson && signer.signerRole !== 'cc') ||
                      (onCopyZaloLink && signer.signerRole !== 'cc') ||
                      (onRemindSigner && signer.deliveryMode === 'email' && signer.email))) ||
                  (canCorrect && onCorrectSigner) ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {canLinkOrRemind && onStartInPerson && signer.signerRole !== 'cc' ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="max-sm:min-h-11"
                          disabled={busy}
                          onClick={() => onStartInPerson(signer.id)}
                          data-testid={`signer-in-person-btn-${signer.id}`}
                        >
                          {t('actions.startInPerson')}
                        </Button>
                      ) : null}
                      {canLinkOrRemind && onCopyZaloLink && signer.signerRole !== 'cc' ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void onCopyZaloLink(signer.id)}
                        >
                          {t('actions.copyZalo')}
                        </Button>
                      ) : null}
                      {canLinkOrRemind && onRemindSigner && signer.deliveryMode === 'email' && signer.email ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void onRemindSigner(signer.id)}
                        >
                          {t('actions.remind')}
                        </Button>
                      ) : null}
                      {canCorrect && onCorrectSigner ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => onCorrectSigner(signer)}
                          data-testid={`signer-correct-${signer.id}`}
                        >
                          {t('signer.correctButton')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {canEdit ? (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 border-t pt-3" data-testid="add-signer-form">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('signer.addTitle')}</h3>
            {formError ? <ErrorText>{formError}</ErrorText> : null}

            <div className="space-y-1">
              <Label htmlFor="signer-name" className="text-xs">
                {t('signer.nameLabel')}
              </Label>
              <Input id="signer-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>

            <div className="space-y-1">
              <Label htmlFor="signer-email" className="text-xs">
                {t('signer.emailLabel')}
              </Label>
              <Input id="signer-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="signer-role" className="text-xs">
                  {t('signer.roleLabel')}
                </Label>
                <NativeSelect
                  id="signer-role"
                  value={signerRole}
                  className="w-full"
                  onChange={(e) => setSignerRole(e.target.value as SignSignerRole)}
                >
                  {SIGN_SIGNER_ROLES.map((role) => (
                    <NativeSelectOption key={role} value={role}>
                      {t(`signer.roles.${role}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="signer-delivery" className="text-xs">
                  {t('signer.deliveryLabel')}
                </Label>
                <NativeSelect
                  id="signer-delivery"
                  value={deliveryMode}
                  className="w-full"
                  onChange={(e) => setDeliveryMode(e.target.value as SignDeliveryMode)}
                >
                  {SIGN_DELIVERY_MODES.map((mode) => (
                    <NativeSelectOption key={mode} value={mode}>
                      {t(`signer.deliveries.${mode}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="signer-phone" className="text-xs">
                  {t('signer.phoneLabel')}
                </Label>
                <Input id="signer-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="signer-role-label" className="text-xs">
                  {t('signer.roleLabelHint')}
                </Label>
                <Input id="signer-role-label" value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} />
              </div>
            </div>

            <label htmlFor="signer-otp-checkbox" className="flex min-h-9 cursor-pointer items-center gap-2 text-xs text-foreground">
              <Checkbox id="signer-otp-checkbox" checked={requireEmailOtp} onCheckedChange={(checked) => setRequireEmailOtp(Boolean(checked))} />
              <span>{t('signer.otpLabel')}</span>
            </label>

            <Button type="submit" variant="secondary" size="sm" className="w-full" loading={submitting} disabled={busy}>
              {t('signer.addButton')}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

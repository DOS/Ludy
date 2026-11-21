// SPDX-License-Identifier: AGPL-3.0-only
// Reusable eSign templates screen (/o/$slug/sign/templates): upload PDF templates,
// configure Signer/Approver/CC roles and normalized fields, manage direct signing links,
// and instantiate envelopes in one click (#3526).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { MAX_UPLOAD_BYTES } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Textarea } from '@crove/ui/components/textarea';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { ContractDrafterDialog } from '../components/sign/contract-drafter-dialog.tsx';
import { FieldOverlayLayer } from '../components/sign/field-placer.tsx';
import { PdfCanvasViewer } from '../components/sign/pdf-canvas-viewer.tsx';
import { SenderSharedSummaryEditor } from '../components/sign/shared-summary-card.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import {
  downloadSignPdfBytes,
  signApi,
  uploadSignPdf,
  type SignSharedSummary,
  type SignSignerRecord,
  type SignTemplateDetail,
  type SignTemplateFieldRecord,
  type SignTemplateRoleRecord,
  type SignTemplateStatus,
  type SignTemplateSummary,
} from '../lib/sign-api.ts';
import {
  SIGN_DELIVERY_MODES,
  SIGN_FIELD_TYPES,
  SIGN_ROUTING_MODES,
  SIGN_SIGNER_ROLES,
  clampFieldBox,
  createPlacedFieldBox,
  nudgeFieldBox,
  planDetectedTagsForTemplateRoles,
  resizeFieldBox,
  signerChipStyle,
  type DraftFieldPlacement,
  type SignDeliveryMode,
  type SignFieldType,
  type SignRoutingMode,
  type SignSignerRole,
} from '../lib/sign-fields.ts';
import { buildDirectSigningUrl, buildSigningUrl, copyTextToClipboard } from '../lib/sign-hash.ts';
import { looksLikePdfBytes } from '../lib/sign-pdf.ts';
import { toast } from '../lib/toast.ts';

type TemplateFilterTab = 'all' | 'active' | 'draft' | 'archived';

const TEMPLATE_BADGE_VARIANT = {
  draft: 'secondary',
  active: 'success',
  archived: 'outline',
} as const;

interface EditableTemplateRole {
  localId: string;
  id?: string;
  roleKey: string;
  signerRole: SignSignerRole;
  roleLabel: string;
  routingOrder: number;
  deliveryMode: SignDeliveryMode;
  requireEmailOtp: boolean;
}

interface RecipientDraft {
  name: string;
  email: string;
  phone: string;
  deliveryMode: SignDeliveryMode;
}

function toEditableRoles(roles: readonly SignTemplateRoleRecord[]): EditableTemplateRole[] {
  return roles.map((r) => ({
    localId: r.id,
    id: r.id,
    roleKey: r.roleKey,
    signerRole: r.signerRole,
    roleLabel: r.roleLabel,
    routingOrder: r.routingOrder,
    deliveryMode: r.deliveryMode,
    requireEmailOtp: r.requireEmailOtp,
  }));
}

function toDraftFields(fields: readonly SignTemplateFieldRecord[]): DraftFieldPlacement[] {
  return fields.map((f) => ({
    localId: f.id,
    signerId: f.templateRoleId,
    fieldType: f.fieldType,
    pageNumber: f.pageNumber,
    xNorm: f.xNorm,
    yNorm: f.yNorm,
    wNorm: f.wNorm,
    hNorm: f.hNorm,
    label: f.label,
    required: f.required,
    proposedByAi: false,
    fontSizePt: f.fontSizePt,
  }));
}

function toOverlaySigners(roles: readonly SignTemplateRoleRecord[]): SignSignerRecord[] {
  return roles.map((r) => ({
    id: r.id,
    roleKey: r.roleKey,
    routingOrder: r.routingOrder,
    signerRole: r.signerRole,
    roleLabel: r.roleLabel,
    name: r.roleLabel,
    email: null,
    phone: null,
    deliveryMode: r.deliveryMode,
    requireEmailOtp: r.requireEmailOtp,
    status: 'waiting',
    tokenLastRemindedAt: null,
    viewedAt: null,
    signedAt: null,
    declinedAt: null,
    declineReason: null,
    otpVerifiedAt: null,
    signatureKind: null,
    consentAcceptedAt: null,
    createdAt: '',
    updatedAt: '',
  }));
}

function nextRoleKey(existing: readonly EditableTemplateRole[]): string {
  const used = new Set(existing.map((r) => r.roleKey));
  for (let i = 1; i <= 100; i += 1) {
    const candidate = `r${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `r${Date.now()}`;
}

export function canAutoSendTemplate(detail: SignTemplateDetail): boolean {
  const { template, roles, fields } = detail;
  if (template.inspectStatus !== 'passed' || template.pageCount === null) return false;
  const nonCc = roles.filter((r) => r.signerRole !== 'cc');
  if (nonCc.length === 0) return false;
  const sigRoles = new Set(fields.filter((f) => f.fieldType === 'signature').map((f) => f.templateRoleId));
  return nonCc.every((r) => r.signerRole !== 'signer' || sigRoles.has(r.id));
}

export function nextFiltersAfterTemplateCreate(currentTab: TemplateFilterTab): {
  tab: TemplateFilterTab;
  searchQuery: string;
} {
  return {
    tab: currentTab !== 'all' && currentTab !== 'draft' ? 'all' : currentTab,
    searchQuery: '',
  };
}

export function shouldApplySavedDraftRevision(params: {
  loadedTemplateId: string | null;
  savedTemplateId: string;
  currentRevision: number;
  submittedRevision: number;
}): boolean {
  return (
    params.loadedTemplateId === params.savedTemplateId &&
    params.currentRevision === params.submittedRevision
  );
}

export function createTemplateDraftRevisionTracker() {
  const rolesRevByTemplate = new Map<string, number>();
  const fieldsRevByTemplate = new Map<string, number>();
  let loaded: {
    id: string;
    version: number;
    syncedRolesRev: number;
    syncedFieldsRev: number;
  } | null = null;

  const rolesRev = (templateId: string) => rolesRevByTemplate.get(templateId) ?? 0;
  const fieldsRev = (templateId: string) => fieldsRevByTemplate.get(templateId) ?? 0;

  return {
    getLoadedTemplateId: () => loaded?.id ?? null,
    getRolesRevision: rolesRev,
    getFieldsRevision: fieldsRev,
    clearLoaded() {
      loaded = null;
    },
    onDetailEffect(templateId: string, version: number): {
      kind: 'none' | 'switched' | 'refreshed';
      syncRoles: boolean;
      syncFields: boolean;
    } {
      if (!loaded || loaded.id !== templateId) {
        const rRev = rolesRev(templateId);
        const fRev = fieldsRev(templateId);
        loaded = {
          id: templateId,
          version,
          syncedRolesRev: rRev,
          syncedFieldsRev: fRev,
        };
        return { kind: 'switched', syncRoles: true, syncFields: true };
      }
      if (loaded.version !== version) {
        const rRev = rolesRev(templateId);
        const fRev = fieldsRev(templateId);
        const syncRoles = rRev === loaded.syncedRolesRev;
        const syncFields = fRev === loaded.syncedFieldsRev;
        loaded = {
          id: templateId,
          version,
          syncedRolesRev: syncRoles ? rRev : loaded.syncedRolesRev,
          syncedFieldsRev: syncFields ? fRev : loaded.syncedFieldsRev,
        };
        return { kind: 'refreshed', syncRoles, syncFields };
      }
      return { kind: 'none', syncRoles: false, syncFields: false };
    },
    markRolesEdited(templateId?: string | null): number {
      const id = templateId ?? loaded?.id ?? null;
      if (!id) return 0;
      const next = rolesRev(id) + 1;
      rolesRevByTemplate.set(id, next);
      return next;
    },
    markFieldsEdited(templateId?: string | null): number {
      const id = templateId ?? loaded?.id ?? null;
      if (!id) return 0;
      const next = fieldsRev(id) + 1;
      fieldsRevByTemplate.set(id, next);
      return next;
    },
    markFieldsSavedClean(savedTemplateId: string, submittedRevision: number): void {
      if (loaded?.id === savedTemplateId && fieldsRev(savedTemplateId) === submittedRevision) {
        loaded.syncedFieldsRev = submittedRevision;
      }
    },
    acceptSavedRoles(savedTemplateId: string, submittedRevision: number, savedVersion?: number): boolean {
      const cur = rolesRev(savedTemplateId);
      const ok = shouldApplySavedDraftRevision({
        loadedTemplateId: loaded?.id ?? null,
        savedTemplateId,
        currentRevision: cur,
        submittedRevision,
      });
      if (ok && loaded) {
        loaded.syncedRolesRev = cur;
        if (savedVersion !== undefined) {
          loaded.version = savedVersion;
        }
      }
      return ok;
    },
    acceptSavedFields(savedTemplateId: string, submittedRevision: number, savedVersion?: number): boolean {
      const cur = fieldsRev(savedTemplateId);
      const ok = shouldApplySavedDraftRevision({
        loadedTemplateId: loaded?.id ?? null,
        savedTemplateId,
        currentRevision: cur,
        submittedRevision,
      });
      if (ok && loaded) {
        loaded.syncedFieldsRev = cur;
        if (savedVersion !== undefined) {
          loaded.version = savedVersion;
        }
      }
      return ok;
    },
  };
}

export async function completeTemplateInstantiate(deps: {
  res: { envelopeId: string; links: Array<{ signerId: string; token: string }> };
  capturedSlug: string | undefined;
  isMounted?: () => boolean;
  getActiveOrg?: () => string | null | undefined;
  getCurrentSlug: () => string | undefined;
  invalidateEnvelopes: () => Promise<unknown>;
  getEnvelope: (envelopeId: string) => Promise<{
    signers: Array<{ id: string; name: string; roleLabel: string | null }>;
  } | null>;
  onCompletedLinks: (completed: {
    envelopeId: string;
    links: Array<{ signerId: string; token: string; signerName: string | null; roleLabel: string | null }>;
  }) => void;
  onCloseDialog: () => void;
  navigateToEnvelope: (slug: string, envelopeId: string) => Promise<unknown>;
}): Promise<'stale' | 'links' | 'navigated' | 'closed'> {
  const isSameContext = () => {
    if (deps.isMounted && !deps.isMounted()) return false;
    if ((deps.getCurrentSlug() ?? '') !== (deps.capturedSlug ?? '')) return false;
    const liveOrg = deps.getActiveOrg ? deps.getActiveOrg() : undefined;
    if (liveOrg !== null && liveOrg !== undefined && deps.capturedSlug && liveOrg !== deps.capturedSlug) {
      return false;
    }
    return true;
  };
  if (!isSameContext()) return 'stale';
  await deps.invalidateEnvelopes();
  if (!isSameContext()) return 'stale';
  if (deps.res.links.length > 0) {
    const envDetail = await deps.getEnvelope(deps.res.envelopeId).catch(() => null);
    if (!isSameContext()) return 'stale';
    const signersById = new Map((envDetail?.signers ?? []).map((s) => [s.id, s]));
    deps.onCompletedLinks({
      envelopeId: deps.res.envelopeId,
      links: deps.res.links.map((item) => {
        const signer = signersById.get(item.signerId);
        return {
          signerId: item.signerId,
          token: item.token,
          signerName: signer?.name ?? null,
          roleLabel: signer?.roleLabel ?? null,
        };
      }),
    });
    return 'links';
  }
  deps.onCloseDialog();
  if (deps.capturedSlug && isSameContext()) {
    await deps.navigateToEnvelope(deps.capturedSlug, deps.res.envelopeId);
    return 'navigated';
  }
  return 'closed';
}

export function TemplateRolesCard({
  roles,
  editable,
  saving,
  onChangeRoles,
  onSaveRoles,
}: {
  roles: readonly EditableTemplateRole[];
  editable: boolean;
  saving: boolean;
  onChangeRoles: (next: EditableTemplateRole[]) => void;
  onSaveRoles: () => void;
}) {
  const t = useTranslations('sign.templates');
  const tSign = useTranslations('sign');
  const controlsDisabled = !editable || saving;

  const updateRole = (idx: number, patch: Partial<EditableTemplateRole>) => {
    if (controlsDisabled) return;
    onChangeRoles(
      roles.map((r, i) => {
        if (i !== idx) return r;
        const next = { ...r, ...patch };
        if (next.signerRole === 'cc') {
          next.requireEmailOtp = false;
        }
        return next;
      }),
    );
  };

  const addRole = () => {
    if (controlsDisabled) return;
    const roleKey = nextRoleKey(roles);
    onChangeRoles([
      ...roles,
      {
        localId: `new-${crypto.randomUUID()}`,
        roleKey,
        signerRole: 'signer',
        roleLabel: `${t('roleTypeSigner')} ${roles.length + 1}`,
        routingOrder: roles.length + 1,
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
    ]);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
        <CardTitle className="text-base">{t('rolesSectionTitle', { count: String(roles.length) })}</CardTitle>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={addRole}
              data-testid="sign-tpl-add-role-btn"
            >
              {t('addRoleButton')}
            </Button>
            <Button
              type="button"
              size="sm"
              loading={saving}
              onClick={onSaveRoles}
              data-testid="sign-tpl-save-roles-btn"
            >
              {t('saveRolesButton')}
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {roles.map((role, idx) => {
          const style = signerChipStyle(idx);
          const keyId = `sign-tpl-role-key-${idx}`;
          const labelId = `sign-tpl-role-label-${idx}`;
          const typeId = `sign-tpl-role-type-${idx}`;
          const orderId = `sign-tpl-role-order-${idx}`;
          const deliveryId = `sign-tpl-role-delivery-${idx}`;
          const otpId = `sign-tpl-role-otp-${idx}`;
          return (
            <div key={role.localId} className="space-y-2 rounded-md border border-border bg-card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-block size-2.5 rounded-full ${style.dot}`} aria-hidden="true" />
                  <Badge variant="secondary">{tSign(`signer.roles.${role.signerRole}`)}</Badge>
                </div>
                {editable ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => onChangeRoles(roles.filter((_, i) => i !== idx))}
                    aria-label={`${t('removeRoleButton')} ${role.roleLabel || role.roleKey}`}
                  >
                    {t('removeRoleButton')}
                  </Button>
                ) : null}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1">
                  <Label htmlFor={keyId}>{t('roleKeyLabel')}</Label>
                  <Input
                    id={keyId}
                    value={role.roleKey}
                    disabled={controlsDisabled}
                    onChange={(e) => updateRole(idx, { roleKey: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
                  />
                </div>
                <div className="space-y-1 sm:col-span-1 lg:col-span-2">
                  <Label htmlFor={labelId}>{t('roleLabelInput')}</Label>
                  <Input
                    id={labelId}
                    value={role.roleLabel}
                    disabled={controlsDisabled}
                    onChange={(e) => updateRole(idx, { roleLabel: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={orderId}>{t('routingOrderLabel')}</Label>
                  <Input
                    id={orderId}
                    type="number"
                    min={1}
                    max={100}
                    disabled={controlsDisabled}
                    value={role.routingOrder}
                    onChange={(e) => updateRole(idx, { routingOrder: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={typeId}>{t('roleTypeLabel')}</Label>
                  <NativeSelect
                    id={typeId}
                    disabled={controlsDisabled}
                    value={role.signerRole}
                    onChange={(e) => updateRole(idx, { signerRole: e.target.value as SignSignerRole })}
                  >
                    {SIGN_SIGNER_ROLES.map((sr) => (
                      <NativeSelectOption key={sr} value={sr}>
                        {sr === 'signer' ? t('roleTypeSigner') : sr === 'approver' ? t('roleTypeApprover') : t('roleTypeCc')}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={deliveryId}>{t('recipientDeliveryLabel', { role: role.roleLabel || role.roleKey })}</Label>
                  <NativeSelect
                    id={deliveryId}
                    disabled={controlsDisabled}
                    value={role.deliveryMode}
                    onChange={(e) => updateRole(idx, { deliveryMode: e.target.value as SignDeliveryMode })}
                  >
                    {SIGN_DELIVERY_MODES.map((dm) => (
                      <NativeSelectOption key={dm} value={dm}>
                        {dm === 'link' ? t('deliveryLink') : t('deliveryEmail')}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Checkbox
                  id={otpId}
                  disabled={controlsDisabled || role.signerRole === 'cc'}
                  checked={role.signerRole === 'cc' ? false : role.requireEmailOtp}
                  onCheckedChange={(checked) => updateRole(idx, { requireEmailOtp: checked === true })}
                />
                <Label htmlFor={otpId}>{t('requireOtpLabel')}</Label>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function DirectLinkCard({
  detail,
  freshDirectUrl,
  pending,
  rotating,
  onToggleEnabled,
  onToggleOtp,
  onRotate,
  onCopyUrl,
}: {
  detail: SignTemplateDetail;
  freshDirectUrl: string | null;
  pending: boolean;
  rotating?: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleOtp: (otp: boolean) => void;
  onRotate: () => void;
  onCopyUrl: (url: string) => void;
}) {
  const t = useTranslations('sign.templates');
  const nonCcCount = detail.roles.filter((r) => r.signerRole !== 'cc').length;
  const eligible = detail.template.status === 'active' && detail.template.inspectStatus === 'passed' && nonCcCount === 1;
  const enabled = Boolean(detail.directLink?.enabled);
  const requireEmailOtp = Boolean(detail.directLink?.requireEmailOtp);
  const isRotating = rotating ?? pending;

  return (
    <Card data-testid="sign-tpl-direct-link-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('directLinkTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!eligible ? (
          <p className="text-xs text-muted-foreground">{t('directLinkRuleHint', { count: String(nonCcCount) })}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="sign-tpl-direct-enabled"
                  checked={enabled}
                  disabled={pending}
                  onCheckedChange={(checked) => onToggleEnabled(checked === true)}
                />
                <Label htmlFor="sign-tpl-direct-enabled">{t('directLinkEnabledLabel')}</Label>
              </div>

              {enabled ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={isRotating}
                  disabled={pending}
                  onClick={onRotate}
                  data-testid="sign-tpl-direct-rotate-btn"
                >
                  {t('directLinkRotateButton')}
                </Button>
              ) : null}
            </div>

            {enabled ? (
              <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="sign-tpl-direct-otp"
                    checked={requireEmailOtp}
                    disabled={pending}
                    onCheckedChange={(checked) => onToggleOtp(checked === true)}
                  />
                  <Label htmlFor="sign-tpl-direct-otp">{t('directLinkOtpLabel')}</Label>
                </div>

                {freshDirectUrl ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="sign-tpl-direct-url">{t('directLinkUrlLabel')}</Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input id="sign-tpl-direct-url" readOnly value={freshDirectUrl} className="font-mono text-xs" />
                      <Button type="button" variant="outline" size="sm" onClick={() => onCopyUrl(freshDirectUrl)}>
                        {t('copyButton')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('directLinkActiveNoSecret')}</p>
                )}
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function CreateTemplateForm({
  title,
  description,
  routingMode,
  subject,
  message,
  file,
  error,
  pending,
  onChangeTitle,
  onChangeDescription,
  onChangeRoutingMode,
  onChangeSubject,
  onChangeMessage,
  onChangeFile,
  onSubmit,
}: {
  title: string;
  description: string;
  routingMode: SignRoutingMode;
  subject: string;
  message: string;
  file: File | null;
  error: string | null;
  pending: boolean;
  onChangeTitle: (value: string) => void;
  onChangeDescription: (value: string) => void;
  onChangeRoutingMode: (value: SignRoutingMode) => void;
  onChangeSubject: (value: string) => void;
  onChangeMessage: (value: string) => void;
  onChangeFile: (file: File | null) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  const t = useTranslations('sign.templates');

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="sign-tpl-create-title">{t('titleLabel')}</Label>
        <Input
          id="sign-tpl-create-title"
          required
          placeholder={t('titlePlaceholder')}
          value={title}
          onChange={(e) => onChangeTitle(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="sign-tpl-create-desc">{t('descriptionLabel')}</Label>
        <Input
          id="sign-tpl-create-desc"
          placeholder={t('descriptionPlaceholder')}
          value={description}
          onChange={(e) => onChangeDescription(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="sign-tpl-create-routing">{t('routingModeLabel')}</Label>
        <NativeSelect
          id="sign-tpl-create-routing"
          value={routingMode}
          onChange={(e) => onChangeRoutingMode(e.target.value as SignRoutingMode)}
        >
          {SIGN_ROUTING_MODES.map((m) => (
            <NativeSelectOption key={m} value={m}>
              {m === 'parallel' ? t('routingParallel') : t('routingSequential')}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor="sign-tpl-create-subject">{t('subjectLabel')}</Label>
        <Input
          id="sign-tpl-create-subject"
          value={subject}
          onChange={(e) => onChangeSubject(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="sign-tpl-create-message">{t('messageLabel')}</Label>
        <Textarea
          id="sign-tpl-create-message"
          rows={2}
          value={message}
          onChange={(e) => onChangeMessage(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="sign-tpl-create-file">{t('pdfFileLabel')}</Label>
        <input
          id="sign-tpl-create-file"
          type="file"
          accept="application/pdf,.pdf"
          required
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-card file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground"
          onChange={(e) => onChangeFile(e.target.files?.[0] ?? null)}
        />
        {file ? <p className="text-xs text-muted-foreground">{t('selectedFile', { name: file.name })}</p> : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button
          type="submit"
          loading={pending}
          disabled={!title.trim() || !file}
          data-testid="sign-tpl-create-submit-btn"
        >
          {t('submitCreate')}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function InstantiateTemplateForm({
  roles,
  title,
  recipients,
  autoSend,
  autoSendAllowed,
  error,
  pending,
  onChangeTitle,
  onChangeRecipient,
  onChangeAutoSend,
  onSubmit,
}: {
  roles: readonly SignTemplateRoleRecord[];
  title: string;
  recipients: Readonly<Record<string, RecipientDraft>>;
  autoSend: boolean;
  autoSendAllowed: boolean;
  error: string | null;
  pending: boolean;
  onChangeTitle: (value: string) => void;
  onChangeRecipient: (roleKey: string, next: RecipientDraft) => void;
  onChangeAutoSend: (value: boolean) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  const t = useTranslations('sign.templates');
  const tSign = useTranslations('sign');

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="sign-tpl-inst-title">{t('envelopeTitleLabel')}</Label>
        <Input
          id="sign-tpl-inst-title"
          required
          value={title}
          onChange={(e) => onChangeTitle(e.target.value)}
        />
      </div>

      {roles.map((role) => {
        const draft = recipients[role.roleKey] ?? {
          name: '',
          email: '',
          phone: '',
          deliveryMode: role.deliveryMode,
        };
        const needEmail = draft.deliveryMode === 'email' || role.requireEmailOtp;
        const nameId = `sign-tpl-inst-name-${role.roleKey}`;
        const emailId = `sign-tpl-inst-email-${role.roleKey}`;
        const phoneId = `sign-tpl-inst-phone-${role.roleKey}`;
        const delivId = `sign-tpl-inst-delivery-${role.roleKey}`;
        return (
          <div key={role.id} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{role.roleLabel}</span>
              <Badge variant="outline">{role.roleKey}</Badge>
              <Badge variant="secondary">{tSign(`signer.roles.${role.signerRole}`)}</Badge>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={nameId}>{t('recipientNameLabel', { role: role.roleLabel })}</Label>
                <Input
                  id={nameId}
                  required={role.signerRole !== 'cc'}
                  value={draft.name}
                  onChange={(e) => onChangeRecipient(role.roleKey, { ...draft, name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={emailId}>{t('recipientEmailLabel', { role: role.roleLabel })}</Label>
                <Input
                  id={emailId}
                  type="email"
                  required={(role.signerRole !== 'cc' || Boolean(draft.name.trim())) && needEmail}
                  value={draft.email}
                  onChange={(e) => onChangeRecipient(role.roleKey, { ...draft, email: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={phoneId}>{t('recipientPhoneLabel', { role: role.roleLabel })}</Label>
                <Input
                  id={phoneId}
                  value={draft.phone}
                  onChange={(e) => onChangeRecipient(role.roleKey, { ...draft, phone: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={delivId}>{t('recipientDeliveryLabel', { role: role.roleLabel })}</Label>
                <NativeSelect
                  id={delivId}
                  value={draft.deliveryMode}
                  onChange={(e) =>
                    onChangeRecipient(role.roleKey, {
                      ...draft,
                      deliveryMode: e.target.value as SignDeliveryMode,
                    })
                  }
                >
                  {SIGN_DELIVERY_MODES.map((dm) => (
                    <NativeSelectOption key={dm} value={dm}>
                      {dm === 'link' ? t('deliveryLink') : t('deliveryEmail')}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
          </div>
        );
      })}

      <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="sign-tpl-inst-autosend"
            disabled={!autoSendAllowed}
            checked={autoSend && autoSendAllowed}
            onCheckedChange={(checked) => onChangeAutoSend(checked === true)}
          />
          <Label htmlFor="sign-tpl-inst-autosend">{t('autoSendLabel')}</Label>
        </div>
        {!autoSendAllowed ? <p className="text-xs text-muted-foreground">{t('autoSendBlockedHint')}</p> : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <DialogFooter>
        <Button type="submit" loading={pending} data-testid="sign-tpl-inst-submit-btn">
          {t('submitInstantiate')}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function SignTemplatesPage() {
  const t = useTranslations('sign.templates');
  const tSign = useTranslations('sign');
  const common = useTranslations('common');
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false }) as { slug?: string };

  const [tab, setTab] = useState<TemplateFilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const draftTrackerRef = useRef<ReturnType<typeof createTemplateDraftRevisionTracker> | null>(null);
  if (!draftTrackerRef.current) {
    draftTrackerRef.current = createTemplateDraftRevisionTracker();
  }
  const draftTracker = draftTrackerRef.current;
  const pendingCreatedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const activeSlugRef = useRef(slug);
  activeSlugRef.current = slug;
  const previousSlugRef = useRef(slug);
  const detailRetryBtnRef = useRef<HTMLButtonElement | null>(null);
  const pendingDetailRetryFocusRef = useRef(false);

  // Create template dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [drafterOpen, setDrafterOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createRouting, setCreateRouting] = useState<SignRoutingMode>('parallel');
  const [createSubject, setCreateSubject] = useState('');
  const [createMessage, setCreateMessage] = useState('');
  const [createFile, setCreateFile] = useState<File | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // Selected template editable state
  const [metaTitle, setMetaTitle] = useState('');
  const [metaDesc, setMetaDesc] = useState('');
  const [metaRouting, setMetaRouting] = useState<SignRoutingMode>('parallel');
  const [metaSubject, setMetaSubject] = useState('');
  const [metaMessage, setMetaMessage] = useState('');
  const [rolesDraft, setRolesDraft] = useState<EditableTemplateRole[]>([]);
  const [fieldsDraft, setFieldsDraft] = useState<DraftFieldPlacement[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [activeRoleId, setActiveRoleId] = useState<string>('');
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [detectedPages, setDetectedPages] = useState<number | null>(null);
  const [freshDirectUrl, setFreshDirectUrl] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  // Instantiate dialog state
  const [instOpen, setInstOpen] = useState(false);
  const [instTitle, setInstTitle] = useState('');
  const [instAutoSend, setInstAutoSend] = useState(false);
  const [instRecipients, setInstRecipients] = useState<Record<string, RecipientDraft>>({});
  const [instError, setInstError] = useState<string | null>(null);
  const [instCompleted, setInstCompleted] = useState<{
    envelopeId: string;
    links: Array<{ signerId: string; token: string; signerName: string | null; roleLabel: string | null }>;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isSameActiveOrgContext = (capturedSlug: string | undefined): boolean => {
    if (!mountedRef.current) return false;
    if ((activeSlugRef.current ?? '') !== (capturedSlug ?? '')) return false;
    const liveOrg = typeof getCurrentOrg === 'function' ? getCurrentOrg() : null;
    if (liveOrg !== null && capturedSlug && liveOrg !== capturedSlug) return false;
    return true;
  };

  const updateRolesDraft = (
    updater: EditableTemplateRole[] | ((prev: EditableTemplateRole[]) => EditableTemplateRole[]),
  ) => {
    draftTracker.markRolesEdited();
    setRolesDraft(updater);
  };

  const updateFieldsDraft = (
    updater: DraftFieldPlacement[] | ((prev: DraftFieldPlacement[]) => DraftFieldPlacement[]),
  ) => {
    draftTracker.markFieldsEdited();
    setFieldsDraft(updater);
  };

  useEffect(() => {
    if (previousSlugRef.current === slug) return;
    previousSlugRef.current = slug;
    pendingCreatedIdRef.current = null;
    draftTracker.clearLoaded();
    setSelectedId(null);
    setFreshDirectUrl(null);
    setInstOpen(false);
    setInstCompleted(null);
    setInstError(null);
  }, [slug, draftTracker]);

  const listQuery = useQuery({
    queryKey: ['sign', 'templates', 'list', tab, searchQuery],
    queryFn: () =>
      signApi.listTemplates({
        ...(tab === 'all' ? {} : { status: tab as SignTemplateStatus }),
        ...(searchQuery.trim() ? { query: searchQuery.trim() } : {}),
        limit: 50,
      }),
  });

  const items: readonly SignTemplateSummary[] = listQuery.data?.items ?? [];
  const resolvedSelectedId =
    selectedId &&
    (items.length === 0 || items.some((item) => item.id === selectedId) || pendingCreatedIdRef.current === selectedId)
      ? selectedId
      : (items[0]?.id ?? null);

  useEffect(() => {
    if (pendingCreatedIdRef.current && items.some((item) => item.id === pendingCreatedIdRef.current)) {
      pendingCreatedIdRef.current = null;
    }
    if (!selectedId && items.length > 0) {
      setSelectedId(items[0]!.id);
    } else if (
      selectedId &&
      items.length > 0 &&
      !items.some((item) => item.id === selectedId) &&
      pendingCreatedIdRef.current !== selectedId
    ) {
      setSelectedId(items[0]!.id);
    }
  }, [items, selectedId]);

  const detailQuery = useQuery({
    queryKey: ['sign', 'templates', 'detail', resolvedSelectedId],
    queryFn: () => signApi.getTemplate(resolvedSelectedId!),
    enabled: Boolean(resolvedSelectedId),
    refetchInterval: (query) => (query.state.data?.template.inspectStatus === 'pending' ? 2000 : false),
  });

  const detail = detailQuery.data ?? null;

  useEffect(() => {
    if (!detailQuery.isFetching && pendingDetailRetryFocusRef.current) {
      pendingDetailRetryFocusRef.current = false;
      if (detailQuery.error) {
        detailRetryBtnRef.current?.focus();
      }
    }
  }, [detailQuery.isFetching, detailQuery.error]);

  const pdfQuery = useQuery({
    queryKey: ['sign', 'templates', 'pdf', detail?.template.sourceFileId],
    queryFn: () => downloadSignPdfBytes(detail!.template.sourceFileId),
    enabled: Boolean(detail?.template.sourceFileId),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!resolvedSelectedId) {
      draftTracker.clearLoaded();
      return;
    }
    if (!detail) return;
    const sync = draftTracker.onDetailEffect(detail.template.id, detail.template.version);
    if (sync.kind === 'none') return;
    if (sync.kind === 'switched') {
      setMetaTitle(detail.template.title);
      setMetaDesc(detail.template.description ?? '');
      setMetaRouting(detail.template.routingMode);
      setMetaSubject(detail.template.subject ?? '');
      setMetaMessage(detail.template.message ?? '');
      setRolesDraft(toEditableRoles(detail.roles));
      setFieldsDraft(toDraftFields(detail.fields));
      setSelectedFieldId(null);
      setPageNumber(1);
      setFreshDirectUrl(null);
      const firstNonCc = detail.roles.find((r) => r.signerRole !== 'cc');
      setActiveRoleId(firstNonCc?.id ?? '');
      return;
    }
    if (sync.syncRoles) {
      setRolesDraft(toEditableRoles(detail.roles));
      const nonCcRoles = detail.roles.filter((r) => r.signerRole !== 'cc');
      const nonCcIds = new Set(nonCcRoles.map((r) => r.id));
      setActiveRoleId((prev) => (prev && nonCcIds.has(prev) ? prev : nonCcRoles[0]?.id ?? ''));
    }
    if (sync.syncFields) {
      const nextFields = toDraftFields(detail.fields);
      setFieldsDraft(nextFields);
      setSelectedFieldId((prev) => (prev && nextFields.some((f) => f.localId === prev) ? prev : null));
    }
  }, [resolvedSelectedId, detail, draftTracker]);

  const invalidateTemplates = async (id?: string) => {
    await queryClient.invalidateQueries({ queryKey: ['sign', 'templates', 'list'] });
    if (id) await queryClient.invalidateQueries({ queryKey: ['sign', 'templates', 'detail', id] });
  };

  const createMutation = useMutation({
    mutationFn: async (vars: { capturedSlug: string | undefined }) => {
      if (!createFile) throw new Error(t('pdfFileLabel'));
      if (createFile.size > MAX_UPLOAD_BYTES) throw new Error(tSign('pdfTooLarge'));
      const header = new Uint8Array(await createFile.slice(0, 16).arrayBuffer());
      if (!looksLikePdfBytes(header)) throw new Error(tSign('pdfInvalidType'));
      const uploaded = await uploadSignPdf(createFile, vars.capturedSlug ?? undefined);
      return signApi.createTemplate({
        title: createTitle.trim(),
        description: createDesc.trim() || null,
        routingMode: createRouting,
        subject: createSubject.trim() || null,
        message: createMessage.trim() || null,
        sourceFileId: uploaded.fileId,
      });
    },
    onSuccess: async (res, vars) => {
      if (!isSameActiveOrgContext(vars.capturedSlug)) return;
      setCreateOpen(false);
      setCreateTitle('');
      setCreateDesc('');
      setCreateSubject('');
      setCreateMessage('');
      setCreateFile(null);
      setCreateError(null);
      pendingCreatedIdRef.current = res.templateId;
      const nextFilters = nextFiltersAfterTemplateCreate(tab);
      if (nextFilters.tab !== tab) {
        setTab(nextFilters.tab);
      }
      setSearchQuery(nextFilters.searchQuery);
      setSelectedId(res.templateId);
      await invalidateTemplates(res.templateId);
      if (!isSameActiveOrgContext(vars.capturedSlug)) return;
      toast(t('savedToast'));
    },
    onError: (err, vars) => {
      if (!isSameActiveOrgContext(vars.capturedSlug)) return;
      setCreateError(errorMessage(err));
    },
  });

  const updateMutation = useMutation({
    mutationFn: (patch: { templateId?: string; status?: 'draft' | 'active'; includeMeta?: boolean }) =>
      signApi.updateTemplate({
        templateId: patch.templateId ?? detail!.template.id,
        ...(patch.includeMeta
          ? {
              title: metaTitle.trim(),
              description: metaDesc.trim() || null,
              routingMode: metaRouting,
              subject: metaSubject.trim() || null,
              message: metaMessage.trim() || null,
            }
          : {}),
        ...(patch.status ? { status: patch.status } : {}),
      }),
    onSuccess: async (res) => {
      if (res.status === 'draft') {
        setFreshDirectUrl(null);
      }
      await invalidateTemplates(res.templateId);
      toast(t('savedToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const rolesMutation = useMutation({
    mutationFn: (vars: {
      templateId: string;
      rolesRev: number;
      roles: Array<{
        id?: string;
        roleKey: string;
        signerRole: SignSignerRole;
        roleLabel: string;
        routingOrder: number;
        deliveryMode: SignDeliveryMode;
        requireEmailOtp: boolean;
      }>;
    }) => signApi.setTemplateRoles(vars.templateId, vars.roles),
    onSuccess: async (res, vars) => {
      if (draftTracker.getLoadedTemplateId() === res.templateId) {
        if (draftTracker.acceptSavedRoles(res.templateId, vars.rolesRev, res.version)) {
          setRolesDraft(toEditableRoles(res.roles));
        }
        const nonCcRoles = res.roles.filter((r) => r.signerRole !== 'cc');
        const nonCcIds = new Set(nonCcRoles.map((r) => r.id));
        setFieldsDraft((prev) => {
          const filtered = prev.filter((f) => nonCcIds.has(f.signerId));
          if (filtered.length !== prev.length) {
            draftTracker.markFieldsEdited(res.templateId);
            return filtered;
          }
          return prev;
        });
        setActiveRoleId((prev) => (prev && nonCcIds.has(prev) ? prev : nonCcRoles[0]?.id ?? ''));
        if (nonCcRoles.length !== 1) {
          setFreshDirectUrl(null);
        }
      }
      await invalidateTemplates(res.templateId);
      toast(t('savedRolesToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const fieldsMutation = useMutation({
    mutationFn: (vars: {
      templateId: string;
      fieldsRev: number;
      fields: Array<{
        templateRoleId: string;
        fieldType: SignFieldType;
        pageNumber: number;
        xNorm: number;
        yNorm: number;
        wNorm: number;
        hNorm: number;
        label: string | null;
        required: boolean;
        fontSizePt: number | null;
      }>;
    }) => signApi.setTemplateFields(vars.templateId, vars.fields),
    onSuccess: async (res, vars) => {
      draftTracker.markFieldsSavedClean(res.templateId, vars.fieldsRev);
      await invalidateTemplates(res.templateId);
      const fresh = queryClient.getQueryData<SignTemplateDetail>(['sign', 'templates', 'detail', res.templateId]);
      if (fresh && draftTracker.acceptSavedFields(res.templateId, vars.fieldsRev, fresh.template.version)) {
        const nextFields = toDraftFields(fresh.fields);
        setFieldsDraft(nextFields);
        setSelectedFieldId((prev) => (prev && nextFields.some((f) => f.localId === prev) ? prev : null));
      }
      toast(t('savedFieldsToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const archiveMutation = useMutation({
    mutationFn: (templateId: string) => signApi.archiveTemplate(templateId),
    onSuccess: async (res) => {
      setArchiveOpen(false);
      if (draftTracker.getLoadedTemplateId() === res.templateId) {
        setFreshDirectUrl(null);
      }
      await invalidateTemplates(res.templateId);
      toast(t('savedToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const directLinkSetMutation = useMutation({
    mutationFn: (input: { templateId: string; enabled: boolean; requireEmailOtp?: boolean }) =>
      signApi.setTemplateDirectLink(input),
    onSuccess: async (res, vars) => {
      if (draftTracker.getLoadedTemplateId() === vars.templateId) {
        if (res.token) setFreshDirectUrl(buildDirectSigningUrl(res.token));
        else if (!res.enabled) setFreshDirectUrl(null);
      }
      await invalidateTemplates(vars.templateId);
      toast(t('directLinkUpdatedToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const directLinkRotateMutation = useMutation({
    mutationFn: (input: { templateId: string; requireEmailOtp?: boolean }) =>
      signApi.rotateTemplateDirectLink(input),
    onSuccess: async (res, vars) => {
      if (draftTracker.getLoadedTemplateId() === vars.templateId && res.token) {
        setFreshDirectUrl(buildDirectSigningUrl(res.token));
      }
      await invalidateTemplates(vars.templateId);
      toast(t('directLinkUpdatedToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const hasMeQuery = Boolean((orpc as { me?: { get?: { queryOptions?: () => unknown } } }).me?.get?.queryOptions);
  const meQuery = useQuery(
    hasMeQuery
      ? orpc.me.get.queryOptions()
      : { queryKey: ['me', 'get', 'noop'], queryFn: async () => null, enabled: false },
  );
  const defaultPartyAName = meQuery.data?.orgs.find((o) => o.slug === slug)?.name ?? '';

  const canEditTemplateSharedSummary = useMemo(() => {
    if (!detail || detail.template.status === 'archived') return false;
    const me = meQuery.data;
    if (!me) return true;
    const orgSummary = me.orgs.find((o) => o.slug === slug);
    if (!orgSummary) return false;
    if (orgSummary.role === 'owner' || orgSummary.role === 'admin') return true;
    return orgSummary.role === 'member' && me.userId === detail.template.createdBy;
  }, [detail, meQuery.data, slug]);

  const templateSharedSummaryMutation = useMutation({
    mutationFn: (vars: {
      templateId: string;
      shareSummaryWithSigners: boolean;
      sharedSummary: SignSharedSummary | null;
    }) => signApi.setTemplateSharedSummary(vars),
    onSuccess: async (_res, vars) => {
      await invalidateTemplates(vars.templateId);
      toast(tSign('sharedSummary.savedToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const instantiateMutation = useMutation({
    mutationFn: async (vars: { capturedSlug: string | undefined }) => {
      if (!detail) throw new Error('No template selected');
      const recipients = detail.roles.flatMap((role) => {
        const rec = instRecipients[role.roleKey];
        const name = rec?.name.trim() ?? '';
        const email = rec?.email.trim() || null;
        const phone = rec?.phone.trim() || null;
        const deliveryMode = rec?.deliveryMode ?? role.deliveryMode;
        if (!name && role.signerRole === 'cc') return [];
        return [
          {
            roleKey: role.roleKey,
            name,
            email,
            phone,
            deliveryMode,
            requireEmailOtp: role.requireEmailOtp,
          },
        ];
      });
      const res = await signApi.instantiateTemplate({
        templateId: detail.template.id,
        title: instTitle.trim() || detail.template.title,
        autoSend: instAutoSend,
        recipients,
      });
      return { res, capturedSlug: vars.capturedSlug };
    },
    onSuccess: async ({ res, capturedSlug }) => {
      if (!isSameActiveOrgContext(capturedSlug)) return;
      setInstError(null);
      await completeTemplateInstantiate({
        res,
        capturedSlug,
        isMounted: () => mountedRef.current,
        getActiveOrg: () => (typeof getCurrentOrg === 'function' ? getCurrentOrg() : null),
        getCurrentSlug: () => activeSlugRef.current,
        invalidateEnvelopes: () => queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] }),
        getEnvelope: (envelopeId) => signApi.getEnvelope(envelopeId),
        onCompletedLinks: (completed) => setInstCompleted(completed),
        onCloseDialog: () => setInstOpen(false),
        navigateToEnvelope: (targetSlug, envelopeId) =>
          navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug: targetSlug, id: envelopeId } }),
      });
    },
    onError: (err, vars) => {
      if (!isSameActiveOrgContext(vars.capturedSlug)) return;
      setInstError(errorMessage(err));
    },
  });

  const openInstantiateDialog = () => {
    if (!detail) return;
    setInstTitle(detail.template.title);
    setInstAutoSend(false);
    setInstError(null);
    setInstCompleted(null);
    const nextRecipients: Record<string, RecipientDraft> = {};
    for (const r of detail.roles) {
      nextRecipients[r.roleKey] = {
        name: '',
        email: '',
        phone: '',
        deliveryMode: r.deliveryMode,
      };
    }
    setInstRecipients(nextRecipients);
    setInstOpen(true);
  };

  const overlaySigners = useMemo(() => (detail ? toOverlaySigners(detail.roles) : []), [detail]);
  const nonCcSavedRoles = useMemo(() => (detail ? detail.roles.filter((r) => r.signerRole !== 'cc') : []), [detail]);
  const selectedField = useMemo(
    () => fieldsDraft.find((f) => f.localId === selectedFieldId) ?? null,
    [fieldsDraft, selectedFieldId],
  );
  const editable = detail ? detail.template.status !== 'archived' : false;
  const fieldsSaving = fieldsMutation.isPending;
  const fieldsEditable = editable && !fieldsSaving;
  const effectivePageCount = detail?.template.pageCount ?? detectedPages ?? 1;
  const autoSendAllowed = detail ? canAutoSendTemplate(detail) : false;
  const detectedTags = detail?.template.detectedTags ?? [];
  const tplTagPlan = useMemo(() => {
    const effectiveExisting =
      detail && draftTracker.getLoadedTemplateId() !== detail.template.id
        ? toDraftFields(detail.fields)
        : fieldsDraft;
    return planDetectedTagsForTemplateRoles({
      detectedTags,
      roles: nonCcSavedRoles,
      existingFields: effectiveExisting,
      pageCount: effectivePageCount,
    });
  }, [detail, detectedTags, nonCcSavedRoles, fieldsDraft, effectivePageCount, draftTracker]);

  const handleApplyDetectedTags = () => {
    if (!fieldsEditable || tplTagPlan.applicable.length === 0) return;
    const placed: DraftFieldPlacement[] = tplTagPlan.applicable.map((item) => ({
      localId: `tpl-tag-${crypto.randomUUID()}`,
      signerId: item.signerId,
      fieldType: item.fieldType,
      pageNumber: item.pageNumber,
      xNorm: item.xNorm,
      yNorm: item.yNorm,
      wNorm: item.wNorm,
      hNorm: item.hNorm,
      label: item.label,
      required: item.required,
      proposedByAi: false,
      fontSizePt: null,
    }));
    updateFieldsDraft((prev) => [...prev, ...placed]);
    setSelectedFieldId(placed[0]!.localId);
    setPageNumber(placed[0]!.pageNumber);
    toast(tSign('tags.appliedToast', { count: String(placed.length) }));
  };

  const handleAddField = (fieldType: SignFieldType) => {
    if (!fieldsEditable || !activeRoleId) return;
    const samePageCount = fieldsDraft.filter((f) => f.pageNumber === pageNumber).length;
    const box = createPlacedFieldBox({ fieldType, existingOnPageCount: samePageCount });
    const next: DraftFieldPlacement = {
      localId: `tpl-field-${crypto.randomUUID()}`,
      signerId: activeRoleId,
      fieldType,
      pageNumber,
      ...box,
      label: null,
      required: true,
      proposedByAi: false,
      fontSizePt: null,
    };
    updateFieldsDraft((prev) => [...prev, next]);
    setSelectedFieldId(next.localId);
  };

  const handleCopy = async (value: string) => {
    const ok = await copyTextToClipboard(value);
    if (ok) toast(t('copiedToast'));
  };

  const onSubmitCreate = (e: FormEvent) => {
    e.preventDefault();
    if (createMutation.isPending) return;
    setCreateError(null);
    createMutation.mutate({ capturedSlug: slug });
  };

  const onSubmitInstantiate = (e: FormEvent) => {
    e.preventDefault();
    if (instantiateMutation.isPending) return;
    setInstError(null);
    instantiateMutation.mutate({ capturedSlug: slug });
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:px-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setDrafterOpen(true)}
              data-testid="sign-tpl-open-drafter-btn"
            >
              {tSign('drafter.openButton')}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              onClick={() => setCreateOpen(true)}
              data-testid="sign-tpl-new-btn"
            >
              {t('createButton')}
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <Tabs
          value={tab}
          onValueChange={(next) => {
            pendingCreatedIdRef.current = null;
            setTab(next as TemplateFilterTab);
          }}
          className="w-full sm:w-auto"
        >
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger value="all">{t('tabAll')}</TabsTrigger>
            <TabsTrigger value="active">{t('tabActive')}</TabsTrigger>
            <TabsTrigger value="draft">{t('tabDraft')}</TabsTrigger>
            <TabsTrigger value="archived">{t('tabArchived')}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="w-full space-y-1 sm:w-64">
          <Label htmlFor="sign-tpl-search">{t('searchLabel')}</Label>
          <Input
            id="sign-tpl-search"
            value={searchQuery}
            placeholder={t('searchPlaceholder')}
            onChange={(e) => {
              pendingCreatedIdRef.current = null;
              setSearchQuery(e.target.value);
            }}
          />
        </div>
      </div>

      {listQuery.isLoading ? <ListSkeleton rows={4} /> : null}
      {listQuery.isError ? <ErrorText>{errorMessage(listQuery.error)}</ErrorText> : null}

      {!listQuery.isLoading && !listQuery.isError && items.length === 0 ? (
        <Empty
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          action={
            <Button type="button" onClick={() => setCreateOpen(true)}>
              {t('createButton')}
            </Button>
          }
        />
      ) : null}

      {items.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="min-w-0 space-y-2">
            {items.map((item) => {
              const isSelected = item.id === resolvedSelectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    pendingCreatedIdRef.current = null;
                    setSelectedId(item.id);
                  }}
                  className={`w-full rounded-lg border p-3 text-left transition-colors ${
                    isSelected ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted/40'
                  }`}
                  data-testid={`sign-tpl-item-${item.id}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.title}</span>
                    <Badge variant={TEMPLATE_BADGE_VARIANT[item.status]}>{t(`status.${item.status}`)}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('roleSummary', { roles: String(item.roleCount), fields: String(item.fieldCount) })}
                  </p>
                  {item.directLink?.enabled ? (
                    <Badge variant="outline" className="mt-2">
                      {t('directLinkBadge')}
                    </Badge>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="min-w-0 space-y-4">
            {!detail ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  {resolvedSelectedId && detailQuery.error ? (
                    <div className="space-y-3 text-left" data-testid="sign-tpl-detail-error">
                      <ErrorText>{errorMessage(detailQuery.error)}</ErrorText>
                      <div>
                        <Button
                          ref={detailRetryBtnRef}
                          type="button"
                          variant="outline"
                          size="sm"
                          loading={detailQuery.isFetching}
                          onClick={() => {
                            pendingDetailRetryFocusRef.current = true;
                            void detailQuery.refetch();
                          }}
                          data-testid="sign-tpl-detail-retry-btn"
                        >
                          {t('retryButton')}
                        </Button>
                      </div>
                    </div>
                  ) : detailQuery.isLoading ? (
                    <ListSkeleton rows={3} />
                  ) : (
                    t('selectPrompt')
                  )}
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardContent className="space-y-3 pt-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="truncate text-lg font-semibold text-foreground">{detail.template.title}</h2>
                          <Badge variant={TEMPLATE_BADGE_VARIANT[detail.template.status]}>
                            {t(`status.${detail.template.status}`)}
                          </Badge>
                        </div>
                        {detail.template.description ? (
                          <p className="text-sm text-muted-foreground">{detail.template.description}</p>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {detail.template.status !== 'archived' ? (
                          <Button
                            type="button"
                            onClick={openInstantiateDialog}
                            data-testid="sign-tpl-instantiate-btn"
                          >
                            {t('instantiateButton')}
                          </Button>
                        ) : null}
                        {detail.template.status === 'draft' ? (
                          <Button
                            type="button"
                            variant="outline"
                            loading={updateMutation.isPending && updateMutation.variables?.status === 'active'}
                            disabled={detail.template.inspectStatus !== 'passed' || updateMutation.isPending}
                            onClick={() => updateMutation.mutate({ templateId: detail.template.id, status: 'active' })}
                            data-testid="sign-tpl-activate-btn"
                          >
                            {t('activate')}
                          </Button>
                        ) : null}
                        {detail.template.status === 'active' ? (
                          <Button
                            type="button"
                            variant="outline"
                            loading={updateMutation.isPending && updateMutation.variables?.status === 'draft'}
                            disabled={updateMutation.isPending}
                            onClick={() => updateMutation.mutate({ templateId: detail.template.id, status: 'draft' })}
                          >
                            {t('deactivateToDraft')}
                          </Button>
                        ) : null}
                        {detail.template.status !== 'archived' ? (
                          <Button
                            type="button"
                            variant="outline"
                            loading={archiveMutation.isPending}
                            onClick={() => setArchiveOpen(true)}
                            data-testid="sign-tpl-archive-btn"
                          >
                            {t('archive')}
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {detail.template.inspectStatus === 'pending' ? (
                      <Alert>
                        <AlertDescription>{t('inspectPending')}</AlertDescription>
                      </Alert>
                    ) : null}
                    {detail.template.inspectStatus === 'failed' ? (
                      <Alert variant="destructive">
                        <AlertDescription>{t('inspectFailed', { reason: detail.template.inspectError ?? '' })}</AlertDescription>
                      </Alert>
                    ) : null}
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="space-y-3 pt-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="sign-tpl-meta-title">{t('titleLabel')}</Label>
                        <Input
                          id="sign-tpl-meta-title"
                          disabled={!editable}
                          value={metaTitle}
                          onChange={(e) => setMetaTitle(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="sign-tpl-meta-routing">{t('routingModeLabel')}</Label>
                        <NativeSelect
                          id="sign-tpl-meta-routing"
                          disabled={!editable}
                          value={metaRouting}
                          onChange={(e) => setMetaRouting(e.target.value as SignRoutingMode)}
                        >
                          {SIGN_ROUTING_MODES.map((m) => (
                            <NativeSelectOption key={m} value={m}>
                              {m === 'parallel' ? t('routingParallel') : t('routingSequential')}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sign-tpl-meta-desc">{t('descriptionLabel')}</Label>
                      <Input
                        id="sign-tpl-meta-desc"
                        disabled={!editable}
                        value={metaDesc}
                        onChange={(e) => setMetaDesc(e.target.value)}
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="sign-tpl-meta-subject">{t('subjectLabel')}</Label>
                        <Input
                          id="sign-tpl-meta-subject"
                          disabled={!editable}
                          value={metaSubject}
                          onChange={(e) => setMetaSubject(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="sign-tpl-meta-message">{t('messageLabel')}</Label>
                        <Textarea
                          id="sign-tpl-meta-message"
                          rows={2}
                          disabled={!editable}
                          value={metaMessage}
                          onChange={(e) => setMetaMessage(e.target.value)}
                        />
                      </div>
                    </div>
                    {editable ? (
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          loading={updateMutation.isPending && Boolean(updateMutation.variables?.includeMeta)}
                          disabled={updateMutation.isPending || !metaTitle.trim()}
                          onClick={() => updateMutation.mutate({ templateId: detail.template.id, includeMeta: true })}
                          data-testid="sign-tpl-save-meta-btn"
                        >
                          {t('saveMetadata')}
                        </Button>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <TemplateRolesCard
                  roles={rolesDraft}
                  editable={editable}
                  saving={rolesMutation.isPending}
                  onChangeRoles={updateRolesDraft}
                  onSaveRoles={() =>
                    rolesMutation.mutate({
                      templateId: detail.template.id,
                      rolesRev: draftTracker.getRolesRevision(detail.template.id),
                      roles: rolesDraft.map((r) => ({
                        ...(r.id ? { id: r.id } : {}),
                        roleKey: r.roleKey,
                        signerRole: r.signerRole,
                        roleLabel: r.roleLabel.trim() || r.roleKey,
                        routingOrder: r.routingOrder,
                        deliveryMode: r.deliveryMode,
                        requireEmailOtp: r.signerRole === 'cc' ? false : r.requireEmailOtp,
                      })),
                    })
                  }
                />

                <DirectLinkCard
                  detail={detail}
                  freshDirectUrl={freshDirectUrl}
                  pending={directLinkSetMutation.isPending || directLinkRotateMutation.isPending}
                  rotating={directLinkRotateMutation.isPending}
                  onToggleEnabled={(enabled) => directLinkSetMutation.mutate({ templateId: detail.template.id, enabled })}
                  onToggleOtp={(requireEmailOtp) =>
                    directLinkSetMutation.mutate({ templateId: detail.template.id, enabled: true, requireEmailOtp })
                  }
                  onRotate={() =>
                    directLinkRotateMutation.mutate({
                      templateId: detail.template.id,
                      ...(detail.directLink?.requireEmailOtp !== undefined
                        ? { requireEmailOtp: detail.directLink.requireEmailOtp }
                        : {}),
                    })
                  }
                  onCopyUrl={(url) => void handleCopy(url)}
                />

                {canEditTemplateSharedSummary ||
                Boolean(detail.template.sharedSummary) ||
                Boolean(detail.template.shareSummaryWithSigners) ? (
                  <SenderSharedSummaryEditor
                    recordKey={`tpl-${detail.template.id}`}
                    initialShare={Boolean(detail.template.shareSummaryWithSigners)}
                    initialSummary={detail.template.sharedSummary ?? null}
                    pageCount={detail.template.pageCount ?? detectedPages}
                    editable={canEditTemplateSharedSummary}
                    saving={templateSharedSummaryMutation.isPending}
                    onSave={(payload) =>
                      templateSharedSummaryMutation.mutateAsync({
                        templateId: detail.template.id,
                        shareSummaryWithSigners: payload.shareSummaryWithSigners,
                        sharedSummary: payload.sharedSummary,
                      })
                    }
                  />
                ) : null}

                <Card>
                  <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
                    <CardTitle className="text-base">{t('fieldsSectionTitle', { count: String(fieldsDraft.length) })}</CardTitle>
                    {editable ? (
                      <Button
                        type="button"
                        size="sm"
                        loading={fieldsSaving}
                        disabled={nonCcSavedRoles.length === 0}
                        onClick={() =>
                          fieldsMutation.mutate({
                            templateId: detail.template.id,
                            fieldsRev: draftTracker.getFieldsRevision(detail.template.id),
                            fields: fieldsDraft.map((f) => ({
                              templateRoleId: f.signerId,
                              fieldType: f.fieldType,
                              pageNumber: f.pageNumber,
                              xNorm: f.xNorm,
                              yNorm: f.yNorm,
                              wNorm: f.wNorm,
                              hNorm: f.hNorm,
                              label: f.label,
                              required: f.required,
                              fontSizePt: f.fontSizePt ?? null,
                            })),
                          })
                        }
                        data-testid="sign-tpl-save-fields-btn"
                      >
                        {t('saveFieldsButton')}
                      </Button>
                    ) : null}
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {editable && tplTagPlan.totalTags > 0 ? (
                      <div
                        className="flex flex-col gap-2.5 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between"
                        data-testid="sign-tpl-detected-tags-banner"
                      >
                        <div className="min-w-0 space-y-1 text-xs">
                          <p className="font-semibold text-foreground">
                            {tSign('tags.bannerTitle', { count: String(tplTagPlan.totalTags) })}
                          </p>
                          <p className="text-muted-foreground">{tSign('tags.bannerHint')}</p>
                          {tplTagPlan.unmatchedRoleKeys.length > 0 ? (
                            <p className="text-warning" data-testid="sign-tpl-detected-tags-unmatched">
                              {tSign('tags.unmatchedRolesHint', { roles: tplTagPlan.unmatchedRoleKeys.join(', ') })}
                            </p>
                          ) : tplTagPlan.applicable.length === 0 ? (
                            <p className="text-muted-foreground">
                              {tSign('tags.allAppliedHint', { count: String(tplTagPlan.totalTags) })}
                            </p>
                          ) : null}
                        </div>
                        {tplTagPlan.applicable.length > 0 || tplTagPlan.alreadyAppliedCount < tplTagPlan.totalTags ? (
                          <Button
                            type="button"
                            size="sm"
                            disabled={!fieldsEditable || tplTagPlan.applicable.length === 0}
                            onClick={handleApplyDetectedTags}
                            data-testid="sign-tpl-apply-detected-tags-btn"
                          >
                            {tSign('tags.applyButton', {
                              count: String(
                                tplTagPlan.applicable.length > 0 ? tplTagPlan.applicable.length : tplTagPlan.totalTags,
                              ),
                            })}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}

                    {nonCcSavedRoles.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('noNonCcRolesHint')}</p>
                    ) : (
                      <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-end sm:justify-between">
                        <div className="w-full space-y-1 sm:w-64">
                          <Label htmlFor="sign-tpl-active-role">{t('activeRoleLabel')}</Label>
                          <NativeSelect
                            id="sign-tpl-active-role"
                            disabled={!fieldsEditable}
                            value={activeRoleId}
                            onChange={(e) => setActiveRoleId(e.target.value)}
                          >
                            {nonCcSavedRoles.map((r) => (
                              <NativeSelectOption key={r.id} value={r.id}>
                                {r.roleLabel} ({r.roleKey})
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </div>

                        {editable ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">{t('addFieldLabel')}</span>
                            {SIGN_FIELD_TYPES.map((ft) => (
                              <Button
                                key={ft}
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!fieldsEditable || !activeRoleId}
                                onClick={() => handleAddField(ft)}
                                data-testid={`sign-tpl-add-field-${ft}`}
                              >
                                + {tSign(`fields.types.${ft}`)}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    )}

                    {selectedField && editable ? (
                      <div className="grid grid-cols-1 gap-2 rounded-md border border-border bg-card p-3 sm:grid-cols-3">
                        <div className="space-y-1">
                          <Label htmlFor="sign-tpl-field-role">{tSign('fields.assignedSignerSelect')}</Label>
                          <NativeSelect
                            id="sign-tpl-field-role"
                            disabled={!fieldsEditable}
                            value={selectedField.signerId}
                            onChange={(e) =>
                              updateFieldsDraft((prev) =>
                                prev.map((f) => (f.localId === selectedField.localId ? { ...f, signerId: e.target.value } : f)),
                              )
                            }
                          >
                            {nonCcSavedRoles.map((r) => (
                              <NativeSelectOption key={r.id} value={r.id}>
                                {r.roleLabel} ({r.roleKey})
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="sign-tpl-field-label">{tSign('fields.fieldLabelInput')}</Label>
                          <Input
                            id="sign-tpl-field-label"
                            disabled={!fieldsEditable}
                            value={selectedField.label ?? ''}
                            onChange={(e) =>
                              updateFieldsDraft((prev) =>
                                prev.map((f) =>
                                  f.localId === selectedField.localId ? { ...f, label: e.target.value || null } : f,
                                ),
                              )
                            }
                          />
                        </div>
                        <div className="flex items-end justify-between gap-2">
                          <div className="flex items-center gap-2 pb-2">
                            <Checkbox
                              id="sign-tpl-field-required"
                              disabled={!fieldsEditable}
                              checked={selectedField.required}
                              onCheckedChange={(checked) =>
                                updateFieldsDraft((prev) =>
                                  prev.map((f) =>
                                    f.localId === selectedField.localId ? { ...f, required: checked === true } : f,
                                  ),
                                )
                              }
                            />
                            <Label htmlFor="sign-tpl-field-required">{tSign('fields.requiredToggle')}</Label>
                          </div>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={!fieldsEditable}
                            onClick={() => {
                              updateFieldsDraft((prev) => prev.filter((f) => f.localId !== selectedField.localId));
                              setSelectedFieldId(null);
                            }}
                          >
                            {tSign('fields.deleteField')}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    <PdfCanvasViewer
                      pdfBytes={pdfQuery.data ?? null}
                      pageNumber={pageNumber}
                      pageCount={effectivePageCount}
                      scale={scale}
                      onPageChange={setPageNumber}
                      onScaleChange={setScale}
                      onPageCountDetected={setDetectedPages}
                      renderOverlay={(page) => (
                        <FieldOverlayLayer
                          pageNumber={page}
                          fields={fieldsDraft}
                          proposals={[]}
                          signers={overlaySigners}
                          selectedFieldId={selectedFieldId}
                          editable={fieldsEditable}
                          onSelectField={setSelectedFieldId}
                          onUpdateFieldBox={(fieldId, box) =>
                            updateFieldsDraft((prev) =>
                              prev.map((f) => (f.localId === fieldId ? { ...f, ...clampFieldBox(box) } : f)),
                            )
                          }
                          onDeleteField={(fieldId) => {
                            updateFieldsDraft((prev) => prev.filter((f) => f.localId !== fieldId));
                            if (selectedFieldId === fieldId) setSelectedFieldId(null);
                          }}
                          onApplyProposal={() => {}}
                          onDismissProposal={() => {}}
                        />
                      )}
                    />

                    {selectedField && editable ? (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!fieldsEditable}
                          onClick={() =>
                            updateFieldsDraft((prev) =>
                              prev.map((f) => (f.localId === selectedField.localId ? { ...f, ...nudgeFieldBox(f, -0.01, 0) } : f)),
                            )
                          }
                        >
                          {tSign('fields.moveLeft')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!fieldsEditable}
                          onClick={() =>
                            updateFieldsDraft((prev) =>
                              prev.map((f) => (f.localId === selectedField.localId ? { ...f, ...nudgeFieldBox(f, 0.01, 0) } : f)),
                            )
                          }
                        >
                          {tSign('fields.moveRight')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!fieldsEditable}
                          onClick={() =>
                            updateFieldsDraft((prev) =>
                              prev.map((f) => (f.localId === selectedField.localId ? { ...f, ...nudgeFieldBox(f, 0, -0.01) } : f)),
                            )
                          }
                        >
                          {tSign('fields.moveUp')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!fieldsEditable}
                          onClick={() =>
                            updateFieldsDraft((prev) =>
                              prev.map((f) => (f.localId === selectedField.localId ? { ...f, ...nudgeFieldBox(f, 0, 0.01) } : f)),
                            )
                          }
                        >
                          {tSign('fields.moveDown')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!fieldsEditable}
                          onClick={() =>
                            updateFieldsDraft((prev) =>
                              prev.map((f) => (f.localId === selectedField.localId ? { ...f, ...resizeFieldBox(f, 0.02, 0) } : f)),
                            )
                          }
                        >
                          {tSign('fields.wider')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!fieldsEditable}
                          onClick={() =>
                            updateFieldsDraft((prev) =>
                              prev.map((f) => (f.localId === selectedField.localId ? { ...f, ...resizeFieldBox(f, -0.02, 0) } : f)),
                            )
                          }
                        >
                          {tSign('fields.narrower')}
                        </Button>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg" closeLabel={common('close')}>
          <DialogHeader>
            <DialogTitle>{t('createTitle')}</DialogTitle>
            <DialogDescription>{t('createHint')}</DialogDescription>
          </DialogHeader>
          <CreateTemplateForm
            title={createTitle}
            description={createDesc}
            routingMode={createRouting}
            subject={createSubject}
            message={createMessage}
            file={createFile}
            error={createError}
            pending={createMutation.isPending}
            onChangeTitle={setCreateTitle}
            onChangeDescription={setCreateDesc}
            onChangeRoutingMode={setCreateRouting}
            onChangeSubject={setCreateSubject}
            onChangeMessage={setCreateMessage}
            onChangeFile={setCreateFile}
            onSubmit={onSubmitCreate}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={instOpen} onOpenChange={setInstOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" closeLabel={common('close')}>
          <DialogHeader>
            <DialogTitle>{instCompleted ? t('mintedLinksTitle') : t('instantiateTitle')}</DialogTitle>
            <DialogDescription>
              {instCompleted ? t('mintedLinksHint') : t('instantiateDescription')}
            </DialogDescription>
          </DialogHeader>

          {instCompleted ? (
            <div className="space-y-3">
              {instCompleted.links.map((link) => {
                const url = buildSigningUrl(link.token);
                const label = link.signerName
                  ? link.roleLabel
                    ? `${link.signerName} (${link.roleLabel})`
                    : link.signerName
                  : link.signerId;
                return (
                  <div key={link.signerId} className="space-y-2 rounded-md border border-border p-3">
                    <p className="text-sm font-medium text-foreground">{label}</p>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <span className="min-w-0 flex-1 break-all font-mono text-xs">{url}</span>
                      <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy(url)}>
                        {t('copyButton')}
                      </Button>
                    </div>
                  </div>
                );
              })}
              <DialogFooter>
                <Button
                  type="button"
                  onClick={() => {
                    setInstOpen(false);
                    if (slug) {
                      void navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug, id: instCompleted.envelopeId } });
                    }
                  }}
                >
                  {t('openEnvelopeButton')}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <InstantiateTemplateForm
              roles={detail?.roles ?? []}
              title={instTitle}
              recipients={instRecipients}
              autoSend={instAutoSend}
              autoSendAllowed={autoSendAllowed}
              error={instError}
              pending={instantiateMutation.isPending}
              onChangeTitle={setInstTitle}
              onChangeRecipient={(roleKey, next) =>
                setInstRecipients((prev) => ({ ...prev, [roleKey]: next }))
              }
              onChangeAutoSend={setInstAutoSend}
              onSubmit={onSubmitInstantiate}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={t('archiveConfirmTitle')}
        description={t('archiveConfirmBody')}
        confirm={t('archive')}
        onConfirm={() => {
          if (!archiveMutation.isPending && detail) archiveMutation.mutate(detail.template.id);
        }}
      />

      {drafterOpen ? (
        <ContractDrafterDialog
          open={drafterOpen}
          onOpenChange={setDrafterOpen}
          defaultPartyAName={defaultPartyAName}
          onEnvelopeCreated={async (envelopeId) => {
            await queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
            if (slug) {
              await navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug, id: envelopeId } });
            }
          }}
          onTemplateCreated={async (templateId) => {
            pendingCreatedIdRef.current = templateId;
            const nextFilters = nextFiltersAfterTemplateCreate(tab);
            if (nextFilters.tab !== tab) setTab(nextFilters.tab);
            setSearchQuery(nextFilters.searchQuery);
            setSelectedId(templateId);
            await invalidateTemplates(templateId);
          }}
        />
      ) : null}
    </div>
  );
}

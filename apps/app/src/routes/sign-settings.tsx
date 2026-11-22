// SPDX-License-Identifier: AGPL-3.0-only
// eSign settings (/o/$slug/sign/settings, #3554, #3817):
//   1. CA digital signature settings (offline Sandbox PAdES for owners/admins, read-only status for members/viewers,
//      and Vietnamese public CA providers gated behind #62 legal review).
//   2. Member-private saved signature & initials profile (author-only RLS) and corporate/title PNG stamps.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { SignaturePadModal } from '../components/sign/signature-pad-modal.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import {
  signApi,
  type SignCaConnectionRecord,
  type SignCaCredentialsInput,
  type SignCaProvider,
  type SignCaSettingsResult,
  type SignMemberSignatureItem,
  type SignOrgStampItem,
} from '../lib/sign-api.ts';
import {
  rawBase64ToPngDataUrl,
  readPngFileAsDataUrl,
  stampTextToPngDataUrl,
  stripPngDataUrlPrefix,
} from '../lib/sign-signature.ts';
import { toast } from '../lib/toast.ts';

export const PUBLIC_CA_PROVIDERS: readonly Exclude<SignCaProvider, 'sandbox'>[] = [
  'vnpt_smartca',
  'viettel_mysign',
  'misa_wesign',
];

export function canManageSignCa(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export interface LiveProviderFormState {
  label: string;
  certRef: string;
  spId: string;
  spPassword: string;
  clientId: string;
  clientSecret: string;
  clientKey: string;
  userId: string;
  profileId: string;
  serialNumber: string;
  username: string;
  password: string;
  taxCode: string;
  baseUrl: string;
}

function emptyLiveForm(label: string, certRef: string): LiveProviderFormState {
  return {
    label,
    certRef,
    spId: '',
    spPassword: '',
    clientId: '',
    clientSecret: '',
    clientKey: '',
    userId: '',
    profileId: '',
    serialNumber: '',
    username: '',
    password: '',
    taxCode: '',
    baseUrl: '',
  };
}

export function buildLiveCredentials(
  provider: Exclude<SignCaProvider, 'sandbox'>,
  form: LiveProviderFormState,
): SignCaCredentialsInput | null {
  const baseUrl = form.baseUrl.trim() || undefined;
  if (provider === 'vnpt_smartca') {
    if (!form.spId.trim() || !form.spPassword || !form.userId.trim()) return null;
    return {
      provider: 'vnpt_smartca',
      spId: form.spId.trim(),
      spPassword: form.spPassword,
      userId: form.userId.trim(),
      ...(form.serialNumber.trim() ? { serialNumber: form.serialNumber.trim() } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  if (provider === 'viettel_mysign') {
    if (!form.clientId.trim() || !form.clientSecret || !form.userId.trim() || !form.profileId.trim()) {
      return null;
    }
    return {
      provider: 'viettel_mysign',
      clientId: form.clientId.trim(),
      clientSecret: form.clientSecret,
      userId: form.userId.trim(),
      profileId: form.profileId.trim(),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  if (!form.clientId.trim() || !form.clientKey || !form.username.trim() || !form.password) {
    return null;
  }
  return {
    provider: 'misa_wesign',
    clientId: form.clientId.trim(),
    clientKey: form.clientKey,
    username: form.username.trim(),
    password: form.password,
    ...(form.taxCode.trim() ? { taxCode: form.taxCode.trim() } : {}),
    ...(form.userId.trim() ? { userId: form.userId.trim() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export interface SignSettingsViewProps {
  role: string | null | undefined;
  settings: SignCaSettingsResult;
  busyProvider?: SignCaProvider | null;
  onSaveSandbox?: (input: { label: string; certRef: string }) => void;
  onTestConnection?: (connectionId: string, provider: SignCaProvider) => void;
  onDisableConnection?: (connectionId: string, provider: SignCaProvider) => void;
  onSaveLiveProvider?: (
    provider: Exclude<SignCaProvider, 'sandbox'>,
    input: { label: string; certRef: string; credentials: SignCaCredentialsInput },
  ) => void;
}

export function SignSettingsView({
  role,
  settings,
  busyProvider = null,
  onSaveSandbox,
  onTestConnection,
  onDisableConnection,
  onSaveLiveProvider,
}: SignSettingsViewProps) {
  const t = useTranslations('sign.ca');
  const f = useFormat();
  const canEdit = canManageSignCa(role);

  const byProvider = new Map<SignCaProvider, SignCaConnectionRecord>();
  for (const conn of settings.connections) {
    if (!byProvider.has(conn.provider)) {
      byProvider.set(conn.provider, conn);
    }
  }

  const sandboxConn = byProvider.get('sandbox') ?? null;
  const [sandboxLabel, setSandboxLabel] = useState(sandboxConn?.label ?? 'Sandbox PAdES');
  const [sandboxCertRef, setSandboxCertRef] = useState(sandboxConn?.certRef ?? 'sandbox-default');

  useEffect(() => {
    if (sandboxConn) {
      setSandboxLabel(sandboxConn.label);
      setSandboxCertRef(sandboxConn.certRef);
    }
  }, [sandboxConn]);

  const [liveForms, setLiveForms] = useState<Record<Exclude<SignCaProvider, 'sandbox'>, LiveProviderFormState>>(() => ({
    vnpt_smartca: emptyLiveForm(
      byProvider.get('vnpt_smartca')?.label ?? 'VNPT SmartCA',
      byProvider.get('vnpt_smartca')?.certRef ?? 'vnpt-default',
    ),
    viettel_mysign: emptyLiveForm(
      byProvider.get('viettel_mysign')?.label ?? 'Viettel MySign',
      byProvider.get('viettel_mysign')?.certRef ?? 'viettel-default',
    ),
    misa_wesign: emptyLiveForm(
      byProvider.get('misa_wesign')?.label ?? 'MISA WeSign',
      byProvider.get('misa_wesign')?.certRef ?? 'misa-default',
    ),
  }));

  const updateLiveField = (
    provider: Exclude<SignCaProvider, 'sandbox'>,
    field: keyof LiveProviderFormState,
    value: string,
  ) => {
    setLiveForms((prev) => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        [field]: value,
      },
    }));
  };

  return (
    <div className="space-y-6" data-testid="sign-settings-page">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {!canEdit ? (
        <Alert data-testid="sign-ca-readonly-banner">
          <AlertDescription>{t('readOnlyNotice')}</AlertDescription>
        </Alert>
      ) : null}

      <Card data-testid="sign-ca-sandbox-card">
        <CardHeader className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">{t('sandboxSectionTitle')}</CardTitle>
            <Badge
              variant={
                sandboxConn?.status === 'active'
                  ? 'success'
                  : sandboxConn?.status === 'disabled'
                    ? 'secondary'
                    : 'outline'
              }
              data-testid="sign-ca-sandbox-status"
            >
              {sandboxConn
                ? t(`connectionStatus.${sandboxConn.status}`)
                : t('connectionStatus.unconfigured')}
            </Badge>
          </div>
          <CardDescription>{t('sandboxDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sandboxConn?.lastTestState ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={sandboxConn.lastTestState === 'works' ? 'success' : 'warning'}>
                {t(`testStates.${sandboxConn.lastTestState}`)}
              </Badge>
              {sandboxConn.lastTestedAt ? (
                <span>{t('lastTestedAt', { testedAt: f.dateTime(sandboxConn.lastTestedAt) })}</span>
              ) : null}
            </div>
          ) : null}

          {canEdit ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ca-sandbox-label">{t('labelField')}</Label>
                  <Input
                    id="ca-sandbox-label"
                    value={sandboxLabel}
                    placeholder={t('labelPlaceholder')}
                    onChange={(e) => setSandboxLabel(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ca-sandbox-cert-ref">{t('certRefField')}</Label>
                  <Input
                    id="ca-sandbox-cert-ref"
                    value={sandboxCertRef}
                    placeholder={t('certRefPlaceholder')}
                    onChange={(e) => setSandboxCertRef(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  loading={busyProvider === 'sandbox'}
                  disabled={!sandboxLabel.trim()}
                  onClick={() =>
                    onSaveSandbox?.({
                      label: sandboxLabel.trim() || 'Sandbox PAdES',
                      certRef: sandboxCertRef.trim() || 'sandbox-default',
                    })
                  }
                  data-testid="sign-ca-sandbox-save"
                >
                  {sandboxConn?.status === 'active' ? t('saveButton') : t('enableSandboxButton')}
                </Button>

                {sandboxConn ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={busyProvider === 'sandbox'}
                    onClick={() => onTestConnection?.(sandboxConn.id, 'sandbox')}
                    data-testid="sign-ca-sandbox-test"
                  >
                    {t('testButton')}
                  </Button>
                ) : null}

                {sandboxConn?.status === 'active' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={busyProvider === 'sandbox'}
                    onClick={() => onDisableConnection?.(sandboxConn.id, 'sandbox')}
                    data-testid="sign-ca-sandbox-disable"
                  >
                    {t('disableButton')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : sandboxConn ? (
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div>
                <span className="font-medium text-foreground">{t('labelField')}:</span> {sandboxConn.label}
              </div>
              <div>
                <span className="font-medium text-foreground">{t('certRefField')}:</span>{' '}
                <span className="font-mono">{sandboxConn.certRef}</span>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{t('publicCaSectionTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('publicCaDescription')}</p>
        </div>

        {!settings.liveCaEnabled ? (
          <Alert data-testid="sign-ca-legal-gate-banner">
            <AlertDescription>{t('legalGateHint')}</AlertDescription>
          </Alert>
        ) : !settings.brokerAvailable && canEdit ? (
          <Alert data-testid="sign-ca-broker-missing-banner">
            <AlertDescription>{t('brokerMissingNotice')}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          {PUBLIC_CA_PROVIDERS.map((provider) => {
            const conn = byProvider.get(provider) ?? null;
            const form = liveForms[provider];
            const isBusy = busyProvider === provider;
            const builtCredentials = buildLiveCredentials(provider, form);

            return (
              <Card key={provider} data-testid={`sign-ca-provider-${provider}`}>
                <CardHeader className="space-y-1 pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-sm">{t(`providers.${provider}`)}</CardTitle>
                    {!settings.liveCaEnabled ? (
                      <Badge variant="brand" data-testid={`sign-ca-gated-badge-${provider}`}>
                        {t('legalGateBadge')}
                      </Badge>
                    ) : (
                      <Badge
                        variant={
                          conn?.status === 'active'
                            ? 'success'
                            : conn?.status === 'disabled'
                              ? 'secondary'
                              : 'outline'
                        }
                      >
                        {conn ? t(`connectionStatus.${conn.status}`) : t('connectionStatus.unconfigured')}
                      </Badge>
                    )}
                  </div>
                  <CardDescription className="text-xs">{t(`providerDescriptions.${provider}`)}</CardDescription>
                </CardHeader>

                {settings.liveCaEnabled ? (
                  <CardContent className="space-y-3 text-xs">
                    {conn?.lastTestState ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={conn.lastTestState === 'works' ? 'success' : 'warning'}>
                          {t(`testStates.${conn.lastTestState}`)}
                        </Badge>
                        {conn.lastTestedAt ? (
                          <span className="text-muted-foreground">
                            {t('lastTestedAt', { testedAt: f.dateTime(conn.lastTestedAt) })}
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    {canEdit ? (
                      <div className="space-y-2.5">
                        <div className="space-y-1">
                          <Label htmlFor={`ca-${provider}-label`} className="text-xs">
                            {t('labelField')}
                          </Label>
                          <Input
                            id={`ca-${provider}-label`}
                            value={form.label}
                            onChange={(e) => updateLiveField(provider, 'label', e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`ca-${provider}-cert-ref`} className="text-xs">
                            {t('certRefField')}
                          </Label>
                          <Input
                            id={`ca-${provider}-cert-ref`}
                            value={form.certRef}
                            onChange={(e) => updateLiveField(provider, 'certRef', e.target.value)}
                          />
                        </div>

                        {provider === 'vnpt_smartca' ? (
                          <>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-sp-id`} className="text-xs">
                                {t('spIdField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-sp-id`}
                                value={form.spId}
                                onChange={(e) => updateLiveField(provider, 'spId', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-sp-password`} className="text-xs">
                                {t('spPasswordField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-sp-password`}
                                type="password"
                                autoComplete="new-password"
                                value={form.spPassword}
                                onChange={(e) => updateLiveField(provider, 'spPassword', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-user-id`} className="text-xs">
                                {t('userIdField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-user-id`}
                                value={form.userId}
                                onChange={(e) => updateLiveField(provider, 'userId', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-serial`} className="text-xs">
                                {t('serialNumberField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-serial`}
                                value={form.serialNumber}
                                onChange={(e) => updateLiveField(provider, 'serialNumber', e.target.value)}
                              />
                            </div>
                          </>
                        ) : null}

                        {provider === 'viettel_mysign' ? (
                          <>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-client-id`} className="text-xs">
                                {t('clientIdField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-client-id`}
                                value={form.clientId}
                                onChange={(e) => updateLiveField(provider, 'clientId', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-client-secret`} className="text-xs">
                                {t('clientSecretField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-client-secret`}
                                type="password"
                                autoComplete="new-password"
                                value={form.clientSecret}
                                onChange={(e) => updateLiveField(provider, 'clientSecret', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-user-id`} className="text-xs">
                                {t('userIdField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-user-id`}
                                value={form.userId}
                                onChange={(e) => updateLiveField(provider, 'userId', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-profile-id`} className="text-xs">
                                {t('profileIdField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-profile-id`}
                                value={form.profileId}
                                onChange={(e) => updateLiveField(provider, 'profileId', e.target.value)}
                              />
                            </div>
                          </>
                        ) : null}

                        {provider === 'misa_wesign' ? (
                          <>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-client-id`} className="text-xs">
                                {t('clientIdField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-client-id`}
                                value={form.clientId}
                                onChange={(e) => updateLiveField(provider, 'clientId', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-client-key`} className="text-xs">
                                {t('clientKeyField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-client-key`}
                                type="password"
                                autoComplete="new-password"
                                value={form.clientKey}
                                onChange={(e) => updateLiveField(provider, 'clientKey', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-username`} className="text-xs">
                                {t('usernameField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-username`}
                                value={form.username}
                                onChange={(e) => updateLiveField(provider, 'username', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-password`} className="text-xs">
                                {t('passwordField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-password`}
                                type="password"
                                autoComplete="new-password"
                                value={form.password}
                                onChange={(e) => updateLiveField(provider, 'password', e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`ca-${provider}-tax-code`} className="text-xs">
                                {t('taxCodeField')}
                              </Label>
                              <Input
                                id={`ca-${provider}-tax-code`}
                                value={form.taxCode}
                                onChange={(e) => updateLiveField(provider, 'taxCode', e.target.value)}
                              />
                            </div>
                          </>
                        ) : null}

                        <div className="space-y-1">
                          <Label htmlFor={`ca-${provider}-endpoint`} className="text-xs">
                            {t('endpointUrlField')}
                          </Label>
                          <Input
                            id={`ca-${provider}-endpoint`}
                            value={form.baseUrl}
                            placeholder="https://"
                            onChange={(e) => updateLiveField(provider, 'baseUrl', e.target.value)}
                          />
                        </div>

                        <div className="flex flex-wrap gap-1.5 pt-1">
                          <Button
                            type="button"
                            size="sm"
                            loading={isBusy}
                            disabled={
                              !settings.brokerAvailable ||
                              !form.label.trim() ||
                              builtCredentials === null
                            }
                            onClick={() => {
                              if (!builtCredentials) return;
                              onSaveLiveProvider?.(provider, {
                                label: form.label.trim(),
                                certRef: form.certRef.trim() || `${provider}-default`,
                                credentials: builtCredentials,
                              });
                            }}
                            data-testid={`sign-ca-save-${provider}`}
                          >
                            {t('saveButton')}
                          </Button>
                          {conn?.status === 'active' ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              loading={isBusy}
                              onClick={() => onDisableConnection?.(conn.id, provider)}
                            >
                              {t('disableButton')}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : conn ? (
                      <div className="text-muted-foreground">
                        <span className="font-medium text-foreground">{conn.label}</span> ({conn.certRef})
                      </div>
                    ) : null}
                  </CardContent>
                ) : null}
              </Card>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="sign-ca-usb-note">
        {t('usbTokenNotice')}
      </p>
    </div>
  );
}

export function SignMemberSignaturesAndStampsSection({ slug }: { slug: string | null }) {
  const t = useTranslations('sign.settings');

  const [editingKind, setEditingKind] = useState<'signature' | 'initials' | null>(null);
  const [deletingKind, setDeletingKind] = useState<'signature' | 'initials' | null>(null);
  const [archivingStamp, setArchivingStamp] = useState<SignOrgStampItem | null>(null);

  const [stampSourceTab, setStampSourceTab] = useState<'generate' | 'upload'>('generate');
  const [stampTitle, setStampTitle] = useState('');
  const [stampSubtitle, setStampSubtitle] = useState('');
  const [stampKind, setStampKind] = useState<'company' | 'title' | 'custom'>('company');
  const [uploadedPngDataUrl, setUploadedPngDataUrl] = useState<string | null>(null);
  const [stampFormError, setStampFormError] = useState<string | null>(null);

  useEffect(() => {
    setEditingKind(null);
    setDeletingKind(null);
    setArchivingStamp(null);
    setStampTitle('');
    setStampSubtitle('');
    setUploadedPngDataUrl(null);
    setStampFormError(null);
  }, [slug]);

  const memberSigQuery = useQuery({
    queryKey: ['sign', 'member_signature', 'list', slug],
    queryFn: () => signApi.listMemberSignatures(),
  });

  const stampsQuery = useQuery({
    queryKey: ['sign', 'stamp', 'list', slug],
    queryFn: () => signApi.listStamps(),
  });

  const savedByKind = useMemo(() => {
    const map = new Map<'signature' | 'initials', SignMemberSignatureItem>();
    for (const item of memberSigQuery.data?.items ?? []) {
      map.set(item.kind, item);
    }
    return map;
  }, [memberSigQuery.data]);

  const upsertSigMutation = useMutation({
    mutationFn: (input: {
      kind: 'signature' | 'initials';
      signatureKind: 'draw' | 'type';
      signatureTypedText?: string | null;
      signaturePngBase64: string;
    }) => signApi.upsertMemberSignature(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sign', 'member_signature'] });
      toast(t('signatureSavedToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const deleteSigMutation = useMutation({
    mutationFn: (kind: 'signature' | 'initials') => signApi.deleteMemberSignature(kind),
    onSuccess: async () => {
      setDeletingKind(null);
      await queryClient.invalidateQueries({ queryKey: ['sign', 'member_signature'] });
      toast(t('signatureDeletedToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const createStampMutation = useMutation({
    mutationFn: (vars: {
      name: string;
      stampKind: 'company' | 'title' | 'custom';
      pngDataUrl: string;
    }) =>
      signApi.createStamp({
        name: vars.name,
        stampKind: vars.stampKind,
        stampPngBase64: stripPngDataUrlPrefix(vars.pngDataUrl),
      }),
    onSuccess: async () => {
      setStampTitle('');
      setStampSubtitle('');
      setUploadedPngDataUrl(null);
      setStampFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['sign', 'stamp'] });
      toast(t('stampCreatedToast'));
    },
    onError: (err) => {
      const msg = errorMessage(err);
      setStampFormError(msg);
      toast(msg, 'error');
    },
  });

  const archiveStampMutation = useMutation({
    mutationFn: (stampId: string) => signApi.archiveStamp(stampId),
    onSuccess: async () => {
      setArchivingStamp(null);
      await queryClient.invalidateQueries({ queryKey: ['sign', 'stamp'] });
      toast(t('stampArchivedToast'));
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const generatedStampPreview = useMemo(
    () =>
      stampTitle.trim()
        ? stampTextToPngDataUrl(stampTitle, {
            subtitle: stampSubtitle,
            stampKind: stampKind === 'company' ? 'company' : 'title',
          })
        : null,
    [stampTitle, stampSubtitle, stampKind],
  );

  const handleUploadStampFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setStampFormError(null);
    try {
      const dataUrl = await readPngFileAsDataUrl(file);
      setUploadedPngDataUrl(dataUrl);
      if (!stampTitle.trim()) {
        setStampTitle(file.name.replace(/\.png$/i, '').slice(0, 120));
      }
    } catch {
      setUploadedPngDataUrl(null);
      setStampFormError(t('stampPngInvalid'));
    }
  };

  const handleCreateStamp = (event: FormEvent) => {
    event.preventDefault();
    setStampFormError(null);
    const trimmedTitle = stampTitle.trim();
    if (!trimmedTitle) {
      setStampFormError(t('stampNameRequired'));
      return;
    }
    const pngDataUrl = stampSourceTab === 'upload' ? uploadedPngDataUrl : generatedStampPreview;
    if (!pngDataUrl) {
      setStampFormError(t('stampPngInvalid'));
      return;
    }
    createStampMutation.mutate({
      name: trimmedTitle,
      stampKind,
      pngDataUrl,
    });
  };

  const canManageStamps = stampsQuery.data?.canManage ?? false;
  const stamps = stampsQuery.data?.items ?? [];

  return (
    <div className="space-y-6" data-testid="sign-settings-profiles-section">
      <Card data-testid="sign-settings-member-signatures-card">
        <CardHeader>
          <CardTitle>{t('memberSectionTitle')}</CardTitle>
          <CardDescription>{t('memberSectionHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {memberSigQuery.isLoading ? (
            <ListSkeleton rows={2} />
          ) : memberSigQuery.error ? (
            <ErrorText>{errorMessage(memberSigQuery.error)}</ErrorText>
          ) : (
            (['signature', 'initials'] as const).map((kind) => {
              const saved = savedByKind.get(kind) ?? null;
              return (
                <div
                  key={kind}
                  className="flex flex-col justify-between gap-3 rounded-lg border border-border p-4"
                  data-testid={`member-signature-slot-${kind}`}
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {kind === 'signature' ? t('mySignatureLabel') : t('myInitialsLabel')}
                      </span>
                      <Badge variant={saved ? 'success' : 'outline'}>
                        {saved ? t('savedBadge') : t('notSavedBadge')}
                      </Badge>
                    </div>
                    <div
                      className={`flex h-28 items-center justify-center rounded-md border border-field-border p-2 ${
                        saved ? 'bg-image-surface' : 'bg-muted/30'
                      }`}
                    >
                      {saved ? (
                        <img
                          src={rawBase64ToPngDataUrl(saved.signaturePngBase64)}
                          alt={kind === 'signature' ? t('mySignatureLabel') : t('myInitialsLabel')}
                          className="max-h-full max-w-full object-contain"
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('emptySignaturePreview')}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant={saved ? 'outline' : 'default'}
                      className="min-h-11"
                      onClick={() => setEditingKind(kind)}
                      data-testid={`member-signature-edit-${kind}`}
                    >
                      {saved ? t('replaceButton') : t('createButton')}
                    </Button>
                    {saved ? (
                      <Button
                        type="button"
                        variant="destructive"
                        className="min-h-11"
                        onClick={() => setDeletingKind(kind)}
                        data-testid={`member-signature-delete-${kind}`}
                      >
                        {t('deleteSignatureButton')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card data-testid="sign-settings-org-stamps-card">
        <CardHeader>
          <CardTitle>{t('stampsSectionTitle')}</CardTitle>
          <CardDescription>{t('stampsSectionHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {stampsQuery.isLoading ? (
            <ListSkeleton rows={2} />
          ) : stampsQuery.error ? (
            <ErrorText>{errorMessage(stampsQuery.error)}</ErrorText>
          ) : (
            <>
              {canManageStamps ? (
                <form
                  onSubmit={handleCreateStamp}
                  className="space-y-4 rounded-lg border border-border bg-muted/20 p-4"
                  data-testid="org-stamp-create-form"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="org-stamp-name-input">{t('stampNameLabel')}</Label>
                      <Input
                        id="org-stamp-name-input"
                        className="min-h-11"
                        placeholder={t('stampNamePlaceholder')}
                        value={stampTitle}
                        onChange={(e) => setStampTitle(e.target.value)}
                        data-testid="org-stamp-name-input"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="org-stamp-kind-select">{t('stampKindLabel')}</Label>
                      <NativeSelect
                        id="org-stamp-kind-select"
                        className="min-h-11 w-full"
                        value={stampKind}
                        onChange={(e) => setStampKind(e.target.value as 'company' | 'title' | 'custom')}
                        data-testid="org-stamp-kind-select"
                      >
                        <NativeSelectOption value="company">{t('stampKindCompany')}</NativeSelectOption>
                        <NativeSelectOption value="title">{t('stampKindTitle')}</NativeSelectOption>
                        <NativeSelectOption value="custom">{t('stampKindCustom')}</NativeSelectOption>
                      </NativeSelect>
                    </div>
                  </div>

                  <Tabs
                    value={stampSourceTab}
                    onValueChange={(next) => setStampSourceTab(next as 'generate' | 'upload')}
                  >
                    <TabsList className="grid h-auto w-full grid-cols-2 sm:max-w-sm">
                      <TabsTrigger value="generate" className="min-h-11" data-testid="org-stamp-tab-generate">
                        {t('stampTabGenerate')}
                      </TabsTrigger>
                      <TabsTrigger value="upload" className="min-h-11" data-testid="org-stamp-tab-upload">
                        {t('stampTabUpload')}
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="generate" className="mt-3 space-y-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="org-stamp-subtitle-input">{t('stampSubtitleLabel')}</Label>
                        <Input
                          id="org-stamp-subtitle-input"
                          className="min-h-11"
                          placeholder={t('stampSubtitlePlaceholder')}
                          value={stampSubtitle}
                          onChange={(e) => setStampSubtitle(e.target.value)}
                          data-testid="org-stamp-subtitle-input"
                        />
                      </div>
                      <div
                        className={`flex h-32 items-center justify-center rounded-md border border-field-border p-2 ${
                          generatedStampPreview ? 'bg-image-surface' : 'bg-muted/30'
                        }`}
                      >
                        {generatedStampPreview ? (
                          <img
                            src={generatedStampPreview}
                            alt={stampTitle}
                            className="max-h-full max-w-full object-contain"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">{t('stampNamePlaceholder')}</span>
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="upload" className="mt-3 space-y-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="org-stamp-file-input">{t('stampUploadLabel')}</Label>
                        <Input
                          id="org-stamp-file-input"
                          type="file"
                          accept="image/png"
                          className="min-h-11"
                          onChange={(e) => void handleUploadStampFile(e)}
                          data-testid="org-stamp-file-input"
                        />
                        <p className="text-xs text-muted-foreground">{t('stampUploadHint')}</p>
                      </div>
                      {uploadedPngDataUrl ? (
                        <div className="flex h-32 items-center justify-center rounded-md border border-field-border bg-image-surface p-2">
                          <img
                            src={uploadedPngDataUrl}
                            alt={stampTitle || t('stampsSectionTitle')}
                            className="max-h-full max-w-full object-contain"
                          />
                        </div>
                      ) : null}
                    </TabsContent>
                  </Tabs>

                  {stampFormError ? <ErrorText>{stampFormError}</ErrorText> : null}

                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      className="min-h-11"
                      loading={createStampMutation.isPending}
                      data-testid="org-stamp-submit-btn"
                    >
                      {t('addStampButton')}
                    </Button>
                  </div>
                </form>
              ) : (
                <Alert data-testid="org-stamp-readonly-notice">
                  <AlertDescription>{t('memberReadOnlyNotice')}</AlertDescription>
                </Alert>
              )}

              {stamps.length === 0 ? (
                <Empty title={t('emptyStampsTitle')} hint={t('emptyStampsHint')} />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="org-stamp-list">
                  {stamps.map((stamp) => (
                    <div
                      key={stamp.id}
                      className="flex flex-col justify-between gap-3 rounded-lg border border-border p-3"
                      data-testid={`org-stamp-card-${stamp.id}`}
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">{stamp.name}</span>
                          <Badge variant={stamp.status === 'active' ? 'brand' : 'outline'}>
                            {stamp.status === 'active' ? t('activeStampBadge') : t('archivedStampBadge')}
                          </Badge>
                        </div>
                        <div className="flex h-28 items-center justify-center rounded border border-field-border bg-image-surface p-2">
                          <img
                            src={rawBase64ToPngDataUrl(stamp.stampPngBase64)}
                            alt={stamp.name}
                            className="max-h-full max-w-full object-contain"
                          />
                        </div>
                      </div>
                      {canManageStamps && stamp.status === 'active' ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => setArchivingStamp(stamp)}
                          data-testid={`org-stamp-archive-${stamp.id}`}
                        >
                          {t('archiveStampButton')}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <SignaturePadModal
        open={editingKind !== null}
        mode={editingKind ?? 'signature'}
        onOpenChange={(next) => !next && setEditingKind(null)}
        onConfirm={({ pngDataUrl, kind, typedText }) => {
          if (!editingKind) return;
          upsertSigMutation.mutate({
            kind: editingKind,
            signatureKind: kind === 'typed' ? 'type' : 'draw',
            ...(kind === 'typed' && typedText ? { signatureTypedText: typedText } : {}),
            signaturePngBase64: stripPngDataUrlPrefix(pngDataUrl),
          });
        }}
      />

      <ConfirmDialog
        open={deletingKind !== null}
        onOpenChange={(next) => !next && setDeletingKind(null)}
        title={t('deleteSignatureTitle')}
        description={t('deleteSignatureConfirm')}
        confirm={t('deleteSignatureButton')}
        destructive
        disabled={deleteSigMutation.isPending}
        onConfirm={() => {
          if (deletingKind) deleteSigMutation.mutate(deletingKind);
        }}
      />

      <ConfirmDialog
        open={archivingStamp !== null}
        onOpenChange={(next) => !next && setArchivingStamp(null)}
        title={t('archiveStampTitle')}
        description={t('archiveStampConfirm', { name: archivingStamp?.name ?? '' })}
        confirm={t('archiveStampButton')}
        destructive
        disabled={archiveStampMutation.isPending}
        onConfirm={() => {
          if (archivingStamp) archiveStampMutation.mutate(archivingStamp.id);
        }}
      />
    </div>
  );
}

export function SignSettingsPage() {
  const t = useTranslations('sign.ca');
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const settingsQuery = useQuery({
    queryKey: ['sign', 'ca-settings'],
    queryFn: () => signApi.getCaSettings(),
  });
  const [busyProvider, setBusyProvider] = useState<SignCaProvider | null>(null);
  const slug = (orgQuery.data as { slug?: string } | undefined)?.slug ?? null;

  const invalidateCa = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sign', 'ca-settings'] });
  };

  const saveMutation = useMutation({
    mutationFn: async (input: {
      provider: SignCaProvider;
      label: string;
      certRef: string;
      credentials?: SignCaCredentialsInput;
    }) => {
      setBusyProvider(input.provider);
      return signApi.saveCaConnection({
        provider: input.provider,
        label: input.label,
        certRef: input.certRef,
        status: 'active',
        ...(input.credentials ? { credentials: input.credentials } : {}),
      });
    },
    onSuccess: async () => {
      toast(t('savedToast'));
      await invalidateCa();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setBusyProvider(null),
  });

  const testMutation = useMutation({
    mutationFn: async (input: { connectionId: string; provider: SignCaProvider }) => {
      setBusyProvider(input.provider);
      return signApi.testCaConnection(input.connectionId);
    },
    onSuccess: async () => {
      toast(t('testedToast'));
      await invalidateCa();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setBusyProvider(null),
  });

  const disableMutation = useMutation({
    mutationFn: async (input: { connectionId: string; provider: SignCaProvider }) => {
      setBusyProvider(input.provider);
      return signApi.disableCaConnection(input.connectionId);
    },
    onSuccess: async () => {
      toast(t('disabledToast'));
      await invalidateCa();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setBusyProvider(null),
  });

  return (
    <div className="space-y-8">
      <SignMemberSignaturesAndStampsSection slug={slug} />
      {orgQuery.isPending || settingsQuery.isPending ? (
        <ListSkeleton />
      ) : settingsQuery.error ? (
        <ErrorText>{errorMessage(settingsQuery.error)}</ErrorText>
      ) : (
        <SignSettingsView
          role={orgQuery.data?.role}
          settings={settingsQuery.data}
          busyProvider={busyProvider}
          onSaveSandbox={({ label, certRef }) =>
            saveMutation.mutate({ provider: 'sandbox', label, certRef })
          }
          onSaveLiveProvider={(provider, { label, certRef, credentials }) =>
            saveMutation.mutate({
              provider,
              label,
              certRef,
              credentials,
            })
          }
          onTestConnection={(connectionId, provider) =>
            testMutation.mutate({ connectionId, provider })
          }
          onDisableConnection={(connectionId, provider) =>
            disableMutation.mutate({ connectionId, provider })
          }
        />
      )}
    </div>
  );
}

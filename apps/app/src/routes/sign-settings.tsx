// SPDX-License-Identifier: AGPL-3.0-only
// CA digital signature settings (/o/$slug/sign/settings, #3554): offline Sandbox PAdES configuration for owners/admins,
// read-only status for members/viewers, and Vietnamese public CA providers gated behind #62 legal review.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import {
  signApi,
  type SignCaConnectionRecord,
  type SignCaCredentialsInput,
  type SignCaProvider,
  type SignCaSettingsResult,
} from '../lib/sign-api.ts';
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

export function SignSettingsPage() {
  const t = useTranslations('sign.ca');
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const settingsQuery = useQuery({
    queryKey: ['sign', 'ca-settings'],
    queryFn: () => signApi.getCaSettings(),
  });
  const [busyProvider, setBusyProvider] = useState<SignCaProvider | null>(null);

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

  if (orgQuery.isPending || settingsQuery.isPending) {
    return <ListSkeleton />;
  }

  if (settingsQuery.error) {
    return <ErrorText>{errorMessage(settingsQuery.error)}</ErrorText>;
  }

  return (
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
  );
}

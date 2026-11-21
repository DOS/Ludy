// SPDX-License-Identifier: AGPL-3.0-only
// eSign Settings screen (/o/$slug/sign/settings, #3817):
//   1. Member-private saved signature & initials profile (author-only RLS, 1-click reuse in ceremony).
//   2. Corporate & title stamps (owner/admin manage, all SIGN_WRITERS members view & apply).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { SignaturePadModal } from '../components/sign/signature-pad-modal.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { errorMessage, queryClient } from '../lib/api.ts';
import { signApi, type SignMemberSignatureItem, type SignOrgStampItem } from '../lib/sign-api.ts';
import {
  rawBase64ToPngDataUrl,
  readPngFileAsDataUrl,
  stampTextToPngDataUrl,
  stripPngDataUrlPrefix,
} from '../lib/sign-signature.ts';
import { toast } from '../lib/toast.ts';

export function SignSettingsPage() {
  const t = useTranslations('sign.settings');
  const { slug } = useParams({ strict: false });

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
    queryKey: ['sign', 'member_signature', 'list', slug ?? null],
    queryFn: () => signApi.listMemberSignatures(),
  });

  const stampsQuery = useQuery({
    queryKey: ['sign', 'stamp', 'list', slug ?? null],
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
    <div className="space-y-6" data-testid="sign-settings-page">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

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
                    <div className="flex h-28 items-center justify-center rounded-md border border-field-border bg-image-surface p-2">
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
                      <div className="flex h-32 items-center justify-center rounded-md border border-field-border bg-image-surface p-2">
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

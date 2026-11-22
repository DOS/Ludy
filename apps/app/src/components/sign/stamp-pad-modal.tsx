// SPDX-License-Identifier: AGPL-3.0-only
// Mobile-friendly corporate and title stamp dialog (#3817): select a saved workspace stamp,
// upload a validated PNG (<= 256 KB, zero SVG/XSS), or generate a crimson corporate/title seal on canvas.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { ErrorText } from '../ui.tsx';
import type { SignOrgStampItem } from '../../lib/sign-api.ts';
import {
  rawBase64ToPngDataUrl,
  readPngFileAsDataUrl,
  stampTextToPngDataUrl,
} from '../../lib/sign-signature.ts';

export interface StampPadModalProps {
  open: boolean;
  defaultOrgName?: string;
  savedStamps?: readonly SignOrgStampItem[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: { pngDataUrl: string; label?: string }) => void;
}

export function StampPadModal({
  open,
  defaultOrgName = '',
  savedStamps = [],
  onOpenChange,
  onConfirm,
}: StampPadModalProps) {
  const t = useTranslations('sign.ceremony');
  const common = useTranslations('common');
  const hasSaved = savedStamps.length > 0;
  const [tab, setTab] = useState<'saved' | 'generate' | 'upload'>(hasSaved ? 'saved' : 'generate');
  const [selectedStampId, setSelectedStampId] = useState<string>(savedStamps[0]?.id ?? '');
  const [stampKind, setStampKind] = useState<'company' | 'title'>('company');
  const [primaryText, setPrimaryText] = useState(defaultOrgName);
  const [subtitleText, setSubtitleText] = useState('');
  const [uploadedDataUrl, setUploadedDataUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUploadError(null);
    if (savedStamps.length > 0) {
      setTab('saved');
      setSelectedStampId((prev) => (savedStamps.some((s) => s.id === prev) ? prev : (savedStamps[0]?.id ?? '')));
    } else {
      setTab('generate');
    }
    if (defaultOrgName) {
      setPrimaryText((prev) => prev || defaultOrgName);
    }
  }, [open, savedStamps, defaultOrgName]);

  const generatedPreview = useMemo(
    () => (primaryText.trim() ? stampTextToPngDataUrl(primaryText, { subtitle: subtitleText, stampKind }) : null),
    [primaryText, subtitleText, stampKind],
  );

  const selectedSavedStamp = useMemo(
    () => savedStamps.find((s) => s.id === selectedStampId) ?? savedStamps[0] ?? null,
    [savedStamps, selectedStampId],
  );

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadError(null);
    try {
      const dataUrl = await readPngFileAsDataUrl(file);
      setUploadedDataUrl(dataUrl);
    } catch {
      setUploadedDataUrl(null);
      setUploadError(t('stampPngInvalid'));
    }
  };

  const canApply =
    tab === 'saved'
      ? Boolean(selectedSavedStamp)
      : tab === 'generate'
        ? Boolean(generatedPreview)
        : Boolean(uploadedDataUrl);

  const handleConfirm = () => {
    if (tab === 'saved') {
      if (!selectedSavedStamp) return;
      const pngDataUrl = rawBase64ToPngDataUrl(selectedSavedStamp.stampPngBase64);
      if (!pngDataUrl) return;
      onConfirm({ pngDataUrl, label: selectedSavedStamp.name });
      onOpenChange(false);
      return;
    }
    if (tab === 'generate') {
      if (!generatedPreview) return;
      onConfirm({ pngDataUrl: generatedPreview, label: primaryText.trim() });
      onOpenChange(false);
      return;
    }
    if (!uploadedDataUrl) return;
    onConfirm({ pngDataUrl: uploadedDataUrl });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" closeLabel={common('close')}>
        <DialogHeader>
          <DialogTitle>{t('stampPadTitle')}</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(next) => setTab(next as 'saved' | 'generate' | 'upload')}>
          <TabsList className={hasSaved ? 'grid h-auto w-full grid-cols-3' : 'grid h-auto w-full grid-cols-2'}>
            {hasSaved ? (
              <TabsTrigger value="saved" className="min-h-11" data-testid="stamp-tab-saved">
                {t('stampTabSaved')}
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="generate" className="min-h-11" data-testid="stamp-tab-generate">
              {t('stampTabGenerate')}
            </TabsTrigger>
            <TabsTrigger value="upload" className="min-h-11" data-testid="stamp-tab-upload">
              {t('stampTabUpload')}
            </TabsTrigger>
          </TabsList>

          {hasSaved ? (
            <TabsContent value="saved" className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="ceremony-saved-stamp-select">{t('stampSelectLabel')}</Label>
                <NativeSelect
                  id="ceremony-saved-stamp-select"
                  className="min-h-11 w-full"
                  value={selectedSavedStamp?.id ?? ''}
                  onChange={(e) => setSelectedStampId(e.target.value)}
                  data-testid="ceremony-saved-stamp-select"
                >
                  {savedStamps.map((stamp) => (
                    <NativeSelectOption key={stamp.id} value={stamp.id}>
                      {stamp.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {selectedSavedStamp ? (
                <div className="flex h-36 items-center justify-center rounded-lg border border-field-border bg-image-surface p-3">
                  <img
                    src={rawBase64ToPngDataUrl(selectedSavedStamp.stampPngBase64)}
                    alt={selectedSavedStamp.name}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : null}
            </TabsContent>
          ) : null}

          <TabsContent value="generate" className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="stamp-kind-select">{t('stampKindLabel')}</Label>
                <NativeSelect
                  id="stamp-kind-select"
                  className="min-h-11 w-full"
                  value={stampKind}
                  onChange={(e) => setStampKind(e.target.value as 'company' | 'title')}
                  data-testid="stamp-kind-select"
                >
                  <NativeSelectOption value="company">{t('stampKindCompany')}</NativeSelectOption>
                  <NativeSelectOption value="title">{t('stampKindTitle')}</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="stamp-subtitle-input">{t('stampSubtitleLabel')}</Label>
                <Input
                  id="stamp-subtitle-input"
                  className="min-h-11"
                  placeholder={t('stampSubtitlePlaceholder')}
                  value={subtitleText}
                  onChange={(e) => setSubtitleText(e.target.value)}
                  data-testid="stamp-subtitle-input"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stamp-primary-input">{t('stampPrimaryLabel')}</Label>
              <Input
                id="stamp-primary-input"
                className="min-h-11"
                placeholder={t('stampPrimaryPlaceholder')}
                value={primaryText}
                onChange={(e) => setPrimaryText(e.target.value)}
                data-testid="stamp-primary-input"
              />
            </div>
            <div
              className={`flex h-36 items-center justify-center rounded-lg border border-field-border p-3 ${
                generatedPreview ? 'bg-image-surface' : 'bg-muted/30'
              }`}
            >
              {generatedPreview ? (
                <img src={generatedPreview} alt={primaryText} className="max-h-full max-w-full object-contain" />
              ) : (
                <span className="text-xs text-muted-foreground">{t('stampPrimaryPlaceholder')}</span>
              )}
            </div>
          </TabsContent>

          <TabsContent value="upload" className="mt-3 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="stamp-png-upload-input">{t('stampUploadLabel')}</Label>
              <Input
                id="stamp-png-upload-input"
                type="file"
                accept="image/png"
                className="min-h-11"
                onChange={(e) => void handleFileChange(e)}
                data-testid="stamp-png-upload-input"
              />
              <p className="text-xs text-muted-foreground">{t('stampUploadHint')}</p>
            </div>
            {uploadError ? <ErrorText>{uploadError}</ErrorText> : null}
            {uploadedDataUrl ? (
              <div className="flex h-36 items-center justify-center rounded-lg border border-field-border bg-image-surface p-3">
                <img src={uploadedDataUrl} alt={t('stampPadTitle')} className="max-h-full max-w-full object-contain" />
              </div>
            ) : null}
          </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>
            {common('cancel')}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={!canApply}
            onClick={handleConfirm}
            data-testid="stamp-pad-apply"
          >
            {t('applyStamp')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

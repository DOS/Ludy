// SPDX-License-Identifier: AGPL-3.0-only
// The logo on the letterhead of quotes (#2814, docs/plan/crm-quotes.md section 4.6), in the quote settings: an owner or admin picks a PNG or a JPEG from the computer, it is uploaded
// like an image of the photo library (so it is never read as a document) and put on the letterhead by its own command, or taken off. It saves at once, apart from the form's Save.
// The browser checks the type and the size so a person is told before an upload; the server checks them again. With AI off nothing changes: no model is involved.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'use-intl';
import { QUOTE_LOGO_MAX_BYTES, QUOTE_LOGO_MAX_SIDE, QUOTE_LOGO_TYPES } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, fetchFile, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import { ClientError } from '../lib/errors.ts';

// What is wrong with a chosen image before it is sent, or null.
export function logoProblem(file: Pick<File, 'type' | 'size'>): 'type' | 'size' | null {
  if (!(QUOTE_LOGO_TYPES as readonly string[]).includes(file.type)) return 'type';
  return file.size > QUOTE_LOGO_MAX_BYTES ? 'size' : null;
}

// The current logo as an object URL, for the person to see it; null while it loads, when there is none, or when it cannot be read (the form still works).
function useLogoPreview(fileId: string | null): string | null {
  const blob = useQuery({ queryKey: ['quote-logo-preview', fileId], queryFn: () => fetchFile(fileId as string), enabled: fileId !== null, staleTime: Infinity, retry: false });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob.data]);
  return fileId === null ? null : url;
}

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.crm.quotes.key() });

export function QuoteLogoField({ fileId }: { fileId: string | null }) {
  const t = useTranslations('quotes.settings');
  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<'type' | 'size' | null>(null);
  const preview = useLogoPreview(fileId);
  const change = useMutation({
    mutationFn: async (file: File) => {
      const stored = (await uploadFiles([file], 'social')).files[0];
      if (!stored) throw new ClientError('inbox.storageUploadFailed', (tr) => tr('inbox.storageUploadFailed', { name: file.name }));
      return client.crm.quotes.setLogo({ fileId: stored.fileId });
    },
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => client.crm.quotes.removeLogo({}), onSuccess: refresh });
  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // The same file can be chosen again after a failure: the box is emptied.
    e.target.value = '';
    if (!file) return;
    const wrong = logoProblem(file);
    setProblem(wrong);
    if (!wrong) change.mutate(file);
  };
  const error = change.error ?? remove.error;
  return (
    <div role="group" aria-label={t('logo')} className="grid gap-2 sm:col-span-2" data-testid="quote-logo">
      <span className="text-sm font-medium">{t('logo')}</span>
      {preview && <img src={preview} alt={t('logoCurrent')} className="max-h-16 w-auto max-w-48 rounded border border-border bg-background object-contain p-1" />}
      <div className="flex flex-wrap gap-2">
        <input ref={picker} type="file" accept={QUOTE_LOGO_TYPES.join(',')} className="sr-only" tabIndex={-1} aria-label={t('logoChoose')} onChange={choose} />
        <Button type="button" variant="outline" size="sm" loading={change.isPending} disabled={remove.isPending} onClick={() => picker.current?.click()}>
          {fileId ? t('logoReplace') : t('logoChoose')}
        </Button>
        {fileId && (
          <Button type="button" variant="ghost" size="sm" loading={remove.isPending} disabled={change.isPending} onClick={() => remove.mutate()}>
            {t('logoRemove')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('logoHint', { max: String(QUOTE_LOGO_MAX_BYTES / 1024), side: String(QUOTE_LOGO_MAX_SIDE) })}</p>
      {problem && <ErrorText>{problem === 'type' ? t('logoType') : t('logoTooLarge', { max: String(QUOTE_LOGO_MAX_BYTES / 1024) })}</ErrorText>}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </div>
  );
}

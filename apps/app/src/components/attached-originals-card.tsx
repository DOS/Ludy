// SPDX-License-Identifier: AGPL-3.0-only
// The seller's original XML that arrived after the invoice was posted from a PDF or a photo (#2320): kept as the posted
// invoice's evidence. The card names each file, says how its seal checked out, and, when its amounts are not the posted
// document's, warns a person to look: the books are never changed by the file.
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { InboxOriginal } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { errorMessage, fetchFile } from '../lib/api.ts';
import { useFormat } from '../i18n/provider.tsx';

type Original = InboxOriginal;
const REVOKE_AFTER_MS = 60_000;

function OriginalRow({ original }: { original: Original }) {
  const t = useTranslations('inboxDetail.originals');
  const f = useFormat();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const signature = original.signature?.status ?? null;
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await fetchFile(original.fileId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = original.filename;
      a.click();
      // Some browsers cancel the download when the URL goes at once.
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
    } catch (e) {
      setError(e ?? new Error());
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="space-y-1" data-testid="attached-original">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-all text-foreground">{original.filename}</span>
        <span className="text-xs text-subtle-foreground">{t('received', { date: f.date(original.receivedAt) })}</span>
        <Button variant="outline" size="sm" loading={busy} onClick={() => void download()}>
          {t('download')}
        </Button>
      </div>
      <p className={signature === 'verified' ? 'text-xs text-muted-foreground' : 'text-sm font-medium text-destructive'} data-testid="attached-original-signature">
        {signature === 'verified' ? t('signatureVerified') : signature === 'unverified' ? t('signatureUnverified') : t('signatureNone')}
      </p>
      {original.differs ? (
        <p className="text-sm font-medium text-destructive" role="alert" data-testid="attached-original-differs">
          {t('differs')}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="attached-original-matches">
          {t('matches')}
        </p>
      )}
      {error !== null && <p className="text-xs break-words text-destructive">{errorMessage(error)}</p>}
    </li>
  );
}

export function AttachedOriginalsCard({ originals }: { originals: readonly Original[] }) {
  const t = useTranslations('inboxDetail.originals');
  if (originals.length === 0) return null;
  return (
    <Card className="mb-4 block space-y-3 p-4" data-testid="attached-originals-card">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('title')}</h2>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <ul className="space-y-3">
        {originals.map((o) => (
          <OriginalRow key={o.fileId} original={o} />
        ))}
      </ul>
    </Card>
  );
}

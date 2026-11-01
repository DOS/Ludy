// SPDX-License-Identifier: AGPL-3.0-only
// "Cần hóa đơn gốc (XML)" (#2268, plan docs/plan/einvoice-lookup.md section 5): an invoice read from a PDF has no XML to
// verify, and the PDF carried the seller's lookup link and code. The card shows them and takes the XML the person
// downloads from the provider's page. Ludy calls nobody: the person opens the provider's page, solves its CAPTCHA, and
// drops the file here, where it goes the ordinary way (an upload, the sandbox, the signature check, a proposal).
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { LookupHint } from '@crove/kernel-contract';
import { LOOKUP_PROVIDER_TABLE, safeLookupUrl } from '@crove/l10n-vn';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { errorMessage } from '../lib/api.ts';
import { useIntake } from './intake.tsx';

const PROVIDER_NAMES: ReadonlyMap<string, string> = new Map(LOOKUP_PROVIDER_TABLE.map((spec) => [spec.id, spec.name]));

// A link the person may open: re-checked here against the provider table, whatever the server stored, so a hint that
// does not pass is shown as text and never as a link. Exported for the test.
export function openableLink(hint: LookupHint, sellerTaxCode: string | null): { url: string; host: string } | null {
  if (hint.url === null) return null;
  const safe = safeLookupUrl(hint.url, sellerTaxCode);
  return safe === null ? null : { url: safe.url, host: new URL(safe.url).hostname };
}

function Hint({ hint, sellerTaxCode }: { hint: LookupHint; sellerTaxCode: string | null }) {
  const t = useTranslations('inboxDetail.lookup');
  const [copied, setCopied] = useState(false);
  const link = openableLink(hint, sellerTaxCode);
  const code = hint.code;
  const copy = async () => {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // No clipboard (a plain-HTTP page, or refused): the code stays on screen to copy by hand.
      setCopied(false);
    }
  };
  return (
    <li className="space-y-1" data-testid="lookup-hint">
      <p className="text-sm font-medium text-foreground">{hint.provider ? (PROVIDER_NAMES.get(hint.provider) ?? hint.provider) : t('unknownProvider')}</p>
      {code !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-subtle-foreground">{t('code')}</span>
          <span className="font-mono text-sm break-all text-foreground" data-testid="lookup-code">
            {code}
          </span>
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? t('copied') : t('copy')}
          </Button>
        </div>
      )}
      {link !== null ? (
        <p className="text-xs text-muted-foreground">
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline" data-testid="lookup-link">
            {t('open')}
          </a>{' '}
          <span className="break-all">({link.host})</span>
        </p>
      ) : (
        hint.url !== null && (
          <p className="text-xs break-all text-muted-foreground" data-testid="lookup-text">
            {t('linkAsText')} {hint.url}
          </p>
        )
      )}
    </li>
  );
}

export function LookupOriginalCard({ hints, sellerTaxCode }: { hints: readonly LookupHint[]; sellerTaxCode: string | null }) {
  const t = useTranslations('inboxDetail.lookup');
  const intake = useIntake();
  const input = useRef<HTMLInputElement>(null);
  const item = intake.items[0];
  const failed = item?.state === 'upload_failed';
  const sent = item !== undefined && !failed;
  if (hints.length === 0) return null;
  return (
    <Card className="mb-4 block space-y-3 p-4" data-testid="lookup-original-card">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('title')}</h2>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <ul className="space-y-3">
        {hints.map((hint) => (
          <Hint key={`${hint.provider ?? ''}|${hint.url ?? ''}|${hint.code ?? ''}`} hint={hint} sellerTaxCode={sellerTaxCode} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" loading={intake.uploading} onClick={() => input.current?.click()}>
          {t('upload')}
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          accept=".xml,application/xml,text/xml"
          data-testid="lookup-xml-input"
          onChange={(e) => {
            const chosen = [...(e.target.files ?? [])].slice(0, 1);
            if (chosen.length) intake.start(chosen);
            e.target.value = '';
          }}
        />
        {sent && !intake.uploading && <span className="text-xs text-muted-foreground">{t('sent')}</span>}
        {failed && <span className="text-xs break-words text-destructive">{errorMessage(item.uploadError)}</span>}
      </div>
    </Card>
  );
}

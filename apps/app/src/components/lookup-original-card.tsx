// SPDX-License-Identifier: AGPL-3.0-only
// "Cần hóa đơn gốc (XML)" (#2268, plan docs/plan/einvoice-lookup.md section 5): an invoice read from a PDF has no XML to
// verify, and the PDF carried the seller's lookup link and code. The card shows them and takes the XML the person
// downloads from the provider's page. Ludy calls nobody: the person opens the provider's page, solves its CAPTCHA, and
// uploads the file here, where it goes the ordinary way (an upload, the sandbox, the signature check, a proposal).
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { LookupHint } from '@crove/kernel-contract';
import { LOOKUP_PROVIDER_TABLE, safeLookupUrl } from '@crove/l10n-vn';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { errorMessage } from '../lib/api.ts';
import { useIntake } from './intake.tsx';

const PROVIDER_NAMES: ReadonlyMap<string, string> = new Map(LOOKUP_PROVIDER_TABLE.map((spec) => [spec.id, spec.name]));
const COPIED_MS = 2000;

// A link the person may open: re-checked here against the provider table, whatever the server stored, so a hint that
// does not pass is shown as text and never as a link. Exported for the test.
export function openableLink(hint: LookupHint, sellerTaxCode: string | null): { url: string; host: string } | null {
  if (hint.url === null) return null;
  const safe = safeLookupUrl(hint.url, sellerTaxCode);
  return safe === null ? null : { url: safe.url, host: new URL(safe.url).hostname };
}

function Hint({ hint, sellerTaxCode }: { hint: LookupHint; sellerTaxCode: string | null }) {
  const t = useTranslations('inboxDetail.lookup');
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const link = openableLink(hint, sellerTaxCode);
  const code = hint.code;
  const provider = hint.provider ? (PROVIDER_NAMES.get(hint.provider) ?? hint.provider) : t('unknownProvider');
  useEffect(() => {
    if (copy !== 'copied') return;
    const timer = setTimeout(() => setCopy('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copy]);
  const copyCode = async () => {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopy('copied');
    } catch {
      // No clipboard (a plain-HTTP page, or refused): the code stays on screen to copy by hand, and the card says so.
      setCopy('failed');
    }
  };
  return (
    <li className="space-y-1" data-testid="lookup-hint">
      <p className="text-sm font-medium text-foreground">{provider}</p>
      {code !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-subtle-foreground">{t('code')}</span>
          <span className="font-mono text-sm break-all text-foreground" data-testid="lookup-code">
            {code}
          </span>
          <Button variant="outline" size="sm" aria-label={`${t('copy')} (${provider})`} onClick={() => void copyCode()}>
            {copy === 'copied' ? t('copied') : t('copy')}
          </Button>
          {copy === 'failed' && <span className="text-xs text-muted-foreground">{t('copyByHand')}</span>}
        </div>
      )}
      {link !== null ? (
        <p className="text-xs text-muted-foreground">
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline" data-testid="lookup-link">
            {t('open')}
            <span className="sr-only"> ({t('newTab')})</span>
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

// legalEntityId: the entity the proposal belongs to, so the original is booked there whatever the shell works in.
// onDismiss: the card of an Inbox item (a mail with no invoice attached, #2286) can be dismissed; one on a proposal cannot.
export function LookupOriginalCard({
  hints,
  sellerTaxCode,
  legalEntityId,
  onDismiss,
  dismissing = false,
}: {
  hints: readonly LookupHint[];
  sellerTaxCode: string | null;
  legalEntityId?: string | undefined;
  onDismiss?: (() => void) | undefined;
  dismissing?: boolean;
}) {
  const t = useTranslations('inboxDetail.lookup');
  const intake = useIntake(legalEntityId);
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState(false);
  const [notXml, setNotXml] = useState(false);
  const item = intake.items[0];
  if (hints.length === 0) return null;
  // What happened to the file, in words: only a file that was filed and is being read, or became a proposal, is "sent".
  let notice: { text: string; tone: 'muted' | 'error' } | null = null;
  if (notXml) notice = { text: t('notXml'), tone: 'error' };
  else if (item?.state === 'upload_failed') notice = { text: errorMessage(item.uploadError), tone: 'error' };
  else if (item?.state === 'failed') notice = { text: item.error ?? t('unreadable'), tone: 'error' };
  else if (item?.state === 'duplicate') notice = { text: t('duplicate'), tone: 'muted' };
  else if (item?.state === 'waiting') notice = { text: t('waiting'), tone: 'muted' };
  else if (item?.state === 'processing' || item?.state === 'proposed') notice = { text: t('sent'), tone: 'muted' };
  else if (picked && item === undefined) notice = { text: t('preparing'), tone: 'muted' };
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
            e.target.value = '';
            // The picker's "all files" lets anything through; this card takes the XML only, so a PDF is not read again.
            if (chosen.length === 0) return;
            if (!/\.xml$/i.test(chosen[0]?.name ?? '')) {
              setNotXml(true);
              return;
            }
            setNotXml(false);
            setPicked(true);
            intake.start(chosen);
          }}
        />
        {onDismiss && (
          <Button variant="ghost" size="sm" disabled={dismissing} onClick={onDismiss}>
            {t('dismiss')}
          </Button>
        )}
        {notice !== null && (
          <span className={notice.tone === 'error' ? 'text-xs break-words text-destructive' : 'text-xs text-muted-foreground'} role="status">
            {notice.text}
          </span>
        )}
      </div>
    </Card>
  );
}

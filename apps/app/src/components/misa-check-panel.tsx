// SPDX-License-Identifier: AGPL-3.0-only
// The check before a MISA SME voucher export (#3848): a person picks a file kind, asks for the check, and sees what MISA's import will refuse or cut, grouped by kind and column with a count and the first
// examples, before the download. The check is a read (vouchers.misaCheck) over the very rows the file is built from; it only warns, and the export buttons beside it are not held back by it. Nothing here
// names a supplier, an invoice or an amount: a row is told by Ludy's voucher number and the line.
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import type { MisaCheck, MisaCheckCounts, MisaCheckFormat, MisaCheckLine } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { client, errorMessage } from '../lib/api.ts';
import { ErrorText } from './ui.tsx';

// How many example rows a group shows on screen (the server sends up to 20).
const SHOWN = 5;

// The findings of each kind summed over the groups, as the server counts them for the coworker's line (apps/kernel finance-misa-check-line-ai.ts): the line is shown only beside the list it was written from.
function misaCheckCounts(check: MisaCheck): MisaCheckCounts {
  const of = (kind: MisaCheck['groups'][number]['kind']) => check.groups.filter((g) => g.kind === kind).reduce((sum, g) => sum + g.count, 0);
  return { rows: check.rows, codes: of('MISSING_CODE'), required: of('MISSING_REQUIRED'), vat: of('VAT_CODE'), accounts: of('ACCOUNT_NOT_IN_CHART'), tooLong: of('TOO_LONG') };
}
const sameCounts = (a: MisaCheckCounts, b: MisaCheckCounts) => a.rows === b.rows && a.codes === b.codes && a.required === b.required && a.vat === b.vat && a.accounts === b.accounts && a.tooLong === b.tooLong;

export function MisaCheckPanel({ formats, from, to, legalEntityId }: { formats: readonly MisaCheckFormat[]; from: string; to: string; legalEntityId: string | undefined }) {
  const t = useTranslations('misaCheck');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const [format, setFormat] = useState<MisaCheckFormat>(formats[0] as MisaCheckFormat);
  const id = useId();
  // The answer belongs to the file kind and range it was asked for; a new kind or new dates clear it, so an old list is never read beside new dates.
  const check = useMutation<MisaCheck>({
    mutationFn: () => client.vouchers.misaCheck({ format, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(legalEntityId === undefined ? {} : { legalEntityId }) }),
  });
  // The coworker's one line about the findings (slice B): asked only when something is flagged, after the list is on screen; with AI off or a refused text the list stands alone.
  const line = useMutation<MisaCheckLine>({
    mutationFn: () => client.vouchers.misaCheckLine({ format, lang, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(legalEntityId === undefined ? {} : { legalEntityId }) }),
  });
  const asked = `${format}|${from}|${to}|${legalEntityId ?? ''}`;
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);
  // A new file kind or new dates clear the answer and any error of the old ask.
  const { reset } = check;
  const { reset: resetLine } = line;
  useEffect(() => {
    reset();
    resetLine();
  }, [asked, reset, resetLine]);
  const result = check.data && answeredFor === asked ? check.data : null;
  return (
    <details className="mb-4 rounded-md border border-border p-3 text-sm print:hidden" data-testid="misa-check">
      <summary className="cursor-pointer font-medium text-foreground">{t('title')}</summary>
      <p className="mt-2 text-muted-foreground">{t('hint')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
            {t('formatLabel')}
          </label>
          <NativeSelect id={id} value={format} onChange={(e) => setFormat(e.target.value as MisaCheckFormat)}>
            {formats.map((f) => (
              <NativeSelectOption key={f} value={f}>
                {t(`format.${f}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button
          type="button"
          variant="outline"
          loading={check.isPending}
          onClick={() =>
            check.mutate(undefined, {
              onSuccess: (data) => {
                setAnsweredFor(asked);
                if (data.findings > 0) line.mutate();
              },
            })
          }
          data-testid="misa-check-run"
        >
          {t('run')}
        </Button>
      </div>
      {check.error && (
        <div className="mt-2" data-testid="misa-check-error">
          <ErrorText>{errorMessage(check.error)}</ErrorText>
        </div>
      )}
      {result && <MisaCheckResult result={result} line={line.data && sameCounts(line.data.counts, misaCheckCounts(result)) ? line.data : null} />}
    </details>
  );
}

export function MisaCheckResult({ result, line = null }: { result: MisaCheck; line?: MisaCheckLine | null }) {
  const t = useTranslations('misaCheck');
  if (result.rows === 0) {
    return (
      <p className="mt-3 text-muted-foreground" data-testid="misa-check-empty">
        {t('noRows')}
      </p>
    );
  }
  if (result.groups.length === 0) {
    return (
      <p className="mt-3 text-foreground" data-testid="misa-check-clean">
        {t('clean', { rows: String(result.rows) })}
      </p>
    );
  }
  return (
    <div className="mt-3" role="status" data-testid="misa-check-result">
      <p className="mb-2 text-foreground" data-testid="misa-check-summary">
        {t('summary', { findings: String(result.findings), rows: String(result.rows) })}
      </p>
      {line?.ai === 'used' && line.text && (
        <p className="mb-2 text-muted-foreground" data-testid="misa-check-line-text">
          {line.text}
        </p>
      )}
      {(line?.ai === 'busy' || line?.ai === 'budget' || line?.ai === 'failed') && (
        <p className="mb-2 text-subtle-foreground" data-testid="misa-check-line-ai-state">
          {t(`lineAi.${line.ai}`)}
        </p>
      )}
      <ul className="space-y-3">
        {result.groups.map((g) => {
          const shown = Math.min(g.examples.length, SHOWN);
          return (
            <li key={`${g.kind}:${g.column}`} className="rounded-md border border-border p-2" data-testid="misa-check-group">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{t(`kind.${g.kind}`)}</Badge>
                <span className="font-medium text-foreground">{g.column}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">{t('count', { count: String(g.count) })}</span>
              </div>
              <p className="mt-1 text-muted-foreground">{t(`meaning.${g.kind}`, { limit: String(g.limit ?? '') })}</p>
              {shown > 0 && (
                <p className="mt-1 text-xs text-subtle-foreground" data-testid="misa-check-examples">
                  {t('examples')} {g.examples.slice(0, shown).map((e) => (e.lineNo === null ? e.voucherNo : `${e.voucherNo} #${e.lineNo}`)).join(', ')}
                  {g.count > shown ? ` ${t('andMore', { count: String(g.count - shown) })}` : ''}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-subtle-foreground">{t('warnOnly')}</p>
    </div>
  );
}

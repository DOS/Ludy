// SPDX-License-Identifier: AGPL-3.0-only
// The approved payments to suppliers waiting for the bank (#3113 S3b-2, #3700), for owners and admins: pick the payments and download one bank file (xlsx) to upload to the bank. Ludy never moves money.
// A sensitive read: it needs a second factor used in the last 5 minutes (the StepUpPrompt repeats the refused request). A refusal that belongs to one payment is shown on that payment's own row
// (by its id, never a holder, a number or an amount); a payment that already has a file asks for a confirmation before a second one is made, and that confirmation is audited.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { SupplierPayment } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { StepUpPrompt } from './two-factor.tsx';
import { ErrorText } from './ui.tsx';
import { apiFetch, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { ApiError } from '../lib/errors.ts';
import { useFormat } from '../i18n/provider.tsx';

export function SupplierPaymentsPanel({ names }: { names: ReadonlyMap<string, string> }) {
  const t = useTranslations('vendors.payments');
  const f = useFormat();
  const list = useQuery(orpc.supplierPayment.list.queryOptions({ input: {} }));
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [reexport, setReexport] = useState(false);
  const download = useMutation({
    mutationFn: async (again: boolean) => {
      const ids = [...picked].join(',');
      const response = await apiFetch(`/api/supplier-payment-bank-file/payments.xlsx?ids=${encodeURIComponent(ids)}${again ? '&reexport=1' : ''}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('fileName');
      a.click();
      URL.revokeObjectURL(url);
    },
    onSuccess: async () => {
      setPicked(new Set());
      setReexport(false);
      await queryClient.invalidateQueries({ queryKey: orpc.supplierPayment.key() });
    },
  });
  const approved = (list.data ?? []).filter((p) => p.status === 'approved');
  if (approved.length === 0) return null;
  const stepUp = isStepUpRequired(download.error);
  const refusal = download.error instanceof ApiError ? download.error : null;
  const refused = refusal?.paymentId ?? null;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
    download.reset();
    setReexport(false);
  };
  const now = Date.now();
  const hold = (p: SupplierPayment) => p.payableAfter !== null && new Date(p.payableAfter).getTime() > now;
  return (
    <section className="mb-6 rounded-md border border-border p-4 print:hidden" aria-label={t('title')} data-testid="supplier-payments">
      <h2 className="mb-1 text-sm font-semibold">{t('title')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('hint')}</p>
      <ul className="divide-y">
        {approved.map((p) => (
          <li key={p.id} className="py-2" data-testid="supplier-payment-row">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Checkbox checked={picked.has(p.id)} onCheckedChange={(on) => toggle(p.id, on === true)} aria-label={t('pick', { name: names.get(p.partyId) ?? '' })} data-testid="supplier-payment-pick" />
              <span className="min-w-0 flex-1 font-medium">{names.get(p.partyId) ?? p.partyId}</span>
              <span className="text-muted-foreground">
                {p.bankName} ••••{p.last4}
              </span>
              <span className="tabular-nums">{f.money(p.amount, p.currency)}</span>
              {hold(p) && <span className="text-xs text-muted-foreground">{t('heldUntil', { when: f.dateTime(p.payableAfter) })}</span>}
              {p.exportedAt !== null && <span className="text-xs text-muted-foreground">{t('exported', { when: f.dateTime(p.exportedAt), count: String(p.exportCount) })}</span>}
            </div>
            {refused === p.id && (
              <p className="mt-1 text-sm text-destructive" role="alert" data-testid="supplier-payment-refusal">
                {errorMessage(download.error)}
                {refusal?.code === 'SUPPLIER_PAYMENT_ALREADY_EXPORTED' && refusal.exportedAt !== null ? ` ${t('earlier', { when: f.dateTime(refusal.exportedAt) })}` : ''}
              </p>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="outline" loading={download.isPending} disabled={picked.size === 0} onClick={() => download.mutate(reexport)} data-testid="supplier-payments-download">
          {t('download')}
        </Button>
        {refusal?.code === 'SUPPLIER_PAYMENT_ALREADY_EXPORTED' && (
          <>
            <Button
              variant="outline"
              disabled={download.isPending}
              onClick={() => {
                setReexport(true);
                download.mutate(true);
              }}
              data-testid="supplier-payments-reexport"
            >
              {t('reexport')}
            </Button>
            <span className="text-sm text-muted-foreground">{t('reexportHint')}</span>
          </>
        )}
      </div>
      {stepUp && <StepUpPrompt action={t('stepUp')} onVerified={() => download.mutate(reexport)} onCancel={() => download.reset()} />}
      {download.error && !stepUp && refused === null && <ErrorText>{errorMessage(download.error)}</ErrorText>}
    </section>
  );
}

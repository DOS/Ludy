// SPDX-License-Identifier: AGPL-3.0-only
// Post-signature agreement terms, renewal notice windows, Vy grounded proposals, and milestone obligations (#3821).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useFormat } from '../../i18n/provider.tsx';
import { errorMessage, queryClient } from '../../lib/api.ts';
import {
  downloadSignPdfBytes,
  signApi,
  type SignEnvelopeObligationRecordContract,
  type SignObligationProposalContract,
} from '../../lib/sign-api.ts';
import { extractPdfPagesText } from '../../lib/sign-pdf.ts';
import { toast } from '../../lib/toast.ts';
import { ErrorText } from '../ui.tsx';

export interface EnvelopeObligationsCardProps {
  envelopeId: string;
  sourceFileId: string;
  pdfBytes: Uint8Array | null;
  onJumpToPage: (pageNumber: number) => void;
}

interface DraftObligationRow {
  localId: string;
  serverId: string | null;
  title: string;
  dueDate: string;
  status: 'pending' | 'completed';
  pageNumber: number | null;
  quoteExcerpt: string | null;
  proposedByAi: boolean;
}

const CURRENCY_OPTIONS = ['VND', 'USD', 'EUR', 'SGD', 'JPY'] as const;

function toDraftRowsFromRecord(record: SignEnvelopeObligationRecordContract | null): DraftObligationRow[] {
  if (!record) return [];
  return record.obligations.map((item) => ({
    localId: `row-${item.id}`,
    serverId: item.id,
    title: item.title,
    dueDate: item.dueDate ?? '',
    status: item.status,
    pageNumber: item.pageNumber,
    quoteExcerpt: item.quoteExcerpt,
    proposedByAi: item.proposedByAi,
  }));
}

export function EnvelopeObligationsCard({
  envelopeId,
  sourceFileId,
  pdfBytes,
  onJumpToPage,
}: EnvelopeObligationsCardProps) {
  const t = useTranslations('sign.obligations');
  const f = useFormat();

  const [counterpartyName, setCounterpartyName] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [renewalNoticeDays, setRenewalNoticeDays] = useState('');
  const [autoRenew, setAutoRenew] = useState(false);
  const [contractValue, setContractValue] = useState('');
  const [currency, setCurrency] = useState('VND');
  const [rows, setRows] = useState<DraftObligationRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [aiNoticeKey, setAiNoticeKey] = useState<
    'aiOffNotice' | 'aiBusyNotice' | 'aiNoTextNotice' | 'aiEmptyNotice' | 'aiFailedNotice' | null
  >(null);

  const obligationQuery = useQuery({
    queryKey: ['sign', 'obligation', envelopeId],
    queryFn: () => signApi.getObligation(envelopeId),
    enabled: Boolean(envelopeId),
  });

  const record = obligationQuery.data?.obligation ?? null;
  const canEdit = obligationQuery.data?.canEdit ?? false;
  const proposal = record?.proposal ?? null;
  const effectiveCurrency = dirty ? currency : (record?.currency || currency);
  const savedItemIds = useMemo(
    () => new Set(record?.status === 'confirmed' ? record.obligations.map((i) => i.id) : []),
    [record],
  );
  const currencyOptions = useMemo(() => {
    const out: string[] = [...CURRENCY_OPTIONS];
    for (const extra of [effectiveCurrency, proposal?.currency]) {
      const normalized = extra?.trim().toUpperCase() ?? '';
      if (/^[A-Z]{3}$/.test(normalized) && !out.includes(normalized)) {
        out.push(normalized);
      }
    }
    return out;
  }, [effectiveCurrency, proposal?.currency]);

  useEffect(() => {
    setDirty(false);
    setFormError(null);
    setAiNoticeKey(null);
  }, [envelopeId]);

  useEffect(() => {
    if (!obligationQuery.data || dirty) return;
    const obl = obligationQuery.data.obligation;
    if (!obl) {
      setCounterpartyName('');
      setEffectiveDate('');
      setExpiryDate('');
      setRenewalNoticeDays('');
      setAutoRenew(false);
      setContractValue('');
      setCurrency('VND');
      setRows([]);
      return;
    }
    setCounterpartyName(obl.counterpartyName ?? '');
    setEffectiveDate(obl.effectiveDate ?? '');
    setExpiryDate(obl.expiryDate ?? '');
    setRenewalNoticeDays(obl.renewalNoticeDays !== null ? String(obl.renewalNoticeDays) : '');
    setAutoRenew(obl.autoRenew);
    setContractValue(obl.contractValue ?? '');
    setCurrency(obl.currency || 'VND');
    setRows(toDraftRowsFromRecord(obl));
  }, [obligationQuery.data, dirty]);

  const invalidateObligationQueries = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sign', 'obligation', envelopeId] });
    await queryClient.invalidateQueries({ queryKey: ['sign', 'renewals'] });
    await queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
  };

  const extractMutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      setAiNoticeKey(null);
      let pages: Array<{ page: number; text: string }> | undefined;
      const rawBytes = pdfBytes ?? (sourceFileId ? await downloadSignPdfBytes(sourceFileId) : null);
      if (rawBytes) {
        try {
          const extracted = await extractPdfPagesText(rawBytes);
          if (extracted.length > 0) pages = extracted;
        } catch {
          // Fall back cleanly if client PDF text extraction fails; server reports no_text.
        }
      }
      return signApi.extractObligations(envelopeId, pages);
    },
    onSuccess: async (res) => {
      if (res.ai === 'off' || res.ai === 'budget') {
        setAiNoticeKey('aiOffNotice');
      } else if (res.ai === 'busy') {
        setAiNoticeKey('aiBusyNotice');
      } else if (res.ai === 'no_text') {
        setAiNoticeKey('aiNoTextNotice');
      } else if (res.ai === 'empty') {
        setAiNoticeKey('aiEmptyNotice');
      } else if (res.ai === 'failed' || res.ai === 'not_ready' || res.ai === 'not_completed') {
        setAiNoticeKey('aiFailedNotice');
      } else {
        setAiNoticeKey(null);
      }
      await invalidateObligationQueries();
    },
    onError: (err) => {
      setFormError(errorMessage(err));
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      const trimmedNotice = renewalNoticeDays.trim();
      const parsedNotice =
        trimmedNotice === ''
          ? null
          : /^\d+$/.test(trimmedNotice)
            ? Number.parseInt(trimmedNotice, 10)
            : Number.NaN;
      if (parsedNotice !== null && (Number.isNaN(parsedNotice) || parsedNotice < 0 || parsedNotice > 365)) {
        throw new Error(t('invalidNoticeDays'));
      }
      const cleanItems = rows
        .map((r) => ({
          ...(r.serverId ? { id: r.serverId } : {}),
          title: r.title.trim(),
          dueDate: r.dueDate.trim() || null,
          status: r.status,
          pageNumber: r.pageNumber,
          quoteExcerpt: r.quoteExcerpt,
          proposedByAi: r.proposedByAi,
        }))
        .filter((r) => r.title.length > 0);

      return signApi.upsertObligation({
        envelopeId,
        counterpartyName: counterpartyName.trim() || null,
        effectiveDate: effectiveDate.trim() || null,
        expiryDate: expiryDate.trim() || null,
        renewalNoticeDays: parsedNotice,
        autoRenew,
        contractValue: contractValue.trim() || null,
        currency: effectiveCurrency,
        obligations: cleanItems,
      });
    },
    onSuccess: async () => {
      setDirty(false);
      setFormError(null);
      toast(t('savedToast'));
      await invalidateObligationQueries();
    },
    onError: (err) => {
      setFormError(errorMessage(err));
    },
  });

  const dismissMutation = useMutation({
    mutationFn: () => signApi.dismissObligationProposal(envelopeId),
    onSuccess: async () => {
      toast(t('proposalDismissedToast'));
      await invalidateObligationQueries();
    },
    onError: (err) => {
      setFormError(errorMessage(err));
    },
  });

  const toggleItemMutation = useMutation({
    mutationFn: ({ itemId, completed }: { itemId: string; completed: boolean }) =>
      signApi.completeObligationItem(envelopeId, itemId, completed),
    onSuccess: async (updated) => {
      if (!dirty) {
        setRows(toDraftRowsFromRecord(updated));
      } else {
        const statusById = new Map(updated.obligations.map((i) => [i.id, i.status]));
        setRows((prev) =>
          prev.map((r) =>
            r.serverId && statusById.has(r.serverId) ? { ...r, status: statusById.get(r.serverId)! } : r,
          ),
        );
      }
      toast(t('itemUpdatedToast'));
      await invalidateObligationQueries();
    },
    onError: (err) => {
      toast(errorMessage(err), 'error');
    },
  });

  const handleLoadProposalIntoForm = (prop: SignObligationProposalContract) => {
    if (prop.counterpartyName !== null) setCounterpartyName(prop.counterpartyName);
    if (prop.effectiveDate !== null) setEffectiveDate(prop.effectiveDate);
    if (prop.expiryDate !== null) setExpiryDate(prop.expiryDate);
    if (prop.renewalNoticeDays !== null) setRenewalNoticeDays(String(prop.renewalNoticeDays));
    setAutoRenew(prop.autoRenew);
    if (prop.contractValue !== null) setContractValue(prop.contractValue);
    if (prop.currency) setCurrency(prop.currency);
    if (prop.obligations.length > 0) {
      setRows(
        prop.obligations.map((item) => ({
          localId: `prop-${item.id}`,
          serverId: item.id,
          title: item.title,
          dueDate: item.dueDate ?? '',
          status: item.status,
          pageNumber: item.pageNumber,
          quoteExcerpt: item.quoteExcerpt,
          proposedByAi: true,
        })),
      );
    }
    setDirty(true);
    toast(t('proposalLoadedToast'));
  };

  const handleAddRow = () => {
    const uid = globalThis.crypto.randomUUID().slice(0, 8);
    setRows((prev) => [
      ...prev,
      {
        localId: `new-${uid}`,
        serverId: null,
        title: '',
        dueDate: '',
        status: 'pending',
        pageNumber: null,
        quoteExcerpt: null,
        proposedByAi: false,
      },
    ]);
    setDirty(true);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit || saveMutation.isPending) return;
    saveMutation.mutate();
  };

  const statusBadge =
    record?.status === 'confirmed' ? (
      <Badge variant="success" data-testid="sign-obligation-status-badge">
        {t('statusConfirmed')}
      </Badge>
    ) : record?.status === 'proposed' ? (
      <Badge variant="warning" data-testid="sign-obligation-status-badge">
        {t('statusProposed')}
      </Badge>
    ) : record?.status === 'dismissed' ? (
      <Badge variant="outline" data-testid="sign-obligation-status-badge">
        {t('statusDismissed')}
      </Badge>
    ) : null;

  return (
    <Card data-testid="sign-obligations-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{t('cardTitle')}</CardTitle>
          {statusBadge}
        </div>
        <p className="text-xs text-muted-foreground">{t('cardHint')}</p>
      </CardHeader>

      <CardContent className="space-y-3 text-xs">
        {obligationQuery.isError ? <ErrorText>{errorMessage(obligationQuery.error)}</ErrorText> : null}
        {formError ? <ErrorText>{formError}</ErrorText> : null}

        {aiNoticeKey ? (
          <p className="rounded-md border bg-muted/40 p-2.5 text-muted-foreground" data-testid="sign-obligation-ai-notice">
            {t(aiNoticeKey)}
          </p>
        ) : null}

        {canEdit ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            loading={extractMutation.isPending}
            onClick={() => extractMutation.mutate()}
            data-testid="sign-obligation-extract-btn"
          >
            {extractMutation.isPending ? t('extracting') : t('extractButton')}
          </Button>
        ) : null}

        {canEdit && proposal ? (
          <div
            className="space-y-2.5 rounded-md border border-dashed border-proposal bg-proposal/10 p-2.5"
            data-testid="sign-obligation-proposal-banner"
          >
            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="font-semibold text-foreground">{t('proposalTitle')}</span>
                <Badge variant="warning">{t('statusProposed')}</Badge>
              </div>
              <p className="text-muted-foreground">{t('proposalHint')}</p>
            </div>

            {proposal.citations.length > 0 ? (
              <ul className="space-y-1.5" data-testid="sign-obligation-citations-list">
                {proposal.citations.map((cite) => (
                  <li key={`${cite.field}-${cite.pageNumber}`} className="rounded border bg-card px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{t(`citationField.${cite.field}`)}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-link"
                        onClick={() => onJumpToPage(cite.pageNumber)}
                      >
                        {t('jumpToPage', { page: String(cite.pageNumber) })}
                      </Button>
                    </div>
                    <p className="mt-0.5 italic text-muted-foreground">&ldquo;{cite.quoteExcerpt}&rdquo;</p>
                  </li>
                ))}
              </ul>
            ) : null}

            {proposal.obligations.length > 0 ? (
              <ul className="space-y-1.5" data-testid="sign-obligation-proposed-items">
                {proposal.obligations.map((item) => (
                  <li key={item.id} className="rounded border bg-card px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{item.title}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-link"
                        onClick={() => onJumpToPage(item.pageNumber)}
                      >
                        {t('jumpToPage', { page: String(item.pageNumber) })}
                      </Button>
                    </div>
                    {item.dueDate ? <p className="text-[11px] text-muted-foreground">{f.date(item.dueDate)}</p> : null}
                    <p className="mt-0.5 italic text-muted-foreground">&ldquo;{item.quoteExcerpt}&rdquo;</p>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => handleLoadProposalIntoForm(proposal)}
                data-testid="sign-obligation-load-proposal-btn"
              >
                {t('applyProposalToForm')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                loading={dismissMutation.isPending}
                onClick={() => dismissMutation.mutate()}
                data-testid="sign-obligation-dismiss-proposal-btn"
              >
                {t('dismissProposal')}
              </Button>
            </div>
          </div>
        ) : null}

        {canEdit ? (
          <form onSubmit={handleSubmit} className="space-y-3" data-testid="sign-obligation-form">
            <div className="space-y-1">
              <Label htmlFor="sign-obl-counterparty" className="text-xs">
                {t('counterpartyLabel')}
              </Label>
              <Input
                id="sign-obl-counterparty"
                value={counterpartyName}
                placeholder={t('counterpartyPlaceholder')}
                onChange={(e) => {
                  setCounterpartyName(e.target.value);
                  setDirty(true);
                }}
              />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="sign-obl-effective-date" className="text-xs">
                  {t('effectiveDateLabel')}
                </Label>
                <Input
                  id="sign-obl-effective-date"
                  type="date"
                  value={effectiveDate}
                  onChange={(e) => {
                    setEffectiveDate(e.target.value);
                    setDirty(true);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sign-obl-expiry-date" className="text-xs">
                  {t('expiryDateLabel')}
                </Label>
                <Input
                  id="sign-obl-expiry-date"
                  type="date"
                  value={expiryDate}
                  onChange={(e) => {
                    setExpiryDate(e.target.value);
                    setDirty(true);
                  }}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="sign-obl-notice-days" className="text-xs">
                {t('renewalNoticeDaysLabel')}
              </Label>
              <Input
                id="sign-obl-notice-days"
                type="number"
                min={0}
                max={365}
                inputMode="numeric"
                value={renewalNoticeDays}
                placeholder={t('renewalNoticeDaysPlaceholder')}
                onChange={(e) => {
                  setRenewalNoticeDays(e.target.value);
                  setDirty(true);
                }}
              />
            </div>

            <label htmlFor="sign-obl-auto-renew" className="flex cursor-pointer items-center gap-2 max-md:min-h-11">
              <Checkbox
                id="sign-obl-auto-renew"
                checked={autoRenew}
                onCheckedChange={(checked) => {
                  setAutoRenew(Boolean(checked));
                  setDirty(true);
                }}
              />
              <span>{t('autoRenewLabel')}</span>
            </label>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="sign-obl-contract-value" className="text-xs">
                  {t('contractValueLabel')}
                </Label>
                <Input
                  id="sign-obl-contract-value"
                  inputMode="decimal"
                  className="font-mono tabular-nums"
                  value={contractValue}
                  placeholder={t('contractValuePlaceholder')}
                  onChange={(e) => {
                    setContractValue(e.target.value);
                    setDirty(true);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sign-obl-currency" className="text-xs">
                  {t('currencyLabel')}
                </Label>
                <NativeSelect
                  id="sign-obl-currency"
                  value={effectiveCurrency}
                  className="w-full"
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setDirty(true);
                  }}
                >
                  {currencyOptions.map((code) => (
                    <NativeSelectOption key={code} value={code}>
                      {code}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>

            <div className="space-y-2 border-t pt-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{t('itemsHeading', { count: String(rows.length) })}</span>
                <Button type="button" size="sm" variant="outline" onClick={handleAddRow} data-testid="sign-obl-add-item-btn">
                  + {t('addItemButton')}
                </Button>
              </div>

              {rows.length > 0 ? (
                <ul className="space-y-2" data-testid="sign-obl-items-list">
                  {rows.map((row) => {
                    const titleInputId = `sign-obl-item-title-${row.localId}`;
                    const dueInputId = `sign-obl-item-due-${row.localId}`;
                    const canToggleDirectly = row.serverId !== null && savedItemIds.has(row.serverId) && !dirty;
                    return (
                      <li key={row.localId} className="space-y-2 rounded-md border bg-card p-2">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <Badge variant={row.status === 'completed' ? 'success' : 'secondary'}>
                            {row.status === 'completed' ? t('itemCompletedBadge') : t('itemPendingBadge')}
                          </Badge>
                          <div className="flex flex-wrap items-center gap-1">
                            {row.pageNumber !== null ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs text-link"
                                onClick={() => onJumpToPage(row.pageNumber!)}
                              >
                                {t('jumpToPage', { page: String(row.pageNumber) })}
                              </Button>
                            ) : null}
                            {canToggleDirectly ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                loading={toggleItemMutation.isPending && toggleItemMutation.variables?.itemId === row.serverId}
                                disabled={toggleItemMutation.isPending}
                                onClick={() =>
                                  toggleItemMutation.mutate({
                                    itemId: row.serverId!,
                                    completed: row.status !== 'completed',
                                  })
                                }
                                data-testid={`sign-obl-toggle-${row.serverId}`}
                              >
                                {row.status === 'completed' ? t('markPending') : t('markCompleted')}
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setRows((prev) =>
                                    prev.map((it) =>
                                      it.localId === row.localId
                                        ? { ...it, status: it.status === 'completed' ? 'pending' : 'completed' }
                                        : it,
                                    ),
                                  );
                                  setDirty(true);
                                }}
                              >
                                {row.status === 'completed' ? t('markPending') : t('markCompleted')}
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setRows((prev) => prev.filter((it) => it.localId !== row.localId));
                                setDirty(true);
                              }}
                            >
                              {t('removeItemButton')}
                            </Button>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <Label htmlFor={titleInputId} className="text-xs">
                            {t('itemTitleLabel')}
                          </Label>
                          <Input
                            id={titleInputId}
                            value={row.title}
                            placeholder={t('itemTitlePlaceholder')}
                            onChange={(e) => {
                              const val = e.target.value;
                              setRows((prev) => prev.map((it) => (it.localId === row.localId ? { ...it, title: val } : it)));
                              setDirty(true);
                            }}
                          />
                        </div>

                        <div className="space-y-1">
                          <Label htmlFor={dueInputId} className="text-xs">
                            {t('itemDueDateLabel')}
                          </Label>
                          <Input
                            id={dueInputId}
                            type="date"
                            value={row.dueDate}
                            onChange={(e) => {
                              const val = e.target.value;
                              setRows((prev) => prev.map((it) => (it.localId === row.localId ? { ...it, dueDate: val } : it)));
                              setDirty(true);
                            }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>

            <Button
              type="submit"
              size="sm"
              className="w-full"
              loading={saveMutation.isPending}
              data-testid="sign-obl-save-btn"
            >
              {t('saveConfirmButton')}
            </Button>
          </form>
        ) : (
          <div className="space-y-2.5" data-testid="sign-obligation-readonly">
            {record?.status === 'confirmed' ? (
              <div className="space-y-2">
                {record.counterpartyName ? (
                  <p className="font-medium text-foreground">
                    {t('counterpartyChip', { name: record.counterpartyName })}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2 text-muted-foreground">
                  {record.effectiveDate ? (
                    <span>
                      {t('effectiveDateLabel')}: {f.date(record.effectiveDate)}
                    </span>
                  ) : null}
                  {record.expiryDate ? <span>{t('expiryOn', { date: f.date(record.expiryDate) })}</span> : null}
                  {record.contractValue !== null ? (
                    <span className="font-mono tabular-nums text-foreground">
                      {f.money(record.contractValue, record.currency)}
                    </span>
                  ) : null}
                </div>
                {record.obligations.length > 0 ? (
                  <ul className="space-y-1.5">
                    {record.obligations.map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-2 rounded border bg-card px-2 py-1.5">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">{item.title}</p>
                          {item.dueDate ? <p className="text-[11px] text-muted-foreground">{f.date(item.dueDate)}</p> : null}
                        </div>
                        <Badge variant={item.status === 'completed' ? 'success' : 'secondary'}>
                          {item.status === 'completed' ? t('itemCompletedBadge') : t('itemPendingBadge')}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">{t('emptyViewer')}</p>
            )}
            <p className="text-[11px] text-muted-foreground">{t('viewerReadOnly')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

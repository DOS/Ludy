// SPDX-License-Identifier: AGPL-3.0-only
// Stage 6C (#4528) modular UI panels for /hr/employees and /hr/my:
// - HrAddendumPanel: contract addendum builder + Ly statutory check + PDF + eSign handoff
// - HrCareerTimelinePanel: chronological employment, probation & issued addendum timeline
// - HrAssetsPanel & HrSelfAssetsCard: asset issuance, return/lost_waived tracking & self-service view
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  vietnamToday,
  type HrAddendumCheckResult,
  type HrAddendumView,
  type HrAssetStatus,
  type HrAssetView,
  type HrEmployee,
  type HrSelfAssetView,
  type HrTimelineEvent,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { HrContractSignHandoff } from './hr-contract-sign-handoff.tsx';
import { ErrorText, TableSkeleton } from './ui.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const PHONE_TARGET = 'max-md:min-h-11';
const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

const ADDENDUM_BADGE = {
  draft: 'warning',
  issued: 'success',
  voided: 'outline',
} as const;

const ASSET_BADGE: Record<HrAssetStatus, 'warning' | 'success' | 'outline'> = {
  assigned: 'warning',
  returned: 'success',
  lost_waived: 'outline',
};

const TIMELINE_BADGE = {
  employment_started: 'secondary',
  probation_reviewed: 'proposal',
  addendum_issued: 'success',
} as const;

export function countUnreturnedAssets(items: readonly Pick<HrAssetView, 'status'>[] | undefined): number {
  if (!items) return 0;
  return items.filter((item) => item.status === 'assigned').length;
}

function downloadBase64Pdf(filename: string, pdfBase64: string): void {
  const binary = atob(pdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HrAddendumPanel({
  employee,
  signEnabled = false,
  employer = null,
}: {
  employee: HrEmployee;
  signEnabled?: boolean;
  employer?: { name: string; taxCode?: string | null; address?: string | null } | null;
}) {
  const t = useTranslations('hrEmployees.addendum');
  const f = useFormat();
  const { locale } = useLocaleSetting();

  const latestEmployment = employee.employments[employee.employments.length - 1] ?? null;
  const [prevEmpId, setPrevEmpId] = useState(employee.id);
  const [employmentId, setEmploymentId] = useState(latestEmployment?.id ?? '');
  const [addendumNumber, setAddendumNumber] = useState('PL-01');
  const [effectiveOn, setEffectiveOn] = useState(vietnamToday());
  const [previousPayRate, setPreviousPayRate] = useState(latestEmployment?.baseWage ?? '');
  const [newPayRate, setNewPayRate] = useState('');
  const [previousTitle, setPreviousTitle] = useState(employee.jobTitle ?? '');
  const [newTitle, setNewTitle] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [checkResult, setCheckResult] = useState<HrAddendumCheckResult | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');

  if (prevEmpId !== employee.id) {
    setPrevEmpId(employee.id);
    const latest = employee.employments[employee.employments.length - 1] ?? null;
    setEmploymentId(latest?.id ?? '');
    setAddendumNumber('PL-01');
    setEffectiveOn(vietnamToday());
    setPreviousPayRate(latest?.baseWage ?? '');
    setNewPayRate('');
    setPreviousTitle(employee.jobTitle ?? '');
    setNewTitle('');
    setChangeSummary('');
    setCheckResult(null);
    setVoidingId(null);
    setVoidReason('');
  }

  const listQ = useQuery({
    ...orpc.hr.addendum.list.queryOptions({ input: { employeeId: employee.id } }),
    ...ONCE,
    gcTime: 0,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });

  const normalizedInputs = () => {
    const prevPay = previousPayRate.trim();
    const nextPay = newPayRate.trim();
    return {
      employeeId: employee.id,
      employmentId,
      addendumNumber: addendumNumber.trim(),
      effectiveOn,
      changeSummary: changeSummary.trim(),
      previousPayRate: prevPay && MONEY_PATTERN.test(prevPay) ? prevPay : null,
      newPayRate: nextPay && MONEY_PATTERN.test(nextPay) ? nextPay : null,
      previousTitle: previousTitle.trim() ? previousTitle.trim() : null,
      newTitle: newTitle.trim() ? newTitle.trim() : null,
    };
  };

  const lyCheck = useMutation({
    mutationFn: () => {
      const n = normalizedInputs();
      return client.hr.addendum.check({
        employeeId: n.employeeId,
        employmentId: n.employmentId,
        ...(n.addendumNumber ? { addendumNumber: n.addendumNumber } : {}),
        ...(n.effectiveOn ? { effectiveOn: n.effectiveOn } : {}),
        ...(n.changeSummary ? { changeSummary: n.changeSummary } : {}),
        previousPayRate: n.previousPayRate,
        newPayRate: n.newPayRate,
        previousTitle: n.previousTitle,
        newTitle: n.newTitle,
        language: locale === 'en' ? 'en' : 'vi',
        withAi: true,
      });
    },
    onSuccess: (res) => setCheckResult(res),
  });

  const createAddendum = useMutation({
    mutationFn: (issueImmediately: boolean) => {
      const n = normalizedInputs();
      return client.hr.addendum.create({
        ...n,
        issueImmediately,
      });
    },
    onSuccess: async () => {
      setChangeSummary('');
      setNewPayRate('');
      setNewTitle('');
      setCheckResult(null);
      await refresh();
      await listQ.refetch();
    },
  });

  const issueAddendum = useMutation({
    mutationFn: (addendumId: string) => client.hr.addendum.issue({ addendumId }),
    onSuccess: async () => {
      await refresh();
      await listQ.refetch();
    },
  });

  const voidAddendum = useMutation({
    mutationFn: ({ addendumId, reason }: { addendumId: string; reason: string }) =>
      client.hr.addendum.void({ addendumId, reason }),
    onSuccess: async () => {
      setVoidingId(null);
      setVoidReason('');
      await refresh();
      await listQ.refetch();
    },
  });

  const downloadPdf = useMutation({
    mutationFn: async (addendumId: string) => {
      const res = await client.hr.addendum.pdf({ addendumId, includeSignTags: signEnabled });
      downloadBase64Pdf(res.filename, res.pdfBase64);
      return res;
    },
  });

  const addendums: readonly HrAddendumView[] = listQ.data ?? [];
  const active = employee.endedOn === null;
  const selectedEmployment =
    employee.employments.find((item) => item.id === employmentId) ?? latestEmployment;
  const hasInvalidPay =
    (previousPayRate.trim() !== '' && !MONEY_PATTERN.test(previousPayRate.trim())) ||
    (newPayRate.trim() !== '' && !MONEY_PATTERN.test(newPayRate.trim()));
  const canCreate =
    active &&
    Boolean(employmentId) &&
    addendumNumber.trim().length > 0 &&
    Boolean(effectiveOn) &&
    changeSummary.trim().length > 0 &&
    !hasInvalidPay;

  const handleCreate = (ev: FormEvent, issueImmediately: boolean) => {
    ev.preventDefault();
    if (!canCreate) return;
    createAddendum.mutate(issueImmediately);
  };

  return (
    <Card className="mt-4 block space-y-4 p-4" data-testid="hr-addendum-panel">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
      </div>

      {active && employee.employments.length > 0 && (
        <form className="space-y-3 border-t pt-3" onSubmit={(ev) => handleCreate(ev, false)}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={`hr-add-emp-${employee.id}`}>{t('baseContractLabel')}</Label>
              <NativeSelect
                id={`hr-add-emp-${employee.id}`}
                className={PHONE_TARGET}
                value={employmentId}
                onChange={(ev) => setEmploymentId(ev.target.value)}
                data-testid="hr-addendum-employment"
              >
                {employee.employments.map((row) => (
                  <NativeSelectOption key={row.id} value={row.id}>
                    {f.date(row.effectiveFrom)} ({row.contractType})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`hr-add-num-${employee.id}`}>{t('numberLabel')}</Label>
              <Input
                id={`hr-add-num-${employee.id}`}
                className={PHONE_TARGET}
                value={addendumNumber}
                maxLength={80}
                onChange={(ev) => setAddendumNumber(ev.target.value)}
                data-testid="hr-addendum-number"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`hr-add-date-${employee.id}`}>{t('effectiveOnLabel')}</Label>
              <Input
                id={`hr-add-date-${employee.id}`}
                type="date"
                className={PHONE_TARGET}
                value={effectiveOn}
                onChange={(ev) => setEffectiveOn(ev.target.value)}
                data-testid="hr-addendum-effective-on"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`hr-add-prev-pay-${employee.id}`}>{t('previousPayLabel')}</Label>
              <Input
                id={`hr-add-prev-pay-${employee.id}`}
                inputMode="decimal"
                className={PHONE_TARGET}
                value={previousPayRate}
                onChange={(ev) => setPreviousPayRate(ev.target.value)}
                data-testid="hr-addendum-prev-pay"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`hr-add-new-pay-${employee.id}`}>{t('newPayLabel')}</Label>
              <Input
                id={`hr-add-new-pay-${employee.id}`}
                inputMode="decimal"
                className={PHONE_TARGET}
                value={newPayRate}
                onChange={(ev) => setNewPayRate(ev.target.value)}
                data-testid="hr-addendum-new-pay"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`hr-add-prev-title-${employee.id}`}>{t('previousTitleLabel')}</Label>
              <Input
                id={`hr-add-prev-title-${employee.id}`}
                className={PHONE_TARGET}
                value={previousTitle}
                maxLength={200}
                onChange={(ev) => setPreviousTitle(ev.target.value)}
                data-testid="hr-addendum-prev-title"
              />
            </div>
            <div className="space-y-1 sm:col-span-2 lg:col-span-1">
              <Label htmlFor={`hr-add-new-title-${employee.id}`}>{t('newTitleLabel')}</Label>
              <Input
                id={`hr-add-new-title-${employee.id}`}
                className={PHONE_TARGET}
                value={newTitle}
                maxLength={200}
                onChange={(ev) => setNewTitle(ev.target.value)}
                data-testid="hr-addendum-new-title"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor={`hr-add-summary-${employee.id}`}>{t('summaryLabel')}</Label>
            <Textarea
              id={`hr-add-summary-${employee.id}`}
              rows={3}
              maxLength={2000}
              placeholder={t('summaryPlaceholder')}
              value={changeSummary}
              onChange={(ev) => setChangeSummary(ev.target.value)}
              data-testid="hr-addendum-summary"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={PHONE_TARGET}
              loading={lyCheck.isPending}
              disabled={!employmentId || hasInvalidPay}
              onClick={() => lyCheck.mutate()}
              data-testid="hr-addendum-ly-check"
            >
              {t('lyCheckBtn')}
            </Button>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className={PHONE_TARGET}
              loading={createAddendum.isPending && createAddendum.variables === false}
              disabled={!canCreate}
              data-testid="hr-addendum-save-draft"
            >
              {t('saveDraftBtn')}
            </Button>
            <Button
              type="button"
              size="sm"
              className={PHONE_TARGET}
              loading={createAddendum.isPending && createAddendum.variables === true}
              disabled={!canCreate}
              onClick={(ev) => handleCreate(ev, true)}
              data-testid="hr-addendum-issue-now"
            >
              {t('issueNowBtn')}
            </Button>
          </div>

          {(lyCheck.error || createAddendum.error) && (
            <ErrorText>{errorMessage(lyCheck.error ?? createAddendum.error)}</ErrorText>
          )}

          {checkResult && (
            <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-sm" data-testid="hr-addendum-check-result">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={checkResult.readyToIssue ? 'success' : 'destructive'}>
                  {checkResult.readyToIssue ? t('checkReady') : t('checkBlocked')}
                </Badge>
                <Badge variant={checkResult.ai.reason === 'ok' ? 'proposal' : 'outline'}>
                  {t(`aiStates.${checkResult.ai.reason}`)}
                </Badge>
              </div>
              {checkResult.lyNote && (
                <p className="text-xs text-foreground" data-testid="hr-addendum-ly-note">
                  {checkResult.lyNote}
                </p>
              )}
              {checkResult.findings.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-xs text-subtle-foreground">
                  {checkResult.findings.map((finding) => (
                    <li key={finding.code}>{finding.detail}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </form>
      )}

      <div className="space-y-2 border-t pt-3">
        <h4 className="text-sm font-medium text-foreground">{t('listTitle')}</h4>
        {downloadPdf.error && <ErrorText>{errorMessage(downloadPdf.error)}</ErrorText>}
        {issueAddendum.error && <ErrorText>{errorMessage(issueAddendum.error)}</ErrorText>}
        {voidAddendum.error && <ErrorText>{errorMessage(voidAddendum.error)}</ErrorText>}
        {listQ.isPending ? (
          <TableSkeleton columns={4} rows={2} />
        ) : listQ.error ? (
          <ErrorText>{errorMessage(listQ.error)}</ErrorText>
        ) : addendums.length === 0 ? (
          <p className="text-sm text-subtle-foreground" data-testid="hr-addendum-empty">
            {t('empty')}
          </p>
        ) : (
          <div className="space-y-2">
            {addendums.map((item) => {
              const matchedEmployment =
                employee.employments.find((row) => row.id === item.employmentId) ?? selectedEmployment;
              return (
                <div key={item.id} className="space-y-2 rounded-md border p-3 text-sm" data-testid="hr-addendum-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{item.addendumNumber}</span>
                      <Badge variant={ADDENDUM_BADGE[item.status]}>{t(`statuses.${item.status}`)}</Badge>
                      <span className="text-xs text-subtle-foreground">
                        {t('effectiveOnInline', { date: f.date(item.effectiveOn) })}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={PHONE_TARGET}
                        loading={downloadPdf.isPending && downloadPdf.variables === item.id}
                        onClick={() => downloadPdf.mutate(item.id)}
                        data-testid="hr-addendum-pdf-btn"
                      >
                        {t('downloadPdfBtn')}
                      </Button>
                      {item.status === 'draft' && (
                        <Button
                          type="button"
                          size="sm"
                          className={PHONE_TARGET}
                          loading={issueAddendum.isPending && issueAddendum.variables === item.id}
                          onClick={() => issueAddendum.mutate(item.id)}
                          data-testid="hr-addendum-issue-btn"
                        >
                          {t('issueBtn')}
                        </Button>
                      )}
                      {signEnabled && matchedEmployment && item.status === 'issued' && (
                        <HrContractSignHandoff
                          source={{
                            employment: matchedEmployment,
                            employee: {
                              id: employee.id,
                              displayName: employee.displayName,
                              legalEntityId: employee.legalEntityId,
                              departmentName: employee.departmentName,
                              jobTitle: employee.jobTitle,
                              address: employee.address,
                              birthDate: employee.birthDate,
                            },
                            employer,
                            addendum: {
                              id: item.id,
                              addendumNumber: item.addendumNumber,
                              effectiveOn: item.effectiveOn,
                              status: item.status,
                            },
                          }}
                          canEdit={active}
                          signEnabled={signEnabled}
                        />
                      )}
                      {item.status !== 'voided' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className={PHONE_TARGET}
                          onClick={() => {
                            setVoidingId((cur) => (cur === item.id ? null : item.id));
                            setVoidReason('');
                          }}
                          data-testid="hr-addendum-void-open"
                        >
                          {t('voidBtn')}
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-foreground">{item.changeSummary}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-subtle-foreground">
                    {(item.previousPayRate !== null || item.newPayRate !== null) && (
                      <span>
                        {t('payDeltaSummary', {
                          prev: item.previousPayRate ? f.money(item.previousPayRate) : '-',
                          next: item.newPayRate ? f.money(item.newPayRate) : '-',
                        })}
                      </span>
                    )}
                    {(item.previousTitle !== null || item.newTitle !== null) && (
                      <span>
                        {t('titleDeltaSummary', {
                          prev: item.previousTitle ?? '-',
                          next: item.newTitle ?? '-',
                        })}
                      </span>
                    )}
                    {item.voidReason && (
                      <span className="text-destructive">{t('voidReasonInline', { reason: item.voidReason })}</span>
                    )}
                  </div>
                  {voidingId === item.id && (
                    <div className="flex flex-wrap items-center gap-2 border-t pt-2">
                      <Input
                        className={`max-w-sm ${PHONE_TARGET}`}
                        aria-label={t('voidReasonPlaceholder')}
                        placeholder={t('voidReasonPlaceholder')}
                        value={voidReason}
                        maxLength={500}
                        onChange={(ev) => setVoidReason(ev.target.value)}
                        data-testid="hr-addendum-void-reason"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className={PHONE_TARGET}
                        loading={voidAddendum.isPending}
                        disabled={voidReason.trim().length === 0}
                        onClick={() => voidAddendum.mutate({ addendumId: item.id, reason: voidReason.trim() })}
                        data-testid="hr-addendum-void-confirm"
                      >
                        {t('voidConfirmBtn')}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

export function HrCareerTimelinePanel({ employeeId }: { employeeId: string }) {
  const t = useTranslations('hrEmployees.timeline');
  const f = useFormat();
  const q = useQuery({
    ...orpc.hr.timeline.get.queryOptions({ input: { employeeId } }),
    ...ONCE,
    gcTime: 0,
  });

  const events: readonly HrTimelineEvent[] = q.data?.events ?? [];

  return (
    <Card className="mt-4 block space-y-3 p-4" data-testid="hr-timeline-panel">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
      </div>
      {q.isPending ? (
        <TableSkeleton columns={3} rows={2} />
      ) : q.error ? (
        <ErrorText>{errorMessage(q.error)}</ErrorText>
      ) : events.length === 0 ? (
        <p className="text-sm text-subtle-foreground" data-testid="hr-timeline-empty">
          {t('empty')}
        </p>
      ) : (
        <ol className="space-y-2 border-l-2 border-border pl-4" data-testid="hr-timeline-list">
          {events.map((ev) => (
            <li key={ev.id} className="space-y-1 rounded-md border p-3 text-sm" data-testid="hr-timeline-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={TIMELINE_BADGE[ev.kind]}>{t(`kinds.${ev.kind}`)}</Badge>
                  <span className="font-medium text-foreground">{ev.title}</span>
                </div>
                <span className="text-xs text-subtle-foreground">{f.date(ev.occurredOn)}</span>
              </div>
              {ev.subtitle && (
                <p className="text-xs text-subtle-foreground">
                  {ev.kind === 'employment_started' && typeof ev.metadata.baseWage === 'string'
                    ? `${f.money(ev.metadata.baseWage)} đ`
                    : ev.subtitle}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function HrAssetsPanel({ employeeId, active }: { employeeId: string; active: boolean }) {
  const t = useTranslations('hrEmployees.assets');
  const f = useFormat();

  const [prevEmpId, setPrevEmpId] = useState(employeeId);
  const [assetCode, setAssetCode] = useState('');
  const [assetName, setAssetName] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [handedOverOn, setHandedOverOn] = useState(vietnamToday());
  const [notes, setNotes] = useState('');
  const [clearDateById, setClearDateById] = useState<Record<string, string>>({});

  if (prevEmpId !== employeeId) {
    setPrevEmpId(employeeId);
    setAssetCode('');
    setAssetName('');
    setSerialNumber('');
    setHandedOverOn(vietnamToday());
    setNotes('');
    setClearDateById({});
  }

  const listQ = useQuery({
    ...orpc.hr.assets.list.queryOptions({ input: { employeeId } }),
    ...ONCE,
    gcTime: 0,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });

  const assignAsset = useMutation({
    mutationFn: () =>
      client.hr.assets.assign({
        employeeId,
        assetCode: assetCode.trim(),
        assetName: assetName.trim(),
        serialNumber: serialNumber.trim() ? serialNumber.trim() : null,
        handedOverOn,
        notes: notes.trim() ? notes.trim() : null,
      }),
    onSuccess: async () => {
      setAssetCode('');
      setAssetName('');
      setSerialNumber('');
      setNotes('');
      await refresh();
      await listQ.refetch();
    },
  });

  const updateAssetStatus = useMutation({
    mutationFn: (vars: { assetId: string; status: 'returned' | 'lost_waived'; returnedOn?: string | null }) =>
      client.hr.assets.updateStatus({
        assetId: vars.assetId,
        status: vars.status,
        ...(vars.returnedOn !== undefined ? { returnedOn: vars.returnedOn } : {}),
      }),
    onSuccess: async () => {
      await refresh();
      await listQ.refetch();
    },
  });

  const assets: readonly HrAssetView[] = listQ.data ?? [];
  const unreturnedCount = countUnreturnedAssets(assets);
  const canAssign = active && assetCode.trim().length > 0 && assetName.trim().length > 0 && Boolean(handedOverOn);

  const handleAssign = (ev: FormEvent) => {
    ev.preventDefault();
    if (!canAssign) return;
    assignAsset.mutate();
  };

  return (
    <Card className="mt-4 block space-y-4 p-4" data-testid="hr-assets-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
          <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
        </div>
        <Badge variant={unreturnedCount > 0 ? 'warning' : 'success'} data-testid="hr-assets-unreturned-badge">
          {unreturnedCount > 0
            ? t('unreturnedCount', { count: f.number(unreturnedCount) })
            : t('allCleared')}
        </Badge>
      </div>

      {active && (
        <form className="grid gap-3 border-t pt-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={handleAssign}>
          <div className="space-y-1">
            <Label htmlFor={`hr-asset-code-${employeeId}`}>{t('codeLabel')}</Label>
            <Input
              id={`hr-asset-code-${employeeId}`}
              className={PHONE_TARGET}
              value={assetCode}
              maxLength={64}
              onChange={(ev) => setAssetCode(ev.target.value)}
              data-testid="hr-asset-code"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`hr-asset-name-${employeeId}`}>{t('nameLabel')}</Label>
            <Input
              id={`hr-asset-name-${employeeId}`}
              className={PHONE_TARGET}
              value={assetName}
              maxLength={200}
              onChange={(ev) => setAssetName(ev.target.value)}
              data-testid="hr-asset-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`hr-asset-serial-${employeeId}`}>{t('serialLabel')}</Label>
            <Input
              id={`hr-asset-serial-${employeeId}`}
              className={PHONE_TARGET}
              value={serialNumber}
              maxLength={120}
              onChange={(ev) => setSerialNumber(ev.target.value)}
              data-testid="hr-asset-serial"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`hr-asset-date-${employeeId}`}>{t('handedOverOnLabel')}</Label>
            <Input
              id={`hr-asset-date-${employeeId}`}
              type="date"
              className={PHONE_TARGET}
              value={handedOverOn}
              onChange={(ev) => setHandedOverOn(ev.target.value)}
              data-testid="hr-asset-date"
            />
          </div>
          <div className="space-y-1 sm:col-span-2 lg:col-span-3">
            <Label htmlFor={`hr-asset-notes-${employeeId}`}>{t('notesLabel')}</Label>
            <Input
              id={`hr-asset-notes-${employeeId}`}
              className={PHONE_TARGET}
              value={notes}
              maxLength={1000}
              onChange={(ev) => setNotes(ev.target.value)}
              data-testid="hr-asset-notes"
            />
          </div>
          <div className="flex items-end">
            <Button
              type="submit"
              size="sm"
              className={`w-full sm:w-auto ${PHONE_TARGET}`}
              loading={assignAsset.isPending}
              disabled={!canAssign}
              data-testid="hr-asset-assign-btn"
            >
              {t('assignBtn')}
            </Button>
          </div>
        </form>
      )}

      {(assignAsset.error || updateAssetStatus.error) && (
        <ErrorText>{errorMessage(assignAsset.error ?? updateAssetStatus.error)}</ErrorText>
      )}

      {listQ.isPending ? (
        <TableSkeleton columns={5} rows={2} />
      ) : listQ.error ? (
        <ErrorText>{errorMessage(listQ.error)}</ErrorText>
      ) : assets.length === 0 ? (
        <p className="text-sm text-subtle-foreground" data-testid="hr-assets-empty">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[540px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b text-subtle-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('colCode')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('colAsset')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('colHandedOver')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('colStatus')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('colActions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const returnDate = clearDateById[asset.id] ?? vietnamToday();
                return (
                  <tr key={asset.id} className="border-b last:border-b-0" data-testid="hr-asset-row">
                    <td className="py-2 pr-3 font-medium text-foreground">{asset.assetCode}</td>
                    <td className="py-2 pr-3">
                      <div className="font-medium text-foreground">{asset.assetName}</div>
                      {asset.serialNumber && <div className="text-subtle-foreground">SN: {asset.serialNumber}</div>}
                      {asset.notes && <div className="text-subtle-foreground">{asset.notes}</div>}
                    </td>
                    <td className="py-2 pr-3 text-subtle-foreground">
                      <div>{f.date(asset.handedOverOn)}</div>
                      {asset.returnedOn && (
                        <div>{t('returnedOnInline', { date: f.date(asset.returnedOn) })}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={ASSET_BADGE[asset.status]}>{t(`statuses.${asset.status}`)}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      {asset.status === 'assigned' && (
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <Input
                            type="date"
                            aria-label={t('returnDateAria')}
                            className={`h-8 w-36 text-xs ${PHONE_TARGET}`}
                            value={returnDate}
                            onChange={(ev) =>
                              setClearDateById((prev) => ({ ...prev, [asset.id]: ev.target.value }))
                            }
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className={PHONE_TARGET}
                            loading={
                              updateAssetStatus.isPending &&
                              updateAssetStatus.variables?.assetId === asset.id &&
                              updateAssetStatus.variables?.status === 'returned'
                            }
                            onClick={() =>
                              updateAssetStatus.mutate({
                                assetId: asset.id,
                                status: 'returned',
                                returnedOn: returnDate,
                              })
                            }
                            data-testid="hr-asset-return-btn"
                          >
                            {t('markReturnedBtn')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className={PHONE_TARGET}
                            loading={
                              updateAssetStatus.isPending &&
                              updateAssetStatus.variables?.assetId === asset.id &&
                              updateAssetStatus.variables?.status === 'lost_waived'
                            }
                            onClick={() =>
                              updateAssetStatus.mutate({
                                assetId: asset.id,
                                status: 'lost_waived',
                                returnedOn: null,
                              })
                            }
                            data-testid="hr-asset-waive-btn"
                          >
                            {t('markWaivedBtn')}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function HrSelfAssetsCard() {
  const t = useTranslations('hrMy.assets');
  const f = useFormat();
  const q = useQuery({
    ...orpc.hr.self.assets.list.queryOptions({ input: {} }),
    ...ONCE,
    gcTime: 0,
  });

  const items: readonly HrSelfAssetView[] = q.data ?? [];

  return (
    <Card className="mt-6 block space-y-3 p-4" data-testid="hr-my-assets">
      <div>
        <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
        <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
      </div>
      {q.isPending ? (
        <TableSkeleton columns={4} rows={2} />
      ) : q.error ? (
        <ErrorText>{errorMessage(q.error)}</ErrorText>
      ) : items.length === 0 ? (
        <p className="text-sm text-subtle-foreground" data-testid="hr-my-assets-empty">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[460px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b text-subtle-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('colCode')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('colAsset')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('colHandedOver')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('colStatus')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b last:border-b-0" data-testid="hr-my-asset-row">
                  <td className="py-2 pr-3 font-medium text-foreground">{item.assetCode}</td>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-foreground">{item.assetName}</div>
                    {item.serialNumber && <div className="text-subtle-foreground">SN: {item.serialNumber}</div>}
                  </td>
                  <td className="py-2 pr-3 text-subtle-foreground">
                    <div>{f.date(item.handedOverOn)}</div>
                    {item.returnedOn && (
                      <div>{t('returnedOnInline', { date: f.date(item.returnedOn) })}</div>
                    )}
                  </td>
                  <td className="py-2">
                    <Badge variant={ASSET_BADGE[item.status]}>{t(`statuses.${item.status}`)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

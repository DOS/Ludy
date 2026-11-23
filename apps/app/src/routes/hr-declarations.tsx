// SPDX-License-Identifier: AGPL-3.0-only
// "Bảng kê khai báo", the declaration lists of the HR app (#2533, payroll plan 6.5, ADR-0046): the D02-LT of a month, the figures of 05/KK-TNCN for a quarter, the data of 05/QTT-TNCN and of the
// 03/TNCN certificates for a year. The page shows the document the server built from approved pay runs; "Print or save as PDF" opens the browser's print dialog (the same way the payslip is
// a PDF), "Download xlsx" fetches the file from the authenticated export route. Nothing is filed or sent; every document says it is a list to declare from, its layout version and, while the
// accountant has not confirmed the plan rows it rests on, that it is a draft. Owners and admins only. Every read is a sensitive query that leaves an audit row and needs a second factor used in the last 5 minutes: the page reads on a click, never on its own.
import { useMutation } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { HR_DECLARATION_KINDS, hrDeclarationPeriodOk, vietnamToday, zHrDeclarationDocument, type HrDeclarationDocument, type HrDeclarationKind, type HrLaborCheckKind, type HrLaborCheckResult } from '@ludy/kernel-contract';
import { Alert } from '@ludy/ui/components/alert';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { DataTable, ErrorText, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, client, clientForOrg, errorMessage, getCurrentOrg, isStepUpRequired } from '../lib/api.ts';

export interface DeclarationSelection {
  orgSlug: string;
  kind: HrDeclarationKind;
  period: string;
}

export interface DeclarationRequestVars extends DeclarationSelection {
  requestId: number;
}

/** Rejects stale in-flight read responses when the active organization, declaration kind, period, or latest request token changed. */
export function isCurrentDeclarationRequest(
  vars: DeclarationRequestVars | undefined,
  current: DeclarationSelection,
  activeRequestId: number,
): boolean {
  if (!vars) return false;
  return (
    vars.requestId === activeRequestId &&
    vars.orgSlug === current.orgSlug &&
    vars.kind === current.kind &&
    vars.period === current.period
  );
}

const NUM = 'px-4 py-3 text-right tabular-nums';

const FINDING_CODE_KEYS = [
  'MISSING_IDENTITY_NUMBER',
  'MISSING_INSURANCE_NUMBER',
  'MISSING_BIRTH_DATE',
  'MISSING_ADDRESS',
  'UNWRITTEN_NONE_CONTRACT',
  'MISSING_CONTRACT_TERM',
  'MISSING_CONTRACT_START_DATE',
  'contract_expired',
  'contract_expiring_soon',
  'must_convert_to_indefinite',
  'probation_ending_soon',
  'final_fixed_term_renewal',
] as const;
type FindingCodeKey = (typeof FINDING_CODE_KEYS)[number];
const FINDING_CODE_SET: ReadonlySet<string> = new Set(FINDING_CODE_KEYS);
function isFindingCodeKey(code: string): code is FindingCodeKey {
  return FINDING_CODE_SET.has(code);
}

const FINDING_FIELD_KEYS = [
  'identityNumber',
  'insuranceNumber',
  'birthDate',
  'address',
  'contractTermMonths',
  'contractStartDate',
] as const;
type FindingFieldKey = (typeof FINDING_FIELD_KEYS)[number];
const FINDING_FIELD_SET: ReadonlySet<string> = new Set(FINDING_FIELD_KEYS);
function isFindingFieldKey(value: string): value is FindingFieldKey {
  return FINDING_FIELD_SET.has(value);
}

type Sheet = HrDeclarationDocument['sheets'][number];

function SheetTable({ sheet, noRows }: { sheet: Sheet; noRows: string }) {
  const f = useFormat();
  const numeric = sheet.columns.flatMap((c, i) => (c.kind === 'text' ? [] : [i]));
  const cell = (kind: Sheet['columns'][number]['kind'], value: string | undefined) => {
    const v = value ?? '';
    if (kind === 'money' && v !== '') return f.money(v, 'VND');
    return v;
  };
  return (
    <section className="mb-6" data-testid="hr-declaration-sheet">
      <h2 className="mb-2 text-base font-medium text-foreground">{sheet.title}</h2>
      {sheet.rows.length === 0 && !sheet.totals ? (
        <p className="text-sm text-muted-foreground">{noRows}</p>
      ) : (
        <DataTable head={sheet.columns.map((c) => c.header)} numeric={numeric}>
          {sheet.rows.map((row, i) => (
            <TableRow key={i}>
              {sheet.columns.map((c) => (
                <TableCell key={c.key} className={c.kind === 'text' ? 'px-4 py-3' : NUM}>
                  {cell(c.kind, row[c.key])}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {sheet.totals && (
            <TableRow className="font-medium">
              {sheet.columns.map((c) => (
                <TableCell key={c.key} className={c.kind === 'text' ? 'px-4 py-3' : NUM}>
                  {cell(c.kind, sheet.totals?.[c.key])}
                </TableCell>
              ))}
            </TableRow>
          )}
        </DataTable>
      )}
    </section>
  );
}

export function HrDeclarationsContent({ orgSlug }: { orgSlug: string }) {
  const t = useTranslations('hrDeclarations');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const today = vietnamToday();
  const [kind, setKind] = useState<HrDeclarationKind>('kk');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [asOf, setAsOf] = useState(today);
  const [year, setYear] = useState(today.slice(0, 4));
  const [quarter, setQuarter] = useState('1');
  const [reportHalf, setReportHalf] = useState<'H1' | 'H2' | 'annual'>('H1');
  const period =
    kind === 'd02lt'
      ? month
      : kind === 'kk'
        ? `${year}-Q${quarter}`
        : kind === 'labor_register'
          ? asOf
          : kind === '01pli'
            ? reportHalf === 'annual'
              ? year
              : `${year}-${reportHalf}`
            : year;
  const valid = hrDeclarationPeriodOk(kind, period);
  const isLaborExport = kind === 'labor_register' || kind === '01pli';
  // The document shown: read on a click (a sensitive read leaves an audit row), scoped to the active org, kind, and period so a loaded list never lingers across org switches or stale reads.
  const [doc, setDoc] = useState<{ orgSlug: string; period: string; kind: HrDeclarationKind; document: HrDeclarationDocument } | null>(null);
  const [checkState, setCheckState] = useState<{ orgSlug: string; period: string; kind: HrLaborCheckKind; result: HrLaborCheckResult } | null>(null);
  const currentSelection: DeclarationSelection = { orgSlug, kind, period };
  const selectionRef = useRef<DeclarationSelection>(currentSelection);
  selectionRef.current = currentSelection;
  const viewReqRef = useRef(0);
  const downloadReqRef = useRef(0);
  const laborCheckReqRef = useRef(0);
  const view = useMutation({
    // The same audited read as the download, as JSON: the server records the view (and so the print) with the same row as a file.
    mutationFn: async (vars: DeclarationRequestVars) =>
      zHrDeclarationDocument.parse(
        await (
          await apiFetch(
            `/api/payroll-export/${vars.kind}.json?period=${encodeURIComponent(vars.period)}`,
            vars.orgSlug ? { orgSlug: vars.orgSlug } : undefined,
          )
        ).json(),
      ),
    onSuccess: (document, vars) => {
      if (!isCurrentDeclarationRequest(vars, selectionRef.current, viewReqRef.current)) return;
      setDoc({ orgSlug: vars.orgSlug, period: vars.period, kind: vars.kind, document });
    },
  });
  const download = useMutation({
    mutationFn: async (vars: DeclarationRequestVars) => {
      const response = await apiFetch(
        `/api/payroll-export/${vars.kind}.xlsx?period=${encodeURIComponent(vars.period)}`,
        vars.orgSlug ? { orgSlug: vars.orgSlug } : undefined,
      );
      const blob = await response.blob();
      if (!isCurrentDeclarationRequest(vars, selectionRef.current, downloadReqRef.current)) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = t('downloadFile', { kind: vars.kind, period: vars.period });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const laborCheck = useMutation({
    mutationFn: (vars: Omit<DeclarationRequestVars, 'kind'> & { kind: HrLaborCheckKind; lang: 'vi' | 'en' }) =>
      (vars.orgSlug ? clientForOrg(vars.orgSlug) : client).hr.payroll.laborCheck({ kind: vars.kind, period: vars.period, lang: vars.lang }),
    onSuccess: (result, vars) => {
      if (!isCurrentDeclarationRequest(vars, selectionRef.current, laborCheckReqRef.current)) return;
      setCheckState({ orgSlug: vars.orgSlug, period: vars.period, kind: vars.kind, result });
    },
  });
  const prevOrgRef = useRef(orgSlug);
  const resetMutationsRef = useRef(() => {});
  resetMutationsRef.current = () => {
    view.reset();
    download.reset();
    laborCheck.reset();
  };
  useEffect(() => {
    if (prevOrgRef.current !== orgSlug) {
      prevOrgRef.current = orgSlug;
      setDoc(null);
      setCheckState(null);
      resetMutationsRef.current();
    }
    return () => {
      viewReqRef.current += 1;
      downloadReqRef.current += 1;
      laborCheckReqRef.current += 1;
    };
  }, [orgSlug]);
  const startView = () => {
    const requestId = (viewReqRef.current += 1);
    view.mutate({ orgSlug, kind, period, requestId });
  };
  const startDownload = () => {
    const requestId = (downloadReqRef.current += 1);
    download.mutate({ orgSlug, kind, period, requestId });
  };
  const startLaborCheck = () => {
    if (!isLaborExport) return;
    const requestId = (laborCheckReqRef.current += 1);
    laborCheck.mutate({ orgSlug, kind, period, lang, requestId });
  };
  // Opening everyone's identifiers needs a second factor used in the last 5 minutes: the prompt appears when the server asks, and the action that was refused runs again once it is verified.
  const viewPending = view.isPending && isCurrentDeclarationRequest(view.variables, currentSelection, viewReqRef.current);
  const downloadPending = download.isPending && isCurrentDeclarationRequest(download.variables, currentSelection, downloadReqRef.current);
  const laborCheckPending = isLaborExport && laborCheck.isPending && isCurrentDeclarationRequest(laborCheck.variables, currentSelection, laborCheckReqRef.current);
  const viewErrorForCurrent = view.error && isCurrentDeclarationRequest(view.variables, currentSelection, viewReqRef.current) ? view.error : null;
  const downloadErrorForCurrent = download.error && isCurrentDeclarationRequest(download.variables, currentSelection, downloadReqRef.current) ? download.error : null;
  const laborCheckErrorForCurrent =
    isLaborExport && laborCheck.error && isCurrentDeclarationRequest(laborCheck.variables, currentSelection, laborCheckReqRef.current) ? laborCheck.error : null;
  const stepUp = isStepUpRequired(viewErrorForCurrent) ? 'view' : isStepUpRequired(downloadErrorForCurrent) ? 'download' : null;
  const shown = doc && doc.orgSlug === orgSlug && doc.kind === kind && doc.period === period ? doc.document : null;
  const shownCheck = checkState && checkState.orgSlug === orgSlug && checkState.kind === kind && checkState.period === period ? checkState.result : null;
  return (
    <>
      <div className="print:hidden">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
      </div>
      <Card className="mb-6 block p-4 print:hidden" aria-label={t('kind')}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="hr-decl-kind">{t('kind')}</Label>
            <NativeSelect id="hr-decl-kind" value={kind} onChange={(e) => setKind(e.target.value as HrDeclarationKind)} data-testid="hr-decl-kind">
              {HR_DECLARATION_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`kinds.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {kind === 'd02lt' && (
            <div className="space-y-1">
              <Label htmlFor="hr-decl-month">{t('month')}</Label>
              <Input id="hr-decl-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </div>
          )}
          {kind === 'labor_register' && (
            <div className="space-y-1">
              <Label htmlFor="hr-decl-as-of">{t('asOf')}</Label>
              <Input id="hr-decl-as-of" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} data-testid="hr-decl-as-of" />
            </div>
          )}
          {kind === 'kk' && (
            <div className="space-y-1">
              <Label htmlFor="hr-decl-quarter">{t('quarter')}</Label>
              <NativeSelect id="hr-decl-quarter" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
                {['1', '2', '3', '4'].map((q) => (
                  <NativeSelectOption key={q} value={q}>
                    {t('quarterOption', { q })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {kind === '01pli' && (
            <div className="space-y-1">
              <Label htmlFor="hr-decl-half">{t('reportPeriod')}</Label>
              <NativeSelect id="hr-decl-half" value={reportHalf} onChange={(e) => setReportHalf(e.target.value as 'H1' | 'H2' | 'annual')} data-testid="hr-decl-half">
                {(['H1', 'H2', 'annual'] as const).map((h) => (
                  <NativeSelectOption key={h} value={h}>
                    {t(`reportPeriods.${h}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {kind !== 'd02lt' && kind !== 'labor_register' && (
            <div className="space-y-1">
              <Label htmlFor="hr-decl-year">{t('year')}</Label>
              <Input id="hr-decl-year" inputMode="numeric" maxLength={4} className="w-24" value={year} onChange={(e) => setYear(e.target.value)} />
            </div>
          )}
          <Button loading={viewPending} disabled={!valid} onClick={startView} data-testid="hr-decl-view">
            {t('view')}
          </Button>
          <Button variant="outline" loading={downloadPending} disabled={!valid} onClick={startDownload} data-testid="hr-decl-download">
            {t('download')}
          </Button>
          {isLaborExport && (
            <Button
              variant="outline"
              loading={laborCheckPending}
              disabled={!valid}
              onClick={startLaborCheck}
              data-testid="hr-decl-ly-check"
            >
              {t('lyCheck')}
            </Button>
          )}
          {shown && (
            <Button variant="outline" onClick={() => window.print()} data-testid="hr-decl-print">
              {t('print')}
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-subtle-foreground">{t('hint')}</p>
        {stepUp && (
          <StepUpPrompt
            action={t('stepUp')}
            onVerified={() => (stepUp === 'view' ? startView() : startDownload())}
            onCancel={() => {
              view.reset();
              download.reset();
            }}
          />
        )}
        {viewErrorForCurrent && !isStepUpRequired(viewErrorForCurrent) && <ErrorText>{errorMessage(viewErrorForCurrent)}</ErrorText>}
        {downloadErrorForCurrent && !isStepUpRequired(downloadErrorForCurrent) && <ErrorText>{errorMessage(downloadErrorForCurrent)}</ErrorText>}
        {laborCheckErrorForCurrent && <ErrorText>{errorMessage(laborCheckErrorForCurrent)}</ErrorText>}
      </Card>
      {shownCheck && (
        <Card className="mb-6 block p-4 print:hidden" data-testid="hr-decl-ly-result">
          <h2 className="mb-2 text-base font-medium text-foreground">{t('lyCheckTitle', { period })}</h2>
          <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-subtle-foreground">{t('lyCounts.checked')}</dt>
              <dd className="font-medium tabular-nums">{shownCheck.counts.checked}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('lyCounts.missingIdentity')}</dt>
              <dd className="font-medium tabular-nums">{shownCheck.counts.employeesMissingIdentity}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('lyCounts.missingInsurance')}</dt>
              <dd className="font-medium tabular-nums">{shownCheck.counts.employeesMissingInsuranceNumber}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('lyCounts.missingBirthDateOrAddress')}</dt>
              <dd className="font-medium tabular-nums">{shownCheck.counts.employeesMissingBirthDateOrAddress}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('lyCounts.unwrittenNoneContracts')}</dt>
              <dd className="font-medium tabular-nums">{shownCheck.counts.unwrittenNoneContracts}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('lyCounts.contractAlerts')}</dt>
              <dd className="font-medium tabular-nums">{shownCheck.counts.contractAlerts}</dd>
            </div>
          </dl>
          {shownCheck.summary && <p className="mb-2 text-sm text-foreground">{shownCheck.summary}</p>}
          {shownCheck.counts.checked > 0 && <p className="mb-2 text-xs text-muted-foreground">{t(`lyAiStatus.${shownCheck.ai.reason}`)}</p>}
          {shownCheck.notes.length > 0 && (
            <div className="mb-2">
              <p className="mb-1 text-xs font-medium text-foreground">{t('lyNotes')}</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {shownCheck.notes.map((n, i) => (
                  <li key={`${i}-${n}`}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {shownCheck.findings.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-foreground">{t('lyFindingsTitle', { count: shownCheck.findings.length })}</p>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {shownCheck.findings.map((f, i) => {
                  const label = isFindingCodeKey(f.code) ? t(`lyFindingCodes.${f.code}`) : f.code;
                  const detail = isFindingFieldKey(f.fieldOrRule) ? t(`lyFindingFields.${f.fieldOrRule}`) : f.fieldOrRule;
                  return (
                    <li key={`${f.employeeId}-${f.code}-${i}`}>
                      {f.employeeName ? `${f.employeeName}: ` : ''}
                      {label} ({detail})
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </Card>
      )}
      {shown && (
        <article className="declaration-sheet" data-testid="hr-declaration" aria-label={shown.title}>
          <h2 className="mb-1 text-lg font-semibold text-foreground" data-testid="hr-declaration-notice">
            {shown.notice}
          </h2>
          <p className="mb-1 text-base font-medium text-foreground">{shown.title}</p>
          <p className="mb-3 text-sm text-muted-foreground" data-testid="hr-declaration-layout">
            {t('layout')}: {shown.layout.form} | {shown.layout.version}
          </p>
          {shown.draft && (
            <Alert className="mb-3" data-testid="hr-declaration-draft">
              {shown.draft}
            </Alert>
          )}
          <p className="mb-3 text-sm text-muted-foreground">{shown.notSent}</p>
          <dl className="mb-6 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr] print:grid-cols-[max-content_1fr]">
            {shown.header.map((h) => (
              <div key={h.label} className="contents">
                <dt className="min-w-0 text-subtle-foreground">{h.label}</dt>
                <dd className="min-w-0 break-words">{h.value}</dd>
              </div>
            ))}
          </dl>
          {shown.sheets.map((sheet) => (
            <SheetTable key={sheet.name} sheet={sheet} noRows={t('noRows')} />
          ))}
          <section className="mb-6">
            <h2 className="mb-2 text-base font-medium text-foreground">{t('notes')}</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {shown.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </section>
        </article>
      )}
    </>
  );
}

export function HrDeclarationsPage() {
  const { slug = '' } = (useParams({ strict: false }) as { slug?: string } | undefined) ?? {};
  const orgSlug = slug || getCurrentOrg() || '';
  return <HrDeclarationsContent key={orgSlug} orgSlug={orgSlug} />;
}

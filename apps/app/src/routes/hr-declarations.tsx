// SPDX-License-Identifier: AGPL-3.0-only
// "Bảng kê khai báo", the declaration lists of the HR app (#2533, payroll plan 6.5, ADR-0046): the D02-LT of a month, the figures of 05/KK-TNCN for a quarter, the data of 05/QTT-TNCN and of the
// 03/TNCN certificates for a year. The page shows the document the server built from approved pay runs; "Print or save as PDF" opens the browser's print dialog (the same way the payslip is
// a PDF), "Download xlsx" fetches the file from the authenticated export route. Nothing is filed or sent; every document says it is a list to declare from, its layout version and, while the
// accountant has not confirmed the plan rows it rests on, that it is a draft. Owners and admins only. Every read is a sensitive query that leaves an audit row and needs a second factor used in the last 5 minutes: the page reads on a click, never on its own.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { HR_DECLARATION_KINDS, hrDeclarationPeriodOk, vietnamToday, zHrDeclarationDocument, type HrDeclarationDocument, type HrDeclarationKind, type HrLaborCheckKind, type HrLaborCheckResult } from '@crove/kernel-contract';
import { Alert } from '@crove/ui/components/alert';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { DataTable, ErrorText, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, client, errorMessage, isStepUpRequired } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';

const FINDING_CODE_KEYS = [
  'MISSING_IDENTITY_NUMBER',
  'MISSING_INSURANCE_NUMBER',
  'MISSING_BIRTH_DATE',
  'MISSING_ADDRESS',
  'UNWRITTEN_NONE_CONTRACT',
  'MISSING_CONTRACT_TERM',
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

export function HrDeclarationsPage() {
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
  // The document shown: read on a click (a sensitive read leaves an audit row), and dropped when the choice changes so a list is never shown under another period's name.
  const [doc, setDoc] = useState<{ period: string; kind: HrDeclarationKind; document: HrDeclarationDocument } | null>(null);
  const [checkState, setCheckState] = useState<{ period: string; kind: HrLaborCheckKind; result: HrLaborCheckResult } | null>(null);
  const view = useMutation({
    // The same audited read as the download, as JSON: the server records the view (and so the print) with the same row as a file.
    mutationFn: async (vars: { kind: HrDeclarationKind; period: string }) =>
      zHrDeclarationDocument.parse(await (await apiFetch(`/api/payroll-export/${vars.kind}.json?period=${encodeURIComponent(vars.period)}`)).json()),
    onSuccess: (document, vars) => setDoc({ period: vars.period, kind: vars.kind, document }),
  });
  const download = useMutation({
    mutationFn: async (vars: { kind: HrDeclarationKind; period: string }) => {
      const response = await apiFetch(`/api/payroll-export/${vars.kind}.xlsx?period=${encodeURIComponent(vars.period)}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('downloadFile', { kind: vars.kind, period: vars.period });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const laborCheck = useMutation({
    mutationFn: (vars: { kind: HrLaborCheckKind; period: string; lang: 'vi' | 'en' }) => client.hr.payroll.laborCheck(vars),
    onSuccess: (result, vars) => setCheckState({ period: vars.period, kind: vars.kind, result }),
  });
  // Opening everyone's identifiers needs a second factor used in the last 5 minutes: the prompt appears when the server asks, and the action that was refused runs again once it is verified.
  const stepUp = isStepUpRequired(view.error) ? 'view' : isStepUpRequired(download.error) ? 'download' : null;
  const shown = doc && doc.kind === kind && doc.period === period ? doc.document : null;
  const shownCheck = checkState && checkState.kind === kind && checkState.period === period ? checkState.result : null;
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
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
          <Button loading={view.isPending} disabled={!valid} onClick={() => view.mutate({ kind, period })} data-testid="hr-decl-view">
            {t('view')}
          </Button>
          <Button variant="outline" loading={download.isPending} disabled={!valid} onClick={() => download.mutate({ kind, period })} data-testid="hr-decl-download">
            {t('download')}
          </Button>
          {isLaborExport && (
            <Button
              variant="outline"
              loading={laborCheck.isPending}
              disabled={!valid}
              onClick={() => laborCheck.mutate({ kind: kind as HrLaborCheckKind, period, lang })}
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
            onVerified={() =>
              stepUp === 'view'
                ? view.mutate(view.variables ?? { kind, period })
                : download.mutate(download.variables ?? { kind, period })
            }
            onCancel={() => {
              view.reset();
              download.reset();
            }}
          />
        )}
        {view.error && !isStepUpRequired(view.error) && <ErrorText>{errorMessage(view.error)}</ErrorText>}
        {download.error && !isStepUpRequired(download.error) && <ErrorText>{errorMessage(download.error)}</ErrorText>}
        {isLaborExport && laborCheck.error && <ErrorText>{errorMessage(laborCheck.error)}</ErrorText>}
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
                  return (
                    <li key={`${f.employeeId}-${f.code}-${i}`}>
                      {f.employeeName ? `${f.employeeName}: ` : ''}
                      {label} ({f.fieldOrRule})
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </Card>
      )}
      {shown && (
        <article data-testid="hr-declaration" aria-label={shown.title}>
          <h2 className="mb-1 text-lg font-semibold uppercase tracking-tight text-foreground" data-testid="hr-declaration-notice">
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
          <dl className="mb-6 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            {shown.header.map((h) => (
              <div key={h.label} className="contents">
                <dt className="text-subtle-foreground">{h.label}</dt>
                <dd>{h.value}</dd>
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

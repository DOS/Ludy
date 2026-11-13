// SPDX-License-Identifier: AGPL-3.0-only
// "Bảng lương", the monthly pay run of the HR app (#2531, payroll plan 6.2 and 6.3, ADR-0046): the months, the month's sheet with each person's breakdown and the employer's total cost,
// the month's inputs, the approval (R3: a fresh second factor; refused while a rule used is still `commentary`), a correction of an approved month as an adjustment line, and the payslip
// of Labor Code Art. 95(3), a view of the stored line that the person prints or saves as a PDF. Owners and admins only. Every read is a sensitive query that leaves an audit row, so the
// screen asks once and again only after its own change. The sheet, the payslips and the flags (deterministic checks) work with AI off; the finance coworker's part (#2534: prepare, flag, explain)
// is a button a person presses, read-only, and shows nothing but the sheet when the model is off, busy, out of budget or refused.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { money, toMoney, type PayrollBreakdown } from '@crove/l10n-vn';
import { HR_ALLOWANCE_TYPES, HR_DEDUCTION_KINDS, HR_INSURANCE_FUNDS, HR_OVERTIME_DAY_KINDS, PAYROLL_PAYMENT_KINDS, vietnamToday, type HrLineView, type HrPayrollInputs, type HrPayslip, type HrRuleView, type HrRunSheet } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { BankSelect } from '../components/bank-select.tsx';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { cashAccountChoices } from '../lib/vouchers.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });
// A sensitive read leaves an audit row each time: the screen reads once and again only after its own change.
const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const NUM = 'px-4 py-3 text-right tabular-nums';
const amountOk = (v: string) => /^\d{1,16}(\.\d{1,2})?$/.test(v);
const signedOk = (v: string) => /^-?\d{1,16}(\.\d{1,2})?$/.test(v);

type Money = (value: string | null | undefined, currency?: string) => string;

// The inputs of a line as the form edits them: every field a string, so a half-typed number is not lost.
interface InputsState {
  unpaidLeaveDays: string;
  daysNotEmployed: string;
  bonus: string;
  advance: string;
  nightHours: string;
  contractTermMonths: string;
  overtime: { dayKind: (typeof HR_OVERTIME_DAY_KINDS)[number]; night: boolean; hours: string }[];
  allowances: { label: string; amount: string; type: (typeof HR_ALLOWANCE_TYPES)[number]; namedInContract: boolean }[];
  deductions: { label: string; kind: (typeof HR_DEDUCTION_KINDS)[number]; amount: string }[];
  // What the form does not edit is kept as stored.
  rest: Record<string, unknown>;
}

const str = (v: unknown, fallback = '0') => (typeof v === 'string' ? v : fallback);
function stateOf(inputs: Record<string, unknown>): InputsState {
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    unpaidLeaveDays: str(inputs.unpaidLeaveDays),
    daysNotEmployed: str(inputs.daysNotEmployed),
    bonus: str(inputs.bonus),
    advance: str(inputs.advance),
    nightHours: str(inputs.nightHours),
    contractTermMonths: typeof inputs.contractTermMonths === 'number' ? String(inputs.contractTermMonths) : '',
    overtime: list<InputsState['overtime'][number]>(inputs.overtime),
    allowances: list<InputsState['allowances'][number]>(inputs.allowances),
    deductions: list<InputsState['deductions'][number]>(inputs.deductions),
    rest: { otherRegularPay: inputs.otherRegularPay, voluntaryPension: inputs.voluntaryPension, commitment: inputs.commitment, insured: inputs.insured, withholdingRequested: inputs.withholdingRequested },
  };
}
const inputsOf = (s: InputsState): HrPayrollInputs =>
  ({
    ...s.rest,
    unpaidLeaveDays: s.unpaidLeaveDays,
    daysNotEmployed: s.daysNotEmployed,
    bonus: s.bonus,
    advance: s.advance,
    nightHours: s.nightHours,
    contractTermMonths: s.contractTermMonths === '' ? null : Number(s.contractTermMonths),
    overtime: s.overtime,
    allowances: s.allowances,
    deductions: s.deductions,
  }) as HrPayrollInputs;
const dayOk = (v: string) => /^\d{1,2}(\.\d)?$/.test(v);
const hoursOk = (v: string) => /^\d{1,3}(\.\d{1,2})?$/.test(v);
const formOk = (s: InputsState) =>
  dayOk(s.unpaidLeaveDays) && dayOk(s.daysNotEmployed) && amountOk(s.bonus) && amountOk(s.advance) && hoursOk(s.nightHours) && (s.contractTermMonths === '' || /^\d{1,2}$/.test(s.contractTermMonths)) &&
  s.overtime.every((o) => hoursOk(o.hours)) && s.allowances.every((a) => a.label.trim() !== '' && amountOk(a.amount)) && s.deductions.every((d) => d.label.trim() !== '' && amountOk(d.amount));

function Breakdown({ line, money }: { line: HrLineView; money: Money }) {
  const t = useTranslations('hrPayroll');
  const b = line.breakdown as unknown as PayrollBreakdown | null;
  if (!b) return <p className="text-sm text-muted-foreground">{line.refusal ?? t('noBreakdown')}</p>;
  const row = (label: string, value: string, key: string) => (
    <div key={key} className="flex justify-between gap-4 py-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{money(value, 'VND')}</dd>
    </div>
  );
  const f = line.figures;
  return (
    <dl className="grid gap-x-8 text-sm sm:grid-cols-2" data-testid="hr-breakdown">
      <div>
        <h4 className="mb-1 font-medium text-foreground">{t('bd.pay')}</h4>
        {row(t('bd.baseWage'), b.pay.baseWage, 'base')}
        {b.pay.allowances.map((a, i) => row(a.label, a.paid, `a${i}`))}
        {b.pay.overtime.map((o, i) => row(t('bd.overtime', { kind: t(`dayKind.${o.dayKind}`), hours: o.hours }), o.pay, `o${i}`))}
        {b.pay.nightWork && row(t('bd.night', { hours: b.pay.nightWork.hours }), b.pay.nightWork.pay, 'night')}
        {row(t('bd.bonus'), b.pay.bonus, 'bonus')}
        {row(t('bd.unpaidReduction'), b.pay.unpaidReduction, 'unpaid')}
      </div>
      <div>
        <h4 className="mb-1 font-medium text-foreground">{t('bd.deductions')}</h4>
        {b.insurance.funds.map((fund) => row(t(`fund.${fund.fund}`), fund.employee, fund.fund))}
        {row(t('bd.pit'), f?.pit ?? '0', 'pit')}
        {row(t('bd.advance'), b.deductions.advance, 'advance')}
        {row(t('bd.damage'), b.deductions.damage, 'damage')}
        {row(t('bd.other'), b.deductions.other, 'other')}
        <h4 className="mb-1 mt-3 font-medium text-foreground">{t('bd.employer')}</h4>
        {row(t('employerInsurance'), f?.employerInsurance ?? '0', 'ei')}
        {row(t('unionFee'), f?.unionFee ?? '0', 'union')}
      </div>
    </dl>
  );
}

function InputsForm({ line, onDone }: { line: HrLineView; onDone: () => void }) {
  const t = useTranslations('hrPayroll');
  const [s, setS] = useState(() => stateOf(line.inputs));
  const save = useMutation({
    mutationFn: () => client.hr.payroll.lines.setInputs({ lineId: line.id, inputs: inputsOf(s) }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const text = (key: 'unpaidLeaveDays' | 'daysNotEmployed' | 'bonus' | 'advance' | 'nightHours' | 'contractTermMonths', label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`in-${line.id}-${key}`}>{label}</Label>
      <Input id={`in-${line.id}-${key}`} value={s[key]} inputMode="decimal" onChange={(e) => setS({ ...s, [key]: e.target.value.replace(/[^\d.]/g, '') })} />
    </div>
  );
  return (
    <div className="mt-3 space-y-3 border-t pt-3" data-testid="hr-inputs-form">
      <div className="grid gap-3 sm:grid-cols-3">
        {text('unpaidLeaveDays', t('in.unpaidLeaveDays'))}
        {text('daysNotEmployed', t('in.daysNotEmployed'))}
        {text('bonus', t('in.bonus'))}
        {text('advance', t('in.advance'))}
        {text('nightHours', t('in.nightHours'))}
        {text('contractTermMonths', t('in.contractTermMonths'))}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('in.overtime')}</legend>
        {s.overtime.map((o, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <NativeSelect aria-label={t('in.dayKind')} value={o.dayKind} onChange={(e) => setS({ ...s, overtime: s.overtime.map((x, j) => (j === i ? { ...x, dayKind: e.target.value as typeof o.dayKind } : x)) })}>
              {HR_OVERTIME_DAY_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`dayKind.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={o.night} onChange={(e) => setS({ ...s, overtime: s.overtime.map((x, j) => (j === i ? { ...x, night: e.target.checked } : x)) })} />
              {t('in.night')}
            </label>
            <Input aria-label={t('in.hours')} className="w-24" value={o.hours} inputMode="decimal" onChange={(e) => setS({ ...s, overtime: s.overtime.map((x, j) => (j === i ? { ...x, hours: e.target.value.replace(/[^\d.]/g, '') } : x)) })} />
            <Button variant="ghost" size="sm" onClick={() => setS({ ...s, overtime: s.overtime.filter((_, j) => j !== i) })}>
              {t('remove')}
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setS({ ...s, overtime: [...s.overtime, { dayKind: 'normal_day', night: false, hours: '0' }] })}>
          {t('in.addOvertime')}
        </Button>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('in.allowances')}</legend>
        {s.allowances.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label={t('in.label')} className="w-40" value={a.label} maxLength={100} onChange={(e) => setS({ ...s, allowances: s.allowances.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <Input aria-label={t('in.amount')} className="w-32" value={a.amount} inputMode="decimal" onChange={(e) => setS({ ...s, allowances: s.allowances.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^\d.]/g, '') } : x)) })} />
            <NativeSelect aria-label={t('in.allowanceType')} value={a.type} onChange={(e) => setS({ ...s, allowances: s.allowances.map((x, j) => (j === i ? { ...x, type: e.target.value as typeof a.type } : x)) })}>
              {HR_ALLOWANCE_TYPES.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`allowanceType.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={a.namedInContract} onChange={(e) => setS({ ...s, allowances: s.allowances.map((x, j) => (j === i ? { ...x, namedInContract: e.target.checked } : x)) })} />
              {t('in.named')}
            </label>
            <Button variant="ghost" size="sm" onClick={() => setS({ ...s, allowances: s.allowances.filter((_, j) => j !== i) })}>
              {t('remove')}
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setS({ ...s, allowances: [...s.allowances, { label: '', amount: '0', type: 'other', namedInContract: false }] })}>
          {t('in.addAllowance')}
        </Button>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('in.deductions')}</legend>
        {s.deductions.map((d, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label={t('in.label')} className="w-40" value={d.label} maxLength={100} onChange={(e) => setS({ ...s, deductions: s.deductions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <Input aria-label={t('in.amount')} className="w-32" value={d.amount} inputMode="decimal" onChange={(e) => setS({ ...s, deductions: s.deductions.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^\d.]/g, '') } : x)) })} />
            <NativeSelect aria-label={t('in.deductionKind')} value={d.kind} onChange={(e) => setS({ ...s, deductions: s.deductions.map((x, j) => (j === i ? { ...x, kind: e.target.value as typeof d.kind } : x)) })}>
              {HR_DEDUCTION_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`deductionKind.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button variant="ghost" size="sm" onClick={() => setS({ ...s, deductions: s.deductions.filter((_, j) => j !== i) })}>
              {t('remove')}
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setS({ ...s, deductions: [...s.deductions, { label: '', kind: 'other', amount: '0' }] })}>
          {t('in.addDeduction')}
        </Button>
      </fieldset>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <div className="flex gap-2">
        <Button loading={save.isPending} disabled={!formOk(s)} onClick={() => save.mutate()} data-testid="hr-inputs-save">
          {t('saveInputs')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

// The coworker's states with no text: a notice, never an error and never a gap in the sheet.
function CoworkerNotice({ state }: { state: 'used' | 'off' | 'busy' | 'budget' | 'failed' | 'quiet' }) {
  const t = useTranslations('hrPayroll');
  if (state === 'used') return null;
  return (
    <p className="text-xs text-subtle-foreground" data-testid="hr-coworker-state">
      {t(`coworker.state.${state}`)}
    </p>
  );
}

// "Explain" for one payslip: asked on a press (a model call costs), from the stored components only; its text is shown beside the payslip and never printed.
function ExplainPayslip({ lineId }: { lineId: string }) {
  const t = useTranslations('hrPayroll');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const explain = useMutation({ mutationFn: () => client.hr.payroll.coworker.explain({ lineId, lang }) });
  return (
    <div className="mt-4 print:hidden">
      <Button variant="outline" size="sm" onClick={() => explain.mutate()} disabled={explain.isPending} data-testid="hr-explain">
        {explain.isPending ? t('coworker.asking') : t('coworker.explain')}
      </Button>
      {explain.error && <ErrorText>{errorMessage(explain.error)}</ErrorText>}
      {explain.data && <CoworkerNotice state={explain.data.ai} />}
      {explain.data?.ai === 'used' && explain.data.text && (
        <div className="mt-2 rounded-md border p-3" data-testid="hr-explanation">
          <p className="text-xs font-medium text-muted-foreground">{t('coworker.explainTitle')}</p>
          <p className="mt-1 text-sm">{explain.data.text}</p>
          <p className="mt-2 text-xs text-subtle-foreground">{t('coworker.note')}</p>
        </div>
      )}
    </div>
  );
}

// The coworker's look at a draft month: what probably changes, and each anomaly code found in a sentence. Proposals only: a person edits the inputs by hand.
function MonthCoworker({ runId }: { runId: string }) {
  const t = useTranslations('hrPayroll');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const ask = useMutation({
    mutationFn: async () => {
      const [prepared, flagged] = await Promise.all([client.hr.payroll.coworker.prepare({ runId, lang }), client.hr.payroll.coworker.flag({ runId, lang })]);
      return { prepared, flagged };
    },
  });
  const prepared = ask.data?.prepared;
  const flagged = ask.data?.flagged;
  return (
    <Card className="mb-4 block p-4" data-testid="hr-coworker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('coworker.title')}</p>
        <Button variant="outline" size="sm" onClick={() => ask.mutate()} disabled={ask.isPending} data-testid="hr-coworker-ask">
          {ask.isPending ? t('coworker.asking') : t('coworker.ask')}
        </Button>
      </div>
      {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
      {/* What code found is listed in every state: with AI off, busy, out of budget or refused it is the facts alone; the coworker's sentence is added only when it passed the checks. */}
      {prepared && prepared.ai !== 'used' && <CoworkerNotice state={prepared.ai} />}
      {prepared && prepared.items.length > 0 && (
        <div className="mt-3" data-testid="hr-coworker-prepare">
          <p className="text-xs font-medium text-muted-foreground">{t('coworker.prepareTitle')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {prepared.items.map((i) => (
              <li key={i.id} data-testid="hr-coworker-finding">
                {i.facts}
                {i.text && (
                  <span className="block text-muted-foreground" data-testid="hr-coworker-sentence">
                    {i.text} {i.field && <span className="text-xs text-subtle-foreground">({t(`coworker.field.${i.field}`)})</span>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {flagged && flagged.items.length > 0 && (
        <div className="mt-3" data-testid="hr-coworker-flag">
          <p className="text-xs font-medium text-muted-foreground">{t('coworker.flagTitle')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {flagged.items.map((i) => (
              <li key={i.id} data-testid="hr-coworker-finding">
                {i.facts}
                {i.text && (
                  <span className="block text-muted-foreground" data-testid="hr-coworker-sentence">
                    {i.text}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(prepared?.ai === 'used' || flagged?.ai === 'used') && <p className="mt-2 text-xs text-subtle-foreground">{t('coworker.note')}</p>}
    </Card>
  );
}

// The payslip of Labor Code Art. 95(3): only stored facts. "Print" opens the browser's print dialog, where the person saves it as a PDF; nothing is emailed.
function Payslip({ lineId, onClose }: { lineId: string; onClose: () => void }) {
  const t = useTranslations('hrPayroll');
  const f = useFormat();
  const q = useQuery({ ...orpc.hr.payroll.lines.payslip.queryOptions({ input: { lineId } }), ...ONCE });
  if (q.isPending) return <TableSkeleton columns={2} rows={4} />;
  if (q.error) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const p: HrPayslip = q.data;
  const b = p.breakdown as unknown as PayrollBreakdown;
  const line = (label: string, value: string, key: string) => (
    <tr key={key}>
      <td className="py-1 pr-6">{label}</td>
      <td className="py-1 text-right tabular-nums">{f.money(value, 'VND')}</td>
    </tr>
  );
  return (
    <Card className="mb-6 block p-6 print:border-0 print:shadow-none" aria-label={t('payslip')} data-testid="hr-payslip">
      <div className="mb-3 flex items-start justify-between gap-3 print:hidden">
        <h2 className="text-base font-medium">{t('payslip')}</h2>
        <div className="flex gap-2">
          <Button onClick={() => window.print()} data-testid="hr-payslip-print">
            {t('printPayslip')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </div>
      <p className="text-lg font-semibold">{p.employerName}</p>
      <p className="text-sm text-muted-foreground">{t('payslipPeriod', { month: p.month })}</p>
      <p className="mt-2 text-sm">{t('payslipFor', { name: p.employeeName })}</p>
      {p.status === 'draft' && <p className="mt-2 text-xs text-subtle-foreground print:hidden">{t('payslipDraft')}</p>}
      <table className="mt-4 w-full text-sm">
        <tbody>
          {line(t('bd.baseWage'), b.pay.baseWage, 'base')}
          {b.pay.allowances.map((a, i) => line(a.label, a.paid, `a${i}`))}
          {b.pay.overtime.map((o, i) => line(t('bd.overtime', { kind: t(`dayKind.${o.dayKind}`), hours: o.hours }), o.pay, `o${i}`))}
          {b.pay.nightWork && line(t('bd.night', { hours: b.pay.nightWork.hours }), b.pay.nightWork.pay, 'night')}
          {line(t('bd.bonus'), b.pay.bonus, 'bonus')}
          {line(t('gross'), p.figures.gross, 'gross')}
          {b.insurance.funds.map((fund) => line(t(`fund.${fund.fund}`), fund.employee, fund.fund))}
          {line(t('bd.pit'), p.figures.pit, 'pit')}
          {line(t('bd.advance'), b.deductions.advance, 'advance')}
          {line(t('bd.damage'), b.deductions.damage, 'damage')}
          {line(t('bd.other'), b.deductions.other, 'other')}
          <tr className="border-t font-semibold">
            <td className="py-2 pr-6">{t('net')}</td>
            <td className="py-2 text-right tabular-nums">{f.money(p.figures.net, 'VND')}</td>
          </tr>
        </tbody>
      </table>
      <ExplainPayslip lineId={lineId} />
    </Card>
  );
}

function BlockingRules({ rules }: { rules: readonly HrRuleView[] }) {
  const t = useTranslations('hrPayroll');
  return (
    <Card className="mb-4 block border-destructive/30 bg-destructive/10 p-4" role="alert" data-testid="hr-blocking">
      <h2 className="text-sm font-medium text-foreground">{t('blockingTitle', { count: String(rules.length) })}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('blockingHint')}</p>
      <ul className="mt-2 space-y-1 text-xs">
        {rules.map((r) => (
          <li key={r.id}>
            <span className="font-mono">{r.id}</span> <Badge variant="secondary">{t(`confidence.${r.confidence}`)}</Badge> <span className="text-muted-foreground">{r.cite}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AdjustForm({ sheet, approvedRuns, onClose }: { sheet: HrRunSheet; approvedRuns: readonly { id: string; month: string }[]; onClose: () => void }) {
  const t = useTranslations('hrPayroll');
  const [runId, setRunId] = useState(approvedRuns[0]?.id ?? '');
  const [employeeId, setEmployeeId] = useState(sheet.lines.find((l) => l.kind === 'pay')?.employeeId ?? '');
  const [note, setNote] = useState('');
  const [gross, setGross] = useState('');
  const [pit, setPit] = useState('0');
  // The insurance of the difference, split across the funds as typed (the employee's part and the employer's part of each): the totals the server checks are the sums of what is typed here.
  const [split, setSplit] = useState<Record<(typeof HR_INSURANCE_FUNDS)[number], { employee: string; employer: string }>>(() =>
    Object.fromEntries(HR_INSURANCE_FUNDS.map((fund) => [fund, { employee: '0', employer: '0' }])) as Record<(typeof HR_INSURANCE_FUNDS)[number], { employee: string; employer: string }>,
  );
  const splitOk = HR_INSURANCE_FUNDS.every((fund) => signedOk(split[fund].employee) && signedOk(split[fund].employer));
  const sumOf = (pick: 'employee' | 'employer') => (splitOk ? toMoney(HR_INSURANCE_FUNDS.reduce((acc, fund) => acc.plus(money(split[fund][pick])), money(0))) : '0');
  const people = sheet.lines.filter((l) => l.kind === 'pay');
  const save = useMutation({
    mutationFn: () =>
      client.hr.payroll.lines.adjust({
        runId: sheet.run.id,
        adjustsRunId: runId,
        employeeId,
        note: note.trim(),
        gross,
        pit,
        employeeInsurance: sumOf('employee'),
        employerInsurance: sumOf('employer'),
        // A fund left at zero is not sent: the server holds the split of what is typed, each fund once.
        funds: HR_INSURANCE_FUNDS.filter((fund) => !money(split[fund].employee).isZero() || !money(split[fund].employer).isZero()).map((fund) => ({ fund, employee: toMoney(money(split[fund].employee)), employer: toMoney(money(split[fund].employer)) })),
      }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  return (
    <Card className="mb-4 block p-4" aria-label={t('adjustTitle')} data-testid="hr-adjust-form">
      <h2 className="text-base font-medium">{t('adjustTitle')}</h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('adjustHint')}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="adj-run">{t('adjustRun')}</Label>
          <NativeSelect id="adj-run" value={runId} onChange={(e) => setRunId(e.target.value)}>
            {approvedRuns.map((r) => (
              <NativeSelectOption key={r.id} value={r.id}>
                {r.month}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="adj-employee">{t('employee')}</Label>
          <NativeSelect id="adj-employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {people.map((l) => (
              <NativeSelectOption key={l.employeeId} value={l.employeeId}>
                {l.employeeName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="adj-gross">{t('adjustGross')}</Label>
          <Input id="adj-gross" value={gross} inputMode="decimal" onChange={(e) => setGross(e.target.value.replace(/[^\d.-]/g, ''))} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="adj-pit">{t('adjustPit')}</Label>
          <Input id="adj-pit" value={pit} inputMode="decimal" onChange={(e) => setPit(e.target.value.replace(/[^\d.-]/g, ''))} />
        </div>
        <fieldset className="space-y-2 sm:col-span-3" data-testid="hr-adjust-funds">
          <legend className="text-sm font-medium">{t('adjustFunds')}</legend>
          <p className="text-xs text-subtle-foreground">{t('adjustFundsHint')}</p>
          {HR_INSURANCE_FUNDS.map((fund) => (
            <div key={fund} className="grid items-end gap-2 sm:grid-cols-[1fr_10rem_10rem]">
              <span className="text-sm">{t(`fund.${fund}`)}</span>
              <div className="space-y-1">
                <Label htmlFor={`adj-${fund}-employee`} className="text-xs">
                  {t('adjustFundEmployee')}
                </Label>
                <Input id={`adj-${fund}-employee`} value={split[fund].employee} inputMode="decimal" onChange={(e) => setSplit({ ...split, [fund]: { ...split[fund], employee: e.target.value.replace(/[^\d.-]/g, '') } })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`adj-${fund}-employer`} className="text-xs">
                  {t('adjustFundEmployer')}
                </Label>
                <Input id={`adj-${fund}-employer`} value={split[fund].employer} inputMode="decimal" onChange={(e) => setSplit({ ...split, [fund]: { ...split[fund], employer: e.target.value.replace(/[^\d.-]/g, '') } })} />
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground" data-testid="hr-adjust-funds-total">
            {t('adjustFundsTotal', { employee: sumOf('employee'), employer: sumOf('employer') })}
          </p>
        </fieldset>
        <div className="space-y-1 sm:col-span-3">
          <Label htmlFor="adj-note">{t('adjustNote')}</Label>
          <Input id="adj-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <div className="mt-3 flex gap-2">
        <Button loading={save.isPending} disabled={runId === '' || employeeId === '' || note.trim() === '' || ![gross, pit].every(signedOk) || !splitOk} onClick={() => save.mutate()} data-testid="hr-adjust-save">
          {t('adjustSave')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </Card>
  );
}

// The posting and the payments of an approved month (#2532), asked for from the month itself: the posting first (one entry for the whole month, built by the server from the frozen run), then
// the net pay and each remittance once it is posted. Each is a proposal that an owner or an admin approves in the Inbox with a fresh second factor; nothing here posts, and Ludy never makes a
// transfer: a payment voucher records one that was made. The card reads where each step stands (finance, from the books and the open proposals: no name, no amount) and offers only the next step.
function SettlementPayment({ runId, kind, step, canAsk }: { runId: string; kind: (typeof PAYROLL_PAYMENT_KINDS)[number]; step: { status: 'none' | 'pending' | 'recorded'; proposalId: string | null }; canAsk: boolean }) {
  const t = useTranslations('hrPayroll');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'cash_payment' | 'bank_debit'>('bank_debit');
  const [date, setDate] = useState(() => vietnamToday());
  const [account, setAccount] = useState('');
  // One key per request, renewed once it succeeds: a retry returns the same proposal, but a new request after the approver rejected the first one must not replay it.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const choices = cashAccountChoices(accounts.data ?? [], type);
  const cash = choices.some((a) => a.code === account) ? account : (choices[0]?.code ?? '');
  const ask = useMutation({
    mutationFn: () => client.inbox.request({ command: 'finance.payroll_payment.record', idempotencyKey, input: { runId, kind, type, date, cashAccount: cash } }),
    onSuccess: () => {
      setOpen(false);
      setIdempotencyKey(crypto.randomUUID());
    },
    onSettled: () => void queryClient.invalidateQueries(),
  });
  return (
    <li className="py-3" data-testid={`hr-settle-pay-${kind}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t(`payKind.${kind}`)}</span>
        {step.status === 'recorded' && <Badge variant="outline" data-testid={`hr-settle-pay-${kind}-state`}>{t('payRecorded')}</Badge>}
        {step.status === 'pending' && step.proposalId && (
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: step.proposalId }} className="text-sm text-link underline" data-testid={`hr-settle-pay-${kind}-state`}>
            {t('payPending')}
          </Link>
        )}
        {step.status === 'none' && canAsk && !open && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`hr-settle-pay-${kind}-open`}>
            {t('payAsk')}
          </Button>
        )}
      </div>
      {step.status === 'none' && canAsk && open && (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          data-testid={`hr-settle-pay-${kind}-form`}
          onSubmit={(e) => {
            e.preventDefault();
            if (cash !== '' && date !== '' && !ask.isPending) ask.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={`pay-type-${kind}`}>{t('payType')}</Label>
            <NativeSelect id={`pay-type-${kind}`} value={type} onChange={(e) => setType(e.target.value as 'cash_payment' | 'bank_debit')}>
              <NativeSelectOption value="bank_debit">{t('payTypeBank')}</NativeSelectOption>
              <NativeSelectOption value="cash_payment">{t('payTypeCash')}</NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`pay-account-${kind}`}>{t('payAccount')}</Label>
            <NativeSelect id={`pay-account-${kind}`} value={cash} onChange={(e) => setAccount(e.target.value)}>
              {choices.map((a) => (
                <NativeSelectOption key={a.code} value={a.code}>
                  {a.code} {a.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`pay-date-${kind}`}>{t('payDate')}</Label>
            <Input id={`pay-date-${kind}`} type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <Button type="submit" size="sm" loading={ask.isPending} disabled={cash === '' || date === ''} data-testid={`hr-settle-pay-${kind}-submit`}>
            {t('paySubmit')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t('payCancel')}
          </Button>
        </form>
      )}
      {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
    </li>
  );
}

function Settlement({ runId }: { runId: string }) {
  const t = useTranslations('hrPayroll');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const state = useQuery(orpc.hr.payroll.settlement.queryOptions({ input: { runId } }));
  // One key per request, renewed once it succeeds (see SettlementPayment).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const post = useMutation({
    mutationFn: () => client.inbox.request({ command: 'finance.payroll_posting.record', idempotencyKey, input: { runId } }),
    onSuccess: () => setIdempotencyKey(crypto.randomUUID()),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const s = state.data;
  return (
    <Card className="mt-6 block p-4 print:hidden" aria-label={t('settleTitle')} data-testid="hr-settlement">
      <h3 className="mb-1 text-sm font-semibold">{t('settleTitle')}</h3>
      <p className="mb-3 text-sm text-muted-foreground">{t('settleHint')}</p>
      {state.error && <ErrorText>{errorMessage(state.error)}</ErrorText>}
      {s && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2" data-testid="hr-settle-posting">
            <span className="text-sm font-medium">{t('settlePosting')}</span>
            {s.posting.status === 'posted' && <Badge variant="outline" data-testid="hr-settle-posting-state">{t('settlePosted')}</Badge>}
            {s.posting.status === 'reversed' && <Badge variant="outline" data-testid="hr-settle-posting-state">{t('settleReversed')}</Badge>}
            {s.posting.status === 'pending' && s.posting.proposalId && (
              <Link to="/o/$slug/inbox/$id" params={{ slug, id: s.posting.proposalId }} className="text-sm text-link underline" data-testid="hr-settle-posting-state">
                {t('settlePending')}
              </Link>
            )}
            {(s.posting.status === 'none' || s.posting.status === 'reversed') && (
              <Button variant="outline" size="sm" loading={post.isPending} onClick={() => post.mutate()} data-testid="hr-settle-post">
                {t('settlePost')}
              </Button>
            )}
          </div>
          {post.error && <ErrorText>{errorMessage(post.error)}</ErrorText>}
          {s.posting.status === 'reversed' && <p className="mt-2 text-sm text-muted-foreground">{t('settleReversedNote')}</p>}
          {s.posting.status === 'posted' || (s.posting.status === 'reversed' && PAYROLL_PAYMENT_KINDS.some((k) => s.payments[k].status !== 'none')) ? (
            <ul className="mt-3 divide-y border-t" data-testid="hr-settle-payments">
              {PAYROLL_PAYMENT_KINDS.map((kind) => (
                <SettlementPayment key={kind} runId={runId} kind={kind} step={s.payments[kind]} canAsk={s.posting.status === 'posted'} />
              ))}
            </ul>
          ) : (
            s.posting.status !== 'reversed' && <p className="mt-2 text-sm text-muted-foreground">{t('settlePayAfterPosting')}</p>
          )}
        </>
      )}
    </Card>
  );
}

// The bank bulk-salary file of an approved month (#2532): one file for one bank, chosen from the bank list (#2897); the file holds the people whose record names that bank. A sensitive read (names and account numbers): the server asks for a second factor used in the last 5
// minutes and the action that was refused runs again once it is verified. Ludy never makes a transfer; the accountant uploads the file to the bank. A saved template of the run's legal entity (#2893, the
// screen "Mẫu file lương") may be chosen: the file then follows its columns, headers and remark; without one the generic layout is used.
function BankFile({ runId, month, legalEntityId }: { runId: string; month: string; legalEntityId: string }) {
  const t = useTranslations('hrPayroll');
  const [bank, setBank] = useState('');
  const [templateId, setTemplateId] = useState('');
  const templates = useQuery(orpc.hr.payroll.bankTemplates.list.queryOptions({ input: { legalEntityId } }));
  const download = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/payroll-bank-file/${runId}.xlsx?bank=${encodeURIComponent(bank)}${templateId === '' ? '' : `&template=${encodeURIComponent(templateId)}`}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('bankFileName', { month, bank: bank.toLowerCase() });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const stepUp = isStepUpRequired(download.error);
  return (
    <Card className="mt-6 block p-4 print:hidden" aria-label={t('bankFileTitle')} data-testid="hr-bank-file">
      <h3 className="mb-1 text-sm font-semibold">{t('bankFileTitle')}</h3>
      <p className="mb-3 text-sm text-muted-foreground" data-testid="hr-bank-file-hint">
        {t('bankFileHint')}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="hr-bank-name">{t('bankFileBank')}</Label>
          <BankSelect id="hr-bank-name" value={bank} onChange={setBank} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-bank-template">{t('bankFileTemplate')}</Label>
          <NativeSelect id="hr-bank-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)} data-testid="hr-bank-template-select">
            <NativeSelectOption value="">{t('bankFileTemplateGeneric')}</NativeSelectOption>
            {(templates.data ?? []).map((template) => (
              <NativeSelectOption key={template.id} value={template.id}>
                {template.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button variant="outline" loading={download.isPending} disabled={bank === ''} onClick={() => download.mutate()} data-testid="hr-bank-file-download">
          {t('bankFileDownload')}
        </Button>
      </div>
      {stepUp && <StepUpPrompt action={t('bankFileStepUp')} onVerified={() => download.mutate()} onCancel={() => download.reset()} />}
      {download.error && !stepUp && <ErrorText>{errorMessage(download.error)}</ErrorText>}
    </Card>
  );
}

function Sheet({ runId, approvedRuns, onBack }: { runId: string; approvedRuns: readonly { id: string; month: string }[]; onBack: () => void }) {
  const t = useTranslations('hrPayroll');
  const f = useFormat();
  const q = useQuery({ ...orpc.hr.payroll.runs.sheet.queryOptions({ input: { runId } }), ...ONCE });
  const [editing, setEditing] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [payslip, setPayslip] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [accept, setAccept] = useState(false);
  const [days, setDays] = useState('');
  const recalc = useMutation({
    mutationFn: () => client.hr.payroll.runs.recalculate({ runId, ...(days !== '' ? { workingDays: days } : {}) }),
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: (fingerprint: string) => client.hr.payroll.runs.approve({ runId, fingerprint, acceptFlags: accept }),
    onSuccess: refresh,
  });
  if (q.isPending) return <TableSkeleton columns={7} />;
  if (q.error) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const s = q.data;
  const draft = s.run.status === 'draft';
  const flagged = s.lines.some((l) => l.flags.some((x) => x === 'check_minimum_wage' || x === 'check_deduction_cap'));
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold" data-testid="hr-sheet-title">
            {t('sheetTitle', { month: s.run.month })} <Badge variant={draft ? 'secondary' : 'brand'}>{t(`status.${s.run.status}`)}</Badge>
          </h2>
          <p className="text-sm text-muted-foreground">{t('sheetMeta', { employer: s.run.employerName, days: s.run.workingDays })}</p>
        </div>
        <Button variant="ghost" onClick={onBack}>
          {t('back')}
        </Button>
      </div>
      {s.blocking.length > 0 && <BlockingRules rules={s.blocking} />}
      {draft && s.lines.length > 0 && <MonthCoworker runId={runId} />}
      {draft && s.obstacles.includes('refused_lines') && <ErrorText>{t('refusedLines')}</ErrorText>}
      {payslip && <Payslip key={payslip} lineId={payslip} onClose={() => setPayslip(null)} />}
      {adjusting && <AdjustForm sheet={s} approvedRuns={approvedRuns} onClose={() => setAdjusting(false)} />}
      <DataTable
        head={[t('employee'), t('gross'), t('employeeInsurance'), t('pit'), t('net'), t('employerCost'), '']}
        numeric={[1, 2, 3, 4, 5]}
        foot={
          <TableRow>
            <TableCell className="px-4 py-3 font-medium">{t('totals')}</TableCell>
            <TableCell className={NUM}>{f.money(s.totals.gross, 'VND')}</TableCell>
            <TableCell className={NUM}>{f.money(s.totals.employeeInsurance, 'VND')}</TableCell>
            <TableCell className={NUM}>{f.money(s.totals.pit, 'VND')}</TableCell>
            <TableCell className={NUM}>{f.money(s.totals.net, 'VND')}</TableCell>
            <TableCell className={`${NUM} font-medium`} data-testid="hr-employer-total">
              {f.money(s.totals.employerCost, 'VND')}
            </TableCell>
            <TableCell />
          </TableRow>
        }
      >
        {s.lines.flatMap((l) => {
          const open = shown === l.id;
          const rows = [
            <TableRow key={l.id} data-testid="hr-line-row">
              <TableCell className="px-4 py-3">
                {l.employeeName}
                {l.kind === 'adjustment' && (
                  <Badge className="ml-2" variant="secondary">
                    {t('adjustmentOf', { month: l.adjustsMonth ?? '' })}
                  </Badge>
                )}
                {l.flags.map((x) => (
                  <Badge key={x} className="ml-2" variant="destructive" data-testid="hr-flag">
                    {t(`flag.${x}`)}
                  </Badge>
                ))}
              </TableCell>
              <TableCell className={NUM}>{l.figures ? f.money(l.figures.gross, 'VND') : '-'}</TableCell>
              <TableCell className={NUM}>{l.figures ? f.money(l.figures.employeeInsurance, 'VND') : '-'}</TableCell>
              <TableCell className={NUM}>{l.figures ? f.money(l.figures.pit, 'VND') : '-'}</TableCell>
              <TableCell className={NUM}>{l.figures ? f.money(l.figures.net, 'VND') : '-'}</TableCell>
              <TableCell className={NUM}>{l.figures ? f.money(l.figures.employerCost, 'VND') : '-'}</TableCell>
              <TableCell className="px-4 py-3 text-right">
                <Button variant="ghost" size="sm" onClick={() => setShown(open ? null : l.id)} data-testid="hr-line-open">
                  {open ? t('close') : t('detail')}
                </Button>
              </TableCell>
            </TableRow>,
          ];
          if (open) {
            rows.push(
              <TableRow key={`${l.id}-detail`}>
                <TableCell colSpan={7} className="px-4 py-3">
                  {l.kind === 'adjustment' ? <p className="text-sm">{l.note}</p> : <Breakdown line={l} money={f.money} />}
                  {l.checks.filter((c) => !c.ok).map((c) => (
                    <p key={c.id} className="mt-2 text-xs text-destructive">
                      {t(`check.${c.id}`, { actual: f.money(c.actual, 'VND'), limit: f.money(c.limit, 'VND') })}
                    </p>
                  ))}
                  {l.refusal && <p className="mt-2 text-xs text-destructive">{l.refusal}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {l.kind === 'pay' && l.status === 'calculated' && (
                      <Button variant="outline" size="sm" onClick={() => setPayslip(l.id)} data-testid="hr-payslip-open">
                        {t('payslip')}
                      </Button>
                    )}
                    {draft && l.kind === 'pay' && editing !== l.id && (
                      <Button variant="outline" size="sm" onClick={() => setEditing(l.id)} data-testid="hr-inputs-open">
                        {t('editInputs')}
                      </Button>
                    )}
                  </div>
                  {draft && editing === l.id && <InputsForm line={l} onDone={() => setEditing(null)} />}
                </TableCell>
              </TableRow>,
            );
          }
          return rows;
        })}
      </DataTable>
      {draft && (
        <Card className="mt-6 block p-4" aria-label={t('approveTitle')}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="hr-days">{t('workingDays')}</Label>
              <Input id="hr-days" className="w-24" value={days} placeholder={s.run.workingDays} inputMode="decimal" onChange={(e) => setDays(e.target.value.replace(/[^\d.]/g, ''))} />
            </div>
            <Button variant="outline" loading={recalc.isPending} disabled={days !== '' && !/^\d{1,2}(\.\d)?$/.test(days)} onClick={() => recalc.mutate()} data-testid="hr-recalculate">
              {t('recalculate')}
            </Button>
            {approvedRuns.length > 0 && (
              <Button variant="outline" onClick={() => setAdjusting(true)} data-testid="hr-adjust-new">
                {t('adjust')}
              </Button>
            )}
          </div>
          {recalc.error && <ErrorText>{errorMessage(recalc.error)}</ErrorText>}
          <div className="mt-4 border-t pt-4">
            <p className="text-sm text-muted-foreground">{t('approveHint')}</p>
            {flagged && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} data-testid="hr-accept-flags" />
                {t('acceptFlags')}
              </label>
            )}
            <Button className="mt-3" loading={approve.isPending} disabled={!s.approvable || (flagged && !accept)} onClick={() => approve.mutate(s.fingerprint)} data-testid="hr-approve">
              {t('approve')}
            </Button>
            {approve.error &&
              (isStepUpRequired(approve.error) ? (
                // Approving freezes the month, so it asks for a fresh second factor; once verified, the same request is repeated.
                <div className="mt-3">
                  <StepUpPrompt action={t('approve')} onVerified={() => approve.mutate(s.fingerprint)} onCancel={() => approve.reset()} />
                </div>
              ) : (
                <ErrorText>{errorMessage(approve.error)}</ErrorText>
              ))}
          </div>
        </Card>
      )}
      {!draft && <p className="mt-4 text-sm text-muted-foreground">{t('frozenNote')}</p>}
      {s.run.status === 'approved' && <Settlement runId={runId} />}
      {s.run.status === 'approved' && <BankFile runId={runId} month={s.run.month} legalEntityId={s.run.legalEntityId} />}
      {s.rules.length > 0 && (
        <details className="mt-6 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t('rulesUsed', { count: String(s.rules.length) })}</summary>
          <ul className="mt-2 space-y-1">
            {s.rules.map((r) => (
              <li key={r.id}>
                <span className="font-mono">{r.id}</span> {t(`ruleStatus.${r.status}`)} - {r.cite}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export function HrPayrollPage() {
  const t = useTranslations('hrPayroll');
  const f = useFormat();
  const list = useQuery({ ...orpc.hr.payroll.runs.list.queryOptions({ input: { limit: 24 } }), ...ONCE });
  const [open, setOpen] = useState<string | null>(null);
  const [month, setMonth] = useState(() => vietnamToday().slice(0, 7));
  const create = useMutation({
    mutationFn: () => client.hr.payroll.runs.open({ month }),
    onSuccess: async (r) => {
      await refresh();
      setOpen(r.runId);
    },
  });
  const rows = list.data ?? [];
  const sheetMonth = rows.find((r) => r.id === open)?.month;
  const approvedRuns = rows.filter((r) => r.status !== 'draft' && (sheetMonth === undefined || r.month < sheetMonth)).map((r) => ({ id: r.id, month: r.month }));
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {open ? (
        <Sheet key={open} runId={open} approvedRuns={approvedRuns} onBack={() => setOpen(null)} />
      ) : (
        <>
          <Card className="mb-6 block p-4" aria-label={t('openTitle')}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="hr-month">{t('month')}</Label>
                <Input id="hr-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
              </div>
              <Button loading={create.isPending} disabled={!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)} onClick={() => create.mutate()} data-testid="hr-run-open">
                {t('openMonth')}
              </Button>
            </div>
            <p className="mt-2 text-xs text-subtle-foreground">{t('openHint')}</p>
            {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
          </Card>
          {list.isPending ? (
            <TableSkeleton columns={5} />
          ) : list.error ? (
            <ErrorText>{errorMessage(list.error)}</ErrorText>
          ) : rows.length === 0 ? (
            <Empty title={t('empty')} hint={t('emptyHint')} />
          ) : (
            <DataTable head={[t('month'), t('statusLabel'), t('people'), t('net'), '']} numeric={[2, 3]}>
              {rows.map((r) => (
                <TableRow key={r.id} data-testid="hr-run-row">
                  <TableCell className="px-4 py-3">{r.month}</TableCell>
                  <TableCell className="px-4 py-3">
                    <Badge variant={r.status === 'draft' ? 'secondary' : 'brand'}>{t(`status.${r.status}`)}</Badge>
                  </TableCell>
                  <TableCell className={NUM}>{r.lines}</TableCell>
                  <TableCell className={NUM}>{f.money(r.totals.net, 'VND')}</TableCell>
                  <TableCell className="px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setOpen(r.id)} data-testid="hr-run-view">
                      {t('open')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          )}
        </>
      )}
    </>
  );
}

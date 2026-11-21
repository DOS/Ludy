// SPDX-License-Identifier: AGPL-3.0-only
// "Nhân viên", the first screen of the HR app (#2530, payroll plan 6.1): the people payroll is run for, each with the terms in force (contract type, region, base wage), their
// dependents and, for the one person opened, the identity number and the bank account number, which are sealed under the person's own key and opened only here. Owners and admins
// only: the server, the database's policies and the menu all say so. Every read of this data is a sensitive query that leaves an audit row first, so the screen asks once and
// never refetches by itself (no refetch on focus, no polling).
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  HR_CONTRACT_FORMS,
  HR_CONTRACT_TYPES,
  HR_DEPARTMENT_CODE_MAX,
  HR_DEPARTMENT_NAME_MAX,
  HR_JOB_TITLE_MAX,
  HR_LEAVE_REQUEST_STATUSES,
  HR_PAY_FUNCTIONS,
  HR_PROBATION_ROLE_TIERS,
  HR_REGIONS,
  HR_RELATIONS,
  SIGN_BY_SOURCE_MAX,
  vietnamToday,
  type HrContractAlert,
  type HrContractForm,
  type HrContractType,
  type HrDepartmentView,
  type HrEmployee,
  type HrEmployeeEdit,
  type HrEmployeeSummary,
  type HrEmploymentTerms,
  type HrEmploymentView,
  type HrLeaveRequestStatus,
  type HrLeaveRequestView,
  type HrPayFunction,
  type HrProbationRoleTier,
  type HrRegion,
  type HrRelation,
  type LegalEntity,
  type SignEnvelopeBySourceItem,
} from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { bankByCode, checkLaborContractTerms, deriveFixedTermEndDateIso, type LaborContractFinding } from '@crove/l10n-vn';
import { BankSelect } from '../components/bank-select.tsx';
import { HrContractSignHandoff } from '../components/hr-contract-sign-handoff.tsx';
import { LeaveBalancePanel } from '../components/hr-leave-panel.tsx';
import { SeveranceCalculatorPanel } from '../components/hr-severance-panel.tsx';
import { signEnvelopePollMs, useSignAppEnabled } from '../components/quote-sign-handoff.tsx';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { DataTable, Empty, ErrorText, FieldError, PageHeader, TableSkeleton, fieldControl, focusFirstInvalid, useFieldErrors } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });
// A sensitive read leaves an audit row each time: the screen reads once and again only after its own change.
const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const NUM = 'px-4 py-3 text-right tabular-nums';
const PHONE_SELECT_TARGET = 'max-md:min-h-11 [&_select]:max-md:min-h-11';
const PHONE_INPUT_TARGET = 'max-md:min-h-11';

export interface TermsState {
  effectiveFrom: string;
  contractType: HrContractType;
  region: HrRegion;
  baseWage: string;
  payFunction: HrPayFunction;
  contractForm: HrContractForm | '';
  termMonths: string;
  contractEndOn: string;
  fixedTermSequence: '' | '1' | '2';
  probationRoleTier: HrProbationRoleTier | '';
  probationEndOn: string;
  probationWage: string;
}

export const blankTerms = (): TermsState => ({
  effectiveFrom: vietnamToday(),
  contractType: 'indefinite',
  region: 'I',
  baseWage: '',
  payFunction: 'admin',
  contractForm: '',
  termMonths: '',
  contractEndOn: '',
  fixedTermSequence: '',
  probationRoleTier: '',
  probationEndOn: '',
  probationWage: '',
});

export const idNumberOk = (v: string) => v.trim() === '' || /^(\d{10}|\d{12})$/.test(v.trim());
const wageOk = (v: string) => /^\d{1,16}(\.\d{1,2})?$/.test(v);

function hasContractDetails(terms: TermsState): boolean {
  return (
    terms.contractForm !== '' ||
    terms.termMonths.trim() !== '' ||
    terms.contractEndOn !== '' ||
    terms.fixedTermSequence !== '' ||
    terms.probationRoleTier !== '' ||
    terms.probationEndOn !== '' ||
    terms.probationWage.trim() !== ''
  );
}

export function buildEmploymentPayload(terms: TermsState): HrEmploymentTerms {
  const termMonthsRaw = terms.termMonths.trim();
  const probationWageRaw = terms.probationWage.trim();
  return {
    effectiveFrom: terms.effectiveFrom,
    contractType: terms.contractType,
    region: terms.region,
    baseWage: terms.baseWage,
    payFunction: terms.payFunction,
    ...(terms.contractForm !== '' ? { contractForm: terms.contractForm } : {}),
    ...(termMonthsRaw !== '' ? { termMonths: Number(termMonthsRaw) } : {}),
    ...(terms.contractEndOn !== '' ? { contractEndOn: terms.contractEndOn } : {}),
    ...(terms.fixedTermSequence !== '' ? { fixedTermSequence: Number(terms.fixedTermSequence) } : {}),
    ...(terms.probationRoleTier !== '' ? { probationRoleTier: terms.probationRoleTier } : {}),
    ...(terms.probationEndOn !== '' ? { probationEndOn: terms.probationEndOn } : {}),
    ...(probationWageRaw !== '' ? { probationWage: probationWageRaw } : {}),
  };
}

function autoEndDateFor(terms: TermsState): string | null {
  if (terms.contractType !== 'fixed_term' || terms.contractEndOn !== '') return null;
  const raw = terms.termMonths.trim();
  if (!/^\d+$/.test(raw)) return null;
  return deriveFixedTermEndDateIso(terms.effectiveFrom, Number(raw));
}

export function previewContractCheck(terms: TermsState): LaborContractFinding[] {
  if (!hasContractDetails(terms)) return [];
  const termMonthsRaw = terms.termMonths.trim();
  const parsedTermMonths =
    termMonthsRaw === ''
      ? null
      : /^\d+$/.test(termMonthsRaw)
        ? Number(termMonthsRaw)
        : Number.NaN;
  const derivedEndOn = terms.contractEndOn !== '' ? terms.contractEndOn : autoEndDateFor(terms);
  const hasProbation =
    terms.probationRoleTier !== '' || terms.probationEndOn !== '' || terms.probationWage.trim() !== '';
  const result = checkLaborContractTerms({
    contractKind: terms.contractType === 'none' ? 'under_one_month' : terms.contractType,
    ...(terms.contractForm !== '' ? { form: terms.contractForm } : {}),
    startDate: terms.effectiveFrom,
    endDate: derivedEndOn,
    termMonths: parsedTermMonths,
    fixedTermSequence: terms.fixedTermSequence === '' ? null : Number(terms.fixedTermSequence),
    ...(wageOk(terms.baseWage) ? { contractWage: terms.baseWage } : {}),
    probation: hasProbation
      ? {
          roleTier: terms.probationRoleTier,
          startDate: terms.effectiveFrom,
          endDate: terms.probationEndOn !== '' ? terms.probationEndOn : null,
          wage: terms.probationWage.trim() !== '' ? terms.probationWage.trim() : null,
        }
      : null,
  });
  const findings = [...result.findings];
  if (terms.contractType !== 'fixed_term' && terms.fixedTermSequence !== '') {
    findings.push({
      code: 'invalid_fixed_term_sequence',
      severity: 'error',
      field: 'fixedTermSequence',
      message: 'Fixed-term sequence is only valid for fixed-term contracts.',
      cite: 'Labor Code 2019 Art. 20(2)',
    });
  }
  return findings;
}

function formatContractAlert(t: ReturnType<typeof useTranslations<'hrEmployees'>>, f: ReturnType<typeof useFormat>, alert: HrContractAlert): string {
  const date = alert.targetDate ? f.date(alert.targetDate) : '';
  const days = String(Math.abs(alert.daysRemaining ?? 0));
  switch (alert.code) {
    case 'contract_expired':
    case 'contract_expiring_soon':
    case 'probation_ending_soon':
      return t(`alerts.${alert.code}`, { days, date });
    case 'final_fixed_term_renewal':
    case 'must_convert_to_indefinite':
      return t(`alerts.${alert.code}`);
  }
}

function ContractAlertBadges({ alerts }: { alerts: readonly HrContractAlert[] }) {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  if (alerts.length === 0) return null;
  return (
    <>
      {alerts.map((alert) => (
        <Badge
          key={`${alert.code}-${alert.targetDate ?? ''}`}
          className="ml-2"
          variant={alert.severity === 'error' ? 'destructive' : 'warning'}
          data-testid={`hr-contract-alert-${alert.code}`}
        >
          {formatContractAlert(t, f, alert)}
        </Badge>
      ))}
    </>
  );
}

function formatContractTermSummary(t: ReturnType<typeof useTranslations<'hrEmployees'>>, f: ReturnType<typeof useFormat>, row: HrEmploymentView): string {
  const parts: string[] = [];
  if (row.termMonths !== null) parts.push(t('termMonthsShort', { months: String(row.termMonths) }));
  if (row.contractEndOn !== null) parts.push(f.date(row.contractEndOn));
  if (row.fixedTermSequence !== null) parts.push(t(`sequenceShort.${String(row.fixedTermSequence) as '1' | '2'}`));
  if (row.contractForm !== null) parts.push(t(`contractForms.${row.contractForm}`));
  return parts.length > 0 ? parts.join(' - ') : '-';
}

function formatProbationSummary(t: ReturnType<typeof useTranslations<'hrEmployees'>>, f: ReturnType<typeof useFormat>, row: HrEmploymentView): string {
  const parts: string[] = [];
  if (row.probationRoleTier !== null) parts.push(t(`probationTiersShort.${row.probationRoleTier}`));
  if (row.probationEndOn !== null) parts.push(f.date(row.probationEndOn));
  if (row.probationWage !== null) parts.push(f.money(row.probationWage, 'VND'));
  return parts.length > 0 ? parts.join(' - ') : '-';
}

export function decodeBase64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function triggerContractPdfDownload(result: { filename: string; contentType: string; pdfBase64: string }): void {
  const bytes = decodeBase64Bytes(result.pdfBase64);
  const blob = new Blob([bytes], { type: result.contentType || 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TermsFields({
  id,
  value,
  onChange,
  defaultExpanded = false,
}: {
  id: string;
  value: TermsState;
  onChange: (patch: Partial<TermsState>) => void;
  defaultExpanded?: boolean;
}) {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const findings = previewContractCheck(value);
  const errors = findings.filter((item) => item.severity === 'error');
  const warnings = findings.filter((item) => item.severity === 'warning');
  const derivedEnd = autoEndDateFor(value);
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${id}-from`}>{t('effectiveFrom')}</Label>
        <Input id={`${id}-from`} type="date" value={value.effectiveFrom} onChange={(e) => onChange({ effectiveFrom: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-contract`}>{t('contractType')}</Label>
        <NativeSelect id={`${id}-contract`} value={value.contractType} onChange={(e) => onChange({ contractType: e.target.value as HrContractType })}>
          {HR_CONTRACT_TYPES.map((k) => (
            <NativeSelectOption key={k} value={k}>
              {t(`contracts.${k}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-region`}>{t('region')}</Label>
        <NativeSelect id={`${id}-region`} value={value.region} onChange={(e) => onChange({ region: e.target.value as HrRegion })}>
          {HR_REGIONS.map((k) => (
            <NativeSelectOption key={k} value={k}>
              {t('regionOption', { region: k })}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-function`}>{t('payFunction')}</Label>
        <NativeSelect id={`${id}-function`} value={value.payFunction} onChange={(e) => onChange({ payFunction: e.target.value as HrPayFunction })}>
          {HR_PAY_FUNCTIONS.map((k) => (
            <NativeSelectOption key={k} value={k}>
              {t(`payFunctions.${k}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-wage`}>{t('baseWage')}</Label>
        <Input id={`${id}-wage`} value={value.baseWage} inputMode="numeric" maxLength={19} onChange={(e) => onChange({ baseWage: e.target.value.replace(/[^\d.]/g, '') })} />
      </div>
      <div className="sm:col-span-full space-y-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid="hr-contract-details-toggle"
        >
          {t('contractDetailsToggle')}
        </Button>
        {expanded && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-3" data-testid="hr-contract-details-panel">
            <div className="space-y-1">
              <Label htmlFor={`${id}-contract-form`}>{t('contractForm')}</Label>
              <NativeSelect
                id={`${id}-contract-form`}
                value={value.contractForm}
                onChange={(e) => onChange({ contractForm: e.target.value as HrContractForm | '' })}
              >
                <NativeSelectOption value="">{t('contractFormUnset')}</NativeSelectOption>
                {HR_CONTRACT_FORMS.map((k) => (
                  <NativeSelectOption key={k} value={k}>
                    {t(`contractForms.${k}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-term-months`}>{t('termMonths')}</Label>
              <Input
                id={`${id}-term-months`}
                value={value.termMonths}
                inputMode="numeric"
                maxLength={2}
                onChange={(e) => onChange({ termMonths: e.target.value.replace(/\D/g, '') })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-contract-end`}>{t('contractEndOn')}</Label>
              <Input
                id={`${id}-contract-end`}
                type="date"
                value={value.contractEndOn}
                onChange={(e) => onChange({ contractEndOn: e.target.value })}
              />
              {derivedEnd && (
                <p className="text-xs text-subtle-foreground" data-testid="hr-contract-auto-end">
                  {t('autoContractEndHint', { date: f.date(derivedEnd) })}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-fixed-seq`}>{t('fixedTermSequence')}</Label>
              <NativeSelect
                id={`${id}-fixed-seq`}
                value={value.fixedTermSequence}
                onChange={(e) => onChange({ fixedTermSequence: e.target.value as '' | '1' | '2' })}
              >
                <NativeSelectOption value="">{t('sequenceUnset')}</NativeSelectOption>
                <NativeSelectOption value="1">{t('sequenceOptions.1')}</NativeSelectOption>
                <NativeSelectOption value="2">{t('sequenceOptions.2')}</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-probation-tier`}>{t('probationRoleTier')}</Label>
              <NativeSelect
                id={`${id}-probation-tier`}
                value={value.probationRoleTier}
                onChange={(e) => onChange({ probationRoleTier: e.target.value as HrProbationRoleTier | '' })}
              >
                <NativeSelectOption value="">{t('probationRoleUnset')}</NativeSelectOption>
                {HR_PROBATION_ROLE_TIERS.map((k) => (
                  <NativeSelectOption key={k} value={k}>
                    {t(`probationTiers.${k}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-probation-end`}>{t('probationEndOn')}</Label>
              <Input
                id={`${id}-probation-end`}
                type="date"
                value={value.probationEndOn}
                onChange={(e) => onChange({ probationEndOn: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-probation-wage`}>{t('probationWage')}</Label>
              <Input
                id={`${id}-probation-wage`}
                value={value.probationWage}
                inputMode="numeric"
                maxLength={19}
                onChange={(e) => onChange({ probationWage: e.target.value.replace(/[^\d.]/g, '') })}
              />
            </div>
          </div>
        )}
        {errors.length > 0 && (
          <div className="space-y-1" data-testid="hr-contract-validation-errors">
            {errors.map((item, index) => (
              <ErrorText key={`${item.code}-${index}`}>{t(`contractCheck.findings.${item.code}`)}</ErrorText>
            ))}
          </div>
        )}
        {warnings.length > 0 && (
          <div className="space-y-1 text-xs text-warning" data-testid="hr-contract-validation-warnings">
            {warnings.map((item, index) => (
              <p key={`${item.code}-${index}`}>{t(`contractCheck.findings.${item.code}`)}</p>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function applyDepartmentDefaultPayFunction(
  terms: TermsState,
  departmentId: string,
  departments: readonly HrDepartmentView[],
  manualOverride: boolean,
): TermsState {
  if (manualOverride) return terms;
  const chosen = departments.find((d) => d.id === departmentId);
  return { ...terms, payFunction: chosen ? chosen.payFunction : 'admin' };
}

export function resolveVisibleDepartmentFilter(
  departmentFilter: string,
  departments: readonly HrDepartmentView[],
  deptLoaded: boolean,
): string {
  if (departmentFilter === '') return '';
  if (deptLoaded && !departments.some((d) => d.id === departmentFilter)) return '';
  return departmentFilter;
}

export function filterDepartmentsForEntity(
  departments: readonly HrDepartmentView[],
  legalEntityId?: string | null,
): HrDepartmentView[] {
  return departments.filter((d) => d.archivedAt === null && (!legalEntityId || d.legalEntityId === legalEntityId));
}

const deptCodeOk = (code: string): boolean => code.trim() === '' || /^[A-Za-z0-9._-]+$/.test(code.trim());

export interface DepartmentEditDraft {
  id: string;
  origName: string;
  origCode: string;
  origPayFunction: HrPayFunction;
  name: string;
  code: string;
  payFunction: HrPayFunction;
}

export function clearEditingDepartmentOnComplete(
  current: DepartmentEditDraft | null,
  completedDepartmentId: string,
): DepartmentEditDraft | null {
  return current?.id === completedDepartmentId ? null : current;
}

export function formatDepartmentFilterOptionLabel(
  department: Pick<HrDepartmentView, 'name' | 'legalEntityId' | 'archivedAt'>,
  entities: readonly Pick<LegalEntity, 'id' | 'name'>[],
  archivedBadge: string,
): string {
  const entityName =
    entities.length > 1 ? entities.find((e) => e.id === department.legalEntityId)?.name : undefined;
  const withEntity = entityName ? `${department.name} - ${entityName}` : department.name;
  return department.archivedAt !== null ? `${withEntity} (${archivedBadge})` : withEntity;
}

export type OrgMemberOption = { userId: string; displayName: string | null; email: string; role: string };

function memberOptionLabel(m: OrgMemberOption): string {
  return m.displayName ? `${m.displayName} (${m.email})` : m.email;
}

function DepartmentManagerSelect({
  department,
  members,
}: {
  department: HrDepartmentView;
  members: readonly OrgMemberOption[];
}) {
  const t = useTranslations('hrEmployees');
  const linkable = members.filter((m) => m.role !== 'viewer');
  const setManager = useMutation({
    mutationFn: (managerUserId: string | null) =>
      client.hr.departments.setManager({ departmentId: department.id, managerUserId }),
    onSuccess: refresh,
  });
  return (
    <div className="space-y-1 sm:col-span-3">
      <Label htmlFor="hr-dept-edit-manager">{t('departments.manager')}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          id="hr-dept-edit-manager"
          className={PHONE_SELECT_TARGET}
          value={department.managerUserId ?? ''}
          disabled={setManager.isPending}
          onChange={(e) => setManager.mutate(e.target.value || null)}
          data-testid="hr-dept-edit-manager"
        >
          <NativeSelectOption value="">{t('departments.noManager')}</NativeSelectOption>
          {department.managerUserId && !linkable.some((m) => m.userId === department.managerUserId) && (
            <NativeSelectOption value={department.managerUserId} disabled>
              {department.managerName ?? department.managerUserId}
            </NativeSelectOption>
          )}
          {linkable.map((m) => (
            <NativeSelectOption key={m.userId} value={m.userId}>
              {memberOptionLabel(m)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {setManager.error && <ErrorText>{errorMessage(setManager.error)}</ErrorText>}
      </div>
    </div>
  );
}

export function DepartmentsSection({
  departments,
  entities,
  members = [],
  showArchived,
  onShowArchivedChange,
  loading = false,
  error = null,
}: {
  departments: readonly HrDepartmentView[];
  entities?: readonly LegalEntity[];
  members?: readonly OrgMemberOption[];
  showArchived: boolean;
  onShowArchivedChange: (next: boolean) => void;
  loading?: boolean;
  error?: unknown;
}) {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  const entityList = entities ?? [];
  const defaultEntityId = entityList.find((x) => x.isDefault)?.id ?? entityList[0]?.id ?? '';
  const entityNameById = new Map(entityList.map((e) => [e.id, e.name]));
  const [adding, setAdding] = useState(false);
  const [newLegalEntityId, setNewLegalEntityId] = useState('');
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newPayFunction, setNewPayFunction] = useState<HrPayFunction>('admin');
  const targetNewEntityId = newLegalEntityId || defaultEntityId;
  const [editing, setEditing] = useState<DepartmentEditDraft | null>(null);

  const createDept = useMutation({
    mutationFn: () =>
      client.hr.departments.add({
        ...(targetNewEntityId ? { legalEntityId: targetNewEntityId } : {}),
        name: newName.trim(),
        ...(newCode.trim() ? { code: newCode.trim() } : {}),
        payFunction: newPayFunction,
      }),
    onSuccess: async () => {
      await refresh();
      setAdding(false);
      setNewLegalEntityId('');
      setNewName('');
      setNewCode('');
      setNewPayFunction('admin');
    },
  });

  const updateDept = useMutation({
    mutationFn: (draft: DepartmentEditDraft) => {
      const trimmedName = draft.name.trim();
      const trimmedCode = draft.code.trim();
      return client.hr.departments.edit({
        departmentId: draft.id,
        ...(trimmedName !== draft.origName ? { name: trimmedName } : {}),
        ...(trimmedCode !== draft.origCode ? { code: trimmedCode === '' ? null : trimmedCode } : {}),
        ...(draft.payFunction !== draft.origPayFunction ? { payFunction: draft.payFunction } : {}),
      });
    },
    onSuccess: async (_data, draft) => {
      await refresh();
      setEditing((current) => clearEditingDepartmentOnComplete(current, draft.id));
    },
  });

  const archiveDept = useMutation({
    mutationFn: (departmentId: string) => client.hr.departments.archive({ departmentId }),
    onSuccess: async (_data, departmentId) => {
      await refresh();
      setEditing((current) => clearEditingDepartmentOnComplete(current, departmentId));
    },
  });

  const editChanged =
    editing !== null &&
    (editing.name.trim() !== editing.origName ||
      editing.code.trim() !== editing.origCode ||
      editing.payFunction !== editing.origPayFunction);

  return (
    <Card className="mb-6 block p-4" data-testid="hr-departments-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">{t('departments.title')}</h2>
          <p className="text-xs text-subtle-foreground">{t('departments.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-xs text-subtle-foreground">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => onShowArchivedChange(e.target.checked)}
              data-testid="hr-departments-show-archived"
            />
            {t('departments.showArchived')}
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={adding}
            onClick={() => {
              if (!updateDept.isPending) updateDept.reset();
              setEditing(null);
              setAdding(true);
            }}
            data-testid="hr-department-new"
          >
            {t('departments.new')}
          </Button>
        </div>
      </div>

      {adding && (
        <div className="mt-4 grid gap-3 rounded-md border p-3 sm:grid-cols-3" data-testid="hr-department-add-form">
          {entityList.length > 1 && (
            <div className="space-y-1">
              <Label htmlFor="hr-dept-add-legal-entity">{t('legalEntity')}</Label>
              <NativeSelect
                id="hr-dept-add-legal-entity"
                value={targetNewEntityId}
                onChange={(e) => setNewLegalEntityId(e.target.value)}
                data-testid="hr-dept-add-legal-entity"
              >
                {entityList.map((entity) => (
                  <NativeSelectOption key={entity.id} value={entity.id}>
                    {entity.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="hr-dept-add-name">{t('departments.name')}</Label>
            <Input
              id="hr-dept-add-name"
              value={newName}
              maxLength={HR_DEPARTMENT_NAME_MAX}
              onChange={(e) => setNewName(e.target.value)}
              data-testid="hr-dept-add-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-dept-add-code">{t('departments.code')}</Label>
            <Input
              id="hr-dept-add-code"
              value={newCode}
              maxLength={HR_DEPARTMENT_CODE_MAX}
              onChange={(e) => setNewCode(e.target.value)}
              data-testid="hr-dept-add-code"
            />
            <p className="text-xs text-subtle-foreground">{t('departments.codeHint')}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-dept-add-function">{t('departments.defaultPayFunction')}</Label>
            <NativeSelect
              id="hr-dept-add-function"
              value={newPayFunction}
              onChange={(e) => setNewPayFunction(e.target.value as HrPayFunction)}
              data-testid="hr-dept-add-pay-function"
            >
              {HR_PAY_FUNCTIONS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`payFunctions.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {createDept.error && (
            <div className="sm:col-span-3">
              <ErrorText>{errorMessage(createDept.error)}</ErrorText>
            </div>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button
              size="sm"
              loading={createDept.isPending}
              disabled={newName.trim() === '' || !deptCodeOk(newCode)}
              onClick={() => createDept.mutate()}
              data-testid="hr-dept-add-save"
            >
              {t('save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {editing && (
        <div className="mt-4 grid gap-3 rounded-md border p-3 sm:grid-cols-3" data-testid="hr-department-edit-form">
          <div className="space-y-1">
            <Label htmlFor="hr-dept-edit-name">{t('departments.name')}</Label>
            <Input
              id="hr-dept-edit-name"
              value={editing.name}
              maxLength={HR_DEPARTMENT_NAME_MAX}
              onChange={(e) => setEditing((cur) => (cur ? { ...cur, name: e.target.value } : null))}
              data-testid="hr-dept-edit-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-dept-edit-code">{t('departments.code')}</Label>
            <Input
              id="hr-dept-edit-code"
              value={editing.code}
              maxLength={HR_DEPARTMENT_CODE_MAX}
              onChange={(e) => setEditing((cur) => (cur ? { ...cur, code: e.target.value } : null))}
              data-testid="hr-dept-edit-code"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-dept-edit-function">{t('departments.defaultPayFunction')}</Label>
            <NativeSelect
              id="hr-dept-edit-function"
              value={editing.payFunction}
              onChange={(e) => setEditing((cur) => (cur ? { ...cur, payFunction: e.target.value as HrPayFunction } : null))}
              data-testid="hr-dept-edit-pay-function"
            >
              {HR_PAY_FUNCTIONS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`payFunctions.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {members.length > 0 && (() => {
            const currentDept = departments.find((d) => d.id === editing.id);
            return currentDept ? <DepartmentManagerSelect department={currentDept} members={members} /> : null;
          })()}
          {updateDept.error !== null && updateDept.error !== undefined && updateDept.variables?.id === editing.id && (
            <div className="sm:col-span-3">
              <ErrorText>{errorMessage(updateDept.error)}</ErrorText>
            </div>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button
              size="sm"
              loading={updateDept.isPending && updateDept.variables?.id === editing.id}
              disabled={editing.name.trim() === '' || !deptCodeOk(editing.code) || !editChanged || updateDept.isPending}
              onClick={() => updateDept.mutate(editing)}
              data-testid="hr-dept-edit-save"
            >
              {t('save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (!updateDept.isPending) updateDept.reset();
                setEditing(null);
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {(!editing || updateDept.variables?.id !== editing.id) && updateDept.error !== null && updateDept.error !== undefined && (
        <ErrorText>{errorMessage(updateDept.error)}</ErrorText>
      )}
      {archiveDept.error && <ErrorText>{errorMessage(archiveDept.error)}</ErrorText>}

      {loading ? (
        <div className="mt-3">
          <TableSkeleton columns={5} />
        </div>
      ) : error ? (
        <div className="mt-3">
          <ErrorText>{errorMessage(error)}</ErrorText>
        </div>
      ) : departments.length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground" data-testid="hr-departments-empty">
          {t('departments.emptyHint')}
        </p>
      ) : (
        <div className="mt-3">
          <DataTable
            head={[
              t('departments.name'),
              t('departments.defaultPayFunction'),
              t('departments.activeEmployees'),
              t('departments.activeBaseWageTotal'),
              '',
            ]}
            numeric={[2, 3]}
          >
            {departments.map((d) => (
              <TableRow key={d.id} data-testid="hr-department-row">
                <TableCell className="px-4 py-3">
                  <span className="font-medium text-foreground">{d.name}</span>
                  {entityList.length > 1 && entityNameById.has(d.legalEntityId) && (
                    <Badge className="ml-2" variant="outline">
                      {entityNameById.get(d.legalEntityId)}
                    </Badge>
                  )}
                  {d.code && (
                    <Badge className="ml-2" variant="outline">
                      {d.code}
                    </Badge>
                  )}
                  {d.managerName && (
                    <Badge className="ml-2" variant="secondary" data-testid="hr-department-manager-badge">
                      {d.managerName}
                    </Badge>
                  )}
                  {d.archivedAt !== null && (
                    <Badge className="ml-2" variant="secondary">
                      {t('departments.archivedBadge')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="px-4 py-3">{t(`payFunctions.${d.payFunction}`)}</TableCell>
                <TableCell className={NUM} data-testid="hr-department-headcount">
                  {d.activeEmployees}
                </TableCell>
                <TableCell className={NUM} data-testid="hr-department-wage-total">
                  {f.money(d.activeBaseWageTotal, 'VND')}
                </TableCell>
                <TableCell className="px-4 py-3 text-right">
                  {d.archivedAt === null && (
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={archiveDept.isPending && archiveDept.variables === d.id}
                        onClick={() => {
                          if (!updateDept.isPending) updateDept.reset();
                          setAdding(false);
                          setEditing({
                            id: d.id,
                            origName: d.name,
                            origCode: d.code ?? '',
                            origPayFunction: d.payFunction,
                            name: d.name,
                            code: d.code ?? '',
                            payFunction: d.payFunction,
                          });
                        }}
                        data-testid="hr-department-edit"
                      >
                        {t('departments.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={updateDept.isPending && updateDept.variables?.id === d.id}
                        loading={archiveDept.isPending && archiveDept.variables === d.id}
                        onClick={() => archiveDept.mutate(d.id)}
                        data-testid="hr-department-archive"
                      >
                        {t('departments.archive')}
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
        </div>
      )}
    </Card>
  );
}

export interface EditEmployeeDraft {
  name: string;
  departmentId: string;
  jobTitle: string;
  address: string;
  identity: string;
  account: string;
  bank: string;
  birth: string;
  tax: string;
  insurance: string;
  clear: {
    department: boolean;
    jobTitle: boolean;
    address: boolean;
    identity: boolean;
    account: boolean;
    bank: boolean;
    birth: boolean;
    tax: boolean;
    insurance: boolean;
  };
}

export const blankEditDraft = (): EditEmployeeDraft => ({
  name: '',
  departmentId: '',
  jobTitle: '',
  address: '',
  identity: '',
  account: '',
  bank: '',
  birth: '',
  tax: '',
  insurance: '',
  clear: {
    department: false,
    jobTitle: false,
    address: false,
    identity: false,
    account: false,
    bank: false,
    birth: false,
    tax: false,
    insurance: false,
  },
});

export function hasEditEmployeeChanges(draft: EditEmployeeDraft): boolean {
  return Boolean(
    draft.name.trim() ||
      draft.departmentId ||
      draft.jobTitle.trim() ||
      draft.address.trim() ||
      draft.identity.trim() ||
      draft.account.trim() ||
      draft.bank ||
      draft.birth ||
      draft.tax.trim() ||
      draft.insurance.trim() ||
      draft.clear.department ||
      draft.clear.jobTitle ||
      draft.clear.address ||
      draft.clear.identity ||
      draft.clear.account ||
      draft.clear.bank ||
      draft.clear.birth ||
      draft.clear.tax ||
      draft.clear.insurance,
  );
}

/** Builds the `hr.payroll.employee.edit` payload from an edit draft (`clear` flags emit explicit `null`, empty fields stay omitted). */
export function buildEditPayload(employeeId: string, draft: EditEmployeeDraft): HrEmployeeEdit {
  return {
    employeeId,
    ...(draft.name.trim() ? { displayName: draft.name.trim() } : {}),
    ...(draft.clear.department ? { departmentId: null } : draft.departmentId ? { departmentId: draft.departmentId } : {}),
    ...(draft.clear.jobTitle ? { jobTitle: null } : draft.jobTitle.trim() ? { jobTitle: draft.jobTitle.trim() } : {}),
    // A field left empty is not changed; a ticked "clear" sends null, which removes the stored value.
    ...(draft.clear.address ? { address: null } : draft.address.trim() ? { address: draft.address.trim() } : {}),
    ...(draft.clear.identity ? { identityNumber: null } : draft.identity.trim() ? { identityNumber: draft.identity.trim() } : {}),
    ...(draft.clear.account ? { accountNumber: null } : draft.account.trim() ? { accountNumber: draft.account.trim() } : {}),
    ...(draft.clear.bank ? { bankCode: null } : draft.bank ? { bankCode: draft.bank } : {}),
    ...(draft.clear.birth ? { birthDate: null } : draft.birth ? { birthDate: draft.birth } : {}),
    ...(draft.clear.tax ? { taxCode: null } : draft.tax.trim() ? { taxCode: draft.tax.trim() } : {}),
    ...(draft.clear.insurance ? { insuranceNumber: null } : draft.insurance.trim() ? { insuranceNumber: draft.insurance.trim() } : {}),
  };
}

function ClearStoredCheckbox({
  checked,
  label,
  onChange,
  testId,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  testId?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-subtle-foreground max-md:min-h-11">
      <input type="checkbox" checked={checked} onChange={(ev) => onChange(ev.target.checked)} data-testid={testId} />
      {label}
    </label>
  );
}

export function EditForm({
  employee,
  departments,
  draft,
  onChange,
  pending,
  onSubmit,
  onCancel,
}: {
  employee: Pick<
    HrEmployee,
    | 'status'
    | 'legalEntityId'
    | 'displayName'
    | 'departmentId'
    | 'jobTitle'
    | 'address'
    | 'hasIdentityNumber'
    | 'hasAccountNumber'
    | 'bankCode'
    | 'birthDate'
    | 'taxCode'
    | 'insuranceNumber'
  >;
  departments: readonly HrDepartmentView[];
  draft: EditEmployeeDraft;
  onChange: (next: EditEmployeeDraft) => void;
  pending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('hrEmployees');
  const limited = employee.status !== 'active';
  const fields = useFieldErrors<'taxCode' | 'insuranceNumber'>((field) => {
    if (field === 'taxCode') return !draft.clear.tax && !idNumberOk(draft.tax) ? t('taxCodeInvalid') : null;
    return !draft.clear.insurance && !idNumberOk(draft.insurance) ? t('insuranceNumberInvalid') : null;
  });
  const hasChange = hasEditEmployeeChanges(draft);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasChange || pending) return;
    if (!fields.checkAll(['taxCode', 'insuranceNumber'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    onSubmit();
  };
  return (
    <form className="grid gap-3 sm:grid-cols-2" noValidate onSubmit={submit} data-testid="hr-employee-edit-form">
      {!limited && (
        <>
          <div className="space-y-1">
            <Label htmlFor="hr-edit-name">{t('name')}</Label>
            <Input
              id="hr-edit-name"
              value={draft.name}
              maxLength={200}
              placeholder={employee.displayName}
              onChange={(ev) => onChange({ ...draft, name: ev.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-edit-department">{t('departments.field')}</Label>
            <NativeSelect
              id="hr-edit-department"
              value={draft.departmentId}
              disabled={draft.clear.department}
              onChange={(ev) => onChange({ ...draft, departmentId: ev.target.value })}
              data-testid="hr-edit-department"
            >
              <NativeSelectOption value="">{t('departments.keepCurrent')}</NativeSelectOption>
              {filterDepartmentsForEntity(departments, employee.legalEntityId).map((d) => (
                <NativeSelectOption key={d.id} value={d.id}>
                  {d.code ? `${d.name} (${d.code})` : d.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {employee.departmentId !== null && (
              <ClearStoredCheckbox
                checked={draft.clear.department}
                label={t('clearStored')}
                onChange={(checked) => onChange({ ...draft, clear: { ...draft.clear, department: checked } })}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-edit-job-title">{t('jobTitle')}</Label>
            <Input
              id="hr-edit-job-title"
              value={draft.jobTitle}
              maxLength={HR_JOB_TITLE_MAX}
              placeholder={employee.jobTitle ?? undefined}
              disabled={draft.clear.jobTitle}
              onChange={(ev) => onChange({ ...draft, jobTitle: ev.target.value })}
              data-testid="hr-edit-job-title"
            />
            {employee.jobTitle !== null && (
              <ClearStoredCheckbox
                checked={draft.clear.jobTitle}
                label={t('clearStored')}
                onChange={(checked) => onChange({ ...draft, clear: { ...draft.clear, jobTitle: checked } })}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-edit-address">{t('address')}</Label>
            <Input
              id="hr-edit-address"
              value={draft.address}
              maxLength={500}
              disabled={draft.clear.address}
              onChange={(ev) => onChange({ ...draft, address: ev.target.value })}
            />
            {employee.address !== null && (
              <ClearStoredCheckbox
                checked={draft.clear.address}
                label={t('clearStored')}
                onChange={(checked) => onChange({ ...draft, clear: { ...draft.clear, address: checked } })}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-edit-identity">{t('identityNumber')}</Label>
            <Input
              id="hr-edit-identity"
              value={draft.identity}
              maxLength={30}
              autoComplete="off"
              disabled={draft.clear.identity}
              onChange={(ev) => onChange({ ...draft, identity: ev.target.value })}
            />
            {employee.hasIdentityNumber && (
              <ClearStoredCheckbox
                checked={draft.clear.identity}
                label={t('clearStored')}
                onChange={(checked) => onChange({ ...draft, clear: { ...draft.clear, identity: checked } })}
              />
            )}
          </div>
        </>
      )}
      <div className="space-y-1">
        <Label htmlFor="hr-edit-account">{t('accountNumber')}</Label>
        <Input
          id="hr-edit-account"
          value={draft.account}
          maxLength={34}
          autoComplete="off"
          disabled={draft.clear.account}
          onChange={(ev) => onChange({ ...draft, account: ev.target.value })}
        />
        {employee.hasAccountNumber && (
          <ClearStoredCheckbox
            checked={draft.clear.account}
            label={t('clearStored')}
            onChange={(checked) => onChange({ ...draft, clear: { ...draft.clear, account: checked } })}
          />
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="hr-edit-bank">{t('bankName')}</Label>
        <BankSelect
          id="hr-edit-bank"
          value={draft.bank}
          disabled={draft.clear.bank}
          onChange={(code) => onChange({ ...draft, bank: code })}
        />
        {employee.bankCode !== null && (
          <ClearStoredCheckbox
            checked={draft.clear.bank}
            label={t('clearStored')}
            onChange={(checked) => onChange({ ...draft, clear: { ...draft.clear, bank: checked } })}
          />
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="hr-edit-birth">{t('birthDate')}</Label>
        <Input
          id="hr-edit-birth"
          type="date"
          min="1900-01-01"
          max={vietnamToday()}
          value={draft.birth}
          disabled={draft.clear.birth}
          onChange={(ev) => onChange({ ...draft, birth: ev.target.value })}
          data-testid="hr-edit-birth"
        />
        {employee.birthDate !== null && (
          <ClearStoredCheckbox
            checked={draft.clear.birth}
            label={t('clearStored')}
            onChange={(checked) => onChange({ ...draft, clear: { ...draft.clear, birth: checked } })}
            testId="hr-edit-birth-clear"
          />
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="hr-edit-tax">{t('taxCode')}</Label>
        <Input
          {...fieldControl('hr-edit-tax', { error: Boolean(fields.of('taxCode')) })}
          value={draft.tax}
          inputMode="numeric"
          maxLength={20}
          autoComplete="off"
          disabled={draft.clear.tax}
          onChange={(ev) => {
            onChange({ ...draft, tax: ev.target.value });
            fields.edit('taxCode');
          }}
          onBlur={(ev) => {
            if (!draft.clear.tax) fields.blur('taxCode', ev.target.value);
          }}
        />
        <FieldError id="hr-edit-tax">{fields.of('taxCode')}</FieldError>
        {employee.taxCode !== null && (
          <ClearStoredCheckbox
            checked={draft.clear.tax}
            label={t('clearStored')}
            onChange={(checked) => {
              onChange({ ...draft, clear: { ...draft.clear, tax: checked } });
              if (checked) fields.edit('taxCode');
            }}
            testId="hr-edit-tax-clear"
          />
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="hr-edit-insurance">{t('insuranceNumber')}</Label>
        <Input
          {...fieldControl('hr-edit-insurance', { error: Boolean(fields.of('insuranceNumber')) })}
          value={draft.insurance}
          inputMode="numeric"
          maxLength={20}
          autoComplete="off"
          disabled={draft.clear.insurance}
          onChange={(ev) => {
            onChange({ ...draft, insurance: ev.target.value });
            fields.edit('insuranceNumber');
          }}
          onBlur={(ev) => {
            if (!draft.clear.insurance) fields.blur('insuranceNumber', ev.target.value);
          }}
        />
        <FieldError id="hr-edit-insurance">{fields.of('insuranceNumber')}</FieldError>
        {employee.insuranceNumber !== null && (
          <ClearStoredCheckbox
            checked={draft.clear.insurance}
            label={t('clearStored')}
            onChange={(checked) => {
              onChange({ ...draft, clear: { ...draft.clear, insurance: checked } });
              if (checked) fields.edit('insuranceNumber');
            }}
            testId="hr-edit-insurance-clear"
          />
        )}
      </div>
      <p className="text-xs text-subtle-foreground sm:col-span-2">{t('editHint')}</p>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" loading={pending} disabled={!hasChange} data-testid="hr-edit-save">
          {t('save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} data-testid="hr-edit-cancel">
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

export function AddForm({
  onClose,
  departments,
  entities,
}: {
  onClose: () => void;
  departments?: readonly HrDepartmentView[];
  entities?: readonly LegalEntity[];
}) {
  const t = useTranslations('hrEmployees');
  const deptQuery = useQuery({
    ...orpc.hr.departments.list.queryOptions({ input: { includeArchived: false } }),
    ...ONCE,
    enabled: departments === undefined,
  });
  const entitiesQuery = useQuery({
    ...orpc.legalEntities.list.queryOptions(),
    ...ONCE,
    enabled: entities === undefined,
  });
  const entityList = entities ?? entitiesQuery.data ?? [];
  const defaultEntityId = entityList.find((x) => x.isDefault)?.id ?? entityList[0]?.id ?? '';
  const [legalEntityId, setLegalEntityId] = useState('');
  const targetEntityId = legalEntityId || defaultEntityId;
  const entityDepartments = filterDepartmentsForEntity(departments ?? deptQuery.data ?? [], targetEntityId || null);
  const [name, setName] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [payFunctionManual, setPayFunctionManual] = useState(false);
  const [address, setAddress] = useState('');
  const [identity, setIdentity] = useState('');
  const [account, setAccount] = useState('');
  const [bank, setBank] = useState('');
  const [birth, setBirth] = useState('');
  const [tax, setTax] = useState('');
  const [insurance, setInsurance] = useState('');
  const [terms, setTerms] = useState(blankTerms);
  const contractErrors = previewContractCheck(terms).filter((item) => item.severity === 'error');
  const fields = useFieldErrors<'taxCode' | 'insuranceNumber'>((field) => {
    if (field === 'taxCode') return idNumberOk(tax) ? null : t('taxCodeInvalid');
    return idNumberOk(insurance) ? null : t('insuranceNumberInvalid');
  });
  const save = useMutation({
    mutationFn: () =>
      client.hr.payroll.employees.add({
        displayName: name.trim(),
        ...(targetEntityId ? { legalEntityId: targetEntityId } : {}),
        ...(departmentId ? { departmentId } : {}),
        ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(identity.trim() ? { identityNumber: identity.trim() } : {}),
        ...(account.trim() ? { accountNumber: account.trim() } : {}),
        ...(bank ? { bankCode: bank } : {}),
        ...(birth ? { birthDate: birth } : {}),
        ...(tax.trim() ? { taxCode: tax.trim() } : {}),
        ...(insurance.trim() ? { insuranceNumber: insurance.trim() } : {}),
        employment: buildEmploymentPayload(terms),
      }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const id = 'hr-add';
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim() === '' || !wageOk(terms.baseWage) || contractErrors.length > 0 || save.isPending) return;
    if (!fields.checkAll(['taxCode', 'insuranceNumber'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    save.mutate();
  };
  return (
    <Card className="mb-6 block p-4" aria-label={t('newTitle')} data-testid="hr-employee-form">
      <h2 className="text-base font-medium text-foreground">{t('newTitle')}</h2>
      <form noValidate onSubmit={submit}>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-name`}>{t('name')}</Label>
            <Input id={`${id}-name`} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </div>
          {entityList.length > 1 && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-legal-entity`}>{t('legalEntity')}</Label>
              <NativeSelect
                id={`${id}-legal-entity`}
                value={targetEntityId}
                onChange={(e) => {
                  setLegalEntityId(e.target.value);
                  setDepartmentId('');
                  setTerms((prev) => applyDepartmentDefaultPayFunction(prev, '', [], payFunctionManual));
                }}
                data-testid="hr-add-legal-entity"
              >
                {entityList.map((entity) => (
                  <NativeSelectOption key={entity.id} value={entity.id}>
                    {entity.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`${id}-department`}>{t('departments.field')}</Label>
            <NativeSelect
              id={`${id}-department`}
              value={departmentId}
              onChange={(e) => {
                const nextId = e.target.value;
                setDepartmentId(nextId);
                setTerms((prev) => applyDepartmentDefaultPayFunction(prev, nextId, entityDepartments, payFunctionManual));
              }}
              data-testid="hr-add-department"
            >
              <NativeSelectOption value="">{t('departments.unassigned')}</NativeSelectOption>
              {entityDepartments.map((d) => (
                <NativeSelectOption key={d.id} value={d.id}>
                  {d.code ? `${d.name} (${d.code})` : d.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-job-title`}>{t('jobTitle')}</Label>
            <Input
              id={`${id}-job-title`}
              value={jobTitle}
              maxLength={HR_JOB_TITLE_MAX}
              onChange={(e) => setJobTitle(e.target.value)}
              data-testid="hr-add-job-title"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-address`}>{t('address')}</Label>
            <Input id={`${id}-address`} value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-identity`}>{t('identityNumber')}</Label>
            <Input id={`${id}-identity`} value={identity} maxLength={30} autoComplete="off" onChange={(e) => setIdentity(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-account`}>{t('accountNumber')}</Label>
            <Input id={`${id}-account`} value={account} maxLength={34} autoComplete="off" onChange={(e) => setAccount(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-bank`}>{t('bankName')}</Label>
            <BankSelect id={`${id}-bank`} value={bank} onChange={setBank} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-birth`}>{t('birthDate')}</Label>
            <Input id={`${id}-birth`} type="date" min="1900-01-01" max={vietnamToday()} value={birth} onChange={(e) => setBirth(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-tax`}>{t('taxCode')}</Label>
            <Input
              {...fieldControl(`${id}-tax`, { error: Boolean(fields.of('taxCode')) })}
              value={tax}
              inputMode="numeric"
              maxLength={20}
              autoComplete="off"
              onChange={(e) => {
                setTax(e.target.value);
                fields.edit('taxCode');
              }}
              onBlur={(e) => fields.blur('taxCode', e.target.value)}
            />
            <FieldError id={`${id}-tax`}>{fields.of('taxCode')}</FieldError>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-insurance`}>{t('insuranceNumber')}</Label>
            <Input
              {...fieldControl(`${id}-insurance`, { error: Boolean(fields.of('insuranceNumber')) })}
              value={insurance}
              inputMode="numeric"
              maxLength={20}
              autoComplete="off"
              onChange={(e) => {
                setInsurance(e.target.value);
                fields.edit('insuranceNumber');
              }}
              onBlur={(e) => fields.blur('insuranceNumber', e.target.value)}
            />
            <FieldError id={`${id}-insurance`}>{fields.of('insuranceNumber')}</FieldError>
          </div>
          <TermsFields
            id={id}
            value={terms}
            onChange={(patch) => {
              if (patch.payFunction !== undefined) setPayFunctionManual(true);
              setTerms((s) => ({ ...s, ...patch }));
            }}
          />
        </div>
        <p className="mt-2 text-xs text-subtle-foreground">{t('sealedHint')}</p>
        {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="submit"
            loading={save.isPending}
            disabled={name.trim() === '' || !wageOk(terms.baseWage) || contractErrors.length > 0}
            data-testid="hr-employee-save"
          >
            {t('save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function Detail({
  employeeId,
  owner,
  onClose,
  departments,
  entities,
  members = [],
  orgName,
  orgTaxCode,
  orgAddress,
}: {
  employeeId: string;
  owner: boolean;
  onClose: () => void;
  departments?: readonly HrDepartmentView[];
  entities?: readonly LegalEntity[];
  members?: readonly OrgMemberOption[];
  orgName?: string | null;
  orgTaxCode?: string | null;
  orgAddress?: string | null;
}) {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  const signEnabled = useSignAppEnabled();
  // The opened numbers are not kept in the cache once the card closes (gcTime 0).
  const q = useQuery({ ...orpc.hr.payroll.employees.get.queryOptions({ input: { employeeId } }), ...ONCE, gcTime: 0 });
  const employmentSourceIdChunks: string[][] = [];
  if (signEnabled && q.data && !q.data.erased) {
    const ids = q.data.employments.map((row) => row.id);
    for (let i = 0; i < ids.length; i += SIGN_BY_SOURCE_MAX) {
      employmentSourceIdChunks.push(ids.slice(i, i + SIGN_BY_SOURCE_MAX));
    }
  }
  const signEnvelopeQueries = useQueries({
    queries: employmentSourceIdChunks.map((sourceIds) => ({
      ...orpc.sign.envelope.by_source.queryOptions({ input: { sourceKind: 'hr_contract', sourceIds } }),
      enabled: signEnabled && sourceIds.length > 0,
      retry: false,
      refetchInterval: (query: { state: { data: { items: SignEnvelopeBySourceItem[] } | undefined } }) =>
        signEnabled ? signEnvelopePollMs(query.state.data?.items) : false,
    })),
  });
  const signEnvelopesPending = signEnvelopeQueries.some((sq) => sq.isPending);
  const signEnvelopesError = signEnvelopeQueries.some((sq) => sq.isError);
  const signEnvelopeByEmployment = new Map<string, SignEnvelopeBySourceItem>();
  for (const sq of signEnvelopeQueries) {
    for (const item of sq.data?.items ?? []) {
      signEnvelopeByEmployment.set(item.sourceId, item);
    }
  }
  const deptQuery = useQuery({
    ...orpc.hr.departments.list.queryOptions({ input: { includeArchived: false } }),
    ...ONCE,
    enabled: departments === undefined,
  });
  const activeDepartments = (departments ?? deptQuery.data ?? []).filter((d) => d.archivedAt === null);
  const [shown, setShown] = useState(false);
  const [terms, setTerms] = useState(blankTerms);
  const [dep, setDep] = useState<{ name: string; relation: HrRelation; registeredOn: string }>({ name: '', relation: 'child', registeredOn: vietnamToday() });
  const [endedOn, setEndedOn] = useState(vietnamToday());
  const [edit, setEdit] = useState<EditEmployeeDraft | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [severanceOpen, setSeveranceOpen] = useState(false);
  const run = <V,>(fn: (v: V) => Promise<unknown>, after?: () => void) => ({
    mutationFn: fn,
    onSuccess: async () => {
      await refresh();
      after?.();
    },
  });
  const addTerms = useMutation(run(() => client.hr.payroll.employments.add({ employeeId, ...buildEmploymentPayload(terms) }), () => setTerms(blankTerms())));
  const downloadContractPdf = useMutation({
    mutationFn: (termsId: string) => client.hr.employee.contractPdf({ employeeId, termsId }),
    onSuccess: (result) => {
      triggerContractPdfDownload(result);
    },
  });
  const contractErrors = previewContractCheck(terms).filter((item) => item.severity === 'error');
  const addDependent = useMutation(
    run(
      () => client.hr.payroll.dependents.add({ employeeId, displayName: dep.name.trim(), relation: dep.relation, registeredOn: dep.registeredOn }),
      () => setDep((s) => ({ ...s, name: '' })),
    ),
  );
  const endDependent = useMutation(run((dependentId: string) => client.hr.payroll.dependents.end({ dependentId, endedOn: vietnamToday() })));
  const endEmployee = useMutation(run(() => client.hr.payroll.employees.end({ employeeId, endedOn })));
  const saveEdit = useMutation(
    run(
      (draft: EditEmployeeDraft) => client.hr.payroll.employees.edit(buildEditPayload(employeeId, draft)),
      () => setEdit(null),
    ),
  );
  const year = Number(vietnamToday().slice(0, 4));
  const authorize = useMutation(run((authorized: boolean) => client.hr.payroll.employees.finalization({ employeeId, year, authorized })));
  const linkMember = useMutation(run((userId: string | null) => client.hr.payroll.employees.linkMember({ employeeId, userId })));
  const linkableMembers = members.filter((m) => m.role !== 'viewer');
  const erase = useMutation(run(() => client.hr.payroll.employees.erase({ employeeId }), () => setConfirmErase(false)));
  if (q.isPending) return <TableSkeleton columns={3} />;
  if (q.error) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const e = q.data;
  const active = e.status === 'active' && !e.erased;
  const none = <span className="text-subtle-foreground">{t('none')}</span>;
  return (
    <Card className="mb-6 block p-4" data-testid="hr-employee-detail">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium text-foreground">{t('detailTitle', { name: e.displayName })}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      {e.contractAlerts.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1" data-testid="hr-employee-alerts">
          <ContractAlertBadges alerts={e.contractAlerts} />
        </div>
      )}
      {e.erased ? (
        <p className="mt-2 text-sm text-subtle-foreground" data-testid="hr-employee-erased">
          {t('erasedNote')}
        </p>
      ) : (
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-subtle-foreground">{t('departments.field')}</dt>
            <dd data-testid="hr-employee-department">{e.departmentName ?? none}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('jobTitle')}</dt>
            <dd data-testid="hr-employee-job-title">{e.jobTitle ?? none}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('linkedMember')}</dt>
            <dd data-testid="hr-employee-linked-member">
              {active && linkableMembers.length > 0 ? (
                <div className="mt-1 space-y-1">
                  <NativeSelect
                    className={PHONE_SELECT_TARGET}
                    aria-label={t('linkedMember')}
                    value={e.linkedUserId ?? ''}
                    disabled={linkMember.isPending}
                    onChange={(ev) => linkMember.mutate(ev.target.value || null)}
                    data-testid="hr-employee-link-member"
                  >
                    <NativeSelectOption value="">{t('noLinkedMember')}</NativeSelectOption>
                    {e.linkedUserId && !linkableMembers.some((m) => m.userId === e.linkedUserId) && (
                      <NativeSelectOption value={e.linkedUserId} disabled>
                        {e.linkedMemberName ?? e.linkedUserId}
                      </NativeSelectOption>
                    )}
                    {linkableMembers.map((m) => (
                      <NativeSelectOption key={m.userId} value={m.userId}>
                        {memberOptionLabel(m)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <p className="text-xs text-subtle-foreground">{t('linkedMemberHint')}</p>
                  {linkMember.error && <ErrorText>{errorMessage(linkMember.error)}</ErrorText>}
                </div>
              ) : (
                e.linkedMemberName ?? none
              )}
            </dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('address')}</dt>
            <dd>{e.address ?? none}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('identityNumber')}</dt>
            <dd data-testid="hr-employee-identity">{e.identityNumber === null ? none : shown ? e.identityNumber : '••••••••'}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('accountNumber')}</dt>
            <dd data-testid="hr-employee-account">{e.accountNumber === null ? none : shown ? e.accountNumber : '••••••••'}</dd>
            {(e.identityNumber !== null || e.accountNumber !== null || e.taxCode !== null || e.insuranceNumber !== null) && (
              <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShown((v) => !v)} data-testid="hr-employee-reveal">
                {shown ? t('hideNumbers') : t('showNumbers')}
              </Button>
            )}
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('bankName')}</dt>
            <dd data-testid="hr-employee-bank">{e.bankCode === null ? none : (bankByCode(e.bankCode)?.shortName ?? e.bankCode)}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('birthDate')}</dt>
            <dd data-testid="hr-employee-birth">{e.birthDate === null ? none : f.date(e.birthDate)}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('taxCode')}</dt>
            <dd data-testid="hr-employee-tax">{e.taxCode === null ? none : shown ? e.taxCode : '••••••••'}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('insuranceNumber')}</dt>
            <dd data-testid="hr-employee-insurance">{e.insuranceNumber === null ? none : shown ? e.insuranceNumber : '••••••••'}</dd>
          </div>
          {e.endedOn && (
            <div>
              <dt className="text-subtle-foreground">{t('endedOn')}</dt>
              <dd>{f.date(e.endedOn)}</dd>
            </div>
          )}
        </dl>
      )}

      {active && (
        <label className="mt-3 flex items-center gap-2 text-sm max-md:min-h-11" data-testid="hr-employee-authorized">
          <input type="checkbox" checked={e.finalizationAuthorizedYears.includes(year)} disabled={authorize.isPending} onChange={(ev) => authorize.mutate(ev.target.checked)} />
          {t('authorizedYear', { year: String(year) })}
        </label>
      )}
      {authorize.error && <ErrorText>{errorMessage(authorize.error)}</ErrorText>}

      {!e.erased && (
        <div className="mt-3">
          {edit === null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEdit(blankEditDraft())}
              data-testid="hr-employee-edit"
            >
              {t('edit')}
            </Button>
          ) : (
            <EditForm
              employee={e}
              departments={activeDepartments}
              draft={edit}
              onChange={setEdit}
              pending={saveEdit.isPending}
              onSubmit={() => saveEdit.mutate(edit)}
              onCancel={() => {
                saveEdit.reset();
                setEdit(null);
              }}
            />
          )}
          {saveEdit.error && <ErrorText>{errorMessage(saveEdit.error)}</ErrorText>}
        </div>
      )}

      <h3 className="mt-5 text-sm font-medium text-foreground">{t('termsTitle')}</h3>
      <DataTable
        head={
          e.erased
            ? [t('effectiveFrom'), t('contractType'), t('contractTermCol'), t('probationCol'), t('region'), t('baseWage')]
            : signEnabled
              ? [t('effectiveFrom'), t('contractType'), t('contractTermCol'), t('probationCol'), t('region'), t('baseWage'), t('sign.column'), '']
              : [t('effectiveFrom'), t('contractType'), t('contractTermCol'), t('probationCol'), t('region'), t('baseWage'), '']
        }
        numeric={[5]}
      >
        {e.employments.map((row) => {
          const employerEntity = entities?.find((ent) => ent.id === e.legalEntityId);
          return (
            <TableRow key={row.id} data-testid="hr-terms-row">
              <TableCell className="px-4 py-3">{f.date(row.effectiveFrom)}</TableCell>
              <TableCell className="px-4 py-3">{t(`contracts.${row.contractType}`)}</TableCell>
              <TableCell className="px-4 py-3">{formatContractTermSummary(t, f, row)}</TableCell>
              <TableCell className="px-4 py-3">{formatProbationSummary(t, f, row)}</TableCell>
              <TableCell className="px-4 py-3">{t('regionOption', { region: row.region })}</TableCell>
              <TableCell className={NUM}>{f.money(row.baseWage, 'VND')}</TableCell>
              {!e.erased && signEnabled && (
                <TableCell className="px-4 py-3" data-testid="hr-terms-sign-cell">
                  <div className="flex flex-wrap items-center gap-2">
                    <HrContractSignHandoff
                      source={{
                        employment: row,
                        employee: {
                          id: e.id,
                          displayName: e.displayName,
                          legalEntityId: e.legalEntityId,
                          departmentName: e.departmentName,
                          jobTitle: e.jobTitle,
                          address: e.address,
                          birthDate: e.birthDate,
                        },
                        employer: employerEntity
                          ? { name: employerEntity.name, taxCode: employerEntity.taxCode ?? orgTaxCode ?? null, address: orgAddress ?? null }
                          : orgName
                            ? { name: orgName, taxCode: orgTaxCode ?? null, address: orgAddress ?? null }
                            : null,
                      }}
                      canEdit={active}
                      signEnabled={signEnabled}
                      envelope={signEnvelopesPending ? null : (signEnvelopeByEmployment.get(row.id) ?? null)}
                      envelopeLoading={signEnvelopesPending || signEnvelopesError}
                    />
                  </div>
                </TableCell>
              )}
              {!e.erased && (
                <TableCell className="px-4 py-3 text-right">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={downloadContractPdf.isPending && downloadContractPdf.variables === row.id}
                    onClick={() => downloadContractPdf.mutate(row.id)}
                    data-testid="hr-terms-contract-pdf"
                  >
                    {t('downloadContractPdf')}
                  </Button>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </DataTable>
      {downloadContractPdf.error && (
        <div className="mt-2" role="alert" data-testid="hr-terms-contract-pdf-error">
          <ErrorText>{errorMessage(downloadContractPdf.error)}</ErrorText>
        </div>
      )}
      {active && (
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <TermsFields id="hr-terms" value={terms} onChange={(patch) => setTerms((s) => ({ ...s, ...patch }))} />
          <div className="sm:col-span-4">
            <Button loading={addTerms.isPending} disabled={!wageOk(terms.baseWage) || contractErrors.length > 0} onClick={() => addTerms.mutate()} data-testid="hr-terms-add">
              {t('addTerms')}
            </Button>
            <span className="ml-2 text-xs text-subtle-foreground">{t('termsHint')}</span>
          </div>
        </div>
      )}
      {addTerms.error && <ErrorText>{errorMessage(addTerms.error)}</ErrorText>}

      <h3 className="mt-5 text-sm font-medium text-foreground">{t('dependentsTitle')}</h3>
      {e.dependents.length === 0 ? (
        <p className="mt-1 text-sm text-subtle-foreground">{t('dependentsEmpty')}</p>
      ) : (
        <DataTable head={[t('name'), t('relation'), t('registeredOn'), '']}>
          {e.dependents.map((d) => (
            <TableRow key={d.id} data-testid="hr-dependent-row">
              <TableCell className="px-4 py-3">{d.displayName}</TableCell>
              <TableCell className="px-4 py-3">{t(`relations.${d.relation}`)}</TableCell>
              <TableCell className="px-4 py-3">
                {f.date(d.registeredOn)}
                {d.endedOn && (
                  <Badge className="ml-2" variant="secondary">
                    {t('dependentEnded', { date: f.date(d.endedOn) })}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="px-4 py-3 text-right">
                {active && d.endedOn === null && (
                  <Button variant="ghost" size="sm" loading={endDependent.isPending && endDependent.variables === d.id} onClick={() => endDependent.mutate(d.id)}>
                    {t('endDependent')}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
      {active && (
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="hr-dep-name">{t('name')}</Label>
            <Input id="hr-dep-name" value={dep.name} maxLength={200} onChange={(ev) => setDep({ ...dep, name: ev.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-dep-relation">{t('relation')}</Label>
            <NativeSelect id="hr-dep-relation" value={dep.relation} onChange={(ev) => setDep({ ...dep, relation: ev.target.value as HrRelation })}>
              {HR_RELATIONS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`relations.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-dep-from">{t('registeredOn')}</Label>
            <Input id="hr-dep-from" type="date" value={dep.registeredOn} onChange={(ev) => setDep({ ...dep, registeredOn: ev.target.value })} />
          </div>
          <div className="flex items-end">
            <Button loading={addDependent.isPending} disabled={dep.name.trim() === ''} onClick={() => addDependent.mutate()} data-testid="hr-dependent-add">
              {t('addDependent')}
            </Button>
          </div>
        </div>
      )}
      {(addDependent.error || endDependent.error) && <ErrorText>{errorMessage(addDependent.error ?? endDependent.error)}</ErrorText>}

      {!e.erased && (
        <div className="mt-5 space-y-4 border-t pt-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setLeaveOpen((v) => !v)} data-testid="hr-leave-toggle">
              {t('leave.toggle')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSeveranceOpen((v) => !v)} data-testid="hr-severance-toggle">
              {t('severance.toggle')}
            </Button>
          </div>
          {leaveOpen && <LeaveBalancePanel employeeId={e.id} />}
          {severanceOpen && <SeveranceCalculatorPanel employeeId={e.id} employeeEndedOn={e.endedOn} />}
        </div>
      )}

      {active && (
        <div className="mt-5 flex flex-wrap items-end gap-3 border-t pt-4">
          <div className="space-y-1">
            <Label htmlFor="hr-end-date">{t('endedOn')}</Label>
            <Input id="hr-end-date" type="date" value={endedOn} onChange={(ev) => setEndedOn(ev.target.value)} />
          </div>
          <Button variant="outline" loading={endEmployee.isPending} onClick={() => endEmployee.mutate()} data-testid="hr-employee-end">
            {t('endEmployee')}
          </Button>
        </div>
      )}
      {endEmployee.error && <ErrorText>{errorMessage(endEmployee.error)}</ErrorText>}

      {owner && e.status === 'ended' && !e.erased && (
        <div className="mt-5 border-t pt-4">
          <p className="text-xs text-subtle-foreground">{t('eraseHint')}</p>
          {confirmErase ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="destructive" loading={erase.isPending} onClick={() => erase.mutate()} data-testid="hr-employee-erase-confirm">
                {t('eraseConfirm')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmErase(false)}>
                {t('cancel')}
              </Button>
            </div>
          ) : (
            <Button className="mt-2" variant="outline" onClick={() => setConfirmErase(true)} data-testid="hr-employee-erase">
              {t('erase')}
            </Button>
          )}
          {erase.error &&
            (isStepUpRequired(erase.error) ? (
              // The erasure cannot be undone, so it asks for a fresh second factor; once verified, the same request is repeated.
              <div className="mt-3">
                <StepUpPrompt action={t('eraseConfirm')} onVerified={() => erase.mutate()} onCancel={() => erase.reset()} />
              </div>
            ) : (
              <ErrorText>{errorMessage(erase.error)}</ErrorText>
            ))}
        </div>
      )}
    </Card>
  );
}

function LeaveApprovalQueue() {
  const t = useTranslations('hrEmployees');
  const tm = useTranslations('hrMy');
  const f = useFormat();
  const [statusFilter, setStatusFilter] = useState<HrLeaveRequestStatus | ''>('');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const q = useQuery({
    ...orpc.hr.leaveRequests.list.queryOptions({
      input: {
        limit: 100,
        ...(statusFilter ? { status: statusFilter } : {}),
      },
    }),
    ...ONCE,
  });

  const approveL1 = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.leaveRequests.approveL1({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refresh,
  });
  const approveFinal = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.leaveRequests.approveFinal({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.leaveRequests.reject({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refresh,
  });

  const rows: readonly HrLeaveRequestView[] = q.data ?? [];

  return (
    <Card className="mt-6 block space-y-3 p-4" data-testid="hr-leave-queue">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">{t('leaveQueue.title')}</h2>
          <p className="text-xs text-subtle-foreground">{t('leaveQueue.subtitle')}</p>
        </div>
        <NativeSelect
          className={PHONE_SELECT_TARGET}
          aria-label={t('leaveQueue.filterLabel')}
          value={statusFilter}
          onChange={(ev) => setStatusFilter((ev.target.value || '') as HrLeaveRequestStatus | '')}
          data-testid="hr-leave-queue-filter"
        >
          <NativeSelectOption value="">{t('leaveQueue.filterAll')}</NativeSelectOption>
          {HR_LEAVE_REQUEST_STATUSES.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {tm(`leave.statuses.${s}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {approveL1.error && <ErrorText>{errorMessage(approveL1.error)}</ErrorText>}
      {approveFinal.error && <ErrorText>{errorMessage(approveFinal.error)}</ErrorText>}
      {reject.error && <ErrorText>{errorMessage(reject.error)}</ErrorText>}
      {q.isPending ? (
        <TableSkeleton columns={5} rows={2} />
      ) : q.error ? (
        <ErrorText>{errorMessage(q.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <p className="text-sm text-subtle-foreground" data-testid="hr-leave-queue-empty">
          {t('leaveQueue.empty')}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const note = notes[r.id]?.trim() || undefined;
            const pending = r.status === 'pending_l1' || r.status === 'pending_final';
            return (
              <div key={r.id} className="space-y-2 rounded-md border p-3 text-sm" data-testid="hr-leave-queue-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{r.employeeName}</span>
                    {r.departmentName && <Badge variant="outline">{r.departmentName}</Badge>}
                    <span>{tm('leave.dates', { start: f.date(r.startOn), end: f.date(r.endOn), days: r.days })}</span>
                    <Badge variant="outline">{tm(`leave.kinds.${r.kind}`)}</Badge>
                    <Badge variant="secondary">{tm(`leave.statuses.${r.status}`)}</Badge>
                  </div>
                </div>
                {r.reason && <p className="text-xs text-subtle-foreground">{r.reason}</p>}
                {(r.l1ApproverName || r.finalActedByName || r.decisionNote) && (
                  <p className="text-xs text-muted-foreground">
                    {[
                      r.l1ApproverName ? t('leaveQueue.l1Trail', { name: r.l1ApproverName }) : null,
                      r.finalActedByName ? t('leaveQueue.finalTrail', { name: r.finalActedByName }) : null,
                      r.decisionNote ?? null,
                    ]
                      .filter(Boolean)
                      .join(' - ')}
                  </p>
                )}
                {pending && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className={`min-w-48 flex-1 ${PHONE_INPUT_TARGET}`}
                      aria-label={t('leaveQueue.notePlaceholder')}
                      placeholder={t('leaveQueue.notePlaceholder')}
                      value={notes[r.id] ?? ''}
                      onChange={(ev) => setNotes((cur) => ({ ...cur, [r.id]: ev.target.value }))}
                      data-testid="hr-leave-queue-note"
                    />
                    {r.status === 'pending_l1' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        loading={approveL1.isPending && approveL1.variables?.requestId === r.id}
                        onClick={() => approveL1.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                        data-testid="hr-leave-queue-approve-l1"
                      >
                        {t('leaveQueue.approveL1')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      loading={approveFinal.isPending && approveFinal.variables?.requestId === r.id}
                      onClick={() => approveFinal.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                      data-testid="hr-leave-queue-approve-final"
                    >
                      {t('leaveQueue.approveFinal')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      loading={reject.isPending && reject.variables?.requestId === r.id}
                      onClick={() => reject.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                      data-testid="hr-leave-queue-reject"
                    >
                      {t('leaveQueue.reject')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function HrEmployeesPage() {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  const org = useQuery(orpc.org.get.queryOptions());
  const owner = org.data?.role === 'owner';
  const members: readonly OrgMemberOption[] = org.data?.members ?? [];
  const [showEnded, setShowEnded] = useState(false);
  const [showArchivedDepartments, setShowArchivedDepartments] = useState(false);
  const [departmentFilter, setDepartmentFilter] = useState('');
  const deptList = useQuery({
    ...orpc.hr.departments.list.queryOptions({ input: { includeArchived: showArchivedDepartments } }),
    ...ONCE,
  });
  const departments: readonly HrDepartmentView[] = deptList.data ?? [];
  const activeDepartments = departments.filter((d) => d.archivedAt === null);
  const entitiesQuery = useQuery({ ...orpc.legalEntities.list.queryOptions(), ...ONCE });
  const entities: readonly LegalEntity[] = entitiesQuery.data ?? [];
  const visibleDepartmentFilter = resolveVisibleDepartmentFilter(departmentFilter, departments, deptList.data !== undefined);
  const list = useQuery({
    ...orpc.hr.payroll.employees.list.queryOptions({
      input: {
        status: showEnded ? 'all' : 'active',
        ...(visibleDepartmentFilter ? { departmentId: visibleDepartmentFilter } : {}),
        limit: 200,
      },
    }),
    ...ONCE,
  });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows: readonly HrEmployeeSummary[] = list.data ?? [];
  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button disabled={adding} onClick={() => setAdding(true)} data-testid="hr-employee-new">
            {t('new')}
          </Button>
        }
      />
      <DepartmentsSection
        departments={departments}
        entities={entities}
        members={members}
        showArchived={showArchivedDepartments}
        onShowArchivedChange={(next) => {
          setShowArchivedDepartments(next);
          if (!next && departmentFilter !== '' && !activeDepartments.some((d) => d.id === departmentFilter)) {
            setDepartmentFilter('');
          }
        }}
        loading={deptList.isPending}
        error={deptList.error}
      />
      {adding && <AddForm departments={activeDepartments} entities={entities} onClose={() => setAdding(false)} />}
      {open && (
        <Detail
          key={open}
          employeeId={open}
          owner={owner}
          departments={activeDepartments}
          entities={entities}
          members={members}
          orgName={org.data?.name ?? null}
          orgTaxCode={org.data?.taxCode ?? null}
          orgAddress={org.data?.address ?? null}
          onClose={() => setOpen(null)}
        />
      )}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="hr-emp-dept-filter" className="text-xs text-subtle-foreground">
            {t('departments.filterLabel')}
          </Label>
          <NativeSelect
            id="hr-emp-dept-filter"
            value={visibleDepartmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            data-testid="hr-employee-dept-filter"
          >
            <NativeSelectOption value="">{t('departments.allDepartments')}</NativeSelectOption>
            {departments.map((d) => (
              <NativeSelectOption key={d.id} value={d.id}>
                {formatDepartmentFilterOptionLabel(d, entities, t('departments.archivedBadge'))}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <label className="flex items-center gap-1 text-xs text-subtle-foreground max-md:min-h-11">
          <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
          {t('showEnded')}
        </label>
      </div>
      {list.isPending ? (
        <TableSkeleton columns={6} />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <DataTable head={[t('name'), t('departmentAndTitle'), t('contractType'), t('region'), t('baseWage'), '']} numeric={[4]}>
          {rows.map((r) => {
            const deptLabel = [r.departmentName, r.jobTitle].filter(Boolean).join(' - ');
            return (
              <TableRow key={r.id} data-testid="hr-employee-row">
                <TableCell className="px-4 py-3">
                  {r.displayName}
                  {r.status === 'ended' && (
                    <Badge className="ml-2" variant="secondary">
                      {t('ended')}
                    </Badge>
                  )}
                  <ContractAlertBadges alerts={r.contractAlerts} />
                </TableCell>
                <TableCell className="px-4 py-3" data-testid="hr-employee-dept-cell">
                  {deptLabel || '-'}
                </TableCell>
                <TableCell className="px-4 py-3">{r.current ? t(`contracts.${r.current.contractType}`) : '-'}</TableCell>
                <TableCell className="px-4 py-3">{r.current ? t('regionOption', { region: r.current.region }) : '-'}</TableCell>
                <TableCell className={NUM}>{r.current ? f.money(r.current.baseWage, 'VND') : '-'}</TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => setOpen(r.id)} data-testid="hr-employee-open">
                    {t('open')}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </DataTable>
      )}
      <LeaveApprovalQueue />
    </>
  );
}

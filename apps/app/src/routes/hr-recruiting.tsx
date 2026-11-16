// SPDX-License-Identifier: AGPL-3.0-only
// "Tuyển dụng", the lightweight recruiting screen of the HR app (#3425, Part of #3403 Stage 3 slice 3b-2):
// job openings, candidate pipeline, calendar interview scheduling without candidate PII in calendar titles,
// 1-click hire to payroll employee + initial employment, R3 candidate erasure, and Ly pseudonymized screening brief.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import {
  HR_CANDIDATE_STAGES,
  HR_CANDIDATE_TRANSITION_STAGES,
  HR_CONTRACT_TYPES,
  HR_PAY_FUNCTIONS,
  HR_REGIONS,
  vietnamToday,
  type HrCandidateStage,
  type HrCandidateView,
  type HrContractType,
  type HrDepartmentView,
  type HrOpeningView,
  type HrPayFunction,
  type HrRecruitingBriefResult,
  type HrRegion,
  type LegalEntity,
} from '@crove/kernel-contract';
import { checkCandidateTransition } from '@crove/l10n-vn';
import { Alert } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Textarea } from '@crove/ui/components/textarea';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const NUM = 'px-4 py-3 text-right tabular-nums';
const WAGE_RE = /^\d{1,16}(\.\d{1,2})?$/;

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });

export function parseSkillsInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export type HireFormDraft = {
  effectiveFrom: string;
  baseWage: string;
  contractType: HrContractType;
  region: HrRegion;
  payFunction: HrPayFunction;
  departmentId: string;
  jobTitle: string;
  termMonths: string;
  contractEndOn: string;
  allowDirectHire: boolean;
};

export type HireDraftField = keyof HireFormDraft;

export function buildHireDefaults(candidate: HrCandidateView, opening: HrOpeningView | null | undefined) {
  return {
    effectiveFrom: candidate.plannedStartOn ?? vietnamToday(),
    baseWage: candidate.agreedWage ?? candidate.expectedWage ?? '',
    contractType: (opening?.contractType ?? 'indefinite') as HrContractType,
    region: (opening?.region ?? 'I') as HrRegion,
    payFunction: (opening?.payFunction ?? 'admin') as HrPayFunction,
    departmentId: opening?.departmentId ?? candidate.departmentId ?? '',
    jobTitle: opening?.title ?? candidate.openingTitle ?? '',
  };
}

export function mergeHireDraft(
  current: HireFormDraft,
  dirtyFields: ReadonlySet<HireDraftField>,
  nextDefaults: Omit<HireFormDraft, 'termMonths' | 'contractEndOn' | 'allowDirectHire'>,
): HireFormDraft {
  return {
    effectiveFrom: dirtyFields.has('effectiveFrom') ? current.effectiveFrom : nextDefaults.effectiveFrom,
    baseWage: dirtyFields.has('baseWage') ? current.baseWage : nextDefaults.baseWage,
    contractType: dirtyFields.has('contractType') ? current.contractType : nextDefaults.contractType,
    region: dirtyFields.has('region') ? current.region : nextDefaults.region,
    payFunction: dirtyFields.has('payFunction') ? current.payFunction : nextDefaults.payFunction,
    departmentId: dirtyFields.has('departmentId') ? current.departmentId : nextDefaults.departmentId,
    jobTitle: dirtyFields.has('jobTitle') ? current.jobTitle : nextDefaults.jobTitle,
    termMonths: current.termMonths,
    contractEndOn: current.contractEndOn,
    allowDirectHire: current.allowDirectHire,
  };
}

export function formatLocalDateTimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function OpeningForm({
  opening,
  departments,
  entities,
  onClose,
}: {
  opening?: HrOpeningView;
  departments: readonly HrDepartmentView[];
  entities: readonly LegalEntity[];
  onClose: () => void;
}) {
  const t = useTranslations('hrRecruiting');
  const defaultEntityId = entities.find((e) => e.isDefault)?.id ?? entities[0]?.id ?? '';
  const [legalEntityId, setLegalEntityId] = useState(opening?.legalEntityId ?? '');
  const targetEntityId = legalEntityId || defaultEntityId;
  const entityDepartments = departments.filter((d) => d.archivedAt === null && (!targetEntityId || d.legalEntityId === targetEntityId));
  const initialDeptId = opening?.departmentId && entityDepartments.some((d) => d.id === opening.departmentId) ? opening.departmentId : '';

  const [title, setTitle] = useState(opening?.title ?? '');
  const [departmentId, setDepartmentId] = useState(initialDeptId);
  const [departmentName, setDepartmentName] = useState(opening?.departmentName ?? '');
  const [contractType, setContractType] = useState<HrContractType>(opening?.contractType ?? 'indefinite');
  const [region, setRegion] = useState<HrRegion>(opening?.region ?? 'I');
  const [payFunction, setPayFunction] = useState<HrPayFunction>(opening?.payFunction ?? 'admin');
  const [payFunctionManual, setPayFunctionManual] = useState(false);
  const [budgetMinWage, setBudgetMinWage] = useState(opening?.budgetMinWage ?? '');
  const [budgetMaxWage, setBudgetMaxWage] = useState(opening?.budgetMaxWage ?? '');
  const [skillsText, setSkillsText] = useState(opening ? opening.requiredSkills.join(', ') : '');

  const minOk = budgetMinWage.trim() === '' || WAGE_RE.test(budgetMinWage.trim());
  const maxOk = budgetMaxWage.trim() === '' || WAGE_RE.test(budgetMaxWage.trim());
  const canSave = title.trim().length > 0 && minOk && maxOk;

  const save = useMutation({
    mutationFn: () => {
      const skills = parseSkillsInput(skillsText);
      const cleanDeptName = departmentName.trim() || null;
      const minVal = budgetMinWage.trim() || null;
      const maxVal = budgetMaxWage.trim() || null;
      if (opening) {
        return client.hr.recruiting.openings.edit({
          openingId: opening.id,
          departmentId: departmentId || null,
          title: title.trim(),
          departmentName: cleanDeptName,
          contractType,
          region,
          payFunction,
          budgetMinWage: minVal,
          budgetMaxWage: maxVal,
          requiredSkills: skills,
        });
      }
      return client.hr.recruiting.openings.add({
        ...(targetEntityId ? { legalEntityId: targetEntityId } : {}),
        ...(departmentId ? { departmentId } : {}),
        title: title.trim(),
        ...(cleanDeptName ? { departmentName: cleanDeptName } : {}),
        contractType,
        region,
        payFunction,
        ...(minVal ? { budgetMinWage: minVal } : {}),
        ...(maxVal ? { budgetMaxWage: maxVal } : {}),
        requiredSkills: skills,
      });
    },
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  return (
    <Card className="mb-6 block p-4" data-testid="hr-opening-form">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-medium text-foreground">{opening ? t('openingForm.editTitle') : t('openingForm.newTitle')}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {!opening && entities.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor="hr-open-entity">{t('fields.legalEntity')}</Label>
            <NativeSelect
              id="hr-open-entity"
              value={targetEntityId}
              onChange={(e) => {
                setLegalEntityId(e.target.value);
                setDepartmentId('');
              }}
            >
              {entities.map((e) => (
                <NativeSelectOption key={e.id} value={e.id}>
                  {e.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="hr-open-title">{t('fields.openingTitle')}</Label>
          <Input id="hr-open-title" maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="hr-opening-title" />
        </div>
        {entityDepartments.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor="hr-open-dept-id">{t('fields.department')}</Label>
            <NativeSelect
              id="hr-open-dept-id"
              value={departmentId}
              onChange={(e) => {
                const nextId = e.target.value;
                setDepartmentId(nextId);
                const chosen = entityDepartments.find((d) => d.id === nextId);
                if (chosen) {
                  setDepartmentName(chosen.name);
                  if (!payFunctionManual) setPayFunction(chosen.payFunction);
                }
              }}
            >
              <NativeSelectOption value="">{t('fields.noDepartment')}</NativeSelectOption>
              {entityDepartments.map((d) => (
                <NativeSelectOption key={d.id} value={d.id}>
                  {d.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="hr-open-dept-name">{t('fields.departmentName')}</Label>
          <Input id="hr-open-dept-name" maxLength={120} value={departmentName} onChange={(e) => setDepartmentName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-open-contract">{t('fields.contractType')}</Label>
          <NativeSelect id="hr-open-contract" value={contractType} onChange={(e) => setContractType(e.target.value as HrContractType)}>
            {HR_CONTRACT_TYPES.map((ct) => (
              <NativeSelectOption key={ct} value={ct}>
                {t(`contracts.${ct}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-open-region">{t('fields.region')}</Label>
          <NativeSelect id="hr-open-region" value={region} onChange={(e) => setRegion(e.target.value as HrRegion)}>
            {HR_REGIONS.map((r) => (
              <NativeSelectOption key={r} value={r}>
                {t('regionOption', { region: r })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-open-payfn">{t('fields.payFunction')}</Label>
          <NativeSelect
            id="hr-open-payfn"
            value={payFunction}
            onChange={(e) => {
              setPayFunctionManual(true);
              setPayFunction(e.target.value as HrPayFunction);
            }}
          >
            {HR_PAY_FUNCTIONS.map((pf) => (
              <NativeSelectOption key={pf} value={pf}>
                {t(`payFunctions.${pf}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-open-min">{t('fields.budgetMin')}</Label>
          <Input id="hr-open-min" inputMode="numeric" value={budgetMinWage} onChange={(e) => setBudgetMinWage(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-open-max">{t('fields.budgetMax')}</Label>
          <Input id="hr-open-max" inputMode="numeric" value={budgetMaxWage} onChange={(e) => setBudgetMaxWage(e.target.value)} />
        </div>
        <div className="space-y-1 sm:col-span-2 lg:col-span-3">
          <Label htmlFor="hr-open-skills">{t('fields.requiredSkills')}</Label>
          <Input id="hr-open-skills" value={skillsText} onChange={(e) => setSkillsText(e.target.value)} placeholder={t('skillsPlaceholder')} />
        </div>
      </div>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <div className="mt-4 flex gap-2">
        <Button loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()} data-testid="hr-opening-save">
          {t('save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </Card>
  );
}

export function CandidateForm({
  candidate,
  openings,
  defaultOpeningId,
  onClose,
}: {
  candidate?: HrCandidateView;
  openings: readonly HrOpeningView[];
  defaultOpeningId?: string;
  onClose: () => void;
}) {
  const t = useTranslations('hrRecruiting');
  const openOptions = openings.filter((o) => o.status === 'open' || o.id === candidate?.openingId);
  const [openingId, setOpeningId] = useState(candidate?.openingId ?? defaultOpeningId ?? '');
  const [displayName, setDisplayName] = useState(candidate?.displayName ?? '');
  const [email, setEmail] = useState(candidate?.email ?? '');
  const [phone, setPhone] = useState(candidate?.phone ?? '');
  const [yearsExperience, setYearsExperience] = useState(candidate?.yearsExperience !== null && candidate?.yearsExperience !== undefined ? String(candidate.yearsExperience) : '');
  const [skillsText, setSkillsText] = useState(candidate ? candidate.matchedSkills.join(', ') : '');
  const [expectedWage, setExpectedWage] = useState(candidate?.expectedWage ?? '');
  const [agreedWage, setAgreedWage] = useState(candidate?.agreedWage ?? '');
  const [plannedStartOn, setPlannedStartOn] = useState(candidate?.plannedStartOn ?? '');
  const [notes, setNotes] = useState(candidate?.notes ?? '');

  const expectedOk = expectedWage.trim() === '' || WAGE_RE.test(expectedWage.trim());
  const agreedOk = agreedWage.trim() === '' || WAGE_RE.test(agreedWage.trim());
  const yearsNum = yearsExperience.trim() === '' ? null : Number(yearsExperience.trim());
  const yearsOk = yearsNum === null || (Number.isInteger(yearsNum) && yearsNum >= 0 && yearsNum <= 80);
  const canSave = displayName.trim().length > 0 && expectedOk && agreedOk && yearsOk;

  const save = useMutation({
    mutationFn: () => {
      const skills = parseSkillsInput(skillsText);
      const cleanEmail = email.trim() || null;
      const cleanPhone = phone.trim() || null;
      const cleanExpected = expectedWage.trim() || null;
      const cleanAgreed = agreedWage.trim() || null;
      const cleanStart = plannedStartOn.trim() || null;
      const cleanNotes = notes.trim() || null;
      if (candidate) {
        return client.hr.recruiting.candidates.edit({
          candidateId: candidate.id,
          openingId: openingId || null,
          displayName: displayName.trim(),
          email: cleanEmail,
          phone: cleanPhone,
          yearsExperience: yearsNum,
          matchedSkills: skills,
          expectedWage: cleanExpected,
          agreedWage: cleanAgreed,
          plannedStartOn: cleanStart,
          notes: cleanNotes,
        });
      }
      return client.hr.recruiting.candidates.add({
        ...(openingId ? { openingId } : {}),
        displayName: displayName.trim(),
        ...(cleanEmail ? { email: cleanEmail } : {}),
        ...(cleanPhone ? { phone: cleanPhone } : {}),
        ...(yearsNum !== null ? { yearsExperience: yearsNum } : {}),
        matchedSkills: skills,
        ...(cleanExpected ? { expectedWage: cleanExpected } : {}),
        ...(cleanAgreed ? { agreedWage: cleanAgreed } : {}),
        ...(cleanStart ? { plannedStartOn: cleanStart } : {}),
        ...(cleanNotes ? { notes: cleanNotes } : {}),
      });
    },
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  return (
    <Card className="mb-6 block p-4" data-testid="hr-candidate-form">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-medium text-foreground">{candidate ? t('candidateForm.editTitle') : t('candidateForm.newTitle')}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="hr-cand-name">{t('fields.candidateName')}</Label>
          <Input id="hr-cand-name" maxLength={200} value={displayName} onChange={(e) => setDisplayName(e.target.value)} data-testid="hr-candidate-name" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-cand-opening">{t('fields.opening')}</Label>
          <NativeSelect id="hr-cand-opening" value={openingId} onChange={(e) => setOpeningId(e.target.value)}>
            <NativeSelectOption value="">{t('fields.noOpening')}</NativeSelectOption>
            {openOptions.map((o) => (
              <NativeSelectOption key={o.id} value={o.id}>
                {o.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-cand-email">{t('fields.email')}</Label>
          <Input id="hr-cand-email" type="email" maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-cand-phone">{t('fields.phone')}</Label>
          <Input id="hr-cand-phone" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-cand-exp">{t('fields.yearsExperience')}</Label>
          <Input id="hr-cand-exp" inputMode="numeric" value={yearsExperience} onChange={(e) => setYearsExperience(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-cand-expected">{t('fields.expectedWage')}</Label>
          <Input id="hr-cand-expected" inputMode="numeric" value={expectedWage} onChange={(e) => setExpectedWage(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-cand-agreed">{t('fields.agreedWage')}</Label>
          <Input id="hr-cand-agreed" inputMode="numeric" value={agreedWage} onChange={(e) => setAgreedWage(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-cand-start">{t('fields.plannedStartOn')}</Label>
          <Input id="hr-cand-start" type="date" value={plannedStartOn} onChange={(e) => setPlannedStartOn(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-cand-skills">{t('fields.matchedSkills')}</Label>
          <Input id="hr-cand-skills" value={skillsText} onChange={(e) => setSkillsText(e.target.value)} placeholder={t('skillsPlaceholder')} />
        </div>
        <div className="space-y-1 sm:col-span-2 lg:col-span-3">
          <Label htmlFor="hr-cand-notes">{t('fields.notes')}</Label>
          <Textarea id="hr-cand-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <div className="mt-4 flex gap-2">
        <Button loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()} data-testid="hr-candidate-save">
          {t('save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </Card>
  );
}

export function RecruitingBriefPanel({
  candidateId,
  candidateVersion = '',
}: {
  candidateId: string;
  candidateVersion?: string;
}) {
  const t = useTranslations('hrRecruiting');
  const locale = useLocale();
  const lang = locale === 'en' ? 'en' : 'vi';
  const versionKey = `${candidateId}:${lang}:${candidateVersion}`;
  const currentVersionRef = useRef(versionKey);
  currentVersionRef.current = versionKey;
  const [briefState, setBriefState] = useState<{ key: string; result: HrRecruitingBriefResult } | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: async (requestedKey: string) => {
      const result = await client.hr.recruiting.brief({ candidateId, lang });
      return { requestedKey, result };
    },
    onSuccess: ({ requestedKey, result }) => {
      if (requestedKey !== currentVersionRef.current) return;
      setErrorKey(null);
      setBriefState({ key: requestedKey, result });
    },
    onError: (_err, requestedKey) => {
      if (requestedKey === currentVersionRef.current) setErrorKey(requestedKey);
    },
  });

  const brief = briefState?.key === versionKey ? briefState.result : null;
  const showError = Boolean(ask.error) && errorKey === versionKey;

  return (
    <section className="mt-4 border-t pt-4" data-testid="hr-recruiting-ly-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('ly.title')}</h3>
          <p className="text-xs text-subtle-foreground">{t('ly.subtitle')}</p>
        </div>
        <Button size="sm" variant="outline" loading={ask.isPending} onClick={() => ask.mutate(versionKey)} data-testid="hr-recruiting-ly-brief">
          {t('ly.run')}
        </Button>
      </div>
      {showError && ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
      {brief && (
        <div className="mt-3 space-y-2 rounded-md border bg-muted/20 p-3 text-sm" data-testid="hr-recruiting-ly-result">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{t(`ly.wageComparisons.${brief.readiness.wageComparison}`)}</Badge>
            <Badge variant="secondary">
              {t('ly.skillsProgress', {
                matched: String(brief.readiness.skillsMatchedCount),
                required: String(brief.readiness.skillsRequiredCount),
              })}
            </Badge>
            {brief.readiness.flags.map((flag) => (
              <Badge key={flag} variant="secondary">
                {t(`ly.flags.${flag}`)}
              </Badge>
            ))}
          </div>
          <p className="text-foreground">{brief.summary}</p>
          <p className="text-xs text-muted-foreground">{t(`ly.aiStatus.${brief.ai.reason}`)}</p>
          {brief.strengths.length > 0 && (
            <div>
              <p className="text-xs font-medium text-foreground">{t('ly.strengths')}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {brief.strengths.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {brief.risks.length > 0 && (
            <div>
              <p className="text-xs font-medium text-foreground">{t('ly.risks')}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {brief.risks.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {brief.interviewQuestions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-foreground">{t('ly.questions')}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {brief.interviewQuestions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function InterviewSchedulePanel({ candidate }: { candidate: HrCandidateView }) {
  const t = useTranslations('hrRecruiting');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState(45);
  const [customStart, setCustomStart] = useState(candidate.interviewStartsAt ? formatLocalDateTimeInput(candidate.interviewStartsAt) : '');
  const [customDuration, setCustomDuration] = useState(45);

  const slotsQuery = useQuery({
    ...orpc.hr.recruiting.interviewSlots.queryOptions({
      input: {
        durationMinutes,
        maxSlots: 8,
        ...(candidate.interviewEventId ? { exceptEventId: candidate.interviewEventId } : {}),
      },
    }),
    enabled: open,
    ...ONCE,
  });

  const schedule = useMutation({
    mutationFn: (slot: { startsAt: string; endsAt: string }) =>
      client.hr.recruiting.candidates.scheduleInterview({ candidateId: candidate.id, ...slot }),
    onSuccess: async () => {
      await refresh();
      setOpen(false);
    },
  });

  const canSchedule = candidate.stage !== 'hired' && candidate.stage !== 'rejected' && candidate.erasedAt === null;

  return (
    <section className="mt-4 border-t pt-4" data-testid="hr-interview-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('interview.title')}</h3>
          <p className="text-xs text-subtle-foreground">
            {candidate.interviewStartsAt ? t('interview.current', { at: f.dateTime(candidate.interviewStartsAt) }) : t('interview.none')}
          </p>
        </div>
        {canSchedule && (
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)} data-testid="hr-interview-toggle">
            {candidate.interviewStartsAt ? t('interview.reschedule') : t('interview.pickSlot')}
          </Button>
        )}
      </div>
      {open && canSchedule && (
        <div className="mt-3 space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-3">
            <Label htmlFor="hr-slot-duration">{t('interview.duration')}</Label>
            <NativeSelect id="hr-slot-duration" value={String(durationMinutes)} onChange={(e) => setDurationMinutes(Number(e.target.value))}>
              {[30, 45, 60, 90].map((m) => (
                <NativeSelectOption key={m} value={String(m)}>
                  {t('interview.minutes', { count: String(m) })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {slotsQuery.data && !slotsQuery.data.hoursSaved && (
            <Alert>{t('interview.defaultHoursNote', { tz: slotsQuery.data.timeZone })}</Alert>
          )}
          {slotsQuery.isPending ? (
            <p className="text-xs text-muted-foreground">{t('loading')}</p>
          ) : slotsQuery.error ? (
            <ErrorText>{errorMessage(slotsQuery.error)}</ErrorText>
          ) : (slotsQuery.data?.slots.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">{t('interview.noSlots')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slotsQuery.data?.slots.map((s) => (
                <Button
                  key={s.startIso}
                  size="sm"
                  variant="secondary"
                  loading={schedule.isPending}
                  onClick={() => schedule.mutate({ startsAt: s.startIso, endsAt: s.endIso })}
                  data-testid="hr-interview-slot"
                >
                  {f.dateTime(s.startIso)}
                </Button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2 border-t pt-2">
            <div className="space-y-1">
              <Label htmlFor="hr-slot-custom">{t('interview.customStart')}</Label>
              <Input id="hr-slot-custom" type="datetime-local" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hr-slot-custom-dur">{t('interview.duration')}</Label>
              <Input
                id="hr-slot-custom-dur"
                type="number"
                min={15}
                max={240}
                className="w-24"
                value={customDuration}
                onChange={(e) => setCustomDuration(Number(e.target.value))}
              />
            </div>
            <Button
              size="sm"
              loading={schedule.isPending}
              disabled={!customStart || customDuration < 15 || customDuration > 240}
              onClick={() => {
                const startMs = new Date(customStart).getTime();
                if (!Number.isFinite(startMs)) return;
                schedule.mutate({
                  startsAt: new Date(startMs).toISOString(),
                  endsAt: new Date(startMs + customDuration * 60_000).toISOString(),
                });
              }}
            >
              {t('interview.bookCustom')}
            </Button>
          </div>
          {schedule.error && <ErrorText>{errorMessage(schedule.error)}</ErrorText>}
        </div>
      )}
    </section>
  );
}

export function HireCandidatePanel({
  candidate,
  opening,
  departments,
}: {
  candidate: HrCandidateView;
  opening: HrOpeningView | null | undefined;
  departments: readonly HrDepartmentView[];
}) {
  const t = useTranslations('hrRecruiting');
  const entityDepartments = departments.filter((d) => d.archivedAt === null && d.legalEntityId === candidate.legalEntityId);
  const rawDefaults = buildHireDefaults(candidate, opening);
  const defaultDepartmentId = entityDepartments.some((d) => d.id === rawDefaults.departmentId) ? rawDefaults.departmentId : '';
  const initialDraft: HireFormDraft = {
    ...rawDefaults,
    departmentId: defaultDepartmentId,
    termMonths: '',
    contractEndOn: '',
    allowDirectHire: false,
  };

  const candidateIdRef = useRef(candidate.id);
  const dirtyRef = useRef(new Set<HireDraftField>());
  const [draft, setDraft] = useState<HireFormDraft>(initialDraft);

  useEffect(() => {
    const nextDefaults = {
      effectiveFrom: rawDefaults.effectiveFrom,
      baseWage: rawDefaults.baseWage,
      contractType: rawDefaults.contractType,
      region: rawDefaults.region,
      payFunction: rawDefaults.payFunction,
      departmentId: defaultDepartmentId,
      jobTitle: rawDefaults.jobTitle,
    };
    if (candidateIdRef.current !== candidate.id) {
      candidateIdRef.current = candidate.id;
      dirtyRef.current.clear();
      setDraft({ ...nextDefaults, termMonths: '', contractEndOn: '', allowDirectHire: false });
      return;
    }
    setDraft((prev) => mergeHireDraft(prev, dirtyRef.current, nextDefaults));
  }, [
    candidate.id,
    candidate.openingId,
    rawDefaults.effectiveFrom,
    rawDefaults.baseWage,
    rawDefaults.contractType,
    rawDefaults.region,
    rawDefaults.payFunction,
    defaultDepartmentId,
    rawDefaults.jobTitle,
  ]);

  const updateField = <K extends HireDraftField>(field: K, value: HireFormDraft[K]) => {
    dirtyRef.current.add(field);
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const needsOverride = candidate.stage !== 'offer' && candidate.stage !== 'hired';
  const trimmedTermMonths = draft.termMonths.trim();
  const parsedTermMonths = trimmedTermMonths === '' ? null : Number(trimmedTermMonths);
  const termMonthsValid =
    parsedTermMonths === null || (Number.isInteger(parsedTermMonths) && parsedTermMonths >= 1 && parsedTermMonths <= 36);
  const fixedTermMissing = draft.contractType === 'fixed_term' && parsedTermMonths === null && draft.contractEndOn === '';
  const fixedTermEndBeforeStart =
    draft.contractType === 'fixed_term' && draft.contractEndOn !== '' && draft.effectiveFrom !== '' && draft.contractEndOn < draft.effectiveFrom;
  const fixedTermValid = draft.contractType !== 'fixed_term' || (termMonthsValid && !fixedTermMissing && !fixedTermEndBeforeStart);

  const hire = useMutation({
    mutationFn: () =>
      client.hr.recruiting.candidates.hire({
        candidateId: candidate.id,
        effectiveFrom: draft.effectiveFrom,
        baseWage: draft.baseWage.trim(),
        contractType: draft.contractType,
        region: draft.region,
        payFunction: draft.payFunction,
        ...(draft.contractType === 'fixed_term' && parsedTermMonths !== null ? { termMonths: parsedTermMonths } : {}),
        ...(draft.contractType === 'fixed_term' && draft.contractEndOn ? { contractEndOn: draft.contractEndOn } : {}),
        ...(draft.departmentId ? { departmentId: draft.departmentId } : { departmentId: null }),
        ...(draft.jobTitle.trim() ? { jobTitle: draft.jobTitle.trim() } : { jobTitle: null }),
        allowDirectHire: draft.allowDirectHire,
      }),
    onSuccess: async () => {
      await refresh();
    },
  });

  if (candidate.stage === 'hired' && candidate.hiredEmployeeId) {
    return (
      <section className="mt-4 border-t pt-4" data-testid="hr-hire-done">
        <Alert>{t('hire.completed', { employeeId: candidate.hiredEmployeeId })}</Alert>
      </section>
    );
  }
  if (candidate.stage === 'rejected' || candidate.erasedAt !== null) return null;

  const canSubmit =
    draft.effectiveFrom.trim() !== '' && WAGE_RE.test(draft.baseWage.trim()) && fixedTermValid && (!needsOverride || draft.allowDirectHire);

  return (
    <section className="mt-4 border-t pt-4" data-testid="hr-hire-panel">
      <h3 className="mb-2 text-sm font-medium text-foreground">{t('hire.title')}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="hr-hire-date">{t('fields.plannedStartOn')}</Label>
          <Input id="hr-hire-date" type="date" value={draft.effectiveFrom} onChange={(e) => updateField('effectiveFrom', e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-hire-wage">{t('fields.agreedWage')}</Label>
          <Input id="hr-hire-wage" inputMode="numeric" value={draft.baseWage} onChange={(e) => updateField('baseWage', e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-hire-title">{t('fields.jobTitle')}</Label>
          <Input id="hr-hire-title" maxLength={160} value={draft.jobTitle} onChange={(e) => updateField('jobTitle', e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-hire-contract">{t('fields.contractType')}</Label>
          <NativeSelect id="hr-hire-contract" value={draft.contractType} onChange={(e) => updateField('contractType', e.target.value as HrContractType)}>
            {HR_CONTRACT_TYPES.map((ct) => (
              <NativeSelectOption key={ct} value={ct}>
                {t(`contracts.${ct}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {draft.contractType === 'fixed_term' && (
          <>
            <div className="space-y-1">
              <Label htmlFor="hr-hire-term-months">{t('fields.termMonths')}</Label>
              <Input
                id="hr-hire-term-months"
                data-testid="hr-hire-term-months"
                inputMode="numeric"
                value={draft.termMonths}
                onChange={(e) => updateField('termMonths', e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hr-hire-contract-end">{t('fields.contractEndOn')}</Label>
              <Input
                id="hr-hire-contract-end"
                data-testid="hr-hire-contract-end"
                type="date"
                value={draft.contractEndOn}
                onChange={(e) => updateField('contractEndOn', e.target.value)}
              />
            </div>
          </>
        )}
        <div className="space-y-1">
          <Label htmlFor="hr-hire-region">{t('fields.region')}</Label>
          <NativeSelect id="hr-hire-region" value={draft.region} onChange={(e) => updateField('region', e.target.value as HrRegion)}>
            {HR_REGIONS.map((r) => (
              <NativeSelectOption key={r} value={r}>
                {t('regionOption', { region: r })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-hire-payfn">{t('fields.payFunction')}</Label>
          <NativeSelect id="hr-hire-payfn" value={draft.payFunction} onChange={(e) => updateField('payFunction', e.target.value as HrPayFunction)}>
            {HR_PAY_FUNCTIONS.map((pf) => (
              <NativeSelectOption key={pf} value={pf}>
                {t(`payFunctions.${pf}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {entityDepartments.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor="hr-hire-dept">{t('fields.department')}</Label>
            <NativeSelect id="hr-hire-dept" value={draft.departmentId} onChange={(e) => updateField('departmentId', e.target.value)}>
              <NativeSelectOption value="">{t('fields.noDepartment')}</NativeSelectOption>
              {entityDepartments.map((d) => (
                <NativeSelectOption key={d.id} value={d.id}>
                  {d.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
      {draft.contractType === 'fixed_term' && !termMonthsValid && <ErrorText>{t('hire.fixedTermRangeError')}</ErrorText>}
      {fixedTermEndBeforeStart && <ErrorText>{t('hire.fixedTermEndBeforeStart')}</ErrorText>}
      {fixedTermMissing && (
        <p className="mt-2 text-xs text-subtle-foreground" data-testid="hr-hire-fixed-term-hint">
          {t('hire.fixedTermHint')}
        </p>
      )}
      {needsOverride && (
        <label className="mt-3 flex items-center gap-2 text-xs text-subtle-foreground">
          <input type="checkbox" checked={draft.allowDirectHire} onChange={(e) => updateField('allowDirectHire', e.target.checked)} />
          {t('hire.allowDirect')}
        </label>
      )}
      {hire.error && <ErrorText>{errorMessage(hire.error)}</ErrorText>}
      <div className="mt-3">
        <Button loading={hire.isPending} disabled={!canSubmit} onClick={() => hire.mutate()} data-testid="hr-candidate-hire">
          {t('hire.submit')}
        </Button>
      </div>
    </section>
  );
}

export function CandidateDetailPanel({
  candidate,
  openings,
  departments,
  owner,
  onClose,
}: {
  candidate: HrCandidateView;
  openings: readonly HrOpeningView[];
  departments: readonly HrDepartmentView[];
  owner: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('hrRecruiting');
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const opening = openings.find((o) => o.id === candidate.openingId) ?? null;

  const move = useMutation({
    mutationFn: (toStage: (typeof HR_CANDIDATE_TRANSITION_STAGES)[number]) =>
      client.hr.recruiting.candidates.moveStage({
        candidateId: candidate.id,
        toStage,
        ...(candidate.stage === 'rejected' ? { allowReopen: true } : {}),
      }),
    onSuccess: async () => {
      await refresh();
    },
  });

  const erase = useMutation({
    mutationFn: () => client.hr.recruiting.candidates.erase({ candidateId: candidate.id }),
    onSuccess: async () => {
      setConfirmErase(false);
      await refresh();
    },
  });

  const canErase = owner && candidate.erasedAt === null && (candidate.stage === 'hired' || candidate.stage === 'rejected');

  return (
    <Card className="mb-6 block p-4" data-testid="hr-candidate-detail">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">{candidate.displayName}</h2>
            <Badge variant="outline">{t(`stages.${candidate.stage}`)}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {candidate.openingTitle ?? t('fields.noOpening')}
            {candidate.departmentName ? ` (${candidate.departmentName})` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          {candidate.stage !== 'hired' && candidate.erasedAt === null && (
            <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
              {t('edit')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </div>

      {editing && candidate.erasedAt === null && (
        <div className="mt-4">
          <CandidateForm candidate={candidate} openings={openings} onClose={() => setEditing(false)} />
        </div>
      )}

      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-xs text-subtle-foreground">{t('fields.email')}</dt>
          <dd>{candidate.email ?? '-'}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">{t('fields.phone')}</dt>
          <dd>{candidate.phone ?? '-'}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">{t('fields.yearsExperience')}</dt>
          <dd>{candidate.yearsExperience !== null ? String(candidate.yearsExperience) : '-'}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">{t('fields.expectedWage')}</dt>
          <dd className="tabular-nums">{candidate.expectedWage ? f.money(candidate.expectedWage, 'VND') : '-'}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">{t('fields.agreedWage')}</dt>
          <dd className="tabular-nums">{candidate.agreedWage ? f.money(candidate.agreedWage, 'VND') : '-'}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">{t('fields.plannedStartOn')}</dt>
          <dd>{candidate.plannedStartOn ? f.date(candidate.plannedStartOn) : '-'}</dd>
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <dt className="text-xs text-subtle-foreground">{t('fields.matchedSkills')}</dt>
          <dd>{candidate.matchedSkills.length > 0 ? candidate.matchedSkills.join(', ') : '-'}</dd>
        </div>
        {candidate.notes && (
          <div className="sm:col-span-2 lg:col-span-3">
            <dt className="text-xs text-subtle-foreground">{t('fields.notes')}</dt>
            <dd className="whitespace-pre-wrap text-muted-foreground">{candidate.notes}</dd>
          </div>
        )}
      </dl>

      {candidate.erasedAt === null && candidate.stage !== 'hired' && (
        <section className="mt-4 border-t pt-4">
          <p className="mb-2 text-xs font-medium text-foreground">{t('pipeline.moveTo')}</p>
          <div className="flex flex-wrap gap-2">
            {HR_CANDIDATE_TRANSITION_STAGES.filter((s) => s !== candidate.stage).map((targetStage) => {
              const check = checkCandidateTransition({
                from: candidate.stage,
                to: targetStage,
                hasScheduledInterview: candidate.interviewEventId !== null,
                agreedWage: candidate.agreedWage,
                startDate: candidate.plannedStartOn,
                allowReopen: candidate.stage === 'rejected',
              });
              return (
                <Button
                  key={targetStage}
                  size="sm"
                  variant={targetStage === 'rejected' ? 'outline' : 'secondary'}
                  disabled={!check.allowed}
                  loading={move.isPending}
                  onClick={() => move.mutate(targetStage)}
                  data-testid={`hr-stage-${targetStage}`}
                >
                  {t(`stages.${targetStage}`)}
                </Button>
              );
            })}
          </div>
          {move.error && <ErrorText>{errorMessage(move.error)}</ErrorText>}
        </section>
      )}

      {candidate.erasedAt === null && (
        <>
          <InterviewSchedulePanel key={`${candidate.id}-${candidate.interviewStartsAt ?? 'none'}`} candidate={candidate} />
          <RecruitingBriefPanel
            candidateId={candidate.id}
            candidateVersion={`${candidate.updatedAt}:${candidate.openingId ?? ''}:${candidate.interviewEventId ?? ''}:${opening?.updatedAt ?? ''}:${candidate.openingTitle ?? ''}:${candidate.departmentName ?? ''}`}
          />
          <HireCandidatePanel key={candidate.id} candidate={candidate} opening={opening} departments={departments} />
        </>
      )}

      {candidate.erasedAt !== null && (
        <Alert className="mt-4">{t('erase.done', { at: f.dateTime(candidate.erasedAt) })}</Alert>
      )}

      {canErase && (
        <section className="mt-4 border-t pt-4" data-testid="hr-candidate-erase-panel">
          {!confirmErase ? (
            <Button size="sm" variant="destructive" onClick={() => setConfirmErase(true)} data-testid="hr-candidate-erase-ask">
              {t('erase.action')}
            </Button>
          ) : (
            <div className="space-y-2 rounded-md border border-destructive/40 p-3">
              <p className="text-sm text-foreground">{t('erase.confirmText')}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" loading={erase.isPending} onClick={() => erase.mutate()} data-testid="hr-candidate-erase-confirm">
                  {t('erase.confirmButton')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmErase(false)}>
                  {t('cancel')}
                </Button>
              </div>
              {erase.error &&
                (isStepUpRequired(erase.error) ? (
                  <StepUpPrompt action={t('erase.confirmButton')} onVerified={() => erase.mutate()} onCancel={() => erase.reset()} />
                ) : (
                  <ErrorText>{errorMessage(erase.error)}</ErrorText>
                ))}
            </div>
          )}
        </section>
      )}
    </Card>
  );
}

export function HrRecruitingPage() {
  const t = useTranslations('hrRecruiting');
  const f = useFormat();
  const org = useQuery(orpc.org.get.queryOptions());
  const owner = org.data?.role === 'owner';
  const [showClosed, setShowClosed] = useState(false);
  const [selectedOpeningId, setSelectedOpeningId] = useState('');
  const [selectedStage, setSelectedStage] = useState<HrCandidateStage | ''>('');
  const [addingOpening, setAddingOpening] = useState(false);
  const [editingOpening, setEditingOpening] = useState<HrOpeningView | null>(null);
  const [addingCandidate, setAddingCandidate] = useState(false);
  const [openCandidateId, setOpenCandidateId] = useState<string | null>(null);

  const entitiesQuery = useQuery({ ...orpc.legalEntities.list.queryOptions(), ...ONCE });
  const deptQuery = useQuery({ ...orpc.hr.departments.list.queryOptions({ input: { includeArchived: false } }), ...ONCE });
  const openingsQuery = useQuery({
    ...orpc.hr.recruiting.openings.list.queryOptions({ input: { status: 'all', limit: 200 } }),
    ...ONCE,
  });
  const candidatesQuery = useQuery({
    ...orpc.hr.recruiting.candidates.list.queryOptions({
      input: {
        ...(selectedOpeningId ? { openingId: selectedOpeningId } : {}),
        ...(selectedStage ? { stage: selectedStage } : {}),
        limit: 200,
      },
    }),
    ...ONCE,
  });

  const toggleOpening = useMutation({
    mutationFn: (o: HrOpeningView) => client.hr.recruiting.openings.close({ openingId: o.id, reopen: o.status === 'closed' }),
    onSuccess: async () => {
      await refresh();
    },
  });

  const entities = entitiesQuery.data ?? [];
  const departments = deptQuery.data ?? [];
  const openings = openingsQuery.data ?? [];
  const visibleOpenings = showClosed ? openings : openings.filter((o) => o.status === 'open');
  const candidates = candidatesQuery.data ?? [];
  const selectedCandidate = openCandidateId ? candidates.find((c) => c.id === openCandidateId) ?? null : null;

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <>
            <Button variant="outline" disabled={addingOpening} onClick={() => setAddingOpening(true)} data-testid="hr-opening-new">
              {t('newOpening')}
            </Button>
            <Button disabled={addingCandidate} onClick={() => setAddingCandidate(true)} data-testid="hr-candidate-new">
              {t('newCandidate')}
            </Button>
          </>
        }
      />

      {addingOpening && <OpeningForm departments={departments} entities={entities} onClose={() => setAddingOpening(false)} />}
      {editingOpening && <OpeningForm key={editingOpening.id} opening={editingOpening} departments={departments} entities={entities} onClose={() => setEditingOpening(null)} />}
      {addingCandidate && <CandidateForm openings={openings} {...(selectedOpeningId ? { defaultOpeningId: selectedOpeningId } : {})} onClose={() => setAddingCandidate(false)} />}
      {selectedCandidate && (
        <CandidateDetailPanel key={selectedCandidate.id} candidate={selectedCandidate} openings={openings} departments={departments} owner={owner} onClose={() => setOpenCandidateId(null)} />
      )}

      <section className="mb-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium text-foreground">{t('openingsTitle')}</h2>
          <label className="flex items-center gap-1 text-xs text-subtle-foreground">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            {t('showClosedOpenings')}
          </label>
        </div>
        {toggleOpening.error && <ErrorText>{errorMessage(toggleOpening.error)}</ErrorText>}
        {openingsQuery.isPending ? (
          <TableSkeleton columns={5} />
        ) : openingsQuery.error ? (
          <ErrorText>{errorMessage(openingsQuery.error)}</ErrorText>
        ) : visibleOpenings.length === 0 ? (
          <Empty title={t('emptyOpenings')} hint={t('emptyOpeningsHint')} />
        ) : (
          <DataTable head={[t('fields.openingTitle'), t('fields.departmentName'), t('fields.budgetBand'), t('fields.candidateCount'), '']} numeric={[2, 3]}>
            {visibleOpenings.map((o) => {
              const band =
                o.budgetMinWage && o.budgetMaxWage
                  ? `${f.money(o.budgetMinWage, 'VND')} - ${f.money(o.budgetMaxWage, 'VND')}`
                  : o.budgetMinWage
                    ? `>= ${f.money(o.budgetMinWage, 'VND')}`
                    : o.budgetMaxWage
                      ? `<= ${f.money(o.budgetMaxWage, 'VND')}`
                      : '-';
              return (
                <TableRow key={o.id} data-testid="hr-opening-row">
                  <TableCell className="px-4 py-3 font-medium">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setSelectedOpeningId((cur) => (cur === o.id ? '' : o.id))}
                    >
                      {o.title}
                    </button>
                    {o.status === 'closed' && (
                      <Badge className="ml-2" variant="secondary">
                        {t('openingStatus.closed')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3">{o.departmentName ?? '-'}</TableCell>
                  <TableCell className={NUM}>{band}</TableCell>
                  <TableCell className={NUM}>{o.candidateCount}</TableCell>
                  <TableCell className="space-x-1 px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setEditingOpening(o)}>
                      {t('edit')}
                    </Button>
                    <Button variant="ghost" size="sm" loading={toggleOpening.isPending} onClick={() => toggleOpening.mutate(o)}>
                      {o.status === 'open' ? t('closeOpening') : t('reopenOpening')}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </DataTable>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium text-foreground">{t('candidatesTitle')}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect value={selectedOpeningId} onChange={(e) => setSelectedOpeningId(e.target.value)} aria-label={t('fields.opening')}>
              <NativeSelectOption value="">{t('allOpenings')}</NativeSelectOption>
              {openings.map((o) => (
                <NativeSelectOption key={o.id} value={o.id}>
                  {o.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect value={selectedStage} onChange={(e) => setSelectedStage(e.target.value as HrCandidateStage | '')} aria-label={t('fields.stage')}>
              <NativeSelectOption value="">{t('allStages')}</NativeSelectOption>
              {HR_CANDIDATE_STAGES.map((st) => (
                <NativeSelectOption key={st} value={st}>
                  {t(`stages.${st}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
        {candidatesQuery.isPending ? (
          <TableSkeleton columns={6} />
        ) : candidatesQuery.error ? (
          <ErrorText>{errorMessage(candidatesQuery.error)}</ErrorText>
        ) : candidates.length === 0 ? (
          <Empty title={t('emptyCandidates')} hint={t('emptyCandidatesHint')} />
        ) : (
          <DataTable head={[t('fields.candidateName'), t('fields.opening'), t('fields.stage'), t('fields.expectedWage'), t('fields.interview'), '']} numeric={[3]}>
            {candidates.map((c) => (
              <TableRow key={c.id} data-testid="hr-candidate-row">
                <TableCell className="px-4 py-3 font-medium">{c.displayName}</TableCell>
                <TableCell className="px-4 py-3">{c.openingTitle ?? '-'}</TableCell>
                <TableCell className="px-4 py-3">
                  <Badge variant="outline">{t(`stages.${c.stage}`)}</Badge>
                </TableCell>
                <TableCell className={NUM}>{c.agreedWage ? f.money(c.agreedWage, 'VND') : c.expectedWage ? f.money(c.expectedWage, 'VND') : '-'}</TableCell>
                <TableCell className="px-4 py-3">{c.interviewStartsAt ? f.dateTime(c.interviewStartsAt) : '-'}</TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => setOpenCandidateId(c.id)} data-testid="hr-candidate-open">
                    {t('open')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Lightweight quarterly OKRs panel (Company -> Department -> Individual) with optional Ludy Cong tac task linkage (#4529, Stage 6D).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  HR_OKR_METRIC_TYPES,
  HR_OKR_SCOPES,
  vietnamToday,
  type HrOkrAiState,
  type HrOkrKeyResultView,
  type HrOkrMetricType,
  type HrOkrObjectiveView,
  type HrOkrProjectOption,
  type HrOkrScope,
  type HrOkrStatus,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { Empty, ErrorText, TableSkeleton } from './ui.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const PHONE_SELECT = 'max-md:min-h-11 [&_select]:max-md:min-h-11';

const STATUS_BADGE: Record<HrOkrStatus, 'default' | 'secondary' | 'success' | 'warning'> = {
  draft: 'warning',
  active: 'default',
  completed: 'success',
  archived: 'secondary',
};

export interface OkrTreeNode {
  objective: HrOkrObjectiveView;
  depth: number;
  parentTitle: string | null;
}

/** Computes current YYYY-QN quarter in Vietnam time. */
export function currentDefaultQuarter(now: Date = new Date()): string {
  const day = vietnamToday(now);
  const year = day.slice(0, 4);
  const month = Number(day.slice(5, 7));
  const q = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${q}`;
}

/** Builds adjacent quarter options around the active quarter. */
export function buildQuarterOptions(known: readonly string[], selected: string): string[] {
  const baseYear = Number(selected.slice(0, 4)) || new Date().getFullYear();
  const extra: string[] = [];
  for (let y = baseYear - 1; y <= baseYear + 1; y++) {
    for (let q = 4; q >= 1; q--) {
      extra.push(`${y}-Q${q}`);
    }
  }
  return Array.from(new Set([selected, ...known, ...extra])).sort().reverse();
}

/** Flattens objectives into parent-first aligned hierarchy (Company -> Department -> Individual). */
export function groupOkrTree(objectives: readonly HrOkrObjectiveView[]): OkrTreeNode[] {
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const childrenByParent = new Map<string | null, HrOkrObjectiveView[]>();
  for (const obj of objectives) {
    const parentId = obj.parentObjectiveId && byId.has(obj.parentObjectiveId) ? obj.parentObjectiveId : null;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(obj);
    childrenByParent.set(parentId, list);
  }
  const out: OkrTreeNode[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    const list = childrenByParent.get(parentId) ?? [];
    for (const obj of list) {
      if (visited.has(obj.id)) continue;
      visited.add(obj.id);
      const parentTitle = obj.parentObjectiveId ? (byId.get(obj.parentObjectiveId)?.title ?? null) : null;
      out.push({ objective: obj, depth, parentTitle });
      walk(obj.id, Math.min(depth + 1, 2));
    }
  };
  walk(null, 0);
  for (const obj of objectives) {
    if (!visited.has(obj.id)) {
      const parentTitle = obj.parentObjectiveId ? (byId.get(obj.parentObjectiveId)?.title ?? null) : null;
      out.push({ objective: obj, depth: 0, parentTitle });
    }
  }
  return out;
}

/** Chooses the text a human can insert when clicking AI draft or AI-off deterministic fallback. */
export function resolveDraftInsertText(draftNote: string | null, deterministicSummary: string): string {
  return draftNote && draftNote.trim() !== '' ? draftNote : deterministicSummary;
}

function progressBarWidth(progressPct: string): string {
  const numeric = Number(progressPct);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0%';
  if (numeric >= 100) return '100%';
  return `${numeric}%`;
}

export function HrOkrPanel({ mode }: { mode: 'manager' | 'self' }) {
  const t = useTranslations('hrOkr');
  const f = useFormat();
  const { locale } = useLocaleSetting();
  const lang: 'vi' | 'en' = locale === 'en' ? 'en' : 'vi';

  const [quarter, setQuarter] = useState(() => currentDefaultQuarter());
  const [scopeFilter, setScopeFilter] = useState<HrOkrScope | 'all'>('all');
  const [showCreateObjective, setShowCreateObjective] = useState(false);

  // Create objective form state
  const allowedCreateScopes: readonly HrOkrScope[] = mode === 'manager' ? HR_OKR_SCOPES : ['department', 'individual'];
  const [newScope, setNewScope] = useState<HrOkrScope>(mode === 'manager' ? 'company' : 'individual');
  const [newTitle, setNewTitle] = useState('');
  const [newDepartmentId, setNewDepartmentId] = useState('');
  const [newOwnerEmployeeId, setNewOwnerEmployeeId] = useState('');
  const [newParentId, setNewParentId] = useState('');

  // Add key result form state (keyed by objectiveId)
  const [addKrObjectiveId, setAddKrObjectiveId] = useState<string | null>(null);
  const [krTitle, setKrTitle] = useState('');
  const [krMetricType, setKrMetricType] = useState<HrOkrMetricType>('percent');
  const [krTarget, setKrTarget] = useState('100');
  const [krUnit, setKrUnit] = useState('');
  const [krProjectId, setKrProjectId] = useState('');
  const [krProjectSearch, setKrProjectSearch] = useState('');
  const [krProjectCursor, setKrProjectCursor] = useState<string | undefined>(undefined);
  const [krProjectPages, setKrProjectPages] = useState<HrOkrProjectOption[]>([]);
  const [krTaskIds, setKrTaskIds] = useState<string[]>([]);

  // Check-in panel state (keyed by keyResultId)
  const [checkinKr, setCheckinKr] = useState<HrOkrKeyResultView | null>(null);
  const [checkinValue, setCheckinValue] = useState('0');
  const [checkinSyncProjects, setCheckinSyncProjects] = useState(false);
  const [checkinNote, setCheckinNote] = useState('');
  const [aiStatus, setAiStatus] = useState<HrOkrAiState | null>(null);
  const [aiDraftText, setAiDraftText] = useState<string | null>(null);
  const [deterministicText, setDeterministicText] = useState<string | null>(null);

  const treeQ = useQuery({
    ...orpc.hr.okr.tree.queryOptions({
      input: {
        quarter,
        ...(scopeFilter !== 'all' ? { scope: scopeFilter } : {}),
      },
    }),
    ...ONCE,
  });

  const tree = treeQ.data;

  const trimmedProjectSearch = krProjectSearch.trim();
  const projectOptionsQ = useQuery({
    ...orpc.hr.okr.projectOptions.queryOptions({
      input: {
        includeArchived: false,
        ...(trimmedProjectSearch !== '' ? { search: trimmedProjectSearch } : {}),
        ...(krProjectCursor !== undefined ? { cursor: krProjectCursor } : {}),
      },
    }),
    enabled: Boolean(addKrObjectiveId && tree?.projectsAvailable),
    ...ONCE,
  });

  const mergedProjectOptions: HrOkrProjectOption[] = (() => {
    const seen = new Set<string>();
    const out: HrOkrProjectOption[] = [];
    for (const p of [...krProjectPages, ...(projectOptionsQ.data?.projects ?? [])]) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
    }
    return out;
  })();

  const projectTasksQ = useQuery({
    ...orpc.hr.okr.projectTasks.queryOptions({ input: { projectId: krProjectId } }),
    enabled: Boolean(addKrObjectiveId && krProjectId && tree?.projectsAvailable),
    ...ONCE,
  });

  const refreshTree = async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.hr.okr.tree.key() });
    await treeQ.refetch();
  };

  const createObj = useMutation({
    mutationFn: () =>
      client.hr.okr.objective.create({
        quarter,
        scope: newScope,
        title: newTitle.trim(),
        ...(newDepartmentId ? { departmentId: newDepartmentId } : {}),
        ...(newOwnerEmployeeId ? { ownerEmployeeId: newOwnerEmployeeId } : {}),
        ...(newParentId ? { parentObjectiveId: newParentId } : {}),
        activate: true,
      }),
    onSuccess: async () => {
      setNewTitle('');
      setNewDepartmentId('');
      setNewOwnerEmployeeId('');
      setNewParentId('');
      setShowCreateObjective(false);
      await refreshTree();
    },
  });

  const setObjStatus = useMutation({
    mutationFn: (vars: { objectiveId: string; status: HrOkrStatus }) =>
      client.hr.okr.objective.updateStatus(vars),
    onSuccess: refreshTree,
  });

  const addKr = useMutation({
    mutationFn: (objectiveId: string) =>
      client.hr.okr.kr.add({
        objectiveId,
        title: krTitle.trim(),
        metricType: krMetricType,
        ...(krTarget.trim() !== '' ? { targetValue: krTarget.trim() } : {}),
        ...(krUnit.trim() !== '' ? { unit: krUnit.trim() } : {}),
        ...(krProjectId ? { linkedProjectId: krProjectId, linkedTaskIds: krTaskIds } : {}),
      }),
    onSuccess: async () => {
      setAddKrObjectiveId(null);
      setKrTitle('');
      setKrTarget('100');
      setKrUnit('');
      setKrProjectId('');
      setKrProjectSearch('');
      setKrProjectCursor(undefined);
      setKrProjectPages([]);
      setKrTaskIds([]);
      await refreshTree();
    },
  });

  const removeKr = useMutation({
    mutationFn: (keyResultId: string) => client.hr.okr.kr.remove({ keyResultId }),
    onSuccess: refreshTree,
  });

  const syncProjects = useMutation({
    mutationFn: (keyResultId: string) => client.hr.okr.kr.syncProjects({ keyResultId }),
    onSuccess: refreshTree,
  });

  const draftAi = useMutation({
    mutationFn: (keyResultId: string) => client.hr.okr.draftCheckin({ keyResultId, lang }),
    onSuccess: (res, keyResultId) => {
      if (checkinKr?.id !== keyResultId) return;
      setAiStatus(res.status);
      setAiDraftText(res.draftNote);
      setDeterministicText(res.deterministicSummary);
      if (res.draftNote && checkinNote.trim() === '') {
        setCheckinNote(res.draftNote);
      }
    },
  });

  const saveCheckin = useMutation({
    mutationFn: () => {
      if (!checkinKr) throw new Error('missing check-in target');
      return client.hr.okr.kr.checkin({
        keyResultId: checkinKr.id,
        ...(checkinSyncProjects ? {} : { currentValue: checkinValue.trim() || '0' }),
        syncFromProjects: checkinSyncProjects,
        note: checkinNote.trim() === '' ? null : checkinNote.trim(),
      });
    },
    onSuccess: async () => {
      setCheckinKr(null);
      setCheckinNote('');
      setAiStatus(null);
      setAiDraftText(null);
      setDeterministicText(null);
      await refreshTree();
    },
  });

  const quarterOptions = buildQuarterOptions(tree?.availableQuarters ?? [], quarter);
  const treeNodes = groupOkrTree(tree?.objectives ?? []);
  const parentCandidates = (tree?.objectives ?? []).filter((o) => {
    if (newScope === 'company') return false;
    if (newScope === 'department') return o.scope === 'company';
    return o.scope === 'company' || o.scope === 'department';
  });

  const openCheckin = (kr: HrOkrKeyResultView) => {
    setCheckinKr(kr);
    setCheckinValue(kr.currentValue);
    setCheckinSyncProjects(kr.linkedProjectAccessible);
    setCheckinNote(kr.lastCheckinNote ?? '');
    setAiStatus(null);
    setAiDraftText(null);
    setDeterministicText(null);
  };

  const toggleTaskSelection = (taskId: string) => {
    setKrTaskIds((prev) => (prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]));
  };

  return (
    <Card className="mt-6 p-5" data-testid="hr-okr-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
            {tree && (
              <Badge variant={tree.projectsAvailable ? 'success' : 'secondary'} data-testid="hr-okr-projects-badge">
                {tree.projectsAvailable ? t('projectsActive') : t('projectsOff')}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-subtle-foreground">{mode === 'manager' ? t('subtitle') : t('selfSubtitle')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="hr-okr-quarter" className="text-xs">
              {t('quarterLabel')}
            </Label>
            <div className={`mt-1 ${PHONE_SELECT}`}>
              <NativeSelect
                id="hr-okr-quarter"
                value={quarter}
                onChange={(e) => setQuarter(e.target.value)}
                data-testid="hr-okr-quarter-select"
              >
                {quarterOptions.map((q) => (
                  <NativeSelectOption key={q} value={q}>
                    {q}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div>
            <Label htmlFor="hr-okr-scope-filter" className="text-xs">
              {t('scopeFilterLabel')}
            </Label>
            <div className={`mt-1 ${PHONE_SELECT}`}>
              <NativeSelect
                id="hr-okr-scope-filter"
                value={scopeFilter}
                onChange={(e) => setScopeFilter(e.target.value as HrOkrScope | 'all')}
                data-testid="hr-okr-scope-filter"
              >
                <NativeSelectOption value="all">{t('scopeAll')}</NativeSelectOption>
                {HR_OKR_SCOPES.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {t(`scopes.${s}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>
          {tree?.canManageAny && (
            <Button
              type="button"
              size="sm"
              className={PHONE_TARGET}
              onClick={() => setShowCreateObjective((v) => !v)}
              data-testid="hr-okr-new-objective-btn"
            >
              {t('createObjectiveBtn')}
            </Button>
          )}
        </div>
      </div>

      {showCreateObjective && tree?.canManageAny && (
        <form
          className="mt-4 rounded-md border border-border bg-muted/20 p-4 space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            createObj.mutate();
          }}
          data-testid="hr-okr-create-form"
        >
          <div className="text-sm font-medium text-foreground">{t('createObjectiveTitle')}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="hr-okr-new-scope" className="text-xs">
                {t('scopeLabel')}
              </Label>
              <div className={`mt-1 ${PHONE_SELECT}`}>
                <NativeSelect
                  id="hr-okr-new-scope"
                  value={newScope}
                  onChange={(e) => {
                    const next = e.target.value as HrOkrScope;
                    setNewScope(next);
                    if (next === 'company') {
                      setNewDepartmentId('');
                      setNewOwnerEmployeeId('');
                      setNewParentId('');
                    } else if (next === 'department') {
                      setNewOwnerEmployeeId('');
                    }
                  }}
                >
                  {allowedCreateScopes.map((s) => (
                    <NativeSelectOption key={s} value={s}>
                      {t(`scopes.${s}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <div>
              <Label htmlFor="hr-okr-new-title" className="text-xs">
                {t('objectiveTitleLabel')}
              </Label>
              <Input
                id="hr-okr-new-title"
                className={`mt-1 ${PHONE_TARGET}`}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={t('objectiveTitlePlaceholder')}
                required
              />
            </div>
            {newScope !== 'company' && (
              <div>
                <Label htmlFor="hr-okr-new-dept" className="text-xs">
                  {t('departmentLabel')}
                </Label>
                <div className={`mt-1 ${PHONE_SELECT}`}>
                  <NativeSelect
                    id="hr-okr-new-dept"
                    value={newDepartmentId}
                    onChange={(e) => setNewDepartmentId(e.target.value)}
                    required={newScope === 'department'}
                  >
                    <NativeSelectOption value="">{t('selectDepartment')}</NativeSelectOption>
                    {tree.manageableDepartments.map((d) => (
                      <NativeSelectOption key={d.id} value={d.id}>
                        {d.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            )}
            {newScope === 'individual' && (
              <div>
                <Label htmlFor="hr-okr-new-emp" className="text-xs">
                  {t('ownerEmployeeLabel')}
                </Label>
                <div className={`mt-1 ${PHONE_SELECT}`}>
                  <NativeSelect
                    id="hr-okr-new-emp"
                    value={newOwnerEmployeeId}
                    onChange={(e) => setNewOwnerEmployeeId(e.target.value)}
                    required
                  >
                    <NativeSelectOption value="">{t('selectEmployee')}</NativeSelectOption>
                    {tree.manageableEmployees.map((emp) => (
                      <NativeSelectOption key={emp.id} value={emp.id}>
                        {emp.jobTitle ? `${emp.displayName} (${emp.jobTitle})` : emp.displayName}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            )}
            {newScope !== 'company' && (
              <div className="sm:col-span-2">
                <Label htmlFor="hr-okr-new-parent" className="text-xs">
                  {t('parentObjectiveLabel')}
                </Label>
                <div className={`mt-1 ${PHONE_SELECT}`}>
                  <NativeSelect
                    id="hr-okr-new-parent"
                    value={newParentId}
                    onChange={(e) => setNewParentId(e.target.value)}
                  >
                    <NativeSelectOption value="">{t('noParentObjective')}</NativeSelectOption>
                    {parentCandidates.map((p) => (
                      <NativeSelectOption key={p.id} value={p.id}>
                        [{t(`scopes.${p.scope}`)}] {p.title}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            )}
          </div>
          {createObj.error && <ErrorText>{errorMessage(createObj.error)}</ErrorText>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className={PHONE_TARGET} disabled={createObj.isPending || newTitle.trim() === ''}>
              {t('saveObjective')}
            </Button>
            <Button type="button" variant="outline" size="sm" className={PHONE_TARGET} onClick={() => setShowCreateObjective(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}

      {treeQ.isPending ? (
        <div className="mt-4">
          <TableSkeleton columns={3} rows={3} />
        </div>
      ) : treeQ.error ? (
        <div className="mt-4">
          <ErrorText>{errorMessage(treeQ.error)}</ErrorText>
        </div>
      ) : treeNodes.length === 0 ? (
        <div className="mt-4">
          <Empty title={t('empty', { quarter })} hint={t('emptyHint')} />
        </div>
      ) : (
        <div className="mt-4 space-y-3" data-testid="hr-okr-tree">
          {(setObjStatus.error || removeKr.error || syncProjects.error) && (
            <ErrorText>{errorMessage(setObjStatus.error ?? removeKr.error ?? syncProjects.error)}</ErrorText>
          )}
          {treeNodes.map(({ objective: obj, depth, parentTitle }) => (
            <div
              key={obj.id}
              className={`rounded-md border border-border p-4 ${depth === 1 ? 'sm:ml-6' : depth === 2 ? 'sm:ml-12' : ''}`}
              data-testid={`hr-okr-objective-${obj.id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{t(`scopes.${obj.scope}`)}</Badge>
                    <Badge variant={STATUS_BADGE[obj.status]}>{t(`statuses.${obj.status}`)}</Badge>
                    {obj.departmentName && <span className="text-xs text-muted-foreground">{obj.departmentName}</span>}
                    {obj.ownerEmployeeName && <span className="text-xs font-medium text-foreground">{obj.ownerEmployeeName}</span>}
                  </div>
                  <h3 className="mt-1 text-sm font-medium text-foreground">{obj.title}</h3>
                  {parentTitle && (
                    <p className="mt-0.5 text-xs text-subtle-foreground">
                      {t('alignedUnder')} {parentTitle}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-28 text-right">
                    <div className="text-xs font-medium tabular-nums text-foreground">{t('progressLabel', { pct: obj.progressPct })}</div>
                    <div
                      role="progressbar"
                      aria-valuenow={Number(obj.progressPct)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={obj.title}
                      className="mt-1 h-2 w-28 overflow-hidden rounded-full bg-muted"
                    >
                      <div className="h-full bg-primary transition-all" style={{ width: progressBarWidth(obj.progressPct) }} />
                    </div>
                  </div>
                  {obj.canManage && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className={PHONE_TARGET}
                        onClick={() => {
                          setAddKrObjectiveId(addKrObjectiveId === obj.id ? null : obj.id);
                          setKrTitle('');
                          setKrMetricType('percent');
                          setKrTarget('100');
                          setKrUnit('');
                          setKrProjectId('');
                          setKrProjectSearch('');
                          setKrProjectCursor(undefined);
                          setKrProjectPages([]);
                          setKrTaskIds([]);
                        }}
                      >
                        {t('addKrBtn')}
                      </Button>
                      {obj.status === 'draft' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={PHONE_TARGET}
                          onClick={() => setObjStatus.mutate({ objectiveId: obj.id, status: 'active' })}
                        >
                          {t('activateBtn')}
                        </Button>
                      )}
                      {obj.status === 'active' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={PHONE_TARGET}
                          onClick={() => setObjStatus.mutate({ objectiveId: obj.id, status: 'completed' })}
                        >
                          {t('completeBtn')}
                        </Button>
                      )}
                      {obj.status === 'completed' && !(obj.scope === 'individual' && obj.ownerEmployeeId === null) && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={PHONE_TARGET}
                          onClick={() => setObjStatus.mutate({ objectiveId: obj.id, status: 'active' })}
                        >
                          {t('reopenBtn')}
                        </Button>
                      )}
                      {obj.status !== 'archived' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={PHONE_TARGET}
                          onClick={() => setObjStatus.mutate({ objectiveId: obj.id, status: 'archived' })}
                        >
                          {t('archiveBtn')}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {addKrObjectiveId === obj.id && obj.canManage && (
                <form
                  className="mt-3 rounded-md border border-border bg-muted/20 p-3 space-y-3"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    addKr.mutate(obj.id);
                  }}
                  data-testid="hr-okr-add-kr-form"
                >
                  <div className="text-xs font-medium text-foreground">{t('addKrTitle')}</div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor={`hr-okr-kr-title-${obj.id}`} className="text-xs">
                        {t('krTitleLabel')}
                      </Label>
                      <Input
                        id={`hr-okr-kr-title-${obj.id}`}
                        className={`mt-1 ${PHONE_TARGET}`}
                        value={krTitle}
                        onChange={(e) => setKrTitle(e.target.value)}
                        placeholder={t('krTitlePlaceholder')}
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor={`hr-okr-kr-metric-${obj.id}`} className="text-xs">
                        {t('metricTypeLabel')}
                      </Label>
                      <div className={`mt-1 ${PHONE_SELECT}`}>
                        <NativeSelect
                          id={`hr-okr-kr-metric-${obj.id}`}
                          value={krMetricType}
                          onChange={(e) => {
                            const next = e.target.value as HrOkrMetricType;
                            setKrMetricType(next);
                            if (next === 'percent') setKrTarget('100');
                            else if (next === 'boolean') setKrTarget('1');
                            else if (next === 'project_tasks') setKrTarget('');
                          }}
                        >
                          {HR_OKR_METRIC_TYPES.map((m) => (
                            <NativeSelectOption key={m} value={m}>
                              {t(`metrics.${m}`)}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor={`hr-okr-kr-target-${obj.id}`} className="text-xs">
                        {t('targetLabel')}
                      </Label>
                      <Input
                        id={`hr-okr-kr-target-${obj.id}`}
                        className={`mt-1 ${PHONE_TARGET}`}
                        value={krTarget}
                        onChange={(e) => setKrTarget(e.target.value)}
                        placeholder={krMetricType === 'project_tasks' ? String(krTaskIds.length || 0) : '100'}
                        required={krMetricType === 'number' || krMetricType === 'currency'}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`hr-okr-kr-unit-${obj.id}`} className="text-xs">
                        {t('unitLabel')}
                      </Label>
                      <Input
                        id={`hr-okr-kr-unit-${obj.id}`}
                        className={`mt-1 ${PHONE_TARGET}`}
                        value={krUnit}
                        onChange={(e) => setKrUnit(e.target.value)}
                        placeholder={t('unitPlaceholder')}
                      />
                    </div>
                    {tree?.projectsAvailable && (
                      <div className="sm:col-span-2 space-y-2">
                        <Label htmlFor={`hr-okr-kr-project-${obj.id}`} className="text-xs">
                          {t('linkedProjectLabel')}
                        </Label>
                        <Input
                          id={`hr-okr-kr-project-search-${obj.id}`}
                          aria-label={t('searchProjectsPlaceholder')}
                          className={PHONE_TARGET}
                          value={krProjectSearch}
                          onChange={(e) => {
                            setKrProjectSearch(e.target.value);
                            setKrProjectCursor(undefined);
                            setKrProjectPages([]);
                            setKrProjectId('');
                            setKrTaskIds([]);
                          }}
                          placeholder={t('searchProjectsPlaceholder')}
                          data-testid="hr-okr-project-search"
                        />
                        <div className={PHONE_SELECT}>
                          <NativeSelect
                            id={`hr-okr-kr-project-${obj.id}`}
                            value={krProjectId}
                            onChange={(e) => {
                              setKrProjectId(e.target.value);
                              setKrTaskIds([]);
                            }}
                          >
                            <NativeSelectOption value="">{t('noLinkedProject')}</NativeSelectOption>
                            {mergedProjectOptions.map((p) => (
                              <NativeSelectOption key={p.id} value={p.id}>
                                {p.name}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </div>
                        {projectOptionsQ.data?.hasMore && projectOptionsQ.data.nextCursor && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={PHONE_TARGET}
                            disabled={projectOptionsQ.isFetching}
                            onClick={() => {
                              const next = projectOptionsQ.data?.nextCursor;
                              if (!next) return;
                              setKrProjectPages(mergedProjectOptions);
                              setKrProjectCursor(next);
                            }}
                            data-testid="hr-okr-project-load-more"
                          >
                            {t('loadMoreProjectsBtn')}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {tree?.projectsAvailable && krProjectId && (
                    <div>
                      <div className="text-xs font-medium text-foreground">{t('linkedTasksLabel')}</div>
                      {projectTasksQ.isPending ? (
                        <div className="mt-1 text-xs text-muted-foreground">{t('loadingTasks')}</div>
                      ) : (
                        <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded border border-border bg-background p-2">
                          {(projectTasksQ.data?.tasks ?? []).map((task) => (
                            <label key={task.id} className="flex items-center gap-2 text-xs max-md:flex max-md:min-h-11">
                              <input
                                type="checkbox"
                                checked={krTaskIds.includes(task.id)}
                                disabled={!krTaskIds.includes(task.id) && krTaskIds.length >= 50}
                                onChange={() => toggleTaskSelection(task.id)}
                              />
                              <span className={task.completed ? 'line-through text-muted-foreground' : 'text-foreground'}>
                                {task.title}
                              </span>
                              <span className="ml-auto text-subtle-foreground">{task.statusName}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {addKr.error && <ErrorText>{errorMessage(addKr.error)}</ErrorText>}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" size="sm" className={PHONE_TARGET} disabled={addKr.isPending || krTitle.trim() === ''}>
                      {t('saveKr')}
                    </Button>
                    <Button type="button" variant="outline" size="sm" className={PHONE_TARGET} onClick={() => setAddKrObjectiveId(null)}>
                      {t('cancel')}
                    </Button>
                  </div>
                </form>
              )}

              {obj.keyResults.length > 0 && (
                <div className="mt-3 space-y-2">
                  {obj.keyResults.map((kr) => (
                    <div
                      key={kr.id}
                      className="rounded border border-border/80 bg-background px-3 py-2.5"
                      data-testid={`hr-okr-kr-${kr.id}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{kr.title}</span>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {kr.currentValue}/{kr.targetValue}
                              {kr.unit ? ` ${kr.unit}` : ''} ({kr.progressPct}%)
                            </span>
                            {kr.linkedProjectId && (
                              <Badge variant={kr.linkedProjectAccessible ? 'secondary' : 'outline'}>
                                {kr.linkedProjectAccessible
                                  ? t('projectLinkBadge', {
                                      project: kr.linkedProjectName ?? '',
                                      done: String(kr.completedLinkedTasks),
                                      total: String(kr.totalLinkedTasks),
                                    })
                                  : tree?.projectsAvailable
                                    ? t('projectPrivateFallback')
                                    : t('projectOffFallback')}
                              </Badge>
                            )}
                          </div>
                          {kr.lastCheckinNote && (
                            <p className="mt-1 text-xs text-foreground/90">{kr.lastCheckinNote}</p>
                          )}
                          {kr.lastCheckinAt && (
                            <p className="mt-0.5 text-xs text-subtle-foreground">
                              {t('lastCheckinMeta', { date: f.date(kr.lastCheckinAt) })}{' '}
                              {kr.lastCheckinByName ? t('byPerson', { name: kr.lastCheckinByName }) : ''}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {kr.canCheckin && kr.linkedProjectId && kr.linkedProjectAccessible && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className={PHONE_TARGET}
                              disabled={syncProjects.isPending}
                              onClick={() => syncProjects.mutate(kr.id)}
                              data-testid={`hr-okr-sync-${kr.id}`}
                            >
                              {t('syncProjectsBtn')}
                            </Button>
                          )}
                          {kr.canCheckin && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className={PHONE_TARGET}
                              onClick={() => openCheckin(kr)}
                              data-testid={`hr-okr-checkin-open-${kr.id}`}
                            >
                              {t('checkinBtn')}
                            </Button>
                          )}
                          {kr.canEdit && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={PHONE_TARGET}
                              onClick={() => removeKr.mutate(kr.id)}
                            >
                              {t('removeKr')}
                            </Button>
                          )}
                        </div>
                      </div>

                      {checkinKr?.id === kr.id && (
                        <form
                          className="mt-3 rounded border border-border bg-muted/20 p-3 space-y-3"
                          onSubmit={(e: FormEvent) => {
                            e.preventDefault();
                            saveCheckin.mutate();
                          }}
                          data-testid="hr-okr-checkin-form"
                        >
                          <div className="text-xs font-medium text-foreground">{t('checkinTitle')}</div>
                          {kr.linkedProjectAccessible && (
                            <label className="flex items-center gap-2 text-xs text-foreground max-md:flex max-md:min-h-11">
                              <input
                                type="checkbox"
                                checked={checkinSyncProjects}
                                onChange={(e) => setCheckinSyncProjects(e.target.checked)}
                              />
                              <span>{t('syncCheckbox')}</span>
                            </label>
                          )}
                          {!checkinSyncProjects && (
                            <div>
                              <Label htmlFor={`hr-okr-checkin-val-${kr.id}`} className="text-xs">
                                {t('currentLabel')}
                              </Label>
                              <Input
                                id={`hr-okr-checkin-val-${kr.id}`}
                                className={`mt-1 max-w-44 ${PHONE_TARGET}`}
                                value={checkinValue}
                                onChange={(e) => setCheckinValue(e.target.value)}
                                required
                              />
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className={PHONE_TARGET}
                              disabled={draftAi.isPending}
                              onClick={() => draftAi.mutate(kr.id)}
                              data-testid="hr-okr-draft-ai-btn"
                            >
                              {t('draftAiBtn')}
                            </Button>
                            {deterministicText && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className={PHONE_TARGET}
                                onClick={() => setCheckinNote(resolveDraftInsertText(aiDraftText, deterministicText))}
                                data-testid="hr-okr-use-summary-btn"
                              >
                                {t('useDeterministicBtn')}
                              </Button>
                            )}
                          </div>
                          {aiStatus && (
                            <div className="rounded border border-border bg-background p-2 text-xs text-muted-foreground" data-testid="hr-okr-ai-status">
                              <div>{t(`aiStates.${aiStatus}`)}</div>
                              {deterministicText && aiStatus !== 'used' && (
                                <div className="mt-1 text-foreground">{deterministicText}</div>
                              )}
                            </div>
                          )}
                          <div>
                            <Label htmlFor={`hr-okr-checkin-note-${kr.id}`} className="text-xs">
                              {t('checkinNoteLabel')}
                            </Label>
                            <Textarea
                              id={`hr-okr-checkin-note-${kr.id}`}
                              className="mt-1 min-h-20"
                              value={checkinNote}
                              onChange={(e) => setCheckinNote(e.target.value)}
                              placeholder={t('checkinNotePlaceholder')}
                            />
                          </div>
                          {saveCheckin.error && <ErrorText>{errorMessage(saveCheckin.error)}</ErrorText>}
                          {draftAi.error && <ErrorText>{errorMessage(draftAi.error)}</ErrorText>}
                          <div className="flex flex-wrap gap-2">
                            <Button type="submit" size="sm" className={PHONE_TARGET} disabled={saveCheckin.isPending}>
                              {t('saveCheckin')}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className={PHONE_TARGET}
                              onClick={() => setCheckinKr(null)}
                            >
                              {t('cancel')}
                            </Button>
                          </div>
                        </form>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

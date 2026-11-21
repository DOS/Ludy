// SPDX-License-Identifier: AGPL-3.0-only
// Member-scoped Vy daily planner for My Work (Notes v2 T4b, #3563, ADR-0049): proposes top-3 focus to-dos and overdue
// date reschedules on demand without automatic writes. Human edits or confirms every change before saving.
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TodoPlanResult, TodoPriority } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { useFormat } from '../i18n/provider.tsx';
import { clientForOrg, orpc } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { DateInput } from './date-input.tsx';
import { errorCodeOf, noteVyBlocked, noteVyErrorKey } from './note-vy-panel.tsx';
import { refreshNotes } from './notes-panel.tsx';
import { ErrorText } from './ui.tsx';

interface FocusRowDraft {
  priority: TodoPriority;
  dueOn: string;
  edited: boolean;
  applied: boolean;
  error: string | null;
}

interface RescheduleRowDraft {
  dueOn: string;
  edited: boolean;
  applied: boolean;
  error: string | null;
}

const PRIORITIES: readonly TodoPriority[] = [1, 2, 3, 4];

export function MyWorkVyPlannerTrigger({
  slug,
  open,
  onToggle,
  buttonRef,
}: {
  slug: string;
  open: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useTranslations('myWork.vyPlanner');
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  if (!role || role === 'viewer') return null;
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5 max-md:min-h-11"
      aria-expanded={open}
      onClick={onToggle}
      data-testid="my-work-vy-plan-btn"
    >
      <NavIcon name="appAi" className="text-proposal" />
      <span>{t('button')}</span>
    </Button>
  );
}

export function MyWorkVyPlannerPanel({
  slug,
  open,
  viewerTz,
  triggerRef,
  onClose,
  initialResult = null,
}: {
  slug: string;
  open: boolean;
  viewerTz: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  initialResult?: TodoPlanResult | null;
}) {
  const t = useTranslations('myWork.vyPlanner');
  const tv = useTranslations('notes.vy');
  const tt = useTranslations('myWork');
  const common = useTranslations('common');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const api = useRef(clientForOrg(slug)).current;
  const panelRef = useRef<HTMLElement>(null);

  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const isViewer = role === 'viewer';

  const status = useQuery({
    ...orpc.notes.vyStatus.queryOptions({ input: {} }),
    enabled: open && !isViewer,
    staleTime: 30_000,
  });
  const meter = useQuery({
    ...orpc.ai.meter.queryOptions({ input: { module: 'notes' } }),
    enabled: open && !isViewer,
    staleTime: 30_000,
  });
  const blocked = noteVyBlocked(status.data, meter.data);
  const statusReady = status.isSuccess && meter.isSuccess;

  const [result, setResult] = useState<TodoPlanResult | null>(initialResult);
  const [focusDrafts, setFocusDrafts] = useState<Record<string, FocusRowDraft>>({});
  const [rescheduleDrafts, setRescheduleDrafts] = useState<Record<string, RescheduleRowDraft>>({});
  const lastTriggerRef = useRef(initialResult !== null);

  const syncDrafts = (plan: TodoPlanResult) => {
    const nextFocus: Record<string, FocusRowDraft> = {};
    for (const item of plan.focus) {
      nextFocus[item.todoId] = {
        priority: item.priority,
        dueOn: item.dueOn && item.dueOn >= plan.today ? item.dueOn : plan.today,
        edited: false,
        applied: false,
        error: null,
      };
    }
    const nextReschedules: Record<string, RescheduleRowDraft> = {};
    for (const item of plan.reschedules) {
      nextReschedules[item.todoId] = {
        dueOn: item.dueOn,
        edited: false,
        applied: false,
        error: null,
      };
    }
    setFocusDrafts(nextFocus);
    setRescheduleDrafts(nextReschedules);
  };

  const planMutation = useMutation({
    mutationFn: () => api.notes.todoPlan({ timeZone: viewerTz, language: locale }),
    onSuccess: (data) => {
      setResult(data);
      if (data.state === 'ready') syncDrafts(data);
    },
  });

  useEffect(() => {
    if (!open) {
      lastTriggerRef.current = false;
      return;
    }
    panelRef.current?.focus();
    if (!lastTriggerRef.current && statusReady && blocked === null && !isViewer) {
      lastTriggerRef.current = true;
      planMutation.mutate();
    }
  }, [open, statusReady, blocked, isViewer]);

  const handleClose = () => {
    onClose();
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const applyFocus = useMutation({
    mutationFn: async (item: TodoPlanResult['focus'][number]) => {
      const draft = focusDrafts[item.todoId] ?? {
        priority: item.priority,
        dueOn: item.dueOn && result && item.dueOn >= result.today ? item.dueOn : (result?.today ?? ''),
        edited: false,
        applied: false,
        error: null,
      };
      const nextDueOn = draft.dueOn || null;
      const dateChanged = nextDueOn !== item.dueOn;
      const priorityChanged = draft.priority !== item.priority;

      if (!dateChanged && !priorityChanged) {
        return item.todoId;
      }
      if (!priorityChanged && nextDueOn !== null) {
        await api.notes.todos.reschedule({ todoIds: [item.todoId], dueOn: nextDueOn });
        return item.todoId;
      }

      const full = await api.notes.todos.get({ todoId: item.todoId });
      if (full.deletedAt !== null) {
        throw Object.assign(new Error('TODO_IN_TRASH'), { code: 'TODO_IN_TRASH' });
      }
      if (full.status !== 'open') {
        throw Object.assign(new Error('TODO_NOT_CHANGEABLE'), { code: 'TODO_NOT_CHANGEABLE' });
      }
      if (full.revision !== item.revision) {
        throw Object.assign(new Error('TODO_REVISION_CONFLICT'), { code: 'TODO_REVISION_CONFLICT' });
      }

      await api.notes.todos.update({
        todoId: full.id,
        revision: item.revision,
        title: full.title,
        details: full.details,
        checklist: full.checklist,
        priority: draft.priority,
        tags: full.tags,
        listId: full.listId,
        sectionId: full.sectionId,
        dueOn: nextDueOn,
        dueTime: nextDueOn ? full.dueTime : null,
        timeZone: full.timeZone,
      });
      return item.todoId;
    },
    onSuccess: (todoId) => {
      setFocusDrafts((prev) => {
        const cur = prev[todoId];
        return cur ? { ...prev, [todoId]: { ...cur, applied: true, error: null } } : prev;
      });
      void refreshNotes();
      toast(t('focusAppliedToast'), 'success');
    },
    onError: (err, item) => {
      const key = noteVyErrorKey(errorCodeOf(err));
      setFocusDrafts((prev) => {
        const cur = prev[item.todoId];
        return cur ? { ...prev, [item.todoId]: { ...cur, error: tv(`errors.${key}`) } } : prev;
      });
    },
  });

  const applyOneReschedule = useMutation({
    mutationFn: async (item: TodoPlanResult['reschedules'][number]) => {
      const draft = rescheduleDrafts[item.todoId];
      const dueOn = draft ? draft.dueOn : item.dueOn;
      if (!dueOn || (result && dueOn < result.today)) {
        throw Object.assign(new Error('TODO_NOT_CHANGEABLE'), { code: 'TODO_NOT_CHANGEABLE' });
      }
      await api.notes.todos.reschedule({ todoIds: [item.todoId], dueOn });
      return { todoId: item.todoId, dueOn };
    },
    onSuccess: ({ todoId, dueOn }) => {
      setRescheduleDrafts((prev) => {
        const cur = prev[todoId];
        return cur ? { ...prev, [todoId]: { ...cur, applied: true, error: null } } : prev;
      });
      void refreshNotes();
      toast(t('rescheduleAppliedToast', { due: f.date(dueOn) }), 'success');
    },
    onError: (err, item) => {
      const key = noteVyErrorKey(errorCodeOf(err));
      setRescheduleDrafts((prev) => {
        const cur = prev[item.todoId];
        return cur ? { ...prev, [item.todoId]: { ...cur, error: tv(`errors.${key}`) } } : prev;
      });
    },
  });

  const applyAllReschedules = useMutation({
    mutationFn: async () => {
      if (!result) return { appliedIds: [] as string[], errors: new Map<string, string>() };
      const byDate = new Map<string, string[]>();
      for (const item of result.reschedules) {
        const draft = rescheduleDrafts[item.todoId];
        if (draft?.applied) continue;
        const targetDate = draft ? draft.dueOn : item.dueOn;
        if (!targetDate || targetDate < result.today) continue;
        const list = byDate.get(targetDate) ?? [];
        list.push(item.todoId);
        byDate.set(targetDate, list);
      }
      const appliedIds: string[] = [];
      const errors = new Map<string, string>();
      for (const [dueOn, todoIds] of byDate) {
        try {
          const res = await api.notes.todos.reschedule({ todoIds, dueOn });
          appliedIds.push(...res.todoIds);
        } catch (err) {
          const msg = tv(`errors.${noteVyErrorKey(errorCodeOf(err))}`);
          for (const id of todoIds) errors.set(id, msg);
        }
      }
      return { appliedIds, errors };
    },
    onSuccess: ({ appliedIds, errors }) => {
      const done = new Set(appliedIds);
      setRescheduleDrafts((prev) => {
        const next = { ...prev };
        for (const id of done) {
          const cur = next[id];
          if (cur) next[id] = { ...cur, applied: true, error: null };
        }
        for (const [id, msg] of errors) {
          const cur = next[id];
          if (cur) next[id] = { ...cur, error: msg };
        }
        return next;
      });
      if (appliedIds.length > 0) {
        void refreshNotes();
        toast(t('reschedulesAppliedAllToast', { count: appliedIds.length }), 'success');
      }
    },
  });

  if (!open || isViewer) return null;

  const resetOn = status.data?.resetOn ?? null;
  const blockedMessage =
    blocked === 'budget'
      ? resetOn
        ? tv('blocked.budget', { resetOn: f.date(resetOn) })
        : tv('blocked.budgetNoDate')
      : blocked
        ? tv(`blocked.${blocked}`)
        : null;

  const runErrorCode =
    planMutation.isError
      ? noteVyErrorKey(errorCodeOf(planMutation.error))
      : result?.state === 'failed'
        ? noteVyErrorKey(result.errorCode)
        : null;

  const remainingReschedules = result
    ? result.reschedules.filter((r) => {
        const draft = rescheduleDrafts[r.todoId];
        if (draft?.applied) return false;
        const targetDate = draft ? draft.dueOn : r.dueOn;
        return Boolean(targetDate) && targetDate >= result.today;
      }).length
    : 0;

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-label={t('title')}
      data-testid="my-work-vy-planner"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          handleClose();
        }
      }}
      className="space-y-3 rounded-lg border border-proposal/40 bg-proposal/5 p-3.5 text-sm outline-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <NavIcon name="appAi" className="text-proposal" />
          <h2 className="font-medium text-foreground">{t('title')}</h2>
          <Badge variant="proposal" data-testid="my-work-vy-ai-badge">
            {t('aiBadge')}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statusReady && blocked === null && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-md:min-h-11"
              loading={planMutation.isPending}
              disabled={planMutation.isPending}
              onClick={() => planMutation.mutate()}
              data-testid="my-work-vy-rerun-btn"
            >
              {t('rerun')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="max-md:min-h-11"
            aria-label={t('close')}
            onClick={handleClose}
            data-testid="my-work-vy-close-btn"
          >
            {common('close')}
          </Button>
        </div>
      </div>

      <p className="text-xs text-subtle-foreground">{t('hint')}</p>

      {blockedMessage && (
        <div
          role="status"
          data-testid="my-work-vy-blocked"
          className="rounded-md border border-dashed bg-background px-3 py-2 text-xs text-subtle-foreground"
        >
          {blockedMessage}
        </div>
      )}

      {runErrorCode && <ErrorText data-testid="my-work-vy-error">{tv(`errors.${runErrorCode}`)}</ErrorText>}

      {planMutation.isPending && (
        <p role="status" data-testid="my-work-vy-loading" className="text-xs text-subtle-foreground">
          {t('running')}
        </p>
      )}

      {!planMutation.isPending && result?.state === 'ready' && (
        <div className="space-y-4">
          {result.dropped > 0 && (
            <p className="text-xs text-subtle-foreground" data-testid="my-work-vy-dropped">
              {t('droppedHint', { count: result.dropped })}
            </p>
          )}

          {result.focus.length === 0 && result.reschedules.length === 0 ? (
            <p role="status" data-testid="my-work-vy-empty" className="text-xs text-subtle-foreground">
              {t('empty')}
            </p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2 rounded-md border bg-background p-3">
                <h3 className="text-xs font-semibold tracking-wide text-foreground uppercase">{t('focusHeading')}</h3>
                {result.focus.length === 0 ? (
                  <p className="text-xs text-subtle-foreground">{t('emptyFocus')}</p>
                ) : (
                  <ul className="space-y-2" data-testid="my-work-vy-focus-list">
                    {result.focus.map((item) => {
                      const draft = focusDrafts[item.todoId] ?? {
                        priority: item.priority,
                        dueOn: item.dueOn && item.dueOn >= result.today ? item.dueOn : result.today,
                        edited: false,
                        applied: false,
                        error: null,
                      };
                      const showProposal = !draft.edited && !draft.applied;
                      return (
                        <li
                          key={item.todoId}
                          data-testid={`my-work-vy-focus-item-${item.todoId}`}
                          className="space-y-2 rounded-md border border-dashed border-proposal/60 bg-card p-2.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-foreground">{item.title}</span>
                            {showProposal ? (
                              <Badge variant="proposal" data-testid={`my-work-vy-focus-proposal-badge-${item.todoId}`}>
                                {t('proposalMark')}
                              </Badge>
                            ) : draft.applied ? (
                              <Badge variant="outline" data-testid={`my-work-vy-focus-applied-badge-${item.todoId}`}>
                                {t('applied')}
                              </Badge>
                            ) : null}
                          </div>
                          {item.reason && <p className="text-xs text-subtle-foreground">{item.reason}</p>}
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              aria-label={t('priorityLabel', { title: item.title })}
                              value={String(draft.priority)}
                              disabled={draft.applied || applyFocus.isPending}
                              onChange={(e) => {
                                const nextP = Number(e.target.value) as TodoPriority;
                                setFocusDrafts((prev) => ({
                                  ...prev,
                                  [item.todoId]: { ...draft, priority: nextP, edited: true },
                                }));
                              }}
                              className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground max-md:min-h-11"
                            >
                              {PRIORITIES.map((p) => (
                                <option key={p} value={p}>
                                  {tt('priorityShort', { level: String(p) })}
                                </option>
                              ))}
                            </select>
                            <DateInput
                              aria-label={t('focusDateLabel', { title: item.title })}
                              value={draft.dueOn}
                              min={result.today}
                              disabled={draft.applied || applyFocus.isPending}
                              inputClassName="text-xs max-md:min-h-11"
                              onChange={(nextDueOn) =>
                                setFocusDrafts((prev) => ({
                                  ...prev,
                                  [item.todoId]: { ...draft, dueOn: nextDueOn, edited: true },
                                }))
                              }
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant={draft.applied ? 'outline' : 'default'}
                              className="ml-auto max-md:min-h-11"
                              disabled={draft.applied || applyFocus.isPending}
                              loading={applyFocus.isPending && applyFocus.variables?.todoId === item.todoId}
                              onClick={() => applyFocus.mutate(item)}
                              data-testid={`my-work-vy-focus-apply-${item.todoId}`}
                            >
                              {draft.applied ? t('applied') : t('applyFocus')}
                            </Button>
                          </div>
                          {draft.error && <ErrorText>{draft.error}</ErrorText>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="space-y-2 rounded-md border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold tracking-wide text-foreground uppercase">{t('reschedulesHeading')}</h3>
                  {remainingReschedules > 1 && (
                    <Button
                      type="button"
                      size="sm"
                      className="max-md:min-h-11"
                      loading={applyAllReschedules.isPending}
                      disabled={applyAllReschedules.isPending}
                      onClick={() => applyAllReschedules.mutate()}
                      data-testid="my-work-vy-reschedule-apply-all"
                    >
                      {t('applyAllReschedules', { count: remainingReschedules })}
                    </Button>
                  )}
                </div>
                {result.reschedules.length === 0 ? (
                  <p className="text-xs text-subtle-foreground">{t('emptyReschedules')}</p>
                ) : (
                  <ul className="space-y-2" data-testid="my-work-vy-reschedule-list">
                    {result.reschedules.map((item) => {
                      const draft = rescheduleDrafts[item.todoId] ?? {
                        dueOn: item.dueOn,
                        edited: false,
                        applied: false,
                        error: null,
                      };
                      const showProposal = !draft.edited && !draft.applied;
                      return (
                        <li
                          key={item.todoId}
                          data-testid={`my-work-vy-reschedule-item-${item.todoId}`}
                          className="space-y-2 rounded-md border border-dashed border-proposal/60 bg-card p-2.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-foreground">{item.title}</span>
                            {showProposal ? (
                              <Badge variant="proposal" data-testid={`my-work-vy-reschedule-proposal-badge-${item.todoId}`}>
                                {t('proposalMark')}
                              </Badge>
                            ) : draft.applied ? (
                              <Badge variant="outline" data-testid={`my-work-vy-reschedule-applied-badge-${item.todoId}`}>
                                {t('applied')}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                            {item.currentDueOn && <span>{t('previousDue', { due: f.date(item.currentDueOn) })}</span>}
                            {item.reason && <span>{item.reason}</span>}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <DateInput
                              aria-label={t('newDateLabel', { title: item.title })}
                              value={draft.dueOn}
                              min={result.today}
                              disabled={draft.applied || applyOneReschedule.isPending || applyAllReschedules.isPending}
                              inputClassName="text-xs max-md:min-h-11"
                              onChange={(nextDueOn) =>
                                setRescheduleDrafts((prev) => ({
                                  ...prev,
                                  [item.todoId]: { ...draft, dueOn: nextDueOn, edited: true },
                                }))
                              }
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant={draft.applied ? 'outline' : 'default'}
                              className="ml-auto max-md:min-h-11"
                              disabled={
                                draft.applied ||
                                !draft.dueOn ||
                                draft.dueOn < result.today ||
                                applyOneReschedule.isPending ||
                                applyAllReschedules.isPending
                              }
                              loading={applyOneReschedule.isPending && applyOneReschedule.variables?.todoId === item.todoId}
                              onClick={() => applyOneReschedule.mutate(item)}
                              data-testid={`my-work-vy-reschedule-apply-${item.todoId}`}
                            >
                              {draft.applied ? t('applied') : t('applyReschedule')}
                            </Button>
                          </div>
                          {draft.error && <ErrorText>{draft.error}</ErrorText>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation } from '@tanstack/react-query';
import {
  TASK_CHECKLIST_STEP_MAX,
  TASK_CHECKLIST_STEPS_MAX,
  countTaskChecklistSteps,
  serializeTaskChecklist,
  type TaskChecklistStep,
} from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { ProjectIcon } from '@crove/ui/components/project-icon';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText } from './ui.tsx';

export function normalizeChecklistSteps(steps: readonly TaskChecklistStep[]): TaskChecklistStep[] {
  return steps.map((step) => ({ text: step.text.trim(), done: step.done }));
}

export function hasBlankChecklistStep(steps: readonly TaskChecklistStep[]): boolean {
  return steps.some((step) => step.text.trim().length === 0);
}

function moveStep(steps: readonly TaskChecklistStep[], from: number, to: number): TaskChecklistStep[] {
  const next = steps.map((step) => ({ ...step }));
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

export function TaskChecklistBadge({
  steps,
  label,
  className,
}: {
  steps: readonly TaskChecklistStep[] | { done: number; total: number };
  label?: string;
  className?: string;
}) {
  const t = useTranslations('tasks');
  const { done, total } = 'total' in steps ? steps : countTaskChecklistSteps(steps);
  if (total === 0) return null;
  const accessibleLabel = label ?? t('checklistProgress', { done: String(done), total: String(total) });
  return (
    <span
      data-testid="task-checklist-badge"
      className={className ?? 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground'}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      <ProjectIcon name="checklist" className="size-3" />
      <span>
        {done}/{total}
      </span>
    </span>
  );
}

function ChecklistRows({
  steps,
  idPrefix,
  disabled,
  stepError,
  onToggle,
  onChangeText,
  onCommitText,
  onMove,
  onRemove,
}: {
  steps: readonly TaskChecklistStep[];
  idPrefix: string;
  disabled: boolean;
  stepError?: boolean;
  onToggle: (index: number, checked: boolean) => void;
  onChangeText: (index: number, text: string) => void;
  onCommitText?: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  const t = useTranslations('tasks');
  return (
    <ul className="space-y-1.5">
      {steps.map((step, index) => {
        const invalid = Boolean(stepError && step.text.trim().length === 0);
        return (
          <li key={`${idPrefix}-step-${index}`} className="flex items-center gap-1.5">
            <Checkbox
              checked={step.done}
              disabled={disabled}
              aria-label={t('checklistStepDone', { step: step.text || String(index + 1) })}
              onCheckedChange={(checked) => onToggle(index, checked === true)}
            />
            <Input
              value={step.text}
              disabled={disabled}
              maxLength={TASK_CHECKLIST_STEP_MAX}
              aria-label={t('checklistStepLabel', { n: String(index + 1) })}
              aria-invalid={invalid || undefined}
              className={step.done ? 'h-8 flex-1 text-sm text-muted-foreground line-through' : 'h-8 flex-1 text-sm'}
              onChange={(e) => onChangeText(index, e.target.value)}
              onBlur={onCommitText ? () => onCommitText(index) : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && onCommitText) {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              disabled={disabled || index === 0}
              aria-label={t('checklistMoveUp')}
              title={t('checklistMoveUp')}
              onMouseDown={(e) => {
                if (onCommitText) e.preventDefault();
              }}
              onClick={() => onMove(index, index - 1)}
            >
              <ProjectIcon name="arrowUp" className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              disabled={disabled || index === steps.length - 1}
              aria-label={t('checklistMoveDown')}
              title={t('checklistMoveDown')}
              onMouseDown={(e) => {
                if (onCommitText) e.preventDefault();
              }}
              onClick={() => onMove(index, index + 1)}
            >
              <ProjectIcon name="arrowDown" className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              disabled={disabled}
              aria-label={t('checklistRemove')}
              title={t('checklistRemove')}
              onMouseDown={(e) => {
                if (onCommitText) e.preventDefault();
              }}
              onClick={() => onRemove(index)}
            >
              <ProjectIcon name="remove" className="size-3.5" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function ChecklistAddRow({
  draft,
  atLimit,
  disabled,
  onDraftChange,
  onAdd,
}: {
  draft: string;
  atLimit: boolean;
  disabled: boolean;
  onDraftChange: (text: string) => void;
  onAdd: () => void;
}) {
  const t = useTranslations('tasks');
  if (atLimit) {
    return <p className="text-xs text-muted-foreground">{t('checklistLimit', { max: String(TASK_CHECKLIST_STEPS_MAX) })}</p>;
  }
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={draft}
        disabled={disabled}
        maxLength={TASK_CHECKLIST_STEP_MAX}
        placeholder={t('checklistNewStep')}
        aria-label={t('checklistNewStep')}
        className="h-8 flex-1 text-sm"
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onAdd();
          }
        }}
      />
      <Button type="button" size="sm" variant="outline" disabled={disabled || !draft.trim()} onClick={onAdd}>
        <ProjectIcon name="plus" className="size-3.5" />
        <span>{t('checklistAdd')}</span>
      </Button>
    </div>
  );
}

export function TaskChecklistEditor({
  value,
  onChange,
  disabled = false,
  stepError = false,
  label,
  idPrefix,
}: {
  value: readonly TaskChecklistStep[];
  onChange: (next: TaskChecklistStep[]) => void;
  disabled?: boolean;
  stepError?: boolean;
  label?: string;
  idPrefix: string;
}) {
  const t = useTranslations('tasks');
  const [draft, setDraft] = useState('');
  const { done, total } = countTaskChecklistSteps(value);
  const atLimit = value.length >= TASK_CHECKLIST_STEPS_MAX;

  const addStep = () => {
    const trimmed = draft.trim();
    if (!trimmed || atLimit || disabled) return;
    onChange([...value, { text: trimmed.slice(0, TASK_CHECKLIST_STEP_MAX), done: false }]);
    setDraft('');
  };

  return (
    <div className="space-y-2" data-testid={`${idPrefix}-checklist-editor`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-subtle-foreground">{label ?? t('checklist')}</span>
        {total > 0 && <TaskChecklistBadge steps={{ done, total }} />}
      </div>
      {value.length > 0 && (
        <ChecklistRows
          steps={value}
          idPrefix={idPrefix}
          disabled={disabled}
          stepError={stepError}
          onToggle={(index, doneValue) => onChange(value.map((item, idx) => (idx === index ? { ...item, done: doneValue } : item)))}
          onChangeText={(index, text) => onChange(value.map((item, idx) => (idx === index ? { ...item, text } : item)))}
          onMove={(from, to) => onChange(moveStep(value, from, to))}
          onRemove={(index) => onChange(value.filter((_, idx) => idx !== index))}
        />
      )}
      <ChecklistAddRow draft={draft} atLimit={atLimit} disabled={disabled} onDraftChange={setDraft} onAdd={addStep} />
      {stepError && <p className="text-xs text-destructive">{t('checklistStepRequired')}</p>}
    </div>
  );
}

export function TaskChecklistSection({
  taskId,
  checklist,
  checkedOut,
  readOnly = false,
}: {
  taskId: string;
  checklist: readonly TaskChecklistStep[];
  checkedOut: boolean;
  readOnly?: boolean;
}) {
  const t = useTranslations('tasks');
  const [steps, setSteps] = useState<TaskChecklistStep[]>(() => [...checklist]);
  const [draft, setDraft] = useState('');
  const savedRef = useRef(serializeTaskChecklist(checklist));

  const update = useMutation(
    orpc.tasks.update.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.tasks.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.projects.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
        ]),
      onError: () => {
        savedRef.current = serializeTaskChecklist(checklist);
        setSteps(checklist.map((step) => ({ ...step })));
      },
    }),
  );

  useEffect(() => {
    const incoming = serializeTaskChecklist(checklist);
    if (incoming !== savedRef.current && !update.isPending) {
      savedRef.current = incoming;
      setSteps(checklist.map((step) => ({ ...step })));
    }
  }, [checklist, update.isPending]);

  const commit = (next: TaskChecklistStep[]) => {
    if (readOnly) return;
    if (hasBlankChecklistStep(next)) {
      setSteps(checklist.map((step) => ({ ...step })));
      return;
    }
    const normalized = normalizeChecklistSteps(next);
    setSteps(normalized);
    update.mutate({ id: taskId, checklist: normalized, idempotencyKey: crypto.randomUUID() });
  };

  const disabled = checkedOut || readOnly || update.isPending;
  const { done, total } = countTaskChecklistSteps(steps);
  const atLimit = steps.length >= TASK_CHECKLIST_STEPS_MAX;

  const addStep = () => {
    const trimmed = draft.trim();
    if (!trimmed || atLimit || disabled) return;
    setDraft('');
    commit([...steps, { text: trimmed.slice(0, TASK_CHECKLIST_STEP_MAX), done: false }]);
  };

  const commitTextAt = (index: number) => {
    const current = steps[index];
    const saved = checklist[index];
    if (!current) return;
    const trimmed = current.text.trim();
    if (!trimmed) {
      setSteps(checklist.map((step) => ({ ...step })));
      return;
    }
    if (saved && saved.text === trimmed && saved.done === current.done) return;
    commit(steps.map((item, idx) => (idx === index ? { ...item, text: trimmed } : item)));
  };

  return (
    <div className="space-y-3" data-testid="task-checklist-section">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs text-subtle-foreground">{t('checklist')}</h2>
          {total > 0 && <TaskChecklistBadge steps={{ done, total }} />}
        </div>
        {update.isPending && <span className="text-xs text-muted-foreground">{t('checklistSaving')}</span>}
      </div>

      {update.error && <ErrorText>{errorMessage(update.error)}</ErrorText>}

      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('checklistEmpty')}</p>
      ) : (
        <ChecklistRows
          steps={steps}
          idPrefix="detail"
          disabled={disabled}
          onToggle={(index, doneValue) => commit(steps.map((item, idx) => (idx === index ? { ...item, done: doneValue } : item)))}
          onChangeText={(index, text) => setSteps((prev) => prev.map((item, idx) => (idx === index ? { ...item, text } : item)))}
          onCommitText={commitTextAt}
          onMove={(from, to) => commit(moveStep(steps, from, to))}
          onRemove={(index) => commit(steps.filter((_, idx) => idx !== index))}
        />
      )}

      {!readOnly && <ChecklistAddRow draft={draft} atLimit={atLimit} disabled={disabled} onDraftChange={setDraft} onAdd={addStep} />}
    </div>
  );
}

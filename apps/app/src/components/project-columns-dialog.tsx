// SPDX-License-Identifier: AGPL-3.0-only
// Dialog to opt in and manage custom project board columns mapped to canonical statuses (#2605, ADR-0056).
import { useMutation } from '@tanstack/react-query';
import {
  BOARD_TASK_STATUSES,
  PROJECT_COLUMNS_MAX,
  PROJECT_COLUMN_NAME_MAX,
  PROJECT_COLUMN_WIP_MAX,
  type BoardTaskStatus,
  type ProjectColumn,
  type ProjectColumnColor,
} from '@ludy/kernel-contract';
import { useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { errorMessage, orpc } from '../lib/api.ts';
import { COLUMN_COLOR_DOT_CLASS, PROJECT_COLUMN_COLORS } from '../lib/projects.ts';
import { refreshProjectQueries } from './project-task-dialog.tsx';

function parseWipLimit(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > PROJECT_COLUMN_WIP_MAX) return { ok: false };
  return { ok: true, value: n };
}

function canDeleteColumn(target: ProjectColumn, columns: readonly ProjectColumn[]): boolean {
  const remaining = columns.filter((c) => c.id !== target.id);
  return remaining.some((c) => c.taskStatus === 'todo') && remaining.some((c) => c.taskStatus === 'done');
}

export function ProjectColumnsDialogBody({
  projectId,
  columns,
  canManage,
  onClearRequest,
  onAfterMutate,
}: {
  projectId: string;
  columns: readonly ProjectColumn[];
  canManage: boolean;
  onClearRequest?: () => void;
  onAfterMutate?: () => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const locale = useLocale();
  const language: 'vi' | 'en' = locale === 'en' ? 'en' : 'vi';

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<BoardTaskStatus>('todo');
  const [editColor, setEditColor] = useState<ProjectColumnColor>('neutral');
  const [editWip, setEditWip] = useState('');

  const [deletingCol, setDeletingCol] = useState<ProjectColumn | null>(null);
  const [fallbackId, setFallbackId] = useState('');

  const [newName, setNewName] = useState('');
  const [newStatus, setNewStatus] = useState<BoardTaskStatus>('in_progress');
  const [newColor, setNewColor] = useState<ProjectColumnColor>('neutral');
  const [newWip, setNewWip] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const initDefaults = useMutation(
    orpc.projects.initDefaultColumns.mutationOptions({
      onSuccess: () => {
        setValidationError(null);
        refreshProjectQueries();
        onAfterMutate?.();
      },
    }),
  );

  const createColumn = useMutation(
    orpc.projects.createColumn.mutationOptions({
      onSuccess: () => {
        setNewName('');
        setNewWip('');
        setValidationError(null);
        refreshProjectQueries();
        onAfterMutate?.();
      },
    }),
  );

  const updateColumn = useMutation(
    orpc.projects.updateColumn.mutationOptions({
      onSuccess: () => {
        setEditingId(null);
        setValidationError(null);
        refreshProjectQueries();
        onAfterMutate?.();
      },
    }),
  );

  const reorderColumn = useMutation(
    orpc.projects.reorderColumn.mutationOptions({
      onSuccess: () => {
        setValidationError(null);
        refreshProjectQueries();
        onAfterMutate?.();
      },
    }),
  );

  const deleteColumn = useMutation(
    orpc.projects.deleteColumn.mutationOptions({
      onSuccess: () => {
        setDeletingCol(null);
        setFallbackId('');
        setValidationError(null);
        refreshProjectQueries();
        onAfterMutate?.();
      },
    }),
  );

  const busy =
    initDefaults.isPending ||
    createColumn.isPending ||
    updateColumn.isPending ||
    reorderColumn.isPending ||
    deleteColumn.isPending;

  const activeError =
    validationError ??
    (initDefaults.error ? errorMessage(initDefaults.error) : null) ??
    (createColumn.error ? errorMessage(createColumn.error) : null) ??
    (updateColumn.error ? errorMessage(updateColumn.error) : null) ??
    (reorderColumn.error ? errorMessage(reorderColumn.error) : null) ??
    (deleteColumn.error ? errorMessage(deleteColumn.error) : null);

  const clearErrors = () => {
    setValidationError(null);
    initDefaults.reset();
    createColumn.reset();
    updateColumn.reset();
    reorderColumn.reset();
    deleteColumn.reset();
    onClearRequest?.();
  };

  const startEdit = (col: ProjectColumn) => {
    clearErrors();
    setDeletingCol(null);
    setEditingId(col.id);
    setEditName(col.name);
    setEditStatus(col.taskStatus);
    setEditColor(col.color);
    setEditWip(col.wipLimit === null ? '' : String(col.wipLimit));
  };

  const startDelete = (col: ProjectColumn) => {
    clearErrors();
    setEditingId(null);
    const candidates = columns.filter((c) => c.id !== col.id);
    const sameStatus = candidates.find((c) => c.taskStatus === col.taskStatus);
    setFallbackId((sameStatus ?? candidates[0])?.id ?? '');
    setDeletingCol(col);
  };

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    if (!canManage || busy) return;
    clearErrors();
    const trimmed = newName.trim();
    if (!trimmed || trimmed.length > PROJECT_COLUMN_NAME_MAX) {
      setValidationError(t('columns.namePlaceholder'));
      return;
    }
    const wip = parseWipLimit(newWip);
    if (!wip.ok) {
      setValidationError(t('columns.wipLimitLabel'));
      return;
    }
    createColumn.mutate({
      projectId,
      name: trimmed,
      taskStatus: newStatus,
      color: newColor,
      wipLimit: wip.value,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const submitEdit = (e: FormEvent, colId: string) => {
    e.preventDefault();
    if (!canManage || busy) return;
    clearErrors();
    const trimmed = editName.trim();
    if (!trimmed || trimmed.length > PROJECT_COLUMN_NAME_MAX) {
      setValidationError(t('columns.namePlaceholder'));
      return;
    }
    const wip = parseWipLimit(editWip);
    if (!wip.ok) {
      setValidationError(t('columns.wipLimitLabel'));
      return;
    }
    updateColumn.mutate({
      projectId,
      columnId: colId,
      name: trimmed,
      taskStatus: editStatus,
      color: editColor,
      wipLimit: wip.value,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  return (
    <div className="space-y-4">
      {activeError && (
        <Alert className="border-destructive/30 bg-destructive/10" data-testid="project-columns-error">
          <NavIcon name="info" className="text-destructive" />
          <AlertDescription className="text-xs text-foreground">{activeError}</AlertDescription>
        </Alert>
      )}

      {columns.length === 0 ? (
          <div className="space-y-4 rounded-xl border border-border bg-muted/25 p-4" data-testid="project-columns-empty-state">
            <p className="text-sm text-foreground">{t('columns.defaultSummary')}</p>
            <div className="flex flex-wrap gap-1.5">
              {BOARD_TASK_STATUSES.map((status) => (
                <Badge key={status} variant="outline">
                  {tt(`status.${status}`)}
                </Badge>
              ))}
            </div>
            {canManage && (
              <Button
                type="button"
                className="min-h-11"
                disabled={busy}
                onClick={() => {
                  clearErrors();
                  initDefaults.mutate({
                    projectId,
                    language,
                    idempotencyKey: crypto.randomUUID(),
                  });
                }}
                data-testid="init-default-columns-button"
              >
                {initDefaults.isPending ? t('columns.enablingAction') : t('columns.enableAction')}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ul className="space-y-2" data-testid="project-columns-list">
              {columns.map((col, idx) => {
                const prev = idx > 0 ? columns[idx - 1] : undefined;
                const next = idx < columns.length - 1 ? columns[idx + 1] : undefined;
                const isEditing = editingId === col.id;
                const isDeleting = deletingCol?.id === col.id;
                const deletable = canDeleteColumn(col, columns);

                return (
                  <li
                    key={col.id}
                    data-testid="project-column-config-row"
                    data-column-id={col.id}
                    className="rounded-lg border border-border bg-card p-3"
                  >
                    {isEditing ? (
                      <form onSubmit={(e) => submitEdit(e, col.id)} className="space-y-3" data-testid="edit-column-form">
                        <div className="grid gap-2.5 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label htmlFor={`col-edit-name-${col.id}`} className="text-xs">
                              {t('columns.nameLabel')}
                            </Label>
                            <Input
                              id={`col-edit-name-${col.id}`}
                              value={editName}
                              maxLength={PROJECT_COLUMN_NAME_MAX}
                              onChange={(e) => setEditName(e.target.value)}
                              className="min-h-11"
                              required
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`col-edit-status-${col.id}`} className="text-xs">
                              {t('columns.statusLabel')}
                            </Label>
                            <NativeSelect
                              id={`col-edit-status-${col.id}`}
                              value={editStatus}
                              onChange={(e) => setEditStatus(e.target.value as BoardTaskStatus)}
                              className="w-full [&_select]:min-h-11 [&_select]:text-xs"
                            >
                              {BOARD_TASK_STATUSES.map((st) => (
                                <NativeSelectOption key={st} value={st}>
                                  {tt(`status.${st}`)}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`col-edit-color-${col.id}`} className="text-xs">
                              {t('columns.colorLabel')}
                            </Label>
                            <NativeSelect
                              id={`col-edit-color-${col.id}`}
                              value={editColor}
                              onChange={(e) => setEditColor(e.target.value as ProjectColumnColor)}
                              className="w-full [&_select]:min-h-11 [&_select]:text-xs"
                            >
                              {PROJECT_COLUMN_COLORS.map((c) => (
                                <NativeSelectOption key={c} value={c}>
                                  {t(`columns.colorOptions.${c}`)}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`col-edit-wip-${col.id}`} className="text-xs">
                              {t('columns.wipLimitLabel')}
                            </Label>
                            <Input
                              id={`col-edit-wip-${col.id}`}
                              type="number"
                              min={1}
                              max={PROJECT_COLUMN_WIP_MAX}
                              placeholder={t('columns.wipLimitPlaceholder')}
                              value={editWip}
                              onChange={(e) => setEditWip(e.target.value)}
                              className="min-h-11"
                            />
                          </div>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button type="button" variant="outline" className="min-h-11" onClick={() => setEditingId(null)} disabled={busy}>
                            {t('columns.cancelAction')}
                          </Button>
                          <Button type="submit" className="min-h-11" disabled={busy} data-testid="save-column-button">
                            {t('columns.saveAction')}
                          </Button>
                        </div>
                      </form>
                    ) : isDeleting ? (
                      <div className="space-y-3" data-testid="delete-column-confirm">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">{t('columns.deleteTitle', { name: col.name })}</p>
                          <p className="text-xs text-muted-foreground">{t('columns.deleteDescription')}</p>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`col-fallback-${col.id}`} className="text-xs">
                            {t('columns.fallbackLabel')}
                          </Label>
                          <NativeSelect
                            id={`col-fallback-${col.id}`}
                            value={fallbackId}
                            onChange={(e) => setFallbackId(e.target.value)}
                            className="w-full [&_select]:min-h-11 [&_select]:text-xs"
                          >
                            {columns
                              .filter((candidate) => candidate.id !== col.id)
                              .map((candidate) => (
                                <NativeSelectOption key={candidate.id} value={candidate.id}>
                                  {candidate.name} ({tt(`status.${candidate.taskStatus}`)})
                                </NativeSelectOption>
                              ))}
                          </NativeSelect>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            onClick={() => setDeletingCol(null)}
                            disabled={busy}
                          >
                            {t('columns.cancelAction')}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            className="min-h-11"
                            disabled={busy || !fallbackId}
                            onClick={() => {
                              clearErrors();
                              deleteColumn.mutate({
                                projectId,
                                columnId: col.id,
                                fallbackColumnId: fallbackId,
                                idempotencyKey: crypto.randomUUID(),
                              });
                            }}
                            data-testid="confirm-delete-column-button"
                          >
                            {deleteColumn.isPending ? t('columns.deletingAction') : t('columns.confirmDeleteAction')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`size-2.5 shrink-0 rounded-full ${COLUMN_COLOR_DOT_CLASS[col.color]}`} aria-hidden="true" />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{col.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {tt(`status.${col.taskStatus}`)}
                              {col.wipLimit !== null ? ` · WIP ${col.wipLimit}` : ''}
                            </p>
                          </div>
                        </div>

                        {canManage && (
                          <div className="flex flex-wrap items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              className="min-h-11 min-w-11 px-2"
                              disabled={busy || !prev}
                              aria-label={t('columns.moveUpOf', { name: col.name })}
                              data-testid="reorder-column-up"
                              onClick={() => {
                                if (!prev) return;
                                clearErrors();
                                reorderColumn.mutate({
                                  projectId,
                                  columnId: col.id,
                                  place: 'before',
                                  anchorId: prev.id,
                                  idempotencyKey: crypto.randomUUID(),
                                });
                              }}
                            >
                              <ProjectIcon name="arrowUp" className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              className="min-h-11 min-w-11 px-2"
                              disabled={busy || !next}
                              aria-label={t('columns.moveDownOf', { name: col.name })}
                              data-testid="reorder-column-down"
                              onClick={() => {
                                if (!next) return;
                                clearErrors();
                                reorderColumn.mutate({
                                  projectId,
                                  columnId: col.id,
                                  place: 'after',
                                  anchorId: next.id,
                                  idempotencyKey: crypto.randomUUID(),
                                });
                              }}
                            >
                              <ProjectIcon name="arrowDown" className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11 px-3 text-xs"
                              disabled={busy}
                              data-testid="edit-column-button"
                              onClick={() => startEdit(col)}
                            >
                              {t('columns.editAction')}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11 px-3 text-xs"
                              disabled={busy || !deletable}
                              title={!deletable ? t('columns.keepTodoDoneHint') : undefined}
                              data-testid="delete-column-button"
                              onClick={() => startDelete(col)}
                            >
                              {t('columns.deleteAction')}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            <p className="text-xs text-muted-foreground">{t('columns.keepTodoDoneHint')}</p>

            {canManage &&
              (columns.length >= PROJECT_COLUMNS_MAX ? (
                <p className="text-xs text-muted-foreground" data-testid="project-columns-max-notice">
                  {t('columns.limitNotice', { max: String(PROJECT_COLUMNS_MAX) })}
                </p>
              ) : (
                <form
                  onSubmit={submitCreate}
                  className="space-y-3 rounded-xl border border-border bg-muted/25 p-3.5"
                  data-testid="add-column-form"
                >
                  <h3 className="text-sm font-medium text-foreground">{t('columns.addTitle')}</h3>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="new-column-name" className="text-xs">
                        {t('columns.nameLabel')}
                      </Label>
                      <Input
                        id="new-column-name"
                        value={newName}
                        maxLength={PROJECT_COLUMN_NAME_MAX}
                        placeholder={t('columns.namePlaceholder')}
                        onChange={(e) => setNewName(e.target.value)}
                        className="min-h-11"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="new-column-status" className="text-xs">
                        {t('columns.statusLabel')}
                      </Label>
                      <NativeSelect
                        id="new-column-status"
                        value={newStatus}
                        onChange={(e) => setNewStatus(e.target.value as BoardTaskStatus)}
                        className="w-full [&_select]:min-h-11 [&_select]:text-xs"
                      >
                        {BOARD_TASK_STATUSES.map((st) => (
                          <NativeSelectOption key={st} value={st}>
                            {tt(`status.${st}`)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="new-column-color" className="text-xs">
                        {t('columns.colorLabel')}
                      </Label>
                      <NativeSelect
                        id="new-column-color"
                        value={newColor}
                        onChange={(e) => setNewColor(e.target.value as ProjectColumnColor)}
                        className="w-full [&_select]:min-h-11 [&_select]:text-xs"
                      >
                        {PROJECT_COLUMN_COLORS.map((c) => (
                          <NativeSelectOption key={c} value={c}>
                            {t(`columns.colorOptions.${c}`)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="new-column-wip" className="text-xs">
                        {t('columns.wipLimitLabel')}
                      </Label>
                      <Input
                        id="new-column-wip"
                        type="number"
                        min={1}
                        max={PROJECT_COLUMN_WIP_MAX}
                        placeholder={t('columns.wipLimitPlaceholder')}
                        value={newWip}
                        onChange={(e) => setNewWip(e.target.value)}
                        className="min-h-11"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button type="submit" className="min-h-11" disabled={busy || !newName.trim()} data-testid="create-column-button">
                      {createColumn.isPending ? t('columns.addingAction') : t('columns.addAction')}
                    </Button>
                  </div>
                </form>
              ))}
          </div>
        )}
    </div>
  );
}

export function ProjectColumnsDialog({
  open,
  onOpenChange,
  projectId,
  columns,
  canManage,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  projectId: string;
  columns: readonly ProjectColumn[];
  canManage: boolean;
}) {
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const [sessionKey, setSessionKey] = useState(0);

  const handleOpenChange = (next: boolean) => {
    if (!next) setSessionKey((n) => n + 1);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent closeLabel={tc('close')} data-testid="project-columns-dialog" className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('columns.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('columns.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <ProjectColumnsDialogBody key={sessionKey} projectId={projectId} columns={columns} canManage={canManage} />

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>
            {t('columns.cancelAction')}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

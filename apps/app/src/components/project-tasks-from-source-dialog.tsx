// SPDX-License-Identifier: AGPL-3.0-only
// Unified dialog on /o/$slug/projects/$id for Vy proposing project tasks from a readable note, meeting, or conversation (#2608).
// Shows proposal badge + dashed border-proposal outline while unedited, and requires explicit human confirmation.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import {
  PROJECT_TASK_TITLE_MAX,
  type ConversationSummary,
  type ProjectProposedTask,
  type ProjectSeat,
  type ProjectTaskSourceType,
  type ProjectTasksFromSourceResult,
} from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { meetingsInstalled } from './linked-meetings.tsx';
import {
  browserTimeZone,
  isModuleOffError,
  noteProposalBlocked,
  resolveSignatureIdempotencyKey,
  seatLabel,
  sourceProposalErrorKey,
  toEditableRows,
  type BatchIdempotencyState,
  type EditableProposalRow,
} from './note-task-proposals.tsx';
import { notesInstalled } from './notes-panel.tsx';
import { refreshProjectQueries } from './project-task-dialog.tsx';
import { ErrorText, Notice, RowsSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { conversationSummaryTitle } from '../lib/agents.ts';
import { clientForOrg, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

export type SourceTabKind = 'note' | 'meeting' | 'conversation';

export const SOURCE_TYPE_BY_TAB: Record<SourceTabKind, ProjectTaskSourceType> = {
  note: 'notes.note',
  meeting: 'meetings.meeting',
  conversation: 'kernel.conversation',
};

export interface SourceEditableProposalRow extends EditableProposalRow {
  edited: boolean;
}

export function toSourceEditableRows(proposals: readonly ProjectProposedTask[]): SourceEditableProposalRow[] {
  return toEditableRows(proposals).map((row) => ({ ...row, edited: false }));
}

export function defaultSourceTab(installed: { notes: boolean; meetings: boolean }): SourceTabKind {
  if (installed.notes) return 'note';
  if (installed.meetings) return 'meeting';
  return 'conversation';
}

export interface SourceProposalSession {
  sourceType: ProjectTaskSourceType;
  sourceId: string;
  sourceTitle: string;
  seats: ProjectSeat[];
  rows: SourceEditableProposalRow[];
  droppedCount: number;
}

export function ProjectTasksFromSourceDialog({
  open,
  onOpenChange,
  slug,
  projectId,
  projectName,
  disabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  projectId: string;
  projectName: string;
  disabled?: boolean;
}) {
  const t = useTranslations('projects.tasksFromSource');
  const tc = useTranslations('common');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" closeLabel={tc('close')} data-testid="project-tasks-from-source-dialog">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>{t('title')}</DialogTitle>
            <Badge variant="proposal" data-testid="project-tasks-source-ai-badge">
              {t('aiBadge')}
            </Badge>
          </div>
          <DialogDescription>
            {projectName ? `${projectName}: ${t('subtitle')}` : t('subtitle')}
          </DialogDescription>
        </DialogHeader>
        <ProjectTasksFromSourceBody
          open={open}
          onClose={() => onOpenChange(false)}
          slug={slug}
          projectId={projectId}
          disabled={disabled}
        />
      </DialogContent>
    </Dialog>
  );
}

export function isCurrentConversationPage(
  activeEpoch: number,
  activeSearch: string,
  vars: { epoch: number; search: string },
): boolean {
  return vars.epoch === activeEpoch && vars.search === activeSearch;
}

export function ProjectTasksFromSourceBody({
  open,
  onClose,
  slug,
  projectId,
  disabled = false,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  projectId: string;
  disabled?: boolean;
}) {
  const t = useTranslations('projects.tasksFromSource');
  const tc = useTranslations('common');
  const f = useFormat();
  const locale = useLocale();
  const language: 'vi' | 'en' = locale === 'en' ? 'en' : 'vi';

  const hasNotes = notesInstalled();
  const hasMeetings = meetingsInstalled();

  const [tab, setTab] = useState<SourceTabKind>(() => defaultSourceTab({ notes: hasNotes, meetings: hasMeetings }));
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [convSearch, setConvSearch] = useState('');
  const [extraConversations, setExtraConversations] = useState<ConversationSummary[]>([]);
  const [convMoreOverride, setConvMoreOverride] = useState<boolean | null>(null);
  const [session, setSession] = useState<SourceProposalSession | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const confirmKeyRef = useRef<BatchIdempotencyState | null>(null);
  const loadMoreEpochRef = useRef(0);

  const trimmedConvSearch = convSearch.trim();
  const currentConvSearchRef = useRef(trimmedConvSearch);
  currentConvSearchRef.current = trimmedConvSearch;
  const sourceType = SOURCE_TYPE_BY_TAB[tab];
  const activeModuleOff =
    (tab === 'note' && !hasNotes) || (tab === 'meeting' && !hasMeetings);

  const statusQuery = useQuery({
    ...orpc.projects.tasksFromSourceStatus.queryOptions({ input: {} }),
    enabled: open && !disabled,
  });
  const meterQuery = useQuery({
    ...orpc.ai.meter.queryOptions({ input: { module: 'projects' } }),
    enabled: open && !disabled,
    staleTime: 15_000,
  });

  const mineNotesQuery = useQuery({
    ...orpc.notes.list.queryOptions({ input: { view: 'mine', limit: 100 } }),
    enabled: open && !disabled && tab === 'note' && hasNotes,
  });
  const sharedNotesQuery = useQuery({
    ...orpc.notes.list.queryOptions({ input: { view: 'shared', limit: 100 } }),
    enabled: open && !disabled && tab === 'note' && hasNotes,
  });
  const meetingsQuery = useQuery({
    ...orpc.meetings.list.queryOptions({ input: { limit: 100 } }),
    enabled: open && !disabled && tab === 'meeting' && hasMeetings,
  });
  const conversationsQuery = useQuery({
    ...orpc.conversations.list.queryOptions({
      input: { limit: 50, ...(trimmedConvSearch ? { q: trimmedConvSearch } : {}) },
    }),
    enabled: open && !disabled && tab === 'conversation',
  });

  const allConversations = useMemo(() => {
    const base = conversationsQuery.data?.conversations ?? [];
    if (extraConversations.length === 0) return base;
    const seen = new Set(base.map((c) => c.id));
    return [...base, ...extraConversations.filter((c) => !seen.has(c.id))];
  }, [conversationsQuery.data?.conversations, extraConversations]);

  const conversationsHasMore = convMoreOverride ?? (conversationsQuery.data?.more ?? false);

  const sourceOptions = useMemo((): Array<{ id: string; label: string }> => {
    if (tab === 'note') {
      if (!hasNotes) return [];
      const combined = [...(mineNotesQuery.data ?? []), ...(sharedNotesQuery.data ?? [])];
      const seen = new Set<string>();
      const items: Array<{ id: string; label: string }> = [];
      for (const n of combined) {
        if (n.deletedAt !== null || seen.has(n.id)) continue;
        seen.add(n.id);
        items.push({ id: n.id, label: n.title.trim() || t('untitledNote') });
      }
      return items;
    }
    if (tab === 'meeting') {
      if (!hasMeetings) return [];
      return (meetingsQuery.data ?? []).map((m) => ({
        id: m.id,
        label: m.title.trim() || t('untitledMeeting'),
      }));
    }
    return allConversations.map((c) => ({
      id: c.id,
      label: conversationSummaryTitle(c),
    }));
  }, [
    tab,
    hasNotes,
    hasMeetings,
    mineNotesQuery.data,
    sharedNotesQuery.data,
    meetingsQuery.data,
    allConversations,
    t,
  ]);

  const resetProposalState = () => {
    confirmKeyRef.current = null;
    setSession(null);
    setProposalError(null);
    setValidationError(null);
  };

  useEffect(() => {
    if (!open) {
      loadMoreEpochRef.current += 1;
      resetProposalState();
      setSelectedSourceId('');
      setConvSearch('');
      setExtraConversations([]);
      setConvMoreOverride(null);
    }
  }, [open]);

  useEffect(() => {
    if (sourceOptions.length === 0) {
      if (selectedSourceId !== '') setSelectedSourceId('');
      return;
    }
    if (!sourceOptions.some((opt) => opt.id === selectedSourceId)) {
      setSelectedSourceId(sourceOptions[0]!.id);
    }
  }, [sourceOptions, selectedSourceId]);

  const moduleOff = isModuleOffError(statusQuery.error);
  const loadError = statusQuery.error && !moduleOff ? statusQuery.error : null;
  const blocked =
    statusQuery.isPending || statusQuery.isError
      ? null
      : noteProposalBlocked(statusQuery.data, meterQuery.data);
  const resetOnLabel = statusQuery.data?.resetOn ? f.date(statusQuery.data.resetOn) : null;

  const listLoading =
    (tab === 'note' && hasNotes && (mineNotesQuery.isPending || sharedNotesQuery.isPending)) ||
    (tab === 'meeting' && hasMeetings && meetingsQuery.isPending) ||
    (tab === 'conversation' && conversationsQuery.isPending);

  const listError =
    (tab === 'note' ? (mineNotesQuery.error ?? sharedNotesQuery.error) : null) ||
    (tab === 'meeting' ? meetingsQuery.error : null) ||
    (tab === 'conversation' ? conversationsQuery.error : null);

  const proposeMutation = useMutation({
    mutationFn: (vars: { sourceType: ProjectTaskSourceType; sourceId: string }) =>
      clientForOrg(slug).projects.proposeTasksFromSource({
        projectId,
        sourceType: vars.sourceType,
        sourceId: vars.sourceId,
        timeZone: browserTimeZone(),
        language,
      }),
    onSuccess: (res: ProjectTasksFromSourceResult) => {
      if (res.state === 'failed') {
        setSession(null);
        setProposalError(t(`errors.${sourceProposalErrorKey(res.errorCode)}`));
        return;
      }
      setProposalError(null);
      setValidationError(null);
      confirmKeyRef.current = null;
      setSession({
        sourceType: res.sourceType,
        sourceId: res.sourceId,
        sourceTitle: res.sourceTitle,
        seats: res.seats,
        rows: toSourceEditableRows(res.proposals),
        droppedCount: res.dropped,
      });
    },
    onError: (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      setSession(null);
      setProposalError(code ? t(`errors.${sourceProposalErrorKey(code)}`) : errorMessage(err));
    },
  });

  const loadMoreMutation = useMutation({
    mutationFn: (vars: {
      epoch: number;
      search: string;
      before?: { at: string | null; id: string };
    }) =>
      clientForOrg(slug).conversations.list({
        limit: 50,
        ...(vars.search ? { q: vars.search } : {}),
        ...(vars.before ? { before: vars.before } : {}),
      }),
    onSuccess: (page, vars) => {
      if (!isCurrentConversationPage(loadMoreEpochRef.current, currentConvSearchRef.current, vars)) {
        return;
      }
      setExtraConversations((prev) => [...prev, ...page.conversations]);
      setConvMoreOverride(page.more);
    },
  });

  const activeLoadMore =
    loadMoreMutation.isPending &&
    loadMoreMutation.variables !== undefined &&
    isCurrentConversationPage(loadMoreEpochRef.current, trimmedConvSearch, loadMoreMutation.variables);

  const confirmMutation = useMutation({
    mutationFn: (vars: {
      sourceType: ProjectTaskSourceType;
      sourceId: string;
      items: ProjectProposedTask[];
      idempotencyKey: string;
    }) =>
      clientForOrg(slug).projects.confirmTasksFromSource({
        projectId,
        sourceType: vars.sourceType,
        sourceId: vars.sourceId,
        confirmed: true,
        timeZone: browserTimeZone(),
        items: vars.items,
        idempotencyKey: vars.idempotencyKey,
      }),
    onSuccess: (res) => {
      resetProposalState();
      refreshProjectQueries();
      void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.notes.key() });
      toast(
        res.linkedCount > 0
          ? t('createdAndLinkedToast', { created: res.createdCount, linked: res.linkedCount })
          : t('createdToast', { created: res.createdCount }),
        'success',
      );
      onClose();
    },
    onError: (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      setValidationError(code ? t(`errors.${sourceProposalErrorKey(code)}`) : errorMessage(err));
    },
  });

  const busy = disabled || proposeMutation.isPending || confirmMutation.isPending;

  const handleSelectTab = (next: SourceTabKind) => {
    if (busy || next === tab) return;
    loadMoreEpochRef.current += 1;
    setTab(next);
    setSelectedSourceId('');
    setConvSearch('');
    setExtraConversations([]);
    setConvMoreOverride(null);
    resetProposalState();
  };

  const handleAskVy = () => {
    if (activeModuleOff || blocked !== null || !selectedSourceId || busy) return;
    resetProposalState();
    proposeMutation.mutate({ sourceType, sourceId: selectedSourceId });
  };

  const rows = session?.rows ?? null;
  const checkedRows = (rows ?? []).filter((r) => r.selected);

  const handleConfirm = () => {
    if (!session || checkedRows.length === 0 || busy) return;
    const cleanedItems: ProjectProposedTask[] = [];
    for (const row of checkedRows) {
      const title = row.title.trim();
      if (title.length === 0) {
        setValidationError(t('emptyTitleError'));
        return;
      }
      cleanedItems.push({
        title: title.slice(0, PROJECT_TASK_TITLE_MAX),
        assigneePositionId: row.assigneePositionId || null,
        dueOn: row.dueOn && row.dueOn.trim().length > 0 ? row.dueOn.trim() : null,
      });
    }
    const signature = JSON.stringify({
      projectId,
      sourceType: session.sourceType,
      sourceId: session.sourceId,
      items: cleanedItems,
    });
    const batch = resolveSignatureIdempotencyKey(confirmKeyRef.current, signature);
    confirmKeyRef.current = batch;
    confirmMutation.mutate({
      sourceType: session.sourceType,
      sourceId: session.sourceId,
      items: cleanedItems,
      idempotencyKey: batch.key,
    });
  };

  const updateRow = (key: string, patch: Partial<Pick<SourceEditableProposalRow, 'selected' | 'title' | 'assigneePositionId' | 'dueOn'>>) => {
    setValidationError(null);
    const marksEdited = patch.title !== undefined || patch.assigneePositionId !== undefined || patch.dueOn !== undefined;
    setSession((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) =>
              r.key === key ? { ...r, ...patch, ...(marksEdited ? { edited: true } : {}) } : r,
            ),
          }
        : null,
    );
  };

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5 border-b border-border pb-2" role="tablist" aria-label={t('tabsLabel')}>
          {(['note', 'meeting', 'conversation'] as const).map((kind) => {
            const active = tab === kind;
            return (
              <Button
                key={kind}
                type="button"
                role="tab"
                aria-selected={active}
                size="sm"
                variant={active ? 'secondary' : 'ghost'}
                disabled={busy}
                onClick={() => handleSelectTab(kind)}
                data-testid={`project-tasks-source-tab-${kind}`}
              >
                {t(`tabs.${kind}`)}
              </Button>
            );
          })}
        </div>

        {moduleOff ? (
          <Notice data-testid="project-tasks-source-blocked">{t('blocked.off')}</Notice>
        ) : loadError ? (
          <ErrorText>{errorMessage(loadError)}</ErrorText>
        ) : statusQuery.isPending ? (
          <RowsSkeleton rows={2} />
        ) : (
          <>
            {blocked !== null && (
              <Notice data-testid="project-tasks-source-blocked">
                {blocked === 'budget'
                  ? resetOnLabel
                    ? t('blocked.budget', { resetOn: resetOnLabel })
                    : t('blocked.budgetNoDate')
                  : t(`blocked.${blocked}`)}
              </Notice>
            )}

            {tab === 'note' && !hasNotes && (
              <Notice data-testid="project-tasks-source-module-off">{t('moduleOff.notes')}</Notice>
            )}
            {tab === 'meeting' && !hasMeetings && (
              <Notice data-testid="project-tasks-source-module-off">{t('moduleOff.meetings')}</Notice>
            )}

            {!activeModuleOff && (
              <>
                {tab === 'conversation' && (
                  <Input
                    type="search"
                    value={convSearch}
                    disabled={busy}
                    placeholder={t('searchConversationPlaceholder')}
                    aria-label={t('searchConversation')}
                    onChange={(e) => {
                      loadMoreEpochRef.current += 1;
                      currentConvSearchRef.current = e.target.value.trim();
                      setConvSearch(e.target.value);
                      setExtraConversations([]);
                      setConvMoreOverride(null);
                      resetProposalState();
                    }}
                    data-testid="project-tasks-source-search"
                  />
                )}
                {listError ? (
                  <ErrorText>{errorMessage(listError)}</ErrorText>
                ) : listLoading ? (
                  <RowsSkeleton rows={1} />
                ) : sourceOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="project-tasks-source-empty">
                    {t(`emptySource.${tab}`)}
                  </p>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-subtle-foreground">
                        <span>{t(`sourceLabel.${tab}`)}</span>
                        <NativeSelect
                          className="w-full"
                          value={selectedSourceId}
                          disabled={busy}
                          onChange={(e) => {
                            setSelectedSourceId(e.target.value);
                            resetProposalState();
                          }}
                          data-testid="project-tasks-source-select"
                        >
                          {sourceOptions.map((opt) => (
                            <NativeSelectOption key={opt.id} value={opt.id}>
                              {opt.label}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </label>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        loading={proposeMutation.isPending}
                        disabled={blocked !== null || selectedSourceId === '' || busy}
                        onClick={handleAskVy}
                        data-testid="project-tasks-source-ask"
                      >
                        {proposeMutation.isPending ? t('running') : t('submit')}
                      </Button>
                    </div>
                    {tab === 'conversation' && conversationsHasMore && (
                      <div className="flex items-center justify-between gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          loading={activeLoadMore}
                          disabled={busy || activeLoadMore}
                          onClick={() => {
                            const last = allConversations[allConversations.length - 1];
                            loadMoreMutation.mutate({
                              epoch: loadMoreEpochRef.current,
                              search: trimmedConvSearch,
                              ...(last ? { before: { at: last.lastMessageAt, id: last.id } } : {}),
                            });
                          }}
                          data-testid="project-tasks-source-load-more"
                        >
                          {activeLoadMore ? t('loadingMoreConversations') : t('loadMoreConversations')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {proposalError && <ErrorText data-testid="project-tasks-source-error">{proposalError}</ErrorText>}

        {session !== null && rows !== null && (
          <div className="flex flex-col gap-3 border-t border-border pt-3" data-testid="project-tasks-source-review">
            {rows.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-subtle-foreground">{t('emptyProposals')}</p>
                <Button type="button" size="sm" variant="ghost" onClick={resetProposalState}>
                  {t('reset')}
                </Button>
              </div>
            ) : (
              <>
                <p className="text-xs text-subtle-foreground">{t('reviewNotice')}</p>
                {session.droppedCount > 0 && (
                  <p className="text-xs text-muted-foreground">{t('droppedNotice', { count: session.droppedCount })}</p>
                )}
                {session.seats.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t('noProjectSeats')}</p>
                )}

                <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                  {rows.map((row, idx) => (
                    <li
                      key={row.key}
                      data-testid="project-tasks-source-row"
                      data-edited={row.edited ? 'true' : 'false'}
                      className={`flex flex-wrap items-center gap-2 rounded-md border bg-background p-2 transition-opacity ${
                        row.edited ? 'border-border' : 'border-dashed border-proposal/60'
                      } ${row.selected ? '' : 'opacity-60'}`}
                    >
                      <Checkbox
                        checked={row.selected}
                        disabled={busy}
                        onCheckedChange={(val) => updateRow(row.key, { selected: Boolean(val) })}
                        aria-label={t('selectTask', { n: String(idx + 1) })}
                      />
                      {!row.edited && (
                        <Badge variant="proposal" data-testid="project-tasks-source-row-badge">
                          {t('proposalBadge')}
                        </Badge>
                      )}
                      <Input
                        value={row.title}
                        maxLength={PROJECT_TASK_TITLE_MAX}
                        disabled={busy}
                        onChange={(e) => updateRow(row.key, { title: e.target.value })}
                        aria-label={t('titleLabel', { n: String(idx + 1) })}
                        className="min-w-[180px] flex-1"
                      />
                      <NativeSelect
                        value={row.assigneePositionId ?? ''}
                        disabled={busy}
                        onChange={(e) => updateRow(row.key, { assigneePositionId: e.target.value || null })}
                        aria-label={t('assigneeLabel', { n: String(idx + 1) })}
                        className="w-40"
                      >
                        <NativeSelectOption value="">{t('unassigned')}</NativeSelectOption>
                        {session.seats.map((seat) => (
                          <NativeSelectOption key={seat.id} value={seat.id}>
                            {seatLabel(seat)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <Input
                        type="date"
                        value={row.dueOn ?? ''}
                        disabled={busy}
                        onChange={(e) => updateRow(row.key, { dueOn: e.target.value || null })}
                        aria-label={t('dueLabel', { n: String(idx + 1) })}
                        className="w-36"
                      />
                    </li>
                  ))}
                </ul>

                {validationError && <ErrorText>{validationError}</ErrorText>}
              </>
            )}
          </div>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={confirmMutation.isPending} onClick={onClose}>
          {tc('close')}
        </Button>
        {session !== null && rows !== null && rows.length > 0 && (
          <Button
            type="button"
            loading={confirmMutation.isPending}
            disabled={checkedRows.length === 0 || busy}
            onClick={handleConfirm}
            data-testid="project-tasks-source-confirm"
          >
            {confirmMutation.isPending ? t('confirming') : t('confirmCount', { count: checkedRows.length })}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Member-scoped Vy panel inside a Note editor (#2598, docs/plan/projects.md §5.3 & §9 step P7, ADR-0048, ADR-0049).
// The member picks a target project and clicks once to propose tasks; nothing is created until the member reviews,
// optionally edits title/seat/due date or unticks rows, and clicks Confirm once (tasks are always created tainted).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import {
  DEFAULT_TIME_ZONE,
  PROJECT_TASK_TITLE_MAX,
  type Note,
  type ProjectProposedTask,
  type ProjectSeat,
  type ProjectTasksFromNoteResult,
  type ProjectTasksFromNoteStatus,
} from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { refreshProjectQueries } from './project-task-dialog.tsx';
import { ErrorText, Notice, RowsSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { clientForOrg, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

export type NoteProposalBlockedReason = 'off' | 'noModel' | 'forbidden' | 'paused' | 'budget';

export function noteProposalBlocked(
  status: ProjectTasksFromNoteStatus | undefined,
  meter: { aiOn: boolean; state?: string } | undefined,
): NoteProposalBlockedReason | null {
  if (!status) return meter?.aiOn === false ? 'noModel' : 'off';
  if (!status.available) {
    if (status.reason === 'off' && meter?.aiOn === false) return 'noModel';
    return status.reason ?? 'off';
  }
  if (meter && !meter.aiOn) return 'noModel';
  return null;
}

const KNOWN_ERRORS = [
  'NOTE_EMPTY',
  'NOTE_TOO_LONG',
  'NOTE_IN_TRASH',
  'PROPOSAL_TIMEOUT',
  'PROPOSAL_UNPARSABLE',
  'PROPOSAL_FAILED',
  'AI_STOPPED',
  'AI_BUDGET_EXHAUSTED',
  'AI_BUSY',
  'PROJECT_ARCHIVED',
  'VY_NOT_ALLOWED',
  'AI_OFF',
  'AI_PAUSED',
  'UNSAVED_NOTE',
] as const;

export type KnownProposalErrorKey = (typeof KNOWN_ERRORS)[number] | 'default';

export function noteProposalErrorKey(code: string | null | undefined): KnownProposalErrorKey {
  if (!code) return 'default';
  return (KNOWN_ERRORS as readonly string[]).includes(code) ? (code as (typeof KNOWN_ERRORS)[number]) : 'default';
}

const SOURCE_EXTRA_ERRORS = [
  'SOURCE_EMPTY',
  'SOURCE_TOO_LONG',
  'MEETING_NOT_FOUND',
  'CONVERSATION_NOT_FOUND',
  'MODULE_OFF',
] as const;

export type KnownSourceProposalErrorKey = KnownProposalErrorKey | (typeof SOURCE_EXTRA_ERRORS)[number];

export function sourceProposalErrorKey(code: string | null | undefined): KnownSourceProposalErrorKey {
  if (!code) return 'default';
  if ((SOURCE_EXTRA_ERRORS as readonly string[]).includes(code)) {
    return code as (typeof SOURCE_EXTRA_ERRORS)[number];
  }
  return noteProposalErrorKey(code);
}

export function isModuleOffError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'MODULE_OFF';
}

export interface EditableProposalRow {
  key: string;
  selected: boolean;
  title: string;
  assigneePositionId: string | null;
  dueOn: string | null;
}

export interface ProposalSession {
  targetProjectId: string;
  seats: ProjectSeat[];
  rows: EditableProposalRow[];
  droppedCount: number;
}

export function toEditableRows(proposals: readonly ProjectProposedTask[]): EditableProposalRow[] {
  return proposals.map((p, idx) => ({
    key: `row-${idx}`,
    selected: true,
    title: p.title,
    assigneePositionId: p.assigneePositionId,
    dueOn: p.dueOn,
  }));
}

export interface BatchIdempotencyState {
  signature: string;
  key: string;
}

export function resolveSignatureIdempotencyKey(
  current: BatchIdempotencyState | null,
  signature: string,
  createKey: () => string = () => crypto.randomUUID(),
): BatchIdempotencyState {
  if (current && current.signature === signature) return current;
  return { signature, key: createKey() };
}

export function resolveBatchIdempotencyKey(
  current: BatchIdempotencyState | null,
  noteId: string,
  projectId: string,
  items: readonly ProjectProposedTask[],
  createKey: () => string = () => crypto.randomUUID(),
): BatchIdempotencyState {
  return resolveSignatureIdempotencyKey(current, JSON.stringify({ noteId, projectId, items }), createKey);
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function seatLabel(seat: ProjectSeat): string {
  const holderName =
    seat.holder?.type === 'user'
      ? (seat.holder.displayName ?? seat.holder.email)
      : seat.holder?.type === 'agent'
        ? seat.holder.name
        : null;
  return holderName ? `${seat.title} - ${holderName}` : seat.title;
}

export function NoteTaskProposals({
  slug,
  note,
  beforePropose,
  saveBlocked = false,
  onCreated,
}: {
  slug: string;
  note: Pick<Note, 'id' | 'title' | 'body' | 'mine' | 'deletedAt'>;
  beforePropose?: (() => Promise<boolean>) | undefined;
  saveBlocked?: boolean | undefined;
  onCreated?: (() => void) | undefined;
}) {
  const t = useTranslations('notes.taskProposals');
  const f = useFormat();
  const locale = useLocale();
  const language: 'vi' | 'en' = locale === 'en' ? 'en' : 'vi';

  const statusQuery = useQuery(orpc.projects.tasksFromNoteStatus.queryOptions({ input: {} }));
  const meterQuery = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'projects' } }), staleTime: 15_000 });
  const projectsQuery = useQuery(orpc.projects.list.queryOptions({ input: {} }));

  const openProjects = useMemo(
    () => (projectsQuery.data?.projects ?? []).filter((p) => p.status !== 'archived'),
    [projectsQuery.data?.projects],
  );

  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [proposalSession, setProposalSession] = useState<ProposalSession | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [settlingSave, setSettlingSave] = useState(false);
  const confirmKeyRef = useRef<BatchIdempotencyState | null>(null);

  useEffect(() => {
    confirmKeyRef.current = null;
    setProposalSession(null);
    setProposalError(null);
    setValidationError(null);
  }, [note.id]);

  useEffect(() => {
    if (openProjects.length === 0) {
      setSelectedProjectId((prev) => (prev === '' ? prev : ''));
      setProposalSession(null);
      return;
    }
    if (!openProjects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(openProjects[0]!.id);
      setProposalSession(null);
    }
  }, [openProjects, selectedProjectId]);

  const moduleOff = isModuleOffError(statusQuery.error) || isModuleOffError(projectsQuery.error);

  const statusPending = statusQuery.isPending;
  const blocked = statusPending ? null : noteProposalBlocked(statusQuery.data, meterQuery.data);
  const hasNoteContent = `${note.title}\n${note.body}`.trim().length > 0;
  const resetOnLabel = statusQuery.data?.resetOn ? f.date(`${statusQuery.data.resetOn}T00:00:00Z`) : null;
  const loadError = statusQuery.error ?? projectsQuery.error ?? null;

  const proposeMutation = useMutation({
    mutationFn: (projectId: string) =>
      clientForOrg(slug).projects.proposeTasksFromNote({
        noteId: note.id,
        projectId,
        timeZone: browserTimeZone(),
        language,
      }),
    onMutate: () => {
      confirmKeyRef.current = null;
      setProposalSession(null);
      setProposalError(null);
      setValidationError(null);
    },
    onSuccess: (res: ProjectTasksFromNoteResult) => {
      if (res.state === 'failed') {
        setProposalSession(null);
        setProposalError(t(`errors.${noteProposalErrorKey(res.errorCode)}`));
        return;
      }
      confirmKeyRef.current = null;
      setProposalSession({
        targetProjectId: res.projectId,
        seats: res.seats,
        rows: toEditableRows(res.proposals),
        droppedCount: res.dropped,
      });
    },
    onError: (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      setProposalError(code ? t(`errors.${noteProposalErrorKey(code)}`) : errorMessage(err));
    },
  });

  const confirmMutation = useMutation({
    mutationFn: ({ projectId, items, idempotencyKey }: { projectId: string; items: ProjectProposedTask[]; idempotencyKey: string }) =>
      clientForOrg(slug).projects.confirmTasksFromNote({
        noteId: note.id,
        projectId,
        confirmed: true,
        timeZone: browserTimeZone(),
        items,
        idempotencyKey,
      }),
    onMutate: () => {
      setValidationError(null);
    },
    onSuccess: (res) => {
      confirmKeyRef.current = null;
      setProposalSession(null);
      setProposalError(null);
      refreshProjectQueries();
      void queryClient.invalidateQueries({ queryKey: orpc.notes.key() });
      onCreated?.();
      toast(
        res.linkedCount > 0
          ? t('createdAndLinkedToast', { created: res.createdCount, linked: res.linkedCount })
          : t('createdToast', { created: res.createdCount }),
        'success',
      );
    },
    onError: (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      setValidationError(code ? t(`errors.${noteProposalErrorKey(code)}`) : errorMessage(err));
    },
  });

  const busy = settlingSave || proposeMutation.isPending || confirmMutation.isPending;

  const handleAskVy = async () => {
    if (!selectedProjectId || saveBlocked || busy) return;
    confirmKeyRef.current = null;
    setProposalSession(null);
    setProposalError(null);
    setValidationError(null);
    if (beforePropose) {
      setSettlingSave(true);
      try {
        const savedOk = await beforePropose();
        if (!savedOk) {
          setProposalError(t('errors.UNSAVED_NOTE'));
          return;
        }
      } finally {
        setSettlingSave(false);
      }
    }
    proposeMutation.mutate(selectedProjectId);
  };

  const rows = proposalSession?.rows ?? null;
  const checkedRows = (rows ?? []).filter((r) => r.selected);

  const handleConfirm = () => {
    if (!proposalSession || checkedRows.length === 0 || busy) return;
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
    const batch = resolveBatchIdempotencyKey(confirmKeyRef.current, note.id, proposalSession.targetProjectId, cleanedItems);
    confirmKeyRef.current = batch;
    confirmMutation.mutate({ projectId: proposalSession.targetProjectId, items: cleanedItems, idempotencyKey: batch.key });
  };

  const updateRow = (key: string, patch: Partial<EditableProposalRow>) => {
    setValidationError(null);
    setProposalSession((prev) =>
      prev ? { ...prev, rows: prev.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) } : null,
    );
  };

  if (moduleOff) return null;

  return (
    <section
      className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-card p-3.5"
      data-testid="note-task-proposals"
      aria-labelledby="note-task-proposals-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 id="note-task-proposals-heading" className="text-sm font-medium text-foreground">
            {t('title')}
          </h3>
          <Badge variant="proposal" data-testid="note-task-proposals-ai-badge">
            {t('aiBadge')}
          </Badge>
        </div>
      </div>

      <p className="text-xs text-subtle-foreground">{t('hint')}</p>

      {loadError ? (
        <ErrorText>{errorMessage(loadError)}</ErrorText>
      ) : statusPending || projectsQuery.isLoading ? (
        <RowsSkeleton rows={1} />
      ) : (
        <>
          {blocked !== null && (
            <Notice>
              {blocked === 'budget'
                ? resetOnLabel
                  ? t('blocked.budget', { resetOn: resetOnLabel })
                  : t('blocked.budgetNoDate')
                : t(`blocked.${blocked}`)}
            </Notice>
          )}

          {openProjects.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
              <span>{t('noProjects')}</span>
              <Link to="/o/$slug/projects" params={{ slug }} className="underline text-foreground">
                {t('openProjects')}
              </Link>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs text-subtle-foreground">
                <span>{t('projectLabel')}</span>
                <NativeSelect
                  className="w-full"
                  value={selectedProjectId}
                  disabled={busy}
                  onChange={(e) => {
                    setSelectedProjectId(e.target.value);
                    confirmKeyRef.current = null;
                    setProposalSession(null);
                    setValidationError(null);
                  }}
                  data-testid="note-task-proposals-project"
                >
                  {openProjects.map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={proposeMutation.isPending || settlingSave}
                disabled={
                  blocked !== null ||
                  saveBlocked ||
                  !hasNoteContent ||
                  selectedProjectId === '' ||
                  busy
                }
                onClick={() => void handleAskVy()}
                data-testid="note-task-proposals-ask"
              >
                {proposeMutation.isPending || settlingSave ? t('running') : t('submit')}
              </Button>
            </div>
          )}

          {!hasNoteContent && blocked === null && openProjects.length > 0 && (
            <p className="text-xs text-muted-foreground">{t('emptyNoteHint')}</p>
          )}
        </>
      )}

      {proposalError && <ErrorText>{proposalError}</ErrorText>}

      {proposalSession !== null && rows !== null && (
        <div className="flex flex-col gap-3 border-t border-border pt-3" data-testid="note-task-proposals-review">
          {rows.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-subtle-foreground">{t('emptyProposals')}</p>
              <Button type="button" size="sm" variant="ghost" onClick={() => setProposalSession(null)}>
                {t('cancel')}
              </Button>
            </div>
          ) : (
            <>
              <p className="text-xs text-subtle-foreground">{t('reviewNotice')}</p>
              {proposalSession.droppedCount > 0 && (
                <p className="text-xs text-muted-foreground">{t('droppedNotice', { count: proposalSession.droppedCount })}</p>
              )}
              {proposalSession.seats.length === 0 && <p className="text-xs text-muted-foreground">{t('noProjectSeats')}</p>}

              <ul className="flex flex-col gap-2">
                {rows.map((row, idx) => (
                  <li
                    key={row.key}
                    className={`flex flex-wrap items-center gap-2 rounded-md border border-dashed border-proposal/60 bg-background p-2 transition-opacity ${row.selected ? '' : 'opacity-60'}`}
                  >
                    <Checkbox
                      checked={row.selected}
                      disabled={busy}
                      onCheckedChange={(val) => updateRow(row.key, { selected: Boolean(val) })}
                      aria-label={t('selectTask', { n: String(idx + 1) })}
                    />
                    <Input
                      value={row.title}
                      maxLength={PROJECT_TASK_TITLE_MAX}
                      disabled={busy}
                      onChange={(e) => updateRow(row.key, { title: e.target.value })}
                      aria-label={t('titleLabel', { n: String(idx + 1) })}
                      className="min-w-[200px] flex-1"
                    />
                    <NativeSelect
                      value={row.assigneePositionId ?? ''}
                      disabled={busy}
                      onChange={(e) => updateRow(row.key, { assigneePositionId: e.target.value || null })}
                      aria-label={t('assigneeLabel', { n: String(idx + 1) })}
                      className="w-44"
                    >
                      <NativeSelectOption value="">{t('unassigned')}</NativeSelectOption>
                      {proposalSession.seats.map((seat) => (
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

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    confirmKeyRef.current = null;
                    setProposalSession(null);
                    setValidationError(null);
                  }}
                >
                  {t('cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  loading={confirmMutation.isPending}
                  disabled={checkedRows.length === 0 || busy}
                  onClick={handleConfirm}
                  data-testid="note-task-proposals-confirm"
                >
                  {confirmMutation.isPending ? t('confirming') : t('confirmCount', { count: checkedRows.length })}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Member-scoped Vy inbox organizer for Notes (Notes v2 E5b, #3563, ADR-0049): proposes notebooks and #tags for unfiled
// notes without modifying notes on generation. Every move or tag change waits for explicit 1-click user confirmation.
import { useMutation, useQuery } from '@tanstack/react-query';
import type { NotebookSummary, NoteOrganizeResult } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@ludy/ui/components/sheet';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { useFormat } from '../i18n/provider.tsx';
import { clientForOrg, orpc } from '../lib/api.ts';
import { parseTags } from '../lib/notes.ts';
import { toast } from '../lib/toast.ts';
import { errorCodeOf, noteVyBlocked, noteVyErrorKey } from './note-vy-panel.tsx';
import { refreshNotes } from './notes-panel.tsx';
import { CoworkerAttribution, ProposalSurface } from './proposal-surface.tsx';
import { ErrorText } from './ui.tsx';

interface OrganizeRowDraft {
  notebookId: string;
  tagsInput: string;
  edited: boolean;
  applied: boolean;
  error: string | null;
}

export function NotesVyOrganizerTrigger({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useTranslations('notes.vyOrganizer');
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="outline"
      className="gap-1.5 max-md:min-h-11"
      aria-expanded={open}
      onClick={onToggle}
      data-testid="notes-vy-organize-btn"
    >
      <NavIcon name="appAi" className="text-proposal" />
      <span>{t('button')}</span>
    </Button>
  );
}

export function NotesVyOrganizerPanel({
  slug,
  open,
  notebooks,
  triggerRef,
  onClose,
  initialResult = null,
}: {
  slug: string;
  open: boolean;
  notebooks: readonly NotebookSummary[];
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  initialResult?: NoteOrganizeResult | null;
}) {
  const t = useTranslations('notes.vyOrganizer');
  const tv = useTranslations('notes.vy');
  const common = useTranslations('common');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const api = useRef(clientForOrg(slug)).current;

  const status = useQuery({
    ...orpc.notes.vyStatus.queryOptions({ input: {} }),
    enabled: open,
    staleTime: 30_000,
  });
  const meter = useQuery({
    ...orpc.ai.meter.queryOptions({ input: { module: 'notes' } }),
    enabled: open,
    staleTime: 30_000,
  });
  const blocked = noteVyBlocked(status.data, meter.data);
  const statusReady = status.isSuccess && meter.isSuccess;

  const [result, setResult] = useState<NoteOrganizeResult | null>(initialResult);
  const [drafts, setDrafts] = useState<Record<string, OrganizeRowDraft>>({});
  const lastTriggerRef = useRef(initialResult !== null);

  const syncDrafts = (data: NoteOrganizeResult) => {
    const next: Record<string, OrganizeRowDraft> = {};
    for (const item of data.suggestions) {
      next[item.noteId] = {
        notebookId: item.notebookId ?? '',
        tagsInput: item.tags.join(', '),
        edited: false,
        applied: false,
        error: null,
      };
    }
    setDrafts(next);
  };

  const organizeMutation = useMutation({
    mutationFn: () => api.notes.organize({ language: locale }),
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
    if (!lastTriggerRef.current && statusReady && blocked === null) {
      lastTriggerRef.current = true;
      organizeMutation.mutate();
    }
  }, [open, statusReady, blocked]);

  const handleClose = () => {
    onClose();
    window.setTimeout(() => {
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    }, 0);
  };

  const applySuggestion = async (item: NoteOrganizeResult['suggestions'][number], draft: OrganizeRowDraft) => {
    const nextNotebookId = draft.notebookId || undefined;
    const addedTags = item.canEditTags ? parseTags(draft.tagsInput) : [];
    const mergedTags = item.canEditTags ? parseTags([...item.existingTags, ...addedTags].join(',')) : undefined;
    const hasTagChange = item.canEditTags && addedTags.length > 0;
    if (!nextNotebookId && !hasTagChange) return false;
    await api.notes.update({
      noteId: item.noteId,
      revision: item.revision,
      ...(nextNotebookId ? { notebookId: nextNotebookId } : {}),
      ...(hasTagChange && mergedTags ? { tags: mergedTags } : {}),
    });
    return true;
  };

  const applyOne = useMutation({
    mutationFn: async (item: NoteOrganizeResult['suggestions'][number]) => {
      const draft = drafts[item.noteId] ?? {
        notebookId: item.notebookId ?? '',
        tagsInput: item.tags.join(', '),
        edited: false,
        applied: false,
        error: null,
      };
      await applySuggestion(item, draft);
      return item.noteId;
    },
    onSuccess: (noteId) => {
      setDrafts((prev) => {
        const cur = prev[noteId];
        return cur ? { ...prev, [noteId]: { ...cur, applied: true, error: null } } : prev;
      });
      void refreshNotes();
      toast(t('appliedToast'), 'success');
    },
    onError: (err, item) => {
      const key = noteVyErrorKey(errorCodeOf(err));
      setDrafts((prev) => {
        const cur = prev[item.noteId];
        return cur ? { ...prev, [item.noteId]: { ...cur, error: tv(`errors.${key}`) } } : prev;
      });
    },
  });

  const applyAll = useMutation({
    mutationFn: async () => {
      if (!result) return 0;
      let count = 0;
      for (const item of result.suggestions) {
        const draft = drafts[item.noteId];
        if (!draft || draft.applied) continue;
        try {
          const updated = await applySuggestion(item, draft);
          if (updated) {
            count += 1;
            setDrafts((prev) => {
              const cur = prev[item.noteId];
              return cur ? { ...prev, [item.noteId]: { ...cur, applied: true, error: null } } : prev;
            });
          }
        } catch (err) {
          const key = noteVyErrorKey(errorCodeOf(err));
          setDrafts((prev) => {
            const cur = prev[item.noteId];
            return cur ? { ...prev, [item.noteId]: { ...cur, error: tv(`errors.${key}`) } } : prev;
          });
        }
      }
      return count;
    },
    onSuccess: (count) => {
      if (count > 0) {
        void refreshNotes();
        toast(t('appliedAllToast', { count }), 'success');
      }
    },
  });

  if (!open) return null;

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
    organizeMutation.isError
      ? noteVyErrorKey(errorCodeOf(organizeMutation.error))
      : result?.state === 'failed'
        ? noteVyErrorKey(result.errorCode)
        : null;

  const remaining = result
    ? result.suggestions.filter((s) => {
        const draft = drafts[s.noteId];
        if (!draft || draft.applied) return false;
        return Boolean(draft.notebookId) || (s.canEditTags && parseTags(draft.tagsInput).length > 0);
      }).length
    : 0;

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <SheetContent closeLabel={t('close')} className="sm:max-w-xl" data-testid="notes-vy-organizer">
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
          <CoworkerAttribution
            coworker="gm"
            badgeLabel={t('aiBadge')}
            badgeTestId="notes-vy-organize-ai-badge"
          />
          <SheetDescription>{t('hint')}</SheetDescription>
        </SheetHeader>

        <SheetBody>
          <section role="region" aria-label={t('title')} className="space-y-3">
            {blockedMessage && (
              <div
                role="status"
                data-testid="notes-vy-organize-blocked"
                className="rounded-md border border-dashed bg-background px-3 py-2 text-xs text-subtle-foreground"
              >
                {blockedMessage}
              </div>
            )}

            {runErrorCode && <ErrorText data-testid="notes-vy-organize-error">{tv(`errors.${runErrorCode}`)}</ErrorText>}

            {organizeMutation.isPending && (
              <p role="status" data-testid="notes-vy-organize-loading" className="text-xs text-subtle-foreground">
                {t('running')}
              </p>
            )}

            {!organizeMutation.isPending && result?.state === 'ready' && (
              <div className="space-y-2.5">
                {result.dropped > 0 && (
                  <p className="text-xs text-subtle-foreground" data-testid="notes-vy-organize-dropped">
                    {t('droppedHint', { count: result.dropped })}
                  </p>
                )}

                {result.suggestions.length === 0 ? (
                  <p role="status" data-testid="notes-vy-organize-empty" className="text-xs text-subtle-foreground">
                    {t('empty')}
                  </p>
                ) : (
                  <ul className="space-y-2" data-testid="notes-vy-organize-list">
                    {result.suggestions.map((item) => {
                      const draft = drafts[item.noteId] ?? {
                        notebookId: item.notebookId ?? '',
                        tagsInput: item.tags.join(', '),
                        edited: false,
                        applied: false,
                        error: null,
                      };
                      const showProposal = !draft.edited && !draft.applied;
                      const compatibleNotebooks = notebooks.filter(
                        (nb) => item.visibility !== 'org' || nb.visibility === 'org',
                      );
                      const parsedAddedTags = item.canEditTags ? parseTags(draft.tagsInput) : [];
                      const canApply = Boolean(draft.notebookId) || parsedAddedTags.length > 0;
                      return (
                        <ProposalSurface
                          as="li"
                          key={item.noteId}
                          proposed={!draft.applied}
                          data-testid={`notes-vy-organize-item-${item.noteId}`}
                          className="space-y-2 rounded-lg p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-foreground">{item.title}</span>
                              <Badge variant="outline">
                                {item.visibility === 'org' ? t('sharedNote') : t('privateNote')}
                              </Badge>
                            </div>
                            {showProposal ? (
                              <Badge variant="proposal" data-testid={`notes-vy-organize-proposal-badge-${item.noteId}`}>
                                {t('proposalMark')}
                              </Badge>
                            ) : draft.applied ? (
                              <Badge variant="outline" data-testid={`notes-vy-organize-applied-badge-${item.noteId}`}>
                                {t('applied')}
                              </Badge>
                            ) : null}
                          </div>
                          {item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}
                          <div className="space-y-2">
                            <NativeSelect
                              size="sm"
                              aria-label={t('notebookLabel', { title: item.title })}
                              value={draft.notebookId}
                              disabled={draft.applied || applyOne.isPending || applyAll.isPending}
                              onChange={(e) =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [item.noteId]: { ...draft, notebookId: e.target.value, edited: true },
                                }))
                              }
                              data-testid={`notes-vy-organize-notebook-${item.noteId}`}
                              className="w-full"
                            >
                              <NativeSelectOption value="">{t('keepUnfiled')}</NativeSelectOption>
                              {compatibleNotebooks.map((nb) => (
                                <NativeSelectOption key={nb.id} value={nb.id}>
                                  {nb.name}
                                </NativeSelectOption>
                              ))}
                              {item.notebookId &&
                                item.notebookName &&
                                !compatibleNotebooks.some((nb) => nb.id === item.notebookId) && (
                                  <NativeSelectOption value={item.notebookId}>{item.notebookName}</NativeSelectOption>
                                )}
                            </NativeSelect>

                            <div className="flex flex-wrap items-start gap-2">
                              <div className="min-w-0 flex-1">
                                {item.canEditTags ? (
                                  <div className="space-y-1">
                                    <Input
                                      aria-label={t('tagsLabel', { title: item.title })}
                                      value={draft.tagsInput}
                                      placeholder={t('tagsPlaceholder')}
                                      disabled={draft.applied || applyOne.isPending || applyAll.isPending}
                                      className="text-xs max-md:min-h-11"
                                      onChange={(e) =>
                                        setDrafts((prev) => ({
                                          ...prev,
                                          [item.noteId]: { ...draft, tagsInput: e.target.value, edited: true },
                                        }))
                                      }
                                      data-testid={`notes-vy-organize-tags-${item.noteId}`}
                                    />
                                    {parsedAddedTags.length > 0 && (
                                      <div className="flex flex-wrap gap-1">
                                        {parsedAddedTags.map((tag) => (
                                          <Badge key={tag} variant="outline" className="text-xs">
                                            #{tag}
                                          </Badge>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <p className="text-xs text-subtle-foreground">{t('tagsAuthorOnly')}</p>
                                )}
                              </div>

                              <Button
                                type="button"
                                size="sm"
                                variant={draft.applied ? 'outline' : 'default'}
                                className="shrink-0 max-md:min-h-11"
                                disabled={draft.applied || !canApply || applyOne.isPending || applyAll.isPending}
                                loading={applyOne.isPending && applyOne.variables?.noteId === item.noteId}
                                onClick={() => applyOne.mutate(item)}
                                data-testid={`notes-vy-organize-apply-${item.noteId}`}
                              >
                                {draft.applied ? t('applied') : t('apply')}
                              </Button>
                            </div>
                          </div>
                          {draft.error && <ErrorText>{draft.error}</ErrorText>}
                        </ProposalSurface>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>
        </SheetBody>

        <SheetFooter>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="max-md:min-h-11"
            aria-label={t('close')}
            onClick={handleClose}
            data-testid="notes-vy-organize-close-btn"
          >
            {common('close')}
          </Button>
          {statusReady && blocked === null && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-md:min-h-11"
              loading={organizeMutation.isPending}
              disabled={organizeMutation.isPending}
              onClick={() => organizeMutation.mutate()}
              data-testid="notes-vy-organize-rerun-btn"
            >
              {t('rerun')}
            </Button>
          )}
          {remaining > 1 && (
            <Button
              type="button"
              size="sm"
              className="max-md:min-h-11"
              loading={applyAll.isPending}
              disabled={applyAll.isPending || applyOne.isPending}
              onClick={() => applyAll.mutate()}
              data-testid="notes-vy-organize-apply-all"
            >
              {t('applyAll', { count: remaining })}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

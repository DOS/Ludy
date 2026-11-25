// SPDX-License-Identifier: AGPL-3.0-only
// 1-step Evernote (.enex) and Todoist (.csv) import dialogs with client-side dry-run preview (#3564, V2-9).
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  ENEX_MAX_FILE_BYTES,
  TODOIST_CSV_MAX_BYTES,
  buildEnexDryRunPreview,
  buildTodoistDryRunPreview,
  deriveTodoistListNameFromFilename,
  parseEnexImport,
  parseTodoistCsv,
  type EnexExistingNoteRef,
  type EnexImportResult,
  type NoteImportFailure,
  type NotebookSummary,
  type TodoListSummary,
  type TodoistExistingTodoRef,
  type TodoistImportResult,
} from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Skeleton } from '@ludy/ui/components/skeleton';
import { ErrorText } from './ui.tsx';
import { errorMessage, importEvernoteEnex, importTodoistCsv } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

export type NoteImportDialogProps =
  | {
      mode: 'enex';
      open: boolean;
      onOpenChange: (open: boolean) => void;
      slug: string;
      notebooks: readonly NotebookSummary[];
      existingNotes?: readonly EnexExistingNoteRef[];
      existingNoteTitles?: readonly EnexExistingNoteRef[];
      defaultNotebookId?: string | null;
      onImported: (result: EnexImportResult, meta?: { targetNotebookId: string | null }) => void;
    }
  | {
      mode: 'todoist';
      open: boolean;
      onOpenChange: (open: boolean) => void;
      slug: string;
      todoLists: readonly TodoListSummary[];
      existingTodos?: readonly TodoistExistingTodoRef[];
      existingTodoTitles?: readonly TodoistExistingTodoRef[];
      defaultListId?: string | null;
      timeZone: string;
      onImported: (result: TodoistImportResult) => void;
    };

export function resolveNoteImportParseError(
  parsed: Pick<NoteImportFailure, 'code' | 'detail'> | null | undefined,
  messages: {
    invalidSizeLimit: string;
    noteTooLong: string;
    kernelError: (code: Exclude<NoteImportFailure['code'], 'TOO_LARGE' | 'NOTE_TOO_LONG'>) => string;
  },
): string | null {
  if (!parsed) return null;
  if (parsed.code === 'TOO_LARGE') return messages.invalidSizeLimit;
  if (parsed.code === 'NOTE_TOO_LONG') return messages.noteTooLong;
  if (
    parsed.code === 'NOTE_IMPORT_INVALID' ||
    parsed.code === 'NOTE_IMPORT_UNSAFE_XML' ||
    parsed.code === 'NOTE_IMPORT_EMPTY' ||
    parsed.code === 'NOTE_ATTACHMENT_LIMIT'
  ) {
    return messages.kernelError(parsed.code);
  }
  return parsed.detail;
}

export function NoteImportDialog(props: NoteImportDialogProps) {
  const isEnex = props.mode === 'enex';
  const tNotes = useTranslations('notes');
  const tWork = useTranslations('myWork');
  const tCommon = useTranslations('common');
  const tKernel = useTranslations('kernelErrors.codes');
  const t = isEnex ? (key: string, values?: Record<string, string | number>) => tNotes(`import.${key}` as never, values as never) : (key: string, values?: Record<string, string | number>) => tWork(`import.${key}` as never, values as never);

  const fileInputId = useId();
  const targetSelectId = useId();
  const skipDupId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileReadSeq = useRef(0);
  const prevOpen = useRef(false);

  const initialTarget = props.mode === 'enex' ? (props.defaultNotebookId ?? 'auto') : (props.defaultListId ?? 'auto');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [targetValue, setTargetValue] = useState<string>(initialTarget);
  const [skipDuplicates, setSkipDuplicates] = useState(false);

  useEffect(() => {
    const opening = props.open && !prevOpen.current;
    prevOpen.current = props.open;
    if (opening) {
      fileReadSeq.current += 1;
      setSelectedFile(null);
      setRawText(null);
      setReadingFile(false);
      setLocalError(null);
      setTargetValue(initialTarget);
      setSkipDuplicates(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [props.open, initialTarget]);

  const parsedEnex = useMemo(() => {
    if (!isEnex || rawText === null) return null;
    return parseEnexImport(rawText);
  }, [isEnex, rawText]);

  const parsedTodoist = useMemo(() => {
    if (isEnex || rawText === null || !selectedFile) return null;
    return parseTodoistCsv(rawText, {
      defaultListName: deriveTodoistListNameFromFilename(selectedFile.name),
      fallbackTimeZone: props.timeZone,
      useInboxWhenNoList: targetValue === 'inbox',
    });
  }, [isEnex, rawText, selectedFile, props.mode === 'todoist' ? props.timeZone : null, targetValue]);

  const enexPreview = useMemo(() => {
    if (!isEnex || !parsedEnex?.ok) return null;
    const targetNotebookId = targetValue !== 'auto' && targetValue !== 'unfiled' ? targetValue : null;
    const overrideNotebook =
      targetNotebookId !== null
        ? (props.notebooks.find((b) => b.id === targetNotebookId)?.name ?? 'target')
        : null;
    const existingNotes = props.existingNotes ?? props.existingNoteTitles ?? [];
    return buildEnexDryRunPreview(
      parsedEnex,
      props.notebooks.filter((b) => b.visibility === 'private'),
      existingNotes,
      { targetNotebookId, overrideNotebookName: overrideNotebook, unfiled: targetValue === 'unfiled' },
    );
  }, [
    isEnex,
    parsedEnex,
    targetValue,
    props.mode === 'enex' ? props.notebooks : null,
    props.mode === 'enex' ? props.existingNotes : null,
    props.mode === 'enex' ? props.existingNoteTitles : null,
  ]);

  const todoistPreview = useMemo(() => {
    if (isEnex || !parsedTodoist?.ok) return null;
    const explicitTargetListId = targetValue !== 'auto' && targetValue !== 'inbox' ? targetValue : null;
    const existingTodos = props.existingTodos ?? props.existingTodoTitles ?? [];
    return buildTodoistDryRunPreview(
      parsedTodoist,
      props.todoLists,
      existingTodos,
      { targetListId: explicitTargetListId, useInbox: targetValue === 'inbox' },
    );
  }, [
    isEnex,
    parsedTodoist,
    targetValue,
    props.mode === 'todoist' ? props.todoLists : null,
    props.mode === 'todoist' ? props.existingTodos : null,
    props.mode === 'todoist' ? props.existingTodoTitles : null,
  ]);

  const parseErrorMessage = useMemo(() => {
    if (localError) return localError;
    const parsed = isEnex ? parsedEnex : parsedTodoist;
    if (!parsed || parsed.ok) return null;
    return resolveNoteImportParseError(parsed, {
      invalidSizeLimit: t('invalidSizeLimit'),
      noteTooLong: tNotes('import.noteTooLong'),
      kernelError: (code) => tKernel(code),
    });
  }, [localError, isEnex, parsedEnex, parsedTodoist, t, tNotes, tKernel]);

  const upload = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error('missing file');
      if (props.mode === 'enex') {
        const targetNotebookId = targetValue !== 'auto' && targetValue !== 'unfiled' ? targetValue : null;
        return {
          mode: 'enex' as const,
          targetNotebookId,
          result: await importEvernoteEnex(
            selectedFile,
            {
              targetNotebookId,
              ignoreFileNotebooks: targetValue === 'unfiled',
              skipDuplicates,
            },
            props.slug,
          ),
        };
      }
      const targetListId = targetValue !== 'auto' && targetValue !== 'inbox' ? targetValue : null;
      return {
        mode: 'todoist' as const,
        result: await importTodoistCsv(
          selectedFile,
          {
            targetListId,
            useInboxWhenNoList: targetValue === 'inbox',
            timeZone: props.timeZone,
            skipDuplicates,
          },
          props.slug,
        ),
      };
    },
    onSuccess: (outcome) => {
      if (outcome.mode === 'enex' && props.mode === 'enex') {
        const r = outcome.result;
        toast(
          r.skippedDuplicates > 0
            ? t('doneSkippedToast', { notes: r.importedNotes, attachments: r.attachmentsCount, skipped: r.skippedDuplicates })
            : t('doneToast', { notes: r.importedNotes, attachments: r.attachmentsCount }),
          'success',
        );
        props.onOpenChange(false);
        props.onImported(r, { targetNotebookId: outcome.targetNotebookId });
      } else if (outcome.mode === 'todoist' && props.mode === 'todoist') {
        const r = outcome.result;
        toast(
          r.skippedDuplicates > 0
            ? t('doneSkippedToast', { tasks: r.importedTodos, steps: r.checklistSteps, skipped: r.skippedDuplicates })
            : t('doneToast', { tasks: r.importedTodos, steps: r.checklistSteps }),
          'success',
        );
        props.onOpenChange(false);
        props.onImported(r);
      }
    },
  });

  const handleFileChange = async (file: File | null) => {
    const seq = ++fileReadSeq.current;
    upload.reset();
    setLocalError(null);
    setRawText(null);
    setSelectedFile(file);
    if (!file) {
      setReadingFile(false);
      return;
    }

    const maxBytes = isEnex ? ENEX_MAX_FILE_BYTES : TODOIST_CSV_MAX_BYTES;
    const expectedExt = isEnex ? '.enex' : '.csv';
    if (!file.name.toLowerCase().endsWith(expectedExt)) {
      setReadingFile(false);
      setLocalError(t('invalidExtension'));
      return;
    }
    if (file.size === 0) {
      setReadingFile(false);
      setLocalError(t('invalidSizeEmpty'));
      return;
    }
    if (file.size > maxBytes) {
      setReadingFile(false);
      setLocalError(t('invalidSizeLimit'));
      return;
    }

    setReadingFile(true);
    try {
      const buffer = await file.arrayBuffer();
      if (fileReadSeq.current !== seq) return;
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (fileReadSeq.current !== seq) return;
      setRawText(decoded);
    } catch {
      if (fileReadSeq.current === seq) setLocalError(t('invalidUtf8'));
    } finally {
      if (fileReadSeq.current === seq) setReadingFile(false);
    }
  };

  const canConfirm =
    !readingFile &&
    !upload.isPending &&
    selectedFile !== null &&
    parseErrorMessage === null &&
    (isEnex ? Boolean(enexPreview) : Boolean(todoistPreview));

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent closeLabel={t('cancel')} className="sm:max-w-lg" data-testid={isEnex ? 'enex-import-dialog' : 'todoist-import-dialog'}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={fileInputId}>{t('fileLabel')}</Label>
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              accept={isEnex ? '.enex,application/xml,text/xml' : '.csv,text/csv'}
              data-testid={isEnex ? 'enex-import-file-input' : 'todoist-import-file-input'}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                void handleFileChange(file);
              }}
              className="block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground file:mr-3 file:min-h-8 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-xs file:font-medium file:text-secondary-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none max-md:min-h-11"
            />
            <p className="text-xs text-subtle-foreground">{t('fileHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={targetSelectId}>{t('targetLabel')}</Label>
            <NativeSelect
              id={targetSelectId}
              value={targetValue}
              data-testid={isEnex ? 'enex-import-target-select' : 'todoist-import-target-select'}
              onChange={(e) => setTargetValue(e.target.value)}
              className="w-full max-md:min-h-11"
            >
              <NativeSelectOption value="auto">{t('targetFromFile')}</NativeSelectOption>
              {isEnex ? (
                <>
                  <NativeSelectOption value="unfiled">{t('targetUnfiled')}</NativeSelectOption>
                  {props.notebooks.map((nb) => (
                    <NativeSelectOption key={nb.id} value={nb.id}>
                      {nb.stackName ? `${nb.stackName} / ${nb.name}` : nb.name}
                    </NativeSelectOption>
                  ))}
                </>
              ) : (
                <>
                  <NativeSelectOption value="inbox">{t('targetInbox')}</NativeSelectOption>
                  {props.todoLists.map((list) => (
                    <NativeSelectOption key={list.id} value={list.id}>
                      {list.name}
                    </NativeSelectOption>
                  ))}
                </>
              )}
            </NativeSelect>
          </div>

          <label htmlFor={skipDupId} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-foreground">
            <Checkbox
              id={skipDupId}
              checked={skipDuplicates}
              data-testid={isEnex ? 'enex-import-skip-duplicates' : 'todoist-import-skip-duplicates'}
              onCheckedChange={(checked) => setSkipDuplicates(checked === true)}
            />
            <span>{t('skipDuplicates')}</span>
          </label>

          {readingFile && (
            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3" aria-busy="true" role="status">
              <p className="text-xs text-subtle-foreground">{t('parsing')}</p>
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3.5 w-3/4" />
            </div>
          )}

          {parseErrorMessage && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert" data-testid="import-parse-error">
              {parseErrorMessage}
            </div>
          )}

          {isEnex && enexPreview && (
            <section
              aria-label={t('previewHeading')}
              data-testid="enex-dry-run-preview"
              className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"
            >
              <h3 className="text-xs font-medium tracking-wide text-subtle-foreground uppercase">{t('previewHeading')}</h3>
              <ul className="space-y-1 text-foreground">
                <li>{t('summaryNotes', { count: enexPreview.notesCount })}</li>
                {enexPreview.attachmentsCount > 0 && <li>{t('summaryAttachments', { count: enexPreview.attachmentsCount })}</li>}
                {enexPreview.tagsCount > 0 && <li>{t('summaryTags', { count: enexPreview.tagsCount })}</li>}
                {enexPreview.notebooksNew.length > 0 && (
                  <li>{t('summaryNotebooksNew', { names: enexPreview.notebooksNew.join(', ') })}</li>
                )}
                {enexPreview.notebooksExisting.length > 0 && (
                  <li>{t('summaryNotebooksReuse', { names: enexPreview.notebooksExisting.join(', ') })}</li>
                )}
                {enexPreview.duplicateTitles > 0 && (
                  <li className="text-subtle-foreground">{t('summaryDuplicateTitles', { count: enexPreview.duplicateTitles })}</li>
                )}
                {enexPreview.strippedRemoteImages > 0 && (
                  <li className="text-subtle-foreground">{t('summaryStrippedImages', { count: enexPreview.strippedRemoteImages })}</li>
                )}
                {enexPreview.warningsCount > 0 && (
                  <li className="text-subtle-foreground">{t('summaryWarnings', { count: enexPreview.warningsCount })}</li>
                )}
              </ul>
            </section>
          )}

          {!isEnex && todoistPreview && (
            <section
              aria-label={t('previewHeading')}
              data-testid="todoist-dry-run-preview"
              className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"
            >
              <h3 className="text-xs font-medium tracking-wide text-subtle-foreground uppercase">{t('previewHeading')}</h3>
              <ul className="space-y-1 text-foreground">
                <li>{t('summaryTasks', { count: todoistPreview.tasksCount })}</li>
                {todoistPreview.checklistStepsCount > 0 && <li>{t('summarySteps', { count: todoistPreview.checklistStepsCount })}</li>}
                {todoistPreview.sectionsCount > 0 && <li>{t('summarySections', { count: todoistPreview.sectionsCount })}</li>}
                {todoistPreview.tagsCount > 0 && <li>{t('summaryTags', { count: todoistPreview.tagsCount })}</li>}
                <li>{t('summaryPriorities', todoistPreview.priorityCounts)}</li>
                {todoistPreview.listsNew.length > 0 && (
                  <li>{t('summaryListsNew', { names: todoistPreview.listsNew.join(', ') })}</li>
                )}
                {todoistPreview.listsExisting.length > 0 && (
                  <li>{t('summaryListsReuse', { names: todoistPreview.listsExisting.join(', ') })}</li>
                )}
                {todoistPreview.duplicateTitles > 0 && (
                  <li className="text-subtle-foreground">{t('summaryDuplicateTitles', { count: todoistPreview.duplicateTitles })}</li>
                )}
                {todoistPreview.skippedRows > 0 && (
                  <li className="text-subtle-foreground">{t('summarySkippedRows', { count: todoistPreview.skippedRows })}</li>
                )}
                {todoistPreview.warnings.length > 0 && (
                  <li className="text-subtle-foreground">{t('summaryWarnings', { count: todoistPreview.warnings.length })}</li>
                )}
              </ul>
            </section>
          )}

          {upload.error && (
            <ErrorText>
              {isEnex && (upload.error as { code?: unknown } | null)?.code === 'NOTE_TOO_LONG'
                ? tNotes('import.noteTooLong')
                : errorMessage(upload.error)}
            </ErrorText>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" className="max-md:min-h-11" disabled={upload.isPending} />}>
            {tCommon('cancel')}
          </DialogClose>
          <Button
            type="button"
            disabled={!canConfirm}
            loading={upload.isPending}
            data-testid={isEnex ? 'enex-import-confirm' : 'todoist-import-confirm'}
            className="max-md:min-h-11"
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? t('importing') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

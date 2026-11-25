// SPDX-License-Identifier: AGPL-3.0-only
// Dialogs to create a project from a starter or org template, or save an existing project as a template (#2607, #4908).
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  BUILTIN_PROJECT_TEMPLATE_KEYS,
  type BuiltinProjectTemplateKey,
  type ProjectTemplateSummary,
  type ProjectVisibility,
} from '@ludy/kernel-contract';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { Textarea } from '@ludy/ui/components/textarea';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput } from './date-input.tsx';
import { ProjectVisibilityField, refreshProjectQueries } from './project-task-dialog.tsx';
import { ErrorText, FieldError, RowsSkeleton, fieldControl } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import { COLUMN_COLOR_DOT_CLASS } from '../lib/projects.ts';

export const DEFAULT_BUILTIN_PROJECT_TEMPLATE_KEY: BuiltinProjectTemplateKey = BUILTIN_PROJECT_TEMPLATE_KEYS[0];

export function nextTemplateRadioIndex(currentIndex: number, key: string, total: number): number | null {
  if (total <= 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % total;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + total) % total;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return null;
}

function localTodayInZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year ?? '2026'}-${byType.month ?? '01'}-${byType.day ?? '01'}`;
}

export type ProjectTemplateDialogProps =
  | {
      mode: 'create';
      open: boolean;
      onOpenChange: (open: boolean) => void;
      onCreated: (projectId: string) => void;
    }
  | {
      mode: 'save';
      open: boolean;
      onOpenChange: (open: boolean) => void;
      projectId: string;
      initialName: string;
      initialDescription: string | null;
      onSaved?: () => void;
    };

export function ProjectTemplateDialog(props: ProjectTemplateDialogProps) {
  const { mode, open, onOpenChange } = props;
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const { locale } = useLocaleSetting();
  const language: 'vi' | 'en' = locale === 'en' ? 'en' : 'vi';
  const tz = browserTimeZone();

  const [selectedId, setSelectedId] = useState<string>(DEFAULT_BUILTIN_PROJECT_TEMPLATE_KEY);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [descEdited, setDescEdited] = useState(false);
  const [startDate, setStartDate] = useState(() => localTodayInZone(tz));
  const [visibility, setVisibility] = useState<ProjectVisibility>('org');
  const [nameError, setNameError] = useState(false);
  const [templateError, setTemplateError] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const radioGroupRef = useRef<HTMLDivElement>(null);

  const listQuery = useQuery({
    ...orpc.projects.listTemplates.queryOptions({ input: { language } }),
    enabled: open && mode === 'create',
  });

  const createFromTemplate = useMutation(orpc.projects.createFromTemplate.mutationOptions());
  const createTemplate = useMutation(orpc.projects.createTemplate.mutationOptions());
  const archiveTemplate = useMutation(orpc.projects.archiveTemplate.mutationOptions());

  const templates = listQuery.data?.templates ?? [];
  const builtins = templates.filter((item) => item.source === 'builtin');
  const customs = templates.filter((item) => item.source === 'custom');
  const allTemplates = [...builtins, ...customs];
  const selectedTemplate: ProjectTemplateSummary | undefined =
    templates.find((item) => item.id === selectedId) ?? templates[0];

  const saveInitialName = mode === 'save' ? props.initialName : '';
  const saveInitialDesc = mode === 'save' ? (props.initialDescription ?? '') : '';

  useEffect(() => {
    if (!open) return;
    setNameError(false);
    setTemplateError(false);
    setIdemKey(crypto.randomUUID());
    if (mode === 'save') {
      setName(saveInitialName);
      setDescription(saveInitialDesc);
      setNameEdited(false);
      setDescEdited(false);
      createTemplate.reset();
    } else {
      setSelectedId(DEFAULT_BUILTIN_PROJECT_TEMPLATE_KEY);
      setNameEdited(false);
      setDescEdited(false);
      setStartDate(localTodayInZone(tz));
      setVisibility('org');
      createFromTemplate.reset();
      archiveTemplate.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, saveInitialName, saveInitialDesc]);

  useEffect(() => {
    if (!open || mode !== 'create' || !selectedTemplate) return;
    if (!nameEdited) setName(selectedTemplate.name);
    if (!descEdited) setDescription(selectedTemplate.description ?? '');
  }, [open, mode, selectedTemplate, nameEdited, descEdited]);

  const nameField = fieldControl(`template-dialog-name-${mode}`, { error: nameError });

  const handleSelectTemplate = (template: ProjectTemplateSummary) => {
    setSelectedId(template.id);
    setTemplateError(false);
    if (!nameEdited) setName(template.name);
    if (!descEdited) setDescription(template.description ?? '');
  };

  const handleRadioKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const nextIndex = nextTemplateRadioIndex(currentIndex, event.key, allTemplates.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const target = allTemplates[nextIndex];
    if (!target) return;
    handleSelectTemplate(target);
    radioGroupRef.current?.querySelector<HTMLButtonElement>(`[data-template-radio-index="${nextIndex}"]`)?.focus();
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(true);
      return;
    }
    if (mode === 'create' && !selectedTemplate) {
      setTemplateError(true);
      return;
    }
    if (!e.currentTarget.checkValidity()) {
      e.currentTarget.reportValidity();
      return;
    }
    const trimmedDesc = description.trim();
    if (mode === 'save') {
      createTemplate.mutate(
        {
          name: trimmedName,
          description: trimmedDesc || null,
          sourceProjectId: props.projectId,
          timeZone: tz,
          idempotencyKey: idemKey,
        },
        {
          onSuccess: () => {
            refreshProjectQueries();
            onOpenChange(false);
            props.onSaved?.();
          },
        },
      );
      return;
    }

    if (!selectedTemplate) {
      return;
    }

    const refPayload =
      selectedTemplate.source === 'builtin'
        ? { builtinKey: (selectedTemplate.builtinKey ?? selectedTemplate.id) as BuiltinProjectTemplateKey }
        : { templateId: selectedTemplate.id };

    createFromTemplate.mutate(
      {
        ...refPayload,
        name: trimmedName,
        description: trimmedDesc || null,
        ...(startDate ? { startDate } : {}),
        visibility,
        timeZone: tz,
        language,
        idempotencyKey: idemKey,
      },
      {
        onSuccess: (res) => {
          refreshProjectQueries();
          onOpenChange(false);
          props.onCreated(res.projectId);
        },
      },
    );
  };

  const pending = mode === 'create' ? createFromTemplate.isPending : createTemplate.isPending;
  const activeError = mode === 'create' ? (createFromTemplate.error ?? archiveTemplate.error) : createTemplate.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={tc('close')}
        className={mode === 'create' ? 'sm:max-w-2xl' : 'sm:max-w-lg'}
        data-testid={mode === 'create' ? 'project-template-dialog' : 'save-project-template-dialog'}
      >
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('templates.createTitle') : t('templates.saveTitle')}</DialogTitle>
          <DialogDescription>{mode === 'create' ? t('templates.createDesc') : t('templates.saveDesc')}</DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          {mode === 'create' && (
            <div className="space-y-3">
              {listQuery.isPending ? (
                <RowsSkeleton rows={3} />
              ) : listQuery.error ? (
                <ErrorText>{errorMessage(listQuery.error)}</ErrorText>
              ) : (
                <>
                  <div ref={radioGroupRef} role="radiogroup" aria-label={t('templates.pickerLabel')} className="space-y-3">
                    <div className="space-y-2" role="group" aria-labelledby="template-builtin-heading">
                      <p id="template-builtin-heading" className="text-xs font-medium text-muted-foreground">
                        {t('templates.builtinSection')}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {builtins.map((tpl, idx) => {
                          const chosen = selectedTemplate?.id === tpl.id;
                          const focusable = chosen || (!selectedTemplate && idx === 0);
                          return (
                            <button
                              key={tpl.id}
                              type="button"
                              role="radio"
                              aria-checked={chosen}
                              tabIndex={focusable ? 0 : -1}
                              data-template-radio-index={idx}
                              data-testid={`template-option-${tpl.id}`}
                              onClick={() => handleSelectTemplate(tpl)}
                              onKeyDown={(e) => handleRadioKeyDown(e, idx)}
                              className={`flex min-h-11 flex-col items-start justify-center gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                                chosen ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-muted/40'
                              }`}
                            >
                              <span className="text-sm font-medium text-foreground">{tpl.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {t('templates.taskCount', { count: tpl.taskCount })}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-2" role="group" aria-labelledby="template-custom-heading">
                      <p id="template-custom-heading" className="text-xs font-medium text-muted-foreground">
                        {t('templates.customSection')}
                      </p>
                      {customs.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                          {t('templates.customEmpty')}
                        </p>
                      ) : (
                        <ul className="max-h-40 divide-y overflow-y-auto rounded-lg border">
                          {customs.map((tpl, idx) => {
                            const flatIndex = builtins.length + idx;
                            const chosen = selectedTemplate?.id === tpl.id;
                            const focusable = chosen || (!selectedTemplate && flatIndex === 0);
                            return (
                              <li
                                key={tpl.id}
                                className={`flex items-center justify-between gap-2 px-3 py-1.5 ${
                                  chosen ? 'bg-primary/5' : ''
                                }`}
                              >
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={chosen}
                                  tabIndex={focusable ? 0 : -1}
                                  data-template-radio-index={flatIndex}
                                  data-testid={`template-option-${tpl.id}`}
                                  onClick={() => handleSelectTemplate(tpl)}
                                  onKeyDown={(e) => handleRadioKeyDown(e, flatIndex)}
                                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md py-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                >
                                  <p className="truncate text-sm font-medium text-foreground">{tpl.name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {t('templates.taskCount', { count: tpl.taskCount })}
                                  </p>
                                </button>
                                {tpl.canManage && (
                                  <ConfirmDialog
                                    destructive
                                    title={t('templates.archiveConfirmTitle')}
                                    description={t('templates.archiveConfirmDesc')}
                                    confirm={t('templates.archiveConfirmBtn')}
                                    onConfirm={() =>
                                      archiveTemplate.mutate(
                                        { templateId: tpl.id, idempotencyKey: crypto.randomUUID() },
                                        {
                                          onSuccess: () => {
                                            refreshProjectQueries();
                                            if (selectedId === tpl.id) setSelectedId(DEFAULT_BUILTIN_PROJECT_TEMPLATE_KEY);
                                          },
                                        },
                                      )
                                    }
                                    render={
                                      <Button
                                        type="button"
                                        size="icon-sm"
                                        variant="ghost"
                                        loading={archiveTemplate.isPending}
                                        aria-label={t('templates.archiveBtn')}
                                      />
                                    }
                                  >
                                    <ProjectIcon name="archive" className="size-3.5" />
                                  </ConfirmDialog>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </div>

                  {selectedTemplate && (
                    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-foreground">{t('templates.previewTitle')}</p>
                        <Badge variant="outline" className="h-5 px-1.5 text-[11px] tabular-nums">
                          {t('templates.taskCount', { count: selectedTemplate.taskCount })}
                        </Badge>
                      </div>
                      {selectedTemplate.tasks.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t('templates.emptyTasks')}</p>
                      ) : (
                        <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                          {selectedTemplate.tasks.map((item, idx) => (
                            <li key={`${item.title}-${idx}`} className="flex items-center justify-between gap-2 text-foreground">
                              <span className="truncate">{item.title}</span>
                              {item.dueOffsetDays !== undefined && item.dueOffsetDays !== null && (
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                  {t('templates.dueOffset', { days: item.dueOffsetDays })}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {selectedTemplate.defaultColumns && selectedTemplate.defaultColumns.length > 0 && (
                        <div className="space-y-1.5 border-t border-border/60 pt-2" data-testid="template-preview-columns">
                          <p className="text-xs font-medium text-foreground">{t('templates.columnsPreviewTitle')}</p>
                          <div className="flex flex-wrap gap-1.5">
                            {selectedTemplate.defaultColumns.map((col, idx) => (
                              <Badge key={`${col.taskStatus}-${idx}`} variant="outline" className="gap-1.5 px-2 py-0.5 text-[11px]">
                                <span
                                  aria-hidden="true"
                                  className={`size-2 rounded-full ${COLUMN_COLOR_DOT_CLASS[col.color]}`}
                                />
                                <span>{col.name}</span>
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              {templateError && <ErrorText>{t('templates.templateRequired')}</ErrorText>}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={nameField.id}>
              {mode === 'create' ? t('templates.nameLabel') : t('templates.templateNameLabel')}
            </Label>
            <Input
              {...nameField}
              required
              maxLength={200}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
                if (nameError && e.target.value.trim()) setNameError(false);
              }}
            />
            <FieldError id={nameField.id}>{nameError ? t('templates.nameRequired') : null}</FieldError>
          </div>

          {mode === 'create' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="template-start-date">{t('templates.startDateLabel')}</Label>
                <DateInput
                  id="template-start-date"
                  value={startDate}
                  onChange={setStartDate}
                  aria-label={t('templates.startDateLabel')}
                />
              </div>
              <ProjectVisibilityField id="template-project-visibility" value={visibility} onChange={setVisibility} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`template-desc-${mode}`}>{t('templates.descLabel')}</Label>
            <Textarea
              id={`template-desc-${mode}`}
              rows={2}
              maxLength={2000}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setDescEdited(true);
              }}
            />
          </div>

          {activeError && <ErrorText>{errorMessage(activeError)}</ErrorText>}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{tc('cancel')}</DialogClose>
            <Button type="submit" loading={pending} disabled={mode === 'create' && !selectedTemplate}>
              <ProjectIcon name="template" className="size-3.5" />
              {mode === 'create' ? t('templates.createSubmit') : t('templates.saveSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

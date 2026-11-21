// SPDX-License-Identifier: AGPL-3.0-only
// Quick note templates picker, save-as-template dialog, and 20-snapshot version history drawer (#3562, Notes v2 E3).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  NOTE_BODY_MAX,
  NOTE_TEMPLATE_NAME_MAX,
  NOTE_TITLE_MAX,
  type Note,
  type NoteTemplate,
  type NoteVersion,
  type NoteVisibility,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@ludy/ui/components/sheet';
import { Tabs, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { Textarea } from '@ludy/ui/components/textarea';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { clientForOrg, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ClientError } from '../lib/errors.ts';
import { computeNoteVersionDiff, starterNoteTemplates, type StarterNoteTemplate } from '../lib/note-templates.ts';
import { parseTags } from '../lib/notes.ts';
import { toast } from '../lib/toast.ts';
import { refreshNotes } from './notes-panel.tsx';
import { Empty, ErrorText, RowsSkeleton } from './ui.tsx';

function invalidateTemplates() {
  return queryClient.invalidateQueries({ queryKey: orpc.notes.templates.key() });
}

interface TemplateFormState {
  name: string;
  title: string;
  body: string;
  tags: string;
  visibility: NoteVisibility;
}

function TemplateFormFields({
  form,
  onChange,
  canChangeVisibility,
  disabled,
  idPrefix,
}: {
  form: TemplateFormState;
  onChange: (patch: Partial<TemplateFormState>) => void;
  canChangeVisibility: boolean;
  disabled: boolean;
  idPrefix: string;
}) {
  const t = useTranslations('notes');
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-name`} className="text-xs font-medium text-muted-foreground">
          {t('templates.nameLabel')}
        </label>
        <Input
          id={`${idPrefix}-name`}
          value={form.name}
          maxLength={NOTE_TEMPLATE_NAME_MAX}
          disabled={disabled}
          placeholder={t('templates.namePlaceholder')}
          onChange={(e) => onChange({ name: e.target.value })}
          data-testid={`${idPrefix}-name`}
        />
      </div>
      {canChangeVisibility && (
        <div className="space-y-1">
          <label htmlFor={`${idPrefix}-visibility`} className="text-xs font-medium text-muted-foreground">
            {t('templates.visibilityLabel')}
          </label>
          <NativeSelect
            id={`${idPrefix}-visibility`}
            value={form.visibility}
            disabled={disabled}
            onChange={(e) => onChange({ visibility: e.target.value as NoteVisibility })}
            data-testid={`${idPrefix}-visibility`}
          >
            <NativeSelectOption value="private">{t('templates.visibilityPrivate')}</NativeSelectOption>
            <NativeSelectOption value="org">{t('templates.visibilityOrg')}</NativeSelectOption>
          </NativeSelect>
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-title`} className="text-xs font-medium text-muted-foreground">
          {t('templates.titleLabel')}
        </label>
        <Input
          id={`${idPrefix}-title`}
          value={form.title}
          maxLength={NOTE_TITLE_MAX}
          disabled={disabled}
          onChange={(e) => onChange({ title: e.target.value })}
          data-testid={`${idPrefix}-title`}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-body`} className="text-xs font-medium text-muted-foreground">
          {t('templates.bodyLabel')}
        </label>
        <Textarea
          id={`${idPrefix}-body`}
          value={form.body}
          rows={6}
          maxLength={NOTE_BODY_MAX}
          disabled={disabled}
          onChange={(e) => onChange({ body: e.target.value })}
          className="font-mono text-xs"
          data-testid={`${idPrefix}-body`}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-tags`} className="text-xs font-medium text-muted-foreground">
          {t('templates.tagsLabel')}
        </label>
        <Input
          id={`${idPrefix}-tags`}
          value={form.tags}
          disabled={disabled}
          placeholder={t('tagsHint')}
          onChange={(e) => onChange({ tags: e.target.value })}
          data-testid={`${idPrefix}-tags`}
        />
      </div>
    </div>
  );
}

export function NewFromTemplateButton({
  slug,
  role,
  onCreated,
}: {
  slug: string;
  role: string | undefined;
  onCreated: (noteId: string) => void;
}) {
  const t = useTranslations('notes');
  const common = useTranslations('common');
  const { locale } = useLocaleSetting();
  const api = useMemo(() => clientForOrg(slug), [slug]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<NoteTemplate | null>(null);
  const [editForm, setEditForm] = useState<TemplateFormState>({
    name: '',
    title: '',
    body: '',
    tags: '',
    visibility: 'private',
  });
  const [deleting, setDeleting] = useState<NoteTemplate | null>(null);

  const writer = role !== undefined && role !== 'viewer';
  const manager = role === 'owner' || role === 'admin';
  const starters = useMemo(() => starterNoteTemplates(locale), [locale]);
  const templatesQuery = useQuery({
    ...orpc.notes.templates.list.queryOptions({ input: {} }),
    enabled: open && writer,
  });

  const customTemplates = templatesQuery.data ?? [];
  const privateMine = customTemplates.filter((item) => item.visibility === 'private' && item.mine);
  const sharedOrg = customTemplates.filter((item) => item.visibility === 'org');

  const createFromTemplate = useMutation({
    mutationFn: async (tpl: { name: string; title: string; body: string; tags: string[] }) =>
      api.notes.create({
        title: tpl.title.trim() || tpl.name.trim() || t('newTitle'),
        body: tpl.body,
        tags: tpl.tags,
        visibility: 'private',
      }),
    onSuccess: (done, tpl) => {
      setOpen(false);
      void refreshNotes();
      toast(t('templates.createdNoteToast', { name: tpl.name }), 'success');
      onCreated(done.noteId);
    },
  });

  const updateTemplate = useMutation({
    mutationFn: async (target: NoteTemplate) =>
      api.notes.templates.update({
        templateId: target.id,
        revision: target.revision,
        name: editForm.name.trim(),
        title: editForm.title.trim(),
        body: editForm.body,
        tags: parseTags(editForm.tags),
        visibility: target.mine ? editForm.visibility : 'org',
      }),
    onSuccess: () => {
      const savedName = editForm.name.trim();
      setEditing(null);
      void invalidateTemplates();
      toast(t('templates.updatedToast', { name: savedName }), 'success');
    },
  });

  const deleteTemplate = useMutation({
    mutationFn: async (target: NoteTemplate) => api.notes.templates.delete({ templateId: target.id }),
    onSuccess: () => {
      setDeleting(null);
      void invalidateTemplates();
      toast(t('templates.deletedToast'), 'success');
    },
  });

  if (!writer) return null;

  const startEdit = (tpl: NoteTemplate) => {
    updateTemplate.reset();
    setEditing(tpl);
    setEditForm({
      name: tpl.name,
      title: tpl.title,
      body: tpl.body,
      tags: tpl.tags.join(', '),
      visibility: tpl.visibility,
    });
  };

  const renderCustomRow = (tpl: NoteTemplate) => {
    const canManage = tpl.mine || (tpl.visibility === 'org' && manager);
    return (
      <li
        key={tpl.id}
        data-testid={`note-template-custom-${tpl.id}`}
        className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium text-foreground">{tpl.name}</span>
            <Badge variant={tpl.visibility === 'org' ? 'secondary' : 'outline'}>
              {tpl.visibility === 'org' ? t('shared') : t('private')}
            </Badge>
          </div>
          {tpl.title.trim() !== '' && <p className="truncate text-xs text-muted-foreground">{tpl.title}</p>}
          {tpl.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tpl.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-[11px]">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {canManage && (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={createFromTemplate.isPending}
                onClick={() => startEdit(tpl)}
                data-testid={`note-template-edit-${tpl.id}`}
              >
                {t('templates.editBtn')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={createFromTemplate.isPending}
                onClick={() => {
                  deleteTemplate.reset();
                  setDeleting(tpl);
                }}
                data-testid={`note-template-delete-${tpl.id}`}
              >
                {t('templates.deleteBtn')}
              </Button>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={createFromTemplate.isPending && createFromTemplate.variables?.name === tpl.name}
            disabled={createFromTemplate.isPending}
            onClick={() => createFromTemplate.mutate({ name: tpl.name, title: tpl.title, body: tpl.body, tags: tpl.tags })}
            data-testid={`note-template-use-${tpl.id}`}
          >
            {t('templates.useBtn')}
          </Button>
        </div>
      </li>
    );
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="notes-new-from-template">
        {t('templates.newFromTemplate')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={common('close')} className="sm:max-w-xl" data-testid="notes-template-picker-dialog">
          <DialogHeader>
            <DialogTitle>{t('templates.pickerTitle')}</DialogTitle>
            <DialogDescription>{t('templates.pickerDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <section className="space-y-2" aria-labelledby="notes-starter-templates-heading">
              <h3 id="notes-starter-templates-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('templates.starterHeading')}
              </h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {starters.map((tpl: StarterNoteTemplate) => (
                  <li key={tpl.id} className="flex flex-col justify-between gap-2 rounded-lg border border-border p-3">
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">{tpl.name}</p>
                      <p className="text-xs text-muted-foreground">{tpl.description}</p>
                    </div>
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        loading={createFromTemplate.isPending && createFromTemplate.variables?.name === tpl.name}
                        disabled={createFromTemplate.isPending}
                        onClick={() =>
                          createFromTemplate.mutate({
                            name: tpl.name,
                            title: tpl.title,
                            body: tpl.body,
                            tags: [...tpl.tags],
                          })
                        }
                        data-testid={`note-template-starter-${tpl.id}`}
                      >
                        {t('templates.useBtn')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {templatesQuery.isPending ? (
              <RowsSkeleton rows={3} />
            ) : templatesQuery.error ? (
              <ErrorText>{errorMessage(templatesQuery.error)}</ErrorText>
            ) : privateMine.length === 0 && sharedOrg.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground" data-testid="notes-templates-empty-custom">
                {t('templates.emptyCustom')}
              </p>
            ) : (
              <>
                {privateMine.length > 0 && (
                  <section className="space-y-2" aria-labelledby="notes-private-templates-heading">
                    <h3 id="notes-private-templates-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('templates.mineHeading')}
                    </h3>
                    <ul className="space-y-2">{privateMine.map(renderCustomRow)}</ul>
                  </section>
                )}
                {sharedOrg.length > 0 && (
                  <section className="space-y-2" aria-labelledby="notes-shared-templates-heading">
                    <h3 id="notes-shared-templates-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('templates.sharedHeading')}
                    </h3>
                    <ul className="space-y-2">{sharedOrg.map(renderCustomRow)}</ul>
                  </section>
                )}
              </>
            )}

            {createFromTemplate.error && <ErrorText>{errorMessage(createFromTemplate.error)}</ErrorText>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(next) => !next && setEditing(null)}>
        <DialogContent closeLabel={common('close')} data-testid="note-template-edit-dialog">
          <DialogHeader>
            <DialogTitle>{t('templates.editDialogTitle')}</DialogTitle>
            <DialogDescription>{t('templates.saveDialogDescription')}</DialogDescription>
          </DialogHeader>
          {editing && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!editForm.name.trim() || updateTemplate.isPending) return;
                updateTemplate.mutate(editing);
              }}
            >
              <TemplateFormFields
                form={editForm}
                onChange={(patch) => setEditForm((prev) => ({ ...prev, ...patch }))}
                canChangeVisibility={editing.mine}
                disabled={updateTemplate.isPending}
                idPrefix="note-template-edit"
              />
              {updateTemplate.error && <ErrorText>{errorMessage(updateTemplate.error)}</ErrorText>}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                  {t('cancel')}
                </Button>
                <Button
                  type="submit"
                  loading={updateTemplate.isPending}
                  disabled={!editForm.name.trim() || updateTemplate.isPending}
                  data-testid="note-template-edit-submit"
                >
                  {t('templates.saveSubmitBtn')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <DialogContent variant="destructive" closeLabel={common('close')} data-testid="note-template-delete-dialog">
          <DialogHeader>
            <DialogTitle>{t('templates.deleteConfirmTitle')}</DialogTitle>
            {deleting && <DialogDescription>{t('templates.deleteConfirmDescription', { name: deleting.name })}</DialogDescription>}
          </DialogHeader>
          {deleteTemplate.error && <ErrorText>{errorMessage(deleteTemplate.error)}</ErrorText>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={deleteTemplate.isPending}
              disabled={deleteTemplate.isPending || deleting === null}
              onClick={() => deleting && deleteTemplate.mutate(deleting)}
              data-testid="note-template-delete-confirm"
            >
              {t('templates.confirmDeleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SaveAsTemplateButton({
  slug,
  title,
  body,
  tags,
  defaultVisibility,
  disabled,
  disabledHint,
  beforeOpen,
}: {
  slug: string;
  title: string;
  body: string;
  tags: readonly string[];
  defaultVisibility: NoteVisibility;
  disabled?: boolean | undefined;
  // Why the button is disabled, shown on hover (for example AI text that nobody has edited yet).
  disabledHint?: string | undefined;
  beforeOpen?: (() => Promise<void>) | undefined;
}) {
  const t = useTranslations('notes');
  const common = useTranslations('common');
  const api = useMemo(() => clientForOrg(slug), [slug]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<TemplateFormState>({
    name: '',
    title: '',
    body: '',
    tags: '',
    visibility: 'private',
  });

  const saveMutation = useMutation({
    mutationFn: async () =>
      api.notes.templates.create({
        name: form.name.trim(),
        title: form.title.trim(),
        body: form.body,
        tags: parseTags(form.tags),
        visibility: form.visibility,
      }),
    onSuccess: () => {
      const savedName = form.name.trim();
      setOpen(false);
      void invalidateTemplates();
      toast(t('templates.savedToast', { name: savedName }), 'success');
    },
  });

  const handleOpen = async () => {
    await beforeOpen?.();
    saveMutation.reset();
    setForm({
      name: title.trim().slice(0, NOTE_TEMPLATE_NAME_MAX),
      title: title.trim(),
      body,
      tags: tags.join(', '),
      visibility: defaultVisibility,
    });
    setOpen(true);
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
        onClick={() => void handleOpen()}
        data-testid="note-save-as-template"
      >
        {t('templates.saveAsTemplateBtn')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={common('close')} data-testid="note-save-as-template-dialog">
          <DialogHeader>
            <DialogTitle>{t('templates.saveDialogTitle')}</DialogTitle>
            <DialogDescription>{t('templates.saveDialogDescription')}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!form.name.trim() || saveMutation.isPending) return;
              saveMutation.mutate();
            }}
          >
            <TemplateFormFields
              form={form}
              onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
              canChangeVisibility
              disabled={saveMutation.isPending}
              idPrefix="note-template-save"
            />
            {saveMutation.error && <ErrorText>{errorMessage(saveMutation.error)}</ErrorText>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                loading={saveMutation.isPending}
                disabled={!form.name.trim() || saveMutation.isPending}
                data-testid="note-template-save-submit"
              >
                {t('templates.saveSubmitBtn')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function NoteVersionHistoryButton({
  slug,
  note,
  currentTitle,
  currentBody,
  currentTags,
  canRestore,
  disabled,
  beforeOpen,
  prepareRestore,
  getCurrentRevision,
  onRestored,
}: {
  slug: string;
  note: Note;
  currentTitle: string;
  currentBody: string;
  currentTags: readonly string[];
  canRestore: boolean;
  disabled?: boolean | undefined;
  beforeOpen?: (() => Promise<void>) | undefined;
  // Saves pending edits and answers whether none is left; a restore never replaces text that is not saved yet.
  prepareRestore?: (() => Promise<boolean>) | undefined;
  getCurrentRevision?: (() => number) | undefined;
  onRestored: () => Promise<void>;
}) {
  const t = useTranslations('notes');
  const common = useTranslations('common');
  const f = useFormat();
  const api = useMemo(() => clientForOrg(slug), [slug]);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<'unified' | 'side'>('unified');

  const versionsQuery = useQuery({
    ...orpc.notes.versions.queryOptions({ input: { noteId: note.id } }),
    enabled: open,
    staleTime: 0,
  });

  const versions = versionsQuery.data ?? [];
  useEffect(() => {
    if (versions.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId === null || !versions.some((v) => v.id === selectedId)) {
      setSelectedId(versions[0]?.id ?? null);
    }
  }, [versions, selectedId]);

  const selected: NoteVersion | null = versions.find((v) => v.id === selectedId) ?? versions[0] ?? null;

  const diff = useMemo(
    () =>
      selected
        ? computeNoteVersionDiff(
            { title: selected.title, body: selected.body, tags: selected.tags },
            { title: currentTitle, body: currentBody, tags: currentTags },
          )
        : null,
    [selected, currentTitle, currentBody, currentTags],
  );

  const restoreMutation = useMutation({
    mutationFn: async (target: NoteVersion) => {
      if (prepareRestore && !(await prepareRestore())) {
        throw new ClientError('notes.versions.unsavedBlocked', (tr) => tr('notes.versions.unsavedBlocked'));
      }
      const revision = getCurrentRevision ? getCurrentRevision() : note.revision;
      return api.notes.restoreVersion({
        noteId: note.id,
        revision,
        versionId: target.id,
      });
    },
    onSuccess: async (_done, target) => {
      await queryClient.invalidateQueries({ queryKey: orpc.notes.key() });
      await onRestored();
      toast(t('versions.restoredToast', { revision: target.revision }), 'success');
      setOpen(false);
    },
  });

  const handleOpen = async () => {
    restoreMutation.reset();
    await beforeOpen?.();
    await queryClient.invalidateQueries({
      queryKey: orpc.notes.versions.key({ input: { noteId: note.id } }),
    });
    setOpen(true);
  };

  const currentRev = getCurrentRevision ? getCurrentRevision() : note.revision;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => void handleOpen()}
        data-testid="note-version-history-open"
      >
        {t('versions.openBtn')}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent closeLabel={common('close')} className="sm:max-w-2xl" data-testid="note-version-history-drawer">
          <SheetHeader>
            <SheetTitle>{t('versions.drawerTitle')}</SheetTitle>
            <SheetDescription>{t('versions.drawerDescription')}</SheetDescription>
          </SheetHeader>

          <SheetBody className="space-y-4">
            {versionsQuery.isPending ? (
              <RowsSkeleton rows={4} />
            ) : versionsQuery.error ? (
              <ErrorText>{errorMessage(versionsQuery.error)}</ErrorText>
            ) : versions.length === 0 ? (
              <Empty title={t('versions.emptyTitle')} hint={t('versions.emptyHint')} />
            ) : (
              <>
                <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-border p-2" data-testid="note-version-list">
                  {versions.map((v) => {
                    const active = selected?.id === v.id;
                    return (
                      <li key={v.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(v.id)}
                          data-testid={`note-version-item-${v.revision}`}
                          aria-pressed={active}
                          className={`flex max-md:min-h-11 w-full items-center justify-between gap-2 rounded-md border border-transparent px-2.5 py-2 text-left text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ${
                            active ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-muted/60 text-foreground'
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <Badge variant={active ? 'default' : 'outline'}>
                              {t('versions.revisionBadge', { revision: v.revision })}
                            </Badge>
                            {v.tainted && <Badge variant="proposal">{t('versions.aiBadge')}</Badge>}
                            <span className="truncate">{v.title || t('newTitle')}</span>
                          </div>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {t('versions.savedAt', { when: f.dateTime(v.createdAt) })}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {selected && diff && (
                  <div className="space-y-3" data-testid="note-version-diff-panel">
                    {diff.titleChanged && (
                      <div className="space-y-1 rounded-md border border-border p-2.5 text-xs">
                        <p className="font-medium text-muted-foreground">{t('versions.titleDiffLabel')}</p>
                        <p className="rounded bg-destructive/10 px-2 py-1 font-mono text-destructive">- {selected.title}</p>
                        <p className="rounded bg-success/10 px-2 py-1 font-mono text-success">+ {currentTitle}</p>
                      </div>
                    )}

                    {diff.tagsChanged && (
                      <div className="space-y-1 rounded-md border border-border p-2.5 text-xs">
                        <p className="font-medium text-muted-foreground">{t('versions.tagsDiffLabel')}</p>
                        <p className="rounded bg-destructive/10 px-2 py-1 font-mono text-destructive">
                          - {selected.tags.length > 0 ? selected.tags.join(', ') : t('versions.emptyTags')}
                        </p>
                        <p className="rounded bg-success/10 px-2 py-1 font-mono text-success">
                          + {currentTags.length > 0 ? currentTags.join(', ') : t('versions.emptyTags')}
                        </p>
                      </div>
                    )}

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-muted-foreground">{t('versions.bodyDiffLabel')}</span>
                          <span className="text-xs text-subtle-foreground">
                            {t('versions.linesSummary', { added: diff.addedLines, removed: diff.removedLines })}
                          </span>
                        </div>
                        <Tabs value={diffMode} onValueChange={(val) => setDiffMode(val as 'unified' | 'side')}>
                          <TabsList>
                            <TabsTrigger value="unified" data-testid="note-version-diff-unified">
                              {t('versions.diffUnified')}
                            </TabsTrigger>
                            <TabsTrigger value="side" data-testid="note-version-diff-side">
                              {t('versions.diffSideBySide')}
                            </TabsTrigger>
                          </TabsList>
                        </Tabs>
                      </div>

                      {!diff.bodyChanged ? (
                        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                          {t('versions.noBodyChanges')}
                        </p>
                      ) : diffMode === 'unified' ? (
                        <pre
                          data-testid="note-version-unified-view"
                          className="max-h-72 overflow-auto rounded-md border border-border bg-muted/20 p-2.5 font-mono text-xs leading-relaxed"
                        >
                          {diff.lines.map((line, idx) => (
                            <div
                              key={idx}
                              className={
                                line.kind === 'added'
                                  ? 'bg-success/10 text-success px-1.5'
                                  : line.kind === 'removed'
                                    ? 'bg-destructive/10 text-destructive px-1.5'
                                    : 'text-foreground px-1.5'
                              }
                            >
                              {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                              {line.text}
                            </div>
                          ))}
                        </pre>
                      ) : (
                        <div
                          data-testid="note-version-side-view"
                          className="grid max-h-72 grid-cols-1 gap-2 overflow-auto sm:grid-cols-2"
                        >
                          <div className="space-y-1 rounded-md border border-border bg-muted/20 p-2">
                            <p className="text-[11px] font-medium text-muted-foreground">
                              {t('versions.snapshotColumn', { revision: selected.revision })}
                            </p>
                            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{selected.body}</pre>
                          </div>
                          <div className="space-y-1 rounded-md border border-border bg-muted/20 p-2">
                            <p className="text-[11px] font-medium text-muted-foreground">
                              {t('versions.currentColumn', { revision: currentRev })}
                            </p>
                            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{currentBody}</pre>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {restoreMutation.error && <ErrorText>{errorMessage(restoreMutation.error)}</ErrorText>}
              </>
            )}
          </SheetBody>

          <SheetFooter className="sm:items-center sm:justify-between">
            {!canRestore && versions.length > 0 ? (
              <p className="text-xs text-subtle-foreground">{t('versions.readOnlyHint')}</p>
            ) : (
              <span />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
              {canRestore && selected && (
                <Button
                  type="button"
                  loading={restoreMutation.isPending}
                  disabled={restoreMutation.isPending}
                  onClick={() => restoreMutation.mutate(selected)}
                  data-testid="note-version-restore"
                >
                  {restoreMutation.isPending ? t('versions.restoring') : t('versions.restoreBtn')}
                </Button>
              )}
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

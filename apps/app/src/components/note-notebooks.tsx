// SPDX-License-Identifier: AGPL-3.0-only
// Notebooks, 2-level stacks, wiki-link autocomplete, and RLS-safe backlinks (#3559, docs/plan/notes-v2.md V2-4 / E1).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  NOTEBOOK_NAME_MAX,
  NOTEBOOK_STACK_MAX,
  type NoteSummary,
  type NoteVisibility,
  type NotebookSummary,
} from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { VisibilityIcon } from '@crove/ui/components/visibility-icon';
import { useFormat } from '../i18n/provider.tsx';
import { clientForOrg, errorMessage, orpc } from '../lib/api.ts';
import { listOfNote, normalizeWikiTitle, type NotesSearch } from '../lib/notes.ts';
import { refreshNotes, VisibilityBadge } from './notes-panel.tsx';
import { ErrorText } from './ui.tsx';

export interface StackGroup {
  stackName: string;
  notebooks: NotebookSummary[];
  noteCount: number;
}

export function groupNotebooks(notebooks: readonly NotebookSummary[]): {
  pinned: NotebookSummary[];
  stacks: StackGroup[];
  standalone: NotebookSummary[];
  stackNames: string[];
} {
  const pinned = notebooks.filter((b) => b.pinned);
  const stackMap = new Map<string, NotebookSummary[]>();
  const standalone: NotebookSummary[] = [];

  for (const nb of notebooks) {
    if (nb.stackName) {
      const group = stackMap.get(nb.stackName) ?? [];
      group.push(nb);
      stackMap.set(nb.stackName, group);
    } else {
      standalone.push(nb);
    }
  }

  const stacks: StackGroup[] = [...stackMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'vi'))
    .map(([stackName, items]) => ({
      stackName,
      notebooks: items,
      noteCount: items.reduce((sum, item) => sum + item.noteCount, 0),
    }));

  return {
    pinned,
    stacks,
    standalone,
    stackNames: stacks.map((s) => s.stackName),
  };
}

export function NotebooksSidebar({
  slug,
  canWrite,
  notebooks,
  allCount,
  unfiledCount,
  selectedNotebook,
  selectedStack,
  onSelectFilter,
}: {
  slug: string;
  canWrite: boolean;
  notebooks: readonly NotebookSummary[];
  allCount: number;
  unfiledCount: number;
  selectedNotebook: string | undefined;
  selectedStack: string | undefined;
  onSelectFilter: (filter: { notebook?: string; stack?: string }) => void;
}) {
  const t = useTranslations('notes');
  const api = useMemo(() => clientForOrg(slug), [slug]);
  const datalistId = useId();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<NotebookSummary | null>(null);
  const [deleting, setDeleting] = useState<NotebookSummary | null>(null);
  const [collapsedStacks, setCollapsedStacks] = useState<Record<string, boolean>>({});

  const [name, setName] = useState('');
  const [stackName, setStackName] = useState('');
  const [visibility, setVisibility] = useState<NoteVisibility>('private');
  const [pinned, setPinned] = useState(false);

  const { pinned: pinnedList, stacks, standalone, stackNames } = useMemo(() => groupNotebooks(notebooks), [notebooks]);

  const openCreate = () => {
    setEditing(null);
    setDeleting(null);
    setName('');
    setStackName(selectedStack ?? '');
    setVisibility('private');
    setPinned(false);
    setCreating(true);
  };

  const openEdit = (nb: NotebookSummary) => {
    setCreating(false);
    setDeleting(null);
    setName(nb.name);
    setStackName(nb.stackName ?? '');
    setVisibility(nb.visibility);
    setPinned(nb.pinned);
    setEditing(nb);
  };

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
  };

  const saveNotebook = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      const trimmedStack = stackName.trim() || null;
      if (editing) {
        return api.notes.notebooks.update({
          notebookId: editing.id,
          revision: editing.revision,
          name: trimmedName,
          stackName: trimmedStack,
          ...(editing.mine ? { visibility } : {}),
          pinned,
        });
      }
      return api.notes.notebooks.create({
        name: trimmedName,
        stackName: trimmedStack,
        visibility,
        pinned,
      });
    },
    onSuccess: (done) => {
      const wasCreating = creating;
      closeForm();
      void refreshNotes();
      if (wasCreating) {
        onSelectFilter({ notebook: done.notebookId });
      }
    },
  });

  const deleteNotebook = useMutation({
    mutationFn: (nb: NotebookSummary) => api.notes.notebooks.delete({ notebookId: nb.id }),
    onSuccess: (_done, nb) => {
      setDeleting(null);
      if (selectedNotebook === nb.id) {
        onSelectFilter({});
      }
      void refreshNotes();
    },
  });

  const submitForm = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saveNotebook.isPending) return;
    saveNotebook.mutate();
  };

  const renderNotebookRow = (nb: NotebookSummary, keyPrefix: string) => {
    const active = selectedNotebook === nb.id;
    return (
      <li key={`${keyPrefix}-${nb.id}`} className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onSelectFilter({ notebook: nb.id })}
          aria-pressed={active}
          data-testid="notebook-item"
          data-notebook-id={nb.id}
          className={
            active
              ? 'flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-left text-xs font-medium text-foreground'
              : 'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground'
          }
        >
          <VisibilityIcon shared={nb.visibility === 'org'} className="size-3 shrink-0" />
          <span className="truncate">{nb.name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-subtle-foreground">{nb.noteCount}</span>
        </button>
        {nb.editable && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => openEdit(nb)}
              aria-label={`${t('notebooks.editBtn')}: ${nb.name}`}
              data-testid="notebook-edit-btn"
              className="px-1.5 text-subtle-foreground hover:text-foreground"
            >
              {t('notebooks.editBtn')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                closeForm();
                setDeleting(nb);
              }}
              aria-label={`${t('notebooks.deleteBtn')}: ${nb.name}`}
              data-testid="notebook-delete-btn"
              className="px-1.5 text-subtle-foreground hover:text-foreground"
            >
              ×
            </Button>
          </div>
        )}
      </li>
    );
  };

  const isAllSelected = !selectedNotebook && !selectedStack;
  const isUnfiledSelected = selectedNotebook === 'unfiled';

  return (
    <nav aria-label={t('notebooks.heading')} data-testid="notebooks-sidebar" className="mt-3 space-y-2 rounded-lg border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{t('notebooks.heading')}</span>
        {canWrite && !creating && !editing && (
          <Button type="button" variant="outline" size="xs" onClick={openCreate} data-testid="notebook-new-btn">
            {t('notebooks.newBtn')}
          </Button>
        )}
      </div>

      <ul className="space-y-0.5">
        <li>
          <button
            type="button"
            onClick={() => onSelectFilter({})}
            aria-pressed={isAllSelected}
            data-testid="notebook-filter-all"
            className={
              isAllSelected
                ? 'flex w-full items-center justify-between rounded-md bg-muted px-2 py-1 text-left text-xs font-medium text-foreground'
                : 'flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }
          >
            <span>{t('notebooks.allNotes')}</span>
            <span className="text-[11px] text-subtle-foreground">{allCount}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            onClick={() => onSelectFilter({ notebook: 'unfiled' })}
            aria-pressed={isUnfiledSelected}
            data-testid="notebook-filter-unfiled"
            className={
              isUnfiledSelected
                ? 'flex w-full items-center justify-between rounded-md bg-muted px-2 py-1 text-left text-xs font-medium text-foreground'
                : 'flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }
          >
            <span>{t('notebooks.unfiled')}</span>
            <span className="text-[11px] text-subtle-foreground">{unfiledCount}</span>
          </button>
        </li>
      </ul>

      {(creating || editing) && (
        <form onSubmit={submitForm} data-testid="notebook-form" className="space-y-2 rounded-md border bg-muted/30 p-2 text-xs">
          <div className="space-y-1">
            <label htmlFor="notebook-name-input" className="block font-medium text-foreground">
              {t('notebooks.nameLabel')}
            </label>
            <Input
              id="notebook-name-input"
              value={name}
              maxLength={NOTEBOOK_NAME_MAX}
              autoFocus
              required
              onChange={(e) => setName(e.target.value)}
              placeholder={t('notebooks.namePlaceholder')}
              data-testid="notebook-name-input"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="notebook-stack-input" className="block font-medium text-foreground">
              {t('notebooks.stackLabel')}
            </label>
            <Input
              id="notebook-stack-input"
              list={datalistId}
              value={stackName}
              maxLength={NOTEBOOK_STACK_MAX}
              onChange={(e) => setStackName(e.target.value)}
              placeholder={t('notebooks.stackPlaceholder')}
              data-testid="notebook-stack-input"
            />
            {stackNames.length > 0 && (
              <datalist id={datalistId}>
                {stackNames.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </div>
          {(!editing || editing.mine) && (
            <div className="space-y-1">
              <label htmlFor="notebook-visibility-select" className="block font-medium text-foreground">
                {t('notebooks.visibilityLabel')}
              </label>
              <select
                id="notebook-visibility-select"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as NoteVisibility)}
                data-testid="notebook-visibility-select"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-xs text-foreground"
              >
                <option value="private">{t('notebooks.privateOption')}</option>
                <option value="org">{t('notebooks.sharedOption')}</option>
              </select>
            </div>
          )}
          <label className="flex items-center gap-2 text-foreground">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              data-testid="notebook-pinned-checkbox"
              className="accent-primary"
            />
            <span>{t('notebooks.pinnedLabel')}</span>
          </label>
          {saveNotebook.error && <ErrorText>{errorMessage(saveNotebook.error)}</ErrorText>}
          <div className="flex flex-wrap gap-1.5">
            <Button type="submit" size="xs" loading={saveNotebook.isPending} disabled={!name.trim() || saveNotebook.isPending} data-testid="notebook-submit-btn">
              {editing ? t('notebooks.saveBtn') : t('notebooks.createBtn')}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={closeForm}>
              {t('notebooks.cancelBtn')}
            </Button>
          </div>
        </form>
      )}

      {deleting && (
        <div role="alertdialog" aria-label={t('notebooks.deleteBtn')} data-testid="notebook-delete-dialog" className="space-y-2 rounded-md border bg-muted/30 p-2 text-xs">
          <p className="text-foreground">{t('notebooks.deleteConfirm', { name: deleting.name })}</p>
          {deleteNotebook.error && <ErrorText>{errorMessage(deleteNotebook.error)}</ErrorText>}
          <div className="flex gap-1.5">
            <Button
              type="button"
              variant="destructive"
              size="xs"
              loading={deleteNotebook.isPending}
              onClick={() => deleteNotebook.mutate(deleting)}
              data-testid="notebook-confirm-delete-btn"
            >
              {t('notebooks.deleteBtn')}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setDeleting(null)}>
              {t('notebooks.cancelBtn')}
            </Button>
          </div>
        </div>
      )}

      {pinnedList.length > 0 && (
        <div className="space-y-1 pt-1" data-testid="notebooks-pinned-section">
          <p className="px-2 text-[11px] font-medium text-subtle-foreground">{t('notebooks.pinnedGroup')}</p>
          <ul className="space-y-0.5">{pinnedList.map((nb) => renderNotebookRow(nb, 'pin'))}</ul>
        </div>
      )}

      {stacks.length > 0 && (
        <div className="space-y-1 pt-1" data-testid="notebooks-stacks-section">
          <p className="px-2 text-[11px] font-medium text-subtle-foreground">{t('notebooks.stacksGroup')}</p>
          <div className="space-y-1">
            {stacks.map((group) => {
              const collapsed = collapsedStacks[group.stackName] === true;
              const stackActive = selectedStack === group.stackName && !selectedNotebook;
              return (
                <div key={group.stackName} data-testid="notebook-stack" data-stack-name={group.stackName} className="space-y-0.5">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      aria-label={t('notebooks.expandStack', { stack: group.stackName })}
                      onClick={() => setCollapsedStacks((prev) => ({ ...prev, [group.stackName]: !collapsed }))}
                      data-testid="notebook-stack-toggle"
                      className="rounded px-1.5 py-0.5 text-xs text-subtle-foreground hover:bg-muted/50 hover:text-foreground"
                    >
                      {collapsed ? '+' : '-'}
                    </button>
                    <button
                      type="button"
                      aria-pressed={stackActive}
                      aria-label={t('notebooks.filterStack', { stack: group.stackName })}
                      onClick={() => onSelectFilter({ stack: group.stackName })}
                      data-testid="notebook-stack-filter"
                      className={
                        stackActive
                          ? 'flex min-w-0 flex-1 items-center justify-between rounded-md bg-muted px-2 py-1 text-left text-xs font-medium text-foreground'
                          : 'flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      }
                    >
                      <span className="truncate">{group.stackName}</span>
                      <span className="ml-2 shrink-0 text-[11px] text-subtle-foreground">{group.noteCount}</span>
                    </button>
                  </div>
                  {!collapsed && (
                    <ul className="space-y-0.5 border-l pl-3">{group.notebooks.map((nb) => renderNotebookRow(nb, 'stack'))}</ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {standalone.length > 0 && (
        <div className="space-y-1 pt-1" data-testid="notebooks-standalone-section">
          {stacks.length > 0 && <p className="px-2 text-[11px] font-medium text-subtle-foreground">{t('notebooks.standaloneGroup')}</p>}
          <ul className="space-y-0.5">{standalone.map((nb) => renderNotebookRow(nb, 'flat'))}</ul>
        </div>
      )}
    </nav>
  );
}

export function NoteNotebookPicker({
  noteVisibility,
  notebookId,
  notebooks,
  editable,
  disabled,
  onChangeNotebook,
}: {
  noteVisibility: NoteVisibility;
  notebookId: string | null | undefined;
  notebooks: readonly NotebookSummary[];
  editable: boolean;
  disabled?: boolean;
  onChangeNotebook: (nextNotebookId: string | null) => void;
}) {
  const t = useTranslations('notes');
  const current = notebookId ? notebooks.find((b) => b.id === notebookId) : undefined;

  if (!editable) {
    if (!current) return null;
    const label = current.stackName ? `${current.stackName} / ${current.name}` : current.name;
    return (
      <Badge variant="outline" data-testid="note-notebook-badge">
        {label}
      </Badge>
    );
  }

  // Hide private notebooks when the note is shared ('org'), preventing invalid cross-visibility assignment.
  const choices = notebooks.filter((b) => noteVisibility !== 'org' || b.visibility === 'org');

  return (
    <div className="flex items-center gap-2 text-xs">
      <label htmlFor="note-notebook-select" className="font-medium text-muted-foreground">
        {t('notebooks.assignLabel')}
      </label>
      <select
        id="note-notebook-select"
        value={notebookId ?? ''}
        disabled={disabled}
        onChange={(e) => onChangeNotebook(e.target.value ? e.target.value : null)}
        data-testid="note-notebook-select"
        className="max-w-xs rounded-md border bg-background px-2 py-1 text-xs text-foreground"
      >
        <option value="">{t('notebooks.unfiledOption')}</option>
        {choices.map((b) => {
          const path = b.stackName ? `${b.stackName} / ${b.name}` : b.name;
          const vis = b.visibility === 'org' ? t('shared') : t('private');
          return (
            <option key={b.id} value={b.id}>
              {path} ({vis})
            </option>
          );
        })}
      </select>
    </div>
  );
}

export function NoteWikiAutocomplete({
  query,
  candidates,
  activeIndex,
  onPick,
}: {
  query: string;
  candidates: readonly NoteSummary[];
  activeIndex: number;
  onPick: (target: NoteSummary, duplicateTitle: boolean) => void;
}) {
  const t = useTranslations('notes');
  const titleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of candidates) {
      const key = normalizeWikiTitle(c.title);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [candidates]);

  const filtered = useMemo(() => {
    const q = normalizeWikiTitle(query);
    const list = q === '' ? [...candidates] : candidates.filter((n) => normalizeWikiTitle(n.title).includes(q));
    return list.slice(0, 8);
  }, [candidates, query]);

  return (
    <div
      role="listbox"
      aria-label={t('wikiLinks.suggestionsLabel')}
      data-testid="note-wiki-autocomplete"
      className="rounded-md border bg-popover p-1.5 text-xs shadow-sm"
    >
      <p className="px-2 py-0.5 text-[11px] text-subtle-foreground">{t('wikiLinks.hint')}</p>
      {filtered.length === 0 ? (
        <p className="px-2 py-1 text-subtle-foreground">{t('wikiLinks.noMatches')}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {filtered.map((item, idx) => {
            const selected = idx === activeIndex;
            const duplicateTitle = (titleCounts.get(normalizeWikiTitle(item.title)) ?? 0) > 1;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(item, duplicateTitle)}
                  data-testid="note-wiki-option"
                  className={
                    selected
                      ? 'flex w-full items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-left font-medium text-foreground'
                      : 'flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-foreground hover:bg-muted/50'
                  }
                >
                  <span className="truncate">{item.title}</span>
                  <VisibilityBadge note={item} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function NoteBacklinks({
  noteId,
  slug,
  currentList,
}: {
  noteId: string;
  slug: string;
  currentList: NotesSearch['list'];
}) {
  const t = useTranslations('notes');
  const f = useFormat();
  const backlinks = useQuery(orpc.notes.backlinks.queryOptions({ input: { noteId } }));

  if (backlinks.error) return <ErrorText>{errorMessage(backlinks.error)}</ErrorText>;
  const items = backlinks.data ?? [];

  return (
    <section aria-label={t('backlinks.title')} data-testid="note-backlinks" className="space-y-2 rounded-lg border p-3 text-sm">
      <h3 className="text-xs font-semibold text-foreground">
        {t('backlinks.title')} {items.length > 0 ? `(${items.length})` : ''}
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-subtle-foreground">{t('backlinks.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
              <Link
                to="/o/$slug/notes"
                params={{ slug }}
                search={{ list: listOfNote(item, currentList), note: item.id }}
                data-testid="note-backlink-item"
                className="truncate font-medium text-link underline"
              >
                {item.title}
              </Link>
              <span className="flex items-center gap-1.5 text-xs text-subtle-foreground">
                <VisibilityBadge note={item} />
                {f.date(item.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

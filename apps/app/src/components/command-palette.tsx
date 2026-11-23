import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import { findSubmenuEntry, moveActive, PALETTE_GROUPS, resolvePaletteResults, type PaletteEntry } from '../lib/palette.ts';

export type { PaletteEntry };

// The command palette (issue #439, #4525): a modal <dialog> holding an editable combobox. The browser's modal dialog traps
// focus, closes on Esc and gives focus back to whatever had it; the input keeps focus while the arrow keys move the
// active option (aria-activedescendant) and Enter runs it (or enters an inline submenu). found holds what the org's
// search (#673) and the notes search (#1675) found for the query, reported through onQueryChange; search says whether
// they are running or one failed.
export function CommandPalette({
  entries,
  open,
  onOpenChange,
  found = [],
  search = 'idle',
  onQueryChange,
}: {
  entries: readonly PaletteEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  found?: readonly PaletteEntry[];
  search?: 'idle' | 'searching' | 'failed';
  onQueryChange?: (query: string) => void;
}) {
  const t = useTranslations('palette');
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [submenuId, setSubmenuId] = useState<string | null>(null);
  const activeSubmenu = useMemo(() => findSubmenuEntry(entries, submenuId), [entries, submenuId]);
  const results = useMemo(() => resolvePaletteResults(entries, query, found, activeSubmenu), [entries, query, found, activeSubmenu]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      setSubmenuId(null);
      setQuery('');
      setActive(0);
      el.showModal();
      input.current?.focus();
    } else if (!open) {
      setSubmenuId(null);
      if (el.open) el.close();
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
    onQueryChange?.(activeSubmenu ? '' : query);
  }, [query, activeSubmenu, onQueryChange]);
  // A refresh of the pending proposals can shorten the results under the same query: keep the active one in range.
  useEffect(() => setActive((current) => Math.min(current, Math.max(results.length - 1, 0))), [results]);

  const exitSubmenu = () => {
    setSubmenuId(null);
    setQuery('');
    setActive(0);
    input.current?.focus();
  };

  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    if (entry.children && entry.children.length > 0) {
      setSubmenuId(entry.id);
      setQuery('');
      setActive(0);
      input.current?.focus();
      return;
    }
    setSubmenuId(null);
    onOpenChange(false);
    entry.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter and the arrows pick a candidate while an input method is composing; leave them to it.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && activeSubmenu) {
      event.preventDefault();
      event.stopPropagation();
      exitSubmenu();
      return;
    }
    if (event.key === 'Backspace' && activeSubmenu && query === '') {
      event.preventDefault();
      exitSubmenu();
      return;
    }
    const next = moveActive(event.key, active, results.length);
    if (next !== null) {
      event.preventDefault();
      setActive(next);
      // Only keyboard moves scroll the list; a pointer hovering an option must not make it jump.
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(results[active]);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-label={t('label')}
      onCancel={(event) => {
        if (activeSubmenu) {
          event.preventDefault();
          exitSubmenu();
        }
      }}
      onClose={() => {
        setSubmenuId(null);
        onOpenChange(false);
      }}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(event) => event.target === dialog.current && onOpenChange(false)}
      className="m-auto mt-[12vh] w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground backdrop:bg-background/70"
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        {activeSubmenu && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={exitSubmenu}
            aria-label={t('back')}
            title={t('back')}
            data-testid="palette-back"
            className="shrink-0"
          >
            <span aria-hidden="true">←</span>
            <span>{activeSubmenu.label}</span>
          </Button>
        )}
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length > 0 ? `${listId}-${active}` : undefined}
          aria-label={activeSubmenu ? activeSubmenu.label : t('label')}
          placeholder={activeSubmenu ? activeSubmenu.label : t('placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle-foreground"
        />
      </div>
      <ul id={listId} role="listbox" aria-label={activeSubmenu ? activeSubmenu.label : t('label')} className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
        {results.length === 0 && (activeSubmenu || search === 'idle') && <li className="px-3 py-6 text-center text-sm text-subtle-foreground">{t('empty')}</li>}
        {PALETTE_GROUPS.map((group) => {
          const inGroup = results.filter((r) => r.group === group);
          if (inGroup.length === 0) return null;
          return (
            <li key={group} role="presentation">
              <div className="px-3 pt-2 pb-1 text-xs text-subtle-foreground" aria-hidden="true">
                {t(`groups.${group}`)}
              </div>
              <ul role="group" aria-label={t(`groups.${group}`)}>
                {inGroup.map((entry) => {
                  const index = results.indexOf(entry);
                  const selected = index === active;
                  const hasChildren = Boolean(entry.children && entry.children.length > 0);
                  return (
                    <li
                      key={entry.id}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => setActive(index)}
                      onClick={() => run(entry)}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${selected ? 'bg-primary/15 text-foreground' : 'text-muted-foreground'}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-foreground">{entry.label}</div>
                        {entry.detail && <div className="truncate text-xs text-subtle-foreground">{entry.detail}</div>}
                      </div>
                      {(entry.badge || hasChildren) && (
                        <div className="flex shrink-0 items-center gap-1.5">
                          {entry.badge && (
                            <Badge variant="secondary" className="max-w-44 font-normal">
                              <span className="truncate">{entry.badge}</span>
                            </Badge>
                          )}
                          {hasChildren && (
                            <span aria-hidden="true" className="text-xs text-subtle-foreground">
                              ›
                            </span>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      {!activeSubmenu && search !== 'idle' && (
        <p role="status" className="border-t px-4 py-2 text-xs text-subtle-foreground">
          {t(search === 'searching' ? 'searching' : 'searchFailed')}
        </p>
      )}
      <p className="border-t bg-muted/50 px-4 py-2 text-xs text-subtle-foreground">{t(activeSubmenu ? 'submenuHint' : 'hint')}</p>
    </dialog>
  );
}

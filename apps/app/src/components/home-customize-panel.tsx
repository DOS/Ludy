// SPDX-License-Identifier: AGPL-3.0-only
// Inline "Tùy chỉnh" editor for Global Home blocks (#4923 Phase 4, #4928):
// per-block Switch, pointer drag-and-drop plus WCAG 2.5.7 accessible Move Up / Move Down buttons,
// polite live-region announcements, Reset to role defaults, Cancel, and Save.
import { useState, type DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { HomeBlockId, HomeLayoutBlock } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Label } from '@ludy/ui/components/label';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { Switch } from '@ludy/ui/components/switch';
import { cn } from '@ludy/ui/lib/utils';
import { errorMessage } from '../lib/api.ts';
import { moveHomeBlock, reorderHomeBlockById, toggleHomeBlockVisibility } from '../lib/home-layout.ts';
import { ErrorText } from './ui.tsx';

export function HomeCustomizePanel({
  initialBlocks,
  isPending,
  error,
  onSave,
  onReset,
  onCancel,
}: {
  initialBlocks: readonly HomeLayoutBlock[];
  isPending: boolean;
  error: unknown;
  onSave: (blocks: HomeLayoutBlock[]) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('overview.customize');
  const tb = useTranslations('overview.blocks');
  const [draft, setDraft] = useState<HomeLayoutBlock[]>(() => initialBlocks.map((b) => ({ ...b })));
  const [announcement, setAnnouncement] = useState('');
  const [draggingId, setDraggingId] = useState<HomeBlockId | null>(null);
  const [dragOverId, setDragOverId] = useState<HomeBlockId | null>(null);

  const announceMove = (id: HomeBlockId, position: number, total: number) => {
    setAnnouncement(
      t('movedAnnouncement', {
        title: tb(`${id}.title`),
        position: String(position),
        total: String(total),
      }),
    );
  };

  const handleStep = (index: number, delta: -1 | 1) => {
    const moved = draft[index];
    if (!moved) return;
    const next = moveHomeBlock(draft, index, delta);
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= next.length) return;
    setDraft(next);
    announceMove(moved.id, nextIndex + 1, next.length);
  };

  const handleDragStart = (id: HomeBlockId, event: DragEvent<HTMLLIElement>) => {
    if (isPending) return;
    setDraggingId(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  };

  const handleDrop = (targetId: HomeBlockId, event: DragEvent<HTMLLIElement>) => {
    event.preventDefault();
    const sourceId = (draggingId ?? (event.dataTransfer.getData('text/plain') as HomeBlockId | '')) || null;
    setDraggingId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId || !draft.some((b) => b.id === sourceId)) return;
    const next = reorderHomeBlockById(draft, sourceId, targetId);
    const nextIndex = next.findIndex((b) => b.id === sourceId);
    setDraft(next);
    if (nextIndex >= 0) announceMove(sourceId, nextIndex + 1, next.length);
  };

  return (
    <section
      aria-labelledby="home-customize-heading"
      data-testid="home-customize-panel"
      className="mt-4 rounded-xl border bg-card p-4"
    >
      <div className="space-y-1">
        <h2 id="home-customize-heading" className="text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div aria-live="polite" className="sr-only" data-testid="home-customize-announcement">
        {announcement}
      </div>

      {draft.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="home-customize-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="mt-3 divide-y rounded-lg border" data-testid="home-customize-list">
          {draft.map((block, index) => {
            const title = tb(`${block.id}.title`);
            const description = tb(`${block.id}.description`);
            const switchId = `home-customize-switch-${block.id}`;
            const labelId = `home-customize-label-${block.id}`;
            const isDragTarget = dragOverId === block.id && draggingId !== block.id;
            return (
              <li
                key={block.id}
                draggable={!isPending}
                onDragStart={(event) => handleDragStart(block.id, event)}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (dragOverId !== block.id) setDragOverId(block.id);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null) && dragOverId === block.id) {
                    setDragOverId(null);
                  }
                }}
                onDrop={(event) => handleDrop(block.id, event)}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDragOverId(null);
                }}
                data-testid={`home-customize-row-${block.id}`}
                data-drag-over={isDragTarget ? 'true' : undefined}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 transition-colors',
                  draggingId === block.id && 'opacity-60',
                  isDragTarget && 'bg-primary/5',
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    title={t('dragHandle', { title })}
                    data-testid={`home-customize-drag-${block.id}`}
                    className="inline-flex shrink-0 cursor-grab items-center text-muted-foreground active:cursor-grabbing"
                  >
                    <ProjectIcon name="grip" className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Label htmlFor={switchId} id={labelId} className="block cursor-pointer text-sm font-medium text-foreground">
                      {title}
                    </Label>
                    <p className="text-xs text-subtle-foreground">{description}</p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                    disabled={index === 0 || isPending}
                    aria-label={t('moveUpOf', { title })}
                    title={t('moveUpOf', { title })}
                    data-testid={`home-customize-up-${block.id}`}
                    onClick={() => handleStep(index, -1)}
                  >
                    <ProjectIcon name="arrowUp" className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                    disabled={index === draft.length - 1 || isPending}
                    aria-label={t('moveDownOf', { title })}
                    title={t('moveDownOf', { title })}
                    data-testid={`home-customize-down-${block.id}`}
                    onClick={() => handleStep(index, 1)}
                  >
                    <ProjectIcon name="arrowDown" className="size-4" />
                  </Button>
                  <Switch
                    id={switchId}
                    checked={block.visible}
                    disabled={isPending}
                    aria-labelledby={labelId}
                    data-testid={`home-customize-switch-${block.id}`}
                    onCheckedChange={(checked) => {
                      setDraft((prev) => toggleHomeBlockVisibility(prev, block.id, checked));
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {Boolean(error) && (
        <div className="mt-3" data-testid="home-customize-error">
          <ErrorText>{errorMessage(error)}</ErrorText>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          data-testid="home-customize-reset"
          onClick={onReset}
        >
          {t('reset')}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            data-testid="home-customize-cancel"
            onClick={onCancel}
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            loading={isPending}
            disabled={draft.length === 0}
            data-testid="home-customize-save"
            onClick={() => onSave(draft)}
          >
            {t('save')}
          </Button>
        </div>
      </div>
    </section>
  );
}

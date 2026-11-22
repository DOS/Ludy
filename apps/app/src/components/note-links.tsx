// The records a note or to-do is linked to (issue #1672, #2595, notes plan §3.4), as the reader may open them now:
// the server checks each through its module in the reader's context, so a record of another legal entity, one the
// reader's role may not see, or one whose module is off shows as "Bản ghi không mở được", by its kind only. Each record
// the reader can open links to its page.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { NoteLink, NoteLinkTargetInput } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { errorMessage, orpc } from '../lib/api.ts';
import { meetingsInstalled } from './linked-meetings.tsx';
import { projectsInstalled } from '../lib/projects.ts';
import { taskTitleText } from '../lib/task-title.ts';
import { ErrorText } from './ui.tsx';

const KIND = {
  'kernel.party': 'party',
  'kernel.file': 'file',
  'finance.purchase_document': 'purchase_document',
  'finance.journal_entry': 'journal_entry',
  'crm.booking': 'booking',
  'kernel.task': 'task',
  'projects.project': 'project',
  'meetings.meeting': 'meeting',
} as const satisfies Record<NoteLink['targetType'], string>;

type LinkableType = 'kernel.task' | 'projects.project' | 'meetings.meeting';

function Open({ link, slug, children }: { link: NoteLink; slug: string; children: string }) {
  const className = 'text-link hover:underline';
  if (link.targetType === 'finance.purchase_document') {
    return (
      <Link to="/o/$slug/documents" params={{ slug }} className={className}>
        {children}
      </Link>
    );
  }
  if (link.targetType === 'finance.journal_entry') {
    return (
      <Link to="/o/$slug/journal" params={{ slug }} hash={`entry-${link.targetId}`} className={className}>
        {children}
      </Link>
    );
  }
  if (link.targetType === 'crm.booking') {
    return (
      <Link to="/o/$slug/bookings" params={{ slug }} className={className}>
        {children}
      </Link>
    );
  }
  if (link.targetType === 'kernel.task') {
    return (
      <Link to="/o/$slug/tasks/$id" params={{ slug, id: link.targetId }} className={className}>
        {children}
      </Link>
    );
  }
  if (link.targetType === 'projects.project') {
    return (
      <Link to="/o/$slug/projects/$id" params={{ slug, id: link.targetId }} className={className}>
        {children}
      </Link>
    );
  }
  if (link.targetType === 'meetings.meeting') {
    return (
      <Link to="/o/$slug/meetings/$id" params={{ slug, id: link.targetId }} className={className}>
        {children}
      </Link>
    );
  }
  return <span className="text-foreground">{children}</span>;
}

export function NoteLinks({
  links,
  slug,
  onRemove,
  removingId,
}: {
  links: NoteLink[];
  slug: string;
  onRemove?: ((linkId: string) => void) | undefined;
  removingId?: string | undefined;
}) {
  const t = useTranslations('notes.links');
  if (links.length === 0) return null;
  return (
    <section aria-labelledby="note-links" className="space-y-1">
      <h3 id="note-links" className="text-xs font-medium text-muted-foreground">
        {t('title')}
      </h3>
      <ul className="space-y-1 text-sm">
        {links.map((link) => (
          <li key={link.id} data-testid="note-link" className="flex flex-wrap items-center gap-2">
            {link.available ? (
              <Open link={link} slug={slug}>
                {t(`types.${KIND[link.targetType]}`)}
              </Open>
            ) : (
              <>
                <span className="text-muted-foreground">{t(`types.${KIND[link.targetType]}`)}</span>
                <span className="text-xs text-subtle-foreground">{t('unavailable')}</span>
              </>
            )}
            {onRemove && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={removingId === link.id}
                onClick={() => onRemove(link.id)}
                aria-label={t('removeOf', { kind: t(`types.${KIND[link.targetType]}`) })}
                data-testid="unlink-record"
              >
                {t('remove')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Inline picker to link an existing task or project from a note or personal to-do (#2595).
// Uses buttons instead of a nested <form> so it works safely inside TodoEditor's form.
export function RecordLinkAdder({
  existingLinks,
  onAdd,
  adding = false,
  error,
  onClearError,
  defaultOpen = false,
}: {
  existingLinks: NoteLink[];
  onAdd: (target: NoteLinkTargetInput) => Promise<unknown> | unknown;
  adding?: boolean;
  error?: unknown;
  onClearError?: (() => void) | undefined;
  defaultOpen?: boolean | undefined;
}) {
  const t = useTranslations('notes.links');
  const common = useTranslations('common');
  const id = useId();
  const hasProjects = projectsInstalled();
  const hasMeetings = meetingsInstalled();
  const [open, setOpen] = useState(defaultOpen);
  const [targetType, setTargetType] = useState<LinkableType>('kernel.task');
  const [targetId, setTargetId] = useState('');

  const tasks = useQuery({
    ...orpc.tasks.list.queryOptions({ input: {} }),
    enabled: open && targetType === 'kernel.task',
  });
  const projects = useQuery({
    ...orpc.projects.list.queryOptions({ input: {} }),
    enabled: open && hasProjects && targetType === 'projects.project',
  });
  const meetings = useQuery({
    ...orpc.meetings.list.queryOptions({ input: { limit: 100 } }),
    enabled: open && hasMeetings && targetType === 'meetings.meeting',
  });

  const alreadyLinked = new Set(existingLinks.filter((l) => l.targetType === targetType).map((l) => l.targetId));
  const options =
    targetType === 'kernel.task'
      ? (tasks.data ?? []).filter((item) => !alreadyLinked.has(item.id)).map((item) => ({ id: item.id, label: taskTitleText(item) }))
      : targetType === 'projects.project'
        ? (projects.data?.projects ?? [])
            .filter((item) => item.status !== 'archived' && !alreadyLinked.has(item.id))
            .map((item) => ({ id: item.id, label: item.name }))
        : (meetings.data ?? [])
            .filter((item) => !alreadyLinked.has(item.id))
            .map((item) => ({ id: item.id, label: item.title }));

  const loading =
    targetType === 'kernel.task'
      ? tasks.isPending
      : targetType === 'projects.project'
        ? projects.isPending
        : meetings.isPending;
  const loadError =
    targetType === 'kernel.task'
      ? tasks.error
      : targetType === 'projects.project'
        ? projects.error
        : meetings.error;

  if (!open) {
    return (
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onClearError?.();
            setOpen(true);
          }}
          data-testid="add-record-link"
        >
          {t('add')}
        </Button>
      </div>
    );
  }

  const handleAdd = async () => {
    if (!targetId || adding) return;
    try {
      await onAdd({ targetType, targetId });
      setTargetId('');
      setOpen(false);
    } catch {
      // Surfaced through the caller's error state; keep the picker open so the user can retry.
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="record-link-adder">
      <div className="grid gap-2 sm:grid-cols-2">
        <label htmlFor={`${id}-type`} className="block text-xs">
          <span className="text-subtle-foreground">{t('pickType')}</span>
          <NativeSelect
            id={`${id}-type`}
            className="mt-1 w-full"
            value={targetType}
            onChange={(e) => {
              setTargetType(e.target.value as LinkableType);
              setTargetId('');
              onClearError?.();
            }}
            data-testid="record-link-type"
          >
            <NativeSelectOption value="kernel.task">{t('types.task')}</NativeSelectOption>
            {hasProjects && <NativeSelectOption value="projects.project">{t('types.project')}</NativeSelectOption>}
            {hasMeetings && <NativeSelectOption value="meetings.meeting">{t('types.meeting')}</NativeSelectOption>}
          </NativeSelect>
        </label>
        <label htmlFor={`${id}-record`} className="block text-xs">
          <span className="text-subtle-foreground">{t('pickRecord')}</span>
          <NativeSelect
            id={`${id}-record`}
            className="mt-1 w-full"
            value={targetId}
            disabled={loading || options.length === 0}
            onChange={(e) => {
              setTargetId(e.target.value);
              onClearError?.();
            }}
            data-testid="record-link-target"
          >
            <NativeSelectOption value="">{t('pickPlaceholder')}</NativeSelectOption>
            {options.map((opt) => (
              <NativeSelectOption key={opt.id} value={opt.id}>
                {opt.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
      {!loading && !loadError && options.length === 0 && <p className="text-xs text-subtle-foreground">{t('noTargets')}</p>}
      {loadError && <ErrorText>{errorMessage(loadError)}</ErrorText>}
      {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" loading={adding} disabled={!targetId || adding} onClick={() => void handleAdd()} data-testid="record-link-save">
          {t('save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setTargetId('');
            setOpen(false);
            onClearError?.();
          }}
        >
          {common('cancel')}
        </Button>
      </div>
    </div>
  );
}

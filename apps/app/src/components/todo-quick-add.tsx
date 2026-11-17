// SPDX-License-Identifier: AGPL-3.0-only
// Reusable Quick Add input with live dismissible natural-language preview chips and
// global Alt+Q Quick Capture modal (#3556). Zero AI calls; parses 100% deterministically offline.
import { useMutation } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import { TODO_TITLE_MAX, type TodoCreateInput } from '@crove/kernel-contract';
import { parseTodoQuickAdd, type TodoQuickAddToken } from '@crove/l10n-vn';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { CalendarIcon } from '@crove/ui/components/calendar-icon';
import { ClockIcon } from '@crove/ui/components/clock-icon';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { ProjectIcon } from '@crove/ui/components/project-icon';
import { RepeatIcon } from '@crove/ui/components/repeat-icon';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import { buildTodoCreatePayload, formatQuickAddRecurrenceLabel, shiftDismissedTokens } from '../lib/quick-add.ts';
import { toast } from '../lib/toast.ts';
import { ErrorText } from './ui.tsx';

const refreshTodos = () => void queryClient.invalidateQueries({ queryKey: orpc.notes.todos.key() });

function localIsoDay(now: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addIsoDay(day: string, offset: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

function listTokenLabel(raw: string): string {
  const body = raw.slice(1);
  if (body.startsWith('"') && body.endsWith('"') && body.length >= 2) return body.slice(1, -1).trim();
  return body;
}

function priorityVariant(level: 1 | 2 | 3 | 4 | null): 'destructive' | 'warning' | 'brand' | 'secondary' {
  switch (level) {
    case 1:
      return 'destructive';
    case 2:
      return 'warning';
    case 3:
      return 'brand';
    default:
      return 'secondary';
  }
}

export interface TodoQuickAddBarProps {
  inputRef?: RefObject<HTMLInputElement | null> | undefined;
  ariaLabel?: string | undefined;
  placeholder?: string | undefined;
  autoFocus?: boolean | undefined;
  blurOnEscape?: boolean | undefined;
  showInlineSubmit?: boolean | undefined;
  showHint?: boolean | undefined;
  initialValue?: string | undefined;
  nowOverride?: Date | undefined;
  timeZoneOverride?: string | undefined;
  onCreated?: ((title: string, meta: { cleared: boolean }) => void) | undefined;
  renderFooter?: ((state: { isPending: boolean; canSubmit: boolean; formId: string }) => ReactNode) | undefined;
}

export function TodoQuickAddBar({
  inputRef,
  ariaLabel,
  placeholder,
  autoFocus = false,
  blurOnEscape = true,
  showInlineSubmit = true,
  showHint = true,
  initialValue = '',
  nowOverride,
  timeZoneOverride,
  onCreated,
  renderFooter,
}: TodoQuickAddBarProps) {
  const t = useTranslations('myWork');
  const f = useFormat();
  const formId = useId();
  const fallbackRef = useRef<HTMLInputElement>(null);
  const resolvedRef = inputRef ?? fallbackRef;

  const [value, setValue] = useState(initialValue);
  const valueRef = useRef(initialValue);
  valueRef.current = value;
  const [dismissed, setDismissed] = useState<TodoQuickAddToken[]>([]);
  const [emptyWarning, setEmptyWarning] = useState(false);
  const [anchorNow, setAnchorNow] = useState<Date>(() => nowOverride ?? new Date());

  const timeZone = timeZoneOverride ?? browserTimeZone();
  const currentNow = nowOverride ?? anchorNow;

  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => resolvedRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, resolvedRef]);

  const parsed = useMemo(
    () => parseTodoQuickAdd(value, { now: currentNow, timeZone, dismissedTokens: dismissed }),
    [value, currentNow, timeZone, dismissed],
  );

  const payloadPreview = useMemo(() => buildTodoCreatePayload(value, parsed, currentNow), [value, parsed, currentNow]);

  const create = useMutation({
    mutationFn: async (v: { payload: TodoCreateInput; sentValue: string }) => {
      const created = await client.notes.todos.create(v.payload);
      refreshTodos();
      return created;
    },
    // Only what was sent is cleared: text typed while the request is in flight stays.
    onSuccess: (_, sent) => {
      const willClear = valueRef.current.trim() === sent.sentValue;
      if (willClear) {
        valueRef.current = '';
        setValue('');
        setDismissed([]);
      }
      setEmptyWarning(false);
      onCreated?.(sent.payload.title, { cleared: willClear });
    },
  });

  const handleChange = (next: string) => {
    if (value === '' && next !== '' && !nowOverride) setAnchorNow(new Date());
    setDismissed((prev) => shiftDismissedTokens(value, next, prev));
    valueRef.current = next;
    setValue(next);
    setEmptyWarning(false);
    if (create.error) create.reset();
  };

  const handleDismiss = (token: TodoQuickAddToken) => {
    setDismissed((prev) => [...prev, token]);
    setValue((current) => {
      if (current.slice(token.start, token.end) === token.raw) return current;
      return current ? `${current} ${token.raw}` : token.raw;
    });
    setEmptyWarning(false);
    resolvedRef.current?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const submitNow = nowOverride ?? new Date();
    const freshParsed = parseTodoQuickAdd(value, { now: submitNow, timeZone, dismissedTokens: dismissed });
    const payload = buildTodoCreatePayload(value, freshParsed, submitNow);
    if (!payload) {
      if (value.trim() !== '') setEmptyWarning(true);
      return;
    }
    if (!create.isPending) create.mutate({ payload, sentValue: value.trim() });
  };

  const todayDay = useMemo(() => localIsoDay(currentNow, timeZone), [currentNow, timeZone]);
  const tomorrowDay = useMemo(() => addIsoDay(todayDay, 1), [todayDay]);

  const hasSeparateTimeChip = useMemo(
    () => parsed.tokens.some((tok) => tok.kind === 'time'),
    [parsed.tokens],
  );

  const dateChipText = (dueOn: string | null): string => {
    if (dueOn === null) return '';
    const formatted = f.date(dueOn);
    let label = formatted;
    if (dueOn === todayDay) label = t('quickAddDateToday', { date: formatted });
    else if (dueOn === tomorrowDay) label = t('quickAddDateTomorrow', { date: formatted });
    if (parsed.dueTime !== null && !hasSeparateTimeChip) {
      return `${label} · ${parsed.dueTime}`;
    }
    return label;
  };

  const chipForToken = (tok: TodoQuickAddToken): {
    label: string;
    variant: 'brand' | 'destructive' | 'warning' | 'secondary' | 'outline';
    icon?: ReactNode;
  } | null => {
    switch (tok.kind) {
      case 'date': {
        if (parsed.dueOn === null) return null;
        return {
          label: dateChipText(parsed.dueOn),
          variant: 'brand',
          icon: <CalendarIcon className="size-3 shrink-0" />,
        };
      }
      case 'time': {
        if (parsed.dueTime === null) return null;
        return {
          label: parsed.dueTime,
          variant: 'brand',
          icon: <ClockIcon className="size-3 shrink-0" />,
        };
      }
      case 'recurrence': {
        if (parsed.recurrence === null) return null;
        return {
          label: formatQuickAddRecurrenceLabel(parsed.recurrence, t),
          variant: 'secondary',
          icon: <RepeatIcon className="size-3 shrink-0" />,
        };
      }
      case 'priority': {
        const level = Number(tok.raw.slice(2)) as 1 | 2 | 3 | 4;
        return {
          label: t('quickAddPriority', { level: String(level) }),
          variant: priorityVariant(level),
        };
      }
      case 'tag': {
        const tag = tok.raw.slice(1).normalize('NFC').toLowerCase();
        return {
          label: t('quickAddTag', { tag }),
          variant: 'outline',
        };
      }
      case 'list': {
        return {
          label: t('quickAddList', { name: listTokenLabel(tok.raw) }),
          variant: 'secondary',
          icon: <ProjectIcon name="list" className="size-3 shrink-0" />,
        };
      }
    }
  };

  const chips = parsed.tokens
    .map((tok) => {
      const view = chipForToken(tok);
      return view ? { tok, ...view } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const labelText = ariaLabel ?? t('quickAdd');
  const placeholderText = placeholder ?? t('quickAdd');
  const canSubmit = payloadPreview !== null;

  return (
    <form id={formId} onSubmit={submit} className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          ref={resolvedRef}
          aria-label={labelText}
          placeholder={placeholderText}
          maxLength={TODO_TITLE_MAX}
          enterKeyHint="done"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            if (blurOnEscape && e.key === 'Escape') e.currentTarget.blur();
          }}
          className="min-w-0 flex-1"
          data-testid="todo-quick-add-input"
        />
        {showInlineSubmit && (
          <Button
            type="submit"
            variant="outline"
            loading={create.isPending}
            disabled={!value.trim() || create.isPending}
            aria-label={t('quickAddButtonAria')}
            data-testid="todo-quick-add-submit"
          >
            {t('quickAddButton')}
          </Button>
        )}
      </div>

      {chips.length > 0 && (
        <ul
          className="flex flex-wrap items-center gap-1.5"
          aria-label={t('quickAddChipsLabel')}
          data-testid="quick-add-chips"
        >
          {chips.map(({ tok, label, variant, icon }) => (
            <li key={`${tok.kind}:${tok.start}:${tok.end}`} className="max-w-full">
              <Badge
                variant={variant}
                className="max-w-full gap-1 pr-1"
                data-testid={`quick-add-chip-${tok.kind}`}
              >
                {icon}
                <span className="truncate">{label}</span>
                <button
                  type="button"
                  onClick={() => handleDismiss(tok)}
                  aria-label={t('quickAddDismiss', { label })}
                  data-testid={`quick-add-dismiss-${tok.kind}`}
                  className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
                >
                  <ProjectIcon name="remove" className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {chips.length > 0 && payloadPreview !== null && payloadPreview.title !== value.trim() && (
        <p className="truncate text-xs text-subtle-foreground" data-testid="quick-add-preview">
          {t('quickAddPreviewTitle', { title: payloadPreview.title })}
        </p>
      )}

      {chips.length === 0 && showHint && (
        <p className="text-xs text-subtle-foreground" data-testid="quick-add-hint">
          {t('quickAddHint')}
        </p>
      )}

      {emptyWarning && (
        <p role="alert" className="text-xs text-destructive" data-testid="quick-add-empty-warning">
          {t('quickAddNeedTitle')}
        </p>
      )}

      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}

      {renderFooter?.({ isPending: create.isPending, canSubmit, formId })}
    </form>
  );
}

/** Lightweight global Quick Capture modal triggered via Alt+Q (or the shell/palette button). */
export function QuickCaptureDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const onMyWork = pathname.toLowerCase().endsWith('/my-work');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={common('close')} className="sm:max-w-lg" data-testid="quick-capture-dialog">
        <DialogHeader>
          <DialogTitle>{t('quickCaptureTitle')}</DialogTitle>
          <DialogDescription>{t('quickCaptureDescription')}</DialogDescription>
        </DialogHeader>
        {open && (
          <TodoQuickAddBar
            autoFocus
            blurOnEscape={false}
            showInlineSubmit={false}
            showHint
            onCreated={(createdTitle, meta) => {
              if (meta.cleared) onOpenChange(false);
              if (onMyWork) {
                toast(t('quickCaptureCreated', { title: createdTitle }), 'success');
              } else {
                toast(t('quickCaptureCreated', { title: createdTitle }), 'success', {
                  action: {
                    label: t('quickCaptureOpen'),
                    run: () => void navigate({ to: '/o/$slug/my-work', params: { slug } }),
                  },
                });
              }
            }}
            renderFooter={({ isPending, canSubmit }) => (
              <DialogFooter className="pt-2">
                <DialogClose render={<Button type="button" variant="outline" />}>{common('cancel')}</DialogClose>
                <Button type="submit" loading={isPending} disabled={!canSubmit || isPending} data-testid="quick-capture-save">
                  {t('quickCaptureSave')}
                </Button>
              </DialogFooter>
            )}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// "Create task" in the Inbox's contact panel (CV3, #3295, plan docs/plan/conversations.md section 4 point 2): follow-up work is an ordinary task of the org's task
// list that links back to the thread, and the thread lists its open tasks here. The conversation keeps its own status; a person types the title (a task is read
// by every member, so the customer's words are not copied in) and picks the seat and the day. Nothing here needs an AI coworker; a task an AI coworker asked for and a person approved (#4148)
// is listed too, marked as AI-written like on the task board.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { DateInput } from './date-input.tsx';
import { SendToTriageDialog } from './send-to-triage-dialog.tsx';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { taskDueFromDay } from '../lib/agents.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import { TOUCH_BUTTON } from '../lib/conversation-touch.ts';
import { taskTitleText } from '../lib/task-title.ts';

// The panel's own poll (the Inbox reads its other panes every six seconds): the stream sends no hint for tasks, so another member's task shows up on the next turn.
const TASKS_POLL_MS = 6_000;

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
};

function NewTask({ conversationId, channelName, onDone, paused = false }: { conversationId: string; channelName: string; onDone: () => void; paused?: boolean }) {
  const t = useTranslations('conversations.contact.tasks');
  const tt = useTranslations('tasks');
  const chart = useQuery({
    ...orpc.chart.get.queryOptions(),
    enabled: !paused,
    refetchOnWindowFocus: !paused,
    refetchOnReconnect: !paused,
  });
  // A fixed default (the org's own channel name, never a word of the customer's), so two clicks make a task; a person can change it.
  const [title, setTitle] = useState(() => t('defaultTitle', { channel: channelName }));
  const [assignee, setAssignee] = useState('');
  const [dueOn, setDueOn] = useState('');
  // One key per version of the form, so a second click on a slow connection makes one task, not two, and an edit after a failure is a new request.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const edited = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setKey(crypto.randomUUID());
  };
  const create = useMutation({
    ...orpc.conversations.followUp.mutationOptions(),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const positions = (chart.data?.positions ?? []).filter((p) => p.status !== 'archived');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() === '') return;
    const due = taskDueFromDay(dueOn, browserTimeZone());
    create.mutate({ conversationId, title: title.trim(), assigneePositionId: assignee || null, ...(due ? { due } : {}), idempotencyKey: key });
  };
  return (
    <form onSubmit={submit} className="space-y-2" data-testid="conversation-task-form">
      <label className="block text-xs font-medium text-muted-foreground" htmlFor={`task-title-${conversationId}`}>
        {t('titleLabel')}
      </label>
      <Input id={`task-title-${conversationId}`} required maxLength={300} value={title} onChange={(e) => edited(setTitle)(e.target.value)} />
      <p className="text-xs text-muted-foreground">{t('titleHint')}</p>
      <label className="block text-xs font-medium text-muted-foreground">
        {tt('assignTo')}
        <NativeSelect className="mt-1 w-full" value={assignee} onChange={(e) => edited(setAssignee)(e.target.value)}>
          <NativeSelectOption value="">{tt('rootAssignee')}</NativeSelectOption>
          {positions.map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.title}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label className="block text-xs font-medium text-muted-foreground">
        {tt('dueLabel')}
        <DateInput value={dueOn} onChange={edited(setDueOn)} className="mt-1" aria-label={tt('dueLabel')} />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" className={TOUCH_BUTTON} loading={create.isPending} disabled={title.trim() === ''}>
          {t('save')}
        </Button>
        <Button type="button" size="sm" className={TOUCH_BUTTON} variant="ghost" onClick={onDone}>
          {t('cancel')}
        </Button>
      </div>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </form>
  );
}

export function ConversationTasks({ conversationId, channelName, canWrite, paused = false }: { conversationId: string; channelName: string; canWrite: boolean; paused?: boolean }) {
  const t = useTranslations('conversations.contact.tasks');
  const tt = useTranslations('tasks');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    ...orpc.conversations.tasks.queryOptions({ input: { conversationId } }),
    enabled: !paused,
    refetchInterval: paused ? false : TASKS_POLL_MS,
    refetchOnWindowFocus: !paused,
    refetchOnReconnect: !paused,
  });
  const tasks = list.data?.tasks ?? [];
  return (
    <div className="space-y-1" data-testid="conversation-tasks">
      <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
      {list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
              <span className="min-w-0">
                <Link to="/o/$slug/tasks/$id" params={{ slug, id: task.id }} className="block truncate text-link hover:underline">
                  {taskTitleText(task)}
                </Link>
                {task.tainted && (
                  <Badge variant="warning" title={tt('taintedHint')}>
                    {tt('tainted')}
                  </Badge>
                )}
                {task.due && <span className="text-xs text-muted-foreground">{t('due', { date: f.date(task.due) })}</span>}
              </span>
              <Badge variant="outline">{tt(`status.${task.status}`)}</Badge>
            </li>
          ))}
        </ul>
      )}
      {canWrite &&
        (adding ? (
          <NewTask conversationId={conversationId} channelName={channelName} onDone={() => setAdding(false)} paused={paused} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className={TOUCH_BUTTON} variant="outline" onClick={() => setAdding(true)}>
              {t('add')}
            </Button>
            {!paused && (
              <SendToTriageDialog
                slug={slug}
                sourceType="kernel.conversation"
                sourceId={conversationId}
                defaultTitle={channelName}
                canWrite={canWrite}
                buttonTestId="conversation-send-to-triage-btn"
              />
            )}
          </div>
        ))}
    </div>
  );
}

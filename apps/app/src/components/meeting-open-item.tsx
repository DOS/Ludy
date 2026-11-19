// SPDX-License-Identifier: AGPL-3.0-only
// The two small pieces of a numbered list of meeting facts, shared by the brief before a meeting (#3543) and, later, other lists of the same facts: the number a sentence of Vy cites, and the line of an
// open action item (its title, who it is with, whether it is accepted as a task and its status, and the day it is due). A person is named by the org's own names, never by an id.
import { useTranslations } from 'use-intl';
import { briefItemDue, type SeriesOpenItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { memberLabel } from './meeting-results.tsx';
import { useMe } from './conversation-inbox.tsx';

export const FactNumber = ({ n }: { n: number }) => (
  <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted px-1 text-xs text-muted-foreground" aria-label={String(n)}>
    {n}
  </span>
);

export function OpenItemLine({ n, item, testId }: { n: number; item: SeriesOpenItem; testId: string }) {
  const series = useTranslations('meetings.series');
  const { members } = useMe();
  const who = item.whoUserId ? memberLabel(members, item.whoUserId, item.who) : (item.assigneeSeat ?? item.who);
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid={testId} data-assigned={item.assigned}>
      <FactNumber n={n} />
      <span className="font-medium">{item.title}</span>
      {who !== '' && <span className="text-muted-foreground">{who}</span>}
      {item.assigned ? item.taskStatus && <Badge variant="outline">{series(`status.${item.taskStatus}`)}</Badge> : <Badge variant="secondary">{series('unassigned')}</Badge>}
      {briefItemDue(item) !== null && <span className="text-xs text-muted-foreground">{series('due', { date: briefItemDue(item) as string })}</span>}
    </li>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// The meetings linked to a contact or a deal (L1, #2587): the title, the day and who may see it. The server returns only the meetings the viewer may read
// (an attendees-only meeting is not a row for anyone else, and its title never reaches this screen), so an empty list may also mean "none you can read".
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { MeetingLinkKind } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { ErrorText } from './ui.tsx';

export const meetingsInstalled = (): boolean => getConfig().modules.includes('meetings');

export function LinkedMeetings({ kind, targetId }: { kind: Exclude<MeetingLinkKind, 'calendar_event'>; targetId: string }) {
  const t = useTranslations('meetings');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const meetings = useQuery(orpc.meetings.links.byTarget.queryOptions({ input: { kind, targetId } }));
  return (
    <div data-testid="linked-meetings">
      <p className="mb-2 text-sm font-medium text-muted-foreground">{t('links.forTarget')}</p>
      {meetings.isLoading ? null : meetings.error ? (
        <ErrorText>{errorMessage(meetings.error)}</ErrorText>
      ) : (meetings.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-subtle-foreground">{t('links.forTargetEmpty')}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {meetings.data?.map((m) => (
            <li key={m.linkId} className="flex flex-wrap items-baseline gap-x-3" data-testid="linked-meeting">
              <Link to="/o/$slug/meetings/$id" params={{ slug, id: m.meetingId }} className="font-medium text-link underline-offset-4 hover:underline">
                {m.title}
              </Link>
              {m.startedAt && <span className="text-xs text-muted-foreground">{f.date(m.startedAt)}</span>}
              <Badge variant="outline">{m.visibility === 'org' ? t('badgeOrg') : t('badgeAttendees')}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

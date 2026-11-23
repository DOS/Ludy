// SPDX-License-Identifier: AGPL-3.0-only
import type { MeetingPlatform, MeetingStatus, MeetingSummary, MeetingVisibility } from '@ludy/kernel-contract';
import { foldWord } from './search-fold.ts';

export type MeetingMediaFilter = 'all' | 'audio' | 'video' | 'transcript';
export type MeetingSort = 'started_desc' | 'started_asc' | 'title_asc' | 'duration_desc';

export interface MeetingListFilter {
  search: string;
  status: MeetingStatus | 'all';
  visibility: MeetingVisibility | 'all';
  media: MeetingMediaFilter;
  platform: MeetingPlatform | 'all';
}

export const EMPTY_MEETING_FILTER: MeetingListFilter = {
  search: '',
  status: 'all',
  visibility: 'all',
  media: 'all',
  platform: 'all',
};

/** Counts non-search filter selections active in the Filter popover. */
export function countActiveMeetingFilters(filter: MeetingListFilter): number {
  let count = 0;
  if (filter.status !== 'all') count += 1;
  if (filter.visibility !== 'all') count += 1;
  if (filter.media !== 'all') count += 1;
  if (filter.platform !== 'all') count += 1;
  return count;
}

/** True when any filter dropdown or title search term is active. */
export function hasActiveMeetingFilter(filter: MeetingListFilter): boolean {
  return filter.search.trim() !== '' || countActiveMeetingFilters(filter) > 0;
}

function matchesMedia(meeting: MeetingSummary, media: MeetingMediaFilter): boolean {
  if (media === 'all') return true;
  if (media === 'audio') return meeting.hasAudio;
  if (media === 'video') return meeting.hasVideo;
  return meeting.hasTranscript;
}

function meetingTimeMs(meeting: MeetingSummary): number {
  const ms = Date.parse(meeting.startedAt ?? meeting.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** Filters meetings client-side by title, status, visibility, media, and platform, then applies the chosen sort. */
export function filterAndSortMeetings(
  meetings: readonly MeetingSummary[],
  filter: MeetingListFilter,
  sort: MeetingSort,
): MeetingSummary[] {
  const rawQuery = filter.search.trim().toLocaleLowerCase();
  const foldedQuery = foldWord(filter.search.trim());
  const filtered = meetings.filter((m) => {
    if (rawQuery !== '') {
      const titleLower = m.title.toLocaleLowerCase();
      const matchesTitle = titleLower.includes(rawQuery) || (foldedQuery !== '' && foldWord(m.title).includes(foldedQuery));
      if (!matchesTitle) return false;
    }
    if (filter.status !== 'all' && m.status !== filter.status) return false;
    if (filter.visibility !== 'all' && m.visibility !== filter.visibility) return false;
    if (!matchesMedia(m, filter.media)) return false;
    if (filter.platform !== 'all' && m.platform !== filter.platform) return false;
    return true;
  });

  return [...filtered].sort((a, b) => {
    if (sort === 'started_asc') {
      return meetingTimeMs(a) - meetingTimeMs(b) || a.id.localeCompare(b.id);
    }
    if (sort === 'title_asc') {
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || meetingTimeMs(b) - meetingTimeMs(a) || a.id.localeCompare(b.id);
    }
    if (sort === 'duration_desc') {
      return (b.lengthSeconds ?? -1) - (a.lengthSeconds ?? -1) || meetingTimeMs(b) - meetingTimeMs(a) || a.id.localeCompare(b.id);
    }
    return meetingTimeMs(b) - meetingTimeMs(a) || a.id.localeCompare(b.id);
  });
}

export interface MeetingDurationLabels {
  hours: (hours: number) => string;
  hoursMinutes: (hours: number, minutes: number) => string;
  minutes: (minutes: number) => string;
  seconds: (seconds: number) => string;
  empty?: string;
}

/** Formats a meeting duration in seconds using caller-provided localized templates. */
export function formatMeetingDuration(seconds: number | null, labels: MeetingDurationLabels): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return labels.empty ?? '-';
  const rounded = Math.round(seconds);
  if (rounded < 60) return labels.seconds(rounded);
  const totalMinutes = Math.floor(rounded / 60);
  if (totalMinutes < 60) return labels.minutes(totalMinutes);
  const hours = Math.floor(totalMinutes / 60);
  const restMinutes = totalMinutes % 60;
  return restMinutes === 0 ? labels.hours(hours) : labels.hoursMinutes(hours, restMinutes);
}

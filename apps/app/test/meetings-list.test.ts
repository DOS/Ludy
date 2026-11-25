// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { MeetingListItem, MeetingSummary } from '@ludy/kernel-contract';
import {
  EMPTY_MEETING_FILTER,
  countActiveMeetingFilters,
  filterAndSortMeetings,
  formatMeetingDuration,
  hasActiveMeetingFilter,
  hasLabel,
  labelChoicesOf,
  labelsByMeetingOf,
} from '../src/lib/meetings-list.ts';

function meeting(over: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Weekly sync',
    language: 'vi',
    visibility: 'attendees',
    status: 'ready',
    recorderUserId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-11-20T02:00:00.000Z',
    endedAt: '2026-11-20T02:30:00.000Z',
    lengthSeconds: 1800,
    keepVideo: false,
    liveNotes: false,
    summaryTemplate: 'general',
    place: null,
    audioRetentionDate: '2026-12-20',
    textRetentionDate: null,
    hasAudio: true,
    hasVideo: false,
    hasTranscript: false,
    platform: null,
    readersCount: 2,
    createdAt: '2026-11-20T02:00:00.000Z',
    updatedAt: '2026-11-20T02:30:00.000Z',
    ...over,
  };
}

describe('meetings-list helpers (#4477)', () => {
  const sample: MeetingSummary[] = [
    meeting({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Họp báo giá khách A',
      status: 'completed',
      visibility: 'org',
      startedAt: '2026-11-20T02:00:00.000Z',
      lengthSeconds: 1800,
      hasAudio: true,
      hasVideo: false,
      hasTranscript: true,
      platform: 'meet',
    }),
    meeting({
      id: '00000000-0000-4000-8000-000000000002',
      title: 'Alpha design review',
      status: 'processing',
      visibility: 'attendees',
      startedAt: '2026-11-22T09:00:00.000Z',
      lengthSeconds: 5400,
      hasAudio: true,
      hasVideo: true,
      hasTranscript: false,
      platform: 'zoom',
    }),
    meeting({
      id: '00000000-0000-4000-8000-000000000003',
      title: 'Chốt hợp đồng đại lý',
      status: 'error',
      visibility: 'attendees',
      startedAt: null,
      createdAt: '2026-11-21T05:00:00.000Z',
      lengthSeconds: null,
      hasAudio: false,
      hasVideo: false,
      hasTranscript: false,
      platform: 'teams',
    }),
  ];

  it('filters by search (accented and unaccented), status, visibility, media, and platform', () => {
    expect(filterAndSortMeetings(sample, { ...EMPTY_MEETING_FILTER, search: '  bao gia  ' }, 'started_desc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(filterAndSortMeetings(sample, { ...EMPTY_MEETING_FILTER, status: 'processing' }, 'started_desc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(filterAndSortMeetings(sample, { ...EMPTY_MEETING_FILTER, visibility: 'org' }, 'started_desc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(filterAndSortMeetings(sample, { ...EMPTY_MEETING_FILTER, media: 'audio' }, 'started_desc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(filterAndSortMeetings(sample, { ...EMPTY_MEETING_FILTER, media: 'video' }, 'started_desc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(filterAndSortMeetings(sample, { ...EMPTY_MEETING_FILTER, media: 'transcript' }, 'started_desc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(filterAndSortMeetings(sample, { ...EMPTY_MEETING_FILTER, platform: 'teams' }, 'started_desc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000003',
    ]);
  });

  it('filters by a label of the meeting, whatever the case, and keeps every meeting with no label chosen (#4955)', () => {
    const labels = new Map<string, readonly string[]>([
      ['00000000-0000-4000-8000-000000000001', ['Khách Hoa Sen', 'Họp tuần']],
      ['00000000-0000-4000-8000-000000000003', ['khách hoa sen']],
    ]);
    const ids = (label: string) => filterAndSortMeetings(sample, { ...EMPTY_MEETING_FILTER, label }, 'started_desc', labels).map((m) => m.id);
    expect(ids('KHÁCH HOA SEN').sort()).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003']);
    expect(ids('Họp tuần')).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(ids('Không có')).toEqual([]);
    expect(ids('')).toHaveLength(sample.length);
    // With no labels read yet, a chosen label shows nothing rather than every meeting.
    expect(filterAndSortMeetings(sample, { ...EMPTY_MEETING_FILTER, label: 'Họp tuần' }, 'started_desc')).toEqual([]);
    expect(hasLabel(labels, '00000000-0000-4000-8000-000000000003', 'Khách Hoa Sen')).toBe(true);
    expect(hasLabel(labels, '00000000-0000-4000-8000-000000000002', 'Khách Hoa Sen')).toBe(false);
  });

  it('takes the labels and the label choices from the rows of the list, the same label whatever the case being one choice, the most used first (#4966)', () => {
    const rows: MeetingListItem[] = [
      { ...meeting({ id: '00000000-0000-4000-8000-000000000001' }), labels: ['Khách Hoa Sen', 'Họp tuần'] },
      { ...meeting({ id: '00000000-0000-4000-8000-000000000002' }), labels: ['khách hoa sen'] },
      { ...meeting({ id: '00000000-0000-4000-8000-000000000003' }), labels: [] },
    ];
    expect(labelsByMeetingOf(rows).get('00000000-0000-4000-8000-000000000002')).toEqual(['khách hoa sen']);
    expect(labelsByMeetingOf(rows).get('00000000-0000-4000-8000-000000000003')).toEqual([]);
    expect(labelChoicesOf(rows)).toEqual([
      { label: 'Khách Hoa Sen', count: 2 },
      { label: 'Họp tuần', count: 1 },
    ]);
    expect(labelChoicesOf([])).toEqual([]);
    // The filter keeps the rows that carry the chosen label, and the rows keep their labels.
    const kept = filterAndSortMeetings(rows, { ...EMPTY_MEETING_FILTER, label: 'KHÁCH HOA SEN' }, 'started_desc', labelsByMeetingOf(rows));
    expect(kept.map((m) => m.id).sort()).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
    expect(kept.every((m) => Array.isArray(m.labels))).toBe(true);
  });

  it('sorts across all 4 modes without mutating input', () => {
    const before = sample.map((m) => m.id);
    expect(filterAndSortMeetings(sample, EMPTY_MEETING_FILTER, 'started_desc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(filterAndSortMeetings(sample, EMPTY_MEETING_FILTER, 'started_asc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(filterAndSortMeetings(sample, EMPTY_MEETING_FILTER, 'title_asc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(filterAndSortMeetings(sample, EMPTY_MEETING_FILTER, 'duration_desc').map((m) => m.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000003',
    ]);
    expect(sample.map((m) => m.id)).toEqual(before);
  });

  it('counts popover filters separately from search', () => {
    expect(countActiveMeetingFilters(EMPTY_MEETING_FILTER)).toBe(0);
    expect(hasActiveMeetingFilter(EMPTY_MEETING_FILTER)).toBe(false);
    expect(countActiveMeetingFilters({ ...EMPTY_MEETING_FILTER, search: 'hop' })).toBe(0);
    expect(hasActiveMeetingFilter({ ...EMPTY_MEETING_FILTER, search: 'hop' })).toBe(true);
    expect(
      countActiveMeetingFilters({
        search: 'hop',
        status: 'ready',
        visibility: 'org',
        media: 'transcript',
        platform: 'meet',
        label: '',
      }),
    ).toBe(4);
    expect(countActiveMeetingFilters({ ...EMPTY_MEETING_FILTER, label: 'Khách Hoa Sen' })).toBe(1);
  });

  it('formats meeting duration across seconds, minutes, hours, and empty values', () => {
    const labels = {
      hours: (h: number) => `${h} h`,
      hoursMinutes: (h: number, m: number) => `${h} h ${m} min`,
      minutes: (m: number) => `${m} min`,
      seconds: (s: number) => `${s} sec`,
      empty: '-',
    };
    expect(formatMeetingDuration(null, labels)).toBe('-');
    expect(formatMeetingDuration(-5, labels)).toBe('-');
    expect(formatMeetingDuration(0, labels)).toBe('0 sec');
    expect(formatMeetingDuration(45, labels)).toBe('45 sec');
    expect(formatMeetingDuration(90, labels)).toBe('1 min');
    expect(formatMeetingDuration(3600, labels)).toBe('1 h');
    expect(formatMeetingDuration(5400, labels)).toBe('1 h 30 min');
  });
});

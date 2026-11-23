// The kernel's and finance's in-app notifications in the app (#671): the kinds the settings list, what an item opens
// and how a VAT period reads.
import { describe, expect, it } from 'vitest';
import { GROUPABLE_KINDS, groupNotifications, groupSubjectCount, isKnownKind, kindKey, notificationKinds, notificationTarget, periodParts, unreadIdChunks } from '../src/lib/notifications.ts';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';

describe('notificationKinds', () => {
  it("lists the kernel's kinds, and finance's where finance runs", () => {
    expect(notificationKinds(['finance'])).toEqual(['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_assigned', 'kernel.task_rerouted', 'kernel.original_flagged', 'kernel.ai_budget', 'kernel.conversation_new', 'finance.bank_attention', 'finance.portal_attention', 'finance.period_closing']);
    expect(notificationKinds(['social'])).toEqual(['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_assigned', 'kernel.task_rerouted', 'kernel.original_flagged', 'kernel.ai_budget', 'kernel.conversation_new']);
    expect(notificationKinds(['notes'])).toEqual(['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_assigned', 'kernel.task_rerouted', 'kernel.original_flagged', 'kernel.ai_budget', 'kernel.conversation_new', 'notes.todo_due']);
    expect(notificationKinds(['projects'])).toEqual(['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_assigned', 'kernel.task_rerouted', 'kernel.original_flagged', 'kernel.ai_budget', 'kernel.conversation_new', 'projects.weekly_status']);
    // The series nudge is a kind of the Meetings module (#3542).
    expect(notificationKinds(['meetings']).slice(-3)).toEqual(['meetings.series_open_items', 'meetings.summary_ready', 'meetings.morning']);
    expect(notificationKinds(['finance'])).not.toContain('meetings.series_open_items');
    // An ad account's paused connection is a kind of the Ads module (#2219).
    expect(notificationKinds(['ads'])).toEqual(['kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_assigned', 'kernel.task_rerouted', 'kernel.original_flagged', 'kernel.ai_budget', 'kernel.conversation_new', 'kernel.channel_expired']);
  });

  it('has a label for every kind in both languages', () => {
    for (const kind of notificationKinds(['finance', 'notes', 'ads', 'projects', 'meetings'])) {
      expect(vi.notifications.kinds[kindKey(kind)], kind).toBeTruthy();
      expect(en.notifications.kinds[kindKey(kind)], kind).toBeTruthy();
    }
    expect(isKnownKind('finance.period_closing')).toBe(true);
    expect(isKnownKind('social.comment')).toBe(false);
    // The Engage reads notice (#4069) is shown but never listed among the kinds a member turns off: it is about their own consent.
    expect(isKnownKind('kernel.mcp_engage_reads')).toBe(true);
    expect(notificationKinds(['finance', 'notes', 'ads', 'projects', 'meetings'])).not.toContain('kernel.mcp_engage_reads');
  });
});

describe('notificationTarget', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  it('opens the AI connections screen from the Engage reads notice (#4069)', () => {
    expect(notificationTarget({ kind: 'kernel.mcp_engage_reads', subjectId: null, detail: { grants: 'company' } })).toEqual({ to: 'aiConnections' });
  });
  it('opens what the notification is about', () => {
    expect(notificationTarget({ kind: 'kernel.approval_waiting', subjectId: id, detail: {} })).toEqual({ to: 'proposal', id });
    expect(notificationTarget({ kind: 'kernel.file_unreadable', subjectId: id, detail: {} })).toEqual({ to: 'inbox' });
    expect(notificationTarget({ kind: 'kernel.task_assigned', subjectId: id, detail: { title: 'Việc' } })).toEqual({ to: 'task', id });
    expect(notificationTarget({ kind: 'kernel.task_assigned', subjectId: null, detail: {} })).toEqual({ to: 'tasks' });
    expect(notificationTarget({ kind: 'kernel.task_rerouted', subjectId: id, detail: { title: 'Việc' } })).toEqual({ to: 'task', id });
    expect(notificationTarget({ kind: 'kernel.task_rerouted', subjectId: null, detail: {} })).toEqual({ to: 'tasks' });
    // An original e-invoice that differs from its posting or is not verified opens the posted proposal (#2335).
    // The series nudge opens the previous meeting, and nothing without one (#3542).
    expect(notificationTarget({ kind: 'meetings.series_open_items', subjectId: id, detail: { count: '2' } })).toEqual({ to: 'meeting', id });
    expect(notificationTarget({ kind: 'meetings.series_open_items', subjectId: null, detail: {} })).toBeNull();
    // The "minutes draft ready" notice opens its meeting, and nothing without one (#3730).
    expect(notificationTarget({ kind: 'meetings.summary_ready', subjectId: id, detail: {} })).toEqual({ to: 'meeting', id });
    expect(notificationTarget({ kind: 'meetings.summary_ready', subjectId: null, detail: {} })).toBeNull();
    expect(notificationTarget({ kind: 'kernel.original_flagged', subjectId: id, detail: { differs: 'true', signature: 'none' } })).toEqual({ to: 'proposal', id });
    expect(notificationTarget({ kind: 'finance.bank_attention', subjectId: id, detail: { bankAccount: '1121' } })).toEqual({ to: 'bank', account: '1121' });
    expect(notificationTarget({ kind: 'finance.portal_attention', subjectId: id, detail: {} })).toEqual({ to: 'portal' });
    expect(notificationTarget({ kind: 'finance.portal_attention', subjectId: id, detail: { direction: 'sale' } })).toEqual({ to: 'portal', sale: true });
    expect(notificationTarget({ kind: 'finance.period_closing', subjectId: null, detail: {} })).toEqual({ to: 'ledger' });
    expect(notificationTarget({ kind: 'notes.todo_due', subjectId: id, detail: {} })).toEqual({ to: 'myWork' });
    expect(notificationTarget({ kind: 'projects.weekly_status', subjectId: id, detail: {} })).toEqual({ to: 'project', id });
    expect(notificationTarget({ kind: 'projects.weekly_status', subjectId: null, detail: {} })).toEqual({ to: 'projects' });
    expect(notificationTarget({ kind: 'kernel.channel_expired', subjectId: id, detail: { provider: 'meta_ads' } })).toEqual({ to: 'ads' });
    expect(notificationTarget({ kind: 'later.kind', subjectId: null, detail: {} })).toBeNull();
  });
});

describe('periodParts', () => {
  it('reads months and quarters', () => {
    expect(periodParts('2026-09')).toEqual({ kind: 'month', label: '09/2026' });
    expect(periodParts('2026-Q3')).toEqual({ kind: 'quarter', label: '3/2026' });
    expect(periodParts('2026-13')).toBeNull();
  });
});

// A run of the same kind is one row (NT-2, #3592); the rest keep a row per event.
describe('groupNotifications', () => {
  const n = (id: string, kind: string, read = false) => ({ id, kind, read });
  it('groups a run of two or more unread of a groupable kind, in the order of the list', () => {
    const rows = groupNotifications([n('1', 'kernel.approval_waiting'), n('2', 'kernel.approval_waiting'), n('3', 'kernel.approval_waiting'), n('4', 'finance.bank_attention'), n('5', 'kernel.file_unreadable')]);
    expect(rows.map((r) => r.type)).toEqual(['group', 'one', 'one']);
    const [first] = rows;
    expect(first?.type === 'group' && { kind: first.kind, ids: first.items.map((i) => i.id) }).toEqual({ kind: 'kernel.approval_waiting', ids: ['1', '2', '3'] });
  });

  it('never counts a read one: the server marks a decided proposal read, so it no longer waits', () => {
    // 3 pending then 4 decided: the group says 3, and the 4 stay rows of their own.
    const rows = groupNotifications([n('1', 'kernel.approval_waiting'), n('2', 'kernel.approval_waiting'), n('3', 'kernel.approval_waiting'), ...['4', '5', '6', '7'].map((id) => n(id, 'kernel.approval_waiting', true))]);
    expect(rows.map((r) => r.type)).toEqual(['group', 'one', 'one', 'one', 'one']);
    expect(rows[0]?.type === 'group' && rows[0].items.length).toBe(3);
    expect(groupNotifications([n('1', 'kernel.approval_waiting', true), n('2', 'kernel.approval_waiting', true)]).map((r) => r.type)).toEqual(['one', 'one']);
    // One unread between read ones is a row of its own, not a group of one.
    expect(groupNotifications([n('1', 'kernel.task_assigned', true), n('2', 'kernel.task_assigned'), n('3', 'kernel.task_assigned', true)]).map((r) => r.type)).toEqual(['one', 'one', 'one']);
  });

  it('keeps a row per event for a single notice and for kinds that name different things', () => {
    expect(groupNotifications([n('1', 'kernel.approval_waiting')]).map((r) => r.type)).toEqual(['one']);
    expect(groupNotifications([n('1', 'finance.bank_attention'), n('2', 'finance.bank_attention'), n('3', 'finance.period_closing')]).map((r) => r.type)).toEqual(['one', 'one', 'one']);
    expect(groupNotifications([])).toEqual([]);
  });

  it('does not join runs a different event separates', () => {
    const rows = groupNotifications([n('1', 'kernel.task_assigned'), n('2', 'kernel.task_assigned'), n('3', 'finance.bank_attention'), n('4', 'kernel.task_assigned'), n('5', 'kernel.task_assigned')]);
    expect(rows.map((r) => r.type)).toEqual(['group', 'one', 'group']);
  });

  it('opens the screen that lists every one of the kind, which exists for each groupable kind', () => {
    const targets = GROUPABLE_KINDS.map((kind) => notificationTarget({ kind, subjectId: null, detail: {} })?.to);
    expect(targets).toEqual(['inbox', 'inbox', 'tasks', 'conversations']);
    for (const kind of GROUPABLE_KINDS) {
      const key = kind.replace('kernel.', '') as 'approval_waiting';
      expect(vi.notifications.group[key], kind).toBeTruthy();
      expect(en.notifications.group[key], kind).toBeTruthy();
    }
  });

  it('counts the things a group stands for, not the notices: one file read twice is one file', () => {
    expect(groupSubjectCount([{ id: 'a', subjectId: 'f1' }, { id: 'b', subjectId: 'f1' }, { id: 'c', subjectId: 'f2' }, { id: 'd', subjectId: null }, { id: 'e', subjectId: null }])).toBe(4);
  });

  it('chunks the unread ids for the read command, which takes 100 at a time', () => {
    const items = Array.from({ length: 250 }, (_v, i) => ({ id: String(i), read: i % 5 === 0 }));
    // 250 items, 50 of them read: 200 unread, two chunks of 100.
    expect(unreadIdChunks(items).map((c) => c.length)).toEqual([100, 100]);
    expect(unreadIdChunks([{ id: 'a', read: true }])).toEqual([]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// "Khi nào đăng?" in the composer (#3653): the time a new post goes out is the person's choice, and a channel with no
// queue slots cannot take "the next free slot". Pure helpers; the commands still decide (a time in the past or an empty
// queue is refused by the server).
import { toLocalInput } from './social.ts';

export type WhenMode = 'time' | 'queue' | 'draft';

// What the composer knows of one chosen channel's queue: how many free slots a post without a category label could take
// (the queue's own next-free list, which leaves out turned-off slots and slots kept for a label), and whether it is paused.
export type QueueState = { free: number; paused: boolean };

// A time to start from when nothing is chosen: 09:00 local, today if that is more than an hour away, else tomorrow.
export function defaultPostTime(now: Date): string {
  const at = new Date(now);
  at.setHours(9, 0, 0, 0);
  if (at.getTime() - now.getTime() < 3_600_000) at.setDate(at.getDate() + 1);
  return toLocalInput(at.toISOString());
}

// The queue can take the post only when every chosen channel has a free slot for it, and none is paused. Until the queues are read
// (null entries) it is not offered, so the person is never sent to a "queue is empty" error.
export function queueReady(queues: readonly (QueueState | null)[]): boolean {
  return queues.length > 0 && queues.every((q) => q !== null && q.free > 0 && !q.paused);
}

// The mode in force: the person's choice, else the next free slot when the channels have one and a time when not. A
// queue choice goes back to a time when the channels no longer have slots (another channel was picked).
export function effectiveWhen(choice: WhenMode | null, ready: boolean): WhenMode {
  if (choice === 'draft') return 'draft';
  if (choice === 'time') return 'time';
  if (choice === 'queue') return ready ? 'queue' : 'time';
  return ready ? 'queue' : 'time';
}

// An ISO instant from a datetime-local text, only when it is still ahead of `now`.
export function futureInstant(iso: string | null, now: number): string | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) || t <= now ? null : iso;
}

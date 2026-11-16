// SPDX-License-Identifier: AGPL-3.0-only
// The invalidation stream and the per-org app switch (ADR-0053, slice c C2b), without a database: a stream of an org that has an app off does not push the
// hints of that app's entities, an org_apps hint makes it check again first and then goes to every stream of the org, and every hint type names its app.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAM_HINT_TYPES } from '@crove/kernel-contract';
import { ALL_ENTITIES, HINT_APPS, STREAM_FILTERED_APPS, StreamConnection, parseHint, type StreamScope } from '../src/stream.ts';

const ORG = randomUUID();
const USER = randomUUID();
const off = (...apps: string[]): StreamScope => ({ ...ALL_ENTITIES, appsOff: new Set(apps) });

describe('hint types and their apps', () => {
  it('names an app for every hint type, and filters only apps other than the kernel', () => {
    for (const type of STREAM_HINT_TYPES) expect(typeof HINT_APPS[type], type).toBe('string');
    expect([...STREAM_FILTERED_APPS].sort()).toEqual(['finance', 'notes', 'social']);
  });

  it('reads the org_apps hint of the org with the org as its id, and no entity or recipient', () => {
    expect(parseHint(`${ORG} org_apps ${ORG}`)).toEqual({ orgId: ORG, hint: { type: 'org_apps', id: ORG } });
  });
});

describe('a stream of an org with an app off', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function connection(scope: StreamScope, check: () => Promise<StreamScope>) {
    const chunks: string[] = [];
    const conn = new StreamConnection({ orgId: ORG, userId: USER, scope, check, recheckMs: 3_600_000, endsAt: Date.now() + 3_600_000, write: (chunk) => (chunks.push(chunk), true), end: () => {} });
    const types = () => chunks.filter((c) => c.startsWith('event: invalidate')).map((c) => (JSON.parse((c.trim().split('\n')[1] as string).slice(6)) as { type: string }).type);
    return { conn, types };
  }

  it('drops the hints of the apps that are off and keeps the kernel ones', async () => {
    const { conn, types } = connection(off('finance', 'social', 'notes'), async () => off('finance', 'social', 'notes'));
    for (const type of ['journal_entry', 'document', 'social_post', 'social_notification', 'file', 'proposal', 'extraction']) {
      conn.hint({ type: type as never, id: randomUUID() }, ['journal_entry', 'document', 'extraction', 'proposal'].includes(type) ? randomUUID() : undefined);
    }
    // A member's own rows of an app that is off are dropped before the recipient test.
    conn.hint({ type: 'todo', id: randomUUID() }, undefined, USER);
    await vi.advanceTimersByTimeAsync(0);
    expect(types().sort()).toEqual(['extraction', 'file', 'proposal']);
    conn.finish();
  });

  it('sends every hint of an app that is on', async () => {
    const { conn, types } = connection(ALL_ENTITIES, async () => ALL_ENTITIES);
    conn.hint({ type: 'social_post', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    expect(types()).toEqual(['social_post']);
    conn.finish();
  });

  it('checks again when the apps change, then pushes org_apps and filters by the new set', async () => {
    let scope: StreamScope = ALL_ENTITIES;
    const check = vi.fn(async () => scope);
    const { conn, types } = connection(ALL_ENTITIES, check);
    conn.hint({ type: 'social_post', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    expect(types()).toEqual(['social_post']);
    // The owner turns Social off: the trigger's hint reaches the stream, which checks first.
    scope = off('social');
    conn.hint({ type: 'org_apps', id: ORG });
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    expect(types()).toEqual(['social_post', 'org_apps']);
    conn.hint({ type: 'social_post', id: randomUUID() });
    conn.hint({ type: 'file', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    expect(types()).toEqual(['social_post', 'org_apps', 'file']);
    // And back on: the next check lifts the filter.
    scope = ALL_ENTITIES;
    conn.hint({ type: 'org_apps', id: ORG });
    await vi.advanceTimersByTimeAsync(0);
    conn.hint({ type: 'social_post', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    expect(types().slice(-2)).toEqual(['org_apps', 'social_post']);
    conn.finish();
  });
  it('runs one more check when the apps change while a check is already running, before the hint goes out', async () => {
    let scope: StreamScope = ALL_ENTITIES;
    const answers: Array<() => void> = [];
    const check = vi.fn(
      () =>
        new Promise<StreamScope>((resolve) => {
          const read = scope;
          answers.push(() => resolve(read));
        }),
    );
    const { conn, types } = connection(ALL_ENTITIES, check);
    // A re-check is under way and has read the apps; then the owner switches Social off and the hint arrives.
    void conn.recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    scope = off('social');
    conn.hint({ type: 'org_apps', id: ORG });
    answers[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    // The first answer is the old set: a second check follows and nothing is sent yet.
    expect(check).toHaveBeenCalledTimes(2);
    expect(types()).toEqual([]);
    answers[1]?.();
    await vi.advanceTimersByTimeAsync(0);
    conn.hint({ type: 'social_post', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    expect(types()).toEqual(['org_apps']);
    conn.finish();
  });
});

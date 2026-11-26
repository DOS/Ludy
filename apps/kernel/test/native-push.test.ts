// SPDX-License-Identifier: AGPL-3.0-only
// Native push sender adapter contract, content-free payload builder, claim/enqueue, and worker job handler unit tests (#4883, ADR-0059).
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@ludy/db';
import type { NativePushTargetsResult } from '@ludy/kernel';
import type { Runtime } from '@ludy/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { defaultAdapters } from '../src/kernel.ts';
import {
  NATIVE_PUSH_BATCH_LIMIT,
  NATIVE_PUSH_SWEEP_MS,
  buildNativePushPayload,
  enqueueNativePushes,
  runNativePushJob,
  type NativePushSender,
} from '../src/native-push.ts';

const BASE_CONFIG = {
  DATABASE_URL: 'postgres://localhost/ludy',
  AUTH_JWT_SECRET: 'x'.repeat(32),
  AUTH_ISSUER: 'ludy-auth',
  WEB_DIST: '/nonexistent',
};

const ORG_ID = '01950000-0000-7000-8000-000000000010';
const NOTICE_ID = '01950000-0000-7000-8000-000000000020';
const SUBJECT_ID = '01950000-0000-7000-8000-000000000030';
const DEVICE_1 = '01950000-0000-7000-8000-000000000101';
const DEVICE_2 = '01950000-0000-7000-8000-000000000102';
const DEVICE_3 = '01950000-0000-7000-8000-000000000103';
const DEVICE_4 = '01950000-0000-7000-8000-000000000104';

function createMockClaimDb(claimedRows: Array<{ org_id: string; notification_id: string }>): {
  db: Db;
  executed: CompiledQuery[];
} {
  const executed: CompiledQuery[] = [];
  const baseDriver = new DummyDriver();
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: () => baseDriver.init(),
        acquireConnection: async () => ({
          executeQuery: async <R>(compiledQuery: CompiledQuery) => {
            executed.push(compiledQuery);
            return { rows: claimedRows as unknown as R[] };
          },
          streamQuery: async function* <R>(): AsyncIterableIterator<{ rows: R[] }> {
            yield { rows: [] };
          },
        }),
        beginTransaction: () => baseDriver.beginTransaction(),
        commitTransaction: () => baseDriver.commitTransaction(),
        rollbackTransaction: () => baseDriver.rollbackTransaction(),
        releaseConnection: () => baseDriver.releaseConnection(),
        destroy: () => baseDriver.destroy(),
      }),
    },
  });
  return { db: db as unknown as Db, executed };
}

describe('buildNativePushPayload', () => {
  it('builds strictly content-free payloads and deep links for each pushed kind', () => {
    expect(buildNativePushPayload('kernel.conversation_new', 'cong-ty-a', SUBJECT_ID)).toEqual({
      kind: 'kernel.conversation_new',
      title: 'Có 1 hội thoại mới',
      orgSlug: 'cong-ty-a',
      subjectId: SUBJECT_ID,
      path: `/o/cong-ty-a/social/inbox?c=${SUBJECT_ID}`,
    });

    expect(buildNativePushPayload('kernel.conversation_new', 'cong-ty-a', null)).toEqual({
      kind: 'kernel.conversation_new',
      title: 'Có 1 hội thoại mới',
      orgSlug: 'cong-ty-a',
      subjectId: null,
      path: '/o/cong-ty-a/social/inbox?status=new',
    });

    expect(buildNativePushPayload('kernel.approval_waiting', 'cong-ty-a', SUBJECT_ID)).toEqual({
      kind: 'kernel.approval_waiting',
      title: 'Có 1 đề xuất cần duyệt',
      orgSlug: 'cong-ty-a',
      subjectId: SUBJECT_ID,
      path: `/o/cong-ty-a/inbox/${SUBJECT_ID}`,
    });

    expect(buildNativePushPayload('kernel.approval_waiting', 'cong-ty-a', null)).toEqual({
      kind: 'kernel.approval_waiting',
      title: 'Có 1 đề xuất cần duyệt',
      orgSlug: 'cong-ty-a',
      subjectId: null,
      path: '/o/cong-ty-a/inbox',
    });

    expect(NATIVE_PUSH_SWEEP_MS).toBe(10_000);
    expect(NATIVE_PUSH_BATCH_LIMIT).toBe(100);
  });
});

describe('enqueueNativePushes', () => {
  it('claims via Kysely sql and sends at-most-once pg-boss jobs with expireInSeconds=300 and retryLimit=0', async () => {
    const { db, executed } = createMockClaimDb([{ org_id: ORG_ID, notification_id: NOTICE_ID }]);
    const send = vi.fn(async () => 'job-1');

    const queued = await enqueueNativePushes({ send }, db, 25, ORG_ID);

    expect(queued).toBe(1);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toContain('ludy_kernel.native_push_claim');
    expect(executed[0]?.parameters).toEqual([25, ORG_ID]);
    expect(send).toHaveBeenCalledWith(
      'kernel-native-push',
      { orgId: ORG_ID, notificationId: NOTICE_ID },
      expect.objectContaining({
        retryLimit: 0,
        expireInSeconds: 300,
      }),
    );

    const failSend = vi.fn(async () => {
      throw new Error('pg-boss insert failed');
    });
    await expect(enqueueNativePushes({ send: failSend }, db, 25, ORG_ID)).rejects.toThrow('pg-boss insert failed');
  });
});

describe('runNativePushJob', () => {
  it('skips sending or recording when there are no eligible targets', async () => {
    const query = vi.fn(async () => null);
    const execute = vi.fn(async () => ({}));
    const send = vi.fn(async () => 'sent' as const);
    const runtime = { query, execute } as unknown as Runtime;
    const sender: NativePushSender = { id: 'test-sender', send };

    expect(await runNativePushJob({ runtime, sender, orgId: ORG_ID, notificationId: NOTICE_ID })).toEqual({
      sent: 0,
      gone: 0,
      failed: 0,
    });
    expect(query).toHaveBeenCalledWith(
      'kernel.native_push.targets',
      { notificationId: NOTICE_ID, checkUpstream: false },
      { actor: { type: 'system', component: 'kernel.native_push' }, orgId: ORG_ID },
    );
    expect(send).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('drops invalid sessions without calling sender, records device generations, and tolerates transient record failures', async () => {
    const targetsResult: NativePushTargetsResult = {
      orgSlug: 'acme',
      kind: 'kernel.approval_waiting',
      subjectId: SUBJECT_ID,
      targets: [
        { deviceId: DEVICE_1, generation: 1, platform: 'apns', token: 'apns-token-one-test', sessionValid: true },
        { deviceId: DEVICE_2, generation: 2, platform: 'fcm', token: 'fcm-token-two-test', sessionValid: true },
        { deviceId: DEVICE_3, generation: 3, platform: 'apns', token: 'apns-token-three-test', sessionValid: true },
        { deviceId: DEVICE_4, generation: 1, platform: 'fcm', token: 'fcm-token-four-test', sessionValid: false },
      ],
    };
    const query = vi.fn(async () => targetsResult);
    const execute = vi.fn(async () => ({ sent: 1, gone: 2, failed: 1 }));
    const send = vi.fn(async (target: { token: string }) => {
      if (target.token === 'apns-token-one-test') return 'sent' as const;
      if (target.token === 'fcm-token-two-test') return 'gone' as const;
      throw new Error('relay timeout');
    });
    const runtime = { query, execute } as unknown as Runtime;
    const sender: NativePushSender = { id: 'test-sender', send };

    const result = await runNativePushJob({
      runtime,
      sender,
      orgId: ORG_ID,
      notificationId: NOTICE_ID,
      checkUpstream: true,
    });

    expect(query).toHaveBeenCalledWith(
      'kernel.native_push.targets',
      { notificationId: NOTICE_ID, checkUpstream: true },
      { actor: { type: 'system', component: 'kernel.native_push' }, orgId: ORG_ID },
    );
    expect(result).toEqual({ sent: 1, gone: 2, failed: 1 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ token: 'fcm-token-four-test' }),
      expect.anything(),
    );
    expect(execute).toHaveBeenCalledWith(
      'kernel.native_push.record',
      {
        sent: [{ id: DEVICE_1, generation: 1 }],
        gone: [{ id: DEVICE_2, generation: 2 }],
        expired: [{ id: DEVICE_4, generation: 1 }],
        failed: [{ id: DEVICE_3, generation: 3 }],
        checkUpstream: true,
      },
      { actor: { type: 'system', component: 'kernel.native_push' }, orgId: ORG_ID },
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingExecute = vi.fn(async () => {
      throw new Error('db blip');
    });
    expect(
      await runNativePushJob({
        runtime: { query, execute: failingExecute } as unknown as Runtime,
        sender,
        orgId: ORG_ID,
        notificationId: NOTICE_ID,
      }),
    ).toEqual({ sent: 1, gone: 2, failed: 1 });
    warnSpy.mockRestore();
  });

  it('re-checks target eligibility between devices and skips rotated or revoked subsequent targets', async () => {
    const initial: NativePushTargetsResult = {
      orgSlug: 'acme',
      kind: 'kernel.conversation_new',
      subjectId: SUBJECT_ID,
      targets: [
        { deviceId: DEVICE_1, generation: 1, platform: 'apns', token: 'tok-1', sessionValid: true },
        { deviceId: DEVICE_2, generation: 1, platform: 'fcm', token: 'tok-2-old', sessionValid: true },
        { deviceId: DEVICE_3, generation: 1, platform: 'apns', token: 'tok-3', sessionValid: true },
      ],
    };
    const afterDevice1: NativePushTargetsResult = {
      orgSlug: 'acme',
      kind: 'kernel.conversation_new',
      subjectId: SUBJECT_ID,
      targets: [
        { deviceId: DEVICE_1, generation: 1, platform: 'apns', token: 'tok-1', sessionValid: true },
        // DEVICE_2 rotated to generation 2 while DEVICE_1 was in flight: stale generation 1 must not be sent or evicted.
        { deviceId: DEVICE_2, generation: 2, platform: 'fcm', token: 'tok-2-new', sessionValid: true },
        // DEVICE_3 session invalidated while DEVICE_1 was in flight: record as gone without calling sender.
        { deviceId: DEVICE_3, generation: 1, platform: 'apns', token: 'tok-3', sessionValid: false },
      ],
    };
    const query = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(afterDevice1);
    const execute = vi.fn(async () => ({ sent: 1, gone: 1, failed: 0 }));
    const send = vi.fn(async () => 'sent' as const);
    const runtime = { query, execute } as unknown as Runtime;
    const sender: NativePushSender = { id: 'test-sender', send };

    expect(await runNativePushJob({ runtime, sender, orgId: ORG_ID, notificationId: NOTICE_ID })).toEqual({
      sent: 1,
      gone: 1,
      failed: 0,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ platform: 'apns', token: 'tok-1' }, expect.any(Object));
    expect(execute).toHaveBeenCalledWith(
      'kernel.native_push.record',
      {
        sent: [{ id: DEVICE_1, generation: 1 }],
        gone: [],
        expired: [{ id: DEVICE_3, generation: 1 }],
        failed: [],
        checkUpstream: false,
      },
      { actor: { type: 'system', component: 'kernel.native_push' }, orgId: ORG_ID },
    );
  });

  it('still records earlier send outcomes when a subsequent inter-device lookup fails', async () => {
    const initial: NativePushTargetsResult = {
      orgSlug: 'acme',
      kind: 'kernel.conversation_new',
      subjectId: SUBJECT_ID,
      targets: [
        { deviceId: DEVICE_1, generation: 1, platform: 'apns', token: 'tok-gone-1', sessionValid: true },
        { deviceId: DEVICE_2, generation: 1, platform: 'fcm', token: 'tok-2', sessionValid: true },
      ],
    };
    const query = vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error('transient lookup error'));
    const execute = vi.fn(async () => ({ sent: 0, gone: 1, failed: 0 }));
    const send = vi.fn(async () => 'gone' as const);
    const runtime = { query, execute } as unknown as Runtime;
    const sender: NativePushSender = { id: 'test-sender', send };

    await expect(runNativePushJob({ runtime, sender, orgId: ORG_ID, notificationId: NOTICE_ID })).rejects.toThrow(
      'transient lookup error',
    );
    expect(execute).toHaveBeenCalledWith(
      'kernel.native_push.record',
      { sent: [], gone: [{ id: DEVICE_1, generation: 1 }], expired: [], failed: [], checkUpstream: false },
      { actor: { type: 'system', component: 'kernel.native_push' }, orgId: ORG_ID },
    );
  });
});

describe('defaultAdapters', () => {
  it('leaves nativePush unset on self-hosted default deployments', () => {
    const config = loadConfig({ ...BASE_CONFIG });
    const adapters = defaultAdapters(config);
    expect(adapters.nativePush).toBeUndefined();
  });
});

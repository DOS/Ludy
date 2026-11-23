// SPDX-License-Identifier: AGPL-3.0-only
// The deadline of the state job's read (issue #3301): when it passes, the read is told to stop (its signal aborts), the objects not read are recorded as a failed read with the code
// TIMEOUT, and the run ends without throwing. The database side is in ads.db.test.ts ("the platform's object states").
import { describe, expect, it } from 'vitest';
import type { AdStateReader } from '@ludy/ad-platform';
import type { CredentialBroker, Runtime } from '@ludy/kernel-runtime';
import { runAdsStateSync } from '../src/ads-state.ts';

describe('the state job\'s deadline', () => {
  it('aborts a read that outlasts it and records every object of the launch as not read (TIMEOUT)', async () => {
    const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
    const runtime = {
      async query(name: string) {
        if (name === 'ads.object.sync_target') {
          return { adAccountId: 'a', writeConnectionId: 'w', provider: 'sandboxwrite_ads', launches: [{ launchId: 'l1', objects: [{ level: 'campaign', id: 'c1' }, { level: 'ad', id: 'a1' }] }] };
        }
        return { provider: 'sandboxwrite_ads', externalAccountId: 'x', keyId: 'k', envelope: Buffer.from('e').toString('base64') };
      },
      async execute(name: string, input: Record<string, unknown>) {
        executed.push({ name, input });
        return { recorded: true, changed: 0 };
      },
    } as unknown as Runtime;
    const broker = { id: 'test', open: () => 'the-secret' } as unknown as CredentialBroker;
    let aborted = false;
    const reader: AdStateReader = {
      readStates: (_secret, _objects, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    };
    const result = await runAdsStateSync({ runtime, broker, readers: { sandboxwrite_ads: reader }, timeoutMs: 20 }, { orgId: 'o', connectionId: 'c' });
    expect(aborted).toBe(true);
    expect(result).toMatchObject({ launches: 1, failed: 1, ended: 'done' });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.name).toBe('ads.object.sync_state');
    expect(executed[0]?.input).toMatchObject({
      launchId: 'l1',
      states: [],
      failed: [
        { id: 'c1', level: 'campaign', kind: 'transient', code: 'TIMEOUT' },
        { id: 'a1', level: 'ad', kind: 'transient', code: 'TIMEOUT' },
      ],
    });
    expect(JSON.stringify(executed)).not.toContain('the-secret');
  });
});

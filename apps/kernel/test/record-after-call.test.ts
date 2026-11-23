// SPDX-License-Identifier: AGPL-3.0-only
// A record refused because its app went off after the platform call was made must fail loudly (ADR-0053, review F1 of C1): the ads were switched on, or the
// invoice was issued, and nothing in Ludy would say so. The worker's quiet rule (a MODULE_OFF ends a job) must not match it, without a database.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DomainError, type Runtime } from '@ludy/kernel-runtime';
import type { AdActivator } from '@ludy/ad-platform';
import type { EInvoiceProvider } from '@ludy/einvoice';
import { runAdsActivate } from '../src/ads-activate.ts';
import { runEInvoiceIssue } from '../src/einvoice-issue-job.ts';
import { withJobLogContext } from '../src/log.ts';
import { AppOffAfterCallError, recordAfterCall } from '../src/record-after-call.ts';

const off = (module: string) => new DomainError('MODULE_OFF', 404, 'off', { module });
const ORG = '01900000-0000-7000-8000-000000000001';

// What the worker does with a failed handler: the quiet rule of withJobLogContext, as pg-boss would see the result.
async function quietRuleResult(queue: string, handler: () => Promise<unknown>, retryCount = 0): Promise<'resolved' | Error> {
  let wrapped: ((jobs: unknown[]) => Promise<unknown>) | undefined;
  const boss = { work: async (_name: string, fn: (jobs: unknown[]) => Promise<unknown>) => void (wrapped = fn) };
  withJobLogContext(boss, { loudOnRetryQueues: new Set(['kernel-ads-activate']) });
  await (boss.work as unknown as (n: string, f: unknown) => Promise<unknown>)(queue, handler);
  const silence = console.error;
  console.error = () => {};
  try {
    await wrapped!([{ id: 'j', data: { orgId: ORG }, retryCount }]);
    return 'resolved';
  } catch (error) {
    return error as Error;
  } finally {
    console.error = silence;
  }
}

describe('recordAfterCall', () => {
  it('passes the answer through and rethrows other errors as they are', async () => {
    await expect(recordAfterCall('x.record', async () => 7)).resolves.toBe(7);
    await expect(recordAfterCall('x.record', async () => Promise.reject(new DomainError('FORBIDDEN', 403, 'no')))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('turns MODULE_OFF into an error the quiet rule does not end', async () => {
    const error = await recordAfterCall('x.record', async () => Promise.reject(off('ads'))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppOffAfterCallError);
    expect(error).not.toBeInstanceOf(DomainError);
    expect((error as AppOffAfterCallError).module).toBe('ads');
    const result = await quietRuleResult('kernel-ads-activate', async () => Promise.reject(error));
    expect(result).toBe(error);
    // A refusal at the job's first gated call (nothing done yet) still ends quietly.
    expect(await quietRuleResult('kernel-ads-activate', async () => Promise.reject(off('ads')))).toBe('resolved');
  });

  it('keeps the retry of that job loud: its begin is refused with MODULE_OFF, and ending that quietly would leave one failed attempt as the only trace', async () => {
    const begin = off('ads');
    // The first attempt (retryCount 0): refused at begin, nothing was done, ends quietly. A retry (retryCount 1): the earlier attempt failed, so it fails again, to the dead letter queue.
    expect(await quietRuleResult('kernel-ads-activate', async () => Promise.reject(begin), 0)).toBe('resolved');
    expect(await quietRuleResult('kernel-ads-activate', async () => Promise.reject(begin), 1)).toBe(begin);
    // A queue that is not named stays quiet on retries.
    expect(await quietRuleResult('kernel-other', async () => Promise.reject(begin), 1)).toBe('resolved');
  });

  it('wraps the record of every runner that records after a platform call, and the worker asks those queues for metadata', () => {
    for (const [file, name] of [['ads-activate.ts', 'ads.activate.record'], ['ads-launch.ts', 'ads.launch.record'], ['einvoice-issue-job.ts', 'finance.einvoice.job_record']] as const) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain(`recordAfterCall('${name}'`);
    }
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    for (const queue of ['einvoiceIssue', 'adsLaunch', 'adsActivate']) {
      expect(worker, queue).toContain(`QUEUES.${queue}, { batchSize: 1, includeMetadata: true }`);
      expect(worker, queue).toMatch(new RegExp(`loudOnRetryQueues: new Set<string>\\([^)]*QUEUES\\.${queue}`));
    }
  });
});

describe('a record refused after the platform call', () => {
  it('fails the ads activation job loudly, after the activator switched the object on', async () => {
    let activated = 0;
    const activator: AdActivator = { activate: async () => void (activated += 1), readStatus: async () => ({ status: 'paused' }) };
    const runtime = {
      execute: async (name: string) => {
        if (name === 'ads.activate.begin') {
          return { action: 'call', launchId: 'l1', callKey: 'k1', step: 's', slot: 'c', level: 'campaign', objectId: 'o1', connectionId: 'c1', provider: 'meta', account: { externalAccountId: 'a', currency: 'VND' } };
        }
        throw off('ads');
      },
      query: async () => ({ provider: 'meta', externalAccountId: 'a', keyId: 'k', envelope: '' }),
    } as unknown as Runtime;
    const broker = { id: 'test', open: () => 'secret' } as never;
    const result = await quietRuleResult('kernel-ads-activate', () => runAdsActivate({ runtime, broker, activators: { meta: activator } }, { orgId: ORG, launchId: 'l1' }));
    expect(activated).toBe(1);
    expect(result).toBeInstanceOf(AppOffAfterCallError);
  });

  it('fails the e-invoice issue job loudly, after the provider issued the invoice', async () => {
    let issued = 0;
    const provider = {
      hosts: [],
      issue: async () => {
        issued += 1;
        return { state: 'issued', ref: 'r1', number: '1', signedAt: '2026-11-16T00:00:00Z', taxAuthorityCode: null };
      },
      status: async () => ({ state: 'unknown' }),
    } as unknown as EInvoiceProvider;
    const runtime = {
      execute: async (name: string) => {
        if (name === 'finance.einvoice.job_begin') {
          return { action: 'issue', draftId: 'd1', legalEntityId: 'le', key: 'k', connectionId: 'c', adapter: 'sandbox', request: {} };
        }
        throw off('finance');
      },
    } as unknown as Runtime;
    const result = await quietRuleResult('kernel-einvoice-issue', () =>
      runEInvoiceIssue({ runtime, broker: { id: 'test', open: () => 'x' } as never, store: {} as never, providers: { sandbox: provider } }, { orgId: ORG, draftId: 'd1' }),
    );
    expect(issued).toBe(1);
    expect(result).toBeInstanceOf(AppOffAfterCallError);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Meta's management of a live launch's objects (ADR-0043, issue #3835, ads W4). A status change goes through the two classes that already own the words of a status (the
// writer's `setStatus` pauses or archives, the activator switches on), so no status word is spelled here and the one file that sends the switch-on stays the activation's;
// what is new in this file is the ad set's budget and end time (`POST <ad set id>` with `daily_budget` in Meta's minor unit, or `end_time`) and a read of an object's status,
// budget and end time (`GET <object id>`). The job never reaches it but through the frozen view of managers.ts. [U] Meta's exact answers are written from its documentation;
// the live check (the W2 live check, then W4's) records what it really sends.
import type { Fetch } from '@crove/channel';
import { Graph, META_DEFAULT_GRAPH_VERSION } from '@crove/channel';
import { AdPlatformError } from './index.ts';
import type { AdActivator, PlatformObjectStatus } from './activators.ts';
import type { AdManager, ManageStatus, ManageTarget, ManagedRead } from './managers.ts';
import { fromMetaMinorUnits, metaMinorUnits } from './meta-currency.ts';
import { graphHostOnly, metaAdsError } from './meta.ts';
import type { AdWriter, AdWriterAccount } from './writer.ts';

const CALL_TIMEOUT_MS = 20_000;
const OBJECT_ID = /^\d{1,32}$/;

export interface MetaAdManagerOptions {
  // The secret of the write app that issued the token.
  appSecret: string;
  // The writer that pauses and archives, and the activator that switches on and reads a status: built by the caller (launch-writers.ts), never here.
  writer: Pick<AdWriter, 'setStatus'>;
  activator: AdActivator;
  graphVersion?: string;
  fetch?: Fetch;
  now?: () => Date;
}

// The token inside the sealed secret of a connection (`{ accessToken }`, as the connector seals it).
function tokenOf(secret: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new AdPlatformError('unknown', 'BAD_SECRET');
  }
  const token = (parsed as { accessToken?: unknown } | null)?.accessToken;
  if (typeof token !== 'string' || token === '') throw new AdPlatformError('unknown', 'BAD_SECRET');
  return token;
}

export class MetaAdManager implements AdManager {
  private readonly graph: Graph;
  private readonly now: () => Date;
  private readonly writer: Pick<AdWriter, 'setStatus'>;
  private readonly activator: AdActivator;

  constructor(options: MetaAdManagerOptions) {
    this.graph = new Graph(options.appSecret, options.graphVersion ?? META_DEFAULT_GRAPH_VERSION, graphHostOnly(options.fetch));
    this.now = options.now ?? (() => new Date());
    this.writer = options.writer;
    this.activator = options.activator;
  }

  async changeStatus(secret: string, object: ManageTarget, status: ManageStatus): Promise<void> {
    if (status === 'active') return this.activator.activate(secret, object);
    // A creative has no status of its own, so the writer's level is one of the three this view allows.
    return this.writer.setStatus(secret, object, status);
  }

  async setBudget(secret: string, object: ManageTarget, account: AdWriterAccount, dailyBudget: string): Promise<void> {
    const token = tokenOf(secret);
    if (!OBJECT_ID.test(object.id)) throw new AdPlatformError('bad_request', 'BAD_OBJECT');
    // Exact, or refused (a currency with no verified offset, a fraction the offset cannot carry): before any request.
    const minor = metaMinorUnits(dailyBudget, account.currency);
    await this.change(token, object.id, { daily_budget: minor });
  }

  async setEndTime(secret: string, object: ManageTarget, endTime: string): Promise<void> {
    const token = tokenOf(secret);
    if (!OBJECT_ID.test(object.id)) throw new AdPlatformError('bad_request', 'BAD_OBJECT');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/.test(endTime)) throw new AdPlatformError('bad_request', 'TIME_INVALID');
    await this.change(token, object.id, { end_time: endTime });
  }

  private async change(token: string, id: string, form: Record<string, string>): Promise<void> {
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', id, { token, form, timeoutMs: CALL_TIMEOUT_MS });
      if (answer.success !== true) throw new AdPlatformError('unknown', 'NOT_CHANGED');
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }

  async read(secret: string, object: ManageTarget, account: AdWriterAccount): Promise<ManagedRead> {
    const token = tokenOf(secret);
    if (!OBJECT_ID.test(object.id)) throw new AdPlatformError('bad_request', 'BAD_OBJECT');
    try {
      const fields = object.level === 'ad_set' ? 'status,daily_budget,end_time' : 'status';
      const answer = await this.graph.call<{ status?: unknown; daily_budget?: unknown; end_time?: unknown }>('GET', object.id, { token, params: { fields }, timeoutMs: CALL_TIMEOUT_MS });
      const status = statusWord(answer.status);
      const minor = typeof answer.daily_budget === 'number' && Number.isInteger(answer.daily_budget) ? String(answer.daily_budget) : answer.daily_budget;
      const budget = typeof minor === 'string' && minor !== '' ? fromMetaMinorUnits(minor, account.currency) : null;
      const endTime = typeof answer.end_time === 'string' && answer.end_time !== '' ? answer.end_time : null;
      return { status, dailyBudget: budget, endTime };
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }
}

// What the platform's status word means (an unknown word is `other`, never a guess). Compared case-insensitively; the words are Meta's own enum, read here, never sent.
function statusWord(value: unknown): PlatformObjectStatus {
  const word = typeof value === 'string' ? value.toLowerCase() : '';
  return word === 'active' ? 'active' : word === 'paused' ? 'paused' : word === 'archived' ? 'archived' : 'other';
}

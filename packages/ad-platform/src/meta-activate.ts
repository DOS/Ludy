// SPDX-License-Identifier: AGPL-3.0-only
// Meta's activation of a launch's objects (ADR-0043 points 4 and 5, issue #2296, W2-4b): `POST <object id>` with the status ACTIVE, and `GET <object id>` for the status
// it reads back. It is a separate class from the writer (`MetaAdWriter`, meta-write.ts, which can only create paused objects and pause or archive them), built with the
// same options and bound to the Graph API host the same way, so the one place in the code that sends ACTIVE is this file. The job never reaches it but through the frozen
// view of activators.ts. [U] Meta's exact answer to the change of status is written from its documentation; the live check (W2-5) records what it really sends.
import type { Fetch } from '@crove/channel';
import { Graph, META_DEFAULT_GRAPH_VERSION } from '@crove/channel';
import { AdPlatformError } from './index.ts';
import type { ActivateTarget, AdActivator, PlatformObjectStatus } from './activators.ts';
import { graphHostOnly, metaAdsError } from './meta.ts';

const CALL_TIMEOUT_MS = 20_000;
const OBJECT_ID = /^\d{1,32}$/;

export interface MetaAdActivatorOptions {
  // The secret of the write app that issued the token.
  appSecret: string;
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

const statusOf = (value: unknown): PlatformObjectStatus => (value === 'ACTIVE' ? 'active' : value === 'PAUSED' ? 'paused' : value === 'ARCHIVED' ? 'archived' : 'other');

export class MetaAdActivator implements AdActivator {
  private readonly graph: Graph;
  private readonly now: () => Date;

  constructor(options: MetaAdActivatorOptions) {
    this.graph = new Graph(options.appSecret, options.graphVersion ?? META_DEFAULT_GRAPH_VERSION, graphHostOnly(options.fetch));
    this.now = options.now ?? (() => new Date());
  }

  async activate(secret: string, object: ActivateTarget): Promise<void> {
    const token = tokenOf(secret);
    if (!OBJECT_ID.test(object.id)) throw new AdPlatformError('bad_request', 'BAD_OBJECT');
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', object.id, { token, form: { status: 'ACTIVE' }, timeoutMs: CALL_TIMEOUT_MS });
      if (answer.success !== true) throw new AdPlatformError('unknown', 'NOT_CHANGED');
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }

  async readStatus(secret: string, object: ActivateTarget): Promise<{ status: PlatformObjectStatus }> {
    const token = tokenOf(secret);
    if (!OBJECT_ID.test(object.id)) throw new AdPlatformError('bad_request', 'BAD_OBJECT');
    try {
      const answer = await this.graph.call<{ status?: unknown }>('GET', object.id, { token, params: { fields: 'status' }, timeoutMs: CALL_TIMEOUT_MS });
      return { status: statusOf(answer.status) };
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }
}

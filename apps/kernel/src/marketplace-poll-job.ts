// SPDX-License-Identifier: AGPL-3.0-only
// The pull of a marketplace connection's orders, the worker's half (#2519, ADR-0045 point 7, plan stock-and-marketplaces.md section 8.7), run as the system for one connection. The credential
// is opened here and nowhere else (the API only seals it, ADR-0025). The provider is asked for the orders since the connection's cursor; what it lists is written as a CSV in the layout of the
// platform's own order report and ingested with kernel.file.ingest (source `upload`, the connection's entity, content type text/csv), the SAME intake as a file a member drops in the Inbox.
// The normal extraction event then fires and readMarketplaceFile stages the file, so the parsing sandbox, the checks, the Inbox card and the 90-day retention apply unchanged.
//
// The poll NEVER confirms: a member confirms in the Inbox, and a profile that is not confirmed against a real seller's file writes no order and no stock by itself. It never calls a write
// endpoint of a platform: the port has none. The same page of orders gives the same bytes, so the intake's content hash recognises a repeat and stages nothing twice; the cursor moves only
// after the ingest succeeded. A failure records a state (unreachable, credentials, rate_limited, too_large), never the provider's own text. Nothing here logs or stores a credential or a
// provider's message: ids, counts and states.
import { EXTRACT_LIMITS } from '@crove/extract-contract';
import {
  MARKETPLACE_PLATFORM_LIMITS,
  MarketplaceProviderError,
  SANDBOX_MARKETPLACE_SECRET,
  marketplaceOrdersCsv,
  ordersSpan,
  splitWritableOrders,
  type MarketplaceOrder,
  type MarketplacePollEnding,
  type MarketplacePollTarget,
  type MarketplaceProvider,
} from '@crove/mod-finance';
import { DomainError, fileKey, putFile, sha256Hex, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.marketplace' };

export interface MarketplacePollJob {
  orgId: string;
  // The marketplace connection's id (the finance module's row), not the channel connection's.
  connectionId: string;
}

export interface MarketplacePollDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  store: BlobStore;
  providers: Readonly<Record<string, MarketplaceProvider>>;
}

export type MarketplacePollOutcome =
  // The connection is left alone (gone, no longer active, its adapter off on this deployment): nothing was asked and nothing is recorded.
  | { state: 'skipped'; reason: string }
  | { state: MarketplacePollEnding; orders: number; staged: boolean };

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

// The connection's id is in the name, so the Inbox files of one connection can be told from every other (the finance module counts what waits for a connection by it).
const csvFilename = (platform: string, connectionId: string, orders: readonly MarketplaceOrder[]): string => {
  const span = ordersSpan(orders);
  return `don-hang-${platform}-${connectionId}${span ? `-${span.from}-${span.to}` : ''}.csv`;
};

export async function runMarketplacePoll(deps: MarketplacePollDeps, job: MarketplacePollJob): Promise<MarketplacePollOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const target = await deps.runtime.query<MarketplacePollTarget>('finance.marketplace_connection.poll_target', { id: job.connectionId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };
  // The adapter switched off on this deployment: nothing is sent and the connection's record is left as it was.
  if (!Object.hasOwn(deps.providers, target.adapter)) return { state: 'skipped', reason: 'provider_off' };
  const provider = deps.providers[target.adapter] as MarketplaceProvider;
  // A poll that changes nothing the row holds (the same state, the same cursor) writes nothing: the 15-minute sweep would otherwise add an audit row for every connection every time.
  const record = async (fields: { state: MarketplacePollEnding; cursor?: string }) => {
    if (fields.state === target.lastPollState && (fields.cursor === undefined || fields.cursor === target.cursor)) return;
    await deps.runtime.execute('finance.marketplace_connection.record_poll', { id: job.connectionId, ...fields }, options);
  };

  // The credential: the offline provider has none; a real one is opened here from the sealed copy, and refused once the member who connected it may no longer use it or the connection is
  // no longer active.
  let secret: string;
  if (provider.hosts.length === 0) {
    secret = SANDBOX_MARKETPLACE_SECRET;
  } else {
    try {
      const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.channelConnectionId }, options);
      secret = String(deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId }));
    } catch (error) {
      if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
        if (error.code === 'CHANNEL_OWNER_LEFT') await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: target.channelConnectionId, reason: 'owner_left' }, options);
        await record({ state: 'credentials' });
        return { state: 'credentials', orders: 0, staged: false };
      }
      throw error;
    }
  }

  let page;
  try {
    page = await provider.listOrders(secret, target.platform, target.cursor);
  } catch (error) {
    // The cursor stays where it was: the next poll asks for the same orders again.
    // Anything that is not the port's own error is made one of its kind here: its message (which a client library may fill with a URL or a header) is neither kept nor logged, and pg-boss
    // never stores it in the job's output.
    const state: MarketplacePollEnding = error instanceof MarketplaceProviderError ? error.kind : 'unreachable';
    await record({ state });
    console.warn(`[marketplace] ${job.connectionId.slice(0, 8)}: ${state}`);
    return { state, orders: 0, staged: false };
  }

  // A page past what the intake accepts is recorded as such and never ingested; the cursor stays, so an owner sees it rather than a silent gap.
  const limit = MARKETPLACE_PLATFORM_LIMITS[target.platform];
  if (page.orders.length > limit.pageSize) {
    await record({ state: 'too_large' });
    return { state: 'too_large', orders: page.orders.length, staged: false };
  }
  // Nothing new: the poll is recorded with the cursor the provider gave back (and not at all when that changes nothing).
  if (page.orders.length === 0) {
    await record({ state: 'ok', ...(page.nextCursor && page.nextCursor !== target.cursor ? { cursor: page.nextCursor } : {}) });
    return { state: 'ok', orders: 0, staged: false };
  }

  // An order the platform's layout cannot carry (a fractional quantity on a platform that writes a row for each unit) is left out and named as a state, never half written.
  const { writable, refused } = splitWritableOrders(target.platform, page.orders);
  const cursor = page.nextCursor && page.nextCursor !== target.cursor ? { cursor: page.nextCursor } : {};
  if (writable.length === 0) {
    await record({ state: 'not_recognized', ...cursor });
    return { state: 'not_recognized', orders: 0, staged: false };
  }
  const csv = marketplaceOrdersCsv(target.platform, writable, job.connectionId);
  const bytes = new TextEncoder().encode(csv);
  const lineCount = csv.split('\n').length - 2;
  if (bytes.byteLength > EXTRACT_LIMITS.maxOrderReportBytes || lineCount > EXTRACT_LIMITS.maxOrderLines) {
    await record({ state: 'too_large' });
    return { state: 'too_large', orders: page.orders.length, staged: false };
  }
  const sha256 = sha256Hex(bytes);
  const storageKey = fileKey(job.orgId, sha256);
  const generation = await putFile(deps.store, storageKey, bytes, 'text/csv', sha256);
  // The same intake as an upload (source `upload`: the file-source CHECK has no source of its own for a platform's pull, and a new one would need a migration of the hot file table). The
  // content hash dedupes a page read twice, and the extraction job that the event queues stages it for a member. A throw here leaves the cursor where it was, so the retry reads the page again.
  const filed = await deps.runtime.execute<{ fileId: string; duplicate: boolean }>(
    'kernel.file.ingest',
    { filename: csvFilename(target.platform, job.connectionId, writable), contentType: 'text/csv', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload', legalEntityId: target.legalEntityId },
    options,
  );
  // Only now does the cursor move. A page that was already ingested hands nothing new to the Inbox.
  const state: MarketplacePollEnding = refused > 0 ? 'not_recognized' : 'ok';
  await record({ state, ...cursor });
  return { state, orders: filed.duplicate ? 0 : writable.length, staged: !filed.duplicate };
}

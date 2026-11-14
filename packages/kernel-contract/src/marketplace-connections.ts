// SPDX-License-Identifier: AGPL-3.0-only
// An org's connection to a marketplace (#2519, ADR-0045 point 7, plan stock-and-marketplaces.md section 8.7): what the Tích hợp card shows and what its commands take. The credential
// is sealed in the kernel and never in an answer, a log or an audit row; nothing here carries a buyer's data or a platform's own text, only ids, states and counts.
import { z } from 'zod';
import { zMarketplacePlatform } from './marketplace.ts';
import { zId } from './schemas.ts';

// What a connection test answers and how a poll ended: states, never the platform's own text. The same lists the port, the database's CHECKs and @crove/db keep.
export const MARKETPLACE_CONNECTION_STATES = ['works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable'] as const;
export const MARKETPLACE_POLL_STATE_KEYS = ['ok', 'unreachable', 'credentials', 'rate_limited', 'too_large', 'not_recognized'] as const;
export const zMarketplaceConnectionState = z.enum(MARKETPLACE_CONNECTION_STATES);
export const zMarketplacePollState = z.enum(MARKETPLACE_POLL_STATE_KEYS);
export type MarketplaceConnectionState = z.infer<typeof zMarketplaceConnectionState>;
export type MarketplacePollState = z.infer<typeof zMarketplacePollState>;

// An adapter this deployment offers: its id, whether it is the offline one (no host, nothing sent), the fields its connect form asks for (their names) and the platforms it serves.
export const zMarketplaceAdapterInfo = z.object({ id: z.string(), offline: z.boolean(), connectFields: z.array(z.string()), platforms: z.array(zMarketplacePlatform) });
export type MarketplaceAdapterInfo = z.infer<typeof zMarketplaceAdapterInfo>;

// Every platform Ludy reads, whether an adapter serves it on this deployment or not. `adapter: false` means the org brings the platform's report as a file (the screen says "nhập file báo cáo").
export const zMarketplacePlatformInfo = z.object({ platform: zMarketplacePlatform, adapter: z.boolean(), adapters: z.array(z.string()) });
export type MarketplacePlatformInfo = z.infer<typeof zMarketplacePlatformInfo>;

export const zMarketplaceProviders = z.object({ adapters: z.array(zMarketplaceAdapterInfo), platforms: z.array(zMarketplacePlatformInfo) });
export type MarketplaceProviders = z.infer<typeof zMarketplaceProviders>;

export const zMarketplaceConnection = z.object({
  id: zId,
  // The channel connection that holds the sealed credential. The credential itself is never in any answer.
  connectionId: zId,
  legalEntityId: zId,
  // The adapter's channel provider id (`marketplace_sandbox`).
  provider: z.string(),
  platform: zMarketplacePlatform,
  displayName: z.string(),
  status: z.enum(['active', 'expired', 'revoked', 'error']),
  lastTestState: zMarketplaceConnectionState.nullable(),
  lastTestedAt: z.iso.datetime({ offset: true }).nullable(),
  lastPolledAt: z.iso.datetime({ offset: true }).nullable(),
  lastPollState: zMarketplacePollState.nullable(),
  // The orders waiting in the Inbox for a member to confirm or reject, counted from the staged files this connection's polls ingested.
  ordersWaiting: z.number().int().nonnegative(),
});
export type MarketplaceConnection = z.infer<typeof zMarketplaceConnection>;

// The names are the adapter's; each value is a secret the org typed once, sealed at the edge and never shown back. The offline adapter has none.
export const zMarketplaceConnectFields = z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), z.string().min(1).max(500)).refine((fields) => Object.keys(fields).length <= 10);
export const zMarketplaceConnect = z.strictObject({
  adapter: z.string().regex(/^[a-z][a-z0-9_]{0,21}$/),
  platform: zMarketplacePlatform,
  // Left out, the org's default entity.
  legalEntityId: zId.nullable(),
  fields: zMarketplaceConnectFields,
});
export type MarketplaceConnect = z.infer<typeof zMarketplaceConnect>;

// The command that records a connection test: a state, nothing else.
export const zMarketplaceConnectionRecordTest = z.strictObject({ id: zId, state: zMarketplaceConnectionState });
export const zMarketplaceConnectionTested = z.object({ state: zMarketplaceConnectionState });
export type MarketplaceConnectionTested = z.infer<typeof zMarketplaceConnectionTested>;

// The command that records a poll: the cursor the next poll resumes from (moved only after the page was ingested) and how it ended. What waits in the Inbox is counted when the list is read.
export const zMarketplaceConnectionRecordPoll = z.strictObject({
  id: zId,
  state: zMarketplacePollState,
  // Left out, the cursor stays where it was (a failed poll never moves it).
  cursor: z.string().min(1).max(200).nullable().optional(),
});

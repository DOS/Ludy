// SPDX-License-Identifier: AGPL-3.0-only
// An org's connection to a marketplace (#2519, ADR-0045 point 7, plan stock-and-marketplaces.md section 8.7): what the Tích hợp card shows and what its commands take. The credential
// is sealed in the kernel and never in an answer, a log or an audit row; nothing here carries a buyer's data or a platform's own text, only ids, states and counts.
import { z } from 'zod';
import { zMarketplacePlatform } from './marketplace.ts';
import { zId } from './schemas.ts';

// What a connection test answers and how a poll ended: states, never the platform's own text. The same lists the port, the database's CHECKs and @crove/db keep.
export const MARKETPLACE_CONNECTION_STATES = ['works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable'] as const;
export const MARKETPLACE_POLL_STATE_KEYS = ['ok', 'unreachable', 'credentials', 'rate_limited', 'too_large', 'not_recognized'] as const;
export const MARKETPLACE_AUTHORIZE_STATE_KEYS = ['pending', 'authorized', 'refused', 'failed'] as const;
export const zMarketplaceAuthorizeState = z.enum(MARKETPLACE_AUTHORIZE_STATE_KEYS);
export type MarketplaceAuthorizeState = z.infer<typeof zMarketplaceAuthorizeState>;
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
  // Where the seller's authorization stands (#4238): a code is waiting for the worker, it worked, Lazada refused the code, or the exchange failed. Null: never started.
  authorizeState: zMarketplaceAuthorizeState.nullable(),
  // When the refresh token ends (a date, never a token): after it the seller authorizes again. Null until an authorization worked.
  reauthorizeBy: z.iso.datetime({ offset: true }).nullable(),
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
// What the test button gets back: the state at once for the offline adapter (tested at the API), or `queued` for an adapter that reaches the platform (the worker tests it and records the state, which the list shows).
export const zMarketplaceConnectionTestAnswer = z.union([zMarketplaceConnectionTested, z.strictObject({ queued: z.literal(true) })]);
export type MarketplaceConnectionTestAnswer = z.infer<typeof zMarketplaceConnectionTestAnswer>;

// The command the poll files a page of orders with (#4250, step 2 of the link table of #2840 point 3): the file of the page, as the same intake as an upload takes it, and the connection that polled it. The
// entity and the source are the connection's and fixed, never the caller's: the command reads the entity from the connection row and the file is always an upload of text/csv.
export const zMarketplaceIngestPage = z.strictObject({
  marketplaceConnectionId: zId,
  filename: z.string().min(1).max(255),
  contentType: z.literal('text/csv'),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storageKey: z.string().min(1).max(500),
  // The content generation the store answered (the intake checks its form).
  generation: z.string().min(1).max(200),
});
export type MarketplaceIngestPage = z.infer<typeof zMarketplaceIngestPage>;
export interface MarketplacePageIngested {
  fileId: string;
  duplicate: boolean;
}

// The command that records a poll: the cursor the next poll resumes from (moved only after the page was ingested) and how it ended. What waits in the Inbox is counted when the list is read.
export const zMarketplaceConnectionRecordPoll = z.strictObject({
  id: zId,
  state: zMarketplacePollState,
  // Left out, the cursor stays where it was (a failed poll never moves it).
  cursor: z.string().min(1).max(200).nullable().optional(),
});

// The seller's authorization of a connection (#4238): a state the API makes (random, only its hash is stored), the one-time code the callback brings (sealed at the API edge) and what the worker records.
export const zMarketplaceStateHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const zMarketplaceAuthorizeBegin = z.strictObject({ id: zId, stateHash: zMarketplaceStateHash });
export const zMarketplaceAuthorizeBegun = z.object({ appKey: z.string(), expiresAt: z.iso.datetime({ offset: true }) });
export type MarketplaceAuthorizeBegun = z.infer<typeof zMarketplaceAuthorizeBegun>;
export const zMarketplaceAuthorizeLookup = z.strictObject({ stateHash: zMarketplaceStateHash });
export const zMarketplaceAuthorizeFinish = z.strictObject({ stateHash: zMarketplaceStateHash, codeKeyId: z.string().min(1).max(64), codeEnvelope: z.string().min(1).max(8000) });
// `codeDigest` names the code the outcome is for (the SHA-256 of its sealed envelope, as authorize_target gave it): an outcome for a code that was replaced meanwhile is not recorded.
export const zMarketplaceAuthorizeRecord = z.strictObject({ id: zId, codeDigest: z.string().regex(/^[0-9a-f]{64}$/), outcome: z.enum(['refused', 'failed']) });
// A good exchange is recorded together with the new credential, in one command (one transaction): the worker's sealed secret replaces the connection's credential only if the connection was not touched since
// the worker read it (`ifVersion`, the channel connection's own version), and the same transaction marks the authorization done. `expiresAt` is the access token's end (the refresh sweep reads it).
export const zMarketplaceAuthorizeComplete = z.strictObject({
  id: zId,
  codeDigest: z.string().regex(/^[0-9a-f]{64}$/),
  ifVersion: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  reauthorizeBy: z.iso.datetime({ offset: true }).nullable(),
  credential: z.strictObject({ keyId: z.string().min(1).max(64), envelope: z.string().min(1).max(8000) }),
});

// The seller's browser, on its way out and back (#4238): the address of the platform's consent page, and what the platform returns the seller to the app with (the state it was given and the one-time code).
export const zMarketplaceAuthorizeStarted = z.object({ authorizeUrl: z.url(), expiresAt: z.iso.datetime({ offset: true }) });
export type MarketplaceAuthorizeStarted = z.infer<typeof zMarketplaceAuthorizeStarted>;
export const zMarketplaceAuthorizeReturn = z.strictObject({ state: z.string().min(16).max(200), code: z.string().min(1).max(400) });
export type MarketplaceAuthorizeReturn = z.infer<typeof zMarketplaceAuthorizeReturn>;

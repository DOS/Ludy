// SPDX-License-Identifier: AGPL-3.0-only
// The writer of an ad platform (ADR-0043, plan docs/plan/ads-write.md, issues #2294 and #2296): what runs ads for an ad account, apart from the
// readers of index.ts (`AdPlatform`), which only read reports. A writer works with the token of a WRITE connection (provider
// `metawrite_ads`, `sandboxwrite_ads`), never with the reader's token, and it is not in the readers' registry (`adPlatforms()`
// does not know it, and no sync job, queue or event reaches it). W0b gave it one capability that changes nothing: `verify` says
// whether the sealed token could run ads on an account. W2 adds `revokeToken` first (the permission at the platform is removed whenever a
// write connection is closed, so no spend path exists without it) and, in its later slices, the methods that create or change a campaign.
// There is no method that deletes an ad object, and none will be added: archiving is a status.

// The answer of `verify`: whether the token could change the campaigns of the account, and the permissions it holds (the
// scopes the platform reports, not the ones asked for).
export interface AdWriterVerification {
  canRunAds: boolean;
  scopes: readonly string[];
}

// The answer of `revokeToken`, how the platform's copy of the permission ended.
// - `revoked`: the platform removed every permission the person gave the app (the person's, for the app, across every org that uses the app).
// - `already_invalid`: the person removed the app at the platform (Meta: error 190, subcode 458), perhaps by an earlier revoke made with another token of the
//   same person, so no token of that grant can spend any more. A token the platform refuses for another reason (expired, invalidated, password changed)
//   is not this: the grant may still stand, and the call throws a `token_expired` error instead.
// - `sandbox`: the offline sandbox has no platform copy.
export interface AdWriterRevocation {
  how: 'revoked' | 'already_invalid' | 'sandbox';
}

export interface AdWriter {
  // The provider id of the write connections this writer works with.
  readonly provider: string;
  // Whether the sealed token (`secret`, opened by the caller, never stored or logged here) could run ads on the account, checked
  // without changing anything. A failure is an `AdPlatformError` as for the readers (a refused token, a missing permission, an
  // account the token does not reach).
  verify(secret: string, account: { externalAccountId: string }): Promise<AdWriterVerification>;
  // Removes at the platform the permissions the token's person gave the app, so no token of that grant can change a campaign any more
  // (ADR-0043 point 4). Called by the worker from the queue, after the closing of the connection committed, never inside a command. A
  // failure is an `AdPlatformError` (`rate_limited` carries the time to wait; `transient` is worth another try).
  revokeToken(secret: string): Promise<AdWriterRevocation>;
}

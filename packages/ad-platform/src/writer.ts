// SPDX-License-Identifier: AGPL-3.0-only
// The writer of an ad platform (ADR-0043, plan docs/plan/ads-write.md, issue #2294): what runs ads for an ad account, apart from the
// readers of index.ts (`AdPlatform`), which only read reports. A writer works with the token of a WRITE connection (provider
// `metawrite_ads`, `sandboxwrite_ads`), never with the reader's token, and it is not in the readers' registry (`adPlatforms()`
// does not know it, and no sync job, queue or event reaches it). W0b gives it one capability that changes nothing: `verify` says
// whether the sealed token could run ads on an account. The methods that create or change a campaign join it in slice W2.

// The answer of `verify`: whether the token could change the campaigns of the account, and the permissions it holds (the
// scopes the platform reports, not the ones asked for).
export interface AdWriterVerification {
  canRunAds: boolean;
  scopes: readonly string[];
}

export interface AdWriter {
  // The provider id of the write connections this writer works with.
  readonly provider: string;
  // Whether the sealed token (`secret`, opened by the caller, never stored or logged here) could run ads on the account, checked
  // without changing anything. A failure is an `AdPlatformError` as for the readers (a refused token, a missing permission, an
  // account the token does not reach).
  verify(secret: string, account: { externalAccountId: string }): Promise<AdWriterVerification>;
}

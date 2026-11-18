// SPDX-License-Identifier: AGPL-3.0-only
// Whether this deployment can carry out a launch on an ad account's provider (#3675). A launch is carried out only where a launch writer was built for the
// account's write connection (kernel.ts `adWritersOf`: the offline sandbox's when ADS_SANDBOX is on, Meta's only with the write app AND ADS_LIVE_LAUNCH, which a
// public deployment refuses); on any other provider an approved plan stays queued with its amount held and nothing is created. The approval card asks this so
// it never promises a launch the server will not make. It takes provider ids only: no secret and no writer object reaches the answer.
import { READ_PROVIDER_OF_WRITE, isAdWriteProviderId } from '@crove/kernel-contract';

// `launchProviders`: the provider ids of the write connections this deployment has a launch writer for. `provider`: the ad account's own (read) provider id.
// null: the account's provider is unknown to the caller (an entity-limited approver does not read the account), so nothing is claimed either way.
export function adLaunchCapable(launchProviders: readonly string[], provider: string | null): boolean | null {
  if (provider === null) return null;
  return launchProviders.some((writeProvider) => isAdWriteProviderId(writeProvider) && READ_PROVIDER_OF_WRITE[writeProvider] === provider);
}

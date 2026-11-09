// SPDX-License-Identifier: AGPL-3.0-only
// The name of a platform on the Sàn screen (#2516 slice D): the three the importer knows come from the messages, a later platform id is shown as it is.
import { MARKETPLACE_PLATFORM_KEYS } from '@crove/kernel-contract';

export function platformLabel(platform: string, known: (key: (typeof MARKETPLACE_PLATFORM_KEYS)[number]) => string): string {
  return (MARKETPLACE_PLATFORM_KEYS as readonly string[]).includes(platform) ? known(platform as (typeof MARKETPLACE_PLATFORM_KEYS)[number]) : platform;
}

// SPDX-License-Identifier: AGPL-3.0-only
// What the API does around a member's minutes webhook (meetings integrations A6, issue #3164), because a command makes no network call and holds no key: the secret is made here, sealed with the
// credential broker bound to the org, the purpose and the member, and handed to the command as an envelope; the clear value goes back to the person who asked, once, and to nothing else (no command
// input of ours keeps it, no audit row, no log). The address is looked up before the command runs (assertWakeHostPublic of the wake-up, the same rule); the egress guard checks it again on every send.
import { randomBytes } from 'node:crypto';
import { DomainError, type CredentialBroker } from '@crove/kernel-runtime';
import type { MeetingHookCredential } from '@crove/kernel-contract';

// The provider name a minutes-webhook secret is sealed under (with the org and the member), so it opens for nothing else.
export const MEETING_HOOK_PROVIDER = 'meeting-hook';

export interface MadeHookSecret {
  // Shown once to the person who asked, never stored in the clear.
  secret: string;
  credential: MeetingHookCredential;
}

// A secret of 32 random bytes with a "whsec_" prefix a receiver's config can recognise, and a public id ("whk_" and eight hex digits) that says which secret signed.
export function makeHookSecret(broker: CredentialBroker, orgId: string, userId: string): MadeHookSecret {
  if (broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
  const secret = `whsec_${randomBytes(32).toString('base64url')}`;
  const sealed = broker.seal(secret, { orgId, provider: MEETING_HOOK_PROVIDER, externalAccountId: userId });
  return { secret, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64'), hint: `whk_${randomBytes(4).toString('hex')}` } };
}

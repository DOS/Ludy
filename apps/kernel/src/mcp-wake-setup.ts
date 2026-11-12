// SPDX-License-Identifier: AGPL-3.0-only
// What the API does around the wake-up commands (ADR-0051 decision 4, issue #3024, step a), because a command makes no network call and holds no key:
// - the secret: made here, sealed with the credential broker bound to the org, the grant and the purpose, and handed to the command as an envelope; the clear
//   value goes back to the person who asked, once, and to nothing else (no command input of ours keeps it, no audit row, no log);
// - the receiver's name: looked up before the command runs, and every address it resolves to must be public, so an owner is told at once. The egress guard checks it
//   again on every send, so this is a courtesy and never the protection.
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { DomainError, isPublicAddress, type CredentialBroker } from '@crove/kernel-runtime';
import { MCP_WAKE_PROVIDER, type McpWakeCredential } from '@crove/kernel';

export interface MadeWakeSecret {
  // Shown once to the person who asked, never stored in the clear.
  secret: string;
  credential: McpWakeCredential;
}

// A secret of 32 random bytes with a "whsec_" prefix a receiver's config can recognise, and a public id ("whk_" and eight hex digits) that says which secret signed.
export function makeWakeSecret(broker: CredentialBroker, orgId: string, grantId: string): MadeWakeSecret {
  if (broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
  const secret = `whsec_${randomBytes(32).toString('base64url')}`;
  const sealed = broker.seal(secret, { orgId, provider: MCP_WAKE_PROVIDER, externalAccountId: grantId });
  return { secret, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64'), hint: `whk_${randomBytes(4).toString('hex')}` } };
}

export type WakeResolve = (host: string) => Promise<{ address: string }[]>;
const systemResolve: WakeResolve = (host) => lookup(host, { all: true });

// Refuses a receiver whose name does not resolve, or resolves to any address that is not public. Answers 422 with one plain line either way.
export async function assertWakeHostPublic(raw: string, resolve: WakeResolve = systemResolve): Promise<void> {
  const refusal = new DomainError('INVALID', 422, 'Không gửi được tới địa chỉ nhận này: tên miền không tìm thấy hoặc trỏ vào mạng nội bộ');
  let answers: { address: string }[];
  try {
    answers = await Promise.race([
      resolve(new URL(raw).hostname),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref()),
    ]);
  } catch {
    throw refusal;
  }
  if (answers.length === 0 || answers.some((a) => !isPublicAddress(a.address))) throw refusal;
}

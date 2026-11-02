// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox of running ads (ADR-0043, issue #2294, W0b): the write connection of a sandbox ad account, with no network, so
// the connect and verify flow runs on a laptop and in tests. Its token is random, sealed like any other, and its own: the secret
// of the write connection is `{ accessToken: 'sbxw_...', accountId, currency }`, never the secret of the read connection (which
// holds a `sbx_` token and the key its account id derives from), so the reader's derivation of figures stays as it is and one
// connection's secret opens nothing of the other's. The kernel never opens either secret on the API side; the writer is called
// by a job or a command that was handed the opened one.
import { randomBytes } from 'node:crypto';
import type { ConnectedAccount } from '@crove/channel';
import { AdPlatformError, SANDBOX_CURRENCIES, type SandboxCurrency } from './index.ts';
import type { AdWriter, AdWriterVerification } from './writer.ts';

export const SANDBOX_WRITE_PROVIDER = 'sandboxwrite_ads' as const;
// The permissions this connection holds, as the real one's do (the read scope and the one that can change campaigns).
export const SANDBOX_WRITE_SCOPES = ['ads_read', 'ads_management'] as const;

const WRITE_TOKEN = /^sbxw_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface SandboxWriteSecret {
  accessToken: string;
  // The ad account this token can run ads on: the id of the read connection's account.
  accountId: string;
  currency: SandboxCurrency;
}

// A secret that is not this sandbox's write secret (garbled, the reader's, another provider's) is a refused token.
function parseSecret(secret: string): SandboxWriteSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new AdPlatformError('token_expired', 'BAD_SECRET');
  }
  const { accessToken, accountId, currency } = (parsed ?? {}) as { accessToken?: unknown; accountId?: unknown; currency?: unknown };
  if (typeof accessToken !== 'string' || !WRITE_TOKEN.test(accessToken) || typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId) || !(SANDBOX_CURRENCIES as readonly unknown[]).includes(currency)) {
    throw new AdPlatformError('token_expired', 'BAD_SECRET');
  }
  return { accessToken, accountId, currency: currency as SandboxCurrency };
}

export interface SandboxWriteLoginInput {
  // The ad account the read connection linked (its `externalAccountId`): the write connection is keyed by the same id.
  externalAccountId: string;
  // The account's currency as the read connection recorded it (a text from the database): only VND and USD are the sandbox's, any
  // other is refused here.
  currency: string;
  displayName?: string;
}

// What a connect needs for the write connection of a sandbox account: the connected account (provider, id, name, scopes) and the
// secret the caller seals with the credential broker and drops. Every call draws a new token, so connecting again replaces the
// sealed one.
export function sandboxWriteLogin(input: SandboxWriteLoginInput): ConnectedAccount {
  if (!ACCOUNT_ID.test(input.externalAccountId)) throw new Error('sandbox ad writer: invalid account id');
  const currency = (SANDBOX_CURRENCIES as readonly string[]).find((c) => c === input.currency);
  if (currency === undefined) throw new Error('sandbox ad writer: unknown currency');
  const accessToken = `sbxw_${randomBytes(32).toString('base64url')}`;
  const secret = JSON.stringify({ accessToken, accountId: input.externalAccountId, currency: currency as SandboxCurrency } satisfies SandboxWriteSecret);
  return {
    provider: SANDBOX_WRITE_PROVIDER,
    externalAccountId: input.externalAccountId,
    displayName: (input.displayName ?? `Sandbox ads ${input.currency} (running ads)`).slice(0, 200),
    scopes: [...SANDBOX_WRITE_SCOPES],
    expiresAt: null,
    secret,
  };
}

// Opens nothing remote: it reads the secret, checks that it is for this account, and answers that it can run ads.
export const sandboxAdWriter = {
  provider: SANDBOX_WRITE_PROVIDER,
  async verify(secret: string, account: { externalAccountId: string }): Promise<AdWriterVerification> {
    const { accountId } = parseSecret(secret);
    // A token that does not reach this account is a missing permission, as the real platform says it.
    if (accountId !== account.externalAccountId) throw new AdPlatformError('permission', 'ACCOUNT_NOT_REACHED');
    return { canRunAds: true, scopes: [...SANDBOX_WRITE_SCOPES] };
  },
} satisfies AdWriter;

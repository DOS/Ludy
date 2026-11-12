// SPDX-License-Identifier: AGPL-3.0-only
// The API's side of the wake-up setup (ADR-0051 decision 4, issue #3024): the secret it makes and seals, and the look-up of the receiver's name.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialVault, DomainError, parseVaultKey } from '@crove/kernel-runtime';
import { WAKE_PROVIDER, assertWakeHostPublic, makeWakeSecret } from '../src/mcp-wake-setup.ts';
import { noCredentialBroker } from '../src/credentials.ts';

const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);

describe('the wake-up secret', () => {
  it('is 32 random bytes with a recognisable prefix and a public id, sealed for the org and the grant', () => {
    const org = randomUUID();
    const grant = randomUUID();
    const made = makeWakeSecret(vault, org, grant);
    expect(made.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(made.credential.hint).toMatch(/^whk_[0-9a-f]{8}$/);
    expect(made.credential.envelope).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // The envelope opens to the secret with its own binding and with none other: another grant, another org or another provider name.
    const sealed = { keyId: made.credential.keyId, envelope: Buffer.from(made.credential.envelope, 'base64') };
    expect(vault.open(sealed, { orgId: org, provider: WAKE_PROVIDER, externalAccountId: grant })).toBe(made.secret);
    expect(() => vault.open(sealed, { orgId: org, provider: WAKE_PROVIDER, externalAccountId: randomUUID() })).toThrow();
    expect(() => vault.open(sealed, { orgId: randomUUID(), provider: WAKE_PROVIDER, externalAccountId: grant })).toThrow();
    expect(() => vault.open(sealed, { orgId: org, provider: 'telegram', externalAccountId: grant })).toThrow();
    // The envelope and the hint carry nothing of the secret in the clear.
    expect(made.credential.envelope).not.toContain(made.secret);
    expect(Buffer.from(made.credential.envelope, 'base64').toString('latin1')).not.toContain(made.secret.slice(6, 20));
  });

  it('is new every time, and refused when the deployment has no credential key', () => {
    const grant = randomUUID();
    const a = makeWakeSecret(vault, randomUUID(), grant);
    const b = makeWakeSecret(vault, randomUUID(), grant);
    expect(a.secret).not.toBe(b.secret);
    expect(a.credential.hint).not.toBe(b.credential.hint);
    expect(() => makeWakeSecret(noCredentialBroker, randomUUID(), grant)).toThrow(/CREDENTIAL_KEY/);
  });
});

describe('looking up the receiver\'s name', () => {
  const refuses = async (resolve: (host: string) => Promise<{ address: string }[]>) => {
    const error = await assertWakeHostPublic('https://hooks.example.com/x', resolve).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(422);
  };

  it('accepts a name whose every address is public, and looks the host up (not the path)', async () => {
    const asked: string[] = [];
    await assertWakeHostPublic('https://hooks.example.com/ludy/token?x=1', async (host) => {
      asked.push(host);
      return [{ address: '93.184.216.34' }, { address: '2606:2800:220:1:248:1893:25c8:1946' }];
    });
    expect(asked).toEqual(['hooks.example.com']);
  });

  it('refuses a name that resolves to nothing, to a private, loopback, link-local or metadata address, to any such address among public ones, or that fails or hangs', async () => {
    await refuses(async () => []);
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      await refuses(async () => [{ address }]);
      await refuses(async () => [{ address: '93.184.216.34' }, { address }]);
    }
    await refuses(async () => {
      throw new Error('ENOTFOUND');
    });
  });
});

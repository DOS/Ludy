// SPDX-License-Identifier: AGPL-3.0-only
// A deployment that signs people in at a remote Supabase-compatible identity provider (issue #2704, ADR-0027 and ADR-0028
// section 1): tokens verified against its JWKS (ES256), and AUTH_ALLOWED_EMAILS, the list of who may use the deployment
// when that provider serves other people too. The provider here is a made-up issuer; no real address or key appears.
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@crove/db';
import { createAuthenticator, createTokenVerifier } from '../src/auth.ts';
import { createEmailAccess, parseAllowedEmails } from '../src/auth-access.ts';
import { loadConfig } from '../src/config.ts';

const ISSUER = 'https://idp.example.test/auth/v1';
const SESSION = '2d0c6f1e-5b7a-4c3d-9e8f-1a2b3c4d5e6f';
const SUBJECT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const BASE_ENV = {
  DATABASE_URL: 'postgres://localhost/x',
  PUBLIC_URL: 'https://api.example.test',
  AUTH_JWKS_URL: 'https://idp.example.test/auth/v1/.well-known/jwks.json',
  AUTH_ISSUER: ISSUER,
  AUTH_SESSION_CHECK: 'jwt',
  PUBLIC_AUTH_URL: ISSUER,
  PUBLIC_AUTH_ANON_KEY: 'sb_publishable_placeholder',
};

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey as CryptoKey;
  otherKey = (await generateKeyPair('ES256')).privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

async function token(claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; kid?: string; alg?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER,
    aud: 'authenticated',
    sub: SUBJECT,
    iat: now,
    exp: now + 900,
    role: 'authenticated',
    email: 'owner@example.test',
    session_id: SESSION,
    aal: 'aal1',
    is_anonymous: false,
    ...claims,
  })
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: opts.kid ?? 'k1' })
    .sign(opts.key ?? signingKey);
}

const verifierFor = (extra: Record<string, string> = {}) => createTokenVerifier(loadConfig({ ...BASE_ENV, ...extra }), { jwks });

describe('tokens of a remote identity provider (JWKS)', () => {
  it('accepts a token of the configured issuer and audience', async () => {
    await expect(verifierFor()(await token())).resolves.toMatchObject({ issuer: ISSUER, subject: SUBJECT, email: 'owner@example.test' });
  });

  it.each([
    ['another issuer', { iss: 'https://other.example.test/auth/v1' }],
    ['another audience', { aud: 'someone-else' }],
    ['an expiry in the past', { exp: Math.floor(Date.now() / 1000) - 120 }],
    ['no session_id', { session_id: undefined }],
  ])('refuses a token with %s as 401', async (_label, claims) => {
    await expect(verifierFor()(await token(claims))).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('refuses a token signed by another key, even under a known kid, and an unknown kid', async () => {
    const verify = verifierFor();
    await expect(verify(await token({}, { key: otherKey }))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await token({}, { kid: 'unknown' }))).rejects.toMatchObject({ status: 401 });
  });

  it('refuses an HS256 token when a JWKS is configured', async () => {
    const hs = await new SignJWT({ iss: ISSUER, aud: 'authenticated', sub: SUBJECT, exp: Math.floor(Date.now() / 1000) + 60, role: 'authenticated', email: 'a@example.test', session_id: SESSION })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('x'.repeat(40)));
    await expect(verifierFor()(hs)).rejects.toMatchObject({ status: 401 });
  });
});

describe('the session check default (compose passes AUTH_SESSION_CHECK empty)', () => {
  it('is jwt without a bundled Supabase Auth and db with one, whatever an empty line says', () => {
    const { AUTH_SESSION_CHECK: _unused, ...rest } = BASE_ENV;
    expect(loadConfig({ ...rest, AUTH_SESSION_CHECK: '', AUTH_UPSTREAM_URL: '' }).AUTH_SESSION_CHECK).toBe('jwt');
    expect(loadConfig({ ...rest, AUTH_SESSION_CHECK: '', AUTH_UPSTREAM_URL: 'http://auth:9999' }).AUTH_SESSION_CHECK).toBe('db');
    expect(() => loadConfig({ ...rest, AUTH_SESSION_CHECK: 'nonsense' })).toThrow(/AUTH_SESSION_CHECK/);
  });
});

describe('AUTH_ALLOWED_EMAILS', () => {
  it('parses addresses and @domains, lower-cases, de-duplicates and names the invalid entries', () => {
    expect(parseAllowedEmails('Owner@Example.test, @example.org  owner@example.test')).toEqual({ entries: ['owner@example.test', '@example.org'], invalid: [] });
    const { invalid } = parseAllowedEmails('example.org @ a@ @b a@b@c.test a..b@c.test a@c.test@ ünï@c.test @localhost');
    expect(invalid).toHaveLength(9);
  });

  it('fails the boot on an entry that is neither an address nor an @domain', () => {
    expect(() => loadConfig({ ...BASE_ENV, AUTH_ALLOWED_EMAILS: 'owner@example.test, example.org' })).toThrow(/AUTH_ALLOWED_EMAILS/);
    expect(loadConfig({ ...BASE_ENV, AUTH_ALLOWED_EMAILS: ' ' }).AUTH_ALLOWED_EMAILS).toEqual([]);
    // Set but listing nobody does not mean "everyone": the boot stops.
    for (const empty of [',', ', ,', ' , ']) expect(() => loadConfig({ ...BASE_ENV, AUTH_ALLOWED_EMAILS: empty }), empty).toThrow(/lists no address/);
    expect(loadConfig(BASE_ENV).AUTH_ALLOWED_EMAILS).toEqual([]);
  });

  it('lets every address through when unset, whatever email_verified says', async () => {
    const verify = verifierFor();
    await expect(verify(await token({ email: 'anyone@example.net', user_metadata: { email_verified: false } }))).resolves.toMatchObject({ email: 'anyone@example.net' });
  });

  it('accepts a listed address (any letter case) and a listed domain, and nothing else', async () => {
    const verify = verifierFor({ AUTH_ALLOWED_EMAILS: 'owner@example.test, @partner.test' });
    await expect(verify(await token())).resolves.toMatchObject({ email: 'owner@example.test' });
    await expect(verify(await token({ email: 'Owner@Example.TEST' }))).resolves.toBeTruthy();
    await expect(verify(await token({ email: 'anyone@partner.test' }))).resolves.toBeTruthy();
    for (const email of ['other@example.test', 'owner@example.test.evil.test', 'anyone@sub.partner.test', 'a@evil.test@partner.test', 'owner+tag@example.test']) {
      await expect(verify(await token({ email }))).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_NOT_ALLOWED' });
    }
  });

  it('refuses a listed address whose provider says it is not verified, and keeps a missing flag working', async () => {
    const verify = verifierFor({ AUTH_ALLOWED_EMAILS: 'owner@example.test' });
    await expect(verify(await token({ user_metadata: { email_verified: false } }))).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_NOT_ALLOWED' });
    await expect(verify(await token({ user_metadata: { email_verified: true } }))).resolves.toBeTruthy();
    await expect(verify(await token())).resolves.toBeTruthy();
  });

  it('still refuses a bad token first, with 401, even for a listed address', async () => {
    const verify = verifierFor({ AUTH_ALLOWED_EMAILS: 'owner@example.test' });
    await expect(verify(await token({}, { key: otherKey }))).rejects.toMatchObject({ status: 401 });
  });

  it('refuses before any database work: a refused address creates no user account', async () => {
    const touched: string[] = [];
    const db = new Proxy({}, { get: (_t, prop) => (touched.push(String(prop)), () => { throw new Error('database used'); }) }) as unknown as Db;
    const config = loadConfig({ ...BASE_ENV, AUTH_ALLOWED_EMAILS: 'owner@example.test' });
    const authenticate = createAuthenticator(config, db, createTokenVerifier(config, { jwks }), null);
    await expect(authenticate(`Bearer ${await token({ email: 'stranger@example.net' })}`)).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_NOT_ALLOWED' });
    expect(touched).toEqual([]);
  });

  it('allows everything for an empty list', () => {
    expect(() => createEmailAccess([])('anyone@example.net', false)).not.toThrow();
  });
});

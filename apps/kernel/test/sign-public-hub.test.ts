// SPDX-License-Identifier: AGPL-3.0-only
// Unit and route tests for public eSign hub IP bucket normalization (#4636):
// templateBucketOf collapses IPv6 addresses within the same /64 and IPv4-mapped IPv6 addresses with plain IPv4
// via clientBucket(ip ?? null) before hashing, while SQL audit attribution in ludy_sign.public_hub_start keeps signIpHash(meta.ip) unchanged.
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type Driver, type QueryResult } from 'kysely';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { contentGeneration, sha256Hex, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { signIpHash, type SignBilling } from '../src/sign-link.ts';
import { resolvePublicHubPdf, runSignPublicHubAction, templateBucketOf } from '../src/sign-public-hub.ts';

const ORG_ID = '01900000-0000-7000-8000-000000000010';
const DIRECT_LINK_ID = '01900000-0000-7000-8000-000000000020';
const TEMPLATE_ID = '01900000-0000-7000-8000-000000000030';
const TEMPLATE_ID_B = '01900000-0000-7000-8000-000000000031';
const ENVELOPE_ID = '01900000-0000-7000-8000-000000000040';
const SIGNER_ID = '01900000-0000-7000-8000-000000000050';
const TOKEN_ID = '01900000-0000-7000-8000-000000000060';
const ORG_SLUG = 'acme-sign';

const PDF_BYTES = Uint8Array.from(Buffer.from('%PDF-1.4\n% hub-bucket-test\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8'));
const PDF_SHA256 = sha256Hex(PDF_BYTES);
const PDF_GEN = contentGeneration(PDF_SHA256);
const PDF_KEY = `org/${ORG_ID}/${PDF_SHA256}`;

interface RecordedSql {
  sql: string;
  parameters: readonly unknown[];
}

function createHubDb(seen: RecordedSql[]) {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      seen.push({ sql: query.sql, parameters: query.parameters });
      if (query.sql.includes('ludy_sign.public_hub_resolve')) {
        return {
          rows: [
            {
              resolved: {
                orgId: ORG_ID,
                directLinkId: DIRECT_LINK_ID,
                templateId: String(query.parameters[1] ?? TEMPLATE_ID),
                state: 'ready',
                orgName: 'Acme Sign',
                title: 'NDA Standard',
                description: null,
                message: null,
                roleLabel: 'Signer',
                signerRole: 'signer',
                emailRequired: false,
                requireEmailOtp: false,
                otpVerified: false,
                verifiedEmail: null,
                pageCount: 1,
                pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842 }],
                fieldCount: 1,
                sharedSummary: null,
              },
            },
          ] as unknown as R[],
        };
      }
      if (query.sql.includes('ludy_sign.public_hub_pdf_source')) {
        return {
          rows: [
            {
              source: {
                orgId: ORG_ID,
                otpRequired: false,
                storageKey: PDF_KEY,
                generation: PDF_GEN,
                sha256: PDF_SHA256,
              },
            },
          ] as unknown as R[],
        };
      }
      if (query.sql.includes('ludy_sign.public_hub_start')) {
        return {
          rows: [
            {
              result: {
                status: 'ok',
                orgId: ORG_ID,
                templateId: String(query.parameters[1] ?? TEMPLATE_ID),
                directLinkId: DIRECT_LINK_ID,
                envelopeId: ENVELOPE_ID,
                signerId: SIGNER_ID,
                signingTokenId: TOKEN_ID,
                expiresAt: '2026-12-01T00:00:00.000Z',
              },
            },
          ] as unknown as R[],
        };
      }
      throw new Error(`Unexpected SQL in test: ${query.sql}`);
    },
    streamQuery: async function* () {
      yield* [];
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function createHubFixture(limits?: { actions?: RateLimiter; templateActions?: RateLimiter }) {
  const sqlSeen: RecordedSql[] = [];
  const runtime = {
    installed: () => true,
    modules: () => ['kernel', 'sign'],
    orgless: async <T>(fn: (db: Kysely<unknown>) => Promise<T>) => fn(createHubDb(sqlSeen)),
  } as unknown as Runtime;
  const billing: SignBilling = { entitlements: async () => ['sign'] };
  const store: BlobStore = {
    put: async () => PDF_GEN,
    get: async (key) => {
      if (key !== PDF_KEY) throw new Error(`missing blob: ${key}`);
      return PDF_BYTES;
    },
    delete: async () => {},
  };
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/x',
    AUTH_JWT_SECRET: 'x'.repeat(32),
    AUTH_ISSUER: 'ludy-auth',
    WEB_DIST: '/nonexistent',
    TRUSTED_PROXY_HOPS: '1',
  });
  const app = createHttpApp({
    config,
    runtime,
    store,
    authenticate: async () => {
      throw new Error('public hub must not authenticate');
    },
    pool: {} as pg.Pool,
    aiEnabled: false,
    billing,
    signPublicHubLimits: {
      actions: limits?.actions ?? new RateLimiter({ perMinute: 100 }),
      templateActions: limits?.templateActions ?? new RateLimiter({ perMinute: 30 }),
    },
  });
  return { app, runtime, billing, sqlSeen };
}

function postHub(app: ReturnType<typeof createHttpApp>, body: unknown, ip: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ip !== null) headers['x-forwarded-for'] = ip;
  return app.request(`/api/sign/public-hub/${ORG_SLUG}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('public eSign hub IP bucket normalization (#4636)', () => {
  it('collapses addresses in the same IPv6 /64 and IPv4-mapped IPv6 with plain IPv4 inside templateBucketOf', () => {
    const v6a = templateBucketOf('2001:db8:1:2::1', ORG_SLUG, TEMPLATE_ID);
    const v6b = templateBucketOf('2001:db8:1:2::abcd', ORG_SLUG, TEMPLATE_ID);
    const v6Bracketed = templateBucketOf('[2001:0DB8:0001:0002::99]', ORG_SLUG, TEMPLATE_ID);
    const v6Zoned = templateBucketOf('2001:db8:1:2::1%eth0', ORG_SLUG, TEMPLATE_ID);
    const v6Other64 = templateBucketOf('2001:db8:1:3::1', ORG_SLUG, TEMPLATE_ID);

    expect(v6a).toBe(v6b);
    expect(v6a).toBe(v6Bracketed);
    expect(v6a).toBe(v6Zoned);
    expect(v6a).not.toBe(v6Other64);
    expect(v6a).toMatch(new RegExp(`^hub:${ORG_SLUG}:${TEMPLATE_ID}:[0-9a-f]{64}$`));
    expect(v6a).not.toContain('2001:db8');

    const v4Mapped = templateBucketOf('::ffff:203.0.113.5', ORG_SLUG, TEMPLATE_ID);
    const v4MappedHex = templateBucketOf('::ffff:cb00:7105', ORG_SLUG, TEMPLATE_ID);
    const v4Plain = templateBucketOf('203.0.113.5', ORG_SLUG, TEMPLATE_ID);
    const v4Other = templateBucketOf('203.0.113.6', ORG_SLUG, TEMPLATE_ID);

    expect(v4Mapped).toBe(v4Plain);
    expect(v4MappedHex).toBe(v4Plain);
    expect(v4Plain).not.toBe(v4Other);
    expect(v4Plain).not.toContain('203.0.113.5');

    const missingNull = templateBucketOf(null, ORG_SLUG, TEMPLATE_ID);
    const missingUndefined = templateBucketOf(undefined, ORG_SLUG, TEMPLATE_ID);
    const missingEmpty = templateBucketOf('', ORG_SLUG, TEMPLATE_ID);
    const missingMalformed = templateBucketOf('not-an-ip', ORG_SLUG, TEMPLATE_ID);
    expect(missingNull).toBe(missingUndefined);
    expect(missingNull).toBe(missingEmpty);
    expect(missingNull).toBe(missingMalformed);
    expect(missingNull).not.toBe(v4Plain);

    expect(templateBucketOf('2001:db8:1:2::1', 'ACME-SIGN', TEMPLATE_ID.toUpperCase())).toBe(v6a);
    expect(templateBucketOf('2001:db8:1:2::1', ORG_SLUG, TEMPLATE_ID_B)).not.toBe(v6a);
  });

  it('shares rate-limit budget across same IPv6 /64 and ::ffff:IPv4 in resolvePublicHubPdf and runSignPublicHubAction while keeping signIpHash(meta.ip) raw for SQL audit', async () => {
    const { runtime, billing, sqlSeen } = createHubFixture();

    const pdfLimiter = new RateLimiter({ perMinute: 2 });
    const pdf1 = await resolvePublicHubPdf(runtime, billing, ORG_SLUG, { action: 'pdf', templateId: TEMPLATE_ID }, (b) => pdfLimiter.take(b), { ip: '2001:db8:1:2::1' });
    const pdf2 = await resolvePublicHubPdf(runtime, billing, ORG_SLUG, { action: 'pdf', templateId: TEMPLATE_ID }, (b) => pdfLimiter.take(b), { ip: '2001:db8:1:2::abcd' });
    const callsBeforeBlock = sqlSeen.length;
    const pdf3 = await resolvePublicHubPdf(runtime, billing, ORG_SLUG, { action: 'pdf', templateId: TEMPLATE_ID }, (b) => pdfLimiter.take(b), { ip: '2001:db8:1:2::dead:beef' });
    expect(pdf1.status).toBe('ok');
    expect(pdf2.status).toBe('ok');
    expect(pdf3.status).toBe('rate_limited');
    expect(sqlSeen.length).toBe(callsBeforeBlock);

    const pdfOther64 = await resolvePublicHubPdf(runtime, billing, ORG_SLUG, { action: 'pdf', templateId: TEMPLATE_ID }, (b) => pdfLimiter.take(b), { ip: '2001:db8:1:3::1' });
    expect(pdfOther64.status).toBe('ok');

    const actionLimiter = new RateLimiter({ perMinute: 2 });
    const act1 = await runSignPublicHubAction(
      runtime,
      billing,
      ORG_SLUG,
      { action: 'view', templateId: TEMPLATE_ID },
      { ip: '::ffff:203.0.113.5', userAgent: 'test-agent' },
      { limitTemplate: (b) => actionLimiter.take(b) },
    );
    const act2 = await runSignPublicHubAction(
      runtime,
      billing,
      ORG_SLUG,
      { action: 'view', templateId: TEMPLATE_ID },
      { ip: '203.0.113.5', userAgent: 'test-agent' },
      { limitTemplate: (b) => actionLimiter.take(b) },
    );
    const act3 = await runSignPublicHubAction(
      runtime,
      billing,
      ORG_SLUG,
      { action: 'view', templateId: TEMPLATE_ID },
      { ip: '::ffff:cb00:7105', userAgent: 'test-agent' },
      { limitTemplate: (b) => actionLimiter.take(b) },
    );
    expect(act1.status).toBe('ok');
    expect(act2.status).toBe('ok');
    expect(act3.status).toBe('rate_limited');

    // SQL audit attribution in ludy_sign.public_hub_start must retain raw signIpHash(meta.ip).
    sqlSeen.length = 0;
    const startIps = ['2001:db8:1:2::1', '2001:db8:1:2::abcd', '::ffff:203.0.113.5', '203.0.113.5', null] as const;
    for (const ip of startIps) {
      const started = await runSignPublicHubAction(
        runtime,
        billing,
        ORG_SLUG,
        { action: 'start', templateId: TEMPLATE_ID, name: 'Nguyen Van A', email: 'signer@example.com' },
        { ip, userAgent: 'test-agent' },
      );
      expect(started.status).toBe('ok');
    }

    const startSqlCalls = sqlSeen.filter((q) => q.sql.includes('ludy_sign.public_hub_start'));
    expect(startSqlCalls).toHaveLength(startIps.length);
    const recordedIpHashes = startSqlCalls.map((q) => q.parameters[6]);
    expect(recordedIpHashes).toEqual(startIps.map((ip) => signIpHash(ip)));
    expect(recordedIpHashes[0]).not.toBe(recordedIpHashes[1]);
    expect(recordedIpHashes[2]).not.toBe(recordedIpHashes[3]);
    expect(recordedIpHashes[4]).toBeNull();
  });

  it('enforces collapsed /64 and ::ffff:IPv4 template buckets on POST /api/sign/public-hub/:orgSlug while preserving SQL audit IP hashing', async () => {
    const { app, sqlSeen } = createHubFixture({
      actions: new RateLimiter({ perMinute: 100 }),
      templateActions: new RateLimiter({ perMinute: 2 }),
    });

    const r1 = await postHub(app, { action: 'view', templateId: TEMPLATE_ID }, '2001:db8:1:2::1');
    expect(r1.status).toBe(200);
    const r2 = await postHub(app, { action: 'pdf', templateId: TEMPLATE_ID }, '2001:db8:1:2::abcd');
    expect(r2.status).toBe(200);
    const r3 = await postHub(app, { action: 'view', templateId: TEMPLATE_ID }, '2001:db8:1:2::9999');
    expect(r3.status).toBe(429);
    expect(Number(r3.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(r3.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r3.headers.get('cache-control')).toBe('no-store');

    // Different /64 on same template and same /64 on different template stay unaffected.
    expect((await postHub(app, { action: 'view', templateId: TEMPLATE_ID }, '2001:db8:1:3::1')).status).toBe(200);
    expect((await postHub(app, { action: 'view', templateId: TEMPLATE_ID_B }, '2001:db8:1:2::1')).status).toBe(200);

    // IPv4-mapped IPv6 and plain IPv4 share the same template bucket.
    const v4r1 = await postHub(app, { action: 'view', templateId: TEMPLATE_ID }, '::ffff:203.0.113.5');
    expect(v4r1.status).toBe(200);
    const v4r2 = await postHub(app, { action: 'pdf', templateId: TEMPLATE_ID }, '203.0.113.5');
    expect(v4r2.status).toBe(200);
    const v4r3 = await postHub(app, { action: 'start', templateId: TEMPLATE_ID, name: 'Signer', email: 's@example.com' }, '::ffff:203.0.113.5');
    expect(v4r3.status).toBe(429);
    expect((await postHub(app, { action: 'view', templateId: TEMPLATE_ID }, '203.0.113.6')).status).toBe(200);

    // Verify route start requests preserve raw signIpHash(meta.ip) in ludy_sign.public_hub_start.
    const auditFixture = createHubFixture({
      actions: new RateLimiter({ perMinute: 100 }),
      templateActions: new RateLimiter({ perMinute: 100 }),
    });
    const routeIps = ['2001:db8:1:2::1', '2001:db8:1:2::abcd', '::ffff:203.0.113.5', '203.0.113.5'] as const;
    for (const ip of routeIps) {
      const startRes = await postHub(
        auditFixture.app,
        { action: 'start', templateId: TEMPLATE_ID, name: 'Signer Audit', email: 'audit@example.com' },
        ip,
      );
      expect(startRes.status).toBe(200);
    }
    const routeStartCalls = auditFixture.sqlSeen.filter((q) => q.sql.includes('ludy_sign.public_hub_start'));
    expect(routeStartCalls).toHaveLength(routeIps.length);
    expect(routeStartCalls.map((q) => q.parameters[6])).toEqual(routeIps.map((ip) => signIpHash(ip)));
    expect(sqlSeen.length).toBeGreaterThan(0);
  });
});

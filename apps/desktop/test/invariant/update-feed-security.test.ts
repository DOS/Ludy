// SPDX-License-Identifier: AGPL-3.0-only
// Security invariant suite for Ludy Desktop update feed validation, SSRF blocks, origin pinning,
// manifest cryptographic signature checks, and Authenticode verification guardrails (#4884).
// Self-contained under test/invariant/: imports only the modules under test and Node built-ins.
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatSignedReleaseManifestScript,
  inspectAuthenticodePkcs7Der,
  OID_SHA256,
  parseAuthenticodeCheckResults,
  RELEASE_MANIFEST_SCRIPT_FILENAME,
  verifyWindowsAuthenticodeFiles,
  verifyWindowsSignedManifest,
} from '../../src/authenticode.ts';
import type { FetchLike } from '../../src/exchange.ts';
import {
  createPinnedFetch,
  isDisallowedRemoteHost,
  isPrivateOrReservedIp,
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_BYTES,
  parseDesktopReleaseManifest,
  parseFeedOrigin,
  parseReleasesManifest,
  prepareVerifiedUpdate,
  readBoundedResponseBytes,
  RELEASE_MANIFEST_SIG_FILENAME,
  resolveFeedUrl,
  unwrapIpLiteral,
  UpdateFeedError,
  validateUpdateFeed,
  verifyEd25519ManifestSignature,
  verifyReleaseManifestAgainstReleases,
} from '../../src/update-feed.ts';

const FEED = 'https://updates.example.vn/ludy-desktop';
const SHA1_A = '1'.repeat(40);
const SHA1_B = '2'.repeat(40);
const SHA256_B = 'a'.repeat(64);
const SHA256_SETUP = 'b'.repeat(64);
const THUMB = 'c'.repeat(40);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ludy-inv-feed-'));
  tempDirs.push(dir);
  return dir;
}

function validManifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    product: 'ludy-desktop',
    platform: 'win32',
    arch: 'x64',
    version: '0.1.1',
    signed: true,
    signing: {
      algorithm: 'sha256',
      timestampServer: 'http://timestamp.digicert.com',
      publisherThumbprint: THUMB,
    },
    installer: {
      file: 'LudyDesktop-Setup.exe',
      sha256: SHA256_SETUP,
      size: 12000000,
    },
    packages: [
      {
        file: 'LudyDesktop-0.1.1-full.nupkg',
        kind: 'full',
        version: '0.1.1',
        sha1: SHA1_B,
        sha256: SHA256_B,
        size: 11000000,
      },
    ],
    ...overrides,
  });
}

function mockFeedFetch(handlers: Record<string, Response>): FetchLike {
  return async (url) => {
    const res = handlers[String(url)];
    if (!res) return new Response('Not found', { status: 404 });
    return res.clone();
  };
}

describe('update feed SSRF, origin pinning, and traversal invariants', () => {
  it('blocks private, loopback, link-local, metadata, and IPv4-mapped IPv6 addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.50',
      '169.254.169.254',
      '100.64.1.2',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      '::127.0.0.1',
      'fe80::1',
      'fe81::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:a9fe:a9fe',
      '::ffff:10.0.0.1',
      '::ffff:0:127.0.0.1',
      '::ffff:0:10.0.0.1',
      '2002:7f00:1::1',
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('blocks disallowed remote hostnames, trailing-dot bypasses, raw path traversal, and off-origin feeds', () => {
    for (const host of [
      '',
      '.',
      'metadata',
      'localhost',
      'localhost.',
      'db.internal',
      'metadata.google.internal.',
      'printer.local',
      'printer.local.',
      'intranet.',
      'foo.localhost',
      'foo.localhost.',
      '169.254.169.254',
    ]) {
      expect(isDisallowedRemoteHost(host), host).toBe(true);
    }
    for (const trailingUrl of [
      'https://localhost./feed',
      'https://metadata.google.internal./feed',
      'https://printer.local./feed',
      'https://intranet./feed',
    ]) {
      expect(resolveFeedUrl(trailingUrl).ok, trailingUrl).toBe(false);
    }
    expect(isDisallowedRemoteHost('updates.example.vn')).toBe(false);
    expect(unwrapIpLiteral('[2606:4700:4700::1111]')).toBe('2606:4700:4700::1111');
    expect(unwrapIpLiteral('updates.example.vn')).toBeNull();
    expect(parseFeedOrigin('http://updates.example.vn').ok).toBe(false);
    expect(resolveFeedUrl('https://updates.example.vn/feed/%2e%2e/other').ok).toBe(false);
    expect(resolveFeedUrl('https://updates.example.vn/feed/..').ok).toBe(false);
    expect(resolveFeedUrl('/desktop/../other', { ludyUrl: 'https://ludy.example.vn' }).ok).toBe(false);
    expect(resolveFeedUrl('https://evil.example/feed', { allowedOrigin: 'https://updates.example.vn' }).ok).toBe(false);
  });

  it('rejects arbitrary HTTP download URLs, cross-origin URLs, traversal, oversized entries, and HTML in RELEASES', () => {
    const cases = [
      `${SHA1_B} http://updates.example.vn/ludy-desktop/LudyDesktop-0.1.1-full.nupkg 100`,
      `${SHA1_B} https://evil.example/ludy-desktop/LudyDesktop-0.1.1-full.nupkg 100`,
      `${SHA1_B} https://updates.example.vn/other/LudyDesktop-0.1.1-full.nupkg 100`,
      `${SHA1_B} ../LudyDesktop-0.1.1-full.nupkg 100`,
      `${SHA1_B} sub/LudyDesktop-0.1.1-full.nupkg 100`,
      `${SHA1_B} LudyDesktop-0.1.1-full.nupkg?token=abc 100`,
      `${SHA1_B} file:///C:/evil.nupkg 100`,
      `${SHA1_B} LudyDesktop-0.1.1-full.nupkg ${MAX_PACKAGE_BYTES + 1}`,
      'not-a-sha1 LudyDesktop-0.1.1-full.nupkg 100',
      '<!doctype html><html><body>error</body></html>',
    ];
    for (const line of cases) {
      expect(() => parseReleasesManifest(line, FEED), line).toThrow(UpdateFeedError);
    }
  });

  it('blocks DNS SSRF resolution, redirects, empty 204/205 without crashing, and over-limit streaming bodies', async () => {
    const blockedFetch = createPinnedFetch(async () => [{ address: '169.254.169.254' }]);
    await expect(blockedFetch(`${FEED}/RELEASES`)).rejects.toThrow(/private or reserved IP/);

    let reqMode: 'redirect' | 'empty204' = 'redirect';
    const server = createServer((_req, res) => {
      if (reqMode === 'redirect') {
        res.writeHead(302, { location: 'https://evil.example/RELEASES' }).end();
      } else {
        res.writeHead(204).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const pinned = createPinnedFetch();
      await expect(pinned(`http://127.0.0.1:${port}/RELEASES`)).rejects.toThrow(/Refused HTTP redirect/);
      reqMode = 'empty204';
      const emptyRes = await pinned(`http://127.0.0.1:${port}/RELEASES`);
      expect(emptyRes.status).toBe(204);
      expect(emptyRes.body).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted < 10) {
          emitted += 1;
          controller.enqueue(new Uint8Array(256 * 1024));
        } else {
          controller.close();
        }
      },
    });
    const bigRes = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    await expect(readBoundedResponseBytes(bigRes, MAX_MANIFEST_BYTES, true)).rejects.toThrow(/exceeded size limit/);
    expect(emitted).toBeLessThan(10);

    // Multi-IP DNS fallback tries validated addresses in sequence without re-resolving DNS, but stops on redirects or private entries.
    let lookupCalls = 0;
    const triedIps: string[] = [];
    const multiIpFetch = createPinnedFetch(
      async () => {
        lookupCalls += 1;
        return [{ address: '2606:4700:4700::1111' }, { address: '93.184.216.34' }];
      },
      async (url, _init, _headers, pinned) => {
        expect(url.hostname).toBe('updates.example.vn');
        triedIps.push(pinned!.address);
        if (pinned!.address === '2606:4700:4700::1111') {
          throw new Error('connect ENETUNREACH');
        }
        return new Response('ok', { status: 200 });
      },
    );
    const fallbackRes = await multiIpFetch(`${FEED}/RELEASES`);
    expect(fallbackRes.status).toBe(200);
    expect(lookupCalls).toBe(1);
    expect(triedIps).toEqual(['2606:4700:4700::1111', '93.184.216.34']);

    const redirectTried: string[] = [];
    const noRedirectRetryFetch = createPinnedFetch(
      async () => [{ address: '93.184.216.34' }, { address: '93.184.216.35' }],
      async (_url, _init, _headers, pinned) => {
        redirectTried.push(pinned!.address);
        throw new UpdateFeedError('REDIRECT_REFUSED', 'Refused HTTP redirect (302) from update feed');
      },
    );
    await expect(noRedirectRetryFetch(`${FEED}/RELEASES`)).rejects.toThrow(/Refused HTTP redirect/);
    expect(redirectTried).toEqual(['93.184.216.34']);
  });
});

describe('update signature and trusted publisher invariants', () => {
  it('fails closed on missing manifest, unsigned HTTPS feed, mismatched manifest, HTML, and thumbprint mismatch', async () => {
    const releasesOk = new Response(`${SHA1_B} LudyDesktop-0.1.1-full.nupkg 11000000\n`, { status: 200 });

    await expect(
      validateUpdateFeed({
        feedUrl: FEED,
        fetch: mockFeedFetch({ [`${FEED}/RELEASES`]: releasesOk }),
        lookupHost: async () => [{ address: '169.254.169.254' }],
      }),
    ).rejects.toThrow(/private or reserved IP/);

    await expect(
      validateUpdateFeed({
        feedUrl: FEED,
        fetch: mockFeedFetch({ [`${FEED}/RELEASES`]: releasesOk }),
      }),
    ).rejects.toThrow(/missing release-manifest\.json/);

    await expect(
      validateUpdateFeed({
        feedUrl: FEED,
        fetch: mockFeedFetch({
          [`${FEED}/RELEASES`]: releasesOk,
          [`${FEED}/release-manifest.json`]: new Response(validManifestJson({ signed: false }), { status: 200 }),
        }),
      }),
    ).rejects.toThrow(/unsigned release manifest/);

    await expect(
      validateUpdateFeed({
        feedUrl: FEED,
        fetch: mockFeedFetch({
          [`${FEED}/RELEASES`]: releasesOk,
          [`${FEED}/release-manifest.json`]: new Response(
            validManifestJson({
              packages: [
                {
                  file: 'LudyDesktop-0.1.1-full.nupkg',
                  kind: 'full',
                  version: '0.1.1',
                  sha1: SHA1_A,
                  sha256: SHA256_B,
                  size: 11000000,
                },
              ],
            }),
            { status: 200 },
          ),
        }),
      }),
    ).rejects.toThrow(/Metadata mismatch/);

    await expect(
      validateUpdateFeed({
        feedUrl: FEED,
        fetch: mockFeedFetch({
          [`${FEED}/RELEASES`]: releasesOk,
          [`${FEED}/release-manifest.json`]: new Response(validManifestJson(), { status: 200 }),
        }),
        expectedPublisherThumbprint: 'd'.repeat(40),
      }),
    ).rejects.toThrow(/thumbprint does not match/);

    await expect(
      validateUpdateFeed({
        feedUrl: FEED,
        fetch: mockFeedFetch({
          [`${FEED}/RELEASES`]: new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        }),
      }),
    ).rejects.toThrow(/returned HTML/);

    expect(() => parseDesktopReleaseManifest('not json')).toThrow(UpdateFeedError);
    expect(() => parseDesktopReleaseManifest(validManifestJson({ platform: 'darwin' }))).toThrow(UpdateFeedError);
    const parsedRel = parseReleasesManifest(`${SHA1_B} LudyDesktop-0.1.1-full.nupkg 11000000\n`, FEED);
    const badManifest = parseDesktopReleaseManifest(validManifestJson({ version: '0.1.2' }));
    expect(() => verifyReleaseManifestAgainstReleases(parsedRel, badManifest, { requireSigned: true })).toThrow(/does not match/);
  });

  it('enforces Ed25519 signature when expectedManifestPublicKey is configured', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const manifestBytes = Buffer.from(validManifestJson(), 'utf8');
    const sigBase64 = cryptoSign(null, manifestBytes, privateKey).toString('base64');

    expect(verifyEd25519ManifestSignature(manifestBytes, sigBase64, pubPem)).toBe(true);
    expect(verifyEd25519ManifestSignature(Buffer.from(validManifestJson({ version: '0.9.9' })), sigBase64, pubPem)).toBe(false);

    await expect(
      validateUpdateFeed({
        feedUrl: FEED,
        fetch: mockFeedFetch({
          [`${FEED}/RELEASES`]: new Response(`${SHA1_B} LudyDesktop-0.1.1-full.nupkg 11000000\n`, { status: 200 }),
          [`${FEED}/release-manifest.json`]: new Response(manifestBytes, { status: 200 }),
          [`${FEED}/${RELEASE_MANIFEST_SIG_FILENAME}`]: new Response(Buffer.alloc(64, 7).toString('base64'), { status: 200 }),
        }),
        expectedManifestPublicKey: pubPem,
      }),
    ).rejects.toThrow(/signature failed verification/);
  });

  it('refuses signed updates without trusted local publisher identity or signed manifest script', async () => {
    const payload = Buffer.from('nupkg-bytes');
    const sha1 = createHash('sha1').update(payload).digest('hex');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const manifestJson = validManifestJson({
      packages: [{ file: 'LudyDesktop-0.1.1-full.nupkg', kind: 'full', version: '0.1.1', sha1, sha256, size: payload.length }],
    });
    const fetchNoPs1 = mockFeedFetch({
      [`${FEED}/RELEASES`]: new Response(`${sha1.toUpperCase()} LudyDesktop-0.1.1-full.nupkg ${payload.length}\n`, { status: 200 }),
      [`${FEED}/release-manifest.json`]: new Response(manifestJson, { status: 200 }),
      [`${FEED}/LudyDesktop-0.1.1-full.nupkg`]: new Response(payload, { status: 200 }),
    });

    // Server self-asserted publisherThumbprint in manifest must NEVER authenticate itself.
    await expect(
      prepareVerifiedUpdate({
        feedUrl: FEED,
        fetch: fetchNoPs1,
        stagingDir: join(makeTempDir(), 'stage-no-pin'),
        verifySignedManifest: async () => undefined,
        verifySignedPackage: async () => undefined,
      }),
    ).rejects.toThrow(/trusted publisher/i);

    // Public IPv6 literals must skip lookupHost cleanly without passing bracketed host to dns.lookup.
    const ipv6Feed = 'https://[2606:4700:4700::1111]/feed';
    let lookupCalledForIpLiteral = false;
    const ipv6Out = await validateUpdateFeed({
      feedUrl: ipv6Feed,
      fetch: mockFeedFetch({
        [`${ipv6Feed}/RELEASES`]: new Response(`${SHA1_B} LudyDesktop-0.1.1-full.nupkg 11000000\n`, { status: 200 }),
        [`${ipv6Feed}/release-manifest.json`]: new Response(validManifestJson(), { status: 200 }),
      }),
      lookupHost: async () => {
        lookupCalledForIpLiteral = true;
        throw new Error('dns lookup should not run for IP literal');
      },
    });
    expect(lookupCalledForIpLiteral).toBe(false);
    expect(ipv6Out.feedUrl).toBe(ipv6Feed);

    // Loopback feeds without allowUnsigned: true MUST refuse unsigned manifests so signed apps never downgrade on localhost.
    const loopbackNoOpt = 'http://127.0.0.1:4010/feed';
    await expect(
      validateUpdateFeed({
        feedUrl: loopbackNoOpt,
        fetch: mockFeedFetch({
          [`${loopbackNoOpt}/RELEASES`]: new Response(`${SHA1_B} LudyDesktop-0.1.1-full.nupkg 11000000\n`, { status: 200 }),
          [`${loopbackNoOpt}/release-manifest.json`]: new Response(
            validManifestJson({ signed: false, signing: { algorithm: 'sha256', timestampServer: null, publisherThumbprint: null } }),
            { status: 200 },
          ),
        }),
      }),
    ).rejects.toThrow(/unsigned release manifest/);

    // Loopback feed WITH pinned publisher thumbprint MUST require real signature verification even if allowUnsigned=true.
    const loopback = 'http://127.0.0.1:4010/feed';
    await expect(
      prepareVerifiedUpdate({
        feedUrl: loopback,
        allowUnsigned: true,
        fetch: mockFeedFetch({
          [`${loopback}/RELEASES`]: new Response(`${sha1.toUpperCase()} LudyDesktop-0.1.1-full.nupkg ${payload.length}\n`, { status: 200 }),
          [`${loopback}/release-manifest.json`]: new Response(manifestJson, { status: 200 }),
          [`${loopback}/LudyDesktop-0.1.1-full.nupkg`]: new Response(payload, { status: 200 }),
        }),
        expectedPublisherThumbprint: THUMB,
        stagingDir: join(makeTempDir(), 'stage-loopback-pinned'),
        verifySignedManifest: async () => undefined,
        verifySignedPackage: async () => undefined,
      }),
    ).rejects.toThrow(/release-manifest\.ps1/);

    // Signed feed missing release-manifest.ps1 fails closed before touching nupkg.
    const failedStage = join(makeTempDir(), 'stage-no-ps1');
    await expect(
      prepareVerifiedUpdate({
        feedUrl: FEED,
        fetch: fetchNoPs1,
        expectedPublisherThumbprint: THUMB,
        stagingDir: failedStage,
        verifySignedManifest: async () => undefined,
        verifySignedPackage: async () => undefined,
      }),
    ).rejects.toThrow(/release-manifest\.ps1/);
    expect(existsSync(join(failedStage, 'LudyDesktop-0.1.1-full.nupkg'))).toBe(false);

    // Fails closed if verifyWindowsAuthenticodeFiles rejects Authenticode or legacy timestamp OIDs.
    await expect(
      prepareVerifiedUpdate({
        feedUrl: FEED,
        fetch: mockFeedFetch({
          [`${FEED}/RELEASES`]: new Response(`${sha1.toUpperCase()} LudyDesktop-0.1.1-full.nupkg ${payload.length}\n`, { status: 200 }),
          [`${FEED}/release-manifest.json`]: new Response(manifestJson, { status: 200 }),
          [`${FEED}/${RELEASE_MANIFEST_SCRIPT_FILENAME}`]: new Response('ps1', { status: 200 }),
          [`${FEED}/LudyDesktop-0.1.1-full.nupkg`]: new Response(payload, { status: 200 }),
        }),
        expectedPublisherThumbprint: THUMB,
        stagingDir: join(makeTempDir(), 'stage-bad-sig'),
        verifySignedManifest: async () => undefined,
        verifySignedPackage: async () => {
          throw new Error('Authenticode signature invalid');
        },
      }),
    ).rejects.toThrow(/Authenticode signature invalid/);

    expect(() =>
      parseAuthenticodeCheckResults(
        JSON.stringify([
          {
            path: 'Setup.exe',
            status: 'Valid',
            thumbprint: THUMB,
            hasTimestamp: true,
            fileDigestOid: OID_SHA256,
            timestampType: 'authenticode-legacy',
            tsDigestOid: '1.3.14.3.2.26',
          },
        ]),
        ['Setup.exe'],
        THUMB,
      ),
    ).toThrow(/RFC 3161/);
  });

  it('inspects SpcIndirectDataContent (/fd), TSTInfo.messageImprint (/td), and verifies signed .ps1 manifest binding end to end', async () => {
    const OID_SHA1 = '1.3.14.3.2.26';
    const OID_SHA384 = '2.16.840.1.101.3.4.2.2';

    const tlv = (tag: number, content: Buffer): Buffer => {
      const len = content.length;
      const hdr = len < 0x80 ? Buffer.from([tag, len]) : len < 256 ? Buffer.from([tag, 0x81, len]) : Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
      return Buffer.concat([hdr, content]);
    };
    const oidTlv = (dotted: string): Buffer => {
      const parts = dotted.split('.').map(Number);
      const out: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
      for (const n of parts.slice(2)) {
        const stack: number[] = [n & 0x7f];
        let v = n >> 7;
        while (v > 0) {
          stack.push((v & 0x7f) | 0x80);
          v >>= 7;
        }
        out.push(...stack.reverse());
      }
      return tlv(0x06, Buffer.from(out));
    };
    const algId = (oid: string): Buffer => tlv(0x30, Buffer.concat([oidTlv(oid), tlv(0x05, Buffer.alloc(0))]));
    const buildCms = (opts: {
      fileDigestOid: string;
      signerAlgOid: string;
      timestampMode: 'rfc3161' | 'legacy' | 'none';
      tsImprintOid?: string;
      tsaSignerAlgOid?: string;
      forgedImprint?: Buffer;
      duplicateRfc3161Attr?: boolean;
      twoTokensInSet?: boolean;
      coexistLegacy?: boolean;
      multiSignerInfos?: boolean;
      extraChildInExplicit?: boolean;
      truncatedExplicit?: boolean;
    }): Buffer => {
      const spcIndirect = tlv(
        0x30,
        Buffer.concat([
          tlv(0x30, oidTlv('1.3.6.1.4.1.311.2.1.15')),
          tlv(0x30, Buffer.concat([algId(opts.fileDigestOid), tlv(0x04, Buffer.alloc(32, 1))])),
        ]),
      );
      const spcWrapper = opts.truncatedExplicit
        ? tlv(0xa0, Buffer.from([0x30, 0x7f]))
        : opts.extraChildInExplicit
          ? tlv(0xa0, Buffer.concat([spcIndirect, tlv(0x05, Buffer.alloc(0))]))
          : tlv(0xa0, spcIndirect);
      const encap = tlv(0x30, Buffer.concat([oidTlv('1.3.6.1.4.1.311.2.1.4'), spcWrapper]));

      const encryptedSignature = Buffer.from('test-encrypted-signature-bytes');
      const signatureSha256 = createHash('sha256').update(encryptedSignature).digest();
      const mkTsToken = (imprint: Buffer): Buffer => {
        const tstInfo = tlv(
          0x30,
          Buffer.concat([
            tlv(0x02, Buffer.from([1])),
            oidTlv('1.2.3.4'),
            tlv(0x30, Buffer.concat([algId(opts.tsImprintOid ?? OID_SHA256), tlv(0x04, imprint)])),
          ]),
        );
        const tsEncap = tlv(0x30, Buffer.concat([oidTlv('1.2.840.113549.1.9.16.1.4'), tlv(0xa0, tlv(0x04, tstInfo))]));
        const tsSigner = tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([1])), algId(opts.tsaSignerAlgOid ?? OID_SHA256)]));
        const tsSignedData = tlv(
          0x30,
          Buffer.concat([tlv(0x02, Buffer.from([3])), tlv(0x31, algId(opts.tsaSignerAlgOid ?? OID_SHA256)), tsEncap, tlv(0x31, tsSigner)]),
        );
        return tlv(0x30, Buffer.concat([oidTlv('1.2.840.113549.1.7.2'), tlv(0xa0, tsSignedData)]));
      };

      const attrItems: Buffer[] = [];
      if (opts.timestampMode === 'rfc3161') {
        const goodToken = mkTsToken(opts.forgedImprint ?? signatureSha256);
        const dummyBadToken = mkTsToken(Buffer.alloc(32, 9));
        if (opts.twoTokensInSet) {
          attrItems.push(tlv(0x30, Buffer.concat([oidTlv('1.3.6.1.4.1.311.3.3.1'), tlv(0x31, Buffer.concat([dummyBadToken, goodToken]))])));
        } else {
          attrItems.push(tlv(0x30, Buffer.concat([oidTlv('1.3.6.1.4.1.311.3.3.1'), tlv(0x31, goodToken)])));
        }
        if (opts.duplicateRfc3161Attr) {
          attrItems.push(tlv(0x30, Buffer.concat([oidTlv('1.3.6.1.4.1.311.3.3.1'), tlv(0x31, dummyBadToken)])));
        }
        if (opts.coexistLegacy) {
          attrItems.push(tlv(0x30, Buffer.concat([oidTlv('1.2.840.113549.1.9.6'), tlv(0x31, Buffer.from([0x05, 0x00]))])));
        }
      } else if (opts.timestampMode === 'legacy') {
        attrItems.push(tlv(0x30, Buffer.concat([oidTlv('1.2.840.113549.1.9.6'), tlv(0x31, Buffer.from([0x05, 0x00]))])));
      }
      const unsignedAttr: Buffer = attrItems.length > 0 ? tlv(0xa1, Buffer.concat(attrItems)) : Buffer.alloc(0);

      const sid = tlv(0x30, Buffer.concat([tlv(0x30, Buffer.alloc(0)), tlv(0x02, Buffer.from([1]))]));
      const signerInfo = tlv(
        0x30,
        Buffer.concat([
          tlv(0x02, Buffer.from([1])),
          sid,
          algId(opts.signerAlgOid),
          algId('1.2.840.113549.1.1.11'),
          tlv(0x04, encryptedSignature),
          unsignedAttr,
        ]),
      );
      const signerSet = opts.multiSignerInfos ? tlv(0x31, Buffer.concat([signerInfo, signerInfo])) : tlv(0x31, signerInfo);
      const signedData = tlv(
        0x30,
        Buffer.concat([tlv(0x02, Buffer.from([1])), tlv(0x31, algId(opts.signerAlgOid)), encap, signerSet]),
      );
      return tlv(0x30, Buffer.concat([oidTlv('1.2.840.113549.1.7.2'), tlv(0xa0, signedData)]));
    };

    // Valid SHA-256 /fd + SHA-256 SignerInfo + SHA-256 /td TSTInfo.messageImprint bound to SignerInfo signature succeeds.
    expect(
      inspectAuthenticodePkcs7Der(
        buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA256, timestampMode: 'rfc3161', tsImprintOid: OID_SHA256, tsaSignerAlgOid: OID_SHA384 }),
      ),
    ).toEqual({
      fileDigestOid: OID_SHA256,
      signerDigestOid: OID_SHA256,
      timestampType: 'rfc3161',
      tsDigestOid: OID_SHA256,
    });

    // Reject forged/mismatched RFC 3161 imprint, duplicate tokens/attributes, multiple SignerInfos, and bounded [0] wrapper bypasses.
    expect(() =>
      inspectAuthenticodePkcs7Der(
        buildCms({
          fileDigestOid: OID_SHA256,
          signerAlgOid: OID_SHA256,
          timestampMode: 'rfc3161',
          forgedImprint: Buffer.alloc(32, 0xaa),
        }),
      ),
    ).toThrow(/messageImprint digest does not match/);
    expect(() =>
      inspectAuthenticodePkcs7Der(
        buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA256, timestampMode: 'rfc3161', twoTokensInSet: true }),
      ),
    ).toThrow(/exactly one timestamp token/);
    expect(() =>
      inspectAuthenticodePkcs7Der(
        buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA256, timestampMode: 'rfc3161', duplicateRfc3161Attr: true }),
      ),
    ).toThrow(/Duplicate RFC 3161/);
    expect(() =>
      inspectAuthenticodePkcs7Der(
        buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA256, timestampMode: 'rfc3161', multiSignerInfos: true }),
      ),
    ).toThrow(/exactly one SignerInfo/);
    expect(() =>
      inspectAuthenticodePkcs7Der(
        buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA256, timestampMode: 'rfc3161', extraChildInExplicit: true }),
      ),
    ).toThrow(/exactly one ASN\.1 DER element/);
    expect(() =>
      inspectAuthenticodePkcs7Der(
        buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA256, timestampMode: 'rfc3161', truncatedExplicit: true }),
      ),
    ).toThrow(/extends past parent container/);
    expect(() => inspectAuthenticodePkcs7Der(Buffer.from([0x30, 0x7f]))).toThrow(/extends past buffer end/);

    // Reject weak /fd SHA-1, weak /fd SignerInfo.digestAlgorithm SHA-1, weak /td SHA-1, and co-existing legacy counter-sign.
    const psValidWinVerify = async (_s: string, _e: Record<string, string>, stdin?: string) => {
      const paths = JSON.parse(stdin ?? '[]') as string[];
      return JSON.stringify(paths.map((p) => ({ path: p, status: 'Valid', thumbprint: THUMB, hasTimestamp: true })));
    };
    const work = makeTempDir();
    const mkPs1 = (name: string, manifestStr: string, cmsDer: Buffer): string => {
      const p = join(work, name);
      writeFileSync(p, `${formatSignedReleaseManifestScript(manifestStr)}# SIG # Begin signature block\r\n# ${cmsDer.toString('base64')}\r\n# SIG # End signature block\r\n`, 'utf8');
      return p;
    };

    const payload = Buffer.from('verified-bundle-content');
    const sha1 = createHash('sha1').update(payload).digest('hex');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const manifestJson = validManifestJson({
      packages: [{ file: 'LudyDesktop-0.1.1-full.nupkg', kind: 'full', version: '0.1.1', sha1, sha256, size: payload.length }],
    });

    const weakFdPs1 = mkPs1(
      'weak-fd.ps1',
      manifestJson,
      buildCms({ fileDigestOid: OID_SHA1, signerAlgOid: OID_SHA256, timestampMode: 'rfc3161', tsImprintOid: OID_SHA256 }),
    );
    await expect(verifyWindowsAuthenticodeFiles([weakFdPs1], THUMB, psValidWinVerify, 'win32')).rejects.toThrow(/SHA-256 digest/);

    const weakSignerAlgPs1 = mkPs1(
      'weak-signer-alg.ps1',
      manifestJson,
      buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA1, timestampMode: 'rfc3161', tsImprintOid: OID_SHA256 }),
    );
    await expect(verifyWindowsAuthenticodeFiles([weakSignerAlgPs1], THUMB, psValidWinVerify, 'win32')).rejects.toThrow(/SHA-256 digest/);

    const weakTdPs1 = mkPs1(
      'weak-td.ps1',
      manifestJson,
      buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA256, timestampMode: 'rfc3161', tsImprintOid: OID_SHA1, tsaSignerAlgOid: OID_SHA256 }),
    );
    await expect(verifyWindowsAuthenticodeFiles([weakTdPs1], THUMB, psValidWinVerify, 'win32')).rejects.toThrow(/SHA-256 digest/);

    const coexistLegacyPs1 = mkPs1(
      'coexist-legacy.ps1',
      manifestJson,
      buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA256, timestampMode: 'rfc3161', coexistLegacy: true }),
    );
    await expect(verifyWindowsAuthenticodeFiles([coexistLegacyPs1], THUMB, psValidWinVerify, 'win32')).rejects.toThrow(/RFC 3161/);

    const legacyTsPs1 = mkPs1(
      'legacy-ts.ps1',
      manifestJson,
      buildCms({ fileDigestOid: OID_SHA256, signerAlgOid: OID_SHA256, timestampMode: 'legacy' }),
    );
    await expect(verifyWindowsAuthenticodeFiles([legacyTsPs1], THUMB, psValidWinVerify, 'win32')).rejects.toThrow(/RFC 3161/);

    // Verify prepareVerifiedUpdate stages a real .ps1 extension (not .ps1.part) and verifyWindowsSignedManifest catches manifest JSON tampering!
    const validCms = buildCms({
      fileDigestOid: OID_SHA256,
      signerAlgOid: OID_SHA256,
      timestampMode: 'rfc3161',
      tsImprintOid: OID_SHA256,
      tsaSignerAlgOid: OID_SHA384,
    });
    const signedPs1Bytes = Buffer.from(
      `${formatSignedReleaseManifestScript(manifestJson)}# SIG # Begin signature block\r\n# ${validCms.toString('base64')}\r\n# SIG # End signature block\r\n`,
      'utf8',
    );
    const tamperedPs1Bytes = Buffer.from(
      `${formatSignedReleaseManifestScript(validManifestJson({ version: '9.9.9' }))}# SIG # Begin signature block\r\n# ${validCms.toString('base64')}\r\n# SIG # End signature block\r\n`,
      'utf8',
    );

    await expect(
      prepareVerifiedUpdate({
        feedUrl: FEED,
        fetch: mockFeedFetch({
          [`${FEED}/RELEASES`]: new Response(`${sha1.toUpperCase()} LudyDesktop-0.1.1-full.nupkg ${payload.length}\n`, { status: 200 }),
          [`${FEED}/release-manifest.json`]: new Response(manifestJson, { status: 200 }),
          [`${FEED}/${RELEASE_MANIFEST_SCRIPT_FILENAME}`]: new Response(tamperedPs1Bytes, { status: 200 }),
          [`${FEED}/LudyDesktop-0.1.1-full.nupkg`]: new Response(payload, { status: 200 }),
        }),
        expectedPublisherThumbprint: THUMB,
        stagingDir: join(makeTempDir(), 'stage-tamper-ps1'),
        verifySignedManifest: (p, bytes, t) => verifyWindowsSignedManifest(p, bytes, t, psValidWinVerify, 'win32'),
        verifySignedPackage: async () => undefined,
      }),
    ).rejects.toThrow(/does not match/);

    const okStaged = await prepareVerifiedUpdate({
      feedUrl: FEED,
      fetch: mockFeedFetch({
        [`${FEED}/RELEASES`]: new Response(`${sha1.toUpperCase()} LudyDesktop-0.1.1-full.nupkg ${payload.length}\n`, { status: 200 }),
        [`${FEED}/release-manifest.json`]: new Response(manifestJson, { status: 200 }),
        [`${FEED}/${RELEASE_MANIFEST_SCRIPT_FILENAME}`]: new Response(signedPs1Bytes, { status: 200 }),
        [`${FEED}/LudyDesktop-0.1.1-full.nupkg`]: new Response(payload, { status: 200 }),
      }),
      expectedPublisherThumbprint: THUMB,
      stagingDir: join(makeTempDir(), 'stage-ok-ps1'),
      verifySignedManifest: (p, bytes, t) => verifyWindowsSignedManifest(p, bytes, t, psValidWinVerify, 'win32'),
      verifySignedPackage: async () => undefined,
    });
    expect(okStaged.status).toBe('staged');
  });
});

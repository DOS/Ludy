// SPDX-License-Identifier: AGPL-3.0-only
// Security invariant suite for Ludy Desktop update feed validation, SSRF blocks, origin pinning,
// manifest cryptographic signature checks, Authenticode, and macOS codesign/Gatekeeper/ZIP verification guardrails (#4884, #4885).
// Self-contained under test/invariant/: imports only the modules under test and Node built-ins.
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
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
import {
  APPLE_BUNDLE_ID,
  inspectZipCentralDirectory,
  MAC_APP_BUNDLE_NAME,
  parseCodesignDisplayOutput,
  parseCodesignVerifyOutput,
  parseInfoPlistJson,
  parseSpctlAssessOutput,
  verifyExtractedDirectorySymlinks,
  verifyMacDmgPackage,
  verifyMacSignedPackage,
  verifyZipDecompressedSizeBounds,
} from '../../src/codesign.ts';
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
  verifyDarwinReleaseManifest,
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
      'fe80::1%eth0',
      'updates.example.vn%00',
      'bad:host.example.vn',
      'not-an-ip:1234',
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
            signatureType: 'Authenticode',
            thumbprint: THUMB,
            hasTimestamp: true,
            fileDigestOid: OID_SHA256,
            signerDigestOid: OID_SHA256,
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
      return JSON.stringify(paths.map((p) => ({ path: p, status: 'Valid', signatureType: 'Authenticode', thumbprint: THUMB, hasTimestamp: true })));
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

describe('macOS update feed, Team ID pinning, ZIP safety, and Gatekeeper invariants', () => {
  const TEAM_ID = 'A1B2C3D4E5';

  function macManifestJson(overrides: Record<string, unknown> = {}): string {
    const version = (overrides.version as string | undefined) ?? '0.2.0';
    const arch = (overrides.arch as string | undefined) ?? 'arm64';
    const zipSha256 = (overrides.zipSha256 as string | undefined) ?? SHA256_B;
    const zipSize = (overrides.zipSize as number | undefined) ?? 2048;
    const { zipSha256: _zSha, zipSize: _zSize, ...rest } = overrides;
    return JSON.stringify({
      schemaVersion: 1,
      product: 'ludy-desktop',
      platform: 'darwin',
      arch,
      version,
      signed: true,
      signing: {
        algorithm: 'sha256',
        teamId: TEAM_ID,
        bundleId: APPLE_BUNDLE_ID,
        hardenedRuntime: true,
        notarized: true,
      },
      installer: {
        file: `LudyDesktop-${version}-darwin-${arch}.dmg`,
        sha256: SHA256_SETUP,
        size: 4096,
      },
      packages: [
        {
          file: `LudyDesktop-${version}-darwin-${arch}.zip`,
          kind: 'full',
          version,
          sha256: zipSha256,
          size: zipSize,
        },
      ],
      ...rest,
    });
  }

  function buildTestZip(
    entries: Array<{
      name: string;
      dataSize?: number;
      payload?: Buffer;
      compress?: boolean;
      useDataDescriptor?: boolean;
      ddWithSignature?: boolean;
      uncompressedSizeOverride?: number;
      versionMadeBy?: number;
      externalFileAttributes?: number;
      localOffsetOverride?: number;
      gapAfterBytes?: number;
    }>,
    overrides: {
      diskNumber?: number;
      diskEntryCount?: number;
      entryCount?: number;
      prependBytes?: Buffer;
      preCdGapBytes?: Buffer;
      postCdGapBytes?: Buffer;
    } = {},
  ) {
    const localChunks: Array<Buffer<ArrayBuffer>> = [];
    const cdChunks: Array<Buffer<ArrayBuffer>> = [];
    let offset = 0;
    if (overrides.prependBytes) {
      localChunks.push(Buffer.from(overrides.prependBytes) as Buffer<ArrayBuffer>);
      offset += overrides.prependBytes.length;
    }
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      const rawData = entry.payload ?? Buffer.alloc(entry.dataSize ?? 4);
      const crc = rawData.length > 0 ? zlibCrc32(rawData) >>> 0 : 0;
      const method = entry.compress ? 8 : 0;
      const compressedData = entry.compress ? deflateRawSync(rawData) : rawData;
      const flags = entry.useDataDescriptor ? 0x0008 : 0;
      const ddLen = entry.useDataDescriptor ? (entry.ddWithSignature !== false ? 16 : 12) : 0;

      const lh = Buffer.alloc(30 + nameBuf.length + compressedData.length + ddLen);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(flags, 6);
      lh.writeUInt16LE(method, 8);
      if (!entry.useDataDescriptor) {
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(compressedData.length, 18);
        lh.writeUInt32LE(rawData.length, 22);
      }
      lh.writeUInt16LE(nameBuf.length, 26);
      nameBuf.copy(lh, 30);
      compressedData.copy(lh, 30 + nameBuf.length);
      if (entry.useDataDescriptor) {
        const ddPos = 30 + nameBuf.length + compressedData.length;
        if (entry.ddWithSignature !== false) {
          lh.writeUInt32LE(0x08074b50, ddPos);
          lh.writeUInt32LE(crc, ddPos + 4);
          lh.writeUInt32LE(compressedData.length, ddPos + 8);
          lh.writeUInt32LE(rawData.length, ddPos + 12);
        } else {
          lh.writeUInt32LE(crc, ddPos);
          lh.writeUInt32LE(compressedData.length, ddPos + 4);
          lh.writeUInt32LE(rawData.length, ddPos + 8);
        }
      }

      const cd = Buffer.alloc(46 + nameBuf.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(flags, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(compressedData.length, 20);
      cd.writeUInt32LE(entry.uncompressedSizeOverride ?? rawData.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt32LE(entry.externalFileAttributes ?? 0, 38);
      cd.writeUInt32LE(entry.localOffsetOverride ?? offset, 42);
      nameBuf.copy(cd, 46);
      localChunks.push(lh);
      cdChunks.push(cd);
      offset += lh.length;
      if (entry.gapAfterBytes && entry.gapAfterBytes > 0) {
        localChunks.push(Buffer.alloc(entry.gapAfterBytes) as Buffer<ArrayBuffer>);
        offset += entry.gapAfterBytes;
      }
    }
    if (overrides.preCdGapBytes) {
      localChunks.push(Buffer.from(overrides.preCdGapBytes) as Buffer<ArrayBuffer>);
      offset += overrides.preCdGapBytes.length;
    }
    const cdBuf = Buffer.concat(cdChunks);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(overrides.diskNumber ?? 0, 4);
    eocd.writeUInt16LE(overrides.diskNumber ?? 0, 6);
    eocd.writeUInt16LE(overrides.diskEntryCount ?? overrides.entryCount ?? entries.length, 8);
    eocd.writeUInt16LE(overrides.entryCount ?? entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    const tailChunks: Array<Buffer<ArrayBuffer>> = [...localChunks, cdBuf];
    if (overrides.postCdGapBytes) {
      tailChunks.push(Buffer.from(overrides.postCdGapBytes) as Buffer<ArrayBuffer>);
    }
    tailChunks.push(eocd);
    return Buffer.concat(tailChunks);
  }

  it('rejects cross-platform, wrong-arch, unsigned, unnotarized, and Team-ID-mismatched macOS manifests', async () => {
    await expect(
      validateUpdateFeed({
        feedUrl: FEED,
        platform: 'darwin',
        arch: 'arm64',
        expectedTeamId: TEAM_ID,
        fetch: mockFeedFetch({
          [`${FEED}/release-manifest.json`]: new Response(macManifestJson({ arch: 'x64' }), { status: 200 }),
        }),
      }),
    ).rejects.toThrow(/does not match arm64/);

    const winAsMac = JSON.stringify({
      schemaVersion: 1,
      product: 'ludy-desktop',
      platform: 'win32',
      arch: 'x64',
      version: '0.2.0',
      signed: true,
      signing: { algorithm: 'sha256', timestampServer: null, publisherThumbprint: THUMB },
      installer: { file: 'LudyDesktop-Setup.exe', sha256: SHA256_SETUP, size: 100 },
      packages: [
        {
          file: 'LudyDesktop-0.2.0-full.nupkg',
          kind: 'full',
          version: '0.2.0',
          sha1: SHA1_B,
          sha256: SHA256_B,
          size: 100,
        },
      ],
    });
    await expect(
      validateUpdateFeed({
        feedUrl: FEED,
        platform: 'darwin',
        arch: 'arm64',
        expectedTeamId: TEAM_ID,
        fetch: mockFeedFetch({ [`${FEED}/release-manifest.json`]: new Response(winAsMac, { status: 200 }) }),
      }),
    ).rejects.toThrow(/does not match darwin/);

    const parsedUnnotarized = parseDesktopReleaseManifest(
      macManifestJson({
        signing: {
          algorithm: 'sha256',
          teamId: TEAM_ID,
          bundleId: APPLE_BUNDLE_ID,
          hardenedRuntime: true,
          notarized: false,
        },
      }),
      { platform: 'darwin', arch: 'arm64' },
    );
    if (parsedUnnotarized.platform !== 'darwin') throw new Error('expected darwin');
    expect(() => verifyDarwinReleaseManifest(parsedUnnotarized, { requireSigned: true })).toThrow(
      /Hardened Runtime and notarization/,
    );

    await expect(
      validateUpdateFeed({
        feedUrl: 'http://127.0.0.1:4123/feed',
        platform: 'darwin',
        arch: 'arm64',
        allowUnsigned: true,
        expectedTeamId: TEAM_ID,
        fetch: mockFeedFetch({
          'http://127.0.0.1:4123/feed/release-manifest.json': new Response(
            macManifestJson({
              signed: false,
              signing: {
                algorithm: 'sha256',
                teamId: null,
                bundleId: APPLE_BUNDLE_ID,
                hardenedRuntime: false,
                notarized: false,
              },
            }),
            { status: 200 },
          ),
        }),
      }),
    ).rejects.toThrow(/Refused unsigned macOS release manifest/);

    await expect(
      prepareVerifiedUpdate({
        feedUrl: FEED,
        platform: 'darwin',
        arch: 'arm64',
        fetch: mockFeedFetch({
          [`${FEED}/release-manifest.json`]: new Response(macManifestJson(), { status: 200 }),
        }),
        stagingDir: join(makeTempDir(), 'mac-no-trust'),
        verifySignedPackage: async () => undefined,
      }),
    ).rejects.toThrow(/trusted Apple Team ID/);

    await expect(
      prepareVerifiedUpdate({
        feedUrl: FEED,
        platform: 'darwin',
        arch: 'arm64',
        expectedTeamId: TEAM_ID,
        fetch: mockFeedFetch({
          [`${FEED}/release-manifest.json`]: new Response(
            macManifestJson({
              signing: {
                algorithm: 'sha256',
                teamId: 'OTHERTEAM1',
                bundleId: APPLE_BUNDLE_ID,
                hardenedRuntime: true,
                notarized: true,
              },
            }),
            { status: 200 },
          ),
        }),
        stagingDir: join(makeTempDir(), 'mac-mismatch'),
        verifySignedPackage: async () => undefined,
      }),
    ).rejects.toThrow(/does not match/);
  });

  it('rejects tampered macOS archives before verification and enforces ZIP traversal, Zip64, symlink, codesign, and spctl bounds', async () => {
    const zipBytes = buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/MacOS/Ludy Desktop`, dataSize: 16 }]);
    const zipSha256 = createHash('sha256').update(zipBytes).digest('hex');

    let verifierCalled = false;
    await expect(
      prepareVerifiedUpdate({
        feedUrl: FEED,
        platform: 'darwin',
        arch: 'arm64',
        expectedTeamId: TEAM_ID,
        fetch: mockFeedFetch({
          [`${FEED}/release-manifest.json`]: new Response(
            macManifestJson({ zipSha256, zipSize: zipBytes.length }),
            { status: 200 },
          ),
          [`${FEED}/LudyDesktop-0.2.0-darwin-arm64.zip`]: new Response(Buffer.alloc(zipBytes.length, 0xaa), {
            status: 200,
          }),
        }),
        stagingDir: join(makeTempDir(), 'mac-tampered-zip'),
        verifySignedPackage: async () => {
          verifierCalled = true;
        },
      }),
    ).rejects.toThrow(/SHA-256 or size mismatch/);
    expect(verifierCalled).toBe(false);

    const staged = await prepareVerifiedUpdate({
      feedUrl: FEED,
      platform: 'darwin',
      arch: 'arm64',
      expectedTeamId: TEAM_ID,
      fetch: mockFeedFetch({
        [`${FEED}/release-manifest.json`]: new Response(
          macManifestJson({ zipSha256, zipSize: zipBytes.length }),
          { status: 200 },
        ),
        [`${FEED}/LudyDesktop-0.2.0-darwin-arm64.zip`]: new Response(zipBytes, { status: 200 }),
      }),
      stagingDir: join(makeTempDir(), 'mac-good-zip'),
      verifySignedPackage: async (pkgPath, team, target) => {
        expect(team).toBe(TEAM_ID);
        expect(target).toEqual({ version: '0.2.0', arch: 'arm64' });
        inspectZipCentralDirectory(pkgPath, { requiredTopDir: `${MAC_APP_BUNDLE_NAME}/` });
      },
    });
    expect(staged.status).toBe('staged');
    if (staged.status !== 'staged') throw new Error('expected staged');
    expect(existsSync(join(staged.stagingDir, staged.packageFile))).toBe(true);

    const dir = makeTempDir();
    const evilZip = join(dir, 'evil.zip');
    writeFileSync(evilZip, buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/../evil` }]));
    expect(() => inspectZipCentralDirectory(evilZip)).toThrow(/Path traversal/);

    const evilAppleDouble = join(dir, 'evil-appledouble.zip');
    writeFileSync(evilAppleDouble, buildTestZip([{ name: '__MACOSX/Evil.app/Contents/MacOS/evil' }]));
    expect(() => inspectZipCentralDirectory(evilAppleDouble)).toThrow(/Unexpected ZIP entry outside/);

    const dupZip = join(dir, 'dup.zip');
    writeFileSync(
      dupZip,
      buildTestZip([
        { name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` },
        { name: `${MAC_APP_BUNDLE_NAME}/contents/info.plist` },
      ]),
    );
    expect(() => inspectZipCentralDirectory(dupZip)).toThrow(/Duplicate/);

    const zip64 = join(dir, 'zip64.zip');
    writeFileSync(
      zip64,
      buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` }], { entryCount: 0xffff }),
    );
    expect(() => inspectZipCentralDirectory(zip64)).toThrow(/Zip64/);

    const declaredBombZip = join(dir, 'declared-bomb.zip');
    writeFileSync(
      declaredBombZip,
      buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Resources/blob`, uncompressedSizeOverride: 500_000_000 }]),
    );
    expect(() =>
      inspectZipCentralDirectory(declaredBombZip, { maxTotalUncompressedBytes: 1024 * 1024 }),
    ).toThrow(/safety limit/);

    // Forged Central Directory claiming 64 bytes while compressed deflate stream actually expands to 2 MiB.
    const rawBombBytes = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const realBombPayload = deflateRawSync(rawBombBytes);
    const bombCrc = zlibCrc32(rawBombBytes) >>> 0;
    const nameBuf = Buffer.from(`${MAC_APP_BUNDLE_NAME}/Contents/Resources/payload`, 'utf8');
    const bombLh = Buffer.alloc(30 + nameBuf.length);
    bombLh.writeUInt32LE(0x04034b50, 0);
    bombLh.writeUInt16LE(20, 4);
    bombLh.writeUInt16LE(8, 8);
    bombLh.writeUInt32LE(bombCrc, 14);
    bombLh.writeUInt32LE(realBombPayload.length, 18);
    bombLh.writeUInt32LE(64, 22);
    bombLh.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(bombLh, 30);
    const bombCd = Buffer.alloc(46 + nameBuf.length);
    bombCd.writeUInt32LE(0x02014b50, 0);
    bombCd.writeUInt16LE(20, 4);
    bombCd.writeUInt16LE(20, 6);
    bombCd.writeUInt16LE(8, 10);
    bombCd.writeUInt32LE(bombCrc, 16);
    bombCd.writeUInt32LE(realBombPayload.length, 20);
    bombCd.writeUInt32LE(64, 24);
    bombCd.writeUInt16LE(nameBuf.length, 28);
    bombCd.writeUInt32LE(0, 42);
    nameBuf.copy(bombCd, 46);
    const bombEocd = Buffer.alloc(22);
    bombEocd.writeUInt32LE(0x06054b50, 0);
    bombEocd.writeUInt16LE(1, 8);
    bombEocd.writeUInt16LE(1, 10);
    bombEocd.writeUInt32LE(bombCd.length, 12);
    bombEocd.writeUInt32LE(bombLh.length + realBombPayload.length, 16);
    const forgedDeflateBomb = join(dir, 'forged-deflate-bomb.zip');
    writeFileSync(forgedDeflateBomb, Buffer.concat([bombLh, realBombPayload, bombCd, bombEocd]));

    await expect(
      verifyZipDecompressedSizeBounds(forgedDeflateBomb, { maxTotalUncompressedBytes: 1024 * 1024 }),
    ).rejects.toThrow(/actual decompressed size exceeds safety limit/);

    // Local File Header mismatch vs Central Directory (name mismatch & size mismatch) must fail before extraction.
    const mismatchBuf = buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist`, dataSize: 8 }]);
    mismatchBuf.write('Evil.app', 30, 'utf8');
    const lfhNameMismatchZip = join(dir, 'lfh-name-mismatch.zip');
    writeFileSync(lfhNameMismatchZip, mismatchBuf);
    await expect(verifyZipDecompressedSizeBounds(lfhNameMismatchZip)).rejects.toThrow(/local header filename mismatch/);

    const sizeMismatchBuf = buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist`, dataSize: 8 }]);
    sizeMismatchBuf.writeUInt32LE(128, 22);
    const lfhSizeMismatchZip = join(dir, 'lfh-size-mismatch.zip');
    writeFileSync(lfhSizeMismatchZip, sizeMismatchBuf);
    await expect(verifyZipDecompressedSizeBounds(lfhSizeMismatchZip)).rejects.toThrow(/local header metadata mismatch/);

    let dittoInvokedOnBomb = false;
    await expect(
      verifyMacSignedPackage(forgedDeflateBomb, TEAM_ID, {
        platform: 'darwin',
        execCmd: async (file) => {
          if (file === 'ditto') dittoInvokedOnBomb = true;
          return { stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/actual decompressed size exceeds safety limit/);
    expect(dittoInvokedOnBomb).toBe(false);

    if (process.platform !== 'win32') {
      const symBundle = join(dir, 'sym-bundle');
      mkdirSync(join(symBundle, 'Contents', 'MacOS'), { recursive: true });
      symlinkSync('/etc/passwd', join(symBundle, 'Contents', 'MacOS', 'escape'));
      expect(() => verifyExtractedDirectorySymlinks(symBundle)).toThrow(/absolute symlink/);

      const externalBundle = join(dir, 'External.app');
      mkdirSync(join(externalBundle, 'Contents', 'MacOS'), { recursive: true });
      const rootSym = join(dir, 'RootSym.app');
      symlinkSync(externalBundle, rootSym);
      expect(() => verifyExtractedDirectorySymlinks(rootSym)).toThrow(/Refused symlink/);
    }

    expect(() =>
      parseInfoPlistJson(
        JSON.stringify({ CFBundleIdentifier: APPLE_BUNDLE_ID, CFBundleShortVersionString: '0.1.0' }),
        { expectedVersion: '0.2.0' },
      ),
    ).toThrow(/version mismatch/);

    expect(() =>
      parseCodesignDisplayOutput(
        [
          `Identifier=${APPLE_BUNDLE_ID}`,
          'Format=app bundle with Mach-O thin (x86_64)',
          'CodeDirectory v=20500 size=100 flags=0x10000(runtime)',
          'Hash type=sha256 size=32',
          `Authority=Developer ID Application: Ludy (${TEAM_ID})`,
          'Authority=Developer ID Certification Authority',
          'Authority=Apple Root CA',
          'Timestamp=Nov 26, 2026',
          `TeamIdentifier=${TEAM_ID}`,
          'Sealed Resources version=2',
        ].join('\n'),
        { expectedTeamId: TEAM_ID, expectedArch: 'arm64' },
      ),
    ).toThrow(/architecture \(x64\) does not match expected arm64/);

    expect(() =>
      parseCodesignDisplayOutput(
        [
          `Identifier=${APPLE_BUNDLE_ID}`,
          'CodeDirectory v=20500 size=100 flags=0x0(none)',
          'Hash type=sha256 size=32',
          `Authority=Developer ID Application: Ludy (${TEAM_ID})`,
          'Authority=Developer ID Certification Authority',
          'Authority=Apple Root CA',
          'Timestamp=Nov 26, 2026',
          `TeamIdentifier=${TEAM_ID}`,
          'Sealed Resources version=2',
        ].join('\n'),
        { expectedTeamId: TEAM_ID },
      ),
    ).toThrow(/Hardened Runtime/);

    expect(() =>
      parseSpctlAssessOutput('/app: rejected\nsource=no usable signature', { expectedTeamId: TEAM_ID }),
    ).toThrow(/did not accept/);

    const goodMacZip = join(dir, 'LudyDesktop-0.2.0-darwin-arm64.zip');
    writeFileSync(goodMacZip, zipBytes);
    await expect(verifyMacSignedPackage(evilZip, null, { platform: 'darwin' })).rejects.toThrow(/Team ID/);
    await expect(
      verifyMacSignedPackage(goodMacZip, TEAM_ID, {
        platform: 'darwin',
        expectedVersion: '0.2.0',
        expectedArch: 'arm64',
        execCmd: async (file, args) => {
          if (file === 'ditto') {
            mkdirSync(join(args[3]!, MAC_APP_BUNDLE_NAME, 'Contents', 'MacOS'), { recursive: true });
            return { stdout: '', stderr: '' };
          }
          if (file === 'codesign' && args.includes('--verify')) {
            return { stdout: 'Ludy Desktop.app: valid on disk\nLudy Desktop.app: satisfies its Designated Requirement', stderr: '' };
          }
          if (file === 'codesign' && args.includes('--display')) {
            return {
              stdout: [
                `Identifier=${APPLE_BUNDLE_ID}`,
                'Format=app bundle with Mach-O thin (arm64)',
                'CodeDirectory v=20500 size=100 flags=0x10000(runtime)',
                'Hash type=sha256 size=32',
                `Authority=Developer ID Application: Ludy (${TEAM_ID})`,
                'Authority=Developer ID Certification Authority',
                'Authority=Apple Root CA',
                'Timestamp=Nov 26, 2026',
                `TeamIdentifier=${TEAM_ID}`,
                'Sealed Resources version=2',
              ].join('\n'),
              stderr: '',
            };
          }
          if (file === 'plutil') {
            return {
              stdout: JSON.stringify({ CFBundleIdentifier: APPLE_BUNDLE_ID, CFBundleShortVersionString: '0.1.9' }),
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/version mismatch/);

    // B1: Pre-extraction ZIP smuggling (prepended unreferenced LFH, gap, overlap, split counts, control chars, special UNIX modes, escaping/traversing symlinks)
    const smuggledPrefix = Buffer.from('PK\x03\x04SMUGGLED-LOCAL-HEADER');
    const prependedZip = join(dir, 'prepended-smuggle.zip');
    writeFileSync(
      prependedZip,
      buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` }], { prependBytes: smuggledPrefix }),
    );
    let dittoCalledOnPrepend = false;
    await expect(
      verifyMacSignedPackage(prependedZip, TEAM_ID, {
        platform: 'darwin',
        execCmd: async (file) => {
          if (file === 'ditto') dittoCalledOnPrepend = true;
          return { stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/not contiguous/);
    expect(dittoCalledOnPrepend).toBe(false);

    const gapBetweenZip = join(dir, 'gap-between.zip');
    writeFileSync(
      gapBetweenZip,
      buildTestZip([
        { name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist`, gapAfterBytes: 12 },
        { name: `${MAC_APP_BUNDLE_NAME}/Contents/MacOS/Ludy Desktop` },
      ]),
    );
    await expect(verifyZipDecompressedSizeBounds(gapBetweenZip)).rejects.toThrow(/not contiguous/);

    const preCdGapZip = join(dir, 'pre-cd-gap.zip');
    writeFileSync(
      preCdGapZip,
      buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` }], {
        preCdGapBytes: Buffer.from('unreferenced-bytes'),
      }),
    );
    await expect(verifyZipDecompressedSizeBounds(preCdGapZip)).rejects.toThrow(/unreferenced bytes/);

    const overlapZip = join(dir, 'overlap-lfh.zip');
    writeFileSync(
      overlapZip,
      buildTestZip([
        { name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` },
        { name: `${MAC_APP_BUNDLE_NAME}/Contents/MacOS/Ludy Desktop`, localOffsetOverride: 0 },
      ]),
    );
    await expect(verifyZipDecompressedSizeBounds(overlapZip)).rejects.toThrow(/not contiguous/);

    const splitCountZip = join(dir, 'split-count.zip');
    writeFileSync(
      splitCountZip,
      buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` }], { diskEntryCount: 2, entryCount: 1 }),
    );
    expect(() => inspectZipCentralDirectory(splitCountZip)).toThrow(/Split ZIP central directory/);

    const postCdGapZip = join(dir, 'post-cd-gap.zip');
    writeFileSync(
      postCdGapZip,
      buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` }], { postCdGapBytes: Buffer.from('junk') }),
    );
    expect(() => inspectZipCentralDirectory(postCdGapZip)).toThrow(/central directory bounds are invalid/);

    const controlCharZip = join(dir, 'control-char.zip');
    writeFileSync(controlCharZip, buildTestZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info\n.plist` }]));
    expect(() => inspectZipCentralDirectory(controlCharZip)).toThrow(/Unsafe ZIP entry path/);

    for (const [label, mode] of [
      ['fifo', 0o010644],
      ['chardev', 0o020600],
      ['socket', 0o140755],
      ['setuid', 0o104755],
      ['setgid', 0o102755],
    ] as const) {
      const badModeZip = join(dir, `unix-${label}.zip`);
      writeFileSync(
        badModeZip,
        buildTestZip([
          {
            name: `${MAC_APP_BUNDLE_NAME}/Contents/MacOS/${label}`,
            versionMadeBy: 0x031e,
            externalFileAttributes: (mode << 16) >>> 0,
          },
        ]),
      );
      expect(() => inspectZipCentralDirectory(badModeZip), label).toThrow(/UNIX/);
    }

    const escapingSymZip = join(dir, 'escaping-symlink.zip');
    writeFileSync(
      escapingSymZip,
      buildTestZip([
        {
          name: `${MAC_APP_BUNDLE_NAME}/Contents/MacOS/escape`,
          payload: Buffer.from('../../../etc/passwd', 'utf8'),
          compress: true,
          versionMadeBy: 0x031e,
          externalFileAttributes: (0o120755 << 16) >>> 0,
        },
      ]),
    );
    let dittoCalledOnSym = false;
    await expect(
      verifyMacSignedPackage(escapingSymZip, TEAM_ID, {
        platform: 'darwin',
        execCmd: async (file) => {
          if (file === 'ditto') dittoCalledOnSym = true;
          return { stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/Escaping pre-extraction ZIP symlink/);
    expect(dittoCalledOnSym).toBe(false);

    const symTraversalZip = join(dir, 'symlink-prefix-traversal.zip');
    writeFileSync(
      symTraversalZip,
      buildTestZip([
        {
          name: `${MAC_APP_BUNDLE_NAME}/Contents/MacOS/link`,
          payload: Buffer.from('../Resources', 'utf8'),
          versionMadeBy: 0x031e,
          externalFileAttributes: (0o120755 << 16) >>> 0,
        },
        {
          name: `${MAC_APP_BUNDLE_NAME}/Contents/MacOS/link/pwned`,
          payload: Buffer.from('payload', 'utf8'),
          versionMadeBy: 0x031e,
          externalFileAttributes: (0o100644 << 16) >>> 0,
        },
      ]),
    );
    await expect(verifyZipDecompressedSizeBounds(symTraversalZip)).rejects.toThrow(/traverses through symlink/);

    const validBundleSymZip = join(dir, 'valid-framework-symlink.zip');
    writeFileSync(
      validBundleSymZip,
      buildTestZip([
        {
          name: `${MAC_APP_BUNDLE_NAME}/Contents/Frameworks/Test.framework/Versions/A/Test`,
          payload: Buffer.from('mach-o', 'utf8'),
          compress: true,
          useDataDescriptor: true,
          ddWithSignature: true,
          versionMadeBy: 0x031e,
          externalFileAttributes: (0o100755 << 16) >>> 0,
        },
        {
          name: `${MAC_APP_BUNDLE_NAME}/Contents/Frameworks/Test.framework/Versions/Current`,
          payload: Buffer.from('A', 'utf8'),
          compress: true,
          useDataDescriptor: true,
          ddWithSignature: true,
          versionMadeBy: 0x031e,
          externalFileAttributes: (0o120700 << 16) >>> 0,
        },
        {
          name: `${MAC_APP_BUNDLE_NAME}/Contents/Frameworks/Test.framework/Versions/._Current`,
          payload: Buffer.from('appledouble', 'utf8'),
          versionMadeBy: 0x031e,
          externalFileAttributes: (0o100600 << 16) >>> 0,
        },
      ]),
    );
    await expect(verifyZipDecompressedSizeBounds(validBundleSymZip)).resolves.toMatchObject({ entryCount: 3 });

    // B2: Spoofed/duplicated codesign outputs and incomplete .dmg certificate chains
    expect(() =>
      parseCodesignVerifyOutput(
        'Ludy Desktop.app: valid on disk spoof\nLudy Desktop.app: satisfies its Designated Requirement',
      ),
    ).toThrow(/valid on disk/);
    expect(() =>
      parseCodesignDisplayOutput(
        [
          `Identifier=${APPLE_BUNDLE_ID}`,
          'CodeDirectory v=20500 size=100 flags=0x10000(runtime)',
          'Hash type=sha256 size=32',
          `Authority=Developer ID Application: Ludy (${TEAM_ID})`,
          'Authority=Developer ID Certification Authority',
          'Authority=Apple Root CA',
          'Timestamp=Nov 26, 2026',
          `TeamIdentifier=${TEAM_ID}`,
          'TeamIdentifier=EVILTEAM99',
          'Sealed Resources version=2',
        ].join('\n'),
        { expectedTeamId: TEAM_ID },
      ),
    ).toThrow(/Duplicate codesign --display/);
    expect(() =>
      parseCodesignDisplayOutput(
        [
          `Identifier=${APPLE_BUNDLE_ID}`,
          'CodeDirectory v=20500 size=100 flags=0x10000(runtime)',
          'Hash type=sha256 size=32',
          `Authority=Developer ID Application: Ludy (${TEAM_ID})`,
          'Authority=Developer ID Certification Authority',
          'Authority=Apple Root CA',
          'Timestamp=Nov 26, 2026',
          `TeamIdentifier=${TEAM_ID}`,
          'Sealed Resources version=2',
          'InjectedLine=evil',
        ].join('\n'),
        { expectedTeamId: TEAM_ID },
      ),
    ).toThrow(/Unexpected codesign --display/);

    const badDmgPath = join(dir, 'LudyDesktop-0.2.0-darwin-arm64.dmg');
    await expect(
      verifyMacDmgPackage(badDmgPath, TEAM_ID, {
        platform: 'darwin',
        execCmd: async (file, args) => {
          if (file === 'codesign' && args.includes('--verify')) {
            return { stdout: `${badDmgPath}: valid on disk\n${badDmgPath}: satisfies its Designated Requirement`, stderr: '' };
          }
          if (file === 'codesign' && args.includes('--display')) {
            return {
              stdout: [
                'CodeDirectory v=20400 size=100 flags=0x0(none)',
                'Hash type=sha256 size=32',
                `Authority=Developer ID Application: Ludy (${TEAM_ID})`,
                'Authority=Self Signed CA',
                'Timestamp=Nov 26, 2026',
                `TeamIdentifier=${TEAM_ID}`,
              ].join('\n'),
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/chain exclusively/);
  });
});

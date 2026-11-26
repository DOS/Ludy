// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELEASE_MANIFEST_SCRIPT_FILENAME } from '../src/authenticode.ts';
import type { FetchLike } from '../src/exchange.ts';
import {
  parseFeedOrigin,
  parseReleasesManifest,
  prepareVerifiedUpdate,
  RELEASE_MANIFEST_SIG_FILENAME,
  resolveFeedUrl,
  validateUpdateFeed,
} from '../src/update-feed.ts';

const FEED = 'https://updates.example.vn/ludy-desktop';
const SHA1_A = '1111111111111111111111111111111111111111';
const SHA1_B = '2222222222222222222222222222222222222222';
const SHA256_B = 'a'.repeat(64);
const SHA256_SETUP = 'b'.repeat(64);
const THUMB = 'c'.repeat(40);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ludy-feed-test-'));
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

describe('update feed product flows', () => {
  it('resolves feed paths and picks latest full semver in RELEASES', () => {
    expect(parseFeedOrigin('https://updates.example.vn/')).toEqual({ ok: true, url: 'https://updates.example.vn' });
    expect(resolveFeedUrl('/feed/win32', { ludyUrl: 'https://ludy.example.vn' })).toEqual({
      ok: true,
      url: 'https://ludy.example.vn/feed/win32',
    });

    const text = [
      `${SHA1_A} LudyDesktop-0.1.0-full.nupkg 9000000`,
      `${SHA1_B} ${FEED}/LudyDesktop-0.1.1-full.nupkg 11000000`,
    ].join('\n');
    const parsed = parseReleasesManifest(text, FEED);
    expect(parsed.latestFull).toEqual({
      sha1: SHA1_B,
      file: 'LudyDesktop-0.1.1-full.nupkg',
      downloadUrl: `${FEED}/LudyDesktop-0.1.1-full.nupkg`,
      size: 11000000,
      version: '0.1.1',
      kind: 'full',
    });
  });

  it('validates signed HTTPS feeds, optional Ed25519 manifest signatures, and unsigned loopback feeds', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const manifestBytes = Buffer.from(validManifestJson(), 'utf8');
    const sigBase64 = cryptoSign(null, manifestBytes, privateKey).toString('base64');

    const out = await validateUpdateFeed({
      feedUrl: FEED,
      fetch: mockFeedFetch({
        [`${FEED}/RELEASES`]: new Response(`${SHA1_B} LudyDesktop-0.1.1-full.nupkg 11000000\n`, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
        [`${FEED}/release-manifest.json`]: new Response(manifestBytes, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        [`${FEED}/${RELEASE_MANIFEST_SIG_FILENAME}`]: new Response(`${sigBase64}\n`, { status: 200 }),
      }),
      allowedOrigin: 'https://updates.example.vn',
      expectedPublisherThumbprint: THUMB.toUpperCase(),
      expectedManifestPublicKey: pubPem,
      lookupHost: async () => [{ address: '93.184.216.34' }],
    });
    expect(out.releases.latestFull.version).toBe('0.1.1');
    expect(out.manifest?.signed).toBe(true);

    const loopback = 'http://127.0.0.1:4010/feed';
    const okLoopback = await validateUpdateFeed({
      feedUrl: loopback,
      allowUnsigned: true,
      fetch: mockFeedFetch({
        [`${loopback}/RELEASES`]: new Response(`${SHA1_B} LudyDesktop-0.1.1-full.nupkg 11000000\n`, { status: 200 }),
        [`${loopback}/release-manifest.json`]: new Response(
          validManifestJson({
            signed: false,
            signing: { algorithm: 'sha256', timestampServer: null, publisherThumbprint: null },
          }),
          { status: 200 },
        ),
      }),
    });
    expect(okLoopback.manifest?.signed).toBe(false);
  });
});

describe('prepareVerifiedUpdate', () => {
  it('verifies signed manifest script, hashes streamed nupkg once, verifies PE signatures, and stages locally', async () => {
    const payload = Buffer.from('signed-nupkg-archive-payload-v2');
    const sha1 = createHash('sha1').update(payload).digest('hex');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const stagingDir = join(makeTempDir(), 'staging');
    const manifestJson = validManifestJson({
      packages: [
        {
          file: 'LudyDesktop-0.1.1-full.nupkg',
          kind: 'full',
          version: '0.1.1',
          sha1,
          sha256,
          size: payload.length,
        },
      ],
    });
    const fetchOk = mockFeedFetch({
      [`${FEED}/RELEASES`]: new Response(`${sha1.toUpperCase()} LudyDesktop-0.1.1-full.nupkg ${payload.length}\n`, { status: 200 }),
      [`${FEED}/release-manifest.json`]: new Response(manifestJson, { status: 200 }),
      [`${FEED}/${RELEASE_MANIFEST_SCRIPT_FILENAME}`]: new Response('# signed ps1', { status: 200 }),
      [`${FEED}/LudyDesktop-0.1.1-full.nupkg`]: new Response(payload, { status: 200 }),
    });

    const upToDate = await prepareVerifiedUpdate({
      feedUrl: FEED,
      fetch: fetchOk,
      currentVersion: '0.1.1',
      expectedPublisherThumbprint: THUMB,
      stagingDir,
      verifySignedManifest: async () => undefined,
      verifySignedPackage: async () => undefined,
    });
    expect(upToDate).toEqual({ status: 'up-to-date', version: '0.1.1' });

    const verifiedPaths: string[] = [];
    const verifiedManifests: string[] = [];
    const staged = await prepareVerifiedUpdate({
      feedUrl: FEED,
      fetch: fetchOk,
      currentVersion: '0.1.0',
      stagingDir,
      expectedPublisherThumbprint: THUMB,
      verifySignedManifest: async (scriptPath, expectedBytes, expectedThumb) => {
        expect(expectedThumb).toBe(THUMB);
        expect(expectedBytes.toString('utf8')).toBe(manifestJson);
        verifiedManifests.push(scriptPath);
      },
      verifySignedPackage: async (pkgPath, expected) => {
        expect(expected).toBe(THUMB);
        verifiedPaths.push(pkgPath);
      },
    });
    expect(verifiedManifests).toHaveLength(1);
    expect(verifiedPaths).toHaveLength(1);
    expect(staged).toEqual({
      status: 'staged',
      version: '0.1.1',
      stagingDir,
      packageFile: 'LudyDesktop-0.1.1-full.nupkg',
      sha1,
      sha256,
      size: payload.length,
    });
    expect(readFileSync(join(stagingDir, 'LudyDesktop-0.1.1-full.nupkg')).equals(payload)).toBe(true);
    expect(readFileSync(join(stagingDir, 'RELEASES'), 'utf8')).toBe(`${sha1.toUpperCase()} LudyDesktop-0.1.1-full.nupkg ${payload.length}\n`);
    expect(existsSync(join(stagingDir, `${RELEASE_MANIFEST_SCRIPT_FILENAME}.part`))).toBe(false);

    // Corrupted nupkg fails checksum verification before verifySignedPackage runs.
    const corrupt = Buffer.from(payload);
    corrupt.writeUInt8(corrupt.readUInt8(0) ^ 0xff, 0);
    let verifierCalled = false;
    await expect(
      prepareVerifiedUpdate({
        feedUrl: FEED,
        fetch: mockFeedFetch({
          [`${FEED}/RELEASES`]: new Response(`${sha1.toUpperCase()} LudyDesktop-0.1.1-full.nupkg ${payload.length}\n`, { status: 200 }),
          [`${FEED}/release-manifest.json`]: new Response(manifestJson, { status: 200 }),
          [`${FEED}/${RELEASE_MANIFEST_SCRIPT_FILENAME}`]: new Response('# signed ps1', { status: 200 }),
          [`${FEED}/LudyDesktop-0.1.1-full.nupkg`]: new Response(corrupt, { status: 200 }),
        }),
        expectedPublisherThumbprint: THUMB,
        stagingDir: join(makeTempDir(), 'staging-bad'),
        verifySignedManifest: async () => undefined,
        verifySignedPackage: async () => {
          verifierCalled = true;
        },
      }),
    ).rejects.toThrow(/checksum verification/i);
    expect(verifierCalled).toBe(false);
  });

  it('validates and stages macOS darwin-arm64 updates via release-manifest.json and Team ID pin', async () => {
    const zipBytes = Buffer.from('signed-notarized-macos-zip-payload');
    const sha256 = createHash('sha256').update(zipBytes).digest('hex');
    const teamId = 'AB12CD34EF';
    const macFeed = 'https://updates.example.vn/ludy-desktop/darwin-arm64';
    const macManifest = JSON.stringify({
      schemaVersion: 1,
      product: 'ludy-desktop',
      platform: 'darwin',
      arch: 'arm64',
      version: '0.1.2',
      signed: true,
      signing: {
        algorithm: 'sha256',
        teamId,
        bundleId: 'vn.ludy.desktop',
        hardenedRuntime: true,
        notarized: true,
      },
      installer: {
        file: 'LudyDesktop-0.1.2-darwin-arm64.dmg',
        sha256: 'e'.repeat(64),
        size: 1024000,
      },
      packages: [
        {
          file: 'LudyDesktop-0.1.2-darwin-arm64.zip',
          kind: 'full',
          version: '0.1.2',
          sha256,
          size: zipBytes.length,
        },
      ],
    });

    const verifiedTeams: Array<string | null> = [];
    const staged = await prepareVerifiedUpdate({
      feedUrl: macFeed,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.1.1',
      expectedTeamId: teamId.toLowerCase(),
      stagingDir: join(makeTempDir(), 'stage-mac'),
      fetch: mockFeedFetch({
        [`${macFeed}/release-manifest.json`]: new Response(macManifest, { status: 200 }),
        [`${macFeed}/LudyDesktop-0.1.2-darwin-arm64.zip`]: new Response(zipBytes, { status: 200 }),
      }),
      verifySignedPackage: async (_pkgPath, expected) => {
        verifiedTeams.push(expected);
      },
    });
    expect(verifiedTeams).toEqual([teamId]);
    expect(staged).toMatchObject({
      status: 'staged',
      version: '0.1.2',
      packageFile: 'LudyDesktop-0.1.2-darwin-arm64.zip',
      sha256,
      size: zipBytes.length,
    });
    expect(readFileSync(join(staged.status === 'staged' ? staged.stagingDir : '', 'LudyDesktop-0.1.2-darwin-arm64.zip')).equals(zipBytes)).toBe(true);

    const upToDate = await prepareVerifiedUpdate({
      feedUrl: macFeed,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.1.2',
      expectedTeamId: teamId,
      stagingDir: join(makeTempDir(), 'stage-mac-current'),
      fetch: mockFeedFetch({
        [`${macFeed}/release-manifest.json`]: new Response(macManifest, { status: 200 }),
      }),
      verifySignedPackage: async () => undefined,
    });
    expect(upToDate).toEqual({ status: 'up-to-date', version: '0.1.2' });
  });
});

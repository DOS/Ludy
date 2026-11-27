// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for @ludy/github webhook HMAC, JWT minting, key/branch extraction, sanitization, and host-locked client (#5158).
import { createHmac, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GithubError,
  createGithubAppJwt,
  createGithubClient,
  extractBranchTaskKeys,
  extractLudyTaskIdsFromText,
  extractTaskKeyMentions,
  extractUnverifiedInstallationId,
  parseGithubWebhookPayload,
  sanitizeBranchName,
  sanitizeGithubLogin,
  sanitizeGithubText,
  verifyGithubWebhookSignature,
} from '../src/index.ts';

describe('@ludy/github', () => {
  it('verifies X-Hub-Signature-256 over raw bytes including secret rotation', () => {
    const raw = Buffer.from('{"action":"opened"}', 'utf8');
    const primary = 'primary-webhook-secret-123456';
    const previous = 'previous-webhook-secret-987654';
    const sigPrimary = `sha256=${createHmac('sha256', primary).update(raw).digest('hex')}`;
    const sigPrev = `sha256=${createHmac('sha256', previous).update(raw).digest('hex')}`;

    expect(verifyGithubWebhookSignature(raw, sigPrimary, [primary, previous])).toBe(true);
    expect(verifyGithubWebhookSignature(raw, sigPrev, [primary, previous])).toBe(true);
    expect(verifyGithubWebhookSignature(Buffer.from('{"action":"closed"}', 'utf8'), sigPrimary, [primary])).toBe(false);
    expect(verifyGithubWebhookSignature(raw, 'sha1=deadbeef', [primary])).toBe(false);
    expect(verifyGithubWebhookSignature(raw, undefined, [primary])).toBe(false);
  });

  it('mints RS256 GitHub App JWT verifiable with matching public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const jwt = createGithubAppJwt('987654', pem, 1_700_000_000);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(payload.iss).toBe('987654');
    expect(payload.iat).toBe(1_699_999_940);
    expect(payload.exp).toBe(1_700_000_540);

    const verified = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      publicKey,
      Buffer.from(parts[2] ?? '', 'base64url'),
    );
    expect(verified).toBe(true);
  });

  it('extracts closing/non-closing mentions, branch task keys, and matching project task URLs', () => {
    const text = 'See PROJ-10 and closes #/PROJ-42; also Fixes PROJ-99.\nhttps://app.ludy.vn/o/demo/projects/11111111-1111-4111-8111-111111111111?task=22222222-2222-4222-8222-222222222222';
    expect(extractTaskKeyMentions(text, 'proj')).toEqual([
      { taskNumber: 10, closesTask: false, linkSource: 'mention' },
      { taskNumber: 42, closesTask: true, linkSource: 'mention' },
      { taskNumber: 99, closesTask: true, linkSource: 'mention' },
    ]);
    expect(extractBranchTaskKeys('feat/PROJ-77-github-sync', 'PROJ')).toEqual([77]);
    expect(
      extractLudyTaskIdsFromText(text, '11111111-1111-4111-8111-111111111111'),
    ).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(
      extractLudyTaskIdsFromText(text, '99999999-9999-4999-8999-999999999999'),
    ).toEqual([]);
  });

  it('strips bidi format characters, control chars, and raw HTML tags from untrusted GitHub payloads', () => {
    const evilTitle = 'Fix \u202E<script>alert(1)</script> PROJ-5\u200B bug';
    expect(sanitizeGithubText(evilTitle)).toBe('Fix alert(1) PROJ-5 bug');
    expect(sanitizeGithubLogin('octocat\u200B')).toBe('octocat');
    expect(sanitizeGithubLogin('bad user login!')).toBeNull();
    expect(sanitizeBranchName('feat/../../evil')).toBeNull();
    expect(sanitizeBranchName('feat/PROJ-5\u200B_clean')).toBe('feat/PROJ-5_clean');

    const rawWebhook = Buffer.from(
      JSON.stringify({
        action: 'closed',
        installation: { id: 555123 },
        repository: { id: 1, full_name: 'acme/ludy-demo' },
        pull_request: {
          number: 88,
          title: 'Closes PROJ-5 <b>important</b>\u202E',
          body: '<img src=x onerror=alert(1)>Closes PROJ-5',
          state: 'closed',
          merged: true,
          draft: false,
          html_url: 'https://github.com/acme/ludy-demo/pull/88',
          updated_at: '2027-01-01T00:00:00Z',
          user: { login: 'alice-dev' },
          head: { ref: 'feat/PROJ-5-patch' },
        },
      }),
      'utf8',
    );
    expect(extractUnverifiedInstallationId(rawWebhook)).toBe(555123);
    const parsed = parseGithubWebhookPayload('pull_request', rawWebhook);
    expect(parsed).toMatchObject({
      eventType: 'pull_request',
      action: 'closed',
      repoFullName: 'acme/ludy-demo',
      number: 88,
      title: 'Closes PROJ-5 important',
      externalState: 'merged',
      merged: true,
      branchName: 'feat/PROJ-5-patch',
      authorLogin: 'alice-dev',
    });
  });

  it('calls only https://api.github.com and caches GitHub App installation tokens', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const calls: string[] = [];

    const client = createGithubClient({
      app: { appId: '4242', privateKeyPem: pem },
      now: () => 1_700_000_000_000,
      transport: async (req) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url === 'https://api.github.com/app/installations/101/access_tokens') {
          return {
            status: 201,
            body: JSON.stringify({ token: 'ghs_test_token_123456', expires_at: '2023-11-15T00:00:00Z' }),
          };
        }
        if (req.url === 'https://api.github.com/installation/repositories?per_page=100') {
          return {
            status: 200,
            body: JSON.stringify({
              repositories: [{ id: 1, full_name: 'acme/web', default_branch: 'main', private: true }],
            }),
          };
        }
        if (req.url === 'https://api.github.com/repos/acme/web/pulls/999') {
          return { status: 404, body: '{"message":"Not Found"}' };
        }
        return { status: 500, body: '{}' };
      },
    });

    const repos = await client.listInstallationRepos('101');
    expect(repos).toEqual([{ githubRepoId: '1', repoFullName: 'acme/web', defaultBranch: 'main', privateRepo: true }]);

    await expect(
      client.getIssueOrPr({ kind: 'github_app', installationId: '101' }, 'acme/web', 'pull_request', 999),
    ).rejects.toMatchObject({ name: 'GithubError', kind: 'not_found' } satisfies Partial<GithubError>);

    // Token minted only once and reused from cache for the second API call.
    expect(calls).toEqual([
      'POST https://api.github.com/app/installations/101/access_tokens',
      'GET https://api.github.com/installation/repositories?per_page=100',
      'GET https://api.github.com/repos/acme/web/pulls/999',
    ]);
  });

  it('evicts cached App tokens on 401 and retries once, bounds cache to 500 entries, and performs GitHub App OAuth exchange + installation listing', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const seenAuth: string[] = [];
    let mintSeq = 0;
    let firstRepoCall = true;

    const client = createGithubClient({
      app: { appId: '4242', privateKeyPem: pem },
      appOAuth: { clientId: 'Iv1.testclient', clientSecret: 'test-client-secret-012345' },
      now: () => 1_700_000_000_000,
      transport: async (req) => {
        if (req.url === 'https://github.com/login/oauth/access_token') {
          const params = new URLSearchParams(req.body ?? '');
          if (params.get('code') === 'bad-code') {
            return { status: 200, body: JSON.stringify({ error: 'bad_verification_code', error_description: 'The code passed is incorrect' }) };
          }
          return { status: 200, body: JSON.stringify({ access_token: 'ghu_user_access_123456', token_type: 'bearer' }) };
        }
        if (req.url.startsWith('https://api.github.com/user/installations')) {
          const url = new URL(req.url);
          const page = Number(url.searchParams.get('page') ?? '1');
          const batch = page === 1
            ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, account: { login: `org-${i + 1}`, type: 'Organization' } }))
            : [{ id: 101, account: { login: 'org-101', type: 'Organization' } }];
          return { status: 200, body: JSON.stringify({ total_count: 101, installations: batch }) };
        }
        if (req.url.endsWith('/access_tokens')) {
          mintSeq += 1;
          return {
            status: 201,
            body: JSON.stringify({ token: `ghs_tok_${mintSeq}_1234567890`, expires_at: '2023-11-15T00:00:00Z' }),
          };
        }
        if (req.url === 'https://api.github.com/installation/repositories?per_page=100') {
          seenAuth.push(req.headers.authorization ?? '');
          if (firstRepoCall) {
            firstRepoCall = false;
            return { status: 401, body: '{"message":"Bad credentials"}' };
          }
          return { status: 200, body: JSON.stringify({ repositories: [] }) };
        }
        return { status: 500, body: '{}' };
      },
    });

    // OAuth code exchange + 2-page installation listing + error classification on GitHub HTTP 200 OAuth error.
    await expect(client.exchangeOAuthCode({ code: 'bad-code', redirectUri: 'https://app.ludy.test/channels/oauth/github_app/callback' })).rejects.toMatchObject({
      name: 'GithubError',
      kind: 'credentials',
    });
    const userToken = await client.exchangeOAuthCode({ code: 'good-code', redirectUri: 'https://app.ludy.test/channels/oauth/github_app/callback' });
    expect(userToken).toBe('ghu_user_access_123456');
    const installations = await client.listUserInstallations(userToken);
    expect(installations).toHaveLength(101);

    // First call gets 401 -> evicts tok_1 -> retries with tok_2 cleanly.
    const repos = await client.listInstallationRepos('555');
    expect(repos).toEqual([]);
    expect(seenAuth).toEqual(['Bearer ghs_tok_1_1234567890', 'Bearer ghs_tok_2_1234567890']);

    // Bounded cache: minting 505 distinct installations evicts installation '555', forcing a fresh mint for '555'.
    const beforeEvict = mintSeq;
    for (let i = 1; i <= 505; i += 1) {
      await client.listInstallationRepos(String(1000 + i));
    }
    expect(mintSeq).toBe(beforeEvict + 505);
    await client.listInstallationRepos('555');
    expect(mintSeq).toBe(beforeEvict + 506);
  });
});

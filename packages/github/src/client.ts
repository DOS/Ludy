// SPDX-License-Identifier: AGPL-3.0-only
// Fixed-host GitHub REST API client over caller-injected guarded transport (#5158, ADR-0060 D1/D5).
import { z } from 'zod';
import { createGithubAppJwt } from './app-auth.ts';
import { GithubError } from './errors.ts';
import {
  canonicalGithubItemUrl,
  normalizeRepoFullName,
  sanitizeBranchName,
  sanitizeGithubLogin,
  sanitizeGithubText,
} from './sanitize.ts';

export const GITHUB_HOSTS = ['api.github.com'] as const;
export const GITHUB_API_BASE_URL = 'https://api.github.com';
export const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const TOKEN_CACHE_MAX = 500;

export interface GithubTransportRequest {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
}

export interface GithubTransportResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body: string;
}

export type GithubTransport = (request: GithubTransportRequest) => Promise<GithubTransportResponse>;

export type GithubAuth =
  | { readonly kind: 'github_pat'; readonly token: string }
  | { readonly kind: 'github_app'; readonly installationId: string };

export interface GithubRepoSummary {
  readonly githubRepoId: string;
  readonly repoFullName: string;
  readonly defaultBranch: string;
  readonly privateRepo: boolean;
}

export interface GithubExternalItem {
  readonly kind: 'issue' | 'pull_request';
  readonly repoFullName: string;
  readonly number: number;
  readonly externalUrl: string;
  readonly externalTitle: string;
  readonly externalState: 'open' | 'closed' | 'merged' | 'draft';
  readonly branchName: string | null;
  readonly authorLogin: string | null;
  readonly updatedAt: string | null;
}

export interface GithubInstallationSummary {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
}

export interface GithubUserInstallation {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
}

export interface GithubPatAccountSummary {
  readonly accountId: string;
  readonly accountLogin: string;
  readonly repos: readonly GithubRepoSummary[];
}

export interface GithubClientOptions {
  readonly transport: GithubTransport;
  readonly app?: { readonly appId: string; readonly privateKeyPem: string } | undefined;
  readonly appOAuth?: { readonly clientId: string; readonly clientSecret: string } | undefined;
  readonly now?: (() => number) | undefined;
}

export interface GithubSetIssueStateInput {
  readonly auth: GithubAuth;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly state: 'open' | 'closed';
  readonly kind?: 'issue' | 'pull_request' | undefined;
}

export interface GithubClient {
  readonly hasAppCredentials: boolean;
  readonly hasAppOAuth: boolean;
  readonly oauthClientId: string | null;
  exchangeOAuthCode(input: { readonly code: string; readonly redirectUri: string }): Promise<string>;
  listUserInstallations(userAccessToken: string): Promise<GithubUserInstallation[]>;
  getInstallation(installationId: string): Promise<GithubInstallationSummary>;
  listInstallationRepos(installationId: string): Promise<GithubRepoSummary[]>;
  inspectPatAndListRepos(token: string): Promise<GithubPatAccountSummary>;
  listRepos(auth: GithubAuth): Promise<GithubRepoSummary[]>;
  getIssueOrPr(
    auth: GithubAuth,
    repoFullName: string,
    kind: 'issue' | 'pull_request',
    externalNumber: number,
  ): Promise<GithubExternalItem>;
  findOpenPrForBranch(
    auth: GithubAuth,
    repoFullName: string,
    branchName: string,
  ): Promise<GithubExternalItem | null>;
  listOpenIssues(
    auth: GithubAuth,
    repoFullName: string,
    limit?: number,
  ): Promise<GithubExternalItem[]>;
  setIssueState(input: GithubSetIssueStateInput): Promise<GithubExternalItem>;
}

const zInstallationRes = z.object({
  id: z.number().int().positive(),
  account: z
    .object({
      login: z.string().max(120).optional(),
      type: z.string().max(40).optional(),
    })
    .nullable()
    .optional(),
});

const zUserInstallationsRes = z.object({
  total_count: z.number().int().nonnegative().optional(),
  installations: z.array(zInstallationRes).max(200),
});

const zOAuthTokenRes = z.union([
  z.object({
    access_token: z.string().min(10).max(512),
    token_type: z.string().optional(),
    scope: z.string().optional(),
  }),
  z.object({
    error: z.string().min(1),
    error_description: z.string().optional(),
  }),
]);

const zInstallationTokenRes = z.object({
  token: z.string().min(10).max(512),
  expires_at: z.string().min(10).max(64),
});

const zRepoItem = z.object({
  id: z.number().int().positive(),
  full_name: z.string().max(220),
  default_branch: z.string().max(255).optional(),
  private: z.boolean().optional(),
});

const zInstallationReposRes = z.object({
  repositories: z.array(zRepoItem).max(200),
});

const zUserRes = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(120),
});

const zIssueRes = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1000),
  state: z.enum(['open', 'closed']),
  html_url: z.string().max(500).optional(),
  updated_at: z.string().max(64).optional(),
  user: z.object({ login: z.string().max(120).optional() }).nullable().optional(),
  pull_request: z.unknown().optional(),
});

const zPullRes = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1000),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  html_url: z.string().max(500).optional(),
  updated_at: z.string().max(64).optional(),
  user: z.object({ login: z.string().max(120).optional() }).nullable().optional(),
  head: z.object({ ref: z.string().max(300) }).optional(),
});

function parseRepoSummary(raw: z.infer<typeof zRepoItem>): GithubRepoSummary | null {
  const fullName = normalizeRepoFullName(raw.full_name);
  if (!fullName) return null;
  const branch = sanitizeBranchName(raw.default_branch) ?? 'main';
  return {
    githubRepoId: String(raw.id),
    repoFullName: fullName,
    defaultBranch: branch,
    privateRepo: Boolean(raw.private),
  };
}

function classifyHttpFailure(status: number, headers: Readonly<Record<string, string>> | undefined): GithubError {
  const retryRaw = headers?.['retry-after'];
  const retryAfterSeconds = retryRaw && /^\d+$/.test(retryRaw) ? Number(retryRaw) : undefined;
  const remaining = headers?.['x-ratelimit-remaining'];
  if (status === 401) return new GithubError('credentials', 'GitHub credentials were rejected', { status });
  if (status === 429 || (status === 403 && remaining === '0')) {
    return new GithubError('rate_limited', 'GitHub API rate limit reached', { status, retryAfterSeconds });
  }
  if (status === 403) return new GithubError('forbidden', 'GitHub token lacks required repository access', { status });
  if (status === 404) return new GithubError('not_found', 'GitHub resource was not found', { status });
  if (status === 400 || status === 422) {
    return new GithubError('bad_request', 'GitHub rejected the request parameters', { status });
  }
  return new GithubError('unreachable', `GitHub API returned HTTP ${status}`, { status });
}

function assertCleanInstallationId(installationId: string): string {
  const clean = installationId.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(clean)) {
    throw new GithubError('bad_request', 'Invalid GitHub App installation ID');
  }
  return clean;
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const now = options.now ?? (() => Date.now());
  const tokenCache = new Map<string, { token: string; expiresMs: number }>();

  async function callApi<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    bearerToken: string,
    schema: z.ZodType<T>,
    body?: string,
  ): Promise<T> {
    if (!path.startsWith('/')) {
      throw new GithubError('bad_request', 'Invalid GitHub API path');
    }
    const url = `${GITHUB_API_BASE_URL}${path}`;
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'api.github.com') {
      throw new GithubError('bad_request', 'Blocked non-GitHub API host');
    }

    let response: GithubTransportResponse;
    try {
      response = await options.transport({
        method,
        url,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${bearerToken}`,
          'x-github-api-version': '2022-11-28',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
    } catch (error) {
      if (error instanceof GithubError) throw error;
      throw new GithubError('unreachable', 'Failed to reach api.github.com', { cause: error });
    }

    if (response.status < 200 || response.status >= 300) {
      throw classifyHttpFailure(response.status, response.headers);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.body);
    } catch (error) {
      throw new GithubError('invalid_response', 'GitHub API returned invalid JSON', { cause: error });
    }

    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      throw new GithubError('invalid_response', 'GitHub API response did not match expected schema');
    }
    return result.data;
  }

  async function mintInstallationToken(installationId: string): Promise<string> {
    if (!options.app) {
      throw new GithubError('credentials', 'GitHub App credentials are not configured on this server');
    }
    const cleanId = assertCleanInstallationId(installationId);
    const cached = tokenCache.get(cleanId);
    if (cached && cached.expiresMs - 60_000 > now()) {
      tokenCache.delete(cleanId);
      tokenCache.set(cleanId, cached);
      return cached.token;
    }

    const jwt = createGithubAppJwt(options.app.appId, options.app.privateKeyPem, Math.floor(now() / 1000));
    const minted = await callApi('POST', `/app/installations/${cleanId}/access_tokens`, jwt, zInstallationTokenRes);
    const expiresMs = Date.parse(minted.expires_at);
    if (tokenCache.size >= TOKEN_CACHE_MAX && !tokenCache.has(cleanId)) {
      const oldestKey = tokenCache.keys().next().value;
      if (oldestKey !== undefined) tokenCache.delete(oldestKey);
    }
    tokenCache.delete(cleanId);
    tokenCache.set(cleanId, {
      token: minted.token,
      expiresMs: Number.isFinite(expiresMs) ? expiresMs : now() + 45 * 60_000,
    });
    return minted.token;
  }

  async function bearerFor(auth: GithubAuth): Promise<string> {
    if (auth.kind === 'github_pat') {
      const clean = auth.token.trim();
      if (!clean || clean.length < 10) throw new GithubError('credentials', 'GitHub personal access token is empty');
      return clean;
    }
    return mintInstallationToken(auth.installationId);
  }

  async function withAuth<T>(auth: GithubAuth, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await bearerFor(auth);
    try {
      return await fn(token);
    } catch (error) {
      if (auth.kind === 'github_app' && error instanceof GithubError && error.kind === 'credentials') {
        tokenCache.delete(assertCleanInstallationId(auth.installationId));
        const refreshed = await bearerFor(auth);
        return await fn(refreshed);
      }
      throw error;
    }
  }

  function encodeRepoPath(repoFullName: string): { repo: string; encoded: string } {
    const repo = normalizeRepoFullName(repoFullName);
    if (!repo) throw new GithubError('bad_request', 'Invalid repository name');
    const [owner, name] = repo.split('/') as [string, string];
    return {
      repo,
      encoded: `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    };
  }

  return {
    hasAppCredentials: Boolean(options.app),
    hasAppOAuth: Boolean(options.appOAuth),
    oauthClientId: options.appOAuth?.clientId ?? null,

    async exchangeOAuthCode(input: { readonly code: string; readonly redirectUri: string }): Promise<string> {
      if (!options.appOAuth) {
        throw new GithubError('credentials', 'GitHub App OAuth is not configured on this server');
      }
      const cleanCode = input.code.trim();
      if (!cleanCode || cleanCode.length > 512) {
        throw new GithubError('bad_request', 'Invalid GitHub OAuth authorization code');
      }
      let redirectUri: string;
      try {
        const parsed = new URL(input.redirectUri);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('unsupported protocol');
        }
        redirectUri = parsed.toString();
      } catch {
        throw new GithubError('bad_request', 'Invalid GitHub OAuth redirect URI');
      }
      const body = new URLSearchParams({
        client_id: options.appOAuth.clientId,
        client_secret: options.appOAuth.clientSecret,
        code: cleanCode,
        redirect_uri: redirectUri,
      }).toString();
      let response: GithubTransportResponse;
      try {
        response = await options.transport({
          method: 'POST',
          url: GITHUB_OAUTH_TOKEN_URL,
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        });
      } catch (error) {
        if (error instanceof GithubError) throw error;
        throw new GithubError('unreachable', 'Failed to reach github.com for OAuth exchange', { cause: error });
      }
      if (response.status < 200 || response.status >= 300) {
        throw classifyHttpFailure(response.status, response.headers);
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(response.body);
      } catch (error) {
        throw new GithubError('invalid_response', 'GitHub OAuth returned invalid JSON', { cause: error });
      }
      const parsed = zOAuthTokenRes.safeParse(parsedJson);
      if (!parsed.success) {
        throw new GithubError('invalid_response', 'GitHub OAuth response did not match expected schema');
      }
      if ('error' in parsed.data) {
        throw new GithubError('credentials', 'GitHub rejected the OAuth authorization code');
      }
      return parsed.data.access_token;
    },

    async listUserInstallations(userAccessToken: string): Promise<GithubUserInstallation[]> {
      const cleanToken = userAccessToken.trim();
      if (!cleanToken || cleanToken.length < 10) {
        throw new GithubError('credentials', 'GitHub user access token is invalid');
      }
      const out: GithubUserInstallation[] = [];
      for (let page = 1; page <= 5; page++) {
        const path = page === 1 ? '/user/installations?per_page=100' : `/user/installations?per_page=100&page=${page}`;
        const res = await callApi('GET', path, cleanToken, zUserInstallationsRes);
        for (const item of res.installations) {
          out.push({
            installationId: String(item.id),
            accountLogin: sanitizeGithubLogin(item.account?.login) ?? `installation-${item.id}`,
            accountType: sanitizeGithubText(item.account?.type ?? 'User', 40) || 'User',
          });
        }
        if (res.installations.length < 100 || (res.total_count !== undefined && out.length >= res.total_count)) {
          break;
        }
      }
      return out;
    },

    async getInstallation(installationId: string): Promise<GithubInstallationSummary> {
      if (!options.app) {
        throw new GithubError('credentials', 'GitHub App credentials are not configured on this server');
      }
      const cleanId = assertCleanInstallationId(installationId);
      const jwt = createGithubAppJwt(options.app.appId, options.app.privateKeyPem, Math.floor(now() / 1000));
      const res = await callApi('GET', `/app/installations/${cleanId}`, jwt, zInstallationRes);
      return {
        installationId: String(res.id),
        accountLogin: sanitizeGithubLogin(res.account?.login) ?? `installation-${res.id}`,
        accountType: sanitizeGithubText(res.account?.type ?? 'Organization', 40) || 'Organization',
      };
    },

    async listInstallationRepos(installationId: string): Promise<GithubRepoSummary[]> {
      const cleanId = assertCleanInstallationId(installationId);
      return withAuth({ kind: 'github_app', installationId: cleanId }, async (token) => {
        const res = await callApi('GET', '/installation/repositories?per_page=100', token, zInstallationReposRes);
        return res.repositories.map(parseRepoSummary).filter((r): r is GithubRepoSummary => r !== null);
      });
    },

    async inspectPatAndListRepos(token: string): Promise<GithubPatAccountSummary> {
      const cleanToken = token.trim();
      if (!cleanToken || cleanToken.length < 10) {
        throw new GithubError('credentials', 'GitHub personal access token is invalid');
      }
      const user = await callApi('GET', '/user', cleanToken, zUserRes);
      const rawRepos = await callApi(
        'GET',
        '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
        cleanToken,
        z.array(zRepoItem).max(200),
      );
      return {
        accountId: String(user.id),
        accountLogin: sanitizeGithubLogin(user.login) ?? `user-${user.id}`,
        repos: rawRepos.map(parseRepoSummary).filter((r): r is GithubRepoSummary => r !== null),
      };
    },

    async listRepos(auth: GithubAuth): Promise<GithubRepoSummary[]> {
      if (auth.kind === 'github_app') {
        return this.listInstallationRepos(auth.installationId);
      }
      const summary = await this.inspectPatAndListRepos(auth.token);
      return [...summary.repos];
    },

    async getIssueOrPr(
      auth: GithubAuth,
      repoFullName: string,
      kind: 'issue' | 'pull_request',
      externalNumber: number,
    ): Promise<GithubExternalItem> {
      if (!Number.isInteger(externalNumber) || externalNumber < 1) {
        throw new GithubError('bad_request', 'Invalid GitHub issue or pull request number');
      }
      const { repo, encoded } = encodeRepoPath(repoFullName);

      return withAuth(auth, async (token) => {
        if (kind === 'issue') {
          const res = await callApi('GET', `/repos/${encoded}/issues/${externalNumber}`, token, zIssueRes);
          if (res.pull_request === undefined) {
            const url = canonicalGithubItemUrl(repo, 'issue', res.number, res.html_url);
            if (!url) throw new GithubError('invalid_response', 'Invalid GitHub issue URL');
            return {
              kind: 'issue',
              repoFullName: repo,
              number: res.number,
              externalUrl: url,
              externalTitle: sanitizeGithubText(res.title, 300) || `Issue #${res.number}`,
              externalState: res.state,
              branchName: null,
              authorLogin: sanitizeGithubLogin(res.user?.login),
              updatedAt: res.updated_at ?? null,
            };
          }
        }

        const res = await callApi('GET', `/repos/${encoded}/pulls/${externalNumber}`, token, zPullRes);
        const url = canonicalGithubItemUrl(repo, 'pull_request', res.number, res.html_url);
        if (!url) throw new GithubError('invalid_response', 'Invalid GitHub pull request URL');
        const isMerged = Boolean(res.merged || res.merged_at);
        const state: 'open' | 'closed' | 'merged' | 'draft' =
          res.state === 'closed' ? (isMerged ? 'merged' : 'closed') : res.draft ? 'draft' : 'open';
        return {
          kind: 'pull_request',
          repoFullName: repo,
          number: res.number,
          externalUrl: url,
          externalTitle: sanitizeGithubText(res.title, 300) || `PR #${res.number}`,
          externalState: state,
          branchName: sanitizeBranchName(res.head?.ref),
          authorLogin: sanitizeGithubLogin(res.user?.login),
          updatedAt: res.updated_at ?? null,
        };
      });
    },

    async findOpenPrForBranch(
      auth: GithubAuth,
      repoFullName: string,
      branchName: string,
    ): Promise<GithubExternalItem | null> {
      const { repo, encoded } = encodeRepoPath(repoFullName);
      const owner = repo.slice(0, repo.indexOf('/'));
      const cleanBranch = sanitizeBranchName(branchName);
      if (!cleanBranch) return null;
      const head = encodeURIComponent(`${owner}:${cleanBranch}`);
      return withAuth(auth, async (token) => {
        const pulls = await callApi('GET', `/repos/${encoded}/pulls?head=${head}&state=all&per_page=1`, token, z.array(zPullRes).max(5));
        const first = pulls[0];
        if (!first) return null;
        const url = canonicalGithubItemUrl(repo, 'pull_request', first.number, first.html_url);
        if (!url) return null;
        const isMerged = Boolean(first.merged || first.merged_at);
        const state: 'open' | 'closed' | 'merged' | 'draft' =
          first.state === 'closed' ? (isMerged ? 'merged' : 'closed') : first.draft ? 'draft' : 'open';
        return {
          kind: 'pull_request',
          repoFullName: repo,
          number: first.number,
          externalUrl: url,
          externalTitle: sanitizeGithubText(first.title, 300) || `PR #${first.number}`,
          externalState: state,
          branchName: sanitizeBranchName(first.head?.ref) ?? cleanBranch,
          authorLogin: sanitizeGithubLogin(first.user?.login),
          updatedAt: first.updated_at ?? null,
        };
      });
    },

    async listOpenIssues(
      auth: GithubAuth,
      repoFullName: string,
      limit = 20,
    ): Promise<GithubExternalItem[]> {
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 30);
      const { repo, encoded } = encodeRepoPath(repoFullName);
      return withAuth(auth, async (token) => {
        const items = await callApi(
          'GET',
          `/repos/${encoded}/issues?state=open&sort=updated&per_page=50`,
          token,
          z.array(zIssueRes).max(50),
        );
        const out: GithubExternalItem[] = [];
        for (const item of items) {
          // GitHub REST /issues endpoint includes pull requests when pull_request key is present; exclude PRs here.
          if (item.pull_request !== undefined) continue;
          const url = canonicalGithubItemUrl(repo, 'issue', item.number, item.html_url);
          if (!url) continue;
          out.push({
            kind: 'issue',
            repoFullName: repo,
            number: item.number,
            externalUrl: url,
            externalTitle: sanitizeGithubText(item.title, 300) || `Issue #${item.number}`,
            externalState: item.state,
            branchName: null,
            authorLogin: sanitizeGithubLogin(item.user?.login),
            updatedAt: item.updated_at ?? null,
          });
          if (out.length >= capped) break;
        }
        return out;
      });
    },

    async setIssueState(input: GithubSetIssueStateInput): Promise<GithubExternalItem> {
      if (input.kind !== undefined && input.kind !== 'issue') {
        throw new GithubError('bad_request', 'Only GitHub issues support outbound state updates');
      }
      if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) {
        throw new GithubError('bad_request', 'Invalid GitHub issue number');
      }
      if (input.state !== 'open' && input.state !== 'closed') {
        throw new GithubError('bad_request', 'Invalid GitHub issue state');
      }
      if (!input.owner.trim() || input.owner.includes('/') || !input.repo.trim() || input.repo.includes('/')) {
        throw new GithubError('bad_request', 'Invalid GitHub repository owner or name');
      }
      const { repo, encoded } = encodeRepoPath(`${input.owner.trim()}/${input.repo.trim()}`);
      const payload = JSON.stringify({ state: input.state });

      return withAuth(input.auth, async (token) => {
        const res = await callApi('PATCH', `/repos/${encoded}/issues/${input.issueNumber}`, token, zIssueRes, payload);
        if (res.pull_request !== undefined) {
          throw new GithubError('bad_request', 'Refusing to update pull request via issues endpoint');
        }
        const url = canonicalGithubItemUrl(repo, 'issue', res.number, res.html_url);
        if (!url) throw new GithubError('invalid_response', 'Invalid GitHub issue URL');
        return {
          kind: 'issue',
          repoFullName: repo,
          number: res.number,
          externalUrl: url,
          externalTitle: sanitizeGithubText(res.title, 300) || `Issue #${res.number}`,
          externalState: res.state,
          branchName: null,
          authorLogin: sanitizeGithubLogin(res.user?.login),
          updatedAt: res.updated_at ?? null,
        };
      });
    },
  };
}

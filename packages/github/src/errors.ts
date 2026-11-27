// SPDX-License-Identifier: AGPL-3.0-only
// Error types for GitHub REST and webhook verification (#5158, ADR-0060).

export const GITHUB_ERROR_KINDS = [
  'credentials',
  'forbidden',
  'not_found',
  'rate_limited',
  'bad_request',
  'timeout',
  'unreachable',
  'invalid_response',
] as const;

export type GithubErrorKind = (typeof GITHUB_ERROR_KINDS)[number];

export class GithubError extends Error {
  readonly kind: GithubErrorKind;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    kind: GithubErrorKind,
    message: string,
    options?: {
      status?: number | undefined;
      retryAfterSeconds?: number | undefined;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GithubError';
    this.kind = kind;
    this.status = options?.status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Pluggable Vietnamese public CA signing port (docs/plan/esign.md section 4.3 and section 8 Slice 2c).
// Modeled after @ludy/einvoice: credentials stay opaque strings inside worker adapters, local USB/PC tokens
// are explicitly refused on server paths, and initiateSign uses reconcile_only retry safety.

export const CA_PROVIDERS = ['sandbox', 'vnpt_smartca', 'viettel_mysign', 'misa_wesign'] as const;
export type CaProviderId = (typeof CA_PROVIDERS)[number];

export function isCaProvider(value: string): value is CaProviderId {
  return (CA_PROVIDERS as readonly string[]).includes(value);
}

// How a step may be repeated if a response is lost in transit:
// - safe: read-only call
// - idempotent: provider guarantees deduplication on caller key
// - reconcile_only: check existing state by idempotencyKey / externalTxId before retrying; never double-sign
export type RetrySafety = 'safe' | 'idempotent' | 'reconcile_only';

export const CA_STEPS = ['testConnection', 'initiateSign', 'pollStatus', 'fetchSignedCms'] as const;
export type CaStep = (typeof CA_STEPS)[number];

export const CA_SIGN_STATUSES = ['pending', 'signed', 'rejected', 'expired', 'failed'] as const;
export type CaSignStatus = (typeof CA_SIGN_STATUSES)[number];

export const CA_CONNECTION_STATES = [
  'works',
  'wrong_credentials',
  'api_not_enabled',
  'ip_not_allowed',
  'unreachable',
  'signing_needs_person',
  'usb_token_unsupported',
] as const;
export type CaConnectionState = (typeof CA_CONNECTION_STATES)[number];

export interface CaSigningCapabilities {
  readonly signing: 'remote_ca' | 'provider_hsm';
  readonly localUsbTokenSupported: false;
  readonly supportedDigestAlgorithms: readonly ('SHA-256')[];
  readonly retry: Readonly<Record<CaStep, RetrySafety>> & { readonly initiateSign: 'reconcile_only' };
}

export interface CaInitiateRequest {
  idempotencyKey: string;
  digestSha256: string;
  certRef: string;
  documentName?: string;
  signerReason?: string;
  signingMode?: string;
}

export interface CaPollQuery {
  externalTxId?: string | null;
  idempotencyKey?: string | null;
}

export interface CaFetchCmsQuery {
  externalTxId: string;
  certRef?: string;
  signedAttrsDer?: Uint8Array;
}

export interface CaSignSession {
  provider: CaProviderId;
  idempotencyKey: string;
  externalTxId: string;
  status: CaSignStatus;
  challengeCode?: string | null;
  expiresAt?: string | null;
  signedAt?: string | null;
  errorCode?: string | null;
}

export interface CaSignedCms {
  externalTxId: string;
  cmsDer: Uint8Array;
  subFilter?: 'adbe.pkcs7.detached' | 'ETSI.CAdES.detached';
  certificateChainPem?: readonly string[];
  timestampTokenDer?: Uint8Array | null;
  ocspResponsesDer?: readonly Uint8Array[];
  signedAt?: string | null;
}

export const CA_ERROR_KINDS = [
  'credentials',
  'usb_token_unsupported',
  'unsafe_url',
  'invalid_request',
  'idempotency_conflict',
  'unreachable',
  'timeout',
  'lost_answer',
  'not_signed',
  'unavailable',
] as const;
export type CaProviderErrorKind = (typeof CA_ERROR_KINDS)[number];

// Provider errors carry only typed failure categories and sanitized static context, never credentials or raw bodies.
export class CaProviderError extends Error {
  readonly kind: CaProviderErrorKind;

  constructor(kind: CaProviderErrorKind, detail?: string) {
    super(detail ? `CA provider error (${kind}): ${detail}` : `CA provider error: ${kind}`);
    this.name = 'CaProviderError';
    this.kind = kind;
  }
}

export interface CaAdapterOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  allowedHosts?: readonly string[];
  now?: () => Date;
  timeoutMs?: number;
}

export interface CaSigningAdapter {
  readonly id: CaProviderId;
  readonly hosts: readonly string[];
  readonly connectFields: readonly string[];
  readonly capabilities: CaSigningCapabilities;
  testConnection(secret: string): Promise<CaConnectionState>;
  initiateSign(secret: string, request: CaInitiateRequest): Promise<CaSignSession>;
  pollStatus(secret: string, query: CaPollQuery | string): Promise<CaSignSession>;
  fetchSignedCms(secret: string, query: CaFetchCmsQuery | string): Promise<CaSignedCms>;
}

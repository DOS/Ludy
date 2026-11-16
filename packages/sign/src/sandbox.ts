// SPDX-License-Identifier: AGPL-3.0-only
// Offline deterministic CA adapter for tests and local `docker compose up` with zero network egress.
// Supports scripted pending/signed/rejected/expired/failed/lose_answer/slow outcomes, reconcile_only
// idempotencyKey deduplication, and deterministic ASN.1 DER CMS SignedData payloads.
import { createHash } from 'node:crypto';
import {
  hasUsbTokenCredentialFields,
  normalizeFetchCmsQuery,
  normalizePollQuery,
  validateInitiateRequest,
} from './http.ts';
import {
  CaProviderError,
  type CaConnectionState,
  type CaFetchCmsQuery,
  type CaInitiateRequest,
  type CaPollQuery,
  type CaSignSession,
  type CaSignStatus,
  type CaSignedCms,
  type CaSigningAdapter,
} from './port.ts';

export const SANDBOX_CA_SECRET = 'sandbox';

export type SandboxCaBehavior =
  | 'signed'
  | 'pending'
  | 'rejected'
  | 'expired'
  | 'failed'
  | 'lose_answer'
  | 'slow';

export interface SandboxCaControl {
  script(...behaviors: SandboxCaBehavior[]): void;
  pendingPolls: number;
  slowMs: number;
  readonly calls: readonly string[];
}

export interface SandboxCaOptions {
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface StoredSession {
  idempotencyKey: string;
  externalTxId: string;
  digestSha256: string;
  certRef: string;
  status: CaSignStatus;
  pollsLeft: number;
  signedAt: string | null;
  expiresAt: string;
  challengeCode: string;
  errorCode: string | null;
  cmsDer: Uint8Array | null;
}

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derNode(tag: number, content: Uint8Array): Uint8Array {
  const len = encodeDerLength(content.byteLength);
  const out = new Uint8Array(1 + len.byteLength + content.byteLength);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.byteLength);
  return out;
}

const derSeq = (...items: Uint8Array[]): Uint8Array => derNode(0x30, concatBytes(items));
const derSet = (...items: Uint8Array[]): Uint8Array => derNode(0x31, concatBytes(items));
const derTagged0 = (inner: Uint8Array): Uint8Array => derNode(0xa0, inner);
const derInt = (value: number): Uint8Array => derNode(0x02, new Uint8Array([value]));
const derOctet = (bytes: Uint8Array): Uint8Array => derNode(0x04, bytes);
const derOid = (bytes: readonly number[]): Uint8Array => derNode(0x06, new Uint8Array(bytes));

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// OIDs: signedData (1.2.840.113549.1.7.2), data (1.2.840.113549.1.7.1),
// sha256 (2.16.840.1.101.3.4.2.1), rsaEncryption (1.2.840.113549.1.1.1).
const OID_SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02] as const;
const OID_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01] as const;
const OID_SHA256 = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01] as const;
const OID_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01] as const;
const OID_CONTENT_TYPE = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03] as const;
const OID_MESSAGE_DIGEST = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04] as const;
const OID_SIGNING_CERT_V2 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x02, 0x2f] as const;

// Builds a deterministic ASN.1 DER CMS ContentInfo(SignedData) structure with CAdES-BES signedAttrs.
export function buildSandboxCmsDer(digestSha256: string, externalTxId: string, certRef: string): Uint8Array {
  const digestBytes = new Uint8Array(Buffer.from(digestSha256, 'hex'));
  const signatureBytes = new Uint8Array(
    createHash('sha256')
      .update(`sandbox-cms-sig:${externalTxId}:${certRef}:${digestSha256}`)
      .digest(),
  );
  const sha256Alg = derSeq(derOid(OID_SHA256), derNode(0x05, new Uint8Array(0)));
  const rsaAlg = derSeq(derOid(OID_RSA), derNode(0x05, new Uint8Array(0)));
  const serialBytes = new Uint8Array(
    createHash('sha256').update(`serial:${certRef}`).digest().subarray(0, 8),
  );
  // Ensure positive canonical ASN.1 integer with non-zero leading octet so DER never encodes redundant leading 0x00.
  serialBytes[0] = ((serialBytes[0] ?? 0) & 0x7f) || 0x01;
  const issuerName = derSeq(
    derSet(
      derSeq(
        derOid([0x55, 0x04, 0x03]),
        derNode(0x0c, new TextEncoder().encode('Crove Sandbox CA')),
      ),
    ),
  );
  const issuerAndSerial = derSeq(issuerName, derNode(0x02, serialBytes));
  const certHash = new Uint8Array(createHash('sha256').update(`sandbox-cert:${certRef}`).digest());
  const contentTypeAttr = derSeq(derOid(OID_CONTENT_TYPE), derSet(derOid(OID_DATA)));
  const messageDigestAttr = derSeq(derOid(OID_MESSAGE_DIGEST), derSet(derOctet(digestBytes)));
  const essCertIdV2 = derSeq(derOctet(certHash), derSeq(derSeq(derNode(0xa4, issuerName)), derNode(0x02, serialBytes)));
  const signingCertV2Attr = derSeq(derOid(OID_SIGNING_CERT_V2), derSet(derSeq(derSeq(essCertIdV2))));
  const sortedAttrs = [contentTypeAttr, messageDigestAttr, signingCertV2Attr].sort((a, b) => Buffer.compare(a, b));
  const signedAttrs = derTagged0(concatBytes(sortedAttrs));
  const signerInfo = derSeq(
    derInt(1),
    issuerAndSerial,
    sha256Alg,
    signedAttrs,
    rsaAlg,
    derOctet(signatureBytes),
  );
  const signedData = derSeq(
    derInt(1),
    derSet(sha256Alg),
    derSeq(derOid(OID_DATA)),
    derSet(signerInfo),
  );
  return derSeq(derOid(OID_SIGNED_DATA), derTagged0(signedData));
}

function classifySandboxSecret(secret: string): 'ok' | 'usb_token' | 'wrong' {
  if (secret === SANDBOX_CA_SECRET) return 'ok';
  const trimmed = secret.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        if (hasUsbTokenCredentialFields(parsed as Record<string, unknown>)) return 'usb_token';
      }
    } catch {
      return 'wrong';
    }
  }
  return 'wrong';
}

export function createSandboxCaAdapter(options: SandboxCaOptions = {}): {
  adapter: CaSigningAdapter;
  control: SandboxCaControl;
} {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const queue: SandboxCaBehavior[] = [];
  const calls: string[] = [];
  const byKey = new Map<string, StoredSession>();
  const byTxId = new Map<string, StoredSession>();
  const inflight = new Map<
    string,
    { readonly digestSha256: string; readonly certRef: string; readonly promise: Promise<CaSignSession> }
  >();

  const control: SandboxCaControl = {
    script: (...behaviors) => {
      queue.push(...behaviors);
    },
    pendingPolls: 1,
    slowMs: 25,
    calls,
  };

  function assertSecret(secret: string): void {
    const kind = classifySandboxSecret(secret);
    if (kind === 'usb_token') {
      throw new CaProviderError('usb_token_unsupported', 'client-PC USB/token signing mode is not supported');
    }
    if (kind !== 'ok') {
      throw new CaProviderError('credentials');
    }
  }

  function toSession(stored: StoredSession): CaSignSession {
    return {
      provider: 'sandbox',
      idempotencyKey: stored.idempotencyKey,
      externalTxId: stored.externalTxId,
      status: stored.status,
      challengeCode: stored.challengeCode,
      expiresAt: stored.expiresAt,
      signedAt: stored.signedAt,
      errorCode: stored.errorCode,
    };
  }

  async function createSession(
    idempotencyKey: string,
    digestSha256: string,
    certRef: string,
    behavior: SandboxCaBehavior,
  ): Promise<CaSignSession> {
    if (behavior === 'slow') {
      await wait(control.slowMs);
    }
    const createdAt = now();
    const txHash = createHash('sha256')
      .update(`${idempotencyKey}:${digestSha256}:${certRef}`)
      .digest('hex')
      .slice(0, 16);
    const externalTxId = `sbx-ca-${txHash}`;
    const expiresAt = new Date(createdAt.getTime() + 5 * 60_000).toISOString();
    const challengeCode = txHash.slice(0, 6).toUpperCase();

    let status: CaSignStatus = 'signed';
    let pollsLeft = 0;
    let errorCode: string | null = null;
    if (behavior === 'pending') {
      status = 'pending';
      pollsLeft = Math.max(0, control.pendingPolls);
    } else if (behavior === 'rejected') {
      status = 'rejected';
      errorCode = 'SANDBOX_USER_REJECTED';
    } else if (behavior === 'expired') {
      status = 'expired';
      errorCode = 'SANDBOX_TX_EXPIRED';
    } else if (behavior === 'failed') {
      status = 'failed';
      errorCode = 'SANDBOX_SIGN_FAILED';
    }

    const signedAt = status === 'signed' ? createdAt.toISOString() : null;
    const cmsDer = status === 'signed' ? buildSandboxCmsDer(digestSha256, externalTxId, certRef) : null;

    const stored: StoredSession = {
      idempotencyKey,
      externalTxId,
      digestSha256,
      certRef,
      status,
      pollsLeft,
      signedAt,
      expiresAt,
      challengeCode,
      errorCode,
      cmsDer,
    };
    byKey.set(idempotencyKey, stored);
    byTxId.set(externalTxId, stored);

    if (behavior === 'lose_answer') {
      throw new CaProviderError('lost_answer', 'simulated lost response after provider accepted transaction');
    }
    return toSession(stored);
  }

  const adapter: CaSigningAdapter = {
    id: 'sandbox',
    hosts: [],
    connectFields: [],
    capabilities: {
      signing: 'remote_ca',
      localUsbTokenSupported: false,
      supportedDigestAlgorithms: ['SHA-256'],
      retry: {
        testConnection: 'safe',
        initiateSign: 'reconcile_only',
        pollStatus: 'safe',
        fetchSignedCms: 'safe',
      },
    },

    testConnection: async (secret): Promise<CaConnectionState> => {
      calls.push('testConnection');
      const kind = classifySandboxSecret(secret);
      if (kind === 'usb_token') return 'usb_token_unsupported';
      return kind === 'ok' ? 'works' : 'wrong_credentials';
    },

    initiateSign: async (secret: string, request: CaInitiateRequest): Promise<CaSignSession> => {
      assertSecret(secret);
      const valid = validateInitiateRequest(request);
      calls.push(`initiateSign:${valid.idempotencyKey}`);

      const existing = byKey.get(valid.idempotencyKey);
      if (existing) {
        if (existing.digestSha256 !== valid.digestSha256 || existing.certRef !== valid.certRef) {
          throw new CaProviderError('idempotency_conflict', 'idempotencyKey already used with different digest or certRef');
        }
        return toSession(existing);
      }

      const pendingRun = inflight.get(valid.idempotencyKey);
      if (pendingRun) {
        if (pendingRun.digestSha256 !== valid.digestSha256 || pendingRun.certRef !== valid.certRef) {
          throw new CaProviderError(
            'idempotency_conflict',
            'idempotencyKey already in flight with different digest or certRef',
          );
        }
        return pendingRun.promise;
      }

      const behavior = queue.shift() ?? 'signed';
      const run = createSession(valid.idempotencyKey, valid.digestSha256, valid.certRef, behavior);
      inflight.set(valid.idempotencyKey, {
        digestSha256: valid.digestSha256,
        certRef: valid.certRef,
        promise: run,
      });
      try {
        return await run;
      } finally {
        inflight.delete(valid.idempotencyKey);
      }
    },

    pollStatus: async (secret: string, query: CaPollQuery | string): Promise<CaSignSession> => {
      assertSecret(secret);
      const { externalTxId, idempotencyKey } = normalizePollQuery(query);
      calls.push(`pollStatus:${externalTxId ?? idempotencyKey}`);

      const stored =
        (externalTxId ? byTxId.get(externalTxId) : undefined) ??
        (idempotencyKey ? byKey.get(idempotencyKey) : undefined);
      if (!stored) {
        throw new CaProviderError('unavailable', 'signing transaction not found');
      }

      if (stored.status === 'pending') {
        if (stored.pollsLeft > 0) stored.pollsLeft -= 1;
        if (stored.pollsLeft === 0) {
          stored.status = 'signed';
          stored.signedAt = now().toISOString();
          stored.cmsDer = buildSandboxCmsDer(stored.digestSha256, stored.externalTxId, stored.certRef);
        }
      }
      return toSession(stored);
    },

    fetchSignedCms: async (secret: string, query: CaFetchCmsQuery | string): Promise<CaSignedCms> => {
      assertSecret(secret);
      const { externalTxId: txId } = normalizeFetchCmsQuery(query);
      calls.push(`fetchSignedCms:${txId}`);

      const stored = byTxId.get(txId);
      if (!stored) {
        throw new CaProviderError('unavailable', 'signing transaction not found');
      }
      if (stored.status !== 'signed' || !stored.cmsDer) {
        throw new CaProviderError('not_signed', 'signing transaction has not completed');
      }
      return {
        externalTxId: stored.externalTxId,
        cmsDer: new Uint8Array(stored.cmsDer),
        subFilter: 'ETSI.CAdES.detached',
        certificateChainPem: [],
        timestampTokenDer: null,
        ocspResponsesDer: [],
        signedAt: stored.signedAt,
      };
    },
  };

  return { adapter, control };
}

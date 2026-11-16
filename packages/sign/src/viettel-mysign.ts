// SPDX-License-Identifier: AGPL-3.0-only
// Viettel MySign (CloudCA RSSP) remote signing adapter.
// Strictly enforces HTTPS + host allowlist (SSRF guard), rejects client-PC USB/token signing modes,
// keeps credentials/bearer tokens opaque in memory, and uses reconcile_only initiateSign safety.
import {
  DEFAULT_CA_TIMEOUT_MS,
  assertSafeCaBaseUrl,
  assertSafeHostAllowlist,
  decodeDerSequenceBase64,
  isRecord,
  isUsbTokenMode,
  normalizeExternalTxId,
  normalizePollQuery,
  optionalCredentialField,
  parseCredentialObject,
  pickCaseInsensitive,
  postCaJson,
  readText,
  requireCredentialField,
  sha256Hex,
  validateInitiateRequest,
} from './http.ts';
import {
  CaProviderError,
  type CaAdapterOptions,
  type CaConnectionState,
  type CaInitiateRequest,
  type CaPollQuery,
  type CaSignSession,
  type CaSignStatus,
  type CaSignedCms,
  type CaSigningAdapter,
} from './port.ts';

export const VIETTEL_MYSIGN_BASE_URL = 'https://remotesigning.viettel.vn';
export const VIETTEL_MYSIGN_HOSTS = ['remotesigning.viettel.vn', 'api.mysign.vn', 'mysign-api.viettel.vn'] as const;
export const VIETTEL_MYSIGN_CONNECT_FIELDS = ['clientId', 'clientSecret', 'userId', 'profileId'] as const;

const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const RSA_OID = '1.2.840.113549.1.1.1';
const DEFAULT_TOKEN_TTL_MS = 50 * 60_000;

interface ViettelCredentials {
  clientId: string;
  clientSecret: string;
  userId: string;
  profileId: string;
  baseUrl?: string;
}

function parseViettelCredentials(secret: string): ViettelCredentials {
  const obj = parseCredentialObject(secret);
  const clientId = requireCredentialField(obj, 'clientId');
  const clientSecret = requireCredentialField(obj, 'clientSecret');
  const userId = requireCredentialField(obj, 'userId');
  const profileId = requireCredentialField(obj, 'profileId');
  const baseUrl = optionalCredentialField(obj, 'baseUrl');
  return {
    clientId,
    clientSecret,
    userId,
    profileId,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

function mapViettelStatus(rawStatus: unknown): CaSignStatus | null {
  if (typeof rawStatus === 'number') {
    if (rawStatus === 0 || rawStatus === 1) return 'pending';
    if (rawStatus === 2) return 'signed';
    if (rawStatus === 3) return 'rejected';
    if (rawStatus === 4) return 'expired';
    if (rawStatus < 0 || rawStatus === 5) return 'failed';
    return null;
  }
  const text = readText(rawStatus)?.toUpperCase();
  if (!text) return null;
  if (['PENDING', 'PROCESSING', 'WAITING', 'NEW', 'IN_PROGRESS'].includes(text)) return 'pending';
  if (['COMPLETE', 'COMPLETED', 'SUCCESS', 'SIGNED'].includes(text)) return 'signed';
  if (['REJECTED', 'DENIED', 'CANCELLED', 'CANCELED', 'USER_REJECTED'].includes(text)) return 'rejected';
  if (['EXPIRED', 'TIMEOUT', 'TIMED_OUT'].includes(text)) return 'expired';
  if (['FAILED', 'ERROR'].includes(text)) return 'failed';
  return null;
}

export function createViettelMySignAdapter(options: CaAdapterOptions = {}): CaSigningAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_CA_TIMEOUT_MS;
  const allowedHosts = assertSafeHostAllowlist(options.allowedHosts ?? VIETTEL_MYSIGN_HOSTS);
  const defaultBaseUrl = assertSafeCaBaseUrl(options.baseUrl ?? VIETTEL_MYSIGN_BASE_URL, allowedHosts);
  const tokens = new Map<string, { token: string; expiresAtMs: number }>();

  function resolveBaseUrl(creds: ViettelCredentials): string {
    return creds.baseUrl ? assertSafeCaBaseUrl(creds.baseUrl, allowedHosts) : defaultBaseUrl;
  }

  async function login(creds: ViettelCredentials): Promise<{ ok: true; token: string; ttlMs: number } | { ok: false; reason: 'credentials' | 'api_not_enabled' | 'ip_not_allowed' | 'unavailable' }> {
    const base = resolveBaseUrl(creds);
    const res = await postCaJson({
      fetchImpl,
      url: `${base}/vtss/service/ras/v1/login`,
      allowedHosts,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        user_id: creds.userId,
        profile_id: creds.profileId,
      },
      write: false,
      timeoutMs,
    });
    if (res.status === 429 || res.status >= 500 || !isRecord(res.json)) return { ok: false, reason: 'unavailable' };
    const code = readText(pickCaseInsensitive(res.json, 'error')) ?? readText(pickCaseInsensitive(res.json, 'errorCode'));
    if (res.status === 401 || res.status === 403 || code === 'invalid_client' || code === 'invalid_credentials') {
      return { ok: false, reason: 'credentials' };
    }
    if (code === 'ip_not_allowed') return { ok: false, reason: 'ip_not_allowed' };
    if (code === 'api_not_enabled') return { ok: false, reason: 'api_not_enabled' };
    const token =
      readText(pickCaseInsensitive(res.json, 'access_token')) ??
      readText(pickCaseInsensitive(pickCaseInsensitive(res.json, 'data'), 'access_token'));
    if (!token) return { ok: false, reason: 'credentials' };
    const expiresInSec = Number(pickCaseInsensitive(res.json, 'expires_in'));
    const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 60 ? (expiresInSec - 30) * 1000 : DEFAULT_TOKEN_TTL_MS;
    return { ok: true, token, ttlMs };
  }

  function cacheToken(secretKey: string, token: string, ttlMs: number): void {
    if (tokens.size >= 100 && !tokens.has(secretKey)) {
      tokens.delete(tokens.keys().next().value as string);
    }
    tokens.set(secretKey, { token, expiresAtMs: now().getTime() + ttlMs });
  }

  async function getToken(secretKey: string, creds: ViettelCredentials, forceFresh: boolean): Promise<string> {
    const cached = tokens.get(secretKey);
    const currentMs = now().getTime();
    if (!forceFresh && cached && cached.expiresAtMs > currentMs) {
      return cached.token;
    }
    tokens.delete(secretKey);
    const result = await login(creds);
    if (!result.ok) {
      throw new CaProviderError(result.reason === 'unavailable' ? 'unavailable' : 'credentials');
    }
    cacheToken(secretKey, result.token, result.ttlMs);
    return result.token;
  }

  async function callAuthorized(
    secret: string,
    creds: ViettelCredentials,
    path: string,
    body: Record<string, unknown>,
    write: boolean,
  ): Promise<{ status: number; json: unknown }> {
    const key = sha256Hex(secret);
    const base = resolveBaseUrl(creds);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getToken(key, creds, attempt > 0);
      const res = await postCaJson({
        fetchImpl,
        url: `${base}${path}`,
        allowedHosts,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        body,
        write,
        timeoutMs,
      });
      if (res.status === 401) {
        tokens.delete(key);
        if (attempt === 0) continue;
        throw new CaProviderError('credentials');
      }
      return res;
    }
    throw new CaProviderError('credentials');
  }

  function parseSession(json: unknown, fallbackIdempotencyKey: string, fallbackTxId: string): CaSignSession {
    const data = pickCaseInsensitive(json, 'data') ?? json;
    const externalTxId =
      readText(pickCaseInsensitive(data, 'transactionId')) ??
      readText(pickCaseInsensitive(data, 'transaction_id')) ??
      fallbackTxId;
    if (!externalTxId) {
      throw new CaProviderError('unavailable', 'missing transactionId in Viettel MySign response');
    }
    const status = mapViettelStatus(
      pickCaseInsensitive(data, 'status') ?? pickCaseInsensitive(data, 'transactionStatus'),
    );
    if (!status) {
      throw new CaProviderError('unavailable', 'unrecognized Viettel MySign status');
    }
    return {
      provider: 'viettel_mysign',
      idempotencyKey: readText(pickCaseInsensitive(data, 'requestId')) ?? fallbackIdempotencyKey,
      externalTxId,
      status,
      challengeCode: readText(pickCaseInsensitive(data, 'challengeCode')),
      expiresAt: readText(pickCaseInsensitive(data, 'expiresAt')),
      signedAt: status === 'signed' ? (readText(pickCaseInsensitive(data, 'signedAt')) ?? now().toISOString()) : null,
      errorCode:
        status === 'signed' || status === 'pending'
          ? null
          : (readText(pickCaseInsensitive(json, 'errorCode')) ?? readText(pickCaseInsensitive(json, 'error'))),
    };
  }

  async function queryStatus(
    secret: string,
    creds: ViettelCredentials,
    query: { externalTxId: string | null; idempotencyKey: string | null },
  ): Promise<{ session: CaSignSession; rawJson: unknown }> {
    const res = await callAuthorized(
      secret,
      creds,
      '/vtss/service/ras/csc/v1/signatures/getStatus',
      {
        ...(query.externalTxId ? { transactionId: query.externalTxId } : {}),
        ...(query.idempotencyKey ? { requestId: query.idempotencyKey } : {}),
      },
      false,
    );
    if (res.status === 429) throw new CaProviderError('unavailable');
    if (res.status >= 500 || !isRecord(res.json)) throw new CaProviderError('unavailable');
    if (res.status === 403) throw new CaProviderError('credentials');
    if (res.status >= 400) throw new CaProviderError('unavailable');
    const fallbackTx = query.externalTxId ?? query.idempotencyKey ?? '';
    const session = parseSession(res.json, query.idempotencyKey ?? fallbackTx, fallbackTx);
    return { session, rawJson: res.json };
  }

  return {
    id: 'viettel_mysign',
    hosts: [...allowedHosts],
    connectFields: [...VIETTEL_MYSIGN_CONNECT_FIELDS],
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

    testConnection: async (secret: string): Promise<CaConnectionState> => {
      let creds: ViettelCredentials;
      try {
        creds = parseViettelCredentials(secret);
        resolveBaseUrl(creds);
      } catch (error) {
        if (error instanceof CaProviderError && error.kind === 'usb_token_unsupported') return 'usb_token_unsupported';
        if (error instanceof CaProviderError && error.kind === 'unsafe_url') throw error;
        return 'wrong_credentials';
      }
      try {
        const auth = await login(creds);
        if (!auth.ok) {
          if (auth.reason === 'credentials') return 'wrong_credentials';
          if (auth.reason === 'ip_not_allowed') return 'ip_not_allowed';
          if (auth.reason === 'api_not_enabled') return 'api_not_enabled';
          return 'unreachable';
        }
        cacheToken(sha256Hex(secret), auth.token, auth.ttlMs);
        const listRes = await callAuthorized(
          secret,
          creds,
          '/vtss/service/ras/csc/v1/credentials/list',
          { user_id: creds.userId, profile_id: creds.profileId },
          false,
        );
        if (listRes.status === 429 || listRes.status >= 500 || !isRecord(listRes.json)) return 'unreachable';
        if (listRes.status === 401 || listRes.status === 403) return 'wrong_credentials';
        const data = pickCaseInsensitive(listRes.json, 'data') ?? listRes.json;
        const credsList =
          (Array.isArray(pickCaseInsensitive(data, 'credentialIDs'))
            ? (pickCaseInsensitive(data, 'credentialIDs') as unknown[])
            : undefined) ??
          (Array.isArray(pickCaseInsensitive(data, 'credentials'))
            ? (pickCaseInsensitive(data, 'credentials') as unknown[])
            : undefined) ??
          (Array.isArray(data) ? data : []);
        if (credsList.length === 0) return 'signing_needs_person';
        const hasRemote = credsList.some((entry) => {
          if (typeof entry === 'string') return true;
          if (!isRecord(entry)) return false;
          const tokenType =
            pickCaseInsensitive(entry, 'tokenType') ??
            pickCaseInsensitive(entry, 'credentialType') ??
            pickCaseInsensitive(entry, 'signingMode');
          return tokenType === undefined || !isUsbTokenMode(tokenType);
        });
        return hasRemote ? 'works' : 'usb_token_unsupported';
      } catch (error) {
        if (error instanceof CaProviderError) {
          if (error.kind === 'unsafe_url') throw error;
          if (error.kind === 'credentials') return 'wrong_credentials';
          if (error.kind === 'usb_token_unsupported') return 'usb_token_unsupported';
        }
        return 'unreachable';
      }
    },

    initiateSign: async (secret: string, request: CaInitiateRequest): Promise<CaSignSession> => {
      const creds = parseViettelCredentials(secret);
      const valid = validateInitiateRequest(request);
      const hashBase64 = Buffer.from(valid.digestSha256, 'hex').toString('base64');
      const res = await callAuthorized(
        secret,
        creds,
        '/vtss/service/ras/csc/v1/signatures/signHash',
        {
          client_id: creds.clientId,
          credentialID: valid.certRef,
          requestId: valid.idempotencyKey,
          numSignatures: 1,
          documents: [
            {
              document_id: valid.idempotencyKey,
              document_name: valid.documentName ?? 'document.pdf',
            },
          ],
          hash: [hashBase64],
          hashAlgo: SHA256_OID,
          signAlgo: RSA_OID,
          async: 1,
        },
        true,
      );
      if (res.status === 429) throw new CaProviderError('unavailable');
      if (res.status >= 500 || !isRecord(res.json)) throw new CaProviderError('lost_answer');
      if (res.status === 403) throw new CaProviderError('credentials');
      const errCode = readText(pickCaseInsensitive(res.json, 'errorCode')) ?? readText(pickCaseInsensitive(res.json, 'error'));
      if (res.status === 409 || errCode?.toUpperCase() === 'DUPLICATE_REQUEST' || errCode?.toUpperCase() === 'TRANSACTION_EXISTS') {
        const reconciled = await queryStatus(secret, creds, { externalTxId: null, idempotencyKey: valid.idempotencyKey }).catch(() => {
          throw new CaProviderError('lost_answer');
        });
        return reconciled.session;
      }
      if (res.status >= 400) {
        return {
          provider: 'viettel_mysign',
          idempotencyKey: valid.idempotencyKey,
          externalTxId: valid.idempotencyKey,
          status: 'failed',
          errorCode: errCode ?? `HTTP_${res.status}`,
        };
      }
      const data = pickCaseInsensitive(res.json, 'data') ?? res.json;
      const explicitStatus = mapViettelStatus(pickCaseInsensitive(data, 'status'));
      const txId =
        readText(pickCaseInsensitive(data, 'transactionId')) ??
        readText(pickCaseInsensitive(data, 'transaction_id'));
      if (!explicitStatus && txId) {
        return {
          provider: 'viettel_mysign',
          idempotencyKey: valid.idempotencyKey,
          externalTxId: txId,
          status: 'pending',
          challengeCode: readText(pickCaseInsensitive(data, 'challengeCode')),
          expiresAt: readText(pickCaseInsensitive(data, 'expiresAt')),
          signedAt: null,
          errorCode: null,
        };
      }
      return parseSession(res.json, valid.idempotencyKey, valid.idempotencyKey);
    },

    pollStatus: async (secret: string, query: CaPollQuery | string): Promise<CaSignSession> => {
      const creds = parseViettelCredentials(secret);
      const normalized = normalizePollQuery(query);
      const { session } = await queryStatus(secret, creds, normalized);
      return session;
    },

    fetchSignedCms: async (secret: string, externalTxId: string): Promise<CaSignedCms> => {
      const creds = parseViettelCredentials(secret);
      const txId = normalizeExternalTxId(externalTxId);
      const { session, rawJson } = await queryStatus(secret, creds, { externalTxId: txId, idempotencyKey: null });
      if (session.status !== 'signed') {
        throw new CaProviderError('not_signed', 'Viettel MySign transaction is not signed');
      }
      const data = pickCaseInsensitive(rawJson, 'data') ?? rawJson;
      const sigs = pickCaseInsensitive(data, 'signatures');
      const rawCms =
        (Array.isArray(sigs) && sigs.length > 0 ? sigs[0] : undefined) ??
        pickCaseInsensitive(data, 'signature') ??
        pickCaseInsensitive(data, 'cms');
      const cmsDer = decodeDerSequenceBase64(rawCms);
      if (!cmsDer) {
        throw new CaProviderError('unavailable', 'Viettel MySign response did not contain valid CMS DER bytes');
      }
      const timestampTokenDer = decodeDerSequenceBase64(pickCaseInsensitive(data, 'timestampToken'));
      const rawOcsps = pickCaseInsensitive(data, 'ocspResponses');
      const ocspResponsesDer = Array.isArray(rawOcsps)
        ? rawOcsps.map(decodeDerSequenceBase64).filter((v): v is Uint8Array => v !== null)
        : [];
      const rawChain = pickCaseInsensitive(data, 'certificateChain');
      const certificateChainPem = Array.isArray(rawChain)
        ? rawChain.map(readText).filter((v): v is string => v !== null)
        : [];
      return {
        externalTxId: session.externalTxId,
        cmsDer,
        certificateChainPem,
        timestampTokenDer,
        ocspResponsesDer,
        signedAt: session.signedAt ?? null,
      };
    },
  };
}

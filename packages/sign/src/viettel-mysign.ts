// SPDX-License-Identifier: AGPL-3.0-only
// Viettel MySign remote signing adapter (VTSS Gateway /vtss/service/* async flow).
// Matches published Viettel MySign v1/service endpoints, status codes ('1','4000','6000','4001','4002','4004','4005','13004','50000'),
// strictly enforces HTTPS + host allowlist (SSRF guard), rejects client-PC USB/token signing modes,
// keeps credentials/bearer tokens opaque, blocks blind re-initiate when transactionId was lost, and wraps raw signatures in CMS.
import {
  decodeDerCertificate,
  resolveCmsOrWrapRawSignature,
  selectRemoteCertificateChain,
} from './cms-der.ts';
import {
  DEFAULT_CA_TIMEOUT_MS,
  assertSafeCaBaseUrl,
  assertSafeHostAllowlist,
  decodeBase64Bytes,
  decodeDerSequenceBase64,
  isRecord,
  isUsbTokenMode,
  normalizeFetchCmsQuery,
  normalizePollQuery,
  optionalCredentialField,
  parseCredentialObject,
  pickCaseInsensitive,
  postCaJson,
  readText,
  requireCredentialField,
  setBoundedMap,
  sha256Hex,
  validateInitiateRequest,
} from './http.ts';
import {
  CaProviderError,
  type CaAdapterOptions,
  type CaConnectionState,
  type CaFetchCmsQuery,
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

interface ViettelCertRecord {
  readonly credentialId: string | null;
  readonly isUsbOnly: boolean;
  readonly isActive: boolean;
  readonly chainDer: readonly Uint8Array[];
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

// Viettel MySign spec requires document_name / description to be Base64 of [A-Za-z0-9 _-] under 100 base64 chars.
function encodeMySignDisplayLabel(raw: string | undefined, fallback: string): string {
  const sanitized = (raw ?? fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 _-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const safeText = (sanitized === '' ? fallback : sanitized).slice(0, 72);
  return Buffer.from(safeText, 'utf8').toString('base64');
}

function readCodeText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readText(value);
}

function mapViettelStatus(rawStatus: unknown): CaSignStatus | null {
  const text = readCodeText(rawStatus)?.toUpperCase();
  if (!text) return null;
  if (['1', 'COMPLETE', 'COMPLETED', 'SUCCESS', 'SIGNED'].includes(text)) return 'signed';
  if (['4000', '6000', 'PENDING', 'PROCESSING', 'WAITING', 'NEW', 'IN_PROGRESS'].includes(text)) return 'pending';
  if (['4002', 'REJECTED', 'DENIED', 'CANCELLED', 'CANCELED', 'USER_REJECTED'].includes(text)) return 'rejected';
  if (['4001', 'EXPIRED', 'TIMEOUT', 'TIMED_OUT'].includes(text)) return 'expired';
  if (['4004', '4005', '13004', '50000', 'FAILED', 'ERROR'].includes(text)) return 'failed';
  return null;
}

function extractViettelCertificates(json: unknown): ViettelCertRecord[] {
  const unwrapped = isRecord(json) ? (pickCaseInsensitive(json, 'data') ?? json) : json;
  const list = Array.isArray(unwrapped)
    ? unwrapped
    : isRecord(unwrapped) && Array.isArray(pickCaseInsensitive(unwrapped, 'credentials'))
      ? (pickCaseInsensitive(unwrapped, 'credentials') as unknown[])
      : [];
  const out: ViettelCertRecord[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const tokenType =
      pickCaseInsensitive(item, 'tokenType') ??
      pickCaseInsensitive(item, 'credentialType') ??
      pickCaseInsensitive(item, 'signingMode');
    const isUsbOnly = tokenType !== undefined && isUsbTokenMode(tokenType);
    const credentialId =
      readText(pickCaseInsensitive(item, 'credential_id')) ??
      readText(pickCaseInsensitive(item, 'credentialID'));
    const keyObj = pickCaseInsensitive(item, 'key');
    const keyStatus = isRecord(keyObj) ? readText(pickCaseInsensitive(keyObj, 'status'))?.toUpperCase() : null;
    const certObj = pickCaseInsensitive(item, 'cert');
    const certStatus = isRecord(certObj) ? readText(pickCaseInsensitive(certObj, 'status'))?.toLowerCase() : null;
    const isActive =
      (keyStatus === null || keyStatus === 'ENABLED' || keyStatus === 'ACTIVE') &&
      (certStatus === null || certStatus === 'valid' || certStatus === 'active');

    const chainDer: Uint8Array[] = [];
    const rawCerts = isRecord(certObj) ? pickCaseInsensitive(certObj, 'certificates') : undefined;
    if (Array.isArray(rawCerts)) {
      for (const rawCert of rawCerts) {
        const parsed = decodeDerCertificate(rawCert);
        if (parsed) chainDer.push(parsed);
      }
    }
    out.push({ credentialId, isUsbOnly, isActive, chainDer });
  }
  return out;
}

export function createViettelMySignAdapter(options: CaAdapterOptions = {}): CaSigningAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_CA_TIMEOUT_MS;
  const allowedHosts = assertSafeHostAllowlist(options.allowedHosts ?? VIETTEL_MYSIGN_HOSTS);
  const defaultBaseUrl = assertSafeCaBaseUrl(options.baseUrl ?? VIETTEL_MYSIGN_BASE_URL, allowedHosts);
  const tokens = new Map<string, { token: string; expiresAtMs: number }>();
  const txToCertRef = new Map<string, string>();
  const certCache = new Map<string, readonly ViettelCertRecord[]>();

  function rememberCertRef(secretKey: string, txId: string, certRef: string): void {
    setBoundedMap(txToCertRef, 500, `${secretKey}:${txId}`, certRef);
  }

  function cacheCerts(secretKey: string, certs: readonly ViettelCertRecord[]): void {
    setBoundedMap(certCache, 100, secretKey, certs);
  }

  function resolveBaseUrl(creds: ViettelCredentials): string {
    return creds.baseUrl ? assertSafeCaBaseUrl(creds.baseUrl, allowedHosts) : defaultBaseUrl;
  }

  async function login(
    creds: ViettelCredentials,
  ): Promise<{ ok: true; token: string; ttlMs: number } | { ok: false; reason: 'credentials' | 'api_not_enabled' | 'ip_not_allowed' | 'unavailable' }> {
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
    if (res.status === 429 || res.status >= 500) return { ok: false, reason: 'unavailable' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'credentials' };
    if (!isRecord(res.json)) return { ok: false, reason: 'unavailable' };
    const code =
      readCodeText(pickCaseInsensitive(res.json, 'error')) ??
      readCodeText(pickCaseInsensitive(res.json, 'errorCode'));
    if (res.status === 401 || res.status === 403 || code === '59033' || code === 'invalid_client' || code === 'invalid_credentials') {
      return { ok: false, reason: 'credentials' };
    }
    if (code === 'ip_not_allowed') return { ok: false, reason: 'ip_not_allowed' };
    if (code === 'api_not_enabled') return { ok: false, reason: 'api_not_enabled' };
    if (res.status >= 400) return { ok: false, reason: 'unavailable' };
    const token =
      readText(pickCaseInsensitive(res.json, 'access_token')) ??
      readText(pickCaseInsensitive(pickCaseInsensitive(res.json, 'data'), 'access_token'));
    if (!token) return { ok: false, reason: 'credentials' };
    const expiresInSec = Number(pickCaseInsensitive(res.json, 'expires_in'));
    const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 60 ? (expiresInSec - 30) * 1000 : DEFAULT_TOKEN_TTL_MS;
    return { ok: true, token, ttlMs };
  }

  function cacheToken(secretKey: string, token: string, ttlMs: number): void {
    setBoundedMap(tokens, 100, secretKey, { token, expiresAtMs: now().getTime() + ttlMs });
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

  async function fetchCertificates(secret: string, creds: ViettelCredentials): Promise<ViettelCertRecord[]> {
    const res = await callAuthorized(
      secret,
      creds,
      '/vtss/service/certificates/info',
      {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        profile_id: creds.profileId,
        user_id: creds.userId,
        certificates: 'chain',
        certInfo: true,
        authInfo: true,
      },
      false,
    );
    if (res.status === 429 || res.status >= 500) {
      throw new CaProviderError('unavailable');
    }
    if (res.status === 401 || res.status === 403) throw new CaProviderError('credentials');
    if (res.json === null || typeof res.json !== 'object') {
      throw new CaProviderError('unavailable');
    }
    const records = extractViettelCertificates(res.json);
    if (records.length > 0) cacheCerts(sha256Hex(secret), records);
    return records;
  }

  async function resolveCertificateChainDer(
    secret: string,
    secretKey: string,
    creds: ViettelCredentials,
    txId: string,
    explicitCertRef?: string,
  ): Promise<readonly Uint8Array[]> {
    const wantedCredId = explicitCertRef ?? txToCertRef.get(`${secretKey}:${txId}`);
    const toSelectionRecords = (list: readonly ViettelCertRecord[]) =>
      list.map((c) => ({
        certRef: c.credentialId,
        isUsbOnly: c.isUsbOnly,
        isActive: c.isActive,
        chainDer: c.chainDer,
      }));
    const cached = certCache.get(secretKey);
    if (cached && cached.length > 0) {
      try {
        return selectRemoteCertificateChain({
          providerLabel: 'Viettel MySign',
          records: toSelectionRecords(cached),
          ...(wantedCredId !== undefined ? { wantedCertRef: wantedCredId } : {}),
        });
      } catch (err) {
        if (!wantedCredId) throw err;
      }
    }
    const fetched = await fetchCertificates(secret, creds);
    return selectRemoteCertificateChain({
      providerLabel: 'Viettel MySign',
      records: toSelectionRecords(fetched),
      ...(wantedCredId !== undefined ? { wantedCertRef: wantedCredId } : {}),
    });
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
          : (readCodeText(pickCaseInsensitive(data, 'error_code')) ??
              readCodeText(pickCaseInsensitive(json, 'errorCode')) ??
              readCodeText(pickCaseInsensitive(json, 'error'))),
    };
  }

  async function queryStatus(
    secret: string,
    creds: ViettelCredentials,
    query: { externalTxId: string | null; idempotencyKey: string | null },
  ): Promise<{ session: CaSignSession; rawJson: unknown }> {
    if (!query.externalTxId) {
      // Published Viettel MySign /vtss/service/requests/status requires server transactionId and does not support lookup by caller idempotencyKey.
      throw new CaProviderError(
        'lost_answer',
        'Viettel MySign requires server transactionId or async callback to reconcile an interrupted initiateSign',
      );
    }
    const res = await callAuthorized(
      secret,
      creds,
      '/vtss/service/requests/status',
      { transactionId: query.externalTxId },
      false,
    );
    if (res.status === 429 || res.status >= 500) throw new CaProviderError('unavailable');
    if (res.status === 401 || res.status === 403) throw new CaProviderError('credentials');
    if (res.status >= 400 || !isRecord(res.json)) throw new CaProviderError('unavailable');
    const session = parseSession(res.json, query.idempotencyKey ?? query.externalTxId, query.externalTxId);
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
          '/vtss/service/certificates/info',
          {
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            profile_id: creds.profileId,
            user_id: creds.userId,
            certificates: 'chain',
            certInfo: true,
            authInfo: true,
          },
          false,
        );
        if (listRes.status === 429 || listRes.status >= 500) {
          return 'unreachable';
        }
        if (listRes.status === 401 || listRes.status === 403) return 'wrong_credentials';
        if (listRes.status >= 400 || listRes.json === null || typeof listRes.json !== 'object') {
          return 'unreachable';
        }
        const records = extractViettelCertificates(listRes.json);
        if (records.length === 0) return 'signing_needs_person';
        const activeRemote = records.filter((r) => !r.isUsbOnly && r.isActive);
        if (activeRemote.length > 0) {
          cacheCerts(sha256Hex(secret), activeRemote);
          return 'works';
        }
        return records.some((r) => !r.isUsbOnly) ? 'signing_needs_person' : 'usb_token_unsupported';
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
      const secretKey = sha256Hex(secret);
      const hashBase64 = Buffer.from(valid.digestSha256, 'hex').toString('base64');
      const encodedDocName = encodeMySignDisplayLabel(valid.documentName, 'Document');
      const encodedDescription = encodeMySignDisplayLabel(valid.signerReason ?? valid.documentName, 'Document Sign');
      const res = await callAuthorized(
        secret,
        creds,
        '/vtss/service/signHash',
        {
          credentialID: valid.certRef,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          numSignatures: 1,
          description: encodedDescription,
          documents: [
            {
              document_id: valid.idempotencyKey,
              document_name: encodedDocName,
            },
          ],
          hash: [hashBase64],
          hashAlgo: SHA256_OID,
          signAlgo: RSA_OID,
          async: 2,
        },
        true,
      );
      if (res.status === 429) throw new CaProviderError('unavailable');
      if (res.status >= 500) throw new CaProviderError('lost_answer');
      if (res.status === 401 || res.status === 403) throw new CaProviderError('credentials');
      if (!isRecord(res.json)) {
        if (res.status >= 400) {
          return {
            provider: 'viettel_mysign',
            idempotencyKey: valid.idempotencyKey,
            externalTxId: valid.idempotencyKey,
            status: 'failed',
            errorCode: `HTTP_${res.status}`,
          };
        }
        throw new CaProviderError('lost_answer');
      }
      const errCode =
        readCodeText(pickCaseInsensitive(res.json, 'errorCode')) ??
        readCodeText(pickCaseInsensitive(res.json, 'error'));
      if (res.status === 409 || errCode?.toUpperCase() === 'DUPLICATE_REQUEST' || errCode?.toUpperCase() === 'TRANSACTION_EXISTS') {
        const dataObj = pickCaseInsensitive(res.json, 'data') ?? res.json;
        const dupTxId =
          readText(pickCaseInsensitive(dataObj, 'transactionId')) ??
          readText(pickCaseInsensitive(dataObj, 'transaction_id'));
        if (!dupTxId) {
          throw new CaProviderError('lost_answer', 'Viettel MySign duplicate request response missing server transactionId');
        }
        const reconciled = await queryStatus(secret, creds, { externalTxId: dupTxId, idempotencyKey: valid.idempotencyKey }).catch(() => {
          throw new CaProviderError('lost_answer');
        });
        rememberCertRef(secretKey, reconciled.session.externalTxId, valid.certRef);
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
      const bodyErrCode =
        errCode ??
        readCodeText(pickCaseInsensitive(data, 'error_code')) ??
        readCodeText(pickCaseInsensitive(data, 'errorCode'));
      const hasBodyError = bodyErrCode !== null && !['0', '200', 'SUCCESS'].includes(bodyErrCode.toUpperCase());
      const explicitStatus = mapViettelStatus(
        pickCaseInsensitive(data, 'status') ?? pickCaseInsensitive(data, 'transactionStatus'),
      );
      const txId =
        readText(pickCaseInsensitive(data, 'transactionId')) ??
        readText(pickCaseInsensitive(data, 'transaction_id'));
      if (hasBodyError && !explicitStatus) {
        return {
          provider: 'viettel_mysign',
          idempotencyKey: valid.idempotencyKey,
          externalTxId: txId ?? valid.idempotencyKey,
          status: 'failed',
          errorCode: bodyErrCode,
        };
      }
      if (!explicitStatus && txId) {
        rememberCertRef(secretKey, txId, valid.certRef);
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
      const session = parseSession(res.json, valid.idempotencyKey, txId ?? '');
      rememberCertRef(secretKey, session.externalTxId, valid.certRef);
      return session;
    },

    pollStatus: async (secret: string, query: CaPollQuery | string): Promise<CaSignSession> => {
      const creds = parseViettelCredentials(secret);
      const normalized = normalizePollQuery(query);
      const { session } = await queryStatus(secret, creds, normalized);
      return session;
    },

    fetchSignedCms: async (secret: string, query: CaFetchCmsQuery | string): Promise<CaSignedCms> => {
      const creds = parseViettelCredentials(secret);
      const normalized = normalizeFetchCmsQuery(query);
      const txId = normalized.externalTxId;
      const secretKey = sha256Hex(secret);
      const { session, rawJson } = await queryStatus(secret, creds, { externalTxId: txId, idempotencyKey: null });
      if (session.status !== 'signed') {
        throw new CaProviderError('not_signed', 'Viettel MySign transaction is not signed');
      }
      const data = pickCaseInsensitive(rawJson, 'data') ?? rawJson;
      const sigs = pickCaseInsensitive(data, 'signatures');
      const rawSigField =
        (Array.isArray(sigs) && sigs.length > 0 ? sigs[0] : undefined) ??
        pickCaseInsensitive(data, 'signature') ??
        pickCaseInsensitive(data, 'cms');
      const sigBytes = decodeBase64Bytes(rawSigField);
      if (!sigBytes || sigBytes.byteLength === 0) {
        throw new CaProviderError('unavailable', 'Viettel MySign response did not contain signature bytes');
      }

      const inlineCredId =
        readText(pickCaseInsensitive(data, 'credentialID')) ??
        readText(pickCaseInsensitive(data, 'credential_id'));
      const rawChain = pickCaseInsensitive(data, 'certificateChain');
      const inlineChainDer = Array.isArray(rawChain)
        ? rawChain.map(decodeDerCertificate).filter((v): v is Uint8Array => v !== null)
        : [];

      const { cmsDer, subFilter, certificateChainPem } = await resolveCmsOrWrapRawSignature({
        providerLabel: 'Viettel MySign',
        sigBytes,
        rawChain,
        inlineChainDer,
        ...(normalized.signedAttrsDer !== undefined ? { signedAttrsDer: normalized.signedAttrsDer } : {}),
        loadChainDer: () => resolveCertificateChainDer(secret, secretKey, creds, txId, normalized.certRef ?? inlineCredId ?? undefined),
      });

      const timestampTokenDer = decodeDerSequenceBase64(pickCaseInsensitive(data, 'timestampToken'));
      const rawOcsps = pickCaseInsensitive(data, 'ocspResponses');
      const ocspResponsesDer = Array.isArray(rawOcsps)
        ? rawOcsps.map(decodeDerSequenceBase64).filter((v): v is Uint8Array => v !== null)
        : [];
      return {
        externalTxId: session.externalTxId,
        cmsDer,
        subFilter,
        certificateChainPem,
        timestampTokenDer,
        ocspResponsesDer,
        signedAt: session.signedAt ?? null,
      };
    },
  };
}

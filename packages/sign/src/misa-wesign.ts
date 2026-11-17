// SPDX-License-Identifier: AGPL-3.0-only
// MISA eSign / WeSign Open API remote signing adapter (esignapp.misa.vn).
// Authenticates via /api/auth/api/v1/auth/login-api (preferring remoteSigningAccessToken for AuthorizationRM),
// lists certs via GET /external/esrm/service/general/api/v1/Certificates/by-userId,
// signs hashes via /external/esrm/service/signing/api/v1/Signing/hash, polls status via GET .../Signing/status/{txId},
// enforces HTTPS + allowlist + USB-token refusal, and prevents ambiguous multi-cert fallback across restarts.
import {
  decodeDerCertificate,
  mergeInlineCertChainDer,
  resolveCmsOrWrapRawSignature,
  selectRemoteCertificateChain,
} from './cms-der.ts';
import {
  DEFAULT_CA_TIMEOUT_MS,
  assertSafeCaBaseUrl,
  assertSafeHostAllowlist,
  decodeBase64Bytes,
  decodeDerSequenceBase64,
  defaultPinnedCaFetch,
  isRecord,
  isUsbTokenMode,
  normalizeFetchCmsQuery,
  normalizePollQuery,
  optionalCredentialField,
  parseCredentialObject,
  pickCaseInsensitive,
  postCaJson,
  readText,
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

export const MISA_WESIGN_BASE_URL = 'https://esignapp.misa.vn';
export const MISA_WESIGN_HOSTS = [
  'esignapp.misa.vn',
  'testesignapp.misa.vn',
  'esignapi.misa.vn',
  'testesignapi.misa.vn',
  'developer.misa.vn',
] as const;
export const MISA_WESIGN_CONNECT_FIELDS = ['clientId', 'clientKey', 'username', 'password', 'taxCode'] as const;

const DEFAULT_TOKEN_TTL_MS = 6 * 3_600_000;

interface MisaWeSignCredentials {
  clientId: string;
  clientKey: string;
  username: string;
  password: string;
  userId?: string;
  taxCode?: string;
  baseUrl?: string;
}

interface MisaCertificateRecord {
  readonly certRef: string | null;
  readonly isUsbOnly: boolean;
  readonly isActive: boolean;
  readonly chainDer: readonly Uint8Array[];
}

function parseMisaCredentials(secret: string): MisaWeSignCredentials {
  const obj = parseCredentialObject(secret);
  const clientId = optionalCredentialField(obj, 'clientId') ?? optionalCredentialField(obj, 'appId');
  const clientKey =
    optionalCredentialField(obj, 'clientKey') ??
    optionalCredentialField(obj, 'clientSecret') ??
    optionalCredentialField(obj, 'appSecret');
  const username = optionalCredentialField(obj, 'username');
  const password = optionalCredentialField(obj, 'password');
  if (!clientId || !clientKey || !username || !password) {
    throw new CaProviderError('credentials');
  }
  const userId = optionalCredentialField(obj, 'userId');
  const taxCode = optionalCredentialField(obj, 'taxCode');
  const baseUrl = optionalCredentialField(obj, 'baseUrl');
  return {
    clientId,
    clientKey,
    username,
    password,
    ...(userId !== undefined ? { userId } : {}),
    ...(taxCode !== undefined ? { taxCode } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

function mapMisaStatus(rawStatus: unknown): CaSignStatus | null {
  if (typeof rawStatus === 'number') {
    if (rawStatus === 0) return 'pending';
    if (rawStatus === 1) return 'signed';
    if (rawStatus === 2) return 'rejected';
    if (rawStatus === 3) return 'expired';
    if (rawStatus < 0 || rawStatus === 4) return 'failed';
    return null;
  }
  const text = readText(rawStatus)?.toUpperCase();
  if (!text) return null;
  if (['0', 'PENDING', 'WAITING', 'WAITINGAPPROVE', 'WAITING_APPROVE', 'PROCESSING'].includes(text)) return 'pending';
  if (['1', 'SUCCESS', 'SIGNED', 'COMPLETED', 'COMPLETE'].includes(text)) return 'signed';
  if (['2', 'REJECTED', 'USERREJECTED', 'USER_REJECTED', 'CANCELLED', 'DECLINED'].includes(text)) return 'rejected';
  if (['3', 'EXPIRED', 'TIMEOUT'].includes(text)) return 'expired';
  if (['4', 'FAILED', 'ERROR'].includes(text)) return 'failed';
  return null;
}

function extractMisaCertificates(json: unknown): MisaCertificateRecord[] {
  const data = pickCaseInsensitive(json, 'Data');
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(pickCaseInsensitive(data, 'certificates'))
      ? (pickCaseInsensitive(data, 'certificates') as unknown[])
      : Array.isArray(json)
        ? json
        : [];
  const out: MisaCertificateRecord[] = [];
  for (const cert of list) {
    if (!isRecord(cert)) continue;
    const certType =
      pickCaseInsensitive(cert, 'SignType') ??
      pickCaseInsensitive(cert, 'TokenType') ??
      pickCaseInsensitive(cert, 'DeviceType');
    const isUsbOnly = certType !== undefined && isUsbTokenMode(certType);
    const keyStatus = readText(pickCaseInsensitive(cert, 'KeyStatus'));
    const certStatus = readText(pickCaseInsensitive(cert, 'certStatus'));
    const isActive =
      (keyStatus === null || keyStatus.toUpperCase() === 'ACTIVE') &&
      (certStatus === null || certStatus.toUpperCase() === 'ACTIVE');
    const certRef =
      readText(pickCaseInsensitive(cert, 'keyAlias')) ??
      readText(pickCaseInsensitive(cert, 'CertAlias')) ??
      readText(pickCaseInsensitive(cert, 'CertSerial')) ??
      readText(pickCaseInsensitive(cert, 'Alias'));
    const leaf = decodeDerCertificate(
      pickCaseInsensitive(cert, 'CertData') ??
        pickCaseInsensitive(cert, 'Certificate') ??
        pickCaseInsensitive(cert, 'CertBase64'),
    );
    const rawChain =
      pickCaseInsensitive(cert, 'certiticateChain') ??
      pickCaseInsensitive(cert, 'CertificateChain');
    const parsedChain = Array.isArray(rawChain)
      ? rawChain.map(decodeDerCertificate).filter((v): v is Uint8Array => v !== null)
      : [];
    const chainDer = mergeInlineCertChainDer(leaf, parsedChain);
    out.push({ certRef, isUsbOnly, isActive, chainDer });
  }
  return out;
}

function toMisaDocumentId(idempotencyKey: string): string {
  return idempotencyKey.length <= 36
    ? idempotencyKey
    : sha256Hex(`misa-doc:${idempotencyKey}`).slice(0, 36);
}

function readMisaErrorCode(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const statusObj = pickCaseInsensitive(json, 'status');
  if (isRecord(statusObj)) {
    const nested = pickCaseInsensitive(statusObj, 'errorCode');
    const nestedText = readText(nested) ?? (typeof nested === 'number' && nested !== 0 ? String(nested) : null);
    if (nestedText) return nestedText;
  }
  const top = pickCaseInsensitive(json, 'ErrorCode');
  return readText(top) ?? (typeof top === 'number' && top !== 0 ? String(top) : null);
}

function extractMisaEnvelopeSuccess(json: unknown): boolean | null {
  const legacySuccess = pickCaseInsensitive(json, 'Success');
  if (typeof legacySuccess === 'boolean') return legacySuccess;
  const statusObj = pickCaseInsensitive(json, 'status');
  if (isRecord(statusObj)) {
    if (pickCaseInsensitive(statusObj, 'error') === true) return false;
    const code = Number(pickCaseInsensitive(statusObj, 'code'));
    if (Number.isFinite(code)) return code >= 200 && code < 300;
  }
  return null;
}

function extractMisaSignatureField(data: unknown): unknown {
  const sigs = pickCaseInsensitive(data, 'signatures');
  if (Array.isArray(sigs) && sigs.length > 0) {
    const first = sigs[0];
    if (isRecord(first)) {
      return (
        pickCaseInsensitive(first, 'signature') ??
        pickCaseInsensitive(first, 'signatureValue') ??
        pickCaseInsensitive(first, 'cms')
      );
    }
    return first;
  }
  return (
    pickCaseInsensitive(data, 'CmsBase64') ??
    pickCaseInsensitive(data, 'Signature') ??
    pickCaseInsensitive(data, 'SignedData')
  );
}

export function createMisaWeSignAdapter(options: CaAdapterOptions = {}): CaSigningAdapter {
  const fetchImpl = options.fetch ?? defaultPinnedCaFetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_CA_TIMEOUT_MS;
  const allowedHosts = assertSafeHostAllowlist(options.allowedHosts ?? MISA_WESIGN_HOSTS);
  const defaultBaseUrl = assertSafeCaBaseUrl(options.baseUrl ?? MISA_WESIGN_BASE_URL, allowedHosts);
  const tokens = new Map<string, { token: string; userId: string; expiresAtMs: number }>();
  const txToCertRef = new Map<string, string>();
  const certCache = new Map<string, readonly MisaCertificateRecord[]>();

  function rememberCertRef(secretKey: string, txId: string, certRef: string): void {
    setBoundedMap(txToCertRef, 500, `${secretKey}:${txId}`, certRef);
  }

  function cacheCerts(secretKey: string, certs: readonly MisaCertificateRecord[]): void {
    setBoundedMap(certCache, 100, secretKey, certs);
  }

  function resolveBaseUrl(creds: MisaWeSignCredentials): string {
    return creds.baseUrl ? assertSafeCaBaseUrl(creds.baseUrl, allowedHosts) : defaultBaseUrl;
  }

  async function login(
    creds: MisaWeSignCredentials,
  ): Promise<
    | { ok: true; token: string; userId: string; ttlMs: number }
    | { ok: false; reason: 'credentials' | 'two_step' | 'api_not_enabled' | 'ip_not_allowed' | 'unavailable' }
  > {
    const base = resolveBaseUrl(creds);
    const res = await postCaJson({
      fetchImpl,
      url: `${base}/api/auth/api/v1/auth/login-api`,
      allowedHosts,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-clientId': creds.clientId,
        'x-clientKey': creds.clientKey,
      },
      body: {
        userName: creds.username,
        username: creds.username,
        password: creds.password,
        ...(creds.taxCode ? { taxCode: creds.taxCode } : {}),
      },
      write: false,
      timeoutMs,
    });
    if (res.status === 429 || res.status >= 500) return { ok: false, reason: 'unavailable' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'credentials' };
    if (!isRecord(res.json)) return { ok: false, reason: 'unavailable' };
    const code = readMisaErrorCode(res.json);
    if (code === '122') return { ok: false, reason: 'two_step' };
    if (code === 'UnAuthorize' || code === 'InvalidCredentials') {
      return { ok: false, reason: 'credentials' };
    }
    if (code === 'InActiveAppID') return { ok: false, reason: 'api_not_enabled' };
    if (code === 'IpNotAllowed') return { ok: false, reason: 'ip_not_allowed' };
    const okEnvelope = extractMisaEnvelopeSuccess(res.json);
    if (okEnvelope === false) return { ok: false, reason: 'credentials' };
    if (res.status >= 400) return { ok: false, reason: 'unavailable' };

    const data = pickCaseInsensitive(res.json, 'Data');
    // Open API returns both MISAID `accessToken` and eSign `remoteSigningAccessToken`; AuthorizationRM requires the latter.
    const hasRemoteTokenField =
      (isRecord(data) && pickCaseInsensitive(data, 'remoteSigningAccessToken') !== undefined) ||
      pickCaseInsensitive(res.json, 'remoteSigningAccessToken') !== undefined;
    const remoteToken =
      readText(pickCaseInsensitive(data, 'remoteSigningAccessToken')) ??
      readText(pickCaseInsensitive(res.json, 'remoteSigningAccessToken'));
    const token =
      remoteToken ??
      (hasRemoteTokenField
        ? null
        : (readText(data) ??
          readText(pickCaseInsensitive(data, 'AccessToken')) ??
          readText(pickCaseInsensitive(data, 'Token')) ??
          readText(pickCaseInsensitive(res.json, 'AccessToken'))));
    if (token) {
      const expiresInSec = Number(pickCaseInsensitive(data, 'ExpiresIn'));
      const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 60 ? (expiresInSec - 30) * 1000 : DEFAULT_TOKEN_TTL_MS;
      const userObj = pickCaseInsensitive(data, 'user');
      const userInfo = pickCaseInsensitive(data, 'userInfo');
      const userId =
        readText(pickCaseInsensitive(userObj, 'id')) ??
        readText(pickCaseInsensitive(userObj, 'userId')) ??
        readText(pickCaseInsensitive(data, 'userId')) ??
        readText(pickCaseInsensitive(userInfo, 'userId')) ??
        readText(pickCaseInsensitive(userInfo, 'id')) ??
        creds.userId ??
        creds.username;
      return { ok: true, token, userId, ttlMs };
    }
    const custom = pickCaseInsensitive(res.json, 'CustomData');
    if (pickCaseInsensitive(custom, 'Id') !== undefined || pickCaseInsensitive(data, 'RequireOtp') === true) {
      return { ok: false, reason: 'two_step' };
    }
    return { ok: false, reason: 'credentials' };
  }

  function cacheToken(secretKey: string, token: string, userId: string, ttlMs: number): void {
    setBoundedMap(tokens, 100, secretKey, { token, userId, expiresAtMs: now().getTime() + ttlMs });
  }

  async function getSessionAuth(
    secretKey: string,
    creds: MisaWeSignCredentials,
    forceFresh: boolean,
  ): Promise<{ readonly token: string; readonly userId: string }> {
    const cached = tokens.get(secretKey);
    const currentMs = now().getTime();
    if (!forceFresh && cached && cached.expiresAtMs > currentMs) {
      return { token: cached.token, userId: cached.userId };
    }
    tokens.delete(secretKey);
    const result = await login(creds);
    if (!result.ok) {
      throw new CaProviderError(result.reason === 'unavailable' ? 'unavailable' : 'credentials');
    }
    cacheToken(secretKey, result.token, result.userId, result.ttlMs);
    return { token: result.token, userId: result.userId };
  }

  async function callAuthorized(
    secret: string,
    creds: MisaWeSignCredentials,
    method: 'GET' | 'POST',
    path: string,
    bodyOrFactory: unknown | ((userId: string) => unknown),
    write: boolean,
  ): Promise<{ status: number; json: unknown }> {
    const key = sha256Hex(secret);
    const base = resolveBaseUrl(creds);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const auth = await getSessionAuth(key, creds, attempt > 0);
      const body = typeof bodyOrFactory === 'function' ? (bodyOrFactory as (uid: string) => unknown)(auth.userId) : bodyOrFactory;
      const res = await postCaJson({
        fetchImpl,
        method,
        url: `${base}${path}`,
        allowedHosts,
        headers: {
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          accept: 'application/json',
          'x-clientId': creds.clientId,
          'x-clientKey': creds.clientKey,
          AuthorizationRM: `Bearer ${auth.token}`,
        },
        body,
        write,
        timeoutMs,
      });
      const code = readMisaErrorCode(res.json);
      const statusObj = isRecord(res.json) ? pickCaseInsensitive(res.json, 'status') : undefined;
      const envelopeCode = isRecord(statusObj) ? Number(pickCaseInsensitive(statusObj, 'code')) : NaN;
      if (
        res.status === 401 ||
        envelopeCode === 401 ||
        code === 'TokenExpiredCode' ||
        code === 'InvalidTokenCode' ||
        code === 'UnAuthorize'
      ) {
        tokens.delete(key);
        if (attempt === 0) continue;
        throw new CaProviderError('credentials');
      }
      return res;
    }
    throw new CaProviderError('credentials');
  }

  async function fetchRemoteCertificateRecords(
    secret: string,
    creds: MisaWeSignCredentials,
  ): Promise<
    | { readonly ok: true; readonly records: readonly MisaCertificateRecord[] }
    | { readonly ok: false; readonly reason: 'credentials' | 'unavailable' }
  > {
    const certsRes = await callAuthorized(
      secret,
      creds,
      'GET',
      '/external/esrm/service/general/api/v1/Certificates/by-userId',
      undefined,
      false,
    );
    if (certsRes.status === 429 || certsRes.status >= 500) {
      return { ok: false, reason: 'unavailable' };
    }
    if (certsRes.status === 401 || certsRes.status === 403) {
      return { ok: false, reason: 'credentials' };
    }
    if (
      certsRes.status >= 400 ||
      !(Array.isArray(certsRes.json) || isRecord(certsRes.json)) ||
      (isRecord(certsRes.json) && extractMisaEnvelopeSuccess(certsRes.json) === false)
    ) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, records: extractMisaCertificates(certsRes.json) };
  }

  async function resolveCertificateChainDer(
    secret: string,
    secretKey: string,
    creds: MisaWeSignCredentials,
    txId: string,
    explicitCertRef?: string,
  ): Promise<readonly Uint8Array[]> {
    const wantedRef = explicitCertRef ?? txToCertRef.get(`${secretKey}:${txId}`);
    const cached = certCache.get(secretKey);
    if (cached && cached.length > 0) {
      try {
        return selectRemoteCertificateChain({
          providerLabel: 'MISA WeSign',
          records: cached,
          ...(wantedRef !== undefined ? { wantedCertRef: wantedRef } : {}),
        });
      } catch (err) {
        if (!wantedRef) throw err;
      }
    }
    const fetched = await fetchRemoteCertificateRecords(secret, creds);
    if (!fetched.ok) {
      throw new CaProviderError(fetched.reason);
    }
    const { records } = fetched;
    if (records.length > 0) cacheCerts(secretKey, records);
    return selectRemoteCertificateChain({
      providerLabel: 'MISA WeSign',
      records,
      ...(wantedRef !== undefined ? { wantedCertRef: wantedRef } : {}),
    });
  }

  function parseSession(
    json: unknown,
    fallbackIdempotencyKey: string,
    fallbackTxId: string,
    unrecognizedErrorKind: 'unavailable' | 'lost_answer' = 'unavailable',
    allowFallbackTxIdOnTerminalOnly = false,
  ): CaSignSession {
    const data = pickCaseInsensitive(json, 'Data') ?? json;
    const topLevelStatus = pickCaseInsensitive(json, 'status');
    const status = mapMisaStatus(
      pickCaseInsensitive(data, 'Status') ??
        pickCaseInsensitive(data, 'SignStatus') ??
        (isRecord(topLevelStatus) ? undefined : topLevelStatus),
    );
    if (!status) {
      throw new CaProviderError(unrecognizedErrorKind, 'unrecognized MISA WeSign status');
    }
    const serverTxId =
      readText(pickCaseInsensitive(data, 'TransactionID')) ??
      readText(pickCaseInsensitive(data, 'SignID')) ??
      readText(pickCaseInsensitive(json, 'transactionId'));
    const allowFallback =
      !allowFallbackTxIdOnTerminalOnly || status === 'rejected' || status === 'expired' || status === 'failed';
    const externalTxId = serverTxId ?? (allowFallback ? fallbackTxId : '');
    if (!externalTxId) {
      throw new CaProviderError(unrecognizedErrorKind, 'missing transactionId in MISA WeSign response');
    }
    return {
      provider: 'misa_wesign',
      idempotencyKey:
        readText(pickCaseInsensitive(data, 'RefID')) ??
        readText(pickCaseInsensitive(data, 'refId')) ??
        fallbackIdempotencyKey,
      externalTxId,
      status,
      challengeCode: readText(pickCaseInsensitive(data, 'ChallengeCode')),
      expiresAt: readText(pickCaseInsensitive(data, 'ExpiredAt')),
      signedAt: status === 'signed' ? (readText(pickCaseInsensitive(data, 'SignedAt')) ?? now().toISOString()) : null,
      errorCode: status === 'signed' || status === 'pending' ? null : readMisaErrorCode(json),
    };
  }

  async function queryStatus(
    secret: string,
    creds: MisaWeSignCredentials,
    query: { externalTxId: string | null; idempotencyKey: string | null },
  ): Promise<{ session: CaSignSession; rawJson: unknown }> {
    if (!query.externalTxId) {
      // Published MISA eSign GET .../Signing/status/{transaction_id} requires server transactionId and does not support lookup by DocumentId/idempotencyKey.
      throw new CaProviderError(
        'lost_answer',
        'MISA WeSign requires server transactionId or webhook callback to reconcile an interrupted initiateSign',
      );
    }
    const res = await callAuthorized(
      secret,
      creds,
      'GET',
      `/external/esrm/service/signing/api/v1/Signing/status/${encodeURIComponent(query.externalTxId)}`,
      undefined,
      false,
    );
    if (res.status === 429 || res.status >= 500) throw new CaProviderError('unavailable');
    if (res.status === 401 || res.status === 403) throw new CaProviderError('credentials');
    if (res.status >= 400 || !isRecord(res.json) || extractMisaEnvelopeSuccess(res.json) === false) {
      throw new CaProviderError('unavailable');
    }
    const session = parseSession(res.json, query.idempotencyKey ?? query.externalTxId, query.externalTxId);
    return { session, rawJson: res.json };
  }

  return {
    id: 'misa_wesign',
    hosts: [...allowedHosts],
    connectFields: [...MISA_WESIGN_CONNECT_FIELDS],
    capabilities: {
      signing: 'provider_hsm',
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
      let creds: MisaWeSignCredentials;
      try {
        creds = parseMisaCredentials(secret);
        resolveBaseUrl(creds);
      } catch (error) {
        if (error instanceof CaProviderError && error.kind === 'usb_token_unsupported') return 'usb_token_unsupported';
        if (error instanceof CaProviderError && error.kind === 'unsafe_url') throw error;
        return 'wrong_credentials';
      }
      try {
        const auth = await login(creds);
        if (!auth.ok) {
          if (auth.reason === 'two_step') return 'signing_needs_person';
          if (auth.reason === 'api_not_enabled') return 'api_not_enabled';
          if (auth.reason === 'ip_not_allowed') return 'ip_not_allowed';
          if (auth.reason === 'credentials') return 'wrong_credentials';
          return 'unreachable';
        }
        cacheToken(sha256Hex(secret), auth.token, auth.userId, auth.ttlMs);
        const fetched = await fetchRemoteCertificateRecords(secret, creds);
        if (!fetched.ok) {
          return fetched.reason === 'credentials' ? 'wrong_credentials' : 'unreachable';
        }
        const { records } = fetched;
        if (records.length === 0) return 'signing_needs_person';
        const activeRemote = records.filter((r) => !r.isUsbOnly && r.isActive);
        if (activeRemote.length > 0) {
          cacheCerts(sha256Hex(secret), records.filter((r) => !r.isUsbOnly));
          return 'works';
        }
        return records.some((r) => r.isUsbOnly) ? 'usb_token_unsupported' : 'signing_needs_person';
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
      const creds = parseMisaCredentials(secret);
      const valid = validateInitiateRequest(request);
      const secretKey = sha256Hex(secret);
      const hashBase64 = Buffer.from(valid.digestSha256, 'hex').toString('base64');
      const res = await callAuthorized(
        secret,
        creds,
        'POST',
        '/external/esrm/service/signing/api/v1/Signing/hash',
        (resolvedUserId: string) => ({
          DataToBeDisplayed: valid.signerReason ?? (valid.documentName ? `Sign ${valid.documentName}` : 'Sign document'),
          UserId: resolvedUserId,
          CertAlias: valid.certRef,
          Documents: [
            {
              DocumentId: toMisaDocumentId(valid.idempotencyKey),
              FileToSign: hashBase64,
              DocumentName: (valid.documentName ?? 'document.pdf').slice(0, 100),
            },
          ],
        }),
        true,
      );
      if (res.status === 429) throw new CaProviderError('unavailable');
      if (res.status >= 500) throw new CaProviderError('lost_answer');
      if (res.status === 401 || res.status === 403) throw new CaProviderError('credentials');
      if (!isRecord(res.json)) {
        if (res.status >= 400) {
          return {
            provider: 'misa_wesign',
            idempotencyKey: valid.idempotencyKey,
            externalTxId: valid.idempotencyKey,
            status: 'failed',
            errorCode: `HTTP_${res.status}`,
          };
        }
        throw new CaProviderError('lost_answer');
      }

      const errorCode = readMisaErrorCode(res.json);
      if (res.status === 409 || errorCode === 'DuplicateRefID' || errorCode === 'TransactionExists') {
        const dataObj = pickCaseInsensitive(res.json, 'Data') ?? res.json;
        const dupTxId =
          readText(pickCaseInsensitive(dataObj, 'TransactionID')) ??
          readText(pickCaseInsensitive(dataObj, 'SignID')) ??
          readText(pickCaseInsensitive(res.json, 'transactionId'));
        if (!dupTxId) {
          throw new CaProviderError(
            'lost_answer',
            'MISA WeSign duplicate request response missing server transactionId',
          );
        }
        const reconciled = await queryStatus(secret, creds, {
          externalTxId: dupTxId,
          idempotencyKey: valid.idempotencyKey,
        }).catch(() => {
          throw new CaProviderError('lost_answer');
        });
        rememberCertRef(secretKey, reconciled.session.externalTxId, valid.certRef);
        return reconciled.session;
      }
      if (res.status >= 400 || extractMisaEnvelopeSuccess(res.json) === false) {
        return {
          provider: 'misa_wesign',
          idempotencyKey: valid.idempotencyKey,
          externalTxId: valid.idempotencyKey,
          status: 'failed',
          errorCode: errorCode ?? `HTTP_${res.status}`,
        };
      }
      const data = pickCaseInsensitive(res.json, 'Data') ?? res.json;
      const topLevelStatus = pickCaseInsensitive(res.json, 'status');
      const rawStatus =
        pickCaseInsensitive(data, 'Status') ??
        pickCaseInsensitive(data, 'SignStatus') ??
        (isRecord(topLevelStatus) ? undefined : topLevelStatus);
      const txId =
        readText(pickCaseInsensitive(data, 'TransactionID')) ??
        readText(pickCaseInsensitive(data, 'SignID')) ??
        readText(pickCaseInsensitive(res.json, 'transactionId'));
      if ((rawStatus === undefined || rawStatus === null) && txId) {
        rememberCertRef(secretKey, txId, valid.certRef);
        return {
          provider: 'misa_wesign',
          idempotencyKey: valid.idempotencyKey,
          externalTxId: txId,
          status: 'pending',
          challengeCode: readText(pickCaseInsensitive(data, 'ChallengeCode')),
          expiresAt: readText(pickCaseInsensitive(data, 'ExpiredAt')),
          signedAt: null,
          errorCode: null,
        };
      }
      const session = parseSession(res.json, valid.idempotencyKey, valid.idempotencyKey, 'lost_answer', true);
      rememberCertRef(secretKey, session.externalTxId, valid.certRef);
      return session;
    },

    pollStatus: async (secret: string, query: CaPollQuery | string): Promise<CaSignSession> => {
      const creds = parseMisaCredentials(secret);
      const normalized = normalizePollQuery(query);
      const { session } = await queryStatus(secret, creds, normalized);
      return session;
    },

    fetchSignedCms: async (secret: string, query: CaFetchCmsQuery | string): Promise<CaSignedCms> => {
      const creds = parseMisaCredentials(secret);
      const normalized = normalizeFetchCmsQuery(query);
      const txId = normalized.externalTxId;
      const secretKey = sha256Hex(secret);
      const { session, rawJson } = await queryStatus(secret, creds, { externalTxId: txId, idempotencyKey: null });
      if (session.status !== 'signed') {
        throw new CaProviderError('not_signed', 'MISA WeSign transaction is not signed');
      }
      const data = pickCaseInsensitive(rawJson, 'Data') ?? rawJson;
      const sigs = pickCaseInsensitive(data, 'signatures');
      const firstSig = Array.isArray(sigs) && isRecord(sigs[0]) ? sigs[0] : undefined;
      const rawCms = extractMisaSignatureField(data);
      const sigBytes = decodeBase64Bytes(rawCms);
      if (!sigBytes || sigBytes.byteLength === 0) {
        throw new CaProviderError('unavailable', 'MISA WeSign response did not contain signature bytes');
      }

      const inlineCertAlias =
        readText(pickCaseInsensitive(firstSig, 'keyAlias')) ??
        readText(pickCaseInsensitive(firstSig, 'CertAlias')) ??
        readText(pickCaseInsensitive(data, 'keyAlias')) ??
        readText(pickCaseInsensitive(data, 'CertAlias')) ??
        readText(pickCaseInsensitive(data, 'CertSerial')) ??
        readText(pickCaseInsensitive(rawJson, 'keyAlias')) ??
        readText(pickCaseInsensitive(rawJson, 'CertAlias'));
      const rawChain =
        pickCaseInsensitive(firstSig, 'certiticateChain') ??
        pickCaseInsensitive(firstSig, 'CertificateChain') ??
        pickCaseInsensitive(data, 'certiticateChain') ??
        pickCaseInsensitive(data, 'CertificateChain');
      const parsedInlineChain = Array.isArray(rawChain)
        ? rawChain.map(decodeDerCertificate).filter((v): v is Uint8Array => v !== null)
        : [];
      const inlineSingleCert = decodeDerCertificate(
        pickCaseInsensitive(firstSig, 'certificate') ??
          pickCaseInsensitive(data, 'CertData') ??
          pickCaseInsensitive(data, 'certificate'),
      );
      const inlineChainDer = mergeInlineCertChainDer(inlineSingleCert, parsedInlineChain);

      const { cmsDer, subFilter, certificateChainPem } = await resolveCmsOrWrapRawSignature({
        providerLabel: 'MISA WeSign',
        sigBytes,
        rawChain,
        inlineChainDer,
        ...(normalized.signedAttrsDer !== undefined ? { signedAttrsDer: normalized.signedAttrsDer } : {}),
        loadChainDer: () => resolveCertificateChainDer(secret, secretKey, creds, txId, normalized.certRef ?? inlineCertAlias ?? undefined),
      });

      const timestampTokenDer = decodeDerSequenceBase64(
        pickCaseInsensitive(firstSig, 'TimestampToken') ?? pickCaseInsensitive(data, 'TimestampToken'),
      );
      const rawOcsps =
        pickCaseInsensitive(firstSig, 'OcspResponses') ?? pickCaseInsensitive(data, 'OcspResponses');
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

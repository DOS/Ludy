// SPDX-License-Identifier: AGPL-3.0-only
// MISA eSign / WeSign remote signing adapter (Open API auth via esignapp.misa.vn + RMeSign signing endpoints).
// Strictly enforces HTTPS + host allowlist (SSRF guard), rejects client-PC USB/token signing modes,
// keeps credentials and AuthorizationRM tokens opaque in memory, uses reconcile_only initiateSign safety,
// and wraps raw signatures in RFC 5652 detached CMS SignedData when certificates are available.
import {
  decodeDerCertificate,
  resolveCmsOrWrapRawSignature,
} from './cms-der.ts';
import {
  DEFAULT_CA_TIMEOUT_MS,
  assertSafeCaBaseUrl,
  assertSafeHostAllowlist,
  decodeBase64Bytes,
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
  setBoundedMap,
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
  taxCode?: string;
  baseUrl?: string;
}

interface MisaCertificateRecord {
  readonly serial: string | null;
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
  const taxCode = optionalCredentialField(obj, 'taxCode');
  const baseUrl = optionalCredentialField(obj, 'baseUrl');
  return {
    clientId,
    clientKey,
    username,
    password,
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
  const list = Array.isArray(data) ? data : [];
  const out: MisaCertificateRecord[] = [];
  for (const cert of list) {
    if (!isRecord(cert)) continue;
    const certType =
      pickCaseInsensitive(cert, 'SignType') ??
      pickCaseInsensitive(cert, 'TokenType') ??
      pickCaseInsensitive(cert, 'DeviceType');
    const isUsbOnly = certType !== undefined && isUsbTokenMode(certType);
    const keyStatus = readText(pickCaseInsensitive(cert, 'KeyStatus'));
    const isActive = keyStatus === null || keyStatus.toUpperCase() === 'ACTIVE';
    const serial = readText(pickCaseInsensitive(cert, 'CertSerial'));
    const chainDer: Uint8Array[] = [];
    const leaf = decodeDerCertificate(
      pickCaseInsensitive(cert, 'CertData') ??
        pickCaseInsensitive(cert, 'Certificate') ??
        pickCaseInsensitive(cert, 'CertBase64'),
    );
    if (leaf) chainDer.push(leaf);
    const rawChain = pickCaseInsensitive(cert, 'CertificateChain');
    if (Array.isArray(rawChain)) {
      for (const item of rawChain) {
        const parsed = decodeDerCertificate(item);
        if (parsed) chainDer.push(parsed);
      }
    }
    out.push({ serial, isUsbOnly, isActive, chainDer });
  }
  return out;
}

export function createMisaWeSignAdapter(options: CaAdapterOptions = {}): CaSigningAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_CA_TIMEOUT_MS;
  const allowedHosts = assertSafeHostAllowlist(options.allowedHosts ?? MISA_WESIGN_HOSTS);
  const defaultBaseUrl = assertSafeCaBaseUrl(options.baseUrl ?? MISA_WESIGN_BASE_URL, allowedHosts);
  const tokens = new Map<string, { token: string; expiresAtMs: number }>();
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
    | { ok: true; token: string; ttlMs: number }
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
    if (res.status === 429 || res.status >= 500 || !isRecord(res.json)) return { ok: false, reason: 'unavailable' };
    const code = readText(pickCaseInsensitive(res.json, 'ErrorCode'));
    const success = pickCaseInsensitive(res.json, 'Success');
    if (res.status === 401 || res.status === 403 || code === 'UnAuthorize' || code === 'InvalidCredentials') {
      return { ok: false, reason: 'credentials' };
    }
    if (code === 'InActiveAppID') return { ok: false, reason: 'api_not_enabled' };
    if (code === 'IpNotAllowed') return { ok: false, reason: 'ip_not_allowed' };
    if (success === false) return { ok: false, reason: 'credentials' };

    const data = pickCaseInsensitive(res.json, 'Data');
    const token =
      readText(data) ??
      readText(pickCaseInsensitive(data, 'AccessToken')) ??
      readText(pickCaseInsensitive(data, 'Token')) ??
      readText(pickCaseInsensitive(res.json, 'AccessToken'));
    if (token) {
      const expiresInSec = Number(pickCaseInsensitive(data, 'ExpiresIn'));
      const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 60 ? (expiresInSec - 30) * 1000 : DEFAULT_TOKEN_TTL_MS;
      return { ok: true, token, ttlMs };
    }
    const custom = pickCaseInsensitive(res.json, 'CustomData');
    if (pickCaseInsensitive(custom, 'Id') !== undefined || pickCaseInsensitive(data, 'RequireOtp') === true) {
      return { ok: false, reason: 'two_step' };
    }
    return { ok: false, reason: 'credentials' };
  }

  function cacheToken(secretKey: string, token: string, ttlMs: number): void {
    setBoundedMap(tokens, 100, secretKey, { token, expiresAtMs: now().getTime() + ttlMs });
  }

  async function getToken(secretKey: string, creds: MisaWeSignCredentials, forceFresh: boolean): Promise<string> {
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
    creds: MisaWeSignCredentials,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    write: boolean,
  ): Promise<{ status: number; json: unknown }> {
    const key = sha256Hex(secret);
    const base = resolveBaseUrl(creds);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getToken(key, creds, attempt > 0);
      const res = await postCaJson({
        fetchImpl,
        method,
        url: `${base}${path}`,
        allowedHosts,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-clientId': creds.clientId,
          'x-clientKey': creds.clientKey,
          AuthorizationRM: `Bearer ${token}`,
        },
        body,
        write,
        timeoutMs,
      });
      const code = isRecord(res.json) ? readText(pickCaseInsensitive(res.json, 'ErrorCode')) : null;
      if (res.status === 401 || code === 'TokenExpiredCode' || code === 'InvalidTokenCode' || code === 'UnAuthorize') {
        tokens.delete(key);
        if (attempt === 0) continue;
        throw new CaProviderError('credentials');
      }
      return res;
    }
    throw new CaProviderError('credentials');
  }

  async function resolveCertificateChainDer(
    secret: string,
    secretKey: string,
    creds: MisaWeSignCredentials,
    txId: string,
  ): Promise<readonly Uint8Array[] | null> {
    const wantedSerial = txToCertRef.get(`${secretKey}:${txId}`);
    const selectFrom = (list: readonly MisaCertificateRecord[]): readonly Uint8Array[] | null => {
      if (list.length === 0) return null;
      const match = wantedSerial
        ? list.find((c) => !c.isUsbOnly && c.serial?.toLowerCase() === wantedSerial.toLowerCase())
        : undefined;
      const chosen = match ?? list.find((c) => !c.isUsbOnly && c.isActive && c.chainDer.length > 0);
      return chosen && chosen.chainDer.length > 0 ? chosen.chainDer : null;
    };
    const cached = certCache.get(secretKey);
    const hit = cached ? selectFrom(cached) : null;
    if (hit) return hit;

    const certsRes = await callAuthorized(secret, creds, 'POST', '/apis/RMeSign/GetListCertificate', {}, false);
    if (certsRes.status === 429 || certsRes.status >= 500 || !isRecord(certsRes.json)) {
      throw new CaProviderError('unavailable');
    }
    if (certsRes.status === 403) throw new CaProviderError('credentials');
    const records = extractMisaCertificates(certsRes.json);
    if (records.length > 0) cacheCerts(secretKey, records);
    return selectFrom(records);
  }

  function parseSession(json: unknown, fallbackIdempotencyKey: string, fallbackTxId: string): CaSignSession {
    const data = pickCaseInsensitive(json, 'Data') ?? json;
    const externalTxId =
      readText(pickCaseInsensitive(data, 'TransactionID')) ??
      readText(pickCaseInsensitive(data, 'SignID')) ??
      fallbackTxId;
    if (!externalTxId) {
      throw new CaProviderError('unavailable', 'missing TransactionID in MISA WeSign response');
    }
    const status = mapMisaStatus(
      pickCaseInsensitive(data, 'Status') ?? pickCaseInsensitive(data, 'SignStatus'),
    );
    if (!status) {
      throw new CaProviderError('unavailable', 'unrecognized MISA WeSign status');
    }
    return {
      provider: 'misa_wesign',
      idempotencyKey: readText(pickCaseInsensitive(data, 'RefID')) ?? fallbackIdempotencyKey,
      externalTxId,
      status,
      challengeCode: readText(pickCaseInsensitive(data, 'ChallengeCode')),
      expiresAt: readText(pickCaseInsensitive(data, 'ExpiredAt')),
      signedAt: status === 'signed' ? (readText(pickCaseInsensitive(data, 'SignedAt')) ?? now().toISOString()) : null,
      errorCode: status === 'signed' || status === 'pending' ? null : readText(pickCaseInsensitive(json, 'ErrorCode')),
    };
  }

  async function queryStatus(
    secret: string,
    creds: MisaWeSignCredentials,
    query: { externalTxId: string | null; idempotencyKey: string | null },
  ): Promise<{ session: CaSignSession; rawJson: unknown }> {
    const res = await callAuthorized(
      secret,
      creds,
      'POST',
      '/apis/RMeSign/GetSignStatusV3',
      {
        ...(query.externalTxId ? { TransactionID: query.externalTxId } : {}),
        ...(query.idempotencyKey ? { RefID: query.idempotencyKey } : {}),
      },
      false,
    );
    if (res.status === 429) throw new CaProviderError('unavailable');
    if (res.status >= 500 || !isRecord(res.json)) throw new CaProviderError('unavailable');
    if (res.status === 403) throw new CaProviderError('credentials');
    if (res.status >= 400 || pickCaseInsensitive(res.json, 'Success') === false) {
      throw new CaProviderError('unavailable');
    }
    const fallbackTx = query.externalTxId ?? query.idempotencyKey ?? '';
    const session = parseSession(res.json, query.idempotencyKey ?? fallbackTx, fallbackTx);
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
        cacheToken(sha256Hex(secret), auth.token, auth.ttlMs);
        const certsRes = await callAuthorized(secret, creds, 'POST', '/apis/RMeSign/GetListCertificate', {}, false);
        if (certsRes.status === 429 || certsRes.status >= 500 || !isRecord(certsRes.json)) return 'unreachable';
        if (certsRes.status === 401 || certsRes.status === 403) return 'wrong_credentials';
        if (pickCaseInsensitive(certsRes.json, 'Success') !== true) return 'unreachable';
        const records = extractMisaCertificates(certsRes.json);
        if (records.length === 0) return 'signing_needs_person';
        const activeRemote = records.filter((r) => !r.isUsbOnly && r.isActive);
        if (activeRemote.length > 0) {
          cacheCerts(sha256Hex(secret), activeRemote);
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
        '/apis/RMeSign/SignHashV4',
        {
          RefID: valid.idempotencyKey,
          CertSerial: valid.certRef,
          HashAlgorithm: 'SHA256',
          DigestHex: valid.digestSha256,
          HashBase64: hashBase64,
          SignType: 'RemoteSigning',
          ...(valid.documentName ? { DocumentName: valid.documentName } : {}),
          ...(valid.signerReason ? { Reason: valid.signerReason } : {}),
        },
        true,
      );
      if (res.status === 429) throw new CaProviderError('unavailable');
      if (res.status >= 500 || !isRecord(res.json)) throw new CaProviderError('lost_answer');
      if (res.status === 403) throw new CaProviderError('credentials');

      const errorCode = readText(pickCaseInsensitive(res.json, 'ErrorCode'));
      if (res.status === 409 || errorCode === 'DuplicateRefID' || errorCode === 'TransactionExists') {
        const reconciled = await queryStatus(secret, creds, { externalTxId: null, idempotencyKey: valid.idempotencyKey }).catch(() => {
          throw new CaProviderError('lost_answer');
        });
        rememberCertRef(secretKey, reconciled.session.externalTxId, valid.certRef);
        return reconciled.session;
      }
      if (res.status >= 400 || pickCaseInsensitive(res.json, 'Success') === false) {
        return {
          provider: 'misa_wesign',
          idempotencyKey: valid.idempotencyKey,
          externalTxId: valid.idempotencyKey,
          status: 'failed',
          errorCode: errorCode ?? `HTTP_${res.status}`,
        };
      }
      const data = pickCaseInsensitive(res.json, 'Data');
      const explicitStatus = mapMisaStatus(pickCaseInsensitive(data, 'Status'));
      const txId = readText(pickCaseInsensitive(data, 'TransactionID')) ?? readText(pickCaseInsensitive(data, 'SignID'));
      if (!explicitStatus && txId) {
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
      const session = parseSession(res.json, valid.idempotencyKey, valid.idempotencyKey);
      rememberCertRef(secretKey, session.externalTxId, valid.certRef);
      return session;
    },

    pollStatus: async (secret: string, query: CaPollQuery | string): Promise<CaSignSession> => {
      const creds = parseMisaCredentials(secret);
      const normalized = normalizePollQuery(query);
      const { session } = await queryStatus(secret, creds, normalized);
      return session;
    },

    fetchSignedCms: async (secret: string, externalTxId: string): Promise<CaSignedCms> => {
      const creds = parseMisaCredentials(secret);
      const txId = normalizeExternalTxId(externalTxId);
      const secretKey = sha256Hex(secret);
      const { session, rawJson } = await queryStatus(secret, creds, { externalTxId: txId, idempotencyKey: null });
      if (session.status !== 'signed') {
        throw new CaProviderError('not_signed', 'MISA WeSign transaction is not signed');
      }
      const data = pickCaseInsensitive(rawJson, 'Data') ?? rawJson;
      const rawCms =
        pickCaseInsensitive(data, 'CmsBase64') ??
        pickCaseInsensitive(data, 'Signature') ??
        pickCaseInsensitive(data, 'SignedData');
      const sigBytes = decodeBase64Bytes(rawCms);
      if (!sigBytes || sigBytes.byteLength === 0) {
        throw new CaProviderError('unavailable', 'MISA WeSign response did not contain signature bytes');
      }

      const rawChain = pickCaseInsensitive(data, 'CertificateChain');
      const inlineChainDer = Array.isArray(rawChain)
        ? rawChain.map(decodeDerCertificate).filter((v): v is Uint8Array => v !== null)
        : [];
      const inlineSingleCert = decodeDerCertificate(pickCaseInsensitive(data, 'CertData'));
      if (inlineSingleCert && inlineChainDer.length === 0) {
        inlineChainDer.push(inlineSingleCert);
      }

      const { cmsDer, certificateChainPem } = await resolveCmsOrWrapRawSignature({
        providerLabel: 'MISA WeSign',
        sigBytes,
        rawChain,
        inlineChainDer,
        loadChainDer: () => resolveCertificateChainDer(secret, secretKey, creds, txId),
      });

      const timestampTokenDer = decodeDerSequenceBase64(pickCaseInsensitive(data, 'TimestampToken'));
      const rawOcsps = pickCaseInsensitive(data, 'OcspResponses');
      const ocspResponsesDer = Array.isArray(rawOcsps)
        ? rawOcsps.map(decodeDerSequenceBase64).filter((v): v is Uint8Array => v !== null)
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

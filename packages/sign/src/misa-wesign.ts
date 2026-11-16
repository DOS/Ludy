// SPDX-License-Identifier: AGPL-3.0-only
// MISA WeSign (RMeSign Open API) remote signing adapter.
// Strictly enforces HTTPS + host allowlist (SSRF guard), rejects client-PC USB/token signing modes,
// keeps credentials/tokens opaque in memory, and uses reconcile_only initiateSign safety.
import {
  DEFAULT_CA_TIMEOUT_MS,
  assertSafeCaBaseUrl,
  assertSafeHostAllowlist,
  decodeDerSequenceBase64,
  isRecord,
  isUsbTokenMode,
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

export const MISA_WESIGN_BASE_URL = 'https://developer.misa.vn/apis/RMeSign';
export const MISA_WESIGN_HOSTS = ['developer.misa.vn', 'esignapi.misa.vn', 'testesignapi.misa.vn'] as const;
export const MISA_WESIGN_CONNECT_FIELDS = ['appId', 'appSecret', 'username', 'password', 'taxCode'] as const;

const DEFAULT_TOKEN_TTL_MS = 6 * 3_600_000;

interface MisaWeSignCredentials {
  appId: string;
  appSecret: string;
  username: string;
  password: string;
  taxCode?: string;
  baseUrl?: string;
}

function parseMisaCredentials(secret: string): MisaWeSignCredentials {
  const obj = parseCredentialObject(secret);
  const appId = requireCredentialField(obj, 'appId');
  const appSecret = requireCredentialField(obj, 'appSecret');
  const username = requireCredentialField(obj, 'username');
  const password = requireCredentialField(obj, 'password');
  const taxCode = optionalCredentialField(obj, 'taxCode');
  const baseUrl = optionalCredentialField(obj, 'baseUrl');
  return {
    appId,
    appSecret,
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
  if (['PENDING', 'WAITING', 'WAITINGAPPROVE', 'WAITING_APPROVE', 'PROCESSING'].includes(text)) return 'pending';
  if (['SUCCESS', 'SIGNED', 'COMPLETED', 'COMPLETE'].includes(text)) return 'signed';
  if (['REJECTED', 'USERREJECTED', 'USER_REJECTED', 'CANCELLED', 'DECLINED'].includes(text)) return 'rejected';
  if (['EXPIRED', 'TIMEOUT'].includes(text)) return 'expired';
  if (['FAILED', 'ERROR'].includes(text)) return 'failed';
  return null;
}

export function createMisaWeSignAdapter(options: CaAdapterOptions = {}): CaSigningAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_CA_TIMEOUT_MS;
  const allowedHosts = assertSafeHostAllowlist(options.allowedHosts ?? MISA_WESIGN_HOSTS);
  const defaultBaseUrl = assertSafeCaBaseUrl(options.baseUrl ?? MISA_WESIGN_BASE_URL, allowedHosts);
  const tokens = new Map<string, { token: string; expiresAtMs: number }>();

  function resolveBaseUrl(creds: MisaWeSignCredentials): string {
    return creds.baseUrl ? assertSafeCaBaseUrl(creds.baseUrl, allowedHosts) : defaultBaseUrl;
  }

  async function login(
    creds: MisaWeSignCredentials,
  ): Promise<
    | { ok: true; token: string }
    | { ok: false; reason: 'credentials' | 'two_step' | 'api_not_enabled' | 'ip_not_allowed' | 'unavailable' }
  > {
    const base = resolveBaseUrl(creds);
    const res = await postCaJson({
      fetchImpl,
      url: `${base}/Login`,
      allowedHosts,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        AppID: creds.appId,
        AppSecret: creds.appSecret,
      },
      body: {
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
      readText(pickCaseInsensitive(data, 'Token'));
    if (token) return { ok: true, token };
    const custom = pickCaseInsensitive(res.json, 'CustomData');
    if (pickCaseInsensitive(custom, 'Id') !== undefined || pickCaseInsensitive(data, 'RequireOtp') === true) {
      return { ok: false, reason: 'two_step' };
    }
    return { ok: false, reason: 'credentials' };
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
    if (tokens.size >= 100) tokens.delete(tokens.keys().next().value as string);
    tokens.set(secretKey, { token: result.token, expiresAtMs: currentMs + DEFAULT_TOKEN_TTL_MS });
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
          AppID: creds.appId,
          Authorization: `Bearer ${token}`,
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
    const params = new URLSearchParams();
    if (query.externalTxId) params.set('transactionId', query.externalTxId);
    if (query.idempotencyKey) params.set('refId', query.idempotencyKey);
    const res = await callAuthorized(
      secret,
      creds,
      'GET',
      `/GetSignStatusV3?${params.toString()}`,
      undefined,
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
        tokens.set(sha256Hex(secret), { token: auth.token, expiresAtMs: now().getTime() + DEFAULT_TOKEN_TTL_MS });
        const certsRes = await callAuthorized(secret, creds, 'POST', '/GetListCertificate', {}, false);
        if (certsRes.status === 429 || certsRes.status >= 500 || !isRecord(certsRes.json)) return 'unreachable';
        if (pickCaseInsensitive(certsRes.json, 'Success') !== true) return 'unreachable';
        const data = pickCaseInsensitive(certsRes.json, 'Data');
        const list = Array.isArray(data) ? data : [];
        if (list.length === 0) return 'signing_needs_person';
        let sawUsb = false;
        const hasActiveRemote = list.some((cert) => {
          if (!isRecord(cert)) return false;
          const certType =
            pickCaseInsensitive(cert, 'SignType') ??
            pickCaseInsensitive(cert, 'TokenType') ??
            pickCaseInsensitive(cert, 'DeviceType');
          if (certType !== undefined && isUsbTokenMode(certType)) {
            sawUsb = true;
            return false;
          }
          const keyStatus = readText(pickCaseInsensitive(cert, 'KeyStatus'));
          return keyStatus === null || keyStatus.toUpperCase() === 'ACTIVE';
        });
        if (hasActiveRemote) return 'works';
        return sawUsb ? 'usb_token_unsupported' : 'signing_needs_person';
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
      const hashBase64 = Buffer.from(valid.digestSha256, 'hex').toString('base64');
      const res = await callAuthorized(
        secret,
        creds,
        'POST',
        '/SignHashV4',
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
      return parseSession(res.json, valid.idempotencyKey, valid.idempotencyKey);
    },

    pollStatus: async (secret: string, query: CaPollQuery | string): Promise<CaSignSession> => {
      const creds = parseMisaCredentials(secret);
      const normalized = normalizePollQuery(query);
      const { session } = await queryStatus(secret, creds, normalized);
      return session;
    },

    fetchSignedCms: async (secret: string, externalTxId: string): Promise<CaSignedCms> => {
      const creds = parseMisaCredentials(secret);
      const txId = externalTxId.trim();
      if (!txId) throw new CaProviderError('invalid_request', 'externalTxId is required');
      const { session, rawJson } = await queryStatus(secret, creds, { externalTxId: txId, idempotencyKey: null });
      if (session.status !== 'signed') {
        throw new CaProviderError('not_signed', 'MISA WeSign transaction is not signed');
      }
      const data = pickCaseInsensitive(rawJson, 'Data') ?? rawJson;
      const rawCms =
        pickCaseInsensitive(data, 'CmsBase64') ??
        pickCaseInsensitive(data, 'Signature') ??
        pickCaseInsensitive(data, 'SignedData');
      const cmsDer = decodeDerSequenceBase64(rawCms);
      if (!cmsDer) {
        throw new CaProviderError('unavailable', 'MISA WeSign response did not contain valid CMS DER bytes');
      }
      const timestampTokenDer = decodeDerSequenceBase64(pickCaseInsensitive(data, 'TimestampToken'));
      const rawOcsps = pickCaseInsensitive(data, 'OcspResponses');
      const ocspResponsesDer = Array.isArray(rawOcsps)
        ? rawOcsps.map(decodeDerSequenceBase64).filter((v): v is Uint8Array => v !== null)
        : [];
      const rawChain = pickCaseInsensitive(data, 'CertificateChain');
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

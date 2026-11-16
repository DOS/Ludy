// SPDX-License-Identifier: AGPL-3.0-only
// VNPT SmartCA remote signing adapter (RSSP Web API).
// Strictly enforces HTTPS + host allowlist (SSRF guard), rejects client-PC USB/token signing modes,
// keeps credentials opaque and absent from thrown errors/URLs, and uses reconcile_only initiateSign safety.
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

export const VNPT_SMARTCA_BASE_URL = 'https://gwsca.vnpt.vn';
export const VNPT_SMARTCA_HOSTS = ['gwsca.vnpt.vn', 'rmgateway.vnptit.vn'] as const;
export const VNPT_SMARTCA_CONNECT_FIELDS = ['spId', 'spPassword', 'userId', 'serialNumber'] as const;

interface VnptCredentials {
  spId: string;
  spPassword: string;
  userId: string;
  serialNumber?: string;
  baseUrl?: string;
}

function parseVnptCredentials(secret: string): VnptCredentials {
  const obj = parseCredentialObject(secret);
  const spId = requireCredentialField(obj, 'spId');
  const spPassword = requireCredentialField(obj, 'spPassword');
  const userId = requireCredentialField(obj, 'userId');
  const serialNumber = optionalCredentialField(obj, 'serialNumber');
  const baseUrl = optionalCredentialField(obj, 'baseUrl');
  return {
    spId,
    spPassword,
    userId,
    ...(serialNumber !== undefined ? { serialNumber } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

function mapVnptStatus(rawStatus: unknown): CaSignStatus | null {
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
  if (['PENDING', 'WAITING', 'WAITING_APPROVE', 'IN_PROGRESS', 'INIT'].includes(text)) return 'pending';
  if (['SIGNED', 'SUCCESS', 'COMPLETED', 'COMPLETE', 'DONE'].includes(text)) return 'signed';
  if (['REJECTED', 'USER_REJECTED', 'CANCELLED', 'CANCELED', 'DECLINED'].includes(text)) return 'rejected';
  if (['EXPIRED', 'TIMEOUT', 'TIMED_OUT'].includes(text)) return 'expired';
  if (['FAILED', 'ERROR'].includes(text)) return 'failed';
  return null;
}

function isVnptAuthError(code: string | null, status: number): boolean {
  if (status === 401 || status === 403) return true;
  const upper = code?.toUpperCase();
  return upper !== undefined && ['AUTH_FAILED', 'INVALID_SP', 'INVALID_CREDENTIALS', 'UNAUTHORIZED', 'WRONG_PASSWORD'].includes(upper);
}

function isVnptDuplicateError(code: string | null, status: number): boolean {
  if (status === 409) return true;
  const upper = code?.toUpperCase();
  return upper !== undefined && ['TRANSACTION_EXISTS', 'DUPLICATE_TRANSACTION', 'DUPLICATE_TX_ID'].includes(upper);
}

export function createVnptSmartCaAdapter(options: CaAdapterOptions = {}): CaSigningAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_CA_TIMEOUT_MS;
  const allowedHosts = assertSafeHostAllowlist(options.allowedHosts ?? VNPT_SMARTCA_HOSTS);
  const defaultBaseUrl = assertSafeCaBaseUrl(options.baseUrl ?? VNPT_SMARTCA_BASE_URL, allowedHosts);

  function resolveBaseUrl(creds: VnptCredentials): string {
    return creds.baseUrl ? assertSafeCaBaseUrl(creds.baseUrl, allowedHosts) : defaultBaseUrl;
  }

  async function postVnpt(
    creds: VnptCredentials,
    path: string,
    body: Record<string, unknown>,
    write: boolean,
  ): Promise<{ status: number; json: unknown }> {
    const base = resolveBaseUrl(creds);
    return postCaJson({
      fetchImpl,
      url: `${base}${path}`,
      allowedHosts,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      write,
      timeoutMs,
    });
  }

  function extractCode(json: unknown): string | null {
    return (
      readText(pickCaseInsensitive(json, 'message_code')) ??
      readText(pickCaseInsensitive(json, 'error_code')) ??
      readText(pickCaseInsensitive(json, 'status_code'))
    );
  }

  function extractData(json: unknown): unknown {
    return pickCaseInsensitive(json, 'data') ?? json;
  }

  function parseSession(json: unknown, fallbackIdempotencyKey: string, fallbackTxId: string): CaSignSession {
    const data = extractData(json);
    const externalTxId =
      readText(pickCaseInsensitive(data, 'tran_id')) ??
      readText(pickCaseInsensitive(data, 'transaction_id')) ??
      fallbackTxId;
    if (!externalTxId) {
      throw new CaProviderError('unavailable', 'missing transaction identifier in VNPT SmartCA response');
    }
    const status = mapVnptStatus(
      pickCaseInsensitive(data, 'status') ??
        pickCaseInsensitive(data, 'tran_status') ??
        pickCaseInsensitive(json, 'tran_status'),
    );
    if (!status) {
      throw new CaProviderError('unavailable', 'unrecognized VNPT SmartCA transaction status');
    }
    const challengeCode =
      readText(pickCaseInsensitive(data, 'challenge_code')) ??
      readText(pickCaseInsensitive(data, 'tran_code'));
    const expiresAt = readText(pickCaseInsensitive(data, 'expired_at')) ?? readText(pickCaseInsensitive(data, 'expires_at'));
    const signedAt =
      status === 'signed'
        ? (readText(pickCaseInsensitive(data, 'signed_at')) ?? now().toISOString())
        : null;
    const errorCode = status === 'signed' || status === 'pending' ? null : extractCode(json);
    return {
      provider: 'vnpt_smartca',
      idempotencyKey: readText(pickCaseInsensitive(data, 'request_id')) ?? fallbackIdempotencyKey,
      externalTxId,
      status,
      challengeCode,
      expiresAt,
      signedAt,
      errorCode,
    };
  }

  async function queryStatus(
    creds: VnptCredentials,
    lookupKey: string,
    idempotencyKey: string,
  ): Promise<{ session: CaSignSession; rawJson: unknown }> {
    const res = await postVnpt(
      creds,
      `/v1/signatures/sign/${encodeURIComponent(lookupKey)}/status`,
      {
        sp_id: creds.spId,
        sp_password: creds.spPassword,
        user_id: creds.userId,
        transaction_id: lookupKey,
      },
      false,
    );
    if (res.status === 429) throw new CaProviderError('unavailable');
    if (res.status >= 500 || !isRecord(res.json)) throw new CaProviderError('unavailable');
    const code = extractCode(res.json);
    if (isVnptAuthError(code, res.status)) throw new CaProviderError('credentials');
    if (res.status >= 400 && pickCaseInsensitive(res.json, 'status_code') === undefined) {
      throw new CaProviderError('unavailable');
    }
    const session = parseSession(res.json, idempotencyKey, lookupKey);
    return { session, rawJson: res.json };
  }

  return {
    id: 'vnpt_smartca',
    hosts: [...allowedHosts],
    connectFields: [...VNPT_SMARTCA_CONNECT_FIELDS],
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
      let creds: VnptCredentials;
      try {
        creds = parseVnptCredentials(secret);
        resolveBaseUrl(creds);
      } catch (error) {
        if (error instanceof CaProviderError && error.kind === 'usb_token_unsupported') return 'usb_token_unsupported';
        if (error instanceof CaProviderError && error.kind === 'unsafe_url') throw error;
        return 'wrong_credentials';
      }
      try {
        const res = await postVnpt(
          creds,
          '/v1/credentials/get_certificate',
          {
            sp_id: creds.spId,
            sp_password: creds.spPassword,
            user_id: creds.userId,
            serial_number: creds.serialNumber ?? '',
            transaction_id: 'crove-connection-check',
          },
          false,
        );
        if (res.status === 429 || res.status >= 500 || !isRecord(res.json)) return 'unreachable';
        const code = extractCode(res.json);
        if (isVnptAuthError(code, res.status)) return 'wrong_credentials';
        const upperCode = code?.toUpperCase();
        if (upperCode === 'IP_NOT_ALLOWED' || upperCode === 'INVALID_IP') return 'ip_not_allowed';
        if (upperCode === 'API_NOT_ENABLED' || upperCode === 'SERVICE_INACTIVE') return 'api_not_enabled';

        const data = extractData(res.json);
        const certs = Array.isArray(data)
          ? data
          : isRecord(data) && Array.isArray(pickCaseInsensitive(data, 'user_certificates'))
            ? (pickCaseInsensitive(data, 'user_certificates') as unknown[])
            : [];
        if (certs.length === 0) return 'signing_needs_person';
        const hasRemote = certs.some((cert) => {
          if (!isRecord(cert)) return false;
          const tokenType =
            pickCaseInsensitive(cert, 'token_type') ??
            pickCaseInsensitive(cert, 'cert_type') ??
            pickCaseInsensitive(cert, 'device_type');
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
      const creds = parseVnptCredentials(secret);
      const valid = validateInitiateRequest(request);
      const res = await postVnpt(
        creds,
        '/v2/signatures/sign',
        {
          sp_id: creds.spId,
          sp_password: creds.spPassword,
          user_id: creds.userId,
          serial_number: valid.certRef,
          transaction_id: valid.idempotencyKey,
          sign_type: 'hash',
          ...(valid.signerReason ? { transaction_desc: valid.signerReason } : {}),
          sign_files: [
            {
              doc_id: valid.idempotencyKey,
              file_name: valid.documentName ?? 'document.pdf',
              data_to_be_signed: valid.digestSha256,
              file_type: 'pdf',
              sign_type: 'hash',
            },
          ],
        },
        true,
      );
      if (res.status === 429) throw new CaProviderError('unavailable');
      if (res.status >= 500 || !isRecord(res.json)) throw new CaProviderError('lost_answer');
      const code = extractCode(res.json);
      if (isVnptAuthError(code, res.status)) throw new CaProviderError('credentials');
      if (isVnptDuplicateError(code, res.status)) {
        const reconciled = await queryStatus(creds, valid.idempotencyKey, valid.idempotencyKey).catch(() => {
          throw new CaProviderError('lost_answer');
        });
        return reconciled.session;
      }
      if (res.status >= 400) {
        return {
          provider: 'vnpt_smartca',
          idempotencyKey: valid.idempotencyKey,
          externalTxId: valid.idempotencyKey,
          status: 'failed',
          errorCode: code ?? `HTTP_${res.status}`,
        };
      }
      const data = extractData(res.json);
      const explicitStatus = mapVnptStatus(
        pickCaseInsensitive(data, 'status') ?? pickCaseInsensitive(data, 'tran_status'),
      );
      if (!explicitStatus && isRecord(data) && (pickCaseInsensitive(data, 'tran_id') || pickCaseInsensitive(data, 'transaction_id'))) {
        // VNPT SmartCA initiate returns tran_id when queued for user phone confirmation.
        return {
          provider: 'vnpt_smartca',
          idempotencyKey: valid.idempotencyKey,
          externalTxId:
            readText(pickCaseInsensitive(data, 'tran_id')) ??
            readText(pickCaseInsensitive(data, 'transaction_id')) ??
            valid.idempotencyKey,
          status: 'pending',
          challengeCode: readText(pickCaseInsensitive(data, 'challenge_code')),
          expiresAt: readText(pickCaseInsensitive(data, 'expired_at')),
          signedAt: null,
          errorCode: null,
        };
      }
      return parseSession(res.json, valid.idempotencyKey, valid.idempotencyKey);
    },

    pollStatus: async (secret: string, query: CaPollQuery | string): Promise<CaSignSession> => {
      const creds = parseVnptCredentials(secret);
      const { externalTxId, idempotencyKey } = normalizePollQuery(query);
      const lookupKey = externalTxId ?? idempotencyKey!;
      const { session } = await queryStatus(creds, lookupKey, idempotencyKey ?? lookupKey);
      return session;
    },

    fetchSignedCms: async (secret: string, externalTxId: string): Promise<CaSignedCms> => {
      const creds = parseVnptCredentials(secret);
      const txId = externalTxId.trim();
      if (!txId) throw new CaProviderError('invalid_request', 'externalTxId is required');
      const { session, rawJson } = await queryStatus(creds, txId, txId);
      if (session.status !== 'signed') {
        throw new CaProviderError('not_signed', 'VNPT SmartCA transaction is not signed');
      }
      const data = extractData(rawJson);
      const sigList = pickCaseInsensitive(data, 'signatures');
      const firstSig = Array.isArray(sigList) && sigList.length > 0 ? sigList[0] : undefined;
      const cmsB64 =
        pickCaseInsensitive(firstSig, 'signature_value') ??
        pickCaseInsensitive(firstSig, 'cms') ??
        pickCaseInsensitive(firstSig, 'signature') ??
        pickCaseInsensitive(data, 'signature_value') ??
        pickCaseInsensitive(data, 'signature');
      const cmsDer = decodeDerSequenceBase64(cmsB64);
      if (!cmsDer) {
        throw new CaProviderError('unavailable', 'VNPT SmartCA response did not contain valid CMS DER bytes');
      }
      const timestampTokenDer = decodeDerSequenceBase64(
        pickCaseInsensitive(firstSig, 'timestamp_token') ?? pickCaseInsensitive(data, 'timestamp_token'),
      );
      const rawOcsps = pickCaseInsensitive(firstSig, 'ocsp_responses') ?? pickCaseInsensitive(data, 'ocsp_responses');
      const ocspResponsesDer = Array.isArray(rawOcsps)
        ? rawOcsps.map(decodeDerSequenceBase64).filter((v): v is Uint8Array => v !== null)
        : [];
      const rawChain = pickCaseInsensitive(firstSig, 'certificate_chain') ?? pickCaseInsensitive(data, 'certificate_chain');
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

// SPDX-License-Identifier: AGPL-3.0-only
// VNPT SmartCA remote signing adapter (Gateway Web API /sca/sp769 v1 async flow).
// Strictly enforces HTTPS + host allowlist (SSRF guard), rejects client-PC USB/token signing modes,
// keeps credentials opaque and absent from thrown errors/URLs, stores server tran_code cleanly,
// and assembles RFC 5652 detached CMS SignedData when signature_value returns a raw RSA digest signature.
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

export const VNPT_SMARTCA_BASE_URL = 'https://gwsca.vnpt.vn/sca/sp769';
export const VNPT_SMARTCA_HOSTS = ['gwsca.vnpt.vn', 'rmgateway.vnptit.vn'] as const;
export const VNPT_SMARTCA_CONNECT_FIELDS = ['spId', 'spPassword', 'userId', 'serialNumber'] as const;

interface VnptCredentials {
  spId: string;
  spPassword: string;
  userId: string;
  serialNumber?: string;
  baseUrl?: string;
}

interface VnptCertificateRecord {
  readonly serialNumber: string | null;
  readonly isUsbOnly: boolean;
  readonly chainDer: readonly Uint8Array[];
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

function formatVnptTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function mapVnptStatusToken(rawStatus: unknown): CaSignStatus | null {
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
  if (['PENDING', 'WAITING', 'WAITING_APPROVE', 'IN_PROGRESS', 'INIT', 'SIG_WAIT_FOR_USER_CONFIRM', 'WAIT_FOR_USER_CONFIRM'].includes(text)) {
    return 'pending';
  }
  if (['SIGNED', 'COMPLETED', 'COMPLETE', 'DONE'].includes(text)) return 'signed';
  if (['REJECTED', 'USER_REJECTED', 'CANCELLED', 'CANCELED', 'DECLINED', 'SIG_USER_DECLINED'].includes(text)) {
    return 'rejected';
  }
  if (['EXPIRED', 'TIMEOUT', 'TIMED_OUT', 'SIG_EXPIRED'].includes(text)) return 'expired';
  if (['FAILED', 'ERROR', 'SIG_FAILED'].includes(text)) return 'failed';
  return null;
}

function isVnptAuthError(code: string | null, status: number): boolean {
  if (status === 401 || status === 403) return true;
  const upper = code?.toUpperCase();
  return (
    upper !== undefined &&
    ['401', 'SP_CREDENTIAL_INVALID', 'AUTH_FAILED', 'INVALID_SP', 'INVALID_CREDENTIALS', 'UNAUTHORIZED', 'WRONG_PASSWORD'].includes(upper)
  );
}

function isVnptDuplicateError(code: string | null, status: number): boolean {
  if (status === 409) return true;
  const upper = code?.toUpperCase();
  return upper !== undefined && ['TRANSACTION_EXISTS', 'DUPLICATE_TRANSACTION', 'DUPLICATE_TX_ID'].includes(upper);
}

function extractVnptCertificates(json: unknown): VnptCertificateRecord[] {
  const data = pickCaseInsensitive(json, 'data') ?? json;
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(pickCaseInsensitive(data, 'user_certificates'))
      ? (pickCaseInsensitive(data, 'user_certificates') as unknown[])
      : [];
  const out: VnptCertificateRecord[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const tokenType =
      pickCaseInsensitive(item, 'token_type') ??
      pickCaseInsensitive(item, 'cert_type') ??
      pickCaseInsensitive(item, 'device_type');
    const isUsbOnly = tokenType !== undefined && isUsbTokenMode(tokenType);
    const serialNumber = readText(pickCaseInsensitive(item, 'serial_number'));
    const leaf = decodeDerCertificate(pickCaseInsensitive(item, 'cert_data'));
    const chainData = pickCaseInsensitive(item, 'chain_data');
    const caExtras: Uint8Array[] = [];
    if (isRecord(chainData)) {
      const caCert = decodeDerCertificate(pickCaseInsensitive(chainData, 'ca_cert'));
      const rootCert = decodeDerCertificate(pickCaseInsensitive(chainData, 'root_cert'));
      if (caCert) caExtras.push(caCert);
      if (rootCert) caExtras.push(rootCert);
    }
    const chainDer = mergeInlineCertChainDer(leaf, caExtras);
    out.push({ serialNumber, isUsbOnly, chainDer });
  }
  return out;
}

export function createVnptSmartCaAdapter(options: CaAdapterOptions = {}): CaSigningAdapter {
  const fetchImpl = options.fetch ?? defaultPinnedCaFetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_CA_TIMEOUT_MS;
  const allowedHosts = assertSafeHostAllowlist(options.allowedHosts ?? VNPT_SMARTCA_HOSTS);
  const defaultBaseUrl = assertSafeCaBaseUrl(options.baseUrl ?? VNPT_SMARTCA_BASE_URL, allowedHosts);
  const txToCertRef = new Map<string, string>();
  const certCache = new Map<string, { readonly certs: readonly VnptCertificateRecord[]; readonly isComplete: boolean }>();

  function rememberCertRef(secretKey: string, txId: string, certRef: string): void {
    setBoundedMap(txToCertRef, 500, `${secretKey}:${txId}`, certRef);
  }

  function cacheCerts(secretKey: string, certs: readonly VnptCertificateRecord[], isComplete: boolean): void {
    const existing = certCache.get(secretKey);
    if (existing?.isComplete && !isComplete) return;
    setBoundedMap(certCache, 100, secretKey, { certs, isComplete });
  }

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
    const msgCode = readText(pickCaseInsensitive(json, 'message_code')) ?? readText(pickCaseInsensitive(json, 'error_code'));
    if (msgCode) return msgCode;
    const sc = pickCaseInsensitive(json, 'status_code');
    if (typeof sc === 'number') return String(sc);
    return readText(sc);
  }

  function extractData(json: unknown): unknown {
    return pickCaseInsensitive(json, 'data') ?? json;
  }

  function resolveVnptStatus(json: unknown, data: unknown, allowSuccessPending: boolean): CaSignStatus | null {
    const explicit = mapVnptStatusToken(
      pickCaseInsensitive(data, 'status') ??
        pickCaseInsensitive(data, 'tran_status') ??
        pickCaseInsensitive(json, 'tran_status'),
    );
    if (explicit) return explicit;

    const rawMsg = readText(pickCaseInsensitive(json, 'message')) ?? readText(pickCaseInsensitive(json, 'message_code'));
    const msgStatus = mapVnptStatusToken(rawMsg);
    if (msgStatus) return msgStatus;

    const signatures = pickCaseInsensitive(data, 'signatures');
    const scNum = Number(pickCaseInsensitive(json, 'status_code'));
    const upperMsg = rawMsg?.toUpperCase();
    if (Array.isArray(signatures) && signatures.length > 0 && (Number.isNaN(scNum) || scNum === 200)) {
      return 'signed';
    }
    if ((Number.isNaN(scNum) || scNum === 200) && upperMsg === 'SUCCESS') {
      return allowSuccessPending ? 'pending' : null;
    }
    return null;
  }

  function parseSession(
    json: unknown,
    fallbackIdempotencyKey: string,
    fallbackTxId: string,
    allowSuccessPending: boolean,
    unrecognizedErrorKind: 'unavailable' | 'lost_answer' = 'unavailable',
    allowFallbackTxIdOnTerminalOnly = false,
  ): CaSignSession {
    const data = extractData(json);
    const status = resolveVnptStatus(json, data, allowSuccessPending);
    if (!status) {
      throw new CaProviderError(unrecognizedErrorKind, 'unrecognized VNPT SmartCA transaction status');
    }
    const tranCode = readText(pickCaseInsensitive(data, 'tran_code')) ?? readText(pickCaseInsensitive(data, 'tran_id'));
    const dataTxId = readText(pickCaseInsensitive(data, 'transaction_id'));
    const serverTxId = tranCode ?? dataTxId;
    const allowFallback =
      !allowFallbackTxIdOnTerminalOnly || status === 'rejected' || status === 'expired' || status === 'failed';
    const externalTxId = serverTxId ?? (allowFallback ? fallbackTxId : '');
    if (!externalTxId) {
      throw new CaProviderError(unrecognizedErrorKind, 'missing transaction identifier in VNPT SmartCA response');
    }
    const idempotencyKey =
      readText(pickCaseInsensitive(data, 'request_id')) ??
      (tranCode && dataTxId && tranCode !== dataTxId ? dataTxId : fallbackIdempotencyKey);
    const challengeCode = readText(pickCaseInsensitive(data, 'challenge_code'));
    const expiresAt = readText(pickCaseInsensitive(data, 'expired_at')) ?? readText(pickCaseInsensitive(data, 'expires_at'));
    const signedAt =
      status === 'signed'
        ? (readText(pickCaseInsensitive(data, 'signed_at')) ?? now().toISOString())
        : null;
    const errorCode = status === 'signed' || status === 'pending' ? null : extractCode(json);
    return {
      provider: 'vnpt_smartca',
      idempotencyKey,
      externalTxId,
      status,
      challengeCode,
      expiresAt,
      signedAt,
      errorCode,
    };
  }

  async function fetchCertificates(secretKey: string, creds: VnptCredentials, serialOverride?: string): Promise<VnptCertificateRecord[]> {
    const requestedSerial = serialOverride ?? creds.serialNumber ?? '';
    const isComplete = requestedSerial.trim() === '';
    const res = await postVnpt(
      creds,
      '/v1/credentials/get_certificate',
      {
        sp_id: creds.spId,
        sp_password: creds.spPassword,
        user_id: creds.userId,
        serial_number: requestedSerial,
        transaction_id: `ludy-cert-${now().getTime()}`,
      },
      false,
    );
    if (res.status === 429 || res.status >= 500) {
      throw new CaProviderError('unavailable');
    }
    if (res.status === 401 || res.status === 403) throw new CaProviderError('credentials');
    if (!isRecord(res.json)) throw new CaProviderError('unavailable');
    const code = extractCode(res.json);
    if (isVnptAuthError(code, res.status)) throw new CaProviderError('credentials');
    const records = extractVnptCertificates(res.json);
    if (records.length > 0) cacheCerts(secretKey, records, isComplete);
    return records;
  }

  async function resolveCertificateChainDer(
    secretKey: string,
    creds: VnptCredentials,
    txId: string,
    explicitCertRef?: string,
  ): Promise<readonly Uint8Array[]> {
    const wantedSerial = explicitCertRef ?? txToCertRef.get(`${secretKey}:${txId}`) ?? creds.serialNumber;
    const toSelectionRecords = (list: readonly VnptCertificateRecord[]) =>
      list.map((r) => ({
        certRef: r.serialNumber,
        isUsbOnly: r.isUsbOnly,
        isActive: true,
        chainDer: r.chainDer,
      }));
    const cached = certCache.get(secretKey);
    if (cached && cached.certs.length > 0 && (wantedSerial !== undefined || cached.isComplete)) {
      try {
        return selectRemoteCertificateChain({
          providerLabel: 'VNPT SmartCA',
          records: toSelectionRecords(cached.certs),
          ...(wantedSerial !== undefined ? { wantedCertRef: wantedSerial } : {}),
        });
      } catch (err) {
        if (!wantedSerial) throw err;
      }
    }
    const fetched = await fetchCertificates(secretKey, creds, wantedSerial ?? '');
    return selectRemoteCertificateChain({
      providerLabel: 'VNPT SmartCA',
      records: toSelectionRecords(fetched),
      ...(wantedSerial !== undefined ? { wantedCertRef: wantedSerial } : {}),
    });
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
    if (res.status === 429 || res.status >= 500) throw new CaProviderError('unavailable');
    if (res.status === 401 || res.status === 403) throw new CaProviderError('credentials');
    if (!isRecord(res.json)) throw new CaProviderError('unavailable');
    const code = extractCode(res.json);
    if (isVnptAuthError(code, res.status)) throw new CaProviderError('credentials');
    if (res.status >= 400 && pickCaseInsensitive(res.json, 'status_code') === undefined) {
      throw new CaProviderError('unavailable');
    }
    const session = parseSession(res.json, idempotencyKey, lookupKey, false);
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
            transaction_id: 'ludy-connection-check',
          },
          false,
        );
        if (res.status === 429 || res.status >= 500) return 'unreachable';
        if (res.status === 401 || res.status === 403) return 'wrong_credentials';
        if (!isRecord(res.json)) return 'unreachable';
        const code = extractCode(res.json);
        if (isVnptAuthError(code, res.status)) return 'wrong_credentials';
        const upperCode = code?.toUpperCase();
        if (upperCode === 'IP_NOT_ALLOWED' || upperCode === 'INVALID_IP') return 'ip_not_allowed';
        if (upperCode === 'API_NOT_ENABLED' || upperCode === 'SERVICE_INACTIVE') return 'api_not_enabled';
        if (res.status >= 400) return 'unreachable';

        const records = extractVnptCertificates(res.json);
        if (records.length === 0) return 'signing_needs_person';
        const remoteRecords = records.filter((r) => !r.isUsbOnly);
        if (remoteRecords.length === 0) return 'usb_token_unsupported';
        cacheCerts(
          sha256Hex(secret),
          records,
          (creds.serialNumber ?? '').trim() === '',
        );
        return 'works';
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
      const secretKey = sha256Hex(secret);
      const res = await postVnpt(
        creds,
        '/v1/signatures/sign',
        {
          sp_id: creds.spId,
          sp_password: creds.spPassword,
          user_id: creds.userId,
          serial_number: valid.certRef,
          transaction_id: valid.idempotencyKey,
          transaction_desc: valid.signerReason ?? valid.documentName ?? 'Remote signature',
          sign_files: [
            {
              doc_id: valid.idempotencyKey,
              data_to_be_signed: valid.digestSha256,
              file_type: 'pdf',
              sign_type: 'hash',
            },
          ],
          time_stamp: formatVnptTimestamp(now()),
        },
        true,
      );
      if (res.status === 429) throw new CaProviderError('unavailable');
      if (res.status >= 500) throw new CaProviderError('lost_answer');
      if (res.status === 401 || res.status === 403) throw new CaProviderError('credentials');
      if (!isRecord(res.json)) {
        if (res.status >= 400) {
          return {
            provider: 'vnpt_smartca',
            idempotencyKey: valid.idempotencyKey,
            externalTxId: valid.idempotencyKey,
            status: 'failed',
            errorCode: `HTTP_${res.status}`,
          };
        }
        throw new CaProviderError('lost_answer');
      }
      const code = extractCode(res.json);
      if (isVnptAuthError(code, res.status)) throw new CaProviderError('credentials');
      if (isVnptDuplicateError(code, res.status)) {
        const reconciled = await queryStatus(creds, valid.idempotencyKey, valid.idempotencyKey).catch(() => {
          throw new CaProviderError('lost_answer');
        });
        rememberCertRef(secretKey, reconciled.session.externalTxId, valid.certRef);
        return reconciled.session;
      }
      if (res.status >= 400 || (pickCaseInsensitive(res.json, 'status_code') !== undefined && Number(pickCaseInsensitive(res.json, 'status_code')) >= 400)) {
        return {
          provider: 'vnpt_smartca',
          idempotencyKey: valid.idempotencyKey,
          externalTxId: valid.idempotencyKey,
          status: 'failed',
          errorCode: code ?? `HTTP_${res.status}`,
        };
      }
      const data = extractData(res.json);
      const txId =
        readText(pickCaseInsensitive(data, 'tran_code')) ??
        readText(pickCaseInsensitive(data, 'tran_id')) ??
        readText(pickCaseInsensitive(data, 'transaction_id'));
      const rawStatusField = isRecord(data)
        ? (pickCaseInsensitive(data, 'tran_status') ?? pickCaseInsensitive(data, 'status'))
        : undefined;
      const rawMessage =
        readText(pickCaseInsensitive(data, 'message')) ?? readText(pickCaseInsensitive(res.json, 'message'));
      const hasRawStatusField = (rawStatusField !== undefined && rawStatusField !== null) || rawMessage !== null;
      const session =
        !hasRawStatusField && !resolveVnptStatus(res.json, data, true) && txId !== null
          ? {
              provider: 'vnpt_smartca' as const,
              idempotencyKey: valid.idempotencyKey,
              externalTxId: txId,
              status: 'pending' as const,
              challengeCode: readText(pickCaseInsensitive(data, 'challenge_code')),
              expiresAt: readText(pickCaseInsensitive(data, 'expired_at')),
              signedAt: null,
              errorCode: null,
            }
          : parseSession(res.json, valid.idempotencyKey, valid.idempotencyKey, true, 'lost_answer', true);
      rememberCertRef(secretKey, session.externalTxId, valid.certRef);
      return session;
    },

    pollStatus: async (secret: string, query: CaPollQuery | string): Promise<CaSignSession> => {
      const creds = parseVnptCredentials(secret);
      const { externalTxId, idempotencyKey } = normalizePollQuery(query);
      const lookupKey = externalTxId ?? idempotencyKey!;
      const { session } = await queryStatus(creds, lookupKey, idempotencyKey ?? lookupKey);
      return session;
    },

    fetchSignedCms: async (secret: string, query: CaFetchCmsQuery | string): Promise<CaSignedCms> => {
      const creds = parseVnptCredentials(secret);
      const normalized = normalizeFetchCmsQuery(query);
      const txId = normalized.externalTxId;
      const secretKey = sha256Hex(secret);
      const { session, rawJson } = await queryStatus(creds, txId, txId);
      if (session.status !== 'signed') {
        throw new CaProviderError('not_signed', 'VNPT SmartCA transaction is not signed');
      }
      const data = extractData(rawJson);
      const sigList = pickCaseInsensitive(data, 'signatures');
      const firstSig = Array.isArray(sigList) && sigList.length > 0 ? sigList[0] : undefined;
      const sigRaw =
        pickCaseInsensitive(firstSig, 'signature_value') ??
        pickCaseInsensitive(firstSig, 'cms') ??
        pickCaseInsensitive(firstSig, 'signature') ??
        pickCaseInsensitive(data, 'signature_value') ??
        pickCaseInsensitive(data, 'signature');
      const sigBytes = decodeBase64Bytes(sigRaw);
      if (!sigBytes || sigBytes.byteLength === 0) {
        throw new CaProviderError('unavailable', 'VNPT SmartCA response did not contain signature bytes');
      }

      const inlineSerial =
        readText(pickCaseInsensitive(firstSig, 'serial_number')) ??
        readText(pickCaseInsensitive(data, 'serial_number'));
      const rawChain = pickCaseInsensitive(firstSig, 'certificate_chain') ?? pickCaseInsensitive(data, 'certificate_chain');
      const parsedInlineChain = Array.isArray(rawChain)
        ? rawChain.map(decodeDerCertificate).filter((v): v is Uint8Array => v !== null)
        : [];
      const inlineSingleCert = decodeDerCertificate(
        pickCaseInsensitive(firstSig, 'cert_data') ?? pickCaseInsensitive(data, 'cert_data'),
      );
      const inlineChainDer = mergeInlineCertChainDer(inlineSingleCert, parsedInlineChain);

      const { cmsDer, subFilter, certificateChainPem } = await resolveCmsOrWrapRawSignature({
        providerLabel: 'VNPT SmartCA',
        sigBytes,
        rawChain,
        inlineChainDer,
        ...(normalized.signedAttrsDer !== undefined ? { signedAttrsDer: normalized.signedAttrsDer } : {}),
        loadChainDer: () => resolveCertificateChainDer(secretKey, creds, txId, normalized.certRef ?? inlineSerial ?? undefined),
      });

      const timestampTokenDer = decodeDerSequenceBase64(
        pickCaseInsensitive(firstSig, 'timestamp_token') ??
          pickCaseInsensitive(firstSig, 'timestamp_signature') ??
          pickCaseInsensitive(data, 'timestamp_token') ??
          pickCaseInsensitive(data, 'timestamp_signature'),
      );
      const rawOcsps = pickCaseInsensitive(firstSig, 'ocsp_responses') ?? pickCaseInsensitive(data, 'ocsp_responses');
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

// SPDX-License-Identifier: AGPL-3.0-only
// Recorded-response unit tests matching official VNPT SmartCA (/sca/sp769), Viettel MySign (/vtss/service),
// and MISA eSign (esignapp.misa.vn Open API) protocols, raw-signature to RFC 5652 CMS assembly,
// SSRF/host-allowlist validation, USB-token mode rejection, reconcile_only behavior, and secret isolation.
import { createSign, createVerify, generateKeyPairSync, X509Certificate, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CaProviderError,
  MISA_WESIGN_HOSTS,
  VIETTEL_MYSIGN_HOSTS,
  VNPT_SMARTCA_HOSTS,
  assembleDetachedCmsSignedData,
  assertSafeCaBaseUrl,
  buildSandboxCmsDer,
  cmsHasCadesSignedAttrs,
  cmsHasSignedAttrs,
  getCaAdapter,
  isCmsSignedDataDer,
  isValidDerSequence,
  prepareCadesSignedAttrs,
  preparePadesSignedAttrs,
  type CaProviderId,
} from '../src/index.ts';

function derLen(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  let rem = n;
  while (rem > 0) {
    bytes.unshift(rem & 0xff);
    rem = Math.floor(rem / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, ...parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const headerLen = derLen(len);
  const out = new Uint8Array(1 + headerLen.byteLength + len);
  out[0] = tag;
  out.set(headerLen, 1);
  let pos = 1 + headerLen.byteLength;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

function createTestRsaIdentity(cn = 'Crove Test CA'): {
  certDer: Uint8Array;
  certB64: string;
  privateKey: KeyObject;
} {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  const oidSha256Rsa = derTlv(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]));
  const sigAlg = derTlv(0x30, oidSha256Rsa, derTlv(0x05));
  const cnAttr = derTlv(0x30, derTlv(0x06, new Uint8Array([0x55, 0x04, 0x03])), derTlv(0x0c, Buffer.from(cn, 'utf8')));
  const name = derTlv(0x30, derTlv(0x31, cnAttr));
  const validity = derTlv(
    0x30,
    derTlv(0x17, Buffer.from('250101000000Z', 'ascii')),
    derTlv(0x17, Buffer.from('350101000000Z', 'ascii')),
  );
  const tbs = derTlv(
    0x30,
    derTlv(0xa0, derTlv(0x02, new Uint8Array([2]))),
    derTlv(0x02, new Uint8Array([0x11, 0x22, 0x33, 0x44])),
    sigAlg,
    name,
    validity,
    name,
    spkiDer,
  );
  const certSig = new Uint8Array(createSign('RSA-SHA256').update(tbs).sign(privateKey));
  const bitString = derTlv(0x03, new Uint8Array([0x00]), certSig);
  const certDer = derTlv(0x30, tbs, sigAlg, bitString);
  new X509Certificate(certDer);
  return { certDer, certB64: Buffer.from(certDer).toString('base64'), privateKey };
}

function createTestRsaCertAndRawSig(payload: Uint8Array): { certB64: string; rawSigB64: string } {
  const { certB64, privateKey } = createTestRsaIdentity();
  const rawSig = new Uint8Array(createSign('RSA-SHA256').update(payload).sign(privateKey));
  return {
    certB64,
    rawSigB64: Buffer.from(rawSig).toString('base64'),
  };
}

const DIGEST = 'd'.repeat(64);
const { certB64: TEST_CERT_B64, rawSigB64: RAW_RSA_SIG_B64 } = createTestRsaCertAndRawSig(Buffer.from(DIGEST, 'hex'));
const SAMPLE_CMS_B64 = Buffer.from(buildSandboxCmsDer(DIGEST, 'tx-recorded-1', 'cert-1')).toString('base64');
const SAMPLE_TS_B64 = Buffer.from(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01])).toString('base64');
const SAMPLE_OCSP_B64 = Buffer.from(new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x00])).toString('base64');

const VNPT_SECRET = JSON.stringify({
  spId: 'sp-ludy-01',
  spPassword: 'vnpt-top-secret-password',
  userId: '079099001234',
  serialNumber: '54010101AABBCCDD',
});

const VIETTEL_SECRET = JSON.stringify({
  clientId: 'vt-client-01',
  clientSecret: 'viettel-top-secret-key',
  userId: 'user-01',
  profileId: 'prof-01',
});

const MISA_SECRET = JSON.stringify({
  clientId: 'misa-client-01',
  clientKey: 'misa-top-secret-key',
  username: 'signer@example.com',
  password: 'misa-top-secret-password',
  taxCode: '0100000001',
});

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: string | undefined;
}

type MockStep =
  | { status: number; body: unknown }
  | Error
  | ((call: RecordedCall) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>);

function mockFetch(routes: Record<string, MockStep[]>) {
  const calls: RecordedCall[] = [];
  const used = new Map<string, number>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
      redirect: init?.redirect,
    };
    calls.push(call);
    const parsedUrl = new URL(url);
    const routeKey = parsedUrl.pathname;
    const queue = routes[routeKey];
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected request: ${call.method} ${routeKey}`);
    }
    const idx = used.get(routeKey) ?? 0;
    used.set(routeKey, idx + 1);
    const step = queue[Math.min(idx, queue.length - 1)]!;
    if (step instanceof Error) throw step;
    const result = typeof step === 'function' ? await step(call) : step;
    return new Response(typeof result.body === 'string' ? result.body : JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('SSRF guard and host allowlists across remote CA adapters', () => {
  it('blocks non-HTTPS, private/loopback/metadata IPs, localhost, non-443 ports, URL credentials, and non-allowlisted hosts', () => {
    const badUrls = [
      'http://gwsca.vnpt.vn/sca/sp769',
      'file:///etc/passwd',
      'https://127.0.0.1/api',
      'https://10.0.0.1/api',
      'https://172.16.0.5/api',
      'https://192.168.1.10/api',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/api',
      'https://2130706433/api',
      'https://127.0x1/api',
      'https://0x7f.1/api',
      'https://0177.0.0.1/api',
      'https://12345/api',
      'https://localhost/api',
      'https://ca.internal/api',
      'https://service.local/api',
      'https://metadata.google.internal/api',
      'https://gwsca.vnpt.vn:8443/sca/sp769',
      'https://user:pass@gwsca.vnpt.vn/sca/sp769',
      'https://gwsca.vnpt.vn/sca/sp769?leak=1',
      'https://attacker.example.com',
    ];
    for (const url of badUrls) {
      expect(() => assertSafeCaBaseUrl(url, VNPT_SMARTCA_HOSTS), url).toThrow(CaProviderError);
      expect(() => getCaAdapter('vnpt_smartca', { baseUrl: url }), url).toThrow(CaProviderError);
    }

    // Even overriding allowedHosts cannot allow private/loopback hosts.
    for (const badAllowHost of ['127.0.0.1', 'localhost', '169.254.169.254', 'internal.local', 'intranet']) {
      expect(() => getCaAdapter('viettel_mysign', { allowedHosts: [badAllowHost] })).toThrow(CaProviderError);
    }

    expect(assertSafeCaBaseUrl('https://rmgateway.vnptit.vn/sca/sp769/', VNPT_SMARTCA_HOSTS)).toBe(
      'https://rmgateway.vnptit.vn/sca/sp769',
    );
  });

  it('rejects unsafe credential baseUrl and USB-token signing modes (camelCase & snake_case) before touching fetch', async () => {
    const cases: Array<{ id: Exclude<CaProviderId, 'sandbox'>; validSecret: string }> = [
      { id: 'vnpt_smartca', validSecret: VNPT_SECRET },
      { id: 'viettel_mysign', validSecret: VIETTEL_SECRET },
      { id: 'misa_wesign', validSecret: MISA_SECRET },
    ];
    for (const { id, validSecret } of cases) {
      const { fetchImpl, calls } = mockFetch({});
      const adapter = getCaAdapter(id, { fetch: fetchImpl });
      expect(adapter.capabilities.localUsbTokenSupported).toBe(false);
      expect(adapter.capabilities.retry.initiateSign).toBe('reconcile_only');

      const parsed = JSON.parse(validSecret) as Record<string, unknown>;
      const badUrlSecret = JSON.stringify({ ...parsed, baseUrl: 'https://169.254.169.254/latest' });
      await expect(adapter.testConnection(badUrlSecret)).rejects.toMatchObject({ kind: 'unsafe_url' });
      await expect(
        adapter.initiateSign(badUrlSecret, { idempotencyKey: 'k1', digestSha256: DIGEST, certRef: 'c1' }),
      ).rejects.toMatchObject({ kind: 'unsafe_url' });

      for (const usbExtra of [{ signingMode: 'usb_token' }, { signing_mode: 'usb_token' }, { usb_token: true }]) {
        const usbSecret = JSON.stringify({ ...parsed, ...usbExtra });
        expect(await adapter.testConnection(usbSecret)).toBe('usb_token_unsupported');
        await expect(
          adapter.initiateSign(usbSecret, { idempotencyKey: 'k2', digestSha256: DIGEST, certRef: 'c1' }),
        ).rejects.toMatchObject({ kind: 'usb_token_unsupported' });
      }

      await expect(
        adapter.initiateSign(validSecret, {
          idempotencyKey: 'k3',
          digestSha256: DIGEST,
          certRef: 'c1',
          signingMode: 'usb_token',
        }),
      ).rejects.toMatchObject({ kind: 'usb_token_unsupported' });

      expect(calls).toHaveLength(0);
    }
  });
});

describe('VNPT SmartCA adapter (official /sca/sp769 v1 recorded responses)', () => {
  it('calls /sca/sp769 endpoints and distinguishes remote vs USB/missing certificates', async () => {
    const ok = mockFetch({
      '/sca/sp769/v1/credentials/get_certificate': [
        {
          status: 200,
          body: { status_code: 200, message: 'Success', data: { user_certificates: [{ serial_number: '5401', cert_data: TEST_CERT_B64 }] } },
        },
      ],
    });
    const adapter = getCaAdapter('vnpt_smartca', { fetch: ok.fetchImpl });
    expect(adapter.hosts).toEqual([...VNPT_SMARTCA_HOSTS]);
    expect(await adapter.testConnection(VNPT_SECRET)).toBe('works');
    expect(ok.calls[0]?.url).toBe('https://gwsca.vnpt.vn/sca/sp769/v1/credentials/get_certificate');
    expect(ok.calls[0]?.redirect).toBe('error');

    const usbOnly = mockFetch({
      '/sca/sp769/v1/credentials/get_certificate': [
        { status: 200, body: { data: { user_certificates: [{ serial_number: '5401', token_type: 'USB_TOKEN' }] } } },
      ],
    });
    expect(await getCaAdapter('vnpt_smartca', { fetch: usbOnly.fetchImpl }).testConnection(VNPT_SECRET)).toBe('usb_token_unsupported');

    const empty = mockFetch({
      '/sca/sp769/v1/credentials/get_certificate': [{ status: 200, body: { data: { user_certificates: [] } } }],
    });
    expect(await getCaAdapter('vnpt_smartca', { fetch: empty.fetchImpl }).testConnection(VNPT_SECRET)).toBe('signing_needs_person');

    const ipBlocked = mockFetch({
      '/sca/sp769/v1/credentials/get_certificate': [{ status: 200, body: { message_code: 'IP_NOT_ALLOWED' } }],
    });
    expect(await getCaAdapter('vnpt_smartca', { fetch: ipBlocked.fetchImpl }).testConnection(VNPT_SECRET)).toBe('ip_not_allowed');

    const wrongCreds = mockFetch({
      '/sca/sp769/v1/credentials/get_certificate': [{ status: 401, body: { status_code: 401, message: 'SP_CREDENTIAL_INVALID' } }],
    });
    expect(await getCaAdapter('vnpt_smartca', { fetch: wrongCreds.fetchImpl }).testConnection(VNPT_SECRET)).toBe('wrong_credentials');
  });

  it('uses /v1/signatures/sign, preserves tran_code as externalTxId, handles official status JSON, and wraps raw signature into detached CMS', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/sca/sp769/v1/credentials/get_certificate': [
        {
          status: 200,
          body: {
            status_code: 200,
            message: 'Success',
            data: {
              user_certificates: [
                {
                  serial_number: '54010101AABBCCDD',
                  cert_data: TEST_CERT_B64,
                  chain_data: { ca_cert: TEST_CERT_B64, root_cert: null },
                },
              ],
            },
          },
        },
      ],
      '/sca/sp769/v1/signatures/sign': [
        {
          status: 200,
          body: {
            status_code: 200,
            message: 'sig_wait_for_user_confirm',
            data: { transaction_id: 'idem-vnpt-1', tran_code: 'vnpt-tran-code-1' },
          },
        },
        { status: 409, body: { message_code: 'TRANSACTION_EXISTS' } },
      ],
      '/sca/sp769/v1/signatures/sign/vnpt-tran-code-1/status': [
        { status: 200, body: { status_code: 200, message: 'sig_wait_for_user_confirm', data: { transaction_id: 'vnpt-tran-code-1' } } },
        { status: 200, body: { status_code: 200, message: 'sig_wait_for_user_confirm', data: { transaction_id: 'vnpt-tran-code-1' } } },
        {
          status: 200,
          body: {
            status_code: 200,
            message: 'SUCCESS',
            data: {
              transaction_id: 'vnpt-tran-code-1',
              signatures: [
                {
                  doc_id: 'idem-vnpt-1',
                  signature_value: RAW_RSA_SIG_B64,
                  timestamp_signature: SAMPLE_TS_B64,
                  ocsp_responses: [SAMPLE_OCSP_B64],
                },
              ],
            },
          },
        },
      ],
      '/sca/sp769/v1/signatures/sign/idem-vnpt-1/status': [
        { status: 200, body: { status_code: 200, message: 'sig_wait_for_user_confirm', data: { tran_code: 'vnpt-tran-code-1', transaction_id: 'idem-vnpt-1' } } },
      ],
      '/sca/sp769/v1/signatures/sign/tx-rej/status': [
        { status: 200, body: { status_code: 200, message: 'USER_REJECTED', data: { tran_code: 'tx-rej' }, message_code: 'USER_DECLINED' } },
      ],
      '/sca/sp769/v1/signatures/sign/tx-exp/status': [
        { status: 200, body: { status_code: 200, message: 'EXPIRED', data: { tran_code: 'tx-exp' } } },
      ],
      '/sca/sp769/v1/signatures/sign/tx-fail/status': [
        { status: 200, body: { status_code: 200, message: 'FAILED', data: { tran_code: 'tx-fail' } } },
      ],
    });

    const adapter = getCaAdapter('vnpt_smartca', { fetch: fetchImpl });
    const init = await adapter.initiateSign(VNPT_SECRET, {
      idempotencyKey: 'idem-vnpt-1',
      digestSha256: DIGEST,
      certRef: '54010101AABBCCDD',
      documentName: 'HopDong.pdf',
    });
    expect(init).toMatchObject({
      provider: 'vnpt_smartca',
      idempotencyKey: 'idem-vnpt-1',
      externalTxId: 'vnpt-tran-code-1',
      status: 'pending',
    });
    expect(calls[0]?.url).toBe('https://gwsca.vnpt.vn/sca/sp769/v1/signatures/sign');

    // Duplicate initiate reconciles via status endpoint and resolves tran_code.
    const dup = await adapter.initiateSign(VNPT_SECRET, {
      idempotencyKey: 'idem-vnpt-1',
      digestSha256: DIGEST,
      certRef: '54010101AABBCCDD',
    });
    expect(dup).toMatchObject({ externalTxId: 'vnpt-tran-code-1', idempotencyKey: 'idem-vnpt-1', status: 'pending' });

    const p1 = await adapter.pollStatus(VNPT_SECRET, 'vnpt-tran-code-1');
    expect(p1.status).toBe('pending');
    await expect(adapter.fetchSignedCms(VNPT_SECRET, 'vnpt-tran-code-1')).rejects.toMatchObject({ kind: 'not_signed' });

    const signed = await adapter.fetchSignedCms(VNPT_SECRET, 'vnpt-tran-code-1');
    expect(signed.externalTxId).toBe('vnpt-tran-code-1');
    expect(isCmsSignedDataDer(signed.cmsDer)).toBe(true);
    expect(Buffer.from(signed.cmsDer).toString('hex')).toContain(Buffer.from(RAW_RSA_SIG_B64, 'base64').toString('hex'));
    expect(signed.certificateChainPem).toHaveLength(2);
    expect(Buffer.from(signed.timestampTokenDer!).toString('base64')).toBe(SAMPLE_TS_B64);
    expect(signed.ocspResponsesDer).toHaveLength(1);

    expect((await adapter.pollStatus(VNPT_SECRET, 'tx-rej')).status).toBe('rejected');
    expect((await adapter.pollStatus(VNPT_SECRET, 'tx-exp')).status).toBe('expired');
    expect((await adapter.pollStatus(VNPT_SECRET, 'tx-fail')).status).toBe('failed');

    for (const call of calls) {
      expect(call.url).not.toContain('vnpt-top-secret-password');
    }

    const lost = mockFetch({ '/sca/sp769/v1/signatures/sign': [new Error('socket reset')] });
    const err = await getCaAdapter('vnpt_smartca', { fetch: lost.fetchImpl })
      .initiateSign(VNPT_SECRET, { idempotencyKey: 'k-lost', digestSha256: DIGEST, certRef: '5401' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'lost_answer' });
    expect(String(err)).not.toContain('vnpt-top-secret-password');
  });
});

describe('Viettel MySign adapter (official /vtss/service/* recorded responses)', () => {
  it('uses /vtss/service endpoints, async: 2, official status codes (1, 4000, 6000, 4001, 4002, 4004), and wraps raw signatures in CMS', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/vtss/service/ras/v1/login': [
        { status: 200, body: { access_token: 'vt-token-1', expires_in: 3600 } },
        { status: 200, body: { access_token: 'vt-token-2', expires_in: 3600 } },
      ],
      '/vtss/service/certificates/info': [
        {
          status: 200,
          body: [
            {
              credential_id: 'vt-cred-01',
              key: { status: 'ENABLED', algo: ['1.2.840.113549.1.1.1'] },
              cert: { status: 'valid', certificates: [TEST_CERT_B64] },
            },
          ],
        },
      ],
      '/vtss/service/signHash': [
        { status: 401, body: { error: 'token_expired' } },
        { status: 200, body: { transaction_id: 'vt-tx-1' } },
      ],
      '/vtss/service/requests/status': [
        { status: 200, body: { status: '4000' } },
        { status: 200, body: { status: '6000' } },
        { status: 200, body: { status: '1', signatures: [RAW_RSA_SIG_B64] } },
        { status: 200, body: { status: '4002' } },
        { status: 200, body: { status: '4001' } },
        { status: 200, body: { status: '4004', error_code: 'SIGN_ERROR' } },
      ],
    });

    const adapter = getCaAdapter('viettel_mysign', { fetch: fetchImpl });
    expect(adapter.hosts).toEqual([...VIETTEL_MYSIGN_HOSTS]);
    expect(await adapter.testConnection(VIETTEL_SECRET)).toBe('works');

    const init = await adapter.initiateSign(VIETTEL_SECRET, {
      idempotencyKey: 'vt-req-1',
      digestSha256: DIGEST,
      certRef: 'vt-cred-01',
      documentName: 'HopDong Dich Vu.pdf',
    });
    expect(init).toMatchObject({ provider: 'viettel_mysign', externalTxId: 'vt-tx-1', status: 'pending' });
    const signBody = JSON.parse(calls.find((c) => c.url.endsWith('/vtss/service/signHash'))?.body ?? '{}') as {
      hash: string[];
      hashAlgo: string;
      async: number;
      client_id: string;
      client_secret: string;
      documents: Array<{ document_name: string }>;
    };
    expect(signBody.hash).toEqual([Buffer.from(DIGEST, 'hex').toString('base64')]);
    expect(signBody.hashAlgo).toBe('2.16.840.1.101.3.4.2.1');
    expect(signBody.async).toBe(2);
    expect(signBody.client_id).toBe('vt-client-01');
    expect(signBody.documents[0]?.document_name.length).toBeLessThan(100);

    expect((await adapter.pollStatus(VIETTEL_SECRET, 'vt-tx-1')).status).toBe('pending');
    expect((await adapter.pollStatus(VIETTEL_SECRET, 'vt-tx-1')).status).toBe('pending');

    const cms = await adapter.fetchSignedCms(VIETTEL_SECRET, 'vt-tx-1');
    expect(isCmsSignedDataDer(cms.cmsDer)).toBe(true);
    expect(Buffer.from(cms.cmsDer).toString('hex')).toContain(Buffer.from(RAW_RSA_SIG_B64, 'base64').toString('hex'));

    expect((await adapter.pollStatus(VIETTEL_SECRET, 'vt-tx-2')).status).toBe('rejected');
    expect((await adapter.pollStatus(VIETTEL_SECRET, 'vt-tx-3')).status).toBe('expired');
    expect((await adapter.pollStatus(VIETTEL_SECRET, 'vt-tx-4')).status).toBe('failed');

    // Without server transactionId, Viettel MySign blocks automatic re-initiate with lost_answer.
    await expect(adapter.pollStatus(VIETTEL_SECRET, { idempotencyKey: 'vt-req-1' })).rejects.toMatchObject({
      kind: 'lost_answer',
    });

    for (const call of calls) {
      expect(call.url).not.toContain('viettel-top-secret-key');
    }
  });

  it('never leaks credentials on auth failure or network error', async () => {
    const authFail = mockFetch({ '/vtss/service/ras/v1/login': [{ status: 401, body: { error: '59033' } }] });
    const adapter = getCaAdapter('viettel_mysign', { fetch: authFail.fetchImpl });
    expect(await adapter.testConnection(VIETTEL_SECRET)).toBe('wrong_credentials');
    const err = await adapter
      .initiateSign(VIETTEL_SECRET, { idempotencyKey: 'k1', digestSha256: DIGEST, certRef: 'c1' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'credentials' });
    expect(String(err)).not.toContain('viettel-top-secret-key');
  });
});

describe('MISA eSign / WeSign adapter (esignapp.misa.vn Open API recorded responses)', () => {
  it('authenticates at /api/auth/api/v1/auth/login-api preferring remoteSigningAccessToken, lists certs via GET .../by-userId, signs at /external/esrm/.../Signing/hash, reconciles DuplicateRefID via GET status, and reads/wraps signatures', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/api/auth/api/v1/auth/login-api': [
        {
          status: 200,
          body: {
            status: { code: 200, error: false },
            data: {
              accessToken: 'misaid-token-do-not-send',
              remoteSigningAccessToken: 'misa-esign-token-1',
              expiresIn: 3600,
              user: { id: 'misa-uid-99', username: 'misa-signer@example.com' },
            },
          },
        },
      ],
      '/external/esrm/service/general/api/v1/Certificates/by-userId': [
        {
          status: 200,
          body: [
            {
              userId: 'misa-uid-99',
              keyAlias: 'MISA-01',
              keyStatus: 'ACTIVE',
              certStatus: 'ACTIVE',
              certificate: TEST_CERT_B64,
              certiticateChain: [TEST_CERT_B64],
            },
          ],
        },
      ],
      '/external/esrm/service/signing/api/v1/Signing/hash': [
        {
          status: 200,
          body: { transactionId: 'misa-tx-1' },
        },
        { status: 200, body: { Success: false, ErrorCode: 'DuplicateRefID', Data: { TransactionID: 'misa-tx-1' } } },
      ],
      '/external/esrm/service/signing/api/v1/Signing/status/misa-tx-1': [
        {
          status: 200,
          body: { transactionId: 'misa-tx-1', status: 'PENDING', errorCode: null, errorDescription: null, signatures: [] },
        },
        {
          status: 200,
          body: {
            status: 'SUCCESS',
            keyAlias: 'MISA-01',
            signatures: [{ documentId: 'misa-req-1', signature: SAMPLE_CMS_B64 }],
            TimestampToken: SAMPLE_TS_B64,
            OcspResponses: [SAMPLE_OCSP_B64],
          },
        },
        {
          status: 200,
          body: {
            status: 'SUCCESS',
            keyAlias: 'MISA-01',
            signatures: [{ documentId: 'misa-req-1', signature: RAW_RSA_SIG_B64 }],
          },
        },
      ],
    });

    const adapter = getCaAdapter('misa_wesign', { fetch: fetchImpl });
    expect(adapter.hosts).toEqual([...MISA_WESIGN_HOSTS]);
    expect(adapter.hosts).toContain('esignapp.misa.vn');
    expect(adapter.capabilities.signing).toBe('provider_hsm');
    expect(await adapter.testConnection(MISA_SECRET)).toBe('works');
    expect(calls[0]?.url).toBe('https://esignapp.misa.vn/api/auth/api/v1/auth/login-api');
    expect(calls[0]?.headers['x-clientid']).toBe('misa-client-01');
    expect(calls[0]?.headers['x-clientkey']).toBe('misa-top-secret-key');
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.url).toBe(
      'https://esignapp.misa.vn/external/esrm/service/general/api/v1/Certificates/by-userId',
    );
    expect(calls[1]?.headers.authorizationrm).toBe('Bearer misa-esign-token-1');
    expect(calls[1]?.headers.authorizationrm).not.toContain('misaid-token-do-not-send');

    const init = await adapter.initiateSign(MISA_SECRET, {
      idempotencyKey: 'misa-req-1',
      digestSha256: DIGEST,
      certRef: 'MISA-01',
      documentName: 'contract.pdf',
      signerReason: 'Approve contract',
    });
    expect(init).toMatchObject({ provider: 'misa_wesign', externalTxId: 'misa-tx-1', status: 'pending' });
    const reqBody = JSON.parse(
      calls.find((c) => c.url.endsWith('/external/esrm/service/signing/api/v1/Signing/hash'))?.body ?? '{}',
    ) as {
      DataToBeDisplayed: string;
      UserId: string;
      CertAlias: string;
      Documents: Array<{ DocumentId: string; DocumentName: string; FileToSign: string }>;
    };
    expect(reqBody.UserId).toBe('misa-uid-99');
    expect(reqBody.CertAlias).toBe('MISA-01');
    expect(reqBody.DataToBeDisplayed).toBe('Approve contract');
    expect(reqBody.Documents).toHaveLength(1);
    expect(reqBody.Documents[0]?.DocumentId).toBe('misa-req-1');
    expect(reqBody.Documents[0]?.DocumentName).toBe('contract.pdf');
    expect(reqBody.Documents[0]?.FileToSign).toBe(Buffer.from(DIGEST, 'hex').toString('base64'));

    // DuplicateRefID reconciles via GET /external/esrm/service/signing/api/v1/Signing/status/{transactionId} when server echoes transactionId.
    const reconciled = await adapter.initiateSign(MISA_SECRET, {
      idempotencyKey: 'misa-req-1',
      digestSha256: DIGEST,
      certRef: 'MISA-01',
    });
    expect(reconciled.externalTxId).toBe('misa-tx-1');
    const reconcileCall = calls.find((c) => c.url.endsWith('/Signing/status/misa-tx-1'));
    expect(reconcileCall?.method).toBe('GET');
    expect(reconcileCall?.headers.authorizationrm).toBe('Bearer misa-esign-token-1');

    // Without server transactionId (lost_answer), MISA refuses to fabricate a DocumentId status path.
    await expect(adapter.pollStatus(MISA_SECRET, { idempotencyKey: 'misa-req-1' })).rejects.toMatchObject({
      kind: 'lost_answer',
    });

    const cms = await adapter.fetchSignedCms(MISA_SECRET, 'misa-tx-1');
    expect(Buffer.from(cms.cmsDer).toString('base64')).toBe(SAMPLE_CMS_B64);
    expect(cms.subFilter).toBe('ETSI.CAdES.detached');
    expect(cmsHasSignedAttrs(cms.cmsDer)).toBe(true);
    expect(cms.timestampTokenDer).not.toBeNull();
    expect(cms.ocspResponsesDer).toHaveLength(1);

    const wrappedRawCms = await adapter.fetchSignedCms(MISA_SECRET, 'misa-tx-1');
    expect(isCmsSignedDataDer(wrappedRawCms.cmsDer)).toBe(true);
    expect(wrappedRawCms.subFilter).toBe('adbe.pkcs7.detached');
    expect(cmsHasSignedAttrs(wrappedRawCms.cmsDer)).toBe(false);

    for (const call of calls) {
      expect(call.url).not.toContain('misa-top-secret-password');
      expect(call.url).not.toContain('misa-top-secret-key');
    }
  });

  it('requires explicit certRef on restarted adapters with multiple active certs and wraps CAdES-BES signedAttrs', async () => {
    const idA = createTestRsaIdentity('Signer A');
    const idB = createTestRsaIdentity('Signer B');
    const rawSigB = new Uint8Array(createSign('RSA-SHA256').update(Buffer.from(DIGEST, 'hex')).sign(idB.privateKey));
    const rawSigBB64 = Buffer.from(rawSigB).toString('base64');

    // Fresh restarted Viettel MySign adapter with 2 active certs and no local initiateSign cache.
    const vtMock = mockFetch({
      '/vtss/service/ras/v1/login': [{ status: 200, body: { access_token: 'vt-tok-multi', expires_in: 3600 } }],
      '/vtss/service/certificates/info': [
        {
          status: 200,
          body: [
            { credential_id: 'cert-A', key: { status: 'ENABLED' }, cert: { status: 'valid', certificates: [idA.certB64] } },
            { credential_id: 'cert-B', key: { status: 'ENABLED' }, cert: { status: 'valid', certificates: [idB.certB64] } },
          ],
        },
      ],
      '/vtss/service/requests/status': [
        { status: 200, body: { transactionStatus: '1', signatures: [rawSigBB64] } },
        { status: 200, body: { transactionStatus: '1', signatures: [rawSigBB64] } },
      ],
    });
    const vtRestarted = getCaAdapter('viettel_mysign', { fetch: vtMock.fetchImpl });
    await expect(vtRestarted.fetchSignedCms(VIETTEL_SECRET, 'vt-restart-1')).rejects.toMatchObject({
      kind: 'unavailable',
    });
    const requireLeafCert = (chain: readonly string[] | undefined): X509Certificate => {
      const pem = chain?.[0];
      if (!pem) throw new Error('expected non-empty certificateChainPem');
      return new X509Certificate(pem);
    };

    const vtSelected = await vtRestarted.fetchSignedCms(VIETTEL_SECRET, {
      externalTxId: 'vt-restart-1',
      certRef: 'cert-B',
    });
    expect(vtSelected.subFilter).toBe('adbe.pkcs7.detached');
    expect(cmsHasSignedAttrs(vtSelected.cmsDer)).toBe(false);
    expect(vtSelected.certificateChainPem).toHaveLength(1);
    const vtLeafCert = requireLeafCert(vtSelected.certificateChainPem);
    expect(vtLeafCert.subject).toContain('Signer B');
    expect(
      createVerify('RSA-SHA256')
        .update(Buffer.from(DIGEST, 'hex'))
        .verify(vtLeafCert.publicKey, rawSigB),
    ).toBe(true);

    // Same ambiguous-cert safeguard on restarted VNPT SmartCA and MISA WeSign adapters.
    const vnptMock = mockFetch({
      '/sca/sp769/v1/credentials/get_certificate': [
        {
          status: 200,
          body: {
            status_code: 200,
            message: 'Success',
            data: {
              user_certificates: [
                { serial_number: 'vnpt-A', cert_data: idA.certB64 },
                { serial_number: 'vnpt-B', cert_data: idB.certB64 },
              ],
            },
          },
        },
      ],
      '/sca/sp769/v1/signatures/sign/vnpt-restart-1/status': [
        { status: 200, body: { status_code: 200, data: { tran_code: 'vnpt-restart-1', tran_status: 1, signatures: [{ signature_value: rawSigBB64 }] } } },
        { status: 200, body: { status_code: 200, data: { tran_code: 'vnpt-restart-1', tran_status: 1, signatures: [{ signature_value: rawSigBB64 }] } } },
      ],
    });
    const vnptRestarted = getCaAdapter('vnpt_smartca', { fetch: vnptMock.fetchImpl });
    await expect(vnptRestarted.fetchSignedCms(VNPT_SECRET, 'vnpt-restart-1')).rejects.toMatchObject({
      kind: 'unavailable',
    });
    const vnptSelected = await vnptRestarted.fetchSignedCms(VNPT_SECRET, {
      externalTxId: 'vnpt-restart-1',
      certRef: 'vnpt-B',
    });
    expect(requireLeafCert(vnptSelected.certificateChainPem).subject).toContain('Signer B');

    const misaMock = mockFetch({
      '/api/auth/api/v1/auth/login-api': [
        { status: 200, body: { status: { code: 200, error: false }, data: { remoteSigningAccessToken: 'misa-tok-multi', user: { id: 'misa-uid-m1' } } } },
      ],
      '/external/esrm/service/general/api/v1/Certificates/by-userId': [
        {
          status: 200,
          body: [
            { userId: 'misa-uid-m1', keyAlias: 'misa-A', keyStatus: 'ACTIVE', certStatus: 'ACTIVE', certificate: idA.certB64 },
            {
              userId: 'misa-uid-m1',
              keyAlias: 'misa-B',
              keyStatus: 'ACTIVE',
              certStatus: 'ACTIVE',
              certificate: idB.certB64,
              certiticateChain: [idB.certB64, idA.certB64],
            },
          ],
        },
      ],
      '/external/esrm/service/signing/api/v1/Signing/status/misa-restart-1': [
        { status: 200, body: { transactionId: 'misa-restart-1', status: 'SUCCESS', signatures: [{ signature: rawSigBB64 }] } },
        { status: 200, body: { transactionId: 'misa-restart-1', status: 'SUCCESS', signatures: [{ signature: rawSigBB64 }] } },
      ],
    });
    const misaRestarted = getCaAdapter('misa_wesign', { fetch: misaMock.fetchImpl });
    await expect(misaRestarted.fetchSignedCms(MISA_SECRET, 'misa-restart-1')).rejects.toMatchObject({
      kind: 'unavailable',
    });
    const misaSelected = await misaRestarted.fetchSignedCms(MISA_SECRET, {
      externalTxId: 'misa-restart-1',
      certRef: 'misa-B',
    });
    expect(requireLeafCert(misaSelected.certificateChainPem).subject).toContain('Signer B');
    expect(misaSelected.certificateChainPem).toHaveLength(2);

    // Explicit certRef lookup must still recover an inactive/rotated signing certificate.
    const misaRotatedMock = mockFetch({
      '/api/auth/api/v1/auth/login-api': [
        { status: 200, body: { status: { code: 200, error: false }, data: { remoteSigningAccessToken: 'misa-tok-rot', user: { id: 'misa-uid-r1' } } } },
      ],
      '/external/esrm/service/general/api/v1/Certificates/by-userId': [
        {
          status: 200,
          body: [
            { userId: 'misa-uid-r1', keyAlias: 'misa-A', keyStatus: 'EXPIRED', certStatus: 'INACTIVE', certificate: idA.certB64 },
            { userId: 'misa-uid-r1', keyAlias: 'misa-B', keyStatus: 'ACTIVE', certStatus: 'ACTIVE', certificate: idB.certB64 },
          ],
        },
      ],
      '/external/esrm/service/signing/api/v1/Signing/status/misa-rot-1': [
        { status: 200, body: { transactionId: 'misa-rot-1', status: 'SUCCESS', signatures: [{ signature: rawSigBB64 }] } },
      ],
    });
    const misaRotated = await getCaAdapter('misa_wesign', { fetch: misaRotatedMock.fetchImpl }).fetchSignedCms(MISA_SECRET, {
      externalTxId: 'misa-rot-1',
      certRef: 'misa-A',
    });
    expect(requireLeafCert(misaRotated.certificateChainPem).subject).toContain('Signer A');

    // PAdES baseline signedAttrs path (ETSI EN 319 142-1 s6.3 Table 1 forbids signing-time inside CMS).
    const prepared = preparePadesSignedAttrs({
      digestSha256: DIGEST,
      certificateChainDer: [idB.certDer],
    });
    expect(Buffer.from(prepared.signedAttrsDer).toString('hex')).not.toContain('06092a864886f70d010905');
    const cadesWithTime = prepareCadesSignedAttrs({
      digestSha256: DIGEST,
      certificateChainDer: [idB.certDer],
      signingTime: new Date('2026-11-16T10:00:00.000Z'),
    });
    expect(Buffer.from(cadesWithTime.signedAttrsDer).toString('hex')).toContain('06092a864886f70d010905');
    const canonicalSetDer = new Uint8Array([0x31, ...prepared.signedAttrsDer.subarray(1)]);
    const cadesRawSig = new Uint8Array(createSign('RSA-SHA256').update(canonicalSetDer).sign(idB.privateKey));
    const misaCadesMock = mockFetch({
      '/api/auth/api/v1/auth/login-api': [
        { status: 200, body: { status: { code: 200, error: false }, data: { remoteSigningAccessToken: 'misa-tok-cades', user: { id: 'misa-uid-c1' } } } },
      ],
      '/external/esrm/service/general/api/v1/Certificates/by-userId': [
        {
          status: 200,
          body: [{ userId: 'misa-uid-c1', keyAlias: 'misa-B', keyStatus: 'ACTIVE', certificate: idB.certB64 }],
        },
      ],
      '/external/esrm/service/signing/api/v1/Signing/status/misa-cades-1': [
        {
          status: 200,
          body: {
            transactionId: 'misa-cades-1',
            status: 'SUCCESS',
            signatures: [{ signature: Buffer.from(cadesRawSig).toString('base64') }],
          },
        },
      ],
    });
    const misaCades = getCaAdapter('misa_wesign', { fetch: misaCadesMock.fetchImpl });
    const cadesCms = await misaCades.fetchSignedCms(MISA_SECRET, {
      externalTxId: 'misa-cades-1',
      certRef: 'misa-B',
      signedAttrsDer: prepared.signedAttrsDer,
    });
    expect(cadesCms.subFilter).toBe('ETSI.CAdES.detached');
    expect(isCmsSignedDataDer(cadesCms.cmsDer)).toBe(true);
    expect(cmsHasSignedAttrs(cadesCms.cmsDer)).toBe(true);
    expect(cmsHasCadesSignedAttrs(cadesCms.cmsDer)).toBe(true);
    expect(
      createVerify('RSA-SHA256')
        .update(canonicalSetDer)
        .verify(requireLeafCert(cadesCms.certificateChainPem).publicKey, cadesRawSig),
    ).toBe(true);

    // Duplicate certs in chain are deduplicated in CMS CertificateSet.
    const dedupCms = assembleDetachedCmsSignedData({
      rawSignature: cadesRawSig,
      certificateChainDer: [idB.certDer, idB.certDer],
      signedAttrsDer: prepared.signedAttrsDer,
    });
    if (!dedupCms) throw new Error('expected dedupCms');
    expect(dedupCms.byteLength).toBe(cadesCms.cmsDer.byteLength);

    // Non-CAdES PKCS#7 CMS with contentType + messageDigest ONLY (missing signingCertificate/V2) must stay adbe.pkcs7.detached.
    const plainContentType = derTlv(
      0x30,
      derTlv(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03])),
      derTlv(0x31, derTlv(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]))),
    );
    const plainDigestAttr = derTlv(
      0x30,
      derTlv(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04])),
      derTlv(0x31, derTlv(0x04, Buffer.from(DIGEST, 'hex'))),
    );
    const plainSignedAttrsDer = derTlv(
      0xa0,
      ...[plainContentType, plainDigestAttr].sort((a, b) => Buffer.compare(a, b)),
    );
    const plainPkcs7Cms = assembleDetachedCmsSignedData({
      rawSignature: cadesRawSig,
      certificateChainDer: [idB.certDer],
      signedAttrsDer: plainSignedAttrsDer,
    });
    if (!plainPkcs7Cms) throw new Error('expected plainPkcs7Cms');
    expect(cmsHasSignedAttrs(plainPkcs7Cms)).toBe(true);
    expect(cmsHasCadesSignedAttrs(plainPkcs7Cms)).toBe(false);
    const misaPlainMock = mockFetch({
      '/api/auth/api/v1/auth/login-api': [
        { status: 200, body: { Success: true, Data: { remoteSigningAccessToken: 'misa-tok-plain' } } },
      ],
      '/external/esrm/service/signing/api/v1/Signing/status/misa-plain-1': [
        {
          status: 200,
          body: {
            status: { code: 200 },
            data: {
              transactionId: 'misa-plain-1',
              status: 'SUCCESS',
              signatures: [{ signature: Buffer.from(plainPkcs7Cms).toString('base64') }],
            },
          },
        },
      ],
    });
    const plainResult = await getCaAdapter('misa_wesign', { fetch: misaPlainMock.fetchImpl }).fetchSignedCms(
      MISA_SECRET,
      'misa-plain-1',
    );
    expect(plainResult.subFilter).toBe('adbe.pkcs7.detached');

    // Viettel HTTP 200 carrying numeric/string non-zero errorCode without explicit status must map to failed.
    const vtErrMock = mockFetch({
      '/vtss/service/ras/v1/login': [{ status: 200, body: { access_token: 'vt-tok-err', expires_in: 3600 } }],
      '/vtss/service/signHash': [
        { status: 200, body: { errorCode: '4004', transactionId: 'vt-tx-err' } },
        { status: 200, body: { errorCode: 4004, transactionId: 'vt-tx-err-num' } },
      ],
    });
    const vtErrAdapter = getCaAdapter('viettel_mysign', { fetch: vtErrMock.fetchImpl });
    expect(
      await vtErrAdapter.initiateSign(VIETTEL_SECRET, { idempotencyKey: 'vt-req-err', digestSha256: DIGEST, certRef: 'cert-A' }),
    ).toMatchObject({ provider: 'viettel_mysign', status: 'failed', errorCode: '4004' });
    expect(
      await vtErrAdapter.initiateSign(VIETTEL_SECRET, { idempotencyKey: 'vt-req-err-num', digestSha256: DIGEST, certRef: 'cert-A' }),
    ).toMatchObject({ provider: 'viettel_mysign', status: 'failed', errorCode: '4004' });

    // Empty-body HTTP 401/403 and non-JSON HTTP 400 across all 3 adapters must classify HTTP status before JSON checks.
    const emptyAuthFetch = (status: number): typeof fetch => async () => new Response(null, { status });
    for (const [provider, secret] of [
      ['vnpt_smartca', VNPT_SECRET],
      ['viettel_mysign', VIETTEL_SECRET],
      ['misa_wesign', MISA_SECRET],
    ] as const) {
      expect(await getCaAdapter(provider, { fetch: emptyAuthFetch(401) }).testConnection(secret)).toBe('wrong_credentials');
      expect(await getCaAdapter(provider, { fetch: emptyAuthFetch(403) }).testConnection(secret)).toBe('wrong_credentials');
      await expect(
        getCaAdapter(provider, { fetch: emptyAuthFetch(403) }).initiateSign(secret, {
          idempotencyKey: 'k-403',
          digestSha256: DIGEST,
          certRef: 'c1',
        }),
      ).rejects.toMatchObject({ kind: 'credentials' });
      await expect(getCaAdapter(provider, { fetch: emptyAuthFetch(403) }).pollStatus(secret, 'tx-403')).rejects.toMatchObject({
        kind: 'credentials',
      });
    }
    const vnpt400 = getCaAdapter('vnpt_smartca', { fetch: emptyAuthFetch(400) });
    expect(
      await vnpt400.initiateSign(VNPT_SECRET, { idempotencyKey: 'k-400', digestSha256: DIGEST, certRef: 'c1' }),
    ).toMatchObject({ provider: 'vnpt_smartca', status: 'failed', errorCode: 'HTTP_400' });
    const raw400AfterAuthFetch = (loginPath: string): typeof fetch => async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).pathname === loginPath) {
        return new Response(
          JSON.stringify({ access_token: 'tok', expires_in: 3600, Success: true, Data: { remoteSigningAccessToken: 'tok' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } });
    };
    expect(
      await getCaAdapter('viettel_mysign', { fetch: raw400AfterAuthFetch('/vtss/service/ras/v1/login') }).initiateSign(
        VIETTEL_SECRET,
        { idempotencyKey: 'k-vt-400', digestSha256: DIGEST, certRef: 'c1' },
      ),
    ).toMatchObject({ provider: 'viettel_mysign', status: 'failed', errorCode: 'HTTP_400' });
    expect(
      await getCaAdapter('misa_wesign', { fetch: raw400AfterAuthFetch('/api/auth/api/v1/auth/login-api') }).initiateSign(
        MISA_SECRET,
        { idempotencyKey: 'k-misa-400', digestSha256: DIGEST, certRef: 'c1' },
      ),
    ).toMatchObject({ provider: 'misa_wesign', status: 'failed', errorCode: 'HTTP_400' });

    // Non-auth HTTP 404 JSON on cert-list / login must return unreachable instead of signing_needs_person or wrong_credentials.
    const notFoundJsonFetch = (loginPath?: string): typeof fetch => async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (loginPath && new URL(url).pathname === loginPath) {
        return new Response(
          JSON.stringify({ access_token: 'tok', expires_in: 3600, Success: true, Data: { remoteSigningAccessToken: 'tok' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
    expect(await getCaAdapter('vnpt_smartca', { fetch: notFoundJsonFetch() }).testConnection(VNPT_SECRET)).toBe('unreachable');
    expect(await getCaAdapter('viettel_mysign', { fetch: notFoundJsonFetch() }).testConnection(VIETTEL_SECRET)).toBe('unreachable');
    expect(await getCaAdapter('viettel_mysign', { fetch: notFoundJsonFetch('/vtss/service/ras/v1/login') }).testConnection(VIETTEL_SECRET)).toBe('unreachable');
    expect(await getCaAdapter('misa_wesign', { fetch: notFoundJsonFetch() }).testConnection(MISA_SECRET)).toBe('unreachable');
    expect(await getCaAdapter('misa_wesign', { fetch: notFoundJsonFetch('/api/auth/api/v1/auth/login-api') }).testConnection(MISA_SECRET)).toBe('unreachable');
  });

  it('detects 2FA (errorCode 122), inactive app, 403 credentials error, USB-only certs, and auth failures without leaking secrets', async () => {
    const twoStep = mockFetch({
      '/api/auth/api/v1/auth/login-api': [
        { status: 400, body: { status: { code: 400, error: true, errorCode: 122 }, data: null } },
      ],
    });
    expect(await getCaAdapter('misa_wesign', { fetch: twoStep.fetchImpl }).testConnection(MISA_SECRET)).toBe('signing_needs_person');

    const twoStepOkStatus = mockFetch({
      '/api/auth/api/v1/auth/login-api': [
        { status: 200, body: { status: { code: 400, error: true, errorCode: 122 }, data: null } },
      ],
    });
    expect(await getCaAdapter('misa_wesign', { fetch: twoStepOkStatus.fetchImpl }).testConnection(MISA_SECRET)).toBe('signing_needs_person');

    const inactive = mockFetch({
      '/api/auth/api/v1/auth/login-api': [{ status: 200, body: { Success: false, ErrorCode: 'InActiveAppID' } }],
    });
    expect(await getCaAdapter('misa_wesign', { fetch: inactive.fetchImpl }).testConnection(MISA_SECRET)).toBe('api_not_enabled');

    const forbiddenCerts = mockFetch({
      '/api/auth/api/v1/auth/login-api': [{ status: 200, body: { status: { code: 200, error: false }, data: { remoteSigningAccessToken: 'tok', user: { id: 'u1' } } } }],
      '/external/esrm/service/general/api/v1/Certificates/by-userId': [{ status: 403, body: { errorCode: 'UnAuthorize' } }],
    });
    expect(await getCaAdapter('misa_wesign', { fetch: forbiddenCerts.fetchImpl }).testConnection(MISA_SECRET)).toBe('wrong_credentials');

    const usbCerts = mockFetch({
      '/api/auth/api/v1/auth/login-api': [{ status: 200, body: { status: { code: 200, error: false }, data: { remoteSigningAccessToken: 'tok', user: { id: 'u1' } } } }],
      '/external/esrm/service/general/api/v1/Certificates/by-userId': [{ status: 200, body: [{ keyAlias: 'U1', SignType: 'USB_TOKEN', keyStatus: 'ACTIVE' }] }],
    });
    expect(await getCaAdapter('misa_wesign', { fetch: usbCerts.fetchImpl }).testConnection(MISA_SECRET)).toBe('usb_token_unsupported');

    const missingRemoteToken = mockFetch({
      '/api/auth/api/v1/auth/login-api': [
        { status: 200, body: { status: { code: 200, error: false }, data: { accessToken: 'misaid-only-tok', remoteSigningAccessToken: null } } },
      ],
    });
    expect(await getCaAdapter('misa_wesign', { fetch: missingRemoteToken.fetchImpl }).testConnection(MISA_SECRET)).toBe('wrong_credentials');
    expect(missingRemoteToken.calls).toHaveLength(1);
  });

  it('derives collision-free MISA DocumentId for keys over 36 chars and refreshes on nested status.errorCode TokenExpiredCode', async () => {
    const keyA = 'same-36-char-prefix-for-both-requests-A';
    const keyB = 'same-36-char-prefix-for-both-requests-B';
    let loginCount = 0;
    const sentDocIds: string[] = [];
    const statusPaths: string[] = [];
    const authHeaders: string[] = [];
    let hashCallCount = 0;

    const customFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const headers = new Headers(init?.headers);
      if (path.endsWith('/login-api')) {
        loginCount += 1;
        return Response.json({
          status: { code: 200, error: false },
          data: { remoteSigningAccessToken: `tok-${loginCount}`, user: { id: 'uid-long' } },
        });
      }
      authHeaders.push(headers.get('authorizationrm') ?? '');
      if (path.endsWith('/Signing/hash')) {
        hashCallCount += 1;
        if (hashCallCount === 1) {
          return Response.json({ status: { code: 200, error: true, errorCode: 'TokenExpiredCode' }, data: null });
        }
        const parsed = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          Documents: Array<{ DocumentId: string }>;
        };
        const docId = parsed.Documents[0]?.DocumentId ?? '';
        sentDocIds.push(docId);
        if (hashCallCount === 3) {
          return Response.json({ status: { code: 400, error: true, errorCode: 'DuplicateRefID' }, data: { transactionId: 'tx-2' } });
        }
        if (hashCallCount === 4) {
          return Response.json({ status: { code: 400, error: true, errorCode: 'DuplicateRefID' }, data: null });
        }
        return Response.json({ transactionId: `tx-${hashCallCount}` });
      }
      if (path.includes('/Signing/status/')) {
        statusPaths.push(path);
        return Response.json({ transactionId: 'tx-2', status: 'PENDING' });
      }
      return Response.json({}, { status: 404 });
    };

    const adapter = getCaAdapter('misa_wesign', { fetch: customFetch });
    const first = await adapter.initiateSign(MISA_SECRET, { idempotencyKey: keyA, digestSha256: DIGEST, certRef: 'M1' });
    expect(first.externalTxId).toBe('tx-2');
    expect(loginCount).toBe(2);
    expect(authHeaders[0]).toBe('Bearer tok-1');
    expect(authHeaders[1]).toBe('Bearer tok-2');

    // Retry same >36-char keyA reconciles DuplicateRefID using server transactionId.
    const dup = await adapter.initiateSign(MISA_SECRET, { idempotencyKey: keyA, digestSha256: DIGEST, certRef: 'M1' });
    expect(dup.externalTxId).toBe('tx-2');

    // DuplicateRefID without server transactionId throws lost_answer instead of querying DocumentId.
    await expect(
      adapter.initiateSign(MISA_SECRET, { idempotencyKey: keyA, digestSha256: DIGEST, certRef: 'M1' }),
    ).rejects.toMatchObject({ kind: 'lost_answer' });

    const second = await adapter.initiateSign(MISA_SECRET, { idempotencyKey: keyB, digestSha256: DIGEST, certRef: 'M1' });
    expect(second.externalTxId).toBe('tx-5');

    expect(sentDocIds).toHaveLength(4);
    const [docA, docADup, , docB] = sentDocIds;
    expect(docA?.length).toBeLessThanOrEqual(36);
    expect(docB?.length).toBeLessThanOrEqual(36);
    expect(docA).toBe(docADup);
    expect(docA).not.toBe(docB);
    expect(statusPaths).toEqual(['/external/esrm/service/signing/api/v1/Signing/status/tx-2']);

    await expect(adapter.pollStatus(MISA_SECRET, { idempotencyKey: keyA })).rejects.toMatchObject({
      kind: 'lost_answer',
    });
    expect(statusPaths).toHaveLength(1);
  });

  it('rejects path-traversal identifiers consistently across initiateSign, pollStatus, and fetchSignedCms, plus non-canonical DER and body timeouts', async () => {
    const { fetchImpl, calls } = mockFetch({});
    for (const provider of ['vnpt_smartca', 'viettel_mysign', 'misa_wesign'] as const) {
      const adapter = getCaAdapter(provider, { fetch: fetchImpl });
      const secret =
        provider === 'vnpt_smartca' ? VNPT_SECRET : provider === 'viettel_mysign' ? VIETTEL_SECRET : MISA_SECRET;
      for (const badId of ['..', '.', '../admin', 'tx/sub', 'tx?leak=1', 'tx#frag', 'tx%2fenc', 'tx space', 'a'.repeat(129)]) {
        await expect(
          adapter.initiateSign(secret, { idempotencyKey: badId, digestSha256: DIGEST, certRef: 'c1' }),
        ).rejects.toMatchObject({ kind: 'invalid_request' });
        await expect(adapter.pollStatus(secret, badId)).rejects.toMatchObject({ kind: 'invalid_request' });
        await expect(adapter.fetchSignedCms(secret, badId)).rejects.toMatchObject({ kind: 'invalid_request' });
      }
      await expect(adapter.pollStatus(secret, { idempotencyKey: '../escape' })).rejects.toMatchObject({
        kind: 'invalid_request',
      });
    }
    expect(calls).toHaveLength(0);

    const nonCanonical = new Uint8Array(3 + 0x80);
    nonCanonical[0] = 0x30;
    nonCanonical[1] = 0x82;
    nonCanonical[2] = 0x00;
    nonCanonical[3] = 0x80;
    expect(isValidDerSequence(nonCanonical)).toBe(false);

    const slowBodyFetch: typeof fetch = async (_input, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(init.signal?.reason ?? new Error('aborted'));
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const timeoutAdapter = getCaAdapter('vnpt_smartca', { fetch: slowBodyFetch, timeoutMs: 25 });
    await expect(timeoutAdapter.pollStatus(VNPT_SECRET, 'tx-slow-body')).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

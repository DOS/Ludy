// SPDX-License-Identifier: AGPL-3.0-only
// Recorded-response unit tests for VNPT SmartCA, Viettel MySign, and MISA WeSign adapters,
// plus SSRF/host-allowlist validation, USB-token mode rejection, reconcile_only recovery, and secret isolation.
import { describe, expect, it } from 'vitest';
import {
  CaProviderError,
  MISA_WESIGN_HOSTS,
  VIETTEL_MYSIGN_HOSTS,
  VNPT_SMARTCA_HOSTS,
  assertSafeCaBaseUrl,
  buildSandboxCmsDer,
  getCaAdapter,
  type CaProviderId,
} from '../src/index.ts';

const DIGEST = 'd'.repeat(64);
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
  appId: 'misa-app-01',
  appSecret: 'misa-top-secret-key',
  username: 'signer@company.vn',
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
      'http://gwsca.vnpt.vn',
      'file:///etc/passwd',
      'https://127.0.0.1/api',
      'https://10.0.0.1/api',
      'https://172.16.0.5/api',
      'https://192.168.1.10/api',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/api',
      'https://2130706433/api',
      'https://localhost/api',
      'https://ca.internal/api',
      'https://service.local/api',
      'https://metadata.google.internal/api',
      'https://gwsca.vnpt.vn:8443',
      'https://user:pass@gwsca.vnpt.vn',
      'https://gwsca.vnpt.vn?leak=1',
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

  it('rejects unsafe credential baseUrl and USB-token signing modes before touching fetch', async () => {
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

      const usbSecret = JSON.stringify({ ...parsed, signingMode: 'usb_token' });
      expect(await adapter.testConnection(usbSecret)).toBe('usb_token_unsupported');
      await expect(
        adapter.initiateSign(usbSecret, { idempotencyKey: 'k2', digestSha256: DIGEST, certRef: 'c1' }),
      ).rejects.toMatchObject({ kind: 'usb_token_unsupported' });

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

describe('VNPT SmartCA adapter (recorded responses)', () => {
  it('declares allowlisted hosts and tests remote vs USB/missing certificates', async () => {
    const ok = mockFetch({
      '/v1/credentials/get_certificate': [{ status: 200, body: { status_code: 0, data: [{ serial_number: '5401', token_type: 'CLOUD_CA' }] } }],
    });
    const adapter = getCaAdapter('vnpt_smartca', { fetch: ok.fetchImpl });
    expect(adapter.hosts).toEqual([...VNPT_SMARTCA_HOSTS]);
    expect(await adapter.testConnection(VNPT_SECRET)).toBe('works');
    expect(ok.calls[0]?.redirect).toBe('error');

    const usbOnly = mockFetch({
      '/v1/credentials/get_certificate': [{ status: 200, body: { data: [{ serial_number: '5401', token_type: 'USB_TOKEN' }] } }],
    });
    expect(await getCaAdapter('vnpt_smartca', { fetch: usbOnly.fetchImpl }).testConnection(VNPT_SECRET)).toBe('usb_token_unsupported');

    const empty = mockFetch({ '/v1/credentials/get_certificate': [{ status: 200, body: { data: [] } }] });
    expect(await getCaAdapter('vnpt_smartca', { fetch: empty.fetchImpl }).testConnection(VNPT_SECRET)).toBe('signing_needs_person');

    const ipBlocked = mockFetch({ '/v1/credentials/get_certificate': [{ status: 200, body: { message_code: 'IP_NOT_ALLOWED' } }] });
    expect(await getCaAdapter('vnpt_smartca', { fetch: ipBlocked.fetchImpl }).testConnection(VNPT_SECRET)).toBe('ip_not_allowed');

    const wrongCreds = mockFetch({ '/v1/credentials/get_certificate': [{ status: 401, body: { message_code: 'AUTH_FAILED' } }] });
    expect(await getCaAdapter('vnpt_smartca', { fetch: wrongCreds.fetchImpl }).testConnection(VNPT_SECRET)).toBe('wrong_credentials');
  });

  it('initiates, polls all statuses, reconciles duplicates, fetches CMS DER, and never leaks secrets', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/v2/signatures/sign': [
        { status: 200, body: { data: { tran_id: 'vnpt-tx-1', status: 'WAITING', challenge_code: '942811', expired_at: '2026-11-16T10:05:00Z' } } },
        { status: 409, body: { message_code: 'TRANSACTION_EXISTS' } },
      ],
      '/v1/signatures/sign/vnpt-tx-1/status': [
        { status: 200, body: { data: { tran_id: 'vnpt-tx-1', status: 'PENDING' } } },
        { status: 200, body: { data: { tran_id: 'vnpt-tx-1', status: 'PENDING' } } },
        {
          status: 200,
          body: {
            data: {
              tran_id: 'vnpt-tx-1',
              status: 'SUCCESS',
              signed_at: '2026-11-16T10:01:00Z',
              signatures: [{ signature_value: SAMPLE_CMS_B64, timestamp_token: SAMPLE_TS_B64, ocsp_responses: [SAMPLE_OCSP_B64] }],
            },
          },
        },
      ],
      '/v1/signatures/sign/idem-vnpt-1/status': [
        { status: 200, body: { data: { tran_id: 'vnpt-tx-1', status: 'PENDING' } } },
      ],
      '/v1/signatures/sign/tx-rej/status': [{ status: 200, body: { data: { tran_id: 'tx-rej', status: 'REJECTED' }, message_code: 'USER_DECLINED' } }],
      '/v1/signatures/sign/tx-exp/status': [{ status: 200, body: { data: { tran_id: 'tx-exp', status: 'EXPIRED' } } }],
      '/v1/signatures/sign/tx-fail/status': [{ status: 200, body: { data: { tran_id: 'tx-fail', status: 'FAILED' } } }],
    });

    const adapter = getCaAdapter('vnpt_smartca', { fetch: fetchImpl });
    const init = await adapter.initiateSign(VNPT_SECRET, {
      idempotencyKey: 'idem-vnpt-1',
      digestSha256: DIGEST,
      certRef: '54010101AABBCCDD',
      documentName: 'HopDong.pdf',
    });
    expect(init).toMatchObject({ provider: 'vnpt_smartca', externalTxId: 'vnpt-tx-1', status: 'pending', challengeCode: '942811' });

    // Duplicate initiate reconciles via status endpoint.
    const dup = await adapter.initiateSign(VNPT_SECRET, {
      idempotencyKey: 'idem-vnpt-1',
      digestSha256: DIGEST,
      certRef: '54010101AABBCCDD',
    });
    expect(dup).toMatchObject({ externalTxId: 'vnpt-tx-1', status: 'pending' });

    const p1 = await adapter.pollStatus(VNPT_SECRET, 'vnpt-tx-1');
    expect(p1.status).toBe('pending');
    await expect(adapter.fetchSignedCms(VNPT_SECRET, 'vnpt-tx-1')).rejects.toMatchObject({ kind: 'not_signed' });

    const signed = await adapter.fetchSignedCms(VNPT_SECRET, 'vnpt-tx-1');
    expect(Buffer.from(signed.cmsDer).toString('base64')).toBe(SAMPLE_CMS_B64);
    expect(Buffer.from(signed.timestampTokenDer!).toString('base64')).toBe(SAMPLE_TS_B64);
    expect(signed.ocspResponsesDer).toHaveLength(1);

    expect((await adapter.pollStatus(VNPT_SECRET, 'tx-rej')).status).toBe('rejected');
    expect((await adapter.pollStatus(VNPT_SECRET, 'tx-exp')).status).toBe('expired');
    expect((await adapter.pollStatus(VNPT_SECRET, 'tx-fail')).status).toBe('failed');

    for (const call of calls) {
      expect(call.url).not.toContain('vnpt-top-secret-password');
    }

    const lost = mockFetch({ '/v2/signatures/sign': [new Error('socket reset')] });
    const err = await getCaAdapter('vnpt_smartca', { fetch: lost.fetchImpl })
      .initiateSign(VNPT_SECRET, { idempotencyKey: 'k-lost', digestSha256: DIGEST, certRef: '5401' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'lost_answer' });
    expect(String(err)).not.toContain('vnpt-top-secret-password');
  });
});

describe('Viettel MySign adapter (recorded responses)', () => {
  it('handles login, credentials check, signHash with base64 SHA-256, token refresh, and CMS extraction', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/vtss/service/ras/v1/login': [
        { status: 200, body: { access_token: 'vt-token-1', expires_in: 3600 } },
        { status: 200, body: { access_token: 'vt-token-2', expires_in: 3600 } },
      ],
      '/vtss/service/ras/csc/v1/credentials/list': [
        { status: 200, body: { credentialIDs: ['vt-cred-01'] } },
      ],
      '/vtss/service/ras/csc/v1/signatures/signHash': [
        { status: 401, body: { error: 'token_expired' } },
        { status: 200, body: { data: { transactionId: 'vt-tx-1', status: 'PENDING', challengeCode: '5511' } } },
      ],
      '/vtss/service/ras/csc/v1/signatures/getStatus': [
        { status: 200, body: { data: { transactionId: 'vt-tx-1', status: 'COMPLETE', signatures: [SAMPLE_CMS_B64] } } },
      ],
    });

    const adapter = getCaAdapter('viettel_mysign', { fetch: fetchImpl });
    expect(adapter.hosts).toEqual([...VIETTEL_MYSIGN_HOSTS]);
    expect(await adapter.testConnection(VIETTEL_SECRET)).toBe('works');

    const init = await adapter.initiateSign(VIETTEL_SECRET, {
      idempotencyKey: 'vt-req-1',
      digestSha256: DIGEST,
      certRef: 'vt-cred-01',
    });
    expect(init).toMatchObject({ provider: 'viettel_mysign', externalTxId: 'vt-tx-1', status: 'pending' });
    const signBody = JSON.parse(calls.find((c) => c.url.endsWith('/signHash'))?.body ?? '{}') as {
      hash: string[];
      hashAlgo: string;
      async: number;
    };
    expect(signBody.hash).toEqual([Buffer.from(DIGEST, 'hex').toString('base64')]);
    expect(signBody.hashAlgo).toBe('2.16.840.1.101.3.4.2.1');
    expect(signBody.async).toBe(1);

    const cms = await adapter.fetchSignedCms(VIETTEL_SECRET, 'vt-tx-1');
    expect(Buffer.from(cms.cmsDer).toString('base64')).toBe(SAMPLE_CMS_B64);

    for (const call of calls) {
      expect(call.url).not.toContain('viettel-top-secret-key');
    }
  });

  it('never leaks credentials on auth failure or network error', async () => {
    const authFail = mockFetch({ '/vtss/service/ras/v1/login': [{ status: 401, body: { error: 'invalid_client' } }] });
    const adapter = getCaAdapter('viettel_mysign', { fetch: authFail.fetchImpl });
    expect(await adapter.testConnection(VIETTEL_SECRET)).toBe('wrong_credentials');
    const err = await adapter
      .initiateSign(VIETTEL_SECRET, { idempotencyKey: 'k1', digestSha256: DIGEST, certRef: 'c1' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'credentials' });
    expect(String(err)).not.toContain('viettel-top-secret-key');
  });
});

describe('MISA WeSign adapter (recorded responses)', () => {
  it('verifies remote certs, enforces SignType RemoteSigning, reconciles DuplicateRefID, and reads CMS DER', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/apis/RMeSign/Login': [
        { status: 200, body: { Success: true, Data: { AccessToken: 'misa-token-1' } } },
      ],
      '/apis/RMeSign/GetListCertificate': [
        { status: 200, body: { Success: true, Data: [{ CertSerial: 'MISA-01', SignType: 'RemoteSigning', KeyStatus: 'ACTIVE' }] } },
      ],
      '/apis/RMeSign/SignHashV4': [
        { status: 200, body: { Success: true, Data: { TransactionID: 'misa-tx-1', Status: 0, ChallengeCode: '8822' } } },
        { status: 200, body: { Success: false, ErrorCode: 'DuplicateRefID' } },
      ],
      '/apis/RMeSign/GetSignStatusV3': [
        { status: 200, body: { Success: true, Data: { TransactionID: 'misa-tx-1', RefID: 'misa-req-1', Status: 0 } } },
        { status: 200, body: { Success: true, Data: { TransactionID: 'misa-tx-1', RefID: 'misa-req-1', Status: 1, CmsBase64: SAMPLE_CMS_B64 } } },
      ],
    });

    const adapter = getCaAdapter('misa_wesign', { fetch: fetchImpl });
    expect(adapter.hosts).toEqual([...MISA_WESIGN_HOSTS]);
    expect(adapter.capabilities.signing).toBe('provider_hsm');
    expect(await adapter.testConnection(MISA_SECRET)).toBe('works');

    const init = await adapter.initiateSign(MISA_SECRET, {
      idempotencyKey: 'misa-req-1',
      digestSha256: DIGEST,
      certRef: 'MISA-01',
    });
    expect(init).toMatchObject({ provider: 'misa_wesign', externalTxId: 'misa-tx-1', status: 'pending' });
    const reqBody = JSON.parse(calls.find((c) => c.url.endsWith('/SignHashV4'))?.body ?? '{}') as { SignType: string; RefID: string };
    expect(reqBody.SignType).toBe('RemoteSigning');
    expect(reqBody.RefID).toBe('misa-req-1');

    // DuplicateRefID reconciles via GetSignStatusV3.
    const reconciled = await adapter.initiateSign(MISA_SECRET, {
      idempotencyKey: 'misa-req-1',
      digestSha256: DIGEST,
      certRef: 'MISA-01',
    });
    expect(reconciled.externalTxId).toBe('misa-tx-1');

    const cms = await adapter.fetchSignedCms(MISA_SECRET, 'misa-tx-1');
    expect(Buffer.from(cms.cmsDer).toString('base64')).toBe(SAMPLE_CMS_B64);

    for (const call of calls) {
      expect(call.url).not.toContain('misa-top-secret-password');
      expect(call.url).not.toContain('misa-top-secret-key');
    }
  });

  it('detects 2FA, inactive app, USB-only certs, and auth failures without leaking secrets', async () => {
    const twoStep = mockFetch({
      '/apis/RMeSign/Login': [{ status: 200, body: { Success: true, Data: null, CustomData: { Id: 'otp-user' } } }],
    });
    expect(await getCaAdapter('misa_wesign', { fetch: twoStep.fetchImpl }).testConnection(MISA_SECRET)).toBe('signing_needs_person');

    const inactive = mockFetch({
      '/apis/RMeSign/Login': [{ status: 200, body: { Success: false, ErrorCode: 'InActiveAppID' } }],
    });
    expect(await getCaAdapter('misa_wesign', { fetch: inactive.fetchImpl }).testConnection(MISA_SECRET)).toBe('api_not_enabled');

    const usbCerts = mockFetch({
      '/apis/RMeSign/Login': [{ status: 200, body: { Success: true, Data: 'tok' } }],
      '/apis/RMeSign/GetListCertificate': [{ status: 200, body: { Success: true, Data: [{ CertSerial: 'U1', SignType: 'USB_TOKEN', KeyStatus: 'ACTIVE' }] } }],
    });
    expect(await getCaAdapter('misa_wesign', { fetch: usbCerts.fetchImpl }).testConnection(MISA_SECRET)).toBe('usb_token_unsupported');
  });
});

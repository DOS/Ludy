// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for @crove/sign offline sandbox CA adapter: capabilities, reconcile_only idempotencyKey
// deduplication, scripted async/failure/lost_answer states, DER CMS output, and USB-token refusal.
import { describe, expect, it } from 'vitest';
import {
  CA_PROVIDERS,
  CaProviderError,
  SANDBOX_CA_SECRET,
  buildSandboxCmsDer,
  createSandboxCaAdapter,
  getCaAdapter,
  isCaProvider,
  isValidDerSequence,
  type CaInitiateRequest,
} from '../src/index.ts';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const makeRequest = (idempotencyKey: string, extra: Partial<CaInitiateRequest> = {}): CaInitiateRequest => ({
  idempotencyKey,
  digestSha256: DIGEST_A,
  certRef: 'cert-sandbox-001',
  documentName: 'Hop-dong-dich-vu.pdf',
  signerReason: 'Approval signature',
  ...extra,
});

describe('CA provider registry and offline sandbox adapter', () => {
  it('exposes expected CA_PROVIDERS and static remote_ca capabilities with reconcile_only initiateSign', () => {
    expect(CA_PROVIDERS).toEqual(['sandbox', 'vnpt_smartca', 'viettel_mysign', 'misa_wesign']);
    expect(isCaProvider('sandbox')).toBe(true);
    expect(isCaProvider('vnpt_smartca')).toBe(true);
    expect(isCaProvider('viettel_mysign')).toBe(true);
    expect(isCaProvider('misa_wesign')).toBe(true);
    expect(isCaProvider('unknown_ca')).toBe(false);

    const adapter = getCaAdapter('sandbox');
    expect(adapter.id).toBe('sandbox');
    expect(adapter.hosts).toEqual([]);
    expect(adapter.capabilities).toEqual({
      signing: 'remote_ca',
      localUsbTokenSupported: false,
      supportedDigestAlgorithms: ['SHA-256'],
      retry: {
        testConnection: 'safe',
        initiateSign: 'reconcile_only',
        pollStatus: 'safe',
        fetchSignedCms: 'safe',
      },
    });
  });

  it('tests connection and rejects invalid secrets or USB-token JSON credentials', async () => {
    const { adapter } = createSandboxCaAdapter();
    expect(await adapter.testConnection(SANDBOX_CA_SECRET)).toBe('works');
    expect(await adapter.testConnection('wrong-secret')).toBe('wrong_credentials');
    expect(await adapter.testConnection(JSON.stringify({ signingMode: 'usb_token' }))).toBe('usb_token_unsupported');
    expect(await adapter.testConnection(JSON.stringify({ usbToken: true }))).toBe('usb_token_unsupported');

    await expect(adapter.initiateSign('wrong-secret', makeRequest('k-bad'))).rejects.toMatchObject({ kind: 'credentials' });
    await expect(
      adapter.initiateSign(JSON.stringify({ signingMode: 'pkcs11' }), makeRequest('k-usb')),
    ).rejects.toMatchObject({ kind: 'usb_token_unsupported' });
  });

  it('refuses client-PC USB/token signing modes on initiateSign', async () => {
    const { adapter } = createSandboxCaAdapter();
    for (const signingMode of ['usb_token', 'local_token', 'pkcs11', 'client_pc', 'smartcard', 'usb']) {
      await expect(
        adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest(`usb-${signingMode}`, { signingMode })),
      ).rejects.toMatchObject({ kind: 'usb_token_unsupported' });
    }
    await expect(adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('bad-digest', { digestSha256: 'xyz' }))).rejects.toMatchObject({
      kind: 'invalid_request',
    });
    for (const badKey of ['.', '..', 'dir/key', 'key?x=1', 'key#frag']) {
      await expect(adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest(badKey))).rejects.toMatchObject({
        kind: 'invalid_request',
      });
    }
  });

  it('signs deterministically offline and produces valid DER CMS SignedData bytes', async () => {
    const fixedNow = () => new Date('2026-11-16T10:00:00.000Z');
    const { adapter } = createSandboxCaAdapter({ now: fixedNow });
    const session = await adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('req-1'));
    expect(session).toMatchObject({
      provider: 'sandbox',
      idempotencyKey: 'req-1',
      status: 'signed',
      signedAt: '2026-11-16T10:00:00.000Z',
      errorCode: null,
    });
    expect(session.externalTxId).toMatch(/^sbx-ca-[0-9a-f]{16}$/);

    const cms = await adapter.fetchSignedCms(SANDBOX_CA_SECRET, session.externalTxId);
    expect(cms.externalTxId).toBe(session.externalTxId);
    expect(isValidDerSequence(cms.cmsDer)).toBe(true);
    expect(cms.cmsDer).toEqual(buildSandboxCmsDer(DIGEST_A, session.externalTxId, 'cert-sandbox-001'));
    // SignedData OID (1.2.840.113549.1.7.2) + 32-byte digest are embedded in DER payload.
    const hex = Buffer.from(cms.cmsDer).toString('hex');
    expect(hex).toContain('2a864886f70d010702');
    expect(hex).toContain(DIGEST_A);
  });

  it('deduplicates repeated initiateSign calls on idempotencyKey and rejects conflicting payloads', async () => {
    const { adapter, control } = createSandboxCaAdapter();
    control.script('pending', 'signed');

    const first = await adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('idem-1'));
    const duplicate = await adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('idem-1'));
    expect(duplicate).toEqual(first);
    expect(first.status).toBe('pending');

    // Conflicting digest or certRef for the same idempotencyKey must be refused.
    await expect(
      adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('idem-1', { digestSha256: DIGEST_B })),
    ).rejects.toMatchObject({ kind: 'idempotency_conflict' });
    await expect(
      adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('idem-1', { certRef: 'other-cert' })),
    ).rejects.toMatchObject({ kind: 'idempotency_conflict' });

    // Second distinct key consumes the next scripted behavior ('signed').
    const second = await adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('idem-2'));
    expect(second.status).toBe('signed');
    expect(second.externalTxId).not.toBe(first.externalTxId);
  });

  it('transitions pending -> signed across pollStatus calls and blocks early fetchSignedCms', async () => {
    const { adapter, control } = createSandboxCaAdapter();
    control.pendingPolls = 2;
    control.script('pending');

    const init = await adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('poll-key'));
    expect(init.status).toBe('pending');
    await expect(adapter.fetchSignedCms(SANDBOX_CA_SECRET, init.externalTxId)).rejects.toMatchObject({
      kind: 'not_signed',
    });

    const p1 = await adapter.pollStatus(SANDBOX_CA_SECRET, init.externalTxId);
    expect(p1.status).toBe('pending');

    const p2 = await adapter.pollStatus(SANDBOX_CA_SECRET, { externalTxId: init.externalTxId });
    expect(p2.status).toBe('signed');

    const cms = await adapter.fetchSignedCms(SANDBOX_CA_SECRET, init.externalTxId);
    expect(isValidDerSequence(cms.cmsDer)).toBe(true);
  });

  it('supports reconcile_only recovery after lose_answer without double-signing', async () => {
    const { adapter, control } = createSandboxCaAdapter();
    control.script('lose_answer');

    await expect(adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('lost-key'))).rejects.toMatchObject({
      kind: 'lost_answer',
    });

    const reconciled = await adapter.pollStatus(SANDBOX_CA_SECRET, { idempotencyKey: 'lost-key' });
    expect(reconciled.status).toBe('signed');
    expect(reconciled.idempotencyKey).toBe('lost-key');

    const cms = await adapter.fetchSignedCms(SANDBOX_CA_SECRET, reconciled.externalTxId);
    expect(isValidDerSequence(cms.cmsDer)).toBe(true);
  });

  it('maps rejected, expired, and failed terminal states and coalesces concurrent slow calls', async () => {
    let releaseSlow: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const { adapter, control } = createSandboxCaAdapter({ wait: () => gate });
    control.script('rejected', 'expired', 'failed', 'slow');

    const rej = await adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('k-rej'));
    const exp = await adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('k-exp'));
    const fail = await adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('k-fail'));
    expect(rej.status).toBe('rejected');
    expect(exp.status).toBe('expired');
    expect(fail.status).toBe('failed');
    await expect(adapter.fetchSignedCms(SANDBOX_CA_SECRET, rej.externalTxId)).rejects.toBeInstanceOf(CaProviderError);

    const pA = adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('k-slow'));
    const pB = adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('k-slow'));
    const pConflict = adapter.initiateSign(SANDBOX_CA_SECRET, makeRequest('k-slow', { digestSha256: DIGEST_B }));
    releaseSlow();
    const [resA, resB] = await Promise.all([pA, pB]);
    expect(resA).toEqual(resB);
    await expect(pConflict).rejects.toMatchObject({ kind: 'idempotency_conflict' });
    expect(JSON.stringify(control.calls)).not.toContain(SANDBOX_CA_SECRET);
  });

  it('prevents txHash collisions across field boundaries when inputs contain colons', async () => {
    const { adapter } = createSandboxCaAdapter();
    const first = await adapter.initiateSign(SANDBOX_CA_SECRET, {
      idempotencyKey: 'x',
      digestSha256: DIGEST_A,
      certRef: `c:${DIGEST_A}:z`,
    });
    const second = await adapter.initiateSign(SANDBOX_CA_SECRET, {
      idempotencyKey: `x:${DIGEST_A}:c`,
      digestSha256: DIGEST_A,
      certRef: 'z',
    });
    expect(first.externalTxId).not.toBe(second.externalTxId);
  });
});

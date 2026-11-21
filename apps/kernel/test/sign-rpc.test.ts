// SPDX-License-Identifier: AGPL-3.0-only
// Authenticated oRPC wiring tests for os.sign (#3325): module gate, noIdempotency commands, and Vy AI analyze/get routing.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { SignAiReader } from '@crove/agent';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const ORG_ID = '01900000-0000-7000-8000-000000000010';
const USER_ID = '01900000-0000-7000-8000-000000000020';
const ENVELOPE_ID = '01900000-0000-7000-8000-000000000030';
const SIGNER_ID = '01900000-0000-7000-8000-000000000040';
const FILE_ID = '01900000-0000-7000-8000-000000000050';
const TOKEN_ID = '01900000-0000-7000-8000-000000000060';
const ANALYSIS_ID = '01900000-0000-7000-8000-000000000070';
const KEY_ID = '01900000-0000-7000-8000-000000000080';
const TEMPLATE_ID = '01900000-0000-7000-8000-000000000090';

const WEB_DIST = mkdtempSync(join(tmpdir(), 'crove-sign-rpc-'));
writeFileSync(join(WEB_DIST, 'index.html'), '<!doctype html><title>Crove</title>');

afterAll(() => {
  rmSync(WEB_DIST, { recursive: true, force: true });
});

function buildUser(): AuthUser {
  return {
    userId: USER_ID,
    email: 'owner@example.com',
    name: 'Owner',
    aal: 'aal2',
    sessionId: 'sess-1',
    mfaAt: 1_700_000_000,
  };
}

function buildConfig() {
  return loadConfig({
    DATABASE_URL: 'postgres://localhost/x',
    AUTH_JWT_SECRET: 'x'.repeat(32),
    AUTH_ISSUER: 'crove-auth',
    AUTH_UPSTREAM_URL: 'http://127.0.0.1:9',
    STATUS_FILE: join(WEB_DIST, 'status.json').replace(/^[A-Za-z]:[\\/]/, '/').replace(/\\/g, '/'),
    WEB_DIST,
  });
}

function createSignTestApp(options: { signInstalled: boolean; signAi?: SignAiReader | null; existingAnalysis?: boolean }) {
  const executed: Array<{ name: string; input: unknown; opts: unknown }> = [];
  const queried: Array<{ name: string; input: unknown; opts: unknown }> = [];
  const fakeDb = {
    getExecutor: () => ({
      transformQuery: (node: unknown) => node,
      compileQuery: () => ({ query: {}, sql: '', parameters: [] }),
      executeQuery: async () => ({
        rows: [{ org_id: ORG_ID, slug: 'acme', name: 'Acme', role: 'owner' }],
      }),
    }),
  };
  const aiSource = {
    envelopeId: ENVELOPE_ID,
    version: 1,
    status: 'draft',
    inspectStatus: 'passed',
    sourceSha256: 'a'.repeat(64),
    title: 'Service Contract',
    pageCount: 1,
    pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842 }],
    aiStopped: false,
    signers: [
      {
        signerId: SIGNER_ID,
        roleKey: 'party-a',
        roleLabel: 'Party A',
        signerRole: 'signer',
        routingOrder: 1,
      },
    ],
  };

  const runtime = {
    installed: (name: string) => name === 'kernel' || (name === 'sign' && options.signInstalled),
    modules: () => (options.signInstalled ? ['kernel', 'sign'] : ['kernel']),
    forUser: async <T>(_actor: unknown, fn: (db: never) => Promise<T>) => fn(fakeDb as never),
    query: vi.fn(async (name: string, input: unknown, opts: unknown) => {
      queried.push({ name, input, opts });
      if (name === 'kernel.ai.budget.check_member') return { allowed: true, hasOrgBudget: true };
      if (name === 'sign.envelope.list') {
        return {
          items: [
            {
              id: ENVELOPE_ID,
              title: 'Service Contract',
              status: 'in_progress',
              routingMode: 'sequential',
              sourceKind: 'standalone',
              sourceId: null,
              sourceFileId: FILE_ID,
              inspectStatus: 'passed',
              sealStatus: null,
              certificateCode: null,
              pageCount: 1,
              expiresAt: null,
              sentAt: '2026-11-16T01:05:00.000Z',
              completedAt: null,
              voidedAt: null,
              expiredAt: null,
              version: 2,
              createdBy: USER_ID,
              createdAt: '2026-11-16T01:00:00.000Z',
              updatedAt: '2026-11-16T01:05:00.000Z',
              signerSummary: {
                total: 2,
                signed: 1,
                waitingForMe: true,
              },
            },
          ],
        };
      }
      if (name === 'sign.envelope.by_source') {
        return {
          items: [
            {
              sourceId: FILE_ID,
              envelopeId: ENVELOPE_ID,
              title: 'Quote BG-2026-0001',
              status: 'sent',
              sealStatus: null,
              certificateCode: null,
              completedAt: null,
              signerCount: 1,
              signedCount: 0,
              createdAt: '2026-11-16T01:00:00.000Z',
              updatedAt: '2026-11-16T01:05:00.000Z',
            },
          ],
        };
      }
      if (name === 'sign.envelope.get') {
        return {
          envelope: {
            id: ENVELOPE_ID,
            title: 'Service Contract',
            subject: null,
            message: null,
            status: 'draft',
            routingMode: 'sequential',
            sourceKind: 'standalone',
            sourceId: null,
            sourceFileId: FILE_ID,
            sourceSha256: 'a'.repeat(64),
            inspectStatus: 'pending',
            inspectError: null,
            pageCount: null,
            pageDimensions: {},
            sealedFileId: null,
            sealedSha256: null,
            sealStatus: null,
            certificateFileId: null,
            certificateSha256: null,
            certificateCode: null,
            expiresAt: null,
            sentAt: null,
            completedAt: null,
            declinedAt: null,
            voidedAt: null,
            voidedBy: null,
            voidReason: null,
            expiredAt: null,
            version: 1,
            createdBy: USER_ID,
            createdAt: '2026-11-16T01:00:00.000Z',
            updatedAt: '2026-11-16T01:00:00.000Z',
          },
          signers: [],
          fields: [],
        };
      }
      if (name === 'sign.template.list') return { items: [] };
      if (name === 'sign.template.get') {
        return {
          template: {
            id: TEMPLATE_ID,
            title: 'Service Template',
            description: null,
            routingMode: 'parallel',
            subject: null,
            message: null,
            expiresInHours: null,
            status: 'active',
            inspectStatus: 'passed',
            inspectError: null,
            sourceFileId: FILE_ID,
            sourceSha256: 'a'.repeat(64),
            pageCount: 1,
            pageDimensions: {},
            version: 1,
            archivedAt: null,
            createdBy: USER_ID,
            createdAt: '2026-11-16T01:00:00.000Z',
            updatedAt: '2026-11-16T01:00:00.000Z',
          },
          roles: [],
          fields: [],
          directLink: null,
        };
      }
      if (name === 'sign.ai_analysis.source') return aiSource;
      if (name === 'sign.ai_analysis.get') {
        if (!options.existingAnalysis) return null;
        return {
          id: ANALYSIS_ID,
          orgId: ORG_ID,
          envelopeId: ENVELOPE_ID,
          sourceSha256: 'a'.repeat(64),
          status: 'completed',
          proposedFields: [],
          riskClauses: [],
          summaryText: 'Standard service terms.',
          errorMessage: null,
          promptVersion: 'v1',
          completedAt: '2026-11-16T01:00:00.000Z',
          createdAt: '2026-11-16T01:00:00.000Z',
        };
      }
      return null;
    }),
    execute: vi.fn(async (name: string, input: unknown, opts: unknown) => {
      executed.push({ name, input, opts });
      if (name === 'sign.envelope.create') {
        return { envelopeId: ENVELOPE_ID, status: 'draft', inspectStatus: 'pending', version: 1 };
      }
      if (name === 'sign.envelope.send') {
        return {
          envelopeId: ENVELOPE_ID,
          status: 'sent',
          version: 2,
          links: [{ signerId: SIGNER_ID, tokenId: TOKEN_ID, token: 'tok-send', expiresAt: '2026-11-23T00:00:00.000Z' }],
        };
      }
      if (name === 'sign.signer.create_link') {
        return {
          envelopeId: ENVELOPE_ID,
          signerId: SIGNER_ID,
          tokenId: TOKEN_ID,
          token: 'tok-link',
          expiresAt: '2026-11-23T00:00:00.000Z',
        };
      }
      if (name === 'sign.signer.correct_recipient') {
        return {
          envelopeId: ENVELOPE_ID,
          signerId: SIGNER_ID,
          status: 'pending',
          deliveryMode: 'link',
          version: 3,
          revokedTokens: 1,
          mailStatus: null,
          link: {
            signerId: SIGNER_ID,
            tokenId: TOKEN_ID,
            token: 'T'.repeat(43),
            expiresAt: '2026-11-23T00:00:00.000Z',
          },
        };
      }
      if (name === 'sign.template.create') {
        return { templateId: TEMPLATE_ID, status: 'draft', inspectStatus: 'pending', version: 1 };
      }
      if (name === 'sign.template.instantiate') {
        return { envelopeId: ENVELOPE_ID, status: 'draft', version: 1, links: [] };
      }
      if (name === 'sign.template.direct_link_set' || name === 'sign.template.direct_link_rotate') {
        return {
          templateId: TEMPLATE_ID,
          enabled: true,
          requireEmailOtp: false,
          url: `/-/sign/d#${'A'.repeat(43)}`,
          token: 'A'.repeat(43),
          lastRotatedAt: null,
        };
      }
      if (name === 'sign.envelope.propose_fields' || name === 'sign.ai_analysis.record') {
        return {
          id: ANALYSIS_ID,
          orgId: ORG_ID,
          envelopeId: ENVELOPE_ID,
          sourceSha256: 'a'.repeat(64),
          status: 'completed',
          proposedFields: [],
          riskClauses: [],
          summaryText: 'Confidentiality applies for 24 months.',
          errorMessage: null,
          promptVersion: 'v1',
          completedAt: '2026-11-16T01:00:00.000Z',
          createdAt: '2026-11-16T01:00:00.000Z',
        };
      }
      return {};
    }),
  } as unknown as Runtime;

  const app = createHttpApp({
    config: buildConfig(),
    runtime,
    store: {} as BlobStore,
    authenticate: async () => buildUser(),
    pool: {} as pg.Pool,
    aiEnabled: Boolean(options.signAi),
    aiMeter: () => ({ admit: async () => {}, record: async () => {} }),
    signAi: options.signAi ?? null,
  });

  return { app, executed, queried };
}

async function callRpc(app: ReturnType<typeof createHttpApp>, path: string, json: unknown) {
  return app.request(`/api/rpc${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'x-crove-org': 'acme',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ json }),
  });
}

describe('os.sign RPC handlers (#3325)', () => {
  it('answers 404 when the sign module is not installed', async () => {
    const { app } = createSignTestApp({ signInstalled: false });
    const res = await callRpc(app, '/sign/envelope/list', {});
    expect(res.status).toBe(404);
  });

  it('forwards normal commands with optional idempotencyKey and strictly omits idempotencyKey on send and create_link', async () => {
    const { app, executed, queried } = createSignTestApp({ signInstalled: true });

    const listRes = await callRpc(app, '/sign/envelope/list', {});
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { json: { items: Array<{ id: string; signerSummary: { total: number; signed: number; waitingForMe: boolean } }> } };
    expect(listBody.json.items).toHaveLength(1);
    expect(listBody.json.items[0]?.signerSummary).toEqual({ total: 2, signed: 1, waitingForMe: true });
    expect(queried[0]?.name).toBe('sign.envelope.list');

    const createRes = await callRpc(app, '/sign/envelope/create', {
      title: 'Service Contract',
      routingMode: 'sequential',
      sourceKind: 'standalone',
      sourceFileId: FILE_ID,
      idempotencyKey: KEY_ID,
    });
    expect(createRes.status).toBe(200);
    expect(executed[0]?.name).toBe('sign.envelope.create');
    expect((executed[0]?.opts as Record<string, unknown> | undefined)?.idempotencyKey).toBe(KEY_ID);
    expect(executed[0]?.input).not.toHaveProperty('idempotencyKey');

    const sendRes = await callRpc(app, '/sign/envelope/send', { envelopeId: ENVELOPE_ID });
    expect(sendRes.status).toBe(200);
    expect(executed[1]?.name).toBe('sign.envelope.send');
    expect(executed[1]?.opts).not.toHaveProperty('idempotencyKey');

    const rejectedSend = await callRpc(app, '/sign/envelope/send', {
      envelopeId: ENVELOPE_ID,
      idempotencyKey: KEY_ID,
    });
    expect(rejectedSend.status).toBe(400);

    const linkRes = await callRpc(app, '/sign/signer/create_link', {
      envelopeId: ENVELOPE_ID,
      signerId: SIGNER_ID,
    });
    expect(linkRes.status).toBe(200);
    expect(executed[2]?.name).toBe('sign.signer.create_link');
    expect(executed[2]?.opts).not.toHaveProperty('idempotencyKey');

    const rejectedLink = await callRpc(app, '/sign/signer/create_link', {
      envelopeId: ENVELOPE_ID,
      signerId: SIGNER_ID,
      idempotencyKey: KEY_ID,
    });
    expect(rejectedLink.status).toBe(400);
  });

  it('bridges sign.ai.analyze (off fallback and extracted pages) and sign.ai.get cleanly', async () => {
    const offApp = createSignTestApp({ signInstalled: true, signAi: null });
    const offRes = await callRpc(offApp.app, '/sign/ai/analyze', { envelopeId: ENVELOPE_ID });
    expect(offRes.status).toBe(200);
    expect(await offRes.json()).toMatchObject({
      json: { ai: 'off', status: 'off', analysis: null, proposedFields: [], riskClauses: [], summaryText: null },
    });

    const reader = new SignAiReader(
      { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' },
      {
        fieldPropose: async () => ({
          output: {
            fields: [
              {
                signerRoleKey: 'party-a',
                fieldType: 'signature',
                pageNumber: 1,
                xNorm: 0.6,
                yNorm: 0.72,
                wNorm: 0.24,
                hNorm: 0.08,
                label: 'Party A',
                confidence: 0.9,
              },
            ],
          },
          usage: { inputTokens: 40, outputTokens: 15 },
        }),
        clauseSummary: async () => ({
          output: {
            summaryText: 'Confidentiality applies for 24 months.',
            riskClauses: [],
          },
          usage: { inputTokens: 40, outputTokens: 15 },
        }),
      },
    );
    const aiApp = createSignTestApp({ signInstalled: true, signAi: reader, existingAnalysis: true });
    const analyzeRes = await callRpc(aiApp.app, '/sign/ai/analyze', {
      envelopeId: ENVELOPE_ID,
      pages: [{ page: 1, text: 'Party A agrees to sign here.' }],
    });
    expect(analyzeRes.status).toBe(200);
    expect(await analyzeRes.json()).toMatchObject({
      json: { ai: 'used', status: 'completed', summaryText: 'Confidentiality applies for 24 months.' },
    });
    expect(aiApp.executed.some((entry) => entry.name === 'sign.envelope.propose_fields')).toBe(true);

    const getRes = await callRpc(aiApp.app, '/sign/ai/get', { envelopeId: ENVELOPE_ID });
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({
      json: { id: ANALYSIS_ID, status: 'completed', summaryText: 'Standard service terms.' },
    });
  });

  it('normalizes empty pageDimensions object on sign.envelope.get to null before contract validation', async () => {
    const { app } = createSignTestApp({ signInstalled: true });
    const res = await callRpc(app, '/sign/envelope/get', { envelopeId: ENVELOPE_ID });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { envelope: { pageDimensions: unknown } } };
    expect(body.json.envelope.pageDimensions).toBeNull();
  });

  it('routes sign.envelope.by_source through inSign and returns 404 when sign is not installed', async () => {
    const offApp = createSignTestApp({ signInstalled: false });
    const offRes = await callRpc(offApp.app, '/sign/envelope/by_source', {
      sourceKind: 'crm_quote',
      sourceIds: [FILE_ID],
    });
    expect(offRes.status).toBe(404);

    const onApp = createSignTestApp({ signInstalled: true });
    const onRes = await callRpc(onApp.app, '/sign/envelope/by_source', {
      sourceKind: 'crm_quote',
      sourceIds: [FILE_ID],
    });
    expect(onRes.status).toBe(200);
    expect(onApp.queried.some((q) => q.name === 'sign.envelope.by_source')).toBe(true);
    expect(await onRes.json()).toMatchObject({
      json: {
        items: [
          {
            sourceId: FILE_ID,
            envelopeId: ENVELOPE_ID,
            status: 'sent',
            signerCount: 1,
            signedCount: 0,
          },
        ],
      },
    });
  });

  it('wires os.sign.template.* routes, module gate, pageDimensions normalization, and noIdempotency commands', async () => {
    const { app: disabledApp } = createSignTestApp({ signInstalled: false });
    const offRes = await callRpc(disabledApp, '/sign/template/list', {});
    expect(offRes.status).toBe(404);

    const { app, executed } = createSignTestApp({ signInstalled: true });
    const listRes = await callRpc(app, '/sign/template/list', {});
    expect(listRes.status).toBe(200);

    const getRes = await callRpc(app, '/sign/template/get', { templateId: TEMPLATE_ID });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { json: { template: { pageDimensions: unknown } } };
    expect(getBody.json.template.pageDimensions).toBeNull();

    const directRes = await callRpc(app, '/sign/template/direct_link_set', {
      templateId: TEMPLATE_ID,
      enabled: true,
    });
    expect(directRes.status).toBe(200);
    expect(executed.at(-1)).toMatchObject({
      name: 'sign.template.direct_link_set',
      opts: { actor: { type: 'user', userId: USER_ID }, orgId: ORG_ID },
    });

    const rejectedSet = await callRpc(app, '/sign/template/direct_link_set', {
      templateId: TEMPLATE_ID,
      enabled: true,
      idempotencyKey: KEY_ID,
    });
    expect(rejectedSet.status).toBe(400);

    const rejectedRotate = await callRpc(app, '/sign/template/direct_link_rotate', {
      templateId: TEMPLATE_ID,
      idempotencyKey: KEY_ID,
    });
    expect(rejectedRotate.status).toBe(400);

    const rejectedInst = await callRpc(app, '/sign/template/instantiate', {
      templateId: TEMPLATE_ID,
      recipients: [],
      idempotencyKey: KEY_ID,
    });
    expect(rejectedInst.status).toBe(400);
  });

  it('wires os.sign.signer.correct_recipient with module gate and noIdempotency, and maps POST /api/sign/delegate HTTP responses (#3819)', async () => {
    const { app: disabledApp } = createSignTestApp({ signInstalled: false });
    const offCorrect = await callRpc(disabledApp, '/sign/signer/correct_recipient', {
      envelopeId: ENVELOPE_ID,
      signerId: SIGNER_ID,
      name: 'Nguyen Van Moi',
      email: 'moi@example.com',
      deliveryMode: 'link',
    });
    expect(offCorrect.status).toBe(404);

    const offDelegate = await disabledApp.request('/api/sign/delegate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'A'.repeat(43),
        delegateName: 'Tran Thi Uy Quyen',
        delegateEmail: 'delegate@example.com',
        reason: 'Di cong tac',
      }),
    });
    expect(offDelegate.status).toBe(404);

    const { app, executed } = createSignTestApp({ signInstalled: true });
    const okCorrect = await callRpc(app, '/sign/signer/correct_recipient', {
      envelopeId: ENVELOPE_ID,
      signerId: SIGNER_ID,
      name: 'Nguyen Van Moi',
      email: 'moi@example.com',
      deliveryMode: 'link',
    });
    expect(okCorrect.status).toBe(200);
    expect(executed.at(-1)).toMatchObject({
      name: 'sign.signer.correct_recipient',
      opts: { actor: { type: 'user', userId: USER_ID }, orgId: ORG_ID },
    });

    const rejectedCorrectIdem = await callRpc(app, '/sign/signer/correct_recipient', {
      envelopeId: ENVELOPE_ID,
      signerId: SIGNER_ID,
      name: 'Nguyen Van Moi',
      email: 'moi@example.com',
      deliveryMode: 'link',
      idempotencyKey: KEY_ID,
    });
    expect(rejectedCorrectIdem.status).toBe(400);

    // Build an HTTP app with a programmable orgless executor to test POST /api/sign/delegate edge outcomes.
    let nextResolved: unknown = {
      orgId: ORG_ID,
      orgName: 'Acme',
      envelopeId: ENVELOPE_ID,
      signerId: SIGNER_ID,
      tokenId: TOKEN_ID,
      tokenUsed: false,
      envelopeStatus: 'sent',
      signerStatus: 'pending',
      signerRole: 'signer',
      routingOrder: 1,
      minPendingOrder: 1,
      requireEmailOtp: false,
      otpVerified: false,
      allowDelegation: true,
      delegationCount: 0,
      delegatedFromName: null,
      title: 'Service Contract',
      message: null,
      signerName: 'Signer One',
      roleLabel: 'Party A',
      expiresAt: '2027-02-01T00:00:00.000Z',
      pageCount: 1,
      pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842 }],
      sourceFileId: FILE_ID,
      fields: [],
    };
    let nextDelegateRow: unknown = {
      status: 'ok',
      signerId: SIGNER_ID,
      delegateName: 'Tran Thi Uy Quyen',
      maskedDelegateEmail: 'd***e@example.com',
      delegationCount: 1,
      delegatedAt: '2026-11-21T10:00:00.000Z',
    };

    const orglessDb = {
      getExecutor: () => ({
        transformQuery: (node: unknown) => node,
        compileQuery: (node: unknown) => ({ query: node, sql: JSON.stringify(node), parameters: [] }),
        executeQuery: async (compiled: { sql: string }) => {
          if (compiled.sql.includes('public_token_resolve')) {
            return { rows: [{ resolved: nextResolved }] };
          }
          if (compiled.sql.includes('public_delegate')) {
            return { rows: [{ result: nextDelegateRow }] };
          }
          return { rows: [] };
        },
      }),
    };

    const delegateRuntime = {
      installed: (name: string) => name === 'kernel' || name === 'sign',
      modules: () => ['kernel', 'sign'],
      orgless: async <T>(fn: (db: never) => Promise<T>) => fn(orglessDb as never),
    } as unknown as Runtime;

    const delegateApp = createHttpApp({
      config: buildConfig(),
      runtime: delegateRuntime,
      store: {} as BlobStore,
      authenticate: async () => buildUser(),
      pool: {} as pg.Pool,
      aiEnabled: false,
      aiMeter: () => ({ admit: async () => {}, record: async () => {} }),
    });

    const postDelegate = (body: unknown, ip = '203.0.113.55') =>
      delegateApp.request('/api/sign/delegate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify(body),
      });

    // 1. Success -> 200
    const res200 = await postDelegate({
      token: 'B'.repeat(43),
      delegateName: 'Tran Thi Uy Quyen',
      delegateEmail: 'delegate@example.com',
      reason: 'Di cong tac tuan nay',
    });
    expect(res200.status).toBe(200);
    expect(await res200.json()).toEqual({
      signerId: SIGNER_ID,
      delegateName: 'Tran Thi Uy Quyen',
      maskedDelegateEmail: 'd***e@example.com',
      delegationCount: 1,
      delegatedAt: '2026-11-21T10:00:00.000Z',
    });

    // 2. Malformed token -> 404 SIGN_LINK_INVALID
    const res404 = await postDelegate({
      token: 'short-token',
      delegateName: 'Tran Thi Uy Quyen',
      delegateEmail: 'delegate@example.com',
      reason: 'Di cong tac',
    });
    expect(res404.status).toBe(404);

    // 3. Domain errors mapped to HTTP statuses (403 OTP, 403 disabled, 409 limit, 422 same email, 409 already used)
    nextDelegateRow = {
      status: 'error',
      code: 'SIGN_OTP_REQUIRED',
      httpStatus: 403,
      message: 'Email OTP verification is required before delegating',
    };
    expect(
      (
        await postDelegate({
          token: 'C'.repeat(43),
          delegateName: 'Tran Thi Uy Quyen',
          delegateEmail: 'delegate@example.com',
          reason: 'Di cong tac',
        })
      ).status,
    ).toBe(403);

    nextDelegateRow = {
      status: 'error',
      code: 'SIGN_DELEGATION_DISABLED',
      httpStatus: 403,
      message: 'Delegation is not enabled for this envelope',
    };
    const resDisabled = await postDelegate({
      token: 'D'.repeat(43),
      delegateName: 'Tran Thi Uy Quyen',
      delegateEmail: 'delegate@example.com',
      reason: 'Di cong tac',
    });
    expect(resDisabled.status).toBe(403);
    expect(await resDisabled.json()).toMatchObject({ code: 'SIGN_DELEGATION_DISABLED' });

    nextDelegateRow = {
      status: 'error',
      code: 'SIGN_DELEGATION_LIMIT_REACHED',
      httpStatus: 409,
      message: 'This signer slot has reached the maximum of 2 delegations',
    };
    const resLimit = await postDelegate({
      token: 'E'.repeat(43),
      delegateName: 'Tran Thi Uy Quyen',
      delegateEmail: 'delegate@example.com',
      reason: 'Di cong tac',
    });
    expect(resLimit.status).toBe(409);
    expect(await resLimit.json()).toMatchObject({ code: 'SIGN_DELEGATION_LIMIT_REACHED' });

    nextDelegateRow = { status: 'already_used' };
    const resUsed = await postDelegate({
      token: 'F'.repeat(43),
      delegateName: 'Tran Thi Uy Quyen',
      delegateEmail: 'delegate@example.com',
      reason: 'Di cong tac',
    });
    expect(resUsed.status).toBe(409);
    expect(await resUsed.json()).toMatchObject({ code: 'SIGN_ALREADY_SUBMITTED' });
  });
});

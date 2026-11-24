// SPDX-License-Identifier: AGPL-3.0-only
// Authenticated oRPC wiring tests for os.sign (#3325): module gate, noIdempotency commands, and Vy AI analyze/get routing.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { SignAiReader } from '@ludy/agent';
import type { BlobStore, Runtime } from '@ludy/kernel-runtime';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { SIGN_ATTACHMENT_MAX_BYTES, verifySignAttachmentBytes } from '../src/sign-link.ts';

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
      if (name === 'sign.drafter.ai_source') return { aiStopped: false };
      if (name === 'sign.vault.search') {
        return {
          items: [
            {
              envelopeId: ENVELOPE_ID,
              title: 'Service Contract',
              status: 'completed',
              sourceKind: 'standalone',
              pageCount: 1,
              completedAt: '2026-11-16T01:05:00.000Z',
              updatedAt: '2026-11-16T01:05:00.000Z',
              counterpartyName: 'Acme Partner',
              effectiveDate: '2026-12-01',
              expiryDate: '2027-11-30',
              renewalNoticeDays: 30,
              autoRenew: true,
              contractValue: '24000000',
              currency: 'VND',
              score: 20,
              snippets: [
                {
                  kind: 'clause',
                  pageNumber: 1,
                  excerpt: 'Confidentiality applies for 24 months.',
                },
              ],
            },
          ],
        };
      }
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

  it('verifies signer supporting attachment magic bytes and structure (PDF/PNG/JPEG only, <= 10 MB) (#3818)', () => {
    const validPdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    const validPng = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    // Minimal valid baseline JPEG: SOI (FF D8), APP0 JFIF (FF E0), SOF0 1x1 (FF C0), SOS + 1 byte + EOI (FF D9).
    const validJpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
      0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00,
      0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0xff, 0xd9,
    ]);

    expect(verifySignAttachmentBytes(validPdf)).toBe('application/pdf');
    expect(verifySignAttachmentBytes(validPng)).toBe('image/png');
    expect(verifySignAttachmentBytes(validJpeg)).toBe('image/jpeg');

    // Reject empty, truncated, active-content SVG/HTML/XML, ZIP/Office, GIF, PE/EXE, and > 10 MB payloads.
    expect(verifySignAttachmentBytes(new Uint8Array(0))).toBeNull();
    expect(verifySignAttachmentBytes(new TextEncoder().encode('%PDF-1.4\ntruncated without eof'))).toBeNull();
    expect(verifySignAttachmentBytes(validPng.subarray(0, validPng.byteLength - 8))).toBeNull();
    expect(verifySignAttachmentBytes(validJpeg.subarray(0, validJpeg.byteLength - 2))).toBeNull();
    expect(
      verifySignAttachmentBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
    ).toBeNull();
    expect(verifySignAttachmentBytes(new TextEncoder().encode('<!doctype html><html><body>hi</body></html>'))).toBeNull();
    expect(verifySignAttachmentBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]))).toBeNull();
    expect(verifySignAttachmentBytes(new TextEncoder().encode('GIF89a\u0001\u0000\u0001\u0000'))).toBeNull();
    expect(verifySignAttachmentBytes(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]))).toBeNull();

    const oversizedPdf = new Uint8Array(SIGN_ATTACHMENT_MAX_BYTES + 1);
    oversizedPdf.set(validPdf, 0);
    expect(verifySignAttachmentBytes(oversizedPdf)).toBeNull();

    // Android Motion Photo JPEGs (and Samsung MotionPhoto_Data trailers) append an MP4 track after EOI (#4331, #4394).
    const mp4Box = (type: string, body: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + body.byteLength);
      const size = out.byteLength;
      out[0] = (size >>> 24) & 0xff;
      out[1] = (size >>> 16) & 0xff;
      out[2] = (size >>> 8) & 0xff;
      out[3] = size & 0xff;
      out.set(new TextEncoder().encode(type), 4);
      out.set(body, 8);
      return out;
    };
    const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
      const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.byteLength;
      }
      return out;
    };
    const makeMotionPhotoMp4 = (opts?: { handler?: string; majorBrand?: string; omitMoov?: boolean }) => {
      const brand = opts?.majorBrand ?? 'mp42';
      const handler = opts?.handler ?? 'vide';
      const ftyp = mp4Box(
        'ftyp',
        new TextEncoder().encode(`${brand}\u0000\u0000\u0000\u0000mp42isom`),
      );
      const hdlrBody = new Uint8Array(12);
      hdlrBody.set(new TextEncoder().encode(handler), 8);
      const hdlr = mp4Box('hdlr', hdlrBody);
      const mdia = mp4Box('mdia', hdlr);
      const trak = mp4Box('trak', mdia);
      const moov = mp4Box('moov', trak);
      const mdat = mp4Box('mdat', new Uint8Array([0x00, 0x00, 0x00, 0x01]));
      return opts?.omitMoov ? concatBytes(ftyp, mdat) : concatBytes(ftyp, mdat, moov);
    };

    const validMotionMp4 = makeMotionPhotoMp4();
    const androidMotionPhoto = concatBytes(validJpeg, validMotionMp4);
    const samsungMotionPhoto = concatBytes(validJpeg, new TextEncoder().encode('MotionPhoto_Data'), validMotionMp4);
    const zeroPaddedJpeg = concatBytes(validJpeg, new Uint8Array(16));
    expect(verifySignAttachmentBytes(androidMotionPhoto)).toBe('image/jpeg');
    expect(verifySignAttachmentBytes(samsungMotionPhoto)).toBe('image/jpeg');
    expect(verifySignAttachmentBytes(zeroPaddedJpeg)).toBe('image/jpeg');

    // Reject polyglot/corrupt trailers after EOI and EXIF-thumbnail EOI masquerading as frame EOI.
    expect(
      verifySignAttachmentBytes(concatBytes(validJpeg, new TextEncoder().encode('<script>alert(1)</script>'))),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(concatBytes(validJpeg, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(concatBytes(androidMotionPhoto, new TextEncoder().encode('<svg/>'))),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(concatBytes(validJpeg, makeMotionPhotoMp4({ handler: 'soun' }))),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(concatBytes(validJpeg, makeMotionPhotoMp4({ omitMoov: true }))),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(concatBytes(validJpeg, makeMotionPhotoMp4({ majorBrand: 'M4A ' }))),
    ).toBeNull();

    // Truncated JPEG whose APP1 EXIF segment embeds FF D9 near the tail must be rejected.
    const fakeExifPayload = new Uint8Array([
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00, 0x00, 0x00,
    ]);
    const truncatedExifJpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xe1, 0x00, fakeExifPayload.byteLength + 2, ...fakeExifPayload,
    ]);
    expect(verifySignAttachmentBytes(truncatedExifJpeg)).toBeNull();

    // Progressive multi-scan JPEG (SOF2 + DHT + two SOS scans + EOI) is accepted (#4331, #4394).
    const progressiveJpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x12, 0xff, 0x00, 0x34,
      0xff, 0xc4, 0x00, 0x04, 0x10, 0x00,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3f, 0x00, 0x56,
      0xff, 0xd9,
    ]);
    expect(verifySignAttachmentBytes(progressiveJpeg)).toBe('image/jpeg');
  });

  it('wires os.sign.vault.search and os.sign.vault.ask with AI-off parity and metered AI-on citations (#4439)', async () => {
    const { app: appOff, queried: queriedOff } = createSignTestApp({ signInstalled: true, signAi: null });
    const searchRes = await callRpc(appOff, '/sign/vault/search', { question: 'Confidentiality' });
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as { json: { items: Array<{ envelopeId: string }> } };
    expect(searchJson.json.items.map((x) => x.envelopeId)).toEqual([ENVELOPE_ID]);
    expect(queriedOff.some((q) => q.name === 'sign.vault.search')).toBe(true);

    const askOffRes = await callRpc(appOff, '/sign/vault/ask', { question: 'Confidentiality' });
    expect(askOffRes.status).toBe(200);
    const askOffJson = (await askOffRes.json()) as { json: { ai: string; items: unknown[]; summary: unknown } };
    expect(askOffJson.json.ai).toBe('off');
    expect(askOffJson.json.summary).toBeNull();
    expect(askOffJson.json.items).toHaveLength(1);

    const vaultReader = new SignAiReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test' },
      {
        vaultQa: async () => ({
          output: {
            answer: 'Service Contract includes a 24 months confidentiality clause.',
            citations: [
              {
                envelopeId: ENVELOPE_ID,
                pageNumber: 1,
                quoteExcerpt: 'Confidentiality applies for 24 months.',
              },
            ],
          },
        }),
      },
    );
    const { app: appOn } = createSignTestApp({ signInstalled: true, signAi: vaultReader });
    const askOnRes = await callRpc(appOn, '/sign/vault/ask', { question: 'Confidentiality' });
    expect(askOnRes.status).toBe(200);
    const askOnJson = (await askOnRes.json()) as {
      json: {
        ai: string;
        summary: {
          answer: string;
          proposedByAi: boolean;
          citations: Array<{ envelopeId: string; pageNumber: number; quoteExcerpt: string }>;
        } | null;
      };
    };
    expect(askOnJson.json.ai).toBe('used');
    expect(askOnJson.json.summary).toEqual({
      answer: 'Service Contract includes a 24 months confidentiality clause.',
      proposedByAi: true,
      citations: [
        {
          envelopeId: ENVELOPE_ID,
          envelopeTitle: 'Service Contract',
          pageNumber: 1,
          quoteExcerpt: 'Confidentiality applies for 24 months.',
        },
      ],
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Authenticated oRPC wiring tests for os.sign (#3325): module gate, noIdempotency commands, and Vy AI analyze/get routing.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { Hono } from 'hono';
import { SignAiReader } from '@ludy/agent';
import { sha256Hex, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { PDF_STREAM_LEASE_MS, PUBLIC_PDF_STREAM_LEASE_MS, createHttpApp, releaseOnResponseClose } from '../src/http.ts';
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

const WEB_DIST = mkdtempSync(join(tmpdir(), 'ludy-sign-rpc-'));
writeFileSync(join(WEB_DIST, 'index.html'), '<!doctype html><title>Ludy</title>');

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
    AUTH_ISSUER: 'ludy-auth',
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
      if (name === 'kernel.ai.budget.reserve_member') {
        return { allowed: true, reservationId: '00000000-0000-7000-8000-000000000101' };
      }
      if (name === 'kernel.ai.usage.record_member') return { recorded: true };
      if (name === 'kernel.ai.budget.release_member') return { released: true };
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
      'x-ludy-org': 'acme',
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
    const paddedMotionPhoto = concatBytes(validJpeg, new Uint8Array(16), validMotionMp4);
    const paddedSamsungMotionPhoto = concatBytes(
      validJpeg,
      new Uint8Array(16),
      new TextEncoder().encode('MotionPhoto_Data'),
      validMotionMp4,
    );
    const zeroPaddedJpeg = concatBytes(validJpeg, new Uint8Array(16));
    expect(verifySignAttachmentBytes(androidMotionPhoto)).toBe('image/jpeg');
    expect(verifySignAttachmentBytes(samsungMotionPhoto)).toBe('image/jpeg');
    expect(verifySignAttachmentBytes(paddedMotionPhoto)).toBe('image/jpeg');
    expect(verifySignAttachmentBytes(paddedSamsungMotionPhoto)).toBe('image/jpeg');
    expect(verifySignAttachmentBytes(zeroPaddedJpeg)).toBe('image/jpeg');

    // Samsung Galaxy SEF (SEFH/SEFT) Motion Photo trailer + optional companion metadata (#4682).
    const makeSamsungSefTrailer = (
      chunks: ReadonlyArray<{ readonly typeWord: number; readonly key: string; readonly payload: Uint8Array }>,
      opts?: { readonly overrideSefSize?: number; readonly overrideVersion?: number; readonly preChunkPad?: Uint8Array },
    ): Uint8Array => {
      const le32 = (val: number): Uint8Array => {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, val, true);
        return b;
      };
      const enc = new TextEncoder();
      const builtChunks: Uint8Array[] = [];
      let totalDataBytes = 0;
      for (const c of chunks) {
        const keyBytes = enc.encode(c.key);
        const rawChunk = concatBytes(le32(c.typeWord), le32(keyBytes.byteLength), keyBytes, c.payload);
        builtChunks.push(rawChunk);
        totalDataBytes += rawChunk.byteLength;
      }
      const sefhPos = totalDataBytes;
      const dirParts: Uint8Array[] = [enc.encode('SEFH'), le32(opts?.overrideVersion ?? 101), le32(chunks.length)];
      let cursor = 0;
      for (let i = 0; i < chunks.length; i += 1) {
        const rawChunk = builtChunks[i]!;
        dirParts.push(le32(chunks[i]!.typeWord), le32(sefhPos - cursor), le32(rawChunk.byteLength));
        cursor += rawChunk.byteLength;
      }
      const sefDir = concatBytes(...dirParts);
      const declaredSize = opts?.overrideSefSize ?? sefDir.byteLength;
      return concatBytes(
        opts?.preChunkPad ?? new Uint8Array(0),
        ...builtChunks,
        sefDir,
        le32(declaredSize),
        enc.encode('SEFT'),
      );
    };
    const samsungSefTrailer = makeSamsungSefTrailer([
      { typeWord: 0x0a30_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 },
      { typeWord: 0x0a01_0000, key: 'Image_UTC_Data', payload: new TextEncoder().encode('1732520000000') },
    ]);
    expect(verifySignAttachmentBytes(concatBytes(validJpeg, samsungSefTrailer))).toBe('image/jpeg');
    expect(verifySignAttachmentBytes(concatBytes(validJpeg, new Uint8Array(16), samsungSefTrailer))).toBe('image/jpeg');

    // Reject tampered/polyglot/metadata-only Samsung SEFT trailers (#4682).
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer([{ typeWord: 0x0a01_0000, key: 'Image_UTC_Data', payload: new TextEncoder().encode('12345') }]),
        ),
      ),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer([
            { typeWord: 0x0a30_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 },
            { typeWord: 0x0a01_0000, key: 'Image_UTC_Data', payload: new TextEncoder().encode('<script>alert(1)</script>') },
          ]),
        ),
      ),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer(
            [{ typeWord: 0x0a30_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 }],
            { overrideSefSize: 20 },
          ),
        ),
      ),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer(
            [{ typeWord: 0x0a30_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 }],
            { preChunkPad: new TextEncoder().encode('<svg/>') },
          ),
        ),
      ),
    ).toBeNull();
    // Reject unrecognized SEF entry names, mismatched typeWord (including BackupRestore_Data 0x0a41), non-timestamp Image_UTC_Data, and wrong MotionPhoto typeWord.
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer([
            { typeWord: 0x0a30_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 },
            { typeWord: 0x0a41_0000, key: 'Unknown_Arbitrary_Tag', payload: new TextEncoder().encode('hello') },
          ]),
        ),
      ),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer([
            { typeWord: 0x0a30_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 },
            { typeWord: 0x0a41_0000, key: 'Image_UTC_Data', payload: new TextEncoder().encode('1732520000000') },
          ]),
        ),
      ),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer([
            { typeWord: 0x0a30_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 },
            { typeWord: 0x0a41, key: 'Image_UTC_Data', payload: new TextEncoder().encode('1732520000000') },
          ]),
        ),
      ),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer([
            { typeWord: 0x0a30_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 },
            { typeWord: 0x0001_0000, key: 'Image_UTC_Data', payload: new TextEncoder().encode('1732520000000') },
          ]),
        ),
      ),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer([
            { typeWord: 0x0a30_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 },
            { typeWord: 0x0a01_0000, key: 'Image_UTC_Data', payload: new TextEncoder().encode('not-epoch-ts') },
          ]),
        ),
      ),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          validJpeg,
          makeSamsungSefTrailer([{ typeWord: 0x0a41_0000, key: 'MotionPhoto_Data', payload: validMotionMp4 }]),
        ),
      ),
    ).toBeNull();

    // Reject > 64 zero bytes before Motion Photo MP4 and trailing garbage after padded Motion Photo MP4 (#4394).
    expect(verifySignAttachmentBytes(concatBytes(validJpeg, new Uint8Array(65), validMotionMp4))).toBeNull();
    expect(verifySignAttachmentBytes(concatBytes(validJpeg, new Uint8Array(65)))).toBeNull();
    expect(
      verifySignAttachmentBytes(
        concatBytes(validJpeg, new Uint8Array(16), validMotionMp4, new TextEncoder().encode('<script/>')),
      ),
    ).toBeNull();

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

    // Android Ultra HDR JPEGs (MPF APP2 and/or XMP GContainer APP1 GainMap) + optional Motion Photo trailer (#4394).
    const makeMpfApp2Segment = (
      primarySizePlaceholder: number,
      gainMapRelOffset: number,
      gainMapSize: number,
      littleEndian = true,
    ): Uint8Array => {
      // Body: "MPF\0" (4) + TIFF header (8) + IFD count(2) + 2 entries(24) + nextIfd(4) + 2 MP entries(32) = 74 bytes.
      const body = new Uint8Array(74);
      const view = new DataView(body.buffer);
      body.set([0x4d, 0x50, 0x46, 0x00], 0);
      body.set(littleEndian ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a], 4);
      view.setUint32(8, 8, littleEndian); // firstIfdOffset relative to tiffStart (byte 4)
      const ifdBase = 12;
      view.setUint16(ifdBase, 2, littleEndian);
      // Tag 0xB001: NumberOfImages = 2 (LONG=4, count=1)
      view.setUint16(ifdBase + 2, 0xb001, littleEndian);
      view.setUint16(ifdBase + 4, 4, littleEndian);
      view.setUint32(ifdBase + 6, 1, littleEndian);
      view.setUint32(ifdBase + 10, 2, littleEndian);
      // Tag 0xB002: MPEntry (UNDEFINED=7, count=32, offset=38 from tiffStart -> byte 42)
      view.setUint16(ifdBase + 14, 0xb002, littleEndian);
      view.setUint16(ifdBase + 16, 7, littleEndian);
      view.setUint32(ifdBase + 18, 32, littleEndian);
      view.setUint32(ifdBase + 22, 38, littleEndian);
      view.setUint32(ifdBase + 26, 0, littleEndian);
      // MP Entry 0 (primary: dataOffset = 0)
      const mpBase = 42;
      view.setUint32(mpBase + 4, primarySizePlaceholder, littleEndian);
      view.setUint32(mpBase + 8, 0, littleEndian);
      // MP Entry 1 (gainMap: size and offset relative to tiffStart)
      view.setUint32(mpBase + 20, gainMapSize, littleEndian);
      view.setUint32(mpBase + 24, gainMapRelOffset, littleEndian);

      const seg = new Uint8Array(4 + body.byteLength);
      seg[0] = 0xff;
      seg[1] = 0xe2;
      const segLen = 2 + body.byteLength;
      seg[2] = (segLen >>> 8) & 0xff;
      seg[3] = segLen & 0xff;
      seg.set(body, 4);
      return seg;
    };

    const makeXmpApp1Segment = (xml: string): Uint8Array => {
      const hdr = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
      const body = concatBytes(hdr, new TextEncoder().encode(xml));
      const seg = new Uint8Array(4 + body.byteLength);
      seg[0] = 0xff;
      seg[1] = 0xe1;
      const segLen = 2 + body.byteLength;
      seg[2] = (segLen >>> 8) & 0xff;
      seg[3] = segLen & 0xff;
      seg.set(body, 4);
      return seg;
    };

    const primaryTailAfterSoi = validJpeg.subarray(2);
    const buildMpfUltraHdr = (opts?: { littleEndian?: boolean; declaredGainMapLen?: number; gapBytes?: Uint8Array }) => {
      const le = opts?.littleEndian ?? true;
      const gap = opts?.gapBytes ?? new Uint8Array(0);
      const dummyMpf = makeMpfApp2Segment(0, 0, 0, le);
      // Primary structure: SOI(2) + APP2(dummyMpf) + primaryTailAfterSoi; tiffStart is at file offset 2 + 4 + 4 = 10.
      const primaryLen = 2 + dummyMpf.byteLength + primaryTailAfterSoi.byteLength;
      const gainMapRelOffset = primaryLen + gap.byteLength - 10;
      const gainMapSize = opts?.declaredGainMapLen ?? validJpeg.byteLength;
      const mpfSeg = makeMpfApp2Segment(primaryLen, gainMapRelOffset, gainMapSize, le);
      return concatBytes(new Uint8Array([0xff, 0xd8]), mpfSeg, primaryTailAfterSoi, gap, validJpeg);
    };

    const xmpXml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${validJpeg.byteLength}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const xmpSeg = makeXmpApp1Segment(xmpXml);
    const xmpUltraHdrJpeg = concatBytes(new Uint8Array([0xff, 0xd8]), xmpSeg, primaryTailAfterSoi, validJpeg);

    const mpfUltraHdrLe = buildMpfUltraHdr({ littleEndian: true });
    const mpfUltraHdrBe = buildMpfUltraHdr({ littleEndian: false });
    expect(verifySignAttachmentBytes(mpfUltraHdrLe)).toBe('image/jpeg');
    expect(verifySignAttachmentBytes(mpfUltraHdrBe)).toBe('image/jpeg');
    expect(verifySignAttachmentBytes(xmpUltraHdrJpeg)).toBe('image/jpeg');
    // Combined Ultra HDR + Motion Photo MP4 trailer.
    expect(verifySignAttachmentBytes(concatBytes(xmpUltraHdrJpeg, new Uint8Array(8), validMotionMp4))).toBe(
      'image/jpeg',
    );
    expect(verifySignAttachmentBytes(concatBytes(mpfUltraHdrLe, validMotionMp4))).toBe('image/jpeg');

    // Reject undeclared appended second JPEG (no MPF or XMP GainMap declaration).
    expect(verifySignAttachmentBytes(concatBytes(validJpeg, validJpeg))).toBeNull();
    // Reject mismatched MPF length (shorter/longer than GainMap JPEG) and trailing garbage after GainMap.
    expect(
      verifySignAttachmentBytes(buildMpfUltraHdr({ declaredGainMapLen: validJpeg.byteLength - 4 })),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(buildMpfUltraHdr({ declaredGainMapLen: validJpeg.byteLength + 10 })),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(concatBytes(mpfUltraHdrLe, new TextEncoder().encode('<script>alert(1)</script>'))),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(concatBytes(xmpUltraHdrJpeg, new TextEncoder().encode('garbage'))),
    ).toBeNull();
    expect(
      verifySignAttachmentBytes(buildMpfUltraHdr({ gapBytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) })),
    ).toBeNull();
    // Reject malformed XMP GainMap declaring a non-JPEG Mime type.
    const badXmpSeg = makeXmpApp1Segment(xmpXml.replace('Item:Semantic="GainMap" Item:Mime="image/jpeg"', 'Item:Semantic="GainMap" Item:Mime="image/png"'));
    expect(
      verifySignAttachmentBytes(concatBytes(new Uint8Array([0xff, 0xd8]), badXmpSeg, primaryTailAfterSoi, validJpeg)),
    ).toBeNull();

    // Reject unclosed repeated <Container:Item tokens across multiple 60 KB XMP APP1 segments in linear time (ReDoS guard).
    const redosXmpSeg = makeXmpApp1Segment('<Container:Item '.repeat(4000));
    const redosJpeg = concatBytes(
      new Uint8Array([0xff, 0xd8]),
      redosXmpSeg,
      redosXmpSeg,
      redosXmpSeg,
      redosXmpSeg,
      primaryTailAfterSoi,
      validJpeg,
    );
    const redosStartMs = performance.now();
    expect(verifySignAttachmentBytes(redosJpeg)).toBeNull();
    expect(performance.now() - redosStartMs).toBeLessThan(2000);

    // Enforce JPEG_MAX_XMP_APP1_SEGMENTS = 4 cap across standard XMP APP1 segments.
    const benignXmpSeg = makeXmpApp1Segment('<x:xmpmeta/>');
    expect(
      verifySignAttachmentBytes(
        concatBytes(new Uint8Array([0xff, 0xd8]), benignXmpSeg, benignXmpSeg, benignXmpSeg, benignXmpSeg, primaryTailAfterSoi),
      ),
    ).toBe('image/jpeg');
    expect(
      verifySignAttachmentBytes(
        concatBytes(
          new Uint8Array([0xff, 0xd8]),
          benignXmpSeg,
          benignXmpSeg,
          benignXmpSeg,
          benignXmpSeg,
          benignXmpSeg,
          primaryTailAfterSoi,
        ),
      ),
    ).toBeNull();

    // Reject duplicate 0xB001 or 0xB002 tags inside the same MPF Index IFD.
    const makeDupTagMpfJpeg = (dupTag: 0xb001 | 0xb002): Uint8Array => {
      const body = new Uint8Array(86);
      const view = new DataView(body.buffer);
      body.set([0x4d, 0x50, 0x46, 0x00, 0x49, 0x49, 0x2a, 0x00], 0);
      view.setUint32(8, 8, true);
      const ifdBase = 12;
      view.setUint16(ifdBase, 3, true);
      const writeTag = (slot: number, tag: number) => {
        const at = ifdBase + 2 + slot * 12;
        if (tag === 0xb001) {
          view.setUint16(at, 0xb001, true);
          view.setUint16(at + 2, 4, true);
          view.setUint32(at + 4, 1, true);
          view.setUint32(at + 8, 2, true);
        } else {
          view.setUint16(at, 0xb002, true);
          view.setUint16(at + 2, 7, true);
          view.setUint32(at + 4, 32, true);
          view.setUint32(at + 8, 50, true);
        }
      };
      if (dupTag === 0xb001) {
        writeTag(0, 0xb001);
        writeTag(1, 0xb001);
        writeTag(2, 0xb002);
      } else {
        writeTag(0, 0xb001);
        writeTag(1, 0xb002);
        writeTag(2, 0xb002);
      }
      view.setUint32(ifdBase + 2 + 3 * 12, 0, true);
      const seg = new Uint8Array(4 + body.byteLength);
      seg[0] = 0xff;
      seg[1] = 0xe2;
      const segLen = 2 + body.byteLength;
      seg[2] = (segLen >>> 8) & 0xff;
      seg[3] = segLen & 0xff;
      const primaryLen = 2 + seg.byteLength + primaryTailAfterSoi.byteLength;
      const mpBase = 54;
      view.setUint32(mpBase + 4, primaryLen, true);
      view.setUint32(mpBase + 8, 0, true);
      view.setUint32(mpBase + 20, validJpeg.byteLength, true);
      view.setUint32(mpBase + 24, primaryLen - 10, true);
      seg.set(body, 4);
      return concatBytes(new Uint8Array([0xff, 0xd8]), seg, primaryTailAfterSoi, validJpeg);
    };
    expect(verifySignAttachmentBytes(makeDupTagMpfJpeg(0xb001))).toBeNull();
    expect(verifySignAttachmentBytes(makeDupTagMpfJpeg(0xb002))).toBeNull();
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

  describe('releaseOnResponseClose PDF slot lifecycle (#4682)', () => {
    it('holds slot across pull() #1 and pull() #2 when outgoing is attached and releases strictly once on finish or close', async () => {
      vi.useFakeTimers();
      try {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const releaseFinish = vi.fn();
        const outgoingFinish = new EventEmitter();
        const app = new Hono();
        app.get('/pdf', (c) => new Response(releaseOnResponseClose(bytes, releaseFinish, c)));

        const res = await app.request('/pdf', undefined, { outgoing: outgoingFinish });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value).toEqual(bytes);
        expect(releaseFinish).not.toHaveBeenCalled();

        // Simulates @hono/node-server eager maxReadCount = 2 read before outgoing.writeHead/write.
        const second = await reader.read();
        expect(second.done).toBe(true);
        expect(releaseFinish).not.toHaveBeenCalled();
        expect(outgoingFinish.listenerCount('finish')).toBe(1);
        expect(outgoingFinish.listenerCount('close')).toBe(1);

        outgoingFinish.emit('finish');
        expect(releaseFinish).toHaveBeenCalledTimes(1);
        expect(outgoingFinish.listenerCount('finish')).toBe(0);
        expect(outgoingFinish.listenerCount('close')).toBe(0);

        // Subsequent close event and advancing beyond the 60-second lease timer must not double-release.
        outgoingFinish.emit('close');
        vi.advanceTimersByTime(120_000);
        expect(releaseFinish).toHaveBeenCalledTimes(1);

        // Also test close-first ordering, plus minimal once/off stubs and abort signal.
        const releaseClose = vi.fn();
        const closeListeners = new Map<string, () => void>();
        const minimalOutgoing = {
          once(evt: string, fn: () => void) {
            closeListeners.set(evt, fn);
          },
          off(evt: string, fn: () => void) {
            if (closeListeners.get(evt) === fn) closeListeners.delete(evt);
          },
        };
        const abortController = new AbortController();
        const minimalContext = {
          env: { outgoing: minimalOutgoing },
          req: { raw: { signal: abortController.signal } },
        } as unknown as Parameters<typeof releaseOnResponseClose>[2];
        const stream2 = releaseOnResponseClose(bytes, releaseClose, minimalContext);
        const r2 = stream2.getReader();
        expect((await r2.read()).done).toBe(false);
        expect((await r2.read()).done).toBe(true);
        expect(releaseClose).not.toHaveBeenCalled();

        const onClose = closeListeners.get('close');
        const onFinish = closeListeners.get('finish');
        expect(onClose).toBeTypeOf('function');
        expect(onFinish).toBeTypeOf('function');
        onClose!();
        expect(releaseClose).toHaveBeenCalledTimes(1);
        expect(closeListeners.size).toBe(0);
        onFinish!();
        abortController.abort();
        vi.advanceTimersByTime(120_000);
        expect(releaseClose).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases stalled outgoing/unread streams automatically via the 60-second lease timer without double-releasing', async () => {
      vi.useFakeTimers();
      try {
        const bytes = new Uint8Array([9, 8, 7]);
        const releaseStalled = vi.fn();
        const outgoing = new EventEmitter();
        const abortController = new AbortController();
        const ctx = {
          env: { outgoing },
          req: { raw: { signal: abortController.signal } },
        } as unknown as Parameters<typeof releaseOnResponseClose>[2];

        const stream = releaseOnResponseClose(bytes, releaseStalled, ctx);
        const reader = stream.getReader();
        expect((await reader.read()).done).toBe(false);
        expect((await reader.read()).done).toBe(true);

        vi.advanceTimersByTime(60_000 - 1);
        expect(releaseStalled).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(releaseStalled).toHaveBeenCalledTimes(1);
        expect(outgoing.listenerCount('finish')).toBe(0);
        expect(outgoing.listenerCount('close')).toBe(0);

        // Late close, finish, and abort after lease expiry must remain no-ops.
        outgoing.emit('close');
        outgoing.emit('finish');
        abortController.abort();
        expect(releaseStalled).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('handles in-memory streams, cancel, abort signals, EventTarget, and pre-finished/pre-aborted contexts safely', async () => {
      vi.useFakeTimers();
      try {
        const bytes = new Uint8Array([5, 6]);

        // Without outgoing: pull() #2 releases once and cancels timer.
        const releaseMem = vi.fn();
        const memStream = releaseOnResponseClose(bytes, releaseMem);
        const memReader = memStream.getReader();
        expect((await memReader.read()).done).toBe(false);
        expect(releaseMem).not.toHaveBeenCalled();
        expect((await memReader.read()).done).toBe(true);
        expect(releaseMem).toHaveBeenCalledTimes(1);
        await memStream.cancel().catch(() => {});
        vi.advanceTimersByTime(120_000);
        expect(releaseMem).toHaveBeenCalledTimes(1);

        // Without outgoing: unread stream cancelled explicitly releases once.
        const releaseCancel = vi.fn();
        const cancelStream = releaseOnResponseClose(bytes, releaseCancel);
        await cancelStream.cancel();
        expect(releaseCancel).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(120_000);
        expect(releaseCancel).toHaveBeenCalledTimes(1);

        // EventTarget outgoing + abort signal.
        const releaseTarget = vi.fn();
        const target = new EventTarget();
        const addTargetListenerSpy = vi.spyOn(target, 'addEventListener');
        const abortTarget = new AbortController();
        const addAbortListenerSpy = vi.spyOn(abortTarget.signal, 'addEventListener');
        const targetCtx = {
          env: { outgoing: target },
          req: { raw: { signal: abortTarget.signal } },
        } as unknown as Parameters<typeof releaseOnResponseClose>[2];
        const targetStream = releaseOnResponseClose(bytes, releaseTarget, targetCtx);
        expect(addTargetListenerSpy).toHaveBeenCalledWith('finish', expect.any(Function));
        expect(addTargetListenerSpy).toHaveBeenCalledWith('close', expect.any(Function));
        expect(addAbortListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        const targetReader = targetStream.getReader();
        expect((await targetReader.read()).done).toBe(false);
        expect((await targetReader.read()).done).toBe(true);
        expect(releaseTarget).not.toHaveBeenCalled();
        abortTarget.abort();
        expect(releaseTarget).toHaveBeenCalledTimes(1);
        target.dispatchEvent(new Event('finish'));
        vi.advanceTimersByTime(120_000);
        expect(releaseTarget).toHaveBeenCalledTimes(1);

        // Pre-aborted signal and pre-finished outgoing release immediately once.
        const preAborted = new AbortController();
        preAborted.abort();
        const releasePreAborted = vi.fn();
        releaseOnResponseClose(bytes, releasePreAborted, {
          env: { outgoing: new EventEmitter() },
          req: { raw: { signal: preAborted.signal } },
        } as unknown as Parameters<typeof releaseOnResponseClose>[2]);
        expect(releasePreAborted).toHaveBeenCalledTimes(1);

        const releasePreFinished = vi.fn();
        const finishedEmitter = Object.assign(new EventEmitter(), { writableFinished: true });
        releaseOnResponseClose(bytes, releasePreFinished, {
          env: { outgoing: finishedEmitter },
          req: { raw: new AbortController().signal },
        } as unknown as Parameters<typeof releaseOnResponseClose>[2]);
        expect(releasePreFinished).toHaveBeenCalledTimes(1);
        expect(finishedEmitter.listenerCount('finish')).toBe(0);
        expect(finishedEmitter.listenerCount('close')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('destroys stalled outgoing target once with zero args and errors unread streams on lease expiry (#5024)', async () => {
      expect(PDF_STREAM_LEASE_MS).toBe(60_000);
      expect(PUBLIC_PDF_STREAM_LEASE_MS).toBe(15_000);

      vi.useFakeTimers();
      try {
        const bytes = new Uint8Array([1, 2, 3, 4]);

        // Unread stream with attached outgoing: expiry calls outgoing.destroy() with zero args and errors the stream.
        const releaseUnread = vi.fn();
        const destroyUnread = vi.fn();
        const unreadOutgoing = Object.assign(new EventEmitter(), { destroy: destroyUnread });
        const unreadCtx = {
          env: { outgoing: unreadOutgoing },
          req: { raw: new AbortController().signal },
        } as unknown as Parameters<typeof releaseOnResponseClose>[2];

        const unreadStream = releaseOnResponseClose(bytes, releaseUnread, unreadCtx);
        vi.advanceTimersByTime(PDF_STREAM_LEASE_MS - 1);
        expect(releaseUnread).not.toHaveBeenCalled();
        expect(destroyUnread).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(releaseUnread).toHaveBeenCalledTimes(1);
        expect(destroyUnread).toHaveBeenCalledTimes(1);
        expect(destroyUnread).toHaveBeenCalledWith();

        const unreadReader = unreadStream.getReader();
        await expect(unreadReader.read()).rejects.toThrow('PDF response stream lease expired');

        // Subsequent events remain no-ops.
        unreadOutgoing.emit('close');
        unreadOutgoing.emit('finish');
        expect(releaseUnread).toHaveBeenCalledTimes(1);
        expect(destroyUnread).toHaveBeenCalledTimes(1);

        // Unread stream with custom PUBLIC_PDF_STREAM_LEASE_MS expires at 15_000ms (not 14_999ms).
        const releasePubLease = vi.fn();
        const destroyPubLease = vi.fn();
        const pubOutgoing = Object.assign(new EventEmitter(), { destroy: destroyPubLease });
        const pubStream = releaseOnResponseClose(
          bytes,
          releasePubLease,
          { env: { outgoing: pubOutgoing }, req: { raw: new AbortController().signal } } as unknown as Parameters<
            typeof releaseOnResponseClose
          >[2],
          PUBLIC_PDF_STREAM_LEASE_MS,
        );
        vi.advanceTimersByTime(PUBLIC_PDF_STREAM_LEASE_MS - 1);
        expect(releasePubLease).not.toHaveBeenCalled();
        expect(destroyPubLease).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(releasePubLease).toHaveBeenCalledTimes(1);
        expect(destroyPubLease).toHaveBeenCalledTimes(1);
        expect(destroyPubLease).toHaveBeenCalledWith();
        await expect(pubStream.getReader().read()).rejects.toThrow('PDF response stream lease expired');

        // Stalled after stream pull() #1/#2 already closed: destroys outgoing once without throwing on closed stream.
        const releasePulled = vi.fn();
        const destroyPulled = vi.fn(() => {
          throw new Error('destroy error should be caught');
        });
        const pulledOutgoing = Object.assign(new EventEmitter(), { destroy: destroyPulled });
        const pulledStream = releaseOnResponseClose(bytes, releasePulled, {
          env: { outgoing: pulledOutgoing },
          req: { raw: new AbortController().signal },
        } as unknown as Parameters<typeof releaseOnResponseClose>[2]);
        const pulledReader = pulledStream.getReader();
        expect((await pulledReader.read()).done).toBe(false);
        expect((await pulledReader.read()).done).toBe(true);
        vi.advanceTimersByTime(PDF_STREAM_LEASE_MS);
        expect(releasePulled).toHaveBeenCalledTimes(1);
        expect(destroyPulled).toHaveBeenCalledTimes(1);
        expect(destroyPulled).toHaveBeenCalledWith();

        // Normal finish, normal close, and pre-finished/pre-closed/pre-destroyed sockets never call destroy().
        const destroyNormalFinish = vi.fn();
        const normalFinishOutgoing = Object.assign(new EventEmitter(), { destroy: destroyNormalFinish });
        releaseOnResponseClose(bytes, vi.fn(), {
          env: { outgoing: normalFinishOutgoing },
          req: { raw: new AbortController().signal },
        } as unknown as Parameters<typeof releaseOnResponseClose>[2]);
        normalFinishOutgoing.emit('finish');
        vi.advanceTimersByTime(PDF_STREAM_LEASE_MS);
        expect(destroyNormalFinish).not.toHaveBeenCalled();

        const destroyNormalClose = vi.fn();
        const normalCloseOutgoing = Object.assign(new EventEmitter(), { destroy: destroyNormalClose });
        releaseOnResponseClose(bytes, vi.fn(), {
          env: { outgoing: normalCloseOutgoing },
          req: { raw: new AbortController().signal },
        } as unknown as Parameters<typeof releaseOnResponseClose>[2]);
        normalCloseOutgoing.emit('close');
        vi.advanceTimersByTime(PDF_STREAM_LEASE_MS);
        expect(destroyNormalClose).not.toHaveBeenCalled();

        for (const flags of [{ writableFinished: true }, { closed: true }, { destroyed: true }]) {
          const destroyPre = vi.fn();
          const releasePre = vi.fn();
          const preOutgoing = Object.assign(new EventEmitter(), { ...flags, destroy: destroyPre });
          releaseOnResponseClose(bytes, releasePre, {
            env: { outgoing: preOutgoing },
            req: { raw: new AbortController().signal },
          } as unknown as Parameters<typeof releaseOnResponseClose>[2]);
          vi.advanceTimersByTime(PDF_STREAM_LEASE_MS);
          expect(releasePre).toHaveBeenCalledTimes(1);
          expect(destroyPre).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses 15s lease on all 4 public PDF/QR routes and preserves 60s lease on /api/v1/sign/* routes (#5024)', async () => {
      vi.useFakeTimers();
      try {
        const pdfBytes = Uint8Array.from(Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8'));
        const pngBytes = new Uint8Array(64);
        pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
        const certBytes = Uint8Array.from(Buffer.from('{"certificateCode":"CS-1111-2222-3333"}', 'utf8'));

        const pdfSha = sha256Hex(pdfBytes);
        const pngSha = sha256Hex(pngBytes);
        const certSha = sha256Hex(certBytes);
        const blobs = new Map<string, Uint8Array>([
          ['k/pdf', pdfBytes],
          ['k/qr', pngBytes],
          ['k/cert', certBytes],
        ]);
        const store = {
          put: async () => 'gen-1',
          get: async (key: string) => {
            const found = blobs.get(key);
            if (!found) throw new Error(`missing ${key}`);
            return found;
          },
          delete: async () => {},
        } as unknown as BlobStore;

        const fakeOrglessDb = {
          getExecutor: () => ({
            transformQuery: (node: unknown) => node,
            compileQuery: (node: unknown) => ({ query: node, sql: JSON.stringify(node), parameters: [] }),
            executeQuery: async ({ sql }: { sql: string }) => {
              if (sql.includes('public_deposit_qr_source')) {
                return {
                  rows: [{ source: { orgId: ORG_ID, otpRequired: false, storageKey: 'k/qr', generation: 'g1', sha256: pngSha } }],
                };
              }
              if (
                sql.includes('public_pdf_source') ||
                sql.includes('public_direct_pdf_source') ||
                sql.includes('public_hub_pdf_source')
              ) {
                return {
                  rows: [{ source: { orgId: ORG_ID, otpRequired: false, storageKey: 'k/pdf', generation: 'g1', sha256: pdfSha } }],
                };
              }
              if (sql.includes('api_key_authenticate')) {
                return {
                  rows: [{ auth: { status: 'ok', orgId: ORG_ID, orgSlug: 'acme', scopes: ['sign:read'] } }],
                };
              }
              if (sql.includes('api_key_envelope_file_source')) {
                const isCert = sql.includes('"certificate"');
                return {
                  rows: [
                    {
                      out: {
                        status: 'ok',
                        envelopeId: ENVELOPE_ID,
                        storageKey: isCert ? 'k/cert' : 'k/pdf',
                        generation: 'g1',
                        sha256: isCert ? certSha : pdfSha,
                      },
                    },
                  ],
                };
              }
              return { rows: [] };
            },
          }),
        };

        const routeRuntime = {
          installed: (name: string) => name === 'kernel' || name === 'sign',
          modules: () => ['kernel', 'sign'],
          orgless: async <T>(fn: (db: never) => Promise<T>) => fn(fakeOrglessDb as never),
        } as unknown as Runtime;

        const routeApp = createHttpApp({
          config: buildConfig(),
          runtime: routeRuntime,
          store,
          authenticate: async () => buildUser(),
          pool: {} as pg.Pool,
          aiEnabled: false,
        });

        const token = 'T'.repeat(43);
        const publicCases: Array<{ path: string; body: unknown }> = [
          { path: '/api/sign/pdf', body: { token } },
          { path: '/api/sign/deposit-qr', body: { token } },
          { path: '/api/sign/direct/pdf', body: { token } },
          { path: '/api/sign/public-hub/acme', body: { action: 'pdf', templateId: TEMPLATE_ID } },
        ];

        for (const [idx, item] of publicCases.entries()) {
          const destroy = vi.fn();
          const outgoing = Object.assign(new EventEmitter(), { destroy });
          const res = await routeApp.request(
            item.path,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-forwarded-for': `198.51.100.${10 + idx}`,
              },
              body: JSON.stringify(item.body),
            },
            { outgoing },
          );
          expect(res.status, item.path).toBe(200);
          vi.advanceTimersByTime(PUBLIC_PDF_STREAM_LEASE_MS - 1);
          expect(destroy, `${item.path} before 15s`).not.toHaveBeenCalled();

          vi.advanceTimersByTime(1);
          expect(destroy, `${item.path} at 15s`).toHaveBeenCalledTimes(1);
          expect(destroy).toHaveBeenCalledWith();
          await expect(res.body!.getReader().read()).rejects.toThrow('PDF response stream lease expired');
        }

        const apiKeyBearer = `Bearer ludy_sk_${'a'.repeat(32)}`;
        for (const [idx, suffix] of ['sealed', 'certificate'].entries()) {
          const destroy = vi.fn();
          const outgoing = Object.assign(new EventEmitter(), { destroy });
          const res = await routeApp.request(
            `/api/v1/sign/envelopes/${ENVELOPE_ID}/${suffix}`,
            {
              method: 'GET',
              headers: {
                authorization: apiKeyBearer,
                'x-forwarded-for': `198.51.100.${30 + idx}`,
              },
            },
            { outgoing },
          );
          expect(res.status, suffix).toBe(200);
          vi.advanceTimersByTime(PUBLIC_PDF_STREAM_LEASE_MS);
          expect(destroy, `${suffix} at 15s`).not.toHaveBeenCalled();

          vi.advanceTimersByTime(PDF_STREAM_LEASE_MS - PUBLIC_PDF_STREAM_LEASE_MS - 1);
          expect(destroy, `${suffix} before 60s`).not.toHaveBeenCalled();

          vi.advanceTimersByTime(1);
          expect(destroy, `${suffix} at 60s`).toHaveBeenCalledTimes(1);
          expect(destroy).toHaveBeenCalledWith();
          await expect(res.body!.getReader().read()).rejects.toThrow('PDF response stream lease expired');
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

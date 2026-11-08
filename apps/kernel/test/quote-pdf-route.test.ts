// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/crm/quotes/:id/pdf (#2695, docs/plan/crm-quotes.md step Q3), with a stand-in runtime: who may take it, what the response says about itself (type,
// file name from the org's slug and the quote's number made safe, never cached, never sniffed), that the bytes are a PDF and the same for the same quote,
// that a quote the runtime does not find is a plain 404 with no file, that a deployment without the CRM module has no such route, and the per-member rate.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ORG_HEADER } from '@crove/kernel-contract';
import { DomainError, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import type { QuoteDocument } from '@crove/mod-crm';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const SECRET = 'x'.repeat(32);
const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent', BRAND_NAME: 'Ludy' });
const orgId = randomUUID();
const user: AuthUser = { userId: randomUUID(), email: 'viewer@example.com', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null };
const headers = { authorization: 'Bearer t', [ORG_HEADER]: 'acme' };

function document(number: string | null): QuoteDocument {
  return {
    quote: {
      id: '00000000-0000-4000-8000-000000000001',
      dealId: '00000000-0000-4000-8000-000000000002',
      dealTitle: 'Gói kế toán năm',
      partyId: '00000000-0000-4000-8000-000000000003',
      partyName: 'Công ty ABC',
      number,
      revision: 1,
      revisesId: null,
      status: number ? 'sent' : 'draft',
      expired: false,
      validUntil: '2026-12-31',
      subtotal: '3000000',
      vatAmount: '300000',
      total: '3300000',
      lineCount: 1,
      version: 1,
      createdBy: 'u',
      createdAt: '2026-11-15T02:00:00.000Z',
      updatedAt: '2026-11-15T02:00:00.000Z',
      notes: null,
      terms: null,
      // The send's facts (Q2, #2694).
      sentAt: number ? '2026-11-15T02:00:00.000Z' : null,
      sentVia: number ? 'link' : null,
      firstViewedAt: null,
      buyer: null,
      links: [],
      lines: [{ lineNo: 1, kind: 'item', description: 'Gói kế toán năm', unit: 'gói', quantity: '2', unitPrice: '1500000', discountPercent: '0', vatRate: '10%', amount: '3000000', vatAmount: '300000', stockItemId: null }],
    },
    seller: { name: 'Công ty Ánh Dương', taxCode: null, address: null, phone: null, email: null, bankNote: null },
    buyer: { name: 'Công ty ABC', taxCode: null, address: null, phone: null, email: null },
    issuedOn: '2026-11-15',
  };
}

function appWith(options: { crm?: boolean; number?: string | null; missing?: boolean } = {}) {
  const asked: Array<{ name: string; input: unknown; orgId: string }> = [];
  const runtime = {
    installed: (module: string) => (module === 'crm' ? (options.crm ?? true) : true),
    modules: () => ['kernel', 'crm'],
    forUser: async () => [{ orgId, slug: 'acme', name: 'Acme', role: 'viewer' }],
    query: async (name: string, input: unknown, context: { orgId: string }) => {
      asked.push({ name, input, orgId: context.orgId });
      if (options.missing) throw new DomainError('QUOTE_NOT_FOUND', 404, 'Không tìm thấy báo giá này');
      return document(options.number === undefined ? 'BG-2026-0001' : options.number);
    },
  } as unknown as Runtime;
  const app = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: async () => user, pool: {} as pg.Pool, aiEnabled: false });
  return { app, asked };
}

const QUOTE = '00000000-0000-4000-8000-000000000001';

describe('GET /api/crm/quotes/:id/pdf (#2695)', () => {
  it('answers a viewer with a PDF that is never cached or sniffed, named from the org and the quote number', async () => {
    const { app, asked } = appWith();
    const response = await app.request(`/api/crm/quotes/${QUOTE}/pdf`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain('filename="ludy-bao-gia-BG-2026-0001-acme.pdf"');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
    expect(bytes.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(asked).toEqual([{ name: 'crm.quote.document', input: { quoteId: QUOTE }, orgId }]);
    // The same quote, the same bytes.
    const again = Buffer.from(await (await app.request(`/api/crm/quotes/${QUOTE}/pdf`, { headers })).arrayBuffer());
    expect(again.equals(bytes)).toBe(true);
  });

  it('names a draft "nhap", and makes the number safe for a file name', async () => {
    const draft = await appWith({ number: null }).app.request(`/api/crm/quotes/${QUOTE}/pdf`, { headers });
    expect(draft.headers.get('content-disposition')).toContain('filename="ludy-bao-gia-nhap-acme.pdf"');
    const odd = await appWith({ number: 'BG/2026 "0001"\r\nX-Evil: 1' }).app.request(`/api/crm/quotes/${QUOTE}/pdf`, { headers });
    const disposition = odd.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('filename="ludy-bao-gia-BG-2026-0001-X-Evil-1-acme.pdf"');
    expect(disposition).not.toMatch(/[\r\n]/);
  });

  it('answers a quote the runtime does not find as a plain 404 with no file', async () => {
    const response = await appWith({ missing: true }).app.request(`/api/crm/quotes/${QUOTE}/pdf`, { headers });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('pdf');
    expect(await response.json()).toMatchObject({ code: 'QUOTE_NOT_FOUND' });
  });

  it('is not there without the CRM module, and wants a signed-in member of the org', async () => {
    expect((await appWith({ crm: false }).app.request(`/api/crm/quotes/${QUOTE}/pdf`, { headers })).status).toBe(404);
    const { app } = appWith();
    expect((await app.request(`/api/crm/quotes/${QUOTE}/pdf`, { headers: { authorization: 'Bearer t', [ORG_HEADER]: 'someone-else' } })).status).toBeGreaterThanOrEqual(403);
  });

  it('lets a member take 30 a minute and tells the 31st to wait', async () => {
    const { app } = appWith();
    for (let i = 0; i < 30; i++) expect((await app.request(`/api/crm/quotes/${QUOTE}/pdf`, { headers })).status).toBe(200);
    const refused = await app.request(`/api/crm/quotes/${QUOTE}/pdf`, { headers });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });
});

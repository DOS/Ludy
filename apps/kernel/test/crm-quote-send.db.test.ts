// SPDX-License-Identifier: AGPL-3.0-only
// Sending a quote (#2694, docs/plan/crm-quotes.md step Q2) on PostgreSQL 17: the send by link and by email, the number from the kernel's yearly series, the buyer snapshot and
// the issuing entity, the refusals, the public page of a link (a definer, one answer for every bad token, views counted), a link's revocation, a revision that keeps the number
// and replaces the older quote and its links, and that the database itself (as the runtime's own login in an org context) lets a person make only those transitions and
// freezes a sent quote and its lines. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Deal, PipelineStage, Quote, QuoteDocument, QuoteLinkCreated, QuoteSent } from '@crove/kernel-contract';
import { vietnamToday } from '@crove/kernel-contract';
import { Runtime, contentGeneration, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { crmCommands, crmQueries, renderQuotePdf, type QuoteDocument as QuotePdfDocument } from '@crove/mod-crm';
import { quoteMailTemplate } from '../src/quote-mail.ts';
import { quoteLogo, quoteView } from '../src/quote-link.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SYSTEM = { type: 'system' as const, component: 'test.crm.quote' };

// A blob store in memory, as the other composition tests keep one: the logo's bytes are read back by the page's route.
class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return contentGeneration(sha256Hex(bytes));
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}
// The first bytes of a PNG and of a JPEG are all the upload sniffing reads; the rest is filler.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const item = (over: Record<string, unknown> = {}) => ({ kind: 'item' as const, description: 'Gói kế toán năm', unit: 'gói', quantity: '2', unitPrice: '1500000', vatRate: '10%', ...over });

suite('crm quote send on PostgreSQL (#2694)', () => {
  const dbName = `crove_test_crm_quote_send_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  // The worker's login: the only one that enters an org's system context (a mail being sent asks crm.quote.mail_data there).
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@quote-send.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    const adminUser = await person('admin');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer'), ($1, $4, 'admin')", [orgId, member, viewer, adminUser]));
    const party = (name: string, email: string | null = null, taxCode = '0312345678') =>
      admin((c) =>
        c
          .query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, email, tax_code, address) VALUES ($1, $2, 'organization', $3, $4, '12 Lê Lợi, Quận 1') RETURNING id", [orgId, name, email, taxCode])
          .then((r) => r.rows[0]!.id),
      );
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId });
    const newDeal = async (partyId: string) => {
      await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
      return exec<Deal>(member, 'crm.deal.create', { partyId, title: 'Gói kế toán năm', amount: '15000000', expectedClose: '2026-12-31' });
    };
    // A draft with one priced line, ready to send.
    const readyDraft = async (dealId: string, lines: unknown[] = [item()]) => {
      const q = await exec<Quote>(member, 'crm.quote.save', { dealId, lines: [] });
      return exec<Quote>(member, 'crm.quote.save', { quoteId: q.id, version: q.version, lines });
    };
    const send = (user: string, quote: Quote, via: 'link' | 'email', to?: string) => exec<QuoteSent>(user, 'crm.quote.send', { quoteId: quote.id, version: quote.version, via, ...(to ? { to } : {}) });
    const link = (user: string, quoteId: string) => exec<QuoteLinkCreated>(user, 'crm.quote.create_link', { quoteId });
    return { orgId, owner, member, viewer, adminUser, party, exec, query, newDeal, readyDraft, send, link };
  }

  async function as<T>(orgId: string, user: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, user, orgId);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 4 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('sends a draft by link: the number, the issuer and the buyer as they were, then a link that opens the one document', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(party);
    const draft = await o.readyDraft(deal.id, [item(), { kind: 'text', description: 'Giao trong 3 ngày' }]);
    // The number's year is the Vietnam year, not the UTC one (they differ from 17:00 UTC on 31 December).
    const year = Number(vietnamToday().slice(0, 4));
    const { quote, mail } = await o.send(o.member, draft, 'link');
    expect(mail).toBeNull();
    expect(quote).toMatchObject({ status: 'sent', sentVia: 'link', revision: 1, version: draft.version + 1, total: draft.total, buyer: { name: 'Công ty ABC', taxCode: '0312345678', address: '12 Lê Lợi, Quận 1', email: null }, links: [] });
    expect(quote.number).toMatch(new RegExp(`^BG-${year}-0001$`));
    expect(quote.sentAt).not.toBeNull();
    // The buyer is a snapshot: editing the contact later does not rewrite what the customer holds.
    await admin((c) => c.query("UPDATE crove_kernel.party SET name = 'Tên mới', address = 'Nơi khác' WHERE org_id = $1 AND id = $2", [o.orgId, party]));
    expect((await o.query<Quote>(o.viewer, 'crm.quote.get', { quoteId: quote.id })).buyer).toMatchObject({ name: 'Công ty ABC', address: '12 Lê Lợi, Quận 1' });
    const issuer = await admin((c) => c.query<{ name: string; issuer_entity_id: string }>('SELECT e.name, q.issuer_entity_id FROM crove_crm.quote q JOIN crove_kernel.legal_entity e ON e.org_id = q.org_id AND e.id = q.issuer_entity_id WHERE q.org_id = $1 AND q.id = $2', [o.orgId, quote.id]));
    expect(issuer.rows[0]!.issuer_entity_id).toBeTruthy();

    // A sent quote is not edited, deleted or sent again.
    await expect(o.exec(o.member, 'crm.quote.save', { quoteId: quote.id, version: quote.version, lines: [] })).rejects.toMatchObject({ code: 'QUOTE_NOT_DRAFT' });
    await expect(o.exec(o.member, 'crm.quote.delete_draft', { quoteId: quote.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_DRAFT' });
    await expect(o.send(o.member, quote, 'link')).rejects.toMatchObject({ code: 'QUOTE_NOT_DRAFT' });

    // The link: the token comes back once; the page is a definer that answers the one document.
    const made = await o.link(o.member, quote.id);
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.path).toBe(`/-/quote#${made.token}`);
    const doc = (await quoteView(rt, { token: made.token })) as QuoteDocument;
    expect(doc).toMatchObject({
      number: quote.number,
      revision: 1,
      status: 'sent',
      expired: false,
      buyer: { name: 'Công ty ABC', taxCode: '0312345678', address: '12 Lê Lợi, Quận 1' },
      seller: { name: issuer.rows[0]!.name, phone: null, email: null, bankNote: null },
    });
    // The page's money is the database's numeric text (scale 4); its value is the quote's.
    expect([Number(doc.total), Number(doc.subtotal)]).toEqual([Number(draft.total), Number(draft.subtotal)]);
    expect(doc.lines.map((l) => [l.lineNo, l.kind, l.description])).toEqual([[1, 'item', 'Gói kế toán năm'], [2, 'text', 'Giao trong 3 ngày']]);
    expect(JSON.stringify(doc)).not.toContain(o.orgId);
    expect(JSON.stringify(doc)).not.toContain(quote.id);
    // The views are counted, for the link and for the quote.
    await quoteView(rt, { token: made.token });
    const after = await o.query<Quote>(o.viewer, 'crm.quote.get', { quoteId: quote.id });
    expect(after.links).toHaveLength(1);
    expect(after.links[0]).toMatchObject({ id: made.linkId, views: 2, live: true, revokedAt: null });
    expect(after.firstViewedAt).not.toBeNull();
    // The database keeps only the token's hash.
    const stored = await admin((c) => c.query<{ token_sha256: string }>('SELECT token_sha256 FROM crove_crm.quote_link WHERE org_id = $1 AND id = $2', [o.orgId, made.linkId]));
    expect(stored.rows[0]!.token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]!.token_sha256).not.toContain(made.token);
  });

  it('answers one refusal for every bad token: malformed, unknown, revoked and expired', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('Công ty ABC'));
    const { quote } = await o.send(o.member, await o.readyDraft(deal.id), 'link');
    const made = await o.link(o.member, quote.id);
    expect(await quoteView(rt, { token: made.token })).not.toBeNull();
    for (const bad of ['', 'abc', 'x'.repeat(43), 'x'.repeat(44), `${made.token}!`, null, 5]) expect(await quoteView(rt, { token: bad }), String(bad)).toBeNull();
    expect(await quoteView(rt, null)).toBeNull();
    expect(await quoteView(rt, { token: made.token, extra: 1 })).toBeNull();
    // Revoked: by a person, once; the second revoke is the same answer.
    expect(await o.exec(o.member, 'crm.quote.revoke_link', { linkId: made.linkId })).toEqual({ linkId: made.linkId, revoked: true });
    expect(await o.exec(o.member, 'crm.quote.revoke_link', { linkId: made.linkId })).toEqual({ linkId: made.linkId, revoked: true });
    expect(await quoteView(rt, { token: made.token })).toBeNull();
    await expect(o.exec(o.viewer, 'crm.quote.revoke_link', { linkId: made.linkId })).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.member, 'crm.quote.revoke_link', { linkId: randomUUID() })).rejects.toMatchObject({ code: 'QUOTE_LINK_NOT_FOUND' });
    // Expired: a link past its time.
    const fresh = await o.link(o.member, quote.id);
    await admin((c) => c.query("UPDATE crove_crm.quote_link SET created_at = now() - interval '3 days', expires_at = now() - interval '1 day' WHERE org_id = $1 AND id = $2", [o.orgId, fresh.linkId]));
    expect(await quoteView(rt, { token: fresh.token })).toBeNull();
    expect((await o.query<Quote>(o.owner, 'crm.quote.get', { quoteId: quote.id })).links.map((l) => [l.revokedAt !== null, l.live])).toEqual([[true, false], [false, false]]);
    // An inactive org's links do not open.
    const third = await o.link(o.member, quote.id);
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1", [o.orgId]));
    expect(await quoteView(rt, { token: third.token })).toBeNull();
  });

  it('takes numbers from the kernel\'s yearly series, one per quote, and a second org starts again at 1', async () => {
    const a = await org();
    const b = await org();
    const dealA = await a.newDeal(await a.party('Công ty A'));
    const dealB = await b.newDeal(await b.party('Công ty B'));
    const first = (await a.send(a.member, await a.readyDraft(dealA.id), 'link')).quote;
    const second = (await a.send(a.owner, await a.readyDraft(dealA.id), 'link')).quote;
    const other = (await b.send(b.member, await b.readyDraft(dealB.id), 'link')).quote;
    expect([first.number, second.number, other.number].map((n) => n?.slice(-4))).toEqual(['0001', '0002', '0001']);
    // A draft that was never sent has no number, so a deleted draft leaves no gap.
    const gone = await a.readyDraft(dealA.id);
    await a.exec(a.member, 'crm.quote.delete_draft', { quoteId: gone.id });
    expect((await a.send(a.member, await a.readyDraft(dealA.id), 'link')).quote.number?.slice(-4)).toBe('0003');
  });

  it('refuses to send what is not sendable, and tells why', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(party);
    const empty = await o.exec<Quote>(o.member, 'crm.quote.save', { dealId: deal.id, lines: [] });
    await expect(o.send(o.member, empty, 'link')).rejects.toMatchObject({ code: 'QUOTE_NOT_SENDABLE', status: 422 });
    const textOnly = await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: empty.id, version: empty.version, lines: [{ kind: 'text', description: 'Chỉ ghi chú' }] });
    await expect(o.send(o.member, textOnly, 'link')).rejects.toMatchObject({ code: 'QUOTE_NOT_SENDABLE' });
    const free = await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: empty.id, version: textOnly.version, lines: [item({ discountPercent: '100' })] });
    await expect(o.send(o.member, free, 'link')).rejects.toMatchObject({ code: 'QUOTE_NOT_SENDABLE' });
    const ready = await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: empty.id, version: free.version, lines: [item()] });
    // A validity date that has passed.
    await admin((c) => c.query("UPDATE crove_crm.quote SET valid_until = '2020-01-01' WHERE org_id = $1 AND id = $2", [o.orgId, ready.id]));
    await expect(o.send(o.member, ready, 'link')).rejects.toMatchObject({ code: 'QUOTE_VALIDITY_PAST', status: 422 });
    await o.exec(o.member, 'crm.quote.save', { quoteId: ready.id, version: ready.version, validUntil: '2031-01-31', lines: [item()] });
    const current = await o.query<Quote>(o.member, 'crm.quote.get', { quoteId: ready.id });
    // The version read is the version sent; a viewer never sends.
    await expect(o.exec(o.member, 'crm.quote.send', { quoteId: ready.id, version: ready.version, via: 'link' })).rejects.toMatchObject({ code: 'STALE_VERSION', status: 409 });
    await expect(o.send(o.viewer, current, 'link')).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.member, 'crm.quote.send', { quoteId: current.id, version: current.version, via: 'post' })).rejects.toMatchObject({ code: 'VALIDATION' });
    // An email send needs an address: the customer has none and none was given.
    await expect(o.send(o.member, current, 'email')).rejects.toMatchObject({ code: 'QUOTE_EMAIL_REQUIRED', status: 422 });
    await expect(o.send(o.member, current, 'email', 'khong-phai-email')).rejects.toMatchObject({ code: 'QUOTE_EMAIL_REQUIRED' });
    // Nothing was written by the refusals: still a draft with no number.
    expect(await o.query<Quote>(o.member, 'crm.quote.get', { quoteId: current.id })).toMatchObject({ status: 'draft', number: null, buyer: null, version: current.version });
    // A link only for a quote that was sent.
    await expect(o.link(o.member, current.id)).rejects.toMatchObject({ code: 'QUOTE_NOT_SENT', status: 409 });
    await expect(o.link(o.viewer, current.id)).rejects.toMatchObject({ status: 403 });
    // Another org sees no such quote.
    const other = await org();
    await expect(other.exec(other.owner, 'crm.quote.send', { quoteId: current.id, version: current.version, via: 'link' })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' });
    await expect(other.link(other.owner, current.id)).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' });
  });

  it('sends by email: one queued mail whose link is made when it is sent, a refused blocked address, and nothing sent without the click', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC', 'ketoan@khach.test');
    const deal = await o.newDeal(party);
    const draft = await o.readyDraft(deal.id);
    expect((await admin((c) => c.query("SELECT 1 FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'crm.quote.send'", [o.orgId]))).rowCount).toBe(0);
    // A blocked address refuses the whole send: the quote stays a draft, no number, no link, no mail.
    await admin((c) => c.query("INSERT INTO crove_kernel.mail_suppression (org_id, to_hash, scope, reason) SELECT $1, crove_kernel.mail_address_hash('chan@khach.test'), 'all', 'manual'", [o.orgId]));
    await expect(o.send(o.member, draft, 'email', 'chan@khach.test')).rejects.toMatchObject({ code: 'QUOTE_EMAIL_SUPPRESSED', status: 422 });
    expect(await o.query<Quote>(o.member, 'crm.quote.get', { quoteId: draft.id })).toMatchObject({ status: 'draft', number: null, links: [] });
    expect((await admin((c) => c.query("SELECT 1 FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'crm.quote.send'", [o.orgId]))).rowCount).toBe(0);
    // The customer's own address.
    const { quote, mail } = await o.send(o.member, draft, 'email');
    expect(mail).toBe('queued');
    expect(quote).toMatchObject({ status: 'sent', sentVia: 'email' });
    // No link yet and no token in the queue: the link is made as the mail is sent.
    expect(quote.links).toHaveLength(0);
    const rows = await admin((c) => c.query<{ template_key: string; status: string; subject: string; source_id: string; payload: Record<string, unknown> }>("SELECT template_key, status, subject, source_id, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'crm.quote.send'", [o.orgId]));
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row).toMatchObject({ template_key: 'crm.quote', status: 'queued', source_id: quote.id });
    expect(row.subject).toContain(quote.number as string);
    expect(JSON.stringify(row.payload)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(row.payload).toMatchObject({ quoteId: quote.id, number: quote.number });
    // The mail renders from its stored data and makes the link then: only its hash is stored, and it opens the document.
    const execute = <T>(command: string, input: unknown) => worker.execute<T>(command, input, { actor: SYSTEM, orgId: o.orgId });
    const rendered = await quoteMailTemplate.render({ messageId: randomUUID(), subject: row.subject, payload: row.payload, publicUrl: 'https://app.example.test/', inboundAddress: null, brand: 'Ludy', execute });
    expect(rendered).not.toBeNull();
    const token = /quote#([A-Za-z0-9_-]{43})/.exec(rendered!.text)![1]!;
    expect(rendered!.text).toContain(quote.number as string);
    expect(rendered!.html).toContain(`href="https://app.example.test/-/quote#${token}"`);
    const opened = (await quoteView(rt, { token })) as QuoteDocument;
    expect(opened.number).toBe(quote.number);
    expect(Number(opened.total)).toBe(Number(draft.total));
    const links = await admin((c) => c.query<{ token_sha256: string; created_by: string }>('SELECT token_sha256, created_by FROM crove_crm.quote_link WHERE org_id = $1 AND quote_id = $2', [o.orgId, quote.id]));
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0]).toMatchObject({ created_by: o.member });
    expect(links.rows[0]!.token_sha256).not.toContain(token);
    // A quote that was replaced meanwhile gets no link and its mail is not sent.
    const revised = await o.exec<Quote>(o.member, 'crm.quote.revise', { quoteId: quote.id });
    await o.send(o.member, await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: revised.id, version: revised.version, lines: [item({ quantity: '5' })] }), 'link');
    expect(await quoteMailTemplate.render({ messageId: randomUUID(), subject: row.subject, payload: row.payload, publicUrl: 'https://app.example.test/', inboundAddress: null, brand: 'Ludy', execute })).toBeNull();
    // A typed recipient is used instead of the customer's.
    const second = await o.readyDraft(deal.id);
    await o.send(o.member, second, 'email', 'khac@khach.test');
    const to = await admin((c) => c.query<{ n: string }>("SELECT count(*)::text AS n FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'crm.quote.send' AND to_hash = crove_kernel.mail_address_hash('khac@khach.test')", [o.orgId]));
    expect(to.rows[0]!.n).toBe('1');
  });

  it('replaces a sent quote by its revision: the same number, the older one superseded and its links revoked', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('Công ty ABC'));
    const v1 = (await o.send(o.member, await o.readyDraft(deal.id), 'link')).quote;
    const old = await o.link(o.member, v1.id);
    expect(await quoteView(rt, { token: old.token })).not.toBeNull();
    const draft = await o.exec<Quote>(o.member, 'crm.quote.revise', { quoteId: v1.id });
    // Until the revision is sent the older quote and its link stand.
    expect((await o.query<Quote>(o.member, 'crm.quote.get', { quoteId: v1.id })).status).toBe('sent');
    expect(await quoteView(rt, { token: old.token })).not.toBeNull();
    await expect(o.link(o.member, draft.id)).rejects.toMatchObject({ code: 'QUOTE_NOT_SENT' });
    const edited = await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: draft.id, version: draft.version, lines: [item({ quantity: '5' })] });
    const { quote: v2 } = await o.send(o.member, edited, 'link');
    expect(v2).toMatchObject({ status: 'sent', revision: 2, number: v1.number, revisesId: v1.id });
    const replaced = await o.query<Quote>(o.member, 'crm.quote.get', { quoteId: v1.id });
    expect(replaced.status).toBe('superseded');
    expect(replaced.links[0]).toMatchObject({ live: false });
    expect(replaced.links[0]!.revokedAt).not.toBeNull();
    expect(await quoteView(rt, { token: old.token })).toBeNull();
    // The new quote has its own link; a superseded quote gets none and is not revised again.
    const fresh = await o.link(o.member, v2.id);
    expect(await quoteView(rt, { token: fresh.token })).toMatchObject({ number: v1.number, revision: 2 });
    await expect(o.link(o.member, v1.id)).rejects.toMatchObject({ code: 'QUOTE_NOT_SENT' });
    await expect(o.exec(o.member, 'crm.quote.revise', { quoteId: v1.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_REVISABLE' });
    // The number is not taken twice: the next new quote is the next number.
    const next = (await o.send(o.member, await o.readyDraft(deal.id), 'link')).quote;
    expect(Number(next.number?.slice(-4))).toBe(Number(v1.number?.slice(-4)) + 1);
  });

  it('holds the transitions in SQL as the runtime\'s own login: no forged send, no link on a draft, a sent quote and its lines are frozen', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(party);
    const otherDeal = await o.newDeal(await o.party('Công ty khác', null, '0399999990'));
    const draft = await o.readyDraft(deal.id);
    const { quote: sent } = await o.send(o.member, await o.readyDraft(deal.id), 'link');
    const entity = (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 LIMIT 1', [o.orgId]))).rows[0]!.id;
    const forgedSend = (set: string) => `UPDATE crove_crm.quote SET ${set} WHERE org_id = $1 AND id = $2`;
    const complete = "status = 'sent', number = 'BG-2026-0777', sent_at = now(), sent_via = 'link', issuer_entity_id = $3, buyer_name = 'Ai đó'";
    // A draft is sent with everything the send writes, or not at all.
    await expect(as(o.orgId, o.member, (c) => c.query(forgedSend("status = 'sent'"), [o.orgId, draft.id]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('QUOTE_FORBIDDEN') });
    await expect(as(o.orgId, o.member, (c) => c.query(forgedSend("status = 'accepted', decided_at = now()"), [o.orgId, draft.id]))).rejects.toMatchObject({ code: '42501' });
    // A viewer sends nothing.
    expect(await as(o.orgId, o.viewer, async (c) => (await c.query(forgedSend(complete), [o.orgId, draft.id, entity])).rowCount)).toBe(0);
    // A well-formed send of a quote with its total changed in the same statement is refused (a quote is sent as it was saved).
    await expect(as(o.orgId, o.member, (c) => c.query(forgedSend(`${complete}, total = 1, subtotal = 1, vat_amount = 0`), [o.orgId, draft.id, entity]))).rejects.toMatchObject({ code: '42501' });
    // The seller's letterhead is frozen into the quote by the send (#2826): a send without it is refused, one with it passes, and nothing else writes it.
    const spare = await o.readyDraft(deal.id);
    await expect(as(o.orgId, o.member, (c) => c.query(forgedSend(complete), [o.orgId, spare.id, entity]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('QUOTE_FORBIDDEN') });
    await expect(as(o.orgId, o.member, (c) => c.query(forgedSend("seller_bank_note = 'Tài khoản khác'"), [o.orgId, draft.id]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('QUOTE_FORBIDDEN') });
    await expect(
      as(o.orgId, o.member, (c) =>
        c.query(`INSERT INTO crove_crm.quote (org_id, deal_id, party_id, valid_until, created_by, seller_name) VALUES ($1, '${deal.id}', '${party}', '2031-01-31', $2, 'Bên bán')`, [o.orgId, o.member]),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('QUOTE_FORBIDDEN') });
    // The logo's freeze marker and file id are the send's too (#2814): not written on a new row nor by an edit of a draft, allowed in the send (also when a sender leaves them out).
    await expect(
      as(o.orgId, o.member, (c) =>
        c.query(`INSERT INTO crove_crm.quote (org_id, deal_id, party_id, valid_until, created_by, seller_logo_frozen) VALUES ($1, '${deal.id}', '${party}', '2031-01-31', $2, true)`, [o.orgId, o.member]),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('QUOTE_FORBIDDEN') });
    await expect(as(o.orgId, o.member, (c) => c.query('UPDATE crove_crm.quote SET seller_logo_frozen = true WHERE org_id = $1 AND id = $2', [o.orgId, spare.id]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('QUOTE_FORBIDDEN') });
    expect(await as(o.orgId, o.member, async (c) => (await c.query(forgedSend(`${complete}, seller_name = 'Bên bán', seller_logo_frozen = true`), [o.orgId, spare.id, entity])).rowCount)).toBe(1);
    // A sent quote does not change, whoever asks and whatever the column.
    for (const set of ["remarks = 'x'", "status = 'draft'", "status = 'accepted'", "number = 'BG-2026-0999'", 'valid_until = valid_until + 1', "seller_bank_note = 'Tài khoản khác'", "seller_name = 'Giả mạo'", "seller_phone = '0123'", 'seller_logo_frozen = false', 'seller_logo_file_id = gen_random_uuid()']) {
      await expect(as(o.orgId, o.owner, (c) => c.query(forgedSend(set), [o.orgId, sent.id])), set).rejects.toMatchObject({ code: '42501' });
    }
    // A sent quote's lines do not change: the share lock and the status check (the line policies also hide the row).
    const line = `INSERT INTO crove_crm.quote_line (org_id, quote_id, line_no, kind, description, quantity, unit_price, vat_rate, amount, vat_amount) VALUES ($1, $2, 9, 'item', 'Thêm', 1, 100, '10%', 100, 10)`;
    await expect(as(o.orgId, o.member, (c) => c.query(line, [o.orgId, sent.id]))).rejects.toMatchObject({ code: '42501' });
    expect(await as(o.orgId, o.member, async (c) => (await c.query(line.replace(', 9,', ', 99,'), [o.orgId, draft.id])).rowCount)).toBe(1);
    // A revision names a sent or declined quote of the same deal and the next revision number, and nothing else.
    const revision = (revisesId: string, deal_id: string, revisionNo: number) =>
      `INSERT INTO crove_crm.quote (org_id, deal_id, party_id, valid_until, created_by, revises_id, revision) VALUES ($1, '${deal_id}', '${party}', '2031-01-31', $2, '${revisesId}', ${revisionNo}) RETURNING id`;
    await expect(as(o.orgId, o.member, (c) => c.query(revision(sent.id, otherDeal.id, 2), [o.orgId, o.member]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(o.orgId, o.member, (c) => c.query(revision(sent.id, deal.id, 5), [o.orgId, o.member]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(o.orgId, o.member, (c) => c.query(revision(draft.id, deal.id, 2), [o.orgId, o.member]))).rejects.toMatchObject({ code: '42501' });
    expect(await as(o.orgId, o.member, async (c) => (await c.query(revision(sent.id, deal.id, 2), [o.orgId, o.member])).rowCount)).toBe(1);
    // Links: not for a draft, not with a view already counted, never by a viewer; revoked once in the revoker's own name, nothing else changes.
    const insertLink = (quoteId: string, extra = '', value = '') =>
      `INSERT INTO crove_crm.quote_link (org_id, quote_id, token_sha256, expires_at, created_by${extra}) VALUES ($1, '${quoteId}', '${'a'.repeat(63)}${randomUUID().slice(0, 1).replace(/[^0-9a-f]/g, '1')}', now() + interval '10 days', $2${value}) RETURNING id`;
    await expect(as(o.orgId, o.member, (c) => c.query(insertLink(draft.id), [o.orgId, o.member]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(o.orgId, o.viewer, (c) => c.query(insertLink(sent.id), [o.orgId, o.viewer]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(o.orgId, o.member, (c) => c.query(insertLink(sent.id, ', views', ', 5'), [o.orgId, o.member]))).rejects.toMatchObject({ code: '42501' });
    // Nor in another person's name, nor with a made-up time that would stretch the 120 days.
    await expect(as(o.orgId, o.member, (c) => c.query(insertLink(sent.id), [o.orgId, o.owner]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(o.orgId, o.member, (c) => c.query(insertLink(sent.id, ', created_at', ", now() + interval '5 days'"), [o.orgId, o.member]))).rejects.toMatchObject({ code: '42501' });
    // A line does not move to a sent quote.
    await expect(as(o.orgId, o.member, (c) => c.query('UPDATE crove_crm.quote_line SET quote_id = $3 WHERE org_id = $1 AND quote_id = $2', [o.orgId, draft.id, sent.id]))).rejects.toMatchObject({ code: '42501' });
    const made = await o.link(o.member, sent.id);
    for (const set of ['views = 7', 'first_viewed_at = now()', "token_sha256 = '" + 'b'.repeat(64) + "'", 'expires_at = expires_at + interval \'1 day\'']) {
      await expect(as(o.orgId, o.member, (c) => c.query(`UPDATE crove_crm.quote_link SET ${set} WHERE org_id = $1 AND id = $2`, [o.orgId, made.linkId])), set).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    }
    await expect(as(o.orgId, o.member, (c) => c.query('UPDATE crove_crm.quote_link SET revoked_at = now(), revoked_by = $3 WHERE org_id = $1 AND id = $2', [o.orgId, made.linkId, o.owner]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('QUOTE_LINK_FORBIDDEN') });
    expect(await as(o.orgId, o.member, async (c) => (await c.query('UPDATE crove_crm.quote_link SET revoked_at = now(), revoked_by = $3 WHERE org_id = $1 AND id = $2', [o.orgId, made.linkId, o.member])).rowCount)).toBe(1);
    // No role deletes a link: it goes with its quote or the org.
    await expect(as(o.orgId, o.owner, (c) => c.query('DELETE FROM crove_crm.quote_link WHERE org_id = $1', [o.orgId]))).rejects.toMatchObject({ code: '42501' });
  });

  it('prints the letterhead the owner set, and only that', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('Công ty ABC'));
    const draft = await o.readyDraft(deal.id);
    await expect(o.exec(o.owner, 'crm.quote_setting.set', { validDays: 14, defaultVat: '10%', defaultTerms: null, email: 'khong-phai-email' })).rejects.toMatchObject({ code: 'QUOTE_EMAIL_INVALID' });
    await expect(o.exec(o.member, 'crm.quote_setting.set', { validDays: 14, defaultVat: '10%', defaultTerms: null, phone: '0909' })).rejects.toMatchObject({ status: 403 });
    expect(await o.exec(o.owner, 'crm.quote_setting.set', { validDays: 21, defaultVat: '8', defaultTerms: 'Thanh toán trong 7 ngày', phone: ' 028 3829 1234 ', email: 'ban-hang@congty.test', bankNote: 'Vietcombank 0071000123456\nCông ty ABC' })).toEqual({
      validDays: 21,
      defaultVat: '8%',
      defaultTerms: 'Thanh toán trong 7 ngày',
      phone: '028 3829 1234',
      email: 'ban-hang@congty.test',
      bankNote: 'Vietcombank 0071000123456\nCông ty ABC',
      logoFileId: null,
    });
    expect(await o.query(o.viewer, 'crm.quote_setting.get', {})).toMatchObject({ phone: '028 3829 1234', email: 'ban-hang@congty.test' });
    const { quote } = await o.send(o.member, draft, 'link');
    const made = await o.link(o.member, quote.id);
    const doc = (await quoteView(rt, { token: made.token })) as QuoteDocument;
    expect(doc.seller).toMatchObject({ phone: '028 3829 1234', email: 'ban-hang@congty.test', bankNote: 'Vietcombank 0071000123456\nCông ty ABC' });
    // The seller is frozen with the quote (#2826): a later change of the bank note, the contacts, the entity's name or the address changes no quote that was sent.
    const before = doc.seller;
    await o.exec(o.owner, 'crm.quote_setting.set', { validDays: 21, defaultVat: '8', defaultTerms: null, phone: '028 3829 0007', email: 'moi@congty.test', bankNote: 'Tài khoản MỚI 999' });
    await admin((c) => c.query("UPDATE crove_kernel.legal_entity SET name = 'Tên pháp nhân mới' WHERE org_id = $1", [o.orgId]));
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET address = 'Địa chỉ mới' WHERE org_id = $1", [o.orgId]));
    expect(((await quoteView(rt, { token: made.token })) as QuoteDocument).seller).toEqual(before);
    // A quote sent before the snapshot existed (no seller_name) shows the live letterhead.
    await admin((c) => c.query('UPDATE crove_crm.quote SET seller_name = NULL, seller_tax_code = NULL, seller_address = NULL, seller_phone = NULL, seller_email = NULL, seller_bank_note = NULL WHERE org_id = $1 AND id = $2', [o.orgId, quote.id]));
    expect(((await quoteView(rt, { token: made.token })) as QuoteDocument).seller).toMatchObject({ name: 'Tên pháp nhân mới', address: 'Địa chỉ mới', phone: '028 3829 0007', email: 'moi@congty.test', bankNote: 'Tài khoản MỚI 999' });
    // A revision takes a fresh snapshot when it is sent.
    const revision = await o.exec<Quote>(o.member, 'crm.quote.revise', { quoteId: quote.id });
    const resent = (await o.send(o.member, await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: revision.id, version: revision.version, lines: [item({ quantity: '3' })] }), 'link')).quote;
    const next = await o.link(o.member, resent.id);
    expect(((await quoteView(rt, { token: next.token })) as QuoteDocument).seller).toMatchObject({ name: 'Tên pháp nhân mới', phone: '028 3829 0007', bankNote: 'Tài khoản MỚI 999' });
    await o.exec(o.owner, 'crm.quote_setting.set', { validDays: 21, defaultVat: '8', defaultTerms: null, phone: '0123 456 789', email: null, bankNote: 'Lại đổi' });
    expect(((await quoteView(rt, { token: next.token })) as QuoteDocument).seller).toMatchObject({ phone: '028 3829 0007', bankNote: 'Tài khoản MỚI 999' });
    // The letterhead can be cleared.
    expect(await o.exec(o.owner, 'crm.quote_setting.set', { validDays: 21, defaultVat: '8', defaultTerms: null, phone: '', email: null, bankNote: null })).toMatchObject({ phone: null, email: null, bankNote: null });
  });

  // The logo of the letterhead (#2814): an owner or admin puts an image of the org's library on it, a quote takes the logo it has when it is sent, the page says there is one, and the image
  // comes only by the link's token.
  it('puts a logo on the letterhead: only an owner or admin, only a small PNG or JPEG of the org, frozen into a quote at send, and the page asks for the image by its own token', async () => {
    const o = await org();
    const store = new MemoryStore();
    // A file row as the upload would record it (source 'social': never extracted), with its bytes in the store.
    const makeFile = async (orgId: string, bytes: Uint8Array, over: { source?: string; contentType?: string; size?: number; width?: number | null; height?: number | null } = {}) => {
      const sha = sha256Hex(bytes);
      await store.put(fileKey(orgId, sha), bytes);
      const inserted = await admin((c) =>
        c.query<{ id: string }>(
          "INSERT INTO crove_kernel.file (org_id, sha256, storage_key, generation, filename, content_type, size_bytes, source, image_width, image_height) VALUES ($1, $2, $3, $4, 'logo', $5, $6, $7, $8, $9) RETURNING id",
          [orgId, sha, fileKey(orgId, sha), contentGeneration(sha), over.contentType ?? 'image/png', over.size ?? bytes.byteLength, over.source ?? 'social', over.width === undefined ? 120 : over.width, over.height === undefined ? 40 : over.height],
        ),
      );
      return inserted.rows[0]!.id;
    };
    const png = await makeFile(o.orgId, PNG_BYTES);
    expect(await o.query(o.viewer, 'crm.quote_setting.get', {})).toMatchObject({ logoFileId: null });

    // The refusals: a person who is not an owner or admin, a file that is not there or is another org's, not from the library, not a PNG or JPEG, too large.
    await expect(o.exec(o.member, 'crm.quote_setting.logo_set', { fileId: png })).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.viewer, 'crm.quote_setting.logo_set', { fileId: png })).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.owner, 'crm.quote_setting.logo_set', { fileId: randomUUID() })).rejects.toMatchObject({ code: 'QUOTE_LOGO_NOT_FOUND', status: 404 });
    const other = await org();
    await expect(o.exec(o.owner, 'crm.quote_setting.logo_set', { fileId: await makeFile(other.orgId, PNG_BYTES) })).rejects.toMatchObject({ code: 'QUOTE_LOGO_NOT_FOUND' });
    await expect(o.exec(o.owner, 'crm.quote_setting.logo_set', { fileId: await makeFile(o.orgId, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 1]), { source: 'upload' }) })).rejects.toMatchObject({ code: 'QUOTE_LOGO_NOT_FOUND' });
    await expect(o.exec(o.owner, 'crm.quote_setting.logo_set', { fileId: await makeFile(o.orgId, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 2]), { contentType: 'image/webp' }) })).rejects.toMatchObject({ code: 'QUOTE_LOGO_TYPE', status: 422 });
    await expect(o.exec(o.owner, 'crm.quote_setting.logo_set', { fileId: await makeFile(o.orgId, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 3]), { size: 512 * 1024 + 1 }) })).rejects.toMatchObject({ code: 'QUOTE_LOGO_TOO_LARGE', status: 422 });
    // A picture over 1024 on a side or over a megapixel in all, and one whose size the upload could not read, are refused (the PDF decodes a PNG on the API's thread).
    for (const [index, dims] of [[4, { width: 1025, height: 100 }], [5, { width: 100, height: 1025 }], [7, { width: null, height: null }]] as const) {
      const fileId = await makeFile(o.orgId, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, index]), dims);
      await expect(o.exec(o.owner, 'crm.quote_setting.logo_set', { fileId })).rejects.toMatchObject({ code: 'QUOTE_LOGO_DIMENSIONS', status: 422 });
    }
    // The most it takes is taken.
    expect(await o.exec(o.owner, 'crm.quote_setting.logo_set', { fileId: await makeFile(o.orgId, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 8]), { width: 1024, height: 1024 }) })).toMatchObject({ validDays: 14 });
    await o.exec(o.owner, 'crm.quote_setting.logo_remove', {});

    // Quote A is sent with no logo: it has none, and keeps having none when the org adds one (the freeze marker says it was decided at the send).
    const deal = await o.newDeal(await o.party('Công ty ABC'));
    const sentA = (await o.send(o.member, await o.readyDraft(deal.id), 'link')).quote;
    const linkA = await o.link(o.member, sentA.id);
    const documentOf = (user: string, quoteId: string) => o.query<{ logoFile: { id: string; contentType: string } | null }>(user, 'crm.quote.document', { quoteId });
    expect(((await quoteView(rt, { token: linkA.token })) as QuoteDocument).hasLogo).toBe(false);
    expect(await quoteLogo(rt, store, { token: linkA.token })).toBeNull();
    expect((await documentOf(o.viewer, sentA.id)).logoFile).toBeNull();
    // Setting one makes the settings row if there is none yet, with its defaults. An admin may.
    expect(await o.exec(o.adminUser, 'crm.quote_setting.logo_set', { fileId: png })).toMatchObject({ logoFileId: png, validDays: 14, defaultVat: '10%' });
    expect(((await quoteView(rt, { token: linkA.token })) as QuoteDocument).hasLogo).toBe(false);
    expect(await quoteLogo(rt, store, { token: linkA.token })).toBeNull();
    expect((await documentOf(o.viewer, sentA.id)).logoFile).toBeNull();

    // A draft shows the org's logo as it is; quote B, sent now, takes it and keeps it.
    const draftB = await o.readyDraft(deal.id);
    expect((await documentOf(o.viewer, draftB.id)).logoFile).toMatchObject({ id: png, contentType: 'image/png' });
    const sentB = (await o.send(o.member, draftB, 'link')).quote;
    const linkB = await o.link(o.member, sentB.id);
    expect(((await quoteView(rt, { token: linkB.token })) as QuoteDocument).hasLogo).toBe(true);
    const shown = await quoteLogo(rt, store, { token: linkB.token });
    expect(shown?.contentType).toBe('image/png');
    expect([...(shown?.bytes ?? [])]).toEqual([...PNG_BYTES]);
    expect(await admin((c) => c.query('SELECT seller_logo_file_id, seller_logo_frozen FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [o.orgId, sentB.id]).then((r) => r.rows[0]))).toEqual({ seller_logo_file_id: png, seller_logo_frozen: true });
    // The bytes have to be the type the row says, and the row has to be a logo type: otherwise nothing is served. (A file row never changes, so the quote is pointed at other rows.)
    const liar = await makeFile(o.orgId, new Uint8Array([...PNG_BYTES, 9]), { contentType: 'image/jpeg' });
    const webp = await makeFile(o.orgId, new Uint8Array([...PNG_BYTES, 8]), { contentType: 'image/webp' });
    const point = (fileId: string) => admin((c) => c.query('UPDATE crove_crm.quote SET seller_logo_file_id = $3 WHERE org_id = $1 AND id = $2', [o.orgId, sentB.id, fileId]));
    await point(liar);
    expect(await quoteLogo(rt, store, { token: linkB.token })).toBeNull();
    await point(webp);
    expect(await quoteLogo(rt, store, { token: linkB.token })).toBeNull();
    // A file that did not come from the photo library (a document, a scan) is not a logo even when it is a PNG.
    await point(await makeFile(o.orgId, new Uint8Array([...PNG_BYTES, 7]), { source: 'upload' }));
    expect(await quoteLogo(rt, store, { token: linkB.token })).toBeNull();
    expect(((await quoteView(rt, { token: linkB.token })) as QuoteDocument).hasLogo).toBe(false);
    expect((await documentOf(o.viewer, sentB.id)).logoFile).toBeNull();
    await point(png);
    expect((await quoteLogo(rt, store, { token: linkB.token }))?.contentType).toBe('image/png');
    // Another image replaces the org's logo: quote B keeps the one it was sent with, a new draft has the new one. The other settings keep what they were.
    await o.exec(o.owner, 'crm.quote_setting.set', { validDays: 30, defaultVat: '8', defaultTerms: null, phone: '028 3829 0007' });
    const jpeg = await makeFile(o.orgId, JPEG_BYTES, { contentType: 'image/jpeg' });
    expect(await o.exec(o.owner, 'crm.quote_setting.logo_set', { fileId: jpeg })).toMatchObject({ logoFileId: jpeg, validDays: 30, phone: '028 3829 0007' });
    expect((await quoteLogo(rt, store, { token: linkB.token }))?.contentType).toBe('image/png');
    expect((await documentOf(o.viewer, sentB.id)).logoFile?.id).toBe(png);
    expect((await documentOf(o.viewer, (await o.readyDraft(deal.id)).id)).logoFile?.id).toBe(jpeg);
    // A revision takes a fresh snapshot when it is sent: the new logo.
    const revision = await o.exec<Quote>(o.member, 'crm.quote.revise', { quoteId: sentB.id });
    const resent = (await o.send(o.member, await o.exec<Quote>(o.member, 'crm.quote.save', { quoteId: revision.id, version: revision.version, lines: [item({ quantity: '3' })] }), 'link')).quote;
    const linkR = await o.link(o.member, resent.id);
    expect((await quoteLogo(rt, store, { token: linkR.token }))?.contentType).toBe('image/jpeg');
    // A quote sent before the freeze existed (no marker) shows the org's logo as it is.
    await admin((c) => c.query('UPDATE crove_crm.quote SET seller_logo_frozen = false, seller_logo_file_id = NULL WHERE org_id = $1 AND id = $2', [o.orgId, resent.id]));
    expect((await documentOf(o.viewer, resent.id)).logoFile?.id).toBe(jpeg);
    expect(((await quoteView(rt, { token: linkR.token })) as QuoteDocument).hasLogo).toBe(true);
    // A file id without the marker is not a snapshot: the table refuses it.
    await expect(admin((c) => c.query('UPDATE crove_crm.quote SET seller_logo_file_id = $3 WHERE org_id = $1 AND id = $2', [o.orgId, resent.id, jpeg]))).rejects.toMatchObject({ code: '23514' });

    // One answer for every bad token and for a quote that is not open: the same as the page's.
    for (const bad of ['', 'abc', 'x'.repeat(43), 'x'.repeat(44), `${linkR.token}!`, null, 5]) expect(await quoteLogo(rt, store, { token: bad }), String(bad)).toBeNull();
    expect(await quoteLogo(rt, store, null)).toBeNull();
    // Another org's token never reaches this org's logo; a quote that was replaced by its revision (its links are revoked) and a revoked link get none.
    const otherDeal = await other.newDeal(await other.party('Công ty KHÁC'));
    const otherSent = await other.send(other.member, await other.readyDraft(otherDeal.id), 'link');
    const otherLink = await other.link(other.member, otherSent.quote.id);
    // The other org has a logo of its own (a JPEG): its token serves its own bytes, and no token of this org ever serves them.
    await other.exec(other.owner, 'crm.quote_setting.logo_set', { fileId: await makeFile(other.orgId, JPEG_BYTES, { contentType: 'image/jpeg' }) });
    const otherSent2 = await other.send(other.member, await other.readyDraft(otherDeal.id), 'link');
    const otherLink2 = await other.link(other.member, otherSent2.quote.id);
    const theirs = await quoteLogo(rt, store, { token: otherLink2.token });
    expect(theirs?.contentType).toBe('image/jpeg');
    expect([...(theirs?.bytes ?? [])]).toEqual([...JPEG_BYTES]);
    expect(await quoteLogo(rt, store, { token: otherLink.token })).toBeNull();
    expect(await quoteLogo(rt, store, { token: linkB.token })).toBeNull();
    expect(await quoteView(rt, { token: linkB.token })).toBeNull();
    await o.exec(o.member, 'crm.quote.revoke_link', { linkId: linkR.linkId });
    expect(await quoteLogo(rt, store, { token: linkR.token })).toBeNull();

    // Taking it off: new quotes have none; a quote that was sent with it keeps it (a draft shows none). Taking off a logo that is not there is not an error.
    expect(await o.exec(o.owner, 'crm.quote_setting.logo_remove', {})).toMatchObject({ logoFileId: null, validDays: 30 });
    expect(await o.exec(o.owner, 'crm.quote_setting.logo_remove', {})).toMatchObject({ logoFileId: null });
    await expect(o.exec(o.member, 'crm.quote_setting.logo_remove', {})).rejects.toMatchObject({ status: 403 });
    expect((await documentOf(o.viewer, (await o.readyDraft(deal.id)).id)).logoFile).toBeNull();
    const sentC = (await o.send(o.member, await o.readyDraft(deal.id), 'link')).quote;
    expect((await documentOf(o.viewer, sentC.id)).logoFile).toBeNull();
    // The audit rows hold the file id only, nothing of the image.
    const audits = await admin((c) => c.query<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'crm.quote_setting.logo_%'", [o.orgId]));
    expect(audits.rows.length).toBeGreaterThanOrEqual(3);
    for (const row of audits.rows) expect(JSON.stringify(row.detail)).not.toMatch(/PNG|filename|sha256|storage/i);
  });

  // The seam between the PDF (#2695) and sending (#2694): a sent quote's file says what the customer's page says, and does not move when the records behind it do.
  it('makes the PDF document of a sent quote from what was frozen at sending: the buyer snapshot, the day sent and the letterhead', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC', 'mua@khach.test');
    const deal = await o.newDeal(party);
    const draft = await o.readyDraft(deal.id);
    await o.exec(o.owner, 'crm.quote_setting.set', { validDays: 14, defaultVat: '10%', defaultTerms: null, phone: '028 3829 1234', email: 'ban-hang@congty.test', bankNote: 'Vietcombank 0071000123456' });
    // A draft is read live: the customer's record as it is now, with the letterhead the owner set.
    const live = await o.query<QuotePdfDocument>(o.viewer, 'crm.quote.document', { quoteId: draft.id });
    expect(live.buyer).toMatchObject({ name: 'Công ty ABC', address: '12 Lê Lợi, Quận 1', email: 'mua@khach.test' });
    expect(live.seller).toMatchObject({ phone: '028 3829 1234', email: 'ban-hang@congty.test', bankNote: 'Vietcombank 0071000123456' });
    expect(live.issuedOn).toBe(vietnamToday(new Date(draft.createdAt)));

    const { quote } = await o.send(o.member, draft, 'email', 'khac@khach.test');
    const before = await o.query<QuotePdfDocument>(o.viewer, 'crm.quote.document', { quoteId: quote.id });
    expect(before.quote.number).toBe(quote.number);
    expect(before.issuedOn).toBe(vietnamToday(new Date(quote.sentAt!)));
    expect(before.buyer).toEqual({ name: 'Công ty ABC', taxCode: '0312345678', address: '12 Lê Lợi, Quận 1', phone: null, email: 'khac@khach.test' });
    const entity = await admin((c) => c.query<{ name: string; tax_code: string | null }>('SELECT e.name, e.tax_code FROM crove_crm.quote q JOIN crove_kernel.legal_entity e ON e.org_id = q.org_id AND e.id = q.issuer_entity_id WHERE q.org_id = $1 AND q.id = $2', [o.orgId, quote.id]));
    expect(before.seller).toMatchObject({ name: entity.rows[0]!.name, taxCode: entity.rows[0]!.tax_code, phone: '028 3829 1234', email: 'ban-hang@congty.test', bankNote: 'Vietcombank 0071000123456' });
    // It is the seller the customer's page shows.
    const made = await o.link(o.member, quote.id);
    const page = (await quoteView(rt, { token: made.token })) as QuoteDocument;
    expect(page.seller).toMatchObject({ name: before.seller.name, taxCode: before.seller.taxCode, address: before.seller.address, phone: before.seller.phone, email: before.seller.email, bankNote: before.seller.bankNote });
    expect(page.buyer).toMatchObject({ name: before.buyer.name, taxCode: before.buyer.taxCode, address: before.buyer.address });

    // The customer's record changes later: the file of the sent quote does not (its bytes are the same).
    await admin((c) => c.query("UPDATE crove_kernel.party SET name = 'Tên mới', address = 'Nơi khác', email = 'moi@khach.test' WHERE org_id = $1 AND id = $2", [o.orgId, party]));
    const after = await o.query<QuotePdfDocument>(o.viewer, 'crm.quote.document', { quoteId: quote.id });
    expect(after.buyer).toEqual(before.buyer);
    expect(Buffer.from(renderQuotePdf(after)).equals(Buffer.from(renderQuotePdf(before)))).toBe(true);
    // The letterhead changes later too: the sent quote's file keeps the seller frozen at sending (#2826), and still shows what the customer's page shows.
    await o.exec(o.owner, 'crm.quote_setting.set', { validDays: 14, defaultVat: '10%', defaultTerms: null, phone: '028 3829 0007', email: 'moi@congty.test', bankNote: 'Tài khoản khác' });
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET address = 'Địa chỉ mới' WHERE org_id = $1", [o.orgId]));
    const afterLetterhead = await o.query<QuotePdfDocument>(o.viewer, 'crm.quote.document', { quoteId: quote.id });
    expect(afterLetterhead.seller).toEqual(before.seller);
    expect(Buffer.from(renderQuotePdf(afterLetterhead)).equals(Buffer.from(renderQuotePdf(before)))).toBe(true);
    expect(((await quoteView(rt, { token: made.token })) as QuoteDocument).seller).toMatchObject({ phone: before.seller.phone, bankNote: before.seller.bankNote, address: before.seller.address });
    // A new draft for the same customer reads the new record and the live letterhead.
    const next = await o.readyDraft((await o.newDeal(party)).id);
    const nextDocument = await o.query<QuotePdfDocument>(o.viewer, 'crm.quote.document', { quoteId: next.id });
    expect(nextDocument.buyer).toMatchObject({ name: 'Tên mới', address: 'Nơi khác' });
    expect(nextDocument.seller).toMatchObject({ phone: '028 3829 0007', bankNote: 'Tài khoản khác', address: 'Địa chỉ mới' });
  });

  it('writes audit rows with ids only, never the buyer, the token or a price', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('Công ty Bí mật Nguyễn Văn A', 'bi.mat@khach.test'));
    const draft = await o.readyDraft(deal.id, [item({ description: 'Hàng bí mật XYZ', unitPrice: '7770001' })]);
    const { quote } = await o.send(o.member, draft, 'email');
    const made = await o.link(o.member, quote.id);
    await o.exec(o.member, 'crm.quote.revoke_link', { linkId: made.linkId });
    const audit = await admin((c) => c.query<{ command: string; detail: unknown }>("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'crm.quote.%' AND outcome = 'ok'", [o.orgId]));
    const timeline = await admin((c) => c.query<{ kind: string; summary: string }>("SELECT kind, summary FROM crove_kernel.activity WHERE org_id = $1 AND kind = 'quote.sent'", [o.orgId]));
    expect(timeline.rows).toHaveLength(1);
    const text = JSON.stringify(audit.rows) + JSON.stringify(timeline.rows);
    for (const secret of ['Bí mật', 'bi.mat', 'bí mật', '7770001', made.token]) expect(text, secret).not.toContain(secret);
  });
});

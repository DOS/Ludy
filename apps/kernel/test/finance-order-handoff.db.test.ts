// SPDX-License-Identifier: AGPL-3.0-only
// The Kế toán side of the quote hand-off (#2818, ADR-0050 points 3 and 4) on a real PostgreSQL 17: an e-invoice draft from the facts of a sales order (whole lines, re-checked, the
// source kept on each line, one invoice per order line, a deleted draft frees its lines, a discounted line refused), the stock move of a delivered order line (keyed and
// idempotent on (order, line), a return is a reversal, a service moves nothing), and that issuing and delivering one line moves stock once, in either order.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { computeLineTotals, enterpriseCheckDigit, money, sumLineTotals } from '@crove/l10n-vn';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url)).toString('utf8');
const suite = ADMIN ? describe : describe.skip;

// The fixture's seller (fake tax code), series symbol and its two lines with a quantity (both 1 000 000 before VAT at 10%).
const SELLER_TAX_CODE = '0101234564';
const FIXTURE_SYMBOL = 'C26TAB';
const LINE_ONE = 'Cước dịch vụ internet tháng 9/2026';
const LINE_TWO = 'Phí quảng cáo Facebook';
// A synthetic tax code made at run time (the repository holds no checksum-valid one).
const PREFIX = '010010910';
const BUYER_TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
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

interface Draft {
  id: string;
  state: string;
  seriesId: string | null;
  subtotal: string;
  vatAmount: string;
  total: string;
  lines: Array<{ lineNo: number; description: string; amount: string; vatAmount: string; vatRate: string }>;
  issues: Array<{ field: string; code: string }>;
}
interface Move {
  id: string;
  quantity: string;
  source: string;
  date: string;
  reversed: boolean;
  reversesMoveId: string | null;
}
type Handoff = Record<string, unknown> & { orderId: string; lines: Array<Record<string, unknown>> };
interface HandoffLine {
  description: string;
  quantity?: string;
  unitPrice?: string;
  vatRate?: string;
  kind?: 'item' | 'text';
  discountPercent?: string;
}

const whole = (value: string): string => money(value).toFixed(0);

// The facts Engage's crm.sales_order.handoff reads, built here with the same line rule (decimal arithmetic, half up) so a payload adds up.
function handoffOf(legalEntityId: string, specs: HandoffLine[], options: { buyer?: Record<string, unknown> } = {}): Handoff {
  const lines = specs.map((s, i) => {
    if (s.kind === 'text') {
      return { lineNo: i + 1, kind: 'text', stockItemId: null, description: s.description, unit: null, quantity: null, unitPrice: null, discountPercent: '0', discountAmount: '0', amount: '0', vatRate: null, vatAmount: '0' };
    }
    const quantity = s.quantity ?? '1';
    const unitPrice = s.unitPrice ?? '1000000';
    const vatRate = s.vatRate ?? '10%';
    const discountPercent = s.discountPercent ?? '0';
    const net = computeLineTotals({ quantity, unitPrice, vatRate, discountPercent });
    const gross = computeLineTotals({ quantity, unitPrice, vatRate });
    return {
      lineNo: i + 1,
      kind: 'item',
      stockItemId: null,
      description: s.description,
      unit: 'Gói',
      quantity,
      unitPrice,
      discountPercent,
      discountAmount: money(gross.amount).minus(money(net.amount)).toFixed(0),
      amount: whole(net.amount),
      vatRate,
      vatAmount: whole(net.vatAmount),
    };
  });
  const totals = sumLineTotals(lines.map((l) => ({ amount: l.amount, vatAmount: l.vatAmount })));
  return {
    orderId: randomUUID(),
    orderNumber: 'DH-2026-0001',
    orderDate: '2026-11-08',
    legalEntityId,
    currency: 'VND',
    buyer: options.buyer ?? { kind: 'business', name: 'Công ty Mua Thử', taxCode: BUYER_TAX_CODE, address: '1 Phố Thử, Hà Nội', email: null },
    lines,
    subtotal: whole(totals.subtotal),
    vatAmount: whole(totals.vatAmount),
    total: whole(totals.total),
  };
}

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

suite('invoice draft and stock move from a sales order (#2818)', () => {
  const dbName = `crove_test_order_handoff_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@handoff.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; entity: string };
  async function org(options: { sellerOf?: boolean } = {}): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Đơn Hàng ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    if (options.sellerOf) await admin((c) => c.query('UPDATE crove_kernel.tenant SET tax_code = $2 WHERE org_id = $1', [orgId, SELLER_TAX_CODE]));
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 ORDER BY created_at LIMIT 1', [orgId]))[0]?.id;
    if (!entity) throw new Error('the org has no legal entity');
    return { orgId, owner, admin: adminUser, member, viewer, entity };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner, key: string = randomUUID()) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: key });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const refused = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(error?.code).toBe(code);
  };
  // A series the provider holds, as the sync would add it: the default of the entity.
  const addSeries = (o: Org, symbol = FIXTURE_SYMBOL) =>
    rows("INSERT INTO crove_finance.einvoice_series (org_id, legal_entity_id, provider, template_no, symbol, is_default) VALUES ($1, $2, 'sandbox', '1', $3, true)", [o.orgId, o.entity, symbol]);
  const draftFrom = (o: Org, handoff: Handoff, lineNos?: number[], user = o.owner, key?: string) => execute<Draft>(o, 'finance.einvoice.draft_from_order', { handoff, ...(lineNos ? { lineNos } : {}) }, user, key);
  const drafts = (o: Org) => query<Array<{ id: string }>>(o, 'finance.einvoice_draft.list', {});
  const sources = (o: Org) =>
    rows<{ source_id: string; source_line_no: number; line_no: number }>('SELECT source_id, source_line_no, line_no FROM crove_finance.einvoice_draft_line WHERE org_id = $1 AND source_kind = $2 ORDER BY source_id, source_line_no', [o.orgId, 'crm.sales_order']);
  const makeItem = (o: Org, extra: Record<string, unknown> = {}) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code: 'QC', name: 'Gói quảng cáo', unit: 'gói', stockAccount: '156', trade: 'goods', ...extra }).then((r) => r.id);
  const teach = (o: Org, itemId: string, key: string) => execute(o, 'finance.stock_alias.teach', { itemId, source: 'text', key, factor: '1' });
  const move = (o: Org, handoff: Handoff, lineNo: number, extra: Record<string, unknown> = {}, user = o.owner, key?: string) =>
    execute<{ status: string; moveId: string | null }>(o, 'finance.stock.move_from_order_line', { handoff, lineNo, date: today(), ...extra }, user, key);
  const moves = (o: Org, itemId: string) => query<Move[]>(o, 'finance.stock_move.list', { itemId });
  const onHand = async (o: Org, itemId: string) => (await query<Array<{ id: string; onHand: string }>>(o, 'finance.stock_item.list', {})).find((i) => i.id === itemId)?.onHand;
  const orderMoves = (o: Org, orderId: string) => rows<{ id: string }>("SELECT id FROM crove_finance.stock_move WHERE org_id = $1 AND source_type = 'crm_order_line' AND crm_order_id = $2", [o.orgId, orderId]);

  // The issue job moves a draft to issued as a worker login in the org's system context (as finance-einvoice-drafts.db.test.ts does): `submitting` first, with the triggers off.
  async function toSubmitting(o: Org, draftId: string) {
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query("UPDATE crove_finance.einvoice_draft SET state = 'submitting', submitted_at = pg_catalog.now() WHERE org_id = $1 AND id = $2 AND state = 'draft'", [o.orgId, draftId]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }
  async function asJob(o: Org, statements: Array<[string, unknown[]]>) {
    const c = await workerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
      for (const [text, params] of statements) await c.query(text, params);
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }
  async function issue(o: Org, draftId: string, number: string) {
    await toSubmitting(o, draftId);
    await asJob(o, [["UPDATE crove_finance.einvoice_draft SET state = 'issued', provider_ref = 'sbx-test', issued_number = $3, issued_at = pg_catalog.now() WHERE org_id = $1 AND id = $2", [o.orgId, draftId, number]]]);
  }
  const invoice = (number: string) => new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`));
  async function ingest(o: Org, bytes: Uint8Array) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return fileId;
  }
  // Reads the sale invoice, then the admin approves it with the two lines on 5111 (goods).
  async function post(o: Org, bytes: Uint8Array) {
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, o.orgId, await ingest(o, bytes));
    const edited = await rt.execute<{ revision: number }>(
      'kernel.proposal.edit',
      {
        id: proposalId,
        revision: 1,
        lineAccounts: [
          { lineNo: 1, debitAccount: '5111' },
          { lineNo: 2, debitAccount: '5111' },
        ],
      },
      { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    return rt.execute<{ documentId: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id: proposalId, revision: edited.revision },
      { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
  }

  beforeAll(async () => {
    extract = inProcessExtract();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 6 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    rt = register(db);
    worker = register(createDb(workerPool));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('finance.einvoice.draft_from_order', () => {
    it('makes a draft from the item lines, computed by the server, with the order line kept on each draft line and no buyer in the audit', async () => {
      const o = await org();
      await addSeries(o);
      const handoff = handoffOf(o.entity, [{ description: 'Hàng A', quantity: '2', unitPrice: '100000' }, { description: 'Ghi chú giao hàng', kind: 'text' }, { description: 'Hàng B', quantity: '1', unitPrice: '33333', vatRate: '8%' }]);
      const draft = await draftFrom(o, handoff);
      expect(draft.state).toBe('draft');
      expect(draft.seriesId).toEqual(expect.any(String));
      expect(draft.lines.map((l) => [l.lineNo, l.description, l.amount, l.vatAmount, l.vatRate])).toEqual([
        [1, 'Hàng A', '200000', '20000', '10%'],
        [2, 'Hàng B', '33333', '2667', '8%'],
      ]);
      expect([draft.subtotal, draft.vatAmount, draft.total]).toEqual(['233333', '22667', '256000']);
      expect(draft.issues).toEqual([]);
      // The draft's lines 1 and 2 are the order's lines 1 and 3 (the note is a text line and is not invoiced).
      expect((await sources(o)).map((s) => [s.source_id, s.source_line_no, s.line_no])).toEqual([
        [handoff.orderId, 1, 1],
        [handoff.orderId, 3, 2],
      ]);
      const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.einvoice.draft_from_order' AND outcome = 'ok'", [o.orgId]);
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0]?.detail)).not.toContain('Công ty Mua Thử');
      expect(JSON.stringify(audit[0]?.detail)).not.toContain(BUYER_TAX_CODE);
      expect(audit[0]?.detail).toMatchObject({ draftId: draft.id, orderId: handoff.orderId, lines: 2 });
    });

    it('runs the draft checks as on any draft: a buyer without an address is an issue on the draft, not a refusal', async () => {
      const o = await org();
      const handoff = handoffOf(o.entity, [{ description: 'Hàng A' }], { buyer: { kind: 'business', name: 'Công ty Mua Thử', taxCode: BUYER_TAX_CODE, address: null, email: null } });
      const draft = await draftFrom(o, handoff);
      expect(draft.issues.map((i) => i.code).sort()).toEqual(['BUYER_ADDRESS_REQUIRED', 'SERIES_REQUIRED']);
    });

    it('replays the same draft for the same idempotency key and refuses a second invoice of a line made with another key', async () => {
      const o = await org();
      const handoff = handoffOf(o.entity, [{ description: 'Hàng A' }, { description: 'Hàng B' }]);
      const key = randomUUID();
      const first = await draftFrom(o, handoff, [1], o.owner, key);
      const replay = await draftFrom(o, handoff, [1], o.owner, key);
      expect(replay.id).toBe(first.id);
      expect(await drafts(o)).toHaveLength(1);
      await refused(draftFrom(o, handoff, [1]), 'ORDER_LINE_ALREADY_INVOICED');
      // With no list the open lines are taken: line 2 only. Then nothing is left.
      const rest = await draftFrom(o, handoff);
      expect(rest.lines.map((l) => l.description)).toEqual(['Hàng B']);
      await refused(draftFrom(o, handoff), 'ORDER_NOTHING_TO_INVOICE');
      expect(await drafts(o)).toHaveLength(2);
    });

    it('lets only one of three invoices of the same line made at once through', async () => {
      const o = await org();
      const handoff = handoffOf(o.entity, [{ description: 'Hàng A' }]);
      const results = await Promise.allSettled([draftFrom(o, handoff), draftFrom(o, handoff), draftFrom(o, handoff)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(['ORDER_LINE_ALREADY_INVOICED', 'ORDER_NOTHING_TO_INVOICE']).toContain((r.reason as { code?: string }).code);
      expect(await sources(o)).toHaveLength(1);
    });

    it('frees the lines when the draft is deleted, and keeps them on a draft that was issued', async () => {
      const o = await org();
      await addSeries(o);
      const handoff = handoffOf(o.entity, [{ description: 'Hàng A' }, { description: 'Hàng B' }]);
      const one = await draftFrom(o, handoff, [1]);
      const two = await draftFrom(o, handoff, [2]);
      await execute(o, 'finance.einvoice_draft.delete', { draftId: one.id });
      expect((await sources(o)).map((s) => s.source_line_no)).toEqual([2]);
      // Line 1 is open again; line 2 stays on its draft, also once that is issued.
      await issue(o, two.id, '9001');
      const again = await draftFrom(o, handoff);
      expect(again.lines.map((l) => l.description)).toEqual(['Hàng A']);
      await refused(draftFrom(o, handoff, [2]), 'ORDER_LINE_ALREADY_INVOICED');
    });

    it('keeps the lines of a draft the issue job rejected: it is back to a draft in the same transaction, with its lines', async () => {
      const o = await org();
      await addSeries(o);
      const handoff = handoffOf(o.entity, [{ description: 'Hàng A' }]);
      const draft = await draftFrom(o, handoff);
      await toSubmitting(o, draft.id);
      await asJob(o, [
        ["UPDATE crove_finance.einvoice_draft SET state = 'rejected', provider_ref = 'sbx-r', error_code = 'INVALID_DATA' WHERE org_id = $1 AND id = $2", [o.orgId, draft.id]],
        ["UPDATE crove_finance.einvoice_draft SET state = 'draft', idempotency_key = pg_catalog.gen_random_uuid(), provider_ref = NULL, submitted_at = NULL, next_check_at = NULL, check_attempts = 0, channel_connection_id = NULL WHERE org_id = $1 AND id = $2", [o.orgId, draft.id]],
      ]);
      expect((await query<Draft>(o, 'finance.einvoice_draft.get', { draftId: draft.id })).state).toBe('draft');
      await refused(draftFrom(o, handoff, [1]), 'ORDER_LINE_ALREADY_INVOICED');
    });

    it('keeps the order line on a draft a person edits: a description fix is fine, a changed amount is refused, and the line stays invoiced', async () => {
      const o = await org();
      await addSeries(o);
      const handoff = handoffOf(o.entity, [{ description: 'Hàng A', quantity: '2', unitPrice: '100000' }]);
      const draft = await draftFrom(o, handoff);
      const form = (description: string, unitPrice: string) => ({
        draftId: draft.id,
        legalEntityId: null,
        date: today(),
        seriesId: draft.seriesId,
        buyer: { kind: 'business', partyId: null, taxCode: BUYER_TAX_CODE, name: 'Công ty Mua Thử', address: '1 Phố Thử, Hà Nội', email: null },
        lines: [{ description, unit: 'Gói', quantity: '2', unitPrice, vatRate: '10%' }],
      });
      await execute(o, 'finance.einvoice_draft.save', form('Hàng A (sửa chính tả)', '100000'));
      expect((await sources(o)).map((s) => [s.source_id, s.source_line_no])).toEqual([[handoff.orderId, 1]]);
      await refused(draftFrom(o, handoff, [1]), 'ORDER_LINE_ALREADY_INVOICED');
      await refused(execute(o, 'finance.einvoice_draft.save', form('Hàng A', '90000')), 'EINVOICE_SOURCE_LINE_LOCKED');
      expect(await sources(o)).toHaveLength(1);
    });

    it('refuses a discounted line, a text line, an unknown line and a payload whose amounts do not add up', async () => {
      const o = await org();
      const handoff = handoffOf(o.entity, [{ description: 'Hàng A', discountPercent: '10' }, { description: 'Hàng B' }, { description: 'Ghi chú', kind: 'text' }]);
      await refused(draftFrom(o, handoff, [1]), 'ORDER_LINE_DISCOUNTED');
      // No list: the open lines include the discounted one, so the call is refused rather than silently leaving it out.
      await refused(draftFrom(o, handoff), 'ORDER_LINE_DISCOUNTED');
      await refused(draftFrom(o, handoff, [3]), 'ORDER_LINE_NOT_INVOICEABLE');
      await refused(draftFrom(o, handoff, [9]), 'ORDER_LINE_UNKNOWN');
      const ok = await draftFrom(o, handoff, [2]);
      expect(ok.lines.map((l) => l.description)).toEqual(['Hàng B']);
      const clean = handoffOf(o.entity, [{ description: 'Hàng C' }]);
      const wrongLine = { ...clean, lines: [{ ...(clean.lines[0] as object), amount: '1' }] };
      await refused(draftFrom(o, wrongLine), 'ORDER_PAYLOAD_MISMATCH');
      await refused(draftFrom(o, { ...clean, total: '5' }), 'ORDER_PAYLOAD_MISMATCH');
      await refused(draftFrom(o, { ...clean, subtotal: '1' }), 'ORDER_PAYLOAD_MISMATCH');
      expect(await drafts(o)).toHaveLength(1);
    });

    it('is for owners, admins and members, not a viewer, and not for an entity the caller may not see', async () => {
      const o = await org();
      const handoff = handoffOf(o.entity, [{ description: 'Hàng A' }]);
      await refused(draftFrom(o, handoff, undefined, o.viewer), 'FORBIDDEN');
      await refused(draftFrom(o, { ...handoff, legalEntityId: randomUUID() }), 'LEGAL_ENTITY_NOT_ALLOWED');
      await draftFrom(o, handoff, undefined, o.member);
    });
  });

  describe('finance.stock.move_from_order_line', () => {
    it('takes the line out of stock on the delivery date, idempotent on (order, line): a retry with another key makes no second move', async () => {
      const o = await org();
      const item = await makeItem(o);
      await teach(o, item, LINE_TWO);
      const handoff = handoffOf(o.entity, [{ description: LINE_TWO, quantity: '2', unitPrice: '500000' }]);
      const first = await move(o, handoff, 1, { date: '2026-11-05' });
      expect(first.status).toBe('moved');
      expect(await moves(o, item)).toEqual([expect.objectContaining({ quantity: '-2', source: 'crm_order_line', date: '2026-11-05', reversed: false })]);
      const retry = await move(o, handoff, 1, { date: '2026-11-06' });
      expect(retry).toEqual({ status: 'already_moved', moveId: first.moveId });
      // The same idempotency key replays the first answer.
      const key = randomUUID();
      const other = handoffOf(o.entity, [{ description: LINE_TWO, quantity: '1' }]);
      const a = await move(o, other, 1, {}, o.owner, key);
      const b = await move(o, other, 1, {}, o.owner, key);
      expect(b).toEqual(a);
      expect(await onHand(o, item)).toBe('-3');
      expect(await orderMoves(o, handoff.orderId)).toHaveLength(1);
      const audit = await rows("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.stock.move_from_order_line' AND outcome = 'ok'", [o.orgId]);
      expect(JSON.stringify(audit)).not.toContain(LINE_TWO);
    });

    it('makes one move when the same line is delivered three times at once', async () => {
      const o = await org();
      const item = await makeItem(o);
      await teach(o, item, LINE_TWO);
      const handoff = handoffOf(o.entity, [{ description: LINE_TWO, quantity: '3' }]);
      const results = await Promise.all([move(o, handoff, 1), move(o, handoff, 1), move(o, handoff, 1)]);
      expect(results.filter((r) => r.status === 'moved')).toHaveLength(1);
      expect(new Set(results.map((r) => r.moveId)).size).toBe(1);
      expect(await onHand(o, item)).toBe('-3');
    });

    it('moves nothing for a service line, and says so for a line no item matches', async () => {
      const o = await org();
      const item = await makeItem(o);
      const handoff = handoffOf(o.entity, [{ description: 'Phí lắp đặt', kind: 'text' }, { description: 'Hàng chưa gán tên' }]);
      expect(await move(o, handoff, 1)).toEqual({ status: 'service', moveId: null });
      await refused(move(o, handoff, 2), 'STOCK_ORDER_LINE_NO_ITEM');
      await refused(move(o, handoff, 7), 'ORDER_LINE_UNKNOWN');
      expect(await moves(o, item)).toEqual([]);
    });

    it('takes the item the order line names when it is one of the entity, and refuses a date in the future and a payload that does not add up', async () => {
      const o = await org();
      const item = await makeItem(o);
      const handoff = handoffOf(o.entity, [{ description: 'Tên khác hẳn', quantity: '4' }]);
      const named = { ...handoff, lines: [{ ...(handoff.lines[0] as object), stockItemId: item }] };
      expect((await move(o, named, 1)).status).toBe('moved');
      expect(await onHand(o, item)).toBe('-4');
      const tomorrow = new Date(Date.now() + 7 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
      await refused(move(o, handoffOf(o.entity, [{ description: LINE_TWO }]), 1, { date: tomorrow }), 'ORDER_DATE_FUTURE');
      await refused(move(o, { ...named, total: '1' }, 1), 'ORDER_PAYLOAD_MISMATCH');
    });

    it('brings the stock back with a reversing move on a return, once, and does not deliver a returned line again', async () => {
      const o = await org();
      const item = await makeItem(o);
      await teach(o, item, LINE_TWO);
      const handoff = handoffOf(o.entity, [{ description: LINE_TWO, quantity: '2' }]);
      await refused(move(o, handoff, 1, { action: 'return' }), 'ORDER_LINE_NOT_DELIVERED');
      const delivered = await move(o, handoff, 1);
      const back = await move(o, handoff, 1, { action: 'return' });
      expect(back.status).toBe('returned');
      expect(await moves(o, item)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: delivered.moveId, reversed: true }), expect.objectContaining({ id: back.moveId, source: 'reversal', quantity: '2', reversesMoveId: delivered.moveId })]),
      );
      expect(await onHand(o, item)).toBe('0');
      expect(await move(o, handoff, 1, { action: 'return' })).toEqual({ status: 'already_returned', moveId: back.moveId });
      await refused(move(o, handoff, 1), 'ORDER_LINE_RETURNED');
      expect(await orderMoves(o, handoff.orderId)).toHaveLength(1);
    });

    it('refuses with a bare 409 a delivery of a line whose move sits in an entity the caller cannot see, instead of a 500', async () => {
      const o = await org();
      const branch = (
        await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Huế', 'branch', $2) RETURNING id", [o.orgId, o.owner])
      )[0]?.id as string;
      const limited = await identity('limited');
      await admin(async (c) => {
        await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, limited]);
        await c.query("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [o.orgId, limited, branch, o.owner]);
      });
      const mainItem = await makeItem(o);
      await teach(o, mainItem, LINE_TWO);
      const branchItem = await makeItem(o, { legalEntityId: branch, code: 'QC-HUE' });
      await teach(o, branchItem, LINE_TWO);
      const real = handoffOf(o.entity, [{ description: LINE_TWO }]);
      expect((await move(o, real, 1)).status).toBe('moved');
      // The same order id forged into the branch's hand-off: the first move is hidden from this caller, and the unique index answers.
      const forged = { ...handoffOf(branch, [{ description: LINE_TWO }]), orderId: real.orderId };
      const error = await move(o, forged, 1, {}, limited).then(
        () => null,
        (e: unknown) => e as { code?: string; status?: number; message?: string; details?: unknown },
      );
      expect(error?.code).toBe('ORDER_LINE_ALREADY_DELIVERED');
      expect(error?.status).toBe(409);
      expect(JSON.stringify(error)).not.toContain(real.orderId);
      expect(await orderMoves(o, real.orderId)).toHaveLength(1);
    });

    it('is for owners, admins and members, not a viewer, and the database itself allows one forward move per order line', async () => {
      const o = await org();
      const item = await makeItem(o);
      await teach(o, item, LINE_TWO);
      const handoff = handoffOf(o.entity, [{ description: LINE_TWO }]);
      await refused(move(o, handoff, 1, {}, o.viewer), 'FORBIDDEN');
      await move(o, handoff, 1, {}, o.member);
      const insert = (quantity: number, source: string, lineNo: number) =>
        rows('INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, crm_order_id, crm_order_line_no) VALUES ($1, $2, $3, $4, $5, $6, $7)', [o.orgId, item, '2026-11-06', quantity, source, handoff.orderId, lineNo]);
      await expect(insert(-1, 'crm_order_line', 1)).rejects.toMatchObject({ code: '23505' });
      // A move of that source takes stock out; another source names no order.
      await expect(insert(1, 'crm_order_line', 2)).rejects.toMatchObject({ code: '23514' });
      await expect(insert(1, 'manual', 1)).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('one stock move per order line, whether the invoice or the delivery comes first (ADR-0050 A4)', () => {
    // The order's lines are the fixture's two lines with a quantity (1 000 000 each), so the issued invoice recorded as a sale carries each draft line's source by its number and amount.
    const orderOf = (o: Org) =>
      handoffOf(o.entity, [
        { description: LINE_ONE, quantity: '1', unitPrice: '1000000' },
        { description: LINE_TWO, quantity: '2', unitPrice: '500000' },
      ]);
    const documentLines = (o: Org, documentId: string) =>
      rows<{ line_no: number; source_kind: string | null; source_line_no: number | null; source_id: string | null }>('SELECT line_no, source_kind, source_line_no, source_id FROM crove_finance.purchase_line WHERE org_id = $1 AND document_id = $2 ORDER BY line_no', [o.orgId, documentId]);
    const documentMoves = (o: Org) => rows("SELECT id FROM crove_finance.stock_move WHERE org_id = $1 AND source_type = 'document_line'", [o.orgId]);

    it('issues, records the invoice, then delivers: the document line moves nothing and is not unassigned, the delivery moves once', async () => {
      const o = await org({ sellerOf: true });
      await addSeries(o);
      const item = await makeItem(o);
      await teach(o, item, LINE_TWO);
      const handoff = orderOf(o);
      const draft = await draftFrom(o, handoff);
      await issue(o, draft.id, '0007020');
      const posted = await post(o, invoice('7020'));
      expect((await documentLines(o, posted.documentId)).slice(0, 2)).toEqual([
        { line_no: 1, source_kind: 'crm.sales_order', source_line_no: 1, source_id: handoff.orderId },
        { line_no: 2, source_kind: 'crm.sales_order', source_line_no: 2, source_id: handoff.orderId },
      ]);
      expect(await documentMoves(o)).toEqual([]);
      expect(await query(o, 'finance.stock.unassigned', {})).toEqual([]);
      await refused(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 2, itemId: item, factor: '1', teach: false }), 'STOCK_LINE_ORDER_SOURCE');
      expect((await move(o, handoff, 2)).status).toBe('moved');
      expect(await documentMoves(o)).toEqual([]);
      expect(await orderMoves(o, handoff.orderId)).toHaveLength(1);
      expect(await onHand(o, item)).toBe('-2');
    });

    it('delivers first, then issues and records the invoice: still exactly one move', async () => {
      const o = await org({ sellerOf: true });
      await addSeries(o);
      const item = await makeItem(o);
      await teach(o, item, LINE_TWO);
      const handoff = orderOf(o);
      expect((await move(o, handoff, 2)).status).toBe('moved');
      const draft = await draftFrom(o, handoff);
      await issue(o, draft.id, '7021');
      const posted = await post(o, invoice('7021'));
      expect(await documentMoves(o)).toEqual([]);
      expect(await orderMoves(o, handoff.orderId)).toHaveLength(1);
      expect(await onHand(o, item)).toBe('-2');
      expect((await documentLines(o, posted.documentId))[1]).toMatchObject({ source_kind: 'crm.sales_order', source_line_no: 2 });
    });

    it('records a sale that did not come from an order as before: its goods line still moves stock', async () => {
      const o = await org({ sellerOf: true });
      const item = await makeItem(o);
      await teach(o, item, LINE_TWO);
      const posted = await post(o, invoice('7022'));
      expect(await documentMoves(o)).toHaveLength(1);
      expect((await documentLines(o, posted.documentId)).every((l) => l.source_kind === null)).toBe(true);
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Stock from the lines of a posted document (#2512, ADR-0045 point 4), on a real PostgreSQL 17: a goods line that matches an item (by code, then by a taught name with its
// factor) makes a move when the document is approved, the others wait in the "Chưa gán hàng" list, a person assigns one (the move and the taught name), a sale takes stock
// out, a voided document takes its stock back, and the entry is the same with or without items.
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
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url)).toString('utf8');
const suite = ADMIN ? describe : describe.skip;

// The fixture's seller (fake tax code): the org is the seller in the sale tests, the buyer otherwise.
const SELLER_TAX_CODE = '0101234564';
// The fixture's two lines with a quantity: line 1 "Cước dịch vụ internet tháng 9/2026" (1 Tháng) and line 2 "Phí quảng cáo Facebook" (2 Gói).
const LINE_ONE = 'Cước dịch vụ internet tháng 9/2026';
const LINE_TWO = 'Phí quảng cáo Facebook';

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

interface Unassigned {
  documentId: string;
  lineNo: number;
  direction: string;
  description: string;
  unit: string | null;
  quantity: string;
}
interface Move {
  id: string;
  quantity: string;
  source: string;
  documentId: string | null;
  lineNo: number | null;
  date: string;
  reversed: boolean;
}

suite('stock from document lines (#2512)', () => {
  const dbName = `crove_test_stocklines_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@lines.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(options: { sellerOf?: boolean } = {}): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Hàng ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    if (options.sellerOf) await admin((c) => c.query('UPDATE crove_kernel.tenant SET tax_code = $2 WHERE org_id = $1', [orgId, SELLER_TAX_CODE]));
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const makeItem = (o: Org, extra: Record<string, unknown> = {}) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code: 'QC', name: 'Gói quảng cáo', unit: 'gói', stockAccount: '156', trade: 'goods', ...extra }).then((r) => r.id);
  const teach = (o: Org, itemId: string, key: string, factor = '1') => execute(o, 'finance.stock_alias.teach', { itemId, source: 'text', key, factor });
  const unassigned = (o: Org, user = o.owner) => query<Unassigned[]>(o, 'finance.stock.unassigned', {}, user);
  const moves = (o: Org, itemId: string) => query<Move[]>(o, 'finance.stock_move.list', { itemId });
  const onHand = async (o: Org, itemId: string) => (await query<Array<{ id: string; onHand: string }>>(o, 'finance.stock_item.list', {})).find((i) => i.id === itemId)?.onHand;

  // The fixture under another number and, when asked, another description for line 2 (a code, say); the org reads it as a sale when its tax code is the fixture's seller's.
  const invoice = (number: string, options: { lineTwo?: string } = {}) => {
    let xml = FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`);
    if (options.lineTwo) xml = xml.replace(`<THHDVu>${LINE_TWO}</THHDVu>`, `<THHDVu>${options.lineTwo}</THHDVu>`);
    return new TextEncoder().encode(xml);
  };
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
  // Reads the invoice, then the admin approves it with the accounts chosen for lines 1 and 2 (the document's lines 3 and 4 carry no quantity).
  async function post(o: Org, bytes: Uint8Array, account: string) {
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, o.orgId, await ingest(o, bytes));
    const edited = await rt.execute<{ revision: number }>(
      'kernel.proposal.edit',
      {
        id: proposalId,
        revision: 1,
        lineAccounts: [
          { lineNo: 1, debitAccount: account },
          { lineNo: 2, debitAccount: account },
        ],
      },
      { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    return rt.execute<{ documentId: string; journalEntryId: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id: proposalId, revision: edited.revision },
      { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
  }
  const journal = (entryId: string) => rows<{ account_code: string; debit: string; credit: string }>('SELECT account_code, debit::text, credit::text FROM crove_finance.journal_line WHERE entry_id = $1 ORDER BY line_no', [entryId]);

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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
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

  it('makes a stock-in for a goods line whose name was taught, at the factor, and lists the goods line that matched nothing', async () => {
    const o = await org();
    const item = await makeItem(o);
    // A package of the platform is ten items: two packages in the line are twenty on hand.
    await teach(o, item, `  ${LINE_TWO.toUpperCase()} `, '10');
    const posted = await post(o, invoice('7001'), '156');
    expect(await moves(o, item)).toEqual([expect.objectContaining({ quantity: '20', source: 'document_line', documentId: posted.documentId, lineNo: 2, reversed: false })]);
    expect(await onHand(o, item)).toBe('20');
    // Line 1 is a goods line with a quantity and no item: it waits, and moves nothing. The discount and the note carry no quantity and are not listed.
    expect(await unassigned(o)).toEqual([expect.objectContaining({ documentId: posted.documentId, lineNo: 1, direction: 'purchase', description: LINE_ONE, unit: 'Tháng', quantity: '1' })]);
  });

  it('matches by the item code first, in the same unit, and leaves a line in another unit for a person', async () => {
    const o = await org();
    // The item "QC" is counted in packages: a line that says QC in packages matches by its code; a line in kilograms does not.
    const item = await makeItem(o, { unit: 'Gói' });
    const posted = await post(o, invoice('7002', { lineTwo: 'qc' }), '156');
    expect((await moves(o, item)).map((m) => [m.quantity, m.lineNo])).toEqual([['2', 2]]);
    const other = await org();
    const kilo = await makeItem(other, { unit: 'kg' });
    await post(other, invoice('7003', { lineTwo: 'QC' }), '156');
    expect(await moves(other, kilo)).toEqual([]);
    expect((await unassigned(other)).map((l) => l.lineNo)).toEqual([1, 2]);
    expect(posted.documentId).toEqual(expect.any(String));
  });

  it('does not change the entry: the same invoice posts the same lines with items and without', async () => {
    const withItems = await org();
    const item = await makeItem(withItems);
    await teach(withItems, item, LINE_TWO);
    const bare = await org();
    const one = await post(withItems, invoice('7004'), '156');
    const two = await post(bare, invoice('7004'), '156');
    expect((await moves(withItems, item)).length).toBe(1);
    expect(await journal(one.journalEntryId)).toEqual(await journal(two.journalEntryId));
  });

  it('moves nothing for a line that is not on a goods account, and nothing for an inactive item', async () => {
    const o = await org();
    const item = await makeItem(o);
    await teach(o, item, LINE_TWO);
    await post(o, invoice('7005'), '6422');
    expect(await moves(o, item)).toEqual([]);
    expect(await unassigned(o)).toEqual([]);
    await execute(o, 'finance.stock_item.set_active', { itemId: item, active: false });
    await post(o, invoice('7006'), '156');
    expect(await moves(o, item)).toEqual([]);
    expect((await unassigned(o)).map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it('assigns a line to an item: the move, the taught name and the line leaving the list; a line is assigned once; a viewer cannot', async () => {
    const o = await org();
    const item = await makeItem(o, { code: 'NET', name: 'Internet', unit: 'tháng' });
    const posted = await post(o, invoice('7007'), '156');
    expect((await unassigned(o)).map((l) => l.lineNo)).toEqual([1, 2]);
    await expect(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 1, itemId: item }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const done = await execute<{ moveId: string; aliasId: string | null }>(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 1, itemId: item, factor: '2' }, o.member);
    expect(done.aliasId).toEqual(expect.any(String));
    expect(await moves(o, item)).toEqual([expect.objectContaining({ id: done.moveId, quantity: '2', source: 'document_line', lineNo: 1 })]);
    expect((await unassigned(o)).map((l) => l.lineNo)).toEqual([2]);
    await expect(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 1, itemId: item })).rejects.toMatchObject({ code: 'STOCK_LINE_ASSIGNED' });
    // The taught name catches the same line of the next invoice by itself.
    await post(o, invoice('7008'), '156');
    expect((await moves(o, item)).map((m) => m.quantity).sort()).toEqual(['2', '2']);
    // A line that is not goods, one that does not exist, and an item of no use any more.
    await expect(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 3, itemId: item })).rejects.toMatchObject({ code: expect.stringMatching(/^STOCK_LINE_(NOT_GOODS|NO_QUANTITY)$/) });
    await expect(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 99, itemId: item })).rejects.toMatchObject({ code: 'STOCK_LINE_NOT_FOUND' });
  });

  it('does not let a matched line be assigned again, nor a name that another item holds be taught', async () => {
    const o = await org();
    const first = await makeItem(o);
    const second = await makeItem(o, { code: 'KHAC', name: 'Khác' });
    await teach(o, first, LINE_ONE);
    const posted = await post(o, invoice('7009'), '156');
    // Line 1 matched the first item when it was posted: assigning it to the second is refused and moves nothing.
    await expect(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 1, itemId: second })).rejects.toMatchObject({ code: 'STOCK_LINE_ASSIGNED' });
    // A name is one item's: the same name with other spacing and case is the same name.
    await expect(teach(o, second, `  ${LINE_ONE.toUpperCase()}`)).rejects.toMatchObject({ code: 'STOCK_ALIAS_TAKEN' });
    expect(await moves(o, second)).toEqual([]);
  });

  it("takes stock out on a sale at the line's quantity", async () => {
    const o = await org({ sellerOf: true });
    const item = await makeItem(o);
    await teach(o, item, LINE_TWO);
    const posted = await post(o, invoice('7010'), '5111');
    expect(await moves(o, item)).toEqual([expect.objectContaining({ quantity: '-2', source: 'document_line', documentId: posted.documentId, lineNo: 2 })]);
    // Negative on hand is allowed and shown, not refused.
    expect(await onHand(o, item)).toBe('-2');
    expect((await unassigned(o)).map((l) => [l.direction, l.lineNo])).toEqual([['sale', 1]]);
  });

  it('moves stock for a sale line left on the default 511 when its text names an item, and does not list the other lines of 511 as unassigned', async () => {
    const o = await org({ sellerOf: true });
    const item = await makeItem(o);
    await teach(o, item, LINE_TWO);
    const posted = await post(o, invoice('7017'), '511');
    expect(await moves(o, item)).toEqual([expect.objectContaining({ quantity: '-2', source: 'document_line', documentId: posted.documentId, lineNo: 2 })]);
    // Line 1 is on 511 too and matches nothing: most lines there are services, so it is not listed, and the screen says how to have a goods line listed (book it to 5111).
    expect(await unassigned(o)).toEqual([]);
  });

  it('applies the factor of a name only to the unit it was taught in', async () => {
    const o = await org();
    const item = await makeItem(o, { unit: 'chai' });
    // "Phí quảng cáo Facebook" is bought in packages (Gói): a carton of twelve in the unit it was taught in, and nothing in another.
    await execute(o, 'finance.stock_alias.teach', { itemId: item, source: 'text', key: LINE_TWO, factor: '12', unit: 'Thùng' });
    await post(o, invoice('7018'), '156');
    expect(await moves(o, item)).toEqual([]);
    expect((await unassigned(o)).map((l) => l.lineNo)).toEqual([1, 2]);
    // The same name taught in the unit of the line (written another way) matches by itself.
    const other = await org();
    const bottle = await makeItem(other, { unit: 'chai' });
    await execute(other, 'finance.stock_alias.teach', { itemId: bottle, source: 'text', key: LINE_TWO, factor: '12', unit: ' gói ' });
    await post(other, invoice('7019'), '156');
    expect((await moves(other, bottle)).map((m) => m.quantity)).toEqual(['24']);
    // Taught again in another unit: refused, and a name taught with no unit stays as it was.
    await expect(execute(other, 'finance.stock_alias.teach', { itemId: bottle, source: 'text', key: LINE_TWO, factor: '12', unit: 'Thùng' })).rejects.toMatchObject({ code: 'STOCK_ALIAS_FACTOR' });
    await expect(execute(other, 'finance.stock_alias.teach', { itemId: bottle, source: 'text', key: LINE_TWO, factor: '12' })).resolves.toMatchObject({ existing: true });
    // A name taught with no unit, taught again in a unit: refused, never left matching every unit.
    const loose = await org();
    const crate = await makeItem(loose, { unit: 'chai' });
    await execute(loose, 'finance.stock_alias.teach', { itemId: crate, source: 'text', key: LINE_TWO, factor: '12' });
    await expect(execute(loose, 'finance.stock_alias.teach', { itemId: crate, source: 'text', key: LINE_TWO, factor: '12', unit: 'Thùng' })).rejects.toMatchObject({ code: 'STOCK_ALIAS_FACTOR' });
  });

  it('has no two items whose codes differ only in case, so a line is never left unmatched by an ambiguous code', async () => {
    const o = await org();
    await makeItem(o, { code: 'ABC' });
    await expect(makeItem(o, { code: 'abc', name: 'Hàng khác' })).rejects.toMatchObject({ code: 'STOCK_ITEM_CODE_EXISTS' });
    // Another entity's org keeps its own codes.
    const other = await org();
    await expect(makeItem(other, { code: 'abc' })).resolves.toEqual(expect.any(String));
  });

  it('takes the stock back when the document is voided, once, on the date of the reversal', async () => {
    const o = await org();
    const item = await makeItem(o);
    await teach(o, item, LINE_TWO, '3');
    const posted = await post(o, invoice('7011'), '156');
    expect(await onHand(o, item)).toBe('6');
    const request = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: posted.journalEntryId, entryDate: '2026-10-20', reason: 'Nhập nhầm' } }, o.admin);
    // Four eyes: the admin asked for it, the owner approves.
    await rt.execute('kernel.proposal.approve', { id: request.proposalId, revision: 1 }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    const list = await moves(o, item);
    expect(list.map((m) => [m.quantity, m.source, m.date])).toEqual(
      expect.arrayContaining([
        ['6', 'document_line', expect.any(String)],
        ['-6', 'reversal', '2026-10-20'],
      ]),
    );
    expect(list.find((m) => m.source === 'document_line')?.reversed).toBe(true);
    expect(await onHand(o, item)).toBe('0');
    // The voided document's lines leave the unassigned list.
    expect(await unassigned(o)).toEqual([]);
    // Its line cannot be assigned any more, and the database refuses a move of a line of a voided document whatever writes it.
    await expect(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 1, itemId: item })).rejects.toMatchObject({ code: 'STOCK_LINE_VOIDED' });
    await expect(
      rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, document_id, line_no, line_attempt) VALUES ($1, $2, current_date, 1, 'document_line', $3, 2, 2)", [o.orgId, item, posted.documentId]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('STOCK_LINE_VOIDED') });
  });

  it('lets a line assigned to the wrong item be reversed and assigned again, keeping the history; and a member who made a move can still be removed', async () => {
    const o = await org();
    const wrong = await makeItem(o, { code: 'A1', name: 'Nhầm', unit: 'Gói' });
    const right = await makeItem(o, { code: 'B1', name: 'Đúng', unit: 'Gói' });
    const posted = await post(o, invoice('7014'), '156');
    expect((await unassigned(o)).map((l) => l.lineNo)).toEqual([1, 2]);
    // A member assigns line 2 to the wrong item, then it is reversed: the line is unassigned again and nothing is lost from the history.
    const first = await execute<{ moveId: string }>(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 2, itemId: wrong, teach: false }, o.member);
    expect((await unassigned(o)).map((l) => l.lineNo)).toEqual([1]);
    await execute(o, 'finance.stock_move.reverse', { moveId: first.moveId });
    expect((await unassigned(o)).map((l) => l.lineNo)).toEqual([1, 2]);
    expect(await onHand(o, wrong)).toBe('0');
    // Assigned again, to the right item: its own move, the second try of the line.
    const second = await execute<{ moveId: string }>(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 2, itemId: right, teach: false });
    expect(await onHand(o, right)).toBe('2');
    expect((await unassigned(o)).map((l) => l.lineNo)).toEqual([1]);
    expect((await rows<{ id: string; line_attempt: number | null }>("SELECT id, line_attempt FROM crove_finance.stock_move WHERE org_id = $1 AND source_type = 'document_line' ORDER BY line_attempt", [o.orgId])).map((r) => [r.id, r.line_attempt])).toEqual([
      [first.moveId, 1],
      [second.moveId, 2],
    ]);
    // A third assignment while the second stands is refused; the database also refuses a try that skips the reversal of the one before.
    await expect(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 2, itemId: wrong, teach: false })).rejects.toMatchObject({ code: 'STOCK_LINE_ASSIGNED' });
    await expect(
      rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, document_id, line_no, line_attempt) VALUES ($1, $2, current_date, 1, 'document_line', $3, 2, 3)", [o.orgId, right, posted.documentId]),
    ).rejects.toMatchObject({ message: expect.stringContaining('STOCK_LINE_ATTEMPT') });
    // The member made a move; removing them does not touch the append-only row it left.
    await expect(execute(o, 'kernel.member.remove', { userId: o.member })).resolves.toBeDefined();
    expect((await rows<{ created_by: string | null }>('SELECT created_by FROM crove_finance.stock_move WHERE org_id = $1 AND id = $2', [o.orgId, first.moveId]))[0]?.created_by).toBe(o.member);
  });

  it('serializes an assignment with the void of its document: a voided document never keeps a move nothing reverses', async () => {
    const o = await org();
    const item = await makeItem(o, { unit: 'Gói' });
    const posted = await post(o, invoice('7015'), '156');
    // The void is run first and commits; the assignment that comes after sees it and refuses.
    const request = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: posted.journalEntryId, entryDate: '2026-10-20', reason: 'Nhập nhầm' } }, o.admin);
    await rt.execute('kernel.proposal.approve', { id: request.proposalId, revision: 1 }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 2, itemId: item })).rejects.toMatchObject({ code: 'STOCK_LINE_VOIDED' });
    expect(await moves(o, item)).toEqual([]);
  });

  it('reports the month the weighted average way, a stock card with its balances, and the month after from the closing', async () => {
    const o = await org();
    const item = await makeItem(o);
    await teach(o, item, LINE_TWO, '10');
    await post(o, invoice('7013'), '156');
    const made = await moves(o, item);
    const month = String(made[0]?.date).slice(0, 7);
    // A manual stock-out of five, later in the month.
    await rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, -5, 'manual')", [o.orgId, item, `${month}-28`]);
    const report = (m: string, user = o.owner) => rt.query<Array<Record<string, unknown>>>('finance.stock.report', { month: m }, { actor: asUser(user), orgId: o.orgId });
    // The line's amount (2 packages at 500,000) comes in with its twenty units: 50,000 each, and five leave at that.
    expect(await report(month)).toEqual([
      expect.objectContaining({ itemId: item, code: 'QC', openingQuantity: '0', openingValue: '0', inQuantity: '20', inValue: '1000000', outQuantity: '5', outValue: '250000', closingQuantity: '15', closingValue: '750000', unitCost: '50000' }),
    ]);
    const card = await rt.query<{ openingQuantity: string; closingQuantity: string; provisional: boolean; moves: Array<{ quantity: string; value: string | null; balance: string }> }>(
      'finance.stock.card',
      { itemId: item, month },
      { actor: asUser(o.viewer), orgId: o.orgId },
    );
    expect(card).toMatchObject({ openingQuantity: '0', closingQuantity: '15', provisional: true });
    expect(card.moves.map((m) => [m.quantity, m.value, m.balance])).toEqual([
      ['20', '1000000', '20'],
      ['-5', null, '15'],
    ]);
    // The next month starts from what was left, at what it was worth; a viewer reads the report too.
    const [year, mm] = month.split('-').map(Number) as [number, number];
    const next = mm === 12 ? `${year + 1}-01` : `${year}-${String(mm + 1).padStart(2, '0')}`;
    expect(await report(next, o.viewer)).toEqual([expect.objectContaining({ openingQuantity: '15', openingValue: '750000', closingQuantity: '15', closingValue: '750000', inQuantity: '0', outQuantity: '0' })]);
    // The month before the first move has nothing in it; another org's item is not found.
    expect(await report('2020-01')).toEqual([expect.objectContaining({ itemId: item, closingQuantity: '0', unitCost: null })]);
    const other = await org();
    await expect(rt.query('finance.stock.card', { itemId: item, month }, { actor: asUser(other.owner), orgId: other.orgId })).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
  });

  it("keeps one entity's stock apart from another's: an item of the other entity is refused for the line", async () => {
    const o = await org();
    const posted = await post(o, invoice('7012'), '156');
    const other = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, created_by) VALUES ($1, 'Pháp nhân phụ', $2) RETURNING id", [o.orgId, o.owner]))[0]?.id;
    const item = await makeItem(o, { legalEntityId: other });
    await expect(execute(o, 'finance.stock.assign', { documentId: posted.documentId, lineNo: 1, itemId: item })).rejects.toMatchObject({ code: 'STOCK_ITEM_ENTITY_MISMATCH' });
  });
});

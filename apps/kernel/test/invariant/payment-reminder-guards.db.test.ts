// SPDX-License-Identifier: AGPL-3.0-only
// Security invariants for customer payment reminders (#2491):
// 1. Legal-entity isolation: a member restricted to one legal entity cannot read, draft, or send another entity's
//    payment reminders, never sees another entity's lastReminder timestamp or level, and never triggers another entity's
//    3-day duplicate confirmation gate (including across merged parties and after 30-day payload retention purge).
// 2. Untrusted AI text rejection: AI-flagged reminder wording (aiLead / aiClosing) containing digits, number words,
//    or links is rejected deterministically before any mail is queued, even if the other field was manually edited.
// Self-contained under test/invariant/: imports only packages under test and local ./fixtures/.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { vietnamToday, type PaymentReminderDraft, type PaymentReminderList, type PaymentReminderSent } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { addDays, financeCommands, financeQueries } from '@ludy/mod-finance';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = vietnamToday();
const dated = (late: number) => addDays(TODAY, -(30 + late));

suite('payment reminder security invariants (#2491)', () => {
  const dbName = `crove_test_reminder_guards_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let kyselyPool: pg.Pool;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = dbIds ? dbIds.roleName(user) : user;
    url.password = password;
    return url.toString();
  };

  async function recordSale(orgId: string, partyId: string, num: string, late: number, entity: string): Promise<void> {
    await admin(async (c) => {
      const doc = randomUUID();
      const entry = randomUUID();
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
         VALUES ($1, $2, $3, 'C26TAA', $4, $5, 'VND', 500000, 0, 500000, 'sale', $6)`,
        [orgId, doc, partyId, num, dated(late), entity],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id)
         VALUES ($1, $2, $3, $4, 'finance.purchase_document', $5, $6)`,
        [orgId, entry, dated(late), `HĐ ${num}`, doc, entity],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id)
         VALUES ($1, $2, 1, '131', 500000, 0, $3, $4), ($1, $2, 2, '511', 0, 500000, NULL, $4)`,
        [orgId, entry, partyId, entity],
      );
      await c.query('COMMIT');
    });
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    kyselyPool = createDbPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 }, dbIds);
    const db = createDb(kyselyPool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 300_000);

  afterAll(async () => {
    await kyselyPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('denies cross-entity access and keeps reminder history and 3-day repeat state strictly per legal entity', async () => {
    const db = createDb(kyselyPool);
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@reminder-scope.test', name: null });
    const memberB = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'member-b@reminder-scope.test', name: null });
    const { orgId } = await createOrg(rt, asUser(owner), 'Doanh nghiệp Hai Pháp Nhân');

    let defaultEntity = '';
    let branch = '';
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh B', 'branch', $2) RETURNING id`, [orgId, owner])).rows[0]?.id as string;
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, memberB]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, memberB, branch, owner]);
    });

    const execute = <T>(name: string, input: unknown, user = owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId, idempotencyKey: randomUUID() });
    const query = <T>(name: string, input: unknown, user = owner) => rt.query<T>(name, input, { actor: asUser(user), orgId });
    const party = (await execute<{ partyId: string }>('kernel.party.create', { kind: 'organization', name: 'Khách Hàng Chung', email: 'shared@buyer.test' })).partyId;
    const dupParty = (await execute<{ partyId: string }>('kernel.party.create', { kind: 'organization', name: 'Khách Hàng Trùng', email: 'shared@buyer.test' })).partyId;

    await recordSale(orgId, dupParty, 'A1', 20, defaultEntity);
    await recordSale(orgId, party, 'B1', 20, branch);
    const draftA = await query<PaymentReminderDraft>('finance.payment_reminder.draft', { partyId: dupParty, legalEntityId: defaultEntity });
    await execute<PaymentReminderSent>('finance.payment_reminder.send', {
      partyId: draftA.partyId,
      legalEntityId: defaultEntity,
      level: draftA.level,
      total: draftA.total,
      invoiceKey: draftA.invoiceKey,
      subject: draftA.words.subject,
      greeting: draftA.words.greeting,
      lead: draftA.words.lead,
      closing: draftA.words.closing,
      payToId: null,
    });
    await admin(async (c) => {
      await c.query(`UPDATE crove_kernel.party SET duplicate_of = $1 WHERE org_id = $2 AND id = $3`, [party, orgId, dupParty]);
    });

    await expect(query<PaymentReminderList>('finance.payment_reminders.list', { legalEntityId: defaultEntity }, memberB)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    await expect(query<PaymentReminderDraft>('finance.payment_reminder.draft', { partyId: party, legalEntityId: defaultEntity }, memberB)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    await expect(
      execute<PaymentReminderSent>(
        'finance.payment_reminder.send',
        {
          partyId: party,
          legalEntityId: defaultEntity,
          level: draftA.level,
          total: draftA.total,
          invoiceKey: draftA.invoiceKey,
          subject: draftA.words.subject,
          greeting: draftA.words.greeting,
          lead: draftA.words.lead,
          closing: draftA.words.closing,
          payToId: null,
        },
        memberB,
      ),
    ).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });

    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.mail_message SET payload = NULL WHERE org_id = $1 AND source_id IN ($2, $3)`, [orgId, party, dupParty]);
      await c.query(
        `INSERT INTO crove_kernel.mail_message (org_id, stream, source, source_id, template_key, to_address, to_hash, subject, payload, message_id_header, status, sent_at)
         VALUES ($1, 'transactional', 'finance.payment_reminder.notice2', $2, 'finance.payment_reminder', 'shared@buyer.test', repeat('e', 64), 'Legacy', NULL, $3, 'sent', now())`,
        [orgId, dupParty, `<legacy-${randomUUID()}@reminder-scope.test>`],
      );
      await c.query('COMMIT');
    });

    const listA = await query<PaymentReminderList>('finance.payment_reminders.list', { legalEntityId: defaultEntity });
    expect(listA.customers.find((c) => c.partyId === party)?.lastReminder).toMatchObject({ level: 2 });

    const listB = await query<PaymentReminderList>('finance.payment_reminders.list', {}, memberB);
    expect(listB.customers.find((c) => c.partyId === party)?.lastReminder).toBeNull();

    const draftB = await query<PaymentReminderDraft>('finance.payment_reminder.draft', { partyId: party }, memberB);
    expect(draftB.lastReminder).toBeNull();
    const sentB = await execute<PaymentReminderSent>(
      'finance.payment_reminder.send',
      {
        partyId: draftB.partyId,
        level: draftB.level,
        total: draftB.total,
        invoiceKey: draftB.invoiceKey,
        subject: draftB.words.subject,
        greeting: draftB.words.greeting,
        lead: draftB.words.lead,
        closing: draftB.words.closing,
        payToId: null,
      },
      memberB,
    );
    expect(sentB.status).toBe('queued');

    await expect(
      execute<PaymentReminderSent>(
        'finance.payment_reminder.send',
        {
          partyId: draftB.partyId,
          level: draftB.level,
          total: draftB.total,
          invoiceKey: draftB.invoiceKey,
          subject: draftB.words.subject,
          greeting: draftB.words.greeting,
          lead: draftB.words.lead,
          closing: draftB.words.closing,
          payToId: null,
        },
        memberB,
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_REMINDED' });
  });

  it('rejects AI-flagged reminder wording containing digits, number words, or links before queueing any mail', async () => {
    const db = createDb(kyselyPool);
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner-ai@reminder-scope.test', name: null });
    const { orgId } = await createOrg(rt, asUser(owner), 'Công ty Kiểm Tra AI');
    const entity = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string);

    const execute = <T>(name: string, input: unknown) => rt.execute<T>(name, input, { actor: asUser(owner), orgId, idempotencyKey: randomUUID() });
    const query = <T>(name: string, input: unknown) => rt.query<T>(name, input, { actor: asUser(owner), orgId });
    const party = (await execute<{ partyId: string }>('kernel.party.create', { kind: 'organization', name: 'Khách Hàng AI', email: 'ai@buyer.test' })).partyId;
    await recordSale(orgId, party, 'AI1', 8, entity);
    const d = await query<PaymentReminderDraft>('finance.payment_reminder.draft', { partyId: party });

    const baseSend = {
      partyId: d.partyId,
      level: d.level,
      total: d.total,
      invoiceKey: d.invoiceKey,
      subject: d.words.subject,
      greeting: d.words.greeting,
      lead: d.words.lead,
      closing: d.words.closing,
      payToId: null,
    };

    await expect(
      execute('finance.payment_reminder.send', { ...baseSend, lead: 'Quý khách còn nợ 900.000 đồng.', aiLead: true }),
    ).rejects.toMatchObject({ code: 'REMINDER_AI_TEXT_INVALID', status: 422 });
    await expect(
      execute('finance.payment_reminder.send', { ...baseSend, closing: 'Xem tại https://evil.test/pay nhé.', aiClosing: true }),
    ).rejects.toMatchObject({ code: 'REMINDER_AI_TEXT_INVALID', status: 422 });
    await expect(
      execute('finance.payment_reminder.send', { ...baseSend, lead: 'Hóa đơn đã quá hạn ba ngày rồi.', aiLead: true }),
    ).rejects.toMatchObject({ code: 'REMINDER_AI_TEXT_INVALID', status: 422 });
    // Manual edit on lead does not bypass validation on an untouched AI closing.
    await expect(
      execute('finance.payment_reminder.send', { ...baseSend, lead: 'Lời người soạn.', aiLead: false, closing: 'Thanh toán qua pay.evil.vn.', aiClosing: true }),
    ).rejects.toMatchObject({ code: 'REMINDER_AI_TEXT_INVALID', status: 422 });

    const queued = await admin(async (c) => (await c.query('SELECT id FROM crove_kernel.mail_message WHERE org_id = $1 AND source_id = $2', [orgId, party])).rows);
    expect(queued).toHaveLength(0);
  });
});

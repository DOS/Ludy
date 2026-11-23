// SPDX-License-Identifier: AGPL-3.0-only
// Two database guards on the journal voucher's marketplace tags (#3214, notes 1 and 7, from the reviews of #3213) on PostgreSQL 17, as the real login roles.
// A voucher that names a settlement, a payout (settlement and bank line) or a fee document names a proposal executing exactly the command that posts that kind
// of voucher: finance.journal_voucher.record, or another tag's command, is refused (EFFECT_PROPOSAL_MISMATCH) while the own command writes, and an
// untagged voucher is not touched; staff are not checked. A bank line is held by one writer: a payout voucher is refused for a line an unreversed cash voucher
// holds, a cash voucher for a line an unreversed payout voucher holds, and a reversed one frees the line. Part of the invariant suite: keep it self-contained
// (package code under test, no helpers from outside test/invariant/). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { enterUser } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const LINES = JSON.stringify([
  { line_no: 1, account_code: '1121', debit: '100000', credit: '0' },
  { line_no: 2, account_code: '131', debit: '0', credit: '100000' },
]);
const MIRRORED = JSON.stringify([
  { line_no: 1, account_code: '1121', debit: '0', credit: '100000' },
  { line_no: 2, account_code: '131', debit: '100000', credit: '0' },
]);
const SETTLEMENT = 'finance.marketplace_settlement.record';
const PAYOUT = 'finance.marketplace_payout.record';
const FEE_CLEARING = 'finance.marketplace_fee_clearing.record';
const GENERIC = 'finance.journal_voucher.record';
const suite = ADMIN ? describe : describe.skip;

type Outcome = { ok: true; value: unknown } | { ok: false; code: string | undefined; message: string };

suite('the journal voucher marketplace tags on PostgreSQL (#3214)', () => {
  const dbName = `crove_test_voucher_tags_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  let pool: pg.Pool | undefined;
  let owner = '';
  let orgId = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // One transaction as the org's owner on the app's login role, always rolled back.
  async function asOwner(fn: (c: pg.Client) => Promise<unknown>): Promise<Outcome> {
    const c = createDbClient({ connectionString: appUrl }, dbIds);
    await c.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, owner, orgId);
      return { ok: true, value: await fn(c) };
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { ok: false, code: e.code, message: e.message };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  // A proposal of the command in the given state, written by the database owner (staff are not checked).
  const proposal = (command: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, eligible_approvers, authors, decided_by, decided_at, executed_command_id, legal_entity_id)
             VALUES ($1, 'test.tags', $2, 'approved', 'T3214', '{"n": 1}', ARRAY[$3::uuid], '[]', $3::uuid, now(), gen_random_uuid(),
                     (SELECT e.id FROM crove_kernel.legal_entity e WHERE e.org_id = $1 AND e.is_default)) RETURNING id`,
            [orgId, command, owner],
          )
        ).rows[0]?.id as string,
    );

  // A bank line of the platform's transfer: 100 000 in on 1121.
  const bankLine = () =>
    admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount)
             VALUES ($1, '1121', gen_random_uuid(), 1, '2026-10-15', 'sàn trả', 100000) RETURNING id`,
            [orgId],
          )
        ).rows[0]?.id as string,
    );

  const tagged = {
    settlement: { command: SETTLEMENT, columns: 'settlement_id', values: () => [randomUUID()] },
    payout: { command: PAYOUT, columns: 'payout_settlement_id, payout_bank_line_id', values: () => [randomUUID(), randomUUID()] },
    fee: { command: FEE_CLEARING, columns: 'fee_document_id', values: () => [randomUUID()] },
  } as const;

  const voucher = (proposalId: string | null, kind?: keyof typeof tagged) => (c: pg.Client) => {
    const tag = kind ? tagged[kind] : undefined;
    const values = tag?.values() ?? [];
    const marks = values.map((_, i) => `$${i + 3}`).join(', ');
    return c.query(
      `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id${tag ? `, ${tag.columns}` : ''})
       VALUES ($1, '2026-10-15', 'chứng từ', $2${tag ? `, ${marks}` : ''})`,
      [orgId, proposalId, ...values],
    );
  };

  // A payout voucher of the settlement on the bank line; with `entry`, its journal entry too (a posted payout), and with `reversed` the entry's reversal.
  async function payoutVoucher(c: pg.Client, line: string, options: { entry?: boolean; reversed?: boolean } = {}): Promise<string> {
    const id = (
      await c.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payout_settlement_id, payout_bank_line_id)
         VALUES ($1, '2026-10-15', 'sàn trả', $2, $3, $4) RETURNING id`,
        [orgId, await proposal(PAYOUT), randomUUID(), line],
      )
    ).rows[0]?.id as string;
    if (options.entry) await post(c, 'finance.journal_voucher', id, options.reversed);
    return id;
  }

  // A bank voucher on the line (money in on 1121 for the date and amount of the line); entry and reversal as above.
  async function cashVoucher(c: pg.Client, line: string, options: { entry?: boolean; reversed?: boolean } = {}): Promise<string> {
    const id = (
      await c.query<{ id: string }>(
        `INSERT INTO crove_finance.cash_voucher (org_id, voucher_type, number, voucher_date, cash_account, description, amount, bank_line_id)
         VALUES ($1, 'bank_credit', 0, '2026-10-15', '1121', 'thu tiền', 100000, $2) RETURNING id`,
        [orgId, line],
      )
    ).rows[0]?.id as string;
    if (options.entry) await post(c, 'finance.cash_voucher', id, options.reversed);
    return id;
  }

  // The voucher's journal entry and, when asked, the reversal entry ordered by an approved finance.journal.reverse proposal.
  async function post(c: pg.Client, sourceType: string, sourceId: string, reversed = false): Promise<void> {
    const { rows } = await c.query<{ id: string }>(`SELECT crove_finance.post_journal_entry('2026-10-15'::date, 'gốc', $1, $2::uuid, $3::jsonb) AS id`, [sourceType, sourceId, LINES]);
    if (reversed) {
      await c.query(`SELECT crove_finance.post_journal_entry('2026-10-15'::date, 'đảo', 'kernel.proposal', $1::uuid, $2::jsonb, $3::uuid, 1)`, [await proposal('finance.journal.reverse'), MIRRORED, rows[0]?.id]);
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const url = new URL(adminUrl);
    url.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createDbPool({ connectionString: appUrl, max: 2 }, dbIds);
    const db = createDb(pool);
    const rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@voucher-tags.test', name: null });
    ({ orgId } = await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Chứng từ có nhãn'));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('a tag is written only by its own command (note 7)', () => {
    for (const kind of Object.keys(tagged) as (keyof typeof tagged)[]) {
      it(`a ${kind} voucher is written by ${tagged[kind].command} only`, async () => {
        await expect(asOwner(voucher(await proposal(tagged[kind].command), kind))).resolves.toMatchObject({ ok: true });
        for (const other of [GENERIC, ...Object.values(tagged).map((t) => t.command)].filter((c) => c !== tagged[kind].command)) {
          await expect(asOwner(voucher(await proposal(other), kind)), other).resolves.toMatchObject({ ok: false, code: '23514', message: 'EFFECT_PROPOSAL_MISMATCH' });
        }
      });
    }

    it('writes an untagged voucher under the generic command and leaves staff unchecked', async () => {
      await expect(asOwner(voucher(await proposal(GENERIC)))).resolves.toMatchObject({ ok: true });
      // Staff (the database owner) are not checked, as for a_effect_proposal.
      const staff = await admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT crove_kernel.enter_system_context($1::uuid)`, [orgId]);
          await voucher(await proposal(GENERIC), 'settlement')(c);
          return true;
        } catch {
          return false;
        } finally {
          await c.query('ROLLBACK').catch(() => {});
        }
      });
      expect(staff).toBe(true);
    });
  });

  describe('a bank line is held by one writer (note 1)', () => {
    it('refuses a payout for a line an unreversed bank voucher holds, and takes it once that voucher is reversed', async () => {
      const line = await bankLine();
      await expect(asOwner(async (c) => (await cashVoucher(c, line, { entry: true }), payoutVoucher(c, line)))).resolves.toMatchObject({ ok: false, code: '23505' });
      await expect(asOwner(async (c) => (await cashVoucher(c, line, { entry: true, reversed: true }), payoutVoucher(c, line)))).resolves.toMatchObject({ ok: true });
    });

    it('refuses a bank voucher for a line an unreversed payout holds, and takes it once that payout is reversed', async () => {
      const line = await bankLine();
      await expect(asOwner(async (c) => (await payoutVoucher(c, line, { entry: true }), cashVoucher(c, line)))).resolves.toMatchObject({ ok: false, code: '23505' });
      await expect(asOwner(async (c) => (await payoutVoucher(c, line, { entry: true, reversed: true }), cashVoucher(c, line)))).resolves.toMatchObject({ ok: true });
    });

    it('refuses a bank voucher for a line a payout of the same transaction holds before its entry is stored', async () => {
      const line = await bankLine();
      await expect(asOwner(async (c) => (await payoutVoucher(c, line), cashVoucher(c, line)))).resolves.toMatchObject({ ok: false, code: '23505' });
    });

    it('refuses a payout for a line a bank voucher of the same transaction holds before its entry is stored', async () => {
      const line = await bankLine();
      await expect(asOwner(async (c) => (await cashVoucher(c, line), payoutVoucher(c, line)))).resolves.toMatchObject({ ok: false, code: '23505' });
    });

    it('leaves a line no payout holds to its bank voucher', async () => {
      const line = await bankLine();
      await expect(asOwner((c) => cashVoucher(c, line, { entry: true }))).resolves.toMatchObject({ ok: true });
    });
  });
});

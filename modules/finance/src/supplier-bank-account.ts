// SPDX-License-Identifier: AGPL-3.0-only
// A supplier's bank accounts and the history of their changes (#3113 S1; JOY's answers of 2026-11-14 on #3113). V5 rule 3 (a supplier's account changed while a payment to that supplier waits) needs
// this data. The full number is SEALED under the supplier's own subject key (`supplier:<party_id>`, ADR-0017) with the holder's name, so one shred erases both; a subject-keyed hash of the digits
// (ctx.subjectHash, #3751) tells "the same account" and "the account changed" without the number (surviving credential key rotations and erased when the subject key is shredded; legacy rows hashed under
// credential keys keep working via ctx.keyedHash); the last four digits are for display. A change never edits a number: the old row is retired and a new one added, with one row in the append-only history.
// Every change needs a fresh second factor (R3) and an owner or an admin; no agent, no MCP tool, no signal ever carries a number.
// - finance.supplier_bank_account.add / .replace / .retire: R3, owners and admins.
// - finance.supplier_bank_account.erase: R3, owners only; retires the accounts, shreds the supplier's key so the sealed number and holder can never be opened again, and wipes last4 and stored hashes with tombstones.
// - finance.supplier_bank_account.list: the accounts (bank, last four, status) and the change history of a supplier. Never a number, never a holder.
// - finance.signals.supplier_bank_changes: rule 3's first read (contract in packages/kernel-contract/src/signals.ts).
import { timingSafeEqual } from 'node:crypto';
import {
  SIGNALS_MAX_CRM,
  SIGNAL_PARTIAL_VIEW_CODE,
  SUPPLIER_BANK_CHANGE_DAYS,
  zFinanceSupplierBankChangeSignals,
  zSupplierBankAccountAdd,
  zSupplierBankAccountErase,
  zSupplierBankAccountListInput,
  zSupplierBankAccountRetire,
  zSupplierBankAccountReplace,
  type FinanceSupplierBankChangeSignal,
  type SupplierBankAccount,
  type SupplierBankAccountErased,
  type SupplierBankAccountList,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@ludy/kernel-runtime';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const OWNERS: readonly MemberRole[] = ['owner'];
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// Where each sealed value is stored: a value opens only at the place it was sealed for.
// Category B (ADR-0054 section 2): immutable AES-256-GCM SubjectVault AAD place strings; kept as crove_finance.* so pre-cutover sealed bank details continue to open.
export const NUMBER_PLACE = 'crove_finance.supplier_bank_account.number_sealed';
export const HOLDER_PLACE = 'crove_finance.supplier_bank_account.account_holder_sealed';
// The subject every sealed value of one supplier is under: one key to shred.
export const supplierSubject = (partyId: string): string => `supplier:${partyId}`;
export const HASH_PURPOSE = 'supplier_bank_account.number';
// Marker stored in `hash_key_id` for rows hashed under the supplier's subject data key (#3751); legacy rows carry the credential key id used by `ctx.keyedHash`.
export const SUBJECT_HASH_KEY_ID = 'subject:v1';

type Trx = CommandContext['trx'];
type AccountRow = { id: string; party_id: string; bank_name: string; last4: string; status: string; number_hash: string; hash_key_id: string; created_at: Date | string; retired_at: Date | string | null };

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

const view = (row: AccountRow): SupplierBankAccount => ({
  id: row.id,
  partyId: row.party_id,
  bankName: row.bank_name,
  last4: row.last4,
  status: row.status as SupplierBankAccount['status'],
  createdAt: iso(row.created_at) as string,
  retiredAt: iso(row.retired_at),
});

// The digits of what a person typed: spaces, dots and dashes are dropped, 6 to 20 digits remain. The one place a number is normalized.
export function normalizeAccountNumber(text: string): string {
  const digits = text.replace(/[\s.-]/g, '');
  if (!/^[0-9]{6,20}$/.test(digits)) throw new DomainError('SUPPLIER_BANK_NUMBER_INVALID', 422, 'Số tài khoản phải gồm 6 đến 20 chữ số');
  return digits;
}

// Computes the subject-keyed hash of the digits (#3751), ensuring the supplier's subject key exists.
async function hashNumber(ctx: Pick<CommandContext, 'subjectHash'>, partyId: string, digits: string): Promise<{ hash: string; keyId: string }> {
  return { hash: await ctx.subjectHash(supplierSubject(partyId), HASH_PURPOSE, digits), keyId: SUBJECT_HASH_KEY_ID };
}

const HEX64 = /^[0-9a-f]{64}$/;

function equalDigests(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export type AccountHashLookupContext = {
  keyedHash: CommandContext['keyedHash'];
  subjectHash: (ref: string, purpose: string, value: string, opts: { create: false }) => Promise<string | null>;
};

// Serializes supplier bank erasure against concurrent payment request creation (`supplierPaymentPrepare`) for the same supplier.
export async function lockSupplierBank(trx: Trx, orgId: string, partyId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.supplier_bank:${orgId}:${partyId.toLowerCase()}`}, 0))`.execute(trx);
}

// Whether `digits` matches a stored account's hash. Subject-keyed rows (`SUBJECT_HASH_KEY_ID`) look up the supplier's subject key without creating one (an erased key answers false);
// legacy rows hashed under a credential key id check via `ctx.keyedHash` while that key is kept, answering false once retired. Erased tombstones are rejected before any key lookup.
export async function matchesAccountHash(
  ctx: AccountHashLookupContext,
  partyId: string,
  digits: string,
  row: Pick<AccountRow, 'number_hash' | 'hash_key_id'>,
): Promise<boolean> {
  if (!HEX64.test(row.number_hash)) return false;
  if (row.hash_key_id === SUBJECT_HASH_KEY_ID) {
    const hash = await ctx.subjectHash(supplierSubject(partyId), HASH_PURPOSE, digits, { create: false });
    return hash !== null && equalDigests(hash, row.number_hash);
  }
  try {
    return equalDigests(ctx.keyedHash(HASH_PURPOSE, digits, row.hash_key_id), row.number_hash);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'KEYED_HASH_KEY_RETIRED') return false;
    throw error;
  }
}

// The time the actor's second factor last passed (the proof the step-up held): R3 refuses a stale one before the handler runs, so a missing time is a refusal here too.
function stepUpAt(ctx: Pick<CommandContext, 'actor'>): Date {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  const at = ctx.actor.mfaAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) throw new DomainError('STEP_UP_REQUIRED', 401, 'Cần xác thực hai lớp gần đây để thực hiện việc này');
  return new Date(at * 1000);
}

const supplierNotFound = () => new DomainError('SUPPLIER_NOT_FOUND', 404, 'Không tìm thấy nhà cung cấp');
const accountNotFound = () => new DomainError('SUPPLIER_BANK_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản ngân hàng này');

async function requireSupplier(trx: Trx, orgId: string, partyId: string): Promise<void> {
  const party = await trx.selectFrom('ludy_kernel.party').select('id').where('org_id', '=', orgId).where('id', '=', partyId.toLowerCase()).forShare().executeTakeFirst();
  if (!party) throw supplierNotFound();
}

async function loadAccount(trx: Trx, orgId: string, accountId: string): Promise<AccountRow> {
  const row = await trx
    .selectFrom('ludy_finance.supplier_bank_account')
    .select(['id', 'party_id', 'bank_name', 'last4', 'status', 'number_hash', 'hash_key_id', 'created_at', 'retired_at'])
    .where('org_id', '=', orgId)
    .where('id', '=', accountId.toLowerCase())
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw accountNotFound();
  return row;
}

async function loadLockedAccountForSupplier(trx: Trx, orgId: string, accountId: string): Promise<AccountRow> {
  const existing = await trx
    .selectFrom('ludy_finance.supplier_bank_account')
    .select('party_id')
    .where('org_id', '=', orgId)
    .where('id', '=', accountId.toLowerCase())
    .executeTakeFirst();
  if (!existing) throw accountNotFound();
  await lockSupplierBank(trx, orgId, existing.party_id);
  return loadAccount(trx, orgId, accountId);
}

async function insertChange(
  ctx: CommandContext,
  change: { partyId: string; accountId: string; kind: 'added' | 'replaced' | 'retired'; oldHash: string | null; newHash: string | null },
): Promise<void> {
  await ctx.trx
    .insertInto('ludy_finance.supplier_bank_account_change')
    .values({
      org_id: ctx.orgId,
      party_id: change.partyId,
      account_id: change.accountId,
      kind: change.kind,
      old_number_hash: change.oldHash,
      new_number_hash: change.newHash,
      changed_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      step_up_at: stepUpAt(ctx),
    })
    .execute();
}

// A new active row for a supplier: the number and the holder sealed under the supplier's key, the subject-keyed hash, the last four digits.
async function insertAccount(ctx: CommandContext, partyId: string, input: { bankName: string; accountHolder: string; accountNumber: string }): Promise<{ row: AccountRow; hash: string }> {
  const digits = normalizeAccountNumber(input.accountNumber);
  // Compute the subject-keyed hash once up front; if an active duplicate exists, the transaction rolls back cleanly.
  const { hash, keyId } = await hashNumber(ctx, partyId, digits);
  // Each active account is judged under its own hash scheme (subject-keyed rows under the supplier's subject key; legacy rows under their credential key id).
  const active = await ctx.trx
    .selectFrom('ludy_finance.supplier_bank_account')
    .select(['number_hash', 'hash_key_id'])
    .where('org_id', '=', ctx.orgId)
    .where('party_id', '=', partyId)
    .where('status', '=', 'active')
    .execute();
  for (const row of active) {
    const matched = row.hash_key_id === SUBJECT_HASH_KEY_ID ? equalDigests(hash, row.number_hash) : await matchesAccountHash(ctx, partyId, digits, row);
    if (matched) throw new DomainError('SUPPLIER_BANK_ACCOUNT_EXISTS', 409, 'Nhà cung cấp này đã có tài khoản với số đó');
  }
  const subject = supplierSubject(partyId);
  const numberSealed = await ctx.seal(subject, NUMBER_PLACE, digits);
  const holderSealed = await ctx.seal(subject, HOLDER_PLACE, input.accountHolder);
  const row = await ctx.trx
    .insertInto('ludy_finance.supplier_bank_account')
    .values({
      org_id: ctx.orgId,
      party_id: partyId,
      bank_name: input.bankName,
      account_holder_sealed: holderSealed,
      number_sealed: numberSealed,
      number_hash: hash,
      hash_key_id: keyId,
      last4: digits.slice(-4),
      created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
    })
    .returning(['id', 'party_id', 'bank_name', 'last4', 'status', 'number_hash', 'hash_key_id', 'created_at', 'retired_at'])
    .executeTakeFirstOrThrow();
  return { row, hash };
}

export const supplierBankAccountAdd = defineCommand({
  name: 'finance.supplier_bank_account.add',
  input: zSupplierBankAccountAdd,
  // The full number and holder are sealed under the supplier's key; keep them out of audit and idempotency input hashes (#3751).
  sealedInput: ['accountNumber', 'accountHolder'],
  // A supplier's account is where money goes: a human with a fresh second factor, an owner or an admin; never an agent, never over MCP.
  risk: 'R3',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.supplier_bank_account', id: input.partyId }),
  handler: async (ctx, input): Promise<SupplierBankAccount> => {
    const partyId = input.partyId.toLowerCase();
    await requireSupplier(ctx.trx, ctx.orgId, partyId);
    await lockSupplierBank(ctx.trx, ctx.orgId, partyId);
    const { row, hash } = await insertAccount(ctx, partyId, input);
    await insertChange(ctx, { partyId, accountId: row.id, kind: 'added', oldHash: null, newHash: hash });
    // The party, the account and the kind: never the number, the last four digits or the hash in full.
    ctx.audit({ partyId, accountId: row.id, kind: 'added' });
    return view(row);
  },
});

export const supplierBankAccountReplace = defineCommand({
  name: 'finance.supplier_bank_account.replace',
  input: zSupplierBankAccountReplace,
  sealedInput: ['accountNumber', 'accountHolder'],
  risk: 'R3',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.supplier_bank_account', id: input.accountId }),
  handler: async (ctx, input): Promise<SupplierBankAccount> => {
    const old = await loadLockedAccountForSupplier(ctx.trx, ctx.orgId, input.accountId);
    if (old.status !== 'active') throw new DomainError('SUPPLIER_BANK_ACCOUNT_NOT_ACTIVE', 409, 'Tài khoản này đã được ngừng dùng');
    if (await matchesAccountHash(ctx, old.party_id, normalizeAccountNumber(input.accountNumber), old)) {
      throw new DomainError('SUPPLIER_BANK_ACCOUNT_SAME', 409, 'Số tài khoản mới trùng với số hiện tại; hãy bỏ qua nếu không đổi');
    }
    await ctx.trx.updateTable('ludy_finance.supplier_bank_account').set({ status: 'retired', retired_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', old.id).execute();
    const { row, hash } = await insertAccount(ctx, old.party_id, input);
    await insertChange(ctx, { partyId: old.party_id, accountId: row.id, kind: 'replaced', oldHash: old.number_hash, newHash: hash });
    ctx.audit({ partyId: old.party_id, accountId: row.id, replacedAccountId: old.id, kind: 'replaced' });
    return view(row);
  },
});

export const supplierBankAccountRetire = defineCommand({
  name: 'finance.supplier_bank_account.retire',
  input: zSupplierBankAccountRetire,
  risk: 'R3',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.supplier_bank_account', id: input.accountId }),
  handler: async (ctx, input): Promise<SupplierBankAccount> => {
    const old = await loadLockedAccountForSupplier(ctx.trx, ctx.orgId, input.accountId);
    if (old.status !== 'active') throw new DomainError('SUPPLIER_BANK_ACCOUNT_NOT_ACTIVE', 409, 'Tài khoản này đã được ngừng dùng');
    const row = await ctx.trx
      .updateTable('ludy_finance.supplier_bank_account')
      .set({ status: 'retired', retired_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', old.id)
      .returning(['id', 'party_id', 'bank_name', 'last4', 'status', 'number_hash', 'hash_key_id', 'created_at', 'retired_at'])
      .executeTakeFirstOrThrow();
    await insertChange(ctx, { partyId: old.party_id, accountId: old.id, kind: 'retired', oldHash: old.number_hash, newHash: null });
    ctx.audit({ partyId: old.party_id, accountId: old.id, kind: 'retired' });
    return view(row);
  },
});

// The erasure of a supplier who is a person (plan 6.6, the design's section 6): active accounts are retired, the supplier's key is shredded so the sealed number and holder (which stay byte for byte)
// can never be opened again, and last4 plus all stored hashes across accounts, change history and finished payments are overwritten with tombstones so legacy keyed hashes and trailing digits cannot be recovered. R3 for owners: it cannot be undone.
export const supplierBankAccountErase = defineCommand({
  name: 'finance.supplier_bank_account.erase',
  runsWhenOff: "erases a supplier's sealed bank account data and shreds its subject key while Finance is off",
  input: zSupplierBankAccountErase,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: OWNERS,
  target: (input) => ({ type: 'finance.supplier_bank_account', id: input.partyId }),
  handler: async (ctx, input): Promise<SupplierBankAccountErased> => {
    const stepUp = stepUpAt(ctx);
    const partyId = input.partyId.toLowerCase();
    await requireSupplier(ctx.trx, ctx.orgId, partyId);
    // Lock terminal supplier-payment proposals still carrying un-erased last4 BEFORE lockSupplierBank
    // so erase matches kernel.proposal.resubmit's lock order (proposal -> lockSupplierBank) without transferring row IDs to Node.
    await sql`
      SELECT pg_catalog.count(*)::int AS n
      FROM (
        SELECT id FROM ludy_kernel.proposal
         WHERE org_id = ${ctx.orgId}::uuid
           AND command = 'finance.supplier_payment.record'
           AND status IN ('executed', 'rejected', 'failed', 'expired')
           AND pg_catalog.lower(payload ->> 'partyId') = ${partyId}
           AND (
             (pg_catalog.jsonb_typeof(payload) = 'object' AND payload ? 'last4' AND payload ->> 'last4' IS DISTINCT FROM '****')
             OR (pg_catalog.jsonb_typeof(result) = 'object' AND result ? 'last4' AND result ->> 'last4' IS DISTINCT FROM '****')
           )
         ORDER BY id FOR UPDATE
      ) AS locked`.execute(ctx.trx);
    // Serialize against concurrent add/replace/retire and supplierPaymentPrepare before reading active accounts or pending proposals.
    await lockSupplierBank(ctx.trx, ctx.orgId, partyId);
    // Lock all bank-account rows of this supplier in id order first so concurrent operations serialize cleanly with erasure.
    const accounts = await ctx.trx
      .selectFrom('ludy_finance.supplier_bank_account')
      .select(['id', 'status', 'number_hash'])
      .where('org_id', '=', ctx.orgId)
      .where('party_id', '=', partyId)
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();
    // A payment waiting (approved, or a request not decided yet) names this supplier's account: it is cancelled or decided first, so no approver is left holding a request for an account that is gone.
    const waiting = await sql<{ n: number }>`
      SELECT (SELECT count(*) FROM ludy_finance.supplier_payment p WHERE p.org_id = ${ctx.orgId}::uuid AND p.party_id = ${partyId}::uuid AND p.status = 'approved')
           + (SELECT count(*) FROM ludy_kernel.proposal q WHERE q.org_id = ${ctx.orgId}::uuid AND q.command = 'finance.supplier_payment.record' AND q.status = 'pending' AND pg_catalog.lower(q.payload->>'partyId') = ${partyId}) AS n`.execute(ctx.trx);
    if (Number(waiting.rows[0]?.n ?? 0) > 0) throw new DomainError('SUPPLIER_PAYMENT_WAITING', 409, 'Nhà cung cấp này còn khoản chi đang chờ duyệt hoặc chờ chi; hãy hủy hoặc xử lý trước khi xóa dữ liệu ngân hàng');
    const active = accounts.filter((account) => account.status === 'active');
    for (const account of active) {
      await ctx.trx.updateTable('ludy_finance.supplier_bank_account').set({ status: 'retired', retired_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', account.id).execute();
      await insertChange(ctx, { partyId, accountId: account.id, kind: 'retired', oldHash: account.number_hash, newHash: null });
    }
    const { rows } = await sql<{ n: number }>`SELECT ludy_kernel.subject_key_shred(ARRAY[${supplierSubject(partyId)}]::text[]) AS n`.execute(ctx.trx);
    const shreddedKeys = Number(rows[0]?.n ?? 0);
    const tombstoned = await sql<{ accounts: number; changes: number; payments: number; proposals: number }>`
      SELECT accounts, changes, payments, proposals
      FROM ludy_finance.supplier_bank_account_erase_tombstone(${partyId}::uuid, ${stepUp}::timestamptz)`.execute(ctx.trx);
    const counts = tombstoned.rows[0] ?? { accounts: 0, changes: 0, payments: 0, proposals: 0 };
    // Scrub cached last4 copies from idempotency_key.response (both {value,last4} and prepare's {value,payload,last4}) so replays after erase cannot return pre-erasure digits.
    const { rows: scrubbed } = await sql<{ n: number }>`
      WITH direct AS (
        UPDATE ludy_kernel.idempotency_key k
           SET response = pg_catalog.jsonb_set(k.response, '{value,last4}', pg_catalog.to_jsonb('****'::text), false)
         WHERE k.org_id = ${ctx.orgId}::uuid
           AND pg_catalog.jsonb_typeof(k.response) = 'object'
           AND pg_catalog.jsonb_typeof(k.response -> 'value') = 'object'
           AND k.response -> 'value' ? 'last4'
           AND k.response -> 'value' ->> 'last4' IS DISTINCT FROM '****'
           AND pg_catalog.lower(k.response -> 'value' ->> 'partyId') = ${partyId}
           AND (
             k.command IN (
               'finance.supplier_bank_account.add',
               'finance.supplier_bank_account.replace',
               'finance.supplier_bank_account.retire',
               'finance.supplier_payment.confirm_account',
               'finance.supplier_payment.cancel',
               'finance.supplier_payment.record'
             )
             OR (
               k.command = 'kernel.proposal.approve'
               AND EXISTS (
                 SELECT 1 FROM ludy_finance.supplier_payment p
                 WHERE p.org_id = k.org_id
                   AND p.party_id = ${partyId}::uuid
                   AND p.id::text = pg_catalog.lower(k.response -> 'value' ->> 'id')
               )
             )
           )
         RETURNING 1
      ), prepared AS (
        UPDATE ludy_kernel.idempotency_key k
           SET response = pg_catalog.jsonb_set(k.response, '{value,payload,last4}', pg_catalog.to_jsonb('****'::text), false)
         WHERE k.org_id = ${ctx.orgId}::uuid
           AND k.command = 'finance.supplier_payment.prepare'
           AND pg_catalog.jsonb_typeof(k.response) = 'object'
           AND pg_catalog.jsonb_typeof(k.response -> 'value') = 'object'
           AND pg_catalog.jsonb_typeof(k.response -> 'value' -> 'payload') = 'object'
           AND k.response -> 'value' -> 'payload' ? 'last4'
           AND k.response -> 'value' -> 'payload' ->> 'last4' IS DISTINCT FROM '****'
           AND pg_catalog.lower(k.response -> 'value' -> 'payload' ->> 'partyId') = ${partyId}
         RETURNING 1
      )
      SELECT ((SELECT pg_catalog.count(*)::int FROM direct) + (SELECT pg_catalog.count(*)::int FROM prepared)) AS n`.execute(ctx.trx);
    const scrubbedIdempotencyKeys = Number(scrubbed[0]?.n ?? 0);
    ctx.audit({
      partyId,
      shreddedKeys,
      retired: active.length,
      tombstonedAccounts: Number(counts.accounts),
      tombstonedChanges: Number(counts.changes),
      tombstonedPayments: Number(counts.payments),
      tombstonedProposals: Number(counts.proposals),
      scrubbedIdempotencyKeys,
    });
    return { partyId, shreddedKeys, retired: active.length };
  },
});

export const supplierBankAccountList = defineQuery({
  name: 'finance.supplier_bank_account.list',
  input: zSupplierBankAccountListInput,
  access: MANAGERS,
  handler: async (ctx, input): Promise<SupplierBankAccountList> => {
    const partyId = input.partyId.toLowerCase();
    const accounts = await ctx.trx
      .selectFrom('ludy_finance.supplier_bank_account')
      .select(['id', 'party_id', 'bank_name', 'last4', 'status', 'number_hash', 'hash_key_id', 'created_at', 'retired_at'])
      .where('org_id', '=', ctx.orgId)
      .where('party_id', '=', partyId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const changes = await ctx.trx
      .selectFrom('ludy_finance.supplier_bank_account_change')
      .select(['id', 'account_id', 'kind', 'changed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('party_id', '=', partyId)
      .orderBy('changed_at', 'desc')
      .orderBy('id', 'desc')
      .limit(200)
      .execute();
    return {
      accounts: accounts.map(view),
      changes: changes.map((c) => ({ id: c.id, accountId: c.account_id, kind: c.kind as SupplierBankAccountList['changes'][number]['kind'], changedAt: iso(c.changed_at) as string })),
    };
  },
});

// Rule 3's first read (V5, #3113): one row per supplier whose account changed in the last SUPPLIER_BANK_CHANGE_DAYS days, with the day (Vietnam time) of the latest change. Ids and days only.
// Complete or refused: more than SIGNALS_MAX_CRM changed suppliers are not cut to a part, the read refuses with SIGNAL_PARTIAL_VIEW. The accounts are the org's (no entity scope), so a
// user who can open the org sees every row.
export const financeSupplierBankChangesSignals = defineQuery({
  name: 'finance.signals.supplier_bank_changes',
  input: z.strictObject({}),
  access: ALL,
  // An AI app the owner or an admin connected may run this read (ADR-0051): ids and days only, never a number.
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<FinanceSupplierBankChangeSignal[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const { rows } = await sql<{ party_id: string; changed_on: string }>`
      SELECT c.party_id, to_char(max(c.changed_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS changed_on
      FROM ludy_finance.supplier_bank_account_change c
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.changed_at >= pg_catalog.now() - (${SUPPLIER_BANK_CHANGE_DAYS}::int * interval '1 day')
      GROUP BY c.party_id
      ORDER BY c.party_id
      LIMIT ${SIGNALS_MAX_CRM + 1}`.execute(ctx.trx);
    if (rows.length > SIGNALS_MAX_CRM) throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'Quá nhiều nhà cung cấp đổi tài khoản gần đây để kiểm tra hết một lượt');
    return zFinanceSupplierBankChangeSignals.parse(rows.map((r) => ({ partyId: r.party_id, changedOn: r.changed_on })));
  },
});

export const supplierBankAccountCommands = [supplierBankAccountAdd, supplierBankAccountReplace, supplierBankAccountRetire, supplierBankAccountErase];
export const supplierBankAccountQueries = [supplierBankAccountList, financeSupplierBankChangesSignals];

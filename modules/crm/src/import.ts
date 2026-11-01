// SPDX-License-Identifier: AGPL-3.0-only
// Contact import (#2229, docs/plan/crm.md §4.4 and §5, step K5). The browser reads a CSV, the person maps its columns and
// posts the rows (a file with personal data is never stored). crm.import.stage checks every row as kernel.party.update
// checks a party, classifies it against the org's parties and the rows before it, and keeps the result in
// crove_crm.import_row; it writes no party. The person reads the preview, then crm.import.commit creates exactly the new
// rows (and, if they chose, fills the empty fields of the parties duplicates matched) and deletes the staged rows. Both
// run as the person's own R1 command; no agent or system actor runs them.
//
// A row is, in this order: invalid (a field that cannot be stored), a conflict (its keys name two parties), a duplicate
// (its tax code, else its email, else its phone key names one party, or an earlier new row of the file), or new. Staged
// rows older than IMPORT_STAGED_DAYS are refused and deleted the next time any import command runs in the org.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  IMPORT_PREVIEW_PAGE,
  IMPORT_STAGED_DAYS,
  phoneKey,
  zImportCommit,
  zImportPreviewQuery,
  zImportRef,
  zImportStage,
  type ImportBatch,
  type ImportCommitted,
  type ImportOnDuplicate,
  type ImportOutcome,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportReason,
  type ImportRowInput,
  type ImportStatus,
} from '@crove/kernel-contract';
import { checkPartyFields } from '@crove/kernel';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const IMPORTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const CHUNK = 200;

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

type Kind = 'organization' | 'person';

// A staged row once its fields are as a party would store them.
interface Candidate {
  rowNo: number;
  kind: Kind;
  name: string;
  taxCode: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

interface Existing {
  id: string;
  name: string;
  tax_code: string | null;
  email: string | null;
  phone: string | null;
}

interface Verdict {
  outcome: ImportOutcome;
  reason: ImportReason | null;
  matchId: string | null;
}

const COMPANY_WORD = /^(organi[sz]ation|company|business|corp|cong ty|công ty|doanh nghiep|doanh nghiệp|to chuc|tổ chức)$/i;
const PERSON_WORD = /^(person|individual|ca nhan|cá nhân|khach le|khách lẻ|nguoi|người)$/i;

// The file's own word for company or person when it has one; otherwise a tax code of a company's shape (10 digits, with
// a 3-digit branch suffix or not) says company, and anything else a person.
function kindOf(word: string | null, taxCode: string | null): Kind {
  const w = word?.trim() ?? '';
  if (COMPANY_WORD.test(w)) return 'organization';
  if (PERSON_WORD.test(w)) return 'person';
  return taxCode !== null && /^\d{10}(-\d{3})?$/.test(taxCode) ? 'organization' : 'person';
}

const cell = (value: string | null): string | null => {
  const v = value?.trim() ?? '';
  return v === '' ? null : v;
};
const emailKey = (email: string | null): string | null => (email === null ? null : email.toLowerCase());

// The org's parties these candidates could match, by tax code, email or phone key: not the ones marked duplicates of
// another (the kept party is the match).
async function existingFor(ctx: Pick<QueryContext, 'trx' | 'orgId'>, rows: readonly Candidate[]): Promise<Existing[]> {
  const taxCodes = [...new Set(rows.flatMap((r) => (r.taxCode ? [r.taxCode] : [])))];
  const emails = [...new Set(rows.flatMap((r) => (r.email ? [r.email.toLowerCase()] : [])))];
  const phones = [...new Set(rows.flatMap((r) => phoneKey(r.phone) ?? []))];
  if (taxCodes.length + emails.length + phones.length === 0) return [];
  const { rows: found } = await sql<Existing>`
    SELECT id, name, tax_code, email, phone FROM crove_kernel.party
    WHERE org_id = ${ctx.orgId}::uuid AND duplicate_of IS NULL AND (
      tax_code = ANY(${taxCodes}::text[])
      OR pg_catalog.lower(email) = ANY(${emails}::text[])
      OR crove_kernel.phone_key(phone) = ANY(${phones}::text[]))`.execute(ctx.trx);
  return found;
}

// Classifies the candidates in file order against the existing parties and against each other.
function classify(rows: readonly Candidate[], existing: readonly Existing[]): Map<number, Verdict> {
  const byTax = new Map<string, Existing[]>();
  const byEmail = new Map<string, Existing[]>();
  const byPhone = new Map<string, Existing[]>();
  const add = (map: Map<string, Existing[]>, key: string | null, party: Existing) => {
    if (key !== null) map.set(key, [...(map.get(key) ?? []), party]);
  };
  for (const p of existing) {
    add(byTax, p.tax_code, p);
    add(byEmail, emailKey(p.email), p);
    add(byPhone, phoneKey(p.phone), p);
  }
  const seenTax = new Set<string>();
  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();
  const verdicts = new Map<number, Verdict>();
  for (const r of rows) {
    const tax = r.taxCode;
    const mail = emailKey(r.email);
    const phone = phoneKey(r.phone);
    // A row that is a duplicate or a conflict still names this tax code, email and phone: a later row with one of them repeats it.
    const remember = () => {
      if (tax) seenTax.add(tax);
      if (mail) seenEmail.add(mail);
      if (phone) seenPhone.add(phone);
    };
    const hits = { tax: tax ? (byTax.get(tax) ?? []) : [], email: mail ? (byEmail.get(mail) ?? []) : [], phone: phone ? (byPhone.get(phone) ?? []) : [] };
    const ids = new Set([...hits.tax, ...hits.email, ...hits.phone].map((p) => p.id));
    if (ids.size > 1) {
      verdicts.set(r.rowNo, { outcome: 'conflict', reason: 'CONFLICT_PARTIES', matchId: null });
      remember();
      continue;
    }
    if (ids.size === 1) {
      const reason: ImportReason = hits.tax.length > 0 ? 'DUPLICATE_TAX_CODE' : hits.email.length > 0 ? 'DUPLICATE_EMAIL' : 'DUPLICATE_PHONE';
      verdicts.set(r.rowNo, { outcome: 'duplicate', reason, matchId: [...ids][0] as string });
      remember();
      continue;
    }
    if ((tax && seenTax.has(tax)) || (mail && seenEmail.has(mail)) || (phone && seenPhone.has(phone))) {
      verdicts.set(r.rowNo, { outcome: 'duplicate', reason: 'DUPLICATE_IN_FILE', matchId: null });
      continue;
    }
    remember();
    verdicts.set(r.rowNo, { outcome: 'new', reason: null, matchId: null });
  }
  return verdicts;
}

const BATCH_COLUMNS = ['id', 'filename', 'status', 'on_duplicate', 'total_rows', 'new_rows', 'duplicate_rows', 'conflict_rows', 'invalid_rows', 'created_rows', 'updated_rows', 'created_at', 'decided_at'] as const;

interface BatchRow {
  id: string;
  filename: string;
  status: string;
  on_duplicate: string;
  total_rows: number;
  new_rows: number;
  duplicate_rows: number;
  conflict_rows: number;
  invalid_rows: number;
  created_rows: number;
  updated_rows: number;
  created_at: Date | string;
  decided_at: Date | string | null;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

function batchView(r: BatchRow, expired = false): ImportBatch {
  return {
    id: r.id,
    filename: r.filename,
    status: (expired && r.status === 'staged' ? 'expired' : r.status) as ImportStatus,
    onDuplicate: r.on_duplicate as ImportOnDuplicate,
    totalRows: r.total_rows,
    newRows: r.new_rows,
    duplicateRows: r.duplicate_rows,
    conflictRows: r.conflict_rows,
    invalidRows: r.invalid_rows,
    createdRows: r.created_rows,
    updatedRows: r.updated_rows,
    createdAt: iso(r.created_at),
    decidedAt: r.decided_at === null ? null : iso(r.decided_at),
  };
}

// The most parties whose filled field names the audit row lists; the count of all of them is `updated`.
const FILLED_AUDIT_MAX = 500;

const notFound = () => new DomainError('IMPORT_NOT_FOUND', 404, 'Không tìm thấy lần nhập này');

// Staged batches of this org older than the limit lose their rows and are marked expired.
async function expireStale(ctx: CommandContext): Promise<void> {
  const cutoff = new Date(ctx.now.getTime() - IMPORT_STAGED_DAYS * 86_400_000);
  const stale = await ctx.trx.selectFrom('crove_crm.import_batch').select('id').where('org_id', '=', ctx.orgId).where('status', '=', 'staged').where('created_at', '<', cutoff).execute();
  if (stale.length === 0) return;
  const ids = stale.map((s) => s.id);
  await ctx.trx.deleteFrom('crove_crm.import_row').where('org_id', '=', ctx.orgId).where('batch_id', 'in', ids).execute();
  await ctx.trx.updateTable('crove_crm.import_batch').set({ status: 'expired', decided_at: ctx.now }).where('org_id', '=', ctx.orgId).where('status', '=', 'staged').where('id', 'in', ids).execute();
}

// An invalid row is kept as read for the preview, minus the control characters (a NUL cannot be stored) and cut to the column.
const clip = (value: string | null, max: number): string | null => (value === null ? null : value.replace(/\p{Cc}/gu, ' ').slice(0, max));

export const importStage = defineCommand({
  name: 'crm.import.stage',
  input: zImportStage,
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<ImportPreview> => {
    const userId = userOf(ctx.actor);
    await expireStale(ctx);
    // One open batch per person: staging again cancels the one staged before, rows deleted, so staged personal data cannot pile
    // up behind a person who keeps choosing files. Two stagings at once by the same person wait for each other.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crm.import:${ctx.orgId}:${userId}`}, 0))`.execute(ctx.trx);
    const replaced = await ctx.trx.selectFrom('crove_crm.import_batch').select('id').where('org_id', '=', ctx.orgId).where('status', '=', 'staged').where('created_by', '=', userId).execute();
    if (replaced.length > 0) {
      const old = replaced.map((b) => b.id);
      await ctx.trx.deleteFrom('crove_crm.import_row').where('org_id', '=', ctx.orgId).where('batch_id', 'in', old).execute();
      await ctx.trx.updateTable('crove_crm.import_batch').set({ status: 'cancelled', decided_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', 'in', old).execute();
    }
    // What each row is as a party would store it, or why it cannot be.
    const candidates: Candidate[] = [];
    const invalid: { rowNo: number; raw: ImportRowInput; reason: ImportReason }[] = [];
    input.rows.forEach((raw: ImportRowInput, i: number) => {
      const rowNo = i + 1;
      const checked = checkPartyFields({ name: raw.name, taxCode: cell(raw.taxCode), email: cell(raw.email), phone: cell(raw.phone), address: cell(raw.address) });
      if (!checked.ok) {
        invalid.push({ rowNo, raw, reason: checked.reason });
        return;
      }
      const f = checked.fields;
      candidates.push({ rowNo, kind: kindOf(raw.kind, f.taxCode), name: f.name, taxCode: f.taxCode, email: f.email, phone: f.phone, address: f.address });
    });
    const verdicts = classify(candidates, await existingFor(ctx, candidates));
    const batch = await ctx.trx
      .insertInto('crove_crm.import_batch')
      .values({ org_id: ctx.orgId, filename: input.filename, created_by: userId, created_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    const staged = [
      ...candidates.map((c) => {
        const v = verdicts.get(c.rowNo) as Verdict;
        return { org_id: ctx.orgId, batch_id: batch.id, row_no: c.rowNo, kind: c.kind, name: c.name, tax_code: c.taxCode, email: c.email, phone: c.phone, address: c.address, outcome: v.outcome, reason: v.reason, match_party_id: v.matchId };
      }),
      ...invalid.map((x) => ({
        org_id: ctx.orgId,
        batch_id: batch.id,
        row_no: x.rowNo,
        kind: 'person' as const,
        name: clip(x.raw.name.trim(), 1000) ?? '',
        tax_code: clip(cell(x.raw.taxCode), 40),
        email: clip(cell(x.raw.email), 1000),
        phone: clip(cell(x.raw.phone), 100),
        address: clip(cell(x.raw.address), 2000),
        outcome: 'invalid' as const,
        reason: x.reason,
        match_party_id: null,
      })),
    ].sort((a, b) => a.row_no - b.row_no);
    for (let i = 0; i < staged.length; i += CHUNK) await ctx.trx.insertInto('crove_crm.import_row').values(staged.slice(i, i + CHUNK)).execute();
    const count = (o: ImportOutcome) => staged.filter((s) => s.outcome === o).length;
    await ctx.trx
      .updateTable('crove_crm.import_batch')
      .set({ total_rows: staged.length, new_rows: count('new'), duplicate_rows: count('duplicate'), conflict_rows: count('conflict'), invalid_rows: count('invalid') })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', batch.id)
      .execute();
    ctx.audit({ batchId: batch.id, rows: staged.length, new: count('new'), duplicate: count('duplicate'), conflict: count('conflict'), invalid: count('invalid'), replaced: replaced.length });
    return previewOf(ctx, { batchId: batch.id });
  },
});

async function previewOf(ctx: Pick<QueryContext, 'trx' | 'orgId' | 'actor' | 'role'>, input: { batchId: string; outcome?: ImportOutcome | undefined; after?: number | undefined; limit?: number | undefined }): Promise<ImportPreview> {
  const row = await ctx.trx
    .selectFrom('crove_crm.import_batch')
    .select([...BATCH_COLUMNS, 'created_by', sql<boolean>`created_at < now() - ${sql.raw(`interval '${IMPORT_STAGED_DAYS} days'`)}`.as('stale')])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', input.batchId)
    .executeTakeFirst();
  if (!row) throw notFound();
  // The rows are personal data read from a person's file: the person who staged them, an owner or an admin read them.
  if (row.created_by !== userOf(ctx.actor) && ctx.role !== 'owner' && ctx.role !== 'admin') throw new DomainError('IMPORT_FORBIDDEN', 403, 'Chỉ người nhập tệp, chủ sở hữu hoặc quản trị viên mới xem được lần nhập này');
  const batch = batchView(row, row.stale);
  if (batch.status !== 'staged') return { batch, rows: [], more: false };
  const limit = input.limit ?? IMPORT_PREVIEW_PAGE;
  let q = ctx.trx
    .selectFrom('crove_crm.import_row as r')
    .leftJoin('crove_kernel.party as p', (j) => j.onRef('p.org_id', '=', 'r.org_id').onRef('p.id', '=', 'r.match_party_id'))
    .select(['r.row_no', 'r.kind', 'r.name', 'r.tax_code', 'r.email', 'r.phone', 'r.address', 'r.outcome', 'r.reason', 'r.match_party_id', 'p.name as match_name'])
    .where('r.org_id', '=', ctx.orgId)
    .where('r.batch_id', '=', input.batchId)
    .where('r.row_no', '>', input.after ?? 0);
  if (input.outcome) q = q.where('r.outcome', '=', input.outcome);
  const found = await q.orderBy('r.row_no').limit(limit + 1).execute();
  const rows: ImportPreviewRow[] = found.slice(0, limit).map((r) => ({
    rowNo: r.row_no,
    kind: r.kind,
    name: r.name,
    taxCode: r.tax_code,
    email: r.email,
    phone: r.phone,
    address: r.address,
    outcome: r.outcome as ImportOutcome,
    reason: r.reason as ImportReason | null,
    match: r.match_party_id && r.match_name !== null ? { partyId: r.match_party_id, name: r.match_name } : null,
  }));
  return { batch, rows, more: found.length > limit };
}

export const importPreview = defineQuery({
  name: 'crm.import.preview',
  input: zImportPreviewQuery,
  access: ALL,
  handler: async (ctx, input): Promise<ImportPreview> => previewOf(ctx, input),
});

// The batch, locked, for the person who made it or an owner or admin.
async function lockBatch(ctx: CommandContext, batchId: string): Promise<BatchRow & { created_by: string }> {
  const batch = await ctx.trx
    .selectFrom('crove_crm.import_batch')
    .select([...BATCH_COLUMNS, 'created_by'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', batchId)
    .forUpdate()
    .executeTakeFirst();
  if (!batch) throw notFound();
  const userId = userOf(ctx.actor);
  if (batch.created_by !== userId && ctx.role !== 'owner' && ctx.role !== 'admin') throw new DomainError('IMPORT_FORBIDDEN', 403, 'Chỉ người nhập tệp, chủ sở hữu hoặc quản trị viên mới quyết định lần nhập này');
  return batch;
}

export const importCancel = defineCommand({
  name: 'crm.import.cancel',
  input: zImportRef,
  target: (input) => ({ type: 'crm.import', id: input.batchId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<ImportBatch> => {
    userOf(ctx.actor);
    await expireStale(ctx);
    const batch = await lockBatch(ctx, input.batchId);
    if (batch.status === 'staged') {
      await ctx.trx.deleteFrom('crove_crm.import_row').where('org_id', '=', ctx.orgId).where('batch_id', '=', batch.id).execute();
      await ctx.trx.updateTable('crove_crm.import_batch').set({ status: 'cancelled', decided_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', batch.id).execute();
      ctx.audit({ batchId: batch.id, rows: batch.total_rows });
    } else if (batch.status === 'committed') {
      throw new DomainError('IMPORT_NOT_STAGED', 409, 'Lần nhập này đã được thực hiện');
    }
    const after = await ctx.trx.selectFrom('crove_crm.import_batch').select(BATCH_COLUMNS).where('org_id', '=', ctx.orgId).where('id', '=', batch.id).executeTakeFirstOrThrow();
    return batchView(after);
  },
});

interface StagedRow extends Candidate {
  outcome: ImportOutcome;
  reason: ImportReason | null;
}

export const importCommit = defineCommand({
  name: 'crm.import.commit',
  input: zImportCommit,
  target: (input) => ({ type: 'crm.import', id: input.batchId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<ImportCommitted> => {
    userOf(ctx.actor);
    await expireStale(ctx);
    const batch = await lockBatch(ctx, input.batchId);
    // A second commit changes nothing and answers the first one's counts. The rows that were not imported are not kept (the staged
    // rows are gone and the batch holds counts only): the page offers that file once, right after the first commit.
    if (batch.status === 'committed') return { batch: batchView(batch), skipped: [] };
    // An expired batch answers as expired instead of failing: the failure would roll back the deletion of its rows.
    if (batch.status === 'expired') return { batch: batchView(batch), skipped: [] };
    if (batch.status !== 'staged') throw new DomainError('IMPORT_NOT_STAGED', 409, 'Lần nhập này đã bị hủy');

    // Commits of one org run one after another: the classification below reads the parties as they are, and the party table has no
    // unique key on email or phone, so two commits carrying one contact would both read it as new.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crm.import-commit:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    const staged = (
      await ctx.trx
        .selectFrom('crove_crm.import_row')
        .select(['row_no', 'kind', 'name', 'tax_code', 'email', 'phone', 'address', 'outcome', 'reason'])
        .where('org_id', '=', ctx.orgId)
        .where('batch_id', '=', batch.id)
        .orderBy('row_no')
        .execute()
    ).map((r): StagedRow => ({ rowNo: r.row_no, kind: r.kind, name: r.name, taxCode: r.tax_code, email: r.email, phone: r.phone, address: r.address, outcome: r.outcome as ImportOutcome, reason: r.reason as ImportReason | null }));
    // The parties may have changed since the preview: every row that was not invalid is judged again.
    const live = staged.filter((s) => s.outcome !== 'invalid');
    const existing = await existingFor(ctx, live);
    const verdicts = classify(live, existing);
    // The invalid rows keep the reason they were staged with.
    const skipped: { rowNo: number; reason: ImportReason }[] = staged.filter((s) => s.outcome === 'invalid').map((s) => ({ rowNo: s.rowNo, reason: s.reason ?? 'INVALID_NAME' }));
    const byId = new Map(existing.map((p) => [p.id, p]));

    let created = 0;
    let updated = 0;
    // What the rows created in this commit hold, so a duplicate row's fill never gives their email or phone to an old party.
    const taken = { email: new Set<string>(), phone: new Set<string>() };
    // The fields each filled party got, by name, for the audit row.
    const filled: { partyId: string; fields: string[] }[] = [];
    for (const c of live) {
      const v = verdicts.get(c.rowNo) as Verdict;
      if (v.outcome === 'new') {
        const id = randomUUID();
        // The id is given and nothing returned: a RETURNING check cannot see the entity link the party's trigger adds (#1280).
        const inserted = await ctx.trx
          .insertInto('crove_kernel.party')
          .values({ id, org_id: ctx.orgId, kind: c.kind, name: c.name, tax_code: c.taxCode, address: c.address, email: c.email, phone: c.phone, source_trust: 'external', created_at: ctx.now, updated_at: ctx.now })
          .onConflict((oc) => oc.columns(['org_id', 'tax_code']).where('tax_code', 'is not', null).doNothing())
          .executeTakeFirst();
        if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) {
          // Another member made a party with this tax code since the classification above.
          skipped.push({ rowNo: c.rowNo, reason: 'DUPLICATE_TAX_CODE' });
          continue;
        }
        created++;
        if (c.email) taken.email.add(c.email.toLowerCase());
        const pk = phoneKey(c.phone);
        if (pk) taken.phone.add(pk);
        await ctx.activity('kernel.party', id, 'party.imported', 'Nhập từ tệp');
        continue;
      }
      if (v.outcome === 'duplicate' && input.onDuplicate === 'fill_empty' && v.matchId) {
        const party = byId.get(v.matchId);
        // Empty fields only, read again under the row lock: a value somebody typed is never replaced.
        const locked = await ctx.trx
          .selectFrom('crove_kernel.party')
          .select(['id', 'email', 'phone', 'address', 'version'])
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', v.matchId)
          .forUpdate()
          .executeTakeFirst();
        if (party && locked) {
          const pk = phoneKey(c.phone);
          // The tax code is never filled: a party matched by its email or phone is not known to be the one that tax code names,
          // and a wrong code written here would stay and misroute its invoices. A party matched by its tax code has one.
          const set = {
            ...(locked.email === null && c.email !== null && !taken.email.has(c.email.toLowerCase()) ? { email: c.email } : {}),
            ...(locked.phone === null && c.phone !== null && !(pk && taken.phone.has(pk)) ? { phone: c.phone } : {}),
            ...(locked.address === null && c.address !== null ? { address: c.address } : {}),
          };
          if (Object.keys(set).length > 0) {
            await ctx.trx
              .updateTable('crove_kernel.party')
              // What was written came from a spreadsheet: the party drops to 'external', the lowest trust (external < user <
              // system), so a verified or invoice-sourced party does not keep a higher one. A party left unchanged keeps its trust.
              .set({ ...set, source_trust: 'external', version: locked.version + 1, updated_at: ctx.now })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', locked.id)
              .execute();
            updated++;
            // Field names, never values.
            const fields: string[] = [];
            if ('email' in set) fields.push('email');
            if ('phone' in set) fields.push('phone');
            if ('address' in set) fields.push('address');
            if (filled.length < FILLED_AUDIT_MAX) filled.push({ partyId: locked.id, fields });
            // What this party holds now is taken for the rest of the commit: a later row never fills it into a second party.
            if ('email' in set && c.email) taken.email.add(c.email.toLowerCase());
            if ('phone' in set && pk) taken.phone.add(pk);
            await ctx.activity('kernel.party', locked.id, 'party.import_filled', 'Bổ sung thông tin từ tệp');
            continue;
          }
        }
      }
      skipped.push({ rowNo: c.rowNo, reason: v.reason ?? 'DUPLICATE_IN_FILE' });
    }
    skipped.sort((a, b) => a.rowNo - b.rowNo);
    await ctx.trx.deleteFrom('crove_crm.import_row').where('org_id', '=', ctx.orgId).where('batch_id', '=', batch.id).execute();
    await ctx.trx
      .updateTable('crove_crm.import_batch')
      .set({ status: 'committed', on_duplicate: input.onDuplicate, created_rows: created, updated_rows: updated, decided_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', batch.id)
      .execute();
    // Counts only: the rows held personal data, and audit rows outlive an erasure.
    ctx.audit({ batchId: batch.id, rows: staged.length, created, updated, notImported: skipped.length, onDuplicate: input.onDuplicate, filled });
    const after = await ctx.trx.selectFrom('crove_crm.import_batch').select(BATCH_COLUMNS).where('org_id', '=', ctx.orgId).where('id', '=', batch.id).executeTakeFirstOrThrow();
    return { batch: batchView(after), skipped };
  },
});

export const importCommands = [importStage, importCommit, importCancel];
export const importQueries = [importPreview];

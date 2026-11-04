// SPDX-License-Identifier: AGPL-3.0-only
// Contact import (#2229, docs/plan/crm.md §4.4 and §5, step K5). The browser reads a CSV, the person maps its columns and
// posts the rows (a file with personal data is never stored). crm.import.stage checks every row as kernel.party.update
// checks a party, classifies it against the org's parties and the rows before it, and keeps the result in
// crove_crm.import_row; it writes no party. The person reads the preview, then crm.import.commit creates exactly the new
// rows (and, if they chose, fills the empty fields of the parties duplicates matched) and deletes the staged rows. Both
// run as the person's own R1 command; no agent or system actor runs them.
//
// A person's row may also name the company they work at (#2438): the cell is a name or the company's tax code. It is resolved
// against the org's companies (a tax code, else a name with marks, case and punctuation folded: search_fold, as the search does),
// kept on the staged row with what it came to, and linked on commit. A name the org does not have is made only when the person
// says so (createCompanies); a duplicate row's company is filled only from an existing company, never made.
//
// A row is, in this order: invalid (a field that cannot be stored), a conflict (its keys name two parties), a duplicate
// (its tax code, else its email, else its phone key names one party, or an earlier new row of the file), or new. Staged
// rows older than IMPORT_STAGED_DAYS are refused and deleted the next time any import command runs in the org.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  IMPORT_PREVIEW_PAGE,
  IMPORT_STAGED_DAYS,
  phoneKey,
  zImportCommit,
  zImportPreviewQuery,
  zImportRef,
  zImportStage,
  normalizeTaxCode,
  type ImportBatch,
  type ImportCommitted,
  type ImportCompanyState,
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
  // The company cell of a person's row as a name a party can store (null for a company's row, an empty cell or one that cannot be stored), and the cell as
  // read for the preview (any row; cut to the column).
  company: string | null;
  companyRaw: string | null;
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

// What a company cell came to: its state, the company it names when it matched (the party kept), and a key that makes two cells naming
// the same company one ("tax:" and the tax code, or "name:" and the folded name).
interface CompanyVerdict {
  state: ImportCompanyState;
  partyId: string | null;
  partyName: string | null;
  key: string | null;
}

const NO_COMPANY: CompanyVerdict = { state: 'none', partyId: null, partyName: null, key: null };

// A company's tax code: ten digits, with a branch suffix or not. (Twelve digits is an individual's citizen ID: not a company.)
const companyTaxCode = (cell: string): string | null => {
  const tax = normalizeTaxCode(cell);
  return tax !== null && /^\d{10}(-\d{3})?$/.test(tax) ? tax : null;
};

// What a spreadsheet cell holds when a person has no company: read as a name it would make a company called "N/A" or "Tự do".
const NOT_A_COMPANY = new Set(['n a', 'na', 'none', 'null', 'khong', 'khong co', 'chua co', 'tu do', 'tu doanh', 'ca nhan', 'khac', 'freelance', 'freelancer', 'nghi viec', 'thoi viec']);

// The cell as a company name a party can store (one line, within the length, no control character), or null: a cell that cannot be stored is
// never looked up (a NUL would fail the whole query) and never made into a company.
function usableCompany(cell: string | null): string | null {
  if (cell === null) return null;
  const checked = checkPartyFields({ name: cell });
  return checked.ok ? checked.fields.name : null;
}

// The text folded as the search folds it (marks, case and punctuation away), for every distinct text: the one folding, in SQL, for the cells
// and the names they are compared with.
async function foldAll(ctx: Pick<QueryContext, 'trx'>, texts: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(texts)];
  if (unique.length === 0) return new Map();
  const { rows } = await sql<{ text: string; key: string }>`SELECT c.text, crove_kernel.search_fold(c.text) AS key FROM pg_catalog.unnest(${unique}::text[]) AS c (text)`.execute(ctx.trx);
  return new Map(rows.map((r) => [r.text, r.key]));
}

// A company the file itself makes (a new row of kind company), so that a person's cell naming it is linked to it and no second one is made.
interface FileCompany {
  name: string;
  taxCode: string | null;
}

// Resolves the cells against the org's companies in two queries: by tax code, and by name folded as the search folds it, so "Công ty Á Châu"
// and "cong ty a chau" are one. A company merged into another answers as the one kept (by tax code and by name alike), and a kept party that
// is no company is none. A name that two companies share is ambiguous: no link is guessed. A cell with no match that names a company of the
// file's own new rows is `in_file`.
async function resolveCompanies(ctx: Pick<QueryContext, 'trx' | 'orgId'>, cells: readonly string[], fileCompanies: readonly FileCompany[]): Promise<Map<string, CompanyVerdict>> {
  const out = new Map<string, CompanyVerdict>();
  const unique = [...new Set(cells.flatMap((c) => usableCompany(c) ?? []))];
  const taxOf = new Map(unique.flatMap((c) => {
    const tax = companyTaxCode(c);
    return tax === null ? [] : [[c, tax] as const];
  }));
  // Digits, spaces, dots and hyphens only, nine digits or more: a tax code or an ID in the wrong shape, never a company's name.
  const numberLike = (c: string) => /^[\d\s.-]+$/.test(c) && c.replace(/\D/g, '').length >= 9;
  const names = unique.filter((c) => !taxOf.has(c) && !numberLike(c));
  for (const c of unique) if (!taxOf.has(c) && numberLike(c)) out.set(c, { state: 'unknown_tax_code', partyId: null, partyName: null, key: null });
  const fileTaxes = new Set(fileCompanies.flatMap((f) => (f.taxCode === null ? [] : [`tax:${f.taxCode}`])));
  const fileNameKeys = await foldAll(ctx, fileCompanies.map((f) => f.name));
  const fileNames = new Set([...fileNameKeys.values()].filter((k) => k !== '').map((k) => `name:${k}`));
  if (taxOf.size > 0) {
    const taxes = [...new Set(taxOf.values())];
    const { rows } = await sql<{ tax_code: string; id: string; name: string }>`
      SELECT p.tax_code, coalesce(k.id, p.id) AS id, coalesce(k.name, p.name) AS name
      FROM crove_kernel.party p
      LEFT JOIN crove_kernel.party k ON k.org_id = p.org_id AND k.id = p.duplicate_of
      WHERE p.org_id = ${ctx.orgId}::uuid AND p.kind = 'organization' AND p.tax_code = ANY(${taxes}::text[]) AND coalesce(k.kind, p.kind) = 'organization'`.execute(ctx.trx);
    const byTax = new Map(rows.map((r) => [r.tax_code, r]));
    for (const [cell, tax] of taxOf) {
      const hit = byTax.get(tax);
      const key = `tax:${tax}`;
      out.set(cell, hit ? { state: 'matched', partyId: hit.id, partyName: hit.name, key } : { state: fileTaxes.has(key) ? 'in_file' : 'unknown_tax_code', partyId: null, partyName: null, key });
    }
  }
  if (names.length > 0) {
    const keyOf = await foldAll(ctx, names);
    const keys = [...new Set([...keyOf.values()].filter((k) => k !== ''))];
    const { rows: found } = keys.length === 0
      ? { rows: [] as { key: string; id: string; name: string }[] }
      : await sql<{ key: string; id: string; name: string }>`
          SELECT crove_kernel.search_fold(p.name) AS key, coalesce(k.id, p.id) AS id, coalesce(k.name, p.name) AS name
          FROM crove_kernel.party p
          LEFT JOIN crove_kernel.party k ON k.org_id = p.org_id AND k.id = p.duplicate_of
          WHERE p.org_id = ${ctx.orgId}::uuid AND p.kind = 'organization' AND coalesce(k.kind, p.kind) = 'organization' AND crove_kernel.search_fold(p.name) = ANY(${keys}::text[])`.execute(ctx.trx);
    const byKey = new Map<string, Map<string, string>>();
    for (const f of found) byKey.set(f.key, (byKey.get(f.key) ?? new Map<string, string>()).set(f.id, f.name));
    for (const cell of names) {
      const folded = keyOf.get(cell) ?? '';
      if (folded === '' || NOT_A_COMPANY.has(folded)) {
        out.set(cell, NO_COMPANY);
        continue;
      }
      const key = `name:${folded}`;
      const hits = [...(byKey.get(folded) ?? new Map<string, string>()).entries()];
      if (hits.length === 1) out.set(cell, { state: 'matched', partyId: hits[0]?.[0] ?? null, partyName: hits[0]?.[1] ?? null, key });
      else if (hits.length > 1) out.set(cell, { state: 'ambiguous', partyId: null, partyName: null, key });
      else out.set(cell, { state: fileNames.has(key) ? 'in_file' : 'new', partyId: null, partyName: null, key });
    }
  }
  return out;
}

const BATCH_COLUMNS = ['id', 'filename', 'status', 'on_duplicate', 'total_rows', 'new_rows', 'duplicate_rows', 'conflict_rows', 'invalid_rows', 'created_rows', 'updated_rows', 'new_companies', 'created_companies', 'linked_rows', 'created_at', 'decided_at'] as const;

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
  new_companies: number;
  created_companies: number;
  linked_rows: number;
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
    newCompanies: r.new_companies,
    createdCompanies: r.created_companies,
    linkedRows: r.linked_rows,
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
  // The batch rows are locked first, in id order, before their rows are deleted: the daily sweep (importExpire) takes the same
  // order, so a command and the sweep reaching one stale batch cannot wait on each other.
  const stale = await ctx.trx.selectFrom('crove_crm.import_batch').select('id').where('org_id', '=', ctx.orgId).where('status', '=', 'staged').where('created_at', '<', cutoff).orderBy('id').forUpdate().execute();
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
      const kind = kindOf(raw.kind, f.taxCode);
      const companyCell = cell(raw.company ?? null);
      // Only a person works at a company: a company's row has none.
      candidates.push({ rowNo, kind, name: f.name, taxCode: f.taxCode, email: f.email, phone: f.phone, address: f.address, company: kind === 'person' ? usableCompany(companyCell) : null, companyRaw: clip(companyCell, 1000) });
    });
    const verdicts = classify(candidates, await existingFor(ctx, candidates));
    // The companies the file makes itself: its new rows of kind company. A person's cell naming one is linked to it, and no second one is made.
    const fileCompanies = candidates.filter((c) => c.kind === 'organization' && verdicts.get(c.rowNo)?.outcome === 'new').map((c) => ({ name: c.name, taxCode: c.taxCode }));
    const companies = await resolveCompanies(ctx, candidates.flatMap((c) => (c.company === null ? [] : [c.company])), fileCompanies);
    const companyOf = (c: Candidate): CompanyVerdict => (c.company === null ? NO_COMPANY : (companies.get(c.company) ?? NO_COMPANY));
    const batch = await ctx.trx
      .insertInto('crove_crm.import_batch')
      .values({ org_id: ctx.orgId, filename: input.filename, created_by: userId, created_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    const staged = [
      ...candidates.map((c) => {
        const v = verdicts.get(c.rowNo) as Verdict;
        const company = companyOf(c);
        return {
          org_id: ctx.orgId,
          batch_id: batch.id,
          row_no: c.rowNo,
          kind: c.kind,
          name: c.name,
          tax_code: c.taxCode,
          email: c.email,
          phone: c.phone,
          address: c.address,
          outcome: v.outcome,
          reason: v.reason,
          match_party_id: v.matchId,
          company_name: c.companyRaw,
          company_state: company.state,
          company_party_id: company.partyId,
        };
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
        company_name: clip(cell(x.raw.company ?? null), 1000),
        company_state: 'none' as const,
        company_party_id: null,
      })),
    ].sort((a, b) => a.row_no - b.row_no);
    for (let i = 0; i < staged.length; i += CHUNK) await ctx.trx.insertInto('crove_crm.import_row').values(staged.slice(i, i + CHUNK)).execute();
    const count = (o: ImportOutcome) => staged.filter((s) => s.outcome === o).length;
    // The companies a commit could make: one for each name the new rows share (duplicates fill from an existing company only).
    const toMake = new Set(candidates.filter((c) => verdicts.get(c.rowNo)?.outcome === 'new' && companyOf(c).state === 'new').map((c) => companyOf(c).key));
    await ctx.trx
      .updateTable('crove_crm.import_batch')
      .set({ total_rows: staged.length, new_rows: count('new'), duplicate_rows: count('duplicate'), conflict_rows: count('conflict'), invalid_rows: count('invalid'), new_companies: toMake.size })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', batch.id)
      .execute();
    ctx.audit({ batchId: batch.id, rows: staged.length, new: count('new'), duplicate: count('duplicate'), conflict: count('conflict'), invalid: count('invalid'), newCompanies: toMake.size, replaced: replaced.length });
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
    .leftJoin('crove_kernel.party as cp', (j) => j.onRef('cp.org_id', '=', 'r.org_id').onRef('cp.id', '=', 'r.company_party_id'))
    .select(['r.row_no', 'r.kind', 'r.name', 'r.tax_code', 'r.email', 'r.phone', 'r.address', 'r.outcome', 'r.reason', 'r.match_party_id', 'p.name as match_name', 'r.company_name', 'r.company_state', 'r.company_party_id', 'cp.name as company_match_name'])
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
    company:
      r.company_name === null
        ? null
        : { name: r.company_name, state: r.company_state as ImportCompanyState, match: r.company_party_id && r.company_match_name !== null ? { partyId: r.company_party_id, name: r.company_match_name } : null },
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
        .select(['row_no', 'kind', 'name', 'tax_code', 'email', 'phone', 'address', 'outcome', 'reason', 'company_name', 'company_state'])
        .where('org_id', '=', ctx.orgId)
        .where('batch_id', '=', batch.id)
        .orderBy('row_no')
        .execute()
    ).map((r): StagedRow => ({ rowNo: r.row_no, kind: r.kind, name: r.name, taxCode: r.tax_code, email: r.email, phone: r.phone, address: r.address, company: r.kind === 'person' && r.company_state !== 'none' ? usableCompany(r.company_name) : null, companyRaw: r.company_name, outcome: r.outcome as ImportOutcome, reason: r.reason as ImportReason | null }));
    // The parties may have changed since the preview: every row that was not invalid is judged again.
    const live = staged.filter((s) => s.outcome !== 'invalid');
    const existing = await existingFor(ctx, live);
    const verdicts = classify(live, existing);
    // The companies are read again too: the matched one may have been merged or renamed, a new one may exist now. Every company a row will be linked
    // to is locked (shared, in id order) before the first link, so a merge of it waits for this commit instead of failing it at the table's guard.
    const fileCompanies = live.filter((c) => c.kind === 'organization' && verdicts.get(c.rowNo)?.outcome === 'new').map((c) => ({ name: c.name, taxCode: c.taxCode }));
    const companies = await resolveCompanies(ctx, live.flatMap((s) => (s.company === null ? [] : [s.company])), fileCompanies);
    const matchedIds = [...new Set([...companies.values()].flatMap((c) => (c.partyId === null ? [] : [c.partyId])))].sort();
    const stillCompanies = new Set(
      matchedIds.length === 0
        ? []
        : (
            await ctx.trx
              .selectFrom('crove_kernel.party')
              .select('id')
              .where('org_id', '=', ctx.orgId)
              .where('id', 'in', matchedIds)
              .where('kind', '=', 'organization')
              .where('duplicate_of', 'is', null)
              .orderBy('id')
              .forShare()
              .execute()
          ).map((r) => r.id),
    );
    // A row's company when it is one to link now: an existing company that is still one (a new one is made below, when the person said so).
    const existingCompanyOf = (c: Candidate): string | null => {
      const verdict = c.company === null ? undefined : companies.get(c.company);
      return verdict?.state === 'matched' && verdict.partyId !== null && stillCompanies.has(verdict.partyId) ? verdict.partyId : null;
    };
    // The companies this commit made, by the key of the cells that name them: the new rows of kind company of the file (by tax code and by folded name,
    // made first), and, when the person said so, a company made for a name no row of the file and no party has.
    const madeCompanies = new Map<string, string>();
    const fileNameKeys = await foldAll(ctx, fileCompanies.map((f) => f.name));
    let createdCompanies = 0;
    let linked = 0;
    // The company for a new row: the existing one, or the one the file makes, or (createCompanies) the one this commit made for the same name before, or one made now.
    const companyForNewRow = async (c: Candidate): Promise<string | null> => {
      const existingId = existingCompanyOf(c);
      if (existingId !== null) return existingId;
      const verdict = c.company === null ? undefined : companies.get(c.company);
      if (verdict?.state === 'in_file' && verdict.key !== null) return madeCompanies.get(verdict.key) ?? null;
      if (!input.createCompanies || c.company === null || verdict?.state !== 'new' || verdict.key === null) return null;
      const made = madeCompanies.get(verdict.key);
      if (made !== undefined) return made;
      const id = randomUUID();
      await ctx.trx
        .insertInto('crove_kernel.party')
        .values({ id, org_id: ctx.orgId, kind: 'organization', name: c.company, tax_code: null, address: null, email: null, phone: null, source_trust: 'external', created_at: ctx.now, updated_at: ctx.now })
        .execute();
      madeCompanies.set(verdict.key, id);
      createdCompanies++;
      await ctx.activity('kernel.party', id, 'party.imported', 'Nhập từ tệp');
      return id;
    };
    // The invalid rows keep the reason they were staged with.
    const skipped: { rowNo: number; reason: ImportReason }[] = staged.filter((s) => s.outcome === 'invalid').map((s) => ({ rowNo: s.rowNo, reason: s.reason ?? 'INVALID_NAME' }));
    const byId = new Map(existing.map((p) => [p.id, p]));

    let created = 0;
    let updated = 0;
    // What the rows created in this commit hold, so a duplicate row's fill never gives their email or phone to an old party.
    const taken = { email: new Set<string>(), phone: new Set<string>() };
    // The fields each filled party got, by name, for the audit row.
    const filled: { partyId: string; fields: string[] }[] = [];
    // The companies of the file go first, so a person's row that names one finds it made, wherever it stands in the file.
    const ordered = [...live.filter((c) => c.kind === 'organization'), ...live.filter((c) => c.kind !== 'organization')];
    for (const c of ordered) {
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
        if (c.kind === 'organization') {
          if (c.taxCode !== null) madeCompanies.set(`tax:${c.taxCode}`, id);
          const folded = fileNameKeys.get(c.name) ?? '';
          if (folded !== '' && !madeCompanies.has(`name:${folded}`)) madeCompanies.set(`name:${folded}`, id);
        }
        // The company comes after the person is in: a person whose tax code was taken since the preview makes no company. The row was made in this
        // transaction, so its version stays 1 (the guard of company_id checks the company).
        const companyId = c.kind === 'person' ? await companyForNewRow(c) : null;
        if (companyId !== null) {
          await ctx.trx.updateTable('crove_kernel.party').set({ company_id: companyId }).where('org_id', '=', ctx.orgId).where('id', '=', id).execute();
          linked++;
          await ctx.activity('kernel.party', companyId, 'party.person_linked', 'Có thêm một người liên hệ làm việc tại đây');
        }
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
          .select(['id', 'kind', 'email', 'phone', 'address', 'company_id', 'version'])
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
            // The company too, only when the party is a person with none and the file names an existing company (it never makes one here).
            ...(locked.kind === 'person' && locked.company_id === null && c.kind === 'person' && existingCompanyOf(c) !== null ? { company_id: existingCompanyOf(c) } : {}),
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
            if ('company_id' in set) {
              fields.push('company');
              linked++;
              await ctx.activity('kernel.party', set.company_id as string, 'party.person_linked', 'Có thêm một người liên hệ làm việc tại đây');
            }
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
      .set({ status: 'committed', on_duplicate: input.onDuplicate, created_rows: created, updated_rows: updated, created_companies: createdCompanies, linked_rows: linked, decided_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', batch.id)
      .execute();
    // Counts only: the rows held personal data, and audit rows outlive an erasure.
    ctx.audit({ batchId: batch.id, rows: staged.length, created, updated, notImported: skipped.length, onDuplicate: input.onDuplicate, createCompanies: input.createCompanies, createdCompanies, linked, filled });
    const after = await ctx.trx.selectFrom('crove_crm.import_batch').select(BATCH_COLUMNS).where('org_id', '=', ctx.orgId).where('id', '=', batch.id).executeTakeFirstOrThrow();
    return { batch: batchView(after), skipped };
  },
});

// The daily sweep's part in one org (K5b, #2251): the worker found a staged batch past IMPORT_STAGED_DAYS here (the
// definer crove_crm.import_expired lists the orgs) and runs this in the org's system context, where the tenant policy shows
// this org's rows alone. The rows are deleted and the batches marked expired, counts only in the audit row.
export const importExpire = defineCommand({
  name: 'crm.import.expire',
  input: z.strictObject({}),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  handler: async (ctx): Promise<{ batches: number; rows: number }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới thực hiện được việc này');
    const cutoff = new Date(ctx.now.getTime() - IMPORT_STAGED_DAYS * 86_400_000);
    // Locked, so a commit running at this moment finishes first and its batch no longer reads as staged here.
    const stale = await ctx.trx.selectFrom('crove_crm.import_batch').select('id').where('org_id', '=', ctx.orgId).where('status', '=', 'staged').where('created_at', '<', cutoff).orderBy('id').forUpdate().execute();
    if (stale.length === 0) return { batches: 0, rows: 0 };
    const ids = stale.map((s) => s.id);
    const deleted = await ctx.trx.deleteFrom('crove_crm.import_row').where('org_id', '=', ctx.orgId).where('batch_id', 'in', ids).executeTakeFirst();
    await ctx.trx.updateTable('crove_crm.import_batch').set({ status: 'expired', decided_at: ctx.now }).where('org_id', '=', ctx.orgId).where('status', '=', 'staged').where('id', 'in', ids).execute();
    const rows = Number(deleted.numDeletedRows);
    ctx.audit({ batches: ids.length, rows });
    return { batches: ids.length, rows };
  },
});

export const importCommands = [importStage, importCommit, importCancel, importExpire];
export const importQueries = [importPreview];

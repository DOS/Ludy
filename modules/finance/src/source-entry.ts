// The journal entry of a source document (a purchase or sale document, a cash or journal voucher). Since #1283 a
// source may have several entries: revision 1, reversed, then revision 2, and so on. The posting path posts revision
// n + 1 only once revision n is reversed, so the latest revision is the only one that can be in force. Every join from
// a source to its entry keeps that one, so a re-posted source counts once in each list and report (#1338). A source
// whose latest revision is reversed (a voided document) keeps that entry, as before. A join from an entry to its source
// (the journal, the ledger) needs none of this: each entry has one source. Nor does a document's export history
// (document-exports.ts), which asks of every revision whether a file took it in.
import { sql, type RawBuilder, type SqlBool } from 'kysely';

// True for the source row `voucher` (a table alias, with org_id and id) when it has been reversed: it has an original entry (source type `source`, reverses nothing) and every original entry of it has
// a reversal entry pointing at it. A source with no entry yet, or with an original that stands, is not reversed. It says in SQL what the database's own rules say (20261211004500: one live payment voucher
// per pay run and kind), as the caller sees the books; the payroll payment check and the card of the month share it (#2854).
export function reversedSource(voucher: string, source: string): RawBuilder<SqlBool> {
  const col = (name: string) => sql.ref(`${voucher}.${name}`);
  return sql<SqlBool>`(
    EXISTS (SELECT 1 FROM crove_finance.journal_entry o WHERE o.org_id = ${col('org_id')} AND o.source_type = ${source} AND o.source_id = ${col('id')} AND o.reverses_entry_id IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM crove_finance.journal_entry o
      WHERE o.org_id = ${col('org_id')} AND o.source_type = ${source} AND o.source_id = ${col('id')} AND o.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id)))`;
}

// True for the entry `alias` when its source has no later revision. The unique key (org_id, source_type, source_id,
// source_revision) serves the lookup.
export function latestRevision(alias: string): RawBuilder<SqlBool> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<SqlBool>`NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_entry AS later
     WHERE later.org_id = ${column('org_id')} AND later.source_type = ${column('source_type')}
       AND later.source_id = ${column('source_id')} AND later.source_revision > ${column('source_revision')})`;
}

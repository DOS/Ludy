import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema.ts';

// The handle every query helper takes: the pool's Kysely or the Transaction of a command. It names both classes on purpose. A
// Transaction<Database> is a Kysely<Database> by inheritance, but TypeScript compares the two structurally, and the generic
// $omitTables, $pickTables and withTables of the subclass make it pair every table name with every other: with N tables that is
// N * N unions, which passes the compiler's 100000 limit at 317 tables (TS2590, #5026). Written as this union, a transaction is
// identical to one member and no comparison runs; the inherited methods have the same type on both members, so calls behave as before.
// A signature that asks for `Kysely<Database>` alone and is handed a transaction brings the comparison back: take `Db` instead.
export type Db = Kysely<Database> | Transaction<Database>;

// Cell-ready connection resolution (plan Decision 14, §3.6). A cell is one database holding the tenant data of
// some orgs; the control plane holds identity, the tenant directory, staff and sessions. Every tenant
// transaction opens on the database that resolveTenant() returns for its org; org-less work opens on
// controlPlane(). Today there is one database (singleCell), so both return the same Db and nothing changes; a
// later multi-cell resolver looks the org up in the tenant directory without touching the callers.
export interface CellResolver {
  // The database holding this org's tenant data. Async so a later resolver can read the tenant directory. It runs
  // before any session or membership check, so an unknown org must resolve to some cell (where enter_context
  // refuses it as for a non-member) and never raise a different error that reveals which org ids exist.
  resolveTenant(orgId: string): Promise<Db>;
  // The control-plane database, for work that has no org yet (signed-in user reads, org creation, inbound mail).
  controlPlane(): Db;
}

// One database for the control plane and every org.
export function singleCell(db: Db): CellResolver {
  return {
    resolveTenant: async () => db,
    controlPlane: () => db,
  };
}

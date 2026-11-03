// Whether an invoice party's tax code is the org's own (issue #313), its branch codes included (#686): a company that
// issues invoices from a branch prints `<its 10-digit code>-NNN` as the seller, and those are its own sales. Both codes
// are compared normalized (parseTaxCode, as kernel.org.set_tax_code stores the org's). An org whose own code is a
// branch code owns only that code: the head office and the other branches are other taxpayers in its books.
import type { QueryContext } from '@crove/kernel-runtime';
import { parseTaxCode } from '@crove/l10n-vn';

export function isOwnTaxCode(code: string | null | undefined, orgTaxCode: string | null | undefined): boolean {
  const party = parseTaxCode(code);
  const org = parseTaxCode(orgTaxCode);
  if (!party || !org) return false;
  if (party.normalized === org.normalized) return true;
  return org.kind === 'enterprise' && party.kind === 'branch' && party.normalized.startsWith(`${org.normalized}-`);
}

// The org's own tax codes: the org's (crove_kernel.tenant.tax_code, which is the default entity's) and each legal entity's (#1278: a company with several entities
// issues invoices as each of them).
export interface OwnTaxCodes {
  tenant: string | null;
  entities: ReadonlyArray<{ id: string; taxCode: string | null }>;
}

// What an invoice is to the books of one legal entity, the one it is read in or booked in (#2502): 'sale' when the seller is that entity (its code, or a branch of it),
// 'purchase' when the seller is not the org's own taxpayer at all or is another entity of the org that sells to this one (an invoice between two entities of the org is
// a sale in the seller's books and a purchase in the buyer's), and 'sale_other_entity' when the seller is another entity of the org and the buyer is not this entity:
// a sale that is not this entity's, so it is booked in the books of the entity that issued it, never as a purchase from a supplier and never here.
export type SellerReading = 'sale' | 'purchase' | 'sale_other_entity';

export function readSeller(invoice: { seller: string | null | undefined; buyer: string | null | undefined; entityId: string }, own: OwnTaxCodes): SellerReading {
  const entity = own.entities.find((e) => e.id === invoice.entityId);
  // An entity the writer cannot see reads as the org (the single-entity way, as before).
  const entityCode = entity ? entity.taxCode : own.tenant;
  if (isOwnTaxCode(invoice.seller, entityCode)) return 'sale';
  // The org's own code counts even when the entity that holds it (the default one) is out of the writer's scope, so a scoped member cannot book it as a stranger's.
  const another = isOwnTaxCode(invoice.seller, own.tenant) || own.entities.some((e) => e.id !== invoice.entityId && isOwnTaxCode(invoice.seller, e.taxCode));
  if (!another) return 'purchase';
  return isOwnTaxCode(invoice.buyer, entityCode) ? 'purchase' : 'sale_other_entity';
}

// The codes as the writer's own policies show them: a scoped member sees the entities of their scope. With `lockTenant` the org's row and the entity rows are read FOR
// SHARE until commit, in the order kernel.org.set_tax_code and kernel.legal_entity.update take them, so a concurrent change of a code waits for the posting.
export async function loadOwnTaxCodes(ctx: Pick<QueryContext, 'trx' | 'orgId'>, options: { lockTenant?: boolean } = {}): Promise<OwnTaxCodes> {
  let tenant = ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId);
  let entities = ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'tax_code']).where('org_id', '=', ctx.orgId);
  if (options.lockTenant) {
    tenant = tenant.forShare();
    entities = entities.forShare();
  }
  const org = await tenant.executeTakeFirst();
  const rows = await entities.execute();
  return { tenant: org?.tax_code ?? null, entities: rows.map((e) => ({ id: e.id, taxCode: e.tax_code })) };
}

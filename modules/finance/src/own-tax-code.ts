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

// The org's own tax codes: the org's (crove_kernel.tenant.tax_code) and each legal entity's (#1278: a company with several entities issues invoices as each of them, and
// the default entity's code is the org's). An invoice whose seller is any of them is the org's own sale, filed under the entity whose code it is.
export interface OwnTaxCodes {
  tenant: string | null;
  entities: ReadonlyArray<{ id: string; taxCode: string | null; isDefault: boolean }>;
}

export interface OwnSeller {
  own: boolean;
  // The entity whose sale it is: the one with exactly this code, else the one whose branch this is; null when only the org's own code matched (an org with no entity row).
  legalEntityId: string | null;
  // That entity is the org's default one: a sale of it needs no entity named on the proposal.
  isDefault: boolean;
}

export function ownSeller(code: string | null | undefined, own: OwnTaxCodes): OwnSeller {
  const party = parseTaxCode(code);
  const exact = party ? own.entities.find((e) => parseTaxCode(e.taxCode)?.normalized === party.normalized) : undefined;
  const entity = exact ?? own.entities.find((e) => isOwnTaxCode(code, e.taxCode));
  if (entity) return { own: true, legalEntityId: entity.id, isDefault: entity.isDefault };
  return { own: isOwnTaxCode(code, own.tenant), legalEntityId: null, isDefault: false };
}

// The codes as the writer's own policies show them: a scoped member sees the entities of their scope, so a seller that is another entity's code reads as not own to them.
export async function loadOwnTaxCodes(ctx: Pick<QueryContext, 'trx' | 'orgId'>, options: { lockTenant?: boolean } = {}): Promise<OwnTaxCodes> {
  let tenant = ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId);
  if (options.lockTenant) tenant = tenant.forShare();
  const org = await tenant.executeTakeFirst();
  const entities = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'tax_code', 'is_default']).where('org_id', '=', ctx.orgId).execute();
  return { tenant: org?.tax_code ?? null, entities: entities.map((e) => ({ id: e.id, taxCode: e.tax_code, isDefault: e.is_default })) };
}

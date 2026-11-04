// Member roles in Settings (issue #1279): which roles an owner may still give a member. The kernel checks again.
import type { BuiltinRoleKey, MemberRoles, RoleAssignment } from '@crove/kernel-contract';

type CatalogRole = MemberRoles['roles'][number];

// An entity role (external_accountant) names one legal entity per assignment.
export const roleNeedsEntity = (role: Pick<CatalogRole, 'scope'>) => role.scope === 'legal_entity';

// The roles an owner may still give the member, as the kernel decides:
// - an entity role, again for another entity, but never to an owner or admin: they see every entity anyway
//   (ROLE_SCOPE_NOT_FOR_ADMINS);
// - an org-wide role the member does not hold yet, but never to a member limited to some entities, whom it would lift
//   to every entity (ROLE_GRANT_WIDENS_SCOPE);
// - never a role that grants a permission to a viewer (ROLE_PRIVILEGED_FOR_VIEWER).
export function assignableRoles(catalog: readonly CatalogRole[], held: readonly Pick<RoleAssignment, 'roleKey' | 'legalEntityId'>[], baseRole: string): CatalogRole[] {
  const admin = baseRole === 'owner' || baseRole === 'admin';
  const limited = !admin && held.length > 0 && held.every((a) => a.legalEntityId !== null);
  return catalog.filter((role) => {
    if (baseRole === 'viewer' && role.permissions.length > 0) return false;
    if (roleNeedsEntity(role)) return !admin;
    return !limited && !held.some((a) => a.roleKey === role.key);
  });
}

// The department roles an owner may send with an invite (#2611): the catalog's org-wide roles, never an entity role (that is
// the entity toggle), and, for a viewer, none that grants a permission (the kernel refuses it: ROLE_PRIVILEGED_FOR_VIEWER).
export function inviteRoleChoices(catalog: readonly CatalogRole[], baseRole: string): CatalogRole[] {
  return catalog.filter((role) => !roleNeedsEntity(role) && !(baseRole === 'viewer' && role.permissions.length > 0));
}

// A role key the kernel sent as a plain string (an invite's), as the catalog's union, so a translation key built from it is
// checked against the few role names and not against every key of the catalog (a string there slows the typecheck to a crawl).
export const asRoleKey = (key: string) => key as BuiltinRoleKey;

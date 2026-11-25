// SPDX-License-Identifier: AGPL-3.0-only
// Org-scoped member permission helpers grounded in `orpc.org.get` and shared app gates (`canUseVy`, `canApproveProposals`).
// Server handlers re-check every permission and role inside PostgreSQL transactions.
import { useQuery } from '@tanstack/react-query';
import { orpc } from './api.ts';
import type { Role } from './members.ts';
import { canApproveProposals } from './review.ts';
import { canUseVy as hasVyPermission } from './vy.ts';

/** Resolve member permissions and convenience display gates for the current org. */
export function useOrgPermissions(enabled = true) {
  const orgDetail = useQuery({ ...orpc.org.get.queryOptions(), enabled });
  const permissions = orgDetail.data?.permissions ?? [];
  const role = orgDetail.data?.role as Role | undefined;
  return {
    orgDetail,
    role,
    permissions,
    permissionsLoaded: orgDetail.isSuccess,
    canUseVy: hasVyPermission(permissions),
    canApproveFinance: role !== 'viewer' && canApproveProposals(role, permissions),
  };
}

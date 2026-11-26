// SPDX-License-Identifier: AGPL-3.0-only
// What the kernel's refusals mean to a client. The RPC path throws oRPC errors that carry `code` and `status`; a client's own
// fetch paths build objects with the same two fields, so these checks recognise both (issue #180). Pure: no imports.

// The session is valid but has not passed the user's second factor yet (issue #126): the kernel refuses every call until it has.
export function isMfaRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'MFA_REQUIRED';
}

// The server answered and refused (a 4xx with its code): nothing it was asked to do was done. A lost response, a timeout or a
// 5xx says nothing about whether it was done.
export function isServerRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

// The org's owner revoked this session for that org only (issue #247): leave the org, keep the session.
export function isOrgAccessRevoked(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'SESSION_REVOKED_IN_ORG';
}

// R3 work (approve, membership changes) needs a second factor verified in the last 5 minutes (policy P11).
export function isStepUpRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'STEP_UP_REQUIRED';
}

// The session is dead: no token, a bad or expired one, a revoked or signed-out session, a token of another OAuth client.
export function isUnauthenticated(error: unknown): boolean {
  const e = error as { status?: number; code?: string } | null;
  if (isMfaRequired(error) || isOrgAccessRevoked(error)) return false;
  return e?.status === 401 || e?.code === 'UNAUTHORIZED' || e?.code === 'UNAUTHENTICATED';
}

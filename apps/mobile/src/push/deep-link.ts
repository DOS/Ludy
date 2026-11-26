// SPDX-License-Identifier: AGPL-3.0-only
// Parses content-free native push tap payloads into typed mobile navigation targets (#4883, ADR-0059).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/i;

export type NativePushRoute =
  | { kind: 'approval'; orgSlug: string; proposalId: string }
  | { kind: 'conversation'; orgSlug: string; conversationId: string }
  | { kind: 'inbox'; orgSlug: string };

function validUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function validSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return SLUG_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

function hasTraversalSegment(rawPath: string): boolean {
  const pathOnly = rawPath.split(/[?#]/, 1)[0] ?? '';
  for (const segment of pathOnly.split('/')) {
    if (!segment) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (segment === '.' || segment === '..' || decoded === '.' || decoded === '..') return true;
  }
  return false;
}

function routeFromPath(rawPath: unknown): NativePushRoute | null {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (
    !trimmed.startsWith('/o/') ||
    trimmed.includes('\t') ||
    trimmed.includes('\r') ||
    trimmed.includes('\n') ||
    trimmed.includes('\\') ||
    hasTraversalSegment(trimmed)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed, 'https://app.invalid');
  } catch {
    return null;
  }
  if (parsed.origin !== 'https://app.invalid') return null;

  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (segments[0] !== 'o') return null;
  const orgSlug = validSlug(segments[1]);
  if (!orgSlug) return null;

  if (segments[2] === 'inbox') {
    if (segments.length === 3) return { kind: 'inbox', orgSlug };
    if (segments.length === 4) {
      const proposalId = validUuid(segments[3]);
      return proposalId ? { kind: 'approval', orgSlug, proposalId } : null;
    }
    return null;
  }
  if (segments.length === 4 && segments[2] === 'social' && segments[3] === 'inbox') {
    const conversationId = validUuid(parsed.searchParams.get('c'));
    return conversationId ? { kind: 'conversation', orgSlug, conversationId } : { kind: 'inbox', orgSlug };
  }
  return null;
}

export function parseNativePushRoute(data: unknown): NativePushRoute | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const orgSlug = validSlug(record.orgSlug);
  const subjectId = validUuid(record.subjectId);

  if (orgSlug && record.kind === 'kernel.approval_waiting') {
    return subjectId ? { kind: 'approval', orgSlug, proposalId: subjectId } : { kind: 'inbox', orgSlug };
  }
  if (orgSlug && record.kind === 'kernel.conversation_new') {
    return subjectId ? { kind: 'conversation', orgSlug, conversationId: subjectId } : { kind: 'inbox', orgSlug };
  }
  return routeFromPath(record.path);
}

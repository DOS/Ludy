// SPDX-License-Identifier: AGPL-3.0-only

const ATTENDEE_EMAILS_MAX = 50;
const BASIC_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalizes, deduplicates, and caps up to 50 non-self, non-resource attendee emails for transient sync hashing. */
export function normalizeAttendeeEmails(
  items: readonly unknown[],
  extract: (item: unknown) => { email?: unknown; self?: unknown; resource?: unknown } | null,
): string[] {
  const out = new Set<string>();
  for (const item of items) {
    const parsed = extract(item);
    if (!parsed || parsed.self === true || parsed.resource === true) continue;
    if (typeof parsed.email !== 'string') continue;
    const normalized = parsed.email.trim().toLowerCase();
    if (normalized.length < 3 || normalized.length > 320 || !BASIC_EMAIL.test(normalized)) continue;
    out.add(normalized);
    if (out.size >= ATTENDEE_EMAILS_MAX) break;
  }
  return [...out].sort();
}

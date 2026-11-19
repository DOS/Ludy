// SPDX-License-Identifier: AGPL-3.0-only
// What the Inbox card of an AI coworker's Engage proposal shows (E4 #3863): the fields of the stored payload as plain text, never as markup. The payload is what an outside AI app sent (tainted): each value is
// cut to a bounded length, and control characters and the characters that make text read in another order (bidirectional overrides) are dropped, so a card cannot be made to say what it does not.
import { isEngageProposalKind, type EngageProposalView } from '@crove/kernel-contract';

const MAX_FIELDS = 40;
const VALUE_MAX = 8000;
const LONG_FROM = 80;
// Controls other than a newline and a tab, the bidirectional embeddings, overrides and isolates, and the zero-width marks.
const hidden = (code: number): boolean =>
  code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;

const textOf = (value: unknown): string => {
  const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return Array.from(raw.slice(0, VALUE_MAX * 2))
    .filter((ch) => !hidden(ch.codePointAt(0) ?? 0))
    .join('')
    .slice(0, VALUE_MAX);
};

export function engageViewOf(kind: string, command: string, payload: unknown): EngageProposalView | null {
  if (!isEngageProposalKind(kind) || typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const fields = Object.entries(payload as Record<string, unknown>)
    .filter(([key]) => /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key))
    .slice(0, MAX_FIELDS)
    .map(([key, value]) => {
      const text = textOf(value);
      return { key, value: text, long: text.length > LONG_FROM || text.includes('\n') };
    });
  return { command, fields };
}

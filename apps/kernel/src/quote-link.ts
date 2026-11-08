// SPDX-License-Identifier: AGPL-3.0-only
// The public side of quote links (#2694): the quote page sends the link's token and gets the quote document. It runs the migration's definer on the control plane as the API
// login role; the token is the only credential, a bad, expired or revoked token gets the same answer as an unknown one, and nothing else of the org comes back.
import { sql } from 'kysely';
import { z } from 'zod';
import { QUOTE_LOGO_MAX_BYTES, QUOTE_LOGO_TYPES, QUOTE_TOKEN_PATTERN, type QuoteDocument } from '@crove/kernel-contract';
import { readVerified, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { sniffType } from './sniff.ts';

export const QUOTE_VIEWS_PER_MINUTE = 60;
// Logo reads (a file read whole, at most QUOTE_LOGO_MAX_BYTES) in flight at once in a process.
export const QUOTE_LOGO_READS_MAX = 8;

const zView = z.strictObject({ token: z.string().regex(QUOTE_TOKEN_PATTERN) });

// null: a malformed body, or a token that names no live link (the same answer either way).
export async function quoteView(runtime: Runtime, body: unknown): Promise<QuoteDocument | null> {
  const input = zView.safeParse(body);
  if (!input.success) return null;
  return runtime.orgless(async (db) => {
    const { rows } = await sql<{ page: QuoteDocument | null }>`SELECT crove_crm.quote_link_view(${input.data.token}) AS page`.execute(db);
    return rows[0]?.page ?? null;
  });
}

// The bytes of a logo file as stored, read once and checked: a PNG or a JPEG of at most the allowed size, checked against its hash, and the content has to be the type the row says.
// null for anything else. A store or integrity error is thrown, for the caller to answer (the page's route) or to leave the logo out (the PDF's).
export async function readLogoFile(store: BlobStore, file: { storageKey: string; generation: string | null; sha256: string; contentType: string; sizeBytes: string | number }): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!(QUOTE_LOGO_TYPES as readonly string[]).includes(file.contentType) || Number(file.sizeBytes) > QUOTE_LOGO_MAX_BYTES) return null;
  const bytes = await readVerified(store, { key: file.storageKey, generation: file.generation, sha256: file.sha256 }, QUOTE_LOGO_MAX_BYTES);
  if (bytes.byteLength > QUOTE_LOGO_MAX_BYTES || sniffType(bytes) !== file.contentType) return null;
  return { bytes, contentType: file.contentType };
}

// The logo of the letterhead of the quote a link names (#2814): the migration's definer says which file it is (that quote's own org only, a PNG or a JPEG, behind the same refusals
// as the page), and readLogoFile reads it. null: a malformed body, a token that names no live link, a quote with no logo, or a file that is not the small image the upload checks let
// in (the same answer for all of them).
export async function quoteLogo(runtime: Runtime, store: BlobStore, body: unknown): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const input = zView.safeParse(body);
  if (!input.success) return null;
  const file = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ logo: { storageKey: string; generation: string | null; sha256: string; contentType: string; sizeBytes: string | number } | null }>`
      SELECT crove_crm.quote_link_logo(${input.data.token}) AS logo`.execute(db);
    return rows[0]?.logo ?? null;
  });
  return file ? readLogoFile(store, file) : null;
}

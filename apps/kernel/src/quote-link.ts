// SPDX-License-Identifier: AGPL-3.0-only
// The public side of quote links (#2694): the quote page sends the link's token and gets the quote document. It runs the migration's definer on the control plane as the API
// login role; the token is the only credential, a bad, expired or revoked token gets the same answer as an unknown one, and nothing else of the org comes back.
import { sql } from 'kysely';
import { z } from 'zod';
import { QUOTE_TOKEN_PATTERN, type QuoteDocument } from '@crove/kernel-contract';
import type { Runtime } from '@crove/kernel-runtime';

export const QUOTE_VIEWS_PER_MINUTE = 60;

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

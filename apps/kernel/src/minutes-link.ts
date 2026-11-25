// SPDX-License-Identifier: AGPL-3.0-only
// The public side of minutes links (#4822): the page sends the link's token and gets the published minutes of one meeting. It runs the migration's definer on the control plane as the API
// login role; the token is the only credential, and a malformed body, a bad, expired or revoked token, a switch that is off, an app that is off and minutes that are not published
// all get the same answer (null). What the definer returns is checked again here against the page's strict schema, so a key it should not carry never reaches a stranger.
import { sql } from 'kysely';
import { z } from 'zod';
import { MINUTES_TOKEN_PATTERN, zMinutesPage, type MinutesPage } from '@ludy/kernel-contract';
import type { Runtime } from '@ludy/kernel-runtime';

export const MINUTES_VIEWS_PER_MINUTE = 60;

const zView = z.strictObject({ token: z.string().regex(MINUTES_TOKEN_PATTERN) });

export async function minutesView(runtime: Runtime, body: unknown): Promise<MinutesPage | null> {
  const input = zView.safeParse(body);
  if (!input.success) return null;
  const page = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ page: unknown }>`SELECT page FROM ludy_meetings.minutes_link_view(${input.data.token})`.execute(db);
    return rows[0]?.page ?? null;
  });
  if (page === null) return null;
  const parsed = zMinutesPage.safeParse(page);
  return parsed.success ? parsed.data : null;
}

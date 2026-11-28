// SPDX-License-Identifier: AGPL-3.0-only
// R0 batched signals read of non-CC signers who opened an active envelope in the last 7 days (#4994 SG2).
// Returns only IDs and timestamps (zero text, names, emails, or tokens), enforcing org_app_on('sign'),
// viewer = [], hr_contract and meeting_minutes confidentiality (and company-grant-only + explicit exclusion under MCP).
import { sql } from 'kysely';
import { z } from 'zod';
import {
  SIGNALS_MAX_CRM,
  SIGN_OPENED_DAYS,
  SIGN_OPENED_SIGNALS_READ,
  zSignOpenedSignals,
  type SignOpenedSignal,
} from '@ludy/kernel-contract';
import { DomainError, defineQuery } from '@ludy/kernel-runtime';
import { applyEnvelopeVisibilityFilter } from './hr-visibility.ts';
import { applyMeetingMinutesVisibilityFilter } from './meeting-visibility.ts';
import { SIGN_READERS } from './shared.ts';

const CONFIDENTIAL_SOURCE_KINDS = ['hr_contract', 'meeting_minutes'] as const;
const DAY_MS = 86_400_000;

export const signOpenedSignals = defineQuery({
  name: SIGN_OPENED_SIGNALS_READ,
  input: z.strictObject({}),
  access: SIGN_READERS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<SignOpenedSignal[]> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    }
    const isMcp = ctx.actor.mcp !== undefined;
    if (isMcp && ((ctx.role !== 'owner' && ctx.role !== 'admin') || ctx.actor.mcp?.kind === 'member')) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP của công ty mới dùng được truy vấn này');
    }
    if (!isMcp && (ctx.role === null || ctx.role === 'viewer')) {
      return [];
    }

    const { rows: appRows } = await sql<{ enabled: boolean }>`
      SELECT ludy_kernel.org_app_on(${ctx.orgId}::uuid, 'sign') AS enabled
    `.execute(ctx.trx);
    if (!appRows[0]?.enabled) return [];

    const now = new Date();
    const cutoff = new Date(now.getTime() - SIGN_OPENED_DAYS * DAY_MS);

    const rows = await ctx.trx
      .with('visible_envelopes', (db) => {
        let q = db
          .selectFrom('ludy_sign.envelope')
          .select(['id'])
          .where('org_id', '=', ctx.orgId)
          .where('status', 'in', ['sent', 'in_progress'])
          .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]));
        if (isMcp) {
          q = q.where('source_kind', 'not in', [...CONFIDENTIAL_SOURCE_KINDS]);
        } else {
          q = applyEnvelopeVisibilityFilter(q, ctx);
          q = applyMeetingMinutesVisibilityFilter(q, ctx);
        }
        return q;
      })
      .with('matched', (db) =>
        db
          .selectFrom('visible_envelopes as ve')
          .innerJoin('ludy_sign.signer as s', (join) =>
            join.onRef('s.envelope_id', '=', 've.id').on('s.org_id', '=', ctx.orgId),
          )
          .innerJoin('ludy_kernel.party as p', (join) =>
            join
              .on('p.org_id', '=', ctx.orgId)
              .on(sql<boolean>`pg_catalog.lower(pg_catalog.btrim(p.email)) = pg_catalog.lower(pg_catalog.btrim(s.email))`),
          )
          .innerJoin('ludy_kernel.party as k', (join) =>
            join
              .on('k.org_id', '=', ctx.orgId)
              .on(sql<boolean>`k.id = COALESCE(p.duplicate_of, p.id)`),
          )
          .distinctOn('k.id')
          .select([
            'k.id as party_id',
            've.id as envelope_id',
            's.viewed_at as opened_at',
          ])
          .where('s.signer_role', '<>', 'cc')
          .where('s.status', 'in', ['pending', 'viewed'])
          .where('s.signed_at', 'is', null)
          .where('s.declined_at', 'is', null)
          .where('s.viewed_at', 'is not', null)
          .where('s.viewed_at', '>=', cutoff)
          .where('s.email', 'is not', null)
          .where(sql<boolean>`pg_catalog.btrim(s.email) <> ''`)
          .where('p.email', 'is not', null)
          .where(sql<boolean>`pg_catalog.btrim(p.email) <> ''`)
          .where('k.duplicate_of', 'is', null)
          .orderBy('k.id', 'asc')
          .orderBy('s.viewed_at', 'desc')
          .orderBy('ve.id', 'asc'),
      )
      .selectFrom('matched')
      .select(['party_id', 'envelope_id', 'opened_at'])
      .orderBy('opened_at', 'desc')
      .orderBy('party_id', 'asc')
      .limit(SIGNALS_MAX_CRM)
      .execute();

    const mapped: SignOpenedSignal[] = [];
    for (const r of rows) {
      if (r.opened_at === null) continue;
      mapped.push({
        partyId: r.party_id,
        envelopeId: r.envelope_id,
        openedAt: (r.opened_at instanceof Date ? r.opened_at : new Date(r.opened_at)).toISOString(),
      });
    }
    return zSignOpenedSignals.parse(mapped);
  },
});

export const signSignalQueries = [signOpenedSignals];

// SPDX-License-Identifier: AGPL-3.0-only
// The record of one try of the revoke at the platform (W2-1, issue #2296, ADR-0043 point 4): the worker (apps/kernel/src/ads-revoke.ts) opens the
// sealed copy of a closed connection's token, calls the platform's one revoking call, and reports the outcome here. The command applies the policy
// (token-revoke.ts: the next time, the tenth try, the seventh day; the tries were counted when the copy was opened) and has the database record it through a worker-only definer; the
// database's own guard holds the record to the same rules and wipes the sealed copy in the statement that ends the obligation. Only the system runs it,
// and nothing it takes or returns is a token: ids, states, counts and error codes.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, type AdsTokenRevokeView } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { settleAttempt, type RevokeOutcome } from './token-revoke.ts';

const zOutcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('done'), how: z.enum(['revoked', 'already_invalid', 'sandbox', 'shared_grant']) }),
  z.strictObject({ kind: z.literal('unrevocable'), code: z.string().regex(/^[A-Za-z0-9_.]{1,64}$/).nullable() }),
  z.strictObject({
    kind: z.literal('failed'),
    error: z.enum(['rate_limited', 'transient', 'permission', 'bad_request', 'unknown']),
    code: z.string().regex(/^[A-Za-z0-9_.]{1,64}$/).nullable(),
    retryAt: z.iso.datetime({ offset: true }).nullable(),
  }),
]);

// `leaseToken` is the fencing token of the claim the outcome answers: a run that stalled past its lease and was claimed again by a newer run is refused.
export const zAdsTokenRevokeRecord = z.strictObject({ revokeId: zId, leaseToken: zId, outcome: zOutcome });
export type AdsTokenRevokeRecordInput = z.infer<typeof zAdsTokenRevokeRecord>;

export interface AdsTokenRevokeRecorded {
  revokeId: string;
  state: 'pending' | 'done' | 'gave_up';
  attempts: number;
  nextAttemptAt: string | null;
  // False when the obligation was already settled (the age sweep got there first): nothing was recorded.
  recorded: boolean;
}

// The errors the definers raise, as domain errors.
function revokeError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  if (message === 'ADS_REVOKE_STALE') throw new DomainError('ADS_REVOKE_STALE', 409, 'Lần gỡ quyền này đã được một tiến trình khác tiếp nhận');
  if (message === 'ADS_REVOKE_NOT_FOUND') throw new DomainError('ADS_REVOKE_NOT_FOUND', 404, 'Không tìm thấy việc gỡ quyền này');
  if (message === 'ADS_WORKER_ONLY') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình nền mới ghi được kết quả gỡ quyền');
  throw error;
}

export const adsTokenRevokeRecord = defineCommand({
  name: 'ads.token_revoke.record',
  input: zAdsTokenRevokeRecord,
  // It changes only the record of what the platform answered: the call itself was the job's, and it spends nothing.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx: CommandContext, input: AdsTokenRevokeRecordInput): Promise<AdsTokenRevokeRecorded> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_ads.ad_token_revoke')
      .select(['state', 'attempts', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.revokeId)
      .executeTakeFirst();
    if (!row) throw new DomainError('ADS_REVOKE_NOT_FOUND', 404, 'Không tìm thấy việc gỡ quyền này');
    if (row.state !== 'pending') return { revokeId: input.revokeId, state: row.state, attempts: row.attempts, nextAttemptAt: null, recorded: false };
    const given = input.outcome;
    const outcome: RevokeOutcome =
      given.kind === 'done'
        ? { kind: 'done', how: given.how }
        : given.kind === 'unrevocable'
          ? { kind: 'unrevocable', code: given.code }
          : { kind: 'failed', error: given.error, code: given.code, retryAt: given.retryAt ? new Date(given.retryAt) : null };
    // The tries were counted when the copy was opened, so the count the policy settles is the row's own.
    const settled = settleAttempt({ state: row.state, attempts: row.attempts, createdAt: new Date(row.created_at) }, outcome, ctx.now);
    const errorKind = outcome.kind === 'failed' ? outcome.error : null;
    const errorCode = outcome.kind === 'done' ? null : outcome.code;
    await sql`
      SELECT crove_ads.token_revoke_settle(
        ${ctx.orgId}::uuid, ${input.revokeId}::uuid, ${input.leaseToken}::uuid, ${settled.state}, ${settled.nextAttemptAt?.toISOString() ?? null}::timestamptz,
        ${settled.how}, ${settled.giveUp}, ${errorKind}, ${errorCode})`
      .execute(ctx.trx)
      .catch(revokeError);
    // Ids, states, counts and error codes only: never the token, never the platform's text.
    ctx.audit({ revokeId: input.revokeId, state: settled.state, attempts: row.attempts, how: settled.how, giveUp: settled.giveUp, errorKind, errorCode });
    return { revokeId: input.revokeId, state: settled.state, attempts: row.attempts, nextAttemptAt: settled.nextAttemptAt?.toISOString() ?? null, recorded: true };
  },
});

// What the Ads screen shows of the obligations (owners and admins): the open ones, and the ones that gave up in the last 30 days (the person is told to
// remove the app by hand). Read through the tenant role, which has SELECT on the state table and no grant at all on the sealed copy.
export async function tokenRevokeViews(ctx: { trx: CommandContext['trx']; orgId: string }): Promise<AdsTokenRevokeView[]> {
  const { rows } = await sql<{
    id: string;
    ad_account_id: string | null;
    account_name: string | null;
    provider: string;
    external_account_id: string;
    kind: 'write' | 'read_spend';
    state: 'pending' | 'done' | 'gave_up';
    give_up: 'attempts' | 'age' | 'unrevocable' | null;
    attempts: number;
    next_attempt_at: Date | null;
    last_error_kind: AdsTokenRevokeView['lastErrorKind'];
    created_at: Date;
  }>`
    SELECT r.id, r.ad_account_id, a.name AS account_name, r.provider, r.external_account_id, r.kind, r.state, r.give_up, r.attempts, r.next_attempt_at, r.last_error_kind, r.created_at
    FROM crove_ads.ad_token_revoke r
    LEFT JOIN crove_ads.ad_account a ON a.org_id = r.org_id AND a.id = r.ad_account_id
    WHERE r.org_id = ${ctx.orgId}::uuid AND (r.state = 'pending' OR (r.state = 'gave_up' AND r.settled_at > pg_catalog.now() - pg_catalog.make_interval(days => 30)))
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 50`.execute(ctx.trx);
  return rows.map((r) => ({
    id: r.id,
    adAccountId: r.ad_account_id,
    accountName: r.account_name,
    provider: r.provider,
    externalAccountId: r.external_account_id,
    kind: r.kind,
    state: r.state === 'gave_up' ? 'gave_up' : 'pending',
    giveUp: r.give_up,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
    lastErrorKind: r.last_error_kind,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export const tokenRevokeCommands = [adsTokenRevokeRecord];

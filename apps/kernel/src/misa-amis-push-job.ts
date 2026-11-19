// SPDX-License-Identifier: AGPL-3.0-only
// The push of vouchers to MISA AMIS Kế toán, the worker's half (#3902, S3b of #3854; ADR-0025, ADR-0044 points 3 to 5), run as the system for one connection when an owner or admin confirmed a push
// (finance.misa_amis.push). The access code is opened here and nowhere else (the API only seals it). Every send is committed to the external_call ledger BEFORE it is made
// (finance.misa_amis.push_begin); a batch begun and never answered is `ambiguous` and is never sent again: MISA is asked for its results instead. What comes back is recorded
// (finance.misa_amis.push_record). The voucher body is never stored: it is rebuilt from the source with the same path the preview used, and checked against the digest the person approved before it goes out.
//
// One run: read the AMIS branch (once, when something is queued), ask MISA for the results of the rows it took or whose answer was lost, then send queued batches of at most AMIS_SAVE_BATCH_MAX
// until none is left. Results come by polling in this slice (the callback route is S4, #3903): the run reports `waiting` while rows wait for MISA's answer, and the worker asks again later.
// Nothing here logs or stores a credential, a party's name, an amount or MISA's own text other than the capped `reason` of a refused voucher: ids, codes and counts.
import { AMIS_DICTIONARIES, AmisError, amisErrorText, isOrgRefId, type AmisCallbackResult, type AmisClient, type AmisConnection } from '@crove/misa-amis';
import { MISA_AMIS_PREVIEW_LIMIT, type MisaAmisPreviewAsk } from '@crove/kernel-contract';
import { amisContextOf, amisPartRows, loadAmisEntries, MISA_AMIS_CHANNEL_PROVIDER, type AmisPartRow, type MisaAmisPushBegin, type MisaAmisPushRecord, type MisaAmisPushTarget } from '@crove/mod-finance';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };

// The most batches one run sends (50 vouchers each): a long queue goes on in the next run, which the worker queues while rows are still waiting.
const MAX_STEPS = 40;
const RESULT_PAGE = 1000;
const RESULT_PAGES_MAX = 20;
const DAY_MS = 24 * 3600 * 1000;

export interface MisaAmisPushJob {
  orgId: string;
  // The finance module's connection row id, not the channel connection's.
  connectionId: string;
  // How many times this chain of runs came back (the worker's own count; it bounds a chain that waits on an unreachable AMIS).
  round?: number;
}

export interface MisaAmisPushDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  client: AmisClient;
  // Today, for the day MISA is asked about; a test passes its own.
  now?: () => Date;
}

export type MisaAmisPushOutcome =
  // The connection is left alone (gone, or no longer active), or its access code cannot be opened or is refused: nothing was sent; queued rows stay queued and the connection shows its own status.
  | { state: 'skipped'; reason: string }
  | { state: 'credentials'; waiting: false }
  // AMIS could not be reached to read its branch or its results: queued rows stay queued, the worker asks again a few times.
  | { state: 'unreachable'; waiting: true }
  | { state: 'done'; batches: number; sent: number; failed: number; accepted: number; refused: number; waiting: boolean };

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

// A move as the job builds it: the attempt is added from what the begin step handed out (see `record`).
type Move = Omit<MisaAmisPushRecord['rows'][number], 'attempts'>;
type CallEnd = NonNullable<MisaAmisPushRecord['call']>['end'];

const reasonOf = (error: AmisError): string => (error.code ? amisErrorText(error.code) : 'AMIS từ chối yêu cầu này');

// The AMIS branch every voucher kind needs. The dictionary of organisation units (data_type 6) holds it; the field that carries its id is UNCONFIRMED until the sandbox check (docs/runbooks/misa-amis-sandbox-check.md),
// so only a single, well-formed id is taken: none or several leave the batch `failed` with BRANCH_UNKNOWN for a person to settle, never a guess.
async function readBranch(client: AmisClient, connection: AmisConnection): Promise<string | null> {
  const rows = await client.dictionary(connection, { dataType: AMIS_DICTIONARIES.organizationUnit, skip: 0, take: 100, lastSyncTime: null, branchId: null });
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row.organization_unit_id ?? row.branch_id ?? row.id;
    if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ids.add(id.toLowerCase());
  }
  return ids.size === 1 ? [...ids][0] ?? null : null;
}

export async function runMisaAmisPush(deps: MisaAmisPushDeps, job: MisaAmisPushJob): Promise<MisaAmisPushOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const now = deps.now ?? (() => new Date());
  const target = await deps.runtime.query<MisaAmisPushTarget>('finance.misa_amis.push_target', { connectionId: job.connectionId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };

  // The access code: opened from the sealed copy, and refused once the member who connected it may no longer use it or the connection is no longer active.
  let connection: AmisConnection;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.channelConnectionId }, options);
    if (sealed.provider !== MISA_AMIS_CHANNEL_PROVIDER) {
      console.warn(`[misa-amis] push ${job.connectionId.slice(0, 8)}: credential of another provider, not opened`);
      return { state: 'credentials', waiting: false };
    }
    const accessCode = String(deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId }));
    connection = { accessCode, orgCompanyCode: target.orgCompanyCode };
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
      if (error.code === 'CHANNEL_OWNER_LEFT') await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: target.channelConnectionId, reason: 'owner_left' }, options);
      return { state: 'credentials', waiting: false };
    }
    throw error;
  }

  const query = <T>(name: string, input: unknown): Promise<T> => deps.runtime.query<T>(name, input, options);
  // The attempt each row was begun under: a completion carries it back, so a stalled run never lands on a row a person has sent again (one more attempt).
  const attemptOf = new Map<string, number>();
  const record = (rows: Move[], call: MisaAmisPushRecord['call']) =>
    deps.runtime.execute<{ applied: number; ignored: number }>(
      'finance.misa_amis.push_record',
      { connectionId: job.connectionId, rows: rows.map((m) => ({ ...m, attempts: attemptOf.get(m.orgRefid) ?? 1 })), call },
      options,
    );
  const tally = { batches: 0, sent: 0, failed: 0, accepted: 0, refused: 0 };
  let checked = false;
  let branchKnown = false;
  let branchId: string | null = null;
  let waiting = false;

  for (let step = 0; step < MAX_STEPS * 2; step++) {
    const begun = await deps.runtime.execute<MisaAmisPushBegin>('finance.misa_amis.push_begin', { connectionId: job.connectionId, branchKnown, checked }, options);
    if (begun.action === 'none') {
      waiting = begun.waiting;
      break;
    }

    if (begun.action === 'need_branch') {
      try {
        branchId = await readBranch(deps.client, connection);
      } catch (error) {
        // Nothing was begun: queued rows stay queued.
        if (error instanceof AmisError && error.kind === 'credentials') return { state: 'credentials', waiting: false };
        console.warn(`[misa-amis] push ${job.connectionId.slice(0, 8)}: branch not read (${error instanceof AmisError ? error.kind : 'error'})`);
        return { state: 'unreachable', waiting: true };
      }
      branchKnown = true;
      continue;
    }

    if (begun.action === 'check') {
      checked = true;
      for (const row of begun.rows) attemptOf.set(row.orgRefid, row.attempts);
      let results: AmisCallbackResult[];
      try {
        results = await readResults(deps.client, connection, begun.from, now());
      } catch (error) {
        if (error instanceof AmisError && error.kind === 'credentials') return { state: 'credentials', waiting: false };
        console.warn(`[misa-amis] push ${job.connectionId.slice(0, 8)}: results not read (${error instanceof AmisError ? error.kind : 'error'})`);
        // Rows stay as they are; the batches that are queued still go out.
        continue;
      }
      const byRefid = new Map(results.map((r) => [r.orgRefId, r]));
      const moves: Move[] = [];
      for (const row of begun.rows) {
        const result = byRefid.get(row.orgRefid);
        if (!result || (row.state !== 'sent' && row.state !== 'ambiguous')) continue;
        moves.push({ orgRefid: row.orgRefid, from: row.state, to: result.success ? 'accepted' : 'refused', reason: result.success ? null : (result.errorMessage ?? (result.errorCode ? amisErrorText(result.errorCode) : null)) });
      }
      if (moves.length > 0) {
        await record(moves, null);
        tally.accepted += moves.filter((m) => m.to === 'accepted').length;
        tally.refused += moves.filter((m) => m.to === 'refused').length;
      }
      continue;
    }

    // action === 'send'
    tally.batches += 1;
    for (const row of begun.rows) attemptOf.set(row.orgRefid, row.attempts);
    const ask: MisaAmisPreviewAsk = { ...begun.params, legalEntityId: target.legalEntityId };
    const moves: Move[] = [];
    const ready: AmisPartRow[] = [];
    if (branchId === null) {
      for (const row of begun.rows) moves.push({ orgRefid: row.orgRefid, from: 'sending', to: 'failed', reason: 'BRANCH_UNKNOWN' });
    } else {
      // Rebuilt from the source with the real branch for EVERY batch (never reused from an earlier batch of the run: a voucher changed or removed while an earlier batch was being sent must not go out as it was); a
      // part that is gone, blocked or different from what the person approved is `failed` and never sent.
      let parts: Map<string, AmisPartRow>;
      try {
        const { entries } = await loadAmisEntries(query, ask, amisContextOf(ask, branchId), MISA_AMIS_PREVIEW_LIMIT + 1);
        parts = new Map(amisPartRows(entries).map((p) => [p.orgRefid, p]));
      } catch (error) {
        // The batch could not be built: nothing was sent, so the rows go back to the queue and the run asks to be tried again.
        console.warn(`[misa-amis] push ${job.connectionId.slice(0, 8)}: batch not built (${error instanceof Error ? error.name : 'error'})`);
        await record(
          begun.rows.map((row) => ({ orgRefid: row.orgRefid, from: 'sending' as const, to: 'queued' as const, reason: 'BUILD_FAILED' })),
          { key: begun.callKey, end: { state: 'failed', kind: 'transient', code: 'BUILD_FAILED' } },
        );
        return { state: 'unreachable', waiting: true };
      }
      for (const row of begun.rows) {
        const part = parts.get(row.orgRefid);
        if (!part || part.digest !== row.digest || part.voucherType !== begun.voucherType || !isOrgRefId(part.orgRefid)) moves.push({ orgRefid: row.orgRefid, from: 'sending', to: 'failed', reason: 'STALE' });
        else ready.push(part);
      }
    }
    let end: CallEnd;
    if (ready.length === 0) {
      end = { state: 'failed', kind: 'bad_request', code: branchId === null ? 'BRANCH_UNKNOWN' : 'STALE' };
    } else {
      const sentRows = ready.map((p) => p.orgRefid);
      try {
        await deps.client.save(connection, ready.map((p) => p.voucher));
        end = { state: 'succeeded' };
        for (const orgRefid of sentRows) moves.push({ orgRefid, from: 'sending', to: 'sent', reason: null });
      } catch (error) {
        const kind = error instanceof AmisError ? error.kind : 'unknown';
        console.warn(`[misa-amis] push ${job.connectionId.slice(0, 8)}: save ${kind}${error instanceof AmisError && error.code ? ` (${error.code})` : ''}`);
        if (error instanceof AmisError && (error.kind === 'credentials' || error.kind === 'token')) {
          // MISA refused the connection before it took anything: the rows go back to the queue with the code on screen, and nothing more is sent in this run.
          end = { state: 'failed', kind: 'permission', code: 'CREDENTIALS' };
          for (const orgRefid of sentRows) moves.push({ orgRefid, from: 'sending', to: 'queued', reason: 'CREDENTIALS' });
          await record(moves, { key: begun.callKey, end });
          tally.failed += moves.filter((m) => m.to === 'failed').length;
          return { state: 'credentials', waiting: false };
        }
        if (error instanceof AmisError && error.kind === 'unreachable') {
          // The host could not be reached, so nothing was sent (the adapter's own contract): the rows go back to the queue and the run asks to be tried again.
          end = { state: 'failed', kind: 'transient', code: 'UNREACHABLE' };
          for (const orgRefid of sentRows) moves.push({ orgRefid, from: 'sending', to: 'queued', reason: 'UNREACHABLE' });
          await record(moves, { key: begun.callKey, end });
          return { state: 'unreachable', waiting: true };
        }
        if (error instanceof AmisError && error.kind === 'refused') {
          // MISA understood the request and refused all of it: nothing was created.
          end = { state: 'failed', kind: 'bad_request', code: error.code ?? 'REFUSED' };
          for (const orgRefid of sentRows) moves.push({ orgRefid, from: 'sending', to: 'refused', reason: reasonOf(error) });
        } else if (error instanceof AmisError && error.kind === 'invalid_request') {
          // Refused here, before anything was sent (an amount that is not exact, more lines than MISA takes): `failed`, with the reason as a code.
          end = { state: 'failed', kind: 'bad_request', code: error.reason ?? 'INVALID' };
          for (const orgRefid of sentRows) moves.push({ orgRefid, from: 'sending', to: 'failed', reason: `INVALID:${error.reason ?? 'request'}` });
        } else {
          // The request may or may not have reached MISA: the rows are `ambiguous` and are never sent again; the next check asks MISA for them.
          end = { state: 'ambiguous', kind: error instanceof AmisError && error.kind === 'unavailable' ? 'transient' : 'unknown', code: error instanceof AmisError ? error.kind.toUpperCase() : 'ERROR' };
          for (const orgRefid of sentRows) moves.push({ orgRefid, from: 'sending', to: 'ambiguous', reason: 'LOST_ANSWER' });
        }
      }
    }
    await record(moves, { key: begun.callKey, end });
    tally.sent += moves.filter((m) => m.to === 'sent').length;
    tally.failed += moves.filter((m) => m.to === 'failed').length;
    if (tally.batches >= MAX_STEPS) {
      waiting = true;
      break;
    }
  }
  console.log(`[misa-amis] push ${job.connectionId.slice(0, 8)}: ${tally.batches} batch(es), ${tally.sent} sent, ${tally.failed} failed, ${tally.accepted} accepted, ${tally.refused} refused${waiting ? ', waiting' : ''}`);
  return { state: 'done', ...tally, waiting };
}

// The results MISA holds from the day before the first row was sent to tomorrow (its time zone is not documented), a page at a time.
async function readResults(client: AmisClient, connection: AmisConnection, from: string, now: Date): Promise<AmisCallbackResult[]> {
  const first = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const last = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
  const all: AmisCallbackResult[] = [];
  for (let page = 0; page < RESULT_PAGES_MAX; page++) {
    const rows = await client.callbackResults(connection, { from: first, to: last, skip: page * RESULT_PAGE, take: RESULT_PAGE });
    all.push(...rows);
    if (rows.length < RESULT_PAGE) break;
  }
  return all;
}

// ---------------------------------------------------------------------------------------------------------------
// When the job comes back. pg-boss's exclusive queue drops a send whose singleton key is queued or ACTIVE, so a run never queues itself under its own key: every follow-up has a key of its own round.
// While rows wait for MISA's answer the job comes back every two minutes for the day MISA is asked about; for an unreachable AMIS with queued rows it tries ten more times; and a run that came from a press
// (round 0) always asks once more a minute later, so a press whose own send was dropped because a run was active is found (the rows it queued are in the table either way).
export const PUSH_RECHECK_SECONDS = 120;
export const PUSH_PRESS_RECHECK_SECONDS = 60;
export const PUSH_WAIT_ROUNDS = 720;
export const PUSH_UNREACHABLE_ROUNDS = 10;

export interface PushFollowUp {
  data: MisaAmisPushJob;
  /** The singleton key's tail, after the org and queue: the connection and the round, never the same for two rounds. */
  keyTail: string;
  startAfterSeconds: number;
}

export function pushFollowUp(job: MisaAmisPushJob, outcome: MisaAmisPushOutcome): PushFollowUp | null {
  const round = job.round ?? 0;
  const next = (startAfterSeconds: number): PushFollowUp => ({ data: { orgId: job.orgId, connectionId: job.connectionId, round: round + 1 }, keyTail: `${job.connectionId}:r${round + 1}`, startAfterSeconds });
  if (outcome.state === 'done') {
    if (outcome.waiting && round < PUSH_WAIT_ROUNDS) return next(PUSH_RECHECK_SECONDS);
    return round === 0 ? next(PUSH_PRESS_RECHECK_SECONDS) : null;
  }
  if (outcome.state === 'unreachable') return round < PUSH_UNREACHABLE_ROUNDS ? next(PUSH_RECHECK_SECONDS) : null;
  return null;
}

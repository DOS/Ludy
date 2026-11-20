// SPDX-License-Identifier: AGPL-3.0-only
// The push of vouchers to MISA AMIS Kế toán, the worker's half (#3902, S3b of #3854; ADR-0025, ADR-0044 points 3 to 5), run as the system for one connection when an owner or admin confirmed a push
// (finance.misa_amis.push). The access code is opened here and nowhere else (the API only seals it). Every send is committed to the external_call ledger BEFORE it is made
// (finance.misa_amis.push_begin); a batch begun and never answered is `ambiguous` and is never sent again: MISA is asked for its results instead. What comes back is recorded
// (finance.misa_amis.push_record). The voucher body is never stored: it is rebuilt from the source with the same path the preview used, and checked against the digest the person approved before it goes out.
//
// One run: read the AMIS branch (once, when something is queued), ask MISA for the results of the rows it took or whose answer was lost, then send queued batches of at most AMIS_SAVE_BATCH_MAX
// until none is left. Results come by polling for AMIS (and by the callback route, #3903): the run reports `waiting` while rows wait for MISA's answer, and the worker asks again later.
// MISA ASP (#4113, S4 of #4103) has no call that lists results: its connection is pushed by the same steps with ASP's client, and its rows are settled only by the callback or by a person (no result check, no
// waiting for a `sent` row).
// Sent only fresh (#4124, S3b of #4103): right before a batch goes out the entries its stored matches rely on are read from the catalogue once more (parties by tax code, items by code), and a batch whose match
// changed in MISA since the check (an entry gone, inactive, with another tax code, or now ambiguous) is `failed` with MATCH_STALE and nothing is sent; a person checks again and confirms again.
// Nothing here logs or stores a credential, a party's name, an amount or MISA's own text other than the capped `reason` of a refused voucher: ids, codes and counts.
import { AMIS_DICTIONARIES, AmisError, amisErrorText, isOrgRefId, type AmisCallbackResult, type AmisClient, type AmisConnection, type AmisVoucher } from '@crove/misa-amis';
import { MISA_AMIS_PREVIEW_LIMIT, type MisaAmisMatchResult, type MisaAmisPreviewAsk } from '@crove/kernel-contract';
import { amisContextOf, amisPartRows, loadAmisEntries, misaChannelProvider, relied, staleMatches, type AmisPartRow, type MisaAmisMatchResults, type MisaAmisPushBegin, type MisaAmisPushRecord, type MisaAmisPushTarget } from '@crove/mod-finance';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { matchCatalogue, readStockNames, TooLarge } from './misa-amis-catalogue.ts';

const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };

// The most batches one run sends (50 vouchers each): a long queue goes on in the next run, which the worker queues while rows are still waiting.
const MAX_STEPS = 40;
const RESULT_PAGE = 1000;
const RESULT_PAGES_MAX = 20;
const DAY_MS = 24 * 3600 * 1000;
// A read of the catalogue before a send is used for the batches that follow it for this long: a run that sends many batches does not read 20 pages of the catalogue for each, and a match is never sent on a read older than this.
export const CATALOGUE_REREAD_MS = 5 * 60 * 1000;

export interface MisaAmisPushJob {
  orgId: string;
  // The finance module's connection row id, not the channel connection's.
  connectionId: string;
  // How many times this chain of runs came back (the worker's own count; it bounds a chain that waits for MISA's answer).
  round?: number;
  // How many runs in a row found AMIS unreachable (the worker's own count; absent after a run that reached it). It bounds the retries for an unreachable AMIS, wherever the chain is in its day (#4041).
  unreachable?: number;
}

export interface MisaAmisPushDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The client of each product, null where the deployment holds no ClientID or has not switched the push on for it (#4113): a connection of that product is left alone, its queued rows stay queued.
  client: AmisClient | null;
  aspClient?: AmisClient | null;
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

/** The stock ids a voucher's lines carry (ASP). */
export const stockIdsOf = (voucher: AmisVoucher): string[] => voucher.detail.flatMap((line) => (typeof (line as { stock_id?: unknown }).stock_id === 'string' ? [(line as { stock_id: string }).stock_id] : []));
/** The part with `stock_name` beside each `stock_id`, or null when a stock has no name in the fresh read. The part's digest is not recomputed: the name is not what a person confirmed. */
export function withStockNames(part: AmisPartRow, names: ReadonlyMap<string, string>): AmisPartRow | null {
  const detail: unknown[] = [];
  for (const line of part.voucher.detail) {
    const id = (line as { stock_id?: unknown }).stock_id;
    if (typeof id !== 'string') {
      detail.push(line);
      continue;
    }
    const name = names.get(id.toLowerCase());
    if (name === undefined) return null;
    detail.push({ ...(line as Record<string, unknown>), stock_name: name });
  }
  return { ...part, voucher: { ...part.voucher, detail } };
}

export async function runMisaAmisPush(deps: MisaAmisPushDeps, job: MisaAmisPushJob): Promise<MisaAmisPushOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const now = deps.now ?? (() => new Date());
  const target = await deps.runtime.query<MisaAmisPushTarget>('finance.misa_amis.push_target', { connectionId: job.connectionId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };
  // The product of the connection decides the client, the provider its access code was sealed for, and whether MISA is asked for results (AMIS: by polling; ASP: never, its results come by the callback).
  const client = target.product === 'asp' ? (deps.aspClient ?? null) : deps.client;
  if (!client) return { state: 'skipped', reason: 'product_off' };

  // The access code: opened from the sealed copy, and refused once the member who connected it may no longer use it or the connection is no longer active.
  let connection: AmisConnection;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.channelConnectionId }, options);
    // Only an access code sealed for this connection's product is opened (the other MISA product's, or another provider's, never).
    if (sealed.provider !== misaChannelProvider(target.product)) {
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
  // The last read of the catalogue for a send: what it was asked for, when, and what it found (held in memory for CATALOGUE_REREAD_MS, never stored).
  let reread: { key: string; at: number; results: MisaAmisMatchResult[] } | null = null;
  // The references a read already failed for in this run (too large, or no page): the batches that follow with the same ones fail at once, without reading 20 pages again to fail the same way.
  let unreadable: string | null = null;

  for (let step = 0; step < MAX_STEPS * 2; step++) {
    const begun = await deps.runtime.execute<MisaAmisPushBegin>('finance.misa_amis.push_begin', { connectionId: job.connectionId, branchKnown, checked }, options);
    if (begun.action === 'none') {
      waiting = begun.waiting;
      break;
    }

    if (begun.action === 'need_branch') {
      try {
        branchId = await readBranch(client, connection);
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
        results = await readResults(client, connection, begun.from, now());
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
    let staleBatch = false;
    if (branchId === null) {
      for (const row of begun.rows) moves.push({ orgRefid: row.orgRefid, from: 'sending', to: 'failed', reason: 'BRANCH_UNKNOWN' });
    } else {
      // Rebuilt from the source with the real branch for EVERY batch (never reused from an earlier batch of the run: a voucher changed or removed while an earlier batch was being sent must not go out as it was); a
      // part that is gone, blocked or different from what the person approved is `failed` and never sent.
      let parts: Map<string, AmisPartRow>;
      let matchStale = false;
      let readKey: string | null = null;
      // ASP (#4125): the names of the stocks the lines leave or enter, read fresh below and written beside their ids; null for AMIS and for a batch with no stock line.
      let stockNames: Map<string, string> | null = null;
      let nameStale = false;
      try {
        // The same matches the person's confirmation was made on (the stored result of the last check against the catalogue): a check made since changes the part, and the part is then `STALE`, never sent.
        const matches = await query<MisaAmisMatchResults>('finance.misa_amis_match.results', { legalEntityId: target.legalEntityId, ask });
        const { entries, wanted } = await loadAmisEntries(query, ask, amisContextOf(ask, branchId, matches), MISA_AMIS_PREVIEW_LIMIT + 1);
        parts = new Map(amisPartRows(entries).map((p) => [p.orgRefid, p]));
        // The entries those matches rely on, read again unless a read for the same ones is young enough.
        const verify = relied(matches, wanted);
        if (verify.taxCodes.length > 0 || verify.itemCodes.length > 0 || verify.confirmed.length > 0 || verify.unitNames.length > 0 || verify.stockCodes.length > 0) {
          const key = JSON.stringify(verify);
          if (unreadable === key) throw new TooLarge();
          readKey = key;
          if (reread === null || reread.key !== key || now().getTime() - reread.at > CATALOGUE_REREAD_MS) {
            reread = { key, at: now().getTime(), results: await matchCatalogue(client, connection, verify) };
          }
          matchStale = staleMatches(matches, reread.results);
        }
        if (target.product === 'asp' && !matchStale && [...parts.values()].some((p) => stockIdsOf(p.voucher).length > 0)) stockNames = await readStockNames(client, connection);
      } catch (error) {
        if (error instanceof AmisError && (error.kind === 'credentials' || error.kind === 'token')) {
          // MISA refused the connection before the catalogue could be read: nothing was sent, the rows go back to the queue with the code on screen.
          await record(
            begun.rows.map((row) => ({ orgRefid: row.orgRefid, from: 'sending' as const, to: 'queued' as const, reason: 'CREDENTIALS' })),
            { key: begun.callKey, end: { state: 'failed', kind: 'permission', code: 'CREDENTIALS' } },
          );
          return { state: 'credentials', waiting: false };
        }
        // The catalogue is too large to read whole or answered something that is not a page: a retry would fail the same way, so the batch is `failed` with a fixed reason and a person looks (nothing was sent).
        if (error instanceof TooLarge || (error instanceof AmisError && error.kind === 'invalid_response')) {
          console.warn(`[misa-amis] push ${job.connectionId.slice(0, 8)}: catalogue not read (${error instanceof AmisError ? error.kind : 'too_large'})`);
          unreadable = readKey ?? unreadable;
          await record(
            begun.rows.map((row) => ({ orgRefid: row.orgRefid, from: 'sending' as const, to: 'failed' as const, reason: 'MATCH_UNREAD' })),
            { key: begun.callKey, end: { state: 'failed', kind: 'bad_request', code: 'MATCH_UNREAD' } },
          );
          tally.failed += begun.rows.length;
          if (tally.batches >= MAX_STEPS) {
            waiting = true;
            break;
          }
          continue;
        }
        // The batch could not be built, or the catalogue could not be reached: nothing was sent, so the rows go back to the queue and the run asks to be tried again.
        console.warn(`[misa-amis] push ${job.connectionId.slice(0, 8)}: batch not built (${error instanceof Error ? error.name : 'error'}${error instanceof AmisError ? `, ${error.kind}` : ''})`);
        await record(
          begun.rows.map((row) => ({ orgRefid: row.orgRefid, from: 'sending' as const, to: 'queued' as const, reason: 'BUILD_FAILED' })),
          { key: begun.callKey, end: { state: 'failed', kind: 'transient', code: 'BUILD_FAILED' } },
        );
        return { state: 'unreachable', waiting: true };
      }
      for (const row of begun.rows) {
        const part = parts.get(row.orgRefid);
        if (!part || part.digest !== row.digest || part.voucherType !== begun.voucherType || !isOrgRefId(part.orgRefid)) moves.push({ orgRefid: row.orgRefid, from: 'sending', to: 'failed', reason: 'STALE' });
        // A match the batch relies on changed in MISA since the check: nothing is sent (the rows whose own part changed say STALE above, the rest MATCH_STALE).
        else if (matchStale) moves.push({ orgRefid: row.orgRefid, from: 'sending', to: 'failed', reason: 'MATCH_STALE' });
        else {
          const named = stockNames === null ? part : withStockNames(part, stockNames);
          // A stock the catalogue no longer has (or has inactive) cannot be named: the part is stale, never sent without its name.
          if (named === null) {
            nameStale = true;
            moves.push({ orgRefid: row.orgRefid, from: 'sending', to: 'failed', reason: 'MATCH_STALE' });
          }
          else ready.push(named);
        }
      }
      staleBatch = matchStale || nameStale;
    }
    let end: CallEnd;
    if (ready.length === 0) {
      end = { state: 'failed', kind: 'bad_request', code: branchId === null ? 'BRANCH_UNKNOWN' : staleBatch ? 'MATCH_STALE' : 'STALE' };
    } else {
      const sentRows = ready.map((p) => p.orgRefid);
      try {
        await client.save(connection, ready.map((p) => p.voucher));
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
// While rows wait for MISA's answer the job comes back every two minutes for the day MISA is asked about; for an unreachable AMIS with queued rows it tries ten more times in a row (the count starts again after a
// run that reached AMIS, so an unreachable answer late in a long waiting chain is not the end of it); and a run that came from a press (round 0) always asks once more a minute later (the rows it queued are in the
// table either way). A press has a job of its own, never dropped for another press's or chain's job (pushPressKeyTail), so the rows of a press are always looked at by a run that began after they were committed.
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

// A chain that stops while rows may still wait says so in one line (ids and a code only, never a name, an amount or MISA's text): without it a chain that gave up leaves no trace until a person looks at the
// screen (#4041). Null when the chain goes on, or when nothing waits.
export function pushGiveUp(job: MisaAmisPushJob, outcome: MisaAmisPushOutcome): string | null {
  if (pushFollowUp(job, outcome) !== null) return null;
  const round = job.round ?? 0;
  const head = `[misa-amis] push ${job.connectionId.slice(0, 8)} (org ${job.orgId.slice(0, 8)}): chain stopped at round ${round}`;
  if (outcome.state === 'done') return outcome.waiting ? `${head}, rows still wait for MISA's answer` : null;
  if (outcome.state === 'unreachable') return `${head}, AMIS unreachable, queued rows stay queued`;
  if (outcome.state === 'credentials') return `${head}, access code not usable, queued rows stay queued`;
  return `${head}, connection left alone (${outcome.reason}), rows are not followed up`;
}

export function pushFollowUp(job: MisaAmisPushJob, outcome: MisaAmisPushOutcome): PushFollowUp | null {
  const round = job.round ?? 0;
  const next = (startAfterSeconds: number, unreachable = 0): PushFollowUp => ({
    data: { orgId: job.orgId, connectionId: job.connectionId, round: round + 1, ...(unreachable > 0 ? { unreachable } : {}) },
    keyTail: `${job.connectionId}:r${round + 1}`,
    startAfterSeconds,
  });
  if (outcome.state === 'done') {
    if (outcome.waiting && round < PUSH_WAIT_ROUNDS) return next(PUSH_RECHECK_SECONDS);
    return round === 0 ? next(PUSH_PRESS_RECHECK_SECONDS) : null;
  }
  if (outcome.state === 'unreachable') {
    // The count is of runs in a row that found AMIS unreachable, this one included; the whole chain is still bounded by the day of waiting rounds.
    const inARow = (job.unreachable ?? 0) + 1;
    return inARow <= PUSH_UNREACHABLE_ROUNDS && round < PUSH_WAIT_ROUNDS ? next(PUSH_RECHECK_SECONDS, inARow) : null;
  }
  return null;
}

// The singleton key's tail of the job a press queues: the connection and the press (the outbox event that confirmed the push). The queue is exclusive on the key, so a key shared by every press of a connection
// let a press's job be dropped while another press's job was active, and the rows of that press then waited for a follow-up that a chain's own job could also drop (#4041, N1). Distinct from a follow-up's tail
// (`<connection>:r<round>`); the same event queued twice (the relay is at least once) is one job.
export const pushPressKeyTail = (connectionId: string, eventId: string): string => `${connectionId}:p${eventId}`;

// SPDX-License-Identifier: AGPL-3.0-only
// Telegram's webhook of customers' private-chat messages (conversation core, issue #3132, plan docs/plan/conversations-channels.md section 4.2,
// design decision of that section). One public route for every bot of the deployment: `POST /api/channels/telegram/webhook/<hook>`, where <hook>
// is the opaque id a connection holds (it names a connection's hook, never an org). The route checks `X-Telegram-Bot-Api-Secret-Token` against the
// secret derived from that hook under the deployment's key, in constant time, before it reads the body or asks the database; a missing header, a
// hook of the wrong shape, an unknown hook and a wrong secret are refused with the same answer. A verified update that carries a customer's message
// is parked in crove_kernel.conversation_inbound_pending for the worker, which finds the org from the stored connection by the hook; the notice
// names no org, and neither does the path or any answer (ADR-0039). A body is personal data of a third party, so the route logs nothing of it and
// the table deletes it the moment it is stored. A verified update with no customer message in it (an edit, a group) is answered 200 and not parked,
// so Telegram stops sending it and the queue holds messages only.
import { sql } from 'kysely';
import { TELEGRAM_HOOK_PATTERN, telegramBusinessState, telegramChatEvents, telegramHookSecretOk, wrapTelegramChatNotice } from '@crove/channel';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

export const TELEGRAM_WEBHOOK_PATH = '/api/channels/telegram/webhook/:hook';
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
// The provider name the update is parked under: the worker's parser and its hook lookup are keyed by it, and the backlog cap is its own.
export const TELEGRAM_INTAKE_PROVIDER = 'telegram_chat';

export interface TelegramWebhookConfig {
  // The keys the hook secret is derived from, the current one first (the broker's `deriveKeys`): one under a rotation that keeps the old key.
  // A function so the route reads them when a request comes in.
  keys: () => readonly Buffer[];
  // The clock the age of a message is read against; the real one when absent.
  now?: (() => number) | undefined;
}

// Messages seen lately, by the hook and the message's own id, so a delivery Telegram repeats is answered without being parked again. Telegram
// holds an undelivered update for up to 24 hours [M], so the window is two days. It is a per-process guard against a queue flooded with one body;
// the guarantee that a replay stores nothing twice is the unique platform message id of the thread's messages. A message is remembered only once
// it is parked, so one refused for backlog is accepted when Telegram sends it again.
export const TELEGRAM_REPLAY_WINDOW_MS = 48 * 3_600_000;
const TELEGRAM_REPLAY_MAX = 10_000;
export class TelegramReplayCache {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  has(key: string): boolean {
    const until = this.seen.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }
  add(key: string): void {
    this.seen.delete(key);
    this.seen.set(key, this.now() + TELEGRAM_REPLAY_WINDOW_MS);
    // Insertion order is age order: the oldest go first when the cache is full.
    while (this.seen.size > TELEGRAM_REPLAY_MAX) this.seen.delete(this.seen.keys().next().value as string);
  }
}

// A message older than this is answered and not parked: Telegram holds an update 24 hours at most [M], so an older one is a captured body
// replayed, and the unique message id alone must not be what keeps a purged or erased thread from coming back (CV6).
export const TELEGRAM_NOTICE_MAX_AGE_MS = 48 * 3_600_000;

// The one answer to every request whose secret does not check out.
export const TELEGRAM_UNAUTHORIZED = { status: 401, code: 'WEBHOOK_SIGNATURE' } as const;

export type TelegramWebhookOutcome =
  | { status: 200; parked: boolean }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' }
  | { status: 503; code: 'BACKLOG' };

// The check that needs neither the body nor the database. Every refusal is the same `false`, and the route's answer to it the same 401.
export function telegramWebhookAuthorized(config: Pick<TelegramWebhookConfig, 'keys'>, request: { hook: string; secret: string | undefined }): boolean {
  return TELEGRAM_HOOK_PATTERN.test(request.hook) && telegramHookSecretOk({ hook: request.hook, header: request.secret, keys: config.keys() });
}

export async function acceptTelegramWebhook(
  runtime: Runtime,
  config: TelegramWebhookConfig,
  request: { hook: string; secret: string | undefined; body: () => Promise<Uint8Array> },
  replays?: TelegramReplayCache,
): Promise<TelegramWebhookOutcome> {
  // Before the body is read, before any database call.
  if (!telegramWebhookAuthorized(config, request)) return TELEGRAM_UNAUTHORIZED;
  const body = await request.body();
  let update: unknown;
  try {
    update = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return { status: 400, code: 'WEBHOOK_MALFORMED' };
  }
  if (typeof update !== 'object' || update === null || Array.isArray(update) || !Number.isSafeInteger((update as { update_id?: unknown }).update_id)) {
    return { status: 400, code: 'WEBHOOK_MALFORMED' };
  }
  const now = (config.now ?? Date.now)();
  // Only the messages of the customer not yet seen and not too old are worth a place in the queue.
  const keys: string[] = [];
  for (const event of telegramChatEvents(update)) {
    // A removal carries no date of its own (it is dated at the earliest instant an event may have, so an erased customer is not brought back by it), and an
    // edit carries the message's first date, not the edit's: the age of a message does not apply to either. The message id names its chat, so the key is the
    // hook and the id.
    if (!event.removed && !event.edited && now - Date.parse(event.at) > TELEGRAM_NOTICE_MAX_AGE_MS) continue;
    // An edit repeats a message id on purpose (each edit is its own update), so it is told apart by the update's id.
    const key = event.edited ? `${request.hook}:update:${(update as { update_id: number }).update_id}` : `${request.hook}:${event.removed ? 'removed:' : ''}${event.messageId}`;
    if (!replays?.has(key)) keys.push(key);
  }
  // A `business_connection` update (a business account connected the bot, edited it or took it away, #3191) carries no message but is state the worker
  // records: it is parked once per update id, so a redelivery is answered without being parked again.
  const stateKey = telegramBusinessState(update) !== null ? `${request.hook}:update:${(update as { update_id: number }).update_id}` : null;
  if (stateKey !== null && !replays?.has(stateKey)) keys.push(stateKey);
  if (keys.length === 0) return { status: 200, parked: false };
  try {
    await runtime.orgless(async (db) => {
      await sql`SELECT crove_kernel.conversation_inbound_enqueue(${TELEGRAM_INTAKE_PROVIDER}, ${wrapTelegramChatNotice(request.hook, body)}::bytea)`.execute(db);
    });
  } catch (error) {
    // The definer refuses past 10000 waiting notices (53400), which the runtime maps to OVERLOADED. Telegram retries a delivery that was not
    // answered 2xx [M], so this one is asked for again.
    if (error instanceof DomainError && error.code === 'OVERLOADED') return { status: 503, code: 'BACKLOG' };
    throw error;
  }
  for (const key of keys) replays?.add(key);
  return { status: 200, parked: true };
}

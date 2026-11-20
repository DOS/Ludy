// SPDX-License-Identifier: AGPL-3.0-only
// Managing a running ad (ads W4, issue #3835, ADR-0043 points 1, 2 and 5, plan docs/plan/ads-write.md sections 3.1, 3.3, 3.4 and 3.6). A person pauses, resumes or archives the
// campaign, the ad set or an ad of a live launch, lowers or raises its daily budget, shortens or extends its schedule (the budget and the end date are the ad set's).
//
// THE SPLIT (3.1). What can start or raise spend, a resume, a raise and an extension, is an R3 `financial` proposal command approved like a launch: an owner or an admin asks
// through a preparer (R1), an owner or an admin approves (four-eyes with the one-person path, a second factor, the amounts named on the card), and the command the approval
// runs re-checks everything and writes the change. What only reduces or stops spend, a pause, an archive, a lower budget and a shorter schedule, is an owner's or an admin's own
// R2 `external` command, with no approval and always audited. A launch that has stopped never resumes (ADR-0043 point 7a): its objects are paused by the wind-down, and a new
// plan is a new draft and a new approval.
//
// THE CAPS (3.3). A change that raises what a launch can spend is judged against every cap and every OTHER launch at the request (an early warning), at the approval (under the
// org's lock) and again by the begin step before the platform is called (under the lock, authoritative). The commitment is written with the change, in the approving transaction,
// before any platform call (crove_ads.launch_hold: a queued or unclear raise is held; a lower budget or a shorter schedule releases nothing until the platform confirms it), so
// two raises approved together serialise on the lock and the second sees the first.
//
// EXACTLY ONCE (3.4). The platform is called by the job (apps/kernel/src/ads-manage.ts) between two system commands: `ads.manage.begin` re-checks the stop conditions and the caps
// and inserts the change's row in the kernel's `external_call` ledger (`ads.manage:<change>:apply`) as started BEFORE the call, and `ads.manage.record` settles it. A row begin
// finds again is never called a second time blind: it is reconciled by reading the object, which says whether the change landed.
//
// THE STOPS STILL WIN. Writing off refuses every command but a pause; launches blocked refuses what can start or raise spend; a queued change of a launch that is no longer live
// is cancelled by begin, never made. The database's guard (crove_ads.manage_change_guard) holds all of this whatever path writes.
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { MemberRole } from '@crove/db';
import {
  ADS_BUDGET_RAISE_COMMAND,
  ADS_BUDGET_RAISE_KIND,
  ADS_OBJECT_RESUME_COMMAND,
  ADS_OBJECT_RESUME_KIND,
  ADS_SCHEDULE_EXTEND_COMMAND,
  ADS_SCHEDULE_EXTEND_KIND,
  zAdsBudget,
  zAdsBudgetRaisePayload,
  zAdsManageSlot,
  zAdsObjectResumePayload,
  zAdsScheduleExtendPayload,
  zAdsScheduleShortenCall,
  zId,
  type AdsManageKind,
  type AdsManageSlot,
  type AdsManageStateView,
  type AdsManageSuggestion,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { contextBase } from './campaign-draft.ts';
import { todayIn } from './domain.ts';
import { committedLaunches, lockedLaunch, ownCommitments } from './launch-ledger.ts';
import { committedProblems } from './launch-caps.ts';
import { launchAccountOf, launchSelect, requireSystem, type Db } from './launch-run.ts';
import { STARTED_STALE_SECONDS, UNCLEAR_GIVE_UP_SECONDS, UNCLEAR_MAX_CALLS, dayAfter, stepAction, zoneKnown, zonedMidnight } from './launch-steps.ts';
import {
  OPENING_KINDS,
  SETTLE_MIN_AGE_SECONDS,
  budgetProblem,
  ownAround,
  unclearOpen,
  BUDGET_KINDS,
  SCHEDULE_KINDS,
  judgedFrom,
  heldValues,
  largestAmount,
  manageCallKey,
  manageStep,
  objectStatusOf,
  scheduleProblem,
  settleCandidate,
  statusProblem,
  stopConditions,
  stopsChange,
  suggestionFor,
} from './manage-rules.ts';
import { changesOf, manageStateOf, objectsOf, type ChangeRecord } from './manage-state.ts';
import { loadFlags } from './spend-flags.ts';
import { lockedSetting, refuseOpenRequest } from './write.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const onlyApproved = () => new DomainError('ADS_ONLY_APPROVED', 403, 'Chỉ chạy được qua một đề xuất đã duyệt');

// ---------------------------------------------------------------------------------------------------------------
// What a change is made against
// ---------------------------------------------------------------------------------------------------------------

// Everything a command of W4 reads, with the org's lock and the launch's row held: the launch, its account and write connection, the switches, the recorded objects and the
// changes asked so far.
async function controlOf(ctx: Db & Pick<CommandContext, 'now'>, launchIdRaw: string) {
  const setting = await lockedSetting(ctx);
  const seen = await lockedLaunch(ctx, launchIdRaw.toLowerCase());
  const found = await launchAccountOf(ctx, seen.ad_account_id);
  if (!found) throw new DomainError('ADS_LAUNCH_NOT_FOUND', 404, 'Không tìm thấy lần chạy quảng cáo này');
  const launch = await launchSelect(ctx).where('id', '=', seen.id).forUpdate().executeTakeFirstOrThrow();
  const objects = await objectsOf(ctx, launch.id);
  const changes = await changesOf(ctx, launch.id);
  const held = heldValues({ dailyBudget: launch.daily_budget, endOn: launch.end_text }, changes);
  const named = await ctx.trx.selectFrom('crove_ads.ad_account').select('name').where('org_id', '=', ctx.orgId).where('id', '=', launch.ad_account_id).executeTakeFirst();
  return { setting, launch, account: found.account, connection: found.connection, accountName: named?.name ?? '', objects, changes, held };
}
type Control = Awaited<ReturnType<typeof controlOf>>;

const refuse = (code: string, status: 403 | 404 | 409 | 422, message: string, details?: Record<string, unknown>) => new DomainError(code, status, message, details);

// The object of a slot, as the launch recorded it.
function objectOf(control: Control, slot: AdsManageSlot) {
  const object = control.objects.find((o) => o.slot === slot);
  if (!object) throw refuse('ADS_OBJECT_NOT_FOUND', 404, 'Lần chạy này không có đối tượng đó');
  return object;
}

// The gates every command meets (the database's guard holds the same): the launch is live (a pause also while it needs attention), running ads is on for the org and the account
// and its write connection is open (a pause needs none of these: stopping spend is always allowed), and what can start or raise spend also needs launches not blocked.
function gate(control: Control, kind: AdsManageKind): void {
  const { launch, setting, account, connection } = control;
  const live = launch.state === 'live' || (kind === 'pause' && launch.state === 'needs_attention');
  if (!live) throw refuse('ADS_MANAGE_NOT_LIVE', 409, 'Chỉ thay đổi được quảng cáo của lần chạy đang chạy; lần chạy đã dừng thì cần kế hoạch và lần duyệt mới');
  if (kind !== 'pause') {
    const stops = stopConditions(setting, account, connection);
    if (stops.some((s) => s === 'switch_off' || s === 'account_off' || s === 'connection_closed')) {
      throw refuse('ADS_WRITE_OFF', 409, 'Việc chạy quảng cáo đang tắt hoặc kết nối ghi đã đóng; chỉ còn tạm dừng được');
    }
    if (OPENING_KINDS.includes(kind) && stops.includes('launches_blocked')) throw refuse('ADS_LAUNCHES_BLOCKED', 409, 'Chạy quảng cáo đang bị chặn; chỉ chủ sở hữu mở lại được');
    // What can start or raise spend is refused for an ad set or a campaign that was archived: it no longer delivers, and a raise would only hold cap room for nothing.
    if (OPENING_KINDS.includes(kind) && (['campaign', 'ad_set'] as const).some((slot) => objectStatusOf(slot, control.changes).status === 'archived')) {
      throw refuse('ADS_OBJECT_STATE', 409, 'Chiến dịch hoặc nhóm quảng cáo đã được lưu trữ nên không bật lại hay tăng chi tiêu được', { problem: 'archived' });
    }
  }
}

const openFamily = (control: Control, family: 'budget' | 'schedule' | AdsManageSlot): boolean =>
  control.changes.some((c) => c.state === 'queued' && (family === 'budget' ? c.kind.startsWith('budget_') : family === 'schedule' ? c.kind.startsWith('schedule_') : !c.kind.startsWith('budget_') && !c.kind.startsWith('schedule_') && c.slot === family));
const unclearBlocks = () => refuse('ADS_CHANGE_UNCLEAR', 409, 'Có một thay đổi cùng loại chưa xác nhận được với nền tảng; chưa giảm hay rút ngắn tiếp được cho đến khi nó được xác nhận');
const changeOpen = () => refuse('ADS_CHANGE_OPEN', 409, 'Đã có một thay đổi cùng loại đang chờ nền tảng xác nhận; hãy đợi xong rồi thử tiếp');

function requireZone(control: Control): string {
  if (!zoneKnown(control.account.time_zone)) throw refuse('ADS_ZONE_UNKNOWN', 409, 'Chưa biết múi giờ của tài khoản quảng cáo; hãy đồng bộ tài khoản trước');
  return control.account.time_zone as string;
}

// The caps for what the launch would hold with this change (its held budget and end date), against every cap and every OTHER launch, from the launch's first day (the commitment
// holds the budget on every day of the window, so this is the very sum the caps will be read with afterwards). Returns the problems; none when it fits.
export async function manageCapsProblems(ctx: Db & Pick<CommandContext, 'now'>, control: Pick<Control, 'launch' | 'account'>, budget: string, endOn: string) {
  const { launch, account } = control;
  const base = await contextBase(ctx, account.id);
  // Judged from the day before today in the account's zone: a raise approved now may already be running (a zone ahead of this one is on tomorrow). What the launch has committed
  // before that day stays as it is (a lower budget confirmed today does not release today, a raise that is unclear still counts for every day it may have run); the plan replaces
  // everything from that day on.
  const from = judgedFrom(todayIn(zoneKnown(account.time_zone) ? (account.time_zone as string) : 'UTC', ctx.now), launch.start_text);
  const window = endOn > from ? endOn : from;
  const others = await committedLaunches(ctx, launch.currency, launch.start_text, window, launch.id);
  const history = ownAround(await ownCommitments(ctx, launch.id, launch.currency, launch.start_text, window), from, window, budget);
  return committedProblems({ adAccountId: launch.ad_account_id, currency: launch.currency, dailyBudget: budget, startOn: from, endOn: window }, [...others, ...history], base.caps);
}

// A change that can raise spend is judged only against caps in the launch's own currency (nothing is converted), and needs one: a cap that was set in another currency since the
// launch leaves no cap that applies, which must never read as "within the cap" (plan 3.3, ADS_CAP_CURRENCY).
export async function capCurrencyProblem(ctx: Db, control: Pick<Control, 'launch' | 'account'>): Promise<'cap_currency' | 'no_cap' | null> {
  const caps = (await contextBase(ctx, control.account.id)).caps;
  if (caps.some((c) => c.currency !== control.launch.currency)) return 'cap_currency';
  return caps.length === 0 ? 'no_cap' : null;
}

async function refuseOverCaps(ctx: Db & Pick<CommandContext, 'now'>, control: Control, budget: string, endOn: string): Promise<void> {
  const currency = await capCurrencyProblem(ctx, control);
  if (currency === 'cap_currency') throw refuse('ADS_CAP_CURRENCY', 409, 'Hạn mức đang áp dụng không cùng đơn vị tiền với tài khoản quảng cáo nên chưa kiểm tra được; hãy đặt lại hạn mức cùng đơn vị tiền');
  if (currency === 'no_cap') throw refuse('ADS_SPEND_CAP_NOT_SET', 409, 'Chưa đặt hạn mức chi tiêu nên chưa tăng được chi tiêu');
  const problems = await manageCapsProblems(ctx, control, budget, endOn);
  if (problems.length === 0) return;
  const first = problems[0] as (typeof problems)[number];
  throw refuse(
    'ADS_SPEND_CAP',
    409,
    `Thay đổi này cùng với các chiến dịch khác sẽ vượt hạn mức ${first.period === 'daily' ? 'theo ngày' : 'theo tháng'} ${first.scope === 'org' ? 'của tổ chức' : 'của tài khoản'} (${first.day ? `ngày ${first.day}` : `tháng ${first.month}`}): hạn mức ${first.cap}, đã giữ chỗ ${first.committed}, thêm ${first.plan} ${control.launch.currency}`,
    { problems },
  );
}

interface NewChange {
  slot: AdsManageSlot;
  kind: AdsManageKind;
  fromBudget?: string;
  toBudget?: string;
  fromEndOn?: string;
  toEndOn?: string;
  proposalId?: string;
}

// Writes the change (the database's guard holds who may, with which switches, which values and which approval) and returns its id. The caller writes the event that queues the job,
// as a literal in its own command.
async function insertChange(ctx: Db & Pick<CommandContext, 'actor'>, control: Control, change: NewChange): Promise<string> {
  if (ctx.actor.type !== 'user') throw refuse('FORBIDDEN', 403, 'Chỉ người dùng mới thay đổi được quảng cáo đang chạy');
  const object = objectOf(control, change.slot);
  const row = await ctx.trx
    .insertInto('crove_ads.ad_manage_change')
    .values({
      org_id: ctx.orgId,
      ad_account_id: control.launch.ad_account_id,
      legal_entity_id: control.launch.legal_entity_id,
      launch_id: control.launch.id,
      kind: change.kind,
      slot: change.slot,
      level: object.level,
      object_id: object.externalId,
      from_budget: change.fromBudget ?? null,
      to_budget: change.toBudget ?? null,
      from_end_on: change.fromEndOn ?? null,
      to_end_on: change.toEndOn ?? null,
      requested_by: ctx.actor.userId,
      ...(change.proposalId ? { proposal_id: change.proposalId } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const targetOf = (input: { launchId: string }) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() });
export interface AdsManageChangedResult {
  changeId: string;
  launchId: string;
  kind: AdsManageKind;
  state: 'queued';
}

// ---------------------------------------------------------------------------------------------------------------
// The R2 commands: what only reduces or stops spend (an owner's or an admin's own, no approval)
// ---------------------------------------------------------------------------------------------------------------

const zObjectInput = z.strictObject({ launchId: zId, slot: zAdsManageSlot });

export const adsObjectPause = defineCommand({
  name: 'ads.object.pause',
  input: zObjectInput,
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: targetOf,
  handler: async (ctx, input): Promise<AdsManageChangedResult> => {
    const control = await controlOf(ctx, input.launchId);
    gate(control, 'pause');
    objectOf(control, input.slot);
    if (openFamily(control, input.slot)) throw changeOpen();
    const problem = statusProblem('pause', objectStatusOf(input.slot, control.changes));
    if (problem) throw refuse('ADS_OBJECT_STATE', 409, problem === 'archived' ? 'Đối tượng này đã được lưu trữ' : 'Đối tượng này đã tạm dừng', { problem });
    const changeId = await insertChange(ctx, control, { slot: input.slot, kind: 'pause' });
    await ctx.emit('ads.manage.queued', { changeId, launchId: control.launch.id, adAccountId: control.launch.ad_account_id });
    ctx.audit({ changeId: changeId, launchId: control.launch.id, adAccountId: control.launch.ad_account_id, kind: 'pause', slot: input.slot, currency: control.launch.currency });
    return { changeId, launchId: control.launch.id, kind: 'pause', state: 'queued' };
  },
});

export const adsObjectArchive = defineCommand({
  name: 'ads.object.archive',
  input: zObjectInput,
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: targetOf,
  handler: async (ctx, input): Promise<AdsManageChangedResult> => {
    const control = await controlOf(ctx, input.launchId);
    gate(control, 'archive');
    objectOf(control, input.slot);
    if (openFamily(control, input.slot)) throw changeOpen();
    const problem = statusProblem('archive', objectStatusOf(input.slot, control.changes));
    if (problem) throw refuse('ADS_OBJECT_STATE', 409, 'Đối tượng này đã được lưu trữ', { problem });
    const changeId = await insertChange(ctx, control, { slot: input.slot, kind: 'archive' });
    await ctx.emit('ads.manage.queued', { changeId, launchId: control.launch.id, adAccountId: control.launch.ad_account_id });
    ctx.audit({ changeId: changeId, launchId: control.launch.id, adAccountId: control.launch.ad_account_id, kind: 'archive', slot: input.slot, currency: control.launch.currency });
    return { changeId, launchId: control.launch.id, kind: 'archive', state: 'queued' };
  },
});

export const adsBudgetLower = defineCommand({
  name: 'ads.budget.lower',
  input: z.strictObject({ launchId: zId, dailyBudget: zAdsBudget }),
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: targetOf,
  handler: async (ctx, input): Promise<AdsManageChangedResult> => {
    const control = await controlOf(ctx, input.launchId);
    gate(control, 'budget_lower');
    if (openFamily(control, 'budget')) throw changeOpen();
    if (unclearOpen(control.changes, BUDGET_KINDS)) throw unclearBlocks();
    const problem = budgetProblem('budget_lower', control.held.dailyBudget, input.dailyBudget, control.launch.currency);
    if (problem) throw refuse('ADS_BUDGET_INVALID', 422, problem === 'not_lower' ? 'Ngân sách mới phải thấp hơn ngân sách đang giữ chỗ; muốn tăng thì cần đề xuất được duyệt' : 'Ngân sách mới không hợp lệ', { problem });
    const toBudget = new Decimal(input.dailyBudget).toFixed();
    const changeId = await insertChange(ctx, control, { slot: 'ad_set', kind: 'budget_lower', fromBudget: control.held.dailyBudget, toBudget });
    await ctx.emit('ads.manage.queued', { changeId, launchId: control.launch.id, adAccountId: control.launch.ad_account_id });
    ctx.audit({ changeId: changeId, launchId: control.launch.id, adAccountId: control.launch.ad_account_id, kind: 'budget_lower', slot: 'ad_set', currency: control.launch.currency, fromBudget: control.held.dailyBudget, toBudget });
    return { changeId, launchId: control.launch.id, kind: 'budget_lower', state: 'queued' };
  },
});

export const adsScheduleShorten = defineCommand({
  name: 'ads.schedule.shorten',
  input: z.strictObject({ launchId: zId, endOn: zAdsScheduleShortenCall.shape.endOn }),
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: targetOf,
  handler: async (ctx, input): Promise<AdsManageChangedResult> => {
    const control = await controlOf(ctx, input.launchId);
    gate(control, 'schedule_shorten');
    if (openFamily(control, 'schedule')) throw changeOpen();
    if (unclearOpen(control.changes, SCHEDULE_KINDS)) throw unclearBlocks();
    const zone = requireZone(control);
    const problem = scheduleProblem('schedule_shorten', { startOn: control.launch.start_text, heldEndOn: control.held.endOn, endOn: input.endOn, today: todayIn(zone, ctx.now) });
    if (problem) throw refuse('ADS_SCHEDULE_INVALID', 422, problem === 'not_earlier' ? 'Ngày kết thúc mới phải sớm hơn ngày đang giữ chỗ; muốn kéo dài thì cần đề xuất được duyệt' : 'Ngày kết thúc mới không hợp lệ', { problem });
    const changeId = await insertChange(ctx, control, { slot: 'ad_set', kind: 'schedule_shorten', fromEndOn: control.held.endOn, toEndOn: input.endOn });
    await ctx.emit('ads.manage.queued', { changeId, launchId: control.launch.id, adAccountId: control.launch.ad_account_id });
    ctx.audit({ changeId: changeId, launchId: control.launch.id, adAccountId: control.launch.ad_account_id, kind: 'schedule_shorten', slot: 'ad_set', currency: control.launch.currency, fromEndOn: control.held.endOn, toEndOn: input.endOn });
    return { changeId, launchId: control.launch.id, kind: 'schedule_shorten', state: 'queued' };
  },
});

// Cancels a change the job has not begun: a raise that waits for a platform that cannot be reached, say, no longer holds its amount against the caps. One the job has begun may
// have landed, so it is the job's to settle (the database refuses it).
export const adsManageCancel = defineCommand({
  name: 'ads.manage.cancel',
  input: z.strictObject({ changeId: zId }),
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ changeId: string; cancelled: true }> => {
    await lockedSetting(ctx);
    const row = await ctx.trx.selectFrom('crove_ads.ad_manage_change').select(['id', 'launch_id', 'kind', 'slot', 'state']).where('org_id', '=', ctx.orgId).where('id', '=', input.changeId.toLowerCase()).forUpdate().executeTakeFirst();
    if (!row) throw refuse('ADS_CHANGE_NOT_FOUND', 404, 'Không tìm thấy thay đổi này');
    if (row.state !== 'queued') throw refuse('ADS_CHANGE_SETTLED', 409, 'Thay đổi này đã được xử lý xong');
    const begun = await ctx.trx.selectFrom('crove_kernel.external_call').select('id').where('org_id', '=', ctx.orgId).where('key', '=', manageCallKey(row.id)).executeTakeFirst();
    if (begun) throw refuse('ADS_CHANGE_BEGUN', 409, 'Thay đổi này đã được gửi đến nền tảng nên không hủy được nữa');
    await ctx.trx.updateTable('crove_ads.ad_manage_change').set({ state: 'cancelled', code: 'cancelled' }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    ctx.audit({ changeId: row.id, launchId: row.launch_id, kind: row.kind, slot: row.slot, cancelled: true });
    return { changeId: row.id, cancelled: true };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// The R3 commands: what can start or raise spend. A preparer builds the request (R1, writes nothing); the command an approval runs re-checks and writes the change.
// ---------------------------------------------------------------------------------------------------------------

// What the card shows of the launch: its campaign's name, its account, and the largest amount it can spend before the change.
function cardBase(control: Control, slot: AdsManageSlot) {
  const campaign = control.objects.find((o) => o.slot === 'campaign');
  return {
    launchId: control.launch.id,
    adAccountId: control.launch.ad_account_id,
    adAccountName: control.accountName.slice(0, 200),
    campaignName: (campaign?.name ?? '').slice(0, 200),
    slot,
    currency: control.launch.currency,
    startOn: control.launch.start_text,
    previousAmount: largestAmount(control.held.dailyBudget, control.launch.start_text, control.held.endOn),
  };
}

export const adsObjectPrepareResume = defineCommand({
  name: 'ads.object.prepare_resume',
  input: zObjectInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: targetOf,
  handler: async (ctx, input) => {
    const control = await controlOf(ctx, input.launchId);
    await refuseOpenRequest(ctx, ADS_OBJECT_RESUME_COMMAND, { launchId: control.launch.id, slot: input.slot });
    gate(control, 'resume');
    const object = objectOf(control, input.slot);
    if (openFamily(control, input.slot)) throw changeOpen();
    const problem = statusProblem('resume', objectStatusOf(input.slot, control.changes));
    if (problem) throw refuse('ADS_OBJECT_STATE', 409, problem === 'archived' ? 'Đối tượng đã lưu trữ thì không bật lại được' : 'Chỉ bật lại được đối tượng đang tạm dừng', { problem });
    const zone = requireZone(control);
    if (control.held.endOn < todayIn(zone, ctx.now)) throw refuse('ADS_FLIGHT_OVER', 409, 'Lịch chạy đã kết thúc nên không bật lại được');
    await refuseOverCaps(ctx, control, control.held.dailyBudget, control.held.endOn);
    const base = cardBase(control, input.slot);
    return {
      kind: ADS_OBJECT_RESUME_KIND,
      command: ADS_OBJECT_RESUME_COMMAND,
      title: `Bật lại ${object.name}: tối đa ${base.previousAmount} ${base.currency}`.slice(0, 300),
      payload: zAdsObjectResumePayload.parse({ ...base, objectName: object.name.slice(0, 400), dailyBudget: control.held.dailyBudget, endOn: control.held.endOn, amount: base.previousAmount }),
      legalEntityId: control.launch.legal_entity_id,
    };
  },
});

export const adsBudgetPrepareRaise = defineCommand({
  name: 'ads.budget.prepare_raise',
  input: z.strictObject({ launchId: zId, dailyBudget: zAdsBudget }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: targetOf,
  handler: async (ctx, input) => {
    const control = await controlOf(ctx, input.launchId);
    await refuseOpenRequest(ctx, ADS_BUDGET_RAISE_COMMAND, { launchId: control.launch.id });
    gate(control, 'budget_raise');
    if (openFamily(control, 'budget')) throw changeOpen();
    const problem = budgetProblem('budget_raise', control.held.dailyBudget, input.dailyBudget, control.launch.currency);
    if (problem) throw refuse('ADS_BUDGET_INVALID', 422, problem === 'not_higher' ? 'Ngân sách mới phải cao hơn ngân sách đang giữ chỗ; muốn giảm thì dùng Giảm ngân sách' : 'Ngân sách mới không hợp lệ', { problem });
    const zone = requireZone(control);
    if (control.held.endOn < todayIn(zone, ctx.now)) throw refuse('ADS_FLIGHT_OVER', 409, 'Lịch chạy đã kết thúc nên không tăng ngân sách được');
    const toBudget = new Decimal(input.dailyBudget).toFixed();
    await refuseOverCaps(ctx, control, toBudget, control.held.endOn);
    const base = cardBase(control, 'ad_set');
    return {
      kind: ADS_BUDGET_RAISE_KIND,
      command: ADS_BUDGET_RAISE_COMMAND,
      title: `Tăng ngân sách ngày ${control.held.dailyBudget} → ${toBudget} ${base.currency}: tối đa ${largestAmount(toBudget, base.startOn, control.held.endOn)}`.slice(0, 300),
      payload: zAdsBudgetRaisePayload.parse({ ...base, fromBudget: control.held.dailyBudget, toBudget, endOn: control.held.endOn, amount: largestAmount(toBudget, base.startOn, control.held.endOn) }),
      legalEntityId: control.launch.legal_entity_id,
    };
  },
});

export const adsSchedulePrepareExtend = defineCommand({
  name: 'ads.schedule.prepare_extend',
  input: z.strictObject({ launchId: zId, endOn: zAdsScheduleShortenCall.shape.endOn }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: targetOf,
  handler: async (ctx, input) => {
    const control = await controlOf(ctx, input.launchId);
    await refuseOpenRequest(ctx, ADS_SCHEDULE_EXTEND_COMMAND, { launchId: control.launch.id });
    gate(control, 'schedule_extend');
    if (openFamily(control, 'schedule')) throw changeOpen();
    const zone = requireZone(control);
    const problem = scheduleProblem('schedule_extend', { startOn: control.launch.start_text, heldEndOn: control.held.endOn, endOn: input.endOn, today: todayIn(zone, ctx.now) });
    if (problem) throw refuse('ADS_SCHEDULE_INVALID', 422, problem === 'not_later' ? 'Ngày kết thúc mới phải muộn hơn ngày đang giữ chỗ; muốn rút ngắn thì dùng Rút ngắn lịch' : 'Ngày kết thúc mới không hợp lệ', { problem });
    await refuseOverCaps(ctx, control, control.held.dailyBudget, input.endOn);
    const base = cardBase(control, 'ad_set');
    return {
      kind: ADS_SCHEDULE_EXTEND_KIND,
      command: ADS_SCHEDULE_EXTEND_COMMAND,
      title: `Kéo dài lịch đến ${input.endOn}: tối đa ${largestAmount(control.held.dailyBudget, base.startOn, input.endOn)} ${base.currency}`.slice(0, 300),
      payload: zAdsScheduleExtendPayload.parse({ ...base, dailyBudget: control.held.dailyBudget, fromEndOn: control.held.endOn, toEndOn: input.endOn, amount: largestAmount(control.held.dailyBudget, base.startOn, input.endOn) }),
      legalEntityId: control.launch.legal_entity_id,
    };
  },
});

// What an approval of a resume, a raise or an extension runs (access 'proposal': only through kernel.proposal.approve, as the approver, in the approving transaction). The
// request may be old, so everything it was made under is read again: the launch is live, the switches are on, the object is paused (resume), what the launch held when the
// approver was shown is what it holds now, the card's amount is the amount of these values, and the caps hold under the org's lock this transaction holds to its end, which
// also writes the commitment (the change row, held by crove_ads.launch_hold). The database's guard re-judges all of it against the proposal that was approved.
function approvedHandler<K extends 'resume' | 'budget_raise' | 'schedule_extend'>(kind: K) {
  return async (
    ctx: CommandContext,
    payload: { launchId: string; adAccountId: string; slot: AdsManageSlot; currency: string; amount: string; previousAmount: string; startOn: string } & Record<string, string>,
  ) => {
    if (!ctx.proposalId || ctx.actor.type !== 'user') throw onlyApproved();
    const control = await controlOf(ctx, payload.launchId);
    const stale = () => refuse('ADS_CHANGE_STALE', 409, 'Quảng cáo đã thay đổi từ lúc đề xuất này được tạo; hãy tạo đề xuất mới');
    gate(control, kind);
    if (payload.adAccountId.toLowerCase() !== control.launch.ad_account_id || payload.currency !== control.launch.currency || payload.startOn !== control.launch.start_text) throw stale();
    // The proposal belongs to the legal entity the account was in when it was asked for (#1538): an account moved since is another approval's business.
    const proposal = await ctx.trx.selectFrom('crove_kernel.proposal').select('legal_entity_id').where('org_id', '=', ctx.orgId).where('id', '=', ctx.proposalId).executeTakeFirst();
    if (proposal?.legal_entity_id !== control.launch.legal_entity_id) throw stale();
    if (openFamily(control, kind === 'budget_raise' ? 'budget' : kind === 'schedule_extend' ? 'schedule' : payload.slot)) throw changeOpen();
    const zone = requireZone(control);
    const today = todayIn(zone, ctx.now);
    if (control.held.endOn < today) throw refuse('ADS_FLIGHT_OVER', 409, 'Lịch chạy đã kết thúc nên không thực hiện được thay đổi này');
    if (largestAmount(control.held.dailyBudget, control.launch.start_text, control.held.endOn) !== payload.previousAmount) throw stale();
    const adSet = { slot: payload.slot };
    let change: NewChange;
    let budget = control.held.dailyBudget;
    let endOn = control.held.endOn;
    if (kind === 'resume') {
      const problem = statusProblem('resume', objectStatusOf(payload.slot, control.changes));
      if (problem) throw stale();
      if (payload.amount !== payload.previousAmount || payload.dailyBudget !== control.held.dailyBudget || payload.endOn !== control.held.endOn) throw stale();
      change = { slot: payload.slot, kind: 'resume' };
    } else if (kind === 'budget_raise') {
      if (adSet.slot !== 'ad_set' || payload.fromBudget !== control.held.dailyBudget || payload.endOn !== control.held.endOn) throw stale();
      if (budgetProblem('budget_raise', control.held.dailyBudget, payload.toBudget as string, control.launch.currency) !== null) throw stale();
      if (largestAmount(payload.toBudget as string, control.launch.start_text, control.held.endOn) !== payload.amount) throw stale();
      budget = new Decimal(payload.toBudget as string).toFixed();
      change = { slot: 'ad_set', kind: 'budget_raise', fromBudget: control.held.dailyBudget, toBudget: budget };
    } else {
      if (adSet.slot !== 'ad_set' || payload.fromEndOn !== control.held.endOn || payload.dailyBudget !== control.held.dailyBudget) throw stale();
      if (scheduleProblem('schedule_extend', { startOn: control.launch.start_text, heldEndOn: control.held.endOn, endOn: payload.toEndOn as string, today }) !== null) throw stale();
      if (largestAmount(control.held.dailyBudget, control.launch.start_text, payload.toEndOn as string) !== payload.amount) throw stale();
      endOn = payload.toEndOn as string;
      change = { slot: 'ad_set', kind: 'schedule_extend', fromEndOn: control.held.endOn, toEndOn: endOn };
    }
    // The authoritative cap check, under the lock held above, for this launch with the change against every other launch.
    await refuseOverCaps(ctx, control, budget, endOn);
    const changeId = await insertChange(ctx, control, { ...change, proposalId: ctx.proposalId });
    return { control, changeId, change, amount: payload.amount, budget, endOn };
  };
}

export const adsObjectResume = defineCommand({
  // A literal, not the contract's constant (which equals it): the job-egress invariant reads the name of every command whose events feed a queue from the source.
  name: 'ads.object.resume',
  input: z.object({ payload: zAdsObjectResumePayload, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: ADS_OBJECT_RESUME_KIND,
  target: (input) => ({ type: 'ads.ad_launch', id: input.payload.launchId.toLowerCase() }),
  handler: async (ctx, { payload }) => {
    const done = await approvedHandler('resume')(ctx, payload);
    await ctx.emit('ads.manage.queued', { changeId: done.changeId, launchId: done.control.launch.id, adAccountId: done.control.launch.ad_account_id });
    ctx.audit({ changeId: done.changeId, launchId: done.control.launch.id, adAccountId: done.control.launch.ad_account_id, kind: 'resume', slot: payload.slot, currency: done.control.launch.currency, amount: done.amount, dailyBudget: done.budget, endOn: done.endOn });
    return { changeId: done.changeId, launchId: done.control.launch.id, kind: 'resume' as const, state: 'queued' as const };
  },
});

export const adsBudgetRaise = defineCommand({
  // A literal, not the contract's constant (which equals it): the job-egress invariant reads the name of every command whose events feed a queue from the source.
  name: 'ads.budget.raise',
  input: z.object({ payload: zAdsBudgetRaisePayload, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: ADS_BUDGET_RAISE_KIND,
  target: (input) => ({ type: 'ads.ad_launch', id: input.payload.launchId.toLowerCase() }),
  handler: async (ctx, { payload }) => {
    const done = await approvedHandler('budget_raise')(ctx, payload);
    await ctx.emit('ads.manage.queued', { changeId: done.changeId, launchId: done.control.launch.id, adAccountId: done.control.launch.ad_account_id });
    ctx.audit({ changeId: done.changeId, launchId: done.control.launch.id, adAccountId: done.control.launch.ad_account_id, kind: 'budget_raise', slot: 'ad_set', currency: done.control.launch.currency, amount: done.amount, fromBudget: payload.fromBudget, toBudget: payload.toBudget });
    return { changeId: done.changeId, launchId: done.control.launch.id, kind: 'budget_raise' as const, state: 'queued' as const };
  },
});

export const adsScheduleExtend = defineCommand({
  // A literal, not the contract's constant (which equals it): the job-egress invariant reads the name of every command whose events feed a queue from the source.
  name: 'ads.schedule.extend',
  input: z.object({ payload: zAdsScheduleExtendPayload, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: ADS_SCHEDULE_EXTEND_KIND,
  target: (input) => ({ type: 'ads.ad_launch', id: input.payload.launchId.toLowerCase() }),
  handler: async (ctx, { payload }) => {
    const done = await approvedHandler('schedule_extend')(ctx, payload);
    await ctx.emit('ads.manage.queued', { changeId: done.changeId, launchId: done.control.launch.id, adAccountId: done.control.launch.ad_account_id });
    ctx.audit({ changeId: done.changeId, launchId: done.control.launch.id, adAccountId: done.control.launch.ad_account_id, kind: 'schedule_extend', slot: 'ad_set', currency: done.control.launch.currency, amount: done.amount, fromEndOn: payload.fromEndOn, toEndOn: payload.toEndOn });
    return { changeId: done.changeId, launchId: done.control.launch.id, kind: 'schedule_extend' as const, state: 'queued' as const };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// The job's two commands (the system's): begin decides the platform call and re-checks, record settles it
// ---------------------------------------------------------------------------------------------------------------

export type ManageBegin =
  | { action: 'none'; reason: string }
  | {
      // `settle` is a read only, for a change that ended unclear (#3898): nothing is called and no ledger row is made.
      action: 'call' | 'reconcile' | 'settle';
      changeId: string;
      callKey: string;
      kind: AdsManageKind;
      level: 'campaign' | 'ad_set' | 'ad';
      slot: AdsManageSlot;
      objectId: string;
      connectionId: string;
      provider: string;
      account: { externalAccountId: string; currency: string };
      // What the change sets, for the call and for the read that settles a lost answer: the status, the budget, or the end time (the first moment after the last day).
      toStatus: 'active' | 'paused' | 'archived' | null;
      toBudget: string | null;
      toEndTime: string | null;
      // What the object had before the change (budget, end time), for a settle's read: "it did not land" needs the old value shown, not just "not the new one" (#3898).
      fromBudget: string | null;
      fromEndTime: string | null;
    };

const none = (reason: string): ManageBegin => ({ action: 'none', reason });
const STATUS_OF_KIND = { pause: 'paused', resume: 'active', archive: 'archived' } as const;

export const zManageBeginInput = z.strictObject({
  changeId: zId,
  // The providers this worker has a manager for: a change whose write connection is of another is left queued until a deployment that has one runs it.
  providers: z.array(z.string().min(1).max(32)).max(8),
  // The sweep that settles an unclear change by reading its object (#3898): the change must be unclear, and the answer is a read, never a call.
  settle: z.boolean().optional(),
});

const zCode = z.string().regex(/^[A-Za-z0-9_.]{1,64}$/);
// What came of a call, as the job tells it (the same words as the activation's): there is no object id in an answer, the object is the one begin named.
export const zManageResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted') }),
  // A read of the object shows the change landed.
  z.strictObject({ kind: z.literal('found') }),
  // A read shows the object is as it was: the call may be made once more.
  z.strictObject({ kind: z.literal('missing') }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['bad_request', 'permission']), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('token'), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('unknown'), error: z.enum(['rate_limited', 'transient', 'unknown']), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('unknowable'), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('blocked'), code: zCode }),
]);
export type ManageResult = z.infer<typeof zManageResult>;

export interface ManageRecorded {
  recorded: boolean;
  reason?: 'not_found' | 'stale' | 'settled';
  state?: string;
  // What the job does next: make the call now (a read showed it did not land), or stop.
  next?: 'call' | 'stop';
}

// What begin hands the job for a change: the object, the connection and what the change sets (the call, the read that settles a lost answer and the sweep's read all use it).
function workOf(
  action: 'call' | 'reconcile' | 'settle',
  change: ChangeRecord,
  connection: { id: string; provider: string },
  object: { externalId: string },
  account: { externalAccountId: string; currency: string },
  zone: string | null,
): Extract<ManageBegin, { action: 'call' | 'reconcile' | 'settle' }> {
  const kindStatus = change.kind === 'pause' || change.kind === 'resume' || change.kind === 'archive' ? STATUS_OF_KIND[change.kind] : null;
  return {
    action,
    changeId: change.id,
    callKey: manageCallKey(change.id),
    kind: change.kind,
    level: change.level,
    slot: change.slot,
    objectId: object.externalId,
    connectionId: connection.id,
    provider: connection.provider,
    account,
    toStatus: kindStatus,
    toBudget: change.toBudget,
    toEndTime: change.toEndOn && zone ? zonedMidnight(dayAfter(change.toEndOn), zone) : null,
    fromBudget: change.fromBudget,
    fromEndTime: change.fromEndOn && zone ? zonedMidnight(dayAfter(change.fromEndOn), zone) : null,
  };
}

export const adsManageBegin = defineCommand({
  name: 'ads.manage.begin',
  // Begins a change that may raise spend, which a switch-off must not overtake: it holds the tenant row, as the switch does (ADR-0053).
  opensBusyWork: true,
  input: zManageBeginInput,
  // The platform is called by the job, not here. The system's and R2 external, because an R3 command cannot run as the system: the authority to raise spend is the approval the
  // change row carries (stamped and checked by the database), and nothing here calls a platform without the re-checks below.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_manage_change', id: input.changeId.toLowerCase() }),
  handler: async (ctx, input): Promise<ManageBegin> => {
    requireSystem(ctx);
    const changeId = input.changeId.toLowerCase();
    const seen = await ctx.trx.selectFrom('crove_ads.ad_manage_change').select(['id', 'launch_id', 'state']).where('org_id', '=', ctx.orgId).where('id', '=', changeId).executeTakeFirst();
    if (!seen) return none('not_found');
    if (seen.state !== (input.settle === true ? 'unclear' : 'queued')) return none('settled');
    // The org's lock first (the stops, the approvals and the other changes take it), then the account, the launch, the change.
    const setting = await lockedSetting(ctx);
    const launch = await launchSelect(ctx).where('id', '=', seen.launch_id).executeTakeFirst();
    if (!launch) return none('not_found');
    const found = await launchAccountOf(ctx, launch.ad_account_id);
    if (!found) return none('no_account');
    const lockedLaunchRow = await launchSelect(ctx).where('id', '=', launch.id).forUpdate().executeTakeFirstOrThrow();
    const changes = await changesOf(ctx, launch.id);
    const change = changes.find((c) => c.id === changeId);
    if (!change || change.state !== (input.settle === true ? 'unclear' : 'queued')) return none('settled');
    const { account, connection } = found;
    // A worker with no manager for the connection's provider leaves the change queued.
    if (connection && !input.providers.includes(connection.provider)) return none('no_manager');
    const objects = await objectsOf(ctx, launch.id);
    const object = objects.find((o) => o.slot === change.slot);

    // A read that settles an unclear change (#3898) makes no call and no ledger row, so none of the checks below that gate a call applies (the stops, the caps, a launch that is no
    // longer running: a read of an object changes nothing). It needs what makes the read mean something: nothing newer of the family has overtaken the change, its call is old enough
    // that a late landing is not taken for a miss, and a connection to read through. The record decides again under the locks.
    if (input.settle === true) {
      if (!object) return none('object_missing');
      if (!connection) return none('no_manager');
      if (!settleCandidate(changes, change.id)) return none('superseded');
      const asked = await ctx.trx.selectFrom('crove_kernel.external_call').select(['updated_at']).where('org_id', '=', ctx.orgId).where('key', '=', manageCallKey(change.id)).executeTakeFirst();
      if (!asked) return none('no_call');
      if ((ctx.now.getTime() - asked.updated_at.getTime()) / 1000 < SETTLE_MIN_AGE_SECONDS) return none('too_soon');
      if (change.toEndOn !== null && !zoneKnown(account.time_zone)) return none('zone_unknown');
      return workOf('settle', change, connection, object, { externalAccountId: account.external_account_id, currency: lockedLaunchRow.currency }, account.time_zone);
    }

    // A call that was begun may have landed, so the change can no longer be cancelled (the database refuses it): the checks below that would cancel it apply only to a change
    // whose call was never begun. One whose call was begun goes on to the ledger below, which reads the object (a read, never a second call while a stop stands: the record
    // fails the change as stopped when the read shows it did not land).
    const callKey = manageCallKey(change.id);
    const begunRow = await ctx.trx.selectFrom('crove_kernel.external_call').select('id').where('org_id', '=', ctx.orgId).where('key', '=', callKey).executeTakeFirst();
    const begun = begunRow !== undefined;
    const settle = async (state: 'cancelled' | 'failed', code: string) => {
      await ctx.trx.updateTable('crove_ads.ad_manage_change').set({ state, code }).where('org_id', '=', ctx.orgId).where('id', '=', change.id).execute();
      ctx.audit({ changeId: change.id, launchId: launch.id, adAccountId: launch.ad_account_id, kind: change.kind, slot: change.slot, state, code, phase: 'begin' });
      return none(code);
    };
    // A change of a launch that is no longer running is never made (the stops win): cancelled, its held amount released. A launch that needs attention keeps a pause.
    const running = lockedLaunchRow.state === 'live' || (change.kind === 'pause' && lockedLaunchRow.state === 'needs_attention');
    if (!running && !begun) return settle('cancelled', `launch_${lockedLaunchRow.state}`);
    if (!object) return begun ? none('object_missing') : settle('cancelled', 'object_missing');
    // A lower budget or a shorter schedule (no approval) behind an unclear raise or extension of its family could really be a raise (the platform may already run the higher value):
    // the request refuses it, and begin refuses it again for one that was queued before the other became unclear. Never called.
    if (!begun && (change.kind === 'budget_lower' ? unclearOpen(changes, BUDGET_KINDS) : change.kind === 'schedule_shorten' ? unclearOpen(changes, SCHEDULE_KINDS) : false)) return settle('cancelled', 'unclear_family');
    // The stop conditions, before EVERY call. A pause needs no switch (stopping spend is always allowed), only a connection that can still be used.
    const stops = stopConditions(setting, account, connection);
    if (stopsChange(stops, change.kind) && !begun) {
      if (change.kind === 'pause') return settle('failed', 'connection_closed');
      return settle('cancelled', stops.find((s) => stopsChange(s, change.kind)) as string);
    }
    if (!connection) return none('no_manager');
    if (!zoneKnown(account.time_zone)) return begun ? none('zone_unknown') : settle('cancelled', 'zone_unknown');
    const zone = account.time_zone as string;
    // What can raise spend is judged against the caps once more, authoritatively, with the launch's own held values (which include this change) against every other launch: a cap
    // lowered since the approval cancels the change and releases what it held.
    if (OPENING_KINDS.includes(change.kind) && !begun) {
      const held = heldValues({ dailyBudget: lockedLaunchRow.daily_budget, endOn: lockedLaunchRow.end_text }, changes);
      if (held.endOn < todayIn(zone, ctx.now)) return settle('cancelled', 'flight_over');
      const currencyProblem = await capCurrencyProblem(ctx, { launch: lockedLaunchRow, account });
      if (currencyProblem) return settle('cancelled', currencyProblem);
      const problems = await manageCapsProblems(ctx, { launch: lockedLaunchRow, account }, held.dailyBudget, held.endOn);
      if (problems.length > 0) {
        // The numbers the person is told (the first caps passed: scope, period, the day or month, the cap, what is committed, what the change adds).
        ctx.audit({ changeId: change.id, launchId: launch.id, adAccountId: launch.ad_account_id, kind: change.kind, slot: change.slot, code: 'cap_lowered', phase: 'begin', problems: problems.slice(0, 5).map((p) => `${p.scope}:${p.period}:${p.day ?? p.month ?? ''}:${p.cap}:${p.committed}:${p.plan}`) });
        return settle('cancelled', 'cap_lowered');
      }
    }

    // The ledger row of the one call: inserted started and committed BEFORE the platform is called; found again, it is read, never called blind.
    const row = await ctx.trx.selectFrom('crove_kernel.external_call').select(['id', 'state', 'calls', 'error_code', 'started_at', 'updated_at']).where('org_id', '=', ctx.orgId).where('key', '=', callKey).forUpdate().executeTakeFirst();
    if (row?.state === 'ambiguous' && row.error_code !== null && (row.calls >= UNCLEAR_MAX_CALLS || (ctx.now.getTime() - row.started_at.getTime()) / 1000 >= UNCLEAR_GIVE_UP_SECONDS)) {
      // Never asked about for ever: the answer stays unclear, the change is shown as such and what it would add stays held against the caps.
      await ctx.trx.updateTable('crove_ads.ad_manage_change').set({ state: 'unclear', code: 'reconcile_unclear' }).where('org_id', '=', ctx.orgId).where('id', '=', change.id).execute();
      ctx.audit({ changeId: change.id, launchId: launch.id, adAccountId: launch.ad_account_id, kind: change.kind, slot: change.slot, state: 'unclear', calls: row.calls, phase: 'begin' });
      return none('reconcile_unclear');
    }
    const action = stepAction(row ? { state: row.state, updatedAt: row.updated_at } : null, ctx.now);
    if (action === 'settled') {
      // A call the platform refused ended the change; one that succeeded was recorded with it (the record settles both in one transaction), so a succeeded row means the change landed.
      if (row?.state === 'failed') return settle('failed', 'step_failed');
      await ctx.trx.updateTable('crove_ads.ad_manage_change').set({ state: 'applied', code: null }).where('org_id', '=', ctx.orgId).where('id', '=', change.id).execute();
      return none('settled');
    }
    if (action === 'wait') return none(row?.state === 'started' ? 'in_flight' : 'reconcile_wait');
    if (action === 'call') {
      await ctx.trx.insertInto('crove_kernel.external_call').values({ org_id: ctx.orgId, key: callKey, module: 'ads', target: 'launch', step: manageStep(change.kind), retry_safety: 'idempotent', started_at: ctx.now, updated_at: ctx.now }).execute();
    } else if (row) {
      // A reconcile: the row is taken by this run, so a job that begins at the same moment waits.
      await ctx.trx.updateTable('crove_kernel.external_call').set({ state: 'ambiguous', updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    }
    return workOf(action === 'reconcile' ? 'reconcile' : 'call', change, connection, object, { externalAccountId: account.external_account_id, currency: lockedLaunchRow.currency }, zone);
  },
});

export const adsManageRecord = defineCommand({
  name: 'ads.manage.record',
  input: z.strictObject({ changeId: zId, callKey: z.string().min(1).max(200), phase: z.enum(['call', 'reconcile', 'settle']), result: zManageResult }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_manage_change', id: input.changeId.toLowerCase() }),
  handler: async (ctx, input): Promise<ManageRecorded> => {
    requireSystem(ctx);
    const changeId = input.changeId.toLowerCase();
    if (input.callKey !== manageCallKey(changeId)) return { recorded: false, reason: 'stale' };
    const seen = await ctx.trx.selectFrom('crove_ads.ad_manage_change').select(['id', 'launch_id', 'ad_account_id', 'kind', 'slot', 'state']).where('org_id', '=', ctx.orgId).where('id', '=', changeId).executeTakeFirst();
    if (!seen) return { recorded: false, reason: 'not_found' };
    const setting = await lockedSetting(ctx);
    const change = await ctx.trx.selectFrom('crove_ads.ad_manage_change').select(['id', 'state', 'kind', 'launch_id', 'ad_account_id', 'slot']).where('org_id', '=', ctx.orgId).where('id', '=', changeId).forUpdate().executeTakeFirst();
    const row = await ctx.trx.selectFrom('crove_kernel.external_call').select(['id', 'state', 'calls', 'updated_at']).where('org_id', '=', ctx.orgId).where('key', '=', input.callKey).forUpdate().executeTakeFirst();
    if (!change || !row) return { recorded: false, reason: 'stale' };
    if (input.phase === 'settle' ? change.state !== 'unclear' : change.state !== 'queued') return { recorded: false, reason: 'settled' };
    if (row.state === 'succeeded' || row.state === 'failed') return { recorded: false, reason: input.phase === 'settle' ? 'stale' : 'settled' };
    const result = input.result;
    const settleRow = (values: { state: 'started' | 'succeeded' | 'failed' | 'ambiguous'; calls?: number; error_kind?: 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient' | 'unknown'; error_code?: string; finished_at?: Date }) =>
      ctx.trx.updateTable('crove_kernel.external_call').set({ updated_at: ctx.now, ...values }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    const setChange = (state: 'applied' | 'failed', code: string | null) => ctx.trx.updateTable('crove_ads.ad_manage_change').set({ state, code }).where('org_id', '=', ctx.orgId).where('id', '=', change.id).execute();

    if (input.phase === 'settle') {
      // The sweep's read of an unclear change (#3898): the answer is what the object shows, never a call. Decided again under the locks: the change is still unclear, nothing newer
      // of its family has overtaken it, and its call is old enough that a late landing is not taken for a miss.
      if (result.kind !== 'found' && result.kind !== 'missing' && result.kind !== 'unknowable') return { recorded: false, reason: 'stale' };
      if (!settleCandidate(await changesOf(ctx, change.launch_id), change.id) || (ctx.now.getTime() - row.updated_at.getTime()) / 1000 < SETTLE_MIN_AGE_SECONDS) return { recorded: false, reason: 'stale' };
      if (result.kind === 'unknowable') {
        // The read could not be made: the change stays unclear and what it holds stays held (never under-counted). Only the ledger row's clock moves, so the next read waits its turn.
        await settleRow({ state: 'ambiguous' });
        ctx.audit({ changeId: change.id, launchId: change.launch_id, adAccountId: change.ad_account_id, kind: change.kind, slot: change.slot, phase: input.phase, outcome: result.kind, code: result.code ?? 'UNKNOWN' });
        return { recorded: true, state: 'unclear', next: 'stop' };
      }
      if (result.kind === 'found') {
        await settleRow({ state: 'succeeded', finished_at: ctx.now });
        await setChange('applied', null);
      } else {
        // The object is as it was, long after the call: it did not land, so the change fails and what it held is released.
        await settleRow({ state: 'failed', error_kind: 'unknown', error_code: 'UNCLEAR_NOT_APPLIED', finished_at: ctx.now });
        await setChange('failed', 'unclear_not_applied');
      }
      ctx.audit({ changeId: change.id, launchId: change.launch_id, adAccountId: change.ad_account_id, kind: change.kind, slot: change.slot, phase: input.phase, outcome: result.kind });
      return { recorded: true, state: result.kind === 'found' ? 'applied' : 'failed', next: 'stop' };
    }
    if (result.kind === 'accepted' || result.kind === 'found') {
      // The change is made at the platform: a fact whatever became of the launch meanwhile, so it is recorded as applied (what it released or raised is the hold's business).
      await settleRow({ state: 'succeeded', finished_at: ctx.now });
      await setChange('applied', null);
      ctx.audit({ changeId: change.id, launchId: change.launch_id, adAccountId: change.ad_account_id, kind: change.kind, slot: change.slot, phase: input.phase, outcome: result.kind });
      return { recorded: true, state: 'applied', next: 'stop' };
    }
    if (result.kind === 'missing') {
      // A read shows the object as it was: the call may be made again, once, from an unclear row (a second `missing` for the same row is stale, so two jobs never both make it),
      // and only if nothing has stopped it since: the owner can switch off while the read runs, and the job still holds the token it opened before.
      if (row.state !== 'ambiguous') return { recorded: false, reason: 'stale' };
      const launch = await launchSelect(ctx).where('id', '=', change.launch_id).executeTakeFirst();
      const found = launch ? await launchAccountOf(ctx, launch.ad_account_id) : null;
      let why: string | null = null;
      if (!launch || !found || stopsChange(stopConditions(setting, found.account, found.connection), change.kind)) why = 'stopped';
      else if (launch.state !== 'live' && !(change.kind === 'pause' && launch.state === 'needs_attention')) why = 'stopped';
      else if (OPENING_KINDS.includes(change.kind)) {
        // What can raise spend is judged again before the call is made once more (a cap lowered, or the flight over, since the first call): the read showed the platform unchanged, so
        // refusing it now changes nothing there.
        const held = heldValues({ dailyBudget: launch.daily_budget, endOn: launch.end_text }, await changesOf(ctx, launch.id));
        if (!zoneKnown(found.account.time_zone) || held.endOn < todayIn(found.account.time_zone as string, ctx.now)) why = 'flight_over';
        else if ((await capCurrencyProblem(ctx, { launch, account: found.account })) !== null) why = 'cap_currency';
        else if ((await manageCapsProblems(ctx, { launch, account: found.account }, held.dailyBudget, held.endOn)).length > 0) why = 'cap_lowered';
      }
      if (why !== null) {
        await settleRow({ state: 'failed', error_kind: 'unknown', error_code: why.toUpperCase(), finished_at: ctx.now });
        // The read showed the object as it was, so nothing changed at the platform: the change fails (a call was begun, so it cannot be cancelled) and what it held is released.
        await setChange('failed', why);
        ctx.audit({ changeId: change.id, launchId: change.launch_id, adAccountId: change.ad_account_id, kind: change.kind, slot: change.slot, phase: input.phase, outcome: 'missing', code: why });
        return { recorded: true, state: 'failed', next: 'stop' };
      }
      await settleRow({ state: 'started', calls: row.calls + 1 });
      ctx.audit({ changeId: change.id, launchId: change.launch_id, adAccountId: change.ad_account_id, kind: change.kind, slot: change.slot, phase: input.phase, outcome: 'missing' });
      return { recorded: true, state: 'queued', next: 'call' };
    }
    if (result.kind === 'unknown' || result.kind === 'unknowable') {
      // An answer that cannot be told: the change may have landed, so the row is unclear until a read shows it. The sweep asks again.
      const code = result.code ?? 'UNKNOWN';
      await settleRow({ state: 'ambiguous', error_kind: result.kind === 'unknown' ? result.error : 'unknown', error_code: code });
      ctx.audit({ changeId: change.id, launchId: change.launch_id, adAccountId: change.ad_account_id, kind: change.kind, slot: change.slot, phase: input.phase, outcome: result.kind, code });
      return { recorded: true, state: 'queued', next: 'stop' };
    }
    // The rest ends the change: the platform refused it, the token is refused, or the call was not made. Nothing changed at the platform, so what it would have raised is released.
    if (result.kind === 'rejected') {
      await settleRow({ state: 'failed', error_kind: result.error, error_code: result.code ?? 'REFUSED', finished_at: ctx.now });
      await setChange('failed', result.code ?? 'REFUSED');
    } else if (result.kind === 'token') {
      await settleRow({ state: 'failed', error_kind: 'token_expired', error_code: result.code ?? 'TOKEN', finished_at: ctx.now });
      await setChange('failed', result.code ?? 'TOKEN');
    } else {
      await settleRow({ state: 'failed', error_kind: /token|expired/.test(result.code.toLowerCase()) ? 'token_expired' : 'permission', error_code: result.code, finished_at: ctx.now });
      await setChange('failed', result.code);
    }
    ctx.audit({ changeId: change.id, launchId: change.launch_id, adAccountId: change.ad_account_id, kind: change.kind, slot: change.slot, phase: input.phase, outcome: result.kind });
    return { recorded: true, state: 'failed', next: 'stop' };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

export const adsManageState = defineQuery({
  name: 'ads.manage.state',
  input: z.strictObject({ launchId: zId }),
  access: ['owner', 'admin', 'member'],
  handler: async (ctx: QueryContext, input): Promise<AdsManageStateView> => {
    const launch = await launchSelect(ctx).where('id', '=', input.launchId.toLowerCase()).executeTakeFirst();
    if (!launch) throw refuse('ADS_LAUNCH_NOT_FOUND', 404, 'Không tìm thấy lần chạy quảng cáo này');
    return manageStateOf(ctx, launch);
  },
});

// Uy's suggestions: the campaigns of live launches whose cost per result jumped (the flag the sync's figures raise, deterministic, no model call), each with a "pause" or a
// "lower the budget" for a person to apply with the ordinary command. Never a raise, and nothing here changes anything.
export const adsManageSuggestions = defineQuery({
  name: 'ads.manage.suggestions',
  input: z.strictObject({ adAccountId: zId.optional() }),
  access: MANAGERS,
  handler: async (ctx: QueryContext, input): Promise<AdsManageSuggestion[]> => {
    const flags = (await loadFlags(ctx, new Date())).filter((f): f is Extract<typeof f, { kind: 'cpr' }> => f.kind === 'cpr' && (!input.adAccountId || f.adAccountId === input.adAccountId.toLowerCase()));
    if (flags.length === 0) return [];
    const out: AdsManageSuggestion[] = [];
    for (const flag of flags) {
      // The live launch whose campaign this is: the recorded object's platform id is the campaign id of the figures.
      const object = await ctx.trx
        .selectFrom('crove_ads.ad_object as o')
        .innerJoin('crove_ads.ad_launch as l', (j) => j.onRef('l.org_id', '=', 'o.org_id').onRef('l.id', '=', 'o.launch_id'))
        .select(['o.launch_id', 'o.name'])
        .where('o.org_id', '=', ctx.orgId)
        .where('o.level', '=', 'campaign')
        .where('o.external_id', '=', flag.campaignId)
        .where('o.ad_account_id', '=', flag.adAccountId)
        .where('l.state', '=', 'live')
        .executeTakeFirst();
      if (!object) continue;
      const launch = await launchSelect(ctx).where('id', '=', object.launch_id).executeTakeFirstOrThrow();
      const changes = await changesOf(ctx, launch.id);
      // A campaign that is paused or archived, or whose budget a change is already moving, has nothing to suggest.
      if (objectStatusOf('campaign', changes).status !== 'active' || changes.some((c) => c.state === 'queued')) continue;
      const held = heldValues({ dailyBudget: launch.daily_budget, endOn: launch.end_text }, changes);
      const suggestion = suggestionFor({ ratio: flag.ratio, heldBudget: held.confirmedBudget, currency: launch.currency });
      out.push({
        launchId: launch.id,
        adAccountId: launch.ad_account_id,
        campaignName: object.name,
        kind: suggestion.kind,
        slot: 'campaign',
        toBudget: suggestion.kind === 'budget_lower' ? suggestion.toBudget : null,
        currency: launch.currency,
        recentCost: flag.recentCost,
        medianCost: flag.medianCost,
        ratio: flag.ratio,
        recentResults: flag.recentResults,
        day: flag.day,
      });
    }
    return out;
  },
});

export const manageCommands = [
  adsObjectPause,
  adsObjectArchive,
  adsBudgetLower,
  adsScheduleShorten,
  adsManageCancel,
  adsObjectPrepareResume,
  adsBudgetPrepareRaise,
  adsSchedulePrepareExtend,
  adsObjectResume,
  adsBudgetRaise,
  adsScheduleExtend,
  adsManageBegin,
  adsManageRecord,
];
export const manageQueries = [adsManageState, adsManageSuggestions];

// Kept for the rules' own unit test of the unclear give-up and the stale lease the job relies on.
export const MANAGE_TIMING = { startedStaleSeconds: STARTED_STALE_SECONDS, unclearGiveUpSeconds: UNCLEAR_GIVE_UP_SECONDS, unclearMaxCalls: UNCLEAR_MAX_CALLS } as const;

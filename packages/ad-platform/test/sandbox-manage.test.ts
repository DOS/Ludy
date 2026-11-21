// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox's management of a live launch's objects (ADR-0043, #3835, ads W4): it changes the objects a `SandboxAdWriter` holds in memory, so every command of W4 runs
// on a laptop with no network. Budget and end time are kept on the ad set from its creation and changed by the manager; the writer's faults (`status`, `status_after`, `read`)
// work as they do for the activation; a secret that is not the sandbox's is a refused token; every change is recorded.
import { describe, expect, it } from 'vitest';
import { AdPlatformError, SandboxAdActivator, SandboxAdManager, SandboxAdWriter, managerOf, sandboxWriteLogin } from '../src/index.ts';

const ACCOUNT = 'sbxads-0123456789abcdef';
const ACCOUNT_REF = { externalAccountId: ACCOUNT, currency: 'VND' };
const secret = () => sandboxWriteLogin({ externalAccountId: ACCOUNT, currency: 'VND' }).secret;

async function launched(writer: SandboxAdWriter, s: string) {
  const campaign = await writer.createCampaign(s, ACCOUNT_REF, { name: 'Plan ludy:abcdef0123', objective: 'traffic' });
  const adSet = await writer.createAdSet(s, ACCOUNT_REF, {
    name: 'Plan ludy:abcdef0123 set',
    campaignId: campaign.id,
    objective: 'traffic',
    dailyBudget: '100000',
    startTime: '2026-11-10T00:00:00+0700',
    endTime: '2026-11-17T00:00:00+0700',
    targeting: { countries: ['VN'], regions: [], ageMin: 18, ageMax: 65, gender: 'all', interests: [] },
    pageId: '12345',
  });
  const creative = await writer.createCreative(s, ACCOUNT_REF, { name: 'Plan ludy:abcdef0123 creative 1', pageId: '12345', linkUrl: 'https://example.com', headline: 'h', primaryText: 'p', callToAction: 'learn_more' });
  const ad = await writer.createAd(s, ACCOUNT_REF, { name: 'Plan ludy:abcdef0123 ad 1', adSetId: adSet.id, creativeId: creative.id });
  return { campaign: campaign.id, adSet: adSet.id, creative: creative.id, ad: ad.id };
}
function setup() {
  const writer = new SandboxAdWriter();
  const manager = new SandboxAdManager(writer, new SandboxAdActivator(writer));
  return { writer, manager, s: secret() };
}

describe('the sandbox manager: budget and end time', () => {
  it('keeps the ad set\'s budget and end time from its creation, and reads them back', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    expect(writer.objects.get(made.adSet)).toMatchObject({ dailyBudget: '100000', endTime: '2026-11-17T00:00:00+0700' });
    expect(await manager.read(s, { level: 'ad_set', id: made.adSet }, ACCOUNT_REF)).toEqual({ status: 'paused', dailyBudget: '100000', endTime: '2026-11-17T00:00:00+0700' });
    // A campaign or an ad has neither.
    expect(await manager.read(s, { level: 'campaign', id: made.campaign }, ACCOUNT_REF)).toEqual({ status: 'paused', dailyBudget: null, endTime: null });
  });

  it('changes them on the object, and the read sees the change', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    const target = { level: 'ad_set' as const, id: made.adSet };
    await manager.setBudget(s, target, ACCOUNT_REF, '150000');
    await manager.setEndTime(s, target, '2026-11-20T00:00:00+0700');
    expect(writer.objects.get(made.adSet)).toMatchObject({ dailyBudget: '150000', endTime: '2026-11-20T00:00:00+0700' });
    expect(await manager.read(s, target, ACCOUNT_REF)).toEqual({ status: 'paused', dailyBudget: '150000', endTime: '2026-11-20T00:00:00+0700' });
    await manager.setBudget(s, target, ACCOUNT_REF, '80000.50');
    expect((await manager.read(s, target, ACCOUNT_REF)).dailyBudget).toBe('80000.50');
  });

  it('refuses a budget that is not an amount above zero with at most two places, and changes nothing', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    const target = { level: 'ad_set' as const, id: made.adSet };
    for (const budget of ['0', '0.00', '-1', '1.234', '1e3', '', 'abc', '12345678901234']) {
      await expect(manager.setBudget(s, target, ACCOUNT_REF, budget), budget).rejects.toMatchObject({ kind: 'bad_request', code: 'BUDGET_INVALID' });
    }
    expect(writer.objects.get(made.adSet)?.dailyBudget).toBe('100000');
    expect(manager.changes).toEqual([]);
  });

  it('records each change, in order, with what was set on which object', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    await manager.changeStatus(s, { level: 'ad', id: made.ad }, 'active');
    await manager.setBudget(s, { level: 'ad_set', id: made.adSet }, ACCOUNT_REF, '90000');
    await manager.changeStatus(s, { level: 'campaign', id: made.campaign }, 'archived');
    await manager.setEndTime(s, { level: 'ad_set', id: made.adSet }, '2026-11-15T00:00:00+0700');
    await manager.read(s, { level: 'ad_set', id: made.adSet }, ACCOUNT_REF);
    expect(manager.changes).toEqual([
      { level: 'ad', id: made.ad, set: 'status', value: 'active' },
      { level: 'ad_set', id: made.adSet, set: 'budget', value: '90000' },
      { level: 'campaign', id: made.campaign, set: 'status', value: 'archived' },
      { level: 'ad_set', id: made.adSet, set: 'end_time', value: '2026-11-15T00:00:00+0700' },
    ]);
  });
});

describe('the sandbox manager: status', () => {
  it('switches on, pauses and archives the objects of its writer, and leaves the others as they are', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    await manager.changeStatus(s, { level: 'ad', id: made.ad }, 'active');
    expect(writer.objects.get(made.ad)?.status).toBe('active');
    expect(writer.objects.get(made.adSet)?.status).toBe('paused');
    await manager.changeStatus(s, { level: 'ad', id: made.ad }, 'paused');
    expect(writer.objects.get(made.ad)?.status).toBe('paused');
    await manager.changeStatus(s, { level: 'ad', id: made.ad }, 'archived');
    expect((await manager.read(s, { level: 'ad', id: made.ad }, ACCOUNT_REF)).status).toBe('archived');
    // The writer's own record of a pause or an archive, and the activator's of a switch-on, are the ones that carried it.
    expect(writer.statusCalls.map((c) => c.status)).toEqual(['paused', 'archived']);
  });

  it('refuses an object it does not hold and an object of another level, with nothing changed', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    for (const target of [
      { level: 'ad' as const, id: 'nope' },
      { level: 'campaign' as const, id: made.ad },
      { level: 'ad_set' as const, id: made.campaign },
    ]) {
      await expect(manager.changeStatus(s, target, 'active')).rejects.toMatchObject({ kind: 'bad_request', code: 'OBJECT_NOT_FOUND' });
      await expect(manager.setBudget(s, target, ACCOUNT_REF, '1000')).rejects.toMatchObject({ kind: 'bad_request', code: 'OBJECT_NOT_FOUND' });
      await expect(manager.setEndTime(s, target, '2026-11-17T00:00:00+0700')).rejects.toMatchObject({ kind: 'bad_request', code: 'OBJECT_NOT_FOUND' });
      await expect(manager.read(s, target, ACCOUNT_REF)).rejects.toMatchObject({ kind: 'bad_request', code: 'OBJECT_NOT_FOUND' });
    }
    expect(manager.changes).toEqual([]);
    expect(writer.objects.get(made.ad)?.status).toBe('paused');
  });
});

describe('the sandbox manager: faults', () => {
  it('fails before the change with `status`: nothing changes, nothing is recorded, and the next call goes through', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    const adSet = { level: 'ad_set' as const, id: made.adSet };
    writer.inject({ level: 'ad_set', when: 'status' });
    await expect(manager.setBudget(s, adSet, ACCOUNT_REF, '150000')).rejects.toBeInstanceOf(AdPlatformError);
    expect(writer.objects.get(made.adSet)?.dailyBudget).toBe('100000');
    writer.inject({ level: 'ad_set', when: 'status' });
    await expect(manager.setEndTime(s, adSet, '2026-11-20T00:00:00+0700')).rejects.toBeInstanceOf(AdPlatformError);
    expect(writer.objects.get(made.adSet)?.endTime).toBe('2026-11-17T00:00:00+0700');
    writer.inject({ level: 'campaign', when: 'status' });
    await expect(manager.changeStatus(s, { level: 'campaign', id: made.campaign }, 'active')).rejects.toBeInstanceOf(AdPlatformError);
    expect(writer.objects.get(made.campaign)?.status).toBe('paused');
    expect(manager.changes).toEqual([]);
    await manager.setBudget(s, adSet, ACCOUNT_REF, '150000');
    expect(writer.objects.get(made.adSet)?.dailyBudget).toBe('150000');
  });

  it('makes the change and loses the answer with `status_after`, the case the read settles', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    const adSet = { level: 'ad_set' as const, id: made.adSet };
    writer.inject({ level: 'ad_set', when: 'status_after' });
    await expect(manager.setBudget(s, adSet, ACCOUNT_REF, '150000')).rejects.toBeInstanceOf(AdPlatformError);
    expect(writer.objects.get(made.adSet)?.dailyBudget).toBe('150000');
    expect(await manager.read(s, adSet, ACCOUNT_REF)).toMatchObject({ dailyBudget: '150000' });
    writer.inject({ level: 'ad_set', when: 'status_after' });
    await expect(manager.setEndTime(s, adSet, '2026-11-20T00:00:00+0700')).rejects.toBeInstanceOf(AdPlatformError);
    expect(writer.objects.get(made.adSet)?.endTime).toBe('2026-11-20T00:00:00+0700');
    // The activator's own: a switch-on whose answer is lost has switched on.
    writer.inject({ level: 'ad', when: 'status_after' });
    await expect(manager.changeStatus(s, { level: 'ad', id: made.ad }, 'active')).rejects.toBeInstanceOf(AdPlatformError);
    expect(writer.objects.get(made.ad)?.status).toBe('active');
    expect(manager.changes.map((c) => c.set)).toEqual(['budget', 'end_time']);
  });

  it('fails a read with `read`, once, and uses the fault\'s own error when it has one', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    const adSet = { level: 'ad_set' as const, id: made.adSet };
    writer.inject({ level: 'ad_set', when: 'read' });
    await expect(manager.read(s, adSet, ACCOUNT_REF)).rejects.toMatchObject({ kind: 'transient', code: 'NETWORK' });
    expect(await manager.read(s, adSet, ACCOUNT_REF)).toMatchObject({ dailyBudget: '100000' });
    writer.inject({ level: 'ad_set', when: 'status', error: new AdPlatformError('permission', 'NO') });
    await expect(manager.setBudget(s, adSet, ACCOUNT_REF, '150000')).rejects.toMatchObject({ kind: 'permission', code: 'NO' });
  });
});

describe('the sandbox manager: the secret', () => {
  it('refuses a secret that is not the sandbox\'s as a refused token, for every call', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    const adSet = { level: 'ad_set' as const, id: made.adSet };
    for (const bad of ['{"accessToken":"x"}', 'nope', '{}', JSON.stringify({ accessToken: `sbx_${'A'.repeat(43)}`, accountId: ACCOUNT, currency: 'VND' })]) {
      await expect(manager.changeStatus(bad, adSet, 'active'), bad).rejects.toMatchObject({ kind: 'token_expired', code: 'BAD_SECRET' });
      await expect(manager.setBudget(bad, adSet, ACCOUNT_REF, '1000'), bad).rejects.toMatchObject({ kind: 'token_expired' });
      await expect(manager.setEndTime(bad, adSet, '2026-11-17T00:00:00+0700'), bad).rejects.toMatchObject({ kind: 'token_expired' });
      await expect(manager.read(bad, adSet, ACCOUNT_REF), bad).rejects.toMatchObject({ kind: 'token_expired' });
    }
    expect(writer.objects.get(made.adSet)).toMatchObject({ status: 'paused', dailyBudget: '100000' });
    expect(manager.changes).toEqual([]);
  });

  it('is the same through the frozen view', async () => {
    const { writer, manager, s } = setup();
    const made = await launched(writer, s);
    const view = managerOf(manager);
    await view.setBudget(s, { level: 'ad_set', id: made.adSet }, ACCOUNT_REF, '120000');
    expect((await view.read(s, { level: 'ad_set', id: made.adSet }, ACCOUNT_REF)).dailyBudget).toBe('120000');
    await expect(view.read('nope', { level: 'ad_set', id: made.adSet }, ACCOUNT_REF)).rejects.toMatchObject({ kind: 'token_expired' });
  });
});

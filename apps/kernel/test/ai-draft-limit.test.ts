import { describe, expect, it } from 'vitest';
import { DraftBudget } from '../src/ai-draft-limit.ts';

describe('DraftBudget', () => {
  it('lets a member draft one at a time and a few a minute, and an org a few more across its members', () => {
    let now = 0;
    const budget = new DraftBudget({ perUserPerMinute: 2, perOrgPerMinute: 3, now: () => now });
    const first = budget.take('org-a', 'u1');
    expect(first.allowed).toBe(true);
    // A second draft while the first runs waits for it.
    expect(budget.take('org-a', 'u1')).toMatchObject({ allowed: false, reason: 'busy' });
    if (first.allowed) first.release();
    const second = budget.take('org-a', 'u1');
    expect(second.allowed).toBe(true);
    if (second.allowed) second.release();
    // Two a minute for this member.
    expect(budget.take('org-a', 'u1')).toMatchObject({ allowed: false, reason: 'user' });
    // Another member of the org gets the org's third, then the org is out.
    const other = budget.take('org-a', 'u2');
    expect(other.allowed).toBe(true);
    if (other.allowed) other.release();
    expect(budget.take('org-a', 'u3')).toMatchObject({ allowed: false, reason: 'org' });
    // Another org is not affected.
    expect(budget.take('org-b', 'u1').allowed).toBe(true);
    // A minute later the budgets are back.
    now += 60_000;
    expect(budget.take('org-a', 'u1').allowed).toBe(true);
  });

  it('charges a member nothing for a draft the org budget refuses', () => {
    let now = 0;
    // One draft a minute per member, two per org (one back every 30 seconds).
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 2, now: () => now });
    for (const user of ['u1', 'u2']) {
      const t = budget.take('org-a', user);
      if (t.allowed) t.release();
    }
    expect(budget.take('org-a', 'u3')).toMatchObject({ allowed: false, reason: 'org' });
    // 30 seconds later the org has one draft back; u3 was not charged, so it gets it (charged, it would wait a minute).
    now += 30_000;
    expect(budget.take('org-a', 'u3').allowed).toBe(true);
  });

  it('releases a ticket once, whatever calls it again', () => {
    const budget = new DraftBudget();
    const t = budget.take('org', 'u');
    expect(t.allowed).toBe(true);
    if (t.allowed) {
      t.release();
      t.release();
    }
    expect(budget.take('org', 'u').allowed).toBe(true);
  });

  it('refunds a ticket once when no model call was needed, restoring both user and org rate tokens', () => {
    const now = 0;
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1, now: () => now });
    const quietTicket = budget.take('org', 'u1');
    expect(quietTicket.allowed).toBe(true);
    // While still running, another call for the same user is busy even after refund.
    if (quietTicket.allowed) {
      quietTicket.refund?.();
      quietTicket.refund?.();
      expect(budget.take('org', 'u1')).toMatchObject({ allowed: false, reason: 'busy' });
      quietTicket.release();
    }
    // Once released, both user and org still have their 1/minute token available.
    const realTicket = budget.take('org', 'u1');
    expect(realTicket.allowed).toBe(true);
    if (realTicket.allowed) realTicket.release();
    expect(budget.take('org', 'u1')).toMatchObject({ allowed: false, reason: 'user' });
    expect(budget.take('org', 'u2')).toMatchObject({ allowed: false, reason: 'org' });
  });
});

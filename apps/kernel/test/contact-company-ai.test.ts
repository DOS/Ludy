// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's company suggestion on the API side (#2438) with a stand-in for the reader: the tax code and domain companies come first whatever the
// model does, the model orders only the names (and is not asked for fewer than two), and every state of `ai` is an answer with the companies in hand, not an error.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError } from '@crove/agent';
import { COMPANY_SUGGESTIONS_MAX, type CompanyCandidates } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { suggestCompanies, type CompanyAi } from '../src/contact-company-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const c = (partyId: string, name = partyId) => ({ partyId, name });
const found = (over: Partial<CompanyCandidates> = {}): CompanyCandidates => ({ personName: 'Nam Trần', label: 'acme', taxCode: [], emailDomain: [], names: [], ...over });

function setup(rank: ((name: string, label: string, names: readonly string[]) => Promise<number[]>) | null, budget = new DraftBudget()) {
  const asked: unknown[][] = [];
  const ai: CompanyAi = {
    reader: rank
      ? {
          rankCompanies: async (name, label, names) => {
            asked.push([name, label, [...names]]);
            return rank(name, label, names);
          },
        }
      : null,
    budget,
  };
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('suggestCompanies', () => {
  it('puts the tax code company first, then the domain company, then the names, each with its reason, and no more than the bound', async () => {
    const { ai } = setup(async (_n, _l, names) => names.map((_, i) => i));
    const names = Array.from({ length: 8 }, (_, i) => c(`n${i}`));
    const answer = await suggestCompanies(ai, ORG, USER, found({ taxCode: [c('t1')], emailDomain: [c('d1')], names }));
    expect(answer.ai).toBe('used');
    expect(answer.candidates.map((x) => [x.partyId, x.reason])).toEqual([['t1', 'tax_code'], ['d1', 'email_domain'], ['n0', 'name'], ['n1', 'name'], ['n2', 'name']]);
    expect(answer.candidates).toHaveLength(COMPANY_SUGGESTIONS_MAX);
  });

  it('asks the model only to order two or more names, and shows them in its order with the unranked ones after', async () => {
    const { ai, asked } = setup(async () => [1]);
    const answer = await suggestCompanies(ai, ORG, USER, found({ names: [c('a', 'Acme A'), c('b', 'Acme B'), c('c', 'Acme C')] }));
    expect(asked).toEqual([['Nam Trần', 'acme', ['Acme A', 'Acme B', 'Acme C']]]);
    expect(answer.candidates.map((x) => x.partyId)).toEqual(['b', 'a', 'c']);
    // One name, or none, or no word at all: nothing is asked.
    const quiet = setup(async () => [0]);
    expect((await suggestCompanies(quiet.ai, ORG, USER, found({ names: [c('a')] }))).ai).toBe('used');
    expect((await suggestCompanies(quiet.ai, ORG, USER, found())).candidates).toEqual([]);
    expect((await suggestCompanies(quiet.ai, ORG, USER, found({ label: null, names: [c('a'), c('b')] }))).ai).toBe('used');
    expect(quiet.asked).toEqual([]);
  });

  it('asks the model nothing when the other rules have filled the list, and shows each name once whatever a reader answers', async () => {
    const full = setup(async () => [0, 1]);
    const many = Array.from({ length: 5 }, (_, i) => c(`t${i}`));
    const answer = await suggestCompanies(full.ai, ORG, USER, found({ taxCode: many, names: [c('a'), c('b')] }));
    expect(answer.ai).toBe('used');
    expect(answer.candidates.map((x) => x.reason)).toEqual(['tax_code', 'tax_code', 'tax_code', 'tax_code', 'tax_code']);
    expect(full.asked).toEqual([]);
    // A reader that repeats an index, or names one that was not offered, adds nothing twice.
    const odd = setup(async () => [1, 1, 7, 0]);
    const once = await suggestCompanies(odd.ai, ORG, USER, found({ names: [c('a'), c('b')] }));
    expect(once.candidates.map((x) => x.partyId)).toEqual(['b', 'a']);
  });

  it('keeps every company in its own order, with a named state and no error, when the model is off, busy, spent or failing', async () => {
    const names = [c('a'), c('b')];
    const order = (r: Awaited<ReturnType<typeof suggestCompanies>>) => r.candidates.map((x) => x.partyId);
    const off = await suggestCompanies(setup(null).ai, ORG, USER, found({ taxCode: [c('t')], names }));
    expect([off.ai, order(off)]).toEqual(['off', ['t', 'a', 'b']]);
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => [2, 1], budget);
    await suggestCompanies(first.ai, ORG, USER, found({ names }));
    const busy = await suggestCompanies(first.ai, ORG, USER, found({ names }));
    expect([busy.ai, order(busy)]).toEqual(['busy', ['a', 'b']]);
    const spent = await suggestCompanies(setup(async () => Promise.reject(new AiBudgetExhaustedError('module', null))).ai, ORG, USER, found({ names }));
    expect([spent.ai, order(spent)]).toEqual(['budget', ['a', 'b']]);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = await suggestCompanies(setup(async () => Promise.reject(new Error('Acme Việt Nam secret'))).ai, ORG, USER, found({ names }));
    expect([failing.ai, order(failing)]).toEqual(['failed', ['a', 'b']]);
    // A failure is named, never quoted: no company name or message reaches the log.
    expect(JSON.stringify(log.mock.calls)).not.toContain('Acme');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// What the registry says of the Engage twins (epic #3857, E4, issue #3863; Platform PO conditions of 2026-11-19): exactly the 15 of ENGAGE_PROPOSALS declare `mcp` in mode proposal, none has a preparer, each is
// a strict payload over its original's own input in an R2 proposal-only command with its kind and scope, each has a four-eyes approval policy of owners and admins, and the originals the twins run still carry no
// `mcp`. The database half (the catalog rows, the audit chain) is in engage-proposals-chain.db.test.ts.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ENGAGE_PROPOSALS, zApprovedCall } from '@ludy/kernel-contract';
import { PROPOSAL_PREPARERS, approvalPolicies, kernelCommands, liveApprovalCommands } from '@ludy/kernel';
import { adsCommands } from '@ludy/mod-ads';
import { crmCommands } from '@ludy/mod-crm';
import { financeCommands } from '@ludy/mod-finance';
import { hrCommands } from '@ludy/mod-hr';
import { meetingsCommands } from '@ludy/mod-meetings';
import { notesCommands } from '@ludy/mod-notes';
import { socialCommands } from '@ludy/mod-social';

type Def = { name: string; input: { safeParse: (v: unknown) => { success: boolean }; shape?: { payload?: { safeParse: (v: unknown) => { success: boolean } } } }; risk: string; sideEffect: string; access: unknown; proposalKind?: string; mcp?: unknown; permission?: unknown; agent?: unknown };
const all = [...kernelCommands, ...financeCommands, ...meetingsCommands, ...socialCommands, ...adsCommands, ...crmCommands, ...hrCommands, ...notesCommands] as unknown as Def[];
const byName = new Map(all.map((c) => [c.name, c]));

describe('the Engage twins in the registry (#3863)', () => {
  it('has exactly the 15 twins of ENGAGE_PROPOSALS declare mode proposal: no prefix, no pattern, none more, none fewer', () => {
    const declared = all.filter((c) => (c.mcp as { mode?: string } | undefined)?.mode === 'proposal').map((c) => c.name);
    expect([...declared].sort()).toEqual(ENGAGE_PROPOSALS.map((p) => p.command).sort());
    expect(ENGAGE_PROPOSALS.length).toBe(15);
    expect(new Set(ENGAGE_PROPOSALS.map((p) => p.command)).size).toBe(15);
  });

  it('has no preparer for any twin (a client\'s raw strict payload is what is stored), and none for what a twin runs', () => {
    for (const p of ENGAGE_PROPOSALS) {
      expect(Object.hasOwn(PROPOSAL_PREPARERS, p.command), p.command).toBe(false);
      expect(Object.hasOwn(PROPOSAL_PREPARERS, p.wraps), p.wraps).toBe(false);
    }
  });

  it('declares each twin R2, proposal-only, with its kind and exactly { scope, mode } and no agent, permission or other door, over its original\'s own strict input', () => {
    for (const p of ENGAGE_PROPOSALS) {
      const twin = byName.get(p.command);
      const original = byName.get(p.wraps);
      expect(twin, p.command).toBeDefined();
      expect(original, p.wraps).toBeDefined();
      expect([twin?.risk, twin?.access, twin?.proposalKind], p.command).toEqual(['R2', 'proposal', p.kind]);
      expect(twin?.mcp, p.command).toStrictEqual({ scope: p.scope, mode: 'proposal' });
      expect(twin?.agent, p.command).toBeUndefined();
      expect(twin?.permission, p.command).toBeUndefined();
      // The original is never reachable by a grant: it carries no `mcp`.
      expect(original?.mcp, p.wraps).toBeUndefined();
      // The envelope is strict, and so is the payload: a key neither declares is refused, and an empty or missing payload is too.
      expect(twin?.input.safeParse({ payload: {}, smuggled: 1 }).success, p.command).toBe(false);
      expect(twin?.input.shape?.payload?.safeParse({ smuggled: 1 }).success, p.command).toBe(false);
      expect(twin?.input.safeParse({}).success, p.command).toBe(false);
    }
  });

  it('gives each twin one policy: owners and admins approve, with four-eyes, judged on the members now, no permission and no ledger', () => {
    const policies = approvalPolicies();
    const live = liveApprovalCommands();
    for (const p of ENGAGE_PROPOSALS) {
      expect(policies.find((x) => x.command === p.command), p.command).toEqual({ command: p.command, roles: ['owner', 'admin'], permission: null, fourEyes: true, ledger: false, live: true });
      expect(live, p.command).toContain(p.command);
    }
  });

  it('stores every id of a payload in lower case, whatever case the client wrote (the database compares them in lower case when a thread is erased)', () => {
    const call = zApprovedCall(z.strictObject({ id: z.uuid(), ids: z.array(z.uuid()), nested: z.strictObject({ at: z.string() }), body: z.string() }));
    const parsed = call.parse({ payload: { id: 'ABCDEF01-2345-4678-9ABC-DEF012345678', ids: ['ABCDEF01-2345-4678-9ABC-DEF012345679'], nested: { at: '2026-11-20T01:00:00Z' }, body: 'Dạ ABCDEF01-2345-4678-9ABC-DEF012345678 ạ' } });
    expect(parsed.payload).toEqual({ id: 'abcdef01-2345-4678-9abc-def012345678', ids: ['abcdef01-2345-4678-9abc-def012345679'], nested: { at: '2026-11-20T01:00:00Z' }, body: 'Dạ ABCDEF01-2345-4678-9ABC-DEF012345678 ạ' });
  });
});

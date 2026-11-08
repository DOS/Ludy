// SPDX-License-Identifier: AGPL-3.0-only
// The built-in implementation of Vy's memory port (ADR-0049 decision 9, issue #2783): a deployment on `docker compose up` has no outside
// service, so memory is the member's own rows of crove_kernel.member_vy_memory, read and written only through the member's own commands, in the
// member's own user context. Asking about anyone else is refused before a command is run, and the database would refuse it anyway (the
// restrictive policy shows a member their own rows only). Knowledge has no declared queries yet: a feature that asks gets no passages.
import { privateText, type MemberRef, type MemoryEntry, type MemoryPort } from '@crove/agent/member-vy';
import type { Runtime, UserActor } from '@crove/kernel-runtime';

export function builtInMemory(runtime: Runtime, actor: UserActor, orgId: string): MemoryPort {
  const mine = (who: MemberRef) => {
    if (who.orgId !== orgId || who.memberUserId !== actor.userId) throw new Error('built-in memory answers only about the member it was made for');
  };
  return {
    async read(who) {
      mine(who);
      const { entries } = await runtime.query<{ entries: Array<{ id: string; body: string }> }>('kernel.member_vy.memory.list', {}, { actor, orgId });
      return entries.map((e): MemoryEntry => ({ id: e.id, text: privateText(e.body) }));
    },
    async write(who, text) {
      mine(who);
      return runtime.execute<{ id: string }>('kernel.member_vy.memory.save', { body: text }, { actor, orgId });
    },
    async forget(target) {
      // A source has nothing in the member's own memory (entries are typed by the member, never derived from a note or a meeting).
      if (!('member' in target)) return;
      mine(target.member);
      const { entries } = await runtime.query<{ entries: Array<{ id: string }> }>('kernel.member_vy.memory.list', {}, { actor, orgId });
      for (const entry of entries) await runtime.execute('kernel.member_vy.memory.delete', { id: entry.id }, { actor, orgId });
    },
  };
}

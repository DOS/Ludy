// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" on Home (issue #2383): what needs the member today across the apps. There is no store of its own
// and nothing is written. Each line exposes one small read that returns TodayItems (`<module>.today`; the shape is
// @crove/kernel-contract's today.ts), and this query runs the ones that are registered, in the member's own transaction
// and role, so every line's own rules decide what the member sees: the list shows only what they could open on that
// line's screens. A line whose read is not registered yet (its issue has not landed, or its module is off) adds
// nothing, so a line joins the list by registering its read, with no change here.
//
// An item that does not match the shape is dropped and counted, never shown. Nothing here approves, sends or changes
// anything: an item only links to the screen where it is acted on.
import { z } from 'zod';
import { sortTodayItems, zTodayItem, type TodayItem, type TodayList } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The reads the lines agreed to expose (issue #2383): Accounting finance.today, Notes and CRM crm.today and
// kernel.conversation.today, Marketing social.today and ads.today.
export const TODAY_READS: readonly string[] = ['finance.today', 'crm.today', 'social.today', 'ads.today', 'kernel.conversation.today'];

export function todayQuery(options: { reads?: readonly string[] } = {}) {
  const reads = options.reads ?? TODAY_READS;
  return defineQuery({
    name: 'kernel.today',
    input: z.object({}),
    access: ALL,
    handler: async (ctx): Promise<TodayList> => {
      const seen = new Set<string>();
      const items: TodayItem[] = [];
      let dropped = 0;
      for (const name of reads) {
        let answer;
        try {
          answer = await ctx.query<unknown>(name, {});
        } catch (error) {
          // Thrown before any SQL, so the transaction is still usable: the read is simply not registered yet.
          if (error instanceof DomainError && error.code === 'QUERY_NOT_FOUND') continue;
          throw error;
        }
        if (answer.status !== 'ok') continue;
        if (!Array.isArray(answer.value)) {
          dropped += 1;
          continue;
        }
        for (const raw of answer.value) {
          const item = zTodayItem.safeParse(raw);
          if (!item.success) {
            dropped += 1;
            continue;
          }
          // The same item twice (a line answering with it twice) is shown once.
          const key = `${item.data.app}:${item.data.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push(item.data);
        }
      }
      return { items: sortTodayItems(items), dropped };
    },
  });
}

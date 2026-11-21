// SPDX-License-Identifier: AGPL-3.0-only
// The title and connector words of the assignee match exist twice (#3940, #4089): in modules/meetings/src/assignee-match.ts (the code step, which also keeps the marks) and, folded, in the member's Vy naming check
// in packages/agent (which cannot import a module). Only a comment kept them in sync; this test pins that they are the same words, so a word added on one side fails here until the other side has it. It lives in the
// kernel app because that is the one package that sees both.
import { describe, expect, it } from 'vitest';
import { ASSIGNEE_TITLES as AGENT_TITLES, ASSIGNEE_CONNECTORS as AGENT_CONNECTORS } from '@crove/agent/member-vy';
import { ASSIGNEE_CONNECTORS as MODULE_CONNECTORS, ASSIGNEE_HONORIFICS, plainName } from '@crove/mod-meetings';

const sorted = (words: readonly string[]) => [...words].sort();

describe('the assignee word lists of the agent package and the meetings module', () => {
  it('hold the same titles: the module list, folded, is the agent list', () => {
    expect(sorted(ASSIGNEE_HONORIFICS.map(plainName))).toEqual(sorted(AGENT_TITLES));
  });
  it('hold the same connector words', () => {
    expect(sorted(MODULE_CONNECTORS)).toEqual(sorted(AGENT_CONNECTORS));
  });
  it('have no word twice on either side (a repeated word would hide a missing one in the comparison)', () => {
    for (const list of [ASSIGNEE_HONORIFICS.map(plainName), AGENT_TITLES, MODULE_CONNECTORS, AGENT_CONNECTORS]) expect(new Set(list).size).toBe(list.length);
  });
});

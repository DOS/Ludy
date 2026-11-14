// SPDX-License-Identifier: AGPL-3.0-only
// Vy's brain sits behind three ports (ADR-0049 decision 9, issue #2783): the model, a member's long-term memory and the retrieval of shared org
// knowledge. A member-Vy feature calls the ports, never a vendor client (the boundary test bans their imports), and the permission boundary
// stays in Ludy whatever stands behind a port:
//   - the ports a feature gets are BOUND to the member the run acts for (bindPorts): a feature cannot name another member, so another member's
//     memory is never requested, and a hosted provider's memory is keyed by (org, member) with only that member ever asked;
//   - retrieval is filtered by the member's own rights before anything reaches a provider: the knowledge port is fed by declared queries run in
//     the member's context, never by a provider's own permission logic;
//   - what comes back from a port is private text (PrivateText) and untrusted: it is tainted like a model's output, and a feature never writes
//     it into memory (the member's click does, through the memory commands);
//   - deletion reaches the provider: every memory port has forget, called on removal, the 30-day purge, source deletion, erasure and the org
//     purge; a provider that cannot forget is not eligible (assertEligible).
import { privateText, type PrivateText } from '../private-text.ts';

// Who a run acts for.
export interface MemberRef {
  readonly orgId: string;
  readonly memberUserId: string;
}

// A thing a result or a passage came from (a note, a meeting), for forgetting by source.
export interface SourceRef {
  type: string;
  id: string;
}

export interface MemoryEntry {
  id: string;
  text: PrivateText;
}

export interface KnowledgePassage {
  source: SourceRef;
  text: PrivateText;
}

// The model port: one call, a prompt in, text and the tokens out. The built-in implementation is the OpenAI-compatible endpoint of decision D9,
// reached through metered(); a hosted provider may supply another. The prompt carries untrusted text between fixed delimiters, nothing else.
// The meter key a model call counts under, when the feature is not the default one of the port (the meeting summary): a translation has a key of its own so it never cuts off a
// summary, a transcription or live notes (#3029, #3184).
export type ModelFeature = 'meetings.summary' | 'meetings.translate';
export interface ModelPrompt {
  system: string;
  user: string;
  feature?: ModelFeature | undefined;
}
export interface ModelAnswer {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}
export interface ModelPort {
  generate(who: MemberRef, prompt: ModelPrompt): Promise<ModelAnswer>;
}

// Memory: read, write and forget a member's long-term entries. write is only ever reached from the member's own click (decision 3).
export interface MemoryPort {
  read(who: MemberRef): Promise<MemoryEntry[]>;
  write(who: MemberRef, text: string): Promise<{ id: string }>;
  forget(target: { member: MemberRef } | { source: SourceRef & { orgId: string } }): Promise<void>;
}

// Knowledge: passages of shared org data for a question, from declared queries run in the member's context.
export interface KnowledgePort {
  retrieve(who: MemberRef, question: string): Promise<KnowledgePassage[]>;
}

export interface Ports {
  model: ModelPort;
  memory: MemoryPort;
  knowledge: KnowledgePort;
}

// The ports a feature sees: the member is fixed, so there is no argument through which a feature could ask about someone else.
export interface BoundPorts {
  readonly who: MemberRef;
  generate(prompt: ModelPrompt): Promise<ModelAnswer>;
  readMemory(): Promise<MemoryEntry[]>;
  retrieve(question: string): Promise<KnowledgePassage[]>;
}

export function bindPorts(who: MemberRef, ports: Ports): BoundPorts {
  // The closures use a frozen object of their own, and the caller gets another frozen copy: changing bound.who changes nothing the ports are asked.
  const fixed: MemberRef = Object.freeze({ orgId: who.orgId, memberUserId: who.memberUserId });
  const shown: MemberRef = Object.freeze({ orgId: who.orgId, memberUserId: who.memberUserId });
  return Object.freeze({
    who: shown,
    generate: (prompt: ModelPrompt) => ports.model.generate(fixed, prompt),
    readMemory: () => ports.memory.read(fixed),
    retrieve: (question: string) => ports.knowledge.retrieve(fixed, question),
  });
}

// A provider is eligible only when its memory can forget (decision 9): checked when it is plugged in, not when a member asks to be erased.
export function assertEligible(ports: { memory: { forget?: unknown } }): void {
  if (typeof ports.memory.forget !== 'function') throw new Error('member Vy provider refused: its memory cannot forget');
}

// What removal, the purge, erasure and the org purge call for a member's memory: every provider forgets the member, none is skipped when
// another fails, and a failure is reported once all have been asked.
export async function forgetMember(memories: readonly MemoryPort[], who: MemberRef): Promise<void> {
  const failures: unknown[] = [];
  for (const memory of memories) {
    try {
      await memory.forget({ member: who });
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `member Vy: ${failures.length} provider(s) could not forget the member`);
}

// The built-in knowledge port of a deployment with no declared queries yet: no passages. A richer implementation reads declared queries in the
// member's own context and nothing else.
export const noKnowledge: KnowledgePort = { retrieve: async () => [] };

export { privateText };

// SPDX-License-Identifier: AGPL-3.0-only
// The commands that may consume what Vy wrote for one member into a shared surface (ADR-0049 decision 4, ADR-0047 point 8, #2822). A member's Vy
// results and memory are private to the member; a command that reads them (the table member_vy_result or member_vy_memory, or the queries
// kernel.member_vy.result.get and kernel.member_vy.memory.list) and writes something others can see is a sink, and it is on the list below or it
// does not exist: the invariant test/invariant/member-vy-sinks.test.ts fails for any command outside the Vy kernel namespaces that reads them and is on
// neither list. A sink is a confirm command (a person's click), keeps what it copies tainted and carries a source_ref to the run it came from; the
// invariant checks the command's source for both.

// The sinks. Ships empty: Meetings moves its commands here in its own change (#2941), each with taint and a source_ref to the run.
export const MEMBER_VY_SINKS: readonly string[] = [];

// The consumers that existed before the list did, and are not yet sinks (#2941): each is on this list only until Meetings moves it to MEMBER_VY_SINKS.
// The list can only shrink: the invariant fails for an entry the baseline in the test does not name, for one that is no longer a command, and
// for one that is also a sink. Do not add to it; add a sink, or do not read the private rows.
export const MEMBER_VY_KNOWN_CONSUMERS: readonly string[] = [
  'meetings.summary.copy_result', // #2941
  'meetings.summary.start', // #2941
  'meetings.transcript.copy_result', // #2941
  'meetings.transcript.start', // #2941
];

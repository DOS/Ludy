// SPDX-License-Identifier: AGPL-3.0-only
// What the per-org app gate lets through while an app is off (ADR-0053 section 3, slice b): the definitions that declare runsWhenOff are an
// exact list, so a new one is a visible, reviewed addition (a change to this protected file and its security review), never a quiet one made in
// a module. Each is a keeping duty (retention, shredding, erasure, a leaver's links, the reseal of a sealed key) or a command that only stops
// spend, revokes a link or deletes, or a read for one, of an app; none is of kernel, which the gate never refuses.
// Step 0 of two for slice (c) (#3310): the 16 commands that RECORD the outcome of an irreversible call a job already made (publish, launch,
// activate, e-invoice issue, chat and hook posts) join the list, because a switch-off between the call and its record would lose the outcome and
// a later retry could do the call twice. This file accepts BOTH the list as it is on main and that list with the 16 added; a tests-only PR makes it
// strict once the commands declare runsWhenOff (the runtime and module PR cannot edit this base file).
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { moduleDefinitions } from '../../src/kernel.ts';

const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' });
const { commands, queries } = moduleDefinitions(config);
const named = (defs: readonly { name: string; runsWhenOff?: string }[]) => defs.filter((d) => d.runsWhenOff !== undefined).map((d) => d.name).sort();

describe('definitions that run while their app is off for an org (ADR-0053)', () => {
  // The commands that record the outcome of an external write already made, which join the list in slice (c).
  const RECORDS = [
    'ads.activate.record',
    'ads.launch.record',
    'finance.einvoice.job_files',
    'finance.einvoice.job_record',
    'meetings.chat.record',
    'meetings.hook.record',
    'social.auto_reply.record',
    'social.comment.record',
    'social.edit.record',
    'social.gate.record',
    'social.pin.record',
    'social.playlist.record',
    'social.publish.record',
    'social.remove.record',
    'social.repost.record',
    'social.thread.record',
  ];

  it('are exactly these commands, with or without the records of external writes (step 0)', () => {
    const current = [
      'ads.account.delete_history',
      'ads.account.disable_write',
      'ads.account.disconnect',
      'ads.account.erase',
      'ads.account.forget_write',
      'ads.cap.lower',
      'ads.launch.stop',
      'ads.pause.begin',
      'ads.pause.record',
      'ads.pause_all',
      'ads.token_revoke.record',
      'ads.write.disable',
      'crm.booking_feed.revoke',
      'crm.booking_feed.revoke_for_member',
      'crm.import.expire',
      'crm.quote.revoke_link',
      'finance.marketplace_retention.apply',
      'hr.payroll.employee.erase',
      'meetings.chat.reseal',
      'meetings.media.discard',
      'meetings.media_key.reseal',
      'meetings.meeting.delete',
      'meetings.meeting.owner_delete',
      'meetings.retention.shred',
      'meetings.shred.replay',
      'notes.member_items.purge',
      'notes.trash.empty',
      'social.calendar_feed.revoke',
      'social.chat_alert.reseal',
      'social.links.revoke_for_member',
      'social.report_link.revoke',
      'social.review_link.revoke',
    ].sort();
    const got = named(commands);
    expect([current, [...current, ...RECORDS].sort()]).toContainEqual(got);
  });

  it('are exactly these queries', () => {
    expect(named(queries)).toEqual(['ads.pause.pending', 'finance.marketplace_retention.key', 'meetings.chat.target', 'meetings.media.orphan_keys', 'social.chat_alert.target']);
  });

  it('each give a one-line reason, and none is a kernel definition', () => {
    for (const def of [...commands, ...queries] as Array<{ name: string; runsWhenOff?: string }>) {
      if (def.runsWhenOff === undefined) continue;
      expect(def.runsWhenOff.trim().length, def.name).toBeGreaterThanOrEqual(10);
      expect(def.runsWhenOff, def.name).not.toContain('\n');
      expect(def.name.startsWith('kernel.'), def.name).toBe(false);
    }
  });
});

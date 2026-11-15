// SPDX-License-Identifier: AGPL-3.0-only
// What the per-org app gate lets through while an app is off (ADR-0053 section 3): the definitions that declare runsWhenOff are an exact list,
// so a new one is a visible, reviewed addition, never a quiet one. Each is a keeping duty or a command that only stops, revokes or deletes (retention, shredding, erasure, stopping spend, the revocation of
// a leaver's links, the reseal of a sealed key, or a command that only stops spend, revokes a link or deletes) or a read for one, of an app, and none is of kernel (which the gate never refuses). No command
// declares opensBusyWork yet: slice c adds the first (the Meetings recording start).
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';

const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' });
const { commands, queries } = moduleDefinitions(config);
const named = (defs: readonly { name: string; runsWhenOff?: string }[]) => defs.filter((d) => d.runsWhenOff !== undefined).map((d) => d.name).sort();

describe('definitions that run while their app is off for an org', () => {
  it('are exactly these commands', () => {
    expect(named(commands)).toEqual(
      [
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
      ].sort(),
    );
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

  it('are the only way past the gate: no command opens busy work yet', () => {
    expect((commands as Array<{ name: string; opensBusyWork?: true }>).filter((c) => c.opensBusyWork).map((c) => c.name)).toEqual([]);
  });
});

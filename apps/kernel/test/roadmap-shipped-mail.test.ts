// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests verifying roadmap shipped mail template and notification worker dispatch via Runtime.query (#4400).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from '@ludy/db';
import { generateVaultKey, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';
import { createCredentialBroker } from '../src/credentials.ts';
import { roadmapShippedMailTemplate } from '../src/roadmap-shipped-mail.ts';
import { dispatchRoadmapAnnouncementNotifications } from '../src/projects-roadmap-worker.ts';

function sealRoadmapValue(broker: CredentialBroker, value: string, binding: Parameters<CredentialBroker['seal']>[1]): string {
  const sealed = broker.seal(value, binding);
  return `crove:cs1:${sealed.keyId}:${Buffer.from(sealed.envelope).toString('base64url')}`;
}

describe('roadmapShippedMailTemplate & notification dispatch query wiring (#4400)', () => {
  it('fetches shipped mail data via input.query rather than input.execute and unseals the unsubscribe token', async () => {
    const broker = createCredentialBroker({
      CREDENTIAL_KEY: generateVaultKey(),
      CREDENTIAL_KEY_FILE: undefined,
      CREDENTIAL_KEY_PREVIOUS: undefined,
    });
    const orgId = randomUUID();
    const boardId = randomUUID();
    const announcementId = randomUUID();
    const subscriberId = randomUUID();
    const voterEmailHash = 'a'.repeat(64);
    const unsubToken = `unsub-${'a'.repeat(24)}`;
    const sealedToken = sealRoadmapValue(broker, unsubToken, {
      orgId,
      provider: 'projects.roadmap_subscriber_unsub',
      externalAccountId: `${boardId}:${voterEmailHash}`,
    });

    const calledQueries: Array<{ name: string; input: unknown }> = [];
    const calledExecutes: string[] = [];
    const mail = await roadmapShippedMailTemplate.render({
      orgId,
      broker,
      messageId: randomUUID(),
      subject: null,
      payload: {
        orgSlug: 'acme',
        orgName: 'Cong ty Acme',
        boardId,
        boardSlug: 'roadmap',
        boardTitle: 'Public Roadmap',
        announcementId,
        subscriberId,
        lang: 'vi',
      },
      publicUrl: 'https://ludy.test/',
      inboundAddress: null,
      brand: 'Ludy',
      execute: async (cmd) => {
        calledExecutes.push(cmd);
        return null as never;
      },
      query: async (name, input) => {
        calledQueries.push({ name, input });
        return {
          title: 'Xuat bao cao CSV',
          bodyMd: '## Diem moi\n- Da phat hanh tinh nang CSV',
          linkedItems: [{ id: randomUUID(), publicTitle: 'CSV export' }],
          voterEmailHash,
          unsubTokenSealed: sealedToken,
        } as never;
      },
    });

    expect(calledExecutes).toEqual([]);
    expect(calledQueries).toEqual([
      { name: 'projects.roadmap.shipped_mail_data', input: { announcementId, subscriberId } },
    ]);
    expect(mail).not.toBeNull();
    expect(mail!.text).toContain('Xuat bao cao CSV');
    expect(mail!.text).toContain(`https://ludy.test/-/roadmap/acme/roadmap#unsubscribe=${unsubToken}`);
  });

  it('resolves announcement_from_event via deps.runtime.query rather than deps.runtime.execute', async () => {
    const broker = createCredentialBroker({
      CREDENTIAL_KEY: generateVaultKey(),
      CREDENTIAL_KEY_FILE: undefined,
      CREDENTIAL_KEY_PREVIOUS: undefined,
    });
    const queries: string[] = [];
    const executes: string[] = [];
    const fakeRuntime = {
      appOn: async () => true,
      query: async (name: string) => {
        queries.push(name);
        return null;
      },
      execute: async (name: string) => {
        executes.push(name);
        return null;
      },
    } as unknown as Runtime;

    const result = await dispatchRoadmapAnnouncementNotifications(
      { workerDb: {} as Db, runtime: fakeRuntime, broker },
      { orgId: randomUUID(), eventId: randomUUID() },
    );
    expect(result).toEqual({ queued: 0, skipped: 0, off: false });
    expect(queries).toEqual(['projects.roadmap.announcement_from_event']);
    expect(executes).toEqual([]);
  });
});

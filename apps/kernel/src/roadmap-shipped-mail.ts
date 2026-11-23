// SPDX-License-Identifier: AGPL-3.0-only
// MailTemplate adapter for Projects Public Roadmap shipped changelog notifications (#4400, ADR-0034, ADR-0057).
// Fetches sanitized announcement content and seals unsubscribe tokens strictly via CredentialBroker at send time so
// neither plaintext emails nor raw unsubscribe tokens rest in mail_message.payload.
import { zRoadmapShippedMailPayload } from '@ludy/kernel-contract';
import { renderRoadmapShippedMail } from '@ludy/mod-projects';
import type { MailTemplate } from './mail-queue.ts';
import { openSealedRoadmapValue } from './projects-roadmap-worker.ts';

export const roadmapShippedMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.broker || input.broker.id === 'none' || !input.orgId || !input.query) return null;
    const parsed = zRoadmapShippedMailPayload.parse(input.payload);
    const data = await input.query<{
      title: string;
      bodyMd: string;
      linkedItems: Array<{ id: string; publicTitle: string }>;
      voterEmailHash: string;
      unsubTokenSealed: string;
    } | null>('projects.roadmap.shipped_mail_data', {
      announcementId: parsed.announcementId,
      subscriberId: parsed.subscriberId,
    });
    if (!data) return null;

    const unsubToken = openSealedRoadmapValue(input.broker, data.unsubTokenSealed, {
      orgId: input.orgId,
      provider: 'projects.roadmap_subscriber_unsub',
      externalAccountId: `${parsed.boardId}:${data.voterEmailHash}`,
    });
    if (!unsubToken) return null;

    return renderRoadmapShippedMail(parsed, {
      brand: input.brand,
      publicUrl: input.publicUrl,
      announcementTitle: data.title,
      bodyMd: data.bodyMd,
      linkedItems: data.linkedItems,
      unsubToken,
    });
  },
};

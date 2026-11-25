// SPDX-License-Identifier: AGPL-3.0-only
// The link to the PUBLISHED minutes of a meeting for people outside the org (#4822, owner decision 2026-11-25). The recorder makes it, copies it once (the token is shown once and kept only as a hash),
// and can revoke it; it opens a read-only page with the published summary, decisions and action items, never the transcript, the recording, the chapters or a draft, for at most 30 days.
// The org's owner or admin switches the whole feature on or off (off by default).
import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const zId = z.string().regex(UUID);

// 32 random bytes, base64url without padding: what the page sends and the database resolves.
export const MINUTES_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// The page of the link (a route of the app); the token is in the fragment, never in a path or query that a log could keep.
export const MINUTES_PAGE_PATH = '/-/minutes';
// How long a link lives, and how many live ones a meeting keeps.
export const MINUTES_LINK_DAYS = 30;
export const MINUTES_LINKS_MAX = 10;

export const zMinutesLinkCreate = z.strictObject({ meetingId: zId });
export const zMinutesLinkCreated = z.strictObject({ linkId: zId, token: z.string().regex(MINUTES_TOKEN_PATTERN), expiresAt: z.string(), path: z.string() });
export type MinutesLinkCreated = z.infer<typeof zMinutesLinkCreated>;

export const zMinutesLinkRevoke = z.strictObject({ meetingId: zId, linkId: zId });
export const zMinutesLinkRevoked = z.strictObject({ linkId: zId, revoked: z.literal(true) });
export type MinutesLinkRevoked = z.infer<typeof zMinutesLinkRevoked>;

export const zMinutesLinkList = z.strictObject({ meetingId: zId });
// A link as the recorder sees it: no token (it is not kept), only when it was made, when it ends and how often it was opened.
export const MINUTES_LINK_STATES = ['live', 'expired', 'revoked'] as const;
export const zMinutesLinkItem = z.strictObject({
  id: zId,
  state: z.enum(MINUTES_LINK_STATES),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  views: z.number().int().min(0),
  firstViewedAt: z.string().nullable(),
});
export type MinutesLinkItem = z.infer<typeof zMinutesLinkItem>;
export const zMinutesLinkItems = z.strictObject({ enabled: z.boolean(), items: z.array(zMinutesLinkItem) });
export type MinutesLinkItems = z.infer<typeof zMinutesLinkItems>;

// The org setting: every member reads it (the meeting page shows the panel only while it is on), an owner or admin changes it.
export const zMinutesLinkSwitch = z.strictObject({ enabled: z.boolean() });
export type MinutesLinkSwitch = z.infer<typeof zMinutesLinkSwitch>;
export const zMinutesLinkSwitchGet = z.strictObject({});

// What the public page shows: the published minutes and nothing else. A strict object at every level, so a transcript, a draft or an attendee's detail cannot ride in any field.
export const zMinutesPage = z.strictObject({
  title: z.string().max(300),
  startedAt: z.string().nullable(),
  publishedAt: z.string(),
  summary: z.string().max(8000),
  decisions: z.array(z.string().max(1000)).max(50),
  actionItems: z.array(z.strictObject({ text: z.string().max(300), owner: z.string().max(200), due: z.string().nullable() })).max(100),
  // The name of the org that shared it, so the reader knows who from.
  orgName: z.string().max(200),
});
export type MinutesPage = z.infer<typeof zMinutesPage>;

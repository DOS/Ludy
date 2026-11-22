// SPDX-License-Identifier: AGPL-3.0-only
// Public Roadmap & Ideas portal schemas and RPC contracts (#4399, ADR-0057, docs/plan/projects-public-roadmap.md).
import { z } from 'zod';
import { zId } from './schemas.ts';

export const ROADMAP_PAGE_PREFIX = '/-/roadmap';
export const ROADMAP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const ROADMAP_TITLE_MAX = 120;
export const ROADMAP_DESCRIPTION_MAX = 1000;
export const ROADMAP_ITEM_TITLE_MAX = 200;
export const ROADMAP_ITEM_SUMMARY_MAX = 4000;
export const ROADMAP_ITEM_CATEGORY_MAX = 60;
export const ROADMAP_DISPLAY_NAME_MAX = 80;
export const ROADMAP_ANNOUNCEMENT_TITLE_MAX = 200;
export const ROADMAP_ANNOUNCEMENT_BODY_MAX = 12000;
export const ROADMAP_ANNOUNCEMENT_LINKED_ITEMS_MAX = 20;
export const ROADMAP_ANNOUNCEMENTS_LIMIT = 100;
export const ROADMAP_EMBED_ORIGINS_MAX = 20;
export const ROADMAP_BOARDS_LIMIT = 50;
export const ROADMAP_ITEMS_LIMIT = 200;
export const ROADMAP_OTP_CODE_PATTERN = /^\d{6}$/;
export const ROADMAP_VOTER_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
export const ROADMAP_VOTER_HEADER = 'x-ludy-voter-token';
export const ROADMAP_EMBED_ORIGIN_RE =
  /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$/;

export const ROADMAP_ITEM_SOURCES = ['internal', 'public_submission'] as const;
export type RoadmapItemSource = (typeof ROADMAP_ITEM_SOURCES)[number];
export const zRoadmapItemSource = z.enum(ROADMAP_ITEM_SOURCES);

export const ROADMAP_ITEM_MODERATION_STATUSES = ['pending', 'published', 'merged', 'archived'] as const;
export type RoadmapItemModerationStatus = (typeof ROADMAP_ITEM_MODERATION_STATUSES)[number];
export const zRoadmapItemModerationStatus = z.enum(ROADMAP_ITEM_MODERATION_STATUSES);

export const ROADMAP_ITEM_STAGES = ['under_review', 'planned', 'in_progress', 'shipped'] as const;
export type RoadmapItemStage = (typeof ROADMAP_ITEM_STAGES)[number];
export const zRoadmapItemStage = z.enum(ROADMAP_ITEM_STAGES);

export const ROADMAP_BOARD_STAGES = ['planned', 'in_progress', 'shipped'] as const;
export type RoadmapBoardStage = (typeof ROADMAP_BOARD_STAGES)[number];

export const ROADMAP_ANNOUNCEMENT_STATUSES = ['draft', 'published'] as const;
export type RoadmapAnnouncementStatus = (typeof ROADMAP_ANNOUNCEMENT_STATUSES)[number];
export const zRoadmapAnnouncementStatus = z.enum(ROADMAP_ANNOUNCEMENT_STATUSES);

/** Validates and normalizes an HTTPS-only embed origin (no wildcards, no paths, no queries, no credentials). */
export function normalizeRoadmapEmbedOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\s*?#]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null;
  const origin = parsed.origin.toLowerCase();
  if (origin !== trimmed.toLowerCase()) return null;
  if (!ROADMAP_EMBED_ORIGIN_RE.test(origin)) return null;
  if (parsed.port !== '') {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  return origin;
}

export const zRoadmapSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(ROADMAP_SLUG_PATTERN, 'Slug must contain 1..63 lowercase alphanumeric or hyphen characters');

export const zRoadmapEmbedOrigin = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizeRoadmapEmbedOrigin(value);
    if (!normalized) {
      ctx.addIssue({
        code: 'custom',
        message: 'Allowed embed origin must be an exact https://<host>[:port] origin',
      });
      return z.NEVER;
    }
    return normalized;
  });

const zCleanLine = (max: number) =>
  z
    .string()
    .trim()
    .refine((v) => !v.includes('\u0000'), 'Control character NUL is not allowed')
    .pipe(z.string().min(1).max(max));

const zOptionalCleanText = (max: number) =>
  z
    .string()
    .trim()
    .refine((v) => !v.includes('\u0000'), 'Control character NUL is not allowed')
    .pipe(z.string().max(max))
    .nullable()
    .optional();

// ---------------------------------------------------------------------------
// Public API contracts (zero-login read + email OTP + ideas/votes)
// ---------------------------------------------------------------------------

export const zRoadmapPublicItem = z.strictObject({
  id: zId,
  stage: zRoadmapItemStage,
  category: z.string().nullable(),
  publicTitle: z.string(),
  publicSummary: z.string().nullable(),
  voteCount: z.number().int().nonnegative(),
  tainted: z.boolean(),
  submitterDisplayName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  viewerHasVoted: z.boolean(),
});
export type RoadmapPublicItem = z.infer<typeof zRoadmapPublicItem>;

export const zRoadmapPublicBoardInfo = z.strictObject({
  slug: z.string(),
  orgSlug: z.string(),
  orgName: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  allowSubmissions: z.boolean(),
  allowVoting: z.boolean(),
  requireModeration: z.boolean(),
});
export type RoadmapPublicBoardInfo = z.infer<typeof zRoadmapPublicBoardInfo>;

export const zRoadmapPublicAnnouncementLinkedItem = z.strictObject({
  id: zId,
  publicTitle: z.string(),
  stage: zRoadmapItemStage,
  category: z.string().nullable(),
});
export type RoadmapPublicAnnouncementLinkedItem = z.infer<typeof zRoadmapPublicAnnouncementLinkedItem>;

export const zRoadmapPublicAnnouncement = z.strictObject({
  id: zId,
  title: z.string(),
  bodyMd: z.string(),
  publishedAt: z.string(),
  linkedItems: z.array(zRoadmapPublicAnnouncementLinkedItem),
});
export type RoadmapPublicAnnouncement = z.infer<typeof zRoadmapPublicAnnouncement>;

export const zRoadmapPublicViewResult = z.strictObject({
  board: zRoadmapPublicBoardInfo,
  viewer: z.strictObject({
    verified: z.boolean(),
    maskedEmail: z.string().nullable(),
    notifyOnShip: z.boolean(),
  }),
  items: z.array(zRoadmapPublicItem),
  announcements: z.array(zRoadmapPublicAnnouncement),
});
export type RoadmapPublicViewResult = z.infer<typeof zRoadmapPublicViewResult>;

export const zRoadmapPublicOtpRequestInput = z.strictObject({
  email: z.string().trim().min(3).max(254),
});
export type RoadmapPublicOtpRequestInput = z.infer<typeof zRoadmapPublicOtpRequestInput>;

export const zRoadmapPublicOtpRequestResult = z.strictObject({
  sent: z.boolean(),
  expiresInMinutes: z.number().int().positive(),
  maskedEmail: z.string(),
});
export type RoadmapPublicOtpRequestResult = z.infer<typeof zRoadmapPublicOtpRequestResult>;

export const zRoadmapPublicOtpVerifyInput = z.strictObject({
  email: z.string().trim().min(3).max(254),
  code: z.string().trim().regex(ROADMAP_OTP_CODE_PATTERN, 'OTP code must be 6 digits'),
  notifyOnShip: z.boolean().optional(),
});
export type RoadmapPublicOtpVerifyInput = z.infer<typeof zRoadmapPublicOtpVerifyInput>;

export const zRoadmapPublicOtpVerifyResult = z.strictObject({
  ok: z.boolean(),
  locked: z.boolean(),
  attemptsRemaining: z.number().int().nonnegative(),
  expired: z.boolean().optional(),
  notReady: z.boolean().optional(),
  voterToken: z.string().optional(),
  maskedEmail: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type RoadmapPublicOtpVerifyResult = z.infer<typeof zRoadmapPublicOtpVerifyResult>;

export const zRoadmapPublicSubmitIdeaInput = z.strictObject({
  title: zCleanLine(ROADMAP_ITEM_TITLE_MAX),
  summary: zOptionalCleanText(ROADMAP_ITEM_SUMMARY_MAX),
  category: zOptionalCleanText(ROADMAP_ITEM_CATEGORY_MAX),
  displayName: zOptionalCleanText(ROADMAP_DISPLAY_NAME_MAX),
});
export type RoadmapPublicSubmitIdeaInput = z.input<typeof zRoadmapPublicSubmitIdeaInput>;

export const zRoadmapPublicSubmitIdeaResult = z.strictObject({
  item: zRoadmapPublicItem.extend({
    moderationStatus: zRoadmapItemModerationStatus,
  }),
});
export type RoadmapPublicSubmitIdeaResult = z.infer<typeof zRoadmapPublicSubmitIdeaResult>;

export const zRoadmapPublicVoteInput = z
  .strictObject({
    itemId: zId.optional(),
    action: z.enum(['vote', 'unvote', 'toggle', 'subscribe', 'unsubscribe']).default('toggle'),
    notifyOnShip: z.boolean().optional(),
    unsubscribeToken: z.string().trim().min(16).max(256).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'unsubscribe') {
      if (!v.unsubscribeToken) {
        ctx.addIssue({ code: 'custom', path: ['unsubscribeToken'], message: 'unsubscribeToken is required' });
      }
      return;
    }
    if (v.action === 'subscribe') {
      if (typeof v.notifyOnShip !== 'boolean') {
        ctx.addIssue({ code: 'custom', path: ['notifyOnShip'], message: 'notifyOnShip is required' });
      }
      return;
    }
    if (!v.itemId) {
      ctx.addIssue({ code: 'custom', path: ['itemId'], message: 'itemId is required' });
    }
  });
export type RoadmapPublicVoteInput = z.input<typeof zRoadmapPublicVoteInput>;

export const zRoadmapPublicVoteResult = z.strictObject({
  itemId: zId.optional(),
  voted: z.boolean().optional(),
  voteCount: z.number().int().nonnegative().optional(),
  notifyOnShip: z.boolean().optional(),
  unsubscribed: z.boolean().optional(),
});
export type RoadmapPublicVoteResult = z.infer<typeof zRoadmapPublicVoteResult>;

// ---------------------------------------------------------------------------
// Internal RPC contracts (org members + owners/admins)
// ---------------------------------------------------------------------------

export const zRoadmapBoardSummary = z.strictObject({
  id: zId,
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  projectId: zId.nullable(),
  projectName: z.string().nullable(),
  allowSubmissions: z.boolean(),
  allowVoting: z.boolean(),
  requireModeration: z.boolean(),
  embedAllowedOrigins: z.array(z.string()),
  pendingCount: z.number().int().nonnegative(),
  publishedCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RoadmapBoardSummary = z.infer<typeof zRoadmapBoardSummary>;

export const zRoadmapAdminItem = z.strictObject({
  id: zId,
  boardId: zId,
  linkedTaskId: zId.nullable(),
  linkedTaskStatus: z.string().nullable(),
  linkedProjectId: zId.nullable(),
  linkedProjectName: z.string().nullable(),
  source: zRoadmapItemSource,
  moderationStatus: zRoadmapItemModerationStatus,
  mergedIntoItemId: zId.nullable(),
  stage: zRoadmapItemStage,
  category: z.string().nullable(),
  publicTitle: z.string(),
  publicSummary: z.string().nullable(),
  voteCount: z.number().int().nonnegative(),
  tainted: z.boolean(),
  submitterDisplayName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RoadmapAdminItem = z.infer<typeof zRoadmapAdminItem>;

export const zRoadmapBoardListResult = z.strictObject({
  boards: z.array(zRoadmapBoardSummary),
  orgSlug: z.string(),
  projects: z.array(
    z.strictObject({
      id: zId,
      name: z.string(),
      status: z.string(),
    }),
  ),
  seats: z.array(
    z.strictObject({
      positionId: zId,
      title: z.string(),
      holderName: z.string(),
      holderRole: z.string(),
    }),
  ),
  canWrite: z.boolean(),
  canManageBoard: z.boolean(),
});
export type RoadmapBoardListResult = z.infer<typeof zRoadmapBoardListResult>;

export const zRoadmapAnnouncementLinkedItem = z.strictObject({
  id: zId,
  publicTitle: z.string(),
  stage: zRoadmapItemStage,
  moderationStatus: zRoadmapItemModerationStatus,
  voteCount: z.number().int().nonnegative(),
});
export type RoadmapAnnouncementLinkedItem = z.infer<typeof zRoadmapAnnouncementLinkedItem>;

export const zRoadmapAnnouncement = z.strictObject({
  id: zId,
  boardId: zId,
  title: z.string(),
  bodyMd: z.string(),
  status: zRoadmapAnnouncementStatus,
  publishedAt: z.string().nullable(),
  linkedItemIds: z.array(zId),
  linkedItems: z.array(zRoadmapAnnouncementLinkedItem),
  notificationsSentAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RoadmapAnnouncement = z.infer<typeof zRoadmapAnnouncement>;

export const zRoadmapBoardDetailInput = z.strictObject({
  boardId: zId,
});
export type RoadmapBoardDetailInput = z.infer<typeof zRoadmapBoardDetailInput>;

export const zRoadmapBoardDetailResult = z.strictObject({
  board: zRoadmapBoardSummary,
  items: z.array(zRoadmapAdminItem),
  announcements: z.array(zRoadmapAnnouncement),
  activeSubscriberCount: z.number().int().nonnegative(),
  canWrite: z.boolean(),
  canManageBoard: z.boolean(),
});
export type RoadmapBoardDetailResult = z.infer<typeof zRoadmapBoardDetailResult>;

export const zRoadmapBoardCreateInput = z.strictObject({
  slug: zRoadmapSlug.optional(),
  title: zCleanLine(ROADMAP_TITLE_MAX),
  description: zOptionalCleanText(ROADMAP_DESCRIPTION_MAX),
  projectId: zId.nullable().optional(),
  enabled: z.boolean().optional(),
  allowSubmissions: z.boolean().optional(),
  allowVoting: z.boolean().optional(),
  requireModeration: z.boolean().optional(),
  embedAllowedOrigins: z.array(zRoadmapEmbedOrigin).max(ROADMAP_EMBED_ORIGINS_MAX).optional(),
});
export type RoadmapBoardCreateInput = z.input<typeof zRoadmapBoardCreateInput>;

export const zRoadmapBoardUpdateInput = z.strictObject({
  boardId: zId,
  slug: zRoadmapSlug.optional(),
  title: zCleanLine(ROADMAP_TITLE_MAX).optional(),
  description: zOptionalCleanText(ROADMAP_DESCRIPTION_MAX),
  projectId: zId.nullable().optional(),
  enabled: z.boolean().optional(),
  allowSubmissions: z.boolean().optional(),
  allowVoting: z.boolean().optional(),
  requireModeration: z.boolean().optional(),
  embedAllowedOrigins: z.array(zRoadmapEmbedOrigin).max(ROADMAP_EMBED_ORIGINS_MAX).optional(),
});
export type RoadmapBoardUpdateInput = z.input<typeof zRoadmapBoardUpdateInput>;

export const zRoadmapItemCreateInput = z.strictObject({
  boardId: zId,
  publicTitle: zCleanLine(ROADMAP_ITEM_TITLE_MAX),
  publicSummary: zOptionalCleanText(ROADMAP_ITEM_SUMMARY_MAX),
  category: zOptionalCleanText(ROADMAP_ITEM_CATEGORY_MAX),
  stage: zRoadmapItemStage.optional(),
  moderationStatus: z.enum(['pending', 'published']).optional(),
});
export type RoadmapItemCreateInput = z.input<typeof zRoadmapItemCreateInput>;

export const zRoadmapItemModerateInput = z.strictObject({
  itemId: zId,
  moderationStatus: z.enum(['pending', 'published', 'archived']).optional(),
  stage: zRoadmapItemStage.optional(),
  publicTitle: zCleanLine(ROADMAP_ITEM_TITLE_MAX).optional(),
  publicSummary: zOptionalCleanText(ROADMAP_ITEM_SUMMARY_MAX),
  category: zOptionalCleanText(ROADMAP_ITEM_CATEGORY_MAX),
});
export type RoadmapItemModerateInput = z.input<typeof zRoadmapItemModerateInput>;

export const zRoadmapItemMergeInput = z.strictObject({
  sourceItemId: zId,
  targetItemId: zId,
});
export type RoadmapItemMergeInput = z.infer<typeof zRoadmapItemMergeInput>;

export const zRoadmapItemConvertToTaskInput = z.strictObject({
  itemId: zId,
  projectId: zId.optional(),
  title: zCleanLine(300).optional(),
  assigneePositionId: zId.nullable().optional(),
});
export type RoadmapItemConvertToTaskInput = z.input<typeof zRoadmapItemConvertToTaskInput>;

export const zRoadmapItemSyncStageInput = z.strictObject({
  itemId: zId,
  stage: zRoadmapItemStage.optional(),
});
export type RoadmapItemSyncStageInput = z.input<typeof zRoadmapItemSyncStageInput>;

export const zRoadmapAnnouncementCreateInput = z.strictObject({
  boardId: zId,
  title: zCleanLine(ROADMAP_ANNOUNCEMENT_TITLE_MAX),
  bodyMd: zCleanLine(ROADMAP_ANNOUNCEMENT_BODY_MAX),
  linkedItemIds: z.array(zId).max(ROADMAP_ANNOUNCEMENT_LINKED_ITEMS_MAX).optional(),
});
export type RoadmapAnnouncementCreateInput = z.input<typeof zRoadmapAnnouncementCreateInput>;

export const zRoadmapAnnouncementUpdateInput = z.strictObject({
  announcementId: zId,
  title: zCleanLine(ROADMAP_ANNOUNCEMENT_TITLE_MAX).optional(),
  bodyMd: zCleanLine(ROADMAP_ANNOUNCEMENT_BODY_MAX).optional(),
  linkedItemIds: z.array(zId).max(ROADMAP_ANNOUNCEMENT_LINKED_ITEMS_MAX).optional(),
});
export type RoadmapAnnouncementUpdateInput = z.input<typeof zRoadmapAnnouncementUpdateInput>;

export const zRoadmapAnnouncementPublishInput = z.strictObject({
  announcementId: zId,
});
export type RoadmapAnnouncementPublishInput = z.infer<typeof zRoadmapAnnouncementPublishInput>;

export const zRoadmapAnnouncementDeleteInput = z.strictObject({
  announcementId: zId,
});
export type RoadmapAnnouncementDeleteInput = z.infer<typeof zRoadmapAnnouncementDeleteInput>;

export const zRoadmapAnnouncementSendNotificationsInput = z.strictObject({
  announcementId: zId,
});
export type RoadmapAnnouncementSendNotificationsInput = z.infer<typeof zRoadmapAnnouncementSendNotificationsInput>;

export const zRoadmapAnnouncementSendNotificationsResult = z.strictObject({
  announcement: zRoadmapAnnouncement,
  eligibleCount: z.number().int().nonnegative(),
  queuedDispatch: z.boolean(),
});
export type RoadmapAnnouncementSendNotificationsResult = z.infer<typeof zRoadmapAnnouncementSendNotificationsResult>;

// Vy AI-native Slice 2 schemas (#4400)
export const ROADMAP_AI_STATES = ['used', 'off', 'paused', 'budget', 'busy', 'refused', 'empty', 'failed'] as const;
export type RoadmapAiState = (typeof ROADMAP_AI_STATES)[number];

export const zRoadmapDedupeInput = z.strictObject({
  boardId: zId,
  language: z.enum(['vi', 'en']).optional(),
});
export type RoadmapDedupeInput = z.input<typeof zRoadmapDedupeInput>;

export const zRoadmapDedupeSuggestion = z.strictObject({
  sourceItemId: zId,
  targetItemId: zId,
  reason: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type RoadmapDedupeSuggestion = z.infer<typeof zRoadmapDedupeSuggestion>;

export const zRoadmapDedupeResult = z.strictObject({
  ai: z.enum(ROADMAP_AI_STATES),
  suggestions: z.array(zRoadmapDedupeSuggestion),
  inspectedCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type RoadmapDedupeResult = z.infer<typeof zRoadmapDedupeResult>;

export const zRoadmapChangelogDraftInput = z.strictObject({
  boardId: zId,
  itemIds: z.array(zId).min(1).max(ROADMAP_ANNOUNCEMENT_LINKED_ITEMS_MAX),
  language: z.enum(['vi', 'en']).optional(),
});
export type RoadmapChangelogDraftInput = z.input<typeof zRoadmapChangelogDraftInput>;

export const zRoadmapChangelogDraftResult = z.strictObject({
  ai: z.enum(ROADMAP_AI_STATES),
  title: z.string().nullable(),
  bodyMd: z.string().nullable(),
});
export type RoadmapChangelogDraftResult = z.infer<typeof zRoadmapChangelogDraftResult>;

export const ROADMAP_MAIL_SOURCE = 'projects.roadmap.otp_request';
export const ROADMAP_OTP_MAIL_TEMPLATE = 'projects.roadmap_otp';
export const ROADMAP_SHIPPED_MAIL_SOURCE = 'projects.roadmap.announcement.send_notifications';
export const ROADMAP_SHIPPED_MAIL_TEMPLATE = 'projects.roadmap_shipped';

export const zRoadmapOtpMailPayload = z.strictObject({
  lang: z.enum(['vi', 'en']).default('vi'),
  orgName: z.string().trim().min(1).max(200),
  boardId: zId,
  boardTitle: z.string().trim().min(1).max(ROADMAP_TITLE_MAX),
  otpId: zId,
  expiresAt: z.string().min(1).max(80),
});
export type RoadmapOtpMailPayload = z.infer<typeof zRoadmapOtpMailPayload>;

export const zRoadmapShippedMailPayload = z.strictObject({
  lang: z.enum(['vi', 'en']).default('vi'),
  orgName: z.string().trim().min(1).max(200),
  orgSlug: z.string().trim().min(1).max(63),
  boardId: zId,
  boardSlug: z.string().trim().min(1).max(63),
  boardTitle: z.string().trim().min(1).max(ROADMAP_TITLE_MAX),
  announcementId: zId,
  subscriberId: zId,
});
export type RoadmapShippedMailPayload = z.infer<typeof zRoadmapShippedMailPayload>;

// Browser push for Social notifications (#1238): the notifications someone must act on (the mailed kinds) also reach the devices a member turned push on, as Planable pushes approvals.
// The subscriptions are the kernel's (ludy_kernel.push_subscription, kernel.push.*; #3736): one per member and browser, shared by every app, so a member turns push on once in the
// notification settings and Social's notices and the kernel's both reach that device. What stays here is what only Social knows: which of its notices are pushed, the one line for
// each kind and the app path it opens (social.push.targets, system).
//
// Sending is the worker's: after social.notification.dispatch commits, it queues one job per new notification of a pushed kind, reads what to send with social.push.targets, encrypts
// and posts it to each endpoint itself, and records the answers with kernel.push.record (system). The push carries no post text: a short line naming the kind and the app path that opens it.
// A deployment without VAPID keys offers no push and the worker queues nothing (the API and the worker check the keys; these commands do not).
import { z } from 'zod';
import { zId } from '@ludy/kernel-contract';
import type { SocialNotificationKind } from '@ludy/db';
import { pushOrgSlug, pushSubscriptionsOf, type PushTargets } from '@ludy/kernel';
import { defineQuery } from '@ludy/kernel-runtime';
import { PUSHED_KINDS, notificationPath } from './notifications.ts';

// The one line a push shows for its kind; never the post's text or a channel's name.
export function pushLine(kind: SocialNotificationKind, detail: Readonly<Record<string, unknown>>): string {
  switch (kind) {
    case 'review_requested':
      return 'Có bài đang chờ bạn duyệt';
    case 'decided':
      return detail.decision === 'approved' ? 'Bài của bạn đã được duyệt' : detail.decision === 'rejected' ? 'Bài của bạn bị từ chối' : 'Người duyệt đề nghị sửa bài của bạn';
    case 'failed':
      if (detail.late && detail.count) return `${String(detail.count)} bài đăng không thành công vì đã quá giờ hẹn`;
      return detail.removal === 'scheduled' ? 'Chưa tự gỡ được một bài đã hẹn giờ gỡ' : 'Một bài đăng không thành công';
    case 'needs_attention':
      return 'Một bài đăng cần bạn xử lý';
    case 'channel_expired':
      return 'Một kênh cần kết nối lại';
    case 'mention':
      return 'Bạn được nhắc đến trong một bình luận';
    case 'queue_low':
      return 'Hàng đợi của một kênh sắp hết bài';
    case 'post_outperforming':
      return 'Một bài đang được tương tác nhiều hơn hẳn thường lệ';
    // An assignment and its due date (#1359).
    case 'assigned':
      return typeof detail.count === 'string' && /^\d{1,3}$/.test(detail.count) ? `Bạn được giao ${detail.count} bài mới` : 'Bạn được giao một bài mới';
    case 'assignment_due':
      return detail.stage === 'overdue' ? 'Một bài được giao cho bạn đã quá hạn' : 'Một bài được giao cho bạn sắp đến hạn';
    default:
      return 'Bạn có thông báo mới';
  }
}

// For the worker's push job: the notification's line and path and its member's subscriptions, or null when nothing
// is to be sent (a kind that is not pushed, a notification gone or read, an org no longer active, a member who left or
// whose account is disabled: member_emails leaves those out).
export const pushTargets = defineQuery({
  name: 'social.push.targets',
  input: z.strictObject({ notificationId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<PushTargets | null> => {
    const n = await ctx.trx
      .selectFrom('ludy_social.notification')
      .select(['user_id', 'kind', 'post_id', 'connection_id', 'detail', 'read_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.notificationId)
      .executeTakeFirst();
    if (!n || n.read_at !== null || !PUSHED_KINDS.has(n.kind)) return null;
    // An org that is active and a member now, with an account that is not disabled.
    const slug = await pushOrgSlug(ctx, n.user_id);
    if (slug === null) return null;
    const subscriptions = await pushSubscriptionsOf(ctx, n.user_id);
    if (subscriptions.length === 0) return null;
    const detail = n.detail && typeof n.detail === 'object' ? (n.detail as Record<string, unknown>) : {};
    return {
      subscriptions,
      line: pushLine(n.kind, detail),
      path: notificationPath(slug, n.kind, n.post_id, n.connection_id),
      tag: `${n.kind}:${n.post_id ?? n.connection_id ?? input.notificationId}`,
    };
  },
});

export const pushQueries = [pushTargets];

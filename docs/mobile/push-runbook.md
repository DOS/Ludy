# Mobile native push & Cloud relay hand-off

This document describes Ludy's open native push sender interface, device registration lifecycle, self-hosted defaults, and the Crove Cloud relay hand-off contract (Issue [#4883](https://github.com/DOS/Ludy/issues/4883), [ADR-0059](../adr/0059-ludy-mobile-and-desktop-client-roadmap.md)).

## Scope and open-source boundary

Ludy's open-source repository ships the **open native-push interface, device registration tables/RPCs, and content-free worker dispatch**, with **no Crove Cloud vendor SDKs and no Apple APNs or Google FCM keys or certificates**.

- **Self-hosted deployments:** `defaultAdapters` leaves `KernelAdapters.nativePush` unset (`null`). When unset:
  - `notifications.nativePush.status` returns `{ enabled: false, registered: false, devices: [] }`.
  - `notifications.nativePush.register` refuses writes with HTTP `404` (`NATIVE_PUSH_DISABLED`).
  - The worker skips the `kernel-native-push` queue and sweep timer, making zero outbound native-push calls.
  - Self-hosted mobile Settings hides or explains the native push toggle when `enabled === false` (self-hosters continue to use VAPID Web Push via `apps/kernel/src/web-push.ts` and the web app).
- **Crove Cloud (or custom enterprise adapter):** The private deployment layer supplies an implementation of `NativePushSender` through `KernelAdapters.nativePush`.

## Open sender interface & Cloud relay hand-off contract

Defined in [`apps/kernel/src/native-push.ts`](../../apps/kernel/src/native-push.ts):

```ts
export type NativePushOutcome = 'sent' | 'gone' | 'failed';

export interface NativePushTarget {
  readonly platform: 'apns' | 'fcm';
  readonly token: string;
}

export interface NativePushPayload {
  readonly kind: 'kernel.conversation_new' | 'kernel.approval_waiting';
  readonly title: string;
  readonly orgSlug: string;
  readonly subjectId: string | null;
  readonly path: string;
}

export interface NativePushSender {
  readonly id: string;
  send(target: NativePushTarget, payload: NativePushPayload): Promise<NativePushOutcome>;
}
```

### Strictly content-free payloads

Every payload handed off by `runNativePushJob` contains static copy, trigger kind, workspace slug, and deep-link id/path only, never customer names, message text, monetary amounts, or proposal titles:

| Trigger kind | Static `title` | Deep-link `path` |
| --- | --- | --- |
| `kernel.conversation_new` | `Có 1 hội thoại mới` | `/o/<orgSlug>/social/inbox?c=<subjectId>` (or `?status=new` when `subjectId` is null) |
| `kernel.approval_waiting` | `Có 1 đề xuất cần duyệt` | `/o/<orgSlug>/inbox/<subjectId>` (or `/o/<orgSlug>/inbox` when `subjectId` is null) |

### Outcome semantics

- `'sent'`: Relay accepted the notification; resets `failure_count = 0` and stamps `last_used_at`.
- `'gone'`: Device token is permanently invalid or unregistered (for example APNs `410 Unregistered` or FCM `UNREGISTERED`); kernel deletes the row immediately.
- `'failed'`: Transient relay/provider failure; kernel increments `failure_count` and automatically deletes the device once `failure_count >= 10` (`NATIVE_PUSH_FAILURE_LIMIT`).

## Device registration & revocation lifecycle

1. **Registration (`notifications.nativePush.register`):**
   - Requires an active signed-in user session (`ctx.actor.sessionId` UUID from verified auth claims, never supplied in client input) inside an active org (`tenant_member`).
   - Enforces at most 10 active device registrations per member per org (`NATIVE_PUSH_DEVICE_LIMIT = 10`).
   - `token` is classified `sensitive` in `packages/kernel/src/manifest.ts`: never returned by `notifications.nativePush.status`, never exported in offboarding snapshots, and never logged in application logs or `audit_event.detail`.
2. **Automatic invalidation & cleanup:**
   - **Device revoke / Sign out everywhere:** Database triggers on `ludy_kernel.auth_session` and `ludy_kernel.auth_session_org` immediately delete matching `ludy_kernel.native_push_device` rows on revocation.
   - **Disabled account:** Trigger on `ludy_kernel.user_account` deletes all registrations for the user.
   - **Member removal:** Foreign key `(org_id, user_id)` referencing `ludy_kernel.tenant_member` `ON DELETE CASCADE` removes the org's registrations immediately.
   - **Org purge:** `ludy_kernel.org_purge` deletes `ludy_kernel.native_push_device` and `ludy_kernel.native_push_sent`.
   - **Worker re-verification:** Before handing any target to `NativePushSender`, `ludy_kernel.native_push_targets` re-checks active org, unread notification (`<= 24 hours`), unmuted preference, live conversation read access (`conversation_readers`) / pending proposal status + `legal_entity_id` scope + `decideApproval`, active membership, non-disabled user, non-revoked Ludy session, upstream `auth_session_valid` when `AUTH_SESSION_CHECK=db` (failing closed with `AUTH_GRANTS_MISSING` if grants are absent), and a 30-day session activity window (`GREATEST(refreshed_at, auth_session_org.last_seen_at)`) in non-upstream (`jwt`) mode.
   - **Offline sign-out & token rotation safety:** Re-registering an unchanged `(session_id, platform, token)` preserves `last_used_at`, `failure_count`, and `generation`; rotating to a new token bumps `generation` so in-flight responses for prior tokens are ignored; registering the same physical token under another signed-in account unlinks the prior user's stale registration atomically.

## Mobile Settings integration note

- Client helpers live in `apps/mobile/src/push/` (`syncNativePushRegistration`, `disableNativePushForOrg`, `unregisterNativePushOnSignOut`, `parseNativePushRoute`).
- Settings screens should inspect `notifications.nativePush.status()`:
  - When `enabled === false`, render native push as unavailable on the server (`Máy chủ này chưa bật thông báo đẩy cho ứng dụng di động`) rather than failing with an error.
  - When `enabled === true`, show the active device list (platform, label, last used time, `current`) and allow toggling on (`register`), removing a specific device (`unregister({ id })`), or turning off the current device (`unregister({ current: true })`).
- Before calling `revokeCurrentSession` on explicit sign-out, invoke `unregisterNativePushOnSignOut` across active workspace slugs; server triggers serve as defense-in-depth if the client is offline or revoked remotely.

# 0059. Ludy Mobile and the desktop client roadmap

- Status: **Accepted (owner, 2026-11-25)**. The owner answered the questions of section 8 of [docs/plan/desktop-mobile-apps.md](../plan/desktop-mobile-apps.md) in the Claude PO chat; the answers are quoted in its "Owner decisions (2026-11-25)" section. **Expo (React Native) is decided** ("Expo luôn."), the first jobs are approvals plus the Engage inbox, macOS follows the signed Windows build, and the owner already holds the store and signing accounts. Points 5 (push for self-hosters), the platform split and the milestone are **PO defaults, owner may change**. Tóm tắt tiếng Việt cho chủ sở hữu nằm ở đầu tài liệu kế hoạch đó.
- Date: 2026-11-25
- Deciders: owner (JOY); Platform PO for the shared shell, auth scopes and shared-core files
- Amends: the **Mobile row of plan Decision 14** ("Client platforms", [crove-os-kernel.md](../plan/crove-os-kernel.md)) and the scope of **Ludy Desktop** in [ADR-0055](0055-three-capture-paths-one-meeting.md) section 4. The amended texts get a one-line "amended by ADR-0059" pointer in a follow-up docs change; this ADR is the authority meanwhile.
- Related: Icebox issue #65 (mobile app), [ADR-0032](0032-oauth-authorization-server.md), [ADR-0028](0028-identity-sessions-and-revocation.md), [ADR-0047](0047-meeting-notes-audio-and-transcripts.md)

## Context and problem statement

Decision 14 says mobile is Expo "when wedge customers ask for mobile approvals or camera capture", with Capacitor as the fallback and "an extension of the web app, not a copy" as the scope. On 2026-11-25 the owner asked for a desktop and a mobile app and suggested Engage (Social, CRM) and Meeting Notes first. ADR-0055 already approved Ludy Desktop (Electron, Windows first) with meeting capture first and only "kept room" for tray notifications and a global hotkey. The plan answers which jobs to put on each device and in what order.

## Decisions

1. **Trigger.** The owner's request counts as the trigger of Decision 14. The PWA (manifest, service worker, web push, share target) stays as built, but gets no further work: the owner dropped plan Phase 1 on 2026-11-25 ("Bỏ PWA, chỉ làm Expo"), so the Expo app is the only phone path.
2. **Scope of Ludy Mobile.** Jobs, not apps: the cross-app approvals queue, the Engage conversations inbox with AI-drafted replies a person edits and sends, native push; then receipt capture into Chứng từ and contact lookup with a typed quick note; then in-person meeting recording and minutes. Everything else opens on the web. This widens Decision 14's list (approvals, push, camera, biometrics) with the inbox, lookup and recording, and keeps its "not a copy" rule.
3. **Technology.** Expo (React Native) in a new `apps/mobile` workspace, sharing `packages/kernel-contract`, zod schemas, the oRPC client (moved from `apps/app/src/lib/api.ts` into a shared package), TanStack Query and the i18n messages. Capacitor remains the fallback. No new write path: the app calls existing commands.
4. **Sign-in.** The device-token pattern of the desktop shell and the extension: PKCE in the system browser, a scoped token for one org and one member in the OS keychain, listed and revocable under "thiết bị đã kết nối", local biometric unlock, the kernel's existing step-up for R3. New scopes touch protected paths (`http.ts`, `auth*.ts`, `EXTENSION_ROUTES`) and need the Platform PO and a security review.
5. **Push.** Web push stays for the PWA and for self-hosters. Native push (APNs, FCM) for Crove Cloud through a relay in the private Cloud layer; payloads carry no content. A self-hosted server cannot push to the store app, because the key belongs to the publisher.
6. **Offline.** Read caches for the queue, recent conversations and contacts; queued writes only for idempotent captures (receipt photos, notes, meeting audio pieces); approvals and replies require the network.
7. **Desktop beyond capture.** After meeting capture (ADR-0055 slice 3) and a signed installer: OS notifications from the notification feed and one global Quick Add hotkey. Not planned: a full window app, offline data, a chat module (ADR-0055 decision 10 stands), USB-token signing.
8. **Stores.** Apple Developer Program and Google Play accounts and the Windows certificate are owner actions with cost; the app sells nothing and signs in to existing accounts only. The AGPL question for store distribution goes to the lawyer (#62); until answered the app contains only code owned by the project owner.

## Consequences

- A second, small UI codebase to maintain; mitigated by sharing contracts and the client.
- The shared client package and the new scopes are shared-core and protected-path work.
- Self-hosters get no native push in Phase 2a.
- Store review and policy checks (login, purchase, account deletion, AGPL) happen before the first submission.
- Decision 14's Mobile row and ADR-0055 section 4 get a short "amended by ADR-0059" pointer in a follow-up docs change (the Mobile row also states that the Expo choice was confirmed by the owner on 2026-11-25).

## Revisit when

A pilot customer asks for the app on an iPhone before Phase 2a lands (then PWA push guidance moves up), Apple or Google changes its login, purchase or testing rules, the lawyer rules against store distribution of AGPL code, or the team cannot carry a second UI (then Capacitor).

## Sources

See section 9 of [docs/plan/desktop-mobile-apps.md](../plan/desktop-mobile-apps.md); retrieved 2026-11-25.

# Desktop and mobile apps for Ludy (plan, 2026-11-25)

Status: **owner decisions recorded 2026-11-25** (see "Owner decisions (2026-11-25)" below); the phases are the backlog. Questions 4, 6 and 8 were not asked separately and follow the recommendation as "PO default, owner may change". Companion ADR: [ADR-0059](../adr/0059-ludy-mobile-and-desktop-client-roadmap.md) (Accepted, owner, 2026-11-25). Written by a planning sub-session of the Platform and Frontend PO.

## Tóm tắt cho chủ sở hữu (JOY)

- **Cập nhật 2026-11-25:** anh đã chốt: làm app điện thoại thật bằng **Expo**, ba việc đầu là duyệt + hộp thư Engage (kèm AI soạn câu trả lời và thông báo đẩy), rồi chụp chứng từ + tra khách, rồi ghi âm họp trực tiếp; làm bản **Mac sớm** ngay sau bản Windows đã ký; anh đã có sẵn tài khoản Apple, Google Play, chứng chỉ ký Windows và Apple Developer ID nên không cần mua thêm. Các bước đăng ký cửa hàng và ký vẫn do anh duyệt (runbook, không để bí mật trong repo). Câu hỏi giấy phép AGPL trên cửa hàng đã thêm vào #62 cho luật sư. Các câu 4, 6, 8 theo đề xuất, ghi là "PO mặc định, anh có thể đổi".
- Bản gốc của kế hoạch (trước khi anh trả lời) ở các dòng dưới. Hoàn thành: đã lập kế hoạch app máy tính và app điện thoại cho Ludy (tài liệu này) kèm ADR-0059.
- Trả lời câu hỏi của anh: **đúng một nửa**. Hộp thư hội thoại của Engage nên làm đầu tiên trên điện thoại (khách nhắn Zalo, Facebook lúc anh đang ngoài đường). CRM chỉ cần tra khách và ghi chú nhanh, không cần bảng cơ hội. Ghi âm họp thì khác nhau giữa hai máy: **trên máy tính là việc đầu tiên** (đang làm, ADR-0055); trên điện thoại chỉ ghi được cuộc họp trực tiếp, không ghi được cuộc gọi Zoom hay Zalo của máy khác, nên để sau.
- Hai việc anh chưa nêu nhưng đối thủ đều có trên điện thoại: **duyệt việc cần anh** (chi tiền, nghỉ phép, bài đăng, đề xuất của AI) và **chụp chứng từ** gửi vào Tài chính. Đề xuất bản điện thoại đầu tiên gồm: duyệt, hội thoại có AI soạn sẵn câu trả lời, thông báo đẩy; bản kế tiếp: chụp chứng từ và tra khách.
- Công nghệ: giữ quyết định cũ là Expo (React Native), dùng chung hợp đồng dữ liệu với web. Trước đó, web trên điện thoại (PWA, đã có thông báo đẩy) làm cầu nối miễn phí. Việc cần ứng dụng thật: thông báo trên iPhone không bắt cài vào Màn hình chính, ghi âm khi tắt màn hình, có mặt trên cửa hàng ứng dụng.
- Chi phí chủ phải làm (tôi không tạo): Apple Developer 99 USD một năm, Google Play 25 USD một lần (cả hai cần số D-U-N-S của pháp nhân, miễn phí nhưng mất 1 đến 4 tuần), chứng chỉ ký Windows khoảng 290 đến 500 USD một năm. Tổng năm đầu khoảng 400 đến 650 USD, chưa kể Expo (gói miễn phí đủ lúc đầu).
- Rủi ro cần biết: chủ máy chủ tự cài (self-host) không gửi được thông báo đẩy vào app trên cửa hàng, vì khóa gửi thuộc về người phát hành app; và giấy phép AGPL với cửa hàng ứng dụng cần luật sư xem trước khi nộp.
- Có 9 câu cần anh quyết ở mục 8, mỗi câu có đề xuất. Quan trọng nhất: làm app thật ngay hay chờ khách pilot đòi; Expo hay chỉ PWA; ba việc đầu tiên.
- Hạn chế: chưa có số liệu từ khách pilot về điện thoại và thói quen của họ (Phase 0 hỏi 5 câu); thông tin đối thủ lấy từ trang công khai và tóm tắt tìm kiếm, ghi rõ chỗ chưa kiểm chứng.

## Owner decisions (2026-11-25)

Recorded from the owner's answers in the Claude PO chat (popups), quoted as given. The text of sections 1 to 9 below is the original proposal, kept for reasoning; where it says "proposed" or "recommended", this section rules.

| Question | Owner answer | Effect |
|---|---|---|
| Q3 first jobs | "Duyệt + hộp thư Engage trước (Khuyên dùng)" | Release 1 = approvals plus Engage inbox with AI-drafted replies plus push; release 2 = receipt capture plus contact lookup and quick note; release 3 = in-person meeting recording |
| Q1, Q2 technology | First: "Expo là gì? TAo chưa chốt cái đó mà?" (Decision 14's Expo line had not been decided with the owner); after the options: "Expo luôn." | Native app now with Expo (React Native). The PWA work already in the UI/UX wave continues (Phase 1). Capacitor stays only as the written fallback |
| Q5 accounts | "Tao có tài khoản hết rồi" | The owner holds Apple Developer, Google Play Console, a Windows code-signing certificate and an Apple Developer ID for macOS signing and notarization. No purchase is needed. Store and signing steps stay owner and Production steps with his approval, done from runbooks, no secrets in the repository |
| Q7 desktop | "Làm bản Mac sớm" | macOS (D4) follows right after the signed Windows build (D2); it no longer waits for a pilot that uses Macs |
| Q9 AGPL on stores | (PO decision, owner informed) | The question is added to the lawyer's list in #62. Until answered, the store build contains only code owned by the project owner |
| Q4 platforms, Q6 push, Q8 milestone | not asked separately | **PO default, owner may change:** both platforms from one Expo codebase, Android internal track and TestFlight first; native push only for Crove Cloud through a relay in the private layer, self-hosters keep PWA push; Phase 1 in M3, Phase 2a in M3 when a worker is free, else right after the pilot exit |

Section 8 question 5 (spending) is moot: no purchase. The cost lines in section 3.5 and the Vietnamese summary describe what the owner already holds.

## 1. Jobs, not apps

An app is worth building only for a job the browser does badly. The jobs below are an inference from the competitor set (section 1.2), [DESIGN.md](../../DESIGN.md) ("owners ... often on a phone") and the existing plans; **no pilot data confirms them yet** (Phase 0 asks the pilot partners five questions). Each passes the monthly bar of [scope.md](../product/scope.md) gate 1.

### 1.1 What an OPC or SME owner and staff do away from a desk

| # | Job (weekly or more) | Who | What the browser does badly | Ludy today |
|---|---|---|---|---|
| J1 | Reply to a customer who wrote on Zalo OA, Messenger or Instagram | owner, sales staff | Customers expect minutes; a web push on iPhone needs the app installed to the Home Screen; the inbox is built for a laptop | Inbox (Hội thoại) is shipped; web push merged (#4547, #4574) |
| J2 | Approve what needs me: a payment request, a leave request, a post, an AI proposal | owner, managers | A one-tap decision should not need a laptop; step-up for money must be quick | "Hôm nay cần bạn" and Chứng từ; `PhoneActionBar` exists on the inbox detail and is being extended (#4784) |
| J3 | Snap a receipt or an invoice | owner, staff | Camera capture works in a browser (`<input capture>`), but upload on weak mobile data needs retry and a queue | Chứng từ upload and the Finance coworker's reading are shipped |
| J4 | Look up a customer before or during a call; add a quick note | owner, sales | Search by phone number and one-screen history are slow in a desktop layout | Liên hệ search (name, email, phone, tax code) is shipped |
| J5 | Record an in-person meeting (customer, supplier, staff) | owner | A browser recording **stops when the screen locks** ([meetings.md](meetings.md): "Native recording on phones" is listed as later) | In-app recorder (browser) shipped |
| J6 | Check money: what is owed to me, what I owe, bank balance | owner | Fine on the web, but a glance on a phone is the habit | **Not in the plan**: the Home money tiles are only a recommendation (L2 of the [benchmark](../research/smb-suite-navigation-benchmark-2026-11.md)) |
| J7 | Check in or ask for leave (staff) | staff | Occasional; the staff portal (Cổng nhân viên) already exists on the web | Web only |

### 1.2 What the reference products ship on a phone

All sources retrieved 2026-11-25; "search summary" means the fact came from a search-engine summary, not from an opened page (section 9 lists them).

| Product | On the phone | Not found or not confirmed |
|---|---|---|
| MISA AMIS Kế toán (M1) | A manager can see and approve a request with its documents on mobile; a separate sales app for customers, stock and debt lookup, quotes and orders; e-invoice issuing on mobile | Photo capture of purchase invoices (page does not say) |
| KiotViet (K1) | One app per kind of business (retail, restaurant, salon, online, hotel); the owner app shows revenue, stock and transactions, with a notification for each transaction; a staff sales app works offline (benchmark K4) | Pricing (not confirmed) |
| Base.vn (B1) | One app that gathers notifications from all Base apps and opens them | Request approvals inside the app (not confirmed) |
| HubSpot (H1) | Free iOS and Android app: call from the app with automatic call logging, inbox reply, business-card scan into a contact, record update, notifications of new chats, an AI summary of the account before a meeting | Feature parity per plan tier |
| QuickBooks (Q1) | Receipt capture (mobile only), invoicing, estimates, mileage; user and approval management is shown on the web side of Intuit's own comparison | A mobile approval flow (not found) |
| Zoho CRM (Z1) | Voice notes (limit raised from 2 to 5 minutes in 2025), business-card scanner, offline edit with later sync, voice commands to the AI | Zoho Books mobile (not covered by what was read) |
| Granola, iOS (G1) | In-person recording with a Lock Screen control and Live Activity; says plainly that phones cannot capture audio from other apps, so virtual calls are not transcribed on mobile | Behaviour of Otter and Fireflies with a locked screen (not confirmed) |

The pattern: phones carry **capture, lookup, notification and one-tap approval**, never the full back office. That fits Ludy's own earlier scope sentence: "an extension of the web app, not a copy" ([plan Decision 14 row](crove-os-kernel.md), modelled on HubSpot's free app).

### 1.3 What only a desktop app adds over the browser

| Capability | Why the browser cannot | Status |
|---|---|---|
| System-audio capture of any call (Zoom, Teams, Zalo PC, Meet outside Chrome) | A web page cannot hear another application | Slice 3 of [ADR-0055](../adr/0055-three-capture-paths-one-meeting.md): Windows capture client merged, macOS backend started, behind `MEETINGS_DESKTOP_CAPTURE`, gated on the lawyer answers (#2585, #62) |
| Tray icon, always-visible recording indicator | A tab can be closed or hidden | Shell merged (#4569, Windows proof #4658) |
| OS notifications while no browser tab is open | Web push needs a service worker in a running browser profile | Not built; ADR-0055 section 4 only "keeps room" |
| Global hotkey (Quick Add from anywhere) | No global keys in a page | Not built; same |
| Offline-ish use | A PWA can cache, but the money flows must be online anyway | **Not recommended** (section 6) |
| USB-token signing (Sign line's later need) | A browser cannot reach a token reliably | Not planned; owner decides later |

## 2. Are Engage (Social, CRM) and Meeting Notes the right first apps?

**Half right.** Ranked by how often the job happens away from a desk and by what a phone does better than a browser:

1. **Engage inbox: yes, first.** J1 is the most frequent and the most time-sensitive job; push turns it from "I check when I sit down" into "I answer in two minutes". The AI part fits the scope gate exactly: the Engage coworker drafts the reply, a person edits and sends.
2. **CRM: only lookup and a quick note** (J4). The pipeline board, imports and quotes stay in the browser. HubSpot and Zoho show the same boundary.
3. **Social (publishing, ads): stays in the browser.** Writing and scheduling a post is desk work. What goes to the phone is the *approval* of an AI-drafted post, inside the shared approvals queue (J2).
4. **Meeting Notes: different on each machine.** On the **desktop** it is the first job (capture of any call, section 5). On the **phone** it is third: only in-person recording is possible (OS rule, same as Granola), it needs native background audio, and the minutes can be read in the browser meanwhile.
5. **Two jobs the owner did not list move to the front:** cross-app **approvals** (J2) and **receipt capture** (J3). They are what plan Decision 14 and Icebox issue #65 name, what MISA and QuickBooks ship, and they concern money, which is what a small owner opens a phone for.

Recommended first mobile release, **"Ludy Mobile 0.1"**: approvals queue (J2), Engage conversations with AI-drafted replies (J1), push for both. Second release: receipt capture (J3), contact lookup and quick note (J4). Third: meeting recording and minutes (J5). Money tiles (J6) only if the owner approves them for the web first.

**Stays in the browser** (a "Mở trên web" hand-off on the phone, never rebuilt natively): books, journal, tax filing, issuing e-invoices (approve on the phone, compose on a laptop), payroll runs, stock and marketplaces, Projects boards, Notes editing, Social composing and Ads, eSign creation, reports, all Settings.

## 3. Technology

### 3.1 Options

| | PWA only (what exists) | Capacitor around the SPA | Expo / React Native (plan Decision 14) |
|---|---|---|---|
| UI reuse | 100% | about 100% (a webview) | 0% of UI; shares contracts, zod schemas, the oRPC client, TanStack Query and i18n messages |
| Push | Web push merged. On iPhone it works only for a web app added to the Home Screen (Apple, 16.4 and later; W1) | Native push through a plugin | Native push |
| Lock-screen recording | No | Via a plugin (background audio mode) | `expo-audio` with `enableBackgroundRecording`, tested on a real device in a standalone build (E2); battery cost noted by Expo |
| Camera, biometrics | Camera yes; **biometrics already work for step-up**, because the kernel accepts WebAuthn as a second factor (`apps/kernel/src/auth.ts`) | Plugins | Native modules |
| Store presence | None | Yes, with Apple review risk ("not sufficiently different from web browsing", a developer-reported 4.2 rejection; unverified rule text) | Yes |
| Feel | Web | Webview | Native |
| Second UI codebase | No | No | Yes, but small: 4 to 6 screens |
| Updates | Instant | Store plus optional OTA | Store plus EAS Update |
| Fit with [AGENTS.md](../../AGENTS.md) | Best | Fine | Fine; new workspace and lockfile are protected paths |

Notes that matter for the choice:

- The SPA already calls the kernel with an `Authorization` bearer token through the oRPC client (`apps/app/src/lib/api.ts`), so a bundled webview (Capacitor) or a native client (Expo) can both use it. The oRPC contract lives in `packages/kernel-contract`; the client factory is inside `apps/app` and would move to a small shared package first.
- Expo's pricing page lists Free (low-priority builds), Starter 19 USD a month and Production 199 USD a month (E1). Free is enough for the first phase.
- **Recommendation:** keep Expo as the native path (Decision 14), keep Capacitor as the written fallback, and make the PWA the bridge until the native app ships. Native only pays for three things the PWA cannot do: push on iPhone without the Home Screen step, recording with the screen locked, and a place in the stores. If the owner does not value those yet, PWA only is the cheapest honest answer (question 2).

### 3.2 Sign-in, tokens and step-up

- Today the desktop shell and the browser extension sign in with PKCE in the system browser and trade a one-time code for a scoped `crx_` device token (one org, one member), listed under "thiết bị đã kết nối" and revocable ([apps/desktop/README.md](../../apps/desktop/README.md), [ADR-0032](../adr/0032-oauth-authorization-server.md)). Cloud sign-in goes through DOS ID OAuth (#4712).
- **Proposal:** the phone uses the **same device-token pattern** with `client: "mobile"`: system browser, PKCE, a claimed https link or custom scheme (loopback is the desktop case, RFC 8252), token in the OS keychain (`expo-secure-store`), local biometric to open the app, and the kernel's existing step-up for R3 approvals. A lost phone is cut off from the devices list without touching the member's other sessions.
- The extension's token is deliberately narrow. Mobile needs more routes (approvals, conversations, upload, contacts), which means new scopes in `EXTENSION_ROUTES`, `http.ts` and `auth*.ts`: **protected paths and shared core**, so Platform PO review plus a security review. The ADR leaves the final design to the build issue.
- Self-hosters see a "server address" field on the sign-in screen (as the desktop shell does with `LUDY_URL`); Cloud users never do.
- Apple's guideline 4.8 (a privacy-equivalent login option beside third-party or social sign-in) must be checked against the DOS ID flow before submission (search summary, A1); unverified here.

### 3.3 Push

- Web push is built and needs no vendor (RFC 8291, VAPID keys of the deployment, `apps/kernel/src/web-push.ts`). It stays the push of the PWA and of self-hosters.
- Native push uses APNs and FCM. **Consequence not obvious from the code:** a push token is tied to the bundle id and the key of the account that publishes the app. A self-hosted server cannot push to the store app; only the publisher's key can. Options: (a) native push only for Crove Cloud through a small relay in the private Cloud layer (consistent with "nothing DOS-specific in this repository"), self-hosters use the PWA or build their own app; (b) an open relay run by the publisher for everyone. Recommendation: (a) for Phase 2a (question 6).
- Payloads carry no content ("Có 1 hội thoại mới"), as web push logs do today; the app fetches the detail after sign-in. A third-party relay (a hosted push service) is not recommended: it would see metadata of every customer message.

### 3.4 Offline expectations

Read: the approvals queue, the last conversations and recent contacts are cached for read (TanStack Query persistence), so the app opens on a bad connection. Write: only **idempotent captures** queue for later (receipt photos, quick notes, meeting audio pieces), using the existing idempotency keys. **Approvals, replies, anything that moves money or sends a message needs the network and says so.** Zoho's offline editing and KiotViet's offline sales (benchmark K4) serve shops without connectivity; Ludy's money flows are server-side commands through `Runtime.execute()`, so an offline write would be a second write path.

### 3.5 Stores, Zalo, signing, licence

- **Zalo** limits come from the OA API, not from the app type: an OA may send advice messages only within 48 hours of the customer's last interaction, and API access needs a registered app, a linked OA, a webhook and Zalo's approval (Z2, third-party SDK docs; check developers.zalo.me). A phone app changes none of this; the draft reply screen must show the window clock. There is no official way to read a customer's personal Zalo chat. A Zalo Mini App as a channel is not in any plan.
- **Apple:** Developer Program 99 USD a year; an organization needs a D-U-N-S number (free from Dun & Bradstreet, up to 5 business days plus 2 for Apple) and the registered legal name, not a trade name (A2). **Google Play:** 25 USD once; an organization needs a D-U-N-S number and Google says it can take up to 30 days; a *personal* account created after 2023-11-13 must run a closed test with 12 testers for 14 days before production, which organization accounts appear exempt from (unconfirmed on Google's own page) (P1). **Windows signing** for the desktop app: see [ADR-0055](../adr/0055-three-capture-paths-one-meeting.md) section 4 (a CA certificate of about 290 to 500 USD a year; Azure Artifact Signing is not open to Vietnamese organizations in Microsoft's list of 2026-11-17) and [signing-runbook.md](../desktop/signing-runbook.md). All of these are **owner actions** (accounts, payments, identity checks).
- **The app sells nothing.** Subscriptions stay on the web; the app only signs in to an existing account. Apple's rules on in-app purchase for digital goods and on in-app account deletion must be checked before the first submission (not verified in this research).
- **AGPL and the stores.** Ludy is AGPL-3.0-only. In 2010 the FSF's view was that App Store terms add restrictions the GPL forbids, and VLC left the store until it was rewritten and fully open sourced in 2013; a VLC developer said the same objection covers the AGPL (L1, 2010 to 2013 coverage, not current law). A copyright holder is not bound by its own licence, so an app written only by the owner's agents and assigned to the owner can ship; contributions by outsiders cannot be relicensed that way, and [CLA.md](../../CLA.md) is still a draft with outside contributions closed. Therefore: keep `apps/mobile` free of GPL or AGPL dependencies (Expo and React Native are permissively licensed; verify per dependency), publish its source in this repository, and **put the question to the lawyer (#62)** before the first submission (question 9). This is not legal advice.

## 4. Phased roadmap

Milestones today: M3 Paid pilot, then the GA gate. Sizes are rough counts of pull requests by worker sessions, not dates. Every phase obeys the scope gate: one person can use it with the defaults, the AI part is named per screen, a person approves money, messages and spend, and the core works with AI off.

| Phase | What | Acceptance (what a user sees) | AI part per screen | Size | Milestone fit | Line | Depends on |
|---|---|---|---|---|---|---|---|
| **0** Decisions and facts | Owner answers section 8. D-U-N-S lookup for the legal entity (free). Five questions to the pilot partners: which phones, which app they open away from the desk, how fast customers expect an answer, whether staff would install an app, Zalo or Facebook first. | A written decision on each question 1 to 9; the pilot answers recorded in this file | none | docs only, about 2 PRs | now, in M3 | Platform PO with the owner | none |
| **1** PWA-ready ("mobile before the store") | Finish phone ergonomics already planned: `PhoneActionBar` on the queues (#4784), Home create actions (#4783), "Thêm vào Màn hình chính" guide for iPhone with a notification opt-in prompt, push deep links to the exact item, app-icon badge, share target kept | On an iPhone and an Android phone: install from the browser, get a push for a new conversation and a pending approval, tap it, land on the item, approve or reply with one hand | the queue and the coworker drafts already exist; no new model call | S to M, about 5 to 8 PRs (UI and copy; some already planned) | M3 (already in the UI/UX wave P2) | Platform, Engage, Finance | web push (#4547, #4574, done) |
| **2a** Ludy Mobile 0.1 (Expo, TestFlight and Play internal track) | `apps/mobile`: sign-in (device token, biometric unlock, "server address" for self-host), **approvals queue** with R3 step-up, **Engage inbox**: thread, reply, "Vy soạn sẵn" draft, native push (Cloud relay), "Mở trên web" hand-off | A pilot owner on iPhone and on Android signs in once, gets a native push, approves a payment request with fingerprint or Face ID, answers a Zalo customer with an edited AI draft; revoking the device in Settings signs the phone out within minutes | Finance and Engage coworkers prepared the proposals and the draft; model calls go through the AI budget meter; a person approves money and sends the message | L, about 12 to 18 PRs (shared client package, auth scopes, relay, app, CI, runbooks) | after Phase 0; start in M3 only if one worker is free, else the GA gate (question 8) | Platform (shell, auth), Engage and Finance (screens) | question answers; accounts (owner actions); #4712 sign-in; security review of the scopes |
| **2b** Capture and lookup | **Receipt capture** into Chứng từ with an upload queue; **contact lookup** by name or phone with open deals and last conversation, **quick note** (typed) | Photograph a receipt on a bad connection: it uploads later, the Finance coworker reads it, the proposal appears in the approvals queue; before a call, one search shows who the customer is | Finance coworker reads the receipt; Vy summarises the last interactions with a contact (drafts only) | M, about 6 to 10 PRs | GA gate | Platform, Finance, Engage | 2a |
| **2c** Store release | Store listings (vi, en), privacy forms, in-app account deletion, review submission, update channel | Installable from App Store and Google Play by a customer, with the same features as 2a and 2b | none | S, about 4 to 6 PRs (mostly owner and runbook steps) | GA gate | Platform, owner | 2a, 2b; accounts; lawyer answer (question 9); Apple and Google checks |
| **3** Meetings on the phone | Native in-person recording with a Lock Screen control, upload queue, read minutes and approve action items, push "Minutes ready" (exists as in-app notice, L8) | Record a customer meeting with the screen locked; minutes appear; an action item is accepted in one tap | Vy transcribes and drafts the minutes; the one-meeting rule and consent (ADR-0055 sections 3 and 5) apply unchanged | M, about 8 to 12 PRs | after the GA gate | Meetings, Platform | 2a; lawyer answers #2585, #62 for consent wording; Meetings slice 3 patterns |
| **4** Glance and staff | Read-only money tiles (J6), leave request and check-in for staff (J7) | An owner sees "chưa thu, chưa trả, tiền ngân hàng" and each opens its list | deterministic numbers, a Vy explanation under them | M | only if the owner approves the tiles (L2 is not in any plan) | Finance, HR | 2a; owner approval |

### Desktop track (Ludy Desktop, Electron, Windows first)

| Phase | What | Acceptance | Size, line | Depends on |
|---|---|---|---|---|
| **D1** Meeting capture (already planned) | Slice 3 of ADR-0055: WASAPI loopback plus microphone with the consent gate and the one-meeting rule; macOS after Windows | A person records a Zoom, Teams or Zalo PC call without a bot; the meeting appears with its transcript and minutes by Vy; the person approves the action items | in progress, Meetings line (shell: Platform) | Slice 1 done, shell #4569, smoke #4658, lawyer #2585 and #62 |
| **D2** A signed installer a customer can run | Signed Windows build, an update feed hosted by the deployment, install guide in Vietnamese | Installing shows no "unknown publisher" block; an update from A to B works | S to M, Platform; **owner actions** (certificate, account) in [signing-runbook.md](../desktop/signing-runbook.md) | D1 near ready; certificate bought |
| **D3** Notifications and Quick Add | OS notification for a new conversation or approval (from the notification feed), click opens the item in the browser; one global hotkey for quick capture | A new customer message shows a Windows notification within a minute with no browser tab open | S to M, Platform | D2; a design check of the stream endpoint versus polling |
| **D4** macOS | Core Audio capture, notarization | Same as D1 on a Mac | M, Platform and Meetings | D1, Apple account, a pilot that uses Macs |

Not planned: a full desktop window app (the browser is it), offline data, a chat module (stays a note per ADR-0055 decision 10), USB-token signing (revisit with the Sign line).

## 5. Why meeting capture first on desktop, tray notifications next

Meeting capture is the one thing no browser can do and is already built up to the capture client, so D1 finishes work in flight. Tray notifications (D3) are second because the desktop shell already runs and signs in; they add value only for people who keep Ludy Desktop open all day, so they stay small and follow D2, since an unsigned installer cannot go to customers.

## 6. Lean rules for every phase

- Smallest slice first; no feature without a job in section 1.
- No new write path: the app calls the same commands through `Runtime.execute()`; the phone never writes a tenant table directly.
- Phone screens show at most the work of one decision (approve, reject, edit, reply); anything with more fields opens the web page.
- A person approves money, messages and spend; AI output stays tainted data (AGENTS.md).
- Each phase ends with a pilot owner using it for a week before the next starts.
- The Review checklist (correctness, security, tenancy, money, performance, accessibility) applies; for the phone, accessibility means 44 px targets, labels and screen-reader order.

## 7. Risks

- **No pilot evidence** for J1 to J7; Phase 0 exists to fix that.
- **Second UI codebase** to keep in step with the web app, even if small; mitigated by sharing contracts and not rebuilding anything outside the four jobs.
- **Store review and policy changes** (login, purchase and deletion rules, AGPL terms); a rejected first submission costs days.
- **Account lead times:** D-U-N-S up to a week or more, Google up to 30 days; start in Phase 0.
- **Push on self-host** (section 3.3).
- **Lock-screen recording** is the hardest native piece; test on a real device in a standalone build, as Expo's docs say.
- **Consent and recording law** for any capture (ADR-0055 section 5) is unanswered by the lawyer.
- **Android share** is about 60% of mobile in Vietnam against 39% for iOS (StatCounter, July 2026, S1), so skipping Android is not an option.

## 8. Owner decisions needed

None of these is decided here. The first option in each is the recommendation.

1. **Build a native mobile app now?** Recommended: **yes, treat the owner's request of 2026-11-25 as the trigger of plan Decision 14** (the written trigger was "customers ask"), but start with Phase 0 and Phase 1, so the PWA works for the pilot meanwhile. Alternative: wait until a pilot customer asks. Without an answer: only Phase 1 (already planned UI work) proceeds.
2. **Technology.** Recommended: **Expo (React Native)** as Decision 14 says, Capacitor stays the fallback. Alternative: PWA only (cheapest; no iPhone push without the Home Screen step, no lock-screen recording, no store presence).
3. **First jobs.** Recommended: release 1 = approvals plus Engage conversations with AI-drafted replies plus push; release 2 = receipt capture plus contact lookup and quick note; release 3 = in-person meeting recording and minutes. CRM board, Social publishing and Ads stay in the browser.
4. **Platforms.** Recommended: **both from one Expo codebase**, Android internal track and iOS TestFlight to the pilot first, store submission only after Phase 2b. Android is about 60% of Vietnamese phones, iOS about 39% (S1). Alternative: Android first (cheaper, quicker review).
5. **Store accounts and spending (owner actions, I create none).** Recommended: start the free D-U-N-S lookup for the legal entity now; buy Apple (99 USD a year) and Google (25 USD once) when Phase 2a is ready for testers; buy the Windows certificate (about 290 to 500 USD a year) when a pilot needs desktop capture. About 400 to 650 USD in the first year plus Expo Starter (19 USD a month) only if build queues hurt. Alternative: buy everything now to remove lead time.
6. **Push for self-hosters.** Recommended: native push only for Crove Cloud through a relay in the private layer in Phase 2a; self-hosters keep the PWA push (own keys) or build the app themselves. Alternative: a public relay run by the publisher for everyone (more work, metadata exposure).
7. **Desktop beyond capture.** Recommended: after D1 and the signed installer (D2), build only tray notifications and one Quick Add hotkey (D3); no full window, no offline, macOS only when a pilot uses Macs. Alternative: stop at capture.
8. **Milestone and owner.** Recommended: Phase 1 stays in M3; Phase 2a is proposed to start in M3 only if a worker is free without delaying the pilot checklist, otherwise right after the pilot exit; the Platform line owns the app, Engage and Finance lines own their screens, Meetings owns Phase 3 and D1. Alternative: all native work after the GA gate.
9. **Licence question to the lawyer.** Recommended: add to the list in #62: "May we distribute AGPL code owned by one entity on the App Store and Google Play, and do we need a store exception in the licence text?" Until answered, the mobile app contains only code owned by the project owner and no outside contributions. Alternative: skip the stores and distribute the app only as a direct Android install and TestFlight (not a real answer for customers).

## 9. Sources

Retrieved 2026-11-25. "Search summary" marks facts taken from a search-engine summary; those pages were not opened and carry the same uncertainty as the benchmark.

- M1 MISA AMIS Kế toán, new features (approval flow, sales app): https://amis.misa.vn/292273/amis-ke-toan-cap-nhat-tinh-nang-moi/ and help centre: https://helpact.misa.vn/kb/su-dung-misa-amis-ke-toan/ (search summary); store listing: https://apps.apple.com/us/app/amis-sme/id726960869
- K1 KiotViet store listings (search summary): https://apps.apple.com/vn/app/kiotviet/id1146695068?l=vi and https://apps.apple.com/us/app/id1146695068; see also K4 of the [benchmark](../research/smb-suite-navigation-benchmark-2026-11.md)
- B1 Base mobile app listing (search summary): https://apps.apple.com/vn/app/base-qu%E1%BA%A3n-tr%E1%BB%8B-v%C3%A0-%C4%91i%E1%BB%81u-h%C3%A0nh-dn/id1365505175 ; Base Request help (web): https://help.base.vn/support/solutions/articles/63000284976-base-request-introduce-base-request-and-table-of-contents
- H1 HubSpot mobile: https://www.hubspot.com/products/mobile and https://apps.apple.com/ie/app/hubspot/id1107711722 (search summary)
- Q1 QuickBooks, mobile app and web comparison: https://quickbooks.intuit.com/learn-support/en-us/help-article/compare-products/get-done-quickbooks-mobile-app-web/L9YN5gwQw_US_en_US ; receipts: https://quickbooks.intuit.com/r/expenses/receipt-capture-app/ (search summary)
- Z1 Zoho CRM mobile, 2025 recap: https://help.zoho.com/portal/ja/community/topic/zoho-crms-mobile-apps-a-2025-recap-8-1-2026 and https://www.zoho.com/crm/mobile/card-scanner.html (search summary)
- G1 Granola iOS: https://docs.granola.ai/help-center/ios/getting-started and https://www.granola.ai/blog/ai-note-taker-in-person-meetings (search summary)
- Z2 Zalo OA advice-message window and integration steps (third-party SDK docs, check the official site): https://unpkg.com/@warriorteam/redai-zalo-sdk@1.11.1/docs/CONSULTATION_SERVICE.md ; official: https://developers.zalo.me
- W1 WebKit, Web Push for web apps on iOS and iPadOS: https://webkit.org/blog/13878/
- E1 Expo pricing: https://expo.dev/pricing ; E2 expo-audio, background recording: https://docs.expo.dev/versions/latest/sdk/audio/
- A1 Apple App Review Guidelines (4.2, 4.8; rule text not confirmed): https://developer.apple.com/app-store/review/guidelines/ ; A2 Apple enrollment and D-U-N-S: https://developer.apple.com/support/enrollment/ and https://developer.apple.com/support/d-u-n-s/
- P1 Google Play developer account requirements and tests: https://support.google.com/googleplay/android-developer/answer/14151465 and https://support.google.com/googleplay/android-developer/answer/13628312
- L1 GPL and the App Store, 2010 to 2013 coverage: https://www.computerworld.com/article/1347653/gplv2-blocks-vlc-from-apple-s-app-store.html and https://news.slashdot.org/story/13/07/18/1943202/vlc-for-ios-returns-on-july-19-rewritten-and-fully-open-sourced
- S1 StatCounter, Vietnam mobile OS share: https://gs.statcounter.com/os-market-share/mobile/viet-nam (July 2026: Android about 60%, iOS about 40%, from a search summary)
- Repository: [ADR-0055](../adr/0055-three-capture-paths-one-meeting.md), [crove-os-kernel.md](crove-os-kernel.md) (client platforms, Decision 14 row), [meetings.md](meetings.md), [conversations.md](conversations.md), [crm.md](crm.md), [lean-navigation-audit-2026-11.md](lean-navigation-audit-2026-11.md), [competitors-engage.md](../product/competitors-engage.md), [apps/desktop/README.md](../../apps/desktop/README.md).

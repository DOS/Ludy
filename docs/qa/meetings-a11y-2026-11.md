<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Meetings accessibility audit, 2026-11

Issue [#3805](https://github.com/DOS/Ludy/issues/3805), line Meetings. Standard: WCAG 2.2 AA as [DESIGN.md](../../DESIGN.md) section 7 sets it (the issue names 2.1 AA; every 2.1 criterion is inside 2.2, and the 2.2 target-size rule is the one DESIGN.md measures against).

## How it was done

- **Code read**: every Meetings route and component on `origin/main` at `c9b8fa8` (2026-11-18): `routes/meetings.tsx`, `meeting-record.tsx`, `meeting-detail.tsx`, `meeting-minutes.tsx`, the components `meeting-*.tsx`, `recording-chip.tsx`, `recording-stopped.tsx`, and the template settings card `minutes-templates.tsx`.
- **Contrast**: computed from the token file (`packages/ui/src/styles/globals.css`) for the pairs these screens use, in both themes (table below).
- **Browser evidence**: the new `e2e/tests/meetings-a11y.spec.ts` opens every Meetings route with data (list, recorder, a meeting with a published result and a draft editor, the printable biên bản, the template card with its form open) in light and dark, at 1280 and 360 px, and fails on a serious or critical axe violation of the WCAG 2.2 AA rules, any landmark or heading-order violation, or a page that scrolls sideways. A second test walks the recorder with the keyboard alone. This worker session has no Docker daemon, so those two tests were typechecked here and run by CI only; the CI result on the PR's head is the evidence, not a local run.
- **Markup tests**: `apps/app/test/meetings-a11y.test.tsx` holds what a static render can see (live regions, heading levels, button names, touch classes).
- **Not done here**: a screen reader walk by a person (NVDA or VoiceOver). DESIGN.md section 7 keeps it as a person's step before general availability.

Severity: **P1** blocks a task for some users; **P2** makes it hard or confusing; **P3** polish.

## Contrast (computed, WCAG 1.4.3 and 1.4.11)

| Pair on the Meetings screens | Light | Dark | Needs |
|---|---|---|---|
| `muted-foreground` on `background` (hints, dates) | 7.15 | 8.77 | 4.5 |
| `muted-foreground` on `card` | 7.47 | 8.29 | 4.5 |
| `muted-foreground` on `muted` (video box) | 6.74 | 7.68 | 4.5 |
| `muted-foreground` on the consent box (`muted/30` over `card`) | 7.24 | 8.12 | 4.5 |
| `primary` on `primary/5` (the "AI is off" card title) | 6.19 | 7.98 | 4.5 |
| `warning` on `card` (the "stale translation" line) | 5.71 | 10.82 | 4.5 |
| `muted-foreground` on `warning/10` (the "recording stopped" note) | 6.23 | 7.45 | 4.5 |
| `destructive` on `card` | 5.86 | 7.20 | 4.5 |
| `destructive` on `destructive/10` over `card` (error alert) | 4.97 | 6.27 | 4.5 |
| `link` on `card` | 7.85 | 9.61 | 4.5 |
| `field-border` on `card` (field outlines) | 3.65 | 3.64 | 3 |

No contrast finding. The recording dot (`destructive`, `muted-foreground`) is decorative and has text beside it, so color is never the only signal.

## Findings fixed in this PR

| # | Finding | Criterion | Sev | Fix |
|---|---|---|---|---|
| F1 | The biên bản page has no `<main>`: it sits outside the shell, so nothing gave it a landmark. | 1.3.1, 2.4.1 | P2 | The page frame is a `<main>`. |
| F2 | The biên bản page sets no tab title; the tab keeps the app's default name. | 2.4.2 | P2 | `useScreenTitle` with the page name. |
| F3 | Card titles on the meeting page are `div`s, so the page has no headings between its `h1` and the `h3`s inside the results panel (a skipped level, no headings to jump to). | 1.3.1, 2.4.6 | P2 | The 17 Meetings card titles carry `role="heading"` and `aria-level="2"`. |
| F4 | The recorder's clock sits inside the polite live region and repaints every 500 ms, so a screen reader is told the time again and again and the state change is buried. | 4.1.3 | P1 | The state line is the live region; the clock is a `role="timer"` beside it (implicitly not live) and keeps its name. |
| F5 | Pressing "Bắt đầu ghi" removes the form, and the focus falls to the top of the page. | 2.4.3 | P1 | The focus goes to the recording status (focusable, `tabindex="-1"`), so the next Tab reaches "Tạm dừng". Only when this screen showed the form: arriving on a running recording is the shell's to announce. |
| F6 | "Tạm dừng" and "Dừng và tải lên" are 32 px high; this screen is used on a phone, during a meeting. The corner chip's Stop is 24 px. | 2.5.8 (24 px floor met), DESIGN.md 44 px on touch-first screens | P2 | 44 px high below `sm`; the chip's Stop is 36 px on a phone and stays compact from `md`. |
| F7 | The camera preview has no name. | 4.1.2 | P3 | `aria-label` "Hình camera đang ghi" / "Camera picture being recorded". |
| F8 | "Bắt đầu ghi" is disabled with no reason a screen reader can reach. | 3.3.2, 4.1.2 | P2 | `aria-describedby` points at the line under it, which lists what recording waits for. Behavior and the consent step are untouched. |
| F9 | Buttons repeated per row have the same name: "Tải lên" and "Bỏ" per saved recording, "Xóa" per reader, "Mang sang" per open item, "Sửa" and "Lưu trữ" per template. | 2.4.6, 4.1.2 | P2 | The row's title is each button's accessible description (the name is unchanged, so label in name holds and existing locators still match). |
| F10 | Vy's run progress, the "draft ready" line, "copied" and the translation's "running" line were added to the page together with their text; a live region that did not exist beforehand is often not announced. | 4.1.3 | P1 | One polite region that is always in the page (`data-testid="vy-live"`, and one in the translation panel and the speaker suggestions), filled when the state changes. |
| F11 | Sharing the summary removes the draft and the button that held the focus, and nothing says it worked. | 2.4.3, 4.1.3 | P1 | The focus goes to the "Đã chia sẻ cho người dự họp" heading, which a screen reader reads as the result. |
| F12 | The series card's "carry" button is replaced by plain text: no announcement, focus lost. | 2.4.3, 4.1.3 | P2 | A status element that was already there takes the text and the focus. |
| F13 | Template settings card: `aria-label` on a `div` with no role (not allowed by ARIA); the card title is a `p`; opening, saving, cancelling, creating, removing or moving a section drops the focus; archiving, saving and creating are silent; "Sửa" does not say it is expanded. | 1.3.1, 2.4.3, 4.1.2, 4.1.3 | P2 | A labelled `region` with an `h2`; `aria-expanded` on "Sửa" and "Thêm mẫu"; focus goes into the form on open and back to its trigger on save, cancel and create; after a section is added, removed or moved the focus follows it; saved, created and archived are toasts (the shared toaster is a live region). |
| F14 | The list and the meeting page show the raw state code ("ready", "processing") in English to Vietnamese users. | 3.1.2, 3.3.2 | P2 | The state is read from the catalog in both languages (`meetings.status.*`). |
| F15 | The meeting page's subtitle prints the recorder's user id (a uuid) as "Người ghi". | 1.3.1 (meaningless text), AGENTS.md "never an id" | P2 | The recorder's name or email, left out until the org's members have loaded. |
| F16 | The back links begin with a literal arrow character that screen readers read as "leftwards arrow". | 1.1.1 | P3 | The arrow is `aria-hidden`. |
| F17 | The audio and video players have no name, and "Đang tải bản ghi…" is not announced. | 4.1.2, 4.1.3 | P3 | `aria-label` from the card titles; the loading line is a status. |
| F18 | The biên bản table's header cells have no `scope`. | 1.3.1 | P3 | `scope="col"`. |
| F19 | The minutes webhook's address field is `aria-invalid` when the address is wrong, but its error is not linked to it (DESIGN.md section 4.2). | 3.3.1 | P3 | The field's `aria-describedby` names the error. |

## Checked and fine, no change

- **Labels**: every field has a visible label with `htmlFor`, or an `aria-label` where the placeholder repeats it (the item form, the decisions box). The recorder, the new-meeting dialog, the consent method and the confirmation box are labelled; icon-only buttons are `aria-label`led (the template's move and remove buttons).
- **Dialogs** (delete, discard, archive, the new-meeting form) use the shared Base UI dialog: focus moves in, returns to the trigger, Esc closes.
- **Errors** use the shared alert (`role="alert"`).
- **Keyboard**: no click handler on a non-interactive element anywhere in the Meetings files; all controls are buttons, links or form fields.
- **Reduced motion**: the pulsing dots are covered by the global rule and `reduced-motion.spec.ts`.
- **Focus ring**: Meetings uses the shared `Button`, `Input`, `NativeSelect` and `Link` styles, which `focus-ring.spec.ts` walks on the sidebar screens.
- **Recording-state chip**: it shows "Đang ghi 12:31" as a link with a Stop button; its clock is deliberately not a live region.

## Findings not fixed, with the reason

| # | Finding | Reason | Next |
|---|---|---|---|
| N1 | The corner chip is not announced when a recording starts or pauses on a screen other than the recorder (the recorder screen announces it). A second `role="status"` containing "Đang ghi" would also make `getByRole('status').filter({ hasText: 'Đang ghi' })` in `meeting-record.spec.ts` match twice. | Touching the recording chip's wording is a change to the recording indicator the consent step relies on; it needs different words and a decision, not a quick fix. | P3 follow-up in the Icebox. |
| N2 | A meeting recorded with video has no captions track (1.2.2). The transcript beside it is the alternative for audio alone (1.2.1), not captions. | Generating WebVTT from the transcript is a feature, and a meeting with AI off has no transcript. | P3 follow-up in the Icebox. |
| N3 | The live notes pane adds lines every 10 seconds with no live region. | Announcing each window would read the draft aloud to the person who is in the meeting; the pane is a draft the full transcript replaces. | None. |
| N4 | The biên bản page has two `h1`: the toolbar title (hidden when printing) and the sheet's "BIÊN BẢN". | WCAG allows it, the sheet's heading is the document title on paper, and the toolbar is not printed. | None. |
| N5 | A disabled button (Start, Dịch, "Tạo việc") cannot take focus, so a keyboard user reaches its reason only in reading mode. | The reason sits next to the button as text; Start also links to it with `aria-describedby` (F8). Making disabled buttons focusable is a shared-component decision. | None. |
| N6 | `title` tooltips on the live line's time and the notes chip. | Extra detail only; the same fact is in the text next to it. | None. |
| N7 | Screen reader walk of the recorder and the results panel. | A person's step (DESIGN.md section 7). | The owner or the PO schedules it before general availability. |

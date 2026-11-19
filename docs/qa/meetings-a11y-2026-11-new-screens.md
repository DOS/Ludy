<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Meetings accessibility audit, 2026-11: the newest screens

Issue [#4055](https://github.com/DOS/Ludy/issues/4055), line Meetings; a follow-on of [the first audit](meetings-a11y-2026-11.md) (#3805), which covered the screens as of 2026-11-18. Standard: WCAG 2.2 AA as [DESIGN.md](../../DESIGN.md) section 7 sets it.

## Screens in this pass

| # | Screen | Where | File |
|---|---|---|---|
| 1 | Morning-notice setting card (#3982) | Notifications | `apps/app/src/components/morning-notice-setting.tsx` |
| 2 | Today view (#3968) | Meetings list | `meeting-agenda.tsx` (`TodayAgenda`) with `BriefBody` of `meeting-brief.tsx` |
| 3 | Weekly card, with the shared open-item line | Meetings list | `meeting-digest.tsx`, `meeting-open-item.tsx` |
| 4 | Title suggestion dialog (#3947) | Meeting page | `meeting-title.tsx` |
| 5 | Commitments list (#3954) | Meeting page | `meeting-commitments.tsx` |
| 6 | Adherence panel (#3959) | Meeting page | `meeting-adherence.tsx` |
| 7 | Language pickers: translation target (E3), the weekly card's window, the recorder's language | Meeting page, list, recorder | `meeting-translation.tsx`, `meeting-transcript-translation.tsx`, `meeting-digest.tsx`, `routes/meeting-record.tsx` |
| 8 | Transcript-cut note | Meeting page | `meeting-transcript.tsx` |

## How it was done

- **Code read**: each file above on `origin/main` at `fb97525` (2026-11-19), against WCAG 2.2 AA and the conventions the first audit set (live regions that are always in the page, a name for every repeated row button, focus kept after an action, `lang` on text in another language).
- **Contrast**: computed from the token file (`packages/ui/src/styles/globals.css`) the same way as in the first audit. The one pair these screens use that the first table does not list is `subtle-foreground` on `card` (the morning card's notes): 5.29 light, 5.93 dark (needs 4.5). Every other pair is in the first audit's table and passes.
- **Target size**: `Button` is at least 44 px high under the `md` breakpoint at every size (`packages/ui/src/components/button.tsx`), so the run and pick buttons meet DESIGN.md on a phone; the checkbox has an enlarged hit area (`after:-inset-x-3 after:-inset-y-2`).
- **Markup tests**: component tests that render on the server and read the markup (`apps/app/test/…`) hold what a static render can see: described-by links, live regions, names.
- **Browser evidence** (part 3, `e2e/tests/meetings-a11y-new-screens.spec.ts`, #4075; passed in CI on its first run): an axe scan (WCAG 2.2 AA serious and critical, plus the landmark and heading rules) of the Notifications page with the morning card off and on and of the meetings list with the Today view and the weekly card, in light and dark at 1280 and 360 px, none scrolling sideways; and a names and announcements test: the morning switch's name and description, the saved toast, the keyboard focus staying on the switch, each Today row's link described by its event title, the weekly card's picker name and its "showing N days" line with the focus staying on the picker. This is the browser evidence for N1 to N4, T1 and W1.
- **Not in a browser**: the Vy result screens (title dialog, commitments, adherence, the weekly recap) and the weekly card's error state: D1 to D3, C1 to C3, A1, O1 and W2 are held by markup tests only, because an axe run of them needs the fake model of the AI end-to-end specs (#4050) to produce an answer on screen. The focus return after a pick (D3) and the screen-reader-only count lines (D2, C1) are not covered by any automated test. Also not done: a screen reader walk by a person (NVDA or VoiceOver), which DESIGN.md section 7 keeps as a person's step before general availability.

Severity: **P1** blocks a task for some users; **P2** makes it hard or confusing; **P3** polish.

## Findings

Status: every finding below is fixed and merged (part 1, [#4061](https://github.com/DOS/Ludy/pull/4061); part 2, [#4073](https://github.com/DOS/Ludy/pull/4073)), except where a row says otherwise. The evidence is of two kinds, and the "Browser evidence" section says which finding has which: a markup test (a render without a browser), or the browser spec of part 3 ([#4075](https://github.com/DOS/Ludy/pull/4075)).

| # | Screen | Finding | Criterion | Sev | Fix | Status |
|---|---|---|---|---|---|---|
| N1 | 1 Morning card | The switch has no description: the hint ("a count and a link only, nothing on a day with no meeting") sits beside the card title and a screen reader reaching the switch does not hear it. | 1.3.1, 3.3.2 | P3 | The hint has an id and the switch's `aria-describedby` points at it. | Fixed (#4061) |
| N2 | 1 Morning card | Saving is silent: the switch moves and the time is saved when its field is left, and nothing says it was kept. | 4.1.3 | P2 | A toast "Đã lưu" / "Saved" on success (the toaster is a live region, as the template card does). | Fixed (#4061) |
| N3 | 1 Morning card | The time field is not told the zone it counts in (the line appears when the notice is on). | 1.3.1, 3.3.2 | P3 | `aria-describedby` points at the zone line while it is shown. | Fixed (#4061) |
| T1 | 2 Today view | "Ghi cuộc họp này" and "Đã ghi" repeat on every row with the same name. | 2.4.6, 4.1.2 | P2 | The row's title is each link's accessible description (the name is unchanged, as in the first audit's F9). | Fixed (#4061) |
| W1 | 3 Weekly card | Changing the window ("7, 14, 30 days") rewrites the facts below while the focus stays on the picker; nothing says which window is shown. | 4.1.3 | P3 | A polite line that is always in the page and is filled once the new window has loaded ("Đang xem 14 ngày gần đây"). Empty on load. | Fixed (#4061) |
| D1 | 4 Title dialog | The candidates each have a button named "Dùng": three buttons with one name. | 2.4.6, 4.1.2 | P2 | The candidate's text is each button's accessible description. | Fixed (#4073) |
| D2 | 4 Title dialog | The candidates appear without being announced (the live region holds only "running" and "renamed"), and the "no suggestion" line is inserted already carrying `role="status"`; the focus stays on "Gợi ý tên". | 4.1.3 | P2 | The always-present live region gets a screen-reader-only line that says how many suggestions there are, or "no suggestion"; the visible "no suggestion" paragraph is no longer a `role="status"` inserted with its text (the problem of A1). | Fixed (#4073) |
| D3 | 4 Title dialog | Picking a title or "none" removes the list and the button that held the focus; the focus falls to the top of the page. | 2.4.3 | P2 | The focus goes back to "Gợi ý tên". | Fixed (#4073) |
| C1 | 5 Commitments | The answer appears without being announced. | 4.1.3 | P2 | The always-present live region gets a screen-reader-only line that says how many lines there are for how many speakers, or "no suggestion". | Fixed (#4073) |
| C2 | 5 Commitments | Each line's time button is named only by its time ("12:03"); the sentence that says what it does is a `title`. | 2.4.6, 4.1.2 | P2 | The accessible name is the sentence that says what it does and contains the visible time ("Open the transcript at 12:03"), so label in name holds. | Fixed (#4073) |
| C3 | 5 Commitments | The time buttons are 16 px high, close together in a list. | 2.5.8 | P3 | A 24 px minimum height, as the adherence panel's cited lines already are, and 44 px on a phone. | Fixed (#4073) |
| A1 | 6 Adherence | The note "more than eight lines, the rest is left out" is rendered with `role="status"` already on it, so it is often not announced; the hint under the box is not linked to it. | 4.1.3, 3.3.2 | P3 | The status is always in the page and filled when it applies; the textarea's `aria-describedby` names the hint. | Fixed (#4073) |
| O1 | 3 Weekly card and Today view, open-item line | The fact number is a `span` with an `aria-label` and no role (a name on a generic element is not allowed by ARIA). | 4.1.2 | P3 | The label is dropped; the number stays as text because Vy's sentences cite it. | Fixed (#4073) |
| W2 | 3 Weekly card | Picking a window whose facts fail to load replaces the whole card, picker included, by the error line, so the focus is lost; the component's own comment says the picker must not vanish. Not reproduced in a browser. | 2.4.3, 3.3.1 | P3 | The error is shown inside the card and the picker stays. | Fixed (#4073) |
| N4 | 1 Morning card | The switch is a `span role="checkbox"` that takes its name from the wrapping `label` through the design system's checkbox (the same pattern as the mute switches above it). It was unverified in a browser, since the Notifications page was in no Meetings axe scan. | 4.1.2 | P2 if wrong | No change needed. The spec of part 3 finds the switch by its name, reads its description and axe-scans the Notifications page with the card off and on, in light and dark, at 1280 and 360 px: it passed in CI. | Confirmed (#4075) |

## Checked and fine, no change

- **Language pickers (screen 7).** The translation target picker, the weekly card's window and the recorder's language are native selects with a visible or `aria-label` name; the target picker writes each language in its own language with a `lang` on the option and on the translated text (WCAG 3.1.2).
- **Transcript-cut note (screen 8).** A plain `p` in the transcript card's header, read in order with the platform line above it, `text-xs` in `muted-foreground` on `card` (7.47 light, 8.29 dark). It is shown when the page loads, so it is not a status message and needs no live region.
- **Headings.** The card titles of the weekly card, the commitments list and the adherence panel carry `role="heading" aria-level="2"`; the sections inside are `h3` (the first audit's F3). The title dialog is a plain block under the meeting's transcript tools, with no card title of its own. The morning card's title is an `h2`, as the settings card above it on the Notifications page.
- **Run buttons.** The Vy buttons (title, commitments, adherence, weekly recap) have a visible name and show a spinner without changing the name. While a run is going the design system's `Button loading` makes the button natively disabled (`button.tsx`, #2116), so the focus leaves it; the status line beside it says the run is going and the result takes its place, which is the design system's choice and not changed here. The adherence and weekly recap buttons say why they are disabled in a status line beside them; the title and commitments buttons are absent when Vy is off, with no word about them, by design.
- **Whole answers are read in full.** The adherence and weekly recap answers sit inside one always-present polite region, so a screen reader reads the whole answer when it arrives. Verbose, not a failure; left as it is.
- **Contrast.** No new finding; see above.

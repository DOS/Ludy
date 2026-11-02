---
name: "Ludy"
version: "4.0"
date: "2026-11-02"
# Machine-readable tokens of the design system, for design tools and coding agents. Everything outside `rules` is copied
# from the CSS files and checked against them by tools/test/design-tokens.test.ts, so it cannot drift: when a value here
# and the CSS disagree, the CSS is right and this block is fixed. `rules` holds the values that DESIGN.md decides in prose
# (the CSS has no token for them); the test only checks that each one still appears in the text below.
colors:
  # packages/ui/src/styles/globals.css: light on :root, dark on .dark. Used by apps/app and packages/ui.
  app:
    light:
      background: "oklch(0.985 0.003 290)"
      foreground: "oklch(0.141 0.004 285.8)"
      card: "oklch(1 0 0)"
      card-foreground: "oklch(0.141 0.004 285.8)"
      popover: "oklch(1 0 0)"
      popover-foreground: "oklch(0.141 0.004 285.8)"
      primary: "oklch(0.49 0.22 290)"
      primary-foreground: "oklch(1 0 0)"
      secondary: "oklch(0.965 0.005 290)"
      secondary-foreground: "oklch(0.141 0.004 285.8)"
      muted: "oklch(0.965 0.005 290)"
      muted-foreground: "oklch(0.45 0.016 285)"
      subtle-foreground: "oklch(0.53 0.014 285)"
      accent: "oklch(0.965 0.005 290)"
      accent-foreground: "oklch(0.141 0.004 285.8)"
      destructive: "oklch(0.53 0.2 25)"
      success: "oklch(0.47 0.085 172)"
      warning: "oklch(0.52 0.12 62)"
      link: "oklch(0.46 0.2 290)"
      brand: "oklch(0.475 0.233 288.7)"
      brand-lip: "oklch(0.379 0.181 287.8)"
      brand-ink: "oklch(1 0 0)"
      brand-spark: "oklch(0.583 0.105 177.1)"
      brand-spark-lip: "oklch(0.47 0.084 178.1)"
      brand-spark-ink: "oklch(1 0 0)"
      border: "oklch(0.915 0.007 290)"
      input: "oklch(0.88 0.008 290)"
      field-border: "oklch(0.62 0.01 290)"
      ring: "oklch(0.55 0.2 290)"
      chart-1: "oklch(0.811 0.101 293.6)"
      chart-2: "oklch(0.606 0.219 292.7)"
      chart-3: "oklch(0.541 0.247 293)"
      chart-4: "oklch(0.491 0.241 292.6)"
      chart-5: "oklch(0.475 0.233 288.7)"
      sidebar: "oklch(1 0 0)"
      sidebar-foreground: "oklch(0.141 0.004 285.8)"
      sidebar-primary: "oklch(0.49 0.22 290)"
      sidebar-primary-foreground: "oklch(1 0 0)"
      sidebar-accent: "oklch(0.965 0.005 290)"
      sidebar-accent-foreground: "oklch(0.141 0.004 285.8)"
      sidebar-border: "oklch(0.915 0.007 290)"
      sidebar-ring: "oklch(0.55 0.2 290)"
      scrollbar: "oklch(0.72 0.012 290)"
      proposal: "oklch(0.5 0.13 245)"
      image-surface: "oklch(1 0 0)"
      label-red: "oklch(0.52 0.19 25)"
      label-orange: "oklch(0.56 0.15 50)"
      label-yellow: "oklch(0.55 0.11 90)"
      label-green: "oklch(0.52 0.13 145)"
      label-teal: "oklch(0.52 0.09 190)"
      label-blue: "oklch(0.52 0.15 255)"
      label-purple: "oklch(0.5 0.18 300)"
      label-pink: "oklch(0.55 0.18 350)"
    dark:
      background: "oklch(0.155 0.008 285)"
      foreground: "oklch(1 0 0)"
      card: "oklch(0.19 0.01 285)"
      card-foreground: "oklch(1 0 0)"
      popover: "oklch(0.19 0.01 285)"
      popover-foreground: "oklch(1 0 0)"
      primary: "oklch(0.75 0.13 293)"
      primary-foreground: "oklch(0.17 0.03 290)"
      secondary: "oklch(0.225 0.012 285)"
      secondary-foreground: "oklch(1 0 0)"
      muted: "oklch(0.225 0.012 285)"
      muted-foreground: "oklch(0.75 0.012 285)"
      subtle-foreground: "oklch(0.66 0.012 285)"
      accent: "oklch(0.225 0.012 285)"
      accent-foreground: "oklch(1 0 0)"
      destructive: "oklch(0.73 0.16 20)"
      success: "oklch(0.8 0.1 172)"
      warning: "oklch(0.83 0.13 80)"
      link: "oklch(0.8 0.11 293)"
      brand: "oklch(0.562 0.224 291.1)"
      brand-lip: "oklch(0.45 0.192 290.2)"
      brand-ink: "oklch(1 0 0)"
      brand-spark: "oklch(0.646 0.119 175.1)"
      brand-spark-lip: "oklch(0.504 0.091 176.7)"
      brand-spark-ink: "oklch(1 0 0)"
      border: "oklch(0.285 0.012 285)"
      input: "oklch(0.32 0.014 285)"
      field-border: "oklch(0.54 0.014 285)"
      ring: "oklch(0.75 0.13 293)"
      chart-1: "oklch(0.811 0.101 293.6)"
      chart-2: "oklch(0.606 0.219 292.7)"
      chart-3: "oklch(0.541 0.247 293)"
      chart-4: "oklch(0.491 0.241 292.6)"
      chart-5: "oklch(0.475 0.233 288.7)"
      sidebar: "oklch(0.19 0.01 285)"
      sidebar-foreground: "oklch(1 0 0)"
      sidebar-primary: "oklch(0.75 0.13 293)"
      sidebar-primary-foreground: "oklch(0.17 0.03 290)"
      sidebar-accent: "oklch(0.225 0.012 285)"
      sidebar-accent-foreground: "oklch(1 0 0)"
      sidebar-border: "oklch(0.285 0.012 285)"
      sidebar-ring: "oklch(0.75 0.13 293)"
      scrollbar: "oklch(0.46 0.015 285)"
      proposal: "oklch(0.78 0.11 245)"
      image-surface: "oklch(1 0 0)"
      label-red: "oklch(0.74 0.15 25)"
      label-orange: "oklch(0.79 0.13 55)"
      label-yellow: "oklch(0.86 0.13 95)"
      label-green: "oklch(0.8 0.14 145)"
      label-teal: "oklch(0.8 0.1 190)"
      label-blue: "oklch(0.76 0.12 255)"
      label-purple: "oklch(0.76 0.13 300)"
      label-pink: "oklch(0.78 0.13 350)"
    roles:
      background: "Page canvas."
      foreground: "Primary text."
      card: "Raised panels, cards, table containers."
      card-foreground: "Text on a card."
      popover: "Overlays: menus, popovers, dialogs."
      popover-foreground: "Text on an overlay."
      primary: "The one accent: the primary action, focus, current selection. Never decoration."
      primary-foreground: "Text and icons on primary."
      secondary: "Fill of secondary buttons and quiet panels."
      secondary-foreground: "Text on secondary."
      muted: "Quiet fills: hover rows, tinted blocks."
      muted-foreground: "Secondary text."
      subtle-foreground: "Captions that may be skipped; only where it still reaches 4.5:1."
      accent: "Hover and selected fill of menu items and rows. A neutral, not the brand accent."
      accent-foreground: "Text on accent."
      destructive: "Error and reject."
      success: "Balanced and approved (teal)."
      warning: "Needs review."
      link: "Link text."
      brand: "Logo mark only: the violet keys."
      brand-lip: "Logo mark only: the lips of the violet keys."
      brand-ink: "Logo mark only: the letters L, U and D."
      brand-spark: "Logo mark only: the teal Y key (Vy)."
      brand-spark-lip: "Logo mark only: the lip of the Y key."
      brand-spark-ink: "Logo mark only: the letter Y."
      border: "Hairlines of cards and dividers; never a field boundary."
      input: "Field fills."
      field-border: "Border of fields and checkboxes; at least 3:1 against background, card and popover."
      ring: "Focus ring."
      chart-1: "Data series 1 (sequential ramp)."
      chart-2: "Data series 2."
      chart-3: "Data series 3."
      chart-4: "Data series 4."
      chart-5: "Data series 5."
      sidebar: "Sidebar surface."
      sidebar-foreground: "Sidebar text."
      sidebar-primary: "Sidebar current item."
      sidebar-primary-foreground: "Text on the sidebar current item."
      sidebar-accent: "Sidebar hover fill."
      sidebar-accent-foreground: "Text on the sidebar hover fill."
      sidebar-border: "Sidebar dividers."
      sidebar-ring: "Sidebar focus ring."
      scrollbar: "The thumb of every scrollbar."
      proposal: "AI-proposed data nobody has approved yet: badge and dashed outline."
      image-surface: "Behind an image made for a white page, in either theme."
      label-red: "Post label hue."
      label-orange: "Post label hue."
      label-yellow: "Post label hue."
      label-green: "Post label hue."
      label-teal: "Post label hue."
      label-blue: "Post label hue."
      label-purple: "Post label hue."
      label-pink: "Post label hue."
  # apps/web/src/app/globals.css: light on :root, dark on :root[data-theme='dark']. Used by the marketing site.
  site:
    light:
      bg: "oklch(0.985 0.003 290)"
      surface: "oklch(1 0 0)"
      surface-2: "oklch(0.965 0.005 290)"
      fg: "oklch(0.2 0.02 285)"
      muted: "oklch(0.45 0.016 285)"
      subtle: "oklch(0.53 0.014 285)"
      line: "oklch(0.915 0.007 290)"
      line-strong: "oklch(0.72 0.012 290)"
      accent: "oklch(0.49 0.22 290)"
      accent-fg: "oklch(1 0 0)"
      accent-soft: "oklch(0.95 0.03 293)"
      accent-ink: "oklch(0.46 0.2 290)"
      ok: "oklch(0.47 0.085 172)"
      ok-soft: "oklch(0.95 0.025 172)"
      brand: "oklch(0.475 0.233 288.7)"
      brand-lip: "oklch(0.379 0.181 287.8)"
      brand-ink: "oklch(1 0 0)"
      brand-spark: "oklch(0.583 0.105 177.1)"
      brand-spark-lip: "oklch(0.47 0.084 178.1)"
      brand-spark-ink: "oklch(1 0 0)"
      warn: "oklch(0.52 0.12 62)"
      warn-soft: "oklch(0.96 0.045 80)"
      bad: "oklch(0.53 0.2 25)"
      scrim: "oklch(0.2 0.02 285 / 0.18)"
      canvas-dot: "oklch(0.85 0.01 290)"
    dark:
      bg: "oklch(0.155 0.008 285)"
      surface: "oklch(0.19 0.01 285)"
      surface-2: "oklch(0.225 0.012 285)"
      fg: "oklch(0.97 0.003 285)"
      muted: "oklch(0.75 0.012 285)"
      subtle: "oklch(0.66 0.012 285)"
      line: "oklch(0.285 0.012 285)"
      line-strong: "oklch(0.46 0.015 285)"
      accent: "oklch(0.75 0.13 293)"
      accent-fg: "oklch(0.17 0.03 290)"
      accent-soft: "oklch(0.3 0.06 293)"
      accent-ink: "oklch(0.8 0.11 293)"
      ok: "oklch(0.8 0.1 172)"
      ok-soft: "oklch(0.29 0.045 172)"
      brand: "oklch(0.562 0.224 291.1)"
      brand-lip: "oklch(0.45 0.192 290.2)"
      brand-ink: "oklch(1 0 0)"
      brand-spark: "oklch(0.646 0.119 175.1)"
      brand-spark-lip: "oklch(0.504 0.091 176.7)"
      brand-spark-ink: "oklch(1 0 0)"
      warn: "oklch(0.83 0.13 80)"
      warn-soft: "oklch(0.31 0.05 75)"
      bad: "oklch(0.73 0.16 20)"
      scrim: "oklch(0.08 0.01 285 / 0.5)"
      canvas-dot: "oklch(0.3 0.012 285)"
    roles:
      bg: "Page canvas."
      surface: "Raised panels and cards."
      surface-2: "Tinted bands and neutral chips."
      fg: "Primary text."
      muted: "Secondary text."
      subtle: "Captions that may be skipped."
      line: "Hairlines."
      line-strong: "Stronger rules and the scrollbar thumb."
      accent: "The one accent: primary action and focus ring."
      accent-fg: "Text on accent."
      accent-soft: "Soft accent fill: step badges, selection, accent chips."
      accent-ink: "Accent-colored text."
      ok: "Done and approved (teal)."
      ok-soft: "Fill of ok chips."
      brand: "Logo mark only: the violet keys."
      brand-lip: "Logo mark only: the lips of the violet keys."
      brand-ink: "Logo mark only: the letters L, U and D."
      brand-spark: "Logo mark only: the teal Y key (Vy)."
      brand-spark-lip: "Logo mark only: the lip of the Y key."
      brand-spark-ink: "Logo mark only: the letter Y."
      warn: "Needs review."
      warn-soft: "Fill of warn chips."
      bad: "Error."
      scrim: "The veil behind the sample command palette of the home page."
      canvas-dot: "The dot grid of the org chart canvas."
typography:
  # --font-* of the @theme inline block of each CSS file.
  app:
    font-sans: "'Be Vietnam Pro', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    font-heading: "var(--font-sans)"
    font-mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  site:
    font-sans: "var(--font-body), ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    font-display: "var(--font-body), ui-sans-serif, system-ui, sans-serif"
    font-mono: "var(--font-code), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  # The faces behind them: packages/ui/src/fonts/fonts.css (app) and apps/web/src/app/fonts.ts (site, through next/font).
  faces:
    app-sans: "Be Vietnam Pro, weights 400 500 600 700, static files, latin latin-ext vietnamese"
    app-mono: "JetBrains Mono, weight range 400 700, variable files, latin latin-ext vietnamese"
    site-sans: "Be Vietnam Pro, weights 400 500 600, variable --font-body"
    site-mono: "JetBrains Mono, weights 400 500, variable --font-code"
  faceWeights:
    app-sans: "400 500 600 700"
    app-mono: "400 700"
    site-sans: "400 500 600"
    site-mono: "400 500"
  siteBodyLineHeight: "1.6"
radius:
  # --radius and the scale derived from it in packages/ui/src/styles/globals.css (the marketing site uses Tailwind's
  # default radii: rounded-md is 0.375rem).
  base: "0.375rem"
  sm: "calc(var(--radius) * 0.6)"
  md: "calc(var(--radius) * 0.8)"
  lg: "var(--radius)"
  xl: "calc(var(--radius) * 1.4)"
  2xl: "calc(var(--radius) * 1.8)"
  3xl: "calc(var(--radius) * 2.2)"
  4xl: "calc(var(--radius) * 2.6)"
layout:
  # apps/web/src/app/globals.css (.wrap, html, :focus-visible) and both files (scrollbar).
  site-content-max-width: "calc(1200px + 3rem)"
  site-gutter-phone: "1rem"
  site-gutter-640-up: "1.5rem"
  site-scroll-padding-top: "4.5rem"
  site-focus-outline: "2px solid var(--accent)"
  site-focus-outline-offset: "2px"
  scrollbar-size: "8px"
motion:
  # The ambient loop of the hero chart (site) and what prefers-reduced-motion: reduce does (both files).
  site-travel-up: "3.6s ease-in-out infinite"
  app-reduced-animation-duration: "0.01ms"
  site-reduced-animation-duration: "1ms"
parity:
  # Each marketing token and the app token it equals, in both themes (DESIGN.md 3.1). The exceptions are listed.
  bg: "background"
  surface: "card"
  surface-2: "secondary"
  fg: "foreground"
  muted: "muted-foreground"
  subtle: "subtle-foreground"
  line: "border"
  line-strong: "scrollbar"
  accent: "primary"
  accent-fg: "primary-foreground"
  accent-ink: "link"
  ok: "success"
  warn: "warning"
  bad: "destructive"
  brand: "brand"
  brand-lip: "brand-lip"
  brand-ink: "brand-ink"
  brand-spark: "brand-spark"
  brand-spark-lip: "brand-spark-lip"
  brand-spark-ink: "brand-spark-ink"
  exceptions: "fg"
rules:
  # Decided in DESIGN.md prose; each value must still appear in the text (the test checks that).
  type-scale-rem:
    marketing-h1: "2.375, 3 from 640px, 3.75 from 1024px (3.5 on app pages), weight 600"
    marketing-h2: "1.75, 2.25 from 640px"
    marketing-h3: "1.125 to 1.5"
    marketing-body: "1 to 1.125"
    marketing-small: "0.875"
    app-h1: "1.25 (`PageHeader`; 1.125 on some older screens), weight 600"
    app-h2: "1 or 0.875"
    app-h3: "0.875"
    app-body: "0.875"
    app-small: "0.75"
  type-weights: "400 body, 500 UI labels, 600 headings"
  radius-px:
    controls: "6px"
    cards: "8px"
    dialogs-and-large-tiles: "12px maximum"
    chips-and-avatars: "Full round allowed"
    table-cells: "0"
  spacing-base: "4px base unit"
  spacing-scale-px: "4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128"
  breakpoints-checked-px: "360, 768, 1280, 1920px"
---

# Ludy design system and UI/UX guidelines

Version 4.0 (2026-11-02). Applies to the marketing site (`apps/web`, ludy.vn), the web app (`apps/app`) and the component package (`packages/ui`). Written for engineers, designers and coding agents. The machine-readable tokens are the block at the top of this file; the research behind each rule, with sources and measurements, is summarized in [docs/design/ui-ux-research-2026-10.vi.html](docs/design/ui-ux-research-2026-10.vi.html).

## What changed since 3.0 (2026-10-18)

- **Names and logo.** Ludy is the suite and Vy the AI assistant (2026-10-28, [#1682](https://github.com/DOS/Ludy/issues/1682)); the logo is four violet keys that spell L, U, D and Y, the Y key teal (2026-11-01, [#2200](https://github.com/DOS/Ludy/issues/2200), [#2293](https://github.com/DOS/Ludy/issues/2293)). Section 1.1 and 1.2 say what is current; the Crove ring mark and the three-tile mark with a spark (Ô tia, [#2052](https://github.com/DOS/Ludy/issues/2052)) are gone.
- **What Ludy is.** Section 1 describes the apps as they are today (Ludy Kế toán, Ludy CRM, Ludy Notes, Social, Vy) and the focus on one-person companies and SMEs first (owner decision, 2026-10-31).
- **App pages on ludy.vn.** Section 6.4 is new: the shared app page template, the `APP_PAGES` registry, the routes of each app in both languages, the call-to-action line for apps that are not on Ludy Cloud yet, and the rule that a claim needs a merged PR behind it ([#2280](https://github.com/DOS/Ludy/issues/2280), [#2281](https://github.com/DOS/Ludy/issues/2281), [#2282](https://github.com/DOS/Ludy/issues/2282)). Section 6.1 is the home page as it is now.
- **Rules added piecemeal are now in their places:** form field borders reach 3:1 ([#2114](https://github.com/DOS/Ludy/issues/2114), 3.1 and 7), every screen has a title, a skip link and a focus move on navigation ([#2115](https://github.com/DOS/Ludy/issues/2115), 7), `<Button loading>` ([#2116](https://github.com/DOS/Ludy/issues/2116), 4.1), reduced motion in the app's base layer ([#1605](https://github.com/DOS/Ludy/issues/1605), 3.6).
- **Token block.** All colors per theme with their role, font families and weights, the radius scale, layout and motion values are in the front matter, taken from the two CSS files and held to them by `tools/test/design-tokens.test.ts`.
- **Code follows it** ([#2351](https://github.com/DOS/Ludy/issues/2351)): the loading Button's spinner keeps turning under reduced motion, no floating element or deal card combines a border or ring with a wide shadow, lucide icons draw at stroke 1.5 from one default, and the Ludy Kế toán page's call to action reads like the other app pages.
- **Corrected.** The type scale and the motion durations are what the code ships (the v3 scale and the 120, 200 and 320ms values with their curves are dropped; the owner has seen and accepted the shipped sizes). The sample confidence line of 5.1 now says what the app says (a learned rule), not a counter it does not have. The marketing site's tokens equal the app's except the primary text color (3.1); the marketing site loads three Be Vietnam Pro weights, the app four (3.2); the domains and the repository have moved (1.1); the app shell has an app switcher with a short menu per app (3.4, 9); the sidebar, scrollbar, image and post-label tokens are in the roles table (3.1).

## Decision records

The owner's picks and the product owner's rulings, kept with their dates. A later decision replaces an earlier one only where it says so.

| Date | Decision | Where |
| :--- | :--- | :--- |
| 2026-10-18 | Visual direction, from the [mockups](docs/design/mockups/): the frame of mockup B (the product UI is the hero, keyboard-first, graphite neutrals), the agents section of E, the phone section of D, the ledger of A. Radius 6px for controls (the v2 look was too round). | the line under this table, 3.3 |
| 2026-10-19 | Option C (paper invoice, seal and routing slip) dropped. Per element from one page: the hero of E (headline centered on top, the live org chart at full width under it), the how-it-works pipeline of E (four stages of equal height, each with a small piece of the app), the module grid of E (each module with its people and agents). | 6.1 |
| 2026-10-19 | Light is the default theme everywhere; the app lets each user pick light, dark or system. | 3.1 |
| 2026-10-19 | Be Vietnam Pro for headings, body and UI; JetBrains Mono for amounts and codes. | 3.2 |
| 2026-10-28 | The product is Ludy, the AI assistant is Vy ([#1682](https://github.com/DOS/Ludy/issues/1682), [#1683](https://github.com/DOS/Ludy/issues/1683)). | 1.1 |
| 2026-10-30 | The landing page is served on ludy.vn (canonical) and ludy.so, the hosted app on app.ludy.vn (ADR-0027). | 1.1, 6 |
| 2026-10-31 | One-person companies and SMEs first; enterprise models wait. | 1 |
| 2026-11-01 | The logo is four keys that spell L, U, D and Y. Interim: the owner is still choosing among the round-2 options of the logo canvas. | 1.2 |
| 2026-11-01 | Frontend PO ruling on the app pages: the call to action for an app not on Ludy Cloud yet says it is in the self-hosted edition and that Ludy Cloud is coming soon, with no plan, tier or price; no unbuilt feature is named (Ludy CRM and Ludy Notes use the exact line of 6.4, Ludy Kế toán says the same in its own words). | 6.4 |
| 2026-11-02 | Frontend PO ruling ([#2351](https://github.com/DOS/Ludy/issues/2351)): all three app pages use that line, with the app's own name; Ludy Kế toán's page changed to match. | 6.4 |
| decision D5 | Social is paused, except the slice the owner reopened on 2026-11-01 (the Facebook Page and Zalo OA channels, [#236](https://github.com/DOS/Ludy/issues/236)). Screens of the paused part are the only exceptions to the rules below that say so (4.1). | 4.1 |

The visual direction in one line: the brand violet is the single, restrained accent, and teal marks done and approved states (`ok` on the marketing site, `success` in `packages/ui`); controls use a 6px radius; the marketing site implements it in `apps/web` (tokens in `apps/web/src/app/globals.css`) and the web app's `packages/ui` tokens use the same values (3.1), with the `proposal` token for AI proposals nobody has approved yet.

---

## 1. What we are designing

Ludy is an open-source, AI-native Business OS for one-person companies, solo founders and SMEs, Vietnam first. The first job it does well: purchase invoices come in, Ludy reads and checks them, proposes a TT133 journal entry, and a person approves it. The apps share one kernel, one approval model and one audit log:

- **Ludy Kế toán** (accounting): the AI Inbox, TT133 books, VAT and the tax calendar, vouchers, fixed assets, bank statements, exports. The core app, and the one the product leads with.
- **Ludy CRM**: contacts shared with Ludy Kế toán, deals on a board by stage, the public booking page and the calendar.
- **Ludy Notes**: notes and personal to-dos, linked to the records they are about. A product of its own on ludy.vn; its screens sit in the app's Home.
- **Social**: posts and channels, with an Ads group; paused under decision D5 except the Facebook Page and Zalo OA slice (see the decision records).
- **Vy**, the AI assistant, works inside these apps: it reads, proposes, suggests and drafts, and a person approves.

The shell's apps are Home (the overview, the AI Inbox, Tasks, Notes, "Việc của tôi" and notifications), Ludy Kế toán, Ludy CRM and Social. The organization's own screens (the org chart with its AI settings, and Settings) belong to no app.

The people using it:

- **Owners of one-person companies, small companies and shops.** Not accountants. Often on a phone. They need to know what needs them today and to trust what the system did.
- **Accountants and bookkeepers** (in-house or at a service firm). Daily, heavy use, keyboard-first, many organizations. They need density, exact numbers and fast review.
- **Technical founders** who self-host. They need to see that it runs with `docker compose up` and that the code is open.

OPC and SME needs come first (owner decision, 2026-10-31): a feature for an enterprise model, many entities of one group or a large team waits until the core is solid.

### 1.1 Names

The owner renamed the product on 2026-10-28 ([#1682](https://github.com/DOS/Ludy/issues/1682)); what users see follows it ([#1683](https://github.com/DOS/Ludy/issues/1683)).

- **Ludy** is the suite, the Business OS. It is the default of `BRAND_NAME`; a deployment that sets its own name shows that name everywhere instead, and no screen names both.
- **Vy** is the AI assistant. Copy names Vy wherever the AI is the one acting: Vy reads, proposes, suggests, drafts and rewrites. The first mention on a screen says what Vy is ("Vy, the AI assistant", "trợ lý AI Vy"). App messages write `{assistant}`, never the name itself (`apps/app/src/i18n/brand.ts`).
- "AI" stays where it labels the technology rather than the assistant: the badges and marks on AI-written content, the kill switch, AI budgets, a server's AI configuration, the "AI agent" label every agent in the org chart carries, and platform labels such as TikTok's AI-generated content.
- Products are named "Ludy" and the area: **Ludy CRM**, **Ludy Accounting** (Vietnamese: **Ludy Kế toán**, the word the app's menu and its users already say), **Ludy Notes**. App messages write `{brand} CRM`, so a deployment's own name carries over. The short label under an app's icon stays the area alone.
- **Ludy Cloud** is the hosted edition, not live yet; copy says "coming soon" and promises nothing more (6.4). DOS-only services belong to the private cloud layer (ADR-0027), never to this repository's copy.
- Domains: ludy.vn (canonical) and ludy.so for the landing page, app.ludy.vn for the hosted app (2026-10-30, ADR-0027). The repository is `DOS/Ludy`. Code identifiers keep the code name `crove` (`@crove/*`, `crove_*`, `CROVE_*`, file names, the `[Crove]` log prefix), as the README says; users never see it.

### 1.2 Logo

The mark is interim: the owner is still choosing among the round-2 options of the logo canvas. Since 2026-11-01 ([#2293](https://github.com/DOS/Ludy/issues/2293)) it is four violet rounded keycaps in a 2 by 2 grid that spell L, U, D and Y in capitals, the Y key teal. The teal key is Vy, the AI assistant. The brand name stays "Ludy"; capitals are for the keys only, and the Y is not a Vietnamese Ý, since the brand is meant for markets abroad too. It replaces the same keys with an accented lowercase y ([#2200](https://github.com/DOS/Ludy/issues/2200)), and before that three tiles in an L with a spark ([#2052](https://github.com/DOS/Ludy/issues/2052)).

- Files: `apps/web/public/brand/` holds the mark and the wordmark (the mark and "Ludy" in Be Vietnam Pro SemiBold, as outlines, the y in teal), each in a light and a dark version, the 16 and 32 px favicons, the 512 px app icon and the Apple touch icon. `favicon.svg` (landing page and app) draws the four keys without letters and switches to the dark colors when the browser is dark. The app's install icons are `apps/app/public/assets/icon-*.png`. The social preview is drawn from the dark mark by `apps/web/src/components/og-image.tsx`.
- Colors: the three violet keys take `brand` (#612BD3, dark #7C4DEB) and their lips `brand-lip` (#44209A, dark #5A33B5); the Y key takes `brand-spark` (#0F8F7A, dark #13A58A) and its lip `brand-spark-lip` (#0A6A5B, dark #0B7563). The letters L, U and D are `brand-ink` and the Y is `brand-spark-ink`, white in both themes; the dark theme's teal is deep enough for white to reach 3.1:1 (white on #0F8F7A is 4:1). The six tokens are for the mark only, never for UI.
- Use: always the whole mark, never a key alone, never recolored, rotated or with a face added. At least a quarter of its width of clear space around it. It carries its letters from 20 px up (the footer of the landing page is its smallest place); the 16 and 32 px favicons, which a tab shows at 16 px, drop the letters and keep the four keys, the teal one at the lower right, so a tab still shows a violet grid with one teal key. The wordmark file sets its y in the teal of the Y key; live text beside the mark (the header, the footer, the social preview, the app) stays one color.
- Geometry, to redraw a size by hand: one 92 unit grid, four keys 43 wide and 39 tall with a corner radius of 11, each with a lip of 4 (the same shape 4 lower, in the lip color), and a gap of 6 between keys and between a lip and the next row: L at (0, 0), U at (49, 0), D at (0, 49), Y at (49, 49). The letters are round-capped strokes 7 wide, centred on each face and 22.8 high (11.4 above and below its centre); the Y's arms run from the top corners of a box 17.1 wide and meet 0.6 below the centre, where the stem goes down. The install icons are the mark on a white rounded square (mark at 60% of the width, corner radius 22%); the maskable icon is the mark at 53% of the width on a square white ground, inside Android's safe zone. The favicons are drawn on their own pixel grids so the keys stay apart: 16 px with keys 7 by 6, a lip of 1 and a gap of 2, and 32 px with keys 14 by 12, a lip of 2 and a gap of 4, both without letters. The wordmark is "Ludy" in Be Vietnam Pro SemiBold (600, the heading weight of section 3.2, the same as the live text beside the mark in the header, the footer, the social preview and the app), outlined with the font's cap height at 60 units on a baseline at 76, with its origin at x = 116 (the mark's width and a gap of 24), kerning on and letter spacing of -0.02 em, in a box as wide as the text's advance rounded up (311), and as high as the mark, with the y as a path of its own in the teal of the Y key.
- The PNG files are icons linked from `<head>` or the install manifest, not page content, so the rule that raster images are AVIF or WebP (section 6) does not apply to them.
- Similar marks: only a rough web look was done (three searches), not a trademark search. It found no logo of letter keys in a 2 by 2 grid and no product named Ludy with a logo, and these near misses for the lawyer: a 2 by 2 grid of squares is the shape of Microsoft's logo and of letter-tile word games such as Wordle, and a white letter on a colored rounded square is the style of the Y Combinator mark. The trademark search for the mark, with the names Ludy and Vy, is the lawyer's, in [#63](https://github.com/DOS/Ludy/issues/63).

## 2. Principles

1. **Show the product working.** Every important claim on the marketing site is backed by a visualization of the real product with real-looking Vietnamese data (an invoice, its checks, the journal entry it becomes). Text explains what the picture cannot. A section that is only an icon, a heading and two sentences is not finished.
2. **A proposal looks like a proposal.** AI output is tainted until a person approves it. Proposed data is visually distinct from posted data everywhere (state chip, outline style, the word "Đề xuất"), and the approve action states exactly what it will post.
3. **Calm density.** Accountants scan hundreds of rows. Prefer compact rows, aligned numbers and quiet chrome over big cards and whitespace for its own sake. Density comes from alignment and hierarchy, not from smaller text.
4. **Vietnamese first.** Copy, typography, number and date formats are designed for Vietnamese and then translated to English, never the other way round.
5. **Exact numbers.** Money is never rounded for display unless the label says so, digits are tabular, amounts are right-aligned, and totals visibly reconcile.
6. **One bold thing per view.** One accent color, one primary action, one memorable visual per page. Everything around it stays quiet.
7. **Accessible by default.** WCAG 2.2 AA is the floor, not a later task.

## 3. Foundations

### 3.1 Color

All colors are tokens in [packages/ui/src/styles/globals.css](packages/ui/src/styles/globals.css) (OKLCH, light on `:root`, dark on `.dark`). The marketing site has its own token file, [apps/web/src/app/globals.css](apps/web/src/app/globals.css), with names of its own (`bg`, `surface`, `fg`, `line`, `accent`, `ok`, `warn`, `bad`); its values equal the app's counterparts in both themes, except `fg`, the primary text, which is a little softer (light `oklch(0.2 0.02 285)` against the app's `oklch(0.141 0.004 285.8)`, dark `oklch(0.97 0.003 285)` against white). The `parity` map of the token block lists the counterparts and `tools/test/design-tokens.test.ts` holds them equal. The exact values of every token, per theme and role, are in the token block at the top of this file; the CSS files stay the source of truth.

Components use token classes only; `pnpm lint` rejects palette classes and literal colors in `apps/app` and `packages/ui` ([tools/ui-colors.mjs](tools/ui-colors.mjs)). `apps/web` follows the same rule by convention until it moves onto `@crove/ui`.

Roles (app token names; the marketing counterparts are in the token block):

| Token | Role |
| :--- | :--- |
| `background`, `card`, `popover` | Page canvas, raised panels, overlays. Three surface levels at most per screen. |
| `foreground`, `muted-foreground`, `subtle-foreground` | Primary text, secondary text, captions. `subtle-foreground` only for text that may be skipped, and only where it still reaches 4.5:1. |
| `border`, `input`, `field-border`, `ring` | Hairlines of cards and dividers, field fills, the border of fields and checkboxes, focus ring. `field-border` reaches 3:1 against `background`, `card` and `popover` in both themes (WCAG 1.4.11); `border` stays a hairline and is never a field boundary. |
| `secondary`, `muted`, `accent` (and their `-foreground`) | Quiet fills: secondary buttons, hover rows and tinted blocks, hover and selected menu items. Neutral; `accent` here is shadcn's hover fill, not the brand accent. |
| `link` | Link text. |
| `sidebar-*` | The sidebar's surface, text, current item, hover fill, divider and ring. |
| `scrollbar` | The thumb of every scrollbar: thin, on a transparent track, in both themes (never the platform's light default). |
| `primary` | The one accent: the primary action, focus, current selection. Never decoration. |
| `brand`, `brand-lip`, `brand-ink`, `brand-spark`, `brand-spark-lip`, `brand-spark-ink` | The logo mark only: its violet keys, the teal Y key, their lips and their letters (1.2). |
| `success`, `warning`, `destructive` | Semantic states (balanced/approved, needs review, error/reject). Separate from the accent; never used for decoration. |
| `proposal` | AI-proposed data nobody has approved yet (below). |
| `image-surface` | Behind an image made for a white page, in either theme (the tax portal's CAPTCHA, [#325](https://github.com/DOS/Ludy/issues/325)). |
| `label-red` to `label-pink` | The hues a member picks for a Social post label ([#639](https://github.com/DOS/Ludy/issues/639)); gray uses the neutral tokens. |
| `chart-1..5` | Reserved for data series (no chart uses them yet). Sequential ramp for one measure; use semantic tokens for good/bad. |

Rules:

- About 90 percent of any screen is neutral. The accent marks what to do next; semantic colors mark state.
- Neutrals carry a slight hue bias toward the accent. No pure mid-grey.
- No gradients on text, buttons or backgrounds. No radial glows, no glass blur as decoration, no colored shadows.
- Both themes are designed, not inverted: check contrast and the accent separately in each. Light is the default everywhere (the owner's decision, 2026-10-19): the app opens light and lets each user pick light, dark or system (next to the language switch and in the command palette; applied before first paint by `apps/app/public/assets/theme-boot.js`); the marketing site is light unless the visitor turns dark on with its toggle. The marketing site offers only light and dark (it is another origin, so the app's setting does not reach it); only the app can follow the system, when the user chooses "system".
- `proposal`: AI-proposed data nobody has approved yet. Use the `proposal` badge variant and a dashed `border-proposal` outline (the AI Inbox journal card does), never the accent, so principle 2 has one consistent look.

### 3.2 Typography

- **Every font must ship the Vietnamese subset** and render stacked diacritics (`Ở`, `ữ`, `ặ`) cleanly at all weights. Test with "Hoá đơn giá trị gia tăng, Thuế GTGT được khấu trừ, Người mua hàng" before adopting a face.
- At most two families: one for display and UI, an optional second for display or for numbers. Monospace only for amounts in dense tables, account numbers, codes (MST, mã CQT, invoice numbers) and keyboard keys, never for decorative labels.
- Subset to latin, latin-ext and vietnamese, `font-display: swap`, self-hosted in production (no third-party font requests from the app). Use the variable font where the family has one (JetBrains Mono); Be Vietnam Pro has none, so the app ships the four static weights its UI uses, 400 to 700. The app's files and their OFL licenses live in `packages/ui/src/fonts/`; the marketing site loads the same faces through `next/font` (Be Vietnam Pro 400, 500 and 600; JetBrains Mono 400 and 500, `apps/web/src/app/fonts.ts`). The families, weights and CSS variables are in the token block.
- Line height: running text at least 1.55 (the marketing body is 1.6; the app's UI text takes Tailwind's own line heights, 1.43 at 0.875rem), headings at least 1.12. Letter spacing on headings no tighter than -0.025em, or diacritics collide. No all-caps on Vietnamese phrases longer than two words; uppercase labels get `tracking-wide` (+0.025em).
- Line length 60 to 75 characters for running text.
- Numbers: `font-variant-numeric: tabular-nums` wherever digits line up.

Scale as shipped (rem at 16px root, measured 2026-11-02; new screens follow it):

| Role | Marketing | App |
| :--- | :--- | :--- |
| H1 / hero | 2.375, 3 from 640px, 3.75 from 1024px (3.5 on app pages), weight 600 | 1.25 (`PageHeader`; 1.125 on some older screens), weight 600 |
| H2 | 1.75, 2.25 from 640px | 1 or 0.875 |
| H3 | 1.125 to 1.5 | 0.875 |
| Body | 1 to 1.125 | 0.875 |
| Small / caption | 0.875 | 0.75 |

Weights: 400 body, 500 UI labels, 600 headings. 800 is not used; size and spacing make hierarchy, not extreme weight.

### 3.3 Shape (radius)

Feedback on v2 was that controls looked dated because they were too round. Measured on 2026-10-18: Stripe primary buttons 4px, Raycast 6px, Attio 10px, Linear and Vercel pill only for small marketing nav buttons. A July 2026 survey of 514 design systems found pills most common overall (32 percent) but concentrated in consumer products; finance and B2B tools sit at 4 to 12px. Ludy is a finance tool.

| Element | Radius |
| :--- | :--- |
| Buttons, inputs, selects, segmented controls | 6px (`--radius: 0.375rem`; components use `rounded-lg`, which is `--radius`; the `sm`, `xs` and small icon buttons use `--radius-md`, 4.8px) |
| Cards, panels, table containers | 8px (cards use `rounded-xl`, `--radius` times 1.4, about 8.4px) |
| Dialogs, sheets, large marketing tiles | 12px maximum |
| Chips, status badges, avatars, toggles | Full round allowed; these are small and not actions |
| Table cells, dividers | 0 |

Never more than 12px on a container, never pill on a primary action. Radius follows hierarchy: a smaller element inside a larger one gets the same or a smaller radius. The radius scale of `packages/ui` is in the token block; the marketing site uses Tailwind's default radii, where `rounded-md` is the 6px of its buttons.

### 3.4 Space and layout

- 4px base unit. Scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128.
- Related items sit close; groups are separated by at least twice the inner spacing. Equal spacing everywhere flattens hierarchy.
- Use `gap` in flex and grid, not per-element margins.
- Marketing: max content width 1200px (the `.wrap` column adds a 1rem side gutter, 1.5rem from 640px, that also clears a phone's side system bar), left-aligned text by default. Section padding 96px desktop, 64px phone.
- App: a sidebar with an app switcher and a short menu for the app in use, plus content; on a phone the menu is a drawer. List and detail side by side on wide screens (the AI Inbox, from 84rem), stacked below.
- Check every screen at 360, 768, 1280, 1920px; CI automates 360 and 1280. No horizontal page scroll at 360px; wide tables scroll inside their own container.
- Separate sections with space and typography first, hairlines second, boxes last. Do not nest cards.

### 3.5 Elevation

- Hairline borders define surfaces. Shadows are reserved for things that float: popovers, menus, dialogs, toasts, the command palette. One shadow style per level, neutral, never colored.
- Never combine a hairline border or ring with a wide soft shadow on the same element: a floating element takes its hairline and at most `shadow-sm`. In the app, per component, the dialogs, command palette, toasts and pickers take the hairline alone and a deal card takes its border alone. The marketing site's product mockups (the sample command palette and the phone frame) are not covered by the test yet. `packages/ui/test/no-border-with-shadow.test.ts` fails on the combination.

### 3.6 Motion

- Durations are Tailwind's defaults: 150ms for transitions, 100ms for the dialog. There are no motion tokens and no custom easing curves. No bounce or elastic on routine UI.
- Motion answers an action or shows what changed (a row moving to "Đã duyệt", a total reconciling). Status that is not changing does not pulse or blink.
- Marketing pages get at most one orchestrated moment (for example the invoice becoming a balanced entry). Content is fully visible at rest; nothing waits at `opacity: 0` for a scroll observer.
- The one ambient loop allowed is the hero chart's proposal path: a small dot travels slowly up the dashed line from an agent to its manager, the way a proposal goes up for approval. Scroll-linked motion may move decoration (the pipeline's check marks), never hide text.
- Reduced motion (#1605): when the system asks for it, nothing slides, zooms, fades or pulses. In the app's base layer every animation and transition ends at once (a near-zero duration, so the `animationend` and `transitionend` events overlays wait for still fire); the spinners keep turning, the standalone `<Spinner>` (`data-slot="spinner"`) and the one of a loading `Button` (`data-slot="button-spinner"`), being the only sign that work is running (WCAG 2.3.3 counts that as essential); `packages/ui/test/spinner-reduced-motion.test.ts` fails when a spinning element is left out of the exception, and scroll-linked fades follow the user's own scroll and keep working. On the marketing site the ambient loop is not drawn and the check marks do not animate. Any other non-essential motion sits inside `@media (prefers-reduced-motion: no-preference)`.
- No marquees, no auto-advancing carousels, no hover zoom on images, no scale-on-hover buttons.

### 3.7 Icons

- `lucide-react`, stroke 1.5, 16px in dense UI and 20px elsewhere, colored with `currentColor`. The default is set once, not per icon: `<IconDefaults>` (`packages/ui/src/components/icon-defaults.tsx`) wraps the app's root, and one stylesheet rule does the same on the marketing site, whose sections ship no client JavaScript. Spinners and check marks are the exceptions: they draw heavier (2 to 3) so they stay legible when small, and name their width themselves (never 2 on the marketing site, where the rule would turn it into 1.5). `packages/ui/test/icon-stroke.test.ts` and `apps/web/test/icon-stroke.test.ts` hold both.
- An icon sits beside its label. No icons inside colored rounded tiles above headings. No emoji as icons.

## 4. Components (`packages/ui`)

Components come from shadcn (base-nova style on Base UI) and are themed only through tokens. Add new ones with `pnpm dlx shadcn@latest add <name>` in `packages/ui`.

### 4.1 Buttons

- Sizes: 28px (`sm`, toolbars and table rows), 32px (`default`, app), 36px (`lg`, forms and dialogs), 40 to 44px (marketing CTAs and touch-first screens). Hit target never below 24x24px.
- Variants: `default` (primary, one per view), `outline` / `secondary`, `ghost` (toolbars), `destructive` (tinted, not solid red, unless it is the confirm step of a destructive dialog), `link`.
- Labels are verbs in sentence case that say what happens: "Duyệt bút toán", "Xuất Excel", "Gửi lời mời". The resulting toast uses the same verb: "Đã duyệt bút toán".
- No arrow appended by default, no gradient, no glow shadow, no scale on hover. Press feedback is the existing 1px translate.
- Loading keeps the label and width, adds a spinner, and disables the button. It is `<Button loading={isPending}>`, never a `<Spinner>` placed in the button: the label stays in the flow (invisible by opacity, so the width does not change and it stays the button's name), the spinner is centered over it at the button's icon size and is `aria-hidden`, and the button gets `aria-busy`, `data-loading` and a native `disabled`, so a second press cannot repeat the action (#2116). The result is announced by the toast or the screen, not by keeping focus on a dead control. `packages/ui/test/button-loading.test.ts` holds the markup and `apps/app/test/button-loading.test.ts` fails on a Spinner inside a `Button`; only the paused Social screens are listed as exceptions (decision D5).

### 4.2 Forms

- Label above the field, always visible; placeholder is an example, never the label.
- Validate on blur and on submit, not on every keystroke. The error says what is wrong and how to fix it ("MST phải có 10 hoặc 13 chữ số"), sits under the field and is linked with `aria-describedby`.
- Do not ask for the same information twice in one flow (WCAG 3.3.7). Allow paste into one-time-code fields and let password managers fill credentials (WCAG 3.3.8).
- Money inputs accept "32832000", "32.832.000" and "32,832,000" and display Vietnamese grouping on blur. Values travel as decimal strings (see AGENTS.md).
- Fields and checkboxes draw their border with `field-border`, never `input` or `border` (3.1, #2114).

### 4.3 Tables

- Row height 36px, the only density built; 44px (comfortable, for touch) is the target for touch-first tables. Sticky header. Zebra striping off; hover row tint on.
- Amounts right-aligned, tabular, same number of decimals in a column; codes and account numbers in the numeric face; text left-aligned.
- Totals row visually separated by a stronger rule, never by color alone.
- Empty, loading (skeleton rows of the right height) and error states are designed for every table.

### 4.4 Status chips

- Small, full-round, text plus a semantic color, never color alone: "Đề xuất", "Cần xem", "Đã duyệt", "Từ chối", "Lỗi".
- One chip vocabulary across the apps so the same state always looks the same.

### 4.5 Overlays

- Dialog for decisions that block (approve with step-up, destructive confirm). Sheet for side detail on narrow screens. Popover for small pickers. Toast for results, with an undo where the action allows it.
- Focus moves into the overlay and returns to the trigger on close. Overlays never cover the focused element (WCAG 2.4.11).

## 5. Interaction patterns

### 5.1 Human approval of AI proposals (AI Inbox, agent proposals)

Every proposal screen answers, in this order:

1. **What is proposed**: the exact entry or action, in the form it will be posted (Nợ / Có lines, amounts, accounts).
2. **Why**: the evidence (the source document side by side) and the deterministic checks with their results (tổng dòng, thuế suất, MST, mã CQT, trùng lặp). A failed check is shown first and blocks approval or requires an explicit override with a reason.
3. **Who proposed it**: the agent or rule, its confidence signal in plain words ("Theo quy tắc đã học: cùng mặt hàng của nhà cung cấp này"), never a bare percentage.
4. **What happens next**: the approve button names the outcome ("Duyệt và ghi sổ"); step-up two-factor appears inline when the risk requires it.

Approve, edit and reject have equal visual access (reject is not hidden in a menu). Bulk approval exists only for items whose checks all passed and is limited to what fits on one screen. Every decision links to its audit log entry.

### 5.2 Keyboard

- `⌘K` / `Ctrl K` opens the command palette on every screen of an organization. It goes to screens and runs commands, and where the apps run it also searches the org's data without Vietnamese marks: parties by name or tax code, invoices by number or party, journal entries by description or amount (`finance.search`, #673), and notes (#1745).
- In the AI Inbox and on Social posts: `J` or `N` and `K` or `P` move between items and `Enter` opens one; on a proposal's own screen `A` approves, `E` edits and `R` rejects; `Esc` closes. The keys are listed in a hint line on the screen, and every one has a pointer equivalent.
- Drag interactions always have a non-drag alternative (WCAG 2.5.7): the deal board's stage select on each card is the example.

### 5.3 Empty, loading and error states

- Empty states say what will appear and give the one action that fills them ("Chuyển tiếp hoá đơn tới địa chỉ này hoặc tải file XML lên").
- Loading uses skeletons shaped like the content; spinners only inside buttons and small regions.
- Errors say what happened and what to do, in the product's voice, without apology. Kernel error codes map to messages in the i18n catalog.

### 5.4 Data visualization

- Draw to scale with one axis scale per chart; label values directly when there are few series; legends only when direct labels do not fit.
- Chart text and gridlines use theme tokens; series use `chart-*`; good and bad use semantic tokens.
- Sparklines: thin line, light area fill, emphasized last point, no axes.
- Prefer a table when exact values matter more than the shape.
- Every chart has a text alternative (a caption with the key number, or an accessible table).

### 5.5 Formats

- Money: `32.832.000 ₫` in Vietnamese (`vi-VN`), `₫32,832,000` in English (`en-GB`). Never rounded to whole đồng when the ledger holds decimals. Format through `apps/app/src/lib/format.ts` from decimal strings, never JS number arithmetic.
- Dates: `dd/mm/yyyy`, times 24-hour (`16:05`). Relative time ("2 phút trước") only for activity feeds, with the absolute time in a tooltip.
- Tax and document codes keep their official formatting (MST, ký hiệu `1C26TPT`, số `00001284`).

## 6. Marketing site (`apps/web`)

### 6.1 Home page anatomy

The home page is `/` (Vietnamese) and `/en`. The picks of 2026-10-19 (see the decision records) are in it.

1. Header: logo, four links (Product, Open source, Pricing, Docs), "Đăng nhập", one primary CTA ("Tự cài đặt miễn phí"), theme and language toggles; a phone menu.
2. Hero: one-sentence thesis, one supporting sentence, primary and secondary action, and the product working (the live org chart at full width, a live HTML rendering, not a screenshot with fake browser chrome).
3. Product tour: an example Ludy screen (AI Inbox, invoice detail, command palette) with example data.
4. How it works: the real sequence (receive, check, propose, approve), each step with a fragment of real UI.
5. Agents (the org chart and the R0 to R3 approval matrix) and the owner's phone.
6. Modules: varied layouts chosen by content, each with a real fragment of the app it names (Ludy Kế toán, Ludy CRM, Ludy Notes, Tasks, Agents, Social). Not a grid of identical icon cards. The Ludy Kế toán, Ludy CRM and Ludy Notes cards link to their app pages (6.4).
7. Trust: AI proposes and people approve, the audit log, tenant isolation, open source with the `docker compose up` command (the `#tu-host` anchor).
8. Pricing: only what is decided. No invented prices or discounts.
9. FAQ (three to six questions), footer with the app pages, the license and the repository link.

"One primary action per view" (principle 6) means the primary action of the content. The header's persistent call to action ("Tự cài đặt miễn phí") is site chrome and is exempt.

### 6.2 Claims and content

- No invented statistics, customer counts, logos, ratings or testimonials. Social proof appears only when it is real and consented.
- The marketing site in this repository describes the open-source core. DOS-only services (for example DOS ID single sign-on) belong to the private cloud layer and are not promised here.
- Name what the product does today; label future work as such ("sắp ra mắt").
- Product visuals use clearly fictional example companies and mark the data as example data once.

### 6.3 Performance budget

- Core Web Vitals at the 75th percentile: LCP under 2.5s, INP under 200ms, CLS under 0.1.
- Static sections render on the server with no client JavaScript; interactive pieces hydrate on their own.
- Two font families at most, preloaded, subset; no layout shift on font swap (matched fallback metrics).
- Product visuals are HTML and SVG, not large images. Any raster image is AVIF or WebP with explicit dimensions.
- The budget is held in CI for the pages of the site (`apps/web/test/perf.spec.ts`), with axe at 360px and desktop in both themes (`a11y.spec.ts`).

### 6.4 App pages

Each app that has users today has a page of its own on ludy.vn (the page of one product, the way 6.1 is the page of the suite): Ludy Kế toán, Ludy CRM and Ludy Notes ([#2280](https://github.com/DOS/Ludy/issues/2280), [#2281](https://github.com/DOS/Ludy/issues/2281), [#2282](https://github.com/DOS/Ludy/issues/2282)). Social and the other areas have none yet.

**Routes and the registry.** A page per language, with its own title, description, canonical, hreflang twin and social preview image named with the app. Vietnamese has no prefix, English lives under `/en`:

| App | Vietnamese | English |
| :--- | :--- | :--- |
| Ludy Kế toán | `/ke-toan` | `/en/accounting` |
| Ludy CRM | `/crm` | `/en/crm` |
| Ludy Notes | `/notes` | `/en/notes` |

`APP_PAGES` in `apps/web/src/content/site.ts` is the one registry (`{ vi, en, module }` per app, and `appPagePath(key, lang)`). The sitemap (with the hreflang alternates), the footer links, the module cards of the home page and the language switch of each page all read it. A new app page is one entry there, its copy, its routes and its visuals, and `apps/web/test/app-pages.test.ts` fails when an entry lacks a route, an image, copy in both languages, a sitemap entry with its twin, or a link from the home card.

**The template.** `AppPage` (`apps/web/src/components/apps/app-page.tsx`) renders, in order: a breadcrumb; the hero (the promise in one sentence, a lead, two actions, the note line and the app's product visual); the numbered steps of the job, each with the outcome it leaves behind as a chip; the feature groups (text and bullets on one side, a fragment of the real product on the other, alternating); "coming soon" when there is something to say; what Vy does here and does not do; who it is for; the FAQ; the call to action. It is server-rendered with no client JavaScript of its own. An app supplies its copy as `AppPageCopy` (`apps/web/src/content/app-page.ts`: `<app>-vi.ts`, with `<app>-en.ts` typed from it so a missing English string fails typecheck), its hero and one visual per feature group (`components/apps/<app>-visuals.tsx`) and `<app>-page.tsx`.

**The call to action.** The two actions are "self-host" (the `#tu-host` anchor of the home page) and "sign in". The line under the hero names what is true about where the app runs: an app that is not on Ludy Cloud yet says "Ludy CRM is in the self-hosted edition. On Ludy Cloud: coming soon." ("Ludy CRM có trong bản tự cài đặt. Trên Ludy Cloud: sắp ra mắt."). All three app pages use this line, with the app's own name. It names no plan, tier or price (Frontend PO ruling, 2026-11-01), and the page names no feature that is not built: the FAQ does not answer for work that does not exist.

**The claim table.** Every claim on an app page is backed by a merged PR and a code path on `main`, and the PR that adds or changes the page carries a table of them (claim, PR numbers, code path), checked by a reviewer with fresh context against the code. What is not yet accepted is stated plainly on the page, not implied: an export the tax authority's or an accounting package's own software has not yet been seen to take, a table of due dates no accountant has confirmed, statements that are drafts. Planned work appears only under the "coming soon" strip, labelled as such. As everywhere (6.2): no price, customer, logo, statistic or testimonial, and example data is fictional and marked "Dữ liệu mẫu" once per fragment.

**Checked in CI.** `app-pages.test.ts` (registry, routes, sitemap, titles, copy in step, no dash or hype word), `content-language.test.ts` and `a11y.spec.ts` (English pages hold no Vietnamese, axe at 360px and desktop in both themes) and `perf.spec.ts` (the budget of 6.3).

## 7. Accessibility (WCAG 2.2 AA)

- Contrast: 4.5:1 for body text, 3:1 for large text, icons and meaningful borders, in both themes. Field borders are measured: `field-border` against `background`, `card` and `popover` (`packages/ui/test/field-border-contrast.test.ts`, #2114).
- Text never sits on a pattern: on a dot-grid canvas (the landing page's org chart) a label gets the chart's own surface behind it, so its contrast is against one solid color and a dot never falls behind a letter (#1657).
- Visible `:focus-visible` ring on every interactive element, never hidden behind sticky headers or banners (2.4.11).
- Targets at least 24x24px (2.5.8); 44px on touch-first screens.
- Semantic landmarks and heading order; icon-only buttons have `aria-label`; tables use real `<table>` markup.
- Every screen has its own tab title "<screen> · <brand>" (the `PageHeader` title, or `ScreenTitle` where there is none), the first Tab stop of the signed-in shell is a "Skip to content" link that focuses `<main>`, and a navigation that changes the path moves the focus to the new screen's heading and names the screen in a polite live region, while a search-param change, the first load and back or forward do not move it (WCAG 2.4.1, 2.4.2, 2.4.3; #2115).
- Color is never the only signal (chips have text, charts have labels).
- Help is in the same place on every screen (3.2.6): the "Góp ý / Hỗ trợ" link.
- Respect `prefers-reduced-motion` (3.6). Light is the default theme; follow `prefers-color-scheme` only when the user picks "system".
- Test with keyboard only and with a screen reader (NVDA or VoiceOver) on the approval flow before release. The keyboard walk is automated; the screen reader walk is a person's step before general availability.

## 8. Internationalization

- Vietnamese is the default locale; English is the second (`apps/app/src/i18n/locale.ts`).
- App: `use-intl`, messages in `apps/app/src/i18n/messages/vi.ts` and `en.ts`; every visible string, including toasts, errors and aria labels, has a key in both.
- Marketing site: one route per language (`/` Vietnamese, `/en` English, and the app pages of 6.4 the same way), copy in `apps/web/src/content/vi.ts` and `en.ts` (and `<app>-vi.ts` and `<app>-en.ts` per app page); the `Dictionary` and `AppPageCopy` types keep them in step, so a missing English string fails typecheck. A page never mixes languages (no Vietnamese button in the English page); example company names and documents stay Vietnamese in both.
- Vietnamese text runs about 10 to 30 percent longer than English: layouts must not depend on English string lengths.

## 9. App engineering notes

- Routing: TanStack Router. Server state: TanStack Query through the oRPC client (`apps/app/src/lib/api.ts`); realtime invalidation comes from the SSE stream (`apps/app/src/lib/stream.ts`); the screens poll only while the stream is down.
- Every write goes through a kernel command (`Runtime.execute()`); the UI updates optimistically only where the command is idempotent and the rollback is visible.
- Modules contribute their own apps, menu groups, items and routes through their manifests (ADR-0031, `MODULE_SCREENS`); the shell keeps only how they look (`apps/app/src/lib/apps.ts`) and does not hardcode module navigation.

## 10. Do not

- Gradient text, gradient buttons, purple-to-pink or purple-to-blue washes, radial glow blobs, decorative glassmorphism.
- Pill badges above headlines, tracked all-caps eyebrows above every heading, emoji icons, icon tiles over headings.
- Identical card grids, nested cards, a border plus a wide shadow on the same element, radius above 12px on containers.
- Fake browser chrome, fake metrics, fake testimonials, marquees, auto carousels, pulsing static status.
- Raw palette classes or literal colors in components; colors live in the token file.
- Fonts without the Vietnamese subset, headings tracked tighter than -0.025em, all-caps Vietnamese sentences.
- Hype copy ("siêu", "đột phá", "supercharge"), "not X but Y" slogans, em dashes.
- Heavy UI kits (Material UI, Ant Design). Build on `@crove/ui`.
- A claim on a marketing page with no merged PR behind it, or a planned feature named outside the "coming soon" strip.
- Shipping a screen that has not been checked at 360px, in both themes, and with the keyboard.

## 11. References

Measured on 2026-10-18 from the live sites (computed styles of the hero heading and primary buttons):

| Site | Body / heading face | Hero heading | Primary button |
| :--- | :--- | :--- | :--- |
| Stripe | Söhne | weight 300, -0.01em | 4px radius, 44px tall |
| Raycast | Inter | weight 600 | 6px radius |
| Attio | Inter / Inter Display | 64px, weight 600, -0.02em | 10px radius, 40px tall, near-black |
| Linear | Inter Variable | weight 510, -0.022em | pill, 32px tall, near-white on dark (nav size) |
| Vercel | Geist | weight 400, -0.04em | pill (nav size) |

Sources:

- [What corner radius do modern products use for primary buttons?](https://www.lazyweb.com/research/what-button-corner-radius-is-standard), Lazyweb Research, July 2026 (514 design systems).
- [The visible tells of AI design](https://www.impeccable.style/slop), Impeccable (catalog of generated-UI patterns and alternatives).
- [10 trends creatives are so over in 2026](https://creativeboom.com/insight/10-trends-creatives-are-so-over-in-2026/), Creative Boom.
- [10 SaaS landing page trends for 2026](https://www.saasframe.io/blog/10-saas-landing-page-trends-for-2026-with-real-examples), SaaSFrame.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/), W3C (ISO/IEC 40500:2025).
- [Designing for AI agents: 8 UX patterns that build trust in 2026](https://pub.towardsai.net/designing-for-ai-agents-8-ux-patterns-that-build-trust-in-2026-713a0c926933), Towards AI.
- [Human-in-the-loop patterns: approval, input and escalation](https://understandingdata.com/posts/human-in-the-loop-patterns/), Understanding Data.
- [Web typography trends 2026](https://madegooddesigns.com/web-typography-trends-2026/), Made Good Designs.

# Changelog

What changed in each release that reaches the pilot. A release is a `v*` tag of `main`, deployed by `.github/workflows/deploy.yml`; how to cut one is in [docs/product-owner-config.md](docs/product-owner-config.md) ("Branches, environments and gates"). Pull request numbers link the detail.

## Unreleased (on `main` after v0.3.1)

Before the first deploy of this release: link the GHCR package `ghcr.io/dos/ludy-media` to the repository for the deploy token (one time), or the deploy stops at pull and changes nothing.

- **Landing page and README** (ludy.vn deploys from `main` already): below the hero, a five-step invoice story, app cards, a numbers band counted from the repository and a "your data stays yours" map, in plain words (#3018); the README gets the same pictures, the numbers with how each is counted, and an architecture diagram (#3014).
- **Meetings**: link a meeting to a contact, a deal or a calendar event, linked meetings on deals and contacts, Vy's link suggestions read from the transcript without a model (L1, #3002 to #3005); a follow-up email after a meeting (L3, #3015, #3019); the length of a recording is measured by the media sandbox, never taken from the browser (#2987, #2992); the media sandbox image is built, published and pinned with each release (#2991); video playback hardening (#2982, #2983, #2986, #2993); a Vietnamese transcription accuracy eval (#2981).
- **MCP endpoint** (off unless `OAUTH_SERVER=on`): customer and invoice read tools (#2980, #2995), a daily row budget per connection (#2996), the Claude and ChatGPT connection guide (#2997), a receiver and a secret for the wake-up webhook of a connection (#3024, setup: #3030), and its delivery: a sweep every minute stores what is due (a schedule, a new signal) and a job posts it signed through the egress guard, retried with a bounded backoff (#3024, step b).
- **Pilot layout**: the API refuses the admin database login and a worker LISTEN url; the API container drops the worker-only settings and the archive volume, the worker drops the MCP server settings (#2999, #3001).
- **Browser extension**: Ludy icons, an English popup, a release zip from an `ext-v*` tag, the Chrome Web Store runbook (#3006, #3011, #3012).
- The usage page names every AI feature (#3021).

## v0.3.1 (2026-11-11)

The first release on the pilot since v0.2.0 (v0.3.0 was rolled back on 2026-11-08: the API container turned unhealthy at start; the cause read from the code, compose defaulting the e-invoice and ads sandboxes on, is fixed in #2974 and v0.3.1 boots).

- **Vy**: the plan and ADR-0051 (Vy's brain is a DOS Claw agent, Ludy is the gate; Cloud includes one Vy, other coworkers are add-ons) (#2944, #2948, #2971); the kernel half of the first cross-app alerts, V4 and V5 (#2968, #2970); member-scoped Vy (ADR-0049) finished: audit allowlist, run bounds, sinks ratchet, daily sweeps of private data (#2822 and its clean-up PRs).
- **MCP endpoint 1a** (off by default): OAuth 2.1 authorization server, consent screen, `agent_grant`, read-only `/mcp` with `ludy_about`, audit "via <app> (MCP)" (#2976, #2977, #2978).
- **Meetings**: summary, decisions and action items by hand and from the recorder's Vy (M6, #2876 to #2909), personal-data finder and erasure in meeting text (L5), video by signed ticket (#2964), transcription with Gemini through `chat_input_audio` (#2973), the switch-on runbook (#2958).
- **Payroll and Accounting**: post and pay a month that carries corrections, the bank salary file per bank and by saved template, payroll payments offered on bank lines (#2532 and its PRs, #2893, #2897); marketplace income import and settlement proposals (#2516 slices).
- **Storage**: a retention delete tags the object version so a lifecycle rule expires it (#2959).
- **Fix**: the API boots on a public deployment with the compose defaults (#2974).

## v0.2.0 (2026-11-03) and earlier

See the [GitHub releases](https://github.com/DOS/Ludy/releases) and the [milestones](https://github.com/DOS/Ludy/milestones).

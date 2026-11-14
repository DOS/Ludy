# Product scope: OPC and SME first, AI-first

The owner decided this on 2026-10-31 and on 2026-11-02. [AGENTS.md](../../AGENTS.md) carries the short version of this gate; this page has the detail. [DESIGN.md](../../DESIGN.md) section 1 says how the AI part looks on screen, and [ai-first-reference-study.md](../research/ai-first-reference-study.md) records what the leading products do.

Ludy serves one-person companies (OPC), which includes household businesses and solo founders, and small and medium businesses (SMEs), in Vietnam first. The core features they use every week come first, and AI does the work inside each of them.

## The gate

Every issue, plan and PR passes this gate. The PO checks it when writing or picking an issue. The coordinator checks it when accepting a PR. When fit is unclear, the issue says so and the owner decides; nobody builds on a guess.

### 1. Fit

The work shortens or secures a task that an owner, bookkeeper or salesperson of a small business does at least monthly.

A feature that mainly serves large organisations waits in the Icebox, even when its design is settled. Examples:

- several legal entities or branches with their own books, mail or tax filings, and consolidation;
- SSO, SCIM, territories, and custom objects at scale;
- approval chains with more steps than a small team needs, and non-calendar fiscal years;
- agency and many-client consoles, white label;
- calendar providers and protocols few small businesses use (Microsoft 365, CalDAV);
- scale and fairness work for very large installs;
- hardening for a case no small business has hit yet, unless the current milestone's checklist names it.

Applied on 2026-11-02: #2125, #2126, #2172, #1595 and #1710 moved to the Icebox, and #1374 and #1375 were cut to the Google slice.

### 2. Smallest useful slice

- It works for one person with the defaults and no setup.
- A setting exists only where a real small business needs a choice.
- One screen and one flow beat a configurable framework. Example: W1 ads (#2295) is one campaign, one ad set and one ad, pre-filled from the post.

### 3. AI part named

A core feature's acceptance says:

- what the AI coworker reads, sorts, matches, drafts or proposes in that very screen;
- how review stays short: batch approval of clean groups, rules learned from corrections, limits the owner sets.

Every model call goes through the AI budget meter (#2382: `metered(...)` under `withAiScope`, with a key in `AI_FEATURES`). The core keeps working with AI off or out of budget. AI output stays tainted, and a person approves anything that posts money, sends a message or spends. Pure correctness fixes and plumbing need no AI part.

### 4. AI coworkers

AI is a coworker. Vy is the general manager across every app, and is both a coworker and an assistant (owner, 2026-11-10); the other coworkers are never called assistants. Each app has its own coworker, whose default name the org can change. The roster is in DESIGN.md section 1.1.

### 5. Proportionate security

Tenancy, the ledger's rules, approvals, authentication and data protection are never weakened. Security work beyond the current milestone's checklist waits, as "Picking up work" in AGENTS.md says.

### 6. Reference products

The owner decided on 2026-11-04 which products Ludy measures itself against.

- **Main references: the all-in-one suites.** Odoo, MISA AMIS and Base.vn are the direct competitors. Look at them first when deciding how apps, modules, roles and shared data fit together.
  - Odoo is closest in how Ludy is built: open source, one platform and one database, apps installed on top that declare what they depend on, self-hosted or cloud.
  - MISA AMIS is closest in customers and work: Vietnamese SMEs and household businesses, TT133, e-invoices and tax filing, with apps grouped by area (AMIS Kế toán, AMIS Nhân sự, AMIS Tiền lương) under one account.
  - Base.vn is an all-in-one suite for Vietnamese businesses (people, work, sales) without accounting.
- **Secondary references: the large vendors.** SAP, Oracle, Workday and Microsoft Dynamics show how a full suite splits its areas. Xero and QuickBooks show small-business accounting; where they offer payroll, it sits inside the accounting app.
- What the suites share: one sign-in, one people list and one database across apps. HR and payroll are an app of their own with their own roles, and post their totals to accounting.

[ai-first-reference-study.md](../research/ai-first-reference-study.md) compares what these products do with AI.

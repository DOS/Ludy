<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Runbook: supervised first run of the tax portal sync (issue #1100)

The assisted purchase-invoice sync ([tax-portal-sync.md](../integrations/tax-portal-sync.md), [ADR-0036](../adr/0036-assisted-tax-portal-sync.md)) was built and tested against a fake portal only. Nobody has logged in to the real hoadondientu.gdt.gov.vn with it. This runbook takes the owner from nothing to one real, supervised run of the sync with the owner's own portal account, says what to look at, and gives the table in which the findings are recorded. It follows [ads-live-check.md](ads-live-check.md) and the "Production, secret and credential steps" rule of AGENTS.md.

Public repository rule: no secret, password, token, tax code, account name, invoice data or internal host appears in this file, in an issue, in a PR or in chat. Findings are words and counts only. Every value is named by where it comes from.

## Who does what

Every step carries a tag.

- **[PERSON]** only the owner (JOY) can do it: it needs their tax portal login or their own judgement. Nobody does it for them, and no agent sees, stores, types or reads back the password or the CAPTCHA.
- **[PO]** the Platform Product Owner (the coordinator) runs it, after JOY approved the concrete step list in the coordinator's chat. This runbook is not that approval. One approval covers one run, and a failed step stops the run.
- **[CHECK]** what must be true before going on, and what to do if it is not.
- **Rollback** for each step: what puts things back.

The password and the CAPTCHA are typed by the owner in Ludy's own screen, in the browser, and nowhere else: not in `.env`, not in a terminal, not in chat, not in an issue. The browser must not save the password.

## What this run is, and is not

- It is the check of the points listed in issue #1100, on the **owner's own company's account**: the owner is the account holder, so no third party's consent is involved. The legal opinion on logging in to the portal for clients (spike section 8, item 3, M3-6) is still the owner's to get **before any firm uses the feature for its clients**. This run does not replace it.
- It is read only: the sync reads the company's purchase list and invoice XML, files them in the throwaway stack's own database, and writes nothing to the portal.
- It runs on a throwaway stack (`docker compose`) on the owner's own machine in Vietnam, with its own database. The real invoice data of the company lands in that database, so the stack is deleted at the end (step 11).

## Where the run happens

**The stack on the owner's own machine, in Vietnam, at `http://localhost:8080`.** The portal blocks some hosts outside Vietnam (spike section 2.1); a home or office connection in Vietnam is the intended case, and whether it is blocked is one of the findings. A cloud host outside Vietnam is not used for this run.

## What is verified in code before you start

- The client talks to one fixed origin, `https://hoadondientu.gdt.gov.vn/api`, through the egress guard: public addresses only, https only, no redirects, no cookies, one deadline per request, a byte cap per answer (ADR-0036, decision 7).
- The password goes in exactly one request (`login`) and is dropped; it is never in the database, a log, a job payload, an audit row, an error message or a trace. The portal's session token lives only inside an envelope sealed with the deployment's credential key and held by the browser for 20 minutes (database and end-to-end tests against the fake portal in `e2e/fake-tax-portal`).
- No login is retried by software. After 3 logins that did not succeed since the last good one, Crove stops logging in for the company for a day (`PORTAL_PASSWORD_GUARD`), before the portal locks the account; a refused CAPTCHA alone does not count.
- Each portal call is recorded in `crove_kernel.external_call` (target `gdt_einvoice`) with who, which step and the outcome class, never a password, a CAPTCHA answer, a token or a response body. That table is the main evidence of this run.
- **Not verified in code, and what this run is for:** that the real portal still has these paths and shapes, the words of its refusals, how long a token lasts, how it pages, and whether it blocks this connection.

## Before you start

- **[PERSON]** An active account on hoadondientu.gdt.gov.vn for the owner's own company, whose user name is the company's tax code, and its password (known to the owner, from wherever they keep it). The owner has logged in to it by hand in the last weeks, so that a refusal in this run is not a forgotten password.
- **[PERSON]** One closed month in which the company has purchase invoices on the portal, of each kind if possible: with a tax authority code (processing state 5), without a code (6) and from a cash register (8). The owner knows how many of each the portal shows for that month: step 8 compares them.
- **[CHECK]** Docker Desktop runs on the machine and `docker compose up --build` works (README, "Quick start").
- **[PO]** The coordinator has shown the owner the concrete step list below and the owner approved it in the coordinator's chat.

## Steps

### 1. Prepare the checkout and the setting **[PO]**

From a clean checkout of `main` at the commit the PO names (a worktree of its own, not the shared checkout), create or edit `.env` in the repository root so that it holds this line and nothing secret:

```
TAX_PORTAL_SYNC=true
```

Everything else stays at its compose default: the stack is local, its passwords are the throwaway defaults, the credential key is created by the container on its own volume (`CREDENTIAL_KEY_FILE`, `/data/keys/credential.key`), and `TAX_PORTAL_URL` stays unset, which means the real portal. **[CHECK]** `.env` has no `TAX_PORTAL_URL` and no real password anywhere. **Rollback:** delete the line (step 11).

### 2. Start the stack **[PO]**

```bash
docker compose up --build -d
```

Wait until the app answers. **[CHECK]** `http://localhost:8080/api/config` says `"taxPortalSync":true` (open it in a browser, or `curl http://localhost:8080/api/config`). If it says `false`, `.env` was not read or the container was not rebuilt; if the API container exits at start, `docker compose logs crove` names the variable (it refuses `TAX_PORTAL_SYNC=true` without the credential key, and it refuses `TAX_PORTAL_URL` unless `PUBLIC_URL` is local). **Rollback:** `docker compose down -v`.

### 3. Create the account and the organization **[PERSON]**

Open `http://localhost:8080`, sign up (the confirmation mail is caught by Mailpit at `http://localhost:8025`), and create an organization for the owner's company. In Settings the organization's **tax code** is the company's own tax code: the portal user name is read from it, never typed in the sync. **[CHECK]** the tax code in Settings equals the one the portal account uses; the sync refuses a list whose buyer is another company. **Rollback:** nothing to undo; the stack goes in step 11.

### 4. Open the sync and pick the month **[PERSON]**

On Kế toán, "Đối chiếu cổng thuế", pick the month chosen above and click **Lấy danh sách từ cổng thuế**. **[CHECK]** the panel opens and shows a CAPTCHA image the owner can read (finding: CAPTCHA format). If the panel is missing, `/api/config` does not say `taxPortalSync` (step 2) or the person is not an owner, admin or member of the organization. If the CAPTCHA does not load, note the message and its wording; a message that says the portal blocks this server is itself a finding (hosting).

### 5. A wrong CAPTCHA, on purpose **[PERSON]**

The owner types the company's real portal password, then types **deliberately wrong characters** for the CAPTCHA, ticks the consent box (for the owner's own company the owner is the account holder) and clicks **Đăng nhập và lấy danh sách**. The password is the real one, so if the portal checks the password before the CAPTCHA nothing is lost; it normally refuses the CAPTCHA first. **[CHECK]** the screen shows the wording for a refused CAPTCHA (`PORTAL_WRONG_CAPTCHA`). Record the wording shown, and the HTTP status the PO reads in step 7. If the screen instead says the password is wrong, stop: record it and ask the owner. **Do not repeat this step more than once.** A refused CAPTCHA does not count for the password guard. **Rollback:** none needed.

### 6. The real run **[PERSON]**, with **[PO]** watching the clock

**[PO]** notes the time. **[PERSON]** clicks **Đổi mã khác** for a fresh CAPTCHA, types the company's real portal password and the CAPTCHA within about a minute (a CAPTCHA key is accepted once within about 2 minutes), ticks the consent box and clicks **Đăng nhập và lấy danh sách**. Crove then logs in, fetches the month's purchase list (the three kinds, page by page), files it as the period's list, and downloads the XML of the invoices that have a tax authority code and that Crove lacks, a few at a time. **Keep the page open until it says it is done.** Do not close it, and do not start a second sync. **[CHECK]** the screen ends with "Đã lấy N hóa đơn từ cổng thuế" and then the XML summary line; the reconciliation below updates within seconds. Any error is shown in words; the table "When something goes wrong" lists them. **Rollback:** the sync only adds a synced list and Inbox items to the throwaway stack; running it again replaces the list; the stack goes in step 11.

### 7. Read the evidence **[PO]**

Without reading any invoice data, list the calls of the run:

```bash
docker compose exec db psql -U postgres -d postgres -c "SELECT step, state, error_kind, error_code, calls, started_at, finished_at FROM crove_kernel.external_call WHERE target = 'gdt_einvoice' ORDER BY started_at"
```

This holds steps `captcha`, `login`, `list` and `xml`, the outcome class of each in `error_code` (`WRONG_CAPTCHA`, `WRONG_PASSWORD`, `RATE_LIMITED`, `BLOCKED`, `BAD_ANSWER` and the like; empty when the call succeeded), how many requests each made, and the times. From it write the findings **Endpoints**, **Login errors**, **Token lifetime** (the time from the login to the last successful call of the same run: a lower bound, since Crove drops its own envelope at 20 minutes) and **Hosting** in the table. A `SESSION_EXPIRED` before 20 minutes after the login is the evidence that the token is shorter; its time is the answer. **Rollback:** the query only reads.

### 8. Compare with the portal **[PERSON]**

Open the portal's own list for the same month by hand (the owner's own login in another browser tab) and compare with Crove's reconciliation, by counts, never by copying values into chat or the issue:

- the number of invoices of each kind (with code, without code, cash register): equal or by how many it differs;
- three invoices of the owner's choice: the invoice date Crove shows equals the portal's (finding: date handling; the portal's instant is read in Vietnam's time zone), and the amounts are equal;
- the total Crove fetched against the portal's own Excel export for the same month, if the owner exports it;
- whether a month with more than 50 invoices was fetched whole (paging: `size`, `page`, `total`).

**[CHECK]** the reconciliation shows each fetched invoice as present on the portal, and the invoices Crove downloaded as XML waiting in the Inbox ("Chứng từ chờ duyệt"). The XML count is the number of invoices with a code that Crove lacked; the owner compares it with the portal's count of invoices with a code minus those already in the stack (none, in a fresh stack). **Rollback:** reading only.

### 9. A late CAPTCHA, optional **[PERSON]**

To check that a CAPTCHA key is accepted for about 2 minutes and not much longer: open the sync again, wait 3 minutes without logging in, then type the real CAPTCHA and the real password and log in. **[CHECK]** the screen asks for a new CAPTCHA (a refused CAPTCHA does not count for the guard). If the login succeeds, the key lasts longer than 2 minutes: record it. Skip this step if the owner does not want a second login. **Rollback:** none needed.

### 10. A wrong password, optional, once, last **[PERSON]**

Only if the owner agrees, and only after everything else: log in with the company's tax code and a **deliberately wrong** password that is not a variant of the real one, a fresh CAPTCHA typed correctly. **[CHECK]** the screen shows the wording for a wrong password (`PORTAL_WRONG_PASSWORD`). Record the portal's words and status. **Do this at most once:** the portal locks an account after a number of wrong passwords that nobody has measured, and Crove's guard stops at 3 failed logins since the last good one. A locked account is not provoked on purpose: if the owner already knows how the portal words it, record that; the portal's block page is recorded only if it is met. If this step ran, the guard's count is now 1 and the next good login clears it; the owner logs in to the portal by hand once to be sure the account still works. **Rollback:** a good login on the portal (by hand) clears the portal's own count.

### 11. Clean up **[PO]**

```bash
docker compose down -v
```

This deletes the stack, its database (the invoice list, the XML files, the audit rows) and the sealed key volume. Delete the `TAX_PORTAL_SYNC` line from `.env`. **[CHECK]** `docker compose ps` lists nothing of the stack, and no file of the run is left in the checkout (`git status` is clean). **[PERSON]** closes the portal tab and signs out of the portal. **Rollback:** none; a new run starts again at step 1.

## Findings to record

Record in issue #1100, as a comment, without any tax code, account, name, invoice number or amount, and without the password, a CAPTCHA, a token or a response body. Words, statuses and counts only. The first column is the issue's checklist.

| Item | What to look at | Result |
|---|---|---|
| Endpoints: `/captcha`, `/security-taxpayer/authenticate`, `/query/invoices/purchase`, `/sco-query/invoices/purchase`, `/query/invoices/export-xml` under `https://hoadondientu.gdt.gov.vn/api` on 443 | steps 4, 6, 7: each step reached the portal and was understood; a `BAD_ANSWER` names the step that failed | |
| A request header the client does not send ("a new request identifier", September 2026) | a refusal of the first request with a non-block outcome; if the first call fails, say which step and the outcome class | |
| CAPTCHA format | step 4: an SVG image, legible; step 6: a key accepted once within about 2 minutes; step 9 if run: a key after 3 minutes | |
| Login error: wrong CAPTCHA | step 5: the wording shown, the status, and which Crove code | |
| Login error: wrong password (once, optional) | step 10: the wording shown, the status, and which Crove code | |
| Login error: locked account | only if already known to the owner; never provoked | |
| Login error: the WAF or block page | only if met: the outcome class (`BLOCKED`) and what the screen said | |
| Token lifetime | step 7: minutes from the login to the last good call; a `SESSION_EXPIRED` and its time | |
| List paging: `size`, `page`, `total` (or `datas` against `data`) | step 8: a month fetched whole; the number of invoices Crove shows against the portal | |
| The `ttxly` 5, 6 and 8 filters each return the right invoices | step 8: the count of each kind equal to the portal's | |
| The cash register endpoint needs a `ttxly` filter | step 7: the `list` calls of the cash register endpoint and their outcome | |
| `tdlap` as an instant or a date; dates match the portal screen | step 8: three invoices, the dates equal or not | |
| Row count equals the portal's own Excel export for the month | step 8, if the owner exported it | |
| XML download: a ZIP holding the invoice XML for `ttxly` 5; the worker opens it; the invoice reaches the Inbox; the reconciliation shows it waiting in the Inbox | steps 6 and 8: the XML summary line, the Inbox, the reconciliation | |
| Hosting: the portal blocks or rate limits this connection (429, 403, or an HTML block page) | step 7: any `RATE_LIMITED` or `BLOCKED` and when | |
| Anything the portal showed that ADR-0036 or the guide does not say | | |

When a point turns out wrong, the client (`apps/kernel/src/tax-portal.ts`) and the fake portal (`e2e/fake-tax-portal/server.ts`) change together in a follow-up PR, and [tax-portal-sync.md](../integrations/tax-portal-sync.md) loses the point from its list of open points once it is checked.

## When something goes wrong

| What the screen says | What it means and what to do |
|---|---|
| `PORTAL_SYNC_DISABLED` | `/api/config` does not say `taxPortalSync`: step 2. |
| `PORTAL_WRONG_CAPTCHA` | the characters were wrong or the image is older than about 2 minutes: **Đổi mã khác** and try again, once more at most. It does not count for the guard. |
| `PORTAL_WRONG_PASSWORD` | the portal did not accept the password. **Stop and ask the owner**; do not retry in a loop. After 3 failed logins Crove stops (`PORTAL_PASSWORD_GUARD`) for a day, before the portal locks the account. |
| `PORTAL_ACCOUNT_LOCKED` | the account is locked: the owner unlocks it on the portal by hand. Stop the run. |
| `PORTAL_PASSWORD_GUARD` | 3 failed logins since the last good one: wait a day, or log in by hand first and check the account. |
| `PORTAL_BLOCKED`, `PORTAL_RATE_LIMITED` | the portal blocks or limits this connection: stop, record the time and which step (finding: hosting), and use the Excel import instead ([tax-portal-invoice-list.md](../integrations/tax-portal-invoice-list.md)). |
| `PORTAL_UNAVAILABLE` | the portal does not answer: try later. |
| `PORTAL_BAD_ANSWER` | the portal answered in a shape Crove cannot read: record the step from step 7; this is the main thing the run looks for. |
| `PORTAL_SESSION_EXPIRED` | the session ended: record the minutes since the login (step 7) and log in again. |
| `PORTAL_STEP_TIMEOUT` | a step took longer than `TAX_PORTAL_STEP_SECONDS` (90): click again; an XML batch goes on from where it stopped. |
| `PORTAL_LIST_TOO_LARGE`, `PORTAL_LIST_UNUSABLE` | the month is too large for one fetch, or the list is not this company's: pick a smaller month or check the tax code in Settings. |

## Cleanup

Step 11 removes the stack and its data. Nothing of the run stays in the repository, in an issue (findings are words and counts) or on the owner's disk beyond what the owner chose to keep from the portal's own Excel export.

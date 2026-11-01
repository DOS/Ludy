# 0042. Assisted fetch of the original e-invoice from the seller's lookup page

- Status: Proposed (2026-11-01). Nothing here is built. It is decided only if the owner or the Accounting PO accepts slice 2 of the plan, which waits (see "Consequences").
- Date: 2026-11-01
- Deciders: owner (JOY), who asked for the planning on 2026-11-01 in the Accounting PO chat ("Có, lên kế hoạch"); the engineering choices below by the Claude Code session that wrote the plan
- Builds on: ADR-0036 (assisted tax portal sync: a person solves the CAPTCHA, bounded steps, a sealed session held by the browser), ADR-0018 (untrusted content, the `crove-extract` sandbox, the egress guard), ADR-0025 (the credential vault, `external_call`), ADR-0027 (the open-source core runs without any DOS service)
- Issue: [#2258](https://github.com/DOS/Ludy/issues/2258); the plan is [einvoice-lookup.md](../plan/einvoice-lookup.md)

## Context and problem statement

A seller often sends a buyer only a PDF, or an email with a lookup link and a lookup code ("mã tra cứu"). The provider's public lookup page (MISA meInvoice, Viettel S-Invoice, VNPT, BKAV, EasyInvoice, FPT) returns the original XML and PDF after the code and a CAPTCHA. Ludy has no XML in that case, so it cannot verify the seller's signature (#674) or read amounts exactly. MISA's purchase-invoice product fetches the original through a "Kết nối nhà cung cấp" screen.

The survey of the plan (section 2) found that every lookup page that could be read guards the lookup with an image CAPTCHA, that the pages are web pages and not documented buyer APIs, and that none of them stated terms for automated access (the one terms document found was unreachable). This record decides how an outbound fetch would work, if it is built at all. The first slice of the plan (a reader of the lookup code and a card that opens the provider's page for the person) needs no outbound call and needs no decision here.

## Decision

1. **Assisted, always.** A person solves every CAPTCHA, typed into Ludy. Ludy never solves one by software, never uses a solving service, never reuses an answer and never retries a lookup by itself. This is ADR-0036's rule applied to a seller's page.
2. **Bounded steps in the API process, driven by the screen.** Two steps, each a bounded number of provider requests: `invoiceLookup.captcha` (fetch the provider's CAPTCHA image and show it) and `invoiceLookup.fetch` (submit the lookup with the person's answer, download the XML). Not in `crove-extract` (no network, ADR-0018) and not in a background job (a job cannot ask for a CAPTCHA). What a provider needs between the two steps, if anything, is sealed with the credential vault under a binding of (org, `invoice_lookup`, user, provider, invoice) and held by the browser for two minutes, as ADR-0036 does with the portal token. Nothing is stored server side.
3. **The request is rebuilt, never copied.** The server builds each request from a fixed provider table (host, path, field names) and the lookup code. It never calls an address taken from a PDF, an email or a person. The VNPT host is the one pattern: `<tax code>.vnpt-invoice.com.vn`, where the tax code is digits (10 or 13) and equals the seller tax code of the invoice the card is about.
4. **Egress to the table's hosts only.** Through `guardedRequest` of `@crove/kernel-runtime` (public addresses, the connection pinned to the checked address, one deadline per request, a byte cap per answer: 200 KB for a CAPTCHA image, 5 MB for an XML or ZIP, no redirects, no compression), with the host checked by its parsed name against the table. A queue or handler that reaches this declares it in the job egress list, and a command whose events feed it is at least R2 (#1653).
5. **The fetched file enters the normal intake path and nothing else.** Stored and recorded as an upload by the person (`kernel.file.ingest`, deduplicated by content hash), read in the sandbox, signature checked (#674), a tainted proposal, human approval, the person counted as author for four-eyes (P10). The fetched answer decides nothing by where it came from.
6. **Dedupe by the invoice's key.** Direction, seller tax code (or name), series and number, as the extraction's duplicate lookup uses them. A pending proposal from a PDF becomes a new revision from the XML; a posted document gets the XML attached as evidence with a warning on any difference; the existing `duplicate.found` check stays strict (plan section 7).
7. **Every call in the ledger.** Each provider call is recorded in `crove_kernel.external_call` before it is made and closed after (target `invoice_lookup:<provider>`, steps `captcha` and `fetch`, the outcome class), never the lookup code, the CAPTCHA answer or a response body. A hash of the code is the only trace.
8. **Never get the server blocked.** One attempt per person action; budgets per person, per provider and per process; a 429, a block page, an HTML answer where a file was expected or a wrong CAPTCHA stops the step and says so in words. Two wrong CAPTCHAs in a row ask for a new image; no loop.
9. **Off by default, adapter by adapter.** `INVOICE_LOOKUP_FETCH=false` unless a deployment opts in, and each provider is switched on separately (`INVOICE_LOOKUP_PROVIDERS`), only after a person has checked that provider's page with a test invoice and read its terms (plan section 8). The screen shows the fetch only when `/api/config` says so.

## Consequences

- Slice 2 is **not scheduled**. It moves into a milestone only when a real user of slice 1 still opens provider pages too often, or the pilot partner asks. Until then this record stays Proposed.
- Each provider is a separate adapter: its form, field names and CAPTCHA are read from a page that can change without notice, so an adapter breaks on the provider's schedule. The fake provider pages used in tests change with the adapter, as the fake tax portal does.
- Requests come from the server's IP. A provider may block hosting outside Vietnam; the screen then says the provider blocks this server and points to the card's manual route (slice 1), which stays.
- Terms of use may forbid automated access even with a person solving the CAPTCHA. If a provider's terms do, its adapter is not built, and the card's manual route stays for it.

## Options considered

1. **Slice 1 only: a reader and a card that sends the person to the provider's page (shipped first, no outbound call).** Chosen as the first step, not rejected by this record: slice 2 is its optional continuation.
2. **Assisted fetch in the API process (this record).** Mirrors ADR-0036; one person step per provider page. Chosen for slice 2.
3. **A browser extension or bookmarklet that fetches from the person's own browser.** Keeps the server's IP out and sidesteps hosting blocks, as MISA's PC helper does for the tax portal, but it is a second product to ship and review for every browser. Not rejected for good; revisit if provider blocks make option 2 unusable.
4. **A background job that fetches by itself with the code.** Needs the CAPTCHA solved by software. Rejected: the project's rule.
5. **Provider APIs.** MISA, Viettel and VNPT offer APIs for issuing and for a seller's own invoices, not for a buyer receiving invoices from dozens of providers (tax portal spike, section 2.3). Rejected as a buyer feed.

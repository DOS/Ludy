# Original e-invoice from the seller's lookup page: plan

> Plan for [#2258](https://github.com/DOS/Ludy/issues/2258), 2026-11-01. Owner decision of 2026-11-01 in the Accounting PO chat ("Có, lên kế hoạch"): plan it, after the PO recommended leaving it for later. Design only; the build issues are listed in section 9. Focus per the owner's decision of 2026-10-31: one-person companies and SMEs first. The outbound fetch (section 6) is recorded as [ADR-0042](../adr/0042-assisted-original-invoice-fetch.md), status Proposed. Vietnamese summary for the owner: [einvoice-lookup.vi.md](einvoice-lookup.vi.md).

## 1. Goal

A purchase invoice reaches Ludy today by email attachment, upload, bulk ZIP (#314) or the assisted tax portal sync (#1100, [ADR-0036](../adr/0036-assisted-tax-portal-sync.md)). Two gaps remain, both seen in MISA's "Kết nối nhà cung cấp" screen:

- a seller emails only a PDF, or only a link and a lookup code ("mã tra cứu"), so Ludy has no XML to verify (#674) and read exactly;
- invoices the portal sync does not return as XML (no tax authority code, cash register invoices, summary-table invoices).

After this plan a member who holds a PDF, or an email with only a lookup link and code, can get the seller's original XML into the Inbox in a few clicks, without retyping the invoice and without Ludy ever solving a CAPTCHA.

## 2. What the providers' lookup pages are like

Survey of 2026-11-01. **Public pages only, read, nothing submitted, no lookup code entered, no test invoice used yet.** Where a page did not say, the cell says "not stated". Many cells come from reseller or accountancy blogs, not from the provider: those are marked (blog) and are **not verified**. Section 8 lists what a person must check by hand before the outbound fetch is built.

| Provider | Lookup page (host) | What it takes | CAPTCHA | What it returns | Rate limits, terms, robots.txt | Source quality |
|---|---|---|---|---|---|---|
| MISA meInvoice | `meinvoice.vn/tra-cuu`, one host for every seller | Four ways: the lookup code, an uploaded XML file, the seller-used phone or email after a MISA ID login, or the link in the mail. Field labels of the code form not shown in the text read | Yes: an image "Mã xác nhận", not case-sensitive. MISA's help also says a further security code appears after more than 5 wrong codes | PDF and XML downloads ("Tải hóa đơn dạng PDF", "dạng XML"); ZIP and HTML not stated | No rate limit stated. `robots.txt` has no rule for `/tra-cuu`. The terms PDF linked from the page returned 404 | MISA's own pages (help, dated 2025-10-26; news, 2026-06-04 and 2026-07-05) and the page itself |
| Viettel S-Invoice | `sinvoice.viettel.vn`, one host; on 2026-11-01 it answered a 301 redirect to a general landing page on `sme.viettel.vn` | (blog) seller tax code, "mã số bí mật", sometimes invoice number and date | (blog) yes, a random-character code | (blog) view, PDF and XML | Not stated; `robots.txt` not read (redirect) | Two blogs that disagree on the fields; **not verified**, and the official page could not be read |
| VNPT Invoice | One host **per seller**: `<seller tax code>.vnpt-invoice.com.vn` (blog) | (blog) the lookup code printed on the PDF and a "mã xác thực"; the seller tax code is in the host name | (blog) yes, kind not described | (blog) PDF, XML, HTML, INV and a ZIP button | Not stated; `robots.txt` not read | One accountancy blog; **not verified** |
| BKAV eHoadon | `van.ehoadon.vn/TCHD` (link on BKAV's help page) | Not read: BKAV's help page text did not come through; its guide to "resend the lookup code to the buyer" confirms a code exists | Not stated | Not stated | Terms page exists on `bkav.com` (not read) | Title and links only; **not verified** |
| EasyInvoice (SoftDreams) | `tracuu.easyinvoice.vn`, one host for every seller | The page form: seller tax code, lookup code, "mã xác thực" (all required) | Yes: an image from `/Captcha/Show` | Result modal "Kết quả tra cứu hóa đơn"; formats not stated (blog: the XML comes from the link in the email) | Not stated; `robots.txt` returned an error page | The provider's own page for the form; a retail-site article for the rest |
| FPT eInvoice | `tracuuhoadon.fpt.com.vn` | The page builds its form with scripts, so the text read held only a title | Not stated | Not stated | Not stated | **Not verified** |

What the survey supports, and what it does not:

- **Every lookup page that could be read shows an image CAPTCHA** (MISA, EasyInvoice; the blogs say so for Viettel and VNPT). An unattended fetch would need a CAPTCHA solved by software, which this project never does. So the only design is a person-in-the-loop one, like ADR-0036.
- **One host or one host per seller.** MISA and EasyInvoice use one host; VNPT uses a host built from the seller's tax code. A host allowlist must therefore hold exact hosts and one validated pattern (section 6).
- **Lookup pages are web pages, not APIs.** None of the pages read documents an API for buyers. SePay offers a bearer-token API to download an invoice as PDF or XML by tracking code ([page](https://developer.sepay.vn/vi/einvoice-api/v1/tai-hoa-don)), but that is for the invoices a seller issues through SePay, not a buyer feed. Provider APIs (MISA, Viettel, VNPT) are for issuing, as the tax portal spike found ([tax-portal-invoice-sync.md](../research/tax-portal-invoice-sync.md), section 2.3).
- **The tax authority's no-login check does not help.** It takes the invoice type, symbol, number and total and shows no invoice detail, within 31 days (MISA's news page); it returns no XML.
- **Legal value.** MISA and ACC both say the XML has legal value while unmodified and the PDF shows the content only. That is why a PDF alone is a weak source, and why the signature check (#674) of the XML matters.
- **Terms of use.** No page read says anything about automated access, and the one terms document found was unreachable. Absence of a statement is not permission: the fetch stays person-driven (one invoice, one person, one CAPTCHA), and the terms are read before any adapter is built (section 8).

## 3. Where the lookup code and link come from

The fetch is needed only when Ludy has no XML for the invoice, so the XML itself is not a source.

| Source | What is there | How Ludy reads it |
|---|---|---|
| The PDF | The providers say each PDF carries the lookup link and code (VNPT blog; MISA says the code is below the stored invoice content) | `crove-extract` already returns the PDF's text (`pdf_text`). A **deterministic** reader (a provider table of code labels and link hosts, no AI) looks for them in that text. A PDF is untrusted: whatever it says is a hint, never an instruction |
| The email body | The notification email holds the lookup link and code (VNPT blog, MISA help) | The `mime` result already carries the body text (`email.text`). The same reader runs on it. Whether the link's address survives in that text (an HTML link shows its label, not its `href`) is an open point for the first build (section 8) |
| The person | Typed in when neither source has it | A field on the card (section 5) |

Today an email with only a link and code is **not ingested** (an email without an invoice attachment is skipped; the spike said so). The first build step closes that: such an email becomes an Inbox item "needs the original" instead of vanishing. Built in [#2286](https://github.com/DOS/Ludy/issues/2286): an Inbox item of kind `finance.invoice.original_needed` in `crove_kernel.inbox_item`, one per hint, whose `detail` holds only the provider, the link and the code; owners, admins and members whose scope is the whole org read and dismiss it (a database rule), and the code stays out of audit rows, logs and error texts.

## 4. Trust rules, for every slice

1. A link or code read from a document or an email is untrusted text. It is shown to the person; Ludy's servers do not follow it.
2. A link is offered as a clickable link only when its host is in the provider table (exact host, or `<10 or 13 digit tax code>.vnpt-invoice.com.vn` with the code equal to the invoice's seller tax code), over `https`, with `rel="noopener noreferrer"` and the host name shown next to it. Any other link is shown as text, not clickable.
3. The lookup code is not a secret of the same kind as a password, but it grants sight of the invoice: it is not written to logs, audit rows, `external_call` rows or error messages. The stored hint keeps it as the invoice's own data (a `pii` class value like the rest of the invoice), and call records keep only a hash.
4. A fetched file enters the normal intake path and nothing else: stored and recorded as an upload by the person (`kernel.file.ingest`, deduplicated by content hash), read in the `crove-extract` sandbox, signature checked (#674), a tainted proposal, human approval, the person counted as author for four-eyes (P10). Nothing fetched is trusted because of where it came from.

## 5. Slice 1: no outbound call (build first)

For a one-person company or an SME this is most of the value at no legal or maintenance risk.

1. **Reader.** `@crove/l10n-vn` gets a provider table and a deterministic reader for the lookup link and code (section 3), used on PDF text and on email text. It finds the provider by link host and code label; it names the provider.
2. **A card "Cần hóa đơn gốc (XML)".** An Inbox proposal read from a PDF or a photo, and an email with only a link and code, show a card: the provider's name, the code with a copy button, "Mở trang tra cứu" (a link that passes rule 2 of section 4), and a drop zone "Tải XML lên" on the same card. The person opens the provider's page, solves its CAPTCHA, downloads the XML and drops it on the card. Ludy calls nobody.
3. **The XML replaces the PDF reading.** The dedupe rule of section 7 decides what happens to the proposal made from the PDF.

What this does not do: it does not save the person from opening the provider's page. It saves them from retyping the invoice and from losing the signature check. If a first user trial shows that this is enough, slice 2 never ships.

## 6. Slice 2: the assisted fetch (waits)

Recorded in [ADR-0042](../adr/0042-assisted-original-invoice-fetch.md). In short, it follows ADR-0036:

- **Assisted.** Ludy asks the provider's page for its CAPTCHA, shows it to the person, takes the person's typed answer and submits the lookup. A person solves every CAPTCHA. No OCR, no solving service, no reuse of a solved answer, no retry loop.
- **Which process.** The **API process**, in short bounded steps the screen drives, because a person is present for each. Not the `crove-extract` container (it has no network, by design, ADR-0018) and not a background job (a job cannot ask for a CAPTCHA). The fetched bytes go to the sandbox like any upload.
- **Egress.** Only through the egress guard (`guardedRequest`: public addresses, pinned connection, one deadline, a byte cap, no redirects), only to the provider table's hosts: exact hosts plus the one VNPT pattern, with the tax code checked against the invoice's seller. The server rebuilds the request from the table and the code; it never calls an address taken from a document.
- **Ledger.** Each call is recorded in `crove_kernel.external_call` before and after (provider, step, outcome class, never the code or a response body); the declared job egress and the R2 rule of #1653 apply where a queue is involved.
- **Off by default.** `INVOICE_LOOKUP_FETCH=false` until a deployment opts in, and each provider adapter is enabled on its own, once the person checks of section 8 are done.
- **Limits.** One attempt per person action; a per-person, per-provider and per-process budget so Ludy's address is not blocked; a 429, a block page or an unreadable answer stops the step and says so in words; no cookies kept beyond the one lookup session (what a provider needs, if anything, travels sealed in the browser as ADR-0036 does with the portal token).

What waits and why: slice 2 adds an outbound integration whose pages are undocumented and whose terms were not readable; each provider is a separate page with a separate form. It is built only after the person checks (section 8) and only if slice 1 leaves a real need.

## 7. Dedupe and the XML that arrives after the PDF

The key of an invoice is the same as today's duplicate lookup (`finance.extraction.lookup`): direction, the seller's tax code (or name when it has none), the invoice series and the invoice number, each normalized as the extraction does.

| State when the original arrives | What happens |
|---|---|
| A pending proposal from a PDF or photo with the same key | The XML reading becomes a **new revision of that proposal** (as a re-extraction does, #40): the amounts and lines come from the XML, the signature check is added, and the PDF stays attached as the first evidence. The reviewer sees one proposal, not two |
| An executed proposal (already posted) from a PDF | Nothing is posted again. The XML is attached to the posted document as evidence with its signature result, and the document says its original was added later. A difference in amounts between the XML and the posted lines is a warning for an accountant, not an automatic change |
| A pending or executed proposal from the same XML (same content hash or same key from XML) | The existing duplicate check applies (`duplicate.found`) |
| The same invoice arriving from the portal sync (#1100) | The portal list marks the row "XML received"; the existing reconciliation already matches on seller tax code, symbol and number |
| No proposal yet | A normal new proposal |

The upgrade is not a change of the duplicate check, which stays strict: it is a branch of the revision path.

**As built for the pending case ([#2269](https://github.com/DOS/Ludy/issues/2269)).** `finance.extraction.lookup` says whether the duplicate is a pending proposal read from a PDF or a photo (`duplicateProposalUpgradable`); an original (XML) is then not flagged. The kernel duplicate guard asks again under its lock (`upgrades` in the guard), and `kernel.extraction.record` locks that proposal and gives it revision +1 from the XML reading: the payload is the original's (its `sourceFileId`, so the posted document names the XML as its source file), `extraction_id` is the XML's run, `source_file_id` stays the PDF, the XML's uploader joins the authors (P10), and the timeline says "Đã nhận hóa đơn gốc XML". It does not happen, and the original is flagged as a duplicate as before, when the proposal is no longer pending, is of another legal entity (a proposal stays in its entity), or was not read from a PDF or a photo. Both files show the one proposal (the file status follows `extraction_id` too); reading the PDF again is refused (`READ_FROM_ORIGINAL`) and a re-read of the PDF that was already running leaves the revision alone, so the weaker reading never comes back; reading the XML again revises it.

**As built for the posted case ([#2320](https://github.com/DOS/Ludy/issues/2320)).** The posted document is append-only, so the link is not stored on it. It is stored on the XML's own extraction run (`crove_kernel.extraction.original_of_proposal_id` and `original_differs`, a migration): the run is the record of what was read from the XML, its checks and its signature result, it is written done at insert and a guard refuses any later change of the two columns. `finance.extraction.lookup` says the one match is an executed proposal read from a PDF or a photo that is the document in force's own (`duplicateProposalAttachable`) and whether the XML's subtotal, VAT or total differ from the posted document's (`attachDiffers`). `kernel.extraction.record` then locks that proposal (shared, same kind, command and legal entity, not voided), inserts the XML's run already done with the link, writes "Đã nhận hóa đơn gốc XML" on the proposal's timeline and creates no proposal: nothing is posted again, and the entry and the document are never touched. A difference in the amounts is `original_differs`, shown on the posted proposal's screen (`kernel.inbox.get` `originals`) as a warning for a person; it is never corrected by itself. The XML file shows the posted proposal as its own (`proposed`, executed), and reading it again is refused as for any posted invoice (`PROPOSAL_DECIDED`). With two matches, another legal entity, or a posting voided by a reversal, the XML is flagged or read as before.

## 8. What a person must check before slice 2, and open points

Needs test invoices and a person (the accountant of the pilot partner, #61, or a test account made by the owner), never customer data:

- For each provider in section 2: open its lookup page with one **test invoice**, write down the form's real fields, whether a CAPTCHA guards it and its kind, which formats it offers, whether a session cookie or an anti-forgery token is involved, and read its terms of use for automated access and rate limits. Record the result in this plan's table.
- Whether an XML's own fields carry the lookup code (to read it when a PDF is missing): read a few test XML files from each provider.
- Whether a notification email's link keeps its address in `email.text` (section 3), and what the MISA link looks like.

Open points for slice 1: how a PDF prints the code (layout varies by provider, so the reader's table grows as samples arrive); and whether the proposal or a new table holds the hint (the build issue decides, with a migration only if a table is needed).

## 9. What ships first, and the build issues

| Order | Slice | What | Milestone, priority | Issue |
|---|---|---|---|---|
| 1 | 1 | Reader of the lookup link and code (provider table, PDF and email text), no outbound call | M3 Paid pilot, P2 | [#2267](https://github.com/DOS/Ludy/issues/2267) |
| 2 | 1 | Email with only a link and code becomes an Inbox item; the "Cần hóa đơn gốc" card with the link, the code and the XML drop zone | M3 Paid pilot, P2 | [#2268](https://github.com/DOS/Ludy/issues/2268) |
| 3 | 1 | The XML that arrives after the PDF: upgrade a pending proposal, attach to a posted document | M3 Paid pilot, P2 | [#2269](https://github.com/DOS/Ludy/issues/2269) |
| 4 | check | Check the lookup pages by hand with test invoices and fill section 2 | Icebox, P3, `owner-action` | [#2270](https://github.com/DOS/Ludy/issues/2270) |
| 5 | 2 | The assisted fetch core: CAPTCHA relay, sealed session, egress allowlist, call ledger, flag | Icebox, P3 | [#2271](https://github.com/DOS/Ludy/issues/2271) |
| 6 | 2 | First provider adapter (MISA meInvoice, the clearest evidence) | Icebox, P3 | [#2272](https://github.com/DOS/Ludy/issues/2272) |

More adapters (EasyInvoice, then VNPT with its per-seller host) are filed one at a time when the check issue shows their forms and terms. Slice 2 moves into a milestone only when a real user of slice 1 still has to open provider pages too often, or the pilot partner asks for it.

## 10. Risks

- **Terms of use.** The pages did not state any, and automated access without a statement is not permission. Mitigated by the person-driven design and by reading the terms first (section 8).
- **Pages change.** A provider can change its form at any time; an adapter breaks with it. Slice 1 has no such dependency, which is why it comes first.
- **A hostile PDF or email** can carry a lookup link to a phishing page. Mitigated by rule 2 of section 4: only table hosts are clickable, and the host is shown.
- **The wrong invoice.** A code could return an invoice other than the one on the card. The fetched XML goes through the normal checks, and the dedupe key (section 7) compares seller, series and number with the card's before it is offered as the original.

# Runbook: the Tingee UAT check, before the bank feed is offered to a real customer

Why this exists: the Tingee bank feed adapter ([#2045](https://github.com/DOS/Ludy/issues/2045), design in [ADR-0039](../adr/0039-bank-feed-connectors.md) and its S3 amendment) was built from Tingee's public documentation and tested only against recorded and fake answers. Five facts the pages do not settle are marked "(UAT)" in the design. This runbook is how they are settled, by one run against Tingee's test environment, with the answers written down. The run itself is owner action ([#4205](https://github.com/DOS/Ludy/issues/4205)); this file is the agent part ([#4377](https://github.com/DOS/Ludy/issues/4377)).

Nothing here moves money. The adapter reads two endpoints (the accounts a credential reaches and the transactions of one account) and names no other Tingee path.

## Who does what

| Step | Who | What they hand over or write |
|---|---|---|
| Register a Tingee UAT account and create the test credential (Client ID and Secret Token) | the owner | Nothing in chat or an issue. The two values go to the coordinator only through the [secret procedure](../contributing.md#production-secret-and-credential-steps). |
| Start the test machine with the UAT settings and run the checks below | the coordinator, on a test VM the owner approved | The notes of each check (the table at the end) on [#4205](https://github.com/DOS/Ludy/issues/4205). |
| Bring one real bank statement file of each bank the pilot uses (check 1) | the owner | The file stays with the owner or the accountant; only the comparison result is written down. |
| Look at what the feed booked and say whether it is right | the accountant ([#61](https://github.com/DOS/Ludy/issues/61)) | A yes or a no per line they checked, in a comment on [#4205](https://github.com/DOS/Ludy/issues/4205). |
| File an issue for every finding that changes the design | the coordinator | An issue linked from [#4205](https://github.com/DOS/Ludy/issues/4205). |

## The rules of the run

- **Never on the pilot host and never on a public deployment.** The UAT switch is refused by a deployment with a public address (`PUBLIC_URL` that is not a local address), because Tingee's UAT host answers with test data. See "Known constraint" below.
- **Settings of the test machine:** `BANK_FEED_TINGEE=true`, `BANK_FEED_TINGEE_UAT=true` (the adapter then calls `uat-open-api.tingee.vn` instead of `open-api.tingee.vn`), and `CREDENTIAL_KEY` or `CREDENTIAL_KEY_FILE` (the Secret Token is sealed per connection). Take them off when the run ends.
- **No secret is written anywhere:** not the Client ID, the Secret Token, the hook key or the webhook address (it contains the key), not a full account number, not a payer's name. Write what was seen in words, and a date.
- **Test data only.** The UAT account holds no real money and its transactions are made up; the statement file of check 1 is a real one but only the comparison of its reference column is recorded.

## Known constraint to settle before check 4 and 5

The two checks that need Tingee to reach Ludy (the portal's validation of the webhook address, and a real signed webhook) need an address on the internet and a domain the tester controls, while the UAT switch refuses a deployment whose `PUBLIC_URL` is public. Two ways, for the coordinator and the owner to choose and write on [#4205](https://github.com/DOS/Ludy/issues/4205):

1. **A tunnel.** `PUBLIC_URL` stays a local address; a tunnel the tester controls (with a name under a domain they own, so the DNS record can be added) forwards to it, and the tester opens the app through the tunnel so the card shows the tunnel's address. Nothing in the code changes.
2. **A separate, labelled change** to let the UAT switch run behind a public address on a machine that holds only test data. That weakens a guard, so it is a decision for the owner with a security review, never part of this run.

Checks 1 to 3 do not need either: they only need the test machine to reach Tingee.

## The checks, in order

For each, "Ludy assumes" is what the code does today; the check proves or disproves it.

### 0. The connection works

- **Steps:** on the test machine, Settings, bank feeds, "Kết nối Tingee": paste the UAT Client ID and Secret Token, connect. Wait for the first sync.
- **Expect:** the connection shows "Đã kết nối", and the accounts Tingee gives the credential appear in the list to map to a bank account of the books.
- **Evidence:** the date, the count of accounts listed, and whether the status was `active`. If the credential is refused, the state says so (codes 92 or 97, Tingee's signature refused) and the clock of the machine matters (codes 90 and 91 mean the clock is out of Tingee's window): fix and repeat, and write which it was.

### 1. Does `code` equal the reference printed on each bank's statement file? (the top risk)

- **Ludy assumes:** a transaction's reference is Tingee's `code`, falling back to `transactionId`. A line that arrives by the feed and again by a statement file is recognised as one only if the two references are equal, because a feed line has no running balance to match on.
- **Steps:** (a) in the UAT account, pick a bank the pilot uses and take the transactions Tingee gives for one account over a few days; (b) take that bank's real statement file for any matching days (the owner hands this to the accountant, not into Ludy); (c) compare, for five or more lines, the `code` Tingee shows with the reference column of the file.
- **Evidence:** per bank, the date and one of: "equal on all N lines", "different on M of N lines" with a plain description of how they differ (a prefix, a longer text, a different number), never the numbers themselves.
- **If they differ:** the cut-over rule of the design (from the cut-over date, statement lines for that account are skipped) is the protection, and the finding is an issue to revisit it. Do not offer the feed for that bank until the accountant agrees.

### 2. The sort order and paging of the transactions list

- **Ludy assumes:** the order is not documented, so the adapter sorts each window by transaction date then id before it stores anything, pages by `skipCount` until `totalCount`, reads at most 10 days at a time and 200 a page, and starts again two days before its last line.
- **Steps:** from a connection with at least 201 test transactions (ask Tingee's UAT to create them or use a window with many), run a sync twice and look at the sync note on the card; then add one new test transaction and sync again.
- **Evidence:** whether the first sync reached `totalCount`, whether a second sync stored nothing twice, whether the new transaction arrived once, and (if visible) whether Tingee returned the oldest or the newest first. Write "no duplicate lines" or the exact symptom.

### 3. A bank statement imported over the feed (the double booking test)

- **Ludy assumes:** when an account is mapped to the feed with a "from" date, a statement import skips that account's lines from that date on, and the feed skips lines before it.
- **Steps:** map one account with a from date in the middle of the test data; import a statement file for the same account over the same days; count the lines.
- **Evidence:** the count from the feed, the count from the file, and whether any line is in both. The accountant checks the bank lines screen and says whether the total matches the bank.

### 4. The portal's validation of the webhook address (needs the constraint above)

- **Ludy assumes:** the portal sends a `url-validation` request before it saves an address, and the route answers 200 for a known key; the customer proves the domain with a DNS TXT record (`_tingee-verification.<domain>`), so no secret is needed to answer.
- **Steps:** in Ludy, "Webhook", create the address; in the Tingee UAT portal paste it as the webhook of the account; add the DNS record the portal asks for; save.
- **Evidence:** whether the portal accepted the address, the exact name and kind of the DNS record the portal asked for (that text is public, it is not a secret), and any message it showed. If it asks for an answer the route does not give (an `encryptedToken` within 5 seconds), write that, because the design's second option then applies and is a security decision.

### 5. Does Tingee sign the exact bytes it sends, or the minified JSON? And the custom API key header

- **Ludy assumes:** the signature is HMAC-SHA512 over the timestamp, a colon and the body, with the connection's Secret Token. The worker checks the raw bytes first and the minified form second, and a good one queues one pull.
- **Steps:** make a test transaction so Tingee sends a webhook; look at the webhook note on the card (last notice, refused count) and at the worker's counts line (a count of verified, refused and dropped, never the body).
- **Evidence:** "verified" or "refused" for each notice, and three or more good notices in a row. The adapter does not record which of the two forms matched; if the answer matters for the design, the finding is an issue to record it, not a guess.
- **The custom API key header:** read the portal's setting and write whether it exists, what it is called and whether a header Ludy chooses can be set. The design prefers the hook key in the address and adds this as a second factor only if it is worth it; the owner decides with the security reviewer.

## What to write back, and where

On [#4205](https://github.com/DOS/Ludy/issues/4205), one comment per run, using this table. A finding that changes the design gets its own issue and a link here.

| Check | Date | What was seen (no secrets) | Ludy's assumption held? | Issue filed |
|---|---|---|---|---|
| 0 Connection | | | | |
| 1 Reference (per bank) | | | | |
| 2 Order and paging | | | | |
| 3 Statement over feed | | | | |
| 4 Address validation | | | | |
| 5 Signature bytes, API key header | | | | |

## When the run ends

1. Remove `BANK_FEED_TINGEE_UAT` and the other settings from the test machine and throw the machine away with its database (the sealed Secret Token goes with it). The bank feed card has no button to remove a connection yet, so a test machine that is kept would keep the sealed token.
2. The owner disables or deletes the UAT credential in Tingee's portal.
3. The accountant's yes or no is on the issue.
4. Offering the feed to a real customer (`BANK_FEED_TINGEE=true` on a deployment) waits for check 1 on each bank that customer uses, and for the answers of checks 4 and 5.

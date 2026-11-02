# Runbook: customers' comments and messages, how long they are kept and how they leave

For the conversation core (issue #2305, [plan](../plan/conversations.md) sections 10 and 13 CV6, ADR-0041). The comments and private messages customers write to an org's Pages and Official Accounts are personal data of third parties; the org is the controller (PDPL). This runbook is for the org's owner or admin and for whoever runs the deployment.

Never paste a customer's message, name or Meta user id into chat, an issue or a commit: write only that a step "matched" or "was refused".

## 1. How long threads are kept

- Every org keeps a thread for **24 months after its last message** unless an owner or admin chooses otherwise: Social, "Hộp bình luận", the box "Thời gian lưu hội thoại" offers **6, 12 or 24 months**, or "Giữ đến khi tôi xóa" (nothing is deleted by age). Every member sees the choice; only owners and admins change it (`kernel.conversation.retention_set`, R2, audited with the number chosen).
- The daily retention job (the same job as the other purges) deletes each thread past its org's retention, with its messages, internal notes, read marks and the customer identities left with no thread (`kernel.conversation.purge_expired`, the worker as the system, 200 threads a batch, up to 25 batches an org a run). A backlog (a long retention just shortened) is worked off over a few nights. The audit row of a purge carries counts and the retention in months, never a word a customer wrote; the job's log line is `[retention] conversation_threads=<n>`.
- **Shortening the retention deletes the older threads at the next run.** The screen says so; nothing asks again.
- A closing org's conversations are deleted by the org purge, not by this job.

## 2. Erasing one customer on request

A customer (or the org's own decision) asks for their messages to go:

1. Open one of the customer's threads in Social, "Hộp bình luận" (a private message later, in Service). The header has **"Xóa khách này"** for owners and admins.
2. Confirm. The kernel asks for a fresh second factor (R3). `kernel.conversation.erase_contact` deletes **every thread of that customer** (their identity on that platform) with its messages, notes and read marks; their identity stays as a **tombstone** for 30 days: no name, no contact link and no platform id, only a keyed hash of the id (so a replayed message of theirs is recognised and refused) and the time of the erasure. What the customer wrote **in other people's comment threads** (replies) goes too, wherever it is: each message knows its author. A customer who only replied, with no thread of their own, is erased from one of their messages (the same button on the message); a thread they opened goes whole with the replies of others in it.
3. The audit row has the number of threads and messages and the kind of thread, nothing of the customer. If the customer writes again, a new thread opens: erasing is not blocking.
4. **Not reached:** a copy in a backup (7-day point-in-time recovery) or in an earlier org export, which the org keeps under its own care (the export contains the conversations; its file is sealed and deleted after 35 to 90 days). After a restore from backup, run the recorded erasures again, as for other personal data ([personal-data-requests.md](personal-data-requests.md) section 5).

**What stays:** a CRM contact (party) a person linked to the customer is only unlinked, not erased: it is the org's own record, and anything copied into it (a name, a phone number) is erased from the party by the personal-data tools ([personal-data-requests.md](personal-data-requests.md)). The call log of a reply (`external_call`) keeps opaque ids only, no text.

The generic erasure by phone or email (`kernel.personal_data.erase`) does not touch conversations: the name a platform gave is registered as kept with its record and goes through this command, the retention purge, Meta's callback or the org's offboarding.

## 3. Meta's data deletion callback: one URL for every Meta connection

A Meta app has **one** "Data Deletion Request URL". Ludy serves one for all its Meta connections: `<PUBLIC_URL>/api/ads/meta/data-deletion` (the path keeps the name it had for Ads; renaming it would mean a second URL to register). One verified request fans out to both sides under **one confirmation code**:

- the **Ads** accounts the person granted (`CHANNEL_META_ADS_APP_ID` and `_APP_SECRET`, Ads module on): their figures and sync log are deleted and the connections closed;
- the **conversations** of the Facebook Page and Instagram connections the person granted (`CHANNEL_META_APP_ID` and `_APP_SECRET`, the Pages app): the connections are closed (the credential is forgotten) and every thread, message and note of those connections and the customer identities left are deleted, in every org the person connected one in.

How it works: the signed request is checked against **each** app secret the deployment holds (the Ads app's and the Pages app's may be one app or two; a request signed by neither is refused with 401 and stored nowhere). A verified one yields the person's Meta user id, which is turned at once into a **keyed hash** (HMAC-SHA256 under that app's secret) and dropped: the id and the body are stored nowhere. Connections carry the same hash (`channel_connection.granted_by_hash`, set by the connector when it links the account: the Facebook connector of CV2, #2307, and Instagram's of CV7). The worker claims open requests on every relay pass, erases per connection in its own org, and marks the request complete. The status page Meta shows the person (`GET` on the same URL with `?code=`) says the request is being handled until **both sides** have finished.

What it cannot do, and what the owner can do about it:

- A connection linked **before** its connector stored the hash has none; the request does not find it. The owner deletes by hand (section 2) or reconnects it.
- **Taking a connection over keeps its conversations:** a reconnect by an owner or admin (`kernel.channel.connect`) clears the old hash, so a later request from the member who granted it before no longer reaches the connection. This is the cautious reading of Meta's rule; whether a business's own customer-care record has to go when the member who connected the Page leaves is for a lawyer ([plan](../plan/conversations.md) section 10).
- **Rotating the Meta app secret** leaves the stored hashes unmatched: reconnect the connections after a rotation.
- Meta states no retry schedule [U]: the endpoint answers 200 with the code once it has stored the request, 429 over the per-address limit, 503 when more than 100000 requests wait.
- Until the Facebook connector (CV2) sets the hash, **no Meta conversation connection exists to find**: this slice builds and tests the whole path with hashes set by the test.

**[PERSON]** in the Meta app dashboard (Settings, Basic) set "Data Deletion Request URL" to the URL above (https, public). **[CHECK]** with Meta's own test of the callback or by removing the app from a test Facebook account: Meta shows a code and a status link; the page first says the request is being handled and, within a minute or so, that the data was deleted; the connection of the test Page is closed and its threads are gone. Record that the code appeared and the page changed, never the person's id.

## 4. Export, offboarding and the org purge

- The org export (`kernel.org.offboard`, and the owner's export on request) lists `kernel.conversation`, `kernel.conversation_message`, `kernel.conversation_identity`, `kernel.conversation_note`, `kernel.conversation_setting` and `kernel.channel_access`. The messages are the org's data and personal data of third parties: the export is sealed, kept 35 to 90 days, and whoever downloads it takes on the duty of care. Read marks are per-member state and stay out; the keyed hash of who granted a connection is the deployment's and stays out too.
- The org purge (offboarding, after the grace period) deletes the conversation tables and the settings with the rest of the org's rows.

## 5. What this does not do yet

- **A replayed or redelivered notice does not bring an erased customer back (#2348).** The intake refuses any message of an erased customer dated at or before the erasure, so a captured signed body replayed within the window, or a platform's redelivery, is dropped; a message dated later is the customer writing again and opens a new thread. The tombstone is dropped by the nightly job after 30 days (longer than any redelivery or the 24-hour age limit of a Zalo notice). Purged threads are not tombstoned: they are months old, and a notice that old is refused by its age.
- **The Meta callback finds nothing in production until a connector sets the hash:** no connection carries `granted_by_hash` yet (CV2 and CV7 set it), so until then a request completes with none; tests set the hash directly.

- **Images and files of a customer's message** are not stored in this slice (a placeholder names their kind), so none are deleted here; the slice that stores them (CV4 and CV5b, #2329) deletes the files with their message, through the same commands.
- **Drafts** (`conversation_draft`, CV8) do not exist yet.
- **A retention per channel or per kind** is not offered: one number for the org.

## 6. Live-channel gate

No real customer's messages go through a live channel (Facebook, Instagram, Zalo) until CV6 is accepted. Before that, only the owner's own Page and OA with test accounts. After it, record the acceptance in #2305 and lift the restriction in the live-check runbooks.

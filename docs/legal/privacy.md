# Crove Privacy Notice (English working copy)

> **DRAFT, NOT REVIEWED BY A LAWYER.** English courtesy copy of [privacy.vi.md](privacy.vi.md) for review; the Vietnamese text prevails. Questions for the lawyer: [README.md](README.md).

Version [number], effective [date]. Under the Law on Personal Data Protection (Law 91/2025/QH15) and Decree 356/2025/NĐ-CP.

1. **Our roles.**
   - **Account data** (members' names, emails, sign-in history, devices): the Operator is the controller.
   - **Data in an organization's books** (documents, invoices, bank statements and entries, which may hold personal data of sellers, buyers, staff or household business owners): the organization, for example an accounting firm, decides the purpose. The Operator is the processor and acts only on its instructions.
2. **What we collect.**
   - Account: name, email, a hashed password only, second factors.
   - Activity: sign-in times, IP address, browser, and the audit trail of who approved what and when.
   - Documents and books: e-invoices, PDFs, photos, statements, entries, tax codes, partners' names and addresses.
   - Support messages.
   - Outside calendars: when a member connects their own Google calendar, the address of the Google account and the busy time ranges (start and end), never titles or attendees. Every member of the organization sees these busy ranges (without content), and they are part of the organization's data export. If the member turns on writing bookings to their calendar, each confirmed booking is also sent to Google as an event in the member's own calendar, titled with the event type and the visitor's name (no email, phone or attendees), and removed when the booking is cancelled; events already written stay in the member's calendar when they disconnect. When a member disconnects, the busy ranges are deleted at once, and within about 15 minutes the grant is revoked at Google and the address deleted. The grant is not revoked, and the member can remove the app's access in their Google account, when Google cannot be reached for 3 days, when the stored token can no longer be opened, when the connection had already expired, or when the organization is closed. While an organization is being offboarded its calendar connections are not processed at all: a sealed token and the account address stay until the organization's data is purged or the organization is reopened, and the grant is not revoked at the purge.
   - Ads: when an owner or admin connects an ad account (Meta or Google Ads), the account's id and name, campaign, ad set and ad ids and names, currency, time zone, and daily figures (spend, impressions, clicks, reach, results). If the organization turns on running ads from Crove: campaign drafts (name, objective, budget, run dates, texts, link, image, broad audience settings: country, region, age range, gender and interests), the description a member gives the AI coworker (sent to the AI provider, see section 4), the ids and status of the objects created at the platform, and spend caps. The figures are daily totals, never per viewer. We do not store customer lists, custom audiences, lead forms or conversion events, nor identifiers of the people who see an ad, so ad data holds no personal data of customers or of people who see ads. Campaign names, ad names and texts are typed by the organization and may, rarely, contain a person's name if the person typing put one in. For Meta, of the person who granted the connection we store only a keyed hash (not reversible), used to find the right accounts when Meta sends a data deletion request; the hash is not part of the organization's data export. The access token of the ad account is sealed, never displayed and not part of the export; when the connection is closed, a sealed copy is kept for at most 7 days, only to revoke the grant at the platform. Retention: see section 6.

   Some financial data may be sensitive personal data, so all documents and books get the protection of sensitive data. [Lawyer to confirm, question 2.]
3. **Purposes.**
   - Providing the service.
   - Security: authentication, two-factor authentication, detecting unusual access, the audit trail.
   - Support and operations: system email, error monitoring.
   - Legal obligations.

   We do not sell personal data, use documents or books for advertising, or use them to train AI models.
4. **AI.**
   - XML e-invoices are read without AI.
   - PDFs and photos are sent to [AI provider, country] to be read. The provider may use the data only to return the result, and keeps none for training. [Per the D9 provider contract.]
   - Results are checked by rules and approved by a person.
5. **Processors.**
   - Server host, file storage, email provider and AI provider, each with [country].
   - A transfer impact assessment is made when data leaves Vietnam. [Lawyer to confirm, question 4.]
6. **Retention.**
   - An organization's data is kept while it uses Crove. After it closes, it has [30] days to export; the data is then deleted, and backups follow their lifecycle of at most [n] days.
   - Recipient addresses and subjects in the mail log are dropped after 13 months; only a hash stays, to keep honouring unsubscribes.
   - Daily ad figures are kept for the latest 13 months; older figures are deleted at each sync. When an organization disconnects an ad account, the stored figures are kept as the organization's cost record until an owner or admin chooses to delete that account's history; the figures and sync log are then deleted, and the disconnected account is removed. When Meta sends a deletion request for a person who granted a connection, we delete the ad accounts that person connected and everything under them.
   - Campaign drafts and records of ad runs are kept with the organization's data, like the other data in this section.
   - Audit records stay with the organization's books.
   - The organization keeps accounting records for the legal period from its own export.
7. **Security.**
   - Per-organization isolation in the database.
   - Encrypted transport.
   - Two-factor authentication for approvals.
   - An append-only audit trail.
   - Daily backups with restore drills.
   - Sign-in attempt limits.

   A personal data breach is notified to the authority and to your organization within 72 hours of discovery.
8. **Your rights.** You may:
   - be informed about the processing;
   - consent, or withdraw consent;
   - access and correct your data;
   - ask for deletion;
   - restrict or object to processing;
   - receive a copy;
   - complain and seek compensation.

   For account data, write to [email]. For data in an organization's books, contact that organization first; we help it act on your request. Legal retention duties, such as for accounting records, limit some rights.
9. **Changes.** At least [30] days' notice in the app and by email before processing is widened.
10. **Contact.** Data protection contact: [name or team], [email], [address].

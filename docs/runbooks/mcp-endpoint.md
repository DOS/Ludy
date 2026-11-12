# The MCP endpoint (Ludy as the gate for AI apps)

Decision: [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md) decision 2 and [ADR-0032](../adr/0032-oauth-authorization-server.md). Tracking: issue #2975.

What it is: a standard remote MCP server at `PUBLIC_URL/mcp` (Streamable HTTP, stateless) and the OAuth 2.1 authorization server that guards it, both inside the Ludy API. An owner or admin connects an AI app (Claude, ChatGPT, Gemini CLI, OpenClaw, DOS Claw, your own agent) by pasting the MCP address into it; the app sends them to Ludy's own consent page; they pick the org and allow. The app then reads what the tools offer, with the rights of the person who allowed it, and nothing else. The connection is **read only** and has three tools: `ludy_about` (the org's name and the connection's own details), `ludy_parties_list` (customers and suppliers) and `ludy_invoices_list` (recorded sales and purchase invoices); a signals tool and the commands come in later steps.

Ludy runs without it: it is off unless you turn it on.

## Turn it on

1. Make the signing key (ES256) and keep it like any secret (never in git). One way, with Node:

   ```bash
   node -e "const {generateKeyPairSync,randomBytes}=require('node:crypto');const k=generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'});console.log(JSON.stringify({keys:[{...k,alg:'ES256',use:'sig',kid:'k-'+randomBytes(4).toString('hex')}]}))"
   ```

2. Make the cookie secrets: `openssl rand -base64 48` (one or more, comma separated; the first signs, the others still verify).
3. Set `OAUTH_SERVER=on`, `OAUTH_JWKS=<the JSON>` and `OAUTH_COOKIE_KEYS=<the secrets>` for the API. `APP_URL`, when you set it, must be `PUBLIC_URL`'s own origin: the consent page and the authorization server's interaction cookie share the API's origin in this step (a deployment with the app on another origin cannot turn it on yet; the API refuses to start and says so).
4. Restart the API. `GET PUBLIC_URL/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` answer.

To rotate the key: add the new key to the set (first), restart, and remove the old one after 10 minutes (the life of an access token). Refresh tokens are opaque and are not tied to a key.

## Connect an app

Step by step for Claude and ChatGPT, with what is verified and what is not: [Connect Claude and ChatGPT](mcp-connect-claude-chatgpt.md).

Give the app the address `PUBLIC_URL/mcp`. It discovers the rest (protected resource metadata, then the authorization server metadata), registers itself (dynamic client registration or a client ID metadata document), and sends you to `PUBLIC_URL/oauth/interaction/<id>`. Sign in as usual, choose the org (only orgs where you are owner or admin are offered), read the list, allow. The name an app shows is the one it gave itself; the page shows the address the browser returns to, which is the fact to check.

## What it can and cannot do

- **What the two data tools return, and never return** (owner decision 2026-11-11; the privacy review of each is the comment on its query, and `apps/kernel/test/mcp-data.db.test.ts` pins it). An AI app connected to the org sees the customer data the person who allowed it sees, as the HubSpot and Twenty MCP servers show theirs. `ludy_parties_list`: id, company or person, name, the company a person works at, **email, phone, address and tax code**, the day recorded, and `sourceTrust` (who put the row in: `external` means a visitor, a public booking form or an import typed it, so a client should trust it less). `ludy_invoices_list`: series and number, date, sale or purchase, the party's name and **tax code**, subtotal, VAT, total, currency, **the description of each line** (the first 20, with the line count) and whether the invoice was voided and **why**. Never: salaries or payroll, bank account records (a number someone typed into a line description or a void reason is free text and does come through), member-private notes, todos and results, anything a `sensitive` query covers, an invoice line's amounts or accounts, the file an invoice came from. Every text value is cut to one plain line (no line break, no separator, no bidi control, no invisible tag character). Both return the newest 50 at most and say when there are more (`total`, `truncated`); there is no search and no paging yet. **The consent page tells the person plainly that the app will see customer and invoice details, contact information included, and that this leaves Ludy and is kept by that app's provider under its own terms: connect only an app you would give the same information to.** A name or a line description is text a person, a customer, a supplier's invoice or a visitor wrote: it is data for the app, and the tool says so, but a language model can still be fooled by text, so treat an `external` row and any invoice text as untrusted.
- Reads only, through the queries a tool names, as the person who allowed it (their live role; if they lose the owner or admin role, leave, or are disabled, the connection stops at once). No command, no write, no tool that sends, edits or spends.
- Tokens: access 10 minutes (ES256 JWT, audience exactly `PUBLIC_URL/mcp`), refresh 30 days and rotating (a replayed refresh token ends the connection). Only hashes of codes and refresh tokens are stored.
- The grant lasts at most 89 days. An owner or admin sees and disconnects every connection in Settings, "Connected AI apps"; the person who allowed one may disconnect their own through the same screen's command.
- **Member grants** (a member connecting their own AI app, ADR-0051 decision 2; the org's owner turns this on in Settings, off by default): a person may hold five live ones per org, and sees only their own. It stops at once when the owner turns the switch off (for a member or viewer; an owner's or admin's own grant needs no switch), and when the person leaves the org or is disabled. **A demotion is stricter on purpose:** when an owner or admin is demoted to member or viewer, every connection they made is ended, member grants included, and none comes back if the role is restored; they connect again under their new role. This is the existing guard trigger on the grant table, pinned in `apps/kernel/test/mcp-member-grant.db.test.ts`.
- Stops at once: disconnecting, the org's Stop AI switch, the deployment's AI switch (`pnpm ops:kill-switch`), a lost role.
- A connection does not depend on the person's browser session: changing a password or signing out everywhere does not cut it. After an account takeover, disconnect the apps in Settings (the grant's owner or admin can), and the org's Stop AI switch cuts all of them at once. A grant also ends for good when its person stops being an owner or admin, leaves the org or is disabled (restoring the role later does not bring it back; a new consent is needed).
- Every call writes an audit row (`kernel.mcp.call`) that names the grant, the client and the tool and says `mcpCall: true`; it never reads as the person's own click. Rate limit per grant (`MCP_GRANT_PER_MINUTE`, default 60) a cap of concurrent calls (`MCP_GRANT_CONCURRENCY`, default 4) and a daily row budget per grant (`MCP_GRANT_DAILY_ROWS`, default 2000 rows, counted over the UTC day; a call that starts under it may end over it by one answer, and once it is spent every tool call is refused, audited as `rate_limited`, until midnight UTC); registrations are limited per address and in total (`OAUTH_REGISTER_PER_MINUTE`, `OAUTH_REGISTER_GLOBAL_PER_MINUTE`). A registration that never obtained a grant expires after a day. The provider's routes answer CORS only for the origins in `MCP_ALLOWED_ORIGINS`, and refuse a body over 64 KB.

## When something does not work

| Symptom | Check |
| --- | --- |
| The API will not start with `OAUTH_SERVER=on` | The message names the setting: `OAUTH_JWKS` must be ES256 private keys with a `kid`, `OAUTH_COOKIE_KEYS` at least 32 characters, `APP_URL` the same origin as `PUBLIC_URL`. |
| The app says the server cannot be discovered | `PUBLIC_URL` is the address the app reaches (https, behind your proxy with `TRUSTED_PROXY_HOPS` set); the two `.well-known` addresses answer JSON. |
| The consent page says the request is lost | The interaction lives 10 minutes and its cookie belongs to the API's origin: open the page in the same browser the app started it in, and do not sign in through another origin. |
| An app is refused after it worked | The connection was disconnected, expired (89 days), the person who allowed it lost the owner or admin role, or the org or the deployment stopped AI. Look at the audit rows `kernel.mcp.call` and the list in Settings. |
| 429 | The grant spent its minute (`MCP_GRANT_PER_MINUTE`) or has too many calls in flight. |
| tool error "The daily limit of rows ..." | The grant read its day's rows (`MCP_GRANT_DAILY_ROWS`); it starts again at midnight UTC. Raise the setting only if the owner asks. |

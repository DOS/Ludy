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

Give the app the address `PUBLIC_URL/mcp`. It discovers the rest (protected resource metadata, then the authorization server metadata), registers itself (dynamic client registration or a client ID metadata document), and sends you to `PUBLIC_URL/oauth/interaction/<id>`. Sign in as usual, choose the org (only orgs where you are owner or admin are offered), read the list, allow. The name an app shows is the one it gave itself; the page shows the address the browser returns to, which is the fact to check.

## What it can and cannot do

- What the two data tools return, and never return (the privacy review of each is the comment on its query, and `apps/kernel/test/mcp-data.db.test.ts` pins it). `ludy_parties_list`: id, company or person, name, the company a person works at, the day recorded; never an email, phone, address or tax code (a household business's tax code is its owner's own). `ludy_invoices_list`: series and number, date, sale or purchase, the party's name, subtotal, VAT, total, currency, voided or not; never the lines, a tax code, an address, the file the invoice came from or the reason of a void. Both return the newest 50 at most and say when there are more (`total`, `truncated`); there is no search and no paging yet. A name is text a person typed or an import brought: it is cleaned to one line and the tool says it is data, never an instruction. An AI app that is sent this data keeps it under its own provider's terms: connect only an app you would give the same information to.
- Reads only, through the queries a tool names, as the person who allowed it (their live role; if they lose the owner or admin role, leave, or are disabled, the connection stops at once). No command, no write, no tool that sends, edits or spends.
- Tokens: access 10 minutes (ES256 JWT, audience exactly `PUBLIC_URL/mcp`), refresh 30 days and rotating (a replayed refresh token ends the connection). Only hashes of codes and refresh tokens are stored.
- The grant lasts at most 89 days. An owner or admin sees and disconnects every connection in Settings, "Connected AI apps"; the person who allowed one may disconnect their own through the same screen's command.
- Stops at once: disconnecting, the org's Stop AI switch, the deployment's AI switch (`pnpm ops:kill-switch`), a lost role.
- A connection does not depend on the person's browser session: changing a password or signing out everywhere does not cut it. After an account takeover, disconnect the apps in Settings (the grant's owner or admin can), and the org's Stop AI switch cuts all of them at once. A grant also ends for good when its person stops being an owner or admin, leaves the org or is disabled (restoring the role later does not bring it back; a new consent is needed).
- Every call writes an audit row (`kernel.mcp.call`) that names the grant, the client and the tool and says `mcpCall: true`; it never reads as the person's own click. Rate limit per grant (`MCP_GRANT_PER_MINUTE`, default 60) and a cap of concurrent calls (`MCP_GRANT_CONCURRENCY`, default 4); registrations are limited per address and in total (`OAUTH_REGISTER_PER_MINUTE`, `OAUTH_REGISTER_GLOBAL_PER_MINUTE`). A registration that never obtained a grant expires after a day. The provider's routes answer CORS only for the origins in `MCP_ALLOWED_ORIGINS`, and refuse a body over 64 KB.

## When something does not work

| Symptom | Check |
| --- | --- |
| The API will not start with `OAUTH_SERVER=on` | The message names the setting: `OAUTH_JWKS` must be ES256 private keys with a `kid`, `OAUTH_COOKIE_KEYS` at least 32 characters, `APP_URL` the same origin as `PUBLIC_URL`. |
| The app says the server cannot be discovered | `PUBLIC_URL` is the address the app reaches (https, behind your proxy with `TRUSTED_PROXY_HOPS` set); the two `.well-known` addresses answer JSON. |
| The consent page says the request is lost | The interaction lives 10 minutes and its cookie belongs to the API's origin: open the page in the same browser the app started it in, and do not sign in through another origin. |
| An app is refused after it worked | The connection was disconnected, expired (89 days), the person who allowed it lost the owner or admin role, or the org or the deployment stopped AI. Look at the audit rows `kernel.mcp.call` and the list in Settings. |
| 429 | The grant spent its minute (`MCP_GRANT_PER_MINUTE`) or has too many calls in flight. |

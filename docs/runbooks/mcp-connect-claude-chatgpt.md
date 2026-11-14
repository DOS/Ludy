# Connect Claude and ChatGPT to Ludy (MCP)

For an owner or admin who wants an AI app to read their Ludy data. The endpoint itself, its limits and its privacy rules are in [the MCP endpoint runbook](mcp-endpoint.md); this page is the click path.

## What is verified and what is not

Every step is marked. **Verified** means a test in this repository runs it: `apps/kernel/test/mcp-oauth.db.test.ts` drives the official MCP TypeScript SDK client (the same client library many apps embed) through discovery, dynamic client registration, the consent page, the token exchange, `tools/list` and a tool call. **Unverified** means it depends on the real Claude or ChatGPT app, their menus, plans or their own server-side behaviour, which we have not run against a Ludy deployment. Menu names below come from each vendor's public documentation as we know it and move often: if a screen differs, follow the vendor's current "custom connector" or "remote MCP server" page, and tell the Platform line what changed.

## Before you start

1. **A public https address.** Claude and ChatGPT call your server from their own cloud, not from your computer. `http://localhost:8080` cannot work; a self-hosted install needs a public https address in front of the API (a reverse proxy with a real certificate, `PUBLIC_URL` set to that address, `TRUSTED_PROXY_HOPS` set to the number of proxies). Verified: the endpoint and the two `.well-known` documents answer behind `PUBLIC_URL`. Unverified: a real TLS proxy in front of it (the test runs plain http on localhost).
2. **Turn the endpoint on** (`OAUTH_SERVER=on`, the signing key and the cookie secrets): see [Turn it on](mcp-endpoint.md#turn-it-on). Check that `PUBLIC_URL/.well-known/oauth-protected-resource/mcp` answers JSON.
3. **You are an owner or admin of the org.** Only they can allow a connection; a plain member is refused on the consent page.
4. **Know what you are handing over.** The app will read customer contacts (name, email, phone, address, tax code) and invoice details, and that leaves Ludy and is kept by the app's provider under its own terms. The consent page says so. Connect only an app you would give the same information to. Reads only: the app cannot change, send or spend anything.

The address to give every app is `PUBLIC_URL/mcp` (for example `https://ludy.example.com/mcp`).

## Claude

1. Open Claude on the web or desktop and go to Settings, then Connectors (unverified: the name and place of this menu).
2. Add a custom connector (unverified: some plans only let an organization owner add one, and the feature may be limited by plan). Name it "Ludy" and paste `PUBLIC_URL/mcp`. Leave any client ID or secret fields empty: Ludy registers the app by itself. Verified for the SDK client; unverified for Claude's own client.
3. Claude opens a browser window at `PUBLIC_URL/oauth/interaction/...`. Verified (SDK client, consent step done by the test in place of the browser).
4. Sign in to Ludy if asked, choose the org (only orgs where you are owner or admin are listed), read the page, and press allow. Check the address the page says the browser will return to: it must be an address of Claude. Verified for the page; unverified for the address Claude uses.
5. Back in Claude, enable the Ludy tools in a chat (unverified) and ask, for example, "Which Ludy organization am I connected to?" It should call `ludy_about`. Then "List my newest customers" calls `ludy_parties_list`, and "Show my latest sales invoices" calls `ludy_invoices_list`. "What is waiting for my review in Social?" calls `ludy_social_review_queue`, and "List my Social posts planned for next week" calls `ludy_social_posts_list`. "What needs my attention?" calls `ludy_signals`, which lists won deals with no invoice and overdue customers with an open deal, and names any check it could not make. Verified: the four tools, their arguments and their answers, with the SDK client.

## ChatGPT

1. In ChatGPT, open Settings, then Connectors (or Apps), and turn on developer mode if the custom connector option is hidden (unverified: the menu, the name "developer mode" and the plans that have it).
2. Create a connector, choose a remote MCP server, paste `PUBLIC_URL/mcp`, and choose OAuth as the sign-in (unverified).
3. ChatGPT discovers Ludy's authorization server and registers itself by dynamic client registration (unverified for ChatGPT's own client; verified for the SDK client). Ludy also accepts a client ID metadata document, but this has not been tried with any real app on a public host.
4. Ludy's consent page opens: choose the org, read, allow, as in the Claude steps (unverified for the redirect address ChatGPT uses).
5. Start a chat, add the Ludy connector (unverified) and try the same three questions as above.

## Other apps

Gemini CLI, OpenClaw, DOS Claw and your own agent connect the same way: they take the address `PUBLIC_URL/mcp` and do the rest. Any client that speaks MCP revision 2025-06-18, 2025-11-25 or 2026-07-28 over Streamable HTTP without a session id should work (verified for the three revisions with test clients).

## After you connect

- Settings, "Connected AI apps" lists every connection with the app's name (as the app declared it) and when it last read. Disconnect there at any time; the app stops at once.
- Every call is in the audit log as "Via <app name> (MCP)" with the tool.
- Each connection may read 2000 rows a day (`MCP_GRANT_DAILY_ROWS`); after that the app is told the daily limit is used up until midnight UTC.
- A connection lasts at most 89 days; the app will ask you to allow again.

## If it fails

| What you see | Likely cause |
| --- | --- |
| The app cannot find or reach the server | The address is not public https, or `PUBLIC_URL` does not match the address the app uses. Open `PUBLIC_URL/.well-known/oauth-protected-resource/mcp` in a browser. |
| The app says it cannot register or the scope is wrong | The app asked for a scope Ludy does not offer. Ludy offers only `ludy.read`. Check the runbook's troubleshooting table and the API log. |
| The consent page says the request is lost | It lives 10 minutes; start again from the app, in the same browser. |
| "Not allowed" after you press allow | You are not an owner or admin of the org you chose. |
| The app worked, then stops | Disconnected, expired, you lost the role, Stop AI is on, or the daily row limit is used up. See the audit log and Settings. |

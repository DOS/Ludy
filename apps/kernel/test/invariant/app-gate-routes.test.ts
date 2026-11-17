// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): the routes that run without a session, classed against the per-org app gate (ADR-0053 section 3, slice c C2).
// An org's owner can switch an app off; a public address of that app must then answer like one that never existed, and an app's webhook must be dropped.
// Every public route in route-coverage.test.ts (its PUBLIC and PENDING lists) carries a class here, so a public route added later fails this test until
// someone says whether it is an app's (and where the gate is) or kernel's. Reads route-coverage.test.ts as text, so this directory stays self-contained.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Gate =
  // The SQL function that finds the org asks crove_kernel.org_app_on, and the route answers its own not-found body.
  | 'sql'
  // The handler goes through a runtime query or command, which refuses MODULE_OFF (a ticket route maps it to its bad-ticket answer).
  | 'runtime'
  // Acknowledged (2xx) and dropped where the org is found, in SQL, so a provider keeps its subscription.
  | 'dropped'
  // Kernel core: never gated (conversations, mail, auth, status, the SPA, OAuth and MCP, the stream, the extension token).
  | 'kernel'
  // An erasure duty: it runs while an app is off.
  | 'keeping'
  // Not in the code yet: its PR must replace this with a real class.
  | 'pending';

const CLASSES: Record<string, { app: string; gate: Gate; why: string }> = {
  '/healthz': { app: 'kernel', gate: 'kernel', why: 'liveness' },
  '/readyz': { app: 'kernel', gate: 'kernel', why: 'readiness' },
  '/version': { app: 'kernel', gate: 'kernel', why: 'build id' },
  '/api/config': { app: 'kernel', gate: 'kernel', why: 'SPA config' },
  '/status': { app: 'kernel', gate: 'kernel', why: 'status page' },
  '/auth/v1/*': { app: 'kernel', gate: 'kernel', why: 'sign-in proxy' },
  '/webhooks/mail/:provider': { app: 'kernel', gate: 'kernel', why: 'mail delivery events' },
  '/api/inbound/email': { app: 'kernel', gate: 'kernel', why: 'inbound mail' },
  '/api/bank-feed/:provider/webhook': { app: 'finance', gate: 'dropped', why: 'crove_finance.bank_feed_notice_claim drops the notice of an org whose Finance is off' },
  '/api/ads/meta/data-deletion': { app: 'ads', gate: 'keeping', why: 'a platform erasure request is a duty that outlives the app switch' },
  '/api/channels/zalo/webhook': { app: 'kernel', gate: 'kernel', why: 'conversation core' },
  '/api/channels/telegram/webhook/:hook': { app: 'kernel', gate: 'kernel', why: 'conversation core' },
  '/api/channels/facebook/webhook': { app: 'kernel', gate: 'kernel', why: 'conversation core' },
  '/api/channels/whatsapp/webhook': { app: 'kernel', gate: 'kernel', why: 'conversation core' },
  '/api/extension/token': { app: 'kernel', gate: 'kernel', why: 'one-time code exchange; the extension calls into Meetings are gated by the runtime' },
  '/api/meetings/:id/video/stream': { app: 'meetings', gate: 'runtime', why: 'meetings.meeting.media_meta is gated; any 4xx is the bad-ticket answer' },
  '/api/stream': { app: 'kernel', gate: 'kernel', why: 'the event stream, opened with a ticket after the session check (its per-app filter is in the stream)' },
  '/api/review/view': { app: 'social', gate: 'sql', why: 'review_link_by_token' },
  '/api/review/media': { app: 'social', gate: 'sql', why: 'review_link_by_token' },
  '/api/review/file': { app: 'social', gate: 'sql', why: 'review_link_by_token' },
  '/api/review/answer': { app: 'social', gate: 'sql', why: 'review_link_by_token: a write of the visitor is refused as for a revoked link' },
  '/api/quote/view': { app: 'crm', gate: 'sql', why: 'quote_link_view' },
  '/api/quote/logo': { app: 'crm', gate: 'sql', why: 'quote_link_logo' },
  '/api/report/view': { app: 'social', gate: 'sql', why: 'report_link_view' },
  '/cal/:file': { app: 'social+crm', gate: 'sql', why: 'calendar_feed_events (social) and booking_feed_events (crm)' },
  '/l/:code': { app: 'social', gate: 'sql', why: 'short_link_hit: no hit is counted for an off org' },
  '/b/:slug': { app: 'social', gate: 'sql', why: 'bio_page_view' },
  '/b/:slug/go/:target': { app: 'social', gate: 'sql', why: 'bio_page_go: no click is counted for an off org' },
  '/b/:slug/img/:file': { app: 'social', gate: 'sql', why: 'bio_page_file' },
  '/api/booking/:org/:type': { app: 'crm', gate: 'sql', why: 'booking_event_type and booking_manage_find cover the page, the request, the status and the manage link' },
  '/assets/*': { app: 'kernel', gate: 'kernel', why: 'SPA static files' },
  '/favicon.svg': { app: 'kernel', gate: 'kernel', why: 'SPA icon' },
  '/*': { app: 'kernel', gate: 'kernel', why: 'SPA shell' },
  '/.well-known/oauth-protected-resource/mcp': { app: 'kernel', gate: 'kernel', why: 'OAuth metadata' },
  '/.well-known/oauth-authorization-server': { app: 'kernel', gate: 'kernel', why: 'OAuth metadata' },
  '/.well-known/openid-configuration': { app: 'kernel', gate: 'kernel', why: 'OAuth metadata' },
  '/oauth/*': { app: 'kernel', gate: 'kernel', why: 'authorization server' },
  '/mcp': { app: 'kernel', gate: 'kernel', why: 'MCP endpoint: its calls into an app answer MODULE_OFF from the runtime' },
  // #3324 (eSign): each public route gates via its crove_sign SECURITY DEFINER resolver (org_app_on + entitlement with opaque 404).
  '/api/sign/view': { app: 'sign', gate: 'sql', why: 'crove_sign.public_token_resolve + crove_sign.public_record_view gate org_app_on + entitlement -> 404' },
  '/api/sign/pdf': { app: 'sign', gate: 'sql', why: 'crove_sign.public_pdf_source gates org_app_on + entitlement -> 404' },
  '/api/sign/otp/request': { app: 'sign', gate: 'sql', why: 'crove_sign.public_request_otp gates org_app_on + entitlement -> 404' },
  '/api/sign/otp/verify': { app: 'sign', gate: 'sql', why: 'crove_sign.public_verify_otp gates org_app_on + entitlement -> 404' },
  '/api/sign/submit': { app: 'sign', gate: 'sql', why: 'crove_sign.public_submit gates org_app_on + entitlement -> 404' },
  '/api/sign/decline': { app: 'sign', gate: 'sql', why: 'crove_sign.public_decline gates org_app_on + entitlement -> 404' },
  '/api/sign/verify': { app: 'sign', gate: 'sql', why: 'crove_sign.public_verify_certificate gates org_app_on + entitlement -> 404' },
  // #3525 (eSign Slice 2a A1): Slice 2a PR moves each from 'pending' to 'sql' (crove_sign SECURITY DEFINER resolver checking org_app_on + entitlement with opaque 404).
  '/api/sign/direct/view': { app: 'sign', gate: 'pending', why: '#3525 (Slice 2a A1 direct signing link pre-registration)' },
  '/api/sign/direct/pdf': { app: 'sign', gate: 'pending', why: '#3525 (Slice 2a A1 direct signing link pre-registration)' },
  '/api/sign/direct/otp/request': { app: 'sign', gate: 'pending', why: '#3525 (Slice 2a A1 direct signing link pre-registration)' },
  '/api/sign/direct/otp/verify': { app: 'sign', gate: 'pending', why: '#3525 (Slice 2a A1 direct signing link pre-registration)' },
  '/api/sign/direct/start': { app: 'sign', gate: 'pending', why: '#3525 (Slice 2a A1 direct signing link pre-registration)' },
};

// The paths of the two lists of route-coverage.test.ts: a key at the start of a line inside `const PUBLIC` or `const PENDING`. A line at the key indent that
// is not a single-quoted path key (a double-quoted or computed key) would escape classification, so it fails here instead.
function publicLists(): { paths: string[]; pending: string[] } {
  const source = readFileSync(new URL('./route-coverage.test.ts', import.meta.url), 'utf8');
  const lists: Record<string, string[]> = { PUBLIC: [], PENDING: [] };
  for (const name of ['PUBLIC', 'PENDING']) {
    const start = source.indexOf(`const ${name}: Record<string, string> = {`);
    expect(start, name).toBeGreaterThan(-1);
    const end = source.indexOf('\n};', start);
    const lines = source.slice(start, end).split('\n').slice(1);
    const stray = lines.filter((line) => /^ {2}\S/.test(line) && !/^ {2}'\/[^']*':/.test(line));
    expect(stray, `${name}: a key this test cannot read`).toEqual([]);
    for (const line of lines) {
      const m = /^ {2}'(\/[^']*)':/.exec(line);
      if (m) (lists[name] as string[]).push(m[1] as string);
    }
  }
  return { paths: [...(lists.PUBLIC as string[]), ...(lists.PENDING as string[])], pending: lists.PENDING as string[] };
}
const publicPaths = () => publicLists().paths;

describe('public routes against the per-org app gate (ADR-0053, slice c C2)', () => {
  it('classes every public route, so a new one must say whether it belongs to an app and where its gate is', () => {
    const paths = publicPaths();
    expect(paths.length).toBeGreaterThan(40);
    expect(paths.filter((p) => !Object.hasOwn(CLASSES, p))).toEqual([]);
  });

  it('keeps no class for a route that is gone, so the table cannot go stale', () => {
    const paths = new Set(publicPaths());
    expect(Object.keys(CLASSES).filter((p) => !paths.has(p))).toEqual([]);
  });

  it('gates every route of Social, CRM, Finance and Sign in SQL or by dropping, and keeps kernel and pending classes honest', () => {
    const { pending } = publicLists();
    for (const [path, c] of Object.entries(CLASSES)) {
      if (!pending.includes(path) && ['social', 'crm', 'social+crm', 'finance', 'sign'].includes(c.app)) expect(['sql', 'dropped'], path).toContain(c.gate);
      // The kernel class belongs to the kernel app and the kernel app to the kernel class: an app's route cannot be filed as kernel.
      expect(c.gate === 'kernel', `${path}: kernel gate and kernel app go together`).toBe(c.app === 'kernel');
      // 'pending' stands only for a route that is still in route-coverage's PENDING list (not in the code yet).
      expect(c.gate === 'pending', `${path}: pending only for a PENDING path`).toBe(pending.includes(path));
      expect(c.why.length, path).toBeGreaterThan(3);
    }
  });
});

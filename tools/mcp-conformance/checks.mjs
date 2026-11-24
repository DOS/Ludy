// SPDX-License-Identifier: AGPL-3.0-only
// The checks of `pnpm mcp:conformance` (issue #4592; ADR-0051 decisions 2, 7 and 10; docs/plan/vy.md section 6, V10). Every check has a stable
// name, passes, fails with a message that says which rule broke, or is skipped with the reason. No model call is made anywhere: the tool proves the
// door of the coworker (the MCP endpoint, its authorization server and the wake-up webhook) behaves as the decision says.
//
//   metadata.protected-resource      RFC 9728 document of the resource
//   metadata.authorization-server    RFC 8414 document of the authorization server
//   mcp.challenge                    a call with no token is answered 401 and points at the resource metadata (RFC 9728, section 5.1)
//   oauth.pkce-required              an authorization request with no code_challenge is refused
//   oauth.resource-indicator         an authorization request for another resource is refused (RFC 8707)
//   oauth.flow                       register, authorize with PKCE and `resource`, consent, token; a signed JWT for the resource
//   mcp.tools                        the token opens the endpoint and the tool list answers
//   tools.hints-present              every tool carries readOnlyHint and destructiveHint, coherently
//   tools.hints-match-tier           a proposal tool (R2 and R3) is neither read only nor destructive
//   proposals.no-execution           a proposal tool answers a pending proposal, never the effect
//   pairing.code                     the pairing-code path (skipped until #4591 lands)
//   wake.*                           a sample receiver verifies the signature and refuses a stale timestamp and a repeated event id
import { randomBytes, randomUUID } from 'node:crypto';
import { CookieJar, pkce, readJwt, request, verifyEs256 } from './http.mjs';
import { sampleOf } from './sample-args.mjs';
import { VECTORS, createReceiver, sendSamples, verifyWake, signWake } from './wake.mjs';

const PROTOCOL_VERSION = '2025-11-25';
const REDIRECT_URI = 'http://127.0.0.1:8976/callback';
const READ_SCOPE = 'ludy.read';
const WRITE_SCOPE = 'ludy.engage.write';

const CHECK_NAMES = [
  'metadata.protected-resource',
  'metadata.authorization-server',
  'mcp.challenge',
  'oauth.pkce-required',
  'oauth.resource-indicator',
  'oauth.flow',
  'mcp.tools',
  'tools.hints-present',
  'tools.hints-match-tier',
  'proposals.no-execution',
  'pairing.code',
  'wake.vectors',
  'wake.valid-accepted',
  'wake.window-accepted',
  'wake.bad-signature-refused',
  'wake.stale-timestamp-refused',
  'wake.rotation-accepted',
  'wake.repeated-event-id',
];

/** @typedef {{ name: string, status: 'pass' | 'fail' | 'skip', message: string }} Result */

class Failure extends Error {}
class Skipped extends Error {}
const fail = (/** @type {string} */ message) => new Failure(message);
const skip = (/** @type {string} */ message) => new Skipped(message);

/** The problems of a tool list against the hint rules. Pure, so the test and the check share it. @param {any[]} tools */
export function hintProblems(tools) {
  /** @type {string[]} */
  const present = [];
  /** @type {string[]} */
  const tier = [];
  for (const tool of tools) {
    const name = String(tool?.name ?? '(unnamed)');
    const a = tool?.annotations;
    if (a === null || typeof a !== 'object') {
      present.push(`${name}: no annotations`);
      continue;
    }
    if (typeof a.readOnlyHint !== 'boolean') present.push(`${name}: readOnlyHint is missing`);
    if (typeof a.destructiveHint !== 'boolean') present.push(`${name}: destructiveHint is missing`);
    if (a.readOnlyHint === true && a.destructiveHint === true) present.push(`${name}: both readOnlyHint and destructiveHint are true`);
    if (isProposalShaped(tool?.outputSchema) && (a.readOnlyHint !== false || a.destructiveHint !== false)) {
      tier.push(`${name}: it answers a proposal (R2 or R3), so readOnlyHint and destructiveHint must both be false (it changes nothing by itself)`);
    }
  }
  return { present, tier };
}

/** A tool whose answer is `{ proposalId, status: 'pending' }` is a proposal tool. @param {any} schema */
export function isProposalShaped(schema) {
  const props = schema?.properties;
  return Boolean(props && 'proposalId' in props && Array.isArray(props.status?.enum) && props.status.enum.includes('pending'));
}

/** @param {string} text */
function parseMcpBody(text, contentType = '') {
  if (contentType.includes('text/event-stream')) {
    const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
    return JSON.parse(data.at(-1) ?? 'null');
  }
  return JSON.parse(text);
}

/**
 * Runs every check. `options`: url (the instance), token (an owner's or admin's access token for the consent page), signUp (make a throwaway
 * account and org on a throwaway instance), org, wakeUrl and wakeSecret (the connector's own receiver), proposalTool and proposalArgs.
 * @param {{ url: string, token?: string, signUp?: boolean, org?: string, wakeUrl?: string, wakeSecret?: string, proposalTool?: string, proposalArgs?: Record<string, unknown>, receiverFlaws?: string[], only?: string, progress?: (result: Result) => void }} options
 * @returns {Promise<Result[]>}
 */
export async function runConformance(options) {
  const base = options.url.replace(/\/+$/, '');
  /** @type {Result[]} */
  const results = [];
  /** @type {Record<string, any>} */
  const state = {};
  const status = (/** @type {string} */ name) => results.find((r) => r.name === name)?.status;
  const push = (/** @type {Result} */ result) => {
    results.push(result);
    options.progress?.(result);
  };
  const wanted = (/** @type {string} */ name) => !options.only || name.startsWith(options.only);

  /** @param {string} name @param {string[]} requires @param {() => Promise<string>} run */
  async function check(name, requires, run) {
    if (!wanted(name)) return;
    const blocked = requires.find((r) => status(r) !== 'pass');
    if (blocked) {
      push({ name, status: 'skip', message: `needs ${blocked}, which ${status(blocked) === 'fail' ? 'failed' : 'did not pass'}` });
      return;
    }
    try {
      push({ name, status: 'pass', message: await run() });
    } catch (error) {
      if (error instanceof Skipped) push({ name, status: 'skip', message: error.message });
      else if (error instanceof Failure) push({ name, status: 'fail', message: error.message });
      else {
        const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
        push({ name, status: 'fail', message: `could not run: ${error instanceof Error ? error.message : String(error)}${cause}` });
      }
    }
  }

  const resource = `${base}/mcp`;

  await check('metadata.protected-resource', [], async () => {
    const res = await request(`${base}/.well-known/oauth-protected-resource/mcp`);
    const doc = /** @type {any} */ (res.json);
    if (res.status !== 200 || !doc || typeof doc !== 'object') throw fail(`GET /.well-known/oauth-protected-resource/mcp answered ${res.status}, not a JSON document (RFC 9728)`);
    if (doc.resource !== resource) throw fail(`resource is ${JSON.stringify(doc.resource)}, it must be exactly ${resource}`);
    if (!Array.isArray(doc.authorization_servers) || doc.authorization_servers.length === 0 || doc.authorization_servers.some((/** @type {unknown} */ s) => typeof s !== 'string')) throw fail('authorization_servers must list at least one issuer');
    if (!Array.isArray(doc.scopes_supported) || !doc.scopes_supported.includes(READ_SCOPE)) throw fail(`scopes_supported must include ${READ_SCOPE}`);
    if (!Array.isArray(doc.bearer_methods_supported) || !doc.bearer_methods_supported.includes('header')) throw fail('bearer_methods_supported must include "header"');
    state.prm = doc;
    state.issuer = String(doc.authorization_servers[0]).replace(/\/+$/, '');
    return `resource ${resource}, issuer ${state.issuer}`;
  });

  await check('metadata.authorization-server', ['metadata.protected-resource'], async () => {
    // The tool stays on the origin it was given: nothing is fetched from, or sent to, an address the instance's own documents name elsewhere.
    if (state.issuer !== base) throw fail(`the issuer ${state.issuer} is not the address the instance was given (${base}): PUBLIC_URL is wrong or the proxy hides the real one (nothing is fetched from another address)`);
    const res = await request(`${state.issuer}/.well-known/oauth-authorization-server`);
    const doc = /** @type {any} */ (res.json);
    if (res.status !== 200 || !doc || typeof doc !== 'object') throw fail(`GET ${state.issuer}/.well-known/oauth-authorization-server answered ${res.status}, not a JSON document (RFC 8414)`);
    if (String(doc.issuer ?? '').replace(/\/+$/, '') !== state.issuer) throw fail(`issuer is ${JSON.stringify(doc.issuer)}, it must equal the authorization server address ${state.issuer} (RFC 8414, section 3.3)`);
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof doc[key] !== 'string' || !URL.canParse(doc[key])) throw fail(`${key} is missing or not an address`);
    }
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'registration_endpoint']) {
      if (typeof doc[key] === 'string' && new URL(doc[key]).origin !== new URL(base).origin) throw fail(`${key} is ${doc[key]}, on another origin than the instance (${new URL(base).origin}); the endpoints of the authorization server must be on the issuer's origin`);
    }
    if (!Array.isArray(doc.code_challenge_methods_supported) || !doc.code_challenge_methods_supported.includes('S256')) throw fail('code_challenge_methods_supported must include S256');
    if (doc.code_challenge_methods_supported.includes('plain')) throw fail('code_challenge_methods_supported lists "plain"; only S256 is allowed (OAuth 2.1)');
    if (!Array.isArray(doc.response_types_supported) || !doc.response_types_supported.includes('code')) throw fail('response_types_supported must include "code"');
    if (Array.isArray(doc.response_types_supported) && doc.response_types_supported.some((/** @type {string} */ t) => t !== 'code')) throw fail('response_types_supported lists a type other than "code" (no implicit flow in OAuth 2.1)');
    if (!Array.isArray(doc.grant_types_supported) || !doc.grant_types_supported.includes('authorization_code')) throw fail('grant_types_supported must include authorization_code');
    if (typeof doc.registration_endpoint !== 'string') throw fail('registration_endpoint is missing (clients register themselves, RFC 7591)');
    state.as = doc;
    return `S256 only, endpoints at ${new URL(doc.authorization_endpoint).pathname} and ${new URL(doc.token_endpoint).pathname}`;
  });

  await check('mcp.challenge', ['metadata.protected-resource'], async () => {
    const res = await request(resource, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    if (res.status !== 401) throw fail(`a call with no token was answered ${res.status}, it must be 401`);
    const challenge = res.headers.get('www-authenticate') ?? '';
    if (!/^Bearer\b/i.test(challenge)) throw fail('the 401 has no `WWW-Authenticate: Bearer` header');
    const pointer = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    if (pointer !== `${base}/.well-known/oauth-protected-resource/mcp`) throw fail(`WWW-Authenticate names resource_metadata ${JSON.stringify(pointer)}, it must be ${base}/.well-known/oauth-protected-resource/mcp (RFC 9728, section 5.1)`);
    return '401 with the resource metadata address';
  });

  // --- OAuth ---------------------------------------------------------------------------------------------------------------------------
  const scopesOf = () => {
    const supported = /** @type {string[]} */ (state.prm?.scopes_supported ?? []);
    return supported.includes(WRITE_SCOPE) ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE];
  };

  async function registerClient() {
    if (state.clientId) return state.clientId;
    const res = await request(state.as.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Ludy MCP conformance check',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
        scope: scopesOf().join(' '),
      }),
    });
    const doc = /** @type {any} */ (res.json);
    if ((res.status !== 201 && res.status !== 200) || typeof doc?.client_id !== 'string') throw fail(`client registration answered ${res.status} ${res.text.slice(0, 160)} (RFC 7591)`);
    state.clientId = doc.client_id;
    return state.clientId;
  }

  /**
   * One authorization request. Resolves what the server did: an interaction (the consent page), a code, or an error.
   * @param {Record<string, string>} params @param {CookieJar} jar
   * @returns {Promise<{ kind: 'interaction', url: string } | { kind: 'code', code: string, state: string | null, iss: string | null } | { kind: 'error', error: string }>}
   */
  async function authorize(params, jar) {
    let url = `${state.as.authorization_endpoint}?${new URLSearchParams(params)}`;
    for (let hop = 0; hop < 8; hop++) {
      const res = await request(url, { jar });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, url);
        if (next.pathname.startsWith('/oauth/interaction/')) return { kind: 'interaction', url: next.toString() };
        if (next.toString().startsWith(REDIRECT_URI)) {
          const error = next.searchParams.get('error');
          if (error) return { kind: 'error', error };
          const code = next.searchParams.get('code');
          if (code) return { kind: 'code', code, state: next.searchParams.get('state'), iss: next.searchParams.get('iss') };
          throw fail(`the redirect to the client carried neither a code nor an error: ${next.search}`);
        }
        if (next.origin !== new URL(base).origin) throw fail(`the authorization request was redirected to ${next.origin}, another origin than the instance; the tool does not follow it`);
        url = next.toString();
        continue;
      }
      const doc = /** @type {any} */ (res.json);
      if (res.status >= 400 && typeof doc?.error === 'string') return { kind: 'error', error: doc.error };
      throw fail(`the authorization endpoint answered ${res.status} ${res.text.slice(0, 120)}, expected a redirect or an OAuth error`);
    }
    throw fail('the authorization request redirected more than 8 times');
  }

  /** @param {string} clientId @param {string} challenge @param {string} stateValue @param {Record<string, string>} [extra] */
  const authorizeParams = (clientId, challenge, stateValue, extra = {}) => ({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: scopesOf().join(' '),
    state: stateValue,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
    ...extra,
  });

  await check('oauth.pkce-required', ['metadata.authorization-server'], async () => {
    const clientId = await registerClient();
    const params = authorizeParams(clientId, '', randomUUID());
    delete (/** @type {any} */ (params).code_challenge);
    delete (/** @type {any} */ (params).code_challenge_method);
    const outcome = await authorize(params, new CookieJar());
    if (outcome.kind !== 'error') throw fail(`an authorization request with no code_challenge was not refused (it went on to ${outcome.kind}); PKCE with S256 is required for every client`);
    return `refused with ${outcome.error}`;
  });

  await check('oauth.resource-indicator', ['metadata.authorization-server'], async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const outcome = await authorize(authorizeParams(clientId, challenge, randomUUID(), { resource: `${base}/not-the-resource` }), new CookieJar());
    if (outcome.kind !== 'error') throw fail(`an authorization request for resource ${base}/not-the-resource was not refused (it went on to ${outcome.kind}); the server must answer invalid_target for a resource it does not guard (RFC 8707)`);
    return `refused with ${outcome.error}`;
  });

  // The consent page needs a signed-in owner or admin: the caller's token, or a throwaway account made with --sign-up.
  async function consentToken() {
    if (options.token) return options.token;
    if (!options.signUp) return null;
    const email = `mcp-conformance-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`;
    const signup = await request(`${base}/auth/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: randomBytes(18).toString('base64url') }) });
    const session = /** @type {any} */ (signup.json);
    if (signup.status >= 300 || typeof session?.access_token !== 'string') throw fail(`--sign-up: the sign-up answered ${signup.status} (a throwaway instance with auto-confirmed sign-up is needed)`);
    const made = await request(`${base}/api/rpc/org/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ json: { name: 'MCP conformance', idempotencyKey: randomUUID() } }),
    });
    if (made.status >= 300) throw fail(`--sign-up: creating the throwaway org answered ${made.status} ${made.text.slice(0, 160)}`);
    return session.access_token;
  }

  await check('oauth.flow', ['metadata.authorization-server'], async () => {
    const token = await consentToken();
    if (!token) throw skip('the consent page needs a signed-in owner or admin: pass --sign-up (throwaway instance) or set MCP_CONFORMANCE_TOKEN');
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const stateValue = randomUUID();
    const jar = new CookieJar();
    const scopes = scopesOf();
    const first = await authorize(authorizeParams(clientId, challenge, stateValue), jar);
    if (first.kind !== 'interaction') throw fail(`the authorization request did not lead to the consent page (${first.kind === 'error' ? first.error : first.kind})`);
    const uid = new URL(first.url).pathname.split('/').filter(Boolean).at(-1);
    const bearer = { authorization: `Bearer ${token}` };
    const details = await request(`${base}/oauth/interaction/${uid}/details`, { headers: bearer, jar });
    const detailsDoc = /** @type {any} */ (details.json);
    if (details.status !== 200 || !Array.isArray(detailsDoc?.orgs) || detailsDoc.orgs.length === 0) throw fail(`the consent page details answered ${details.status} ${details.text.slice(0, 160)}: the account must be an owner or admin of an org`);
    const org = detailsDoc.orgs.find((/** @type {any} */ o) => o.orgId === options.org || o.slug === options.org) ?? detailsDoc.orgs[0];
    const consent = await request(`${base}/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      jar,
      body: JSON.stringify({ decision: 'approve', orgId: org.orgId, kind: 'company', writes: scopes.filter((s) => s !== READ_SCOPE) }),
    });
    const consentDoc = /** @type {any} */ (consent.json);
    if (consent.status !== 200 || typeof consentDoc?.redirectTo !== 'string') throw fail(`the consent answered ${consent.status} ${consent.text.slice(0, 160)}`);
    // The provider's resume address (`/oauth/authorize/<uid>`) leads back to the client with the code.
    const resumeUrl = new URL(consentDoc.redirectTo, base);
    if (resumeUrl.origin !== new URL(base).origin) throw fail(`the consent answered redirectTo ${resumeUrl.origin}, another origin than the instance; the tool does not follow it`);
    const resumed = await followResume(resumeUrl.toString(), jar);
    if (resumed.state !== stateValue) throw fail('the redirect to the client lost the state parameter');
    // RFC 9207: a server that advertises authorization_response_iss_parameter_supported must put iss on every authorization response.
    if (resumed.iss === null && state.as.authorization_response_iss_parameter_supported === true) throw fail('the metadata advertises authorization_response_iss_parameter_supported but the redirect carries no iss (RFC 9207)');
    if (resumed.iss !== null && resumed.iss.replace(/\/+$/, '') !== state.issuer) throw fail(`the redirect carries iss=${resumed.iss}, it must be the issuer ${state.issuer} (RFC 9207)`);
    const exchange = await request(state.as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: resumed.code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource }).toString(),
    });
    const tokens = /** @type {any} */ (exchange.json);
    if (exchange.status !== 200 || typeof tokens?.access_token !== 'string') throw fail(`the token endpoint answered ${exchange.status} ${exchange.text.slice(0, 160)}`);
    if (String(tokens.token_type).toLowerCase() !== 'bearer') throw fail(`token_type is ${JSON.stringify(tokens.token_type)}, it must be Bearer`);
    if (typeof tokens.refresh_token !== 'string') throw fail('no refresh_token in the answer');
    const jwt = readJwt(tokens.access_token);
    if (!jwt) throw fail('the access token is not a JWT (RFC 9068)');
    const aud = jwt.payload['aud'];
    if (!(aud === resource || (Array.isArray(aud) && aud.includes(resource)))) throw fail(`the access token's audience is ${JSON.stringify(aud)}, it must be the resource ${resource} (RFC 8707, RFC 9068)`);
    if (String(jwt.payload['iss'] ?? '').replace(/\/+$/, '') !== state.issuer) throw fail(`the access token's iss is ${JSON.stringify(jwt.payload['iss'])}, it must be ${state.issuer}`);
    if (typeof jwt.payload['exp'] !== 'number' || jwt.payload['exp'] * 1000 <= Date.now()) throw fail('the access token has no future exp');
    if (jwt.header['alg'] !== 'ES256') throw fail(`the access token is signed with ${JSON.stringify(jwt.header['alg'])}, Ludy signs with ES256`);
    const jwks = await request(state.as.jwks_uri);
    if (!verifyEs256(jwt, /** @type {any} */ (jwks.json ?? {}))) throw fail('the access token signature does not verify against the keys at jwks_uri');
    state.accessToken = tokens.access_token;
    state.grantedScopes = String(jwt.payload['scope'] ?? '').split(' ');
    return `PKCE and resource accepted; ES256 JWT for ${resource}, scopes ${state.grantedScopes.join(' ')}`;
  });

  /** @param {string} resumeUrl @param {CookieJar} jar */
  async function followResume(resumeUrl, jar) {
    let url = resumeUrl;
    for (let hop = 0; hop < 8; hop++) {
      const res = await request(url, { jar });
      const location = res.headers.get('location');
      if (!(res.status >= 300 && res.status < 400 && location)) throw fail(`the consent did not lead back to the client (answered ${res.status} ${res.text.slice(0, 120)})`);
      const next = new URL(location, url);
      if (next.toString().startsWith(REDIRECT_URI)) {
        const error = next.searchParams.get('error');
        if (error) throw fail(`the authorization after consent ended in error ${error}`);
        const code = next.searchParams.get('code');
        if (!code) throw fail('the redirect to the client carries no code');
        return { kind: 'code', code, state: next.searchParams.get('state'), iss: next.searchParams.get('iss') };
      }
      if (next.origin !== new URL(base).origin) throw fail(`the consent redirected to ${next.origin}, another origin than the instance; the tool does not follow it`);
      url = next.toString();
    }
    throw fail('the consent redirected more than 8 times');
  }

  // --- the endpoint ----------------------------------------------------------------------------------------------------------------------
  /** @param {string} method @param {Record<string, unknown>} [params] */
  async function rpc(method, params) {
    const res = await request(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${state.accessToken}`, 'mcp-protocol-version': PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, ...(params ? { params } : {}) }),
    });
    let body;
    try {
      body = parseMcpBody(res.text, res.headers.get('content-type') ?? '');
    } catch {
      throw fail(`${method} answered ${res.status} with a body that is not JSON-RPC`);
    }
    return { status: res.status, body };
  }

  await check('mcp.tools', ['oauth.flow'], async () => {
    const init = await request(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${state.accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ludy-mcp-conformance', version: '1' } } }),
    });
    /** @type {any} */
    let initDoc = null;
    try {
      initDoc = parseMcpBody(init.text, init.headers.get('content-type') ?? '');
    } catch {
      // answered below
    }
    if (init.status !== 200 || !initDoc?.result?.protocolVersion) throw fail(`initialize with the token answered ${init.status} ${init.text.slice(0, 160)}`);
    const listed = await rpc('tools/list');
    const tools = /** @type {any} */ (listed.body)?.result?.tools;
    if (listed.status !== 200 || !Array.isArray(tools) || tools.length === 0) throw fail(`tools/list answered ${listed.status} with no tools`);
    state.tools = tools;
    return `${tools.length} tools listed`;
  });

  await check('tools.hints-present', ['mcp.tools'], async () => {
    const { present } = hintProblems(state.tools);
    if (present.length > 0) throw fail(`${present.length} problem${present.length === 1 ? '' : 's'}: ${present.slice(0, 5).join('; ')}${present.length > 5 ? '; ...' : ''}`);
    return `all ${state.tools.length} tools declare readOnlyHint and destructiveHint`;
  });

  await check('tools.hints-match-tier', ['mcp.tools'], async () => {
    const { tier } = hintProblems(state.tools);
    if (tier.length > 0) throw fail(tier.slice(0, 5).join('; '));
    const proposals = state.tools.filter((/** @type {any} */ t) => isProposalShaped(t.outputSchema)).length;
    const reads = state.tools.filter((/** @type {any} */ t) => t.annotations?.readOnlyHint === true).length;
    return `${reads} read only, ${proposals} proposal tools (neither read only nor destructive), ${state.tools.length - reads - proposals} direct writes; a proposal tool is read from its answer shape, since no tier travels on the wire`;
  });

  await check('proposals.no-execution', ['mcp.tools'], async () => {
    /** @type {any[]} */
    const candidates = state.tools.filter((/** @type {any} */ t) => (options.proposalTool ? t.name === options.proposalTool : isProposalShaped(t.outputSchema)));
    if (candidates.length === 0) {
      if (options.proposalTool) throw fail(`--proposal-tool ${options.proposalTool} is not in the tool list`);
      throw skip(`no proposal tool is listed for this grant (the ${WRITE_SCOPE} scope must be granted: it was ${state.grantedScopes?.includes(WRITE_SCOPE) ? 'granted' : 'not granted by this instance or account'})`);
    }
    const refusals = [];
    for (const tool of candidates.slice(0, 5)) {
      const args = options.proposalArgs ?? /** @type {Record<string, unknown>} */ (sampleOf(tool.inputSchema));
      const called = await rpc('tools/call', { name: tool.name, arguments: args });
      const body = /** @type {any} */ (called.body);
      if (body?.error || body?.result?.isError) {
        refusals.push(`${tool.name}: ${String(body?.error?.message ?? body?.result?.content?.[0]?.text ?? 'refused').slice(0, 100)}`);
        continue;
      }
      const out = body?.result?.structuredContent;
      if (out && out.status === 'pending' && typeof out.proposalId === 'string') {
        return `${tool.name} left proposal ${out.proposalId} pending (reject it in Inbox: it is the check's own)`;
      }
      throw fail(`${tool.name} is an R2 or R3 tool but answered ${JSON.stringify(out ?? body?.result?.content ?? null).slice(0, 160)} instead of { proposalId, status: "pending" }: a grant must never execute it (ADR-0051 decision 10)`);
    }
    throw fail(`no proposal tool took the sample arguments, so the rule could not be shown (${refusals.join('; ')}); pass --proposal-tool and --proposal-args`);
  });

  await check('pairing.code', [], async () => {
    throw skip('the pairing-code path is not checked yet: it waits for the pairing code of #4591; this check will run once that lands');
  });

  // --- the wake-up webhook ---------------------------------------------------------------------------------------------------------------
  await check('wake.vectors', [], async () => {
    const at = Number(VECTORS.timestamp) * 1000;
    const headers = (/** @type {string} */ signature) => ({ 'ludy-timestamp': VECTORS.timestamp, 'ludy-signature': signature });
    if (!verifyWake(VECTORS.signer, headers(VECTORS.ping.signature), VECTORS.ping.body, at)) throw fail('the sample verifier refused the runbook\'s ping vector');
    if (!verifyWake(VECTORS.signer, headers(VECTORS.schedule.signature), VECTORS.schedule.body, at)) throw fail('the sample verifier refused the runbook\'s schedule.due vector');
    if (!verifyWake(VECTORS.signer, headers(VECTORS.rotation), VECTORS.ping.body, at)) throw fail('the sample verifier refused the runbook\'s two-signature (rotation) vector');
    const flipped = `${VECTORS.ping.signature.slice(0, -1)}${VECTORS.ping.signature.endsWith('0') ? '1' : '0'}`;
    if (verifyWake(VECTORS.signer, headers(flipped), VECTORS.ping.body, at)) throw fail('the sample verifier accepted a signature with one digit changed');
    if (verifyWake(VECTORS.signer, headers(VECTORS.ping.signature), `${VECTORS.ping.body} `, at)) throw fail('the sample verifier accepted a body with one space added');
    if (verifyWake(VECTORS.signer, headers(signWake(VECTORS.signer, VECTORS.timestamp, VECTORS.ping.body)), VECTORS.ping.body, at + 301_000)) throw fail('the sample verifier accepted a timestamp 301 seconds old');
    return 'the runbook test vectors verify, a changed digit, a changed body and a stale timestamp are refused';
  });

  const wakeNames = CHECK_NAMES.filter((n) => n.startsWith('wake.') && n !== 'wake.vectors');
  if (wakeNames.some(wanted)) {
    const own = options.wakeUrl === undefined;
    const secret = options.wakeSecret ?? `whsec_${randomBytes(32).toString('hex')}`;
    const receiver = own ? createReceiver(secret, { flaws: options.receiverFlaws ?? [] }) : null;
    try {
      if (!own && options.wakeSecret === undefined) {
        for (const name of wakeNames) if (wanted(name)) push({ name, status: 'skip', message: 'the secret of your receiver is needed: set MCP_CONFORMANCE_WAKE_SECRET (the whsec_ value) beside --wake-url' });
      } else {
        const url = options.wakeUrl ?? (await /** @type {NonNullable<typeof receiver>} */ (receiver).listen());
        const { verdicts, repeatedId } = await sendSamples(url, secret);
        for (const v of verdicts) {
          if (!wanted(v.name)) continue;
          let { ok, message } = v;
          if (own && v.name === 'wake.repeated-event-id' && ok) {
            const handled = /** @type {NonNullable<typeof receiver>} */ (receiver).processed.filter((id) => id === repeatedId).length;
            if (handled !== 1) {
              ok = false;
              message = `the same event id was handled ${handled} times, it must be handled once`;
            }
          }
          push({ name: v.name, status: ok ? 'pass' : 'fail', message: own ? `sample receiver: ${message}` : message });
        }
      }
    } finally {
      await receiver?.close();
    }
  }
  return results;
}

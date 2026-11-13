// SPDX-License-Identifier: AGPL-3.0-only
// The MCP wire protocol of the endpoint, as pure functions (ADR-0051 decision 2, issue #2975): stateless JSON-RPC over Streamable HTTP, answering the
// revision 2026-07-28 (no handshake, a version and a method header on every request, `server/discover`) and, from the same handler and without any
// session, the 2025-06-18 and 2025-11-25 clients that still open with `initialize`. Read from the specification repository
// (modelcontextprotocol/modelcontextprotocol, docs/specification/2026-07-28/basic/transports/streamable-http.mdx and basic/versioning.mdx).
//
// No server-initiated message, no GET stream, no session id: a request is answered in its own response. A tool is a descriptor over one existing
// query of the kernel; this file knows nothing of the database.
import { z } from 'zod';

export const MODERN_VERSION = '2026-07-28';
// Newest first. A client that asks for another version of `initialize` is answered with the newest legacy one, as the specification has it.
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS] as const;

export const SERVER_NAME = 'ludy';

// JSON-RPC error codes: the standard ones and the protocol's own (HeaderMismatch -32020, UnsupportedProtocolVersion -32022).
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL = -32603;
export const RPC_HEADER_MISMATCH = -32020;
export const RPC_UNSUPPORTED_VERSION = -32022;

type RpcId = string | number | null;

const zRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1).max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  // The MCP annotations mirror the risk tier of the query behind the tool: every tool of this step reads only.
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
  // What the tool accepts, checked here before anything runs: strict (an unknown key is refused), so a client cannot smuggle a field a query does not declare.
  argsSchema: z.ZodType<Record<string, unknown>>;
  // The kernel query it runs and what it answers; the endpoint runs it as the grant, never as the person's own click.
  read: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  // How many rows of business data an answer carries, charged against the grant's daily row budget. Zero for a tool that reads none.
  rows: (value: Record<string, unknown>) => number;
}

export interface McpHeaders {
  protocolVersion: string | null;
  method: string | null;
  name: string | null;
}

export type McpReply =
  | { kind: 'json'; status: number; body: unknown }
  // A notification or a response from the client: accepted, no body (the transport's 202).
  | { kind: 'accepted' };

const rpcError = (id: RpcId, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0' as const, id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: '2.0' as const, id, result });

function metaOf(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta = params?._meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

export function toolList(tools: readonly ToolDescriptor[]): Array<Record<string, unknown>> {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map(({ read: _read, rows: _rows, argsSchema: _argsSchema, ...descriptor }) => descriptor);
}

// What a tool answers: structured content and a short text form of it, for clients that read only text.
function toolResult(modern: boolean, value: Record<string, unknown>) {
  return { ...(modern ? { resultType: 'complete' } : {}), content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

export interface HandleInput {
  body: unknown;
  headers: McpHeaders;
  tools: readonly ToolDescriptor[];
  serverVersion: string;
  // Runs one tool call after the endpoint's own checks; throws what the kernel throws.
  callTool: (tool: ToolDescriptor, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  // Describes an error thrown while running a tool as a JSON-RPC error body (never the thrown message of an unexpected error).
  describeError: (error: unknown) => { code: number; message: string };
}

// One request, as the 2026-07-28 transport and the two legacy revisions it still serves allow. A batch (a JSON array) is not supported by any of
// them anymore and is refused whole.
export async function handleMcp(input: HandleInput): Promise<McpReply> {
  const { body, headers } = input;
  if (Array.isArray(body)) return { kind: 'json', status: 400, body: rpcError(null, RPC_INVALID_REQUEST, 'Batch requests are not supported') };
  const parsed = zRequest.safeParse(body);
  if (!parsed.success) {
    // A response from the client (it has a result or an error and no method) or a malformed message.
    const isResponse = body !== null && typeof body === 'object' && !('method' in (body as object)) && ('result' in (body as object) || 'error' in (body as object));
    if (isResponse) return { kind: 'accepted' };
    return { kind: 'json', status: 400, body: rpcError(null, RPC_INVALID_REQUEST, 'Invalid request') };
  }
  const request = parsed.data;
  const isNotification = request.id === undefined;
  const id: RpcId = request.id ?? null;
  const method = request.method;

  // `initialize` is the one request of a legacy client that carries no version header; it is also all a legacy client sends before it learns ours.
  if (method === 'initialize') {
    const requested = typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '';
    const version = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];
    return {
      kind: 'json',
      status: 200,
      body: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: input.serverVersion },
        instructions: 'Ludy, the business OS for small companies. This connection reads only: it has no tool that changes anything.',
      }),
    };
  }

  // Every other request names its version in the header.
  const version = headers.protocolVersion;
  if (version === null || version === '') {
    return { kind: 'json', status: 400, body: rpcError(id, RPC_HEADER_MISMATCH, 'Missing MCP-Protocol-Version header') };
  }
  if (!(SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
    return { kind: 'json', status: 400, body: rpcError(id, RPC_UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested: version }) };
  }
  const modern = version === MODERN_VERSION;

  if (modern) {
    // The header and the body must agree (a mismatch is a 400 HeaderMismatch), and the method header is required on every request.
    const meta = metaOf(request.params);
    const bodyVersion = meta['io.modelcontextprotocol/protocolVersion'];
    if (bodyVersion !== version) return { kind: 'json', status: 400, body: rpcError(id, RPC_HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version does not match the version in _meta') };
    if (headers.method !== method) return { kind: 'json', status: 400, body: rpcError(id, RPC_HEADER_MISMATCH, 'Header mismatch: Mcp-Method does not match the request method') };
    if (method === 'tools/call') {
      const name = typeof request.params?.name === 'string' ? request.params.name : null;
      if (headers.name !== name) return { kind: 'json', status: 400, body: rpcError(id, RPC_HEADER_MISMATCH, 'Header mismatch: Mcp-Name does not match the tool name') };
    }
  }

  // A notification of any kind is accepted and ignored (there is nothing to notify).
  if (isNotification) return { kind: 'accepted' };

  switch (method) {
    case 'ping':
      return { kind: 'json', status: 200, body: rpcResult(id, {}) };
    case 'server/discover':
      if (!modern) break;
      return {
        kind: 'json',
        status: 200,
        body: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: input.serverVersion } },
          instructions: 'Ludy, the business OS for small companies. This connection reads only: it has no tool that changes anything.',
          ttlMs: 3_600_000,
          cacheScope: 'public',
        }),
      };
    case 'tools/list':
      // The same list for every connection of a grant: it never varies per connection. Cached for a minute.
      return { kind: 'json', status: 200, body: rpcResult(id, { ...(modern ? { resultType: 'complete', ttlMs: 60_000, cacheScope: 'private' } : {}), tools: toolList(input.tools) }) };
    case 'tools/call': {
      const name = typeof request.params?.name === 'string' ? request.params.name : null;
      const tool = input.tools.find((t) => t.name === name);
      if (!tool) return { kind: 'json', status: 200, body: rpcError(id, RPC_INVALID_PARAMS, 'Unknown tool') };
      const raw = request.params?.arguments === undefined ? {} : request.params.arguments;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { kind: 'json', status: 200, body: rpcError(id, RPC_INVALID_PARAMS, 'Arguments must be an object') };
      }
      const parsed = tool.argsSchema.safeParse(raw);
      if (!parsed.success) {
        // The names of the fields that are wrong, never their values; a key the schema does not have is not named either (it is the client's text).
        const fields = [...new Set(parsed.error.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' ? ['(unknown field)'] : [issue.path.join('.') || '(arguments)'])))];
        return { kind: 'json', status: 200, body: rpcError(id, RPC_INVALID_PARAMS, `Invalid arguments: ${fields.slice(0, 10).join(', ')}`) };
      }
      try {
        return { kind: 'json', status: 200, body: rpcResult(id, toolResult(modern, await input.callTool(tool, parsed.data))) };
      } catch (error) {
        const described = input.describeError(error);
        return { kind: 'json', status: 200, body: rpcError(id, described.code, described.message) };
      }
    }
    default:
      break;
  }
  // The specification has a modern server answer an unknown method with 404 and -32601; a legacy client gets the plain JSON-RPC error.
  return { kind: 'json', status: modern ? 404 : 200, body: rpcError(id, RPC_METHOD_NOT_FOUND, 'Method not found') };
}

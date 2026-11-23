// SPDX-License-Identifier: AGPL-3.0-only
// A fake OpenAI-compatible model for the AI end-to-end stack (#3805, compose.ai.yml). Its answers are fixed, so a test knows what Vy wrote, and it makes no request of its own: it never reaches another host,
// and a request for any other host name is refused. A chat completion gets the answer of the member-Vy feature its instruction names (fixtures.ts: title, commitments, agenda adherence, digest, brief; #4050),
// and any other request the meeting summary for the three-line transcript e2e/tests-ai inserts (the app's own checks still run on every answer: every number a summary names is in the transcript, and the
// item's second falls inside a line). Runs as `node main.ts` in a container; types are erasable.
import { createServer, type Server } from 'node:http';
import { answerFor, routeOf, scenarioOf, subjectOf } from './fixtures.ts';

// What Vy "wrote" for the transcript the spec stores: lines at 0 to 10, 10 to 20 and 20 to 30 seconds.
export const FIXED_SUMMARY = {
  summary: 'Cuộc họp bàn việc báo giá cho khách A. Hai bên thống nhất giữ giá cũ.',
  decisions: ['Giữ giá cũ cho khách A'],
  items: [{ title: 'Gửi báo giá cho khách A', who: 'Nam', when: 'thứ sáu', seconds: 10 }],
};

// The names the service answers to inside the compose network and on the machine running it; any other Host header is not for this service.
const HOSTS = new Set(['fake-model', 'localhost', '127.0.0.1']);
const BODY_LIMIT = 1_000_000;

// The text of the messages of one role: a message's content is a string, or a list of parts of which the text ones count.
function textOf(messages: unknown, role: string): string {
  if (!Array.isArray(messages)) return '';
  const out: string[] = [];
  for (const message of messages as unknown[]) {
    if (typeof message !== 'object' || message === null || (message as { role?: unknown }).role !== role) continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') out.push(content);
    else if (Array.isArray(content)) for (const part of content as unknown[]) if (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string') out.push((part as { text: string }).text);
  }
  return out.join('\n');
}

export interface FakeModel {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startFakeModel(options: { port: number; host: string }): Promise<FakeModel> {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const name = (req.headers.host ?? '').split(':')[0] ?? '';
    if (!HOSTS.has(name)) return send(421, { error: 'not this host' });
    if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: 'not found' });
    // The cap counts BYTES (a Buffer chunk's length), not characters: a body of multi-byte text must not slip past it.
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let model = 'fake-summary';
      let content = JSON.stringify(FIXED_SUMMARY);
      try {
        const parsed = JSON.parse(raw) as { model?: unknown; messages?: unknown };
        if (typeof parsed.model === 'string') model = parsed.model;
        const route = routeOf(textOf(parsed.messages, 'system'));
        if (route !== null) {
          const subject = subjectOf(textOf(parsed.messages, 'user'));
          const answer = answerFor(route, subject, scenarioOf(subject));
          // A failed request: the service is down for this run.
          if (answer === null) return send(500, { error: 'fake model down' });
          content = answer;
        }
      } catch {
        return send(400, { error: 'body is not JSON' });
      }
      send(200, {
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: 1_800_000_000,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return { server, url: `http://${options.host}:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// SPDX-License-Identifier: AGPL-3.0-only
// A fake OpenAI-compatible model for the AI end-to-end stack (#3805, compose.ai.yml). It answers every chat completion with the same fixed text, so a test knows what Vy wrote, and it makes no
// request of its own: it never reaches another host, and a request for any other host name is refused. The answer is a meeting summary for the three-line transcript e2e/tests-ai inserts
// (the app's own checks still run on it: every number it names is in the transcript, and the item's second falls inside a line). Runs as `node main.ts` in a container; types are erasable.
import { createServer, type Server } from 'node:http';

// What Vy "wrote" for the transcript the spec stores: lines at 0 to 10, 10 to 20 and 20 to 30 seconds.
export const FIXED_SUMMARY = {
  summary: 'Cuộc họp bàn việc báo giá cho khách A. Hai bên thống nhất giữ giá cũ.',
  decisions: ['Giữ giá cũ cho khách A'],
  items: [{ title: 'Gửi báo giá cho khách A', who: 'Nam', when: 'thứ sáu', seconds: 10 }],
};

// The names the service answers to inside the compose network and on the machine running it; any other Host header is not for this service.
const HOSTS = new Set(['fake-model', 'localhost', '127.0.0.1']);
const BODY_LIMIT = 1_000_000;

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
    let size = 0;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      size += chunk.length;
      if (size > BODY_LIMIT) req.destroy();
      else raw += chunk;
    });
    req.on('end', () => {
      let model = 'fake-summary';
      try {
        const parsed = JSON.parse(raw) as { model?: unknown };
        if (typeof parsed.model === 'string') model = parsed.model;
      } catch {
        return send(400, { error: 'body is not JSON' });
      }
      send(200, {
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: 1_800_000_000,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(FIXED_SUMMARY) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return { server, url: `http://${options.host}:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

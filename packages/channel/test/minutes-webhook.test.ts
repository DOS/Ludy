// SPDX-License-Identifier: AGPL-3.0-only
// The Slack and Teams webhook adapter for approved minutes (Meetings B4, #3168): which addresses are accepted, what is sent (nothing in the minutes can ping a channel or render as a link the recorder did not
// read), how each answer is classified (sent, failed, or ambiguous and so never repeated without a tick), and that no result or error carries the address.
import { describe, expect, it } from 'vitest';
import { minutesLines, parseMinutesUrl, postMinutes, slackMinutesBody, teamsMinutesBody, type MinutesMessage } from '../src/minutes-webhook.ts';

// Built from pieces so the repository holds no string shaped like a Slack webhook address (secret scanners flag one, real or not).
const SVC = ['services', 'T0000000A', 'B0000000B', 'abcdefghijklmnopqrstuvwx'].join('/');
const SLACK = `https://hooks.slack.com/${SVC}`;
const TEAMS = 'https://prod-12.southeastasia.logic.azure.com:443/workflows/0123456789abcdef/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=SECRETSIGNATURE';
const POWER = 'https://abc123.12.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sig=SECRETSIGNATURE';

const message: MinutesMessage = {
  lang: 'vi',
  title: 'Họp giao ban',
  day: '2026-11-13',
  summary: 'Chốt báo giá.',
  decisions: ['Giữ giá cũ'],
  items: [{ title: 'Gửi báo giá', who: 'An', when: 'thứ sáu' }],
};

describe('the address of a webhook', () => {
  it('accepts a Slack Incoming Webhook and a Teams Workflows address, and says only the host', () => {
    expect(parseMinutesUrl('slack', SLACK)).toEqual({ kind: 'slack', url: SLACK, host: 'hooks.slack.com' });
    const teams = parseMinutesUrl('teams', TEAMS);
    expect(teams?.host).toBe('prod-12.southeastasia.logic.azure.com');
    expect(teams?.url).not.toContain(':443');
    expect(parseMinutesUrl('teams', POWER)?.host).toBe('abc123.12.environment.api.powerplatform.com');
    expect(parseMinutesUrl('slack', `  ${SLACK}  `)?.host).toBe('hooks.slack.com');
  });

  it.each([
    ['slack', `http://hooks.slack.com/${SVC}`],
    ['slack', `https://hooks.slack.com.evil.example/${SVC}`],
    ['slack', `https://evil.example/${SVC}`],
    ['slack', `https://user:pass@hooks.slack.com/${SVC}`],
    ['slack', `https://hooks.slack.com:8443/${SVC}`],
    ['slack', `https://hooks.slack.com/${SVC}?x=1`],
    ['slack', 'https://hooks.slack.com/triggers/E0000/1234/abcdef'],
    ['slack', `https://hooks.slack.com/${SVC}#frag`],
    ['slack', TEAMS],
    ['teams', SLACK],
    ['teams', 'https://logic.azure.com/workflows/0123456789abcdef/triggers/manual/paths/invoke'],
    ['teams', 'https://evil.logic.azure.com.attacker.example/workflows/0123456789abcdef/triggers/manual/paths/invoke'],
    ['teams', 'https://prod-12.southeastasia.logic.azure.com/other/path'],
    ['teams', 'http://prod-12.southeastasia.logic.azure.com/workflows/0123456789abcdef/triggers/manual/paths/invoke'],
    ['teams', 'not a url'],
    ['teams', ''],
  ] as const)('refuses %s %s', (kind, raw) => {
    expect(parseMinutesUrl(kind, raw)).toBeNull();
  });
});

describe('what is sent', () => {
  it('sends Slack plain text, mrkdwn off, nothing unfurled, with the link as a plain address', () => {
    const body = JSON.parse(slackMinutesBody(message, 'https://app.test/o/x/meetings/1')) as { text: string; mrkdwn: boolean; unfurl_links: boolean; unfurl_media: boolean };
    expect(body).toMatchObject({ mrkdwn: false, unfurl_links: false, unfurl_media: false });
    expect(body.text).toBe(minutesLines(message, 'https://app.test/o/x/meetings/1').join('\n'));
    expect(body.text.split('\n').slice(0, 2)).toEqual(['Họp giao ban', '13/11/2026']);
    expect(body.text).toContain('• Gửi báo giá (An, thứ sáu)');
    expect(body.text).toContain('Xem cuộc họp: https://app.test/o/x/meetings/1');
  });

  it('cannot ping anyone in Slack: angle brackets and ampersands are escaped', () => {
    const hostile: MinutesMessage = { ...message, title: '<!channel> & <@U123|boss>', summary: '<!here> xem <https://evil.example|bấm đây>', decisions: ['<!subteam^S1>'] };
    const { text } = JSON.parse(slackMinutesBody(hostile, null)) as { text: string };
    expect(text).not.toMatch(/<[!@#h]/);
    expect(text).toContain('&lt;!channel&gt; &amp; &lt;@U123|boss&gt;');
  });

  it('sends a Teams Adaptive Card in a message, escaping markdown so nothing renders as a link or emphasis', () => {
    const hostile: MinutesMessage = { ...message, summary: '[bấm đây](https://evil.example) và **đậm** và <at>x</at>' };
    const card = JSON.parse(teamsMinutesBody(hostile, 'https://app.test/o/x/meetings/1')) as {
      type: string;
      attachments: Array<{ contentType: string; content: { type: string; version: string; body: Array<{ text: string }>; actions: Array<{ type: string; url: string }> } }>;
    };
    expect(card.type).toBe('message');
    const content = card.attachments[0]?.content;
    expect(card.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(content?.type).toBe('AdaptiveCard');
    const summary = content?.body.find((b) => b.text.includes('bấm đây'))?.text ?? '';
    expect(summary).toBe('\\[bấm đây\\]\\(https://evil.example\\) và \\*\\*đậm\\*\\* và \\<at\\>x\\</at\\>');
    expect(content?.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Mở cuộc họp', url: 'https://app.test/o/x/meetings/1' }]);
    expect(JSON.parse(teamsMinutesBody(message, null)).attachments[0].content.actions).toBeUndefined();
  });

  it('writes English labels for an English meeting', () => {
    const en = minutesLines({ ...message, lang: 'en' }, null).join('\n');
    expect(en).toContain('Summary');
    expect(en).toContain('Decisions');
    expect(en).toContain('Action items');
    expect(en.split('\n')[1]).toBe('2026-11-13');
  });
});

describe('how an answer is classified', () => {
  const answer = (status: number, headers: Record<string, string> = {}) => async () => new Response('ok', { status, headers });
  const guard = (code: string) => async () => {
    throw Object.assign(new Error('x'), { name: 'EgressError', code });
  };

  it('is sent on 200 (Slack) and 202 (Teams)', async () => {
    expect(await postMinutes('slack', SLACK, message, null, answer(200))).toEqual({ state: 'sent', httpStatus: 200, code: null, retryAfterSeconds: null });
    expect(await postMinutes('teams', TEAMS, message, null, answer(202))).toMatchObject({ state: 'sent', httpStatus: 202 });
  });

  it('is failed, and nothing may have gone out, for a refusal, a missing channel and a rate limit (with the seconds)', async () => {
    expect(await postMinutes('slack', SLACK, message, null, answer(404))).toMatchObject({ state: 'failed', code: 'CHANNEL_GONE' });
    expect(await postMinutes('slack', SLACK, message, null, answer(410))).toMatchObject({ state: 'failed', code: 'CHANNEL_GONE' });
    expect(await postMinutes('slack', SLACK, message, null, answer(403))).toMatchObject({ state: 'failed', code: 'CHANNEL_REFUSED' });
    expect(await postMinutes('slack', SLACK, message, null, answer(400))).toMatchObject({ state: 'failed', code: 'CHANNEL_REJECTED' });
    expect(await postMinutes('slack', SLACK, message, null, answer(302, { location: 'https://evil.example' }))).toMatchObject({ state: 'failed', code: 'CHANNEL_REDIRECTED' });
    expect(await postMinutes('slack', SLACK, message, null, answer(429, { 'retry-after': '7' }))).toMatchObject({ state: 'failed', code: 'CHANNEL_RATE_LIMITED', retryAfterSeconds: 7 });
    expect(await postMinutes('slack', SLACK, message, null, answer(429))).toMatchObject({ retryAfterSeconds: 30 });
    expect(await postMinutes('slack', SLACK, message, null, answer(429, { 'retry-after': '99999' }))).toMatchObject({ retryAfterSeconds: 3600 });
  });

  it('is failed when the guard refused before a request left, and ambiguous when one may have been delivered', async () => {
    for (const code of ['invalid_url', 'blocked', 'dns']) expect(await postMinutes('slack', SLACK, message, null, guard(code))).toMatchObject({ state: 'failed', code: 'CHANNEL_UNREACHABLE' });
    expect(await postMinutes('slack', SLACK, message, null, guard('timeout'))).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_TIMEOUT' });
    for (const code of ['network', 'too_large', 'encoding']) expect(await postMinutes('slack', SLACK, message, null, guard(code))).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_NO_ANSWER' });
    expect(await postMinutes('slack', SLACK, message, null, async () => { throw new Error('boom'); })).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_NO_ANSWER' });
    expect(await postMinutes('slack', SLACK, message, null, answer(500))).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_SERVER_ERROR' });
    expect(await postMinutes('slack', SLACK, message, null, answer(503))).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_SERVER_ERROR' });
  });

  it('checks the address again and makes no request for one that is not the service\'s own', async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return new Response('ok');
    };
    expect(await postMinutes('slack', `https://evil.example/${SVC}`, message, null, counting)).toMatchObject({ state: 'failed', code: 'CHANNEL_ADDRESS_INVALID' });
    expect(await postMinutes('teams', SLACK, message, null, counting)).toMatchObject({ state: 'failed', code: 'CHANNEL_ADDRESS_INVALID' });
    expect(calls).toBe(0);
  });

  it('refuses a Teams card past the size limit before any request, and still posts a long Slack text', async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return new Response('ok', { status: 200 });
    };
    // Letters of three bytes in UTF-8 and escapes make a card heavier than its characters.
    const heavy: MinutesMessage = { ...message, summary: '界'.repeat(8000), decisions: Array.from({ length: 30 }, () => '界-(*)_'.repeat(60)) };
    expect(await postMinutes('teams', TEAMS, heavy, null, counting)).toMatchObject({ state: 'failed', code: 'CHANNEL_MESSAGE_TOO_LARGE' });
    expect(calls).toBe(0);
    expect(await postMinutes('slack', SLACK, heavy, null, counting)).toMatchObject({ state: 'sent' });
    expect(calls).toBe(1);
  });

  it('carries the address in no result and posts to it once, as JSON', async () => {
    const seen: Array<{ url: string; method: string | undefined; type: string | null }> = [];
    const results = [
      await postMinutes('slack', SLACK, message, null, async (input, init) => {
        seen.push({ url: input, method: init?.method, type: new Headers(init?.headers).get('content-type') });
        return new Response('ok');
      }),
      await postMinutes('teams', TEAMS, message, null, guard('timeout')),
      await postMinutes('teams', POWER, message, null, answer(500)),
    ];
    expect(seen).toEqual([{ url: SLACK, method: 'POST', type: 'application/json; charset=utf-8' }]);
    expect(JSON.stringify(results)).not.toMatch(/abcdefghijklmnopqrstuvwx|SECRETSIGNATURE|T0000000A|logic\.azure|hooks\.slack/);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): AWS SNS webhook verification security invariants for Amazon SES (#4960).
// Self-contained: imports only vitest, node:crypto, and the SES module under test.
import { createSign, generateKeyPairSync, randomBytes, X509Certificate, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSesProvider, parseSesWebhook } from '../../src/ses.ts';
import { WebhookRejected, type WebhookRequest } from '../../src/types.ts';

const REGION = 'ap-southeast-1';
const TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:ludy-pilot-ses-events`;
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem`;
const SUBSCRIBE_URL = `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=tok123`;
const NOW = Date.parse('2026-11-25T12:00:00Z');

// Minimal in-memory X.509 v3 DER certificate builder so invariant checks need no external fixtures or openssl.
function tlv(tag: number, value: Uint8Array): Buffer {
  const len = value.length;
  const header = len < 0x80 ? [len] : len < 0x100 ? [0x81, len] : [0x82, len >> 8, len & 0xff];
  return Buffer.concat([Buffer.from([tag, ...header]), value]);
}
const seq = (...items: Uint8Array[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Uint8Array[]) => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, value: Uint8Array) => tlv(0xa0 + n, value);
const bits = (value: Uint8Array) => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const nul = () => Buffer.from([0x05, 0x00]);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const generalizedTime = (date: Date) => tlv(0x18, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`, 'ascii'));
function integer(value: Uint8Array): Buffer {
  let bytes = Buffer.from(value);
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] as number) < 0x80) bytes = bytes.subarray(1);
  return tlv(0x02, (bytes[0] as number) >= 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function makeTestCert(options: { notBefore?: Date; notAfter?: Date; kind?: 'rsa' | 'ec' } = {}): { privateKey: KeyObject; pem: string } {
  const kind = options.kind ?? 'rsa';
  const { privateKey, publicKey } =
    kind === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = kind === 'ec' ? seq(oid('1.2.840.10045.4.3.2')) : seq(oid('1.2.840.113549.1.1.11'), nul());
  const subject = seq(set(seq(oid('2.5.4.3'), utf8('TEST ONLY SNS'))));
  const notBefore = options.notBefore ?? new Date(NOW - 3_600_000);
  const notAfter = options.notAfter ?? new Date(NOW + 3_600_000);
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    alg,
    subject,
    seq(generalizedTime(notBefore), generalizedTime(notAfter)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const sig = createSign('sha256').update(tbs).sign(privateKey);
  const der = seq(tbs, alg, bits(sig));
  const b64 = der.toString('base64').replace(/.{1,64}/g, '$&\n').trim();
  const pem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(pem);
  return { privateKey, pem };
}

const DEFAULT_CERT = makeTestCert();

function signSnsEnvelope(
  envelope: Record<string, unknown>,
  privateKey: KeyObject = DEFAULT_CERT.privateKey,
  version: '1' | '2' = '2',
): WebhookRequest {
  const type = String(envelope['Type']);
  const keys =
    type === 'Notification'
      ? ['Message', 'MessageId', ...(typeof envelope['Subject'] === 'string' ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const canonical = keys.map((k) => `${k}\n${String(envelope[k])}\n`).join('');
  const signature = createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1').update(canonical, 'utf8').sign(privateKey, 'base64');
  return {
    headers: { 'content-type': 'text/plain; charset=UTF-8' },
    body: JSON.stringify({ ...envelope, SignatureVersion: version, Signature: signature }),
  };
}

function makeNotification(
  message: unknown,
  overrides: Record<string, unknown> = {},
  privateKey: KeyObject = DEFAULT_CERT.privateKey,
  version: '1' | '2' = '2',
): WebhookRequest {
  return signSnsEnvelope(
    {
      Type: 'Notification',
      MessageId: 'sns-inv-1',
      TopicArn: TOPIC_ARN,
      Message: typeof message === 'string' ? message : JSON.stringify(message),
      Timestamp: new Date(NOW - 30_000).toISOString(),
      SigningCertURL: CERT_URL,
      ...overrides,
    },
    privateKey,
    version,
  );
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const resolved = String(url);
    const resolvedInit = init ?? {};
    calls.push({ url: resolved, init: resolvedInit });
    return handler(resolved, resolvedInit);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('SES security, SSRF, and SNS webhook verification invariants (#4960)', () => {
  it('enforces region, endpoint, configurationSet, ARN cross-checks, and MIME/PII safety invariants', async () => {
    for (const bad of ['', 'local', 'ap-southeast-1.evil.com', 'ap-southeast-1/foo', 'AP-SOUTHEAST-1', 'us_east_1']) {
      expect(() => createSesProvider({ region: bad, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com' }), bad).toThrow(/region/);
    }
    expect(() =>
      createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com', configurationSet: 'bad set!' }),
    ).toThrow(/configuration set/);
    expect(() =>
      createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com', snsTopicArn: 'arn:aws:s3:::bucket' }),
    ).toThrow(/ARN/);
    expect(createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com' }).parseWebhook).toBeUndefined();
    expect(() =>
      createSesProvider({
        region: REGION,
        accessKeyId: 'k',
        secretAccessKey: 's',
        from: 'noreply@example.com',
        snsTopicArn: 'arn:aws:sns:us-east-1:123456789012:topic',
      }),
    ).toThrow(/region/);

    // Endpoint confinement, header injection sanitization, and error PII scrubbing.
    const { calls, fetchImpl } = fakeFetch(() =>
      Response.json(
        { message: 'Recipient address rejected: khach@example.test', __type: 'MessageRejected' },
        { status: 400, headers: { 'x-amzn-errortype': 'MessageRejected' } },
      ),
    );
    const provider = createSesProvider({
      region: REGION,
      accessKeyId: 'AKIAEXAMPLE123456',
      secretAccessKey: 'secret-example-key',
      from: 'Ludy <noreply@mail.example.com>',
      snsTopicArn: TOPIC_ARN,
      fetch: fetchImpl,
      now: () => NOW,
    });
    const res = await provider.send({
      to: 'khach@example.test',
      subject: 'Hóa đơn',
      text: 'Nội dung',
      html: '<p>Nội dung</p>',
      fromName: 'Công ty "ABC"\r\nBcc: victim@example.test',
    });
    expect(res).toEqual({ status: 'rejected', error: 'invalid_recipient', code: 'SES_400_MessageRejected' });
    expect(JSON.stringify(res)).not.toContain('khach@example.test');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://email.${REGION}.amazonaws.com/v2/email/outbound-emails`);
    expect(calls[0]?.init.redirect).toBe('manual');
    const sentPayload = JSON.parse(String(calls[0]?.init.body)) as { FromEmailAddress: string; Content: { Raw: { Data: string } } };
    expect(sentPayload.FromEmailAddress).not.toContain('\n');
    expect(sentPayload.FromEmailAddress).not.toContain('Bcc:');
    const rawMime = Buffer.from(sentPayload.Content.Raw.Data, 'base64').toString('utf8');
    expect(rawMime).not.toMatch(/^Bcc:/im);

    // Webhook PII non-leakage on Delivery, Bounce, and Complaint payloads.
    const piiProvider = createSesProvider({
      region: REGION,
      accessKeyId: 'k',
      secretAccessKey: 's',
      from: 'noreply@example.com',
      snsTopicArn: TOPIC_ARN,
      fetch: fakeFetch(() => new Response(DEFAULT_CERT.pem, { status: 200 })).fetchImpl,
    });
    const piiPayloads = [
      {
        eventType: 'Delivery',
        mail: { messageId: 'm-del', destination: ['khach@example.test'] },
        delivery: { recipients: ['khach@example.test'], smtpResponse: '250 OK khach@example.test' },
      },
      {
        notificationType: 'Bounce',
        mail: { messageId: 'm-bnc' },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [{ emailAddress: 'khach@example.test', diagnosticCode: '550 5.1.1 khach@example.test' }],
        },
      },
      {
        notificationType: 'Complaint',
        mail: { messageId: 'm-cmp' },
        complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'khach@example.test' }] },
      },
    ];
    for (const payload of piiPayloads) {
      const events = await piiProvider.parseWebhook?.(makeNotification(payload), NOW);
      expect(JSON.stringify(events)).not.toContain('khach@example.test');
      expect(JSON.stringify(events)).not.toContain('250 OK');
      expect(JSON.stringify(events)).not.toContain('550 5.1.1');
    }
  });

  it('rejects TopicArn mismatches, bad SignatureVersion, stale timestamps, and SSRF SigningCertURLs before any fetch', async () => {
    const { calls, fetchImpl } = fakeFetch(() => new Response(DEFAULT_CERT.pem, { status: 200 }));
    const reasonOf = async (req: WebhookRequest, now = NOW) => {
      try {
        await parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fetchImpl }, req, now);
        return 'accepted';
      } catch (err) {
        return err instanceof WebhookRejected ? err.reason : 'other';
      }
    };

    expect(await reasonOf({ headers: {}, body: 'not-json' })).toBe('malformed');
    expect(await reasonOf({ headers: {}, body: JSON.stringify({ Type: 'UnknownType' }) })).toBe('malformed');
    expect(await reasonOf(makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, { TopicArn: `arn:aws:sns:${REGION}:123456789012:other` }))).toBe('signature');
    expect(await reasonOf(makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, {}, DEFAULT_CERT.privateKey, '3' as '2'))).toBe('signature');

    // Past messages up to 1h old remain valid (SNS retry window); > 1h past or > 5m future are stale.
    expect(await reasonOf(makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, { Timestamp: new Date(NOW - 30 * 60_000).toISOString() }))).toBe('accepted');
    expect(await reasonOf(makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, { Timestamp: new Date(NOW - 61 * 60_000).toISOString() }))).toBe('stale');
    expect(await reasonOf(makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, { Timestamp: new Date(NOW + 6 * 60_000).toISOString() }))).toBe('stale');
    calls.length = 0;

    const hex32 = '0123456789abcdef0123456789abcdef';
    const badCertUrls = [
      `http://sns.${REGION}.amazonaws.com/SimpleNotificationService-${hex32}.pem`,
      `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${hex32}.pem`,
      `https://evil.example.com/SimpleNotificationService-${hex32}.pem`,
      `https://sns.${REGION}.amazonaws.com:8443/SimpleNotificationService-${hex32}.pem`,
      `https://user:pass@sns.${REGION}.amazonaws.com/SimpleNotificationService-${hex32}.pem`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${hex32}.pem?x=1`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${hex32}.pem#frag`,
      `https://sns.${REGION}.amazonaws.com/foo/../SimpleNotificationService-${hex32}.pem`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-%2e%2e.pem`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${hex32}.pem\\evil`,
      `https://sns.${REGION}.amazonaws.com/other.pem`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-abc123.pem`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${'a'.repeat(129)}.pem`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${'Z'.repeat(32)}.pem`,
    ];
    for (const SigningCertURL of badCertUrls) {
      expect(await reasonOf(makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, { SigningCertURL })), SigningCertURL).toBe('signature');
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects tampered signatures, wrong keys, expired or non-RSA certs, oversized PEMs, and malformed payloads, and ignores prototype/unknown detail values', async () => {
    const otherCert = makeTestCert();
    const expiredCert = makeTestCert({ notBefore: new Date(NOW - 7_200_000), notAfter: new Date(NOW - 1_000) });
    const ecCert = makeTestCert({ kind: 'ec' });

    const validReq = makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } });
    const tamperedReq = { ...validReq, body: validReq.body.replace('m1', 'm2') };
    await expect(
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(DEFAULT_CERT.pem)).fetchImpl }, tamperedReq, NOW),
    ).rejects.toMatchObject({ reason: 'signature' });

    await expect(
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(otherCert.pem)).fetchImpl }, validReq, NOW),
    ).rejects.toMatchObject({ reason: 'signature' });

    await expect(
      parseSesWebhook(
        { region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(expiredCert.pem)).fetchImpl },
        makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, {}, expiredCert.privateKey),
        NOW,
      ),
    ).rejects.toMatchObject({ reason: 'signature' });

    await expect(
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(ecCert.pem)).fetchImpl }, validReq, NOW),
    ).rejects.toMatchObject({ reason: 'signature' });

    const oversized = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(33 * 1024).fill(65));
        controller.close();
      },
    });
    await expect(
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(oversized, { status: 200 })).fetchImpl }, validReq, NOW),
    ).rejects.toMatchObject({ reason: 'signature' });

    // Declared Content-Length over 32 KiB cancels the unconsumed response stream immediately.
    let declaredCancelled = false;
    const declaredBody = new ReadableStream({
      cancel() {
        declaredCancelled = true;
      },
    });
    await expect(
      parseSesWebhook(
        {
          region: REGION,
          snsTopicArn: TOPIC_ARN,
          fetch: fakeFetch(() => new Response(declaredBody, { status: 200, headers: { 'content-length': String(33 * 1024) } })).fetchImpl,
        },
        validReq,
        NOW,
      ),
    ).rejects.toMatchObject({ reason: 'signature' });
    expect(declaredCancelled).toBe(true);

    // Non-OK cert fetch responses cancel their unconsumed body streams cleanly.
    let nonOkCancelled = false;
    const nonOkBody = new ReadableStream({
      cancel() {
        nonOkCancelled = true;
      },
    });
    await expect(
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(nonOkBody, { status: 403 })).fetchImpl }, validReq, NOW),
    ).rejects.toMatchObject({ reason: 'signature' });
    expect(nonOkCancelled).toBe(true);

    const certFetch = fakeFetch(() => new Response(DEFAULT_CERT.pem)).fetchImpl;
    await expect(
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: certFetch }, makeNotification({ eventType: 'Delivery', mail: {} }), NOW),
    ).rejects.toMatchObject({ reason: 'malformed' });
    await expect(
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: certFetch }, makeNotification({ eventType: 'Delivery', mail: { messageId: 'x'.repeat(256) } }), NOW),
    ).rejects.toMatchObject({ reason: 'malformed' });

    // Prototype property names do not match RECORDED_EVENTS, and unrecognized detail values are omitted cleanly.
    for (const protoKey of ['__proto__', 'constructor', 'toString']) {
      expect(
        await parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: certFetch }, makeNotification({ eventType: protoKey, mail: { messageId: 'm1' } }), NOW),
      ).toEqual([]);
    }
    const weirdDetail = await parseSesWebhook(
      { region: REGION, snsTopicArn: TOPIC_ARN, fetch: certFetch },
      makeNotification({
        eventType: 'Bounce',
        mail: { messageId: 'm-weird' },
        bounce: { bounceType: 'UnexpectedType', bounceSubType: 'attacker@evil.test' },
      }),
      NOW,
    );
    expect(weirdDetail).toEqual([expect.objectContaining({ kind: 'bounce_soft', detail: {} })]);
  });

  it('coalesces concurrent cert fetches, rejects excess concurrent fetches as capacity (503), and negative-caches failed cert URLs', async () => {
    let releaseCert!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCert = resolve;
    });
    const { calls: sameUrlCalls, fetchImpl: sameUrlFetch } = fakeFetch(async () => {
      await gate;
      return new Response(DEFAULT_CERT.pem, { status: 200 });
    });
    const provider = createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com', snsTopicArn: TOPIC_ARN, fetch: sameUrlFetch });
    const note = makeNotification({ eventType: 'Send', mail: { messageId: 'm-burst' } });
    const burst = Promise.all(Array.from({ length: 8 }, () => provider.parseWebhook?.(note, NOW)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sameUrlCalls).toHaveLength(1);
    releaseCert();
    await burst;
    expect(sameUrlCalls).toHaveLength(1);

    // Distinct uncached cert URLs beyond the in-flight concurrency cap (4) fail with capacity (503) so AWS SNS retries.
    const pendingResolvers: Array<() => void> = [];
    const distinctFetch = fakeFetch(
      () =>
        new Promise<Response>((resolve) => {
          pendingResolvers.push(() => resolve(new Response(DEFAULT_CERT.pem, { status: 200 })));
        }),
    );
    const certUrl = (i: number) => `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${i.toString(16).padStart(32, '0')}.pem`;
    const distinctProvider = createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com', snsTopicArn: TOPIC_ARN, fetch: distinctFetch.fetchImpl });
    const inFlightReqs = Array.from({ length: 4 }, (_, i) => distinctProvider.parseWebhook?.(makeNotification({ eventType: 'Send' }, { SigningCertURL: certUrl(i + 1) }), NOW));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(distinctFetch.calls).toHaveLength(4);
    await expect(distinctProvider.parseWebhook?.(makeNotification({ eventType: 'Send' }, { SigningCertURL: certUrl(99) }), NOW)).rejects.toMatchObject({ reason: 'capacity' });
    expect(distinctFetch.calls).toHaveLength(4);
    for (const resolve of pendingResolvers) resolve();
    await Promise.all(inFlightReqs);

    // 4xx failed cert URLs are negative-cached briefly to avoid repeated fetches on probes.
    const badProbe = fakeFetch(() => new Response('missing', { status: 404 }));
    const negProvider = createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com', snsTopicArn: TOPIC_ARN, fetch: badProbe.fetchImpl });
    await expect(negProvider.parseWebhook?.(makeNotification({ eventType: 'Send' }), NOW)).rejects.toMatchObject({ reason: 'signature' });
    await expect(negProvider.parseWebhook?.(makeNotification({ eventType: 'Send' }), NOW + 1_000)).rejects.toMatchObject({ reason: 'signature' });
    expect(badProbe.calls).toHaveLength(1);
  });

  it('requires verified SubscriptionConfirmation SubscribeURL on exact / with matching Action, TopicArn, and Token, cancelling response bodies', async () => {
    let subCancelled = false;
    const { calls, fetchImpl } = fakeFetch((url) => {
      if (url === CERT_URL) return new Response(DEFAULT_CERT.pem, { status: 200 });
      if (url === SUBSCRIBE_URL) {
        return new Response(
          new ReadableStream({
            cancel() {
              subCancelled = true;
            },
          }),
          { status: 200 },
        );
      }
      return new Response('bad', { status: 400 });
    });
    const confirm = signSnsEnvelope({
      Type: 'SubscriptionConfirmation',
      MessageId: 'sub-1',
      TopicArn: TOPIC_ARN,
      Token: 'tok123',
      Message: 'You have chosen to subscribe...',
      SubscribeURL: SUBSCRIBE_URL,
      Timestamp: new Date(NOW).toISOString(),
      SigningCertURL: CERT_URL,
    });
    expect(await parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fetchImpl }, confirm, NOW)).toEqual([]);
    expect(subCancelled).toBe(true);
    expect(calls.map((c) => [c.url, c.init.redirect])).toEqual([
      [CERT_URL, 'manual'],
      [SUBSCRIBE_URL, 'manual'],
    ]);

    const badSubscribeUrls = [
      'https://169.254.169.254/latest/meta-data',
      `https://sns.${REGION}.amazonaws.com/unexpected-path?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=tok123`,
      `https://sns.${REGION}.amazonaws.com/?Action=ListTopics&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=tok123`,
      `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(`arn:aws:sns:${REGION}:123456789012:other`)}&Token=tok123`,
      `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=other-tok`,
    ];
    for (const SubscribeURL of badSubscribeUrls) {
      const badSub = signSnsEnvelope({
        Type: 'SubscriptionConfirmation',
        MessageId: 'sub-bad',
        TopicArn: TOPIC_ARN,
        Token: 'tok123',
        Message: 'You have chosen to subscribe...',
        SubscribeURL,
        Timestamp: new Date(NOW).toISOString(),
        SigningCertURL: CERT_URL,
      });
      const subFetch = fakeFetch((url) => (url === CERT_URL ? new Response(DEFAULT_CERT.pem) : new Response('should not fetch', { status: 200 })));
      await expect(parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: subFetch.fetchImpl }, badSub, NOW), SubscribeURL).rejects.toMatchObject({ reason: 'malformed' });
      expect(subFetch.calls.map((c) => c.url)).toEqual([CERT_URL]);
    }
  });
});

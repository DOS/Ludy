// SPDX-License-Identifier: AGPL-3.0-only
// Amazon SES v2 adapter and verified AWS SNS webhook (#4960): SigV4 signing, RFC 5322 MIME with attachments
// and header injection guards, SES error classification without PII leakage, SSRF-proof SNS certificate validation,
// RSA-SHA1/RSA-SHA256 signatures, SubscriptionConfirmation, and Event Publishing / legacy SES notifications.
import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes, X509Certificate, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSesProvider, parseSesWebhook, signSesRequest, WebhookRejected, type WebhookRequest } from '../src/index.ts';

const REGION = 'ap-southeast-1';
const TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:ludy-pilot-ses-events`;
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem`;
const SUBSCRIBE_URL = `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=tok123`;
const NOW = Date.parse('2026-11-25T12:00:00Z');
const MAIL = {
  to: 'khach@example.test',
  subject: 'Hóa đơn điện tử',
  text: 'Nội dung văn bản',
  html: '<p>Nội dung HTML</p>',
  messageId: '<0192f0aa-0000-7000-8000-000000000001@mail.example.com>',
};

// Minimal in-memory X.509 v3 DER certificate builder so tests generate fresh ephemeral RSA/EC certs without openssl.
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

function makeTestCert(options: { notBefore?: Date; notAfter?: Date; kind?: 'rsa' | 'ec' } = {}): { privateKey: KeyObject; pem: string; cert: X509Certificate } {
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
  return { privateKey, pem, cert: new X509Certificate(pem) };
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
      MessageId: 'sns-evt-1',
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

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const resolved = String(url);
    const resolvedInit = init ?? {};
    calls.push({ url: resolved, init: resolvedInit });
    return handler(resolved, resolvedInit);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('SES SigV4 signing & region guard', () => {
  it('computes canonical AWS4-HMAC-SHA256 signatures matching reference derivation', () => {
    const body = JSON.stringify({ FromEmailAddress: 'noreply@example.com', Content: { Raw: { Data: 'SGVsbG8=' } } });
    const headers = signSesRequest({
      region: 'ap-southeast-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      host: 'email.ap-southeast-1.amazonaws.com',
      path: '/v2/email/outbound-emails',
      body,
      now: Date.UTC(2026, 10, 25, 13, 5, 42),
    });
    const payloadHash = createHash('sha256').update(body, 'utf8').digest('hex');
    expect(headers['x-amz-date']).toBe('20261125T130542Z');
    expect(headers['x-amz-content-sha256']).toBe(payloadHash);
    expect(headers['host']).toBe('email.ap-southeast-1.amazonaws.com');
    expect(headers['content-type']).toBe('application/json');

    const canonicalRequest = [
      'POST',
      '/v2/email/outbound-emails',
      '',
      `content-type:application/json\nhost:email.ap-southeast-1.amazonaws.com\nx-amz-content-sha256:${payloadHash}\nx-amz-date:20261125T130542Z\n`,
      'content-type;host;x-amz-content-sha256;x-amz-date',
      payloadHash,
    ].join('\n');
    const scope = '20261125/ap-southeast-1/ses/aws4_request';
    const stringToSign = ['AWS4-HMAC-SHA256', '20261125T130542Z', scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');
    const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d, 'utf8').digest();
    const sig = hmac(hmac(hmac(hmac('AWS4wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', '20261125'), 'ap-southeast-1'), 'ses'), 'aws4_request');
    const expectedSig = hmac(sig, stringToSign).toString('hex');
    expect(headers['authorization']).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/${scope}, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${expectedSig}`,
    );
  });

  it('rejects malformed or host-injecting region values and invalid SNS topic ARNs', () => {
    for (const bad of ['', 'local', 'ap-southeast-1.evil.com', 'ap-southeast-1/foo', 'AP-SOUTHEAST-1', 'us_east_1']) {
      expect(() => createSesProvider({ region: bad, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com' }), bad).toThrow(/region/);
    }
    expect(() =>
      createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com', snsTopicArn: 'arn:aws:s3:::bucket' }),
    ).toThrow(/ARN/);
  });
});

describe('SES send & RFC 5322 raw MIME', () => {
  it('posts signed raw MIME to email.<region>.amazonaws.com with headers, threading, and attachments', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ MessageId: '010f019abc-123' }));
    const provider = createSesProvider({
      region: REGION,
      accessKeyId: 'AKIAEXAMPLE123456',
      secretAccessKey: 'secret-example-key',
      from: 'Ludy <noreply@mail.example.com>',
      configurationSet: 'ludy-pilot',
      fetch: fetchImpl,
      now: () => NOW,
    });
    expect(provider).toMatchObject({ name: 'ses', enabled: true, sendRetrySafety: 'never' });
    expect(provider.parseWebhook).toBeUndefined();

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0xff]);
    const icsText = 'BEGIN:VCALENDAR\r\nSUMMARY:Lịch hẹn\r\nEND:VCALENDAR\r\n';
    const res = await provider.send({
      ...MAIL,
      fromName: 'Công ty "ABC"\r\nBcc: victim@example.test',
      replyTo: 'reply@mail.example.com',
      inReplyTo: '<prev-1@mail.example.com>',
      references: ['<root@mail.example.com>', '<prev-1@mail.example.com>'],
      attachments: [
        { filename: 'lich.ics', contentType: 'text/calendar; method=PUBLISH; charset=UTF-8', content: icsText },
        { filename: 'bao-gia.pdf', contentType: 'application/pdf', content: pdfBytes },
      ],
    });
    expect(res).toEqual({ status: 'accepted', providerMessageId: '010f019abc-123' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`https://email.${REGION}.amazonaws.com/v2/email/outbound-emails`);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('manual');
    const reqHeaders = call?.init.headers as Record<string, string>;
    expect(reqHeaders['x-amz-date']).toBe('20261125T120000Z');
    expect(reqHeaders['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE123456\/20261125\/ap-southeast-1\/ses\/aws4_request/);

    const payload = JSON.parse(String(call?.init.body)) as { FromEmailAddress: string; ConfigurationSetName: string; Content: { Raw: { Data: string } } };
    expect(payload.FromEmailAddress).toBe('noreply@mail.example.com');
    expect(payload.ConfigurationSetName).toBe('ludy-pilot');

    const rawMime = Buffer.from(payload.Content.Raw.Data, 'base64').toString('utf8');
    expect(rawMime).toContain('\r\n');
    expect(rawMime).toMatch(/^To: khach@example\.test\r\n/m);
    expect(rawMime).toMatch(/^Reply-To: reply@mail\.example\.com\r\n/m);
    expect(rawMime).toMatch(/^Message-ID: <0192f0aa-0000-7000-8000-000000000001@mail\.example\.com>\r\n/m);
    expect(rawMime).toMatch(/^In-Reply-To: <prev-1@mail\.example\.com>\r\n/m);
    expect(rawMime).toMatch(/^References: <root@mail\.example\.com> <prev-1@mail\.example\.com>\r\n/m);
    expect(rawMime).toContain('<noreply@mail.example.com>');
    expect(rawMime).not.toMatch(/^Bcc:/im);
    // Both attachments survive base64 round-trip cleanly.
    const compact = rawMime.replace(/\r\n/g, '');
    expect(compact).toContain(Buffer.from(icsText, 'utf8').toString('base64'));
    expect(compact).toContain(Buffer.from(pdfBytes).toString('base64'));
  });

  it('uses senderName for bare from addresses and ignores oversized MessageId', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ MessageId: 'x'.repeat(256) }));
    const provider = createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@mail.example.com', senderName: 'Ludy VN', fetch: fetchImpl });
    expect(await provider.send(MAIL)).toEqual({ status: 'accepted' });
    const rawMime = Buffer.from((JSON.parse(String(calls[0]?.init.body)) as { Content: { Raw: { Data: string } } }).Content.Raw.Data, 'base64').toString('utf8');
    expect(rawMime).toMatch(/^From: Ludy VN <noreply@mail\.example\.com>\r\n/m);
  });

  it('classifies HTTP and SES errors safely without leaking recipient or message text', async () => {
    const send = (handler: () => Response | Promise<Response>) =>
      createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@mail.example.com', fetch: fakeFetch(handler).fetchImpl }).send(MAIL);
    const errRes = (status: number, errorType: string | null, message = 'khach@example.test failed', headers: Record<string, string> = {}) => () =>
      Response.json(
        { message, ...(errorType ? { __type: errorType } : {}) },
        { status, headers: { ...(errorType ? { 'x-amzn-errortype': `${errorType}:http://internal.amazon.com/coral` } : {}), ...headers } },
      );

    expect(await send(errRes(429, 'TooManyRequestsException', 'throttled', { 'retry-after': '4' }))).toEqual({
      status: 'rejected',
      error: 'rate_limited',
      code: 'SES_429_TooManyRequestsException',
      retryAfterMs: 4_000,
    });
    expect(await send(errRes(400, 'LimitExceededException'))).toEqual({
      status: 'rejected',
      error: 'rate_limited',
      code: 'SES_400_LimitExceededException',
    });
    for (const [status, type] of [
      [403, 'InvalidClientTokenId'],
      [403, 'SignatureDoesNotMatch'],
      [403, 'AccessDeniedException'],
      [401, null],
    ] as const) {
      expect(await send(errRes(status, type))).toEqual({
        status: 'rejected',
        error: 'auth',
        code: type ? `SES_${status}_${type}` : `SES_${status}`,
      });
    }
    for (const type of ['SendingPausedException', 'AccountSuspendedException', 'BadRequestException', 'MailFromDomainNotVerifiedException']) {
      expect(await send(errRes(400, type))).toEqual({ status: 'rejected', error: 'bad_request', code: `SES_400_${type}` });
    }
    // MessageRejected distinguishes recipient syntax failure vs general bad_request without leaking message text.
    const unverified = await send(errRes(400, 'MessageRejected', 'Email address is not verified: khach@example.test'));
    expect(unverified).toEqual({ status: 'rejected', error: 'bad_request', code: 'SES_400_MessageRejected' });
    expect(JSON.stringify(unverified)).not.toContain('khach@example.test');

    const badAddr = await send(errRes(400, 'MessageRejected', "Missing final '@domain' on khach@example.test"));
    expect(badAddr).toEqual({ status: 'rejected', error: 'invalid_recipient', code: 'SES_400_MessageRejected' });
    expect(JSON.stringify(badAddr)).not.toContain('khach@example.test');

    const suppressed = await send(errRes(400, 'MessageRejected', 'Address is on the account-level suppression list: khach@example.test'));
    expect(suppressed).toEqual({ status: 'rejected', error: 'suppressed_by_provider', code: 'SES_400_MessageRejected' });

    expect(await send(errRes(503, 'ServiceUnavailableException'))).toEqual({ status: 'unknown', code: 'SES_503_ServiceUnavailableException' });
    expect(await send(() => Promise.reject(new TypeError('network down')))).toEqual({ status: 'unknown', code: 'SES_NETWORK' });
    expect(await send(() => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })))).toEqual({ status: 'unknown', code: 'SES_TIMEOUT' });
  });
});

describe('SES SNS webhook verification & event parsing', () => {
  it('enables parseWebhook on provider only when snsTopicArn is set', () => {
    expect(createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com' }).parseWebhook).toBeUndefined();
    const withSns = createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com', snsTopicArn: TOPIC_ARN });
    expect(withSns.parseWebhook).toBeTypeOf('function');
  });

  it('verifies RSA-SHA256 (v2) and RSA-SHA1 (v1), optional Subject, and maps SES Event Publishing & legacy payloads', async () => {
    const { calls, fetchImpl } = fakeFetch((url) => (url === CERT_URL ? new Response(DEFAULT_CERT.pem, { status: 200 }) : new Response('not found', { status: 404 })));
    const provider = createSesProvider({
      region: REGION,
      accessKeyId: 'k',
      secretAccessKey: 's',
      from: 'noreply@example.com',
      snsTopicArn: TOPIC_ARN,
      fetch: fetchImpl,
    });

    const deliveredReq = makeNotification({
      eventType: 'Delivery',
      mail: { messageId: 'ses-msg-1', timestamp: '2026-11-25T11:58:00.000Z', destination: ['khach@example.test'] },
      delivery: { timestamp: '2026-11-25T11:59:10.000Z', recipients: ['khach@example.test'], smtpResponse: '250 OK khach@example.test' },
    });
    const delivered = await provider.parseWebhook?.(deliveredReq, NOW);
    expect(delivered).toEqual([
      { providerEventId: 'sns-evt-1', providerMessageId: 'ses-msg-1', kind: 'delivered', occurredAt: '2026-11-25T11:59:10.000Z', detail: {} },
    ]);
    expect(JSON.stringify(delivered)).not.toContain('khach@example.test');
    expect(JSON.stringify(delivered)).not.toContain('250 OK');

    // Cert is cached on the provider instance: subsequent calls do not re-fetch CERT_URL.
    const hardBounceReq = makeNotification(
      {
        notificationType: 'Bounce',
        mail: { messageId: 'ses-msg-2', timestamp: '2026-11-25T11:58:00.000Z' },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          timestamp: '2026-11-25T11:59:20.000Z',
          bouncedRecipients: [{ emailAddress: 'khach@example.test', diagnosticCode: '550 5.1.1 khach@example.test does not exist' }],
        },
      },
      { MessageId: 'sns-evt-2', Subject: 'Amazon SES Email Event Notification' },
      DEFAULT_CERT.privateKey,
      '1',
    );
    const hardBounce = await provider.parseWebhook?.(hardBounceReq, NOW);
    expect(hardBounce).toEqual([
      {
        providerEventId: 'sns-evt-2',
        providerMessageId: 'ses-msg-2',
        kind: 'bounce_hard',
        occurredAt: '2026-11-25T11:59:20.000Z',
        detail: { bounceType: 'Permanent', bounceSubType: 'General' },
      },
    ]);
    expect(JSON.stringify(hardBounce)).not.toContain('khach@example.test');
    expect(calls).toHaveLength(1);

    // Transient bounce -> bounce_soft
    expect(
      await provider.parseWebhook?.(
        makeNotification({ eventType: 'Bounce', mail: { messageId: 'ses-msg-3' }, bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull' } }, { MessageId: 'sns-evt-3' }),
        NOW,
      ),
    ).toEqual([expect.objectContaining({ kind: 'bounce_soft', detail: { bounceType: 'Transient', bounceSubType: 'MailboxFull' } })]);

    // DeliveryDelay -> deferred
    expect(
      await provider.parseWebhook?.(
        makeNotification({ eventType: 'DeliveryDelay', mail: { messageId: 'ses-msg-4' }, deliveryDelay: { delayType: 'TransientCommunicationFailure' } }, { MessageId: 'sns-evt-4' }),
        NOW,
      ),
    ).toEqual([expect.objectContaining({ kind: 'deferred', detail: { delayType: 'TransientCommunicationFailure' } })]);

    // Complaint -> complaint (non-PII metadata only)
    const complaint = await provider.parseWebhook?.(
      makeNotification(
        {
          notificationType: 'Complaint',
          mail: { messageId: 'ses-msg-5' },
          complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'khach@example.test' }] },
        },
        { MessageId: 'sns-evt-5' },
      ),
      NOW,
    );
    expect(complaint).toEqual([expect.objectContaining({ kind: 'complaint', detail: { feedbackType: 'abuse' } })]);
    expect(JSON.stringify(complaint)).not.toContain('khach@example.test');

    // Informational events are acknowledged and return [].
    for (const eventType of ['Send', 'Open', 'Click', 'Reject', 'Rendering Failure']) {
      expect(await provider.parseWebhook?.(makeNotification({ eventType, mail: { messageId: 'ses-msg-x' } }), NOW)).toEqual([]);
    }
    expect(calls).toHaveLength(1);
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
    expect(await reasonOf(makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, { Timestamp: new Date(NOW - 16 * 60_000).toISOString() }))).toBe('stale');
    expect(await reasonOf(makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, { Timestamp: new Date(NOW + 16 * 60_000).toISOString() }))).toBe('stale');

    const badCertUrls = [
      `http://sns.${REGION}.amazonaws.com/SimpleNotificationService-abc123.pem`,
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem',
      'https://evil.example.com/SimpleNotificationService-abc123.pem',
      `https://sns.${REGION}.amazonaws.com:8443/SimpleNotificationService-abc123.pem`,
      `https://user:pass@sns.${REGION}.amazonaws.com/SimpleNotificationService-abc123.pem`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-abc123.pem?x=1`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-abc123.pem#frag`,
      `https://sns.${REGION}.amazonaws.com/foo/../SimpleNotificationService-abc123.pem`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-%2e%2e.pem`,
      `https://sns.${REGION}.amazonaws.com/other.pem`,
      `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-ZZZZ.pem`,
    ];
    for (const SigningCertURL of badCertUrls) {
      expect(await reasonOf(makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, { SigningCertURL })), SigningCertURL).toBe('signature');
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects tampered signatures, wrong keys, expired/non-RSA certs, oversized PEMs, and malformed message payloads', async () => {
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
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(expiredCert.pem)).fetchImpl }, makeNotification({ eventType: 'Delivery', mail: { messageId: 'm1' } }, {}, expiredCert.privateKey), NOW),
    ).rejects.toMatchObject({ reason: 'signature' });

    await expect(
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(ecCert.pem)).fetchImpl }, validReq, NOW),
    ).rejects.toMatchObject({ reason: 'signature' });

    // Oversized PEM streamed without Content-Length (> 32 KiB)
    const oversized = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(33 * 1024).fill(65));
        controller.close();
      },
    });
    await expect(
      parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(oversized, { status: 200 })).fetchImpl }, validReq, NOW),
    ).rejects.toMatchObject({ reason: 'signature' });

    // Missing mail.messageId or oversized messageId on recorded event
    await expect(
      parseSesWebhook(
        { region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(DEFAULT_CERT.pem)).fetchImpl },
        makeNotification({ eventType: 'Delivery', mail: {} }),
        NOW,
      ),
    ).rejects.toMatchObject({ reason: 'malformed' });
    await expect(
      parseSesWebhook(
        { region: REGION, snsTopicArn: TOPIC_ARN, fetch: fakeFetch(() => new Response(DEFAULT_CERT.pem)).fetchImpl },
        makeNotification({ eventType: 'Delivery', mail: { messageId: 'x'.repeat(256) } }),
        NOW,
      ),
    ).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('bounds the in-memory certificate cache to 16 entries with LRU eviction', async () => {
    const { calls, fetchImpl } = fakeFetch(() => new Response(DEFAULT_CERT.pem, { status: 200 }));
    const provider = createSesProvider({ region: REGION, accessKeyId: 'k', secretAccessKey: 's', from: 'noreply@example.com', snsTopicArn: TOPIC_ARN, fetch: fetchImpl });
    const certUrl = (i: number) => `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${i.toString(16).padStart(32, '0')}.pem`;

    for (let i = 0; i < 16; i++) {
      await provider.parseWebhook?.(makeNotification({ eventType: 'Send' }, { SigningCertURL: certUrl(i) }), NOW);
    }
    expect(calls).toHaveLength(16);
    // Hitting cert 0 refreshes it in LRU order, then inserting cert 16 evicts cert 1 (not cert 0).
    await provider.parseWebhook?.(makeNotification({ eventType: 'Send' }, { SigningCertURL: certUrl(0) }), NOW);
    expect(calls).toHaveLength(16);
    await provider.parseWebhook?.(makeNotification({ eventType: 'Send' }, { SigningCertURL: certUrl(16) }), NOW);
    expect(calls).toHaveLength(17);
    await provider.parseWebhook?.(makeNotification({ eventType: 'Send' }, { SigningCertURL: certUrl(0) }), NOW);
    expect(calls).toHaveLength(17);
    await provider.parseWebhook?.(makeNotification({ eventType: 'Send' }, { SigningCertURL: certUrl(1) }), NOW);
    expect(calls).toHaveLength(18);
  });

  it('verifies SubscriptionConfirmation, validates SubscribeURL before GET, and handles UnsubscribeConfirmation', async () => {
    const { calls, fetchImpl } = fakeFetch((url) => {
      if (url === CERT_URL) return new Response(DEFAULT_CERT.pem, { status: 200 });
      if (url === SUBSCRIBE_URL) return new Response('<ConfirmSubscriptionResponse/>', { status: 200 });
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
    expect(calls.map((c) => [c.url, c.init.redirect])).toEqual([
      [CERT_URL, 'manual'],
      [SUBSCRIBE_URL, 'manual'],
    ]);

    // SSRF SubscribeURL (even if signed) is rejected without fetching SubscribeURL.
    const badSubscribe = signSnsEnvelope({
      Type: 'SubscriptionConfirmation',
      MessageId: 'sub-2',
      TopicArn: TOPIC_ARN,
      Token: 'tok123',
      Message: 'You have chosen to subscribe...',
      SubscribeURL: 'https://169.254.169.254/latest/meta-data',
      Timestamp: new Date(NOW).toISOString(),
      SigningCertURL: CERT_URL,
    });
    const badSubFetch = fakeFetch((url) => (url === CERT_URL ? new Response(DEFAULT_CERT.pem) : new Response('should not fetch', { status: 200 })));
    await expect(parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: badSubFetch.fetchImpl }, badSubscribe, NOW)).rejects.toMatchObject({ reason: 'malformed' });
    expect(badSubFetch.calls.map((c) => c.url)).toEqual([CERT_URL]);

    // UnsubscribeConfirmation returns [] without fetching SubscribeURL.
    const unsub = signSnsEnvelope({
      Type: 'UnsubscribeConfirmation',
      MessageId: 'unsub-1',
      TopicArn: TOPIC_ARN,
      Token: 'tok123',
      Message: 'Unsubscribed',
      SubscribeURL: SUBSCRIBE_URL,
      Timestamp: new Date(NOW).toISOString(),
      SigningCertURL: CERT_URL,
    });
    const unsubFetch = fakeFetch((url) => (url === CERT_URL ? new Response(DEFAULT_CERT.pem) : new Response('should not fetch', { status: 200 })));
    expect(await parseSesWebhook({ region: REGION, snsTopicArn: TOPIC_ARN, fetch: unsubFetch.fetchImpl }, unsub, NOW)).toEqual([]);
    expect(unsubFetch.calls.map((c) => c.url)).toEqual([CERT_URL]);
  });
});

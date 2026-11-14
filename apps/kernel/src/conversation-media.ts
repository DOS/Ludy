// SPDX-License-Identifier: AGPL-3.0-only
// The fetch of a customer's image for the conversation core (issue #2357, plan docs/plan/conversations.md section 10). The address comes
// from a platform's notice, so it is a URL somebody else chose: it is fetched only through the egress guard of @crove/kernel-runtime (a
// public address, the connection pinned to the address that was checked), only from the platform's own media hosts on every hop of a
// redirect, at most CONVERSATION_IMAGE_MAX_BYTES, and what comes back is an image only if its first bytes say so (JPEG, PNG, WebP or GIF:
// never what the platform or the host declared, and never SVG or anything that could be rendered as a page).
//
// Nothing here logs or returns the address or any byte of the image except as the result's own bytes: a failure is a short code.
import { FACEBOOK_MEDIA_HOSTS, INSTAGRAM_MEDIA_HOSTS, TELEGRAM_MEDIA_HOSTS, WHATSAPP_MEDIA_HOSTS, ZALO_MEDIA_HOSTS, mediaHostAllowed, type ConversationAdapter } from '@crove/channel';
import { CONVERSATION_IMAGE_MAX_BYTES, type ConversationImageType } from '@crove/kernel-contract';
import { EgressError, egressFetch, guardedFetch, type EgressOptions } from '@crove/kernel-runtime';
import { imageSize } from './media-probe.ts';

// The fetch's deadline, redirects included.
export const CONVERSATION_IMAGE_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 2;

export type ConversationImage =
  | { kind: 'image'; bytes: Buffer; contentType: ConversationImageType; width: number | null; height: number | null }
  // retry: asking again may succeed (a timeout, the host's error); else the image is dropped for good.
  | { kind: 'failed'; retry: boolean; code: string };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean => signature.every((b, i) => bytes[offset + i] === b);

// The image type the bytes themselves say, or null.
export function sniffConversationImage(bytes: Uint8Array): ConversationImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  return null;
}

// A GIF's logical screen size, from its header (width and height are little-endian 16-bit numbers after the six-byte signature).
function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 10) return null;
  const width = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
  const height = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
  return width >= 1 && height >= 1 ? { width, height } : null;
}

// The hosts a provider's images may come from: its own list, or the deployment's. A provider with no list has no allowed host. `configured` is Zalo's
// (CHANNEL_ZALO_MEDIA_HOSTS); `byProvider` holds the deployment's list of another provider (CHANNEL_WHATSAPP_MEDIA_HOSTS), an empty one meaning the built-in.
export function mediaHostsOf(provider: string, configured: readonly string[] | undefined, byProvider?: Readonly<Record<string, readonly string[]>>): readonly string[] {
  if (provider === 'zalo_oa') return configured && configured.length > 0 ? configured : ZALO_MEDIA_HOSTS;
  if (provider === 'facebook_page') return FACEBOOK_MEDIA_HOSTS;
  if (provider === 'instagram') return INSTAGRAM_MEDIA_HOSTS;
  // Telegram serves a bot's files from the Bot API's own host (#3192): the one host, never the deployment's to widen.
  if (provider === 'telegram') return TELEGRAM_MEDIA_HOSTS;
  if (provider === 'whatsapp') {
    const own = byProvider && Object.hasOwn(byProvider, provider) ? byProvider[provider] : undefined;
    return own && own.length > 0 ? own : WHATSAPP_MEDIA_HOSTS;
  }
  return [];
}

export interface FetchConversationImageOptions {
  hosts: readonly string[];
  // Tests only: the resolver, the address check and any port (a local test server), which the guard otherwise never allows.
  egress?: Pick<EgressOptions, 'resolve' | 'allowed' | 'anyPort' | 'httpsOnly'>;
}

export async function fetchConversationImage(url: string, options: FetchConversationImageOptions): Promise<ConversationImage> {
  let answer;
  try {
    answer = await guardedFetch(url, {
      timeoutMs: CONVERSATION_IMAGE_TIMEOUT_MS,
      maxBytes: CONVERSATION_IMAGE_MAX_BYTES,
      overLimit: 'fail',
      maxRedirects: MAX_REDIRECTS,
      accept: 'image/jpeg, image/png, image/webp, image/gif',
      hostAllowed: (host) => mediaHostAllowed(host, options.hosts),
      httpsOnly: true,
      ...options.egress,
    });
  } catch (error) {
    if (!(error instanceof EgressError)) return { kind: 'failed', retry: true, code: 'FETCH_ERROR' };
    // A host that is not allowed, a bad address, a body over the cap or a compressed one will not change on asking again; a name that does
    // not resolve, a timeout and a dropped connection may.
    const transient = error.code === 'dns' || error.code === 'timeout' || error.code === 'network';
    return { kind: 'failed', retry: transient, code: `EGRESS_${error.code.toUpperCase()}` };
  }
  if (answer.status === 429 || answer.status >= 500) return { kind: 'failed', retry: true, code: `HTTP_${answer.status}` };
  if (answer.status !== 200) return { kind: 'failed', retry: false, code: `HTTP_${answer.status}` };
  if (answer.truncated || answer.body.byteLength === 0 || answer.body.byteLength > CONVERSATION_IMAGE_MAX_BYTES) return { kind: 'failed', retry: false, code: 'BAD_SIZE' };
  const image = inspectConversationImage(answer.body);
  if (!image) return { kind: 'failed', retry: false, code: 'NOT_AN_IMAGE' };
  return { kind: 'image', bytes: answer.body, ...image };
}

// What the bytes of an image say of themselves (the type from the first bytes, the size in pixels when the header gives it), or null when
// they are not a JPEG, PNG, WebP or GIF. Shared by the fetch of a platform's image and the images a customer's mail carries (#2758).
export function inspectConversationImage(bytes: Buffer): { contentType: ConversationImageType; width: number | null; height: number | null } | null {
  const contentType = sniffConversationImage(bytes);
  if (!contentType) return null;
  const shown = contentType === 'image/gif' ? gifSize(bytes) : imageSize(bytes, contentType);
  return { contentType, width: shown?.width ?? null, height: shown?.height ?? null };
}

// An image the platform gave only by a reference (WhatsApp's media id, #3131): the provider's adapter turns it into bytes with the connection's credential,
// and every byte of that goes through the egress guard (public addresses only, the connection pinned to the checked address, the provider's media hosts
// only on the first request and on any redirect, https only, no redirect followed, at most CONVERSATION_IMAGE_MAX_BYTES). The bytes are an image only if
// their first bytes say so, as for a fetched address. A failure is a short code: never the reference, the token, an address or a platform's words.
export interface FetchConversationMediaOptions {
  externalAccountId: string;
  // The opened credential (the provider's own JSON): passed to the adapter and nowhere else.
  secret: string;
  mediaRef: string;
  hosts: readonly string[];
  egress?: FetchConversationImageOptions['egress'];
}

export async function fetchConversationMedia(adapter: ConversationAdapter, options: FetchConversationMediaOptions): Promise<ConversationImage> {
  if (!adapter.media) return { kind: 'failed', retry: false, code: 'NO_MEDIA_ADAPTER' };
  const guarded = egressFetch({
    timeoutMs: CONVERSATION_IMAGE_TIMEOUT_MS,
    maxBytes: CONVERSATION_IMAGE_MAX_BYTES,
    overLimit: 'fail',
    accept: 'image/jpeg, image/png, image/webp, image/gif',
    hostAllowed: (host) => mediaHostAllowed(host, options.hosts),
    httpsOnly: true,
    ...options.egress,
  });
  let answer;
  try {
    answer = await adapter.media({ externalAccountId: options.externalAccountId, secret: options.secret, mediaRef: options.mediaRef, fetch: guarded, maxBytes: CONVERSATION_IMAGE_MAX_BYTES, hosts: options.hosts });
  } catch {
    // A throw out of an adapter says nothing of what it did: asked again later, up to the row's five tries.
    return { kind: 'failed', retry: true, code: 'MEDIA_ADAPTER_ERROR' };
  }
  if (answer.kind === 'failed') return { kind: 'failed', retry: answer.retry, code: answer.code };
  const bytes = Buffer.from(answer.bytes);
  if (bytes.byteLength === 0 || bytes.byteLength > CONVERSATION_IMAGE_MAX_BYTES) return { kind: 'failed', retry: false, code: 'BAD_SIZE' };
  const image = inspectConversationImage(bytes);
  if (!image) return { kind: 'failed', retry: false, code: 'NOT_AN_IMAGE' };
  return { kind: 'image', bytes, ...image };
}

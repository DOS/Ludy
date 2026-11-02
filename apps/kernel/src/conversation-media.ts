// SPDX-License-Identifier: AGPL-3.0-only
// The fetch of a customer's image for the conversation core (issue #2357, plan docs/plan/conversations.md section 10). The address comes
// from a platform's notice, so it is a URL somebody else chose: it is fetched only through the egress guard of @crove/kernel-runtime (a
// public address, the connection pinned to the address that was checked), only from the platform's own media hosts on every hop of a
// redirect, at most CONVERSATION_IMAGE_MAX_BYTES, and what comes back is an image only if its first bytes say so (JPEG, PNG, WebP or GIF:
// never what the platform or the host declared, and never SVG or anything that could be rendered as a page).
//
// Nothing here logs or returns the address or any byte of the image except as the result's own bytes: a failure is a short code.
import { ZALO_MEDIA_HOSTS, mediaHostAllowed } from '@crove/channel';
import { CONVERSATION_IMAGE_MAX_BYTES, type ConversationImageType } from '@crove/kernel-contract';
import { EgressError, guardedFetch, type EgressOptions } from '@crove/kernel-runtime';
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

// The hosts a provider's images may come from: its own list, or the deployment's. A provider with no list has no allowed host.
export function mediaHostsOf(provider: string, configured: readonly string[] | undefined): readonly string[] {
  if (provider === 'zalo_oa') return configured && configured.length > 0 ? configured : ZALO_MEDIA_HOSTS;
  return [];
}

export interface FetchConversationImageOptions {
  hosts: readonly string[];
  // Tests only: the resolver, the address check and any port (a local test server), which the guard otherwise never allows.
  egress?: Pick<EgressOptions, 'resolve' | 'allowed' | 'anyPort'>;
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
  const contentType = sniffConversationImage(answer.body);
  if (!contentType) return { kind: 'failed', retry: false, code: 'NOT_AN_IMAGE' };
  const shown = contentType === 'image/gif' ? gifSize(answer.body) : imageSize(answer.body, contentType);
  return { kind: 'image', bytes: answer.body, contentType, width: shown?.width ?? null, height: shown?.height ?? null };
}

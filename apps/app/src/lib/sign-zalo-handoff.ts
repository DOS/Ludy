// SPDX-License-Identifier: AGPL-3.0-only
// Pure deterministic helpers for eSign Zalo OA Engage composer handoff (#4720).
// Zero React imports, zero LLM calls, and strict exclusion of confidential hr_contract and meeting_minutes envelopes.
import { CONVERSATION_PROVIDER_RULES, hasNamePlaceholder } from '@ludy/kernel-contract';

export const SIGN_ZALO_PROVIDER = 'zalo_oa';
export const SIGN_ZALO_DRAFT_MAX: number = CONVERSATION_PROVIDER_RULES.zalo_oa?.replyMax ?? 2000;
export const SIGN_ZALO_THREADS_MAX = 15;

export function isConfidentialSignSourceKind(sourceKind: string): boolean {
  return sourceKind === 'hr_contract' || sourceKind === 'meeting_minutes';
}

export function getEligibleSignZaloSigners<T extends { signerRole: string; status: string }>(
  signers: readonly T[],
): T[] {
  return signers.filter((s) => s.signerRole !== 'cc' && (s.status === 'pending' || s.status === 'viewed'));
}

export function canOfferSignZaloHandoff(input: {
  sourceKind: string;
  status: string;
  expiresAt?: string | null | undefined;
  signers: readonly { signerRole: string; status: string }[];
  canManageLinks?: boolean | undefined;
  socialInstalled?: boolean | undefined;
  now?: number | undefined;
}): boolean {
  if (input.socialInstalled === false) return false;
  if (input.canManageLinks === false) return false;
  if (isConfidentialSignSourceKind(input.sourceKind)) return false;
  if (input.status !== 'sent' && input.status !== 'in_progress') return false;
  if (input.expiresAt) {
    const expiresMs = Date.parse(input.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= (input.now ?? Date.now())) {
      return false;
    }
  }
  return getEligibleSignZaloSigners(input.signers).length > 0;
}

export interface SignZaloThreadSourceItem {
  id: string;
  kind: string;
  status?: string;
  channel: { provider: string; displayName: string };
  lastMessageAt: string | null;
  replyWindowUntil?: string | null;
  contact?: {
    partyName?: string | null;
    displayName?: string | null;
    idTail?: string | null;
  };
}

export interface SignZaloThreadOption {
  id: string;
  channelName: string;
  contactName: string | null;
  lastMessageAt: string | null;
  replyWindowUntil: string | null;
  linkedToContact: boolean;
  status: string | null;
}

function contactLabelOf(item: SignZaloThreadSourceItem): string | null {
  const raw = item.contact?.partyName ?? item.contact?.displayName ?? null;
  const trimmed = raw?.trim();
  if (trimmed) return trimmed;
  const tail = item.contact?.idTail?.trim();
  return tail ? `#${tail}` : null;
}

/** Deduplicates and prioritizes Zalo OA direct threads (CRM-linked contact threads first, then newest activity). */
export function zaloDirectThreadsOf(input: {
  linkedLists?: ReadonlyArray<ReadonlyArray<SignZaloThreadSourceItem> | undefined>;
  recentDirectList?: ReadonlyArray<SignZaloThreadSourceItem> | undefined;
  limit?: number;
}): SignZaloThreadOption[] {
  const byId = new Map<string, SignZaloThreadOption>();

  const upsert = (item: SignZaloThreadSourceItem, linkedToContact: boolean) => {
    if (item.kind !== 'direct' || item.channel.provider !== SIGN_ZALO_PROVIDER) return;
    const prev = byId.get(item.id);
    const nextContact = contactLabelOf(item) ?? prev?.contactName ?? null;
    const prevDate = prev?.lastMessageAt ?? '';
    const itemDate = item.lastMessageAt ?? '';
    const latestAt = itemDate > prevDate ? item.lastMessageAt : (prev?.lastMessageAt ?? item.lastMessageAt);
    byId.set(item.id, {
      id: item.id,
      channelName: item.channel.displayName || prev?.channelName || 'Zalo OA',
      contactName: nextContact,
      lastMessageAt: latestAt,
      replyWindowUntil: item.replyWindowUntil ?? prev?.replyWindowUntil ?? null,
      linkedToContact: Boolean(prev?.linkedToContact || linkedToContact),
      status: item.status ?? prev?.status ?? null,
    });
  };

  for (const list of input.linkedLists ?? []) {
    for (const item of list ?? []) {
      upsert(item, true);
    }
  }
  for (const item of input.recentDirectList ?? []) {
    upsert(item, false);
  }

  const max = input.limit ?? SIGN_ZALO_THREADS_MAX;
  return [...byId.values()]
    .sort((a, b) => {
      if (a.linkedToContact !== b.linkedToContact) return a.linkedToContact ? -1 : 1;
      const dateCmp = (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '');
      if (dateCmp !== 0) return dateCmp;
      return b.id.localeCompare(a.id);
    })
    .slice(0, max);
}

// Strips control/invisible characters and braces so untrusted envelope titles or signer names can never inject `{tên}` placeholders.
function sanitizeOneLine(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}{}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function sanitizeMultiline(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}{}]/gu, (ch) => (ch === '\n' ? ch : ' '))
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function sanitizeSigningUrl(rawUrl: string): string {
  return rawUrl
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}{}\r\n]/gu, '')
    .trim();
}

export interface SignZaloDraftInput {
  envelopeTitle: string;
  signerName: string;
  signingUrl: string;
  requireEmailOtp?: boolean | undefined;
  expiresAtText?: string | null | undefined;
  customNote?: string | null | undefined;
  max?: number | undefined;
}

export interface SignZaloDraftResult {
  text: string;
  length: number;
  max: number;
  fits: boolean;
}

/** Builds a deterministic Vietnamese Zalo OA signing invitation draft (0 LLM calls). */
export function buildSignZaloDraft(input: SignZaloDraftInput): SignZaloDraftResult {
  const max = input.max ?? SIGN_ZALO_DRAFT_MAX;
  const cleanTitle = sanitizeOneLine(input.envelopeTitle) || 'Tài liệu ký kết';
  const cleanSigner = sanitizeOneLine(input.signerName);
  const cleanUrl = sanitizeSigningUrl(input.signingUrl);
  const cleanNote = input.customNote ? sanitizeMultiline(input.customNote) : '';
  const cleanExpiry = input.expiresAtText ? sanitizeOneLine(input.expiresAtText) : '';

  if (!cleanUrl) {
    return { text: '', length: 0, max, fits: false };
  }

  const blocks: string[] = [
    cleanSigner ? `Kính gửi ${cleanSigner},` : 'Kính chào Quý khách,',
    `Mời Anh/Chị xem và ký tài liệu "${cleanTitle}" qua liên kết bảo mật dưới đây:\n${cleanUrl}`,
  ];

  if (cleanNote) {
    blocks.push(cleanNote);
  }

  const notes: string[] = ['Vui lòng mở trực tiếp liên kết trên điện thoại hoặc máy tính để ký.'];
  if (input.requireEmailOtp) {
    notes.push('Khi mở tài liệu, vui lòng nhập mã OTP 6 chữ số được gửi tới email đã đăng ký.');
  }
  if (cleanExpiry) {
    notes.push(`Hạn ký: ${cleanExpiry}.`);
  }
  blocks.push(`Lưu ý: ${notes.join(' ')}`);

  const text = blocks.join('\n\n').trim();
  if (hasNamePlaceholder(text)) {
    return { text: '', length: 0, max, fits: false };
  }
  return {
    text,
    length: text.length,
    max,
    fits: text.length > 0 && text.length <= max,
  };
}

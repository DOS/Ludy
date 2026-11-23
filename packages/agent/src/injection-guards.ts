// SPDX-License-Identifier: AGPL-3.0-only
// Shared deterministic prompt-injection guards for AI coworker validators (#3977, audit AI-02).
// Pure string checks: no I/O, no model calls, safe for both org-level and member-Vy modules.

// C0/DEL controls (excluding tab, LF, CR) plus stealth format/bidi/Unicode-tag characters that split tokens, reorder visible text, or hide instructions.
// Excludes U+200D (ZWJ) so multi-codepoint emoji sequences in user-facing copy are preserved while checking output strings.
export const STEALTH_CONTROL_RE =
  /(?![\t\n\r])\p{Cc}|[\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;

const ALL_STEALTH_AND_CF_RE = /(?![\t\n\r])\p{Cc}|\p{Cf}|[\u{E0000}-\u{E007F}]/gu;

export function hasStealthControls(text: string): boolean {
  return STEALTH_CONTROL_RE.test(text);
}

export function stripStealthControls(text: string): string {
  return text.replace(ALL_STEALTH_AND_CF_RE, '');
}

function normalizeForGuard(text: string): string {
  return stripStealthControls(text).normalize('NFC').toLowerCase();
}

// Detects unprompted autonomous execution, approval, wire, contract-signing, hiring, or prompt-override directives.
// Evaluated on NFC text without stripping Vietnamese diacritics so "từ dòng" / "tên đồng" do not collide with "tự động" / "ten dong",
// and negated safety phrasing ("không tự động...") or ordinary factual past tense ("đã ký hợp đồng") is preserved.
const AUTONOMOUS_ACTION_RE: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])(?<!không\s)(?<!chưa\s)(?<!đừng\s)(?<!tránh\s)tự\s+động\s+(?:phê\s+duyệt|duyệt|tuyển\s+dụng|ký|chuyển\s+khoản|chuyển\s+tiền|chi\s+trả|thanh\s+toán|gửi|xuất\s+hóa\s+đơn|hạch\s+toán|ghi\s+sổ)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])đã\s+tự\s+động\s+(?:phê\s+duyệt|tuyển\s+dụng|ký|chuyển\s+khoản|chi\s+trả|hạch\s+toán|ghi\s+sổ)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])đã\s+bỏ\s+qua\s+(?:quy\s+tắc|kiểm\s+tra)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])xác\s+nhận\s+(?:hóa\s+đơn\s+)?đã\s+thanh\s+toán(?:\s+ngay)?(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:bỏ\s+qua\s+(?:mọi\s+)?(?:quy\s+tắc|hướng\s+dẫn)|chỉ\s+thị\s+quản\s+trị)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?<!khong\s)(?<!chua\s)tu\s+dong\s+(?:phe\s+duyet|duyet|tuyen\s+dung|ky|chuyen\s+khoan|chuyen\s+tien|chi\s+tra|thanh\s+toan|gui|xuat\s+hoa\s+don|hach\s+toan|ghi\s+so)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])da\s+tu\s+dong\s+(?:phe\s+duyet|tuyen\s+dung|ky|chuyen\s+khoan|chi\s+tra|hach\s+toan|ghi\s+so)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])da\s+bo\s+qua\s+(?:quy\s+tac|kiem\s+tra)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])xac\s+nhan\s+(?:hoa\s+don\s+)?da\s+thanh\s+toan(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:bo\s+qua\s+(?:moi\s+)?(?:quy\s+tac|huong\s+dan)|chi\s+thi\s+quan\s+tri)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?<!not\s)(?<!never\s)(?<!no\s)(?:auto[- ]?approv(?:e|ed)|approved\s+and\s+wired|wire(?:d)?\b[^.]{0,40}\b(?:without\s+review|immediately))(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:system\s+override|admin_override|ignore\s+(?:prior|all|previous)\s+(?:rules|instructions))(?![\p{L}\p{N}])/iu,
];

export function hasAutonomousActionDirective(text: string): boolean {
  const normalized = normalizeForGuard(text);
  return AUTONOMOUS_ACTION_RE.some((re) => re.test(normalized));
}

// Obfuscated URLs, schemes, emails/obfuscated emails/domains, phone numbers, and @handles that plain URL matchers can miss.
// Anchored with negative lookbehinds and disjoint character classes to stay linear (no ReDoS on long runs of dots/spaces).
const OBFUSCATED_CONTACT_OR_LINK_RE =
  /hxxps?:\/\/|\p{L}[ \t]{0,8}(?:\[\.\]|\(dot\))[ \t]{0,8}\p{L}|\(at\)|(?<![\p{L}\p{N}_.%+-])[\p{L}\p{N}_%+-]+(?:\.[\p{L}\p{N}_%+-]+)*@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?![\p{L}\p{N}-])|(?<![\p{L}\p{N}_])@[\p{L}\p{N}_]{2,}|(?<!\d)(?:\+?84|0)(?:[ \t.-]?\d){8,10}(?!\d)|(?<![\p{L}\p{N}_.-])(?:[\p{L}\p{N}-]+\.)+(?:com|vn|net|org|io|ai|gov|edu|info|biz|co|me|ly|invalid|example|test|club|shop|xyz)(?=$|[\s/?#.,;!?)}\]"'])/giu;

const PLAIN_PHONE_RE = /^(?:\+?84|0)(?:[ \t.-]?\d){8,10}$/;

// Written money / scale / currency phrases used in prompt injections (without flagging "một triệu dòng dữ liệu" or "Họ tên đồng nghiệp" or standalone "VND"/"one"/"two").
const MONEY_SCALE_WORDS_RE: readonly RegExp[] = [
  /(?<![\p{L}])(?:mười|mươi|trăm)\s+(?:nghìn|ngàn|triệu|tỷ)(?:\s+(?:đồng|đô|vnđ))?(?![\p{L}])/iu,
  /(?<![\p{L}])(?:không|một|hai|ba|bốn|tư|năm|lăm|sáu|bảy|tám|chín|mười|mươi|trăm|nghìn|ngàn|triệu|tỷ)\s+(?:trăm\s+(?:nghìn|ngàn|triệu|tỷ)\s+)?(?:đồng|đô|vnđ)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:nghìn|ngàn|triệu|tỷ)\s+(?:đồng|đô|vnđ)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:khong|mot|hai|ba|bon|tu|nam|lam|sau|bay|tam|chin|muoi)\s+muoi\s+(?:trieu|nghin|ngan|ty|tram(?:\s+nghin)?|dong)(?:\s+dong)?(?![\p{L}])/iu,
  /(?<![\p{L}])(?:trieu|nghin|ngan|ty)\s+dong(?![\p{L}])/iu,
  /(?<![\p{L}])(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(?:hundred|thousand|million|billion|trillion|dollars?|usd|euros?|eur|vnd|dong|percent)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:hundred|thousand|million|billion|trillion)\s+(?:dollars?|usd|euros?|eur|vnd|dong)(?![\p{L}])/iu,
];

// Adversarial non-ASCII digits/minus, UUID leaks, currency/percentage amounts, or multi-thousand grouped numbers.
// Negative lookbehinds include ",", "-", and "\u2212" so repeated comma/dash/minus-digit runs stay strictly linear (no O(N^2) ReDoS).
const NON_ASCII_DIGIT_OR_MINUS_RE = /[\uFF10-\uFF19\u0660-\u0669\u2212]/u;
const UNTRUSTED_MONEY_OR_ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![\p{N}_.,\u2212$€£₫-])[−-]?[$€£₫]\s*\d+(?:[.,]\d+)*(?=$|[\s.,;!?)}\]"':/])|(?<![\p{L}\p{N}_.,\u2212-])[−-]?\d+(?:[.,]\d+)*\s*(?:%|triệu|trieu|tỷ|ty|tỉ|nghìn|nghin|ngàn|ngan|đồng|dong|vnđ|vnd|đ|₫|usd|\$|€)(?=$|[\s.,;!?)}\]"':/])|(?<![\p{L}\p{N}_.,\u2212-])[−-]?\d{1,3}(?:[.,]\d{3}){2,}(?=$|[\s.,;!?)}\]"'])/giu;

// Strict written number words used by payment reminders and finance word checks that expect zero figures or currencies.
const STRICT_NUMBER_WORD_RE = new RegExp(
  '(?<![\\p{L}])(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|half|grand|percent|dollars?|usd|euros?|eur|vnd|vnđ|trăm|nghìn|nghin|ngàn|ngan|triệu|trieu|tỷ|vạn|mươi|muoi|mùng|mồng|nửa)(?![\\p{L}])',
  'iu',
);
const STRICT_VI_NUMBER_BEFORE_UNIT_RE = new RegExp(
  '(?<![\\p{L}])(?:một|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|mười|mươi|mốt|lăm|mấy)(?:\\s+(?:mươi|mốt|lăm|mười))?\\s+(?:ngày|tuần|tháng|quý|năm|đồng|đô|giờ|phút)(?![\\p{L}])',
  'iu',
);
const ADDRESS_RE = /\p{L}\.\p{L}|\p{L}\s*\[\.\]\s*\p{L}|\p{L}\s*\(dot\)\s*\p{L}|\p{L}\s+dot\s+\p{L}|\(at\)|@|:\/\/|(?<![\p{L}])www(?![\p{L}])/iu;

// Project status/cycle written tens/scales/counts, leaving standalone currency codes (VND, USD, EUR) and small words ("one", "two") intact.
const PROJECT_WRITTEN_COUNT_RE =
  /(?<![\p{L}])(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|grand)(?![\p{L}])|(?<![\p{L}])(?:một|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|mười)\s+(?:mươi|mốt|lăm|ngày|tuần|tháng|quý|năm|đồng|đô|giờ|phút|việc|điểm)(?![\p{L}])|(?<![\p{L}])(?:trăm|nghìn|nghin|ngàn|ngan|triệu|trieu|tỷ|tỉ|vạn|mươi|muoi|phần\s+trăm)(?![\p{L}])/iu;

/** Precomputed normalized domain/handle and phone-digit sets allowed in grounded outputs. */
export interface TrustedContactSets {
  readonly domainOrHandleSet: ReadonlySet<string>;
  readonly phoneDigitSet: ReadonlySet<string>;
}

/** Extracts normalized trusted domain/handle tokens and phone digits from source strings once per validator run. */
export function collectTrustedContactSets(
  trusted: readonly string[],
  phoneTrusted: readonly string[] = trusted,
): TrustedContactSets {
  const domainOrHandleSet = new Set<string>();
  const phoneDigitSet = new Set<string>();

  for (const t of trusted) {
    const norm = stripStealthControls(t).normalize('NFKC');
    for (const match of norm.matchAll(OBFUSCATED_CONTACT_OR_LINK_RE)) {
      const token = match[0].trim().toLowerCase();
      if (token && !PLAIN_PHONE_RE.test(token) && !/hxxps?:\/\/|\[\.\]|\(dot\)|\(at\)/i.test(token)) {
        domainOrHandleSet.add(token);
      }
    }
  }

  for (const t of phoneTrusted) {
    const collapsed = stripStealthControls(t).normalize('NFKC').replace(/(?<=\d)[ \t.-]+(?=\d)/g, '');
    for (const match of collapsed.matchAll(/(?<!\d)(?:\+?84|0)\d{8,10}(?!\d)/g)) {
      const digits = match[0].replace(/\D+/g, '');
      if (digits) phoneDigitSet.add(digits);
    }
  }

  return { domainOrHandleSet, phoneDigitSet };
}

/** Checks obfuscated links, handles, domains, and phones against precomputed trusted contact sets. */
export function hasObfuscatedContactOrLinkFromSets(text: string, sets: TrustedContactSets): boolean {
  const normalized = stripStealthControls(text).normalize('NFKC');
  const { domainOrHandleSet, phoneDigitSet } = sets;

  for (const match of normalized.matchAll(OBFUSCATED_CONTACT_OR_LINK_RE)) {
    const token = match[0].trim();
    if (PLAIN_PHONE_RE.test(token)) {
      const digits = token.replace(/\D+/g, '');
      if (digits && phoneDigitSet.has(digits)) continue;
    } else if (!/hxxps?:\/\/|\[\.\]|\(dot\)|\(at\)/i.test(token)) {
      const cleanToken = token.toLowerCase();
      if (cleanToken && domainOrHandleSet.has(cleanToken)) continue;
    }
    return true;
  }
  return false;
}

export function hasObfuscatedContactOrLink(
  text: string,
  trusted: readonly string[] = [],
  phoneTrusted: readonly string[] = trusted,
): boolean {
  return hasObfuscatedContactOrLinkFromSets(text, collectTrustedContactSets(trusted, phoneTrusted));
}

export function hasUngroundedMoneyOrScaleWords(text: string): boolean {
  const normalized = normalizeForGuard(text);
  return MONEY_SCALE_WORDS_RE.some((re) => re.test(normalized));
}

/** Whether a text says a number in words (either language): "twenty", "hai mươi ngày". */
export function hasNumberWords(text: string): boolean {
  const read = stripStealthControls(text).normalize('NFKC');
  return STRICT_NUMBER_WORD_RE.test(read) || STRICT_VI_NUMBER_BEFORE_UNIT_RE.test(read);
}

/** Whether a text reads as an address on any domain ("evil.club", "pay.example.cn", "name (at) host"). */
export function hasAddress(text: string): boolean {
  return ADDRESS_RE.test(stripStealthControls(text).normalize('NFKC'));
}

/** Whether a project status/cycle text contains written tens/scales or Vietnamese unitized number counts. */
export function hasProjectWrittenCountWords(text: string): boolean {
  const read = stripStealthControls(text).normalize('NFKC');
  return PROJECT_WRITTEN_COUNT_RE.test(read);
}

function normalizeMoneyOrIdToken(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hasUngroundedMoneyOrIdToken(text: string, trusted: readonly string[] = []): boolean {
  const stripped = stripStealthControls(text);
  // Check non-ASCII digits and Unicode minus BEFORE NFKC folds fullwidth digits into ASCII.
  if (NON_ASCII_DIGIT_OR_MINUS_RE.test(stripped)) return true;

  const normalized = stripped.normalize('NFKC');
  const trustedTokens = new Set<string>();
  for (const t of trusted) {
    const tNorm = stripStealthControls(t).normalize('NFKC');
    for (const match of tNorm.matchAll(UNTRUSTED_MONEY_OR_ID_RE)) {
      const tok = normalizeMoneyOrIdToken(match[0]);
      if (tok) trustedTokens.add(tok);
    }
  }

  for (const match of normalized.matchAll(UNTRUSTED_MONEY_OR_ID_RE)) {
    const token = normalizeMoneyOrIdToken(match[0]);
    if (token && trustedTokens.has(token)) continue;
    return true;
  }
  return false;
}

// Prompt fence escapes or system/context tag leaks inside AI outputs (excluding HTML script tags stripped separately by note-ai).
const PROMPT_FENCE_RE = /<<<|>>>/;
const PROMPT_TAG_LEAK_RE =
  /\[\/?UNTRUSTED_[A-Z0-9_]+\]|<\/?system\b|<\/?(?:note-ctx|subject|memory|knowledge)-[a-z0-9-]+\b|<\/?[a-z]+-[0-9a-f]{4,}\b/i;

const SCRIPT_TAG_LEAK_RE = /<\/?script\b/i;

/** Returns true when text contains prompt delimiter fences or leaked prompt/nonce tags. */
export function hasPromptTagOrFenceLeak(text: string): boolean {
  const stripped = stripStealthControls(text);
  return PROMPT_FENCE_RE.test(stripped) || PROMPT_TAG_LEAK_RE.test(stripped);
}

/** Returns true when text contains HTML script tags or leaked prompt/nonce tags (without treating >>> alone as a tag). */
export function hasPromptTagOnlyLeak(text: string): boolean {
  const stripped = stripStealthControls(text);
  return SCRIPT_TAG_LEAK_RE.test(stripped) || PROMPT_TAG_LEAK_RE.test(stripped);
}

/** Prompt fence escapes, HTML script tags, or system/context tag leaks inside AI outputs. */
export function hasPromptMarkupLeak(text: string): boolean {
  const stripped = stripStealthControls(text);
  return SCRIPT_TAG_LEAK_RE.test(stripped) || PROMPT_FENCE_RE.test(stripped) || PROMPT_TAG_LEAK_RE.test(stripped);
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function isDroppedTranscriptChar(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    code === 0x7f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Strips stealth/control characters, normalizes lone surrogates to U+FFFD, and collapses whitespace. */
export function tidyPlainText(text: string): string {
  let out = '';
  for (const char of stripStealthControls(text)) {
    if (!isDroppedTranscriptChar(char.codePointAt(0)!)) out += char;
  }
  return out.replace(LONE_SURROGATE_RE, '\uFFFD').replace(/\s+/g, ' ').trim();
}

// Term list caps shared cleanly between meeting transcription and pure member-Vy glossary modules.
export const TERMS_MAX = 50;
export const TERM_CHARS_MAX = 40;
export const TERMS_CHARS_MAX = 1000;
const TERM_DIGITS_MAX = 4;

/** Deduplicates, cleans invisible/control characters, and rejects email/URL/numeric-ID-like glossary/transcription terms. */
export function normalizeTerms(raw: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const item of raw ?? []) {
    if (typeof item !== 'string') continue;
    if (item.length > TERM_CHARS_MAX * 4) continue;
    const term = tidyPlainText(item).replace(/[\p{Cf}\p{Cc}]/gu, '').replace(/\s+/g, ' ').trim().normalize('NFC');
    if (term === '' || Array.from(term).length > TERM_CHARS_MAX) continue;
    const folded = term.normalize('NFKC');
    if (!/\p{L}/u.test(term) || folded.includes('@') || /:\/\/|www\./i.test(folded)) continue;
    if ((term.match(/\p{Nd}/gu) ?? []).length > TERM_DIGITS_MAX) continue;
    const key = term.toLocaleLowerCase('vi');
    if (seen.has(key)) continue;
    if (out.length >= TERMS_MAX || total + term.length + (out.length === 0 ? 0 : 2) > TERMS_CHARS_MAX) break;
    seen.add(key);
    total += term.length + (out.length === 0 ? 0 : 2);
    out.push(term);
  }
  return out;
}

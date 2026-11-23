// SPDX-License-Identifier: AGPL-3.0-only
// Shared deterministic prompt-injection guards for AI coworker validators (#3977, audit AI-02).
// Pure string checks: no I/O, no model calls, safe for both org-level and member-Vy modules.

// C0/DEL controls (excluding tab, LF, CR) plus stealth format/bidi characters that split tokens or reorder visible text.
// Excludes U+200D (ZWJ) so multi-codepoint emoji sequences in user-facing copy are preserved while checking output strings.
export const STEALTH_CONTROL_RE =
  /(?![\t\n\r])\p{Cc}|[\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;

const ALL_STEALTH_AND_CF_RE = /(?![\t\n\r])\p{Cc}|\p{Cf}/gu;

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
  /(?<![\p{L}\p{N}])(?<!không\s)(?<!chưa\s)(?<!đừng\s)(?<!tránh\s)tự\s+động\s+(?:phê\s+duyệt|duyệt|tuyển\s+dụng|ký\b|chuyển\s+khoản|chuyển\s+tiền|chi\s+trả|thanh\s+toán|gửi|xuất\s+hóa\s+đơn|hạch\s+toán|ghi\s+sổ)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])đã\s+tự\s+động\s+(?:phê\s+duyệt|tuyển\s+dụng|ký\b|chuyển\s+khoản|chi\s+trả|hạch\s+toán|ghi\s+sổ)(?![\p{L}\p{N}])/iu,
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

// Written money / scale / currency phrases used in prompt injections (without flagging "một triệu dòng dữ liệu" or "Họ tên đồng nghiệp").
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
const UNTRUSTED_MONEY_OR_ID_RE =
  /[\uFF10-\uFF19\u0660-\u0669\u2212]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![\p{L}\p{N}_.])[−-]?\d+(?:[.,]\d+)*\s*(?:%|triệu|trieu|tỷ|ty|nghìn|nghin|ngàn|ngan|đồng|dong|vnđ|vnd|usd|\$|€)(?=$|[\s.,;!?)}\]"'])|(?<![\p{L}\p{N}_.])[−-]?\d{1,3}(?:[.,]\d{3}){2,}(?=$|[\s.,;!?)}\]"'])/giu;

function collectTrustedContactSets(trusted: readonly string[], phoneTrusted: readonly string[]) {
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

export function hasObfuscatedContactOrLink(
  text: string,
  trusted: readonly string[] = [],
  phoneTrusted: readonly string[] = trusted,
): boolean {
  const normalized = stripStealthControls(text).normalize('NFKC');
  const { domainOrHandleSet, phoneDigitSet } = collectTrustedContactSets(trusted, phoneTrusted);

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

export function hasUngroundedMoneyOrScaleWords(text: string): boolean {
  const normalized = normalizeForGuard(text);
  return MONEY_SCALE_WORDS_RE.some((re) => re.test(normalized));
}

export function hasUngroundedMoneyOrIdToken(text: string, trusted: readonly string[] = []): boolean {
  const normalized = stripStealthControls(text).normalize('NFKC');
  const trustedNorm = trusted.map((t) => stripStealthControls(t).normalize('NFKC')).join(' ').toLowerCase();
  for (const match of normalized.matchAll(UNTRUSTED_MONEY_OR_ID_RE)) {
    const token = match[0].trim();
    if (/[\uFF10-\uFF19\u0660-\u0669\u2212]/u.test(token)) return true;
    const lowered = token.toLowerCase();
    if (lowered && trustedNorm.includes(lowered)) continue;
    return true;
  }
  return false;
}

// Prompt fence escapes, HTML script tags, or system/context tag leaks inside AI outputs.
const PROMPT_LEAK_RE =
  /<<<|>>>|\[\/?UNTRUSTED_[A-Z0-9_]+\]|<\/?(?:script|system)\b|<\/?(?:note-ctx|subject|memory|knowledge)-[a-z0-9-]+\b|<\/?[a-z]+-[0-9a-f]{4,}\b/i;

export function hasPromptMarkupLeak(text: string): boolean {
  return PROMPT_LEAK_RE.test(stripStealthControls(text));
}

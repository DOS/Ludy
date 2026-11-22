// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic Vietnamese recruiting CV field heuristics and Engage interview invite draft templates.

export interface DeterministicCvFields {
  displayName: string | null;
  email: string | null;
  phone: string | null;
  yearsExperience: number | null;
  matchedSkills: string[];
  notes: string | null;
  textPreview: string | null;
}

const HEADING_SKIP = new Set([
  'curriculum vitae',
  'so yeu ly lich',
  'resume',
  'cv',
  'ho so ung vien',
  'thong tin ca nhan',
  'personal information',
  'contact',
  'lien he',
  'muc tieu nghe nghiep',
  'kinh nghiem lam viec',
  'hoc van',
  'ky nang',
  'education',
  'experience',
  'skills',
  'objective',
  'profile',
  'summary',
]);

const DEFAULT_VN_SKILLS = [
  'Excel',
  'MISA',
  'Kế toán',
  'Thuế',
  'BHXH',
  'Tiếng Anh',
  'Zalo OA',
  'Facebook Ads',
  'TikTok',
  'CSKH',
  'Bán hàng',
  'Word',
  'PowerPoint',
  'SQL',
  'TypeScript',
  'React',
  'Node.js',
  'Python',
  'HR',
  'Tuyển dụng',
];

function foldDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function cleanControlChars(text: string): string {
  // Strip C0/C1 control characters except \n and \t cleanly.
  // oxlint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ');
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlnumCode(code: number): boolean {
  return isAsciiAlphaCode(code) || (code >= 48 && code <= 57);
}

function isEmailLocalCharCode(code: number): boolean {
  return isAsciiAlnumCode(code) || code === 46 || code === 95 || code === 37 || code === 43 || code === 45;
}

function isEmailDomainCharCode(code: number): boolean {
  return isAsciiAlnumCode(code) || code === 46 || code === 45;
}

function isValidEmailDomain(domain: string): boolean {
  if (domain.length < 4 || domain.length > 253) return false;
  const lastDot = domain.lastIndexOf('.');
  if (lastDot <= 0) return false;
  const tld = domain.slice(lastDot + 1);
  if (tld.length < 2 || tld.length > 24) return false;
  for (let i = 0; i < tld.length; i += 1) {
    if (!isAsciiAlphaCode(tld.charCodeAt(i))) return false;
  }
  const labels = domain.slice(0, lastDot).split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.charCodeAt(0) === 45 || label.charCodeAt(label.length - 1) === 45) return false;
  }
  return true;
}

function extractEmail(text: string): string | null {
  // Scan linearly around '@' so untrusted CV text without '@' or with repeated prefixes stays O(n) (no CWE-1333 ReDoS).
  let pos = 0;
  while (pos < text.length) {
    const at = text.indexOf('@', pos);
    if (at === -1) return null;

    let localStart = at;
    while (localStart > 0 && at - localStart < 64 && isEmailLocalCharCode(text.charCodeAt(localStart - 1))) {
      localStart -= 1;
    }
    if (localStart === at || (localStart > 0 && isEmailLocalCharCode(text.charCodeAt(localStart - 1)))) {
      pos = at + 1;
      continue;
    }

    let domainEnd = at + 1;
    while (domainEnd < text.length && domainEnd - (at + 1) <= 253 && isEmailDomainCharCode(text.charCodeAt(domainEnd))) {
      domainEnd += 1;
    }
    if (domainEnd < text.length && isEmailDomainCharCode(text.charCodeAt(domainEnd))) {
      pos = at + 1;
      continue;
    }
    while (domainEnd > at + 1 && (text.charCodeAt(domainEnd - 1) === 46 || text.charCodeAt(domainEnd - 1) === 45)) {
      domainEnd -= 1;
    }

    if (domainEnd - localStart > 254) {
      pos = at + 1;
      continue;
    }

    const domain = text.slice(at + 1, domainEnd);
    if (isValidEmailDomain(domain)) {
      return text.slice(localStart, domainEnd).toLowerCase();
    }
    pos = at + 1;
  }
  return null;
}

function extractVnPhone(text: string): string | null {
  // Match +84 / 84 / 0 VN phone numbers on a single line (never crossing newlines) with word boundary after the final digit.
  const candidates = text.matchAll(/(?<![\d])(?:\+?84|0)(?:[ \t.\-()]*\d){8,10}(?!\d)/g);
  for (const m of candidates) {
    const digits = m[0].replace(/\D/g, '');
    let normalized = digits;
    if (normalized.startsWith('84') && normalized.length >= 10 && normalized.length <= 12) {
      normalized = `0${normalized.slice(2)}`;
    }
    if (/^0(?:[35789]\d{8}|2\d{8,9}|[146]\d{8,9})$/.test(normalized)) {
      return normalized;
    }
  }
  return null;
}

function extractDisplayName(lines: readonly string[], email: string | null): string | null {
  for (const rawLine of lines.slice(0, 20)) {
    if (rawLine.length > 500) continue;
    const labelMatch = rawLine.match(/^(?:họ\s*(?:và\s*)?tên|full\s*name|họ\s*tên|name|ứng\s*viên|candidate)\s*[:-]\s*(.+)$/i);
    const candidate = (labelMatch ? labelMatch[1] : rawLine)?.trim() ?? '';
    if (!candidate) continue;
    if (candidate.length < 2 || candidate.length > 80) continue;
    if (email && candidate.toLowerCase().includes(email)) continue;
    if (candidate.includes('@') || /https?:\/\//i.test(candidate)) continue;
    const digitCount = (candidate.match(/\d/g) ?? []).length;
    if (digitCount > 0) continue;
    const folded = foldDiacritics(candidate).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!folded || HEADING_SKIP.has(folded)) continue;
    const words = candidate.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 6) continue;
    if (!/[\p{L}]/u.test(candidate)) continue;
    return candidate.replace(/\s+/g, ' ').slice(0, 200);
  }
  return null;
}

const EMPLOYMENT_SECTION_HEADINGS = new Set([
  'kinh nghiem',
  'kinh nghiem lam viec',
  'kinh nghiem cong tac',
  'lich su lam viec',
  'qua trinh cong tac',
  'qua trinh lam viec',
  'experience',
  'work experience',
  'professional experience',
  'employment',
  'employment history',
  'work history',
  'career history',
]);

const EXCLUDED_SECTION_HEADINGS = new Set([
  'hoc van',
  'trinh do',
  'trinh do hoc van',
  'education',
  'academic background',
  'academic history',
  'dao tao',
  'bang cap',
  'chung chi',
  'certification',
  'certifications',
  'giai thuong',
  'awards',
  'hoat dong',
  'activities',
  'du an',
  'projects',
  'ky nang',
  'skills',
  'muc tieu nghe nghiep',
  'objective',
  'summary',
  'profile',
  'nguoi tham chieu',
  'references',
  'so thich',
  'hobbies',
  'interests',
  'lien he',
  'contact',
  'thong tin ca nhan',
  'personal information',
]);

const INLINE_EDUCATION_RE =
  /\b(?:dai hoc|cao dang|trung cap|cu nhan|thac si|tien si|tot nghiep|hoc sinh|sinh vien|university|college|bachelor|master|phd|high school|academy)\b/i;

function normalizeHeadingCandidate(raw: string): string {
  return foldDiacritics(raw)
    .replace(/^[-*•#\s]+/, '')
    .replace(/[:-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyExperienceSectionLine(rawLine: string): 'employment' | 'excluded' | null {
  const whole = normalizeHeadingCandidate(rawLine);
  if (EMPLOYMENT_SECTION_HEADINGS.has(whole)) return 'employment';
  if (EXCLUDED_SECTION_HEADINGS.has(whole)) return 'excluded';
  const colonIdx = rawLine.indexOf(':');
  if (colonIdx > 0 && colonIdx <= 40) {
    const prefix = normalizeHeadingCandidate(rawLine.slice(0, colonIdx));
    if (EMPLOYMENT_SECTION_HEADINGS.has(prefix)) return 'employment';
    if (EXCLUDED_SECTION_HEADINGS.has(prefix)) return 'excluded';
  }
  return null;
}

function extractYearsExperience(text: string): number | null {
  const directMatch =
    text.match(/(\d{1,2})(?:[.,]\d+)?\s*(?:\+\s*)?(?:năm\s+kinh\s+nghiệm|years?\s+(?:of\s+)?(?:work\s+)?experience|năm\s+làm\s+việc)/i) ??
    text.match(/(?:kinh\s+nghiệm|experience)\s*[:-]\s*(\d{1,2})\s*(?:\+\s*)?(?:năm|years?)/i);
  if (directMatch?.[1]) {
    const parsed = Number.parseInt(directMatch[1], 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 60) return parsed;
  }
  // Fallback heuristic: infer from year ranges inside employment history, excluding education and non-employment sections.
  const lines = text.split('\n');
  const taggedLines = lines.map((line) => ({
    line,
    heading: classifyExperienceSectionLine(line),
  }));
  const hasExplicitEmployment = taggedLines.some((item) => item.heading === 'employment');

  const currentYear = new Date().getUTCFullYear();
  const intervals: Array<[number, number]> = [];
  let section: 'default' | 'employment' | 'excluded' = 'default';
  const rangePattern = /\b(20\d{2}|19[89]\d)\s*(?:-|\u2013|to|đến)\s*(20\d{2}|present|hiện\s*tại|nay)\b/gi;

  for (const { line, heading } of taggedLines) {
    if (heading === 'employment') {
      section = 'employment';
    } else if (heading === 'excluded') {
      section = 'excluded';
    }
    if (section === 'excluded') continue;
    if (hasExplicitEmployment && section !== 'employment') continue;
    if (section === 'default' && INLINE_EDUCATION_RE.test(foldDiacritics(line))) continue;

    for (const m of line.matchAll(rangePattern)) {
      const startYear = Number.parseInt(m[1] ?? '', 10);
      const endRaw = (m[2] ?? '').toLowerCase();
      const endYear = /^\d{4}$/.test(endRaw) ? Number.parseInt(endRaw, 10) : currentYear;
      if (startYear <= endYear && endYear - startYear <= 45) {
        intervals.push([startYear, endYear]);
      }
    }
  }
  if (intervals.length > 0) {
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const first = intervals[0];
    if (first) {
      let totalYears = 0;
      let curStart = first[0];
      let curEnd = first[1];
      for (let i = 1; i < intervals.length; i += 1) {
        const next = intervals[i];
        if (!next) continue;
        if (next[0] <= curEnd) {
          curEnd = Math.max(curEnd, next[1]);
        } else {
          totalYears += curEnd - curStart;
          curStart = next[0];
          curEnd = next[1];
        }
      }
      totalYears += curEnd - curStart;
      if (totalYears > 0 && totalYears <= 50) return totalYears;
    }
  }
  return null;
}

function matchCvSkills(text: string, openingRequiredSkills: readonly string[]): string[] {
  const normalizedText = foldDiacritics(text);
  const pool: string[] = [];
  const seenKey = new Set<string>();
  for (const raw of [...openingRequiredSkills, ...DEFAULT_VN_SKILLS]) {
    const skill = raw.trim();
    if (!skill) continue;
    const key = foldDiacritics(skill);
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    pool.push(skill);
  }
  const matched: string[] = [];
  for (const skill of pool) {
    const needle = foldDiacritics(skill);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = /^[a-z0-9\s]+$/i.test(needle)
      ? new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i')
      : new RegExp(escaped, 'i');
    if (pattern.test(normalizedText)) {
      matched.push(skill);
      if (matched.length >= 20) break;
    }
  }
  return matched;
}

/**
 * Deterministically extracts candidate fields from already-sandboxed CV plain text (0 LLM cost).
 */
export function extractCvFieldsDeterministically(
  rawText: string,
  openingRequiredSkills: readonly string[] = [],
): DeterministicCvFields {
  const cleaned = cleanControlChars(rawText).replace(/\r\n?/g, '\n');
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const email = extractEmail(cleaned);
  const phone = extractVnPhone(cleaned);
  const displayName = extractDisplayName(lines, email);
  const yearsExperience = extractYearsExperience(cleaned);
  const matchedSkills = matchCvSkills(cleaned, openingRequiredSkills);
  const previewSource = lines.join(' | ').replace(/\s+/g, ' ').trim();
  const textPreview = previewSource ? previewSource.slice(0, 600) : null;
  const notesParts: string[] = [];
  if (yearsExperience !== null) notesParts.push(`Kinh nghiệm: ${yearsExperience} năm`);
  if (matchedSkills.length > 0) notesParts.push(`Kỹ năng khớp: ${matchedSkills.join(', ')}`);
  if (previewSource) notesParts.push(`Tóm tắt CV: ${previewSource.slice(0, 280)}`);
  const notes = notesParts.length > 0 ? notesParts.join(' · ').slice(0, 1200) : null;
  return {
    displayName,
    email,
    phone,
    yearsExperience,
    matchedSkills,
    notes,
    textPreview,
  };
}

export interface EngageInviteSlotInput {
  start: string;
  end: string;
}

export interface BuildEngageInviteDraftInput {
  channel: 'zalo_oa' | 'facebook';
  candidateLabel: string;
  openingTitle: string;
  interviewerName?: string | null;
  slots: readonly EngageInviteSlotInput[];
  lang?: 'vi' | 'en';
}

function formatSlotLine(slot: EngageInviteSlotInput, lang: 'vi' | 'en'): string {
  const startDate = new Date(slot.start);
  const endDate = new Date(slot.end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return `${slot.start} - ${slot.end}`;
  }
  const locale = lang === 'en' ? 'en-US' : 'vi-VN';
  const datePart = new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Ho_Chi_Minh',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(startDate);
  const startTime = new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(startDate);
  const endTime = new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(endDate);
  return `${datePart} (${startTime} - ${endTime})`;
}

/**
 * Builds deterministic Engage (Zalo OA / Facebook Page) interview invitation copy for human review and manual send.
 */
export function buildEngageInviteDraft(input: BuildEngageInviteDraftInput): string {
  const lang = input.lang ?? 'vi';
  const candidate = input.candidateLabel.trim() || (lang === 'en' ? 'Candidate' : 'bạn');
  const title = input.openingTitle.trim() || (lang === 'en' ? 'open role' : 'vị trí đang tuyển');
  const topSlots = input.slots.slice(0, 3);
  const slotLines = topSlots.map((slot, idx) => `${idx + 1}. ${formatSlotLine(slot, lang)}`).join('\n');
  const channelLabel = input.channel === 'zalo_oa' ? 'Zalo OA' : 'Facebook Page';

  if (lang === 'en') {
    const interviewerLine = input.interviewerName ? ` with ${input.interviewerName}` : '';
    const slotSection = slotLines
      ? `Available interview slots${interviewerLine} (GMT+7):\n${slotLines}\nPlease reply with the slot number that works best for you.`
      : `Please share two or three times this week that work best for your interview${interviewerLine}.`;
    return [
      `Hello ${candidate},`,
      `Thank you for applying for the ${title} position. We would love to invite you to an interview via ${channelLabel}.`,
      slotSection,
      'We look forward to speaking with you!',
    ].join('\n\n');
  }

  const interviewerLine = input.interviewerName ? ` cùng ${input.interviewerName}` : '';
  const slotSection = slotLines
    ? `Các khung giờ phỏng vấn còn trống${interviewerLine} (giờ Việt Nam):\n${slotLines}\nAnh/chị vui lòng phản hồi số thứ tự khung giờ phù hợp nhất nhé.`
    : `Anh/chị vui lòng phản hồi 2-3 khung giờ thuận tiện trong tuần này để đội ngũ sắp xếp phỏng vấn${interviewerLine} nhé.`;

  return [
    `Chào ${candidate},`,
    `Cảm ơn anh/chị đã quan tâm ứng tuyển vị trí ${title}. Bộ phận Nhân sự trân trọng mời anh/chị tham gia buổi trao đổi phỏng vấn (liên hệ qua ${channelLabel}).`,
    slotSection,
    'Rất mong sớm nhận được phản hồi của anh/chị!',
  ].join('\n\n');
}

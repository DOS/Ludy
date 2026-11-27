// SPDX-License-Identifier: AGPL-3.0-only
// Sanitization helpers for untrusted GitHub payloads (ADR-0018, ADR-0060 D5).

const REPO_FULL_NAME_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9-]{1,100}(?:\[bot\])?$/;
const GITHUB_ITEM_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(issues|pull)\/([1-9][0-9]{0,8})(?:[?#].*)?$/;

const stripControlChars = (value: string): string => {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isDisallowed =
      (code >= 0 && code <= 0x08) || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
    out += isDisallowed ? ' ' : value[i]!;
  }
  return out;
};

// Strip Unicode Cf format chars (bidi overrides, zero-width), ASCII C0/DEL control chars, and raw HTML tags.
export function sanitizeGithubText(raw: string, maxLength = 300): string {
  const withoutFormat = raw.replace(/\p{Cf}/gu, '');
  const withoutControl = stripControlChars(withoutFormat);
  const withoutComments = withoutControl.replace(/<!--[\s\S]*?-->/g, ' ');
  const withoutTags = withoutComments.replace(/<[^>\n]{1,500}>/g, ' ');
  const collapsed = withoutTags.replace(/\s+/g, ' ').trim().normalize('NFC');
  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.slice(0, maxLength).trim();
}

export function sanitizeGithubMultilineSnippet(raw: string, maxLength = 8192): string {
  const withoutFormat = raw.replace(/\p{Cf}/gu, '');
  const withoutControl = stripControlChars(withoutFormat);
  const withoutComments = withoutControl.replace(/<!--[\s\S]*?-->/g, ' ');
  const withoutTags = withoutComments.replace(/<[^>\n]{1,500}>/g, ' ');
  const trimmed = withoutTags.trim().normalize('NFC');
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

export function normalizeRepoFullName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!REPO_FULL_NAME_RE.test(trimmed)) return null;
  const slash = trimmed.indexOf('/');
  const owner = trimmed.slice(0, slash);
  const repo = trimmed.slice(slash + 1);
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return `${owner}/${repo}`;
}

export function sanitizeGithubLogin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\p{Cf}/gu, '').trim();
  return GITHUB_LOGIN_RE.test(cleaned) ? cleaned : null;
}

export function sanitizeBranchName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = sanitizeGithubText(raw, 255).replace(/\s+/g, '-');
  if (!cleaned || cleaned.includes('..')) return null;
  return cleaned;
}

export function canonicalGithubItemUrl(
  repoFullName: string,
  kind: 'issue' | 'pull_request',
  externalNumber: number,
  candidateUrl?: string | null,
): string | null {
  const normalizedRepo = normalizeRepoFullName(repoFullName);
  if (!normalizedRepo || !Number.isInteger(externalNumber) || externalNumber < 1) return null;
  const segment = kind === 'issue' ? 'issues' : 'pull';
  if (candidateUrl) {
    const match = GITHUB_ITEM_URL_RE.exec(candidateUrl.trim());
    if (match) {
      const urlRepo = normalizeRepoFullName(`${match[1] ?? ''}/${match[2] ?? ''}`);
      const urlSegment = match[3];
      const urlNum = Number(match[4]);
      if (urlRepo && urlRepo.toLowerCase() === normalizedRepo.toLowerCase() && urlSegment === segment && urlNum === externalNumber) {
        return `https://github.com/${normalizedRepo}/${segment}/${externalNumber}`;
      }
    }
  }
  return `https://github.com/${normalizedRepo}/${segment}/${externalNumber}`;
}

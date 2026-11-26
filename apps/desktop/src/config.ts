// SPDX-License-Identifier: AGPL-3.0-only
// What Ludy Desktop is pointed at (ADR-0055 slice 2, #4515/#4884/#4885). Nothing is baked in: no default server, no secret.
//   - LUDY_URL (or `ludyUrl` in config.json in the user data folder): the Ludy deployment to sign in to and to open.
//   - LUDY_DESKTOP_UPDATE_URL (or `updateUrl`): the folder that holds the update feed (RELEASES / release-manifest.json / packages).
//   - LUDY_DESKTOP_UPDATE_ORIGIN (or `updateOrigin`): optional origin pin that the update feed URL must match.
//   - LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1 (or `updatePublisherThumbprint`): optional Windows 40-hex signing certificate thumbprint pin.
//   - LUDY_DESKTOP_UPDATE_TEAM_ID (or `updateTeamId`): optional macOS 10-char Apple Developer Team ID pin.
// An environment variable wins over the file. A value that is not a safe address is reported and ignored, never used: the shell
// sends the member's token only to the configured Ludy origin, and loads no remote content at all.
import { APPLE_TEAM_ID_PATTERN, normalizeAppleTeamId } from './codesign.ts';
import { parseFeedOrigin, resolveFeedUrl, type FeedUrlOptions } from './update-feed.ts';

export interface DesktopConfig {
  // The origin of the Ludy deployment, or null when none (valid) is configured.
  ludyUrl: string | null;
  // The update feed folder URL without a trailing slash, or null: updates are off.
  updateUrl: string | null;
  // What is wrong with the configuration, in Vietnamese, for the tray. Empty when all is well.
  problems: string[];
}

export interface UpdatePolicyConfig extends DesktopConfig {
  allowedUpdateOrigin: string | null;
  expectedPublisherThumbprint: string | null;
  expectedTeamId: string | null;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const SHA1_THUMBPRINT = /^[0-9a-fA-F]{40}$/;

// localhost, 127.0.0.1, [::1] and *.localhost: the development hosts where plain http is accepted for Ludy URL.
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

function parseHttpUrl(value: string): URL | string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'không phải một địa chỉ hợp lệ';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    return 'phải dùng https (http chỉ cho localhost, 127.0.0.1 hoặc [::1])';
  }
  if (url.username !== '' || url.password !== '') return 'không được chứa tên người dùng hoặc mật khẩu';
  if (url.search !== '' || url.hash !== '') return 'không được chứa tham số hoặc đoạn #';
  return url;
}

// The Ludy deployment: an origin, nothing after it (allows internal HTTPS origins for self-hosted deployments).
export function parseLudyUrl(value: string): UrlCheck {
  const url = parseHttpUrl(value);
  if (typeof url === 'string') return { ok: false, reason: url };
  if (url.pathname !== '/') return { ok: false, reason: 'chỉ gồm địa chỉ gốc, không có đường dẫn' };
  return { ok: true, url: url.origin };
}

// The update feed folder: asks `<url>/RELEASES` (Windows) and `<url>/release-manifest.json`, with SSRF and origin-pinning checks.
export function parseUpdateUrl(value: string, options: FeedUrlOptions = {}): UrlCheck {
  return resolveFeedUrl(value, options);
}

export interface ConfigSources {
  env: Readonly<Record<string, string | undefined>>;
  // The text of config.json in the user data folder, or null when there is none.
  configFile: string | null;
}

interface RawFileConfig {
  ludyUrl?: string;
  updateUrl?: string;
  updateOrigin?: string;
  updatePublisherThumbprint?: string;
  updateTeamId?: string;
  invalidLudyType?: boolean;
  invalidUpdateType?: boolean;
  invalidOriginType?: boolean;
  invalidThumbprintType?: boolean;
  invalidTeamIdType?: boolean;
}

function readFileConfig(text: string | null, problems: string[]): RawFileConfig {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const record = parsed as Record<string, unknown>;
    const out: RawFileConfig = {};
    if (Object.hasOwn(record, 'ludyUrl') && record.ludyUrl !== undefined) {
      if (typeof record.ludyUrl === 'string') out.ludyUrl = record.ludyUrl;
      else {
        out.invalidLudyType = true;
        problems.push('ludyUrl trong config.json phải là chuỗi');
      }
    }
    if (Object.hasOwn(record, 'updateUrl') && record.updateUrl !== undefined) {
      if (typeof record.updateUrl === 'string') out.updateUrl = record.updateUrl;
      else {
        out.invalidUpdateType = true;
        problems.push('updateUrl trong config.json phải là chuỗi');
      }
    }
    if (Object.hasOwn(record, 'updateOrigin') && record.updateOrigin !== undefined) {
      if (typeof record.updateOrigin === 'string') out.updateOrigin = record.updateOrigin;
      else {
        out.invalidOriginType = true;
        problems.push('updateOrigin trong config.json phải là chuỗi');
      }
    }
    if (Object.hasOwn(record, 'updatePublisherThumbprint') && record.updatePublisherThumbprint !== undefined) {
      if (typeof record.updatePublisherThumbprint === 'string') out.updatePublisherThumbprint = record.updatePublisherThumbprint;
      else {
        out.invalidThumbprintType = true;
        problems.push('updatePublisherThumbprint trong config.json phải là chuỗi');
      }
    }
    if (Object.hasOwn(record, 'updateTeamId') && record.updateTeamId !== undefined) {
      if (typeof record.updateTeamId === 'string') out.updateTeamId = record.updateTeamId;
      else {
        out.invalidTeamIdType = true;
        problems.push('updateTeamId trong config.json phải là chuỗi');
      }
    }
    return out;
  } catch {
    problems.push('config.json không đọc được (phải là JSON dạng {"ludyUrl": "..."})');
    return {};
  }
}

export function loadUpdateConfig(sources: ConfigSources): UpdatePolicyConfig {
  const problems: string[] = [];
  const file = readFileConfig(sources.configFile, problems);
  const envLudy = sources.env.LUDY_URL?.trim();
  const envUpdate = sources.env.LUDY_DESKTOP_UPDATE_URL?.trim();
  const envOrigin = sources.env.LUDY_DESKTOP_UPDATE_ORIGIN?.trim();
  const envThumbprint = sources.env.LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1?.trim();
  const envTeamId = sources.env.LUDY_DESKTOP_UPDATE_TEAM_ID?.trim();

  const ludyRaw = envLudy || file.ludyUrl;
  const updateRaw = envUpdate || file.updateUrl;
  const originRaw = envOrigin || file.updateOrigin?.trim() || '';
  const thumbprintRaw = envThumbprint || file.updatePublisherThumbprint?.trim() || '';
  const teamIdRaw = envTeamId || file.updateTeamId?.trim() || '';

  let ludyUrl: string | null = null;
  if (ludyRaw) {
    const checked = parseLudyUrl(ludyRaw);
    if (checked.ok) ludyUrl = checked.url;
    else problems.push(`Địa chỉ Ludy ${checked.reason}`);
  }

  let allowedUpdateOrigin: string | null = null;
  let originInvalid = Boolean(!envOrigin && file.invalidOriginType);
  if (originRaw) {
    const checkedOrigin = parseFeedOrigin(originRaw);
    if (checkedOrigin.ok) allowedUpdateOrigin = checkedOrigin.url;
    else {
      originInvalid = true;
      problems.push(`Địa chỉ gốc cập nhật được ghim ${checkedOrigin.reason}`);
    }
  }

  let expectedPublisherThumbprint: string | null = null;
  let thumbprintInvalid = Boolean(!envThumbprint && file.invalidThumbprintType);
  if (thumbprintRaw) {
    if (SHA1_THUMBPRINT.test(thumbprintRaw)) expectedPublisherThumbprint = thumbprintRaw.toLowerCase();
    else {
      thumbprintInvalid = true;
      problems.push('Mã chứng chỉ ký cập nhật (SHA-1) phải gồm đúng 40 ký tự hex');
    }
  }

  let expectedTeamId: string | null = null;
  let teamIdInvalid = Boolean(!envTeamId && file.invalidTeamIdType);
  if (teamIdRaw) {
    const normalized = normalizeAppleTeamId(teamIdRaw);
    if (normalized && APPLE_TEAM_ID_PATTERN.test(normalized)) expectedTeamId = normalized;
    else {
      teamIdInvalid = true;
      problems.push('Mã định danh nhóm Apple (Team ID) phải gồm đúng 10 ký tự chữ và số');
    }
  }

  let updateUrl: string | null = null;
  if (updateRaw && !(file.invalidUpdateType && !envUpdate)) {
    if (originInvalid || thumbprintInvalid || teamIdInvalid) {
      // Fail closed when pinning policy is invalid so an unverified feed cannot run.
      updateUrl = null;
    } else {
      const checked = parseUpdateUrl(updateRaw, { ludyUrl, allowedOrigin: allowedUpdateOrigin });
      if (checked.ok) updateUrl = checked.url;
      else problems.push(`Địa chỉ cập nhật ${checked.reason}`);
    }
  }

  return { ludyUrl, updateUrl, allowedUpdateOrigin, expectedPublisherThumbprint, expectedTeamId, problems };
}

export function loadConfig(sources: ConfigSources): DesktopConfig {
  const full = loadUpdateConfig(sources);
  return { ludyUrl: full.ludyUrl, updateUrl: full.updateUrl, problems: full.problems };
}

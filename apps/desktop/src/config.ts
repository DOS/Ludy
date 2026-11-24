// SPDX-License-Identifier: AGPL-3.0-only
// What Ludy Desktop is pointed at (ADR-0055 slice 2, issue #4515). Nothing is baked in: no default server, no secret.
//   - LUDY_URL (or `ludyUrl` in config.json in the user data folder): the Ludy deployment to sign in to and to open.
//   - LUDY_DESKTOP_UPDATE_URL (or `updateUrl`): the folder that holds the Squirrel.Windows feed (RELEASES and the nupkg).
// An environment variable wins over the file. A value that is not a safe address is reported and ignored, never used: the shell
// sends the member's token only to the configured Ludy origin, and loads no remote content at all.

export interface DesktopConfig {
  // The origin of the Ludy deployment, or null when none (valid) is configured.
  ludyUrl: string | null;
  // The update feed folder URL without a trailing slash, or null: updates are off.
  updateUrl: string | null;
  // What is wrong with the configuration, in Vietnamese, for the tray. Empty when all is well.
  problems: string[];
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

// localhost, 127.0.0.1, [::1] and *.localhost: the development hosts where plain http is accepted.
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

// The Ludy deployment: an origin, nothing after it.
export function parseLudyUrl(value: string): UrlCheck {
  const url = parseHttpUrl(value);
  if (typeof url === 'string') return { ok: false, reason: url };
  if (url.pathname !== '/') return { ok: false, reason: 'chỉ gồm địa chỉ gốc, không có đường dẫn' };
  return { ok: true, url: url.origin };
}

// The update feed folder: the Squirrel.Windows client asks `<url>/RELEASES`, so a path is fine and a trailing slash is not kept.
export function parseUpdateUrl(value: string): UrlCheck {
  const url = parseHttpUrl(value);
  if (typeof url === 'string') return { ok: false, reason: url };
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

export interface ConfigSources {
  env: Readonly<Record<string, string | undefined>>;
  // The text of config.json in the user data folder, or null when there is none.
  configFile: string | null;
}

function readFileConfig(text: string | null, problems: string[]): { ludyUrl?: string; updateUrl?: string } {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const record = parsed as Record<string, unknown>;
    const out: { ludyUrl?: string; updateUrl?: string } = {};
    if (typeof record.ludyUrl === 'string') out.ludyUrl = record.ludyUrl;
    if (typeof record.updateUrl === 'string') out.updateUrl = record.updateUrl;
    return out;
  } catch {
    problems.push('config.json không đọc được (phải là JSON dạng {"ludyUrl": "..."})');
    return {};
  }
}

export function loadConfig(sources: ConfigSources): DesktopConfig {
  const problems: string[] = [];
  const file = readFileConfig(sources.configFile, problems);
  const ludyRaw = sources.env.LUDY_URL?.trim() || file.ludyUrl;
  const updateRaw = sources.env.LUDY_DESKTOP_UPDATE_URL?.trim() || file.updateUrl;
  let ludyUrl: string | null = null;
  let updateUrl: string | null = null;
  if (ludyRaw) {
    const checked = parseLudyUrl(ludyRaw);
    if (checked.ok) ludyUrl = checked.url;
    else problems.push(`Địa chỉ Ludy ${checked.reason}`);
  }
  if (updateRaw) {
    const checked = parseUpdateUrl(updateRaw);
    if (checked.ok) updateUrl = checked.url;
    else problems.push(`Địa chỉ cập nhật ${checked.reason}`);
  }
  return { ludyUrl, updateUrl, problems };
}

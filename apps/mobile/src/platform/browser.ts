// SPDX-License-Identifier: AGPL-3.0-only
// The phone's system browser (ASWebAuthenticationSession on iOS, Custom Tabs on Android via expo-web-browser). Keeping OAuth in
// the system browser instead of an embedded browser view gives the phone's password manager and keeps tokens out of any embedded page (issue #4880).
import * as WebBrowser from 'expo-web-browser';
import type { BrowserPort } from '../auth/session.ts';
import { isSafeExternalWebUrl } from '../screens/approvals/format.ts';

export const systemBrowser: BrowserPort = {
  async open(url, redirectUri) {
    const result = await WebBrowser.openAuthSessionAsync(url, redirectUri, { preferEphemeralSession: true });
    return result.type === 'success' ? { type: 'success', url: result.url } : { type: 'cancel' };
  },
};

interface ExternalWebPort {
  openWeb(url: string, allowedOrigin?: string): Promise<boolean>;
}

export const externalBrowser: ExternalWebPort = {
  async openWeb(url, allowedOrigin) {
    if (!isSafeExternalWebUrl(url, allowedOrigin)) return false;
    await WebBrowser.openBrowserAsync(url);
    return true;
  },
};
